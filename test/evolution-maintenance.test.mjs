// 维护扫描的测试。
//
// 这里的每一条都在守同一件事：**记忆不会自己消失**。扫描只改状态（提醒 → 归档），
// 不删文件；而且是"先出计划，再执行" —— 计划是纯函数，所以可以逐条钉住"为什么它被处理"。
//
// 两条口径尤其要钉住：
//   - 到期**先提醒、不停用**。记忆突然从上下文里消失，比它稍微旧一点危险得多。
//   - 归档只对提醒过仍然没人理的条目 —— 没提醒就归档等于跳过用户。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARCHIVE_DAYS,
  EPISODE_KEEP_DAYS,
  REVIEW_DAYS,
  WORKSPACE_MISSING_DAYS,
  healthOf,
  planSweep,
  runSweep,
  shouldSweepNow,
} from '../lib/evolution/maintenance.js'

const DAY = 86400_000
const NOW = Date.parse('2026-06-01T00:00:00Z')
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()

const counters = (over = {}) => ({ injected: 0, read: 0, helpful: 0, harmful: 0, ...over })

const entry = (over = {}) => ({
  id: 'w/a',
  layer: 'workspace',
  key: 'a',
  status: 'active',
  origin: 'auto',
  confidence: 0.8,
  tokens: 10,
  updatedAt: iso(1),
  counters: counters(),
  ...over,
})

// ── 计划 ───────────────────────────────────────────────────────────────────

test('planSweep：没到期的库一条都不动', () => {
  const { actions, counts } = planSweep([entry(), entry({ id: 'w/b', status: 'candidate' })], { now: NOW })
  assert.deepEqual(actions, [])
  assert.deepEqual(counts, { review: 0, ttl: 0, workspace: 0 })
})

test('planSweep：到期先只提醒，状态与注入都不动', () => {
  const { actions, counts } = planSweep(
    [
      entry({ id: 'fact-old', kind: 'fact', updatedAt: iso(REVIEW_DAYS + 1) }),
      entry({ id: 'fact-fresh', kind: 'fact', updatedAt: iso(REVIEW_DAYS - 1) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind, a.bucket]), [['fact-old', 'flag', 'review']])
  assert.equal(actions[0].needsReview, 'ttl')
  assert.equal(counts.review, 1)
  assert.equal(counts.ttl, 0, '还没到归档线，一条都不该停用')
})

test('planSweep：提醒之后仍没人理才归档', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'forgotten', kind: 'fact', updatedAt: iso(ARCHIVE_DAYS + 1) }),
      entry({ id: 'warned', kind: 'fact', updatedAt: iso(ARCHIVE_DAYS - 1) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind]), [['forgotten', 'archive'], ['warned', 'flag']])
})

test('planSweep：偏好没有保质期，放多久都不提醒', () => {
  const { actions } = planSweep([entry({ kind: 'preference', updatedAt: iso(3650) })], { now: NOW })
  assert.deepEqual(actions, [])
})

test('planSweep：显式 TTL 是复核间隔，归档线跟着放大到 3 倍', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'a', kind: 'fact', ttlDays: 10, updatedAt: iso(15) }),
      entry({ id: 'b', kind: 'fact', ttlDays: 10, updatedAt: iso(35) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind]), [['a', 'flag'], ['b', 'archive']])
})

test('planSweep：工作区目录没消失够久，不归档它的记忆', () => {
  const cases = [
    [WORKSPACE_MISSING_DAYS - 1, 0],
    [WORKSPACE_MISSING_DAYS, 1],
  ]
  for (const [days, want] of cases) {
    const { actions } = planSweep([entry({ workspace: 'h1' })], {
      now: NOW,
      workspaceMissingDays: new Map([['h1', days]]),
    })
    assert.equal(actions.length, want, `missing ${days} days`)
  }
})

test('planSweep：用户记忆、锁定条目、已归档的都不进来', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'user', origin: 'user', updatedAt: iso(ARCHIVE_DAYS + 10) }),
      entry({ id: 'locked', locked: true, updatedAt: iso(ARCHIVE_DAYS + 10) }),
      entry({ id: 'archived', status: 'archived', updatedAt: iso(ARCHIVE_DAYS + 10) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions, [])
})

// ── 执行 ───────────────────────────────────────────────────────────────────

function deps(over = {}) {
  const calls = []
  const marked = []
  const base = {
    calls,
    marked,
    learner: {
      async setStatus(id, status, actor, opts) {
        calls.push({ id, status, actor, opts })
        return { ok: true, id }
      },
      async markReview(id, reason) {
        calls.push({ id, review: reason })
        return { ok: true, id }
      },
    },
    episodes: {
      async prune(days, now) {
        calls.push({ prune: days })
        return { removed: 2 }
      },
      async compact(days) {
        calls.push({ compact: days })
        return { kept: 5, dropped: 1 }
      },
    },
    state: {
      update: async (fn) => ({ ok: true, result: fn({ watermarks: {} }) }),
      read: async () => ({ ok: true, state: { entries: {} } }),
    },
    config: {
      async readWorkspaces() {
        return { workspaces: {} }
      },
      async markWorkspaceMissing(hash, missingAt) {
        marked.push({ hash, missingAt })
        return { ok: true, changed: true }
      },
    },
    withWriteLock: (fn) => fn(),
    log: async () => {},
    message: (e) => String(e?.message || e),
    now: () => NOW,
    async entries() {
      return []
    },
    ...over,
  }
  return base
}

test('runSweep：dry 只出报告，一个状态都不改', async () => {
  const d = deps({
    async entries() {
      return [entry({ id: 'x1', updatedAt: iso(400) })]
    },
  })
  const r = await runSweep(d, { dry: true })
  assert.equal(r.dry, true)
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].ok, true)
  assert.deepEqual(d.calls.filter((c) => c.id), [])
  // 裁剪仍然跑（它删的是派生数据，不是记忆）。
  assert.ok(d.calls.some((c) => c.prune === EPISODE_KEEP_DAYS))
})

test('runSweep：提醒走 markReview，归档走 setStatus', async () => {
  const d = deps({
    async entries() {
      return [
        entry({ id: 'warn', kind: 'fact', updatedAt: iso(REVIEW_DAYS + 1) }),
        entry({ id: 'gone', kind: 'fact', updatedAt: iso(ARCHIVE_DAYS + 1) }),
      ]
    },
  })
  const r = await runSweep(d)
  assert.deepEqual(r.actions.map((a) => [a.id, a.kind, a.ok]), [['warn', 'flag', true], ['gone', 'archive', true]])
  const setCalls = d.calls.filter((c) => c.status)
  assert.deepEqual(setCalls.map((c) => [c.id, c.status]), [['gone', 'archived']])
  const reviewCalls = d.calls.filter((c) => c.review)
  assert.deepEqual(reviewCalls.map((c) => [c.id, c.review]), [['warn', 'ttl']])
})

test('runSweep：单条失败不影响其它条，错误进报告', async () => {
  let n = 0
  const d = deps({
    learner: {
      async setStatus(id) {
        n++
        return id === 'bad' ? { ok: false, error: 'boom' } : { ok: true, id }
      },
      async markReview(id) {
        n++
        return id === 'bad' ? { ok: false, error: 'boom' } : { ok: true, id }
      },
    },
    async entries() {
      return [entry({ id: 'bad', updatedAt: iso(400) }), entry({ id: 'good', updatedAt: iso(400) })]
    },
  })
  const r = await runSweep(d)
  assert.equal(n, 2)
  assert.deepEqual(r.actions.map((a) => [a.id, a.ok]), [['bad', false], ['good', true]])
  assert.equal(r.actions[0].error, 'boom')
  // 两条都到期归档（400 天 > 90 天）：成功的那条不再注入，失败的仍是 active。
  assert.equal(r.tokensBefore, 20)
  assert.equal(r.tokensAfter, 10)
})

test('runSweep：工作区首次缺失只打标记，目录回来后清掉标记', async () => {
  const d = deps({
    config: {
      async readWorkspaces() {
        return {
          workspaces: {
            h1: { key: 'k1', cwd: '/definitely/not/here' },
            // 目录又回来了（missingAt 还留着）→ 这次要清掉标记。
            h2: { key: 'k2', cwd: process.cwd(), missingAt: iso(5) },
            h3: { key: 'k3', cwd: process.cwd() },
          },
        }
      },
      async markWorkspaceMissing(hash, missingAt) {
        d.marked.push({ hash, missingAt })
        return { ok: true, changed: true }
      },
    },
    async entries() {
      return []
    },
  })
  const r = await runSweep(d)
  assert.deepEqual(r.workspaces, { checked: 3, missing: 1, back: 1, archived: 0 })
  // h1 打新标记；h2 清标记（null）；h3 本来就好，不写。
  assert.deepEqual(d.marked.sort((a, b) => a.hash.localeCompare(b.hash)), [
    { hash: 'h1', missingAt: new Date(NOW).toISOString() },
    { hash: 'h2', missingAt: null },
  ])
})

test('runSweep：工作区目录回来 → 同步恢复"因工作区失效"归档的记忆', async () => {
  const d = deps({
    config: {
      async readWorkspaces() {
        return { workspaces: { h2: { key: 'k2', cwd: process.cwd(), missingAt: iso(100) } } }
      },
      async markWorkspaceMissing(hash, missingAt) {
        d.marked.push({ hash, missingAt })
        return { ok: true, changed: true }
      },
    },
    async entries() {
      return [
        // 三条都在 h2：一条是工作区失效归档的（要恢复）、一条是别的理由归档的（不动）、
        // 一条还是 active（不动）。第四条属于别的 hash，与本工作区无关。
        entry({ id: '_ws/h2/back', layer: 'workspace', workspace: 'h2', status: 'archived', updatedAt: iso(95) }),
        entry({ id: '_ws/h2/decayed', layer: 'workspace', workspace: 'h2', status: 'archived', updatedAt: iso(95) }),
        entry({ id: '_ws/h2/live', layer: 'workspace', workspace: 'h2', status: 'active', updatedAt: iso(1) }),
        entry({ id: '_ws/other/note', layer: 'workspace', workspace: 'other', status: 'archived', updatedAt: iso(95) }),
      ]
    },
  })
  // state.read 给转移动机：只有 back 那条最后一次归档原因带 "workspace directory missing"。
  d.state.read = async () => ({
    ok: true,
    state: {
      entries: {
        '_ws/h2/back': { transitions: [{ at: iso(90), from: 'active', to: 'archived', actor: 'dream', reason: 'workspace directory missing for 90 days' }] },
        '_ws/h2/decayed': { transitions: [{ at: iso(80), from: 'active', to: 'archived', actor: 'sweep', reason: 'not reviewed for 100 days' }] },
      },
    },
  })
  const r = await runSweep(d)
  assert.equal(r.workspaces.back, 1)
  const setCalls = d.calls.filter((c) => c.id)
  // 只有"因工作区失效"归档的那条被恢复成 active；decay 归档与活条目不碰。
  assert.deepEqual(setCalls.map((c) => [c.id, c.status, c.opts.reason]), [
    ['_ws/h2/back', 'active', 'workspace directory is back'],
  ])
})

test('runSweep：目录已经缺失 90 天 → 归档它的记忆', async () => {
  const d = deps({
    config: {
      async readWorkspaces() {
        return { workspaces: { h1: { key: 'k1', cwd: '/gone', missingAt: iso(WORKSPACE_MISSING_DAYS + 1) } } }
      },
      async markWorkspaceMissing() {
        return { ok: true, changed: false }
      },
    },
    async entries() {
      return [entry({ id: 'w/old', workspace: 'h1' }), entry({ id: 'w/new', workspace: 'h2' })]
    },
  })
  const r = await runSweep(d)
  assert.deepEqual(r.actions.map((a) => a.id), ['w/old'])
  assert.equal(r.actions[0].bucket, 'workspace')
  assert.equal(r.workspaces.archived, 1)
})

test('runSweep：裁剪失败不挡住后面的状态扫描', async () => {
  const d = deps({
    episodes: {
      async prune() {
        throw new Error('磁盘只读')
      },
      async compact() {
        return { kept: 0, dropped: 0 }
      },
    },
    async entries() {
      return [entry({ updatedAt: iso(400) })]
    },
  })
  const r = await runSweep(d)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /episodes: 磁盘只读/)
  assert.equal(r.actions.length, 1, 'TTL 该跑还是要跑')
})

// ── 健康度与节奏 ───────────────────────────────────────────────────────────

test('healthOf：按层统计，候选与归档分开算，过期数目单独给', () => {
  const h = healthOf(
    [
      entry({ id: 'w/a' }),
      entry({ id: 'w/b', status: 'candidate' }),
      entry({ id: 'w/c', status: 'archived' }),
      entry({ id: 'w/d', status: 'core', tokens: 30 }),
      entry({ id: 'g/a', layer: 'global', counters: counters({ harmful: 2 }) }),
      entry({ id: 'g/old', layer: 'global', kind: 'fact', updatedAt: iso(400) }),
    ],
    { entries: { 'w/a': { needsReview: 'ttl' } } },
    NOW,
  )
  assert.deepEqual(h.byLayer.workspace, { active: 2, candidate: 1, archived: 1, tokens: 40 })
  assert.equal(h.byLayer.global.active, 2)
  // active/core 的体积都算：w/a 10 + w/d 30 + g/a 10 + g/old 10。过期的也还在注入，所以也算。
  assert.equal(h.tokens, 60)
  assert.equal(h.conflicts, 1)
  assert.equal(h.needsReview, 1)
  assert.equal(h.expired, 1)
  assert.equal(h.total, 6)
})

test('shouldSweepNow：一天一次', () => {
  assert.equal(shouldSweepNow(undefined, NOW), true)
  assert.equal(shouldSweepNow(iso(1 / 24), NOW), false)
  assert.equal(shouldSweepNow(iso(2), NOW), true)
  assert.equal(shouldSweepNow('not-a-date', NOW), true)
})
