// src/rules/archive-engine.ts —— 场景档案引擎：sidecar 读写 + 运行时应用，全部经 deps 注入（无直接 I/O）。
// 状态机（设计 §2.2）：进入 = 快照 → 应用已定义段 → 记忆收窄；退出 = 恢复快照；失败回滚 fail-closed。
import {
  computeApplyPlan,
  computeRestorePlan,
  normalizeArchive,
  snapshotRuntime,
  hasSection,
  type ApplyPlan,
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
  /** 实时发现的工具 key 全集（`<server>/<tool>`；live 注册表 ∪ 启停表已知键）。 */
  knownToolKeys(): Promise<Set<string>>
  /** 实时发现的技能 key 全集（`<rootKey>/<name>`）。 */
  knownSkillKeys(): Promise<Set<string>>
  /** 当前工具启停全集。 */
  currentTools(): Promise<Record<string, boolean>>
  /** 当前技能启停全集。 */
  currentSkills(): Promise<Record<string, boolean>>
  /** 单域批量应用（复用既有单条写通道；引擎保证串行）。 */
  applyTools(target: Record<string, boolean>): Promise<void>
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

  async function applyPlan(plan: ApplyPlan): Promise<void> {
    if (plan.tools) await deps.applyTools(plan.tools)
    if (plan.skills) await deps.applySkills(plan.skills)
  }

  const ops = {
    // 读：页面渲染模式与档案
    'scene-mode-get': async () => ({ ok: true, ...(await deps.loadSlice()) }),

    // 写：保存某场景档案（勾选集整体替换；键对实时发现全集校验，未知键丢弃并报告）
    'scene-archive-save': (args: any) => serial(async () => {
      const scene = String((args && args.scene) || '').trim()
      if (!scene) return { ok: false, error: '缺少场景名' }
      if (!(await deps.sceneExists(scene))) return { ok: false, error: `场景不存在: ${scene}` }
      const archive = normalizeArchive((args && args.archive) || {})
      const stale: string[] = []
      if (archive.tools) {
        const known = await deps.knownToolKeys()
        stale.push(...archive.tools.filter((k) => !known.has(k)).map((k) => 'tools/' + k))
        archive.tools = archive.tools.filter((k) => known.has(k))
      }
      if (archive.skills) {
        const known = await deps.knownSkillKeys()
        stale.push(...archive.skills.filter((k) => !known.has(k)).map((k) => 'skills/' + k))
        archive.skills = archive.skills.filter((k) => known.has(k))
      }
      const slice = await deps.loadSlice()
      if (Object.keys(archive).length === 0) delete slice.archives[scene]
      else slice.archives[scene] = archive
      await deps.saveSlice(slice)
      return { ok: true, scene, archive: slice.archives[scene] ?? null, stale }
    }),

    // 写：进入/退出/切换当前模式（scene=null 退出；目标场景无 tools/skills 段 = 仅记忆收窄，不快照）
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
        await applyPlan(computeRestorePlan(current.snapshot, {
          tools: await deps.currentTools(),
          skills: await deps.currentSkills(),
        }))
      }
      // 2) 进入新模式
      if (target) {
        const archive = slice.archives[target]
        if (!(await deps.sceneExists(target))) return { ok: false, error: `场景不存在: ${target}` }
        if (!archive || (!hasSection(archive, 'tools') && !hasSection(archive, 'skills'))) {
          const mode: ModeState = { scene: target, snapshot: null }
          await deps.saveSlice({ ...slice, mode })
          return { ok: true, mode, applied: null, stale: [] }
        }
        const snapshot = snapshotRuntime(await deps.currentTools(), await deps.currentSkills())
        const plan = computeApplyPlan(archive, { tools: await deps.knownToolKeys(), skills: await deps.knownSkillKeys() })
        try {
          await applyPlan(plan)
        } catch (e) {
          // fail-closed：应用失败 → 立即按快照回滚再报错
          await applyPlan(computeRestorePlan(snapshot, { tools: await deps.currentTools(), skills: await deps.currentSkills() })).catch(() => {})
          return { ok: false, error: '应用档案失败，已回滚: ' + String((e && (e as Error).message) || e) }
        }
        const mode: ModeState = { scene: target, snapshot }
        await deps.saveSlice({ ...slice, mode })
        return { ok: true, mode, applied: { tools: !!plan.tools, skills: !!plan.skills }, stale: plan.stale }
      }
      const mode: ModeState = { scene: null, snapshot: null }
      await deps.saveSlice({ ...slice, mode })
      return { ok: true, mode, applied: null, stale: [] }
    }),
  }
  return { ops, writeOps: new Set(['scene-archive-save', 'scene-mode-set']) }
}
