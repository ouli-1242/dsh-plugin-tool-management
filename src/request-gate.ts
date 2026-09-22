// HTTP 请求准入与 handlers 后处理（原 index.ts apply() 闭包内四段，2026-09-19 抽出）。
//
// 这一域管「谁能改、改哪些、什么时候不许改」：
//   * 访问令牌（可选）—— 两条用途：宿主浏览器鉴权的逃生口，以及写操作的纵深防御；
//   * 写 / 敏感 op 白名单 —— 哪些 op 要凭令牌（含"只读但会泄露明文"与"只读但会改宿主状态"）；
//     清单本身在 `./op-registry.ts`，本文件只拼装（`opsWith` / `frozenOps`）。
//   * 场景锁定 —— 任一场景 locked=true 时五个管理域整体冻结；
//   * handlers 后处理 —— 把上面三条装到 op 表上（包装顺序即语义，见 installHandlerGuards）。
//
// 为什么抽出来：四段分散在 apply() 的 220 / 902 / 1650 / 1928，靠闭包共享 handlers 与
// memoriesService。抽成工厂后依赖改为显式入参，index.ts 只剩四行装配 —— 而引用点用解构
// 保持原名字，一行没动（改名才是这类搬迁最容易出静默错误的地方）。
//
// **一处必须守住的不变量**：handlers 的后处理顺序。`guardLockedOps` / `syncSceneArchiveOnSwitch`
// 都是「读原函数 → 换包装」的原地改写，先装的在内层、后装的在外层；`annotateLocked` 只挂在
// 五个读 op 上。整段照搬、顺序未变。

import { createHash, timingSafeEqual } from 'node:crypto'
import { frozenOps, opsWith } from './op-registry.js'

// ── 1. 访问令牌 ──────────────────────────────────────────────────────────────

export interface AccessTokenDeps {
  /** 插件配置（apply 的第二个参数）。 */
  config?: Record<string, unknown>
}

export interface AccessToken {
  /** 配置里的**存量**令牌（比较与"关掉后还能开回来"都用它）。 */
  CONFIG_TOKEN: string
  /** `config.tokenDisabled === true`：令牌留在配置里但不生效。 */
  TOKEN_DISABLED: boolean
  /** 写门禁用的**生效**令牌：关掉即视为没配。 */
  TOKEN: string
  /** 与存量令牌比对（双侧 sha256 → timingSafeEqual）。 */
  tokenMatches(presented: string): boolean
  /** 本次**进程**的标识（界面把"填过的令牌"与它绑定，重启即失效）。 */
  BOOT_ID: string
  /**
   * 本次进程里**有没有人拿对过令牌**（见 `markAccepted`）。
   *
   * 与 `BOOT_ID` 同一生命周期：重启即清零。客户端把"填过的令牌"与 bootId 绑在一起，
   * 所以重启后它手里那串不再作数 —— 于是"验过没有"这件事天然按启动算。
   */
  acceptedThisBoot(): boolean
  /** 记下"本次进程验过一次令牌"（HTTP 入口在带对令牌时调用）。 */
  markAccepted(): void
  /**
   * 把闩重新挂上（「清除令牌」调用）：此后 pre-step 门禁恢复拦截，直到再有人验对。
   *
   * 不要求凭证 —— 它只会**收紧**（要求重新验令牌），给不了任何人任何权限。没有它，
   * 解锁一次之后「清除令牌 + 刷新页面」就是个后门：浏览器里已无令牌，闩却挂着，
   * 对话整个启动期畅通（2026-09-19 用户实测）。
   */
  unmarkAccepted(): void
}

/**
 * 建访问令牌三件套。**必须**从 apply 的第二个参数取配置 ——
 * 读 `ctx.config` 不是注入服务，启动时会抛 "cannot get property without inject"。
 */
export function createAccessToken(deps: AccessTokenDeps): AccessToken {
  const { config } = deps

  // Optional access token. Enabled by setting `config.token` on this plugin's
  // loader row (profile cordis.patch.yml override) or the
  // DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN env var. Two roles now:
  //   1. escape hatch — a correct token is accepted *in place of* the host's
  //      browser authentication, so curl/scripts and LAN tooling keep working;
  //   2. defense in depth — when set, every state-changing op additionally
  //      requires `x-dsh-token: <token>`.
  // It is NOT the primary gate anymore: the route calls the host's
  // connection.requestRejection fence first (Host must be loopback/LAN
  // IP-literal → defeats DNS rebinding, plus browser-session cookie auth),
  // so an unset token no longer means "anyone may call writes".
  // NOTE: the entry config arrives as the SECOND apply argument (Cordis
  // calls `callback(ctx, config)`) — never read it off `ctx.config`, which
  // is not an injected service and throws "cannot get property without
  // inject" at boot.
  const CONFIG_TOKEN = String((config as { token?: unknown } | undefined)?.token || process.env.DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN || '').trim()
  /**
   * `config.tokenDisabled: true` = 令牌**留在配置里**但当前不生效（用户主动关掉）。
   *
   * 与"没配令牌"的区别（用户裁定 2026-09-19）：关掉之后随时能开回来，不需要重新输一遍；
   * 两者对写操作的要求一样 —— 都不带令牌。
   */
  const TOKEN_DISABLED = (config as { tokenDisabled?: unknown } | undefined)?.tokenDisabled === true
  /** 写门禁用的**生效**令牌：关掉即视为没配（配置里的值原样保留）。 */
  const TOKEN = TOKEN_DISABLED ? '' : CONFIG_TOKEN
  // 令牌比较走「双侧 sha256 → timingSafeEqual」：摘要定长 32 字节，无需长度分支
  // （直接比较不等长 Buffer 会抛），逐字节的耗时不随匹配前缀长度变化 —— JS 的 ===
  // 逐字符短路，理论上可被计时侧信道逐位猜测。
  // 比较的是**存量**令牌（CONFIG_TOKEN）而不是生效值：关掉之后仍然要凭它才能开回来 /
  // 换掉 / 看明文（要求 9：关闭令牌需要验证当前的令牌）。
  const tokenMatches = (presented: string): boolean =>
    timingSafeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(CONFIG_TOKEN).digest())

  // 本次**进程**的标识（用户裁定 2026-09-18 第 3 条：「每次启动只用填一次，退出进程后再启动就要重填」）。
  // 界面把"填过的令牌"和这个值绑在一起存，读到不同值就作废 —— 于是重启后必须重填，
  // 而同一次运行内刷新页面不必重填。
  //
  // 用 pid + 进程启动时刻，而不是每次 apply 现生成的随机串：apply 在 HMR / 重复挂载时会再跑一次，
  // 那时候换掉 BOOT_ID 会把用户刚填好的令牌判成过期（表现为"刚填完又要求填"）。
  // 进程启动时刻由 `Date.now() - uptime()` 反推，同一进程内恒定、跨进程几乎不会撞。
  const BOOT_ID = (() => {
    try { return process.pid + '-' + Math.round(Date.now() - process.uptime() * 1000) } catch { return 'unknown' }
  })()

  /**
   * 「本次启动已经验过令牌」的闩。验过即置位；唯一的手动清零入口是 `unmarkAccepted`
   * （「清除令牌」走的 `token-unaccept`，见上）。重启自然清零。
   *
   * 用途：`agent/pre-step` 的令牌门禁要回答"这台机器现在是不是还没人验过令牌"，而它看不到
   * 浏览器请求头。HTTP 入口是唯一知道答案的地方（那里才知道 `x-dsh-token` 对不对），
   * 所以由入口在验过时置位，门禁读这一个布尔 —— 两边不共享别的东西。
   *
   * 注意它**不是**"当前请求带没带令牌"：带上之后页面刷新、切页、轮询都不该再要求重填，
   * 而这与界面的 bootId 口径一致（同一进程内只需填一次）。
   *
   * 已知边界：闩按**进程**记，不区分浏览器 —— 同一启动里任何一个客户端验对过，其它
   * 客户端的对话也放行。这是"填一次只管本次启动"（裁定 2026-09-18 第 3 条）在 pre-step
   * 只能看宿主全局状态下的固有代价；外层还有宿主的连接围栏（回环 / 局域网字面量 +
   * 浏览器会话 cookie）兜着。
   */
  let accepted = false

  return {
    CONFIG_TOKEN,
    TOKEN_DISABLED,
    TOKEN,
    tokenMatches,
    BOOT_ID,
    acceptedThisBoot: () => accepted,
    markAccepted: () => { accepted = true },
    unmarkAccepted: () => { accepted = false },
  }
}

// ── 2. 写 / 敏感 op 白名单 ───────────────────────────────────────────────────

export interface OpWhitelistDeps {
  /** 各 service 自报的写 op（与其 ops 表同文件同源维护）。 */
  writeOps: {
    skills: Iterable<string>
    memories: Iterable<string>
    archives: Iterable<string>
    subagents: Iterable<string>
  }
}

export interface OpWhitelist {
  /** 需要访问令牌的写 op。 */
  WRITE_OPS: Set<string>
  /** 会泄露明文凭据 / 完整配置的 op（**必须**带对的令牌，没配令牌就一律拒绝）。 */
  SENSITIVE_OPS: Set<string>
}

/** 建白名单。必须在四个 service 创建之后构造（依赖其 writeOps）。 */
export function createOpWhitelist(deps: OpWhitelistDeps): OpWhitelist {
  // 清单本身在 `./op-registry.ts` 里逐条登记（判据、口径、为什么）。这里只做拼装：
  // 写 = 四个 service 自报的 writeOps ∪ 登记表里标了 write 的内联域；敏感 = 登记表标 sensitive。
  const WRITE_OPS = new Set<string>([
    ...deps.writeOps.skills,
    ...deps.writeOps.memories,
    ...deps.writeOps.archives,
    ...deps.writeOps.subagents,
    ...opsWith('write'),
  ])

  // 会泄露明文凭据 / 完整配置的 op：**必须**带对的访问令牌，没配令牌就一律拒绝
  // （判定在 http-fence.ts 的 secretOpRejection，含两种情况的区分与理由）。
  const SENSITIVE_OPS = new Set<string>(opsWith('sensitive'))

  return { WRITE_OPS, SENSITIVE_OPS }
}

// ── 3. 场景锁定查询 ──────────────────────────────────────────────────────────

export interface SceneLockDeps {
  /** 读场景清单（`memoriesService.ops['rules-list']({})` 的结果；只用 scenes / activeScene）。 */
  readSceneList(): Promise<unknown>
}

export interface SceneLock {
  /** 所有 locked=true 的场景名。 */
  lockedSceneNames(): Promise<string[]>
  /** 当前启用（= 已进入）的那个场景名；没有则 null。 */
  activeSceneName(): Promise<string | null>
  /** 「当前场景已锁定」的拒绝文案（模型工具用；无活动场景 / 未锁定 → null）。 */
  lockedSceneGuard(): Promise<string | null>
}

// ---------- 场景锁定守卫（v0.8）----------
// 任一场景 locked=true = 五个管理域（MCP/技能/子智能体/记忆/提示词）整体冻结：
// 下面列出的写 op 一律拒绝；界面按钮同步禁用，这里是兜底（防止绕过界面直接打 op）。
// 只包 **handlers** 这一层是有意的：进/退模式的运行时应用走的是内部函数与
// service.ops（applyMcpServerSwitches / applySkills / applySubagentSwitches / patchIndex），
// 不经过 handlers —— 锁定就是为了让场景能按原样启动，运行时应用不能被自己挡住。
// 例外里的例外：scene-archive-save / rules-remove-scene 只对**被锁的那个场景**拒绝。
export function createSceneLock(deps: SceneLockDeps): SceneLock {
  async function lockedSceneNames(): Promise<string[]> {
    const r: any = await deps.readSceneList()
    return ((r && r.scenes) || []).filter((s: any) => s.locked === true).map((s: any) => String(s.name))
  }
  /** 当前启用（= 已进入）的那个场景名；没有则 null。 */
  async function activeSceneName(): Promise<string | null> {
    try {
      const r: any = await deps.readSceneList()
      return r && r.ok && r.activeScene ? String(r.activeScene) : null
    } catch { return null }
  }
  /** 「当前场景已锁定」的拒绝文案（模型工具用；无活动场景 / 未锁定 → null）。 */
  async function lockedSceneGuard(): Promise<string | null> {
    const scene = await activeSceneName()
    if (!scene) return null
    const locked = await lockedSceneNames()
    return locked.includes(scene) ? `场景「${scene}」已锁定：先到场景页解锁再改。` : null
  }
  return { lockedSceneNames, activeSceneName, lockedSceneGuard }
}

// ── 4. handlers 后处理 ───────────────────────────────────────────────────────

export interface HandlerGuardsDeps {
  /** op 表。原地改写：包装会被写回**同一个对象**，所以传引用，不能传副本。 */
  handlers: Record<string, (args: any) => Promise<any>>
  lockedSceneNames(): Promise<string[]>
  activeSceneName(): Promise<string | null>
  /** 开关成功后把改动同步进当前场景档案（见 index.ts 的 syncSwitchToScene）。 */
  syncSwitchToScene(op: string, args: any): Promise<string | null>
  /** 注册失败的工具清单（apply 期间定下来，随 subagent-list 带出去）。 */
  subagentToolFailures: Array<{ name: string; reason: string }>
}

export function installHandlerGuards(deps: HandlerGuardsDeps): void {
  const { handlers, lockedSceneNames, activeSceneName, syncSwitchToScene, subagentToolFailures } = deps

  /**
   * 包一层：开关成功后把改动同步进当前场景档案（见 syncSwitchToScene）。
   * 失败只挂 `sceneSyncError`，不改写原操作的成功结论 —— 运行时确实改了，档案没跟上要说得清。
   * 锁定仍由 `guardLockedOps` 挡住（更靠内的那层包装先执行）。
   */
  function syncSceneArchiveOnSwitch(opNames: string[]): void {
    for (const opName of opNames) {
      const original = handlers[opName]
      if (typeof original !== 'function') continue
      handlers[opName] = async (args: any) => {
        const res: any = await original(args)
        if (!res || res.ok === false) return res
        const err = await syncSwitchToScene(opName, args)
        return err ? { ...res, sceneSyncError: err } : res
      }
    }
  }
  function guardLockedOps(opNames: string[], what: string): void {
    for (const opName of opNames) {
      const original = handlers[opName]
      if (typeof original !== 'function') continue
      handlers[opName] = async (args: any) => {
        const locked = await lockedSceneNames()
        if (locked.length) return { ok: false, error: `场景已锁定（${locked.join('、')}）：先到场景页解锁再${what}` }
        return original(args)
      }
    }
  }
  // 冻结清单与档案同步清单都来自 `./op-registry.ts`：加 op 时在那里登记一条，这里不再抄。
  guardLockedOps(frozenOps('all'), '修改')
  // 场景内「开关」类操作（用户裁定 2026-09-17）：未锁定时**可用**，改动同步进当前场景档案。
  // 与「锁定」正交：锁定冻结全部写操作，这里只是把页面开关的意图也写进档案。
  syncSceneArchiveOnSwitch(opsWith('syncsArchive'))
  // 口径 `frozenScope: 'active-scene'` 的那几条（判据与理由登记在 op-registry.ts 的
  // `rules-set-active` 条目上）。没有锁定场景在生效时（全局态 / 场景未锁）照旧可用。
  const ACTIVE_SCENE_LABEL: Record<string, string> = { 'rules-set-active': '切换场景' }
  for (const opName of frozenOps('active-scene')) {
    const what = ACTIVE_SCENE_LABEL[opName] ?? '改它'
    const original = handlers[opName]
    if (typeof original !== 'function') continue
    handlers[opName] = async (args: any) => {
      const scene = await activeSceneName()
      if (scene && (await lockedSceneNames()).includes(scene)) {
        // 同集合的重复提交放行：它没有改变任何东西，不该被"冻结"挡下来。
        const current = new Set<string>([scene])
        const next = new Set<string>(
          (Array.isArray(args && args.scenes) ? args.scenes : [])
            .map((n: unknown) => String(n == null ? '' : n).trim())
            .filter((n: string) => n !== ''),
        )
        const same = current.size === next.size && [...current].every((n) => next.has(n))
        if (!same) {
          return { ok: false, error: `场景「${scene}」已锁定：先到场景页解锁再${what}（锁定期间改启用集合会让模型侧的写门禁失效）` }
        }
      }
      return original(args)
    }
  }
  // 被锁场景自身的档案与删除：只挡它自己，别的场景照常（口径 `frozenScope: 'self-scene'`）。
  // 目标场景一律从 `args.scene` / `args.name` 里取 —— 这两个键名就是本插件 op 的惯例。
  const SELF_SCENE_LABEL: Record<string, string> = { 'scene-archive-save': '改档案', 'rules-remove-scene': '删除' }
  for (const opName of frozenOps('self-scene')) {
    const what = SELF_SCENE_LABEL[opName] ?? '改它'
    const original = handlers[opName]
    if (typeof original !== 'function') continue
    handlers[opName] = async (args: any) => {
      const scene = String((args && (args.scene || args.name)) || '').trim()
      const locked = await lockedSceneNames()
      if (scene && locked.includes(scene)) return { ok: false, error: `场景「${scene}」已锁定：先解锁再${what}` }
      return original(args)
    }
  }
  // 各页列表响应带上 anyLocked + activeScene：界面据此禁用写控件、并说明
  // 「当前处于场景 X，开关请到档案里改」（读 op，附加字段不影响既有消费方）。
  async function annotateLocked(res: any): Promise<any> {
    if (res && res.ok !== false) {
      const locked = (await lockedSceneNames()).length > 0
      const scene = await activeSceneName()
      res.anyLocked = locked
      res.activeScene = scene
      // 信封里再套一层 `data` 的 op（`skill-state` 就是）必须**同时**写进 `data`：
      // 客户端 callApi 只把 `data` 交给页面，外层字段在那一层就被丢掉了 ——
      // 于是"服务端明明标了、技能页两个横幅却从来不显示"（2026-09-19 用户报的）。
      if (res.data && typeof res.data === 'object') {
        res.data.anyLocked = locked
        res.data.activeScene = scene
      }
    }
    return res
  }
  for (const opName of opsWith('annotatesLock')) {
    const original = handlers[opName]
    if (typeof original !== 'function') continue
    handlers[opName] = async (args: any) => annotateLocked(await original(args))
  }
  // 子智能体页面横幅的数据源：注册失败的工具名与原因随列表一起带出去（同一处 attach 的
  // 语义，见上方 annotateLocked）。失败清单在 apply 期间就定下来了，这里只是挂上去。
  {
    const original = handlers['subagent-list']
    if (typeof original === 'function') {
      handlers['subagent-list'] = async (args: any) => {
        const res: any = await original(args)
        if (res && res.ok !== false) res.toolFailures = subagentToolFailures.map((f) => ({ ...f }))
        return res
      }
    }
  }
}
