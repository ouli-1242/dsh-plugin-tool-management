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
  mergeSnapshotSwitches,
  type McpPlan,
  type McpServerState,
  type ModeSnapshot,
  type ModeState,
  type SceneArchive,
  type SkillSourceState,
  type SkillsPlan,
} from './archive.js'

/** 快照里的上层两行（服务器级 / 来源级）的形状：进场景前每一行的原值。 */
type McpServerRow = { id: string; level: string; disabled: boolean }
type SkillSourceRow = { root: string; enabled: boolean }

export interface ArchiveIndexSlice {
  archives: Record<string, SceneArchive>
  mode: ModeState
  /** 记忆启用场景集合（null = 全部启用）；进入模式时收窄为 [S]，退出**不**恢复（设计 §2.2）。 */
  active: string[] | null
}

export interface ArchiveEngineDeps {
  /** 读 memories-index.json 的 mode/archives/active 切片（rules service 唯一属主）。 */
  loadSlice(): Promise<ArchiveIndexSlice>
  /** 写回切片（合并进 memories-index.json，rules service 负责原子写与缓存失效）。 */
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
  /** 当前 MCP 备注（loader entry id → 备注文本）。 */
  currentMcpNotes(): Promise<Record<string, string>>
  /** 写/删 MCP 备注：`note` 为 null = 删除该 id 的备注。引擎保证串行。 */
  applyMcpNotes(entries: Array<{ id: string; note: string | null }>): Promise<void>
  /** serverName → loader entry id（写备注按 id，场景档案按 serverName 存）。查不到返回 undefined。 */
  mcpIdOfServer(serverName: string): Promise<string | undefined>
  /** 各技能来源的启停现状。来源关闭时技能级的 enable 会被吞掉，所以必须能改来源级。 */
  skillSourceStates(): Promise<SkillSourceState[]>
  /** 改**来源级**启停。 */
  applySkillSourceSwitches(switches: Array<{ root: string; enabled: boolean }>): Promise<void>
  /** 实时发现的技能 key 全集（`<rootKey>/<name>`）。 */
  knownSkillKeys(): Promise<Set<string>>
  /**
   * 档案里**能写、且写了有意义**的技能键：既不被同名技能覆盖，结构也完整。
   *
   * 保存档案时按它校验：被覆盖的副本永远不可能生效（`applySkills` 直接跳过）、结构不完整的
   * 连启停都被 core 拒绝，写进档案只会造成「档案说开着、运行时说关着」两种说法。
   */
  selectableSkillKeys(): Promise<Set<string>>
  /** 当前技能启停全集。 */
  currentSkills(): Promise<Record<string, boolean>>
  /** 技能批量应用（复用既有单条写通道）。 */
  applySkills(target: Record<string, boolean>): Promise<void>
  /** 场景名是否真实存在（进入模式前校验）。 */
  sceneExists(name: string): Promise<boolean>
  /** 实时发现的人设名全集（保存档案时校验 subagents 段；进入模式时算「未勾的是哪些」）。 */
  knownPersonas(): Promise<Set<string>>
  /** 指定人设名单里当前被停用的（进入模式拍快照用：只记将被启用的行）。 */
  disabledPersonas(names: string[]): Promise<string[]>
  /** 指定人设名单里当前**开着**的（进入模式把未勾的关掉时，只记将被关闭的行）。 */
  enabledPersonas(names: string[]): Promise<string[]>
  /** 改人设启停（子智能体开关；引擎保证串行）。 */
  applySubagentSwitches(switches: Array<{ name: string; enabled: boolean }>): Promise<void>
  /** 实时发现的记忆 id 全集。**引擎已不再消费**（P5 起档案不写、不校验 memories 段，
   *  保存时顺手清掉残留字段）—— 依赖保留只为接口稳定，新代码不要引用它。 */
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
   * 快照里的上层两行 → 退出时**真正要回写**的那些：现状 ≠ 快照值、且这一行现在还存在。
   *
   * 为什么必须过滤而不是逐行无条件回写：
   *   - 快照是全量记录（进场景前每一行的原值），场景没碰过的行占绝大多数，逐行回写会让
   *     补丁文件 / 状态文件白写一遍（MCP 那一侧还会连带触发宿主热重载与备份噪音）；
   *   - 现状已经等于原值的行本来就无需还原。真正要回写的只有「场景期间被改过的行」——
   *     档案改的，或用户自己在场景页面上改的（未锁定时可用，改动同步进档案）。
   *     后者正是用户报的「场景里关掉 A 目录，退出后 A 与它下面的技能都没开回来」：
   *     旧口径只记「进场景时被档案改动过的行」，而 A 在进场景时没被改动（档案里勾着
   *     A 下面的技能），快照里根本没有 A 这一行。
   *
   * 快照里记过、但现在已不存在的行直接跳过：这类行在场景期间被删掉了，没有可还原的状态，
   * 硬写还会让退出失败（MCP 启停按 id 定位，`未找到条目` 直接报错）。
   * 读不到现状（列表读取抛错）→ 退回旧行为全量回写：宁可多写几行，不可少还原。
   */
  async function mcpServerRowsToRestore(rows: McpServerRow[]): Promise<McpServerRow[]> {
    if (!rows.length) return []
    let current: McpServerState[]
    try { current = await deps.mcpServerStates() } catch { return rows }
    const byKey = new Map(current.map((s) => [s.id + '\u0000' + s.level, s.disabled]))
    return rows.filter((x) => {
      const key = x.id + '\u0000' + x.level
      return byKey.has(key) && byKey.get(key) !== x.disabled
    })
  }

  /** 同 mcpServerRowsToRestore：来源级的还原行。 */
  async function skillSourceRowsToRestore(rows: SkillSourceRow[]): Promise<SkillSourceRow[]> {
    if (!rows.length) return []
    let current: SkillSourceState[]
    try { current = await deps.skillSourceStates() } catch { return rows }
    const byRoot = new Map(current.map((s) => [s.root, s.enabled]))
    return rows.filter((x) => byRoot.has(x.root) && byRoot.get(x.root) !== x.enabled)
  }

  /**
   * 还原到快照（退出模式与失败回滚共用同一条路径）：
   * MCP 停用表**按快照原文整体回写**——模式自己写进去的键（未勾服务器的 ['*']）必须随之消失，
   * 否则退出后用户环境仍被静默停用（比"多留一个键"严重得多）；模式期间的手动改动按设计 §2.2
   * 不保留（「退出 = 恢复 mode.snapshot」，手动改动只在「保存到场景」时回写）。
   * 技能只写快照列出的键（这是既有批量通道的语义）：模式期间新增的技能保持现状。
   * 上层两行（服务器级 / 来源级）按**全量**快照还原 —— 只回写与现状不同的行，见
   * mcpServerRowsToRestore / skillSourceRowsToRestore。
   */
  async function restoreSnapshot(snapshot: ModeSnapshot): Promise<void> {
    // 顺序与进入时**相反**：先恢复服务器级 / 来源级，再恢复工具级 / 技能级 ——
    // 来源还关着的时候写技能级策略会被吞掉（`skills/core.js` 的 sourceEnabled 判定）。
    // 老 snapshot 没有这两栏 → `?? []`，按旧行为只恢复下层。
    const servers = await mcpServerRowsToRestore(snapshot.mcpServers ?? [])
    if (servers.length) {
      await deps.applyMcpServerSwitches(servers.map((x) => ({ id: x.id, level: x.level, enabled: !x.disabled })))
    }
    const sources = await skillSourceRowsToRestore(snapshot.skillSources ?? [])
    if (sources.length) {
      await deps.applySkillSourceSwitches(sources.map((x) => ({ root: x.root, enabled: x.enabled })))
    }
    const mcp = Object.fromEntries(Object.entries(snapshot.mcp).map(([k, v]) => [k, v.slice()]))
    await deps.applyMcpEntries(mcp)
    await deps.applySkills({ ...snapshot.skills })
    // 备注：按快照原值写回（null = 原本没有，删除）。模式期间的手动备注改动不保留（同 §2.2）。
    const notes = snapshot.mcpNotes ?? []
    if (notes.length) {
      await deps.applyMcpNotes(notes.map((x) => ({ id: x.id, note: x.note })))
    }
    // 子智能体开关（v0.9.1）：**全量映射优先**——退出即精确还原「进场景前」的开与关。
    // 为什么不能只靠下面那两个部分名单：场景内页面开关已开放（未锁定即可改、改动同步进档案），
    // 「现在开着」不再只来自档案勾选，部分名单答不出「这个人是场景开的还是用户开的」。
    // 表里**记过的名字**逐个还原；场景中新建的人设不在表里 → 不动它（与技能域同口径）。
    // 老 snapshot 没有这一栏 → 退回两个方向的部分名单（旧行为：先停被开的，再开回被关的）。
    const personaStates = snapshot.subagentsAll
    if (personaStates && typeof personaStates === 'object') {
      const switches = Object.entries(personaStates).map(([name, on]) => ({ name, enabled: on === true }))
      if (switches.length) await deps.applySubagentSwitches(switches)
    } else {
      const personasOff = snapshot.subagents ?? []
      if (personasOff.length) {
        await deps.applySubagentSwitches(personasOff.map((n) => ({ name: n, enabled: false })))
      }
      const personasOn = snapshot.subagentsOn ?? []
      if (personasOn.length) {
        await deps.applySubagentSwitches(personasOn.map((n) => ({ name: n, enabled: true })))
      }
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

  /**
   * 把**当前模式**的档案就地重新应用一次（改档案 → 立即生效）。
   *
   * 存在的理由（用户裁定 2026-09-16）：场景内页面上的开关被禁用，改环境只能改档案；
   * 若档案改完不立刻生效，用户就得「退出场景再进一次」才看得到结果。
   *
   * 口径与进入模式**完全一致**（四域同口径）：勾选集 = 该场景下开着的东西，段未定义 =
   * 一个都没勾 = 全部停用。返回这次要改的**上层行**（服务器级 / 来源级，带改动前的状态），
   * 由调用方并进快照 —— 退出仍按「进场景前」精确还原（见 mergeSnapshotSwitches）。
   * 人设域不在这里处理：它需要往快照里补记（谁被开 / 关过），由 index.ts 的
   * `scene-archive-save` 包装统一做。
   */
  async function reapplyActiveArchive(archive: SceneArchive | undefined): Promise<{
    mcpServers: Array<{ id: string; level: string; disabledBefore: boolean }>
    skillSources: Array<{ root: string; enabledBefore: boolean }>
  }> {
    const mcpPlan = computeMcpPlan((archive && archive.mcp) || {}, {
      configuredServers: await deps.configuredServers(),
      knownTools: await deps.serverKnownTools(),
      serverStates: await deps.mcpServerStates(),
    })
    const skillsPlan = computeSkillsPlan((archive && archive.skills) || [], await deps.knownSkillKeys(), await deps.skillSourceStates())
    if (mcpPlan.serverSwitches.length) {
      await deps.applyMcpServerSwitches(mcpPlan.serverSwitches.map((s) => ({ id: s.id, level: s.level, enabled: s.enabled })))
    }
    if (skillsPlan.sourceSwitches.length) {
      await deps.applySkillSourceSwitches(skillsPlan.sourceSwitches.map((s) => ({ root: s.root, enabled: s.enabled })))
    }
    await deps.applyMcpEntries(mcpPlan.entries)
    await deps.applySkills(skillsPlan.target)
    if (archive && archive.mcpNotes) {
      // 与进入时同一口径：场景备注只作用于 mcp 段里实际勾选的服务器。
      const selected = archive.mcp ? Object.keys(archive.mcp) : []
      const entries: Array<{ id: string; note: string | null }> = []
      for (const [server, note] of Object.entries(archive.mcpNotes)) {
        if (selected.indexOf(server) < 0) continue
        const id = await deps.mcpIdOfServer(server)
        if (id !== undefined) entries.push({ id, note })
      }
      // 不在本次覆盖里的旧场景备注行**不这里删**（退出时会按快照整体回原位）。
      if (entries.length) await deps.applyMcpNotes(entries)
    }
    return { mcpServers: mcpPlan.serverSwitches, skillSources: skillsPlan.sourceSwitches }
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
      if (archive.mcpNotes) {
        const configured = await deps.configuredServers()
        for (const server of Object.keys(archive.mcpNotes)) {
          if (configured.indexOf(server) < 0) { stale.push('mcpNotes/' + server); delete archive.mcpNotes[server] }
        }
        // 空段 = 无覆盖（与未定义行为相同：进入场景不覆盖任何备注），删除以免歧义。
        if (Object.keys(archive.mcpNotes).length === 0) delete archive.mcpNotes
      }
      if (archive.skills) {
        // 校验用**可勾选**集合（不是「已知全集」）：被同名技能覆盖的副本与结构不完整的技能
        // 永远不可能生效，勾了也是假的 —— 留着就是「档案说开着、技能页说没启动」（用户实测：
        // 启动一个目录后档案里多出被覆盖的那个技能）。这里按同一口径丢弃并如实报告，
        // 顺带把历史残留清掉。
        const known = await deps.selectableSkillKeys()
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
      // 改的正是**当前模式**的档案 → 就地重新应用（场景内只能改档案，改完必须生效）。
      // 这次新改到的**上层行**（服务器级 / 来源级）并进快照：退出仍按「进场景前」还原，
      // 进场景时改过的行 + 这次新改的行都要有记录（已记过的行保持原值，见 mergeSnapshotSwitches）。
      // 应用失败不回滚档案：档案是用户的意图记录，运行时状态下次进场景会对齐；
      // 如实把错误报出去，别假装生效了。
      let applyError: string | null = null
      if (slice.mode.scene === scene) {
        try {
          const changed = await reapplyActiveArchive(slice.archives[scene])
          const snapshot = slice.mode.snapshot
          if (snapshot && (changed.mcpServers.length || changed.skillSources.length)) {
            await deps.saveSlice({
              ...slice,
              mode: { ...slice.mode, snapshot: mergeSnapshotSwitches(snapshot, changed.mcpServers, changed.skillSources) },
            })
          }
        } catch (e) {
          applyError = msg(e)
        }
      }
      return { ok: true, scene, archive: slice.archives[scene] ?? null, stale, ...(applyError ? { applyError } : {}) }
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

      // ② 进入目标模式：校验 → 算计划 → 拍快照 → 先落盘 mode（中途失败也留可退快照）→ 应用 → 记忆收窄。
      //    三个域（MCP / 技能 / 人设）都按「与档案勾选集完全一致」应用，未定义 = 全关；
      //    备注段只在定义时覆盖。所以这里没有「纯记忆场景不用动运行时」这条分支 —— 恒拍快照。
      const archive = slice.archives[target]
      if (!(await deps.sceneExists(target))) return { ok: false, error: `场景不存在: ${target}` }
      // 子智能体段：人设域按**「置为与勾选集完全一致」**应用（与 MCP / 技能同一条语义）——
      // 勾了的启用、没勾的（含整段未定义 = 一个都没勾）停用。此前只启用、从不关闭，
      // 于是用户实测「场景没绑定任何人设，进场景后原先开着的人设照样开着」。
      // 快照两个方向都记：被打开的（改动前关着）退出停回，被关掉的（改动前开着）退出开回。
      const boundPersonas = archive && Array.isArray(archive.subagents) ? archive.subagents : []
      let unboundPersonas: string[] = []
      let personaRestore: string[] = []
      let personaRestoreOn: string[] = []
      // 全量开关映射（v0.9.1）：退出即精确还原「进场景前」。半个名单做不到这件事 ——
      // 场景里手动开过的人设，「改动前是关还是开」只在这张全量表里。
      let personaStates: Record<string, boolean> = {}
      try {
        const known = await deps.knownPersonas()
        unboundPersonas = [...known].filter((n) => boundPersonas.indexOf(n) < 0).sort()
        personaRestore = await deps.disabledPersonas(boundPersonas)
        personaRestoreOn = await deps.enabledPersonas(unboundPersonas)
        const on = new Set(await deps.enabledPersonas([...known]))
        personaStates = Object.fromEntries([...known].map((n) => [n, on.has(n)]))
      } catch (e) {
        return { ok: false, error: `读取人设开关状态失败（未改动任何东西）：${msg(e)}` }
      }
      // **四域同口径**（用户实测三连，2026-09-16）：档案的勾选集 = 该场景下开着的东西，
      // **段未定义 = 一个都没勾 = 全部停用**。此前只有人设域按这条应用，MCP / 技能沿用旧口径
      // 「未定义 = 该域不碰」——于是「场景档案没开 MCP 工具集 / 技能集」时，进场景后原本在跑的
      // 服务器与技能照样开着（用户报的 ②③）。开关既然已收归档案（场景内页面不可改），
      // 档案就必须说得清「这个场景要什么」——未定义只能读成「什么都不要」。
      // 备注段是例外：未定义 = 不覆盖任何备注（没有东西"因为未定义而需要关掉"）。
      const mcpSpec: Record<string, '*' | string[]> = (archive && archive.mcp) || {}
      const skillsSpec: string[] = (archive && archive.skills) || []
      // 先读现状、再算计划：现状既喂给计划（算「哪些行需要改」），也**全量**写进快照。
      // 快照记的是**每一行**服务器 / 来源的进场景前状态，不是只记「本次计划要改的行」——
      // 场景期间用户可以在页面上改开关（未锁定时可用，改动同步进档案），只记计划行的话
      // 这些改动就没有原值可回：用户报的「场景里关掉 A 目录，退出后 A 和它下面的技能都没开回来」，
      // 就是 A 在进场景时没被档案改动（档案里勾着 A 下面的技能）而未进快照。
      let mcpPlan: McpPlan | null = null
      let skillsPlan: SkillsPlan | null = null
      let mcpServerStates: McpServerState[] = []
      let skillSources: SkillSourceState[] = []
      try {
        mcpServerStates = await deps.mcpServerStates()
        skillSources = await deps.skillSourceStates()
        mcpPlan = computeMcpPlan(mcpSpec, {
          configuredServers: await deps.configuredServers(),
          knownTools: await deps.serverKnownTools(),
          serverStates: mcpServerStates,
        })
        skillsPlan = computeSkillsPlan(skillsSpec, await deps.knownSkillKeys(), skillSources)
      } catch (e) {
        return { ok: false, error: `读取运行时状态失败（未改动任何东西）：${msg(e)}` }
      }
      // 场景备注（v0.8.1）：把 `mcpNotes`（serverName → 场景备注）映射到 loader id，
      // 记录**改动前**的备注（快照恢复用），应用时写进 notes.json 覆盖全局备注。
      let noteTargets: Array<{ id: string; note: string }> | null = null
      let noteBefore: Array<{ id: string; note: string | null }> = []
      if (archive && archive.mcpNotes) {
        try {
          const current = await deps.currentMcpNotes()
          const targets: Array<{ id: string; note: string }> = []
          const before: Array<{ id: string; note: string | null }> = []
          // 只对**mcp 段里实际勾选**的服务器应用场景备注：未勾选的服务器该场景根本不用它，
          // 覆盖它的全局备注属于误伤（2026-09-16 用户实测「没勾的服务器备注也变了」）。
          const selectedServers = archive.mcp ? Object.keys(archive.mcp) : []
          for (const [server, note] of Object.entries(archive.mcpNotes)) {
            if (selectedServers.indexOf(server) < 0) continue
            const id = await deps.mcpIdOfServer(server)
            if (id === undefined) continue // 保存时已 stale 过，这里再兜底
            targets.push({ id, note })
            before.push({ id, note: current[id] ?? null })
          }
          if (targets.length) {
            noteTargets = targets
            noteBefore = before
          }
        } catch (e) {
          return { ok: false, error: `读取备注状态失败（未改动任何东西）：${msg(e)}` }
        }
      }
      // 快照**恒拍**：三个域都按「与勾选集完全一致」应用（未定义 = 全关），所以任何场景
      // 进入都可能改动运行时（哪怕只是停掉几台服务器 / 几个技能），退出都得能精确还原。
      // 上层两行传**现状全量**（上面的 mcpServerStates / skillSources 就是进场景前的值），
      // 不是计划里那几行 —— 退出按「现状 ≠ 记录值」回写（见 mcpServerRowsToRestore）。
      const snapshot = snapshotRuntime(
        await deps.currentMcpRaw(),
        await deps.currentSkills(),
        mcpServerStates.map((s) => ({ id: s.id, level: s.level, disabled: s.disabled })),
        skillSources.map((s) => ({ root: s.root, enabled: s.enabled })),
        personaRestore,
        personaRestoreOn,
        noteBefore,
        personaStates,
      )
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
        if (mcpPlan.serverSwitches.length) {
          await deps.applyMcpServerSwitches(mcpPlan.serverSwitches.map((s) => ({ id: s.id, level: s.level, enabled: s.enabled })))
        }
        if (skillsPlan.sourceSwitches.length) {
          await deps.applySkillSourceSwitches(skillsPlan.sourceSwitches.map((s) => ({ root: s.root, enabled: s.enabled })))
        }
        // ② 再写**下层**（工具级停用表 / 技能级策略）。
        stale.push(...mcpPlan.stale)
        await deps.applyMcpEntries(mcpPlan.entries)
        stale.push(...skillsPlan.stale)
        await deps.applySkills(skillsPlan.target)
        // ③ 子智能体开关：**勾了的启用、未勾的停用**（子智能体页与目录段同步）。
        //    先开后关：勾选名单不可能同时出现在两边，顺序只影响中间态的观感。
        if (personaRestore.length) {
          await deps.applySubagentSwitches(personaRestore.map((n) => ({ name: n, enabled: true })))
        }
        if (personaRestoreOn.length) {
          await deps.applySubagentSwitches(personaRestoreOn.map((n) => ({ name: n, enabled: false })))
        }
        // ④ 场景备注：覆盖全局备注（notes.json）。恢复走快照的 mcpNotes 原值。
        if (noteTargets && noteTargets.length) {
          await deps.applyMcpNotes(noteTargets.map((x) => ({ id: x.id, note: x.note })))
        }
      } catch (e) {
        return await rollback(slice, snapshot, '应用档案', e)
      }
      // ③ 记忆启用集收窄为 {S}（`_shared` 由 resolveActiveScenes 恒常加入；退出不恢复）。
      try {
        await deps.saveSlice(entered)
      } catch (e) {
        return await rollback(slice, snapshot, '记忆收窄落盘', e)
      }
      return {
        ok: true,
        mode: entered.mode,
        // 三个域都是「按勾选集全量应用」（未定义 = 全关），所以都算已应用；
        // 备注段未定义 = 不覆盖任何备注，如实报它是否定义。
        applied: { mcp: true, skills: true, subagents: true, mcpNotes: !!(archive && archive.mcpNotes) },
        // 上层实际切换了几个（0 = 本来就已经是目标状态，界面不必提示"已停用 N 台"）。
        switched: {
          mcpServers: mcpPlan.serverSwitches.length,
          skillSources: skillsPlan.sourceSwitches.length,
        },
        stale,
        narrowedTo: [target],
      }
    }),
  }
  return { ops, writeOps: new Set(['scene-archive-save', 'scene-mode-set']) }
}
