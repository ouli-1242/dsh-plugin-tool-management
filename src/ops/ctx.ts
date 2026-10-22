// 记忆域 op 的**显式上下文契约**（2026-09-19 抽出，配合 memories/service.ts 组装）。
//
// 为什么要有它：24 个 op 原先写在 createMemoriesService 闭包里，靠闭包隐式捕获读模型
// （snapshot / sceneMemory / scenePrompt）、写管道（invalidateSnapshot）、入口
// （parseId / locateRule / buildProjected）与三个路径配置。抽成独立文件后，这些依赖必须
// 显式传入 —— 本文件就是那份清单，签名与原声明逐字对应（改这里等于改 op 的可见面）。
//
// 刻意不做成 `typeof rc`：那会把契约藏回 service.ts，域文件又得反向引它。

import type { DiscoveredEntry, Snapshot } from '../memories/snapshot.js'
import type { MemoryScopeOverride, Rule, RulesIndex, SceneMemoryProjection, ScenePromptProjection, SceneRow } from '../memories/service.js'

export interface MemoriesOpsCtx {
  // 路径与预算（原闭包顶部的四个配置常量）
  stateDir: string
  memoriesRoot: string
  scenesRoot: string
  maxBytes: number
  /**
   * 技能回收站根目录（`<hub>/trash/skills-trash`）。只有 `trash-preview` 用得到 ——
   * 回收站「详情」要读的技能条目住在技能域那边，不在记忆域这三条路径下。
   * 由 index.ts 用 `trashRootPath()` 喂进来（那条路径的唯一定义在 skills/skill-roots.ts，
   * 这里不重算一遍，否则两处迟早分家）。
   */
  skillsTrashDir?: string

  // 读模型：快照、场景记忆段、提示词段
  snapshot(): Promise<Snapshot>
  invalidateSnapshot(): void
  sceneMemory(scope?: MemoryScopeOverride): SceneMemoryProjection
  scenePrompt(): ScenePromptProjection
  /**
   * 某个会话的记忆域覆盖（0.21.2）：由 service 从 `scope-overrides.json` 取，`undefined` =
   * 没有覆盖 = 全局口径。
   *
   * 为什么放在这里而不是让 ops 直接读侧车：侧车归 `scope/store.ts` 管（TTL 缓存 + 写锁），
   * 记忆域再引一份就多了一个读取点，而两处的缓存过期时刻不同步时，界面与注入会各说各话。
   */
  scopeOverrideOf(sessionId: string): MemoryScopeOverride | undefined

  // 记忆条目入口
  parseId(id: string): { group: string; name: string } | null
  locateRule(group: string, name: string): Promise<DiscoveredEntry | null>
  refuseOutsideRoot(target: string): Promise<{ ok: false; error: string; code: string } | null>
  buildProjected(id: string): Promise<Rule | null>
  sceneRows(snap: Snapshot, index: RulesIndex, override?: string | null): SceneRow[]

  // 写侧辅助
  copyIntoMemoriesTrash(located: DiscoveredEntry, group: string, name: string): Promise<string>
  listAttachments(bundleDir: string, name: string): Promise<Array<{ name: string; size: number }>>
  serializeRuleFile(fields: Record<string, string | boolean>, body: string): string
  serializeUpdatedFile(text: string, newName: string, description: string | undefined | null, body: string): string
  ensureLayout(): Promise<void>
  presetExistsSync(id: string): boolean
}
