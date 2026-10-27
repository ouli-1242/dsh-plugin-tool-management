// 场景档案与候选源域的 HTTP ops（从 index.ts 的 handlers 表抽出）。
//
// 三个 op 都是**只读候选源**：preset-tools（人设表单的工具候选）、model-candidates
// （宿主 LLM 目录）、scene-inventory（场景档案勾选器的数据源 v2）。

import type { PresetToolCandidates } from '../scenes/candidates.js'
import type { DisabledToolsRead } from '../mcp/disabled-tools.js'

/** 候选清单 op 的依赖：预设工具视图 + 宿主模型目录。 */
export interface CandidateOpsDeps {
  /** 一行一个 Agent 预设，各带自己的工具清单与归属组。 */
  presetToolCandidates(): Promise<PresetToolCandidates>
  /** 宿主 LLM 目录里的 (provider, model) 对 + 去重后的来源清单（`listModels`，官方适配器带缓存）。 */
  modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }>; providers: Array<{ id: string; name: string }> }>
  /**
   * 某个 (provider, model) 的思考强度档位。与上面那个**代价不同**：要问 adapter，官方注释写明
   * 是 `adapter-owned asynchronous lookup`（可能联网），所以单独一个 op、按需拉取。
   */
  modelReasoning(provider: string, model: string): Promise<{ ok: boolean; efforts?: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string | null; error?: string }>
  /**
   * 本插件自己没注册上的工具清单（如 `subagent_manager_*`）。用 getter 是因为它是可变的：
   * 注册失败是在 apply 过程中逐个记进去的，op 每次调用都要读最新那份。
   */
  getToolFailures(): Array<Record<string, unknown>>
  /** MCP 列表视图（含备注、已打码）。 */
  mcpmListView(): Promise<{ rows?: any[] }>
  toolStates(): Promise<Record<string, boolean>>
  skillRows(): Promise<unknown>
  subagentList(): Promise<Array<{ name: string; description?: string; toolsByPreset?: unknown }>>
  /**
   * MCP 停用表四态读：场景档案勾选器据此预勾（把"全停"读成"全启用"是错的）。
   * 用四态而不是值：corrupt / unreadable 时勾选器必须显式禁用，不能拿空表当"全开"。
   */
  readDisabledToolsResult(force?: boolean): Promise<DisabledToolsRead>
  presetNames(): Promise<Array<{ id: string; name: string; trust: string }>>
  memorySceneCandidates(): Promise<Array<{ name: string; label: string; description: string; count: number; global: boolean }>>
  memoryCandidates(): Promise<Array<{ id: string; scene: string; name: string; description: string }>>
}

/** 候选源的只读 op：给场景 / 人设表单按需拉「有哪些预设、各自带哪些工具」。 */
export function buildCandidateOps(deps: CandidateOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    // 人设表单的两个候选源之一（只读，均为「按需拉取」——不进 scene-inventory，避免每次开
    // 档案弹窗都枚举预设）。
    // preset-tools：一行一个 Agent 预设，各带自己的工具清单与归属组（不再返回全体并集）。
    // `unavailable` = 本插件自己没注册上的工具：工具列表接口是唯一按名字枚举工具的地方，
    // 注册失败只能在这里被如实回答。
    'preset-tools': async () => ({
      ok: true,
      ...(await deps.presetToolCandidates()),
      unavailable: deps.getToolFailures().map((f) => ({ ...f })),
    }),
    // model-candidates：宿主 LLM 目录里的 (provider, model) 对（`listModels`，官方适配器带缓存）。
    'model-candidates': async () => ({ ok: true, ...(await deps.modelCandidates()) }),
    // model-reasoning：某个 (provider, model) 支持的思考强度档位（人设表单的「思考强度」下拉）。
    // 为什么单独一个 op：档位清单要逐个模型问 adapter（`llm.resolveModelInfo`，异步、
    // 可能联网），代价随模型数量增长；而 model-candidates 读的是有缓存的官方目录。
    // 捆在一次调用里会让"打开人设表单"多付这部分代价。这里只做参数归一与转发，
    // 判定留给调用方（界面按 ok 分两态显示）。
    'model-reasoning': async (args: any) => {
      const provider = String((args && args.provider) || '').trim()
      const model = String((args && args.model) || '').trim()
      if (!provider || !model) return { ok: false, error: 'provider 与 model 都要给（档位跟模型走）' }
      return deps.modelReasoning(provider, model)
    },
    // 场景档案勾选器数据源 v2：全部 MCP 服务器（含未运行）+ 技能全集 + 人设清单。
    'scene-inventory': async () => {
      const [rowsR, tools, skills, subs, disabledRead] = await Promise.all([
        deps.mcpmListView(), deps.toolStates(), deps.skillRows(), deps.subagentList(), deps.readDisabledToolsResult(),
      ])
      const disabledUnknown = disabledRead.status === 'corrupt' || disabledRead.status === 'unreadable'
      const disabledRaw = disabledRead.status === 'ok' ? disabledRead.value : {}
      const rows: any[] = (rowsR && rowsR.rows) || []
      const mcpServers: any[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        const name = String((row && row.serverName) || '')
        if (!name || seen.has(name)) continue
        seen.add(name)
        const live = !!(row.live && row.live.enabled)
        mcpServers.push({
          name,
          level: row.level || null,
          live,
          serverDisabled: !!row.disabled,
          // 停用表里的 ['*'] = 整台工具停用（勾选器据此预勾，避免把"全停"读成"全启用"）。
          // unknown 时恒 false：这不是"没停用"，而是"不知道"，由顶层 `disabledState` 说清。
          allToolsDisabled: !disabledUnknown && (disabledRaw[name] || []).indexOf('*') >= 0,
          // 未运行且没有任何已知工具 ⇒ null（客户端显示「工具数未知」并引导读取），
          // 不再给出误导性的 0。
          toolCount: live || Number(row.toolCount) > 0
            ? (typeof row.toolCount === 'number' ? row.toolCount : null)
            : null,
        })
      }
      return {
        ok: true,
        // 勾选器必须能区分"停用表是空的"与"停用表读不出来"：后者下所有工具都被执行侧
        // 拒绝，界面要把 MCP 段锁住并解释原因（见 45-scenes.js 的 mcpGroup）。
        disabledState: disabledUnknown ? 'unknown' : 'ok',
        disabledIssue: disabledUnknown ? disabledRead.status : null,
        mcpServers,
        tools: Object.entries(tools).map(([key, enabled]) => ({ key, enabled })),
        // 技能行：技能名与来源名分开给（早先只给 `<来源 key>/<技能名>`，自定义目录的
        // 来源 key 是 `custom-<hash>`，于是导入的技能在场景里显示成一串哈希）。
        skills,
        // 人设行要显示"按模式配了什么限制"，所以把按模式名单一起带上；
        // presets 只给名字与来源（不枚举工具，避免打开档案弹窗就挂载每个预设）。
        subagents: subs.map((p) => ({ name: p.name, description: p.description, toolsByPreset: p.toolsByPreset ?? null })),
        presets: await deps.presetNames(),
        // 档案编辑器第 4 段「记忆」的候选：场景 + 每个场景里的记忆条数。
        // 记忆正文不在这里返回（勾选集只存 id，渲染时才读盘）。
        scenes: await deps.memorySceneCandidates(),
        memories: await deps.memoryCandidates(),
      }
    },
  }
}
