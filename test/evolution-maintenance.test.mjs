// 维护扫描（P3）的测试。
//
// 这里的每一条都在守同一件事：**记忆不会自己消失**。扫描只改状态（active → candidate →
// archived），不删文件；而且是"先出计划，再执行" —— 计划是纯函数，所以可以逐条钉住
// "为什么它被处理"。
//
// 顺序也是不变量：会话 GC 先跑，被它归档的条目不该在 TTL 那轮又降一次候选。真出过这种
// 事的话，用户会在界面上看到同一条记忆的两次变更记录，而第二次毫无意义。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DECAY_DAYS,
  EPISODE_KEEP_DAYS,
  SESSION_GC_DAYS,
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
  assert.deepEqual(counts, { 'session-gc': 0, ttl: 0, decay: 0, workspace: 0, quota: 0 })
})

test('planSweep：会话层两周没动就归档，且不会被后面的桶重复处理', () => {
  const { actions, counts } = planSweep(
    [
      entry({ id: '_session/s1/a', layer: 'session', updatedAt: iso(SESSION_GC_DAYS + 1) }),
      entry({ id: '_session/s2/b', layer: 'session', updatedAt: iso(SESSION_GC_DAYS - 1) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => a.id), ['_session/s1/a'])
  assert.equal(actions[0].bucket, 'session-gc')
  assert.equal(counts['session-gc'], 1)
  // 只有一条动作：说明 `taken` 真的挡住了后续桶。
  assert.equal(actions.length, 1)
})

test('planSweep：TTL 到期先降候选并标待确认，候选要 2× 才归档', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'fact-old', kind: 'fact', updatedAt: iso(200) }),
      entry({ id: 'cand-old', kind: 'fact', status: 'candidate', updatedAt: iso(200) }),
      entry({ id: 'cand-ancient', kind: 'fact', status: 'candidate', updatedAt: iso(400) }),
      entry({ id: 'fact-fresh', kind: 'fact', updatedAt: iso(10) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind, a.bucket]), [
    ['fact-old', 'demote', 'ttl'],
    ['cand-ancient', 'archive', 'ttl'],
  ])
  assert.equal(actions[0].needsReview, 'ttl')
})

test('planSweep：显式 TTL 覆盖 kind 默认值', () => {
  const { actions } = planSweep([entry({ kind: 'preference', ttlDays: 30, updatedAt: iso(40) })], { now: NOW })
  assert.deepEqual(actions.map((a) => a.id), ['w/a'])
})

test('planSweep：衰减只碰"从没被注入也没人读"的 active', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'dead', updatedAt: iso(DECAY_DAYS + 1) }),
      entry({ id: 'injected', updatedAt: iso(DECAY_DAYS + 1), counters: counters({ injected: 3 }) }),
      entry({ id: 'read', updatedAt: iso(DECAY_DAYS + 1), counters: counters({ read: 1 }) }),
      entry({ id: 'core', status: 'core', updatedAt: iso(DECAY_DAYS + 1) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => a.id), ['dead'])
  assert.equal(actions[0].bucket, 'decay')
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

test('planSweep：配额超了只清候选，从最低分开始，且一次不超过 20%', () => {
  const rows = [
    entry({ id: 'a1' }),
    entry({ id: 'a2' }),
    entry({ id: 'a3' }),
    entry({ id: 'a4' }),
    // 两条候选：低置信度的先走。
    entry({ id: 'c-low', status: 'candidate', confidence: 0.62 }),
    entry({ id: 'c-high', status: 'candidate', confidence: 0.9 }),
  ]
  // 上限 4 → 超 2 条，但预算 floor(4*0.2)=0 → 至少 1 条。
  const { actions, counts } = planSweep(rows, { now: NOW, layerCaps: { workspace: 4 } })
  assert.deepEqual(actions.map((a) => a.id), ['c-low'])
  assert.equal(counts.quota, 1)

  // 上限 12 → floor(12*0.2)=2，但仍只清候选（这里只有 2 条），active 一条不动。
  const wide = [...Array.from({ length: 11 }, (_, i) => entry({ id: 'x' + i })), entry({ id: 'c1', status: 'candidate', confidence: 0.7 })]
  const r2 = planSweep(wide, { now: NOW, layerCaps: { workspace: 10 } })
  assert.equal(r2.actions.length, 1)
  assert.equal(r2.actions[0].id, 'c1')
})

test('planSweep：用户记忆、锁定条目、已归档的都不进来', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'user', origin: 'user', updatedAt: iso(DECAY_DAYS + 10) }),
      entry({ id: 'locked', locked: true, updatedAt: iso(DECAY_DAYS + 10) }),
      entry({ id: 'archived', status: 'archived', updatedAt: iso(DECAY_DAYS + 10) }),
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
    state: { update: async (fn) => ({ ok: true, result: fn({ watermarks: {} }) }) },
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

test('runSweep：真跑时逐条翻译成 setStatus，并在报告里留原因', async () => {
  const d = deps({
    async entries() {
      return [entry({ id: 'x1', kind: 'fact', updatedAt: iso(200) })]
    },
  })
  const r = await runSweep(d)
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].bucket, 'ttl')
  assert.equal(r.actions[0].ok, true)
  const setCalls = d.calls.filter((c) => c.id)
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0].id, 'x1')
  assert.equal(setCalls[0].status, 'candidate')
  assert.equal(setCalls[0].actor, 'dream')
  assert.equal(setCalls[0].opts.needsReview, 'ttl')
  assert.match(setCalls[0].opts.reason, /ttl 180d/)
})

test('runSweep：单条失败不影响其它条，错误进报告', async () => {
  let n = 0
  const d = deps({
    learner: {
      async setStatus(id) {
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
  // 成功的降为候选（不再注入），失败的那条还是 active，仍然算注入体积。
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
  )
  assert.deepEqual(h.byLayer.workspace, { active: 2, candidate: 1, archived: 1, cap: 200, tokens: 40 })
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
