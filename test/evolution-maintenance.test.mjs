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

const counters = (over = {}) => ({ injected: 0, read: 0, ...over })

const entry = (over = {}) => ({
  id: 'w/a',
  layer: 'workspace',
  key: 'a',
  status: 'active',
  origin: 'auto',
  tier: 'inferred',
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
  assert.equal(actions[0].reviewDue, 'ttl')
  assert.equal(counts.review, 1)
  assert.equal(counts.ttl, 0, '还没到归档线，一条都不该停用')
})

test('planSweep：提醒之后仍没人理才归档', () => {
  const { actions } = planSweep(
    [
      // `reviewDue` = 上一轮已经提醒过。只有这种才够格归档。
      entry({ id: 'forgotten', kind: 'fact', reviewDue: 'ttl', updatedAt: iso(ARCHIVE_DAYS + 1) }),
      entry({ id: 'warned', kind: 'fact', reviewDue: 'ttl', updatedAt: iso(ARCHIVE_DAYS - 1) }),
    ],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind]), [['forgotten', 'archive'], ['warned', 'flag']])
})

test('planSweep：从没提醒过的旧条目第一次扫描只提醒，不归档', () => {
  // 这是「先提醒、后归档」的核心保证：用户关掉功能一段时间再打开，或很久没跑扫描时，
  // 一条从未被提醒过的旧记忆不能被直接停用 —— 他连「待复核」都没看见过。
  const { actions } = planSweep(
    [entry({ id: 'ancient', kind: 'fact', updatedAt: iso(ARCHIVE_DAYS * 4) })],
    { now: NOW },
  )
  assert.deepEqual(actions.map((a) => [a.id, a.kind]), [['ancient', 'flag']])
})

test('planSweep：偏好没有保质期，放多久都不提醒', () => {
  const { actions } = planSweep([entry({ kind: 'preference', updatedAt: iso(3650) })], { now: NOW })
  assert.deepEqual(actions, [])
})

test('planSweep：显式 TTL 是复核间隔，归档线跟着放大到 3 倍', () => {
  const { actions } = planSweep(
    [
      entry({ id: 'a', kind: 'fact', ttlDays: 10, updatedAt: iso(15) }),
      entry({ id: 'b', kind: 'fact', ttlDays: 10, reviewDue: 'ttl', updatedAt: iso(35) }),
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
      // 只读版本：`dry` 走这两条，**不写盘**。
      async planPrune(days) {
        calls.push({ planPrune: days })
        return { removed: 2 }
      },
      async planCompact(days) {
        calls.push({ planCompact: days })
        return { kept: 5, dropped: 1 }
      },
    },
    state: {
      // 真实 store 的 state 一定有 `entries`（孤儿回收会遍历它）；测试桩少这个字段时
      // 那条路径会静默不执行，等于把新行为测成"没生效"。
      update: async (fn) => ({ ok: true, result: fn({ watermarks: {}, entries: {} }) }),
      read: async () => ({ ok: true, state: { entries: {} } }),
      // 孤儿回收从同步快照读现有 id（写路径才用 readFresh）；桩要给同一份形状。
      cachedSync: () => ({ watermarks: {}, entries: {} }),
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
    // 默认"文件都不在"：多数测试不关心孤儿回收，给一个不挡路的默认值。
    noteFileGone: async () => true,
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
  // **dry 不删任何东西**：裁剪与 outbox 清理都走只读的 `plan*`，一行都不落盘。
  // 早先这里不判 `dry`，用户点「预览」等于真的清理了一次。
  assert.equal(d.calls.filter((c) => c.prune !== undefined).length, 0, 'dry 不许真删 episode')
  assert.equal(d.calls.filter((c) => c.compact !== undefined).length, 0, 'dry 不许真写 outbox')
  assert.ok(d.calls.some((c) => c.planPrune === EPISODE_KEEP_DAYS))
  assert.ok(d.calls.some((c) => c.planCompact === EPISODE_KEEP_DAYS))
})

test('runSweep：提醒走 markReview，归档走 setStatus', async () => {
  const d = deps({
    async entries() {
      return [
        entry({ id: 'warn', kind: 'fact', updatedAt: iso(REVIEW_DAYS + 1) }),
        // `reviewDue` 已挂 = 上一轮提醒过；只有这种才够格归档。
        entry({ id: 'gone', kind: 'fact', reviewDue: 'ttl', updatedAt: iso(ARCHIVE_DAYS + 1) }),
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
      // 两条都已被提醒过（`reviewDue`），所以都够格归档。
      return [
        entry({ id: 'bad', reviewDue: 'ttl', updatedAt: iso(400) }),
        entry({ id: 'good', reviewDue: 'ttl', updatedAt: iso(400) }),
      ]
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

test('runSweep：工作区回来时还原到归档前的状态，不把候选变成 active', async () => {
  // 工作区失效会把候选一起归档（理由是「这个目录不在了」，与用户有没有确认过无关）。
  // 但插回硬盘不该等于用户点了确认：早先这里硬编码 `active`，于是一条用户从没看过的
  // 候选记忆，因为插回一块硬盘就生效并进入之后每一次对话。
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
        entry({ id: '_ws/h2/cand', layer: 'workspace', workspace: 'h2', status: 'archived', updatedAt: iso(95) }),
        entry({ id: '_ws/h2/live', layer: 'workspace', workspace: 'h2', status: 'archived', updatedAt: iso(95) }),
      ]
    },
  })
  d.state.read = async () => ({
    ok: true,
    state: {
      entries: {
        '_ws/h2/cand': { transitions: [{ at: iso(90), from: 'candidate', to: 'archived', actor: 'sweep', reason: 'workspace directory missing for 90 days' }] },
        '_ws/h2/live': { transitions: [{ at: iso(90), from: 'active', to: 'archived', actor: 'sweep', reason: 'workspace directory missing for 90 days' }] },
      },
    },
  })
  const r = await runSweep(d)
  assert.equal(r.workspaces.back, 1)
  const restored = d.calls.filter((c) => c.id).map((c) => [c.id, c.status])
  assert.deepEqual(restored, [
    ['_ws/h2/cand', 'candidate'],
    ['_ws/h2/live', 'active'],
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
      async planPrune() {
        throw new Error('磁盘只读')
      },
      async planCompact() {
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
      entry({ id: 'g/a', layer: 'global' }),
      entry({ id: 'g/old', layer: 'global', kind: 'fact', updatedAt: iso(400) }),
    ],
    // 两个字段分开报：`pendingReason` = 等你裁决（不注入），`reviewDue` = 该看一眼（照常注入）。
    { entries: { 'w/a': { reviewDue: 'ttl' }, 'w/b': { pendingReason: 'inference' } } },
    NOW,
  )
  assert.deepEqual(h.byLayer.workspace, { active: 2, candidate: 1, archived: 1, tokens: 40 })
  assert.equal(h.byLayer.global.active, 2)
  // active/core 的体积都算：w/a 10 + w/d 30 + g/a 10 + g/old 10。过期的也还在注入，所以也算。
  assert.equal(h.tokens, 60)
  assert.equal(h.awaitingReview, 1)
  assert.equal(h.reviewDue, 1)
  assert.equal(h.expired, 1)
  assert.equal(h.total, 6)
})

test('过期判据：偏好与纠正都没有保质期，事实与做法才会过期', () => {
  // 两者的 `auto_ttl_days` 都写 3650（字段必须有数），但那个数**不是**复核周期。
  // 早先只跳过 `preference`，于是 `correction` 会在第 3650 天触发一次毫无意义的复核提醒。
  // `healthOf` 与 `planSweep` 必须同口径，否则界面上的「过期」数与扫描实际提醒的条数对不上。
  const old = iso(4000)
  const kinds = ['preference', 'correction', 'fact', 'procedure']
  const h = healthOf(
    kinds.map((kind) => entry({ id: 'g/' + kind, layer: 'global', kind, updatedAt: old })),
    { entries: {} },
    NOW,
  )
  assert.equal(h.expired, 2, '只有 fact 与 procedure 会过期')

  const { actions } = planSweep(
    kinds.map((kind) => entry({ id: 'g/' + kind, layer: 'global', kind, updatedAt: old })),
    { entries: {} },
    { now: NOW },
  )
  const flagged = actions.filter((a) => a.kind === 'flag').map((a) => a.id).sort()
  assert.deepEqual(flagged, ['g/fact', 'g/procedure'], '扫描只该提醒会过期的两类')
  assert.equal(flagged.length, h.expired, '两个口径的条数必须一致')
})

test('候选不参与 TTL 老化：它等用户裁决，不该被时间归档', () => {
  // 候选从不注入。让 TTL 替用户归档，等于静默丢掉一条他从没看过的记忆；
  // 给它挂「该复核了」又是把两个不同的问题混在一起（复核问「还成立吗」，候选问「要不要」）。
  const old = iso(4000)
  const entries = [
    entry({ id: 'g/cand', layer: 'global', kind: 'fact', status: 'candidate', updatedAt: old }),
    entry({ id: 'g/live', layer: 'global', kind: 'fact', status: 'active', updatedAt: old }),
  ]
  const { actions } = planSweep(entries, { entries: {} }, { now: NOW })
  assert.deepEqual(actions.map((a) => a.id), ['g/live'], '候选一条动作都不该有')
  const h = healthOf(entries, { entries: {} }, NOW)
  assert.equal(h.expired, 1, '过期数只数会老化的那条')
  assert.equal(h.byLayer.global.candidate, 1, '候选仍计入统计')
})

test('planSweep：工作区失效归档能盖掉同一条的 TTL 提醒', () => {
  // 一条记忆同时「该复核」且「工作区已失效 90 天」：只能出一条动作，且必须是归档。
  // 早先按 id 去重、先到先得，TTL 提醒排在前面，于是归档被吞掉 —— 用户看到的是
  // 「提醒了 90 天」，工作区删了那条记忆却一直还在注入。
  const plan = planSweep([
    entry({
      id: 'ws-gone',
      layer: 'workspace',
      workspace: 'h1',
      kind: 'fact',
      reviewDue: 'ttl',
      updatedAt: iso(ARCHIVE_DAYS + 10),
    }),
  ], {
    now: NOW,
    workspaces: { h1: { key: '/definitely/not/here', missingAt: iso(WORKSPACE_MISSING_DAYS + 5) } },
  })
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].kind, 'archive')
})

test('planSweep：dry 报告与实际扫描同一份判定', () => {
  // dry 与真跑共用 `planSweep`：两边判据分家时，用户点「预览」看到的和真跑做的不一样。
  const entries = [
    entry({ id: 'warn', kind: 'fact', updatedAt: iso(REVIEW_DAYS + 1) }),
    entry({ id: 'gone', kind: 'fact', reviewDue: 'ttl', updatedAt: iso(ARCHIVE_DAYS + 1) }),
  ]
  const a = planSweep(entries, { now: NOW, workspaces: {} })
  const b = planSweep(entries, { now: NOW, workspaces: {} })
  assert.deepEqual(a.actions, b.actions)
})

test('runSweep：回收文件已不在的孤儿状态', async () => {
  // 条目文件被删（用户删文件 / 同步工具 / 换机器），state 里还留着它的证据与计数。
  // 留着只会让「自动记忆」的数字对不上列表，而且它永远不会自己消失。
  const live = entry({ id: 'still-there', kind: 'fact', updatedAt: iso(1) })
  const existing = { 'still-there': { evidence: [] }, 'file-gone': { evidence: [] }, 'also-gone': {} }
  const d = deps({
    state: {
      update: async (fn) => ({ ok: true, result: fn({ watermarks: {}, entries: existing }) }),
      read: async () => ({ ok: true, state: { entries: existing } }),
      cachedSync: () => ({ watermarks: {}, entries: existing }),
    },
    async entries() {
      return [live]
    },
  })
  const r = await runSweep(d)
  assert.equal(r.orphans.removed, 2)
})

test('runSweep：文件读不动时不回收孤儿状态', async () => {
  // catalog 重建时逐条 `catch { continue }`：目录被临时占住 / 网络盘断连都会让它少几条。
  // 拿那一份当"文件已删"的依据会误删证据链 —— 所以维护扫描要逐个确认文件确实不在。
  const existing = { 'unreadable': { evidence: [{ quote: '重要依据' }] } }
  const d = deps({
    state: {
      update: async (fn) => ({ ok: true, result: fn({ watermarks: {}, entries: existing }) }),
      read: async () => ({ ok: true, state: { entries: existing } }),
      cachedSync: () => ({ watermarks: {}, entries: existing }),
    },
    // 文件读不动（权限 / 占用）：不是"已删除"。
    noteFileGone: async () => false,
    async entries() {
      return []
    },
  })
  const r = await runSweep(d)
  assert.equal(r.orphans.removed, 0)
  assert.ok(existing['unreadable'], '证据链必须还在')
})

test('runSweep：dry 不回收孤儿状态', async () => {
  let touched = false
  const d = deps({
    state: {
      update: async (fn) => {
        touched = true
        return { ok: true, result: fn({ watermarks: {}, entries: { gone: {} } }) }
      },
      read: async () => ({ ok: true, state: { entries: {} } }),
    },
    async entries() {
      return []
    },
  })
  const r = await runSweep(d, { dry: true })
  assert.equal(r.orphans.removed, 0)
  assert.equal(touched, false, '预览一个字节都不写')
})

test('runSweep：state 读失败时不回收孤儿', async () => {
  // 读不到状态就不知道有哪些 id —— 这时"一个都不在"是错误结论，必须整轮跳过。
  const d = deps({
    state: {
      update: async (fn) => ({ ok: true, result: fn({ watermarks: {}, entries: {} }) }),
      read: async () => ({ ok: false, error: '状态文件损坏' }),
      cachedSync: () => ({ watermarks: {}, entries: {} }),
    },
    async entries() {
      return []
    },
  })
  const r = await runSweep(d)
  assert.equal(r.orphans.removed, 0)
  assert.ok(r.errors.some((x) => x.includes('orphans:')), '要如实报错，不能静默当没有孤儿')
})

test('healthOf：冲突数不再是恒 0 的假统计', () => {
  // 同 slot 下两个都生效的条目 = 注入侧无法解释的状态（两条互相矛盾的说法同时在上下文里）。
  // 这个字段此前声明了却从不累加，界面上那格永远是 0 —— 比不显示更糟。
  const h = healthOf([
    entry({ id: 'g1', layer: 'global', key: 'pkg', status: 'active', kind: 'fact' }),
    entry({ id: 'g2', layer: 'global', key: 'pkg', status: 'active', kind: 'fact' }),
    // 候选 / 归档不算：它们不注入，谈不上"同时在上下文里"。
    entry({ id: 'g3', layer: 'global', key: 'pkg', status: 'candidate', kind: 'fact' }),
    entry({ id: 'g4', layer: 'global', key: 'pkg', status: 'archived', kind: 'fact' }),
    // 不同 slot 不算。
    entry({ id: 'g5', layer: 'global', key: 'other', status: 'active', kind: 'fact' }),
  ], { entries: {} })
  assert.equal(h.conflicts, 2, '两个生效的 pkg 条目')
})

test('shouldSweepNow：一天一次', () => {
  assert.equal(shouldSweepNow(undefined, NOW), true)
  assert.equal(shouldSweepNow(iso(1 / 24), NOW), false)
  assert.equal(shouldSweepNow(iso(2), NOW), true)
  assert.equal(shouldSweepNow('not-a-date', NOW), true)
})
