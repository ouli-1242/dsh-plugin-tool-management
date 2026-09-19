// src/imports/parsers.js — transcript parsing for conversation import.
// Pure Node, no DSH dependencies: detect format, then convert a Claude Code /
// Cursor JSONL, a Codex-style Markdown transcript, or generic prefixed text
// into an ordered list of `{ role: 'user' | 'assistant', text }` turns.

/** Heading lines that begin a Markdown turn (`## User` / `### Assistant` …). */
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

/** Flatten a message content value (string, text-block array, or nested object) to text. */
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

/** Push a finished turn, trimming empty bodies. */
function flushTurn(current: TranscriptTurn | null, turns: TranscriptTurn[]): void {
  if (!current) return
  const text = String(current.text || '').trim()
  if (text) turns.push({ role: current.role, text })
}

/**
 * Detect the transcript format. Extension wins; content sniffing only applies
 * when the name carries no recognized extension.
 * @returns {'jsonl' | 'markdown' | 'generic'}
 */
export function detectFormat(fileName: unknown, content: unknown): 'jsonl' | 'markdown' | 'generic' {
  const name = String(fileName || '').toLowerCase()
  if (/\.jsonl$/.test(name)) return 'jsonl'
  if (/\.(md|markdown)$/.test(name)) return 'markdown'
  if (/\.txt$/.test(name)) return 'generic'
  const first = String(content || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s) || ''
  if (first.startsWith('{')) {
    try {
      // JSON 值实际形状未知；若为对象，type/role 字段由下方运行时比较判定
      const obj = JSON.parse(first) as { type?: unknown; role?: unknown } | null
      if (obj && typeof obj === 'object' && (obj.type === 'user' || obj.type === 'assistant' || obj.role === 'user' || obj.role === 'assistant')) return 'jsonl'
    } catch (e) { /* not JSONL after all */ }
  }
  if (HEADING_RE.test(first) || BOLD_PREFIX_RE.test(first)) return 'markdown'
  return 'generic'
}

/**
 * Parse a Claude Code / Cursor style JSONL transcript.
 * Recognizes `{type:'user'|'assistant', message:{role,content}}` (Claude Code)
 * and `{role, content}` (Cursor-like). System/tool lines are skipped; adjacent
 * turns with the same role are merged.
 * @returns {Array<{role:'user'|'assistant', text:string}>}
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
 * Parse a Markdown transcript into turns by heading or bold-prefix markers
 * (`## User`, `### Assistant`, `**User:**`, …). Content lines accumulate under
 * the current turn until the next marker.
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
 * Parse generic prefixed text. Lines starting with `User:` / `Assistant:` /
 * `用户：` / `助手：` begin a new turn; everything else appends to the current
 * one. When no marker is present the whole text becomes one user turn.
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
