// P3 新增 op 的接线测试。
//
// 这些 op 自己是薄薄一层转发，但要守的不变量不少：**没接线要如实报错而不是静默成功**、
// `dry` 预览不能失效缓存、回滚的 `force` 只能从界面确认后传过来、成功才 invalidate。
// 少一条，用户看到的就是"点了没反应"或者"列表是旧的"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEvolutionOps } from '../lib/ops/evolution.js'

const message = (e) => String(e?.message || e)

function fixture(over = {}) {
  const calls = []
  const base = {
    calls,
    config: {
      async effective() {
        return { enabled: true, dream: 'daily', model: 'p/m' }
      },
    },
    runtime: {
      view() {
        return {
          state: { watermarks: { lastDreamAt: '2026-05-01T00:00:00Z', lastSweepAt: '2026-05-02T00:00:00Z' }, entries: {} },
          catalog: { entries: {} },
        }
      },
      invalidate() {
        calls.push(['invalidate'])
      },
    },
    dream: () => ({
      async dream(cfg, route) {
        calls.push(['dream', cfg.model, route])
        return { ok: true, draftId: '20260501-100000', ops: 2 }
      },
      async listDrafts(limit) {
        calls.push(['listDrafts', limit])
        return [{ id: '20260501-100000', status: 'draft', ops: 2 }]
      },
      async readDraft(id) {
        calls.push(['readDraft', id])
        return { ok: true, draft: { id } }
      },
      async apply(id) {
        calls.push(['apply', id])
        return { ok: true, applied: 2 }
      },
      async revert(id, opts) {
        calls.push(['revert', id, opts.force])
        return { ok: true, restored: 3 }
      },
    }),
    health: async () => ({ tokens: 100, needsReview: 1, conflicts: 0, expired: 2, total: 4, byLayer: {} }),
    sweep: async (opts) => {
      calls.push(['sweep', opts.dry === true])
      return { ok: true, dry: opts.dry === true, actions: [] }
    },
    message,
    ...over,
  }
  return { ops: buildEvolutionOps(base), calls, base }
}

test('evolution-dream：会话路由透传，成功后失效缓存', async () => {
  const f = fixture({
    cold: () => ({ routeOf: () => ({ provider: 'live', model: 'm2' }) }),
  })
  const res = await f.ops['evolution-dream']({ sessionId: 's1' })
  assert.equal(res.ok, true)
  assert.equal(res.ops, 2)
  assert.deepEqual(f.calls, [
    ['dream', 'p/m', { provider: 'live', model: 'm2' }],
    ['invalidate'],
  ])
})

test('evolution-dream：没接线 / 开关关掉都如实拒绝', async () => {
  const noDream = fixture({ dream: () => null })
  assert.equal((await noDream.ops['evolution-dream']({})).code, 'no-dream')

  const off = fixture({
    config: { async effective() { return { enabled: false, dream: 'daily', model: '' } } },
  })
  assert.equal((await off.ops['evolution-dream']({})).code, 'disabled')
})

test('evolution-dreams：把草案、水位与健康度一起给界面', async () => {
  const f = fixture()
  const res = await f.ops['evolution-dreams']({ limit: 999 })
  assert.equal(res.ok, true)
  assert.equal(res.drafts.length, 1)
  assert.equal(res.lastDreamAt, '2026-05-01T00:00:00Z')
  assert.equal(res.lastSweepAt, '2026-05-02T00:00:00Z')
  assert.equal(res.health.tokens, 100)
  // limit 有上限，别让界面一次拉几百份草案。
  assert.deepEqual(f.calls.find((c) => c[0] === 'listDrafts'), ['listDrafts', 50])
})

test('apply / revert：id 必填，force 只在显式传入时为 true', async () => {
  const f = fixture()
  assert.equal((await f.ops['evolution-dream-apply']({})).code, 'bad-args')
  assert.equal((await f.ops['evolution-dream-revert']({})).code, 'bad-args')
  await f.ops['evolution-dream-apply']({ id: 'd1' })
  await f.ops['evolution-dream-revert']({ id: 'd1' })
  await f.ops['evolution-dream-revert']({ id: 'd1', force: true })
  assert.deepEqual(f.calls.filter((c) => c[0] === 'apply' || c[0] === 'revert'), [
    ['apply', 'd1'],
    ['revert', 'd1', false],
    ['revert', 'd1', true],
  ])
  // 两次写成功 → 两次失效；失败的 id 校验不碰缓存。
  assert.equal(f.calls.filter((c) => c[0] === 'invalidate').length, 3)
})

test('evolution-maintain：dry 只出计划、不失效缓存；真跑才失效', async () => {
  const f = fixture()
  const dry = await f.ops['evolution-maintain']({ dry: true })
  assert.equal(dry.dry, true)
  assert.deepEqual(f.calls, [['sweep', true]])
  const real = await f.ops['evolution-maintain']({})
  assert.equal(real.dry, false)
  assert.deepEqual(f.calls, [['sweep', true], ['sweep', false], ['invalidate']])
})

test('新 op 没接线时统一返回 no-*，不静默成功', async () => {
  const ops = buildEvolutionOps({
    config: { async effective() { return { enabled: true } } },
    runtime: { view() { return { state: { watermarks: {} }, catalog: { entries: {} } } }, invalidate() {} },
    message,
  })
  for (const [name, code] of [
    ['evolution-dream', 'no-dream'],
    ['evolution-dreams', 'no-dream'],
    ['evolution-dream-read', 'no-dream'],
    ['evolution-dream-apply', 'no-dream'],
    ['evolution-dream-revert', 'no-dream'],
    ['evolution-maintain', 'no-sweep'],
    ['evolution-health', 'no-health'],
  ]) {
    const res = await ops[name]({ id: 'x' })
    assert.equal(res.ok, false, name)
    assert.equal(res.code, code, name)
  }
})
