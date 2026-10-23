// 会话作用域的 HTTP op（状态层；四层模型）。
//
//   scope-get            只读：某个会话的覆盖 + 全局快照 + 生效差异（空 sessionId = 全局层）
//   scope-set            写：设一个键（布尔开关）/ 进出一个场景
//   scope-clear          写：清一个键 / 一个域 / 整个会话
//   scope-sessions-list  只读：当前会话区里的未归档会话（下拉框的数据源，按工作区分组）
//   scope-lock           写：锁 / 解锁某个会话的覆盖
//   scope-intent-set     写：MCP 服务器 / 技能来源的全局意图（on / off / blocked）
//
// ## 为什么这几条都不标 frozen
//
// 场景锁（`index.scenes[n].locked`）冻结的是**全局**写入。会话覆盖是叠加在
// 全局之上的视图偏好，它改不动任何全局状态 —— 全局那一份在锁着的时候本来就没人能改。
// 让场景锁连"本会话先别看这个服务器"也一起挡住，等于把一个视图开关关进写门禁，
// 用户能做的只有"解锁 → 改 → 再锁上"，而那个空窗期恰恰是锁要防的。
//
// 会话锁是另一把锁，只冻结**这个会话自己**的 `scope-set` / `scope-clear`。
// `scope-lock` 自己不能被它挡住，否则锁上就解不开了（与 `rules-scene-lock` 同一条）。
//
// ## 场景模式：`scope-set` 的 scene 分支 = 进出场景
//
// `value` 给场景名 = **进入**该场景（本会话）；`value` 给 null / 空串 = **退出场景**。
// 两件事都只写会话侧车；进入后跑一轮意图对账 —— 场景勾中的全局关着的服务器 / 来源成为
// **租约**（运行起来，但意图仍是 off，别的会话看不到）。见 `deps.reconcile`。
// 模型工具表：场景绑了方案就在进入这一次**套到本对话**（不改全局那份）
// 退出时连本对话在场景里改过的一起清掉，回到创建时抄的基线。
//
// ## 为什么 `scope-set` 不接"写全局"
//
// 全局写入有五条各不相同的路径（索引 / 状态文件 / 补丁 / 快捷词 meta / 场景），把它们
// 收进一条 op 就是第五份实现。面板改全局时照旧调各域自己的 op；模型工具要改全局也走
// 各域自己的工具（`skill_manager_switch` 等），由那边按 `scope: "global"` 分派。

import {
  PROMPT_CONTENT_MAX_BYTES,
  SCOPE_FLAG_DOMAINS,
  applyFlag,
  effectiveDiff,
  enterSceneInScope,
  exitSceneInScope,
  isFlagDomain,
  isEmptyScope,
  isKeepableScope,
  layerParentSnapshot,
  layeredFlag,
  normalizeSessionScope,
  overrideCountOf,
  promptOverrideOf,
  pruneScope,
  scopeForLayerSeed,
  withBaseline,
  type ScopeFlagDomain,
  type ScopeGlobalSnapshot,
  type ScopeMode,
  type ScopeOverrides,
  type SessionBaseline,
  type SessionScope,
} from '../scope/scope-overrides.js'
import { effectiveLayerOf, isIntentDomain, normalizeIntentState, type IntentDomain, type IntentState, type ScopeReconcileReport } from '../scope/intent.js'
import { normalizePresetId } from '../prompts/preset-id.js'
import { isWorkspaceScopeKey, scopeKeyLabel, scopeKeyOfRow, workspaceScopeKeyOf } from '../scope/workspace-key.js'
import { workspaceBaseName } from '../sessions/path-key.js'
import type { ScopeStore } from '../scope/store.js'
import type { SceneArchive } from '../memories/archive.js'

/** 下拉框里的一行。 */
export interface ScopeSessionRow {
  id: string
  title: string
  /** 覆盖条目数（`scene` 算一条）。 */
  count: number
  /** 已归档（归档会话的覆盖保留，但不出现在下拉框里）。 */
  archived: boolean
  /** 工作区目录：下拉框按它分组（空串 = 未归属）。 */
  cwd?: string
  /** 工作区模式下这一行代表一个工作区（id 是 `ws:` 键）；缺省 = 会话行。 */
  kind?: 'session' | 'workspace'
  /** 工作区行：这个工作区里有几个会话（含被空壳过滤掉的？不，只算列出来的）。 */
  sessions?: number
}

/** 会话覆盖 op 的依赖：覆盖存储 + 会话键解析。 */
export interface ScopeOpsDeps {
  store: ScopeStore
  /**
   * 把外部给的 `sessionId` / 作用域键折成**当前模式**的作用域键。
   *
   * 面板传的是选中的层键；斜杠菜单 / 旧调用仍传真实 sessionId —— 工作区模式下必须折到
   * `ws:<cwd>`，否则会写进一条永远读不到的会话记录。缺省 = 原样使用（兼容测试/旧装配）。
   */
  resolveKey?(idOrKey: string): Promise<string>
  /** 当前隔离粒度（同步读 store 缓存；缺省 = session）。 */
  mode?(): ScopeMode
  /**
   * 模式切换之后的通知：重排工具可见性、刷新两个目录、跑一轮不采纳的意图对账。
   * 通知失败绝不能把已经落盘的模式切换报成失败。
   */
  onModeChanged?(mode: ScopeMode): void
  /** 全局快照：当前场景 + 各域各键的全局开关。读失败由调用方兜（见 index.ts 的装配）。 */
  global(): Promise<ScopeGlobalSnapshot>
  /** 全部会话（含已归档标记）。标题由装配层从投影缓存取，取不到就退回 cwd / id 前缀。 */
  sessions(): Promise<ScopeSessionRow[]>
  /**
   * 会话摘要（宿主投影缓存）：真实标题 + 有没有过用户输入。
   * 取不到返回 undefined（调用方保留兜底标题、不做空壳过滤）。
   */
  summaryOf?(sessionId: string): Promise<{ title?: string; hasMessages: boolean } | undefined>
  /**
   * 某个场景的档案（**同步**，装配层从内存索引读）。`undefined` = 档案不存在 / 没有这一段。
   * 场景层据此实时计算（档案改了，下一个请求就跟着变）。
   */
  sceneArchiveOf?(scene: string): SceneArchive | undefined
  /** 场景存在吗（进入前校验；不接 = 不校验）。 */
  sceneExists?(scene: string): Promise<boolean>
  /**
   * 场景绑定的模型工具表方案：返回关停名单；方案不存在返回 null。
   * 进入场景时**套到本对话**（不是改全局）—— 工具表是每个对话自己的整份名单。
   */
  toolTablePresetHidden?(name: string): Promise<string[] | null>
  /** 本进程注册过的工具名：过滤方案里已经不存在的历史名字（不接 = 不过滤）。 */
  toolTableAvailable?(): { has(name: string): boolean }
  /**
   * 捕获"会话创建时的样子"（基线）。装配层读全局快照来生成；失败返回 null。
   * 进入 / 退出场景前确保有 —— 退出要回到它，而它只有在那一刻之前取才是"创建时的样子"。
   */
  captureBaseline?(): Promise<SessionBaseline | null>
  /**
   * 跑一轮意图对账：运行态 := 意图 ∪ 租约。
   *
   * 写会话覆盖 / 写全局意图之后都调它 —— 新写入的"开"是一条租约，服务器 / 来源要跟着
   * 被拉起来；写入的"关"若带走了最后一个租约，也要跟着停。返回逐条结果（失败与刚拉起的
   * 资源），写 op 据此拼回执。
   */
  reconcile?(opts?: { adoptExternal?: boolean }): Promise<ScopeReconcileReport>
  /** 写全局意图（`scope-intent-set` 用）；返回错误串，null = 成功。 */
  writeIntent?(domain: IntentDomain, keys: readonly string[], state: IntentState): Promise<string | null>
  /**
   * 预设正文（`scope-prompt-set` 的 apply 用）：返回 null = 不存在 / 读不到。
   * 应用前读一次是为了校验并拒绝空预设 —— 只存一个悬空 id 会让界面显示"已应用"却没有正文。
   */
  presetContent?(id: string): Promise<string | null>
  /**
   * 本会话**生效**的用户级提示词正文（`scope-get` 回给界面做编辑预填）。
   * 无会话覆盖时给全局链那份；读失败返回空串（界面按空框处理）。
   */
  promptTextOf?(sessionId: string): string
  /**
   * 确保本会话的提示词**冻结快照**已捕获（首次写会话提示词前调一次）。
   *
   * 快照平时由注入侧首见捕获；但"面板先于第一条消息打开、先写了会话正文"这条路上没人
   * 捕获过 —— 之后「恢复全局」会退到**当时的**全局文件，而不是会话出生时那份。
   * 读失败返回 `undefined`（这次不写快照，与注入侧同一降级）。
   */
  ensurePromptBaseline?(sessionId: string): string | undefined
  /**
   * 覆盖写入成功后的通知。`domain` = 这一笔改的域；清除整个会话时按 `''` 报。
   *
   * 用途只有一处：MCP 会话覆盖会改变「本会话可见的工具」，而可见性层（官方
   * `tools.restrict`）只在 `tools/change` 时重排 —— 写侧不动它，界面拨回开关后模型
   * 那边要等下一次无关的工具变化才恢复。装配层据此重排。
   */
  onChanged?: (sessionId: string, domain: string) => void
  message(e: unknown): string
}

/** 覆盖表里这个会话的那一条。 */
function scopeOrEmpty(overrides: ScopeOverrides, sessionId: string): SessionScope | undefined {
  return overrides.sessions[sessionId]
}

/**
 * 全局粒度下写会话层的统一拒绝文案。
 *
 * 三条写 op（`scope-set` / `scope-clear` / `scope-lock`）共用一句：它们都收一个具体
 * sessionId，而全局粒度下那个身份没有可写的格子。静默转成全局写入是不行的 —— 用户点的是
 * "这个对话"，扩大成整台机器没有任何提示，事后也看不出是哪一步变宽的。
 */
const GLOBAL_MODE_NO_LAYER = '隔离已关闭（全局模式）：没有会话层可写。要改就改全局设置，或在界面上把隔离粒度调成「按对话」/「按工作区」。'

/** 会话作用域的 op：状态、四层并值、覆盖读写与租约认领。 */
export function buildScopeOps(deps: ScopeOpsDeps): Record<string, (args: any) => Promise<any>> {
  /** 当前隔离粒度（同步；没接 = session）。 */
  const modeOf = (): ScopeMode => deps.mode?.() ?? 'session'
  /** 外部键 → 当前模式的作用域键。失败按原样（宁可少共享，不串工作区）。 */
  async function resolveKey(raw: string): Promise<string> {
    if (raw === '' || deps.resolveKey === undefined) return raw
    try { return await deps.resolveKey(raw) } catch { return raw }
  }
  /** 错误 / 提示里的人话主语：会话 or 工作区。 */
  function layerWord(key: string): string {
    return key.startsWith('ws:') ? '工作区' : '会话'
  }
  /** 会话锁判据：锁着就拒（`scope-lock` 不调它）。 */
  async function lockedError(sessionId: string): Promise<string | null> {
    const scope = await deps.store.scopeOf(sessionId)
    if (scope?.locked !== true) return null
    return `${layerWord(sessionId)}「${scopeKeyLabel(sessionId)}」的作用域已锁定：先解锁再改`
  }
  /** 通知装配层（见 `onChanged` 文档）。通知失败绝不能把已落盘的写入报成失败。 */
  function notifyChanged(sessionId: string, domain: string): void {
    if (deps.onChanged === undefined) return
    try { deps.onChanged(sessionId, domain) } catch { /* best effort */ }
  }
  /** 场景档案（同步）。没有 `sceneArchiveOf` 或没有场景 → undefined（这一层没话说）。 */
  function archiveOf(scope: SessionScope | undefined): SceneArchive | undefined {
    if (deps.sceneArchiveOf === undefined || scope?.scene === undefined) return undefined
    try { return deps.sceneArchiveOf(scope.scene) } catch { return undefined }
  }
  /** 确保基线在（进入 / 退出前调）。返回这次新捕获的那份；已有 / 失败返回 null。 */
  async function ensureBaseline(sessionId: string, current: SessionScope | undefined): Promise<SessionBaseline | null> {
    if (current?.baseline !== undefined && current.baseline.capturedAt !== undefined) return null
    if (deps.captureBaseline === undefined) return null
    try { return await deps.captureBaseline() } catch { return null }
  }
  /**
   * 提示词冻结快照（写会话提示词前确保有）。已有 / 读不到 / 未接 = undefined。
   * 与记忆 / 开关的基线不是同一份：那份是"出生时的全局开关"，这份是"出生时的 AGENTS.md"。
   */
  function capturePromptBaselineOnce(sessionId: string): string | undefined {
    if (deps.ensurePromptBaseline === undefined) return undefined
    try { return deps.ensurePromptBaseline(sessionId) } catch { return undefined }
  }
  /**
   * 这一格落到哪些**意图**域/键上（逐工具 → 服务器；单条技能 → 自己 + 所在来源）。
   *
   * 用途只有两个：判断全局是不是「统一关闭」，以及回执里点名"仅为这个对话临时运行"的那一格。
   * 技能要**两个**都查：来源被统一关闭时，技能级策略表开着也加载不到 —— 只查自己会给出
   * 一条"能开"的假承诺。
   */
  function intentTargetsOf(domain: ScopeFlagDomain, key: string): Array<{ domain: IntentDomain; key: string }> {
    if (domain === 'mcp') return [{ domain: 'mcp', key }]
    if (domain === 'skillSources') return [{ domain: 'skillSources', key }]
    if (domain === 'mcpTools') {
      const i = key.indexOf('/')
      return i > 0 ? [{ domain: 'mcp', key: key.slice(0, i) }] : []
    }
    if (domain === 'skills') {
      const i = key.indexOf('/')
      if (i <= 0) return []
      const out: Array<{ domain: IntentDomain; key: string }> = [{ domain: 'skills', key }]
      const source = intentSourceOf(key)
      if (source !== null) out.push({ domain: 'skillSources', key: source })
      return out
    }
    return []
  }
  /** 一条技能键（`<root>/<名>`）所属的来源；不是这种形状返回 null。 */
  function intentSourceOf(key: string): string | null {
    const i = key.indexOf('/')
    return i > 0 ? key.slice(0, i) : null
  }
  /** 意图格的中文名义（回执里点名用；服务端文案本来就拼中文，与其余警告同口径）。 */
  function intentLabel(domain: IntentDomain): string {
    return domain === 'mcp' ? 'MCP 服务器' : domain === 'skillSources' ? '技能来源' : '技能'
  }

  /** 写侧的下层值：场景层 → 基线 → 全局（域整体读不到时返回 undefined 并标记）。 */
  function parentValueOf(scope: SessionScope | undefined, archive: SceneArchive | undefined, global: ScopeGlobalSnapshot, domain: ScopeFlagDomain, key: string): { value: boolean; unknown: boolean } {
    const lower = layeredFlag(scope, archive, domain, key)
    if (lower !== undefined) return { value: lower, unknown: false }
    if ((global.unavailable ?? []).includes(domain)) return { value: false, unknown: true }
    return { value: global.flags[domain]?.[key] === true, unknown: false }
  }

  /**
   * 把一轮对账裁成"这几格"的人话警告（空 = 不需要说什么）。
   *
   * 只说两种：**没拉起来**（用户在场景里勾了它、工具却调不到）与**租约拉起**
   * （"全局设置没变，只是这个对话临时在跑"—— 用户最能误解的一步）。
   */
  function reconcileWarnings(report: ScopeReconcileReport | undefined, entries: ReadonlyArray<{ domain: IntentDomain; key: string }>): string[] {
    if (report === undefined) return []
    const started = new Set(report.started.map((item) => item.domain + '\u0000' + item.key))
    const failed = new Map(report.failed.map((item) => [item.domain + '\u0000' + item.key, item.error || '未知错误']))
    const out: string[] = []
    for (const entry of entries) {
      const id = entry.domain + '\u0000' + entry.key
      const noun = intentLabel(entry.domain)
      const error = failed.get(id)
      if (error !== undefined) out.push(`${noun}「${entry.key}」没能在后台启动（${error}）：这个对话里它暂时用不了`)
      else if (started.has(id)) out.push(`${noun}「${entry.key}」全局关着：仅为这个对话临时运行，全局设置未变`)
    }
    return out
  }

  return {
    // 一次拿全：界面切到某个会话时只要这一条。
    //   · `overrides` 是**剪过**的（与下层同值的覆盖不出现在这里）；
    //   · `effective` 是**与全局的差异**（界面画勾用：`map[key] ?? 全局值`）；
    //   · `scene` 是本会话生效的场景（进入的 → 基线里那份 → 全局的），`detached` 见文件头。
    'scope-get': async (args: any) => {
      const rawId = String((args && args.sessionId) || '').trim()
      /** 全局层的回答（空 sessionId，或全局粒度下任何 sessionId）。 */
      const globalLayer = async (): Promise<any> => {
        try {
          const global = await deps.global()
          return {
            ok: true,
            sessionId: '',
            mode: modeOf(),
            locked: false,
            global,
            scene: global.scene,
            detached: false,
            baseline: null,
            overrides: {},
            effective: {},
            toolTableHidden: null,
            prompt: { override: null, effective: '' },
          }
        } catch (e) {
          return { ok: false, error: '读取全局状态失败: ' + deps.message(e) }
        }
      }
      // 空 sessionId = **全局层**：面板停在「全局默认」时也走这一条，拿到的
      // `global` 与切到某个会话时同一份（意图三态 + 租约计数都在里面）。
      if (!rawId) return await globalLayer()
      // 全局粒度：这个会话没有自己的格子 —— 回答"它看到什么"就等同于全局层。走这一条
      // 而不是去读侧车里那份已经不再生效的旧记录，否则界面会显示一堆当前不起作用的覆盖。
      if (modeOf() === 'global') return await globalLayer()
      const sessionId = await resolveKey(rawId)
      try {
        const [overrides, global] = await Promise.all([deps.store.read(), deps.global()])
        const raw = scopeOrEmpty(overrides, sessionId)
        const archive = archiveOf(raw)
        const parent = layerParentSnapshot(global, raw, archive)
        const scope = pruneScope(raw, parent)
        return {
          ok: true,
          sessionId,
          mode: overrides.mode,
          locked: raw?.locked === true,
          global,
          scene: parent.scene,
          detached: raw?.detached === true,
          baseline: raw?.baseline === undefined
            ? null
            : { scene: raw.baseline.scene, capturedAt: raw.baseline.capturedAt ?? null },
          overrides: scope ?? {},
          effective: effectiveDiff(raw, archive, global),
          // 本对话自己的工具表名单：null = 没有显式设置，跟随基线/全局。
          toolTableHidden: raw?.toolTableHidden ?? null,
          // 提示词覆盖：`override` 只回用户写的那一半（content / presetId 二选一）
          // —— 冻结快照是系统元数据，不混进"覆盖"。
          // `effective` 是用户级那一槽此刻的正文（含快照链；界面编辑本会话正文时预填）。
          prompt: {
            override: promptOverrideOf(raw) ?? null,
            effective: deps.promptTextOf === undefined ? '' : deps.promptTextOf(sessionId),
          },
        }
      } catch (e) {
        return { ok: false, error: '读取会话作用域失败: ' + deps.message(e) }
      }
    },
    'scope-set': async (args: any) => {
      const rawId = String((args && args.sessionId) || '').trim()
      if (!rawId) return { ok: false, error: '缺少 sessionId' }
      // 全局粒度：没有会话层可写。这里**必须挡**而不是静默改全局 —— op 的入参
      // 是一个具体 sessionId，调用方以为自己在改那一格；把它转成机器级写入就是一次无声的扩大。
      if (modeOf() === 'global') return { ok: false, error: GLOBAL_MODE_NO_LAYER }
      const sessionId = await resolveKey(rawId)
      const domain = String((args && args.domain) || '').trim()
      if (domain === '') return { ok: false, error: '缺少 domain' }
      const denied = await lockedError(sessionId)
      if (denied !== null) return { ok: false, error: denied }
      let global: ScopeGlobalSnapshot
      try {
        global = await deps.global()
      } catch (e) {
        return { ok: false, error: '读取全局状态失败，未写入: ' + deps.message(e) }
      }
      // 场景：`value` 是场景名（进入）；`null` / 空串 = 退出场景模式。
      if (domain === 'scene') {
        const rawValue = args && args.value
        const wanted = rawValue === null || rawValue === undefined || rawValue === '' ? null : String(rawValue)
        if (wanted !== null && (wanted === '__proto__' || wanted.length > 256 || /[\u0000-\u001f\u007f]/.test(wanted) || wanted.indexOf('/') >= 0 || wanted.indexOf('\\') >= 0)) {
          return { ok: false, error: '非法场景名' }
        }
        if (wanted !== null && deps.sceneExists !== undefined) {
          let exists = false
          try { exists = await deps.sceneExists(wanted) } catch { exists = true /* 读不到 = 不拦（宁可能进也不能因为一次读失败卡住） */ }
          if (!exists) return { ok: false, error: `没有这个场景：${wanted}（场景名以场景页为准）` }
        }
        const current = await deps.store.scopeOf(sessionId)
        const baseline = await ensureBaseline(sessionId, current)
        if (wanted === null) {
          // 退出场景：下层换成基线（会话创建时的样子；记不到基线时如实降级为"跟随全局"）。
          const res = await deps.store.mutate(sessionId, (cur) => {
            let next = exitSceneInScope(cur).scope
            if (baseline !== null) next = withBaseline(next, baseline).scope
            return next
          })
          if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
          notifyChanged(sessionId, 'scene')
          // 退出后认领少了：最后一个租约消失的资源要跟着停。
          if (deps.reconcile !== undefined) await deps.reconcile().catch(() => undefined)
          return {
            ok: true, sessionId, domain, scene: null, detached: true,
            restoredBaseline: res.scope?.baseline !== undefined,
            ...(baseline === null && res.scope?.baseline === undefined
              ? { warning: '这个会话没有记下创建时的基线，退出后按"跟随全局"处理' }
              : {}),
            scope: res.scope ?? {},
          }
        }
        // 场景档案只读一次：工具表套用与下面的租约回执都要用。
        let archive: SceneArchive | undefined
        try { archive = deps.sceneArchiveOf?.(wanted) } catch { archive = undefined }
        // 模型工具表：场景绑了方案就把**本对话**的整份关停名单换成那份
        // 没绑就不碰（对话自己调过的工具表保持原样）。方案不存在时也不拦进入，
        // 只是保持原样并给一条警告 —— 其余域照常进入。
        const toolTablePreset = archive !== undefined && typeof archive.toolTablePreset === 'string'
          ? archive.toolTablePreset
          : ''
        let toolTableHidden: string[] | null = null
        let toolTableApplied = false
        if (toolTablePreset !== '' && deps.toolTablePresetHidden !== undefined) {
          try { toolTableHidden = await deps.toolTablePresetHidden(toolTablePreset) } catch { toolTableHidden = null }
          if (toolTableHidden !== null) {
            const available = deps.toolTableAvailable?.()
            if (available !== undefined) toolTableHidden = toolTableHidden.filter((name) => available.has(name))
            toolTableApplied = true
          }
        }
        /**
         * 旧场景是否绑定过工具表方案。切场景时它的名单已经抄进了本会话的
         * `toolTableHidden` —— 新场景没绑（或绑定方案已不存在）时不能再留着它，
         * 否则"换了个场景、工具表还是上一个场景的"。
         * 同场景重进不删（那是"重新应用"的场景表单语义）。
         */
        const oldScenePreset = (scope: SessionScope | undefined): string => {
          if (scope?.scene === undefined || scope.scene === wanted) return ''
          try { return String(deps.sceneArchiveOf?.(scope.scene)?.toolTablePreset || '') } catch { return '' }
        }
        let droppedPrevSceneToolTable = false
        // 进入场景：先落覆盖（这一步定义了这个会话的认领），再跑一轮对账 —— 场景勾中的
        // 全局关着的服务器 / 来源会成为租约：连接 / 来源被拉起来，但**意图保持 off**，
        // 别的会话看不到它们（「仍按租约运行」）。
        const res = await deps.store.mutate(sessionId, (cur) => {
          let next = enterSceneInScope(cur, wanted).scope
          if (baseline !== null) next = withBaseline(next, baseline).scope
          if (toolTableApplied && toolTableHidden !== null) {
            next = { ...next, toolTableHidden: toolTableHidden.slice() }
          } else if (oldScenePreset(cur) !== '') {
            // 新场景不套方案：把上一个场景抄进来的名单一起摘掉，回到基线。
            const without = { ...next }
            delete without.toolTableHidden
            next = without
            droppedPrevSceneToolTable = true
          }
          return next
        })
        if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
        notifyChanged(sessionId, 'scene')
        let warnings: string[] = []
        if (toolTablePreset !== '' && !toolTableApplied) {
          warnings.push(droppedPrevSceneToolTable
            ? `场景绑定的模型工具表方案「${toolTablePreset}」已不存在：本对话的工具表已回到创建时的状态`
            : `场景绑定的模型工具表方案「${toolTablePreset}」已不存在：本对话的工具表保持不变`)
        }
        if (deps.reconcile !== undefined) {
          const report = await deps.reconcile().catch(() => undefined)
          const entries: Array<{ domain: IntentDomain; key: string }> = []
          if (archive !== undefined) {
            for (const server of Object.keys(archive.mcp ?? {})) entries.push({ domain: 'mcp', key: server })
            const roots = new Set<string>()
            for (const key of archive.skills ?? []) {
              const i = key.indexOf('/')
              if (i <= 0) continue
              entries.push({ domain: 'skills', key })
              roots.add(key.slice(0, i))
            }
            for (const root of roots) entries.push({ domain: 'skillSources', key: root })
          }
          warnings = warnings.concat(reconcileWarnings(report, entries))
          // 全局「统一关闭」压过场景：勾中它也不会运行。不说的话用户会以为场景坏了。
          for (const entry of entries) {
            if (global.intent?.[entry.domain]?.[entry.key] === 'blocked') {
              warnings.unshift(`${intentLabel(entry.domain)}「${entry.key}」已在全局「统一关闭」：这个场景里它不会运行`)
            }
          }
        }
        return {
          ok: true, sessionId, domain, scene: wanted, detached: false,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(toolTablePreset !== ''
            ? { toolTable: { preset: toolTablePreset, applied: toolTableApplied, hidden: toolTableApplied && toolTableHidden !== null ? toolTableHidden.length : null } }
            : {}),
          scope: res.scope ?? {},
        }
      }
      if (!isFlagDomain(domain)) return { ok: false, error: `未知 domain: ${domain}（可用：scene / ${SCOPE_FLAG_DOMAINS.join(' / ')}）` }
      const key = String((args && args.key) || '')
      if (key === '') return { ok: false, error: '缺少 key' }
      // 与侧车 `validKey` 同一条：`__proto__` 在普通对象上是改原型，不是落自有属性。
      if (key === '__proto__') return { ok: false, error: '非法 key: __proto__' }
      if (typeof (args && args.value) !== 'boolean') return { ok: false, error: 'value 必须是布尔值（只按传入值写入，不做"翻转"推断）' }
      const value = args.value === true
      // 全局「统一关闭」压过一切会话层（显式拒绝的语义）：写一条"开"只会看起来生效、
      // 实际调不到 —— 当场拒掉并给出出口（先把全局改成关闭或启用）。
      // 技能要连**所在来源**一起查：来源停了，技能级策略开着也加载不到。
      const blockedTarget = intentTargetsOf(domain, key)
        .find((target) => global.intent?.[target.domain]?.[target.key] === 'blocked')
      if (value && blockedTarget !== undefined) {
        return { ok: false, error: `「${blockedTarget.key}」已在全局「统一关闭」：先把全局改回关闭或启用，它才可能再运行` }
      }
      // 下层值的**预检**（锁外、读缓存）：只为快速拒绝，不是权威判定 —— 权威那一份在
      // `store.mutate` 的锁内按**重读出来的** `cur` 再算一次（见下面 `effectiveParent`）。
      // 锁外这份不能直接拿去写：两次读之间别的写 op 可能改了这个会话的 `scene` / 基线，
      // 那时"下层"已经不是同一个值，用它判"与下层同值即自动清除"会清错。
      const current = await deps.store.scopeOf(sessionId)
      const preParent = parentValueOf(current, archiveOf(current), global, domain, key)
      // 下层读不到（该域这一轮没读到）→ **拒绝写入**，不猜。猜错的两种方向都很难看：
      // 当成"下层关着"会把一次显式开启记成"等于下层"当场清掉；当成"下层开着"会让
      // 用户点了"关闭"却留下一层看不见的覆盖。场景模式 / 基线在场时下层不依赖全局
      // （见 `parentValueOf`），那两种情形照常可写。
      if (preParent.unknown) {
        return { ok: false, error: `读不到「${domain}」的下层状态，已拒绝写入：无法判断这次改的是"与下层不同"还是"与下层相同"，而后者要自动清除这条覆盖。请稍后重试。` }
      }
      // 拨开逐工具 / 单条技能时，**一并认领它的上层**（服务器 / 来源）：工具要能调，
      // 服务器得在跑；来源不启用时 core 会吞掉技能级 enable。这条认领写在本会话的
      // 覆盖表里（不是全局），对账据此把资源拉起来 —— 修掉旧版"在全局拉起来"的串味。
      const upperOf = ((): { domain: ScopeFlagDomain; key: string } | undefined => {
        if (domain === 'mcpTools') {
          const slash = key.indexOf('/')
          return slash > 0 ? { domain: 'mcp', key: key.slice(0, slash) } : undefined
        }
        if (domain === 'skills') {
          const slash = key.indexOf('/')
          return slash > 0 ? { domain: 'skillSources', key: key.slice(0, slash) } : undefined
        }
        return undefined
      })()
      /**
       * 这一格下面还有没有显式为「开」的子项（工具 → 服务器 / 技能 → 来源）。
       * 读取侧把"子项开"认成"上层也要"（`effectiveLayerOf`），所以显式关掉上层时必须
       * 压得住它；反过来，最后一个子项关掉之后那条压制用的 `false` 要能自己消失。
       */
      const hasTrueChild = (scope: SessionScope | undefined, upper: { domain: ScopeFlagDomain; key: string }): boolean => {
        const map = upper.domain === 'mcp' ? scope?.mcpTools : upper.domain === 'skillSources' ? scope?.skills : undefined
        if (map === undefined) return false
        const prefix = upper.key + '/'
        return Object.entries(map).some(([k, v]) => v === true && k.startsWith(prefix))
      }
      const upperTarget = domain === 'mcp'
        ? { domain: 'mcp' as const, key }
        : domain === 'skillSources'
          ? { domain: 'skillSources' as const, key }
          : undefined
      // 锁内算出来的那份下层值（写完之后判 `cleared` 也用它 —— 与真正落盘的那次判定同源）。
      let effectiveParent: { value: boolean; unknown: boolean } | null = null
      /** 这次写的是"压制子项推导"的显式上层关（不是自动清除）。 */
      let suppressed = false
      const res = await deps.store.mutate(sessionId, (cur) => {
        // 锁内按重读出来的 `cur` 重算下层，同值自动清除也随之重判（写路径原子性）。
        // blocked 检查**不在这里**：它用的是锁外那份全局意图快照，本意是快速拒绝；这里只保证
        // 「下层是谁」与落盘判定同源。
        const parent = parentValueOf(cur, archiveOf(cur), global, domain, key)
        effectiveParent = parent
        // 锁内才发现读不到（预检之后该域状态变了）→ 原样返回，不写半份：调用方按 `unknown` 报错。
        if (parent.unknown) return cur
        // 关上层时若有子项显式为开：把 false 真的写下来，否则读侧的"子项开 ⇒ 上层要"会把它
        // 顶回来（用户点了关，开关却纹丝不动）。
        const suppressUpper = value === false && upperTarget !== undefined && hasTrueChild(cur, upperTarget)
        if (suppressUpper) suppressed = true
        let next = applyFlag(cur, domain, key, value, suppressUpper ? !parent.value : parent.value).scope
        if (value && upperOf !== undefined) {
          const upperParent = parentValueOf(cur, archiveOf(cur), global, upperOf.domain, upperOf.key)
          if (!upperParent.unknown) next = applyFlag(next, upperOf.domain, upperOf.key, true, upperParent.value).scope
        }
        // 最后一个子项关掉之后，那条"压制用的关"若已等于下层就清掉（读侧本来也会剪掉它，
        // 这里顺手落干净，免得下拉框条数说还有一项、打开却什么都没有）。
        if (!value && upperTarget !== undefined) {
          const upperExplicit = next?.[upperTarget.domain]?.[upperTarget.key]
          if (upperExplicit === false && !hasTrueChild(next, upperTarget)) {
            const upperParent = parentValueOf(next, archiveOf(next), global, upperTarget.domain, upperTarget.key)
            if (!upperParent.unknown) next = applyFlag(next, upperTarget.domain, upperTarget.key, false, upperParent.value).scope
          }
        }
        return next
      })
      if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
      const parent = effectiveParent as { value: boolean; unknown: boolean } | null
      if (parent === null || parent.unknown) {
        return { ok: false, error: `读不到「${domain}」的下层状态，已拒绝写入：无法判断这次改的是"与下层不同"还是"与下层相同"，而后者要自动清除这条覆盖。请稍后重试。` }
      }
      notifyChanged(sessionId, domain)
      // 对账（只有这四个域会改变租约）：新开的一条要拉起资源；拨关如果带走了最后一个
      // 租约，连接 / 来源要跟着停。回执里如实说哪些是"仅为这个对话临时运行"。
      let warnings: string[] = []
      if (deps.reconcile !== undefined && (domain === 'mcp' || domain === 'mcpTools' || domain === 'skills' || domain === 'skillSources')) {
        const report = await deps.reconcile().catch(() => undefined)
        if (value) warnings = reconcileWarnings(report, intentTargetsOf(domain, key))
      }
      // `cleared` = 这次写入等于下层值，覆盖被自动清掉。压制子项推导时写的是一条
      // 真实覆盖（哪怕它等于下层），不能报成"已清除"。
      return { ok: true, sessionId, domain, key, value, cleared: !suppressed && value === parent.value, ...(warnings.length > 0 ? { warnings } : {}), scope: res.scope ?? {} }
    },
    /**
     * 会话级提示词覆盖：apply / unapply / edit。
     *
     * 只写侧车 `prompt` 域，**永不写** `~/.dsh/AGENTS.md`；场景锁不拦（它只冻结全局写），
     * 会话锁照常拦（与 `scope-set` 同一个 `lo` 判据）。预设被删后解析时退化到下一层
     * （场景 / 会话冻结快照）；这里不清侧车，用户能看见自己曾应用过哪一份。
     */
    'scope-prompt-set': async (args: any) => {
      const rawId = String((args && args.sessionId) || '').trim()
      if (!rawId) return { ok: false, error: '缺少 sessionId' }
      const sessionId = await resolveKey(rawId)
      const denied = await lockedError(sessionId)
      if (denied !== null) return { ok: false, error: denied }
      const action = String((args && args.action) || '').trim()
      if (action === 'unapply') {
        const res = await deps.store.mutate(sessionId, (cur) => {
          if (cur === undefined || cur.prompt === undefined) return cur
          const next: SessionScope = { ...cur }
          // 只清用户覆盖，**快照留着**：取消应用要回到本会话冻结的基线
          // 不是回到此刻的全局文件。把整个 prompt 删掉会让下一轮重新捕获当前文件，
          // 等于"取消应用顺手解冻"。
          const baseline = cur.prompt.baseline
          if (baseline === undefined) delete next.prompt
          else next.prompt = { baseline }
          return isKeepableScope(next) ? next : undefined
        })
        if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
        return { ok: true, sessionId, action, prompt: null, scope: res.scope ?? {} }
      }
      if (action === 'apply') {
        const rawPreset = String((args && args.presetId) || '').trim()
        if (rawPreset === '') return { ok: false, error: '缺少 presetId' }
        // 与预设库 / 场景绑定同一套 id 规则（`presets/preset-id.ts`）：id 同时是磁盘目录名，
        // 这里的校验挡住分隔符与 `..` —— 只按长度 / 控制字符放行时，一个构造出来的 id 能让
        // 注入侧读到预设目录之外的同名 AGENTS.md。
        const normalized = normalizePresetId(rawPreset)
        if (!normalized.ok) return { ok: false, error: normalized.error }
        const presetId = normalized.id
        if (deps.presetContent === undefined) return { ok: false, error: '预设库不可用，未写入' }
        let content: string | null = null
        try { content = await deps.presetContent(presetId) } catch { content = null }
        if (content === null) return { ok: false, error: `预设不存在或读不到：${presetId}` }
        if (content.trim() === '') return { ok: false, error: `预设「${presetId}」正文为空，无法应用` }
        const ensureBaseline = capturePromptBaselineOnce(sessionId)
        const res = await deps.store.mutate(sessionId, (cur) => ({
          ...(cur === undefined ? {} : cur),
          prompt: {
            presetId,
            // 覆盖替换的是"用户级那一槽用哪份正文"，不碰冻结快照。
            ...(cur?.prompt?.baseline === undefined
              ? (ensureBaseline === undefined ? {} : { baseline: ensureBaseline })
              : { baseline: cur.prompt.baseline }),
          },
        }))
        if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
        return { ok: true, sessionId, action, prompt: { presetId }, scope: res.scope ?? {} }
      }
      if (action === 'edit') {
        const content = typeof (args && args.content) === 'string' ? String(args.content) : ''
        if (content.trim() === '') return { ok: false, error: '正文不能为空：要恢复全局请用「取消应用 / 恢复全局」' }
        if (content.indexOf('\u0000') >= 0) return { ok: false, error: '正文含非法字符（NUL）' }
        if (Buffer.byteLength(content, 'utf8') > PROMPT_CONTENT_MAX_BYTES) {
          return { ok: false, error: `正文超过 ${Math.floor(PROMPT_CONTENT_MAX_BYTES / 1024)} KiB，未写入` }
        }
        const ensureBaseline = capturePromptBaselineOnce(sessionId)
        const res = await deps.store.mutate(sessionId, (cur) => ({
          ...(cur === undefined ? {} : cur),
          prompt: {
            content,
            ...(cur?.prompt?.baseline === undefined
              ? (ensureBaseline === undefined ? {} : { baseline: ensureBaseline })
              : { baseline: cur.prompt.baseline }),
          },
        }))
        if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
        return { ok: true, sessionId, action, prompt: { content }, scope: res.scope ?? {} }
      }
      return { ok: false, error: `未知 action: ${action}（可用：apply / unapply / edit）` }
    },
    'scope-clear': async (args: any) => {
      const rawId = String((args && args.sessionId) || '').trim()
      if (!rawId) return { ok: false, error: '缺少 sessionId' }
      // 全局粒度：没有会话层可写。这里**必须挡**而不是静默改全局 —— op 的入参
      // 是一个具体 sessionId，调用方以为自己在改那一格；把它转成机器级写入就是一次无声的扩大。
      if (modeOf() === 'global') return { ok: false, error: GLOBAL_MODE_NO_LAYER }
      const sessionId = await resolveKey(rawId)
      const denied = await lockedError(sessionId)
      if (denied !== null) return { ok: false, error: denied }
      const domain = String((args && args.domain) || '').trim()
      const key = String((args && args.key) || '')
      // 整个会话：清掉全部覆盖、场景、脱离标记与锁。**两份基线不清** —— 它们是
      // "这个会话出生时长什么样"的记录（退出到创建时的样子 / 提示词冻结快照），删了就没法
      // 再回去；而且工具表按基线解析，删掉会让这个对话突然跟着全局变。
      if (domain === '') {
        let removed = false
        const res = await deps.store.mutate(sessionId, (cur) => {
          if (cur === undefined) return cur
          removed = !isEmptyScope(cur)
          const next: SessionScope = {}
          if (cur.baseline !== undefined) next.baseline = cur.baseline
          const promptBaseline = cur.prompt?.baseline
          if (promptBaseline !== undefined) next.prompt = { baseline: promptBaseline }
          return normalizeSessionScope(next)
        })
        if (!res.ok) return { ok: false, error: '清除失败: ' + res.error }
        if (removed) {
          notifyChanged(sessionId, '')
          // 覆盖没了 = 认领没了：运行态要跟着回落（最后一个租约消失就停）。
          if (deps.reconcile !== undefined) await deps.reconcile().catch(() => undefined)
        }
        return { ok: true, sessionId, removed, scope: res.scope ?? {} }
      }
      if (domain !== 'scene' && domain !== 'toolTable' && !isFlagDomain(domain)) {
        return { ok: false, error: `未知 domain: ${domain}` }
      }
      const res = await deps.store.mutate(sessionId, (current) => {
        if (current === undefined) return undefined
        const out: SessionScope = { ...current }
        if (domain === 'scene') {
          // 清场景 = 不再钉住场景，但**不**算"退出模式"（不给 detached）—— 退出模式是
          // `scope-set` 的 scene=null 那条路（它换下层）。这里是"只把场景那一格擦掉"。
          delete out.scene
        } else if (domain === 'toolTable') {
          // 工具表是整份名单，没有"清一个键"：擦掉显式那份 = 回到创建时抄的基线。
          delete out.toolTableHidden
        } else {
          // 指定了 key 就只删那一个；没指定就把整张域表删掉。
          if (key !== '') {
            const map = out[domain]
            if (map !== undefined) {
              const next = { ...map }
              delete next[key]
              if (Object.keys(next).length > 0) out[domain] = next
              else delete out[domain]
            }
          } else {
            delete out[domain]
          }
        }
        return normalizeSessionScope(out)
      })
      if (!res.ok) return { ok: false, error: '清除失败: ' + res.error }
      notifyChanged(sessionId, domain)
      if (deps.reconcile !== undefined && (domain === 'scene' || domain === 'mcp' || domain === 'mcpTools' || domain === 'skills' || domain === 'skillSources')) {
        await deps.reconcile().catch(() => undefined)
      }
      return { ok: true, sessionId, domain, ...(key === '' ? {} : { key }), scope: res.scope ?? {} }
    },
    // 列**当前会话区里的未归档会话**（用户 ：按工作区分组，像来源目录那样）——
    // 只列有覆盖的那些会让用户找不到还没动过的对话；归档、未挂回工作区的孤儿，以及
    // 从没发过消息的空壳都不列（覆盖留着，恢复后自然回来）。空壳判定见下面的 summaryOf：
    // 侧栏也不显示它们，列进来只会是一串同名条目。当前会话永远在（否则下拉框会把它
    // 自己藏掉）；宿主清单一条都没读到时也只留它一项。
    'scope-sessions-list': async (args: any) => {
      const currentSessionId = String((args && args.sessionId) || '').trim()
      try {
        const [overrides, rows] = await Promise.all([deps.store.read(), deps.sessions()])
        const mode = overrides.mode
        // 侧车 GC：剪掉宿主**已不认识**的会话条目。判据由 store 自己取
        // （宿主已知的全部会话，含归档与未挂回工作区的孤儿）—— 这里手头这份 `rows` 是
        // 展示口径（按当前会话区成员过滤过），拿它当判据会把孤儿会话的覆盖一并抹掉。
        // 不 await：剪枝失败不该让下拉框空掉，下一轮会再剪。
        void deps.store.pruneDeletedSessions().catch(() => { /* 下一轮再剪 */ })
        // 运行态自愈：面板每次挂载 / 会话清单变化都会拉这一条，
        // 顺手排一轮**不采纳**的对账 —— 删除 / 归档 / 恢复 / 重启都不走插件的写 op，
        // 没有任何触发点可挂，这里是它们唯一的落点。对账幂等、无差异不写盘，
        // 读的成本与 `scope-get` 同量级。不 await：回执照旧，对账失败也不该让下拉框空掉。
        void deps.reconcile?.({ adoptExternal: false }).catch(() => { /* 下一轮面板刷新还会再对 */ })
        // 全局粒度：没有"每个会话一格"这回事，下拉框该整块消失而不是列出 N 个都指向全局的
        // 条目。这里如实返回空表 + 当前 mode —— 界面据此隐藏整个作用域栏。
        if (mode === 'global') return { ok: true, mode, currentKey: '', sessions: [], workspaces: [] }
        const byId = new Map(rows.map((row) => [row.id, row] as const))
        const currentRow = currentSessionId === '' ? undefined : byId.get(currentSessionId)
        // 当前层的键：工作区模式下是当前会话所在工作区的 `ws:` 键（无 cwd / 超长 → 会话键）。
        const currentKey = currentSessionId === ''
          ? ''
          : (mode === 'workspace'
            ? (scopeKeyOfRow({ id: currentSessionId, cwd: currentRow?.cwd }, 'workspace'))
            : currentSessionId)

        // 标题补全 + 空壳过滤：持久化表头里没有标题，摘要直接读宿主的投影缓存文件
        // （`summaryOf`）。**从没发过消息的会话**（titleInput.count = 0）不在侧栏的
        // 当前会话区里，也不进下拉 —— 只剩一串同名空条目（用户 实测）。
        // 当前会话永远在（哪怕刚建、还没有第一条消息）；读不到摘要时也不过滤。
        const candidates: ScopeSessionRow[] = []
        for (const row of rows) {
          if (row.archived === true && row.id !== currentSessionId) continue
          candidates.push({
            id: row.id,
            title: row.title,
            count: overrideCountOf(overrides.sessions[row.id]),
            archived: row.archived === true,
            cwd: row.cwd || '',
          })
        }
        if (currentSessionId !== '' && !candidates.some((row) => row.id === currentSessionId)) {
          candidates.push({
            id: currentSessionId,
            title: currentRow?.title || currentSessionId.slice(0, 8),
            count: overrideCountOf(overrides.sessions[currentSessionId]),
            archived: currentRow?.archived === true,
            cwd: currentRow?.cwd || '',
          })
        }
        if (typeof deps.summaryOf === 'function') {
          const summaryOf = deps.summaryOf
          const summaries = await Promise.all(candidates.map(async (row) => {
            try { return await summaryOf(row.id) } catch { return undefined }
          }))
          const kept: ScopeSessionRow[] = []
          candidates.forEach((row, i) => {
            const summary = summaries[i]
            if (summary && summary.title !== undefined && summary.title !== '') row.title = summary.title
            if (row.id !== currentSessionId && summary !== undefined && summary.hasMessages === false) return
            kept.push(row)
          })
          candidates.length = 0
          candidates.push(...kept)
        }

        if (mode === 'workspace') {
          // 同一工作区的会话折成一行；没有 cwd（或路径超长无法生成键）的会话保持会话隔离。
          const workspaceRows = new Map<string, ScopeSessionRow>()
          const isolated: ScopeSessionRow[] = []
          for (const row of candidates) {
            const workspaceKey = workspaceScopeKeyOf(row.cwd)
            if (workspaceKey === undefined) {
              isolated.push(row)
              continue
            }
            const existing = workspaceRows.get(workspaceKey)
            if (existing !== undefined) {
              existing.sessions = (existing.sessions || 1) + 1
              // 当前会话所在的工作区保留一行；标题取目录名（摘要标题属于单个会话，不适合当工作区名）。
              continue
            }
            workspaceRows.set(workspaceKey, {
              id: workspaceKey,
              title: workspaceBaseName(row.cwd) || row.title,
              count: overrideCountOf(overrides.sessions[workspaceKey]),
              archived: false,
              cwd: row.cwd,
              kind: 'workspace',
              sessions: 1,
            })
            // 行尾条数是**工作区记录**的覆盖数，不是成员会话条数之和；成员数另放 sessions。
          }
          // 当前工作区永远在（清单读不到 / 当前会话被摘要过滤掉的兜底）。
          if (currentKey !== '' && !workspaceRows.has(currentKey) && currentRow?.cwd) {
            const workspaceKey = workspaceScopeKeyOf(currentRow.cwd)
            if (workspaceKey !== undefined && !workspaceRows.has(workspaceKey)) {
              workspaceRows.set(workspaceKey, {
                id: workspaceKey,
                title: workspaceBaseName(currentRow.cwd) || currentRow.title,
                count: overrideCountOf(overrides.sessions[workspaceKey]),
                archived: false,
                cwd: currentRow.cwd,
                kind: 'workspace',
                sessions: 1,
              })
            }
          }
          const workspaces = [...workspaceRows.values()].sort((a, b) => {
            if (a.id === currentKey) return -1
            if (b.id === currentKey) return 1
            const diff = b.count - a.count
            if (diff !== 0) return diff
            const an = String(a.title || ''), bn = String(b.title || '')
            return an < bn ? -1 : an > bn ? 1 : 0
          })
          isolated.sort((a, b) => (a.id === currentSessionId ? -1 : b.id === currentSessionId ? 1 : b.count - a.count))
          return { ok: true, mode, currentKey, sessions: isolated, workspaces }
        }

        candidates.sort((a, b) => (a.id === currentSessionId ? -1 : b.id === currentSessionId ? 1 : b.count - a.count))
        return { ok: true, mode, currentKey, sessions: candidates }
      } catch (e) {
        return { ok: false, error: '读取会话列表失败: ' + deps.message(e) }
      }
    },
    /**
     * 切换隔离粒度：会话 ↔ 工作区。
     *
     * 播种规则（决策：**首次进入一侧时用另一侧已有设置初始化，已有记录一律保留**）：
     *   · 切到工作区：每个工作区**还没有** `ws:` 记录时，用当前会话（若属于该工作区）或
     *     该工作区里覆盖条数最多的会话初始化；
     *   · 切回会话：会话原有记录不动；从未有过自己记录的会话从工作区记录复制一份。
     *   · 关掉隔离（`global`）：**什么都不播种、也不删** —— 那一档只是"不读会话层"，记录
     *     原样躺着；回执另带一份 `kept` 计数，界面据此说清"还留着 N 份，调回来就恢复"。
     * 两侧记录都不删除 —— 来回切换是回到各自上一次的样子，不会丢设置。
     * 复制时剥掉 `locked`（见 `scopeForLayerSeed`）。
     */
    'scope-mode-set': async (args: any) => {
      const rawMode = args && args.mode
      if (rawMode !== 'global' && rawMode !== 'session' && rawMode !== 'workspace') {
        return { ok: false, error: `未知 mode: ${String(rawMode ?? '')}（可用：global / session / workspace）` }
      }
      const wanted: ScopeMode = rawMode
      const currentSessionId = String((args && args.currentSessionId) || '').trim()
      try {
        const [overrides, rows] = await Promise.all([deps.store.read(), deps.sessions()])
        if (overrides.mode === wanted) return { ok: true, mode: wanted, seeded: 0 }
        const seeds: Record<string, SessionScope | undefined> = {}
        /**
         * 坍缩摘要：切到工作区粒度时，N 个会话的个性化设置
         * 必须收敛成 1 份，规则是「当前会话优先，否则项数最多」。这个选择此前对用户
         * 完全不可见 —— 一次点击丢掉几十份配置，界面上只说「同一个工作区共用一份设置」。
         * 这里如实回报：涉及多少工作区、多少会话本来带设置、其中多少份没被采用。
         */
        let summary: { workspaces: number; conversations: number; dropped: number } | undefined
        /**
         * 关闭隔离时的存量摘要。`global` 粒度不删除任何记录、也不播种 ——
         * 那些会话 / 工作区设置原样躺在侧车里，切回来就恢复。但用户在界面上看不到这一点，
         * 很容易以为「切到全局 = 设置被清掉了」。这里报个数，让提示语能说"还留着 N 份"。
         */
        let kept: { scopes: number; conversations: number; workspaces: number } | undefined
        if (wanted === 'global') {
          let conversations = 0
          let workspaces = 0
          for (const [key, scope] of Object.entries(overrides.sessions)) {
            if (overrideCountOf(scope) === 0) continue
            if (isWorkspaceScopeKey(key)) workspaces += 1
            else conversations += 1
          }
          if (conversations + workspaces > 0) {
            kept = { scopes: conversations + workspaces, conversations, workspaces }
          }
        } else if (wanted === 'workspace') {
          const groups = new Map<string, ScopeSessionRow[]>()
          for (const row of rows) {
            if (row.archived === true) continue
            const workspaceKey = workspaceScopeKeyOf(row.cwd)
            if (workspaceKey === undefined) continue
            const list = groups.get(workspaceKey)
            if (list === undefined) groups.set(workspaceKey, [row])
            else list.push(row)
          }
          let conversationsWithSettings = 0
          let seededGroups = 0
          for (const [workspaceKey, members] of groups) {
            for (const row of members) {
              if (overrideCountOf(overrides.sessions[row.id]) > 0) conversationsWithSettings += 1
            }
            if (overrides.sessions[workspaceKey] !== undefined) continue
            let best: SessionScope | undefined
            let bestScore = -1
            // 当前会话优先：用户正在这个对话里切模式，期望看到的就是眼前这套设置。
            const currentFirst = members.find((row) => row.id === currentSessionId)
            if (currentFirst !== undefined && overrides.sessions[currentFirst.id] !== undefined) {
              best = overrides.sessions[currentFirst.id]
            } else {
              for (const row of members) {
                const scope = overrides.sessions[row.id]
                if (scope === undefined) continue
                const score = overrideCountOf(scope)
                if (score > bestScore) { best = scope; bestScore = score }
              }
            }
            // 与切回会话那一侧同一条判据：只有基线的记录不算「设过」，播过去只是一份
            // 与默认状态等价的空拷贝，还会让 `seeded` 计数虚高。
            if (best !== undefined && overrideCountOf(best) > 0) { seeds[workspaceKey] = scopeForLayerSeed(best); seededGroups += 1 }
          }
          summary = {
            workspaces: seededGroups,
            conversations: conversationsWithSettings,
            dropped: Math.max(0, conversationsWithSettings - seededGroups),
          }
        } else if (wanted === 'session') {
          for (const row of rows) {
            if (row.archived === true) continue
            // 判据是「用户真在这一层设过什么」，不是「有没有这条记录」。
            // `ensureBaselineFor` 在每个 `agent/created` 都会写一条只有 `baseline` 的记录，
            // 所以 `!== undefined` 对所有会话恒真 —— 播种永远不执行，工作区期间的配置
            // 永远带不回老会话。`overrideCountOf` 不计基线、但**计入显式的 false**
            // （见 scope-overrides.ts 按 Object.keys 计数），所以不会覆盖用户故意关掉的项。
            if (overrideCountOf(overrides.sessions[row.id]) > 0) continue
            const workspaceKey = workspaceScopeKeyOf(row.cwd)
            if (workspaceKey === undefined) continue
            const workspaceScope = overrides.sessions[workspaceKey]
            if (workspaceScope === undefined) continue
            // 工作区那份也只有基线 = 用户在工作区里什么都没设，没必要往会话里拷一份空记录。
            if (overrideCountOf(workspaceScope) === 0) continue
            seeds[row.id] = scopeForLayerSeed(workspaceScope)
          }
        }
        // `wanted === 'global'`：什么都不播种，也不删任何记录 —— 那一档只是"不读会话层"。
        const res = await deps.store.switchMode(wanted, seeds)
        if (!res.ok) return { ok: false, error: '切换失败: ' + res.error }
        // 落盘已经成功：通知失败只能影响下一拍的可见性，不能把切换报成失败。
        try { deps.onModeChanged?.(wanted) } catch { /* best effort */ }
        return {
          ok: true, mode: wanted, seeded: res.seeded,
          ...(summary === undefined ? {} : { summary }),
          ...(kept === undefined ? {} : { kept }),
        }
      } catch (e) {
        return { ok: false, error: '切换失败: ' + deps.message(e) }
      }
    },
    // 全局意图：MCP 服务器 / 技能（含来源）三格的**全局开关**写这里，不再直接改补丁 /
    // 来源状态 —— 后者是运行态，由对账器维持成 `意图 ∪ 租约`。
    // `blocked` 仍可读（旧版本留下的 MCP 值），新界面不再写它：「统一关闭」是一次性
    // 动作，走下面的 `scope-stop-now`。
    'scope-intent-set': async (args: any) => {
      const domain = String((args && args.domain) || '').trim()
      if (!isIntentDomain(domain)) return { ok: false, error: `未知 domain: ${domain}（可用：mcp / skillSources / skills）` }
      const raw = args && args.value
      const state = normalizeIntentState(raw) ?? (raw === true ? 'on' as const : raw === false ? 'off' as const : undefined)
      if (state === undefined) return { ok: false, error: 'value 必须是 on / off / blocked' }
      const list: string[] = Array.isArray(args && args.keys)
        ? (args.keys as unknown[]).map((key) => String(key)).filter((key) => key !== '')
        : (args && args.key !== undefined && String(args.key) !== '' ? [String(args.key)] : [])
      const keys = [...new Set(list)]
      if (keys.length === 0) return { ok: false, error: '缺少 key（或 keys）' }
      if (keys.length > 512) return { ok: false, error: '一次最多改 512 项' }
      for (const key of keys) {
        if (key === '__proto__' || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: '非法 key: ' + key }
      }
      if (deps.writeIntent === undefined) return { ok: false, error: '当前环境不支持全局意图写入' }
      const error = await deps.writeIntent(domain, keys, state)
      if (error !== null) return { ok: false, error: '写入失败: ' + error }
      const report = deps.reconcile === undefined ? undefined : await deps.reconcile().catch(() => undefined)
      // 意图已落盘、运行态没跟上：逐条说出来（下一轮对账会再试，但不是"已经生效"）。
      const keySet = new Set(keys)
      const warnings = (report === undefined ? [] : report.failed)
        .filter((item) => item.domain === domain && keySet.has(item.key))
        .map((item) => `「${item.key}」的全局意图已记下，但运行态没跟上（${item.error}）：下一次对账会再试`)
      return { ok: true, domain, value: state, keys, ...(warnings.length > 0 ? { warnings } : {}) }
    },
    /**
     * 「统一关闭」/「全部关闭」：一次性停机，不留下持久的 `blocked`。
     *
     * 对布尔域：先把全局意图写成 `off`（只有 mcp / skills / skillSources 有意图），再把
     * **所有层里开着它的**会话 / 工作区写成显式关闭 —— 只写 off 不够：那些层里的 `true`
     * （或场景勾选）会在下一轮对账里成为租约，把它重新拉起来。显式 `false` 同时压过场景层，
     * 所以场景里的会话也会一起停下。memory / subagents / quickPrompts 没有运行态，清掉
     * 认领就够了。
     *
     * `scene` 没有布尔键：把每个进入过场景的会话 / 工作区退回基线（`exitSceneInScope`）；
     * 带 `key` / `keys` 时只退这些场景，不带 = 页头「全部关闭」退全部。
     * 全局正在用的那个场景不动 —— 它是全局设置，不是"临时运行"。
     *
     * 归档会话不写：它已经不占资源，改它的设置只是噪音。被锁的层照写 —— 这是用户显式
     * 触发的全局停机，层锁保护的是误触，不是拒绝停机。
     */
    'scope-stop-now': async (args: any) => {
      const domain = String((args && args.domain) || 'mcp').trim()
      const isFlagDomainArg = (value: string): value is ScopeFlagDomain =>
        value === 'mcp' || value === 'skills' || value === 'skillSources' || value === 'memory' || value === 'subagents' || value === 'quickPrompts'
      if (domain !== 'scene' && !isFlagDomainArg(domain)) {
        return { ok: false, error: `不支持的 domain: ${domain}（可用：mcp / skills / skillSources / memory / subagents / quickPrompts / scene）` }
      }
      let archived = new Set<string>()
      try {
        archived = new Set((await deps.sessions()).filter((row) => row.archived === true).map((row) => row.id))
      } catch { /* 清单读不到：不按归档过滤，宁可多关几格 */ }
      if (domain === 'scene') {
        // 不带 key = 页头的「全部关闭」；带 key = 某一张场景卡菜单里的「统一关闭」。
        const rawScenes: unknown[] = Array.isArray(args && args.keys)
          ? (args.keys as unknown[])
          : (args && args.key !== undefined ? [args.key] : [])
        const sceneNames = new Set(rawScenes.map((key) => String(key)).filter((key) => key !== ''))
        for (const key of sceneNames) {
          if (key === '__proto__' || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: '非法 key: ' + key }
        }
        const res = await deps.store.mutateAll((scope, sessionId) => {
          if (archived.has(sessionId) || typeof scope.scene !== 'string' || scope.scene === '') return scope
          if (sceneNames.size > 0 && !sceneNames.has(scope.scene)) return scope
          return exitSceneInScope(scope).scope
        })
        if (!res.ok) return { ok: false, error: '退出场景失败: ' + res.error }
        if (res.changed > 0) deps.onChanged?.('', 'scene')
        if (deps.reconcile !== undefined) await deps.reconcile().catch(() => undefined)
        return { ok: true, domain, cleared: res.changed, ...(sceneNames.size > 0 ? { keys: [...sceneNames] } : {}) }
      }
      const rawList: unknown[] = Array.isArray(args && args.keys)
        ? (args.keys as unknown[])
        : (args && args.key !== undefined ? [args.key] : [])
      const keys = [...new Set(rawList.map((key) => String(key)).filter((key) => key !== ''))]
      if (keys.length === 0) return { ok: false, error: '缺少 key（或 keys）' }
      if (keys.length > 512) return { ok: false, error: '一次最多改 512 项' }
      for (const key of keys) {
        if (key === '__proto__' || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: '非法 key: ' + key }
      }
      const runtime = domain === 'mcp' || domain === 'skills' || domain === 'skillSources'
      if (runtime) {
        if (deps.writeIntent === undefined) return { ok: false, error: '当前环境不支持全局意图写入' }
        const error = await deps.writeIntent(domain as IntentDomain, keys, 'off')
        if (error !== null) return { ok: false, error: '写入失败: ' + error }
      }
      const cleared: Record<string, number> = Object.create(null)
      const res = await deps.store.mutateAll((scope, sessionId) => {
        if (archived.has(sessionId)) return scope
        const archive = scope.scene !== undefined ? deps.sceneArchiveOf?.(scope.scene) : undefined
        const table: Record<string, boolean> | undefined = scope[domain]
        let next = table
        for (const key of keys) {
          if (effectiveLayerOf(scope, archive, domain, key) !== true) continue
          if (next === undefined) next = {}
          else if (next === table) next = Object.assign({}, next)
          next[key] = false
          cleared[key] = (cleared[key] || 0) + 1
        }
        return next === table ? scope : Object.assign({}, scope, { [domain]: next })
      })
      if (!res.ok) return { ok: false, error: '关闭会话开关失败: ' + res.error }
      if (res.changed > 0) deps.onChanged?.('', domain)
      const report = runtime && deps.reconcile !== undefined ? await deps.reconcile().catch(() => undefined) : undefined
      const keySet = new Set(keys)
      const warnings = (report === undefined ? [] : report.failed)
        .filter((item) => item.domain === domain && keySet.has(item.key))
        .map((item) => `「${item.key}」已记录为关闭，但运行态没跟上（${item.error}）：下一次对账会再试`)
      return { ok: true, domain, keys, cleared, ...(warnings.length > 0 ? { warnings } : {}) }
    },
    // 锁 / 解锁：与 `rules-scene-lock` 同一条 —— 它自己不能被锁挡住，否则锁上就解不开。
    'scope-lock': async (args: any) => {
      const rawId = String((args && args.sessionId) || '').trim()
      if (!rawId) return { ok: false, error: '缺少 sessionId' }
      // 全局粒度：没有会话层可写。这里**必须挡**而不是静默改全局 —— op 的入参
      // 是一个具体 sessionId，调用方以为自己在改那一格；把它转成机器级写入就是一次无声的扩大。
      if (modeOf() === 'global') return { ok: false, error: GLOBAL_MODE_NO_LAYER }
      const sessionId = await resolveKey(rawId)
      if (typeof (args && args.locked) !== 'boolean') {
        return { ok: false, error: '缺少参数：locked 必须是布尔值（只按传入值写入，不做"翻转"推断）' }
      }
      const locked = args.locked === true
      const res = await deps.store.mutate(sessionId, (current) => {
        const out: SessionScope = { ...(current === undefined ? {} : current) }
        if (locked) out.locked = true
        else delete out.locked
        return normalizeSessionScope(out)
      })
      if (!res.ok) return { ok: false, error: '保存失败: ' + res.error }
      return { ok: true, sessionId, locked }
    },
  }
}