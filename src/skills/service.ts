// dsh-plugin-tool-management —— 技能管理服务层
// 把 src/skills/core.js（移植自 dsh-skills-manager，Apache-2.0）的纯文件操作
// 适配成统一 op 协议：handler(args) → { ok:true, data }（core 业务失败原样透传
// { ok:false, error, code?, params? }）。provider / agent-scope 注册与变更通知
// 沿用上游机制：全局层接管 + 每个活动 agent scope 内二次注册。
import { appendFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isInsideRootResolved, isSameOrDescendant, isValidSegment } from '../paths.js'
import { workspaceCwdOfScopeKey } from '../scope/workspace-key.js'
import {
  state,
  setSkillEnabled,
  setPreferredSkill,
  markSkillsDisabled,
  setSourceEnabled,
  setSourceRemoved,
  deleteSkill,
  restoreTrash,
  permanentlyDeleteTrash,
  importSkill,
  importUploadedSkill,
  browseDirectories,
  createSkill,
  updateSkill,
  skillDetail,
  listProviderCandidates,
  getProviderSkill,
  userRoots,
  projectRoots,
  readManagerState,
  customRootsFromState,
  addCustomRoot,
  removeCustomRoot,
  forgetSource,
  logPath,
  trashRootPath,
} from './core.js'
import { watchDirectories } from './dir-watch.js'
import { registerAgentSkillProviders, externalSkillProvider } from './provider-registration.js'
import { moveToSystemTrash, permanentlyDeleteTrashSafely } from './system-trash.js'

const MAX_LOG_BYTES = 1 << 20

const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 串行写日志，超过上限滚动为 .1；日志失败不阻塞主流程（移植自上游）。 */
function makeLog(): (event: string, detail?: unknown) => Promise<void> {
  const file = logPath()
  let queue: Promise<void> = Promise.resolve()
  return async (event: string, detail?: unknown) => {
    queue = queue.then(async () => {
      try {
        const current: any = await stat(file).catch(() => null)
        if (current && current.size >= MAX_LOG_BYTES) {
          await rm(`${file}.1`, { force: true })
          await rename(file, `${file}.1`)
        }
        await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), event, detail })}\n`, 'utf8')
      } catch {
        /* 日志失败不阻塞主流程 */
      }
    })
    await queue
  }
}

/**
 * 某个会话的 cwd（`null` = 在自己的活动会话清单里找不到这个会话）。
 *
 * 与 `activeSessionCwds` 同一条取法（`sessions.list()` → `header.cwd`），只是按 id 过滤。
 * 用 `list()` 而不是 `sessions.get(id)`：前者是宿主公开的活会话清单，后者在冷会话上返回
 * undefined。**找不到 ≠ 没有 cwd**：调用方据此退回全局口径（全部活动会话），
 * 而不是把项目技能整个清空 —— 一次清单读取时序问题不该让某一轮少掉一整类技能。
 */
export function sessionCwdOf(ctx: any, sessionId: string): string[] | null {
  // 工作区模式（0.21.2）：面板 / 斜杠菜单传过来的可能是 `ws:<cwd>` 作用域键。
  // 它本身就是项目技能根（键里带归一化后的完整路径），不必再去会话清单里找。
  const workspaceCwd = workspaceCwdOfScopeKey(sessionId)
  if (workspaceCwd !== undefined) return [workspaceCwd]
  try {
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) || ctx.sessions
    const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
    for (const session of Array.isArray(list) ? list : []) {
      const id = session && (session.id ?? (session.header && session.header.id))
      if (String(id ?? '') !== sessionId) continue
      const cwd = session && session.header && session.header.cwd
      // 找到了这个会话：有 cwd 就只取它；没有 cwd = 这个对话不在任何项目里。
      return typeof cwd === 'string' && cwd.trim() !== '' ? [cwd.trim()] : []
    }
    return null
  } catch {
    return null
  }
}

/** 活动 Session 的宿主 cwd；项目 Skill 只从这些已知 workspace 推导。 */
export function activeSessionCwds(ctx: any): string[] {
  try {
    const sessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined) || ctx.sessions
    const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
    const seen = new Set<string>()
    const cwds: string[] = []
    for (const session of Array.isArray(list) ? list : []) {
      const cwd = session && session.header && session.header.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') continue
      const trimmed = cwd.trim()
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      cwds.push(trimmed)
    }
    return cwds
  } catch {
    return []
  }
}

/** 文件写入后刷新技能目录，并通知 Web 端重拉 `/` 菜单缓存（移植自上游）。 */
function notifyChatCatalog(ctx: any, invalidateSkills: () => void): void {
  try { invalidateSkills() } catch { /* ignore */ }
  try { if (typeof ctx.emit === 'function') ctx.emit('commands/change') } catch { /* ignore */ }
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
    for (const session of list) {
      const id = session && (session.id ?? (session.header && session.header.id))
      const preset = session && session.header && typeof session.header.agentPreset === 'string' ? session.header.agentPreset : undefined
      if (id == null || !preset || typeof ctx.emit !== 'function') continue
      ctx.emit('agent-preset/selected', id, preset)
    }
  } catch { /* 斜杠菜单刷新失败不影响已完成的操作 */ }
}

/**
 * 本插件**可写**的技能来源集合，共两员：
 *
 * - `hub`（`$DSH_HOME/tool-management/skills/`，界面名「导入技能」）—— 导入 / 上传的落点；
 * - `dsh`（`$DSH_HOME/skills/`，界面名「DSH 技能」）—— **新建**技能的落点（用户裁定
 *   2026-10-15：「新增技能默认 DSH 技能；导入技能功能才是导入技能目录」）。
 *
 * 其余根（官方内置 / agents / codex / claude / 自定义 / 项目）一律不碰。
 *
 * 这个集合曾经只有 `hub`：新建默认落点还在 hub 的年代那么判够用。落点改到 dsh 之后，
 * 只认 hub 会把「新建 → 再存一次」整条回路掐断 —— 新建默认落 dsh，改的分支永远找不到
 * hub 里的胜出者，每次都回 `error.update.notOwnRoot`。所以它与新建落点是同一条裁定
 * 的两面，必须一起扩。
 */
const PLUGIN_WRITABLE_ROOTS: ReadonlySet<string> = new Set(['hub', 'dsh'])

export interface SkillsService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /** 注册全局层与 agent-scope provider；返回清理函数（配合 ctx.effect）。 */
  registerProviders: () => () => void
  /**
   * 该绝对路径是否落在「本插件认识的技能来源」内（静态根 + 自定义根 + 项目来源）。
   * `skill-open` 用它把该 op 限制在技能文件上，避免成为「任意绝对路径 → 系统编辑器」的入口。
   */
  isInsideKnownSkillRoot: (abs: string) => Promise<boolean>
}

/** 全插件共用的审计日志：单一串行写队列，避免多处写同一文件交叉。 */
let sharedLog: ((event: string, detail?: unknown) => Promise<void>) | null = null
export function pluginLog(): (event: string, detail?: unknown) => Promise<void> {
  if (!sharedLog) sharedLog = makeLog()
  return sharedLog
}

export function createSkillsService(ctx: any): SkillsService {
  const log = pluginLog()
  const roots = userRoots()
  const rootByKey: Record<string, any> = Object.fromEntries(roots.map((root: any) => [root.key, root]))
  /** op 入参里的 `sessionId`（空串 / 非字符串 → undefined = 全局口径）。 */
  const sessionIdOfArgs = (args: any): string | undefined => {
    const raw = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    return raw === '' ? undefined : raw
  }

  /**
   * 项目技能根的 cwd 集合（0.21.2）。
   *
   * 不给 `sessionId` 时是**全部活动会话的 cwd 并集**（0.21.2 及以前的行为，界面没有"当前会话"
   * 概念时用它）；给了就只取那一个会话的 cwd —— 这是让项目技能按会话隔离的关键：
   * A 对话在 `proj-a`、B 在 `proj-b` 时，并集会让两边都看到两个项目的技能，而"这个对话在哪个
   * 项目里"本来就有唯一答案（会话自己的 `header.cwd`）。
   */
  const projectOptions = (sessionId?: string) => {
    if (sessionId === undefined) return { projectCwds: activeSessionCwds(ctx) }
    const own = sessionCwdOf(ctx, sessionId)
    // 清单里找不到这个会话（时序 / 冷会话）→ 退回全局口径，不把项目技能清空。
    return { projectCwds: own === null ? activeSessionCwds(ctx) : own }
  }
  const requestRoot = async (key: string) => {
    if (rootByKey[key]) return rootByKey[key]
    // 自定义来源不在静态 root 表里：从状态文件的 customRoots 解析 definition。
    try {
      const policy = await readManagerState()
      const custom = customRootsFromState(policy.state).find((root: any) => root.key === key)
      if (custom) return custom
    } catch { /* 状态不可用时按未知来源处理 */ }
    const list = await projectRoots(projectOptions().projectCwds)
    return list.find((root: any) => root.key === key)
  }

  /**
   * **项目来源**（`project-dsh:<hash>` / `project-agents:<hash>`）能不能被启停，此前取决于
   * 「它的工作区此刻在不在活动会话里」（`requestRoot` 的第三步）——于是场景快照恢复时工作区
   * 早已关闭，解析落空 → `setSourceEnabled(undefined)` → 「该技能来源不允许启用或停用」→
   * 退出模式直接失败、卡在场景里（用户 2026-09-17 报的）。
   *
   * key 本身就是自描述的（`<kind>:<路径哈希>`），而启停只写本地状态文件
   * （`state.sources[key]`），一个字节都不碰源目录 —— 所以按前缀合成一个最小 definition
   * 交给 core 即可：这个工作区下次被打开时，来源按记录的状态生效。
   */
  const PROJECT_SOURCE_KEY_RE = /^project-(dsh|agents):[a-f0-9]{16}$/
  function projectKeyStub(key: string): any {
    if (!PROJECT_SOURCE_KEY_RE.test(key)) return undefined
    return {
      key,
      kind: key.slice(0, key.indexOf(':')),
      scope: 'project',
      toggleable: true,
      mutable: false,
      deletable: false,
      label: key,
      path: '',
    }
  }
  /** 启停来源专用的解析：静态 / 自定义 / 活动工作区都命中不了时，按 key 前缀兜底。 */
  const requestSwitchRoot = async (key: string) => (await requestRoot(key)) || projectKeyStub(key)

  const providerInvalidators = new Set<() => void>()
  const invalidateSkills = () => {
    for (const invalidate of providerInvalidators) {
      try { invalidate() } catch { /* 单个失效不影响其余 */ }
    }
  }

  // state() 全量扫描 4 个用户根（递归，上限 2000 目录）+ 活动项目根，并读取
  // 全部 SKILL.md 正文；UI 默认每 5s 轮询一次。加 1s TTL 缓存吸收密集轮询，
  // 任何写操作成功后立即失效（afterWrite），保证写后读到的总是新状态。
  const STATE_TTL_MS = 1000
  // ⚠️ 按**项目根集合**分桶（0.21.2）：`projectOptions(sessionId)` 只取该会话的 cwd，两个会话能
  // 算出两份不同的技能清单。单槽缓存下 A 读完 B 直接用 —— 症状是「B 的对话里列出了 A 项目的技能」。
  // 键不能是 sessionId：同一工作区里的多个对话、以及全局口径，算出来的是**同一份**扫描结果，
  // 按会话分桶会让 `skillCatalog.refresh()` 为每个会话各扫一遍磁盘（写操作因此从毫秒拖到秒级）。
  // 上限 16 条 LRU（与记忆段同一手法）。
  const STATE_CACHE_MAX = 16
  const stateCache = new Map<string, { at: number; value: unknown }>()
  /** cwd 集合 → 缓存键（去重、排序：同一组项目根只有一个桶）。 */
  const stateKeyOf = (cwds: readonly string[]): string => {
    const seen = new Set<string>()
    for (const cwd of cwds) {
      const trimmed = String(cwd || '').trim()
      if (trimmed !== '') seen.add(trimmed)
    }
    return [...seen].sort().join('\u0000')
  }
  /**
   * 同一次扫描的并发合流 + 写后作废（0.21.2）。
   *
   * `scope-get`、斜杠菜单、对账、目录刷新会在同一拍里各问一次「技能清单」——不合流的话
   * 一次场景切换会并发跑好几份全量扫描，既有磁盘开销又抢事件循环；而写操作之后在飞的那份
   * 是**写之前**的，不能复用。`generation` 同时解决两件事：同代的在飞共享，换代后的旧结果不落缓存。
   */
  let stateGeneration = 0
  const stateInflight = new Map<string, { gen: number; promise: Promise<unknown> }>()
  const readState = async (sessionId?: string): Promise<unknown> => {
    const options = projectOptions(sessionId)
    const key = stateKeyOf(options.projectCwds)
    const hit = stateCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < STATE_TTL_MS) return hit.value
    const running = stateInflight.get(key)
    if (running !== undefined && running.gen === stateGeneration) return running.promise
    const gen = stateGeneration
    let promise: Promise<unknown>
    promise = state(options).then((value) => {
      // 扫描期间有过写操作 → 这份结果可能是写之前的，丢掉（下一次读会重扫）。
      if (gen === stateGeneration) {
        stateCache.delete(key)
        stateCache.set(key, { at: Date.now(), value })
        while (stateCache.size > STATE_CACHE_MAX) {
          const oldest = stateCache.keys().next()
          if (oldest.done === true) break
          stateCache.delete(oldest.value)
        }
      }
      return value
    }).finally(() => {
      const current = stateInflight.get(key)
      if (current !== undefined && current.promise === promise) stateInflight.delete(key)
    })
    stateInflight.set(key, { gen, promise })
    return promise
  }

  const afterWrite = () => {
    // 写操作影响的是磁盘事实 → 全清；同时换代，让写之前发出的扫描结果不再被当成新鲜数据。
    stateGeneration += 1
    stateCache.clear()
    stateInflight.clear()
    notifyChatCatalog(ctx, invalidateSkills)
  }

  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  const registerProviders = (): (() => void) => {
    const disposers: Array<() => void> = []
    // 卸载竞态（0.21.2）：自定义目录那份 watcher 是**异步**挂上的（要先读状态文件）。
    // 如果插件在 `readManagerState()` 落地之前就被卸载，`dispose()` 已经跑完，随后那句
    // `disposers.push(...)` 就永远没人收 —— 结果是一个 Worker 线程加一组 fs.watch 句柄
    // 留在进程里（Worker 已 unref 不会挡住退出，但每次重载都多一份，热重载环境里会累积）。
    // 所以记一个"已卸载"标记：晚到的 disposer 当场自己跑掉。
    let disposed = false
    const add = (dispose: () => void): void => {
      if (disposed) { try { dispose() } catch { /* ignore */ } return }
      disposers.push(dispose)
    }
    try {
      const dispose = ctx.skills.registerProvider((control: any) => externalSkillProvider(control, providerInvalidators))
      if (typeof dispose === 'function') add(dispose)
    } catch (e) {
      console.error('[dsh-plugin-tool-management] global skills provider registration failed:', message(e))
    }
    try {
      add(registerAgentSkillProviders(ctx, providerInvalidators))
    } catch (e) {
      console.error('[dsh-plugin-tool-management] agent-scoped provider setup failed:', message(e))
    }
    try {
      const watchPaths = roots
        // 官方内置来源是宿主启动时物化的只读副本，不会中途变化，不起 watcher。
        .filter((root: any) => root.key !== 'official')
        .map((root: any) => String((root && root.path) || ''))
        .filter(Boolean)
      add(watchDirectories(watchPaths, invalidateSkills))
      // 自定义目录在状态文件里，注册时读取一次并一并监听（后添加的目录由
      // provider 首次 list 天然覆盖，等插件重载后才有 watcher）。
      readManagerState()
        .then((current) => {
          const customPaths = customRootsFromState(current.state)
            .map((root: any) => String((root && root.path) || ''))
            .filter(Boolean)
          if (customPaths.length) add(watchDirectories(customPaths, invalidateSkills))
        })
        .catch(() => { /* 状态不可用时仅监听静态根 */ })
    } catch (e) {
      console.error('[dsh-plugin-tool-management] skill watcher setup failed:', message(e))
    }
    return () => {
      disposed = true
      for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
      disposers.length = 0
    }
  }

  /** 成功 → {ok:true, data}；core 业务失败 → 原样透传 {ok:false,...}；成功后可选触发 afterWrite。 */
  const wrap = (fn: (args: any) => Promise<any>, after?: () => void) => async (args: any) => {
    const result = await fn(args)
    if (result && result.ok === false) return result
    if (after) { try { after() } catch { /* ignore */ } }
    return { ok: true, data: result }
  }

  const write = <T>(task: () => Promise<T>): Promise<T> => enqueueMutation(task)

  // 写操作清单：与下方 ops 表同文件同源维护；HTTP 端门禁由 index.ts 从本集合派生，勿在宿主端另抄一份。
  const writeOps: ReadonlySet<string> = new Set([
    'skill-enable', 'skill-disable', 'skill-source-enable', 'skill-source-disable',
    // 移除/恢复来源会改写本地来源状态（listProviderCandidates 随之变化，模型侧的技能目录
    // 也变），是写操作；漏在这份清单里 = 配了访问令牌也不会被要求带令牌。
    'skill-source-remove', 'skill-source-restore',
    'skill-prefer', 'skill-unprefer',
    'skill-create', 'skill-update', 'skill-import', 'skill-upload', 'skill-delete',
    // 批量启停与单条启停同权：配了访问令牌的宿主必须同样要求带令牌。
    'skill-set-all',
    'skill-trash-restore', 'skill-trash-delete', 'skill-custom-add', 'skill-custom-remove',
    // 「永久删除来源记录」（回收站 → 目录）：与上面两条同权，是写操作。
    'skill-source-forget',
  ])

  /**
   * 新建 / 导入 / 恢复技能后统一「默认停用」。**失败不能吞。**
   *
   * 这里原先写作 `.catch(() => undefined)`，两处都漏：一是抛出的写失败被吞，二是
   * `markSkillsDisabled` 在状态文件不可读时**不抛**、而是返回 `{ ok: false }` —— 那个
   * 返回值此前根本没被看过。两种情况下技能都停在启用态、下一轮就进模型上下文，而用户
   * 看到的是「创建成功」。
   *
   * 沿用 `sceneSyncError` 的形状：这里只给**原因原文**，句子由界面按当前语言拼
   * （服务端拼中文会让英文界面露出中文）。
   */
  async function disableNewSkills(targets: Array<{ root: string; name: string }>, res: any): Promise<any> {
    if (!targets.length) return res
    let reason: string | null = null
    try {
      const out: any = await markSkillsDisabled(targets, log)
      if (out && out.ok === false) reason = String(out.error || '状态文件不可读')
    } catch (e) {
      reason = message(e)
    }
    if (reason === null) return res
    // 本来就已经失败的回执：把原因并进 error，不要用 warning 把失败说成「成功但有提示」。
    return res && res.ok === false
      ? { ...res, error: `${res.error}；另外，「默认停用」也没能写入（${reason}）` }
      : { ...res, stateSyncError: reason }
  }

  const ops: Record<string, (args: any) => Promise<any>> = {
    // 读操作（state 走短 TTL 缓存，见上方 readState）
    // 会话层（0.21.2）：给了 `sessionId` 就只按该会话的 cwd 推导项目技能根。
    'skill-state': wrap((args) => readState(sessionIdOfArgs(args))),
    'skill-detail': wrap(async (args) => {
      const key = String(args.root || 'dsh')
      // requestRoot 未命中时回传原始 key，让 core 的 error.root.unknown 带上来源名（而非 undefined）。
      return skillDetail((await requestRoot(key)) || key, String(args.name || ''), projectOptions(sessionIdOfArgs(args)))
    }),
    'skill-browse': wrap((args) => browseDirectories(args && args.path)),
    // 启停（写 manager 状态，不改源文件）
    'skill-enable': wrap(
      (args) => write(async () => setSkillEnabled(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), true, log)),
      afterWrite,
    ),
    'skill-disable': wrap(
      (args) => write(async () => setSkillEnabled(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), false, log)),
      afterWrite,
    ),
    'skill-source-enable': wrap(
      (args) => write(async () => setSourceEnabled(await requestSwitchRoot(String(args.root || '')), true, log)),
      afterWrite,
    ),
    'skill-source-disable': wrap(
      (args) => write(async () => setSourceEnabled(await requestSwitchRoot(String(args.root || '')), false, log)),
      afterWrite,
    ),
    // 移除 / 恢复来源（「不再读取这个文件夹」）：只改本地状态，源目录一个字节都不动。
    'skill-source-remove': wrap(
      (args) => write(async () => setSourceRemoved(await requestRoot(String(args.root || '')), true, log)),
      afterWrite,
    ),
    'skill-source-restore': wrap(
      (args) => write(async () => setSourceRemoved(await requestRoot(String(args.root || '')), false, log)),
      afterWrite,
    ),
    // 同名技能首选来源（手工指定哪个同名版本生效；只写本地策略）。
    'skill-prefer': wrap(
      (args) => write(async () => setPreferredSkill(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), true, log)),
      afterWrite,
    ),
    'skill-unprefer': wrap(
      (args) => write(async () => setPreferredSkill(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), false, log)),
      afterWrite,
    ),
    /**
     * 批量启停（技能页 / 记忆页那种「全选 / 取消全选」用）。
     *
     * 为什么要有它：前端逐条打单条 op 时，每次成功都会清状态缓存 + 重扫技能目录 +
     * 广播 agent-preset 事件，几十上百条就是几十上百轮全量重扫。这里一次写锁走完、
     * 只在最后失效一次。逐条仍复用单条写通道（不另写一份策略逻辑）。
     */
    'skill-set-all': wrap(
      (args) => write(async () => {
        const items: any[] = Array.isArray(args && args.items) ? args.items : []
        const enabled = (args && args.enabled) === true
        const failed: Array<{ root: string; name: string; error: string }> = []
        let changed = 0
        for (const item of items) {
          const rootKey = String((item && item.root) || '')
          const name = String((item && item.name) || '')
          if (!rootKey || !name) continue
          const res = await setSkillEnabled(await requestRoot(rootKey), name, enabled, log)
          if (res && res.ok === false) failed.push({ root: rootKey, name, error: String(res.error || '') })
          else changed++
        }
        return { enabled, changed, failed }
      }),
      afterWrite,
    ),
    // 创建 / 导入 / 删除 / 回收站
    // 创建默认落 **DSH 技能目录**（用户裁定 2026-10-15）：v0.4 起这里是 hub，现在改回 dsh ——
    // hub（`tool-management/skills/`）只服务「导入技能」功能。与 UI「创建技能」的
    // `defaultCreateRoot`、core.js 的 createSkill 默认值同口径；core 里的那份是第二道保险。
    // 落点变了但有一件事没变：`skill_manager_switch` / `_remove` 侧跨来源解析照旧兜得住（P0-1）。
    'skill-create': wrap(
      (args) => write(async () => {
        // requestRoot 未命中时回传原始 key，让 core 的 error.root.unknown 带上来源名
        // （否则传了不存在的 root 会收到「技能来源不存在：(空)」这种指错方向的提示）。
        const key = String(args.root || 'dsh')
        const res = await createSkill(
          { name: args.name, description: args.description, body: args.body, files: args.files },
          log,
          { root: (await requestRoot(key)) || key },
        )
        // v0.8.5：新建技能默认不启动（用户裁定）——与子智能体 / MCP 同口径。
        if (res && res.ok !== false && res.name) {
          return disableNewSkills([{ root: String(res.root || 'hub'), name: String(res.name) }], res)
        }
        return res
      }),
      afterWrite,
    ),
    // 改写**本插件自己写的那一份**技能。先跨来源找胜出者，再要求它落在本插件可写的两个根
    // （hub / dsh，见 PLUGIN_WRITABLE_ROOTS）里：同名技能在 dsh / agents / claude / 自定义根
    // 各有一份时只有一份生效，改错那一份会返回 OK 而技能毫无变化（用户实测踩过：同一技能
    // 四份并存，启错根等于没启）。胜出者判定要读来源排序与首选设置，属于状态层，所以在这里
    // 做；core 的 `updateSkill` 只保证不越出给定根。
    //
    // 门禁为什么不能只认 hub：新建默认落点 2026-10-15 改到 dsh 后，模型 `skill_manager_save`
    // 建出来的技能全在 dsh；只认 hub 时改的分支永远找不到 hub 胜出者，「新建 → 再存一次」
    // 直接回 error.update.notOwnRoot。可写集合跟着落点一起扩才闭环。
    'skill-update': wrap(
      (args) => write(async () => {
        const wanted = String(args.name || '').trim()
        const s: any = await readState()
        const hits: Array<{ rootKey: string; shadowedBy: string }> = []
        for (const root of (s && s.roots) || []) {
          for (const skill of root.skills || []) {
            if (String(skill.declaredName || skill.name || '') !== wanted) continue
            hits.push({
              rootKey: String(root.key || ''),
              shadowedBy: skill.shadowedBy && skill.shadowedBy.root ? String(skill.shadowedBy.root) : '',
            })
          }
        }
        if (!hits.length) {
          return { ok: false, code: 'error.update.notFound', params: { name: wanted }, error: `技能不存在：${wanted}` }
        }
        const winner = hits.find((h) => !h.shadowedBy) || hits[0]
        if (!PLUGIN_WRITABLE_ROOTS.has(winner.rootKey)) {
          return {
            ok: false,
            code: 'error.update.notOwnRoot',
            params: { name: wanted, root: winner.rootKey },
            error: `技能 ${wanted} 的生效副本在来源「${winner.rootKey}」，不在本插件可写的目录（hub = 导入落点；dsh = $DSH_HOME/skills）：本插件不修改官方根里的技能`,
          }
        }
        // 写**胜出者所在的那个根**，不能写死 hub：同名两边各有一份时写错那份，
        // 正是这道判定要防的「返回 OK 而技能毫无变化」。
        return updateSkill(
          { name: args.name, description: args.description, body: args.body },
          log,
          { root: (await requestRoot(winner.rootKey)) || winner.rootKey },
        )
      }),
      afterWrite,
    ),
    'skill-import': wrap(
      (args) => write(async () => {
        const res = await importSkill(String(args.source || ''), log, {
          conflict: args.conflict === 'overwrite' ? 'overwrite' : 'skip',
          dryRun: args.dryRun === true,
        })
        // 导入的技能默认停用；部分成功也对 imported 逐条停用。
        const names = res && Array.isArray(res.imported) ? res.imported : []
        return disableNewSkills(names.map((n: unknown) => ({ root: 'hub', name: String(n) })), res)
      }),
      afterWrite,
    ),
    'skill-upload': wrap(
      (args) => write(async () => {
        const res = await importUploadedSkill({ name: args.name, entries: args.entries, zip: args.zip }, log, {
          conflict: args.conflict === 'overwrite' ? 'overwrite' : 'skip',
          // 上传导入撞名一律退号新增（用户 2026-10-15）：静默跳过会让用户想要的
          // 那份根本没进来，结果里只多一行"已跳过"。目录导入（skill-import）
          // 不带这个开关，仍是 skip / overwrite 二选一。
          dedupe: true,
        })
        // 上传/导入同口径：默认停用。
        const names = res && Array.isArray(res.imported) ? res.imported : (res && res.name ? [res.name] : [])
        return disableNewSkills(names.map((n: unknown) => ({ root: 'hub', name: String(n) })), res)
      }),
      afterWrite,
    ),
    'skill-delete': wrap(
      (args) => write(async () => deleteSkill(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), log)),
      afterWrite,
    ),
    'skill-trash-restore': wrap(
      (args) => write(async () => {
        // `dedupe: true` = 界面上"已存在同名技能，是否恢复为 foo-1"确认过之后那一次
        // （用户 2026-10-14）；不带时撞名照旧拒绝，并把候选名字放在 `params.next` 里回给弹窗。
        const res = await restoreTrash(String(args.id || ''), log, {
          ...projectOptions(),
          dedupe: args.dedupe === true,
        })
        // 恢复的技能默认停用（v0.8.5 用户裁定：新建/导入/恢复一律不启动，手动开启）。
        // `res.name` 是**最终落盘的名字**（退号恢复时不是回收站里的原名），启停状态必须按它写。
        if (res && res.ok !== false && res.name) {
          return disableNewSkills([{ root: String(res.root || 'hub'), name: String(res.name) }], res)
        }
        return res
      }),
      afterWrite,
    ),
    'skill-trash-delete': wrap(
      (args) => write(() => permanentlyDeleteTrashSafely(String(args.id || ''), log)),
    ),
    // 自定义技能目录：添加（绝对路径，只读接入）/ 移除（连同策略键）。
    'skill-custom-add': wrap(
      (args) => write(() => addCustomRoot(args && args.path, args && args.label, log)),
      afterWrite,
    ),
    'skill-custom-remove': wrap(
      (args) => write(() => removeCustomRoot(args && args.key, log)),
      afterWrite,
    ),
    // 永久删除一条**按约定发现**的来源记录（agents / codex / claude）。与 `skill-custom-remove`
    // 的分工见 core.ts 的 `forgetSource`：那条管用户手加的自定义目录，这条管推导出来的来源
    // —— 后者不在状态文件的 customRoots 里，必须另记一份"已永久删除"名单才删得掉。
    'skill-source-forget': wrap(
      (args) => write(() => forgetSource(args && args.root, log)),
      afterWrite,
    ),
  }

  /**
   * 该绝对路径是否落在「本插件认识的技能来源」内。
   *
   * 为什么需要它：`skill-open` 会把路径交给**系统默认编辑器**，不设边界的话它就是一个
   * 「任意绝对路径 → 启动外部程序」的入口。三类来源都要收进来，否则会把合法技能误挡在外：
   * 静态根（`userRoots`）+ 状态文件里的自定义根 + 当前活动工作区的项目来源。
   */
  async function isInsideKnownSkillRoot(abs: string): Promise<boolean> {
    const dirs: string[] = roots.map((r: any) => String((r && r.path) || '')).filter(Boolean)
    try {
      for (const r of customRootsFromState((await readManagerState()).state)) {
        if (r && r.path) dirs.push(String(r.path))
      }
    } catch { /* 状态不可读 → 只用静态根 */ }
    try {
      for (const r of await projectRoots(projectOptions().projectCwds)) {
        if (r && r.path) dirs.push(String(r.path))
      }
    } catch { /* 项目来源解析失败 → 跳过 */ }
    for (const dir of dirs) {
      try { if (await isInsideRootResolved(dir, abs)) return true } catch { /* 单个根失败不影响其他 */ }
    }
    return false
  }

  return { ops, writeOps, registerProviders, isInsideKnownSkillRoot }
}
