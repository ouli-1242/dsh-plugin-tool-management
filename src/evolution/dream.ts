// dream：全库整理（P3）。与复习器的分工是**粒度**，不是模型大小。
//
//   复习器（P2）：一次看一轮，只回答"这轮有什么值得记" → 写新条目。
//   dream（P3）：一次看全库，只回答"这些条目该怎么并/降/升" → 不改正文，出草案。
//
// 三条硬纪律：
//
//   1. **输入不动，输出是草案**。生成阶段一个字节都不写记忆库；应用阶段才动，而且动之前
//      把 state.json / memories-index.json / 每一条受影响的正文都复制到 `dreams/<id>/backup/`。
//      Anthropic Dreams 的"写新库"思路在这里落地为"可整批回滚"——整理是全库操作，
//      出错代价最大，所以它必须是唯一一个能一键回到从前的东西。
//
//   2. **草案要能被人读懂**。每条 op 带 reason；界面拿 `entries` 里的 oneLine 拼 diff。
//      没有 diff 的整理等于让用户签一张空白支票。
//
//   3. **校验跑两遍**：生成时一遍（模型跑偏的当场丢），应用时再一遍（草案躺了两天，
//      库已经变了）。应用时任何一条不合法就整批拒绝 —— 半套合并比不合并更糟：
//      A 已并进 B、C 却因为过期被跳过，用户看到的就是一个他没批准的中间态。
//
// 为什么 dream 不产"新条目"：新条目需要**轮级证据**（谁在什么时候说了什么），dream 手上
// 只有摘要和现有条目，让它造新记忆等于绕过证据门。新条目是复习器的活。

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import type { MemoryLayer } from '../memories/constants.js'
import type { EffectiveEvolutionConfig } from './config.js'
import type { Episode } from './digest.js'
import type { EpisodeStore } from './episodes.js'
import { extractJson } from './review.js'
import { independentEvidenceOf, type EvolutionState } from './state.js'
import type { Learner } from './write.js'

/** 一次整理最多接受多少条 op。再多就不是"整理"，是重建。 */
export const MAX_DREAM_OPS = 40
/** 单次输出上限。 */
const MAX_OUTPUT_TOKENS = 2400
/** 单次请求超时：全库整理比复习慢，但也不该让学生等十分钟。 */
const DREAM_TIMEOUT_MS = 90_000
/** 草稿里最多列多少条现有记忆（与设计文档的 ≤200 对齐）。 */
export const MAX_INPUT_ENTRIES = 200
/** 给模型的 episode 条数。 */
export const MAX_INPUT_EPISODES = 50
/** 用户纠正最多列几条。 */
export const MAX_INPUT_CORRECTIONS = 20

export type DreamOp =
  | { op: 'merge'; keep: string; drop: string[]; reason: string }
  | { op: 'archive'; id: string; reason: string }
  | { op: 'promote'; id: string; status: 'active' | 'core'; reason: string }

export interface DreamPlan {
  version: 1
  createdAt: string
  ops: DreamOp[]
  notes: string
}

/** 校验与渲染共用的一份条目视图（只读）。 */
export interface DreamEntryView {
  id: string
  layer: MemoryLayer
  key: string
  status: string
  origin: 'user' | 'auto'
  oneLine: string
  confidence: number
  tokens: number
  locked?: boolean
  helpful: number
  harmful: number
  /** 不同会话的证据数。 */
  evidence: number
}

export interface DreamContext {
  entries: DreamEntryView[]
  now?: number
}

/** 应用结果：逐条，失败的也留着 —— 回滚时要能解释"当时发生了什么"。 */
export interface DreamApplyResult {
  op: DreamOp
  ok: boolean
  code?: string
  error?: string
}

export interface DreamDraft {
  version: 1
  id: string
  createdAt: string
  model: string
  plan: DreamPlan
  /** 生成阶段被校验丢掉的 op 数（模型的原始输出里有几条不合法）。 */
  dropped: number
  tokensBefore: number
  /** 草案执行后的大致注入 token（按合并/归档/晋升估算，不是精确值）。 */
  tokensAfter: number
}

export interface DreamManifest {
  version: 1
  id: string
  createdAt: string
  /** `draft` 未应用 / `applying` 应用中断（可回滚）/ `applied` / `reverted`。 */
  status: 'draft' | 'applying' | 'applied' | 'reverted'
  appliedAt?: string
  revertedAt?: string
  /** 应用后的 state.json 摘要：回滚前用它判断"这之后有没有新的写入"。 */
  stateHash?: string
  /** 备份的相对路径（相对 `dreams/<id>/`）。 */
  backup: string[]
  results: DreamApplyResult[]
  /** 整批被拒时留一句原因（界面直接显示）。 */
  error?: string
}

// ── 校验 ───────────────────────────────────────────────────────────────────

const byId = (ctx: DreamContext): Map<string, DreamEntryView> => new Map(ctx.entries.map((e) => [e.id, e]))

const isLive = (e: DreamEntryView): boolean =>
  e.origin === 'auto' && e.locked !== true && e.status !== 'archived' && e.status !== 'superseded'

const cleanReason = (v: unknown): string => String(typeof v === 'string' ? v : '').replaceAll(/\s+/g, ' ').trim().slice(0, 300)

/**
 * 把模型给的草案落成合法 op 列表。
 *
 * 单条不合法 → **丢这一条**并计数（`dropped`），不整批拒：模型一次给 10 条，其中一条
 * 引用了不存在的 id，不该让另外 9 条白跑。但应用阶段用的是同一个函数，且那时**任何**
 * dropped 都会导致整批拒绝 —— 两处的严格度不同是有意的（见文件头第 3 条）。
 */
export function parseDreamPlan(
  raw: unknown,
  ctx: DreamContext,
): { ok: true; plan: DreamPlan; dropped: number } | { ok: false; error: string } {
  const box = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!box) return { ok: false, error: 'draft is not an object' }
  const list = Array.isArray(box.ops) ? box.ops : Array.isArray(box.operations) ? box.operations : null
  if (!list) return { ok: false, error: 'draft has no ops array' }

  const entries = byId(ctx)
  const taken = new Set<string>()
  const ops: DreamOp[] = []
  let dropped = 0

  for (const row of list) {
    if (ops.length >= MAX_DREAM_OPS) break
    if (!row || typeof row !== 'object') {
      dropped++
      continue
    }
    const r = row as Record<string, unknown>
    const op = typeof r.op === 'string' ? r.op : typeof r.action === 'string' ? r.action : ''
    const reason = cleanReason(r.reason)

    if (op === 'merge') {
      const keep = typeof r.keep === 'string' ? r.keep.trim() : ''
      const dropRaw = Array.isArray(r.drop) ? r.drop : typeof r.drop === 'string' ? [r.drop] : []
      const drop = [...new Set(dropRaw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
      const keepEntry = entries.get(keep)
      if (!keepEntry || drop.length === 0 || reason === '') {
        dropped++
        continue
      }
      if (drop.includes(keep) || !isLive(keepEntry)) {
        dropped++
        continue
      }
      if (taken.has(keep)) {
        dropped++
        continue
      }
      let bad = false
      for (const id of drop) {
        const e = entries.get(id)
        // 跨层合并会让一条记忆的可见范围凭空扩大或缩小；用户记忆与锁定条目不进自动整理。
        if (!e || !isLive(e) || e.layer !== keepEntry.layer || e.origin !== keepEntry.origin || taken.has(id)) {
          bad = true
          break
        }
        // 把 core 并进非 core = 悄悄降级。要么 keep 也是 core，要么不允许。
        if (e.status === 'core' && keepEntry.status !== 'core') {
          bad = true
          break
        }
      }
      if (bad) {
        dropped++
        continue
      }
      ops.push({ op: 'merge', keep, drop, reason })
      taken.add(keep)
      for (const id of drop) taken.add(id)
      continue
    }

    if (op === 'archive') {
      const id = typeof r.id === 'string' ? r.id.trim() : ''
      const e = entries.get(id)
      if (!e || !isLive(e) || reason === '' || taken.has(id)) {
        dropped++
        continue
      }
      ops.push({ op: 'archive', id, reason })
      taken.add(id)
      continue
    }

    if (op === 'promote') {
      const id = typeof r.id === 'string' ? r.id.trim() : ''
      const status = r.status === 'core' ? 'core' : r.status === 'active' ? 'active' : ''
      const e = entries.get(id)
      if (!e || !isLive(e) || status === '' || reason === '' || taken.has(id)) {
        dropped++
        continue
      }
      // 已经是目标状态 = 空操作，丢掉（留在草案里只会让"应用了 N 条"虚高）。
      if (e.status === status || (status === 'active' && e.status === 'core')) {
        dropped++
        continue
      }
      if (status === 'active') {
        // 候选转正的门槛与治理表一致：置信度够，或两条独立证据。dream 不是后门。
        if (e.status !== 'candidate') {
          dropped++
          continue
        }
        if (e.confidence < 0.6 && e.evidence < 2) {
          dropped++
          continue
        }
      } else {
        // core 的硬条件在 learner.setStatus 里还会再判一次（那道才是权威）。
        // 只允许 active → core：治理表的状态机是 candidate → active → core，跳档等于让一条
        // 从没被注入过的弱推断直接占用常驻额度。
        if (e.status !== 'active' || e.helpful < 3 || e.harmful > 0) {
          dropped++
          continue
        }
      }
      ops.push({ op: 'promote', id, status, reason })
      taken.add(id)
      continue
    }

    dropped++
  }

  return {
    ok: true,
    plan: { version: 1, createdAt: new Date(ctx.now ?? Date.now()).toISOString(), ops, notes: cleanReason(box.notes).slice(0, 1000) },
    dropped,
  }
}

// ── 输入 / 提示词 ──────────────────────────────────────────────────────────

export interface DreamInput {
  entries: DreamEntryView[]
  episodes: Episode[]
  corrections: string[]
  instructions?: string
}

/** 拼 prompt。导出是为了钉住"不塞全文、不塞用户原话之外的东西"。 */
export function buildDreamPrompt(input: DreamInput): string {
  const lines: string[] = []
  lines.push('## 现有自动记忆（每行一条，id 用于输出）')
  const entries = input.entries.slice(0, MAX_INPUT_ENTRIES)
  lines.push(
    entries.length
      ? entries
          .map(
            (e) =>
              `- ${e.id} | ${e.layer} | ${e.status} | conf ${e.confidence.toFixed(2)} | helpful ${e.helpful} | ${
                e.key ? 'key=' + e.key + ' | ' : ''
              }${e.oneLine}`,
          )
          .join('\n')
      : '(none)',
  )
  lines.push('', '## 最近的对话摘要（只是背景，不要从里面提取新记忆）')
  const eps = input.episodes.slice(0, MAX_INPUT_EPISODES)
  if (eps.length === 0) lines.push('(none)')
  for (const ep of eps) {
    const said = ep.userTexts.slice(-3).map((t) => t.replaceAll(/\s+/g, ' ').slice(0, 200)).join(' / ')
    lines.push(`- ${ep.session}/${ep.turn}: ${said || '(no user text)'}`)
  }
  if (input.corrections.length > 0) {
    lines.push('', '## 用户最近纠正过的事（说明哪些旧条目可能已过期）')
    lines.push(input.corrections.slice(0, MAX_INPUT_CORRECTIONS).map((x) => '- ' + x).join('\n'))
  }
  if (input.instructions && input.instructions.trim() !== '') {
    lines.push('', '## 用户给这次整理的说明')
    lines.push(input.instructions.trim().slice(0, 4096))
  }
  lines.push('', '## 输出')
  lines.push('只输出 JSON，不要解释。没有可整理的就返回 {"ops":[]}。')
  return lines.join('\n')
}

export const DREAM_SYSTEM_PROMPT = [
  'You consolidate an existing memory library. You never invent new memories: there is no new evidence in this task.',
  'Allowed operations:',
  '- {"op":"merge","keep":"<id>","drop":["<id>",...],"reason":"..."} — only when the entries state the same thing. All ids must be in the same layer, all must be auto memories. The kept entry absorbs the others.',
  '- {"op":"archive","id":"<id>","reason":"..."} — for entries that are stale, wrong, or contradicted by newer evidence. Never archive something just because it is old.',
  '- {"op":"promote","id":"<id>","status":"active|core","reason":"..."} — candidate→active only when the evidence is strong; active→core only for rules the user relies on repeatedly (helpful ≥ 3).',
  'Do NOT merge entries that differ in scope, boundary, or meaning. "Use pnpm" and "do not commit the lockfile" are different rules.',
  'Do NOT touch entries that are already archived or superseded. At most 40 operations. When in doubt, do nothing — every merge is hard for the user to undo mentally.',
  'Output strict JSON: {"ops":[...],"notes":"one short paragraph on what you found"}',
].join('\n')

// ── 草案存取 ───────────────────────────────────────────────────────────────

const DREAMS_DIR = 'evolution/dreams'

/** 时间戳 id：可按字典序排，也一眼能看出是哪天整理的。 */
export function dreamIdOf(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function isValidDreamId(id: string): boolean {
  return /^\d{8}-\d{6}(-\d+)?$/.test(String(id ?? ''))
}

export interface DreamDraftSummary {
  id: string
  createdAt: string
  status: DreamManifest['status']
  ops: number
  merges: number
  archives: number
  promotes: number
  appliedAt?: string
  revertedAt?: string
  error?: string
}

// ── 执行器 ─────────────────────────────────────────────────────────────────

export interface DreamDeps {
  llm: any
  learner: Learner
  state: {
    read(): Promise<{ ok: true; state: EvolutionState } | { ok: false; error: string }>
    write(state: EvolutionState): Promise<{ ok: true } | { ok: false; error: string }>
    update<T>(fn: (state: EvolutionState) => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }>
    invalidateCache(): void
  }
  episodes: EpisodeStore
  /** 现有条目视图（来自 catalog + state 的同步快照）。 */
  entries(): DreamEntryView[]
  /** 最近一次模型路由（没有就要求 `evolution.model` 显式配置）。 */
  lastRoute?(): { provider: string; model: string } | null
  /** 重建派生索引（回滚后必须调，否则注入侧还拿着旧卡片）。 */
  rebuildCatalog(): Promise<unknown>
  /** 记忆根与 state 根。 */
  memoriesRoot: string
  stateDir: string
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  log(row: Record<string, unknown>): Promise<void>
  message(e: unknown): string
  now?(): number
}

export interface DreamOutcome {
  ok: boolean
  draftId?: string
  ops?: number
  dropped?: number
  reason?: string
  error?: string
}

interface DraftFile extends DreamDraft {}
interface ManifestFile extends DreamManifest {}

const absOf = (deps: DreamDeps, id: string, name: string): string => join(deps.stateDir, DREAMS_DIR, id, name)

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function sha256OfFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return ''
  }
}

/** 模型给的合并理由里常见的空话，不拦（只拦空串）——判断语义是模型的事，代码只守不变量。 */

export function createDreamer(deps: DreamDeps) {
  const clock = (): number => (deps.now ? deps.now() : Date.now())

  function routeOf(cfg: EffectiveEvolutionConfig, live: { provider: string; model: string } | null): { provider: string; model: string } | null {
    const raw = String(cfg.model ?? '').trim()
    if (raw !== '') {
      const slash = raw.indexOf('/')
      if (slash > 0 && slash < raw.length - 1) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      if (live) return { provider: live.provider, model: raw }
      return null
    }
    return live ?? deps.lastRoute?.() ?? null
  }

  /** 现有条目 + 计数器拼成校验/渲染共用的视图。 */
  function viewFrom(entries: DreamEntryView[], state: EvolutionState): DreamEntryView[] {
    const out: DreamEntryView[] = []
    for (const e of entries) {
      const st = state.entries[e.id]
      const counters = st?.counters
      out.push({
        ...e,
        helpful: counters ? Math.max(0, Number(counters.helpful) || 0) : e.helpful ?? 0,
        harmful: counters ? Math.max(0, Number(counters.harmful) || 0) : e.harmful ?? 0,
        evidence: st && Array.isArray(st.evidence) ? independentEvidenceOf(st.evidence) : e.evidence ?? 0,
      })
    }
    return out
  }

  async function contextOf(): Promise<{ ok: true; ctx: DreamContext } | { ok: false; error: string }> {
    const read = await deps.state.read()
    if (!read.ok) return { ok: false, error: read.error }
    return { ok: true, ctx: { entries: viewFrom(deps.entries(), read.state), now: clock() } }
  }

  /** 估算 token：合并保留 keep 的体积，归档扣掉，晋升到 core 不变。 */
  function estimateTokens(entries: DreamEntryView[], ops: DreamOp[]): number {
    const byIdMap = byId({ entries, now: clock() })
    let before = 0
    for (const e of entries) before += e.tokens
    let after = before
    for (const op of ops) {
      if (op.op === 'merge') {
        for (const id of op.drop) after -= byIdMap.get(id)?.tokens ?? 0
      } else if (op.op === 'archive') {
        after -= byIdMap.get(op.id)?.tokens ?? 0
      }
    }
    return Math.max(0, after)
  }

  async function writeDraft(draft: DraftFile): Promise<void> {
    const dir = join(deps.stateDir, DREAMS_DIR, draft.id)
    await mkdir(dir, { recursive: true })
    await writeFileAtomically(join(dir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 })
  }

  async function writeManifest(m: ManifestFile): Promise<void> {
    const dir = join(deps.stateDir, DREAMS_DIR, m.id)
    await mkdir(dir, { recursive: true })
    await writeFileAtomically(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
  }

  async function readBundle(id: string): Promise<{ draft: DreamDraft; manifest: DreamManifest } | null> {
    if (!isValidDreamId(id)) return null
    const [draft, manifest] = await Promise.all([
      readJson<DreamDraft>(absOf(deps, id, 'draft.json')),
      readJson<DreamManifest>(absOf(deps, id, 'manifest.json')),
    ])
    if (!draft || !manifest || !Array.isArray(draft.plan?.ops) || !Array.isArray(manifest.backup)) return null
    return { draft, manifest }
  }

  return {
    /** 生成草案。不写记忆库、不改状态；失败也是一份可解释的日志。 */
    async dream(cfg: EffectiveEvolutionConfig, liveRoute?: { provider: string; model: string } | null): Promise<DreamOutcome> {
      const llm = deps.llm
      if (!llm || typeof llm.prepareCall !== 'function') {
        return { ok: false, reason: 'no-llm', error: '宿主没有提供 llm 服务' }
      }
      const route = routeOf(cfg, liveRoute ?? null)
      if (!route) return { ok: false, reason: 'no-model', error: '拿不到模型路由：请先在一次对话里触发，或在设置里指定模型' }

      const built = await contextOf()
      if (!built.ok) return { ok: false, reason: 'state-unreadable', error: built.error }
      const ctx = built.ctx
      // 少于 4 条时整理没有意义：合并最多省两三条，而一次整理要用户审阅、要备份、要占一次模型调用。
      if (ctx.entries.filter((e) => isLive(e)).length < 4) {
        return { ok: false, reason: 'too-small', error: '记忆库还太小，不需要整理' }
      }

      const [episodes, corrections] = await Promise.all([
        deps.episodes.recent(MAX_INPUT_EPISODES).catch(() => [] as Episode[]),
        Promise.resolve(
          ctx.entries
            .filter((e) => e.status === 'active' && e.key !== '' && e.origin === 'auto')
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, MAX_INPUT_CORRECTIONS)
            .map((e) => e.oneLine),
        ),
      ])

      let text = ''
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), DREAM_TIMEOUT_MS)
      // 先记"试过"再调：失败也烧钱，不记就等于每轮都能再试一次。
      await deps.state
        .update((st) => {
          st.watermarks.lastDreamTryAt = new Date(clock()).toISOString()
          return true
        })
        .catch(() => ({ ok: false as const, error: 'state write failed' }))
      try {
        const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, temperature: 0 })
        const stream = prepared.stream({
          ...prepared.config,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildDreamPrompt({ entries: ctx.entries, episodes, corrections }) }] }],
          system: DREAM_SYSTEM_PROMPT,
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: ac.signal,
        })
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
      } catch (e) {
        await deps.log({ at: new Date().toISOString(), event: 'dream-failed', error: deps.message(e) })
        return { ok: false, error: deps.message(e) }
      } finally {
        clearTimeout(timer)
      }

      const parsed = extractJson(text)
      if (parsed === null) {
        await deps.log({ at: new Date().toISOString(), event: 'dream-bad-json', chars: text.length })
        return { ok: false, reason: 'bad-json', error: '模型输出不是 JSON' }
      }
      const checked = parseDreamPlan(parsed, ctx)
      if (!checked.ok) {
        await deps.log({ at: new Date().toISOString(), event: 'dream-invalid', error: checked.error })
        return { ok: false, reason: 'invalid', error: checked.error }
      }
      if (checked.plan.ops.length === 0) {
        await deps.log({ at: new Date().toISOString(), event: 'dream-empty', dropped: checked.dropped })
        return { ok: false, reason: 'empty', error: '这次没有可整理的内容' }
      }

      const id = dreamIdOf(clock())
      const before = ctx.entries.reduce((n, e) => n + e.tokens, 0)
      const draft: DreamDraft = {
        version: 1,
        id,
        createdAt: new Date(clock()).toISOString(),
        model: `${route.provider}/${route.model}`,
        plan: checked.plan,
        dropped: checked.dropped,
        tokensBefore: before,
        tokensAfter: estimateTokens(ctx.entries, checked.plan.ops),
      }
      const manifest: DreamManifest = {
        version: 1,
        id,
        createdAt: draft.createdAt,
        status: 'draft',
        backup: [],
        results: [],
      }
      try {
        await writeDraft(draft)
        await writeManifest(manifest)
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
      await deps.log({ at: draft.createdAt, event: 'dream-drafted', id, ops: draft.plan.ops.length, dropped: draft.dropped })
      await deps.state
        .update((st) => {
          st.watermarks.lastDreamAt = draft.createdAt
          return true
        })
        .catch(() => ({ ok: false as const, error: 'state write failed' }))
      return { ok: true, draftId: id, ops: draft.plan.ops.length, dropped: draft.dropped }
    },

    /** 草案清单（新→旧），界面用它决定显示「去审阅」还是「上次整理未完成」。 */
    async listDrafts(limit = 20): Promise<DreamDraftSummary[]> {
      let names: string[] = []
      try {
        names = (await readdir(join(deps.stateDir, DREAMS_DIR), { withFileTypes: true }))
          .filter((d) => d.isDirectory() && isValidDreamId(d.name))
          .map((d) => d.name)
      } catch {
        return []
      }
      names.sort((a, b) => b.localeCompare(a))
      const out: DreamDraftSummary[] = []
      for (const id of names.slice(0, Math.max(1, limit))) {
        const bundle = await readBundle(id)
        if (!bundle) continue
        const ops = bundle.draft.plan.ops
        out.push({
          id,
          createdAt: bundle.draft.createdAt,
          status: bundle.manifest.status,
          ops: ops.length,
          merges: ops.filter((o) => o.op === 'merge').length,
          archives: ops.filter((o) => o.op === 'archive').length,
          promotes: ops.filter((o) => o.op === 'promote').length,
          ...(bundle.manifest.appliedAt ? { appliedAt: bundle.manifest.appliedAt } : {}),
          ...(bundle.manifest.revertedAt ? { revertedAt: bundle.manifest.revertedAt } : {}),
          ...(bundle.manifest.error ? { error: bundle.manifest.error } : {}),
        })
      }
      return out
    },

    /** 读一份草案（界面渲染 diff 用）：带每条 id 的 oneLine，不返回正文。 */
    async readDraft(id: string): Promise<{
      ok: boolean
      draft?: DreamDraft
      manifest?: DreamManifest
      items?: { id: string; oneLine: string }[]
      error?: string
    }> {
      const bundle = await readBundle(id)
      if (!bundle) return { ok: false, error: '草案不存在' }
      const items = deps.entries().map((e) => ({ id: e.id, oneLine: e.oneLine }))
      return { ok: true, draft: bundle.draft, manifest: bundle.manifest, items }
    },

    /**
     * 应用草案。
     *
     * 顺序：应用时校验 → 备份 → 先写 `applying` → 逐条执行 → 写 `applied` + stateHash。
     * 先写 `applying` 是为了让"中途崩溃"在界面上有话说：manifest 停在 applying 就是
     * "上次整理没做完，可以回滚"，而不是一份看起来从未应用过的草案。
     *
     * 这里套了整批写锁，而 `learner.setStatus` / `applyOrganize` 内部也套同一把 —— 依赖
     * 装配层那把锁**可重入**（`AsyncLocalStorage` 判 scope，已在锁内就直接执行）。若换成
     * 朴素的互斥量，第一次执行 op 就会自锁死；别在不知情的情况下改这一层。
     */
    async apply(id: string): Promise<{ ok: boolean; applied?: number; results?: DreamApplyResult[]; code?: string; error?: string }> {
      return deps.withWriteLock(async () => {
        const bundle = await readBundle(id)
        if (!bundle) return { ok: false, code: 'not-found', error: '草案不存在' }
        const { draft, manifest } = bundle
        if (manifest.status === 'applied') return { ok: false, code: 'already-applied', error: '这份草案已经应用过了' }
        if (manifest.status === 'applying') {
          return { ok: false, code: 'interrupted', error: '上次应用没有完成，请先回滚再重新生成草案' }
        }
        if (manifest.status === 'reverted') return { ok: false, code: 'reverted', error: '这份草案已经回滚过，重新生成一份再用' }

        const built = await contextOf()
        if (!built.ok) return { ok: false, code: 'state-unreadable', error: built.error }
        const checked = parseDreamPlan(draft.plan, built.ctx)
        if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error }
        // 应用阶段：任何一条被丢 = 库已经变了，整批拒绝。理由见文件头第 3 条。
        if (checked.dropped > 0 || checked.plan.ops.length !== draft.plan.ops.length) {
          return {
            ok: false,
            code: 'stale',
            error: `草案与现在的记忆库对不上（${checked.dropped} 条已失效）。请重新生成一份。`,
          }
        }

        // 备份：state / index / 每条受影响的正文。路径保留原相对结构，回滚时原样盖回去。
        const files = new Set<string>()
        for (const op of draft.plan.ops) {
          if (op.op === 'merge') {
            files.add(op.keep)
            for (const d of op.drop) files.add(d)
          } else files.add(op.id)
        }
        const backup: string[] = []
        const dir = join(deps.stateDir, DREAMS_DIR, id)
        try {
          await mkdir(join(dir, 'backup'), { recursive: true })
          // state.json 在 stateDir；启停索引是**自主库自己那份**（deps.memoriesRoot 现在指
          // evolution/notes），不是用户记忆的 memories-index.json —— 后者根本不在备份范围。
          // 两条备份 rel 都挂在 `memories/` 前缀下，回滚时才映得回自主根目录。
          const stateFiles = [
            { rel: 'evolution/state.json', from: join(deps.stateDir, 'evolution/state.json') },
            { rel: 'memories/memories-index.json', from: join(deps.memoriesRoot, 'memories-index.json') },
          ]
          for (const f of stateFiles) {
            if (!(await stat(f.from).then(() => true).catch(() => false))) continue
            const to = join(dir, 'backup', f.rel)
            await mkdir(dirname(to), { recursive: true })
            await copyFile(f.from, to)
            backup.push(f.rel)
          }
          for (const mid of files) {
            const slash = mid.lastIndexOf('/')
            if (slash <= 0) continue
            const rel = `memories/${mid}.md`
            const from = join(deps.memoriesRoot, mid.slice(0, slash), mid.slice(slash + 1) + '.md')
            if (!(await stat(from).then(() => true).catch(() => false))) continue
            const to = join(dir, 'backup', rel)
            await mkdir(dirname(to), { recursive: true })
            await copyFile(from, to)
            backup.push(rel)
          }
        } catch (e) {
          return { ok: false, code: 'backup-failed', error: deps.message(e) }
        }

        await writeManifest({
          ...manifest,
          status: 'applying',
          appliedAt: new Date(clock()).toISOString(),
          backup,
          results: [],
        })

        const results: DreamApplyResult[] = []
        let applied = 0
        for (const op of draft.plan.ops) {
          try {
            if (op.op === 'merge') {
              // 多条 drop 逐条并：mergeDraft 每次处理一对，且会自己加写锁与补 boundary。
              const failures: string[] = []
              for (const d of op.drop) {
                const r = await deps.learner.applyOrganize({ action: 'merge', keep: op.keep, ids: [op.keep, d] })
                if (r && r.ok) applied++
                else failures.push(`${d}: ${r?.error ?? r?.code ?? 'failed'}`)
              }
              results.push(
                failures.length === 0
                  ? { op, ok: true }
                  : { op, ok: false, code: 'partial', error: failures.join('; ') },
              )
            } else if (op.op === 'archive') {
              const r = await deps.learner.setStatus(op.id, 'archived', 'dream')
              if (r && r.ok) applied++
              results.push(r && r.ok ? { op, ok: true } : { op, ok: false, code: r?.code, error: r?.error })
            } else {
              const r = await deps.learner.setStatus(op.id, op.status, 'dream')
              if (r && r.ok) applied++
              results.push(r && r.ok ? { op, ok: true } : { op, ok: false, code: r?.code, error: r?.error })
            }
          } catch (e) {
            results.push({ op, ok: false, code: 'exception', error: deps.message(e) })
          }
        }

        const stateHash = await sha256OfFile(join(deps.stateDir, 'evolution/state.json'))
        await writeManifest({
          ...manifest,
          status: 'applied',
          appliedAt: new Date(clock()).toISOString(),
          backup,
          results,
          stateHash,
        })
        deps.state.invalidateCache()
        deps.rebuildCatalog().catch(() => undefined)
        await deps.log({ at: new Date().toISOString(), event: 'dream-applied', id, applied, failed: results.filter((r) => !r.ok).length })
        return { ok: true, applied, results }
      })
    },

    /**
     * 回滚：把备份盖回去，整份 state 与 index 一起恢复。
     *
     * 为什么整份恢复而不是"逐条反向操作"：反向操作要能重放每一步的中间态（merged from、
     * 旧边界、旧状态、旧索引 enabled），那本身就比备份更复杂，而且一旦有一步算错就是
     * 一个谁也说不清的状态。备份是 O(1) 的正确性。
     *
     * 代价：回滚会覆盖应用之后的所有新写入。所以先比 state.json 的摘要，不一致就拒绝
     * （`force` 才越过）。这不是保守，是让"回滚"不会无声地吃掉几条刚学会的记忆。
     */
    async revert(id: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; code?: string; error?: string; restored?: number }> {
      return deps.withWriteLock(async () => {
        const bundle = await readBundle(id)
        if (!bundle) return { ok: false, code: 'not-found', error: '草案不存在' }
        const { manifest } = bundle
        if (manifest.status === 'draft') return { ok: false, code: 'not-applied', error: '这份草案还没有应用' }
        if (manifest.status === 'reverted') return { ok: true, restored: 0 }

        const current = await sha256OfFile(join(deps.stateDir, 'evolution/state.json'))
        if (!opts.force && manifest.stateHash && current !== manifest.stateHash) {
          return {
            ok: false,
            code: 'drift',
            error: '应用之后又有新的记忆写入。回滚会一并撤销它们，确认后再试。',
          }
        }

        let restored = 0
        const dir = join(deps.stateDir, DREAMS_DIR, id)
        for (const rel of manifest.backup) {
          const from = join(dir, 'backup', rel)
          const to = rel.startsWith('memories/') ? join(deps.memoriesRoot, rel.slice('memories/'.length)) : join(deps.stateDir, rel)
          try {
            await mkdir(dirname(to), { recursive: true })
            await copyFile(from, to)
            restored++
          } catch (e) {
            // 一个文件盖不回去就停下：继续只会得到"一半新一半旧"的库。
            return { ok: false, code: 'restore-failed', error: deps.message(e) }
          }
        }
        await writeManifest({ ...manifest, status: 'reverted', revertedAt: new Date(clock()).toISOString() })
        deps.state.invalidateCache()
        deps.rebuildCatalog().catch(() => undefined)
        await deps.log({ at: new Date().toISOString(), event: 'dream-reverted', id, restored })
        return { ok: true, restored }
      })
    },
  }
}

export type Dreamer = ReturnType<typeof createDreamer>

/** 判"今天还要不要自动整理"：每日模式 + 距上次 ≥ 24h + 不在 `off`。 */
export function shouldDreamToday(
  cfg: EffectiveEvolutionConfig,
  lastDreamAt: string | undefined,
  now = Date.now(),
): boolean {
  if (cfg.dream !== 'daily' || !cfg.enabled) return false
  if (!lastDreamAt) return true
  const t = Date.parse(lastDreamAt)
  return !Number.isFinite(t) || now - t >= 24 * 3600_000
}

/** 两次**尝试**之间至少隔 6 小时：模型坏掉时别每轮重烧。 */
export const DREAM_RETRY_MS = 6 * 3600_000

export function shouldRetryDream(lastTryAt: string | undefined, now = Date.now()): boolean {
  if (!lastTryAt) return true
  const t = Date.parse(lastTryAt)
  return !Number.isFinite(t) || now - t >= DREAM_RETRY_MS
}
