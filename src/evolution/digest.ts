// 轮内捕获（冷路径的第一段）：把一轮里发生的事压成一份小摘要。
//
// 为什么不能只靠 `turn/end`：它的载荷只有 `{ turn, reason }`（`@deepseek-ai/dsh-session`
// 的 `types.d.ts`），不带消息。复习阶段要"这一轮用户说了什么、工具查到了什么"，只能从
// `session/event` 一路攒下来。
//
// 三条纪律：
//   1. **只攒摘要，不攒全文**。用户消息留原文（证据门要逐字核对），工具结果截断到 500 字，
//      assistant 只记"请求了哪些工具"——它的正文是模型的自我叙述，不是事实来源。
//   2. **内存态，崩溃即丢**。这是有意的：丢一轮摘要比写错一条记忆好。宿主的会话日志
//      本来就能回放，真需要补的时候从那边重建，不要在这里做持久化。
//   3. **有上限**。长对话里 digest 是纯内存增长点，每个会话只留最近几个轮次。

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

export interface TurnDigest {
  turn: number
  events: DigestEvent[]
  /** 用户在本轮说过的原文（证据门的逐字来源）。 */
  userTexts: string[]
  /** 本轮 assistant 请求过的工具名（去重）。 */
  tools: string[]
  /** callId → 工具名：`tool/result` 只带 callId，名字在 assistant 的 tool-call 块里。 */
  toolNames: Map<string, string>
}

/** 每条事件的文本上限（字符）。工具输出常常整屏，摘要只需要"它说了什么"这一层。 */
export const MAX_EVENT_TEXT = 500
/** 单个轮次最多记多少条事件。 */
export const MAX_EVENTS_PER_TURN = 40
/** 单个会话保留几个轮次（超了丢最旧）。 */
export const MAX_TURNS_PER_SESSION = 4
/** 最多跟踪多少个会话。 */
const MAX_SESSIONS = 256

/** 用户原文里出现这些，说明"这句值得记"（只是**要不要复习**的信号，不是写入判据）。 */
const EXPLICIT_RE = /(记住|记一下|记好|以后都|以后别|以后不要|一律|总是|每次都|别再|不要再|统一用|统一成|从现在起|from now on|always use|never use|remember (this|that))/i
/** 纠正信号。 */
const CORRECTION_RE = /(不对|不是这样|不是这个|应该是|改成|纠正一下|其实(是|应该)|说错了|actually|not .{1,20} but|should be)/i
/** 反问：含"不对/不是"但以问号结尾的，不算纠正。 */
const QUESTION_RE = /[？?]\s*$/

/** 一句话里的信号。导出是为了单独测：启发式写错了会让"该复习的轮次"整批消失。 */
export function signalsOf(text: string): { explicit: boolean; correction: boolean } {
  const s = String(text ?? '')
  if (s.trim() === '') return { explicit: false, correction: false }
  const question = QUESTION_RE.test(s.trim())
  return {
    explicit: !question && EXPLICIT_RE.test(s),
    // 「不是这样吗？」是确认，不是纠正。问句里只保留显式的"应该是"。
    correction: CORRECTION_RE.test(s) && (!question || /应该是|改成|纠正/.test(s)),
  }
}

/**
 * 这一轮值不值得复习。
 *
 * 返回的 `reason` 会写进 episode：用户事后想知道"为什么这轮被复习了 / 没被复习"，
 * 只有一个布尔值是回答不了的。
 */
export function reviewDecision(
  digest: TurnDigest,
  reviewEveryTurns: number,
): { review: boolean; reason: 'signal' | 'tools' | 'periodic' | 'none'; signals: { explicit: number; correction: number } } {
  let explicit = 0
  let correction = 0
  for (const text of digest.userTexts) {
    const s = signalsOf(text)
    if (s.explicit) explicit++
    if (s.correction) correction++
  }
  if (explicit > 0 || correction > 0) return { review: true, reason: 'signal', signals: { explicit, correction } }
  // 用了两次以上工具：可能"查出来一个值得记的事实"（tool_verified 的前提）。
  if (digest.tools.length >= 2) return { review: true, reason: 'tools', signals: { explicit, correction } }
  const every = Math.max(1, Math.floor(reviewEveryTurns || 0))
  if (digest.turn > 0 && digest.turn % every === 0) return { review: true, reason: 'periodic', signals: { explicit, correction } }
  return { review: false, reason: 'none', signals: { explicit, correction } }
}

interface SessionDigests {
  turns: Map<number, TurnDigest>
  at: number
}

export interface DigestStore {
  /** 收一条事件。拿不到 turn 时（`turn/start` 之前的消息）用 0 兜底。 */
  capture(sessionId: string, turn: number, event: Omit<DigestEvent, 'at'> & { at?: number }): void
  /** 记一次工具调用（`tool/call` 事件），供后面的 tool/result 查名字。 */
  noteToolCall(sessionId: string, turn: number, callId: string, name: string): void
  /** 按 callId 查这一轮调用的工具名（查不到返回空串）。 */
  toolNameOf(sessionId: string, turn: number, callId: string): string
  /** 封存并取走这一轮的摘要（取走后即清空）。 */
  seal(sessionId: string, turn: number): TurnDigest | undefined
  /** 丢掉（开关关掉 / 判定不值得复习 / 会话结束）。 */
  drop(sessionId: string, turn?: number): void
  /** 诊断与测试用。 */
  stats(): { sessions: number; turns: number }
}

export function createDigestStore(): DigestStore {
  const store = new Map<string, SessionDigests>()

  const bucketOf = (sessionId: string): SessionDigests => {
    let hit = store.get(sessionId)
    if (hit) {
      // LRU：读一次就挪到末尾（Map 的插入序）。
      store.delete(sessionId)
      store.set(sessionId, hit)
      hit.at = Date.now()
      return hit
    }
    hit = { turns: new Map(), at: Date.now() }
    store.set(sessionId, hit)
    while (store.size > MAX_SESSIONS) {
      const oldest = store.keys().next()
      if (oldest.done) break
      store.delete(oldest.value)
    }
    return hit
  }

  function digestOf(sessionId: string, turn: number): TurnDigest {
    const bucket = bucketOf(sessionId)
    let d = bucket.turns.get(turn)
    if (!d) {
      d = { turn, events: [], userTexts: [], tools: [], toolNames: new Map() }
      bucket.turns.set(turn, d)
      // 只留最近几个轮次：一个会话的 digest 是内存里最容易无界增长的东西。
      while (bucket.turns.size > MAX_TURNS_PER_SESSION) {
        const oldest = bucket.turns.keys().next()
        if (oldest.done) break
        bucket.turns.delete(oldest.value)
      }
    }
    return d
  }

  return {
    capture(sessionId, turn, event) {
      if (sessionId === '') return
      const d = digestOf(sessionId, Math.max(0, Math.floor(turn)))
      const text = event.text === undefined ? undefined : String(event.text).slice(0, MAX_EVENT_TEXT)
      d.events.push({
        kind: event.kind,
        ...(text !== undefined && text !== '' ? { text } : {}),
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
        ...(event.ok !== undefined ? { ok: event.ok } : {}),
        at: event.at ?? Date.now(),
      })
      if (d.events.length > MAX_EVENTS_PER_TURN) d.events.splice(0, d.events.length - MAX_EVENTS_PER_TURN)
      if (event.kind === 'user' && text !== undefined && text !== '') d.userTexts.push(text)
      if (event.tool !== undefined && event.tool !== '' && !d.tools.includes(event.tool)) d.tools.push(event.tool)
    },

    noteToolCall(sessionId, turn, callId, name) {
      if (sessionId === '' || callId === '' || name === '') return
      digestOf(sessionId, Math.max(0, Math.floor(turn))).toolNames.set(callId, name)
    },

    toolNameOf(sessionId, turn, callId) {
      if (sessionId === '' || callId === '') return ''
      const bucket = store.get(sessionId)
      const d = bucket?.turns.get(Math.max(0, Math.floor(turn)))
      return d?.toolNames.get(callId) ?? ''
    },

    seal(sessionId, turn) {
      const bucket = store.get(sessionId)
      if (!bucket) return undefined
      const d = bucket.turns.get(turn)
      if (!d) return undefined
      bucket.turns.delete(turn)
      if (bucket.turns.size === 0) store.delete(sessionId)
      return d
    },

    drop(sessionId, turn) {
      if (turn === undefined) {
        store.delete(sessionId)
        return
      }
      const bucket = store.get(sessionId)
      if (!bucket) return
      bucket.turns.delete(turn)
      if (bucket.turns.size === 0) store.delete(sessionId)
    },

    stats() {
      let turns = 0
      for (const bucket of store.values()) turns += bucket.turns.size
      return { sessions: store.size, turns }
    },
  }
}

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
