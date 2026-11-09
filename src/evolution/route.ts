// 写入路由：一条自动记忆该落在哪一层。
//
// 三个轴是正交的（docs 01-model §2）：`layer` 是数据属性（谁能看见），`origin` 是谁写的，
// `learnScope` 是策略（在哪儿允许学）。本文件只算 `layer`，不看 `learnScope` —— 后者决定
// "开不开学习"，不影响"该记在哪"。混在一起就会出现"在会话里学的没资格进全局"这种错论：
// 会话只是场所，不是证据强度的上限。
//
// 路由两步，顺序不能反：
//   ① 按**内容与环境**判"想要哪层"（下面 ROUTE_RULES）
//   ② 与 `writeTarget` 的**上限**取更窄者
// 为什么第②步是"取窄"而不是"拒绝"：拒绝会让"全局措辞 + 会话上限"这句话一个字都记不下来，
// 而降级到工作区仍然有用。降级必须留痕（`degraded`），否则用户会以为全局记上了。

import { LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, type MemoryLayer } from '../memories/constants.js'
import type { WriteTarget } from './config.js'
import type { EvidenceSource } from './state.js'

/** 层从窄到宽的序号：取 `min` 即"取更窄的上限"。 */
const LAYER_RANK: Record<MemoryLayer, number> = {
  [LAYER_SESSION]: 0,
  [LAYER_SCENE]: 1,
  [LAYER_WORKSPACE]: 2,
  [LAYER_GLOBAL]: 3,
}

export const narrowerOf = (a: MemoryLayer, b: MemoryLayer): MemoryLayer => (LAYER_RANK[a] <= LAYER_RANK[b] ? a : b)

/**
 * `writeTarget` 的**上限层**。
 *
 * `global` 与 `route` 都表示"不设上限"：前者是给界面的措辞（"最多记到全局"），后者是
 * 出厂默认。让两个值行为一致是有意的 —— 区别只在文案，不在语义，少一条分支就少一个
 * "两个看起来一样的选项行为不同"的坑。
 */
export function capLayerOf(target: WriteTarget): MemoryLayer {
  // 会话层已取消：旧配置里残留的 `session` 按最窄的工作区解释，不再产生 `_session/` 目录。
  if (target === 'session' || target === 'workspace') return LAYER_WORKSPACE
  return LAYER_GLOBAL
}

/**
 * 全局措辞。命中才允许升到全局层（还要叠加证据门：只有用户明说的才算）。
 *
 * 刻意收窄：只认"跨项目"与"永远/以后都"这两类**明确**表述。不认"一般"、"通常"、
 * "最好"——那些是偏好强度，不是作用域。误判的代价是把项目约定升级成所有项目的约定，
 * 而用户根本不知道它存在于全局层。
 */
const GLOBAL_PATTERNS: readonly RegExp[] = [
  /所有项目/, /任何项目/, /每个项目/, /各个项目/, /跨项目/,
  /以后都/, /今后都/, /一律/, /永远都?/, /总是/,
  /不(?:管|论)哪(?:个|一)(?:项目|仓库)/,
  /\ball projects?\b/i, /\bevery project\b/i, /\bacross projects?\b/i,
  /\bfrom now on\b/i, /\balways\b/i,
]

/** 场景措辞：只有它才允许落场景层（场景是手动单选、默认不启用的，往里写等于让它消失）。 */
const SCENE_PATTERNS: readonly RegExp[] = [
  /这个场景/, /该场景/, /当前场景/, /本场景/, /在这个场景/,
  /写代码时/, /写文档时/, /做研究时/, /翻译时/,
  /\bin this scene\b/i, /\bthis scene\b/i,
]

export const hasGlobalPhrase = (text: string): boolean => GLOBAL_PATTERNS.some((re) => re.test(text))
export const hasScenePhrase = (text: string): boolean => SCENE_PATTERNS.some((re) => re.test(text))

export interface RouteInput {
  /** 正文（判措辞用）。 */
  text: string
  /** 证据来源：只有用户明说/纠正才可能升全局。 */
  source: EvidenceSource
  /** `writeTarget`（配置）。 */
  writeTarget: WriteTarget
  /** 工作区 hash16；取不到 cwd 时为 undefined。 */
  workspaceHash?: string
  /** 当前启用的场景名；没有启用场景时为 undefined。 */
  scene?: string
  /** 会话 id；拿不到时为 undefined。 */
  sessionId?: string
  /**
   * 模型显式要求的层（`memory_manager_auto` 的 `action=learn` 里的 `layer` 参数）。
   *
   * 它**只是"想要"**，不越过上限与环境：指定的层缺身份（比如要 session 但没有 sid）或
   * 超过 `writeTarget` 上限时照样压窄。理由：模型看不到"这个工作区有没有登记"、
   * 也不知道用户把上限设成了会话；给它一个能绕过上限的参数，等于让上限形同虚设。
   */
  forcedLayer?: MemoryLayer
}

export interface RouteResult {
  /** 最终落层。 */
  layer: MemoryLayer
  /** 目录 group：`global` / `<scene>` / `_ws/<hash16>` / `_session/<sid>`。 */
  group: string
  /** 按内容与环境算出的"想要"层（界面解释"为什么被降级"用）。 */
  desired: MemoryLayer
  /** 降级原因；没降级则没有这个键。 */
  degraded?: DegradeReason
}

export type DegradeReason = 'scope-too-narrow' | 'no-scene' | 'no-workspace' | 'no-session'

/** 降级原因的人话（界面与工具回执共用一份，避免两处措辞不同）。 */
export const DEGRADE_NOTE: Record<DegradeReason, string> = {
  'scope-too-narrow': '记到了本项目（当前的写入上限不允许全局）',
  'no-scene': '场景层已取消，记到了本项目',
  'no-workspace': '拿不到工作区路径，记到了全局',
  'no-session': '会话层已取消，记到了本项目',
}

export function routeLayer(input: RouteInput): RouteResult {
  // 只判两种层：**全局 / 本项目**。会话层与场景层已取消 —— 它们和用户记忆的场景单选
  // 绑在一起（一个场景开着就不能开别的），而自主记忆不参与那套机制。
  //
  // 判据刻意不交给模型：只有①用户明说/纠正且带明确跨项目措辞，或②显式 `layer=global`，
  // 才升全局；其余一律本项目。`forcedLayer` 里的 session/scene 一律按本项目解释。
  const wantsGlobal =
    input.forcedLayer === LAYER_GLOBAL ||
    ((input.source === 'user_explicit' || input.source === 'user_correction') && hasGlobalPhrase(input.text))

  const cap = capLayerOf(input.writeTarget)
  // `desired` 记**原始想要**，不随后续降级改写：界面解释"为什么被降级"靠它对照
  // （想要全局、落了本项目），改写了这句解释就没法生成。
  const desired: MemoryLayer = wantsGlobal ? LAYER_GLOBAL : LAYER_WORKSPACE
  let layer = desired
  let degraded: DegradeReason | undefined
  if (layer === LAYER_GLOBAL && cap !== LAYER_GLOBAL) {
    layer = LAYER_WORKSPACE
    degraded = 'scope-too-narrow'
  }
  let group: string
  if (layer === LAYER_GLOBAL) {
    group = 'global'
  } else if (input.workspaceHash) {
    group = `_ws/${input.workspaceHash}`
  } else {
    // 拿不到工作区身份时不静默丢：落到全局并留降级痕迹，界面会说明"这条没绑到本项目"。
    // 宁可多一条全局，也不要一条学完永远看不见的记忆。
    layer = LAYER_GLOBAL
    group = 'global'
    degraded = degraded ?? 'no-workspace'
  }

  return { layer, group, desired, ...(degraded !== undefined ? { degraded } : {}) }
}

/** 从 group 反推层；旧 `_session/` / 场景目录一律按本项目读（迁移后只作兼容）。 */
export function layerOfRoute(group: string): MemoryLayer {
  const head = String(group ?? '').split('/')[0]
  if (head === 'global') return LAYER_GLOBAL
  return LAYER_WORKSPACE
}
