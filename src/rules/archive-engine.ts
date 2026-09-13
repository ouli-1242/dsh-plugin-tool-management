// src/rules/archive-engine.ts —— 场景档案引擎：sidecar 读写 + 运行时应用，全部经 deps 注入（无直接 I/O）。
// 状态机（设计 §2.2）：进入 = 快照 → 先落盘 mode（留可退路径）→ 应用已定义段 → 记忆收窄为 {S}；
//                     退出 = 恢复快照 → 落盘自由模式；切换 = 先退后进。
// 失败语义（fail-closed）：任一步失败即反向恢复运行时并写回旧切片；回滚不全会如实写进错误文本。
// v2：MCP 段两级（服务器勾选 + '*' / 工具明细），停用表存勾选集的补集，通配由 index.ts 的 guard/restrict 原生支持。
import {
  computeMcpPlan,
  computeMemoriesPlan,
  computeSkillsPlan,
  normalizeArchive,
  snapshotRuntime,
  hasSection,
  type ModeSnapshot,
  type ModeState,
  type SceneArchive,
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
    const mcp = Object.fromEntries(Object.entries(snapshot.mcp).map(([k, v]) => [k, v.slice()]))
    await deps.applyMcpEntries(mcp)
    await deps.applySkills({ ...snapshot.skills })
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
      if (archive.memories) {
        // 记忆段只影响投影（正文是否进 system prompt），不写任何运行时状态；
        // 这里只把已不存在的记忆 id 剔掉并上报，避免档案里留下指向空气的勾选。
        const known = await deps.knownMemoryIds()
        const hadKeys = archive.memories.length > 0
        const { stale: memStale } = computeMemoriesPlan(archive.memories, known)
        stale.push(...memStale)
        archive.memories = archive.memories.filter((id) => known.has(id))
        if (hadKeys && archive.memories.length === 0) delete archive.memories
      }
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
      if (!archive || (!hasSection(archive, 'mcp') && !hasSection(archive, 'skills'))) {
        return { ok: false, error: `场景「${target}」的档案没有 MCP / 技能段（仅记忆或仅子智能体的场景不需要进入模式）` }
      }
      const snapshot = snapshotRuntime(await deps.currentMcpRaw(), await deps.currentSkills())
      const entered: ArchiveIndexSlice = { ...slice, mode: { scene: target, snapshot }, active: [target] }
      try {
        await deps.saveSlice({ ...slice, mode: entered.mode })
      } catch (e) {
        return { ok: false, error: '进入模式前落盘快照失败（运行时未改动）：' + msg(e) }
      }
      const stale: string[] = []
      try {
        if (archive.mcp) {
          const plan = computeMcpPlan(archive.mcp, {
            configuredServers: await deps.configuredServers(),
            knownTools: await deps.serverKnownTools(),
          })
          stale.push(...plan.stale)
          await deps.applyMcpEntries(plan.entries)
        }
        if (archive.skills) {
          const plan = computeSkillsPlan(archive.skills, await deps.knownSkillKeys())
          stale.push(...plan.stale)
          await deps.applySkills(plan.target)
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
      return { ok: true, mode: entered.mode, applied: { mcp: !!archive.mcp, skills: !!archive.skills }, stale, narrowedTo: [target] }
    }),
  }
  return { ops, writeOps: new Set(['scene-archive-save', 'scene-mode-set']) }
}
