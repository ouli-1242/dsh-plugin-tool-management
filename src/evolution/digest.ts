// episode 的形状与两种构造方式（冷路径的落盘格式）。
//
// 现在唯一的**生产**来源是官方 `compaction/summary`（`checkpointEpisodeOf`）。旧版按轮次
// 攒 digest 的那一套（轮内捕获 / 值不值得复习的启发式）已经没有调用点，删掉了 —— 那份
// 摘要信息密度低，而且压缩 checkpoint 本来就是同一段对话更高密度的提炼。
//
// `episodeOf` / `TurnDigest` 留着：盘上可能还有升级前排队、没复习完的旧 episode，
// 读回来的形状必须仍然可构造、复习提示里也仍按旧版式渲染。

export type DigestEventKind = 'user' | 'assistant' | 'tool'

export interface DigestEvent {
  kind: DigestEventKind
  /** 用户原文 / 工具输出摘要；assistant 事件不带正文。 */
  text?: string
  /** 工具名（tool 事件）。 */
  tool?: string
  /** 工具是否失败。 */
  ok?: boolean
  at: number
}

/** 旧版轮次摘要的形状；只给 `episodeOf` 与旧数据读取用。 */
export interface TurnDigest {
  turn: number
  events: DigestEvent[]
  /** 用户在本轮说过的原文（证据门的逐字来源）。 */
  userTexts: string[]
  /** 本轮 assistant 请求过的工具名（去重）。 */
  tools: string[]
}

/** 单个轮次最多记多少条事件。 */
export const MAX_EVENTS_PER_TURN = 40

/**
 * 轮次结束后落盘的那份 episode（摘要，不是全文）。
 *
 * 字段刻意保守：只放"复习时真的会用到的"。整份会话日志宿主自己有，这里再存一遍
 * 只会让 episodes 目录变成一个更难查的副本。
 */
export interface Episode {
  id: string
  session: string
  turn: number
  at: string
  cwd?: string
  workspaceHash?: string
  /** 为什么复习它（compaction / signal / tools / periodic）。 */
  reason: string
  userTexts: string[]
  tools: string[]
  events: Array<{ kind: DigestEventKind; text?: string; tool?: string; ok?: boolean; at: number }>
  /** 官方压缩 checkpoint 的纯文本；只有压缩触发的复习才有。 */
  checkpoint?: string
}

/** 旧版按轮次复习产出的 episode；现在只为兼容盘上已排队的旧项保留。 */
export function episodeOf(digest: TurnDigest, meta: { session: string; at: string; reason: string; cwd?: string; workspaceHash?: string }): Episode {
  return {
    id: `${meta.session}:${digest.turn}`,
    session: meta.session,
    turn: digest.turn,
    at: meta.at,
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
    ...(meta.workspaceHash !== undefined ? { workspaceHash: meta.workspaceHash } : {}),
    reason: meta.reason,
    userTexts: digest.userTexts.slice(-8),
    tools: digest.tools.slice(-12),
    events: digest.events.slice(-MAX_EVENTS_PER_TURN),
  }
}

/**
 * 官方 `compaction/summary` 产出的 episode。
 *
 * `seq` 是官方 session log 的序号，压缩事件在同一会话里单调，用它当 turn 既稳定又不会
 * 与旧版按轮号建的 episode 撞名（旧 id 是 `<session>:<turn>`，这里是 `<session>:compact:<seq>`）。
 * checkpoint 是模型转述，不是用户原话 —— userTexts / tools 一律留空，证据门不该拿到
 * 一份看似「用户说过」的文本。
 */
export function checkpointEpisodeOf(input: {
  session: string
  seq: number
  at: string
  checkpoint: string
  cwd?: string
  workspaceHash?: string
}): Episode {
  return {
    id: `${input.session}:compact:${input.seq}`,
    session: input.session,
    turn: Math.max(0, Math.floor(input.seq)),
    at: input.at,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.workspaceHash !== undefined ? { workspaceHash: input.workspaceHash } : {}),
    reason: 'compaction',
    userTexts: [],
    tools: [],
    events: [],
    checkpoint: input.checkpoint,
  }
}
