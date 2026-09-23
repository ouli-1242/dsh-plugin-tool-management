// 场景 / 表单的**候选源** —— 界面要"选一个"的地方，数据从哪来。
//
// 2026-09-19 从 index.ts 的 apply 闭包原样抽出（10 段，约 260 行）。为什么单独一个文件：
// 这些函数是**只读的取数**，彼此只有缓存关系，与"写补丁 / 改场景"完全无关；此前散在
// apply 闭包的四个角落（286 / 425 / 532 / 833 / 1924-2133），改一处要在 3000 行里找。
//
// 三组候选，各自的失效模式不同：
//   * **技能 / 记忆 / 场景**（skillRows / memoryCandidates / memorySceneCandidates）——
//     直接读各自 service 的 op，无缓存；
//   * **预设工具**（presetToolCandidates / presetToolNames）—— 枚举会为预设建立 standing
//     mount（官方语义：每进程一次），所以按 PRESET_ENUM_CACHE_MS 缓存，不能每次重枚举；
//   * **模型**（modelCandidates）—— 只读宿主 LLM 目录，**不发网络请求**。
//
// 依赖全部经 deps 显式传入。注意 \`toolKeyParts\` 留在 index.ts：场景档案引擎也在用它，
// 放进本文件会让两个域互相引用。

import type { McpManager } from '../mcp/manager.js'
import type { ToolsService } from '../mcp/manager.js'
import { presetRosterOf } from '../compat/preset-reach.js'
import { injectionFactsOf, readCompositionFacts } from '../compat/preset-reach.js'
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
  /** 工具全名 → { server, tool }；场景档案引擎也用，故留在 index.ts。 */
  toolKeyParts(toolName: string): { key: string; server: string; tool: string } | null
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
  /** 全体 Agent 预设工具名的并集 + 各工具所属预设 + 当前会话是否可见。 */
  presetToolCandidates(): Promise<{ tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string }> }>
  /** 单个预设的工具名。 */
  presetToolNames(id: string): Promise<string[]>
  /** 预设名单（名字投影）。 */
  presetNames(): Promise<Array<{ id: string; name: string; trust: string }>>
  /** 人设表单的模型候选（只读宿主 LLM 目录，不发网络请求）。 */
  modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }> }>
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
  const { get, tools, mcp, skillsService, memoriesService, toolKeyParts } = deps
  const ctx = { get }

  // Agent 预设名单（@deepseek-ai/dsh-agent-presets）：同样是可选服务，按需取用。
  // 读它只为了回答"当前预设下本插件注入的东西到不到得了模型"——只读，不挂载任何预设。
  const presetRoster = () => presetRosterOf(ctx as unknown as { get?: (name: string) => unknown })

  async function toolStates(): Promise<Record<string, boolean>> {
    const disabled = await mcp.readDisabledTools()
    const states: Record<string, boolean> = {}
    let schemas: any[] = []
    try { schemas = await tools.schemas() } catch { /* 无 live 工具 → 仅启停表 */ }
    const liveByServer: Record<string, string[]> = {}
    for (const s of schemas) {
      const p = toolKeyParts(String((s && s.name) || ''))
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
    if (!roster || typeof roster.composedPreset !== 'function' || typeof roster.read !== 'function') return undefined
    let presetId = ''
    try {
      presetId = String(roster.composedPreset((agent as { ctx?: unknown } | null | undefined)?.ctx) ?? '')
    } catch { return undefined }
    if (presetId === '') return undefined
    const hit = presetFactsCache.get(presetId)
    if (hit && Date.now() - hit.at < PRESET_FACTS_TTL_MS) return hit.value
    try {
      const text = String((await roster.read(presetId)) ?? '')
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
   * 工具候选（人设的「工具白名单 / 黑名单」选择器）：
   * 取**全体 Agent 预设工具名的并集**——人设可能在任意预设下被子代理复用，
   * 只列当前会话的工具会让换预设后的子代理启动失败（官方 `toolFilter` 对未知名直接拒绝）。
   * 同时标注 `current`：当前会话可见的工具（其余只是「本预设可用，当前会话看不到」）。
   *
   * 每次调用都会为尚未挂载的预设建立 standing mount（官方语义：一个预设在本进程内只挂一次，
   * 正常创建会话时同样会挂），因此结果会按需缓存 PRESET_ENUM_CACHE_MS，避免频繁枚举。
   */
  // 两个预设枚举缓存（全体候选 / 单个预设）共用这个 TTL：枚举的代价是"给预设建立
  // standing mount"，与内容变化无关，所以只要别刷得太勤就行。
  const PRESET_ENUM_CACHE_MS = 60_000
  let presetToolsCache: { at: number; value: { tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string; trust: string; broken: boolean; tools: string[] }> } } | null = null
  async function presetToolCandidates(): Promise<{ tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string }> }> {
    if (presetToolsCache && Date.now() - presetToolsCache.at < PRESET_ENUM_CACHE_MS) return presetToolsCache.value
    const byName = new Map<string, { name: string; presets: Set<string>; current: boolean }>()
    const presets: Array<{ id: string; name: string; trust: string; broken: boolean; tools: string[] }> = []
    // 当前会话的可见工具（用于标 current）；拿不到就全部按「非当前」处理。
    const currentNames = new Set<string>()
    try {
      const schemas = await tools.schemas()
      for (const s of schemas || []) currentNames.add(String((s as any).name))
    } catch { /* 无 live 工具 → current 全 false */ }

    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    if (agentPresets && typeof agentPresets.list === 'function') {
      try {
        // roster 顺序 = 官方的展示顺序（preset.yml 的 order：标准 1 / PTC 2 / 极简 3 / 创造 4，
        // 自建预设排在其后）。人设编辑器的四行照抄这个顺序，**不要**再按 id 排序。
        const roster = await agentPresets.list()
        for (const p of roster || []) {
          const id = String((p && p.id) || '')
          if (!id) continue
          // MCP 工具名形如 `mcp__<server>__<tool>`：面向上百个条目，噪声大于价值 → 不进候选。
          // 子代理照样能用当前在跑的 MCP —— 那份名单在 decideToolFilter 里运行时并进白名单。
          const names = (await presetToolNames(id)).filter((name) => !name.startsWith('mcp__'))
          presets.push({
            id,
            name: String((p && (p.name || p.id)) || id),
            trust: String((p && p.trust) || 'user'),
            broken: typeof (p && p.broken) === 'string',
            tools: names,
          })
          for (const name of names) {
            const rec = byName.get(name) || { name, presets: new Set<string>(), current: false }
            rec.presets.add(id)
            byName.set(name, rec)
          }
        }
      } catch { /* 预设服务不可用 → 退回「仅当前会话工具」 */ }
    }
    // 当前会话的工具即便没有任何预设可枚举，也要出现在候选里（否则选择器是空的）。
    for (const name of currentNames) {
      if (name.startsWith('mcp__')) continue
      const rec = byName.get(name) || { name, presets: new Set<string>(), current: false }
      byName.set(name, rec)
    }
    for (const rec of byName.values()) rec.current = currentNames.has(rec.name)

    const value = {
      tools: [...byName.values()]
        .map((r) => ({ name: r.name, presets: [...r.presets].sort(), current: r.current }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // 保持 roster 顺序（官方的展示顺序），前端四行直接照用。
      presets,
    }
    presetToolsCache = { at: Date.now(), value }
    return value
  }

  /**
   * 单个预设的工具名（列表里含 MCP 与宿主平面的工具，因为子代理的可见集合是
   * "宿主平面 ∪ 该预设"的并集）。枚举会为该预设建立 standing mount —— 官方语义：
   * 一个预设每进程只挂一次，正常创建会话时同样会挂，所以这里按 id 缓存 PRESET_ENUM_CACHE_MS；
   * `subagent_manager_run` 每次委派都要用它校验名单，不能每次都重新枚举。
   */
  const presetNamesCache = new Map<string, { at: number; names: string[] }>()
  async function presetToolNames(id: string): Promise<string[]> {
    const hit = presetNamesCache.get(id)
    if (hit && Date.now() - hit.at < PRESET_ENUM_CACHE_MS) return hit.names
    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    let scopeKey: unknown
    try {
      scopeKey = agentPresets && typeof agentPresets.standingKeyFor === 'function'
        ? await agentPresets.standingKeyFor(id)
        : undefined
    } catch { scopeKey = undefined }
    let names: string[] = []
    try {
      names = ((await tools.schemas(scopeKey as any)) || []).map((s: any) => String(s.name)).filter(Boolean)
    } catch { names = [] }
    presetNamesCache.set(id, { at: Date.now(), names })
    return names
  }

  /** 预设名单的名字投影（只读 roster，不挂载任何预设）：场景页显示模式名用。 */
  async function presetNames(): Promise<Array<{ id: string; name: string; trust: string }>> {
    const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
    if (!agentPresets || typeof agentPresets.list !== 'function') return []
    try {
      const roster = await agentPresets.list()
      return (roster || [])
        .map((p: any) => ({ id: String((p && p.id) || ''), name: String((p && (p.name || p.id)) || ''), trust: String((p && p.trust) || 'user') }))
        .filter((p: { id: string }) => p.id !== '')
    } catch { return [] }
  }

  /**
   * 模型候选（人设的「模型」下拉）：宿主已注册的 provider + 各 provider 能宣告的模型。
   * 只读宿主 LLM 目录，**不发起网络请求**（`discoverModels` 会打端点，这里不用）；
   * 拿不到就返回空列表，UI 退回手填（跨来源模型如 sensenova 的手工条目仍需手填兜底）。
   * 返回扁平列表：DSH 的模型路由是 (provider, model) 一对，两个键必须同时给。
   */
  async function modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }> }> {
    const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as any
    if (!llm || typeof llm.listProviders !== 'function') return { models: [] }
    let list: any[] = []
    try {
      list = llm.listProviders() || []
    } catch {
      return { models: [] }
    }
    const models: Array<{ provider: string; providerName: string; id: string; name: string }> = []
    const seen = new Set<string>()
    for (const p of list) {
      const provider = String((p && (p.id || p.provider)) || '')
      if (!provider) continue
      const providerName = String((p && (p.name || p.displayName)) || provider)
      let discovered: any[] = []
      try {
        // 适配器可选提供 listModels（官方 LlmAdapter 契约）；未提供时该 provider 只报名字。
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
    return { models }
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
