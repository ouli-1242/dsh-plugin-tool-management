// src/rules/archive-engine.ts —— 场景档案引擎：sidecar 读写 + 运行时应用，全部经 deps 注入（无直接 I/O）。
// 状态机（设计 §2.2）：进入 = 快照 → 应用已定义段 → 记忆收窄；退出 = 恢复快照；失败回滚 fail-closed。
// v2：MCP 段两级（服务器勾选 + '*' / 工具明细），通配由 index.ts 的 guard/restrict 原生支持。
import {
  computeMcpPlan,
  computeSkillsPlan,
  computeRestorePlan,
  normalizeArchive,
  snapshotRuntime,
  hasSection,
  type ModeState,
  type SceneArchive,
} from './archive.js'

export interface ArchiveIndexSlice {
  archives: Record<string, SceneArchive>
  mode: ModeState
}

export interface ArchiveEngineDeps {
  /** 读 rules-index.json 的 mode/archives 切片（rules service 唯一属主）。 */
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
}

export interface ArchiveEngine {
  ops: Record<string, (args: any) => Promise<any>>
  writeOps: ReadonlySet<string>
}

export function createArchiveEngine(deps: ArchiveEngineDeps): ArchiveEngine {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = chain.then(task, task)
    chain = queued.catch(() => undefined)
    return queued
  }

  async function restoreSkills(snapshotSkills: Record<string, boolean>): Promise<void> {
    const target: Record<string, boolean> = {}
    for (const [k, on] of Object.entries(snapshotSkills)) target[k] = on
    for (const [k, on] of Object.entries(await deps.currentSkills())) if (!(k in target)) target[k] = on
    await deps.applySkills(target)
  }

  const ops = {
    // 读：页面渲染模式与档案
    'scene-mode-get': async () => ({ ok: true, ...(await deps.loadSlice()) }),

    // 写：保存某场景档案（三段整体替换；键对实时发现全集校验，未知键丢弃并报告）
    'scene-archive-save': (args: any) => serial(async () => {
      const scene = String((args && args.scene) || '').trim()
      if (!scene) return { ok: false, error: '缺少场景名' }
      if (!(await deps.sceneExists(scene))) return { ok: false, error: `场景不存在: ${scene}` }
      const archive = normalizeArchive((args && args.archive) || {})
      const stale: string[] = []
      if (archive.mcp) {
        const configured = await deps.configuredServers()
        for (const server of Object.keys(archive.mcp)) {
          if (configured.indexOf(server) < 0) { stale.push('mcp/' + server); delete archive.mcp[server] }
        }
        if (Object.keys(archive.mcp).length === 0) delete archive.mcp
      }
      if (archive.skills) {
        const known = await deps.knownSkillKeys()
        stale.push(...archive.skills.filter((k) => !known.has(k)).map((k) => 'skills/' + k))
        archive.skills = archive.skills.filter((k) => known.has(k))
        if (archive.skills.length === 0) delete archive.skills
      }
      const slice = await deps.loadSlice()
      if (Object.keys(archive).length === 0) delete slice.archives[scene]
      else slice.archives[scene] = archive
      await deps.saveSlice(slice)
      return { ok: true, scene, archive: slice.archives[scene] ?? null, stale }
    }),

    // 写：进入/退出/切换当前模式（scene=null 退出；目标场景无 mcp/skills 段 = 仅记忆收窄，不快照）
    'scene-mode-set': (args: any) => serial(async () => {
      const hasKey = args && 'scene' in (args || {})
      if (!hasKey) return { ok: false, error: '缺少 scene（null = 退出模式）' }
      const raw = (args && args.scene) ?? null
      const target = raw == null ? null : String(raw).trim() || null
      const slice = await deps.loadSlice()
      const current = slice.mode ?? { scene: null, snapshot: null }
      if (target === current.scene) return { ok: true, mode: current, applied: null, stale: [] }
      // 1) 退出当前模式：有快照才恢复
      if (current.scene && current.snapshot) {
        const restore = computeRestorePlan(current.snapshot, { mcp: await deps.currentMcpRaw(), skills: await deps.currentSkills() })
        await deps.applyMcpEntries(restore.mcp)
        await restoreSkills(restore.skills)
      }
      // 2) 进入新模式
      if (target) {
        const archive = slice.archives[target]
        if (!(await deps.sceneExists(target))) return { ok: false, error: `场景不存在: ${target}` }
        if (!archive || (!hasSection(archive, 'mcp') && !hasSection(archive, 'skills'))) {
          const mode: ModeState = { scene: target, snapshot: null }
          await deps.saveSlice({ ...slice, mode })
          return { ok: true, mode, applied: null, stale: [] }
        }
        const snapshot = snapshotRuntime(await deps.currentMcpRaw(), await deps.currentSkills())
        const stale: string[] = []
        if (archive.mcp) {
          const plan = computeMcpPlan(archive.mcp, {
            configuredServers: await deps.configuredServers(),
            knownTools: await deps.serverKnownTools(),
          })
          stale.push(...plan.stale)
          try {
            await deps.applyMcpEntries(plan.entries)
          } catch (e) {
            await deps.applyMcpEntries(snapshot.mcp).catch(() => {})
            return { ok: false, error: '应用 MCP 档案失败，已回滚: ' + String((e && (e as Error).message) || e) }
          }
        }
        if (archive.skills) {
          const plan = computeSkillsPlan(archive.skills, await deps.knownSkillKeys())
          stale.push(...plan.stale)
          try {
            await deps.applySkills(plan.target)
          } catch (e) {
            await restoreSkills(snapshot.skills).catch(() => {})
            return { ok: false, error: '应用技能档案失败，已回滚: ' + String((e && (e as Error).message) || e) }
          }
        }
        const mode: ModeState = { scene: target, snapshot }
        await deps.saveSlice({ ...slice, mode })
        return { ok: true, mode, applied: { mcp: !!archive.mcp, skills: !!archive.skills }, stale }
      }
      const mode: ModeState = { scene: null, snapshot: null }
      await deps.saveSlice({ ...slice, mode })
      return { ok: true, mode, applied: null, stale: [] }
    }),
  }
  return { ops, writeOps: new Set(['scene-archive-save', 'scene-mode-set']) }
}
