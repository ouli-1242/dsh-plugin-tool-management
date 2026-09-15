// src/rules/archive-engine.ts —— 场景档案引擎：sidecar 读写 + 运行时应用，全部经 deps 注入（无直接 I/O）。
// 状态机（设计 §2.2）：进入 = 快照 → 先落盘 mode（留可退路径）→ 应用已定义段 → 记忆收窄为 {S}；
//                     退出 = 恢复快照 → 落盘自由模式；切换 = 先退后进。
// 失败语义（fail-closed）：任一步失败即反向恢复运行时并写回旧切片；回滚不全会如实写进错误文本。
// v2：MCP 段两级（服务器勾选 + '*' / 工具明细），停用表存勾选集的补集，通配由 index.ts 的 guard/restrict 原生支持。
import {
  computeMcpPlan,
  computeSkillsPlan,
  normalizeArchive,
  snapshotRuntime,
  hasSection,
  type McpPlan,
  type McpServerState,
  type ModeSnapshot,
  type ModeState,
  type SceneArchive,
  type SkillSourceState,
  type SkillsPlan,
} from './archive.js'

export interface ArchiveIndexSlice {
  archives: Record<string, SceneArchive>
  mode: ModeState
  /** 记忆启用场景集合（null = 全部启用）；进入模式时收窄为 [S]，退出**不**恢复（设计 §2.2）。 */
  active: string[] | null
}

export interface ArchiveEngineDeps {
  /** 读 rules-index.json 的 mode/archives/active 切片（rules service 唯一属主）。 */
  loadSlice(): Promise<ArchiveIndexSlice>
  /** 写回切片（合并进 rules-index.json，rules service 负责原子写与缓存失效）。 */
  saveSlice(slice: ArchiveIndexSlice): Promise<void>
  /** 配置中真实存在的 MCP 服务器名全集（含未运行的）。 */
  configuredServers(): Promise<string[]>
  /** 每台服务器已知工具名（live schemas ∪ 启停表历史键）。 */
  serverKnownTools(): Promise<Record<string, string[]>>
  /** 当前 MCP 停用表原文（serverName → 停用工具名 / ['*']）。 */
  currentMcpRaw(): Promise<Record<string, string[]>>
  /** 全量重写 MCP 停用表并刷新 restrict（引擎保证串行）。 */
  applyMcpEntries(entries: Record<string, string[]>): Promise<void>
  /**
   * 各服务器的**服务器级**启停现状（`disabled` 来自补丁文件）。
   *
   * 工具级停用只在「服务器已经加载」时才有意义 —— 服务器没起来，它的工具根本不存在，
   * 勾选与否毫无区别。所以档案必须能改服务器级，否则就是用户报的「勾了没开」。
   */
  mcpServerStates(): Promise<McpServerState[]>
  /** 改**服务器级**启停（写补丁文件，宿主热生效 ≤5s；引擎保证串行）。 */
  applyMcpServerSwitches(switches: Array<{ id: string; level: string; enabled: boolean }>): Promise<void>
  /** 各技能来源的启停现状。来源关闭时技能级的 enable 会被吞掉，所以必须能改来源级。 */
  skillSourceStates(): Promise<SkillSourceState[]>
  /** 改**来源级**启停。 */
  applySkillSourceSwitches(switches: Array<{ root: string; enabled: boolean }>): Promise<void>
  /** 实时发现的技能 key 全集（`<rootKey>/<name>`）。 */
  knownSkillKeys(): Promise<Set<string>>
  /** 当前技能启停全集。 */
  currentSkills(): Promise<Record<string, boolean>>
  /** 技能批量应用（复用既有单条写通道）。 */
  applySkills(target: Record<string, boolean>): Promise<void>
  /** 场景名是否真实存在（进入模式前校验）。 */
  sceneExists(name: string): Promise<boolean>
  /** 实时发现的人设名全集（保存档案时校验 subagents 段）。 */
  knownPersonas(): Promise<Set<string>>
  /** 指定人设名单里当前被停用的（进入模式拍快照用：只记将被启用的行）。 */
  disabledPersonas(names: string[]): Promise<string[]>
  /** 改人设启停（子智能体开关；引擎保证串行）。 */
  applySubagentSwitches(switches: Array<{ name: string; enabled: boolean }>): Promise<void>
  /** 实时发现的记忆 id 全集（保存档案时校验 memories 段）。 */
  knownMemoryIds(): Promise<Set<string>>
}

export interface ArchiveEngine {
  ops: Record<string, (args: any) => Promise<any>>
  writeOps: ReadonlySet<string>
}

const msg = (e: unknown): string => String((e && (e as Error).message) || e)

export function createArchiveEngine(deps: ArchiveEngineDeps): ArchiveEngine {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = chain.then(task, task)
    chain = queued.catch(() => undefined)
    return queued
  }

  /**
   * 还原到快照（退出模式与失败回滚共用同一条路径）：
   * MCP 停用表**按快照原文整体回写**——模式自己写进去的键（未勾服务器的 ['*']）必须随之消失，
   * 否则退出后用户环境仍被静默停用（比"多留一个键"严重得多）；模式期间的手动改动按设计 §2.2
   * 不保留（「退出 = 恢复 mode.snapshot」，手动改动只在「保存到场景」时回写）。
   * 技能只写快照列出的键（这是既有批量通道的语义）：模式期间新增的技能保持现状。
   */
  async function restoreSnapshot(snapshot: ModeSnapshot): Promise<void> {
    // 顺序与进入时**相反**：先恢复服务器级 / 来源级，再恢复工具级 / 技能级 ——
    // 来源还关着的时候写技能级策略会被吞掉（`skills/core.js` 的 sourceEnabled 判定）。
    // 老 snapshot 没有这两栏 → `?? []`，按旧行为只恢复下层。
    const servers = snapshot.mcpServers ?? []
    if (servers.length) {
      await deps.applyMcpServerSwitches(servers.map((x) => ({ id: x.id, level: x.level, enabled: !x.disabled })))
    }
    const sources = snapshot.skillSources ?? []
    if (sources.length) {
      await deps.applySkillSourceSwitches(sources.map((x) => ({ root: x.root, enabled: x.enabled })))
    }
    const mcp = Object.fromEntries(Object.entries(snapshot.mcp).map(([k, v]) => [k, v.slice()]))
    await deps.applyMcpEntries(mcp)
    await deps.applySkills({ ...snapshot.skills })
    // 子智能体开关：只停「进入时被这次启用过的」那些（老 snapshot 没有这栏 → []，按旧行为跳过）。
    const personas = snapshot.subagents ?? []
    if (personas.length) {
      await deps.applySubagentSwitches(personas.map((n) => ({ name: n, enabled: false })))
    }
  }

  /**
   * 失败回滚：运行时还原 + 切片写回；每步失败都记下来，绝不谎报「已回滚」。
   * 返回结构化错误（ok:false），错误文本如实区分「已回滚」与「回滚未完成」。
   */
  async function rollback(prev: ArchiveIndexSlice, snapshot: ModeSnapshot, stage: string, err: unknown): Promise<{ ok: false; error: string }> {
    const problems: string[] = []
    try {
      await restoreSnapshot(snapshot)
    } catch (e) {
      problems.push('运行时还原: ' + msg(e))
    }
    try {
      await deps.saveSlice(prev)
    } catch (e) {
      problems.push('模式状态写回: ' + msg(e))
    }
    const base = `${stage}失败：${msg(err)}`
    return { ok: false, error: problems.length ? `${base}；回滚未完成（${problems.join('；')}）` : `${base}，已回滚` }
  }

  const ops = {
    // 读：页面渲染模式与档案
    'scene-mode-get': async () => {
      const slice = await deps.loadSlice()
      return { ok: true, archives: slice.archives, mode: slice.mode, active: slice.active }
    },

    // 写：保存某场景档案（三段整体替换；键对实时发现全集校验，未知键丢弃并报告）
    'scene-archive-save': (args: any) => serial(async () => {
      const scene = String((args && args.scene) || '').trim()
      if (!scene) return { ok: false, error: '缺少场景名' }
      if (!(await deps.sceneExists(scene))) return { ok: false, error: `场景不存在: ${scene}` }
      const archive = normalizeArchive((args && args.archive) || {})
      const stale: string[] = []
      if (archive.mcp) {
        const configured = await deps.configuredServers()
        const hadKeys = Object.keys(archive.mcp).length > 0
        for (const server of Object.keys(archive.mcp)) {
          if (configured.indexOf(server) < 0) { stale.push('mcp/' + server); delete archive.mcp[server] }
        }
        // 只剔除「全 stale」段：空段是合法值（全不勾 = 全部停用），必须留下来。
        if (hadKeys && Object.keys(archive.mcp).length === 0) delete archive.mcp
      }
      if (archive.skills) {
        const known = await deps.knownSkillKeys()
        const hadKeys = archive.skills.length > 0
        stale.push(...archive.skills.filter((k) => !known.has(k)).map((k) => 'skills/' + k))
        archive.skills = archive.skills.filter((k) => known.has(k))
        if (hadKeys && archive.skills.length === 0) delete archive.skills
      }
      if (archive.subagents) {
        const known = await deps.knownPersonas()
        const hadKeys = archive.subagents.length > 0
        stale.push(...archive.subagents.filter((p) => !known.has(p)).map((p) => 'subagents/' + p))
        archive.subagents = archive.subagents.filter((p) => known.has(p))
        if (hadKeys && archive.subagents.length === 0) delete archive.subagents
      }
      // 记忆段（P5 已废弃）：不再写入、不再校验。记忆的开关是 `rules[*].enabled` 单一真相源，
      // 老档案里残留的 `memories` 字段被忽略（不迁移、不删除，回滚代码时仍可读）。
      // 保存档案时顺手把残留字段清掉，避免新旧语义并存造成误读。
      if (archive.memories !== undefined) delete archive.memories
      const slice = await deps.loadSlice()
      if (Object.keys(archive).length === 0) delete slice.archives[scene]
      else slice.archives[scene] = archive
      await deps.saveSlice(slice)
      return { ok: true, scene, archive: slice.archives[scene] ?? null, stale }
    }),

    // 写：进入/退出/切换当前模式
    // scene=null 退出；目标场景没有 mcp/skills 段 = 结构化拒绝（设计 §2.4：此类场景不显示模式按钮）。
    'scene-mode-set': (args: any) => serial(async () => {
      const hasKey = args && 'scene' in (args || {})
      if (!hasKey) return { ok: false, error: '缺少 scene（null = 退出模式）' }
      const raw = (args && args.scene) ?? null
      const target = raw == null ? null : String(raw).trim() || null

      let slice = await deps.loadSlice()
      let current: ModeState = slice.mode ?? { scene: null, snapshot: null }
      if (target === current.scene) return { ok: true, mode: current, applied: null, stale: [] }

      // ① 退出当前模式（切换 = 先退后进）：先恢复运行时，再落盘自由模式。
      //    恢复失败即中止且**保持原 mode 不变**——宁可留在「可再退出一次」的状态，也不吞错。
      if (current.scene && current.snapshot) {
        try {
          await restoreSnapshot(current.snapshot)
        } catch (e) {
          return { ok: false, error: `退出模式「${current.scene}」失败，已保持原模式（运行时可能部分残留）：${msg(e)}` }
        }
      }
      if (current.scene) {
        const exited: ArchiveIndexSlice = { ...slice, mode: { scene: null, snapshot: null } }
        try {
          await deps.saveSlice(exited)
        } catch (e) {
          return { ok: false, error: `退出模式「${current.scene}」已恢复运行时，但模式状态落盘失败：${msg(e)}` }
        }
        slice = exited
        current = exited.mode
      }
      if (!target) return { ok: true, mode: current, applied: null, stale: [] }

      // ② 进入目标模式：校验 → 快照 → 先落盘 mode（中途失败也留可退快照）→ 应用已定义段 → 记忆收窄。
      const archive = slice.archives[target]
      if (!(await deps.sceneExists(target))) return { ok: false, error: `场景不存在: ${target}` }
      // 无档案段（纯记忆 / 纯人设场景）**也要能进入**：不应用档案、不建快照，但
      // `mode.scene` 与 `active` 照常写入。原因有二：
      //   ① 场景开关（P6）是唯一入口，纯记忆场景点开关不能报错；
      //   ② 顶部「当前模式」横幅的渲染条件是 `mode.scene`，不写就永远不显示 ——
      //      用户裁定：无档案场景开开关也要显示横幅，副标题走 `scenes.mode.noProfile`。
      const appliesArchive = !!archive && (hasSection(archive, 'mcp') || hasSection(archive, 'skills') || hasSection(archive, 'subagents'))
      // 先算计划、再拍快照：快照只记**将被改动**的服务器行 / 来源 / 人设（带改动前的状态），
      // 退出时按记录精确恢复 —— 不动用户手动设置的其他行。
      let mcpPlan: McpPlan | null = null
      let skillsPlan: SkillsPlan | null = null
      if (appliesArchive && archive) {
        try {
          if (archive.mcp) {
            mcpPlan = computeMcpPlan(archive.mcp, {
              configuredServers: await deps.configuredServers(),
              knownTools: await deps.serverKnownTools(),
              serverStates: await deps.mcpServerStates(),
            })
          }
          if (archive.skills) {
            skillsPlan = computeSkillsPlan(archive.skills, await deps.knownSkillKeys(), await deps.skillSourceStates())
          }
        } catch (e) {
          return { ok: false, error: `读取运行时状态失败（未改动任何东西）：${msg(e)}` }
        }
      }
      // 子智能体段：进入时把档案勾选的人设**启用**（子智能体页同步亮起）。
      // 快照只记「改动前停用」的那些 —— 退出时按名单停回，不动其他行。
      const boundPersonas = archive && Array.isArray(archive.subagents) ? archive.subagents : []
      let personaRestore: string[] = []
      if (boundPersonas.length) {
        try {
          personaRestore = await deps.disabledPersonas(boundPersonas)
        } catch (e) {
          return { ok: false, error: `读取人设开关状态失败（未改动任何东西）：${msg(e)}` }
        }
      }
      const snapshot = appliesArchive
        ? snapshotRuntime(
            await deps.currentMcpRaw(),
            await deps.currentSkills(),
            // 直接用计划带出的 `*Before`（改动前的状态），不在这里反推 —— 反推容易搞反方向。
            (mcpPlan?.serverSwitches ?? []).map((s) => ({ id: s.id, level: s.level, disabled: s.disabledBefore })),
            (skillsPlan?.sourceSwitches ?? []).map((s) => ({ root: s.root, enabled: s.enabledBefore })),
            personaRestore,
          )
        : null
      const entered: ArchiveIndexSlice = { ...slice, mode: { scene: target, snapshot }, active: [target] }
      try {
        await deps.saveSlice({ ...slice, mode: entered.mode })
      } catch (e) {
        return { ok: false, error: '进入模式前落盘快照失败（运行时未改动）：' + msg(e) }
      }
      const stale: string[] = []
      try {
        // ① 先切**上层**（服务器级 / 来源级）——下层只有在上层开着时才有意义：
        //    服务器没起来，它的工具不存在，工具级停用无从谈起；来源关着，技能级 enable 会被吞掉。
        if (mcpPlan && mcpPlan.serverSwitches.length) {
          await deps.applyMcpServerSwitches(mcpPlan.serverSwitches.map((s) => ({ id: s.id, level: s.level, enabled: s.enabled })))
        }
        if (skillsPlan && skillsPlan.sourceSwitches.length) {
          await deps.applySkillSourceSwitches(skillsPlan.sourceSwitches.map((s) => ({ root: s.root, enabled: s.enabled })))
        }
        // ② 再写**下层**（工具级停用表 / 技能级策略）。
        if (mcpPlan) {
          stale.push(...mcpPlan.stale)
          await deps.applyMcpEntries(mcpPlan.entries)
        }
        if (skillsPlan) {
          stale.push(...skillsPlan.stale)
          await deps.applySkills(skillsPlan.target)
        }
        // ③ 子智能体开关：把档案勾选的人设启用（子智能体页与目录段同步亮起）。
        if (boundPersonas.length) {
          await deps.applySubagentSwitches(boundPersonas.map((n) => ({ name: n, enabled: true })))
        }
      } catch (e) {
        // 无档案段时没有运行时改动可回滚（snapshot 为 null）。
        return snapshot ? await rollback(slice, snapshot, '应用档案', e) : { ok: false, error: `应用档案失败：${String((e as Error)?.message || e)}` }
      }
      // ③ 记忆启用集收窄为 {S}（`_shared` 由 resolveActiveScenes 恒常加入；退出不恢复）。
      try {
        await deps.saveSlice(entered)
      } catch (e) {
        return snapshot ? await rollback(slice, snapshot, '记忆收窄落盘', e) : { ok: false, error: `记忆收窄落盘失败：${String((e as Error)?.message || e)}` }
      }
      return {
        ok: true,
        mode: entered.mode,
        applied: { mcp: !!(archive && archive.mcp), skills: !!(archive && archive.skills), subagents: !!(archive && archive.subagents) },
        // 上层实际切换了几个（0 = 本来就已经是目标状态，界面不必提示"已停用 N 台"）。
        switched: {
          mcpServers: mcpPlan ? mcpPlan.serverSwitches.length : 0,
          skillSources: skillsPlan ? skillsPlan.sourceSwitches.length : 0,
        },
        stale,
        narrowedTo: [target],
      }
    }),
  }
  return { ops, writeOps: new Set(['scene-archive-save', 'scene-mode-set']) }
}
