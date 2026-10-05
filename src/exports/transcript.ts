// 会话转录导出：把宿主的 SessionEvent[] 提成可再导入的转录文本。
//
// 从 src/index.ts 剥出来（0.18.5），同时补上两件事：
//
// 1. **按块类型取文本**。宿主的内容块是带 type 标签的联合（dsh-llm types.d.ts:114-122）：
//    `text` 是用户可见正文，`reasoning` 是思考，`tool-call` 是模型发起的调用。此前导出走
//    `extractText`，它只判「这个对象有没有 text 字段」—— 而 `ReasoningBlock` 恰好就是
//    `{type:'reasoning', text}`，所以**思考一直混在助手正文里导出去**。同一类缺陷 0.16.x
//    已在子智能体侧用 `textOfBlocks` 修过（persona-parse.ts:275），导出侧是它的第二个出口。
// 2. **导出分三档，且是累进的**：正文 → 另加工具 → 再加思考。每档都是上一档的超集，
//    所以一个下拉就说得清（两个独立勾选框是另一种答案，用户不要）。
//    三档仍是**可读转录，不是完整备份**：每块有上限并明说截断，token 统计与压缩结构不在里面。
//
// `extractText` 本身不动：它服务的是外部文件导入，那份宽松是故意的（外来转录稿没有
// `reasoning` 词表可守）。
import { textOfBlocks } from '../subagents/persona-parse.js'

/**
 * 导出内容档位，**累进**：每一档都是上一档的超集。
 *
 * `simple` 只有正文；`tools` 另加工具调用与结果、附件名；`full` 再加思考。
 * 中间档只可能是「带工具、不带思考」这一个方向 —— 思考是模型对自己干了什么的叙述，
 * 没有工具调用就没有它叙述的对象，反过来那一档没有意义。
 */
export type ExportDetail = 'simple' | 'tools' | 'full'

/** 一轮对话。`details` 是比简洁档多出来的附加段，顺序即渲染顺序；简洁档恒空。 */
export interface ExportTurn {
  role: 'user' | 'assistant'
  /** 用户可见正文：**只来自 type === 'text' 的块**。 */
  text: string
  details: Array<{ label: string; text: string }>
}

// 上限是**病态保护**：工具结果可以是一次几 MB 的文件读取，不设限的话一个会话就能
// 导出上百 MB。取最靠前的那一段 —— 工具输出的头部几乎总是最有用的那部分。
const REASONING_MAX = 6000
const TOOL_INPUT_MAX = 1000
const TOOL_RESULT_MAX = 2000

/** 裁到 max 个字符并留下标记。标记固定英文：op 跑在服务端，没有客户端词典可用。 */
function cap(text: string, max: number): string {
  const s = String(text || '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars]`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

function formatBytes(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return 'unknown size'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`
  return `${(Math.round((v / 1024 / 1024) * 10) / 10).toFixed(1)} MB`
}

/** 附件只报名字 / 类型 / 尺寸 / 字节数 —— `attachmentId` 官方定义为不透明串，进了转录稿只是噪声。 */
function attachmentLines(content: unknown): string {
  const lines: string[] = []
  for (const block of blocksOf(content)) {
    const ref = (block.attachment && typeof block.attachment === 'object' ? block.attachment : {}) as Record<string, unknown>
    if (block.type === 'image') {
      const media = str(ref.mediaType) || 'image'
      const w = Number(ref.width); const h = Number(ref.height)
      const dims = Number.isFinite(w) && Number.isFinite(h) ? ` ${w}×${h}` : ''
      const name = str(ref.name)
      lines.push(`image: ${name ? name + ' — ' : ''}${media}${dims} (${formatBytes(ref.bytes)})`)
    } else if (block.type === 'file') {
      lines.push(`file: ${str(ref.name) || '(未命名)'} (${formatBytes(ref.bytes)})`)
    }
  }
  return lines.join('\n')
}

function toolLabel(name: string, kind: string, failed = false): string {
  return `Tool: ${name} — ${kind}${failed ? ' (failed)' : ''}`
}

/**
 * 把会话事件提成导出用的轮次。
 *
 * 工具的**发起**在两处都有记录：`assistant/message` 里的 `tool-call` 块（模型可见真相），
 * 与 log-only 的 `tool/call` 事件（持久化记录）。两边都收、按 call id 去重 —— 只认一边
 * 会在某种宿主形状下静默丢掉全部工具调用，而"导出里看不见工具调用"正是这份文件此前的毛病。
 * 配不上任何调用的 `tool/result` 也照样单独成段，同样不静默丢。
 */
export function extractExportTurns(events: unknown[], detail: ExportDetail): ExportTurn[] {
  const wantTools = detail !== 'simple'
  const wantThinking = detail === 'full'
  const turns: ExportTurn[] = []
  const namesByCallId = new Map<string, string>()
  const emittedCallIds = new Set<string>()
  let current: ExportTurn | null = null

  const flush = () => {
    // 空正文 + 空附加段 = 这一轮什么都没有，不占位。
    if (current && (current.text || current.details.length)) turns.push(current)
    current = null
  }
  /** 工具细节总归属于助手轮；正文已经翻篇时就另起一轮。 */
  const openAssistant = (): ExportTurn => {
    if (!current || current.role !== 'assistant') {
      flush()
      current = { role: 'assistant', text: '', details: [] }
    }
    return current
  }

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue
    const e = event as { type?: unknown; data?: unknown }
    const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>

    if (e.type === 'user/message') {
      flush()
      const turn: ExportTurn = { role: 'user', text: textOfBlocks(data.content, 'text'), details: [] }
      // 附件跟工具一起进中间档：它是「对话里出现过什么」的一部分，不是「模型想了什么」。
      if (wantTools) {
        const attachments = attachmentLines(data.content)
        if (attachments) turn.details.push({ label: 'Attachment', text: attachments })
      }
      current = turn
      continue
    }

    if (e.type === 'assistant/message') {
      flush()
      const message = (data.message && typeof data.message === 'object' ? data.message : {}) as { content?: unknown }
      const turn: ExportTurn = { role: 'assistant', text: textOfBlocks(message.content, 'text'), details: [] }
      // 顺序即模型产出的顺序：先思考、后调用。两档都开时（full）这个次序天然成立，
      // 因为 full 必然也开 wantTools。
      if (wantThinking) {
        const reasoning = textOfBlocks(message.content, 'reasoning')
        if (reasoning) turn.details.push({ label: 'Thinking', text: cap(reasoning, REASONING_MAX) })
      }
      if (wantTools) {
        for (const block of blocksOf(message.content)) {
          if (block.type !== 'tool-call') continue
          const id = str(block.id)
          const name = str(block.name) || '(unnamed)'
          if (id) { namesByCallId.set(id, name); emittedCallIds.add(id) }
          turn.details.push({ label: toolLabel(name, 'in'), text: cap(str(block.arguments), TOOL_INPUT_MAX) })
        }
      }
      current = turn
      continue
    }

    // 往下只剩工具与结果两类事件，中间档就要，只有简洁档跳过。
    if (!wantTools) continue

    if (e.type === 'tool/call') {
      const id = str(data.callId)
      const name = str(data.name) || namesByCallId.get(id) || '(unnamed)'
      if (id) namesByCallId.set(id, name)
      // assistant 块里已经列过同一个调用，就别重复成段。
      if (id && emittedCallIds.has(id)) continue
      if (id) emittedCallIds.add(id)
      openAssistant().details.push({ label: toolLabel(name, 'in'), text: cap(str(data.arguments), TOOL_INPUT_MAX) })
      continue
    }

    if (e.type === 'tool/result') {
      const message = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>
      const id = str(message.toolCallId)
      const name = namesByCallId.get(id) || '(unknown)'
      const failed = message.isError === true
      const body = textOfBlocks(message.content, 'text')
      const blocks = blocksOf(message.content)
      openAssistant().details.push({
        label: toolLabel(name, 'out', failed),
        text: cap(body || (blocks.length ? `(无文本输出，${blocks.length} 个内容块)` : '(无输出)'), TOOL_RESULT_MAX),
      })
      // `error` 官方注释明说它在模型可见消息之外 —— 带工具的那两档是用户唯一能看到它的地方。
      const err = (data.error && typeof data.error === 'object' ? data.error : undefined) as { name?: unknown; code?: unknown; reason?: unknown } | undefined
      if (err) {
        const reason = str(err.reason) || str(err.code) || str(err.name)
        if (reason) openAssistant().details.push({ label: toolLabel(name, 'error'), text: cap(`${str(err.name)}/${str(err.code)} — ${reason}`, TOOL_RESULT_MAX) })
      }
      continue
    }
  }
  flush()
  return turns
}

/**
 * 把载荷整段缩进 4 空格。
 *
 * 这是**回流保护**，不是排版：工具结果可以是任意文件内容，读进一份 markdown 转录稿就会把
 * 里面的 `## User` 原样吐进助手正文，再导入时把轮次劈开。缩进同时废掉 `HEADING_RE` 与
 * `BOLD_PREFIX_RE` 两个行首锚点（两者都不允许前导空白）。空行保持真空，不留尾随空格。
 */
function indentBlock(text: string): string {
  return String(text || '')
    .split('\n')
    .map((line) => (line.trim() ? `    ${line}` : ''))
    .join('\n')
}

/**
 * 序列化为可再导入的转录文本：Codex 风格 Markdown 或 Claude Code 风格 JSONL。
 *
 * 签名与 0.18.5 之前一致 —— 附加信息全在 `turn.details` 里，所以 `details` 为空时两种输出
 * 与旧版逐字节相同。`## User` / `### Assistant` 两级标题不能改：导入侧靠它切轮次与嗅探格式。
 */
export function serializeTranscript(turns: ExportTurn[], format: 'markdown' | 'jsonl'): string {
  const list = Array.isArray(turns) ? turns : []
  if (format === 'jsonl') {
    // content 保持**字符串**：改成类型化块数组的话，导入侧的 extractText 会把 reasoning
    // 又拼回正文（正是我们在修的那个泄漏），并让 tool-call 无声消失 —— 严格劣于字符串。
    return list
      .map((turn) => {
        let content = turn.text
        for (const item of turn.details) content += `${content ? '\n\n' : ''}[${item.label}]\n${item.text}`
        return JSON.stringify({ type: turn.role, message: { role: turn.role, content } })
      })
      .join('\n')
  }
  return list
    .map((turn) => {
      const head = turn.role === 'user' ? '## User' : '### Assistant'
      const blocks = [turn.text ? `${head}\n${turn.text}` : head]
      // 四级标题：`#{1,3}` 匹配不到，所以附加段再导入时只会并入所属轮次，不会伪装成边界。
      for (const item of turn.details) blocks.push(`#### ${item.label}\n${indentBlock(item.text)}`)
      return blocks.join('\n\n')
    })
    .join('\n\n')
}
