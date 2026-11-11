// 会话最近的**用户原文**缓存：给证据门做逐字校验。
//
// 为什么需要它：`turn/end` 的载荷只有 `{turn, reason}`（见 dsh-session 的 types.d.ts），
// 而工具执行时拿不到"用户此前说过什么"。唯一的来源是 `session/event` 的 `user/message`
// （冷路径已在监听），它一次带一条、按落盘顺序到达，所以这里按**追加**累积。
//
// 为什么必须逐字而不是"意思对就行"：模型极容易把自己的总结当成用户的话。实测里
// "用户说了以后都用 pnpm" 与 "用户说要统一包管理器" 在语义上等价，但只有前者能核对。
// 要求 `includes`，能挡掉绝大多数编造 —— 而剩下那部分（模型直接抄一句用户真说过、
// 但意思相反的话）靠 `source` 与矛盾检测兜，不靠这里。
//
// 缓存纪律：
//   - 只留本会话最近若干条，按字节封顶（长对话不无限占内存）；
//   - 只收 `source.kind === 'user'`（或没有 source）的 user 消息 —— 其余 kind 都是各插件
//     注入的合成消息（`runtime-context` / `tool-registry` / 本插件的 `<system-reminder>`），
//     不是用户原话。模型引用它们不算"用户明说"。
//   - 会话结束不主动清（拿不到可靠信号），靠 LRU + TTL 自然淘汰。

/** 单个会话保留多少条用户消息。压缩后更早的原话不在了，模型也不该再引用它。 */
const MAX_MESSAGES = 24
/** 单个会话保留的用户文本总字节上限（约 16 KiB）。 */
const MAX_BYTES = 16 * 1024
/** 缓存多少个会话（LRU）。 */
const MAX_SESSIONS = 128
/** 多久没更新就丢弃（毫秒）。 */
const TTL_MS = 30 * 60 * 1000

interface SessionTexts {
  messages: string[]
  at: number
}

const store = new Map<string, SessionTexts>()

/** 从消息里抽纯文本。宽松处理：`content` 可能是字符串，也可能是 part 数组。 */
export function textOfMessage(msg: any): string {
  if (!msg || typeof msg !== 'object') return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue }
    if (!part || typeof part !== 'object') continue
    // 只取 text 型 part：工具调用 / 图片 / 附件都不是"用户说的话"。
    if (typeof part.text === 'string' && (part.type === undefined || part.type === 'text')) parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * 是不是用户真的说了这句话。
 *
 * **`kind === 'user'` 是真人输入**（`MessageSourceMap` 里 `user` 与 `user-rpc` 两种源的
 * kind 都是 `'user'`），其余非空 kind（`runtime-context` / `tool-registry` /
 * `working-directory` / 各插件自定义）都是注入的合成消息。早先这里写成"有 kind 就跳过"，
 * 等于把真人说的话也一起丢了 —— 症状是所有 `user_explicit` 都降级成候选（证据门报
 * `no-cache`），而开关看起来一切正常。这是本模块最容易写错的一行。
 */
export function isGenuineUserMessage(msg: any): boolean {
  const kind = msg && msg.source && typeof msg.source === 'object' ? msg.source.kind : undefined
  if (typeof kind !== 'string' || kind === '') return true
  return kind === 'user'
}

/**
 * 收下这一步的用户原话。
 *
 * 调用点只有 `session/event` 的 `user/message`，一次一条。所以这里是**追加**，不是替换：
 * 替换会让缓存恒为最后一句，模型再引用三轮前说过的原话时证据门判 `not-verbatim` 并**硬拒**
 * （不是降级）—— 「以后提交信息都写中文」这种话说完两轮就再也记不下来了。
 */
export function captureUserTexts(sessionId: string, messages: readonly unknown[]): void {
  if (!sessionId) return
  const collected: string[] = []
  for (const raw of messages) {
    const msg = raw as any
    if (!msg || msg.role !== 'user') continue
    if (!isGenuineUserMessage(msg)) continue
    const text = textOfMessage(msg).trim()
    if (text !== '') collected.push(text)
  }
  if (collected.length === 0) return
  const prev = store.get(sessionId)
  const all = [...(prev?.messages ?? [])]
  for (const text of collected) {
    // 同一句连着来两次（重放 / 重复事件）只留一条：引句核对按 `includes` 走，
    // 重复不改变结论，白占额度。
    if (all[all.length - 1] === text) continue
    all.push(text)
  }
  // 截断到条数与字节上限：从最新往回取，老的先丢。
  const kept: string[] = []
  let bytes = 0
  for (let i = all.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const size = Buffer.byteLength(all[i], 'utf8')
    if (bytes + size > MAX_BYTES && kept.length > 0) break
    kept.unshift(all[i])
    bytes += size
  }
  store.delete(sessionId)
  store.set(sessionId, { messages: kept, at: Date.now() })
  prune()
}

function prune(): void {
  const now = Date.now()
  for (const [sid, value] of store) {
    if (now - value.at > TTL_MS) store.delete(sid)
  }
  while (store.size > MAX_SESSIONS) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
}

/** 本会话最近的用户原文（从旧到新）。拿不到返回空数组。 */
export function recentUserTexts(sessionId: string): string[] {
  const value = store.get(sessionId)
  if (!value) return []
  if (Date.now() - value.at > TTL_MS) {
    store.delete(sessionId)
    return []
  }
  return value.messages
}

export type QuoteCheck =
  | { ok: true; /** 命中的是第几条（0 = 最早）。 */ index: number }
  | { ok: false; reason: 'empty' | 'no-cache' | 'not-verbatim' }

/**
 * 引句是否真是用户说过的**一段原文**。
 *
 * 逐条 `includes` 而不是拼接后 `includes`：拼接会让"上一句的结尾 + 下一句的开头"
 * 变成一个从没被说过的句子，而模型恰恰容易这样拼。
 */
export function checkQuote(sessionId: string, quote: string): QuoteCheck {
  const q = String(quote ?? '').trim()
  if (q === '') return { ok: false, reason: 'empty' }
  const texts = recentUserTexts(sessionId)
  if (texts.length === 0) return { ok: false, reason: 'no-cache' }
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].includes(q)) return { ok: true, index: i }
  }
  return { ok: false, reason: 'not-verbatim' }
}

/** 测试与「重置」用。 */
export function clearUserTexts(sessionId?: string): void {
  if (sessionId === undefined) store.clear()
  else store.delete(sessionId)
}

/** 诊断：本会话缓存了几条、多少字节。 */
export function userTextStats(sessionId: string): { messages: number; bytes: number } {
  const texts = recentUserTexts(sessionId)
  return { messages: texts.length, bytes: texts.reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0) }
}
