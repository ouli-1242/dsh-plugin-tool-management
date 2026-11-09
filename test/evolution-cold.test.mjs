// 冷路径的测试：轮内摘要 → episode → outbox → 复习器 → 事件接线。
//
// 分层测，理由和 organize 那份一样：摘要算错、队列写坏、门禁判错是三种不同的 bug，
// 混在一条用例里断言失败时看不出是哪一边。
//
// 这里**不碰真模型**：`llm.prepareCall` 是注入的，回一段固定 JSON 就够验证
// "怎么解析、怎么记账、怎么落盘"。真正决定记忆质量的是 prompt 与九道门，那两块在
// evolution-write / evolution-organize 里已经钉住了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  signalsOf,
  reviewDecision,
  createDigestStore,
  episodeOf,
  MAX_EVENT_TEXT,
  MAX_EVENTS_PER_TURN,
} from '../lib/evolution/digest.js'
import { createEpisodeStore, safeSegment } from '../lib/evolution/episodes.js'
import {
  extractJson,
  parseReviewItems,
  buildReviewPrompt,
  createReviewBudget,
  createReviewer,
  nextRetryAt,
  outboxFailed,
  MAX_ITEMS_PER_REVIEW,
} from '../lib/evolution/review.js'
import { createColdPath, attachColdPath } from '../lib/evolution/cold.js'
import { buildEvolutionOps } from '../lib/ops/evolution.js'
import { checkQuote, clearUserTexts } from '../lib/evolution/evidence.js'
import { DEFAULT_EVOLUTION_SETTINGS } from '../lib/evolution/config.js'

const message = (e) => (e instanceof Error ? e.message : String(e))
const tmp = () => mkdtemp(join(tmpdir(), 'evo-cold-'))
const MIN = 60_000

/** 生效配置：只在复习里用到 `model` / `reviewEveryTurns`，其余给默认值。 */
const cfgOf = (over = {}) => ({ ...DEFAULT_EVOLUTION_SETTINGS, inject: true, ...over })

/** 一轮摘要：`userTexts` 与 `tools` 都是调用方给的。 */
const digestOf = (turn, over = {}) => ({
  turn,
  events: [],
  userTexts: [],
  tools: [],
  toolNames: new Map(),
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
function fakeReviewer(outcome = { ok: true, learned: 1, rejected: 0 }) {
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

// ───────────────────────────── 信号与决策 ─────────────────────────────

test('signalsOf：显式要求 / 纠正 / 反问', () => {
  assert.deepEqual(signalsOf('记住：以后提交信息都用中文'), { explicit: true, correction: false })
  assert.deepEqual(signalsOf('from now on always use pnpm'), { explicit: true, correction: false })
  assert.deepEqual(signalsOf('不对，应该用 pnpm'), { explicit: false, correction: true })
  // 问句里的"不对"是确认，不是纠正。
  assert.deepEqual(signalsOf('不是这样吗？'), { explicit: false, correction: false })
  // 问句里出现显式的"应该是"仍然算纠正。
  assert.deepEqual(signalsOf('这里应该是 pnpm 吧？'), { explicit: false, correction: true })
  assert.deepEqual(signalsOf('   '), { explicit: false, correction: false })
  // 普通对话不该有信号：否则每一轮都会复习。
  assert.deepEqual(signalsOf('帮我看一下这个文件'), { explicit: false, correction: false })
})

test('reviewDecision：signal > tools > periodic > none', () => {
  const signal = reviewDecision(digestOf(1, { userTexts: ['记住用 pnpm'] }), 8)
  assert.equal(signal.review, true)
  assert.equal(signal.reason, 'signal')
  assert.deepEqual(signal.signals, { explicit: 1, correction: 0 })

  // 两个以上工具：可能"查出来一个值得记的事实"。
  const tools = reviewDecision(digestOf(2, { tools: ['read', 'grep'] }), 8)
  assert.equal(tools.reason, 'tools')
  assert.equal(reviewDecision(digestOf(2, { tools: ['read'] }), 8).review, false)

  // 到点复习。
  assert.equal(reviewDecision(digestOf(8, {}), 8).reason, 'periodic')
  assert.equal(reviewDecision(digestOf(9, {}), 8).reason, 'none')
  // turn 0（turn/start 之前的消息）不按周期触发，否则开局就白花一次。
  assert.equal(reviewDecision(digestOf(0, {}), 1).review, false)
  // 信号优先：第 8 轮同时有信号，reason 应该是 signal 而不是 periodic。
  assert.equal(reviewDecision(digestOf(8, { userTexts: ['记住这个'] }), 8).reason, 'signal')
})

// ───────────────────────────── digest store ─────────────────────────────

test('digest：文本截断、事件上限、seal 取走即清空', () => {
  const store = createDigestStore()
  for (let i = 0; i < MAX_EVENTS_PER_TURN + 5; i++) {
    store.capture('s1', 1, { kind: 'user', text: 'x'.repeat(MAX_EVENT_TEXT + 100) })
  }
  const d = store.seal('s1', 1)
  assert.equal(d.events.length, MAX_EVENTS_PER_TURN)
  assert.equal(d.events[0].text.length, MAX_EVENT_TEXT)
  assert.equal(d.userTexts[0].length, MAX_EVENT_TEXT)
  // 取走过一次，再取就没有了（防止同一轮复习两遍）。
  assert.equal(store.seal('s1', 1), undefined)
  assert.deepEqual(store.stats(), { sessions: 0, turns: 0 })
})

test('digest：每个会话只留最近 4 轮', () => {
  const store = createDigestStore()
  for (let t = 1; t <= 6; t++) store.capture('s1', t, { kind: 'user', text: 'turn ' + t })
  assert.equal(store.stats().turns, 4)
  assert.equal(store.seal('s1', 1), undefined)
  assert.equal(store.seal('s1', 6).turn, 6)
})

test('digest：工具名按 callId 反查，空 session 不落桶', () => {
  const store = createDigestStore()
  store.noteToolCall('s1', 3, 'call-1', 'mcp__fs__read')
  assert.equal(store.toolNameOf('s1', 3, 'call-1'), 'mcp__fs__read')
  assert.equal(store.toolNameOf('s1', 3, 'call-x'), '')
  store.capture('', 1, { kind: 'user', text: '记住' })
  assert.deepEqual(store.stats(), { sessions: 1, turns: 1 })
})

test('digest：drop 单个轮次 / 整个会话', () => {
  const store = createDigestStore()
  store.capture('s1', 1, { kind: 'user', text: 'a' })
  store.capture('s1', 2, { kind: 'user', text: 'b' })
  store.drop('s1', 1)
  assert.deepEqual(store.stats(), { sessions: 1, turns: 1 })
  store.drop('s1')
  assert.deepEqual(store.stats(), { sessions: 0, turns: 0 })
})

test('episodeOf：只留最近 8 句用户原话、12 个工具', () => {
  const digest = digestOf(5, {
    userTexts: Array.from({ length: 12 }, (_, i) => 'u' + i),
    tools: Array.from({ length: 16 }, (_, i) => 't' + i),
  })
  const ep = episodeOf(digest, { session: 's1', at: '2026-01-01T00:00:00.000Z', reason: 'signal' })
  assert.equal(ep.id, 's1:5')
  assert.equal(ep.userTexts.length, 8)
  assert.equal(ep.userTexts[0], 'u4')
  assert.equal(ep.tools.length, 12)
  assert.equal(ep.tools[0], 't4')
  assert.equal(ep.reason, 'signal')
  // 没有 cwd 时不留空字段（episode 文件会被用户翻出来看）。
  assert.equal('cwd' in ep, false)
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
  // 最后一行是被杀进程写了一半的：读的时候必须跳过，而不是整份队列读废。
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
  // 另一会话的项不该被捞出来。
  await store.enqueue({ ...base, session: 's2', id: 's2:1', turn: 1 })

  const all = await store.list()
  const second = all.find((x) => x.id === 's1:2')
  await store.mark(second, { status: 'failed', attempts: 1, nextAt: now + 5 * MIN })

  const ready = await store.retryable('s1', 10, now)
  assert.deepEqual(ready.map((x) => x.id), ['s1:1'])
  const later = await store.retryable('s1', 10, now + 5 * MIN)
  assert.deepEqual(later.map((x) => x.id), ['s1:1', 's1:2'])
  // limit 生效。
  assert.equal((await store.retryable('s1', 1, now + 5 * MIN)).length, 1)
})

test('episodes：compact 清掉老 done，保留 pending 与新的 done', async () => {
  const dir = await tmp()
  const store = createEpisodeStore({ stateDir: dir, message })
  const old = new Date(Date.now() - 40 * 86400_000).toISOString()
  const fresh = new Date().toISOString()
  // 直接写文件：`mark` 会把 at 改成"现在"，测不出"几天前的 done 该被清掉"。
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
  // 重写后的文件仍是逐行 JSON（不能留下半截）。
  const text = await readFile(join(dir, 'evolution/outbox.jsonl'), 'utf8')
  assert.equal(text.trim().split('\n').length, 2)
  for (const line of text.trim().split('\n')) JSON.parse(line)
})

test('episodes：prune 只删 30 天前的摘要，recent 按修改时间倒序', async () => {
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
  // 用 mtime 判"多久没人碰过"：at 是内容的一部分，重写一次正文不该让过期文件续命。
  await utimes(join(dir, a.path), new Date(now - 40 * day), new Date(now - 40 * day))
  await utimes(join(dir, b.path), new Date(now - day), new Date(now - day))
  assert.deepEqual((await store.recent(10)).map((e) => e.turn), [2, 1])
  const r = await store.prune(30, now)
  assert.equal(r.removed, 1)
  assert.deepEqual((await store.recent(10)).map((e) => e.turn), [2])
  // 空会话目录也一并收掉，别让目录数量跟会话数一起涨。
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

// ───────────────────────────── 解析 ─────────────────────────────

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
      { text: ' 用 pnpm ', kind: 'nonsense', source: 'made_up', quote: ' 以后用 pnpm ', layer: 'mars', ttlDays: -3 },
      { text: '', source: 'user_explicit' },
      { kind: 'fact', source: 'user_explicit' },
      { text: '第二条', source: 'tool_verified' },
      { text: '第三条', source: 'user_explicit' },
      { text: '第四条该被截掉', source: 'user_explicit' },
    ],
  })
  assert.equal(items.length, MAX_ITEMS_PER_REVIEW)
  assert.equal(items[0].text, '用 pnpm')
  // 越界的 kind / layer 丢掉，但条目本身保留（一条写错不该让别的白跑）。
  assert.equal('kind' in items[0], false)
  assert.equal('layer' in items[0], false)
  assert.equal('ttlDays' in items[0], false)
  // 认不出的 source 降级成 model_inference，绝不冒领 user_explicit。
  assert.equal(items[0].source, 'model_inference')
  assert.equal(items[0].quote, '以后用 pnpm')
  assert.equal(items[2].source, 'user_explicit')
})

test('parseReviewItems：认 items 别名，空输入不炸', () => {
  assert.equal(parseReviewItems({ items: [{ text: 'a', source: 'user_explicit' }] }).length, 1)
  assert.deepEqual(parseReviewItems(null), [])
  assert.deepEqual(parseReviewItems({ memories: 'nope' }), [])
})

test('buildReviewPrompt：只带摘要，不带全文', () => {
  const ep = episodeOf(
    digestOf(3, {
      userTexts: ['记住：提交信息写中文'],
      tools: ['mcp__fs__read'],
      events: [{ kind: 'tool', tool: 'mcp__fs__read', ok: false, text: 'ENOENT', at: 1 }],
    }),
    { session: 's1', at: 'x', reason: 'signal' },
  )
  const p = buildReviewPrompt(ep, ['commit-lang — 提交信息用中文'])
  assert.match(p, /记住：提交信息写中文/)
  assert.match(p, /mcp__fs__read \(failed\): ENOENT/)
  assert.match(p, /commit-lang/)
  assert.match(p, /只输出 JSON/)
  // 没有值得记的东西时导语要说清楚，否则模型会硬凑。
  assert.match(buildReviewPrompt(episodeOf(digestOf(1), { session: 's', at: 'x', reason: 'periodic' }), []), /\(none\)/)
})

// ───────────────────────────── 退避 ─────────────────────────────

test('nextRetryAt：1min → 5min → 30min，且不越界', () => {
  const now = 1_000_000
  assert.equal(nextRetryAt(1, now), now + 1 * MIN)
  assert.equal(nextRetryAt(2, now), now + 5 * MIN)
  assert.equal(nextRetryAt(3, now), now + 30 * MIN)
  assert.equal(nextRetryAt(99, now), now + 30 * MIN)
  // attempts 为 0 / 负数时按第一次算，不能返回 0（那样会立刻重试打满）。
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
  assert.equal('nextAt' in b, false, 'dead 项不该带 nextAt：它永远不该再被捞出来')
})

// ───────────────────────────── 复习器 ─────────────────────────────

test('reviewer：没有 llm 服务 → no-llm，不花钱', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const r = createReviewer({ llm: null, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-llm')
  assert.equal(await budget.remaining('s1'), 2)
})

test('reviewer：拿不到模型路由 → no-model', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ model: '' }), null)
  assert.equal(out.reason, 'no-model')
  assert.equal(llm.calls.length, 0)
  assert.equal(await budget.remaining('s1'), 2, '没调模型就不该记账')
})

test('reviewer：解析出条目后逐条过 learner，记账一次', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm(
    '```json\n' +
      JSON.stringify({
        memories: [
          { text: '提交信息用中文', kind: 'preference', source: 'user_explicit', quote: '以后提交信息都写中文', key: 'commit-lang' },
          { text: '这个项目用 pnpm', source: 'tool_verified' },
        ],
      }) +
      '\n```',
  )
  const learner = fakeLearner()
  const r = createReviewer({ llm, learner, budget, catalogLines: async () => ['commit-lang'], log, message })
  const ep = episodeOf(digestOf(2, { userTexts: ['以后提交信息都写中文'] }), {
    session: 's1',
    at: 'x',
    reason: 'signal',
    workspaceHash: 'h1',
  })
  const out = await r.review(ep, cfgOf({ model: '' }), { provider: 'p', model: 'm' })
  assert.equal(out.ok, true)
  assert.equal(out.learned, 2)
  assert.equal(out.rejected, 0)
  assert.equal(learner.calls.length, 2)
  // 逐条带的上下文必须是这一轮的会话与工作区，否则层级会写错。
  assert.deepEqual(learner.calls[0].scope, { sessionId: 's1', workspaceHash: 'h1' })
  assert.equal(learner.calls[0].req.key, 'commit-lang')
  assert.equal(learner.calls[0].req.quote, '以后提交信息都写中文')
  // 显式配置了 model 时优先（`provider/model` 形态）。
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(await budget.remaining('s1'), 1)
  // 温度必须是 0：复习要可复现，不要创意。
  assert.equal(llm.calls[0].temperature, 0)
})

test('reviewer：`model` 只写 model 时沿用会话的 provider', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf({ model: 'fast-model' }), {
    provider: 'live-provider',
    model: 'live-model',
  })
  assert.deepEqual(llm.calls[0], { provider: 'live-provider', model: 'fast-model', temperature: 0 })
})

test('reviewer：输出不是 JSON → bad-json，不 learn', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const learner = fakeLearner()
  const r = createReviewer({ llm: fakeLlm('我觉得这轮没啥好记的'), learner, budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'bad-json')
  assert.equal(learner.calls.length, 0)
})

test('reviewer：空列表算成功（模型判断"不值得记"是正常结论）', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const r = createReviewer({ llm: fakeLlm('{"memories":[]}'), learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, true)
  assert.equal(out.learned, 0)
})

test('reviewer：门禁拒绝计入 rejected，不打断后面的条目', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const reply = JSON.stringify({
    memories: [
      { text: '第一条', source: 'user_explicit' },
      { text: '第二条', source: 'user_explicit' },
    ],
  })
  const calls = []
  const learner = {
    async learn(req) {
      calls.push(req)
      return calls.length === 1 ? { ok: false, code: 'duplicate', gate: 'novelty' } : { ok: true }
    },
  }
  const r = createReviewer({ llm: fakeLlm(reply), learner, budget, catalogLines: async () => [], log, message })
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
  // 计数器要落盘：新实例（进程重启）必须认得已经花过的那一次。
  const reloaded = createReviewBudget({ path, max: 1, message })
  assert.equal(await reloaded.remaining('s1'), 0)

  const llm = fakeLlm()
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.reason, 'budget')
  assert.equal(llm.calls.length, 0)
  // 别的会话不受影响。
  assert.equal(await budget.remaining('s2'), 1)
})

test('reviewer：模型报错 → 不抛，返回 error', async () => {
  const dir = await tmp()
  const budget = createReviewBudget({ path: join(dir, 'reviews.json'), max: 2, message })
  const llm = {
    prepareCall() {
      throw new Error('upstream 500')
    },
  }
  const r = createReviewer({ llm, learner: fakeLearner(), budget, catalogLines: async () => [], log, message })
  const out = await r.review(episodeOf(digestOf(1), { session: 's1', at: 'x', reason: 'signal' }), cfgOf(), { provider: 'p', model: 'm' })
  assert.equal(out.ok, false)
  assert.match(out.error, /upstream 500/)
  // 报错也是花过钱：不能再给它无限次机会。
  assert.equal(await budget.remaining('s1'), 1)
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

test('cold：turnEnd 写 episode + 入队 + 复习到 done', async () => {
  const { dir, episodes, reviewer, cold } = await coldFixture()
  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1, 'C:/ws')

  const all = await episodes.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].status, 'done')
  assert.equal(all[0].reason, 'learned 1')
  assert.equal(reviewer.calls.length, 1)
  // episode 里要留下 cwd 与工作区 hash：复习是异步的，那时候已经拿不到活的 session。
  const ep = await episodes.read(all[0].path)
  assert.equal(ep.cwd, 'C:/ws')
  assert.equal(ep.workspaceHash, 'h1')
  assert.equal(ep.reason, 'signal')
  assert.equal(ep.userTexts[0], '记住：以后用 pnpm')
  assert.ok(dir)
})

test('cold：不值得复习的轮次不入队，只留一条日志', async () => {
  const { episodes, cold } = await coldFixture()
  cold.noteTurn('s1', 3)
  cold.digests.capture('s1', 3, { kind: 'user', text: '帮我看一下这个文件' })
  await cold.turnEnd('s1', 3, 'C:/ws')
  assert.equal((await episodes.list()).length, 0)
  assert.ok(logs.some((r) => r.event === 'turn-skipped' && r.reason === 'none'))
})

test('cold：开关关掉时既不封存也不复习', async () => {
  const { episodes, reviewer, cold } = await coldFixture({ effectiveOf: async () => cfgOf({ enabled: false }) })
  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1)
  assert.equal((await episodes.list()).length, 0)
  assert.equal(reviewer.calls.length, 0)
  // digest 已经被 seal 取走，不会在内存里越积越多。
  assert.deepEqual(cold.digests.stats(), { sessions: 0, turns: 0 })
})

test('cold：失败按退避重排，第 3 次进 dead-letter', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, error: 'upstream 500' })
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const { episodes, cold } = await coldFixture({ reviewer, now: () => now })

  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1)
  let item = (await episodes.list())[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 1)
  assert.equal(item.nextAt, now + 1 * MIN)

  // 还没到退避时间：捞不出来。
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
  // dead 之后不再重试。
  await cold.drain('s1')
  assert.equal(reviewer.calls.length, 3)
})

test('cold：预算用光不是失败，标 done 并从队列消失', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, reason: 'budget' })
  const { episodes, cold } = await coldFixture({ reviewer })
  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1)
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'done')
  assert.equal(item.reason, 'budget')
  // 再 drain 一次也不会重跑。
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
  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1)
  assert.equal(first.calls.length, 1)

  // 模拟进程重启：同一份磁盘，新的 reviewer。
  const dir2 = { episodes }
  const second = fakeReviewer()
  const cold2 = createColdPath({
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes: dir2.episodes,
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
  // 手写一条"上次没跑完"的队列项 + 对应 episode。
  const ep = episodeOf(digestOf(4, { userTexts: ['记住：用 pnpm'] }), { session: 's1', at: 'x', reason: 'signal' })
  const w = await episodes.write(ep)
  await episodes.enqueue({ id: ep.id, session: 's1', turn: 4, at: ep.at, path: w.path })

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
  const ep = episodeOf(digestOf(1, { userTexts: ['记住：用 pnpm'] }), { session: 's1', at: 'x', reason: 'signal' })
  const w = await episodes.write(ep)
  await episodes.enqueue({ id: ep.id, session: 's1', turn: 1, at: ep.at, path: w.path })

  // 两次并发 drain：串行链保证第二次看得见第一次已标记 done，不会重复复习。
  await Promise.all([cold.drain('s1'), cold.drain('s1')])
  assert.deepEqual(order, ['start s1', 'end s1'])
  assert.equal((await episodes.list())[0].status, 'done')
})

// ───────────────────────────── 手动重跑（op 层） ─────────────────────────────

test('cold：retry 把 dead 项重新排队，计数清零后再跑一遍', async () => {
  const reviewer = fakeReviewer({ ok: false, learned: 0, rejected: 0, error: 'upstream 500' })
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const { episodes, cold } = await coldFixture({ reviewer, now: () => now })
  cold.noteTurn('s1', 1)
  cold.digests.capture('s1', 1, { kind: 'user', text: '记住：以后用 pnpm' })
  await cold.turnEnd('s1', 1)
  now += 1 * MIN
  await cold.drain('s1')
  now += 5 * MIN
  await cold.drain('s1')
  assert.equal((await episodes.list())[0].status, 'dead')

  // 用户点「重试」：计数必须清零，否则第一次失败就立刻又进 dead-letter，等于点了没反应。
  const r = await cold.retry('s1:1')
  assert.deepEqual(r, { ok: true, session: 's1' })
  // 但重试仍走同一条复习路径：模型还是失败，于是重新排下一次退避。
  const item = (await episodes.list())[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 1)
  assert.equal(item.nextAt, now + 1 * MIN)

  assert.deepEqual(await cold.retry('不存在'), { ok: false })
})

test('op：evolution-queue 只列未完成的项，dead 排最前', async () => {
  const cold = {
    async queue() {
      return [
        { id: 's1:1', session: 's1', turn: 1, at: 'x', path: 'p', status: 'done', attempts: 1 },
        { id: 's1:2', session: 's1', turn: 2, at: 'x', path: 'p', status: 'pending', attempts: 0 },
        { id: 's1:3', session: 's1', turn: 3, at: 'x', path: 'p', status: 'dead', attempts: 3, reason: 'upstream 500' },
        { id: 's1:4', session: 's1', turn: 4, at: 'x', path: 'p', status: 'failed', attempts: 1, reason: 'timeout', nextAt: 99 },
      ]
    },
    async stats() {
      return { pending: 1, failed: 1, dead: 1, done: 1 }
    },
  }
  const ops = buildEvolutionOps({ cold: () => cold, message })
  const res = await ops['evolution-queue']({})
  assert.equal(res.ok, true)
  assert.deepEqual(res.stats, { pending: 1, failed: 1, dead: 1, done: 1 })
  // done 不进列表（条目已经进记忆库了），其余按严重程度排。
  assert.deepEqual(res.items.map((x) => x.id), ['s1:3', 's1:4', 's1:2'])
  assert.equal(res.items[0].reason, 'upstream 500')
  assert.equal(res.items[1].nextAt, 99)
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
  const miss = await ops['evolution-replay']({ id: 'nope' })
  assert.equal(miss.ok, false)
  assert.equal(miss.code, 'not-found')
  assert.deepEqual(calls, [['retry', 's1:1'], ['replay'], ['retry', 'nope']])

  // 没接线时如实报不可用，不静默成功。
  const coldLess = buildEvolutionOps({ cold: () => null, message })
  assert.equal((await coldLess['evolution-queue']({})).code, 'no-cold')
  assert.equal((await coldLess['evolution-replay']({})).code, 'no-cold')
})

// ───────────────────────────── 事件接线 ─────────────────────────────

/** 最小的事件总线替身：只记住 `session/event` 的处理器。 */
function fakeCtx() {
  const handlers = new Map()
  return {
    on(name, cb) {
      handlers.set(name, cb)
    },
    emit(name, ...args) {
      handlers.get(name)?.(...args)
      return handlers.has(name)
    },
    has(name) {
      return handlers.has(name)
    },
  }
}

test('attachColdPath：turn/end 只认 completed，取消的一轮把 digest 丢掉', async () => {
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

  const session = { id: 's1' }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '记住：以后用 pnpm' }] },
  })
  assert.equal(cold.currentTurn('s1'), 2)
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'cancelled' } } })
  assert.deepEqual(cold.digests.stats(), { sessions: 0, turns: 0 }, '取消的轮次不该留在内存里')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await episodes.list()).length, 0)
  assert.equal(reviewer.calls.length, 0)
})

test('attachColdPath：completed 的一轮排队并复习，路由来自请求头', async () => {
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

  const session = { id: 's1', header: { cwd: 'C:/ws' } }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } })
  ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '记住：以后用 pnpm' }] },
  })
  assert.deepEqual(cold.routeOf('s1'), { provider: 'p', model: 'm' })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })

  await waitFor(async () => (await episodes.list()).length === 1 && (await episodes.list())[0].status === 'done')
  const item = (await episodes.list())[0]
  assert.equal(item.turn, 3)
  // 复习时用的是这一轮对话的模型。
  assert.deepEqual(reviewer.calls[0].route, { provider: 'p', model: 'm' })
})

test('attachColdPath：合成消息不算用户说的话，真人消息既进摘要也进证据缓存', async () => {
  const { episodes } = await coldFixture()
  const ctx = fakeCtx()
  const cold = attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  const session = { id: 's1' }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  // 各注入插件的合成消息也常出现"记住"两个字，不能当成用户说的话
  // （否则每一轮都被判成信号，还会让证据门拿注入文本去核对引句）。
  for (const kind of ['runtime-context', 'tool-registry', 'reminder']) {
    ctx.emit('session/event', session, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '记住：不要记这一句' }], source: { kind } },
    })
  }
  assert.deepEqual(cold.digests.stats(), { sessions: 0, turns: 0 })

  // 真人消息的 kind 就是 'user'（`user` / `user-rpc` 两种源都是）。早先把非空 kind 一律
  // 跳过，等于把所有 `user_explicit` 都降级成候选 —— 这条断言就是那道回归线。
  ctx.emit('session/event', session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '以后提交信息都用中文写' }], source: { kind: 'user' } },
  })
  assert.deepEqual(cold.digests.stats(), { sessions: 1, turns: 1 })
  assert.deepEqual(checkQuote('s1', '提交信息都用中文'), { ok: true, index: 0 })
  assert.equal(checkQuote('s1', '提交信息都用英文').ok, false)
  clearUserTexts('s1')
})

test('attachColdPath：配置读取抛异常时只写日志，不冒泡到会话主链', async () => {
  const ctx = fakeCtx()
  const before = logs.length
  attachColdPath(ctx, {
    effectiveOf: async () => {
      throw new Error('config 炸了')
    },
    episodes: createEpisodeStore({ stateDir: await tmp(), message }),
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 's1' }, { type: 'user/message', data: { content: '记住：以后用 pnpm' } })
  // 不抛：emit 正常返回就是断言本身。
  ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // tick 一下，让后台的 turnEnd 跑完并吞掉异常。
  await waitFor(() => logs.slice(before).some((r) => r.event === 'turn-end-failed'))
})

test('attachColdPath：turn 号缺失的事件被忽略', async () => {
  const { episodes } = await coldFixture()
  const ctx = fakeCtx()
  const cold = attachColdPath(ctx, {
    effectiveOf: async () => cfgOf({ enabled: true }),
    episodes,
    reviewer: fakeReviewer(),
    workspaceHashOf: () => 'h1',
    log,
    message,
  })
  ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: {} })
  ctx.emit('session/event', { id: '' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 's1' }, null)
  assert.equal((await episodes.list()).length, 0)
  assert.equal(cold.currentTurn('s1'), 0)
})
