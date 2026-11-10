// 复习器（冷路径的第二段）：轮末异步把 digest 过一遍，挑出值得记的几条。
//
// 为什么值得多花一次模型调用：热路径（`memory_note` 的 `action=learn`）靠模型在对话中"顺手"记，
// 但它正忙着解决用户的问题，注意力不在"这句话以后还用得上吗"。轮末它已经交差了，同样
// 一段对话再看一遍，判断质量完全不同。这也是 Claude Code / Codex 那类 harness 的做法：
// 记忆不是对话的副产品，是**对话结束后的独立工序**。
//
// 三条纪律：
//   1. **严格 JSON**：只接受白名单字段；解析不出来就整批丢弃，不重试（模型已经跑偏，
//      重试只会更贵）。逐条过九道门，复习器不是后门。
//   2. **成本上限**：每会话最多 `maxReviewsPerSession` 次。超了直接跳过并在 outbox 记
//      原因 —— 这条不是省钱，是防止长对话越跑越慢。
//   3. **失败不阻塞会话**：这里的所有异常都吞掉并写日志。用户不该因为记忆整理失败
//      看到报错，更不该等它。

import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import type { Episode } from './digest.js'
import type { OutboxItem, ReviewLearnedItem } from './episodes.js'
import { MAX_AUTO_TEXT_WIDTH, MAX_AUTO_TITLE_WIDTH, type Learner } from './write.js'
import { truncateToWidth } from '../text-width.js'
import { normalizeNoteStyle, noteStyleGuideOf, type CustomNoteStyle, type EffectiveEvolutionConfig } from './config.js'

/** 一次复习最多落几条。多了就是在把摘要改写成记忆库，那不是复习。 */
export const MAX_ITEMS_PER_REVIEW = 3
/** 单次请求的输出上限（token）。 */
const MAX_OUTPUT_TOKENS = 900
/** 单次请求的超时。超了就按失败处理，下一轮再试。 */
const REVIEW_TIMEOUT_MS = 45_000

export interface ReviewItem {
  text: string
  /** 行名 / 注入行的加粗名；缺省时列表按正文首句兜底。 */
  title?: string
  kind?: 'preference' | 'fact' | 'correction' | 'procedure'
  source: 'user_explicit' | 'user_correction' | 'tool_verified' | 'model_inference'
  quote?: string
  key?: string
  boundary?: string
  layer?: 'global' | 'workspace' | 'scene' | 'session'
  ttlDays?: number
}

const SOURCES = new Set(['user_explicit', 'user_correction', 'tool_verified', 'model_inference'])
const KINDS = new Set(['preference', 'fact', 'correction', 'procedure'])
const LAYERS = new Set(['global', 'workspace', 'scene', 'session'])

/**
 * 从模型输出里抽出 JSON 对象。
 *
 * 三种常见形态都要认：整段就是 JSON、包在 ```json 里、前后带一句人话。
 * 用"第一个 { 到最后一个 }"而不是正则匹配平衡括号：模型的 JSON 里可能有嵌套对象，
 * 正则数不准；而多截一段的后果只是 JSON.parse 失败，与直接放弃等价。
 */
export function extractJson(text: string): unknown {
  const s = String(text ?? '').trim()
  if (s === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const candidates = [fenced ? fenced[1]! : s]
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1))
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim())
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * 校验并裁剪模型给的条目。
 *
 * **越界字段直接丢，不整批拒**：一条写错了 kind 不该让另外两条也白跑。
 * 但缺 `text` / `source` 的条目要丢 —— 那两个是写入管线的必填项，补不出来。
 */
export function parseReviewItems(raw: unknown): ReviewItem[] {
  const box = raw && typeof raw === 'object' ? (raw as { memories?: unknown; items?: unknown }) : {}
  const list = Array.isArray(box.memories) ? box.memories : Array.isArray(box.items) ? box.items : []
  const out: ReviewItem[] = []
  for (const row of list) {
    if (out.length >= MAX_ITEMS_PER_REVIEW) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const text = typeof r.text === 'string' ? truncateToWidth(r.text.trim(), MAX_AUTO_TEXT_WIDTH) : ''
    const source = typeof r.source === 'string' && SOURCES.has(r.source) ? (r.source as ReviewItem['source']) : 'model_inference'
    if (text === '') continue
    const item: ReviewItem = { text, source }
    const title = typeof r.title === 'string' ? truncateToWidth(r.title.trim(), MAX_AUTO_TITLE_WIDTH) : ''
    if (title !== '') item.title = title
    if (typeof r.kind === 'string' && KINDS.has(r.kind)) item.kind = r.kind as ReviewItem['kind']
    if (typeof r.quote === 'string' && r.quote.trim() !== '') item.quote = r.quote.trim().slice(0, 2000)
    if (typeof r.key === 'string' && r.key.trim() !== '') item.key = r.key.trim().slice(0, 80)
    if (typeof r.boundary === 'string' && r.boundary.trim() !== '') item.boundary = r.boundary.trim().slice(0, 500)
    if (typeof r.layer === 'string' && LAYERS.has(r.layer)) item.layer = r.layer as ReviewItem['layer']
    if (typeof r.ttlDays === 'number' && Number.isFinite(r.ttlDays) && r.ttlDays > 0) item.ttlDays = Math.min(3650, Math.floor(r.ttlDays))
    out.push(item)
  }
  return out
}

/** 拼复习用的 prompt。导出是为了能单独看它长什么样（测试里也钉住"不塞全文"）。 */
export function buildReviewPrompt(episode: Episode, catalogLines: string[]): string {
  const known = catalogLines.slice(0, 80)
  const users = episode.userTexts.slice(-6)
  const tools = episode.events
    .filter((e) => e.kind === 'tool')
    .slice(-8)
    .map((e) => '- ' + String(e.tool || 'tool') + (e.ok === false ? ' (failed)' : '') + (e.text ? ': ' + e.text.slice(0, 200) : ''))
  const lines: string[] = []
  lines.push('## 这一轮用户说的话（逐字，不要改写）')
  lines.push(users.length ? users.map((t, i) => `[${i}] ${t.slice(0, 1500)}`).join('\n') : '(none)')
  if (tools.length) {
    lines.push('', '## 这一轮用到的工具')
    lines.push(tools.join('\n'))
  }
  lines.push('', '## 已经记住的东西（不要重复记）')
  lines.push(known.length ? known.map((x) => '- ' + x).join('\n') : '(nothing yet)')
  lines.push('', '## 输出')
  lines.push('只输出 JSON，不要解释。没有值得记的就返回 {"memories":[]}。')
  return lines.join('\n')
}

export const REVIEW_SYSTEM_PROMPT = [
  'You extract durable memories from one finished conversation turn.',
  'Record only what will still matter in a different conversation: a stated preference, a correction of your behaviour, a project fact that cannot be read from the code, or a repeatable procedure.',
  'Do NOT record: one-off instructions ("this time", "for now"), anything derivable from package.json / config / git, or your own reasoning.',
  'For every item, `quote` must be an exact substring of what the user said in this turn. Do not paraphrase it.',
  '`layer`: "global" only when it applies to every project or to the user personally; otherwise "workspace". Always pass it.',
  'Write every `text` in the user\'s language.',
  'Give every item a short `title` (2-8 words) in the user\'s language; it becomes the row name.',
  'At most 3 items. When in doubt, return fewer — a wrong memory is injected into every later conversation.',
  'Output strict JSON: {"memories":[{"title":"Reply style","text":"the note","kind":"preference|fact|correction|procedure","source":"user_explicit|user_correction|tool_verified|model_inference","quote":"exact user words","key":"kebab-case-slot","layer":"workspace","boundary":"when it might not hold"}]}',
].join('\n')

/** 系统提示 + 按需追加的风格行（custom 为空串时不追加）。 */
export function reviewSystemPrompt(cfg: {
  noteStyle?: string
  noteStyleText?: string
  customNoteStyles?: readonly CustomNoteStyle[]
}): string {
  // 句长由风格指引决定：基础提示只保留语言要求，否则「详细」的 2–3 句会与
  // 基础提示里的「one terse sentence」互相矛盾。
  const style = normalizeNoteStyle({
    style: cfg.noteStyle,
    customStyles: cfg.customNoteStyles,
    custom: cfg.noteStyleText,
  })
  const guide = noteStyleGuideOf(style.style, style.customStyles)
  return guide === '' ? REVIEW_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT + '\nWrite every `text` field in this style: ' + guide
}

/** 每会话的复习次数（花过的钱不退款，失败也计数）。 */
export interface ReviewBudget {
  /** 还能复习几次。`max` 给了就按它算（生效配置可能被用户在会话里改过）。 */
  remaining(session: string, max?: number): Promise<number>
  /** 记一次（在真正调模型之前调用：超时也是花了钱）。 */
  spend(session: string): Promise<void>
}

interface BudgetFile {
  sessions: Record<string, { count: number; at: string }>
}

export function createReviewBudget(deps: { path: string; max: number; message(e: unknown): string }): ReviewBudget {
  let cache: BudgetFile | null = null
  let loading: Promise<BudgetFile> | null = null

  async function load(): Promise<BudgetFile> {
    if (cache) return cache
    if (loading) return loading
    loading = (async () => {
      try {
        const raw = JSON.parse(await readFile(deps.path, 'utf8')) as BudgetFile
        cache = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
          ? { sessions: raw.sessions }
          : { sessions: {} }
      } catch {
        cache = { sessions: {} }
      }
      return cache!
    })()
    return loading
  }

  async function save(next: BudgetFile): Promise<void> {
    cache = next
    try {
      await mkdir(dirname(deps.path), { recursive: true })
      await writeFileAtomically(deps.path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    } catch {
      /* 计数器写不进去不该挡住复习本身：下一次会重算，最多多花一次钱。 */
    }
  }

  return {
    async remaining(session, max) {
      const file = await load()
      const hit = file.sessions[session]
      const used = hit ? Math.max(0, Number(hit.count) || 0) : 0
      // 0 是合法值（用户把每会话次数设成 0 = 不复习），不再夹到至少 1 次。
      const cap = Math.max(0, Math.round(max ?? deps.max))
      return Math.max(0, cap - used)
    },
    async spend(session) {
      const file = await load()
      const hit = file.sessions[session]
      const next: BudgetFile = {
        sessions: {
          ...file.sessions,
          [session]: { count: (hit ? Math.max(0, Number(hit.count) || 0) : 0) + 1, at: new Date().toISOString() },
        },
      }
      await save(next)
    },
  }
}

/** 把一段流式输出收成一个字符串（只取 text-delta）。 */
async function collectText(stream: AsyncIterable<any>): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  return out
}

export interface ReviewDeps {
  /** 宿主 llm 服务（`ctx.get('llm')`）。没有就整段跳过。 */
  llm: any
  learner: Learner
  budget: ReviewBudget
  /** 现有自动记忆的一行摘要（让模型别重复记）。 */
  catalogLines(): Promise<string[]>
  log(row: Record<string, unknown>): Promise<void>
  message(e: unknown): string
}

export interface ReviewOutcome {
  ok: boolean
  /** 真的落了几条。 */
  learned: number
  /** 被门禁拒 / 合并掉的条数。 */
  rejected: number
  reason?: string
  error?: string
  /** 落下的条目摘要：outbox 的 done 行与界面据此展示「复习学到了什么」。 */
  items?: ReviewLearnedItem[]
}

export function createReviewer(deps: ReviewDeps): {
  review(episode: Episode, cfg: EffectiveEvolutionConfig, route?: { provider: string; model: string } | null): Promise<ReviewOutcome>
} {
  return {
    async review(episode, cfg, liveRoute) {
      const llm = deps.llm
      if (!llm || typeof llm.prepareCall !== 'function') {
        return { ok: false, learned: 0, rejected: 0, reason: 'no-llm', error: '宿主没有提供 llm 服务' }
      }
      const left = await deps.budget.remaining(episode.session, cfg.maxReviewsPerSession)
      if (left <= 0) {
        await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-skipped', reason: 'budget' })
        return { ok: false, learned: 0, rejected: 0, reason: 'budget' }
      }
      // 配置里显式指定模型时优先（`provider/model` 或只有 model）；否则用这一轮
      // 对话正在用的那个 —— 默认换模型会让"学到的风格"和"对话的风格"不一致。
      const route = routeOf(cfg.model, liveRoute ?? null)
      if (!route) {
        await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-skipped', reason: 'no-model' })
        return { ok: false, learned: 0, rejected: 0, reason: 'no-model', error: '拿不到这一轮的模型路由' }
      }

      // 先记账再调：超时 / 崩溃也是花了钱，不记就等于"无限次重试"。
      await deps.budget.spend(episode.session)

      let text = ''
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), REVIEW_TIMEOUT_MS)
      try {
        const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, temperature: 0 })
        const catalogLines = await deps.catalogLines()
        const stream = prepared.stream({
          ...prepared.config,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildReviewPrompt(episode, catalogLines) }] }],
          system: reviewSystemPrompt(cfg),
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: ac.signal,
        })
        text = await collectText(stream)
      } catch (e) {
        await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-failed', error: deps.message(e) })
        return { ok: false, learned: 0, rejected: 0, error: deps.message(e) }
      } finally {
        clearTimeout(timer)
      }

      const parsed = extractJson(text)
      if (parsed === null) {
        await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-bad-json', chars: text.length })
        return { ok: false, learned: 0, rejected: 0, reason: 'bad-json' }
      }
      const items = parseReviewItems(parsed)
      if (items.length === 0) {
        await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-empty' })
        return { ok: true, learned: 0, rejected: 0 }
      }

      let learned = 0
      let rejected = 0
      const learnedItems: ReviewLearnedItem[] = []
      for (const item of items) {
        try {
          const r = await deps.learner.learn(
            {
              text: item.text,
              ...(item.title !== undefined ? { title: item.title } : {}),
              ...(item.kind !== undefined ? { kind: item.kind } : {}),
              ...(item.key !== undefined ? { key: item.key } : {}),
              source: item.source,
              ...(item.quote !== undefined ? { quote: item.quote } : {}),
              ...(item.layer !== undefined ? { layer: item.layer } : {}),
              ...(item.boundary !== undefined ? { boundary: item.boundary } : {}),
              ...(item.ttlDays !== undefined ? { ttlDays: item.ttlDays } : {}),
              // 后台没有人可弹卡：按自动确认授权直接落 active，由 agent 承担判断；
              // 与用户手写记忆冲突的条目仍落候选，等用户裁决。
              autoActive: true,
            },
            cfg,
            {
              sessionId: episode.session,
              ...(episode.workspaceHash !== undefined ? { workspaceHash: episode.workspaceHash } : {}),
            },
          )
          if (r.ok) {
            learned++
            // 测试替身可能只返回 `{ok:true}`；没有 id 就不记摘要，不能因为展示字段缺失
            // 让一次已经成功的复习在记账时抛异常。
            if (typeof r.id === 'string' && r.id !== '') {
              learnedItems.push({
                id: r.id,
                ...(item.title !== undefined ? { title: item.title } : {}),
                text: item.text,
                layer: String(r.layer ?? ''),
                status: String(r.status ?? ''),
                confidence: Number(r.confidence) || 0,
              })
            }
          } else {
            rejected++
            await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-rejected', code: r.code, gate: r.gate })
          }
        } catch (e) {
          rejected++
          await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-item-failed', error: deps.message(e) })
        }
      }
      await deps.log({ at: new Date().toISOString(), session: episode.session, turn: episode.turn, event: 'review-done', learned, rejected })
      return { ok: true, learned, rejected, ...(learnedItems.length > 0 ? { items: learnedItems } : {}) }
    },
  }
}

/** `cfg.model` 支持 `provider/model` 与裸 model（provider 沿用会话的）。 */
function routeOf(configured: string, fallback: { provider: string; model: string } | null): { provider: string; model: string } | null {
  const raw = String(configured ?? '').trim()
  if (raw !== '') {
    const slash = raw.indexOf('/')
    if (slash > 0 && slash < raw.length - 1) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
    if (fallback) return { provider: fallback.provider, model: raw }
    return null
  }
  return fallback
}

/** 供冷路径判断"这次复习要不要重试"。纯函数，好测。 */
export function nextRetryAt(attempts: number, now = Date.now()): number {
  // 1min / 5min / 30min；第 3 次之后不再重试（进 dead-letter）。
  const delays = [60_000, 5 * 60_000, 30 * 60_000]
  const idx = Math.max(0, Math.min(delays.length - 1, attempts - 1))
  return now + delays[idx]!
}

/**
 * 失败后的补丁。
 *
 * `now` 与 `episodes.retryable` 用的是同一个时钟：两边各取一次 `Date.now()` 会在边界上
 * 出现"刚写下的 nextAt 已经过期"或"要等到下次才过期"的抖动，重试判定就变得不可复现。
 */
export function outboxFailed(item: OutboxItem, error: string, now = Date.now()): Partial<OutboxItem> {
  const attempts = (item.attempts ?? 0) + 1
  if (attempts >= 3) return { status: 'dead', attempts, reason: error }
  return { status: 'failed', attempts, reason: error, nextAt: nextRetryAt(attempts, now) }
}
