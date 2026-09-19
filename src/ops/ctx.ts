// 记忆域 op 的**显式上下文契约**（2026-09-19 抽出，配合 memories/service.ts 组装）。
//
// 为什么要有它：24 个 op 原先写在 createMemoriesService 闭包里，靠闭包隐式捕获读模型
// （snapshot / sceneMemory / scenePrompt）、写管道（invalidateSnapshot）、入口
// （parseId / locateRule / buildProjected）与三个路径配置。抽成独立文件后，这些依赖必须
// 显式传入 —— 本文件就是那份清单，签名与原声明逐字对应（改这里等于改 op 的可见面）。
//
// 刻意不做成 `typeof rc`：那会把契约藏回 service.ts，域文件又得反向引它。

import type { DiscoveredEntry, ParsedSkillDoc, Snapshot } from '../memories/snapshot.js'
import type { Rule, RulesIndex, SceneMemoryProjection, ScenePromptProjection, SceneRow } from '../memories/service.js'

export interface MemoriesOpsCtx {
  // 路径与预算（原闭包顶部的四个配置常量）
  stateDir: string
  memoriesRoot: string
  scenesRoot: string
  maxBytes: number

  // 读模型：快照、场景记忆段、提示词段
  snapshot(): Promise<Snapshot>
  invalidateSnapshot(): void
  sceneMemory(): SceneMemoryProjection
  scenePrompt(): ScenePromptProjection

  // 记忆条目入口
  parseId(id: string): { group: string; name: string } | null
  locateRule(group: string, name: string): Promise<DiscoveredEntry | null>
  refuseOutsideRoot(target: string): Promise<{ ok: false; error: string; code: string } | null>
  buildProjected(id: string): Promise<Rule | null>
  sceneRows(snap: Snapshot, index: RulesIndex): SceneRow[]

  // 写侧辅助
  copyIntoMemoriesTrash(located: DiscoveredEntry, group: string, name: string): Promise<string>
  listAttachments(bundleDir: string, name: string): Promise<Array<{ name: string; size: number }>>
  serializeRuleFile(fields: Record<string, string | boolean>, body: string): string
  serializeUpdatedFile(doc: ParsedSkillDoc, newName: string, description: string | undefined | null, body: string): string
  ensureLayout(): Promise<void>
  presetExistsSync(id: string): boolean
}
