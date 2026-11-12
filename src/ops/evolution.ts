// 自主记忆的 op（HTTP 层 + 工具层共用）：开关、学习、遗忘、清单。
//
// 为什么单独一个域：这些读写不碰记忆正文的**通用编辑**（那是 `memories-*` 的职责），
// 只碰"自动记忆"这个受策略约束的子集。混进记忆域会让"改一条记忆"和"让 agent 学一条"
// 共用同一个门禁，而它们的权限要求正相反 —— 前者要确认卡，后者必须是零摩擦（否则
// 每学一条都弹窗，用户三分钟就会关掉开关）。
//
// `learn` 与 `save` 分成两条工具的完整理由见 docs 05-tools §2：授权边界写在工具名上，
// 门禁不用猜参数。

import { DEFAULT_EVOLUTION_SETTINGS, normalizeNoteStyle, workspaceHashOf, type EvolutionConfigStore, type EvolutionOverrides, type EvolutionSettings } from '../evolution/config.js'
import type { EvolutionRuntime } from '../evolution/runtime.js'
import type { Learner } from '../evolution/write.js'
// 只取类型：冷路径在装配层晚于本函数创建，所以拿的是 getter 而不是实例。
import type { ColdPathHandle } from '../evolution/cold.js'
import type { SweepReport } from '../evolution/maintenance.js'
import { isInjectableStatus } from '../memories/catalog.js'
import { tierOf } from '../evolution/state.js'
import { AUTO_KINDS } from '../evolution/gates.js'
import { workspaceCwdOfScopeKey, workspaceMemoryKeyOf } from '../scope/workspace-key.js'

/**
 * 工作区显示名：取作用域键（`ws:<路径>`）的最后一段。
 *
 * 用 key 而不是会话 cwd：`workspaceMemoryKeyOf` 会把子目录收敛到 git 根，从
 * `repo/src` 启动的会话也该显示 `repo`，不是 `src`。
 */
function workspaceLabelOfPath(path: string): string {
  const s = String(path || '').replace(/^ws:/, '').replace(/[\\/]+$/, '')
  const cut = s.split(/[\\/]/).pop() ?? ''
  return cut === '' ? s : cut
}

export interface EvolutionOpDeps {
  config: EvolutionConfigStore
  /** 同步视图（清单与统计读它，比异步门面新鲜且不额外读盘）。 */
  runtime: EvolutionRuntime
  /**
   * 写入管线。没有就表示这版没接自动记忆 —— op 如实报不可用，不静默成功。
   *
   * 类型引用 `Learner`（= `createLearner` 的返回值）而不是在这里再描述一遍：
   * 手写的那一份与实现分叉时编译器不会报错（方法参数双变），后果是某个参数被静默忽略。
   */
  learner?: Learner
  /**
   * 会话 id → 工作目录。客户端的「本工作区」那一行只知道自己当前是哪个对话，
   * 不知道 cwd；宿主那边的映射只有装配层有（与 `scope-sessions-list` 同一份）。
   *
   * 取不到就当作"没有工作区"：界面少一行工作区开关，好过写错层。
   */
  sessionCwd?(sessionId: string): Promise<string | undefined>
  /**
   * 未登记工作区的反查：hash → `ws:<路径>` 键。
   *
   * 旧笔记（以及卡片确认那条学习路径）可能没写 `evolution/workspaces.json`，
   * 列表却要按工作区名称分节。装配层用宿主会话的 cwd 反查，口径与学习时一致
   * （先收敛到 git 根再算 hash）；反查不到就按 hash 短码兜底。
   */
  workspaceKeysOfHashes?(hashes: string[]): Promise<Record<string, string>>
  /**
   * 宿主当前可用的模型清单（`provider` + `id` + `name`）。
   *
   * 界面的「复习模型」做成下拉框用：让用户从**真实存在**的模型里挑，而不是手打一个
   * provider/model 字符串 —— 打错了不会报错，只会在后台复习时静默失败，用户看不出原因。
   *
   * 宿主不提供 `llm` 服务时返回空数组，界面退回手填输入框（降级方向是「还能用」）。
   */
  modelsOf?(): Promise<Array<{ provider: string; id: string; name: string }>>
  /**
   * 冷路径句柄（后台复习队列）。
   *
   * 用 getter 而不是直接传实例：op 表在 `attachColdPath` **之前**装配（op 要能被
   * 「开关打开」之前就调用，那时光标还没有后台复习）。传 getter 就不会出现
   * "先建一份空队列、真正跑起来的是另一份"的错位。
   */
  cold?(): ColdPathHandle | null
  /** 维护扫描：TTL 复核提醒 / 归档 + 工作区失效。 */
  sweep?(opts?: { dry?: boolean }): Promise<SweepReport>
  /** 健康度（只读统计）。 */
  health?(): Promise<{
    byLayer: Record<string, { active: number; candidate: number; archived: number; tokens: number }>
    tokens: number
    conflicts: number
    /** 有 `pendingReason`、等用户裁决的条数（不注入）。 */
    awaitingReview: number
    reviewDue: number
    expired: number
    total: number
  }>
  /**
   * 设置写入后的通知：那条自主记忆工具跟随总开关，而模型侧的 restrict 名单是缓存的。
   * 不主动重排一次，拨完开关要等下一次无关的 tools/change 工具才真的出现 / 消失。
   * 可选：单测里不接也能跑；回调自己抛错不该让开关保存失败。
   */
  onSettingsChanged?(): void
  /**
   * 页头「注入预算」里**记忆域**的实际字节数。
   *
   * 必须由装配层提供（它才知道手写记忆占了多少、当前笔记风格、启用场景），而且必须走
   * 注入侧同一份渲染 —— 界面自己按条目累加会漏掉「按渲染块实际字节记账」与「预算装不下
   * 就整条让位」两道闸，得出一个比实际大的数，于是页头报"已超限"而模型那边其实还有余量。
   *
   * 可选：单测里不接就不给这个字段（界面显示未知），不能拿 0 冒充。
   */
  injectBytesOf?(scopeKey: string | undefined, sessionId: string): Promise<InjectBytesReport>
  /**
   * 同 slot 下同时生效的条目数（>1 就是两条矛盾说法同时在注入）。
   *
   * 与维护扫描的 `healthOf().conflicts` 同一份判据；这里单独给一个轻量入口，
   * 免得记忆页为了一个数字去跑整轮健康度统计。
   */
  conflictsOf?(): Promise<number>
  message(e: unknown): string
}

/**
 * 记忆域的注入字节账：`bytes` 是这一轮真正进上下文的字节数。
 *
 * `breakdown` 是各来源的**条目正文字节**（不含板块标题与授权语 —— 合并块里它们只发一次），
 * 用来给界面画构成；各项之和 ≤ `bytes` 是正常现象，不要拿它当总量。
 */
export interface InjectBytesReport {
  bytes: number
  /** 记忆域上限：手写记忆与自主笔记共用同一个盘。 */
  maxBytes: number
  breakdown: { global: number; workspace: number; scene: number; autoGlobal: number; autoWorkspace: number }
  /**
   * 有一部分算不出来时的原因（哪一块、为什么）。有它时 `bytes` 可能偏低，
   * 界面必须显示"未知 / 不完整"，不能当成 0。
   */
  degraded?: string
}

/** 一档的展示形态：值 + 是否真的覆盖了字段（界面据此显示"来源"）。 */
function layerView(overrides: EvolutionOverrides | undefined) {
  return { defined: overrides !== undefined && Object.keys(overrides).length > 0, values: overrides ?? {} }
}


export function buildEvolutionOps(deps: EvolutionOpDeps): Record<string, (args: any) => Promise<any>> {
  const { config, runtime, learner, message } = deps
  /** 只在这四处「写设置」之后调；记忆正文写入不碰工具表，不必重排。 */
  const notifySettingsChanged = () => {
    try { deps.onSettingsChanged?.() } catch { /* 重排失败不该让开关保存失败 */ }
  }

  /**
   * cwd → 工作区身份（与 scope 页同一口径：先向上收敛到 git root）。
   *
   * 客户端只给 `sessionId` 时按会话查一次 cwd（`deps.sessionCwd`）—— 界面上「本工作区」
   * 那颗开关否则永远没有落点。查不到就返回空：宁可少一行开关，也不猜一个工作区。
   */
  const workspaceOf = async (args: any): Promise<{ scopeKey?: string; cwd?: string; hash?: string }> => {
    let cwd = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
    if (!cwd && deps.sessionCwd && typeof args?.sessionId === 'string' && args.sessionId !== '') {
      cwd = await deps.sessionCwd(args.sessionId)
    }
    if (!cwd) return {}
    const scopeKey = workspaceMemoryKeyOf(cwd)
    if (!scopeKey) return { cwd }
    return { cwd, scopeKey, hash: workspaceHashOf(scopeKey) }
  }

  return {
    /**
     * 读：全局值、两级覆盖、解析后的生效值、来源，外加自动记忆的统计。
     *
     * `cwd` / `sessionId` 由调用方给：HTTP 层拿不到宿主 agent。工具层从 agent 取，
     * 但**层永远以真实 sid / 真实 cwd 为准**，不接受客户端伪造的"层归属"。
     */
    /**
     * 读：可用模型清单（「复习模型」下拉框的选项）。
     *
     * 只读、无副作用。空数组 = 宿主没接 `llm` 服务或它一个模型都没注册 —— 界面据此
     * 退回手填输入框，而不是显示一个空下拉让用户以为坏了。
     */
    'evolution-models': async () => {
      try {
        const models = deps.modelsOf === undefined ? [] : await deps.modelsOf()
        return { ok: true, models }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e), models: [] }
      }
    },
    'evolution-status': async (args: any) => {
      try {
        const { scopeKey, cwd, hash } = await workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const global = await config.readSettings()
        const effective = await config.effective(scopeKey, sessionId)
        const workspaces = await config.readWorkspaces()
        const sessions = await config.readSessions()
        const workspaceRecord = hash ? workspaces.workspaces[hash] : undefined
        const sessionRecord = sessionId ? sessions.sessions[sessionId] : undefined

        // 自动记忆实况：只报计数，不把正文塞进状态回执（它会被界面高频轮询）。
        const view = runtime.view()
        // 目录最近一次没更新成功的原因。catalog 是派生数据，失败不影响真相，但**会影响注入**：
        // 界面必须能区分"记忆被删了"与"目录没跟上"，否则用户只能看到条数凭空空掉。
        const catalogDegraded = deps.learner?.catalogDegraded()
        const entries = Object.values(view.catalog.entries)
        // 待复核与「已学 / 生效 / 待确认」分开报：`reviewDue` 是「该看一眼」，仍照常注入；
        // `pending` 是候选数（等用户裁决），不要拿 `pendingReason` 的条数混进去 —— 合成一个
        // 数字，用户会以为生效中的条目也在等他处理。
        const reviewDue = entries.filter((e) => {
          const st = view.state.entries[e.id]
          return st && typeof st.reviewDue === 'string' && st.reviewDue !== ''
        }).length
        // 「待确认」必须与页面上**看得见的行**同口径：记忆页的工作区卡把所有工作区
        // 合成一张列出，所以这里也数全部候选。此前按「全局 + 本工作区」过滤，卡片上有
        // 3 条待确认、计数却写 1 条 —— 而 `已学` / `生效` 本来就是全库口径，三个数里
        // 只有这一个被收窄，用户只能以为计数坏了。
        const pending = entries.filter((e) => e.status === 'candidate').length
        const archived = entries.filter((e) => e.status === 'archived').length
        // 「已学」只数**还留着**的条目：归档（用户否决 / 删除 / 维护扫描）与已取代的都是
        // 历史，它们留在 catalog 里只是为了能恢复。照总数报，用户删得越多数字越大 ——
        // 而他真正想知道的正是"现在还有多少条"。
        const retained = entries.filter((e) => e.status !== 'archived' && e.status !== 'superseded').length

        return {
          ok: true,
          effective,
          global,
          workspace: workspaceRecord
            ? { hash, key: workspaceRecord.key, cwd: workspaceRecord.cwd, label: workspaceRecord.label || workspaceLabelOfPath(workspaceRecord.key), ...layerView(workspaceRecord.evolution) }
            : hash ? { hash, key: scopeKey, cwd: cwd ?? '', label: workspaceLabelOfPath(scopeKey ?? ''), defined: false, values: {} } : null,
          // 会话那一行：**有会话 id 就要给一行**（哪怕还没写过记录）。
          // 返回 null 会让界面把整行藏掉 —— 用户第一次想给这个对话开开关时，找不到入口。
          // 工作区那一档就是这么处理的（`defined: false` + 空 values 表示"还没覆盖"）。
          session: sessionId === ''
            ? null
            : (sessionRecord ? layerView(sessionRecord.evolution) : { defined: false, values: {} }),
          defaults: global,
          auto: {
            entries: retained,
            total: entries.length,
            // `byLayer` / `byStatus` 不在这里返回：它们是维护扫描的诊断口径，而 `evolution-health`
            // 已经给了完整一份。放在 status 里从来没有消费者 —— 一个没人读的字段比不存在更糟，
            // 它会让下一个人以为界面上有这张图。
            reviewDue,
            pending,
            archived,
            broken: view.broken,
            // 有原因才给字段：空串会被界面当成"降级了但没原因"，与"没降级"分不开。
            ...(catalogDegraded !== undefined ? { catalogDegraded } : {}),
            active: entries.filter((e) => e.enabled && isInjectableStatus(e.status)).length,
            // 页头「注入预算」里**记忆域**的实际字节数。
            //
            // 界面自己按 `injects` + 层开关 + 当前工作区累加是**算不准**的：注入侧还要过
            // 「按渲染块实际字节记账」与「预算装不下就整条让位」两道闸，实际进上下文的比那个和大。
            // 两个数字对不上时，用户看到的"还剩 30 KiB"与模型看到的上下文会互相矛盾。
            // 这里直接按注入侧同一份口径算一遍，界面只做展示。
            // 没接这个回调（单测 / 老装配）时**不给这个字段**，而不是给 0：
            // 0 会被界面当成"记忆不占字节"，于是页头报的用量偏小、超限也不转红。
            // 缺字段时界面只能显示"未知"，不要拿 0 或本地累加顶上去。
            ...(deps.injectBytesOf === undefined
              ? {}
              : { injectBytes: await deps.injectBytesOf(scopeKey, sessionId) }),
            // 冲突数并进 status：界面只在记忆页显示这个数字，而记忆页不调 `evolution-health`
            // （那是维护扫描的诊断入口）。放在这里，页头一格才有数据来源。
            conflicts: await (deps.conflictsOf?.() ?? 0),
          },
        }
      } catch (e) {
        return { ok: false, error: message(e), code: 'status-failed' }
      }
    },

    /** 写全局设置。只接受已知字段，未传的沿用当前值。 */
    'evolution-settings': async (args: any) => {
      try {
        if (args?.set !== true) return { ok: true, settings: await config.readSettings() }
        const patch = args.settings && typeof args.settings === 'object' ? args.settings : {}
        // **只收集这次真要改的字段**，不要以"我读到的当前值"为基线拼整份 —— 那是
        // 拿 3 秒缓存去覆盖磁盘（两个窗口同时改不同字段时后写的赢，前一个的改动消失）。
        // 合并由 `writeSettings` 在写锁内对新读到的磁盘值做。
        const next: Partial<EvolutionSettings> = {}
        // 旧客户端只认识 `enabled`：按「两层同值」兼容，不让老界面把新字段写丢。
        if (typeof patch.learnGlobal === 'boolean') next.learnGlobal = patch.learnGlobal
        else if (typeof patch.enabled === 'boolean') next.learnGlobal = patch.enabled
        if (typeof patch.learnWorkspace === 'boolean') next.learnWorkspace = patch.learnWorkspace
        else if (typeof patch.enabled === 'boolean') next.learnWorkspace = patch.enabled
        if (typeof patch.autoConfirm === 'boolean') next.autoConfirm = patch.autoConfirm
        if (typeof patch.maxReviewsPerSession === 'number') next.maxReviewsPerSession = patch.maxReviewsPerSession
        // 学习频率：窗口分钟数与每窗口条数；`null` = 回出厂值（空框语义）。
        // 越界值由 `normalizeEvolutionSettings` 统一夹取，这里不写第二份判据。
        if (typeof patch.learnWindowMinutes === 'number') next.learnWindowMinutes = patch.learnWindowMinutes
        else if (patch.learnWindowMinutes === null) next.learnWindowMinutes = DEFAULT_EVOLUTION_SETTINGS.learnWindowMinutes
        if (typeof patch.maxLearnsPerWindow === 'number') next.maxLearnsPerWindow = patch.maxLearnsPerWindow
        else if (patch.maxLearnsPerWindow === null) next.maxLearnsPerWindow = DEFAULT_EVOLUTION_SETTINGS.maxLearnsPerWindow
        if (typeof patch.model === 'string') next.model = patch.model
        // 风格：预设、自定义档列表、选中的 id 可能分两次到，缺哪项就沿用当前值。
        // 选中的自定义档被删掉时，normalize 会退回默认档。
        if (patch.noteStyle !== undefined || patch.customNoteStyles !== undefined || patch.noteStyleText !== undefined) {
          // 风格要**整组**算：选中的档被删掉时要退回默认档，只改其中一项会让组合不成立。
          // 因此这里读一次当前值当基线 —— 但只把算出来的两项放进 patch，其余字段仍不碰。
          const current = await config.readSettings()
          const style = normalizeNoteStyle({
            style: patch.noteStyle !== undefined ? patch.noteStyle : current.noteStyle,
            customStyles: patch.customNoteStyles !== undefined ? patch.customNoteStyles : current.customNoteStyles,
            custom: patch.noteStyleText,
          })
          next.noteStyle = style.style
          next.customNoteStyles = style.customStyles
        }
        const written = await config.writeSettings(next)
        if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
        runtime.invalidate()
        notifySettingsChanged()
        return { ok: true, settings: written.settings }
      } catch (e) {
        return { ok: false, error: message(e), code: 'settings-failed' }
      }
    },

    /**
     * 写某一档的开关（也接受别的覆盖字段）。
     *
     * `scope='workspace'` 需要 `cwd`；`scope='session'` 需要 `sessionId`。
     * 下层可以覆盖上层的"关"——这正是"只给这个对话开"能成立的原因。
     */
    'evolution-toggle': async (args: any) => {
      try {
        const scope = args?.scope
        // `inherit: true` = 清掉这一档的覆盖，回到跟上一级走。
        // 为什么需要它：三级开关是"逐字段覆盖"，没有"清除"这条路的话，用户一旦点过
        // 工作区那一档就再也回不到"跟随全局" —— 他只能选开或关，而上层改了之后这里不会跟。
        const inherit = args?.inherit === true
        const enabled = args?.enabled
        if (!inherit && typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值', code: 'bad-args' }
        if (scope === 'global') {
          if (inherit) return { ok: false, error: '全局这一档没有「继承」', code: 'bad-args' }
          // 旧的总开关语义保留：一次拨动两层同值。新界面用 `evolution-settings` 分别写。
          const written = await config.writeSettings({ learnGlobal: enabled, learnWorkspace: enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, enabled }
        }
        if (scope === 'workspace') {
          const { scopeKey, cwd } = await workspaceOf(args)
          if (!scopeKey) return { ok: false, error: '拿不到工作区路径，无法保存工作区开关', code: 'no-workspace' }
          // 保留同一档的其它覆盖字段，只换 enabled（继承 = 整块清空）。
          const workspaces = await config.readWorkspaces()
          const record = workspaces.workspaces[workspaceHashOf(scopeKey)]
          const prev = record?.evolution ?? {}
          // 标签沿用已存的那一份：开关请求通常不带 label，覆盖成 '' 会把用户见过的
          // 工作区名字抹掉（下拉框里就只剩一串路径）。
          const label = typeof args?.label === 'string' && args.label !== '' ? args.label : (record?.label ?? '')
          const written = await config.writeWorkspace(scopeKey, cwd ?? '', label, inherit ? {} : { ...prev, learnGlobal: enabled, learnWorkspace: enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, inherit, ...(inherit ? {} : { enabled }), hash: written.hash }
        }
        if (scope === 'session') {
          const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
          if (!sessionId) return { ok: false, error: '拿不到会话 id，无法保存会话开关', code: 'no-session' }
          const sessions = await config.readSessions()
          const prev = sessions.sessions[sessionId]?.evolution ?? {}
          const written = await config.writeSession(sessionId, inherit ? {} : { ...prev, learnGlobal: enabled, learnWorkspace: enabled })
          if (!written.ok) return { ok: false, error: written.error, code: 'write-failed' }
          runtime.invalidate()
          notifySettingsChanged()
          return { ok: true, scope, inherit, ...(inherit ? {} : { enabled }) }
        }
        return { ok: false, error: 'scope 必须是 global / workspace / session', code: 'bad-args' }
      } catch (e) {
        return { ok: false, error: message(e), code: 'toggle-failed' }
      }
    },

    /**
     * 学一条（模型主动调；也是复习器的唯一写入口）。
     *
     * **没有 `source` 参数**：证据来源由系统按 `quote` 的核对结果判定，不由调用方声明。
     * 传了 `quote` 且逐字命中本会话的用户消息 → `user_explicit`；核不上 → 硬拒；
     * 没传 → `model_inference`（进候选，等用户确认）。
     */
    /**
     * 只读预演：同一条 learn 请求如果被用户在卡片上批准，会落到哪一层、会不会合并 / 取代。
     *
     * 与 `evolution-learn` 同一套开关与路由；不写盘、不 bump revision。工具层据此决定
     * 要不要弹卡（门禁拒绝、与用户记忆冲突、锁定目标都不弹）。
     */
    'evolution-preview': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const { scopeKey } = await workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const cfg = await config.effective(scopeKey, sessionId)
        if (!cfg.enabled) {
          return { ok: false, error: 'autonomous memory is off for this conversation / workspace', code: 'disabled' }
        }
        return await learner.preview(
          {
            text: String(args?.text ?? ''),
            ...(args?.title !== undefined ? { title: args.title } : {}),
            ...(args?.kind !== undefined ? { kind: args.kind } : {}),
            ...(args?.key !== undefined ? { key: args.key } : {}),
            ...(args?.quote !== undefined ? { quote: args.quote } : {}),
            ...(args?.layer !== undefined ? { layer: args.layer } : {}),
            ...(args?.boundary !== undefined ? { boundary: args.boundary } : {}),
            ...(args?.ttlDays !== undefined ? { ttlDays: args.ttlDays } : {}),
            ...(args?.description !== undefined ? { description: args.description } : {}),
          },
          cfg,
          {
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(scopeKey !== undefined ? { workspaceHash: workspaceHashOf(scopeKey) } : {}),
            ...(typeof args?.scene === 'string' && args.scene !== '' ? { scene: args.scene } : {}),
          },
        )
      } catch (e) {
        return { ok: false, error: message(e), code: 'preview-failed' }
      }
    },

    'evolution-learn': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const { scopeKey, cwd } = await workspaceOf(args)
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
        const cfg = await config.effective(scopeKey, sessionId)
        // 开关：学不学是一道独立的门，与"能不能写"无关。关了就说清为什么，别静默成功。
        if (!cfg.enabled) {
          return { ok: false, error: 'autonomous memory is off for this conversation / workspace', code: 'disabled' }
        }
        const result = await learner.learn(
          {
            text: String(args?.text ?? ''),
            ...(args?.title !== undefined ? { title: args.title } : {}),
            ...(args?.kind !== undefined ? { kind: args.kind } : {}),
            ...(args?.key !== undefined ? { key: args.key } : {}),
            ...(args?.quote !== undefined ? { quote: args.quote } : {}),
            ...(args?.layer !== undefined ? { layer: args.layer } : {}),
            ...(args?.boundary !== undefined ? { boundary: args.boundary } : {}),
            ...(args?.ttlDays !== undefined ? { ttlDays: args.ttlDays } : {}),
            ...(args?.approved === true ? { approved: true } : {}),
            ...(args?.autoActive === true ? { autoActive: true } : {}),
          },
          cfg,
          {
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(scopeKey !== undefined ? { workspaceHash: workspaceHashOf(scopeKey) } : {}),
            ...(typeof args?.scene === 'string' && args.scene !== '' ? { scene: args.scene } : {}),
          },
        )
        if (result.ok) runtime.invalidate()
        // 记下工作区名：记忆页要按名称分节，而 workspaces.json 此前只在拨开关时才写。
        // 展示增强，失败不影响学习本身。
        if (result.ok && result.layer === 'workspace' && scopeKey !== undefined && cwd !== undefined) {
          try {
            const workspaces = await config.readWorkspaces()
            const hash = workspaceHashOf(scopeKey)
            const prev = workspaces.workspaces[hash]
            if (prev === undefined || prev.cwd !== cwd || prev.label === '') {
              await config.writeWorkspace(scopeKey, cwd, prev?.label || workspaceLabelOfPath(scopeKey), prev?.evolution)
            }
          } catch { /* 展示名没写上：下一次学习或拨开关会再试 */ }
        }
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'learn-failed' }
      }
    },

    /** 忘掉一条：正文移进统一回收站，写墓碑（30 天内自动路径不能复活）。 */
    'evolution-forget': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const actor = typeof args?.actor === 'string' ? args.actor : 'model'
        const result = await learner.forget(id, { actor })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'forget-failed' }
      }
    },

    /**
     * 否决一条候选：正文移进统一回收站，不写墓碑。
     *
     * 与 `evolution-forget` 分开：否决只表达「这条不要」，不该让同义内容 30 天内学不回来。
     */
    'evolution-discard': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.discard(id, { actor: 'user' })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'discard-failed' }
      }
    },

    /**
     * 确认一条候选（记忆页的「确认」）。
     *
     * 只做"候选 → 生效"这一件事：换层 / 合并 / 拆条属于整理草案，不走这条。
     * 候选不注入，所以确认是用户把一条自动记忆真正启用的唯一入口。
     */
    'evolution-approve': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.approve(id)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'approve-failed' }
      }
    },

    /**
     * 行内开关：只拨索引，不归档、不写回收站。
     *
     * 与 `evolution-set-status` 的分工：这里管「暂时不注入」，条目留在列表里随时拨回来；
     * 归档 / 恢复 / 删除才走状态那条路。
     */
    'evolution-set-enabled': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        if (typeof args?.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值', code: 'bad-args' }
        const result = await learner.setEnabled(id, args.enabled)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'status-failed' }
      }
    },

    /**
     * 复核一条：清掉「待复核」标记并重置老化计时。
     *
     * 只清标记不重置时间的话，下一次扫描会立刻按旧时间再挂一次 —— 用户会觉得点了没反应。
     * 重置的是 state 里的 `reviewedAt`，**不是文件里的 `auto_updated`**：复核没有改正文，
     * 写成"刚刚更新"会让列表与 catalog 一起说谎。用户改正文（`evolution-update`）另算。
     */
    'evolution-review': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.markReviewed(id)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'review-failed' }
      }
    },

    /**
     * 归档 / 恢复一条。
     *
     * 与 `evolution-forget` 的区别要体现在回执里：这条**不删文件、不写墓碑**，随时能恢复。
     */
    'evolution-set-status': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        // 两个入参名都收：界面按开关语义传 `enabled`，工具按状态语义传 `status`。
        // 只认一个会让另一条路静默写成 undefined —— 而 `setStatus` 会拿它跟当前值比、
        // 比不出来就返回 unchanged，症状是"点了没反应但不报错"。
        //
        // **不认识的 status 一律拒绝**，不要兜底成 `active`：早先只有 `archived` 被识别，
        // 于是传 `candidate` / `superseded` / 拼错的值都会把条目**激活**——一个想撤回
        // 候选的动作反而让它开始注入，而且回执说成功。
        const wanted = typeof args?.status === 'string' ? args.status.trim() : ''
        const KNOWN = ['active', 'candidate', 'archived'] as const
        let status: 'active' | 'candidate' | 'archived'
        if (wanted !== '') {
          if (!(KNOWN as readonly string[]).includes(wanted)) {
            return { ok: false, error: `unknown status "${wanted}" (expected ${KNOWN.join(' / ')})`, code: 'bad-args' }
          }
          status = wanted as typeof status
        } else if (typeof args?.enabled === 'boolean') {
          // 只给了 `enabled` 的旧调用方：开关语义 = 归档 / 恢复。
          status = args.enabled ? 'active' : 'archived'
        } else {
          // 两个都没给：**拒绝**，不要兜底成 `active`。一次缺参调用不该把一条归档的
          // 记忆重新激活 —— 那是"什么都没传，它自己开始注入"的静默副作用。
          return {
            ok: false,
            error: 'missing status — pass status ("active" / "candidate" / "archived") or enabled (true / false)',
            code: 'bad-args',
          }
        }
        const result = await learner.setStatus(id, status, 'user')
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'status-failed' }
      }
    },

    /**
     * 编辑一条自动记忆的名称与正文。
     *
     * 与记忆页的编辑弹窗同一条路：id / 层 / 状态不变。`frozen` 不设 ——
     * 自主记忆不绑场景，场景锁定不该挡住它。
     */
    'evolution-update': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const text = typeof args?.text === 'string' ? args.text : ''
        const baseHash = typeof args?.baseHash === 'string' ? args.baseHash : ''
        // 不传 = 不改名称；传空串 = 清空名称（列表按正文首句兜底）。
        const title = typeof args?.title === 'string' ? args.title : undefined
        // 类型：只认四个已知值。传了别的（拼错 / 旧数据里的 core）就拒绝，别静默忽略 ——
        // 用户以为改成功了、其实没改，比直接报错更糟。
        let kind: 'preference' | 'fact' | 'correction' | 'procedure' | undefined
        if (args?.kind !== undefined) {
          const raw = String(args.kind)
          if (!AUTO_KINDS.includes(raw as never)) return { ok: false, error: 'unknown kind: ' + raw, code: 'bad-args' }
          kind = raw as 'preference' | 'fact' | 'correction' | 'procedure'
        }
        const result = await learner.update(id, text, baseHash, title, kind)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'update-failed' }
      }
    },

    /**
     * 从统一回收站恢复一条停用的自动记忆。
     *
     * 只接受 `auto: true` 的条目：用户手写记忆走 `rules-restore`，两条路的落点与索引
     * 完全不同，不能靠一个 op 猜。
     */
    'evolution-restore': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const trashId = String(args?.trashId ?? '')
        if (trashId === '') return { ok: false, error: 'missing trashId', code: 'bad-args' }
        const result = await learner.restoreFromTrash(trashId)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'restore-failed' }
      }
    },

    /** 永久删除回收站里的自动记忆：写墓碑、清 state、删正文与回收站副本。 */
    'evolution-trash-remove': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const trashId = String(args?.trashId ?? '')
        if (trashId === '') return { ok: false, error: 'missing trashId', code: 'bad-args' }
        const result = await learner.purgeTrash(trashId)
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'purge-failed' }
      }
    },

    /** 提升为用户记忆：从自动段移出，进用户记忆的注入与预算。 */
    'evolution-promote': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const result = await learner.promote(id, { actor: args?.actor === 'user' ? 'user' : 'curator' })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'promote-failed' }
      }
    },

    /** 读一条自动记忆的详情（界面展开 / `memory_get` 兜底）。 */
    'evolution-read': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const id = String(args?.id ?? '')
        if (id === '') return { ok: false, error: 'missing id', code: 'bad-args' }
        const detail = await learner.describe(id)
        // 只有模型读（`touch: true`）才计数；界面展开详情不算「被用过」。
        if (detail && detail.ok && args?.touch === true) await learner.noteRead(id)
        return detail
      } catch (e) {
        return { ok: false, error: message(e), code: 'read-failed' }
      }
    },

    /**
     * 算整理草案：只读。
     *
     * 返回的 `drafts[].id` 是确定性的（action + ids）—— 界面「应用」时原样回传，
     * 服务端不靠"再算一遍碰运气"，而是按回传的 ids 直接执行并逐条校验。
     */
    'evolution-organize': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const scope = args?.scope === 'all' ? 'all' : args?.scope === 'global' ? 'global' : 'workspace'
        return await learner.organize(scope)
      } catch (e) {
        return { ok: false, error: message(e), code: 'organize-failed' }
      }
    },

    /** 应用一条草案（用户点过「应用」才会到这里）。 */
    'evolution-apply-organize': async (args: any) => {
      if (!learner) return { ok: false, error: '自主记忆尚未启用', code: 'unavailable' }
      try {
        const result = await learner.applyOrganize({
          action: args?.action,
          ids: Array.isArray(args?.ids) ? args.ids.map((x: unknown) => String(x)) : undefined,
          ...(typeof args?.keep === 'string' ? { keep: args.keep } : {}),
        })
        if (result && result.ok) runtime.invalidate()
        return result
      } catch (e) {
        return { ok: false, error: message(e), code: 'apply-failed' }
      }
    },

    /**
     * 后台复习队列（只读）。
     *
     * 为什么界面需要看这个：复习完全在后台跑，用户唯一的观察窗口就是"学到的条目"。一旦
     * 整批失败（模型没配、密钥过期、上游 5xx），表现是"开了开关但什么都不学" —— 没有
     * 这个 op，这个状态和"这几轮确实没什么可记"长得一模一样。
     *
     * `items` 只列未完成的项：done 的条目已经进了记忆库，列在失败清单里没有意义。
     * `recent` 另给最近 10 条 done 行（带这次学到的条目摘要）—— 界面用它回答
     * 「后台复习到底学成了什么」，而不是只报一个失败数字。
     */
    'evolution-queue': async () => {
      const cold = deps.cold?.()
      if (!cold) return { ok: false, error: '后台复习尚未接线', code: 'no-cold' }
      try {
        const [items, stats] = await Promise.all([cold.queue(), cold.stats()])
        // orphan 排第二：它和 dead 一样「永远不会自己好」，但成因不同（摘要文件被清掉了），
        // 混在 pending 后面会让用户以为它还在排队。
        const order = ['dead', 'orphan', 'failed', 'pending']
        const rows = items
          .filter((x) => x.status !== 'done')
          .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.turn - a.turn)
          .slice(0, 50)
          .map((x) => ({
            id: x.id,
            session: x.session,
            turn: x.turn,
            status: x.status,
            attempts: x.attempts,
            at: x.at,
            ...(x.reason !== undefined ? { reason: x.reason } : {}),
            ...(x.nextAt !== undefined ? { nextAt: x.nextAt } : {}),
          }))
        // 旧 done 行没有 learnedItems；照常返回，界面据此显示「没学到」而不是丢掉时间线。
        const recent = items
          .filter((x) => x.status === 'done')
          .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || b.turn - a.turn)
          .slice(0, 10)
          .map((x) => ({
            id: x.id,
            session: x.session,
            turn: x.turn,
            at: x.at,
            ...(x.reason !== undefined ? { reason: x.reason } : {}),
            ...(x.learnedItems !== undefined && x.learnedItems.length > 0 ? { learnedItems: x.learnedItems } : {}),
            ...(x.rejected !== undefined ? { rejected: x.rejected } : {}),
          }))
        return { ok: true, stats, items: rows, recent }
      } catch (e) {
        return { ok: false, error: message(e), code: 'queue-failed' }
      }
    },

    /**
     * 手动重跑复习。
     *
     * 带 `id` = 重试那一条（含 dead-letter：这是它唯一的出口）；不带 = 把队列里所有
     * pending / failed 跑一遍。两者都不改记忆正文本身 —— 真正写库的仍是复习器 + 九道门。
     */
    'evolution-replay': async (args: any) => {
      const cold = deps.cold?.()
      if (!cold) return { ok: false, error: '后台复习尚未接线', code: 'no-cold' }
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      try {
        if (id !== '') {
          const r = await cold.retry(id)
          if (!r.ok) return { ok: false, error: '队列里没有这一条', code: 'not-found' }
          return { ok: true, attempted: 1 }
        }
        return { ok: true, ...(await cold.replay()) }
      } catch (e) {
        return { ok: false, error: message(e), code: 'replay-failed' }
      }
    },

    /**
     * 列自动记忆（界面与 `memory_get` 共用）。
     *
     * 与 `rules-list` 分开：那条列的是"用户记忆"，这条列的是"agent 学的" —— 两者在界面上
     * 是同一页的两节，但权威等级、状态机、可做的操作都不同，混成一份返回会让界面到处判 `origin`。
     */
    'evolution-list': async (args: any) => {
      try {
        const view = runtime.view()
        const layerFilter = typeof args?.layer === 'string' && args.layer !== '' ? args.layer : undefined
        const statusFilter = typeof args?.status === 'string' && args.status !== '' ? args.status : undefined
        const kindFilter = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : undefined
        const includeAll = args?.all === true
        // 界面传当前工作区 hash：工作区卡只列本项目，别把别的仓库的条目混进来。
        // 模型侧的 `memory_get` 不传，保持全库可见。
        const workspaceFilter = typeof args?.workspaceHash === 'string' && args.workspaceHash !== '' ? args.workspaceHash : undefined
        // 工作区目录消失的条目要能被界面看出来（用户：工作区删除后记忆要跟着"消失"）：
        // hash → missingAt。目录回来了 sweep 会清掉这个标记并同步恢复记忆。
        const missingWs = new Set<string>(
          Object.entries(view.workspaces.workspaces)
            .filter(([, w]) => typeof w.missingAt === 'string' && w.missingAt !== '')
            .map(([hash]) => hash),
        )
        // 没登记过的工作区（旧笔记 / 卡片确认早于登记逻辑）：按会话 cwd 反查名称，
        // 顺手补登记。补完下一次列表就直接读记录，不必再枚举会话。
        const unresolved = [...new Set(
          Object.values(view.catalog.entries)
            .filter((e: any) => e.layer === 'workspace' && e.workspace !== '' && view.workspaces.workspaces[e.workspace] === undefined)
            .map((e: any) => String(e.workspace)),
        )]
        const resolvedLabels: Record<string, string> = {}
        if (unresolved.length > 0 && deps.workspaceKeysOfHashes) {
          try {
            const keys = await deps.workspaceKeysOfHashes(unresolved)
            for (const [hash, key] of Object.entries(keys || {})) {
              if (typeof key !== 'string' || key === '') continue
              const label = workspaceLabelOfPath(key)
              resolvedLabels[hash] = label
              try {
                await config.writeWorkspace(key, workspaceCwdOfScopeKey(key) ?? '', label, undefined)
              } catch { /* 补登记失败不影响本次显示 */ }
            }
          } catch { /* 反查失败就按 hash 短码兜底 */ }
        }
        const rows: any[] = []
        for (const entry of Object.values(view.catalog.entries)) {
          if (layerFilter && entry.layer !== layerFilter) continue
          if (statusFilter && entry.status !== statusFilter) continue
          if (kindFilter && entry.kind !== kindFilter) continue
          if (workspaceFilter && entry.layer === 'workspace' && entry.workspace !== workspaceFilter) continue
          const st = view.state.entries[entry.id]
          const pendingReason = st && typeof st.pendingReason === 'string' && st.pendingReason !== '' ? st.pendingReason : ''
          const reviewDue = st && typeof st.reviewDue === 'string' && st.reviewDue !== '' ? st.reviewDue : ''
          // 工作区条目的显示名：界面按它分节，用户才知道这一组属于哪个项目。
          // 记录可能还没登记（新工作区第一次写入）：留给界面用 hash 短码兜底。
          const wsRecord = entry.layer === 'workspace' && entry.workspace !== ''
            ? view.workspaces.workspaces[entry.workspace]
            : undefined
          // 默认列「待确认 + 会注入的」：候选不看 pendingReason（所有新学条目都是候选，
          // 不是每条都带理由）；archived / superseded 只在 all=true 时出现。
          if (!includeAll && entry.status !== 'candidate' && !isInjectableStatus(entry.status)) continue
          rows.push({
            id: entry.id,
            layer: entry.layer,
            kind: entry.kind,
            key: entry.key,
            status: entry.status,
            // 档位从证据算（catalog 不再存副本）。界面按它排序与标色。
            tier: st ? tierOf(st.evidence) : 'inferred',
            oneLine: entry.oneLine,
            // 正文只在明确要求时返回（`withBody`）：界面列表用不上它，整库带上会让回包
            // 大一个量级；而 `memory_get` 的搜索需要它 —— 只搜 `oneLine`（160 宽度截断
            // 摘要）等于「搜不到正文后半截的内容」，与工具描述写的 "or body" 不符。
            ...(args?.withBody === true ? { body: entry.body } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            enabled: entry.enabled,
            // 「会不会进上下文」的主判据就是这两个：状态与单条开关。层匹配由调用方判
            // （界面知道自己是谁、模型知道自己的 sid/cwd），op 层不猜。
            injects: entry.enabled && isInjectableStatus(entry.status),
            tokens: entry.estTokens,
            // 注入总盘按字节算，界面要把自主段并进页头那个「已用/上限」。
            bytes: entry.bytes,
            workspace: entry.workspace,
            ...(wsRecord !== undefined
              ? {
                  workspaceLabel: typeof wsRecord.label === 'string' && wsRecord.label !== ''
                    ? wsRecord.label
                    : workspaceLabelOfPath(wsRecord.key),
                }
              : resolvedLabels[String(entry.workspace)] !== undefined
                ? { workspaceLabel: resolvedLabels[String(entry.workspace)] }
                : {}),
            scene: entry.scene,
            session: entry.session,
            ...(entry.layer === 'workspace' && entry.workspace !== '' && missingWs.has(entry.workspace) ? { wsMissing: true } : {}),
            ...(pendingReason !== '' ? { pendingReason } : {}),
            ...(reviewDue !== '' ? { reviewDue } : {}),
            // `degraded` / `locked` / `counters` / `transitions` **不在这里返回**：列表一次刷新
            // 几十条，这些字段没有消费者（界面只在展开单条时读详情，那条路走 `evolution-read`
            // 的 `describe()`，它完整给出 state 里的计数、证据与时间线）。留在列表里只会让回包
            // 变大，并让下一个人以为界面某处用着它。
          })
        }
        // 待确认的排前面：界面的「待确认」入口靠这个顺序。
        const rankOf = (s: string): number => s === 'candidate' ? 0 : isInjectableStatus(s) ? 1 : s === 'archived' ? 2 : 3
        // 排序：待确认优先 → 生效 → 历史；同档按证据档位，再按 id（确定性）。
        const tierRank = (t: string): number => t === 'confirmed' ? 3 : t === 'quoted' ? 2 : 1
        rows.sort((a, b) => rankOf(a.status) - rankOf(b.status) || tierRank(b.tier) - tierRank(a.tier) || a.id.localeCompare(b.id))
        return {
          ok: true,
          entries: rows,
          total: Object.keys(view.catalog.entries).length,
          broken: view.broken,
          settings: view.settings,
        }
      } catch (e) {
        return { ok: false, error: message(e), code: 'list-failed' }
      }
    },

    /** 跑一遍维护扫描（`dry: true` 只出计划）。 */
    'evolution-maintain': async (args: any) => {
      if (!deps.sweep) return { ok: false, error: '维护扫描尚未接线', code: 'no-sweep' }
      try {
        const dry = args?.dry === true
        const report = await deps.sweep({ dry })
        if (!dry) runtime.invalidate()
        return { ok: true, ...report }
      } catch (e) {
        return { ok: false, error: message(e), code: 'maintain-failed' }
      }
    },

    /** 健康度：只读，界面每次打开记忆页都会拉一次。 */
    'evolution-health': async () => {
      if (!deps.health) return { ok: false, error: '健康度尚未接线', code: 'no-health' }
      try {
        return { ok: true, ...(await deps.health()) }
      } catch (e) {
        return { ok: false, error: message(e), code: 'health-failed' }
      }
    },
  }
}
