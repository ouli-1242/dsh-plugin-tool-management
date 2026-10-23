// 全局意图（`hub/scope-intent.json`）—— 把「用户想要什么」与「此刻在跑什么」分开记。
//
// ## 为什么需要这一层
//
// MCP 连接与技能来源启用都是**进程级**的，没有"某个会话的一份"。会话里打开一台全局关着的
// 服务器时，唯一能让本会话用上它的办法就是把它在全局拉起来。此前「全局开着」只由补丁表示，
// 于是这次拉起同时改变了**别的会话**看到的全局默认 —— 新开的会话也继承它。用户实测的
// 「会话开了 mcp，开一个新会话也注入了会话级的 mcp 信息」正是这条路径。
//
// 拆成三件事之后就不会串：
//
//   · **intent**：用户对全局的定义，`on` / `off` / `blocked` 三态；
//   · **running**：补丁 / 来源状态里的实际启停，恒等于 `intent ∪ 租约`；
//   · **claim（租约）**：某个未归档会话在这一格上拨了"开"，而全局意图不是 `on`。
//     它是**派生**的（从覆盖表 + 场景档案 + 会话清单实时算出），不落盘 —— 落盘就会与会话
//     删除 / 归档 / 场景改档案这几条路径分叉。
//
// 用户要求「仍按租约运行」：全局 off + 有租约 → 连接保持运行，但只有认领的
// 会话看得到它；未认领的会话（含新会话）一律按 off。`blocked` 是显式拒绝，压过租约与
// 一切会话层；新界面不再写它 —— MCP 的「统一关闭」已改为一次性动作（先写 off 再清掉
// 各层认领），读侧仍认这个值，保证升级前留下的记录照旧生效。
//
// ## 为什么只有这三格有意图
//
// 只有它们是"进程级 / 机器级"的资源，没有"某个会话的一份"：
//   · **MCP 服务器** —— 连接是宿主的；
//   · **技能来源** —— 启用写在 core 的 `state.json`；
//   · **单条技能**—— 启停是 core 那张策略表，官方 provider 按进程发布它。
//     会话里"开"一条全局关着的技能，唯一让它真加载得了的办法就是临时落到那张表上；
//     不这么做，目录写着有、官方 `skill` 工具必拒（空头承诺）。
//
// 人设 / 记忆 / 快捷提示词的开关本身就按会话求值（会话层是一个纯视图，读的人就是我们自己），
// 不需要意图这一层。

import type { SceneArchive } from '../memories/archive.js'
import { SCOPE_FLAG_DOMAINS, layeredFlagWithChildren, overrideOf, type ScopeFlagDomain, type ScopeMode, type SessionScope } from './scope-overrides.js'
import { isWorkspaceScopeKey, scopeKeyOfRow } from './workspace-key.js'

/** 意图三态。`blocked` = 显式拒绝，压过租约与一切会话层（旧版本的值；新界面不再写它）。 */
export type IntentState = 'on' | 'off' | 'blocked'

/**
 * 有意图这一层的域：MCP 服务器 / 技能来源 / 单条技能。
 *
 * **冻结**：这张表被读写四处共用（意图侧车、对账器、快照投影、界面三态）。
 * 运行期往里 push 一个域，等于让其中一处悄悄多认一格、其余三处不认 —— 那种分叉不会抛错，
 * 只会表现为"某一格拨了没反应"。要加域就改这里，四处的类型检查会一起告诉你还差什么。
 */
export const INTENT_DOMAINS = Object.freeze(['mcp', 'skillSources', 'skills'] as const)

/** 有意图这一层的域。 */
export type IntentDomain = (typeof INTENT_DOMAINS)[number]

/** 侧车 `scope-intent.json` 的形状。 */
export interface ScopeIntent {
  version: 1
  mcp: Record<string, IntentState>
  skillSources: Record<string, IntentState>
  /** 单条技能：键是 `<root>/<声明名>`（与覆盖表、目录、档案同一套键）。 */
  skills: Record<string, IntentState>
}

/** 一个键能不能进意图表（与覆盖表同一口径：非空、不超长、不含控制字符）。 */
function validKey(key: unknown): key is string {
  return typeof key === 'string' && key !== '' && key !== '__proto__' && key.length <= 256 && !/[\u0000-\u001f\u007f]/.test(key)
}

/** 是不是意图域。 */
export function isIntentDomain(value: unknown): value is IntentDomain {
  return typeof value === 'string' && (INTENT_DOMAINS as readonly string[]).includes(value)
}

/** 夹一个意图值；不认识的一律 undefined（坏输入不抛）。 */
export function normalizeIntentState(value: unknown): IntentState | undefined {
  return value === 'on' || value === 'off' || value === 'blocked' ? value : undefined
}

function normalizeIntentMap(raw: unknown): Record<string, IntentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.create(null)
  const out: Record<string, IntentState> = Object.create(null)
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!validKey(key)) continue
    const state = normalizeIntentState(value)
    if (state !== undefined) out[key] = state
  }
  return out
}

/** 把任意输入夹成合法侧车（读盘时用；坏输入不抛）。 */
export function normalizeScopeIntent(raw: unknown): ScopeIntent {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    version: 1,
    mcp: normalizeIntentMap(obj.mcp),
    skillSources: normalizeIntentMap(obj.skillSources),
    skills: normalizeIntentMap(obj.skills),
  }
}

/** 某域某键的意图（没有 = undefined，表示"还没有意见"，由运行态兜底）。 */
export function intentOf(intent: ScopeIntent | undefined, domain: IntentDomain, key: string): IntentState | undefined {
  if (intent === undefined) return undefined
  return intent[domain][key]
}

/** 写一批意图（返回新对象，不改入参）。 */
export function withIntent(intent: ScopeIntent, domain: IntentDomain, keys: readonly string[], state: IntentState): ScopeIntent {
  const map: Record<string, IntentState> = Object.assign(Object.create(null), intent[domain])
  for (const key of keys) {
    if (!validKey(key)) continue
    map[key] = state
  }
  return { ...intent, [domain]: map }
}

/**
 * 某一格在这个会话里的解析结果。
 *
 * `visible` 是**界面 / 注入 / 工具表 / 执行守卫**四处共用的那一个答案：
 *   · `true` / `false` = 确定看得到 / 看不到；
 *   · `undefined` = 还没有意图记录、会话层也没话说 —— 调用方按运行态兜底（升级期 / 新服务器）。
 * `claim` = 这个会话是否在"全局意图不是 on"的情况下仍要它（租约的来源）。
 */
export interface ResourceView {
  visible: boolean | undefined
  claim: boolean
}

/**
 * 一台服务器 / 一个来源在某个会话里的可见性。`lower` 是会话的那三层
 * （覆盖 → 场景层 → 基线）的并值，`undefined` = 三层都没话说。
 *
 * 优先级：`blocked`（显式拒绝）> 会话层 > `on` / `off` > 运行态。
 * blocked 压过会话层是它的定义：否则一个还留着 `mcp[x]=true` 的会话就能把它复活，
 * 那一步就没有出口了。
 */
export function resolveResource(intent: IntentState | undefined, lower: boolean | undefined): ResourceView {
  if (intent === 'blocked') return { visible: false, claim: false }
  if (lower === false) return { visible: false, claim: false }
  if (lower === true) return { visible: true, claim: intent === 'off' }
  if (intent === 'on') return { visible: true, claim: false }
  if (intent === 'off') return { visible: false, claim: false }
  return { visible: undefined, claim: false }
}

/** 一个会话在某一格上的**有效层**（覆盖 → 场景层 → 基线；不看全局与意图）。 */
export function effectiveLayerOf(
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
  domain: ScopeFlagDomain,
  key: string,
): boolean | undefined {
  const over = overrideOf(scope, domain, key)
  if (over !== undefined) return over
  // 上层闸推导：显式拨开一条工具 / 技能，就认它所在的整台服务器 / 来源也是开
  // —— 否则全局后来关掉服务器 / 来源时，这条显式开启会变成"界面开着、模型调不到"。
  // 显式的上层覆盖（含关）压过这条推导，见上一条 `overrideOf`。
  return layeredFlagWithChildren(scope, archive, domain, key)
}

/**
 * 一条覆盖记录算不算**认领**（归档认领不变式）。
 *
 * 展示侧（`countViewClaims` 的徽章计数）与执行侧（对账器的租约）必须同一口径，
 * 否则会出现两种都很难查的症状：徽章说"还有 2 个对话在用"而资源已经被停掉；
 * 或者资源还在跑、而界面上一个认领者都指不出来。
 *
 *   · **已归档**会话不认领 —— 它已经不用了。覆盖留着（恢复后自然回来），但不再持有资源。
 *   · **清单里没有的会话**（已删除 / 孤儿）不认领；但**清单一条都没读到时不做这条判定** ——
 *     读不到 ≠ 不存在，宁可多留一个租约，也不能把正在用的会话的服务器停掉。
 *
 * @param row 会话清单里的那一行；`undefined` = 清单里没有它。
 * @param listKnown 会话清单这一轮读到东西了吗（`rows.length > 0`）。
 */
export function claimsResource(row: { archived?: boolean } | undefined, listKnown: boolean): boolean {
  if (row !== undefined && row.archived === true) return false
  if (listKnown && row === undefined) return false
  return true
}

/** 认领扫描要问的键集合（域 → 这一格要问的键）。省掉没问的域 = 内存几百条键的域不会全扫。 */
export type ClaimScanTargets = Partial<Record<ScopeFlagDomain, readonly string[]>>

/** 一次认领扫描的产物（七域各一份）。 */
export interface ClaimScanResult {
  /** 域 → 键 → 认领会话 id（未归档、且在会话清单里）。 */
  claims: Record<ScopeFlagDomain, Map<string, string[]>>
  /** 域 → 键 → **显式**拨过这一格的会话 id（`scope[domain][key] === true`），不做归档过滤。 */
  explicit: Record<ScopeFlagDomain, Map<string, string[]>>
  /** 域 → 键 → 侧车里有没有会话痕迹（任一会话的有效层为 true），**不做**归档 / 清单过滤。 */
  traced: Record<ScopeFlagDomain, Set<string>>
}

/** 意图对账的输入：哪些会话占着资源、哪些已归档。 */
export interface ClaimScanInput {
  sessions: Record<string, SessionScope>
  /** 会话清单。`cwd` 用于工作区模式下把会话折到同一个作用域键。 */
  rows: readonly { id: string; archived?: boolean; cwd?: string }[]
  /** 当前隔离粒度；缺省 = session。 */
  mode?: ScopeMode
  archiveOf: (scope: SessionScope) => SceneArchive | undefined
  targets: ClaimScanTargets
}

/**
 * 七域认领扫描（纯函数）：一趟扫完"谁在这一格上要它"。
 *
 * 展示侧（徽章计数）与执行侧（对账租约）此前各写一份扫描（装配层的 `countViewClaims` /
 * `leaseClaimsOf`），口径一旦分叉就会出现两种都很难查的症状：徽章说"还有 2 个对话在用"
 * 而资源已经被停掉，或者资源还在跑、界面上一个认领者都指不出来。现在由这一个函数产出三样
 * 东西，两处装配层只做薄壳：
 *
 *   · `claims`   —— 未归档且在清单里的会话（`claimsResource` 仍是唯一真源）；
 *   · `explicit` —— 显式覆盖为 true 的会话（升级首轮判"旧版本的会话级开启"用）；
 *   · `traced`   —— 侧车里**任何**会话（含归档 / 孤儿）的有效层为 true，即"这一格被某个
 *                   会话动过"的痕迹；对账器据此拒绝把运行态采纳成全局 `on`（见 planReconcile）。
 *
 * 逐工具 / 单条技能为"开"也认领它所在的整台服务器 / 来源：工具能调的前提是那台在跑。
 *
 * @param input.archiveOf 会话的场景档案解析器（装配层用 `sceneArchiveOfSession`）。
 */
export function scanSessionClaims(input: ClaimScanInput): ClaimScanResult {
  const claims = {} as Record<ScopeFlagDomain, Map<string, string[]>>
  const explicit = {} as Record<ScopeFlagDomain, Map<string, string[]>>
  const traced = {} as Record<ScopeFlagDomain, Set<string>>
  for (const domain of SCOPE_FLAG_DOMAINS) {
    claims[domain] = new Map()
    explicit[domain] = new Map()
    traced[domain] = new Set()
  }
  const ask = {} as Record<ScopeFlagDomain, ReadonlySet<string>>
  const domains: ScopeFlagDomain[] = []
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const keys = input.targets[domain]
    ask[domain] = new Set(keys === undefined ? [] : keys)
    if (ask[domain].size > 0) domains.push(domain)
  }
  if (domains.length === 0) return { claims, explicit, traced }
  const servers = ask.mcp
  const roots = ask.skillSources
  const mode = input.mode ?? 'session'
  // 会话清单按**当前模式的作用域键**分桶：工作区模式下同一工作区的一批会话落在同一格里。
  // 无 cwd 的会话仍以 sessionId 为键（会话隔离回退）。
  const byKey = new Map<string, Array<{ id: string; archived?: boolean; cwd?: string }>>()
  for (const row of input.rows) {
    const key = scopeKeyOfRow(row, mode)
    const list = byKey.get(key)
    if (list === undefined) byKey.set(key, [row])
    else list.push(row)
  }
  const listKnown = input.rows.length > 0
  const bump = (map: Map<string, string[]>, key: string, id: string): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [id])
    else if (list.indexOf(id) < 0) list.push(id)
  }
  for (const [scopeKey, scope] of Object.entries(input.sessions)) {
    // 快路径：这个会话 / 工作区一个域都没话说。**只有基线不算** —— 基线只在脱离（detached）时
    // 生效，绝大多数记录只带一条基线，为它们把每个键都问一遍是白跑。
    const speaks = scope.scene !== undefined || scope.detached === true ||
      scope.mcp !== undefined || scope.mcpTools !== undefined ||
      scope.skillSources !== undefined || scope.skills !== undefined ||
      scope.memory !== undefined || scope.subagents !== undefined || scope.quickPrompts !== undefined
    if (!speaks) continue
    const holders = byKey.get(scopeKey) ?? []
    // 只处理**当前模式认的键**：工作区模式下，会话键只有在它代表"无 cwd 的隔离会话"时才有效
    // （此时 byKey 里有它）；被工作区收编的旧会话记录不能被当成租约。会话模式下 ws: 键不参与。
    //
    // 全局粒度下**所有**键都要扫（`true`）：那一档没有认领者，但 `traced` 与 `explicit` 仍然
    // 必须如实反映"侧车里被谁动过"。少了它们，对账器在 `adoptExternal` 那一轮会把租约期间
    // 跑着的资源采纳成"用户全局开过"（用户报障过的错判）。所以全局粒度
    // 只清"认领"（见下面的 activeIds），不清"痕迹"。
    const eligible = mode === 'global'
      ? true
      : (mode === 'workspace'
        ? (isWorkspaceScopeKey(scopeKey) || holders.length > 0)
        : !isWorkspaceScopeKey(scopeKey))
    if (!eligible) continue
    // 认领者 = 这个作用域键下的未归档会话。清单一条都没读到时（listKnown=false）按"宁可多留"
    // 处理：会话模式下仍认这个会话；工作区模式下没有会话 id 可数，就用作用域键本身占一个位
    // ——目标是让对账知道"这一格还有人在用"，不把计数当成精确的会话数。
    //
    // 全局粒度 = **没有认领者**：那一档"会话里开"就是"全局开"，不存在租约。这是全局粒度
    // 与另外两档唯一的实质差别，其余（痕迹 / 显式覆盖）照旧扫。
    const activeIds = mode === 'global'
      ? []
      : (holders.length > 0
        ? holders.filter((row) => claimsResource(row, listKnown)).map((row) => row.id)
        : (listKnown ? [] : [scopeKey]))
    // 显式覆盖（升级推断用）不做归档过滤：归档会话的旧覆盖仍是"这曾是会话级开启"的证据。
    // 工作区键没有真实会话时没有显式认领者（它不是一个可以升级推断的旧会话 id）。
    const explicitIds = holders.length > 0
      ? holders.map((row) => row.id)
      : (mode === 'workspace' ? [] : [scopeKey])
    const archive = input.archiveOf(scope)
    for (const domain of domains) {
      for (const key of ask[domain]) {
        if (effectiveLayerOf(scope, archive, domain, key) !== true) continue
        traced[domain].add(key)
        for (const id of activeIds) bump(claims[domain], key, id)
      }
    }
    // 逐工具 / 单条技能为开也认领它所在的整台服务器 / 来源（**显式** 那份也算一个认领者）。
    // 上层被显式关掉时这条推导**不生效**（与 `effectiveLayerOf` 的优先级同一份）：那种状态
    // 下界面把整组画成关、执行守卫也 deny，再认领只会让服务器白跑并挂一条假的「临时运行」。
    if (servers.size > 0) {
      for (const [toolKey, value] of Object.entries(scope.mcpTools ?? {})) {
        if (value !== true) continue
        const slash = toolKey.indexOf('/')
        if (slash <= 0) continue
        const server = toolKey.slice(0, slash)
        if (!servers.has(server)) continue
        if (effectiveLayerOf(scope, archive, 'mcp', server) === false) continue
        traced.mcp.add(server)
        for (const id of activeIds) bump(claims.mcp, server, id)
        for (const id of explicitIds) bump(explicit.mcp, server, id)
      }
    }
    if (roots.size > 0) {
      for (const [skillKey, value] of Object.entries(scope.skills ?? {})) {
        if (value !== true) continue
        const slash = skillKey.indexOf('/')
        if (slash <= 0) continue
        const root = skillKey.slice(0, slash)
        if (!roots.has(root)) continue
        if (effectiveLayerOf(scope, archive, 'skillSources', root) === false) continue
        traced.skillSources.add(root)
        for (const id of activeIds) bump(claims.skillSources, root, id)
        for (const id of explicitIds) bump(explicit.skillSources, root, id)
      }
    }
    // 显式覆盖（不做归档过滤）：升级首轮判"旧版本的会话级开启"用的那一条。
    for (const domain of domains) {
      const table = scope[domain]
      if (table === undefined) continue
      for (const [key, value] of Object.entries(table)) {
        if (value === true && ask[domain].has(key)) {
          for (const id of explicitIds) bump(explicit[domain], key, id)
        }
      }
    }
  }
  return { claims, explicit, traced }
}

/** 对账输入的一行（MCP 服务器或技能来源）。 */
export interface ReconcileRow {
  key: string
  intent: IntentState | undefined
  /** 补丁 / 来源状态里的实际启停。 */
  running: boolean
  /** 有效层为"开"的未归档会话数。 */
  claims: number
  /**
   * 其中**显式**拨过这一格的会话数（`scope.mcp[key]` / `scope.mcpTools[...]` / `scope.skillSources[...]`）。
   *
   * 只在"还没有意图记录"时用一次：旧版本在会话里打开全局关着的资源时会把补丁 / 来源直接
   * 拉起来，升级后如果照抄运行态，那次会话级开启就变成了全局开启（串味的原样）。显式覆盖是
   * 它曾经是"会话级"的证据 —— 见到它就记 `off`，让运行态落在租约里。
   */
  explicitClaims: number
  /**
   * 侧车里有没有**会话痕迹**：任一未过滤的会话（含归档 / 孤儿）在这一格上
   * 的有效层为 true。`undefined` = 调用方没给（`scope-set` 之后的普通对账不需要它）。
   *
   * 只对"采纳外部改动"那一条分支有意义：把运行态读成"用户全局开过"之前，先看这一格是不是
   * 某个会话留下的（见 planReconcile）。读不到侧车时装配层按 `true` 填（宁可少采纳，不误提升）。
   */
  traced?: boolean
}

/** 对账结果的一行：只列**要变**的部分。 */
export interface ReconcileDecision {
  key: string
  /** 要写回的意图（升级推断 / 外部改动采纳）。 */
  intentNext?: IntentState
  /** 要写的运行态（true = 开）。 */
  runningNext?: boolean
}

/** 意图对账的选项：是否只预览、是否回写。 */
export interface ReconcileOptions {
  /**
   * 采纳"外部对运行态的改动"（用户手改补丁 / 官方页面改了来源 / 全局场景引擎刚应用完）。
   *
   * 只在**没有租约**时采纳：有租约说明运行态本来就该与意图不同，那不是外部改动。
   * 启动对账与全局场景应用之后各跑一次；`scope-set` 之后的普通对账**不**采纳 ——
   * 否则用户刚写进去的意图会被自己上一次的运行态吞掉。
   */
  adoptExternal?: boolean
}

/**
 * 意图 / 运行态对账（纯函数）。运行态的目标恒为 `intent ∪ 租约`：
 *
 *   · `on`      → 运行；
 *   · `off`     → 有租约就运行，没有就停；
 *   · `blocked` → 永远停（租约也压不过）；
 *   · 没有记录  → 从运行态与显式覆盖反推一条，从此按意图走。
 */
export function planReconcile(rows: readonly ReconcileRow[], opts: ReconcileOptions = {}): ReconcileDecision[] {
  const out: ReconcileDecision[] = []
  for (const row of rows) {
    const { intent, running } = row
    let intentNext: IntentState | undefined
    let desired: boolean
    if (intent === 'blocked') {
      desired = false
    } else if (intent === 'on') {
      if (running) desired = true
      else if (row.claims === 0 && opts.adoptExternal === true) { intentNext = 'off'; desired = false }
      else desired = true
    } else if (intent === 'off') {
      // 外部把运行态打开了（手改补丁 / 官方页面 / 全局场景）：没有租约、**也没有会话痕迹**时以它为准。
      //
      // 痕迹闸门：会话里打开一台全局关着的资源会把运行态拉起来（那是在租约里）
      // 重启后认领可能整批落空 —— 会话已归档（归档不占资源）、已删除（孤儿条目还没清）、
      // 或启动时工作区表还没恢复全（清单半冷），任何一条都会让 claims 落成 0。此时若照抄运行态，
      // 那次**会话级**开启就被读成了"用户全局开过"，别的会话从此都看得见它（用户报障 A）。
      // 有痕迹 → 不采纳，运行态按 claims>0 落：归档 / 删除 → 停机，正确执行"归档不占资源"不变式；
      // 半冷清单期误停由 `scope-sessions-list` 排的那轮不采纳对账自愈（裁决 3）。
      if (running && row.claims === 0 && opts.adoptExternal === true && row.traced !== true) { intentNext = 'on'; desired = true }
      else desired = row.claims > 0
    } else if (running) {
      // 还没有意见：补丁开着。显式会话覆盖还在 = 那是旧版本的"会话级开启"留下的运行态，
      // 记成 off 让它落回租约；否则就是普通的全局开启。
      intentNext = row.explicitClaims > 0 ? 'off' : 'on'
      desired = true
    } else if (row.claims > 0) {
      intentNext = 'off'
      desired = true
    } else {
      intentNext = 'off'
      desired = false
    }
    if (intentNext === undefined && desired === running) continue
    out.push({
      key: row.key,
      ...(intentNext === undefined || intentNext === intent ? {} : { intentNext }),
      ...(desired === running ? {} : { runningNext: desired }),
    })
  }
  return out
}

/** 对账报告里的一条（started / stopped / failed 共用）。 */
export interface ReconcileChange {
  domain: IntentDomain
  key: string
  /** 失败时的人话原因。 */
  error?: string
}

/** 一次对账的产物：给人看的回执（写 op 拼进 warnings）。 */
export interface ScopeReconcileReport {
  /** 因为租约被拉起来（或保持运行）的。只在这次对账真的从"停"改成"开"时记录。 */
  started: ReconcileChange[]
  /** 因为最后一个租约消失而停下的。 */
  stopped: ReconcileChange[]
  /** 写补丁 / 来源状态失败的。 */
  failed: ReconcileChange[]
}
