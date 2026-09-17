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
  skillDetail,
  listProviderCandidates,
  getProviderSkill,
  userRoots,
  projectRoots,
  readManagerState,
  customRootsFromState,
  addCustomRoot,
  removeCustomRoot,
  logPath,
  trashRootPath,
} from './core.js'

const MAX_LOG_BYTES = 1 << 20
const PROVIDER_NAME = 'dsh-plugin-tool-management-external'

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

// ── 系统回收站（永久删除的最后一道保险） ──────────────────────────────────

function runQuietly(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: any
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', (code: number) => resolve(code === 0))
  })
}

function psQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Win → 回收站；macOS → ~/.Trash；Linux → gio trash。失败返回 false。 */
async function moveToSystemTrash(abs: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(" + psQuote(abs) + ", 'OnlyErrorDialogs', 'SendToRecycleBin')",
      ].join('; ')
      return await runQuietly('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    }
    if (process.platform === 'darwin') {
      await rename(abs, join(homedir(), '.Trash', basename(abs) + '-' + Date.now()))
      return true
    }
    return await runQuietly('gio', ['trash', abs])
  } catch {
    return false
  }
}

/**
 * 永久删除回收站条目：先尝试系统回收站（用户仍可在系统里找回），
 * 失败才落到 core 的硬删除 —— 让「永久删除」也不会静默丢数据。
 */
async function permanentlyDeleteTrashSafely(
  id: string,
  log: (event: string, detail?: unknown) => Promise<void>,
): Promise<any> {
  const clean = String(id || '').trim()
  const root = trashRootPath()
  const sep = root.indexOf('\\') >= 0 ? '\\' : '/'
  const target = /^[A-Za-z0-9._-]{1,128}$/.test(clean) ? root + sep + clean : null
  if (target && target.indexOf(root + sep) === 0 && existsSync(target)) {
    if (await moveToSystemTrash(target)) {
      await log('trash-delete-system', { id: clean, path: target })
      return { id: clean, method: 'system-trash' }
    }
  }
  return permanentlyDeleteTrash(clean, log)
}

// ── 文件监听：外部改动自动失效 ────────────────────────────────────────────

/**
 * 监听目录，200ms 防抖后回调：在编辑器或其他工具里新增/修改/删除文件后，无需手动
 * 刷新即可看到变化。技能来源与规则根目录共用（见 src/rules/service.ts 的场景记忆段缓存）。
 *
 * 为什么用 worker_threads：Windows 上 fs.watch(recursive) 的句柄在「被监听
 * 目录被删除」时会静默卡死事件循环（不触发 error、unref 也无效）——宿主
 * 进程将永远无法退出。把 watcher 放进独立的 worker 线程，主线程对 worker
 * unref()，无论目录发生什么，宿主与测试进程都能正常收尾；worker 内部失败
 * 也不影响主线程。目录不存在或平台不支持递归监听时静默跳过。
 */
function watchDirectories(paths: string[], invalidate: () => void): () => void {
  const valid = paths.filter((dir) => dir && existsSync(dir))
  if (!valid.length) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { invalidate() } catch { /* 失效失败不影响监听 */ }
    }, 200)
  }
  let worker: import('node:worker_threads').Worker | null = null
  try {
    // eval 模式内联 worker 代码：无需额外文件与构建步骤。worker 事件循环独立，
    // 主线程 unref 后完全不参与宿主进程的退出判定。
    const src = `
      const { watch } = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      for (const dir of workerData.paths) {
        try {
          const w = watch(dir, { recursive: true, persistent: false }, () => {
            try { parentPort.postMessage('change') } catch { /* worker 正在关闭 */ }
          });
          w.on('error', () => { /* 目录被移除等：忽略，不向主线程传播 */ });
        } catch { /* 不可监听（权限/平台）时跳过该目录 */ }
      }
    `
    worker = new Worker(src, { eval: true, workerData: { paths: valid } })
    worker.unref()
    worker.on('message', () => fire())
    worker.on('error', () => { /* worker 崩溃即失去监听；op 全量重扫天然兜底 */ })
  } catch { /* worker 不可用时静默跳过，功能退化为依赖 op 全量扫描 */ }
  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (worker) {
      const w = worker
      worker = null
      try { w.removeAllListeners(); w.terminate() } catch { /* ignore */ }
    }
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

/** manager provider：以 core 的候选/正文接口接管四个来源（含启停策略）。 */
function externalSkillProvider(control: any, invalidators: Set<() => void>): any {
  if (control && typeof control.invalidate === 'function') invalidators.add(control.invalidate)
  if (control && control.signal && typeof control.signal.addEventListener === 'function') {
    control.signal.addEventListener('abort', () => { invalidators.delete(control.invalidate) }, { once: true })
  }
  return {
    name: PROVIDER_NAME,
    list: async (options: any) => listProviderCandidates(options),
    get: async (candidate: any, options: any) => getProviderSkill(candidate, options),
  }
}

/**
 * 在每个活动 agent 的 scope 内注册同一 provider。
 * 用户级技能由 agent-preset 的 scoped 层解析；只有在 agent 自己的层里注册，
 * 候选 rank 覆盖才能对它们生效（详见上游 registerAgentSkillProviders）。
 */
function registerAgentSkillProviders(ctx: any, invalidators: Set<() => void>): () => void {
  const on = ctx && ctx.on
  if (typeof on !== 'function') return () => {}
  const registrations = new Map<string, () => void>()
  const skillsOf = (agent: any) => {
    const agentCtx = agent && agent.ctx
    if (!agentCtx) return null
    const skills = typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx.skills
    return skills && typeof skills.registerProvider === 'function' ? skills : null
  }
  const install = (agent: any) => {
    if (!agent || agent.id == null || registrations.has(agent.id)) return
    const skills = skillsOf(agent)
    if (!skills) return
    try {
      const dispose = skills.registerProvider((control: any) => externalSkillProvider(control, invalidators))
      registrations.set(agent.id, typeof dispose === 'function' ? dispose : () => {})
    } catch (e) {
      console.error('[dsh-plugin-tool-management] agent-scoped skills provider registration failed:', message(e))
    }
  }
  const uninstall = (agent: any) => {
    const id = agent && agent.id
    if (id == null) return
    const dispose = registrations.get(id)
    registrations.delete(id)
    if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
  }
  const stopCreated = on('agent/created', (payload: any) => install(payload && payload.agent))
  const stopDisposed = on('agent/disposed', (payload: any) => uninstall(payload && payload.agent))
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) install(agent)
    }
  } catch { /* agents 服务不可用 → 仅靠事件 */ }
  return () => {
    if (typeof stopCreated === 'function') stopCreated()
    if (typeof stopDisposed === 'function') stopDisposed()
    for (const dispose of registrations.values()) { try { dispose() } catch { /* ignore */ } }
    registrations.clear()
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

export interface SkillsService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /** 注册全局层与 agent-scope provider；返回清理函数（配合 ctx.effect）。 */
  registerProviders: () => () => void
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
  const projectOptions = () => ({ projectCwds: activeSessionCwds(ctx) })
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
  let stateCache: { at: number; value: unknown } | null = null
  const readState = async (): Promise<unknown> => {
    if (stateCache && Date.now() - stateCache.at < STATE_TTL_MS) return stateCache.value
    const value = await state(projectOptions())
    stateCache = { at: Date.now(), value }
    return value
  }

  const afterWrite = () => {
    stateCache = null
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
    try {
      const dispose = ctx.skills.registerProvider((control: any) => externalSkillProvider(control, providerInvalidators))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (e) {
      console.error('[dsh-plugin-tool-management] global skills provider registration failed:', message(e))
    }
    try {
      disposers.push(registerAgentSkillProviders(ctx, providerInvalidators))
    } catch (e) {
      console.error('[dsh-plugin-tool-management] agent-scoped provider setup failed:', message(e))
    }
    try {
      const watchPaths = roots.map((root: any) => String((root && root.path) || '')).filter(Boolean)
      disposers.push(watchDirectories(watchPaths, invalidateSkills))
      // 自定义目录在状态文件里，注册时读取一次并一并监听（后添加的目录由
      // provider 首次 list 天然覆盖，等插件重载后才有 watcher）。
      readManagerState()
        .then((current) => {
          const customPaths = customRootsFromState(current.state)
            .map((root: any) => String((root && root.path) || ''))
            .filter(Boolean)
          if (customPaths.length) disposers.push(watchDirectories(customPaths, invalidateSkills))
        })
        .catch(() => { /* 状态不可用时仅监听静态根 */ })
    } catch (e) {
      console.error('[dsh-plugin-tool-management] skill watcher setup failed:', message(e))
    }
    return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
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
    'skill-create', 'skill-import', 'skill-upload', 'skill-delete',
    // 批量启停与单条启停同权：配了访问令牌的宿主必须同样要求带令牌。
    'skill-set-all',
    'skill-trash-restore', 'skill-trash-delete', 'skill-custom-add', 'skill-custom-remove',
  ])

  const ops: Record<string, (args: any) => Promise<any>> = {
    // 读操作（state 走短 TTL 缓存，见上方 readState）
    'skill-state': wrap(() => readState()),
    'skill-detail': wrap(async (args) => {
      const key = String(args.root || 'dsh')
      // requestRoot 未命中时回传原始 key，让 core 的 error.root.unknown 带上来源名（而非 undefined）。
      return skillDetail((await requestRoot(key)) || key, String(args.name || ''), projectOptions())
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
    // 创建默认落 hub（`tool-management/skills/`）：UI 不传 root 时走这里；
    // core.js 的 createSkill 默认值是第二道保险（同口径）。官方 `~/.dsh/skills/` 仍作为来源列出。
    'skill-create': wrap(
      (args) => write(async () => {
        // requestRoot 未命中时回传原始 key，让 core 的 error.root.unknown 带上来源名
        // （否则传了不存在的 root 会收到「技能来源不存在：(空)」这种指错方向的提示）。
        const key = String(args.root || 'hub')
        const res = await createSkill(
          { name: args.name, description: args.description, body: args.body },
          log,
          { root: (await requestRoot(key)) || key },
        )
        // v0.8.5：新建技能默认不启动（用户裁定）——与子智能体 / MCP 同口径。
        if (res && res.ok !== false && res.name) {
          await markSkillsDisabled([{ root: String(res.root || 'hub'), name: String(res.name) }], log).catch(() => undefined)
        }
        return res
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
        if (names.length) await markSkillsDisabled(names.map((n: unknown) => ({ root: 'hub', name: String(n) })), log).catch(() => undefined)
        return res
      }),
      afterWrite,
    ),
    'skill-upload': wrap(
      (args) => write(async () => {
        const res = await importUploadedSkill({ name: args.name, entries: args.entries, zip: args.zip }, log, {
          conflict: args.conflict === 'overwrite' ? 'overwrite' : 'skip',
        })
        // 上传/导入同口径：默认停用。
        const names = res && Array.isArray(res.imported) ? res.imported : (res && res.name ? [res.name] : [])
        if (names.length) await markSkillsDisabled(names.map((n: unknown) => ({ root: 'hub', name: String(n) })), log).catch(() => undefined)
        return res
      }),
      afterWrite,
    ),
    'skill-delete': wrap(
      (args) => write(async () => deleteSkill(await requestRoot(String(args.root || 'dsh')), String(args.name || ''), log)),
      afterWrite,
    ),
    'skill-trash-restore': wrap(
      (args) => write(async () => {
        const res = await restoreTrash(String(args.id || ''), log, projectOptions())
        // 恢复的技能默认停用（v0.8.5 用户裁定：新建/导入/恢复一律不启动，手动开启）。
        if (res && res.ok !== false && res.name) {
          await markSkillsDisabled([{ root: String(res.root || 'hub'), name: String(res.name) }], log).catch(() => undefined)
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
  }

  return { ops, writeOps, registerProviders }
}
