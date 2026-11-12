// 写入路由：一条自动记忆该落在哪一层。
//
// 三个轴是正交的：`layer` 是数据属性（谁能看见），`origin` 是谁写的，`allowed` 是策略
// （哪几层允许写）。本文件只算 `layer`；「开不开学习」由 `enabled` 在更外层判。
//
// 路由两步，顺序不能反：
//   ① 按**内容与环境**判"想要哪层"（下面 ROUTE_RULES）
//   ② 与两个开关的**允许层**求交
// 目标层被关掉时落到另一层并留痕（`degraded`），不静默改层；两层都不可用则 `blocked`，
// 由门禁给出明确错误 —— 拒绝比悄悄写到用户关掉的那一层好。

import { LAYER_GLOBAL, LAYER_WORKSPACE, type MemoryLayer } from '../memories/constants.js'


/** 两个自主记忆开关给出的允许层。 */
export interface RouteAllowed {
  global: boolean
  workspace: boolean
}

/**
 * 全局措辞。命中才允许升到全局层（还要叠加证据门：只有用户明说的才算）。
 *
 * 刻意收窄：只认"跨项目"与"永远/以后都"这两类**明确**表述。不认"一般"、"通常"、
 * "最好"——那些是偏好强度，不是作用域。误判的代价是把项目约定升级成所有项目的约定，
 * 而用户根本不知道它存在于全局层。
 *
 * 同样不认 `总是` / `always`：它们是**频率**，不是范围。"提交前总是先跑测试"在项目里说，
 * 说的是这个项目的习惯；升到全局层之后，用户在别的仓库也会看到它。自动确认开着时更没有
 * 卡片可以纠正 —— 这类词一个都不能留。
 */
const GLOBAL_PATTERNS: readonly RegExp[] = [
  /所有项目/, /任何项目/, /每个项目/, /各个项目/, /跨项目/,
  /以后都/, /今后都/, /一律/, /永远都?/,
  /不(?:管|论)哪(?:个|一)(?:项目|仓库)/,
  /\ball projects?\b/i, /\bevery project\b/i, /\bacross projects?\b/i,
  /\bfrom now on\b/i,
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
  /**
   * 这条有没有可核对的原话依据。只有它才可能升全局层。
   *
   * 早先判的是模型自报的 `source`：模型声明 `user_explicit` 就能把一条项目内的
   * 习惯抬到「所有项目」。现在来源由系统逐字比对引句得出；这个布尔只说明
   * 「正文命中了本会话用户原话」，是证据降级，不是人工核对。
   */
  quoted: boolean
  /** 两个开关给出的允许层。 */
  allowed: RouteAllowed
  /** 工作区 hash16；取不到 cwd 时为 undefined。 */
  workspaceHash?: string
  /** 当前启用的场景名；没有启用场景时为 undefined。 */
  scene?: string
  /** 会话 id；拿不到时为 undefined。 */
  sessionId?: string
  /**
   * 模型显式要求的层（`memory_note` 的 `action=learn` 里的 `layer` 参数）。
   *
   * 它**只是"想要"**，不越过开关与环境：指定的层关着或缺身份（比如要 workspace 但没有
   * cwd）时照样改落另一层。理由：模型看不到用户关掉了哪一层；给它一个能绕过开关的参数，
   * 等于让开关形同虚设。
   */
  forcedLayer?: MemoryLayer
}

export interface RouteResult {
  /** 最终落层。 */
  layer: MemoryLayer
  /** 目录 group：`global` / `_ws/<hash16>`。 */
  group: string
  /** 按内容与环境算出的"想要"层（界面解释"为什么被降级"用）。 */
  desired: MemoryLayer
  /** 降级原因；没降级则没有这个键。 */
  degraded?: DegradeReason
  /** 两层都不可用（或只开工作区但拿不到 cwd）：调用方应拒绝写入。 */
  blocked?: boolean
}

export type DegradeReason = 'layer-off' | 'no-workspace'

/** 降级原因的人话（界面与工具回执共用一份，避免两处措辞不同）。 */
export const DEGRADE_NOTE: Record<DegradeReason, string> = {
  'layer-off': '记到了另一层（想写的那一层在自主记忆设置里关着）',
  'no-workspace': '拿不到工作区路径，记到了全局',
}

export function routeLayer(input: RouteInput): RouteResult {
  // 只判两种层：**全局 / 本项目**。会话层与场景层已取消 —— 它们和用户记忆的场景单选
  // 绑在一起（一个场景开着就不能开别的），而自主记忆不参与那套机制。
  //
  // 显式 `forcedLayer` **压过内容措辞**：用户在对话卡片里选了「本工作区」，正文里恰好有
  // 「所有项目」时不能悄悄抬到全局 —— 那等于用户的选择没生效。没有显式层时才按内容判：
  // 只有用户明说 / 纠正且带明确跨项目措辞才升全局；其余一律本项目。`forcedLayer` 里的
  // session / scene 一律按本项目解释。
  const wantsGlobal = input.forcedLayer !== undefined
    ? input.forcedLayer === LAYER_GLOBAL
    : (input.quoted && hasGlobalPhrase(input.text))

  // `desired` 记**原始想要**，不随后续降级改写：界面解释"为什么被降级"靠它对照
  // （想要全局、落了本项目），改写了这句解释就没法生成。
  const desired: MemoryLayer = wantsGlobal ? LAYER_GLOBAL : LAYER_WORKSPACE
  let layer = desired
  let degraded: DegradeReason | undefined
  if (layer === LAYER_GLOBAL && !input.allowed.global) {
    layer = LAYER_WORKSPACE
    degraded = 'layer-off'
  } else if (layer === LAYER_WORKSPACE && !input.allowed.workspace) {
    layer = LAYER_GLOBAL
    degraded = 'layer-off'
  }

  // 目标层已经确定；只有工作区层需要 cwd。只开工作区又没有 cwd 时不能退到全局 ——
  // 那是用户明确关掉的一层，写进去等于开关失效。
  if (layer === LAYER_WORKSPACE) {
    if (!input.allowed.workspace) return { layer, group: '', desired, blocked: true }
    if (input.workspaceHash) return { layer, group: `_ws/${input.workspaceHash}`, desired, ...(degraded !== undefined ? { degraded } : {}) }
    if (input.allowed.global) {
      // 拿不到工作区身份时不静默丢：落到全局并留降级痕迹，界面会说明"这条没绑到本项目"。
      return { layer: LAYER_GLOBAL, group: 'global', desired, degraded: 'no-workspace' }
    }
    return { layer: LAYER_WORKSPACE, group: '', desired, degraded: 'no-workspace', blocked: true }
  }

  // 全局层：开关允许才走到这里；两者都关时也不该静默写全局。
  if (!input.allowed.global) return { layer: LAYER_GLOBAL, group: '', desired, blocked: true }
  return { layer: LAYER_GLOBAL, group: 'global', desired, ...(degraded !== undefined ? { degraded } : {}) }
}

/** 从 group 反推层；旧 `_session/` / 场景目录一律按本项目读（迁移后只作兼容）。 */
export function layerOfRoute(group: string): MemoryLayer {
  const head = String(group ?? '').split('/')[0]
  if (head === 'global') return LAYER_GLOBAL
  return LAYER_WORKSPACE
}
