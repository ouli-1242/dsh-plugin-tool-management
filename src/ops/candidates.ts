// 场景档案与候选源域的 HTTP ops（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// 三个 op 都是**只读候选源**：preset-tools（人设表单的工具候选）、model-candidates
// （宿主 LLM 目录）、scene-inventory（场景档案勾选器的数据源 v2）。

export interface CandidateOpsDeps {
  /** 全体 Agent 预设工具名并集 + 各工具所属预设 + 当前会话是否可见。 */
  presetToolCandidates(): Promise<{ tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string }> }>
  /** 宿主 LLM 目录里的 (provider, model) 对（不发网络请求）。 */
  modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }> }>
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
  /** MCP 停用表：场景档案勾选器据此预勾（把"全停"读成"全启用"是错的）。 */
  readDisabledTools(force?: boolean): Promise<Record<string, string[]>>
  presetNames(): Promise<Array<{ id: string; name: string; trust: string }>>
  memorySceneCandidates(): Promise<Array<{ name: string; label: string; description: string; count: number; global: boolean }>>
  memoryCandidates(): Promise<Array<{ id: string; scene: string; name: string; description: string }>>
}

export function buildCandidateOps(deps: CandidateOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    // 人设表单的两个候选源之一（只读，均为「按需拉取」——不进 scene-inventory，避免每次开
    // 档案弹窗都枚举预设）。
    // preset-tools：全体 Agent 预设工具名并集 + 各工具所属预设 + 当前会话是否可见。
    // `unavailable` = 本插件自己没注册上的工具：工具列表接口是唯一按名字枚举工具的地方，
    // 注册失败只能在这里被如实回答。
    'preset-tools': async () => ({
      ok: true,
      ...(await deps.presetToolCandidates()),
      unavailable: deps.getToolFailures().map((f) => ({ ...f })),
    }),
    // model-candidates：宿主 LLM 目录里的 (provider, model) 对（不发网络请求）。
    'model-candidates': async () => ({ ok: true, ...(await deps.modelCandidates()) }),
    // 场景档案勾选器数据源 v2：全部 MCP 服务器（含未运行）+ 技能全集 + 人设清单。
    'scene-inventory': async () => {
      const [rowsR, tools, skills, subs] = await Promise.all([deps.mcpmListView(), deps.toolStates(), deps.skillRows(), deps.subagentList()])
      const disabledRaw = await deps.readDisabledTools()
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
          allToolsDisabled: (disabledRaw[name] || []).indexOf('*') >= 0,
          // 未运行且没有任何已知工具 ⇒ null（客户端显示「工具数未知」并引导读取），
          // 不再给出误导性的 0。
          toolCount: live || Number(row.toolCount) > 0
            ? (typeof row.toolCount === 'number' ? row.toolCount : null)
            : null,
        })
      }
      return {
        ok: true,
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
