// 冷路径的测试：官方压缩 → episode → outbox → 复习器 → 事件接线。
//
// 分层测，理由和 organize 那份一样：摘要算错、队列写坏、门禁判错是三种不同的 bug，
// 混在一条用例里断言失败时看不出是哪一边。
//
// 这里**不碰真模型**：`llm.prepareCall` 是注入的，回一段固定 JSON 就够验证
// "怎么解析、怎么记账、怎么落盘"。真正决定记忆质量的是 prompt 与九道门，那两块在
// evolution-write / evolution-organize 里已经钉住了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  episodeOf,
  checkpointEpisodeOf,
  MAX_EVENTS_PER_TURN,
} from '../lib/evolution/digest.js'
import { createEpisodeStore, safeSegment } from '../lib/evolution/episodes.js'
import {
  extractJson,
  parseReviewItems,
  buildReviewPrompt,
  reviewSystemPromptFor,
  createReviewBudget,
  createReviewer,
  nextRetryAt,
  outboxFailed,
  MAX_ITEMS_PER_REVIEW,
} from '../lib/evolution/review.js'
import { createColdPath, attachColdPath, checkpointTextOf, MAX_CHECKPOINT_BYTES } from '../lib/evolution/cold.js'
import { buildEvolutionOps } from '../lib/ops/evolution.js'
import { checkQuote, clearUserTexts } from '../lib/evolution/evidence.js'
import { DEFAULT_EVOLUTION_SETTINGS } from '../lib/evolution/config.js'

const message = (e) => (e instanceof Error ? e.message : String(e))
const tmp = () => mkdtemp(join(tmpdir(), 'evo-cold-'))
const MIN = 60_000

const cfgOf = (over = {}) => ({ ...DEFAULT_EVOLUTION_SETTINGS, inject: true, ...over })

/** 旧版按轮次排队的 episode 夹具（盘上可能还有，读取路径要兼容）。 */
const digestOf = (turn, over = {}) => ({
  turn,
  events: [],
  userTexts: [],
  tools: [],
  ...over,
})

/** 一段能过 `parseReviewItems` 的模型输出。 */
const REPLY_OK = JSON.stringify({
  memories: [
    { text: '提交信息用中文写', kind: 'preference', source: 'user_explicit', quote: '以后提交信息都写中文' },
  ],
})

/** 假 llm：`stream()` 回一个 text-delta 序列。`calls` 用来断言"到底调没调"。 */
function fakeLlm(reply = REPLY_OK) {
  const calls = []
  return {
    calls,
    prepareCall(cfg) {
      calls.push(cfg)
      return {
        config: { ...cfg },
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: reply }
          })()
        },
      }
    },
  }
}

/** 假 learner：只记调用，不落盘。 */
function fakeLearner(result = { ok: true }) {
  const calls = []
  return {
    calls,
    async learn(req, cfg, scope) {
      calls.push({ req, cfg, scope })
      return result
    },
  }
}

/** 假 reviewer：给 `createColdPath` 用（它只要求返回 `ReviewOutcome`）。 */
function fakeReviewer(outcome = {
  ok: true,
  learned: 1,
  rejected: 0,
  items: [{ id: 'm1', title: '测试标题', text: '测试正文', layer: 'workspace', status: 'active', confidence: 0.85 }],
}) {
  const calls = []
  return {
    calls,
    async review(ep, cfg, route) {
      calls.push({ ep, cfg, route })
      return outcome
    },
  }
}

const logs = []
const log = async (row) => {
  logs.push(row)
}

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ───────────────────────────── 官方压缩 → episode ─────────────────────────────

test('checkpointTextOf：只取 text 块、拼成纯文本、按字节截但不切坏字符', () => {
  assert.equal(checkpointTextOf(null), '')
  assert.equal(checkpointTextOf([{ type: 'image', text: 'x' }, { type: 'text', text: ' 摘要 ' }]), '摘要')
  assert.equal(checkpointTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  const long = checkpointTextOf([{ type: 'text', text: '汉'.repeat(MAX_CHECKPOINT_BYTES) }])
  assert.ok(Buffer.byteLength(long, 'utf8') <= MAX_CHECKPOINT_BYTES)
  assert.equal(long, '汉'.repeat(Math.floor(MAX_CHECKPOINT_BYTES / 3)))
})

test('checkpointEpisodeOf：id 用官方 seq，不带用户原话，reason 是 compaction', () => {
  const ep = checkpointEpisodeOf({
    session: 's1', seq: 42, at: '2026-01-01T00:00:00.000Z', checkpoint: '## Critical Context\n- 用中文回复',
    cwd: 'C:/ws', workspaceHash: 'h1',
  })
  assert.equal(ep.id, 's1:compact:42')
  assert.equal(ep.turn, 42)
  assert.equal(ep.reason, 'compaction')
  assert.equal(ep.checkpoint, '## Critical Context\n- 用中文回复')
  assert.deepEqual(ep.userTexts, [], 'checkpoint 是转述，不能伪装成用户原话')
  assert.deepEqual(ep.tools, [])
  assert.equal(ep.cwd, 'C:/ws')
  assert.equal(ep.workspaceHash, 'h1')
})

test('episodeOf：旧版轮次 episode 仍可构造（盘上旧队列项要读得出来）', () => {
  const ep = episodeOf(digestOf(5, {
    userTexts: Array.from({ length: 12 }, (_, i) => 'u' + i),
    tools: Array.from({ length: 16 }, (_, i) => 't' + i),
  }), { session: 's1', at: '2026-01-01T00:00:00.000Z', reason: 'signal' })
  assert.equal(ep.id, 's1:5')
  assert.equal(ep.userTexts.length, 8)
  assert.equal(ep.userTexts[0], 'u4')
  assert.equal('checkpoint' in ep, false)
})

// ───────────────────────────── outbox ─────────────────────────────

test('episodes：写 → 入队 → 折叠取最新状态', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  const ep = episodeOf(digestOf(1), { session: 's1', at: '2026-01-01T00:00:00.000Z', reason: 'signal' })
  const w = await store.write(ep)
  assert.equal(w.ok, true)
  assert.deepEqual(await store.read(w.path), ep)

  const item = await store.enqueue({ id: ep.id, session: 's1', turn: 1, at: ep.at, path: w.path })
  assert.equal(item.status, 'pending')
  assert.equal(item.attempts, 0)

  await store.mark(item, { status: 'failed', attempts: 1, reason: 'boom' })
  await store.mark(item, { status: 'done', reason: 'learned 1' })
  const all = await store.list()
  assert.equal(all.length, 1, '同一个 id 只应折叠成一条')
  assert.equal(all[0].status, 'done')
  assert.equal(all[0].reason, 'learned 1')
})

test('episodes：半截 JSON 行不影响其余队列', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  await mkdir(join(dir, 'evolution'), { recursive: true })
  const good = JSON.stringify({ id: 's1:1', session: 's1', turn: 1, at: 'x', path: 'p', status: 'pending', attempts: 0 })
  await writeFile(join(dir, 'evolution/outbox.jsonl'), good + '\n' + '{"id":"s1:2","tru', 'utf8')
  const all = await store.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].id, 's1:1')
})

test('episodes：retryable 尊重退避与状态', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  const base = { session: 's1', at: '2026-01-01T00:00:00.000Z', path: 'p' }
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  await store.enqueue({ ...base, id: 's1:1', turn: 1 })
  await store.enqueue({ ...base, id: 's1:2', turn: 2 })
  await store.enqueue({ ...base, session: 's2', id: 's2:1', turn: 1 })

  const all = await store.list()
  const second = all.find((x) => x.id === 's1:2')
  await store.mark(second, { status: 'failed', attempts: 1, nextAt: now + 5 * MIN })

  const ready = await store.retryable('s1', 10, now)
  assert.deepEqual(ready.map((x) => x.id), ['s1:1'])
  const later = await store.retryable('s1', 10, now + 5 * MIN)
  assert.deepEqual(later.map((x) => x.id), ['s1:1', 's1:2'])
  assert.equal((await store.retryable('s1', 1, now + 5 * MIN)).length, 1)
})

test('episodes：compact 清掉老 done，保留 pending 与新的 done', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  const old = new Date(Date.now() - 40 * 86400_000).toISOString()
  const fresh = new Date().toISOString()
  await mkdir(join(dir, 'evolution'), { recursive: true })
  const rows = [
    { id: 's1:1', session: 's1', turn: 1, at: old, path: 'p', status: 'done', attempts: 1 },
    { id: 's1:2', session: 's1', turn: 2, at: old, path: 'p', status: 'pending', attempts: 0 },
    { id: 's1:3', session: 's1', turn: 3, at: fresh, path: 'p', status: 'done', attempts: 1 },
  ]
  await writeFile(join(dir, 'evolution/outbox.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const r = await store.compact(30)
  assert.equal(r.dropped, 1)
  assert.deepEqual((await store.list()).map((x) => x.id), ['s1:2', 's1:3'])
  const text = await readFile(join(dir, 'evolution/outbox.jsonl'), 'utf8')
  assert.equal(text.trim().split('\n').length, 2)
  for (const line of text.trim().split('\n')) JSON.parse(line)
})

test('episodes：prune 只删 30 天前的摘要（按文件 mtime，不看正文）', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  const now = Date.now()
  const day = 86400_000
  const oldEp = episodeOf(digestOf(1, { userTexts: ['旧的一轮'] }), { session: 's1', at: new Date(now).toISOString(), reason: 'signal' })
  const newEp = episodeOf(digestOf(2, { userTexts: ['新的一轮'] }), { session: 's1', at: new Date(now).toISOString(), reason: 'periodic' })
  const a = await store.write(oldEp)
  const b = await store.write(newEp)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  await utimes(join(dir, a.path), new Date(now - 40 * day), new Date(now - 40 * day))
  await utimes(join(dir, b.path), new Date(now - day), new Date(now - day))
  const r = await store.prune(30, now)
  assert.equal(r.removed, 1)
  await assert.rejects(readFile(join(dir, a.path), 'utf8'), '过期摘要要删掉')
  assert.equal(JSON.parse(await readFile(join(dir, b.path), 'utf8')).turn, 2)
  const other = await store.write(episodeOf(digestOf(1, {}), { session: 's2', at: new Date(now).toISOString(), reason: 'signal' }))
  await utimes(join(dir, other.path), new Date(now - 40 * day), new Date(now - 40 * day))
  assert.equal((await store.prune(30, now)).removed, 1)
})

test('safeSegment：会话 id 里的路径分隔符被压平', () => {
  assert.equal(safeSegment('a/b\\c'), 'a_b_c')
  assert.equal(safeSegment('..'), 'unknown')
  assert.equal(safeSegment(''), 'unknown')
  assert.ok(safeSegment('x'.repeat(200)).length <= 80)
})

// ───────────────────────────── 解析与提示词 ─────────────────────────────

test('extractJson：整段 / 代码围栏 / 前后带人话', () => {
  assert.deepEqual(extractJson('{"memories":[]}'), { memories: [] })
  assert.deepEqual(extractJson('```json\n{"memories":[{"text":"a"}]}\n```'), { memories: [{ text: 'a' }] })
  assert.deepEqual(extractJson('好的，结果如下：\n{"memories":[]}\n希望有帮助'), { memories: [] })
  assert.equal(extractJson('完全不是 JSON'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson('  '), null)
})

test('parseReviewItems：越界字段丢弃，缺 text 整条丢', () => {
  const items = parseReviewItems({
    memories: [
      { title: ' 包管理器 ', text: ' 用 pnpm ', kind: 'nonsense', source: 'made_up', quote: ' 以后用 pnpm ', layer: 'mars', ttlDays: -3 },
      { text: '', source: 'user_explicit' },
      { kind: 'fact', source: 'user_explicit' },
      { text: '第二条', source: 'tool_verified' },
      { text: '第三条', source: 'user_explicit' },
      { text: '第四条该被截掉', source: 'user_explicit' },
    ],
  })
  assert.equal(items.length, MAX_ITEMS_PER_REVIEW)
  assert.equal(items[0].text, '用 pnpm')
  assert.equal(items[0].title, '包管理器')
  assert.equal('kind' in items[0], false)
  assert.equal('layer' in items[0], false)
  assert.equal('ttlDays' in items[0], false)
  assert.equal(items[0].source, 'model_inference')
  assert.equal(items[0].quote, '以后用 pnpm')
  assert.equal(items[2].source, 'user_explicit')
})

test('parseReviewItems：认 items 别名，空输入不炸', () => {
  assert.equal(parseReviewItems({ items: [{ text: 'a', source: 'user_explicit' }] }).length, 1)
  assert.deepEqual(parseReviewItems(null), [])
  assert.deepEqual(parseReviewItems({ memories: 'nope' }), [])
})

test('buildReviewPrompt：压缩 episode 带 checkpoint，旧 episode 仍按轮次渲染', () => {
  const ep = checkpointEpisodeOf({ session: 's1', seq: 9, at: 'x', checkpoint: '## Critical Context\n- 用户偏好中文回复' })
  const p = buildReviewPrompt(ep, ['commit-lang — 提交信息用中文'])
  assert.match(p, /Host-compiled checkpoint/)
  assert.match(p, /用户偏好中文回复/)
  assert.match(p, /commit-lang/)
  assert.match(p, /只输出 JSON/)

  const old = buildReviewPrompt(
    episodeOf(digestOf(3, { userTexts: ['记住：提交信息写中文'] }), { session: 's1', at: 'x', reason: 'signal' }),
    [],
  )
  assert.match(old, /记住：提交信息写中文/)
  assert.match(buildReviewPrompt(episodeOf(digestOf(1), { session: 's', at: 'x', reason: 'periodic' }), []), /\(none\)/)
})

test('reviewSystemPromptFor：压缩版明确排除任务态章节、禁止伪造引句', () => {
  const ep = checkpointEpisodeOf({ session: 's1', seq: 9, at: 'x', checkpoint: 'checkpoint' })
  const p = reviewSystemPromptFor(ep, cfgOf())
  assert.match(p, /DISCARD everything task-local/)
  assert.match(p, /Current Work, Next Step, Pending Jobs/)
  assert.match(p, /never invent a `quote`/)
  assert.match(p, /"model_inference"/)
  // 旧 episode 仍用逐字原话那套提示（不能要求引句来自转述）。
  const old = reviewSystemPromptFor(episodeOf(digestOf(1), { session: 's', at: 'x', reason: 'signal' }), cfgOf())
  assert.match(old, /exact substring/)
  assert.equal(old.includes('DISCARD everything task-local'), false)
})

// ───────────────────────────── 退避 ─────────────────────────────

test('nextRetryAt：1min → 5min → 30min，且不越界', () => {
  const now = 1_000_000
  assert.equal(nextRetryAt(1, now), now + 1 * MIN)
  assert.equal(nextRetryAt(2, now), now + 5 * MIN)
  assert.equal(nextRetryAt(3, now), now + 30 * MIN)
  assert.equal(nextRetryAt(99, now), now + 30 * MIN)
  assert.equal(nextRetryAt(0, now), now + 1 * MIN)
})

test('outboxFailed：第 3 次进 dead-letter，不再退避', () => {
  const item = { id: 's1:1', session: 's1', turn: 1, at: 'x', path: 'p', status: 'pending', attempts: 0 }
  const a = outboxFailed(item, 'boom')
  assert.equal(a.status, 'failed')
  assert.equal(a.attempts, 1)
  assert.ok(a.nextAt > Date.now())
  const b = outboxFailed({ ...item, attempts: 2 }, 'boom')
  assert.equal(b.status, 'dead')
  assert.equal('nextAt' in b, false)
})

// ───────────────────────────── 复习器 ─────────────────────────────

test('reviewer：没有 llm 服务 → no-llm，不占学习名额', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const r = createReviewer({ llm: null, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-llm')
  assert.equal(await budget.remaining('s1'), 2)
})

test('review budget：生效配置的上限覆盖默认值，0 = 不复习', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  assert.equal(await budget.remaining('s1', 5), 5)
  assert.equal(await budget.remaining('s1', 0), 0)
  await budget.spend('s1')
  assert.equal(await budget.remaining('s1', 5), 4)
  assert.equal(await budget.remaining('s1'), 1)
})

test('reviewer：上限设 0 时一次都不跑', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ maxReviewsPerSession: 0 }), { provider: 'p', model: 'm' })
  assert.equal(out.reason, 'budget')
  assert.equal(llm.calls.length, 0)
})

test('reviewer：拿不到模型路由 → no-model，不占学习名额', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ model: '' }), null)
  assert.equal(out.reason, 'no-model')
  assert.equal(llm.calls.length, 0)
  assert.equal(await budget.remaining('s1'), 2)
})

test('reviewer：解析出条目后逐条过 learner，成功才记一次', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm(
    '```json\n' + JSON.stringify({
      memories: [
        { title: '提交语言', text: '提交信息用中文', kind: 'preference', source: 'user_explicit', quote: '以后提交信息都写中文', key: 'commit-lang' },
        { text: '这个项目用 pnpm', source: 'tool_verified' },
      ],
    }) + '\n```',
  )
  const learner = fakeLearner()
  const r = createReviewer({ llm, learner, budget, catalogLines: async () => ['commit-lang'], log, message })
  const ep = episodeOf(digestOf(2, { userTexts: ['以后提交信息都写中文'] }), { session: 's1', at: 'x', reason: 'signal', workspaceHash: 'h1' })
  const out = await r.review(ep, cfgOf({ model: '' }), { provider: 'p', model: 'm' })
  assert.equal(out.ok, true)
  assert.equal(out.learned, 2)
  assert.equal(learner.calls.length, 2)
  assert.deepEqual(learner.calls[0].scope, { sessionId: 's1', workspaceHash: 'h1' })
  assert.equal(learner.calls[0].req.key, 'commit-lang')
  assert.equal(learner.calls[0].req.title, '提交语言')
  assert.equal(learner.calls[0].req.quote, '以后提交信息都写中文')
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(llm.calls[0].temperature, 0)
  assert.equal(await budget.remaining('s1'), 1)
})

test('reviewer：压缩条目一律按 model_inference，不带伪装成用户原话的 quote', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm(JSON.stringify({
    memories: [{ title: '回复语言', text: '用中文回复', source: 'user_explicit', quote: '以后都用中文' }],
  }))
  const learner = fakeLearner()
  const r = createReviewer({ llm, learner, budget, catalogLines: async () => [], log, message })
  const ep = checkpointEpisodeOf({ session: 's1', seq: 12, at: 'x', checkpoint: '## Critical Context\n- 用户希望中文回复' })
  const out = await r.review(ep, cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, true)
  assert.equal(learner.calls[0].req.source, 'model_inference')
  assert.equal('quote' in learner.calls[0].req, false)
})

test('reviewer：`model` 只写 model 时沿用会话的 provider', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ model: 'fast-model' }), { provider: 'live-provider', model: 'live-model' })
  assert.deepEqual(llm.calls[0], { provider: 'live-provider', model: 'fast-model', temperature: 0 })
})

test('reviewer：输出不是 JSON → bad-json，可重试且不占学习名额', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const learner = fakeLearner()
  const r = createReviewer({ llm: fakeLlm('我觉得这轮没啥好记的'), learner, budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'bad-json')
  assert.equal(learner.calls.length, 0)
  assert.equal(await budget.remaining('s1'), 2, '失败不占「成功学习次数」')
})

test('reviewer：空列表算成功（模型判断"不值得记"是正常结论）', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const r = createReviewer({ llm: fakeLlm('{"memories":[]}'), learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, true)
  assert.equal(out.learned, 0)
  assert.equal(await budget.remaining('s1'), 1)
})

test('reviewer：门禁拒绝计入 rejected，不打断后面的条目', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const calls = []
  const learner = {
    async learn(req) {
      calls.push(req)
      return calls.length === 1 ? { ok: false, code: 'duplicate', gate: 'novelty' } : { ok: true }
    },
  }
  const r = createReviewer({ llm: fakeLlm(JSON.stringify({ memories: [{ text: '第一条' }, { text: '第二条' }] })), learner, budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.learned, 1)
  assert.equal(out.rejected, 1)
  assert.equal(calls.length, 2)
})

test('reviewer：预算用光 → budget，且不调模型', async () => {
  const dir = await tmp()
  const path = join(dir, 'reviews.json')
  const budget = createReviewBudget({ path, max: 1, message })
  await budget.spend('s1')
  assert.equal(await budget.remaining('s1'), 0)
  const reloaded = createReviewBudget({ path, max: 1, message })
  assert.equal(await reloaded.remaining('s1'), 0)

  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ maxReviewsPerSession: 1 }), { provider: 'p', model: 'm' })
  assert.equal(out.reason, 'budget')
  assert.equal(llm.calls.length, 0)
  assert.equal(await budget.remaining('s2'), 1)
})

test('reviewer：模型报错 → 不抛，失败不占学习名额', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const r = createReviewer({ llm: { prepareCall() { throw new Error('upstream 500') } }, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, false)
  assert.match(out.error, /upstream 500/)
  assert.equal(await budget.remaining('s1'), 2, '失败由 outbox 的三次退避兜住，不靠扣学习次数')
})

// ───────────────────────────── 冷路径接线 ─────────────────────────────

async function coldFixture(over = {}) {
  const dir = await tmp()
  const episodes = createEpisodeStore({ stateDir: dir, message })
  const reviewer = over.reviewer ?? fakeReviewer()
  const cold = createColdPath({
    effectiveOf: over.effectiveOf ?? (async () => cfgOf({ enabled: true })),
    episodes,
    reviewer,
    workspaceHashOf: () => 'h1',
    log,
    message,
    ...(over.now ? { now: over.now } : {}),
  })
  return { dir, episodes, reviewer, cold }
}

const CHECKPOINT = [
  { type: 'text', text: '## Critical Context\n- 用户偏好中文回复\n- 提交信息用中文' },
]

test('cold：官方压缩写 episode + 入队 + 复习到 done', async () => {
  const { dir, episodes, reviewer, cold } = await coldFixture()
  await cold.compactionSummary('s1', 42, CHECKPOINT, 'C:/ws')

  const all = await episodes.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].id, 's1:compact:42')
  assert.equal(all[0].status, 'done')
  assert.equal(all[0].reason, 'learned 1')
  assert.equal(all[0].learnedItems[0].id, 'm1')
  assert.equal(reviewer.calls.length, 1)
  const ep = await episodes.read(all[0].path)
  assert.equal(ep.cwd, 'C:/ws')
  assert.equal(ep.workspaceHash, 'h1')
  assert.equal(ep.reason, 'compaction')
  assert.match(ep.checkpoint, /用户偏好中文回复/)
  assert.ok(dir)
})

test('cold：没有压缩事件就不排队（热路径自己负责当场记）', async () => {
  const { episodes, cold } = await coldFixture()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await episodes.list()).length, 0)
  assert.equal((await cold.stats()).pending, 0)
})

test('cold：summary 没有可读文本时不入队', async () => {
  const { episodes, reviewer, cold } = await coldFixture()
  await cold.compactionSummary('s1', 42, [{ type: 'image' }])
  assert.equal((await episodes.list()).length, 0)
  assert.equal(reviewer.calls.length, 0)
})

test('cold：开关关掉时既不封存也不复习', async () => {
  const { episodes, reviewer, cold } = await coldFixture({ effectiveOf: async () => cfgOf({ enabled: false }) })
  await cold.compactionSummary('s1', 42, CHECKPOINT)
  assert.equal((await episodes.list()).length, 0)
  assert.equal(reviewer.calls.length, 0)
})

test('cold：失败按退避重排，第 3 次进 dead-letter', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, error: 'upstream 500' })
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const { episodes, cold } = await coldFixture({ reviewer, now: () => now })

  await cold.compactionSummary('s1', 42, CHECKPOINT)
  let item = (await episodes.list())[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 1)
  assert.equal(item.nextAt, now + 1 * MIN)

  assert.equal((await episodes.retryable('s1', 5, now)).length, 0)
  now += 1 * MIN
  await cold.drain('s1')
  item = (await episodes.list())[0]
  assert.equal(item.attempts, 2)
  assert.equal(item.nextAt, now + 5 * MIN)

  now += 5 * MIN
  await cold.drain('s1')
  item = (await episodes.list())[0]
  assert.equal(item.status, 'dead')
  assert.equal(item.attempts, 3)
  assert.equal((await cold.stats()).dead, 1)
  await cold.drain('s1')
  assert.equal(reviewer.calls.length, 3)
})

test('cold：坏 JSON / 拿不到模型可重试，不再直接标 done', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, reason: 'bad-json' })
  const { episodes, cold } = await coldFixture({ reviewer })
  await cold.compactionSummary('s1', 42, CHECKPOINT)
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'failed')
  assert.equal((await cold.stats()).done, 0)
})

test('cold：预算用光不是失败，标 done 并从队列消失', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, reason: 'budget' })
  const { episodes, cold } = await coldFixture({ reviewer })
  await cold.compactionSummary('s1', 42, CHECKPOINT)
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'done')
  assert.equal(item.reason, 'budget')
  await cold.drain('s1')
  assert.equal(reviewer.calls.length, 1)
})

test('cold：episode 文件丢了标 orphan，不反复重试', async () => {
  const { episodes, reviewer, cold } = await coldFixture()
  await episodes.enqueue({ id: 's1:9', session: 's1', turn: 9, at: new Date().toISOString(), path: 'evolution/episodes/s1/9.json' })
  await cold.drain('s1')
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'orphan')
  assert.equal(reviewer.calls.length, 0)
})

test('cold：replay 只跑 pending / failed，且幂等', async () => {
  const first = fakeReviewer()
  const { episodes, cold } = await coldFixture({ reviewer: first })
  await cold.compactionSummary('s1', 42, CHECKPOINT)
  assert.equal(first.calls.length, 1)

  const second = fakeReviewer()
  const cold2 = createColdPath({
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer: second,
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  const r = await cold2.replay()
  assert.deepEqual(r, { attempted: 0, done: 0, failed: 0 })
  assert.equal(second.calls.length, 0)
})

test('cold：replay 会捡起上次进程留下的 pending', async () => {
  const { episodes } = await coldFixture()
  const ep = checkpointEpisodeOf({ session: 's1', seq: 42, at: 'x', checkpoint: 'checkpoint' })
  const w = await episodes.write(ep)
  await episodes.enqueue({ id: ep.id, session: 's1', turn: ep.turn, at: ep.at, path: w.path })

  const reviewer = fakeReviewer()
  const cold2 = createColdPath({
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer,
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  const r = await cold2.replay()
  assert.deepEqual(r, { attempted: 1, done: 1, failed: 0 })
  assert.equal((await episodes.list())[0].status, 'done')
})

test('cold：同会话串行（第二次 drain 看得见第一次的结果）', async () => {
  const order = []
  const reviewer = {
    async review(ep) {
      order.push('start ' + ep.session)
      await new Promise((r) => setTimeout(r, 20))
      order.push('end ' + ep.session)
      return { ok: true, learned: 1, rejected: 0 }
    },
  }
  const { episodes, cold } = await coldFixture({ reviewer })
  const ep = checkpointEpisodeOf({ session: 's1', seq: 42, at: 'x', checkpoint: 'checkpoint' })
  const w = await episodes.write(ep)
  await episodes.enqueue({ id: ep.id, session: 's1', turn: ep.turn, at: ep.at, path: w.path })

  await Promise.all([cold.drain('s1'), cold.drain('s1')])
  assert.deepEqual(order, ['start s1', 'end s1'])
  assert.equal((await episodes.list())[0].status, 'done')
})

test('cold：retry 把 dead 项重新排队，计数清零后再跑一遍', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, error: 'upstream 500' })
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const { episodes, cold } = await coldFixture({ reviewer, now: () => now })
  await cold.compactionSummary('s1', 42, CHECKPOINT)
  now += 1 * MIN
  await cold.drain('s1')
  now += 5 * MIN
  await cold.drain('s1')
  assert.equal((await episodes.list())[0].status, 'dead')

  const r = await cold.retry('s1:compact:42')
  assert.deepEqual(r, { ok: true, session: 's1' })
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 1)
  assert.equal(item.nextAt, now + 1 * MIN)
  assert.deepEqual(await cold.retry('不存在'), { ok: false })
})

// ───────────────────────────── 手动重跑（op 层） ─────────────────────────────

test('op：evolution-queue 只列未完成的项，dead 排最前', async () => {
  const cold = {
    async queue() {
      return [
        { id: 's1:1', session: 's1', turn: 1, at: '2026-11-10T09:00:00.000Z', path: 'p', status: 'done', attempts: 1, learnedItems: [{ id: 'm1', title: '测试标题', text: '测试正文', layer: 'workspace', status: 'active', confidence: 0.85 }] },
        { id: 's1:2', session: 's1', turn: 2, at: 'x', path: 'p', status: 'pending', attempts: 0 },
        { id: 's1:3', session: 's1', turn: 3, at: 'x', path: 'p', status: 'dead', attempts: 3, reason: 'upstream 500' },
        { id: 's1:4', session: 's1', turn: 4, at: 'x', path: 'p', status: 'failed', attempts: 1, reason: 'timeout', nextAt: 99 },
      ]
    },
    async stats() { return { pending: 1, failed: 1, dead: 1, done: 1 } },
  }
  const ops = buildEvolutionOps({ cold: () => cold, message })
  const res = await ops['evolution-queue']({})
  assert.equal(res.ok, true)
  assert.deepEqual(res.stats, { pending: 1, failed: 1, dead: 1, done: 1 })
  assert.deepEqual(res.items.map((x) => x.id), ['s1:3', 's1:4', 's1:2'])
  assert.equal(res.items[0].reason, 'upstream 500')
  assert.equal(res.items[1].nextAt, 99)
  assert.deepEqual(res.recent.map((x) => x.id), ['s1:1'])
  assert.equal(res.recent[0].learnedItems[0].id, 'm1')
})

test('op：evolution-replay 带 id 走 retry，不带 id 走整队重放', async () => {
  const calls = []
  const cold = {
    async retry(id) {
      calls.push(['retry', id])
      return id === 's1:1' ? { ok: true, session: 's1' } : { ok: false }
    },
    async replay() {
      calls.push(['replay'])
      return { attempted: 3, done: 2, failed: 1 }
    },
  }
  const ops = buildEvolutionOps({ cold: () => cold, message })
  assert.deepEqual(await ops['evolution-replay']({ id: 's1:1' }), { ok: true, attempted: 1 })
  assert.deepEqual(await ops['evolution-replay']({}), { ok: true, attempted: 3, done: 2, failed: 1 })
  assert.equal((await ops['evolution-replay']({ id: 'nope' })).code, 'not-found')
  assert.deepEqual(calls, [['retry', 's1:1'], ['replay'], ['retry', 'nope']])

  const coldLess = buildEvolutionOps({ cold: () => null, message })
  assert.equal((await coldLess['evolution-queue']({})).code, 'no-cold')
  assert.equal((await coldLess['evolution-replay']({})).code, 'no-cold')
})

// ───────────────────────────── 事件接线 ─────────────────────────────

/** 最小的事件总线替身：只记住 `session/event` 的处理器。 */
function fakeCtx() {
  const handlers = new Map()
  return {
    on(name, cb) { handlers.set(name, cb) },
    emit(name, ...args) {
      handlers.get(name)?.(...args)
      return handlers.has(name)
    },
    has(name) { return handlers.has(name) },
  }
}

const summaryEvent = (seq, summary) => ({ type: 'compaction/summary', seq, data: { summary } })

test('attachColdPath：只有官方压缩事件才排队，turn/end 不再触发复习', async () => {
  const { episodes, reviewer } = await coldFixture()
  const ctx = fakeCtx()
  const cold = attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer,
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  assert.equal(ctx.has('session/event'), true)

  const session = { id: 's1', header: { cwd: 'C:/ws' } }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 8 } })
  ctx.emit('session/event', session, { type: 'user/message', data: { content: [{ type: 'text', text: '记住：以后用 pnpm' }] } })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await episodes.list()).length, 0, '没压缩就不复习')
  assert.equal(reviewer.calls.length, 0)

  ctx.emit('session/event', session, summaryEvent(31, CHECKPOINT))
  await waitFor(async () => (await episodes.list()).length === 1 && (await episodes.list())[0].status === 'done')
  const item = (await episodes.list())[0]
  assert.equal(item.id, 's1:compact:31')
  assert.equal(reviewer.calls.length, 1)
})

test('attachColdPath：压缩事件排队并复习，路由来自请求头', async () => {
  const { episodes, reviewer } = await coldFixture()
  const ctx = fakeCtx()
  attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer,
    workspaceHashOf: () => 'h1',
    log,
    message,
  })

  const session = { id: 's1', header: { cwd: 'C:/ws' } }
  ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
  ctx.emit('session/event', session, summaryEvent(31, CHECKPOINT))

  await waitFor(async () => (await episodes.list()).length === 1 && (await episodes.list())[0].status === 'done')
  assert.deepEqual(reviewer.calls[0].route, { provider: 'p', model: 'm' })
})

test('attachColdPath：真人消息仍喂证据缓存，合成消息不算用户说的话', async () => {
  const { episodes } = await coldFixture()
  const ctx = fakeCtx()
  attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  const session = { id: 's1' }
  // 各注入插件的合成消息也常出现"记住"两个字，不能当成用户说的话。
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '记住：不要记这一句' }], source: { kind: 'runtime-context' } },
  })
  assert.equal(checkQuote('s1', '不要记这一句').ok, false)

  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '以后提交信息都用中文写' }], source: { kind: 'user' } },
  })
  assert.deepEqual(checkQuote('s1', '提交信息都用中文'), { ok: true, index: 0 })
  assert.equal(checkQuote('s1', '提交信息都用英文').ok, false)
  clearUserTexts('s1')
  assert.equal((await episodes.list()).length, 0, '用户消息本身不触发复习')
})

test('attachColdPath：配置读取抛异常时只写日志，不冒泡到会话主链', async () => {
  const ctx = fakeCtx()
  const before = logs.length
  attachColdPath(ctx, {
    effectiveOf: async () => { throw new Error('config 炸了') },
    episodes: createEpisodeStore({ stateDir: await tmp(), message }),
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  ctx.emit('session/event', { id: 's1' }, summaryEvent(31, CHECKPOINT))
  await waitFor(() => logs.slice(before).some((r) => r.event === 'compaction-failed'))
})

test('attachColdPath：没有 seq / 空 session 的压缩事件被忽略', async () => {
  const { episodes, reviewer } = await coldFixture()
  const ctx = fakeCtx()
  attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  ctx.emit('session/event', { id: 's1' }, { type: 'compaction/summary', data: { summary: CHECKPOINT } })
  ctx.emit('session/event', { id: '' }, summaryEvent(31, CHECKPOINT))
  ctx.emit('session/event', { id: 's1' }, null)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await episodes.list()).length, 0)
  assert.equal(reviewer.calls.length, 0)
})
