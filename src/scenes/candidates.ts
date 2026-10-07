// 场景 / 表单的**候选源** —— 界面要"选一个"的地方，数据从哪来。
//
// 2026-09-19 从 index.ts 的 apply 闭包原样抽出（10 段，约 260 行）。为什么单独一个文件：
// 这些函数是**只读的取数**，彼此只有缓存关系，与"写补丁 / 改场景"完全无关；此前散在
// apply 闭包的四个角落（286 / 425 / 532 / 833 / 1924-2133），改一处要在 3000 行里找。
//
// 三组候选，各自的失效模式不同：
//   * **技能 / 记忆 / 场景**（skillRows / memoryCandidates / memorySceneCandidates）——
//     直接读各自 service 的 op，无缓存；
//   * **预设工具**（presetToolCandidates / presetToolNames）—— 每次枚举要为每个预设取一次
//     官方 `acquireScope` 租约 + 读一次 `tools.schemas()`，所以按 PRESET_ENUM_CACHE_MS 缓存；
//   * **模型**（modelCandidates）—— 只读宿主 LLM 目录，**不发网络请求**。
//
// 依赖全部经 deps 显式传入。注意 \`toolKeyParts\` 留在 index.ts：场景档案引擎也在用它，
// 放进本文件会让两个域互相引用。

import type { McpManager } from '../mcp/manager.js'
import type { ToolsService } from '../mcp/manager.js'
import { MCP_TOOL_PREFIX } from '../host-names.js'
import { serverNameCandidates, type McpToolNameParts } from '../host-names.js'
import { presetRosterOf } from '../compat/preset-reach.js'
import { injectionFactsOf, readCompositionFacts, readCompositionText } from '../compat/preset-reach.js'
import { decideToolFilter, type ToolFilterDecision } from '../subagents/service.js'

/** 本文件需要的外部能力。 */
export interface CandidateDeps {
  /** 宿主服务查找（presetRoster 要读 agent-presets 服务）。 */
  get(name: string): unknown
  /** 宿主 tools 服务（读 live schema）。 */
  tools: ToolsService
  /** MCP 管理域：读停用表与服务器列表。 */
  mcp: McpManager
  /** 技能服务（`skill-state` op）。 */
  skillsService: { ops: Record<string, (args: any) => Promise<any>> }
  /** 记忆服务（`rules-list` op）。 */
  memoriesService: { ops: Record<string, (args: any) => Promise<any>> }
  /** 工具全名 → `{ server, tool }`（切分规则见 `host-names.ts` 的 `splitMcpToolName`）。
   *  `serverNames` 是切分的候选 serverName 集合 —— **必填**，因为光看全名无法消解
   *  `serverName` 含 `__` 的歧义（审查 N1）。 */
  toolKeyParts(toolName: string, serverNames: Iterable<string>): McpToolNameParts | null
  /**
   * 本插件自己注册过的工具名（在 `index.ts` 的注册漏斗里逐个登记）。
   *
   * 这是「插件工具」这一组**唯一**可靠的判据：官方没有工具级归属接口（见
   * `presetToolView` 的注释），但本插件注册了什么自己当然知道。用 getter 而不是快照，
   * 因为登记发生在 apply 过程中，而本工厂构造在更早处。
   */
  selfToolNames(): ReadonlySet<string>
}

/**
 * 一个工具在「工具限制」选择器里的归属组。
 *
 * `plugin` = 本插件；`official` = **该预设自带的**（出厂四预设即官方工具包）；
 * `other` = 剩下的（宿主平面上的其余插件，以及认不出来的）。
 */
export type ToolOrigin = 'plugin' | 'official' | 'other'

/** 一个预设自己的工具视图：名字清单 + 每个名字的归属。 */
export interface PresetToolView {
  /** 该预设可见的工具名（= 宿主平面 ∪ 该预设自己挂的包）。 */
  names: string[]
  /** 名字 → 归属。**`names` 里每个名字都有一项**（认不出就是 `other`，绝不丢）。 */
  origins: Record<string, ToolOrigin>
}

/**
 * 「工具限制」的候选载荷：一行一个 Agent 预设（roster 顺序），各带自己的工具清单与归属组。
 *
 * 0.19.0 前这里还有一份 `tools`（全体并集 + `presets` / `current`）—— 整条链上零读取点，
 * 且是同一份数据的第二个真相，已删。
 */
export interface PresetToolCandidates {
  presets: Array<{
    id: string
    name: string
    trust: string
    broken: boolean
    /** 该预设自己的工具名（旧字段名，语义从 0.19.0 起才真的是"该预设自己的"）。 */
    tools: string[]
    /** 名字 → 归属组；与 `tools` 一一对应。缺项按 `other` 处理。 */
    toolGroups: Record<string, ToolOrigin>
  }>
}

/** 本文件对外暴露的出口（9 项）。 */
export interface Candidates {
  /** 宿主 Agent 预设名单（读不到 → undefined）。 */
  presetRoster(): ReturnType<typeof presetRosterOf>
  /** 某个 agent 跑在哪个预设上、该预设压不压得住注入。 */
  presetFactsForAgent(agent: unknown): Promise<ReturnType<typeof injectionFactsOf> | undefined>
  /** 工具全名 → 是否启用（按停用表）。 */
  toolStates(): Promise<Record<string, boolean>>
  /** 场景档案「技能集」的行。 */
  skillRows(): Promise<unknown>
  /** 一行一个 Agent 预设（roster 顺序），各带自己的工具清单与归属组。 */
  presetToolCandidates(): Promise<PresetToolCandidates>
  /** 单个预设的工具名（`subagent_manager_run` 的名单校验用；只取名字，不带归属）。 */
  presetToolNames(id: string): Promise<string[]>
  /** 预设名单（名字投影）。 */
  presetNames(): Promise<Array<{ id: string; name: string; trust: string }>>
  /** 人设表单的模型候选：模型对 + 来源清单（只读宿主 LLM 目录，不发网络请求）。 */
  modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }>; providers: Array<{ id: string; name: string }> }>
  /**
   * 某个 (provider, model) 支持的思考强度档位（人设表单的「思考强度」下拉）。
   *
   * 与 `modelCandidates` **代价差一个数量级**：那个读本地目录、不发请求；这个要问 adapter，
   * 官方注释写明是 `adapter-owned asynchronous lookup`（可能联网），所以它是**单独的 op**、
   * 按需拉取，不捆进 model-candidates。
   *
   * 失败原样上报，**不回落**到"猜几个常见档位"：官方对不支持的显式 effort 是在 provider I/O
   * **之前**直接拒（不夹紧、不别名），猜错一次就是子代理起不来。
   */
  modelReasoning(provider: string, model: string): Promise<ModelReasoningResult>
  /** 档案编辑器第 4 段的记忆候选。 */
  memoryCandidates(): Promise<Array<{ id: string; scene: string; name: string; description: string }>>
  /** 档案编辑器第 4 段的分组维度（场景 + 记忆条数）。 */
  memorySceneCandidates(): Promise<Array<{ name: string; label: string; description: string; count: number; global: boolean }>>
}

/**
 * `modelReasoning` 的结果。`ok:false` 时 `error` 是给人看的原因（adapter 拉不到就是拉不到）。
 * `efforts` 为空 = 这个模型没有暴露可选档位（不是失败）。
 */
export interface ModelReasoningResult {
  ok: boolean
  efforts?: Array<{ id: string; name: string; description?: string }>
  /** adapter 配置的默认档位；缺省（null）= 由 provider 自己的默认决定。 */
  defaultEffort?: string | null
  error?: string
}

/**
 * 问 adapter 的等待上限。官方签名 `resolveModelInfo(provider, model, signal?)` 的 signal 是
 * "optional cancellation for adapter-owned asynchronous lookup"，所以给一个上限 —— 界面那一格
 * 是懒加载 + loading 态，挂住不返回会让它一直转。
 *
 * ⚠️ 10s 是**防御性**取值，没有实测依据：本机拿不到活着的 adapter，量不出真实耗时。
 * 真机上若发现常见 provider 只要几十毫秒，可以调小；若某个 provider 稳定超过它，就该调大。
 */
const MODEL_REASONING_TIMEOUT_MS = 10_000

export function createCandidates(deps: CandidateDeps): Candidates {
  // 外部能力一次解构成局部名：块内代码逐字搬来，保持原样最不容易出错。
  const { get, tools, mcp, skillsService, memoriesService, toolKeyParts, selfToolNames } = deps
  const ctx = { get }

  // Agent 预设名单（@deepseek-ai/dsh-agent-presets）：同样是可选服务，按需取用。
  // 读它只为了回答"当前预设下本插件注入的东西到不到得了模型"——只读，不挂载任何预设。
  const presetRoster = () => presetRosterOf(ctx as unknown as { get?: (name: string) => unknown })

  async function toolStates(): Promise<Record<string, boolean>> {
    const disabled = await mcp.readDisabledTools()
    const states: Record<string, boolean> = {}
    let schemas: any[] = []
    try { schemas = await tools.schemas() } catch { /* 无 live 工具 → 仅启停表 */ }
    // 切分的候选 serverName 集合必须与 `serverKnownTools`（index.ts）同源 —— 同一批来源、
    // 同一个 builder，否则「服务器名含 `__`」时两处会把同一个全名切成不同的 (server, tool)
    // （2026-09-30 审查 N1）。三个来源里补丁那份是唯一与切分结果无关的（另两份是插件自己
    // 写出来的：停用表键来自界面勾选、缓存键来自上一次切分），缺它会在首次遇到含 `__` 的名字时
    // 切错并锁死。任一份读不到就退化为其余两份（少候选 = 少命中，不会多命中）。
    let known: Record<string, unknown> = {}
    try { known = await mcp.readKnownMcpTools() } catch { /* 缓存不可读 → 仅停用表 */ }
    let configured: string[] = []
    try { configured = await mcp.configuredServerNames() } catch { /* 补丁读不到 → 仅另两份 */ }
    const serverNames = serverNameCandidates(configured, disabled, known)
    const liveByServer: Record<string, string[]> = {}
    for (const s of schemas) {
      const p = toolKeyParts(String((s && s.name) || ''), serverNames)
      if (!p) continue
      const list = liveByServer[p.server] || (liveByServer[p.server] = [])
      if (list.indexOf(p.tool) < 0) list.push(p.tool)
    }
    for (const [server, list] of Object.entries(disabled)) {
      // 整台停用（['*']）：在 live 工具上展开成具体键，不产出 `server/*` 伪键（那会污染勾选器）。
      if (list.indexOf('*') >= 0) {
        for (const t of (liveByServer[server] || [])) states[server + '/' + t] = false
        continue
      }
      for (const t of list) states[server + '/' + t] = false
    }
    for (const [server, list] of Object.entries(liveByServer)) {
      for (const t of list) if (!(server + '/' + t in states)) states[server + '/' + t] = true
    }
    return states
  }

  /** 场景档案「技能集」用的一行。 */
  interface SceneSkillRow {
    key: string
    name: string
    enabled: boolean
    shadowed: boolean
    /**
     * 结构是否完整（缺 frontmatter / 名字非法 / 描述为空 → false）。
     * false 的技能 core 一律拒绝启停，勾了也不生效，界面据此禁掉勾选。
     */
    loadable: boolean
    rootKey: string
    rootLabel: string
    rootLocaleKey?: string
    rootKind?: string
  }

  /**
   * 场景档案「技能集」的技能行 —— 技能名与来源名**分开**给出。
   *
   * 界面早先直接渲染 `key`（形如 `<来源 key>/<技能名>`），而自定义目录的来源 key 是
   * `custom-<sha256-16>`，于是导入的技能在场景档案里显示成一串哈希（用户 2026-09-15 报的）。
   * 这里把来源的 label / localeKey 一并带上，界面就能显示「技能名 · 来源名」。
   *
   * 含被覆盖的副本（`shadowed`）：场景允许勾选任意一条技能，用生效集校验会把合法勾选判成 stale。
   */
  async function skillRows(): Promise<SceneSkillRow[]> {
    const rows: SceneSkillRow[] = []
    try {
      const r: any = await skillsService.ops['skill-state']({})
      for (const root of ((r && r.data && r.data.roots) || [])) {
        const rootKey = String((root && root.key) || '')
        if (!rootKey) continue
        for (const sk of ((root && root.skills) || [])) {
          const name = String((sk && (sk.declaredName || sk.name)) || '')
          if (!name) continue
          rows.push({
            key: rootKey + '/' + name,
            name,
            enabled: sk.enabled === true && !sk.shadowedBy,
            shadowed: !!sk.shadowedBy,
            loadable: sk.loadable !== false,
            rootKey,
            rootLabel: String((root && root.label) || rootKey),
            ...(root && root.localeKey ? { rootLocaleKey: String(root.localeKey) } : {}),
            ...(root && root.kind ? { rootKind: String(root.kind) } : {}),
          })
        }
      }
    } catch { /* 技能状态读不到 → 空列表（界面如实显示"没有可选项"） */ }
    // 平铺列表按技能名排（同名再按来源），比按来源聚在一起更好找。
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.rootKey.localeCompare(b.rootKey))
  }

  // 注入判定要的两条预设事实（压制型？挂得到 AGENTS.md 通道？）。读取走 TTL 缓存：
  // 组合文件可以随时被编辑（patchReload: live），但每个 step 读一次盘没有必要。
  const PRESET_FACTS_TTL_MS = 15_000
  const presetFactsCache = new Map<string, { at: number; value: ReturnType<typeof injectionFactsOf> }>()
  async function presetFactsForAgent(agent: unknown): Promise<ReturnType<typeof injectionFactsOf>> {
    const roster = presetRoster()
    if (!roster || typeof roster.composedPreset !== 'function') return undefined
    if (typeof roster.read !== 'function' && typeof roster.readDocument !== 'function') return undefined
    let presetId = ''
    try {
      presetId = String(roster.composedPreset((agent as { ctx?: unknown } | null | undefined)?.ctx) ?? '')
    } catch { return undefined }
    if (presetId === '') return undefined
    const hit = presetFactsCache.get(presetId)
    if (hit && Date.now() - hit.at < PRESET_FACTS_TTL_MS) return hit.value
    try {
      const text = await readCompositionText(roster, presetId)
      const value = injectionFactsOf(readCompositionFacts(text))
      presetFactsCache.set(presetId, { at: Date.now(), value })
      return value
    } catch { return undefined }
  }

  /**
   * 记忆候选（档案编辑器第 4 段「记忆」）：`[{ id, scene, name, description }]`。
   * 只读、不读正文（勾选集只存 id）；任何异常降级为空列表，不让档案弹窗崩掉。
   */
  async function memoryCandidates(): Promise<Array<{ id: string; scene: string; name: string; description: string }>> {
    try {
      const r: any = await memoriesService.ops['rules-list']({})
      if (!r || r.ok === false) return []
      return (r.rules || [])
        .filter((x: any) => !x.shadowed)
        .map((x: any) => ({
          id: String(x.id),
          scene: String(x.group || ''),
          name: String(x.name || ''),
          description: String(x.description || ''),
        }))
    } catch {
      return []
    }
  }

  /** 场景候选（档案编辑器第 4 段的分组维度）：`[{ name, label, description, count, global }]`。 */
  async function memorySceneCandidates(): Promise<Array<{ name: string; label: string; description: string; count: number; global: boolean }>> {
    try {
      const r: any = await memoriesService.ops['rules-list']({})
      if (!r || r.ok === false) return []
      return (r.scenes || []).map((s: any) => ({
        name: String(s.name),
        label: String(s.label || s.name),
        description: String(s.description || ''),
        count: Number(s.count || 0),
        global: s.global === true,
      }))
    } catch {
      return []
    }
  }

  /**
   * 工具候选（人设的「工具白名单 / 黑名单」选择器）：一行一个 Agent 预设，各带**它自己的**
   * 工具清单与归属组。
   *
   * 为什么按预设切而不是给一份并集：人设可能在任意预设下被子代理复用，而界面一行只对那个
   * 预设生效，所以勾出来的名字必须属于那一行。见 `presetToolView`（判据与 0.19.0 修掉的
   * 那条断链）。
   *
   * 0.19.0 删掉了原来那份「全体并集」（`tools`，含 `presets` / `current` 两个字段）：整条链
   * 上零读取点（客户端只读 `presets`），而它是同一份数据的第二个真相 —— 从 `presets[].tools`
   * 直接推得出来，每次调用白背 ≈2KB 载荷。
   */
  // 两个预设枚举缓存（全体候选 / 单个预设）共用这个 TTL：枚举要一次 acquireScope 租约 +
  // 一次 schemas()，与内容变化无关，所以只要别刷得太勤就行。
  const PRESET_ENUM_CACHE_MS = 60_000
  let presetToolsCache: { at: number; value: PresetToolCandidates } | null = null
  async function presetToolCandidates(): Promise<PresetToolCandidates> {
    if (presetToolsCache && Date.now() - presetToolsCache.at < PRESET_ENUM_CACHE_MS) return presetToolsCache.value
    const presets: PresetToolCandidates['presets'] = []
    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    if (agentPresets && typeof agentPresets.list === 'function') {
      try {
        // roster 顺序 = 官方的展示顺序（preset.yml 的 order：标准 1 / PTC 2 / 极简 3 / 创造 4，
        // 自建预设排在其后）。人设编辑器的四行照抄这个顺序，**不要**再按 id 排序。
        const roster = await agentPresets.list()
        for (const p of roster || []) {
          const id = String((p && p.id) || '')
          if (!id) continue
          const view = await presetToolView(id)
          // MCP 工具名形如 `mcp__<server>__<tool>`：面向上百个条目，噪声大于价值 → 不进候选。
          // 子代理照样能用当前在跑的 MCP —— 那份名单在 decideToolFilter 里运行时并进白名单。
          const names = view.names.filter((name) => !name.startsWith(MCP_TOOL_PREFIX))
          presets.push({
            id,
            name: String((p && (p.name || p.id)) || id),
            // 官方 registry 的预设**没有** trust 字段 —— 缺省必须是 ''（未知）而不是 'user'：
            // 客户端只对显式 user 隐藏内置模式的词典名，缺省 'user' 会让四个内置模式永远
            // 显示原始 id（2026-09-28 用户截图）。
            trust: String((p && p.trust) || ''),
            broken: typeof (p && p.broken) === 'string',
            tools: names,
            // 与 tools 同序裁剪：被 MCP 前缀筛掉的名字不留在归属表里（这张表只描述列出来的那些）。
            toolGroups: names.reduce<Record<string, ToolOrigin>>((acc, name) => {
              acc[name] = view.origins[name] ?? 'other'
              return acc
            }, {}),
          })
        }
      } catch { /* 预设服务不可用 → 一行都不给（界面显示读不到，不假装空） */ }
    }
    const value: PresetToolCandidates = { presets }
    presetToolsCache = { at: Date.now(), value }
    return value
  }

  /** 官方包的作用域前缀。只用来判「这个预设的行是不是全部来自官方」，不做任何工具名匹配。 */
  const OFFICIAL_PACKAGE_PREFIX = '@deepseek-ai/'

  /**
   * 一个预设自己的工具视图 + 三组归属。
   *
   * 归属只能做到「层」粒度，这是**官方的限制而不是设计选择**：`ToolSchema` 只有
   * `{ name, description, parameters, deferLoading? }`，没有归属字段；`ToolRuntime` 的公开面
   * （`register` / `restrict` / `guard` / `get` / `schemas` / `presentAs`）里也没有「这个工具是谁
   * 注册的」（`view` 是 private）；`tools/change` 是**无载荷** emit，只报"变了"；宿主侧的
   * `dsh-host-plugin-inventory` 自述 "No layer attribution"，且 Remote-only、进程内 `ctx.get`
   * 拿不到。所以判据全部是集合运算，不出现任何工具名或包名的字面量：
   *
   *   G = tools.schemas()                       宿主平面（global 层）
   *   P = tools.schemas(acquireScope(id).key)   该预设视图 = G ∪ 该预设自己挂的包
   *   Δ = P − G                                 该预设自带的工具
   *   O = 本插件注册漏斗登记的名字               插件工具 = O ∩ P
   *
   * 「官方」在这里是**该预设自带的**，不是「DeepSeek 出的」：宿主平面上的官方工具（如
   * `load_workspace_dependencies`）会落在「其他」。这是刻意的 —— 宁可说「不知道」，不假装是
   * 官方；要认出来只能靠一份名字对照表，那会同时丢掉「零硬编码」与「随官方更新而更新」。
   * 预设里混挂了第三方行时 Δ 无法再拆（包粒度已知、工具粒度未知），此时整份落「其他」。
   */
  const presetViewCache = new Map<string, { at: number; view: PresetToolView }>()
  async function presetToolView(id: string): Promise<PresetToolView> {
    const hit = presetViewCache.get(id)
    if (hit && Date.now() - hit.at < PRESET_ENUM_CACHE_MS) return hit.view

    // 宿主平面：一次读、所有预设共用。读不到 → 空集，于是 Δ = P，全部落「其他」而不是误判成官方。
    const hostNames = new Set<string>()
    try {
      for (const s of (await tools.schemas()) || []) {
        const name = String((s as any)?.name || '')
        if (name) hostNames.add(name)
      }
    } catch { /* 读不到宿主平面 → Δ 退化成 P，全部落「其他」 */ }

    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    // 官方预设服务的公开面里，取"某个预设的 standing scope key"的只有 `acquireScope(id)`：
    // 返回 `{ key: ScopeKey } & AsyncDisposable`，契约是**读完就 dispose**（内部 `retain()` 会
    // `generation.users++`，不还这份 generation 永远回收不掉）。它**不挂载**预设：`retain` 对
    // 未激活/损坏的预设直接抛 `RemoteError` —— 于是"读不到"与"没有工具"被分开了，后者不会
    // 再冒充前者。此前的 `standingKeyFor` 在官方包里根本不存在（`@deepseek-ai` 全树 0 命中），
    // 那条 `typeof` 守卫恒为假，等于一直在读全局视图。
    const canScope = !!(agentPresets && typeof agentPresets.acquireScope === 'function')
    let names: string[] = []
    if (canScope) {
      let lease: any
      try {
        lease = await agentPresets.acquireScope(id)
        names = ((await tools.schemas(lease && lease.key)) || [])
          .map((s: any) => String(s?.name || ''))
          .filter(Boolean)
      } catch { names = [] } finally {
        // 还租约。dispose 自己幂等且吞异常，这里再包一层只为不让"还租约"失败盖掉真正的读失败。
        try { if (lease && typeof lease[Symbol.asyncDispose] === 'function') await lease[Symbol.asyncDispose]() } catch { /* 已经还过 */ }
      }
    } else {
      // 老宿主没有 `acquireScope`：退回宿主平面（= 0.19.0 之前的可见行为），并且**什么都不认成
      // 官方**。这比列一份空的强（用户至少还看得见、还能勾），也比拿全局清单冒充"该预设自己的"诚实。
      names = [...hostNames]
    }

    // 本插件自报的名字。读不到 → 空集，于是本插件的工具落「其他」而不是凭空消失。
    const self = new Set<string>()
    try { for (const name of selfToolNames()) self.add(String(name)) } catch { /* 读不到自报名单 */ }

    const shipped = canScope ? await presetIsShipped(id) : false
    const origins: Record<string, ToolOrigin> = {}
    for (const name of names) {
      if (self.has(name)) origins[name] = 'plugin'
      // 只有该预设的行**全部**来自官方包时才敢把差集叫「官方」；混挂第三方行时整份落「其他」。
      else if (shipped && !hostNames.has(name)) origins[name] = 'official'
      else origins[name] = 'other'
    }

    const view: PresetToolView = { names, origins }
    presetViewCache.set(id, { at: Date.now(), view })
    return view
  }

  /**
   * 该预设的行是不是**全部**来自 `@deepseek-ai/`（出厂四预设都是）。
   *
   * 读 `compositionInventory()`（官方公开方法，"Read plugin rows without creating an Agent"）。
   * 它是**包**粒度、不是工具粒度 —— 这正是本节开头那段限制的具体形状：拿得到"这个预设挂了
   * 哪些包"，拿不到"哪个包贡献了哪个工具"。所以只能整份判，判不了就整份落「其他」。
   *
   * 任何一步失败都返回 `false`（= 不认成官方），不抛。
   */
  const presetShippedCache = new Map<string, { at: number; shipped: boolean }>()
  async function presetIsShipped(id: string): Promise<boolean> {
    const hit = presetShippedCache.get(id)
    if (hit && Date.now() - hit.at < PRESET_ENUM_CACHE_MS) return hit.shipped
    let shipped = false
    try {
      const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
      if (agentPresets && typeof agentPresets.compositionInventory === 'function') {
        const list = await agentPresets.compositionInventory()
        const row = (list || []).filter((p: any) => p && String(p.id) === id)[0]
        const rows = row && Array.isArray(row.rows) ? row.rows : []
        shipped = rows.length > 0 && rows.every((r: any) => String((r && r.moduleName) || '').startsWith(OFFICIAL_PACKAGE_PREFIX))
      }
    } catch { shipped = false }
    presetShippedCache.set(id, { at: Date.now(), shipped })
    return shipped
  }

  /**
   * 单个预设的工具名（含 MCP 与宿主平面的工具，因为子代理的可见集合是
   * "宿主平面 ∪ 该预设"的并集）。`subagent_manager_run` 每次委派都要用它校验名单，所以
   * 按 id 缓存 PRESET_ENUM_CACHE_MS。只取名字 —— 归属那份走 `presetToolView`。
   */
  async function presetToolNames(id: string): Promise<string[]> {
    return (await presetToolView(id)).names
  }

  /** 预设名单的名字投影（只读 roster，不挂载任何预设）：场景页显示模式名用。 */
  async function presetNames(): Promise<Array<{ id: string; name: string; trust: string }>> {
    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    if (!agentPresets || typeof agentPresets.list !== 'function') return []
    try {
      const roster = await agentPresets.list()
      return (roster || [])
        .map((p: any) => ({ id: String((p && p.id) || ''), name: String((p && (p.name || p.id)) || ''), trust: String((p && p.trust) || '') }))
        .filter((p: { id: string }) => p.id !== '')
    } catch { return [] }
  }

  /**
   * 模型候选（人设的「模型」与「模型来源」两个下拉）：宿主已注册的 provider + 各 provider
   * 能宣告的模型。只读宿主 LLM 目录，**不发起网络请求**（`discoverModels` 会打端点，这里不用）；
   * 拿不到就返回空列表，UI 退回手填（跨来源模型如 sensenova 的手工条目仍需手填兜底）。
   *
   * 两份投影、用途不同：
   *   · `models` 是扁平列表 —— DSH 的模型路由是 (provider, model) 一对，两个键必须同时给；
   *   · `providers` 是去重后的来源清单 —— 「模型来源」下拉要用它。
   *
   * `providers` 不能由 `models` 去重反推：适配器不提供 `listModels` 时该 provider 一个模型
   * 都报不出来（官方 LlmAdapter 里它是可选项），而"来源有、目录里没模型"恰恰是最需要手填
   * 模型 id 的场景 —— 由 models 反推会让这类 provider 在来源下拉里整个消失。
   */
  async function modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }>; providers: Array<{ id: string; name: string }> }> {
    const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as any
    if (!llm || typeof llm.listProviders !== 'function') return { models: [], providers: [] }
    let list: any[] = []
    try {
      list = llm.listProviders() || []
    } catch {
      return { models: [], providers: [] }
    }
    const models: Array<{ provider: string; providerName: string; id: string; name: string }> = []
    const providers: Array<{ id: string; name: string }> = []
    const seen = new Set<string>()
    const seenProvider = new Set<string>()
    for (const p of list) {
      const provider = String((p && (p.id || p.provider)) || '')
      if (!provider) continue
      const providerName = String((p && (p.name || p.displayName)) || provider)
      if (!seenProvider.has(provider)) {
        seenProvider.add(provider)
        providers.push({ id: provider, name: providerName })
      }
      let discovered: any[] = []
      try {
        // 适配器可选提供 listModels（官方 LlmAdapter 契约）；未提供时该 provider 只有来源那一项。
        if (typeof llm.listModels === 'function') discovered = (await llm.listModels(provider)) || []
      } catch { /* 该 provider 的目录读失败 → 只报 provider 本身 */ }
      for (const m of discovered) {
        const id = String((m && (m.id || m.model)) || '')
        if (!id) continue
        const key = provider + '\u0000' + id
        if (seen.has(key)) continue
        seen.add(key)
        models.push({ provider, providerName, id, name: String((m && m.name) || id) })
      }
    }
    return { models, providers }
  }

  /**
   * 某个 (provider, model) 的思考强度档位。见 `Candidates.modelReasoning` 的注释。
   *
   * `llm` 与 `modelCandidates` 同一路径取（**不在 inject 声明里**，所以必须 `ctx.get('llm')`
   * 而不是 `ctx.llm` —— 后者在未声明该服务时 cordis 代理会抛
   * "cannot get property without inject"）。
   */
  async function modelReasoning(provider: string, model: string): Promise<ModelReasoningResult> {
    const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as any
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      return { ok: false, error: '宿主没有提供 llm.resolveModelInfo（拿不到档位清单）' }
    }
    const ac = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), MODEL_REASONING_TIMEOUT_MS) : null
    try {
      const info: any = await llm.resolveModelInfo(provider, model, ac ? ac.signal : undefined)
      const reasoning = info && info.reasoning
      const raw: any[] = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const efforts: Array<{ id: string; name: string; description?: string }> = []
      for (const e of raw) {
        const id = String((e && e.id) || '')
        if (!id) continue
        // 官方结构：`{ id, name, description? }`（`dsh-llm/lib/types/types.d.ts:295-302`）。
        // name 是给人看的档位名，id 才是要传回去的值 —— 两者都要留着，界面按 name 显示、按 id 提交。
        efforts.push({
          id,
          name: String((e && e.name) || id),
          ...(e && typeof e.description === 'string' && e.description ? { description: e.description } : {}),
        })
      }
      return {
        ok: true,
        efforts,
        // 缺省（null）= 由 provider 自己的默认决定（官方注释：Absence preserves the provider's own default）。
        defaultEffort: reasoning && reasoning.defaultEffort ? String(reasoning.defaultEffort) : null,
      }
    } catch (e) {
      return { ok: false, error: (e && (e as any).message) ? String((e as any).message) : String(e) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    presetRoster,
    presetFactsForAgent,
    toolStates,
    skillRows,
    presetToolCandidates,
    presetToolNames,
    presetNames,
    modelCandidates,
    modelReasoning,
    memoryCandidates,
    memorySceneCandidates,
  }
}
