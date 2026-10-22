// 会话导入用的转录稿解析。纯 node、不依赖 DSH：先判格式，再把 Claude Code / Cursor 的
// JSONL、Codex 风格的 Markdown 转录稿、或带前缀的普通文本，转成有序的
// `{ role: 'user' | 'assistant', text }` 轮次列表。

/** 开启一个 Markdown 轮次的标题行（`## User` / `### Assistant` …）。 */
const HEADING_RE = /^#{1,3}\s+(User|Human|Assistant|AI|Bot)\s*:?\s*$/i
/** Bold-prefix lines (`**User:** …` / `**User**: …`). */
const BOLD_PREFIX_RE = /^\*\*(User|Human|Assistant|AI|Bot):?\*\*\s*:?\s*(.*)$/i
/** Generic prefixed lines (`User: …` / `Assistant: …` / `用户：…`). */
const GENERIC_PREFIX_RE = /^(User|Human|用户|Assistant|AI|Bot|助手)\s*[:：]\s*(.*)$/i

/** 一轮对话：说话人角色 + 累积的正文文本。 */
export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
}

/** 把消息 content 摊平成文本（字符串 / 文本块数组 / 嵌套对象三种形状）。 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content) {
      if (typeof part === 'string') out += part
      else if (part && typeof part === 'object') {
        // JSON 块的实际形状由下方 typeof 运行时比较决定，这里按记录形状读取字段
        const record = part as Record<string, unknown>
        if (typeof record.text === 'string') out += record.text
        else if (typeof record.content === 'string') out += record.content
      }
    }
    return out
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

/** 收下一轮完整对话；正文为空的不收。 */
function flushTurn(current: TranscriptTurn | null, turns: TranscriptTurn[]): void {
  if (!current) return
  const text = String(current.text || '').trim()
  if (text) turns.push({ role: current.role, text })
}

/** 嗅探时最多看几行（见 `sniffFormat`）。 */
const SNIFF_LINES = 5

/**
 * 按**内容**嗅探转录格式。只看前若干条非空行，不读全篇。
 *
 * 为什么不是「只看第一行」：Claude Code 的转录稿常在正文前带 `summary` / `system` 行，
 * 那些行也是 JSON 但 `type` 不是 user/assistant；只看第一行会把它们判成 generic。
 * 只扫前 `SNIFF_LINES` 行是为了压低误报 —— 一份 Markdown 正文里偶然粘了一段
 * `{"role":"user"}` 的 API 载荷，不该让整份稿子按 JSONL 解析。
 * @returns {'jsonl' | 'markdown' | 'generic'}
 */
function sniffFormat(content: unknown): 'jsonl' | 'markdown' | 'generic' {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s)
  for (const line of lines.slice(0, SNIFF_LINES)) {
    if (!line.startsWith('{')) continue
    try {
      // JSON 值实际形状未知；若为对象，type/role 字段由下方运行时比较判定
      const obj = JSON.parse(line) as { type?: unknown; role?: unknown } | null
      if (
        obj && typeof obj === 'object' && !Array.isArray(obj) &&
        (obj.type === 'user' || obj.type === 'assistant' || obj.role === 'user' || obj.role === 'assistant')
      ) return 'jsonl'
    } catch (e) { /* 这一行不是 JSON，继续往下看 */ }
  }
  const first = lines[0] || ''
  if (HEADING_RE.test(first) || BOLD_PREFIX_RE.test(first)) return 'markdown'
  return 'generic'
}

/**
 * 判断转录稿格式。扩展名优先；文件名没有可识别的扩展名**或是 `.txt`** 时改看内容嗅探。
 *
 * `.txt` 走嗅探，不是无条件 generic：`.txt` 恰恰是**最常被改名**的
 * 扩展名 —— Claude Code / Cursor 的 JSONL、Markdown 转录稿都可能被存成 `transcript.txt`
 *（客户端拿不到文件名时自己就默认这个名字）。原来无条件判 generic，于是整份对话被折成
 * **一条 user 消息**、分轮结构全失、零警告，op 还回 `{ok:true,count:1}`。
 * `.jsonl` / `.md` 仍按扩展名直判（那两种名字下内容必然是同一种，嗅探没有收益）。
 * @returns {'jsonl' | 'markdown' | 'generic'}
 */
export function detectFormat(fileName: unknown, content: unknown): 'jsonl' | 'markdown' | 'generic' {
  const name = String(fileName || '').toLowerCase()
  if (/\.jsonl$/.test(name)) return 'jsonl'
  if (/\.(md|markdown)$/.test(name)) return 'markdown'
  return sniffFormat(content)
}

/**
 * 解析 Claude Code / Cursor 风格的 JSONL 转录稿。
 *
 * 认两种形状：`{type:'user'|'assistant', message:{role,content}}`（Claude Code）与
 * `{role, content}`（Cursor 一类）。system / tool 行跳过；相邻同角色的轮次合并。
 *
 * @param text 转录稿原文
 * @returns 按出现顺序排好的轮次
 */
export function parseJsonlTranscript(text: unknown): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let lastRole: 'user' | 'assistant' | null = null
  let lastText = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // JSONL 每行的实际形状未知；字段有效性由下方运行时比较判定
    let obj: { type?: unknown; role?: unknown; message?: unknown; content?: unknown } | null
    try { obj = JSON.parse(line) } catch (e) { continue }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue
    let role: 'user' | 'assistant' | null = null
    let content: unknown
    if (obj.type === 'user' || obj.type === 'assistant') {
      const message = (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message) ? obj.message : null) as { role?: unknown; content?: unknown } | null
      role = message && (message.role === 'user' || message.role === 'assistant') ? message.role : (obj.type === 'user' ? 'user' : 'assistant')
      content = message ? message.content : undefined
    } else if (obj.role === 'user' || obj.role === 'assistant') {
      role = obj.role
      content = obj.content
    }
    if (!role) continue
    const piece = extractText(content).trim()
    if (!piece) continue
    if (role === lastRole) {
      lastText += '\n' + piece
    } else {
      // lastText 非空 ⇒ lastRole 已随 lastText 同步赋值（非 null），类型层无法表达该不变式
      if (lastText) turns.push({ role: lastRole!, text: lastText })
      lastRole = role
      lastText = piece
    }
  }
  if (lastText) turns.push({ role: lastRole!, text: lastText })
  return turns
}

/**
 * 按标题行或加粗前缀标记（`## User` / `### Assistant` / `**User:**` …）把 Markdown
 * 转录稿切成轮次。正文行累积到当前轮次，直到下一个标记出现。
 *
 * @param text 转录稿原文
 * @returns 按出现顺序排好的轮次
 */
export function parseMarkdownTranscript(text: unknown): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let current: TranscriptTurn | null = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = line.match(HEADING_RE)
    if (heading) {
      flushTurn(current, turns)
      current = { role: isAssistantLabel(heading[1]) ? 'assistant' : 'user', text: '' }
      continue
    }
    const bold = line.match(BOLD_PREFIX_RE)
    if (bold) {
      flushTurn(current, turns)
      current = { role: isAssistantLabel(bold[1]) ? 'assistant' : 'user', text: String(bold[2] || '').trim() }
      continue
    }
    if (current) current.text += (current.text ? '\n' : '') + line
  }
  flushTurn(current, turns)
  return turns
}

/**
 * 解析带前缀的普通文本。以 `User:` / `Assistant:` / `用户：` / `助手：` 开头的行开启新
 * 轮次，其余行追加到当前轮次。一个标记都没有时，整段文本算一条 user 轮次。
 *
 * @param text 转录稿原文
 * @returns 按出现顺序排好的轮次
 */
export function parseGenericText(text: unknown): TranscriptTurn[] {
  const lines = String(text || '').split(/\r?\n/)
  if (!lines.some((line) => GENERIC_PREFIX_RE.test(line.trim()))) {
    const whole = String(text || '').trim()
    return whole ? [{ role: 'user', text: whole }] : []
  }
  const turns: TranscriptTurn[] = []
  let current: TranscriptTurn | null = null
  for (const line of lines) {
    const m = line.match(GENERIC_PREFIX_RE)
    if (m) {
      flushTurn(current, turns)
      current = { role: isAssistantLabel(m[1]) ? 'assistant' : 'user', text: String(m[2] || '').trim() }
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line
    }
  }
  flushTurn(current, turns)
  return turns
}

/** Map a speaker label to the assistant role (AI / Bot / Assistant / 助手). */
function isAssistantLabel(label: string): boolean {
  return /^(assistant|ai|bot|助手)$/i.test(label)
}
