// 复习器（冷路径的第二段）：宿主压缩上下文时，把那份 checkpoint 过一遍，挑出值得记的几条。
//
// 为什么值得多花一次模型调用：热路径（`memory_note`）靠模型在对话中"顺手"记，但它正忙着
// 解决用户的问题，注意力不在"这句话以后还用得上吗"。压缩时宿主已经把整段对话交给模型提炼
// 成结构化摘要 —— 那是信息密度最高、且已经付过钱的产物，同一个模型再读一遍它的判断质量
// 完全不同。这也是 Claude Code / Codex 那类 harness 的做法：记忆不是对话的副产品，
// 是**独立工序**。
//
// 三条纪律：
//   1. **严格 JSON**：只接受白名单字段；解析不出来按可恢复失败走退避重试（不占学习名额）。
//      逐条过九道门，复习器不是后门。
//   2. **成本上限**：每会话最多 `maxReviewsPerSession` 次**成功**复习。超了直接跳过并在
//      outbox 记原因 —— 失败 / 超时 / 环境未就绪都不占名额，失控由 outbox 的退避兜住。
//   3. **失败不阻塞会话**：这里的所有异常都吞掉并写日志。用户不该因为记忆整理失败
//      看到报错，更不该等它。

import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import type { Episode } from './digest.js'
import type { OutboxItem, ReviewLearnedItem } from './episodes.js'
import { MAX_AUTO_TITLE_WIDTH, type Learner } from './write.js'
import { truncateToWidth } from '../text-width.js'
import { normalizeNoteStyle, noteStyleGuideOf, type CustomNoteStyle, type EffectiveEvolutionConfig } from './config.js'

/** 一次复习最多落几条。多了就是在把摘要改写成记忆库，那不是复习。 */
export const MAX_ITEMS_PER_REVIEW = 3
/**
 * 单次请求的输出上限（token）。
 *
 * 必须装得下 `MAX_ITEMS_PER_REVIEW` 条**满配**正文：一条 800 显示单位 ≈ 400 汉字，
 * 三条中文正文加上 JSON 包装就已经超过 900 —— 那时输出被截断，`extractJson` 解析不出来，
 * 整批按 `bad-json` 重试到死信。2000 留了足够的余量（三条满配中文 ≈ 1300）。
 */
const MAX_OUTPUT_TOKENS = 2000
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
    // 正文**不在这里截**：超限交给写入管线拒（`too-long`），与热路径同一条规矩。
    // 在这里截会存下一句被腰斩的话，而用户看不到任何提示 —— 那正是本版修掉的
    // 「静默截断」。截断只留给展示字段（标题）。
    const text = typeof r.text === 'string' ? r.text.trim() : ''
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

/**
 * 拼复习用的 prompt。
 *
 * 压缩触发的复习只读官方 checkpoint；旧版按轮次排队的 episode 兼容旧渲染（盘上可能还有）。
 * checkpoint 是模型转述，不是用户原话 —— 这里不给它「逐字」的标签，证据门也不会把它
 * 当成引句来源。
 */
export function buildReviewPrompt(episode: Episode, catalogLines: string[]): string {
  // 上限比旧版宽：清单里现在混着用户记忆与全局指令文件，截到 80 行会让后加的自主笔记
  // 整段消失，而「别重复」恰恰最需要它们。
  const known = catalogLines.slice(0, 160)
  const lines: string[] = []
  if (typeof episode.checkpoint === 'string' && episode.checkpoint.trim() !== '') {
    lines.push('## Host-compiled checkpoint (a summary written by another model, not the user\'s words)')
    lines.push(episode.checkpoint)
  } else {
    const users = episode.userTexts.slice(-6)
    const tools = episode.events
      .filter((e) => e.kind === 'tool')
      .slice(-8)
      .map((e) => '- ' + String(e.tool || 'tool') + (e.ok === false ? ' (failed)' : '') + (e.text ? ': ' + e.text.slice(0, 200) : ''))
    lines.push('## 这一轮用户说的话（逐字，不要改写）')
    lines.push(users.length ? users.map((t, i) => `[${i}] ${t.slice(0, 1500)}`).join('\n') : '(none)')
    if (tools.length) {
      lines.push('', '## 这一轮用到的工具')
      lines.push(tools.join('\n'))
    }
  }
  // 标题点名「已经在上下文里」而不只是「已经记住」：清单里除了自主记忆，还有用户手写的
  // 记忆与全局指令文件的摘录 —— 它们本来就会注入每一次对话，再学一遍就是同一句话在上下文
  // 里出现两次，还多一条要维护的副本。
  lines.push('', '## 已经记住 / 已经在上下文里的东西（不要重复记）')
  lines.push(known.length ? known.map((x) => '- ' + x).join('\n') : '(nothing yet)')
  lines.push('', '## 输出')
  lines.push('只输出 JSON，不要解释。没有值得记的就返回 {"memories":[]}。')
  return lines.join('\n')
}

/**
 * 压缩复习专用：checkpoint 里大半是「接着干活」的任务态，只有这一小类跨会话成立。
 *
 * 最后一句是**去重**的一半：清单里已经列了用户手写记忆与全局指令文件的摘录，它们每一次
 * 对话都会注入。不点名这件事，模型会照着 checkpoint 里的说法再写一条几乎一样的笔记
 * （真实数据：「gh cli已经登录」被重学成「GitHub CLI 已登录」）。
 */
const CHECKPOINT_FILTER = [
  'The input is a host-compiled conversation checkpoint meant for resuming the current task, not for long-term memory.',
  'Keep ONLY what will still be true in a different conversation: user preferences, corrections of your behaviour, durable constraints, project facts that cannot be read from the code, and repeatable procedures.',
  'DISCARD everything task-local: Current Work, Next Step, Pending Jobs, Files and Code, Errors and Fixes, file paths, commands, error strings, dependency versions, and one-off instructions.',
  'The checkpoint is a paraphrase, not the user\'s words: never invent a `quote`; set `source` to "model_inference".',
  'The list at the end of the user message holds what is ALREADY in every conversation (the user\'s own memories and their global instructions, not just earlier notes). Do not restate any of it in other words — only add what that list does not already say.',
].join(' ')

/** 旧版按轮次复习的提示：那份 episode 里是用户逐字原话，可以要求引句核对。 */
const TURN_SYSTEM_PROMPT = [
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

/** 系统提示按 episode 来源分叉：压缩那份必须明确排除任务态章节。 */
export function reviewSystemPromptFor(episode: Episode, cfg: {
  noteStyle?: string
  noteStyleText?: string
  customNoteStyles?: readonly CustomNoteStyle[]
}): string {
  const style = normalizeNoteStyle({
    style: cfg.noteStyle,
    customStyles: cfg.customNoteStyles,
    custom: cfg.noteStyleText,
  })
  const guide = noteStyleGuideOf(style.style, style.customStyles)
  const base = typeof episode.checkpoint === 'string' && episode.checkpoint.trim() !== ''
    ? CHECKPOINT_FILTER + '\n' + [
      '`layer`: "global" only when it applies to every project or to the user personally; otherwise "workspace". Always pass it.',
      'Write every `text` in the user\'s language. Give every item a short `title` (2-8 words).',
      'At most 3 items. When in doubt, return fewer — a wrong memory is injected into every later conversation.',
      'Output strict JSON: {"memories":[{"title":"Reply style","text":"the note","kind":"preference|fact|correction|procedure","source":"model_inference","key":"kebab-case-slot","layer":"workspace","boundary":"when it might not hold"}]}',
    ].join('\n')
    : TURN_SYSTEM_PROMPT
  return guide === '' ? base : base + '\nWrite every `text` field in this style: ' + guide
}

/** 每会话的**成功**复习次数（失败 / 超时 / 坏 JSON 都不计数）。 */
export interface ReviewBudget {
  /** 还能复习几次。`max` 给了就按它算（生效配置可能被用户在会话里改过）。 */
  remaining(session: string, max?: number): Promise<number>
  /** 记一次成功（复习真正跑完后才调用）。 */
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

      // 「学习次数」只在复习成功跑完后记一次；失败 / 坏 JSON 走重试，不占名额。
      // 失控由 outbox 的 attempts（三次进 dead）兜住，不靠把失败算成一次学习。
      const isCheckpoint = typeof episode.checkpoint === 'string' && episode.checkpoint.trim() !== ''

      let text = ''
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), REVIEW_TIMEOUT_MS)
      try {
        // 输出上限必须进 `prepareCall`：宿主会把适配器的默认 maxTokens 补进
        // `prepared.config`（`dsh-llm-deepseek` 恒有 `defaultMaxTokens`），而 `prepared.stream`
        // 会用 `callConfigEquals` 逐字段比对调用方传的配置与它，不一致直接抛
        // `INVALID_PREPARED_CALL` —— 把上限放到 dispatch 那一侧，后台复习每次都失败。
        const prepared = await llm.prepareCall({
          provider: route.provider,
          model: route.model,
          temperature: 0,
          maxTokens: MAX_OUTPUT_TOKENS,
        })
        const catalogLines = await deps.catalogLines()
        const stream = prepared.stream({
          ...prepared.config,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildReviewPrompt(episode, catalogLines) }] }],
          system: reviewSystemPromptFor(episode, cfg),
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
        await deps.budget.spend(episode.session)
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
              // checkpoint 是转述：不伪造用户原话，也不冒领 user_explicit。
              source: isCheckpoint ? 'model_inference' : item.source,
              ...(!isCheckpoint && item.quote !== undefined ? { quote: item.quote } : {}),
              ...(item.layer !== undefined ? { layer: item.layer } : {}),
              ...(item.boundary !== undefined ? { boundary: item.boundary } : {}),
              ...(item.ttlDays !== undefined ? { ttlDays: item.ttlDays } : {}),
              // 后台没有人可弹卡，所以「要不要直接生效」跟随用户自己的授权：
              // `autoConfirm` 开着 = 用户已同意由 agent 决定，直接落 active；
              // 关着（默认）= 落候选，在记忆页逐条确认。
              //
              // 这里**不能恒为 true**：复习的输入是另一个模型写的转述，未经任何人过目就进入
              // 之后每一次对话的上下文，与「没卡片时仍待确认」的承诺直接冲突。两种情况都
              // 越不过用户手写记忆的冲突（门禁里 `user-conflict` 永远等用户裁决）。
              ...(cfg.autoConfirm === true ? { autoActive: true } : {}),
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
      await deps.budget.spend(episode.session)
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

/**
 * 供冷路径判断"这次复习要不要重试"。纯函数，好测。
 *
 * 三档退避 1 / 5 / 30 分钟；第 4 次才进 dead-letter —— 档位与 dead 的界要**错开一位**，
 * 否则 30 分钟那一档永远用不到（`attempts === 3` 时就死了）。
 */
export function nextRetryAt(attempts: number, now = Date.now()): number {
  const delays = [60_000, 5 * 60_000, 30 * 60_000]
  const idx = Math.max(0, Math.min(delays.length - 1, attempts - 1))
  return now + delays[idx]!
}

/** 一次复习失败后还能再试几次（与 `nextRetryAt` 的档位数一致）。 */
export const MAX_REVIEW_ATTEMPTS = 3

/**
 * 失败后的补丁。
 *
 * `now` 与 `episodes.retryable` 用的是同一个时钟：两边各取一次 `Date.now()` 会在边界上
 * 出现"刚写下的 nextAt 已经过期"或"要等到下次才过期"的抖动，重试判定就变得不可复现。
 *
 * `transient` 是**环境还没就绪**（拿不到模型路由 / 宿主没给 llm 服务）：那不是这次复习的
 * 错，重试次数不该被它烧掉 —— 启动重放时路由表必然是空的，按失败计数的话重启三次，
 * 任何残留项都会在真正跑过一次之前就进 dead-letter。
 */
export function outboxFailed(
  item: OutboxItem,
  error: string,
  now = Date.now(),
  opts: { transient?: boolean; immediate?: boolean } = {},
): Partial<OutboxItem> {
  if (opts.transient === true) {
    // 不增 attempts：保持 pending，等下一次触发（新压缩 / 重启 / 手动重放）。
    // `immediate` 清掉退避（显式写 undefined —— `mark` 是合并写入，不给这个键会沿用旧值）：
    // 这一项的触发条件已经就绪（路由刚记上），再等一分钟只是白拖。
    const wait = opts.immediate === true ? { nextAt: undefined } : { nextAt: nextRetryAt(1, now) }
    return { status: 'pending', attempts: item.attempts ?? 0, reason: error, ...wait }
  }
  const attempts = (item.attempts ?? 0) + 1
  if (attempts > MAX_REVIEW_ATTEMPTS) return { status: 'dead', attempts, reason: error }
  return { status: 'failed', attempts, reason: error, nextAt: nextRetryAt(attempts, now) }
}
