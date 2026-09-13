// test/archive.test.mjs —— 场景档案纯逻辑冒烟（node --test）。跑 lib 编译产物，改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArchive, hasSection, computeApplyPlan, snapshotRuntime, computeRestorePlan } from '../lib/rules/archive.js'

test('normalizeArchive: 键存在性独立于集合空否', () => {
  const a = normalizeArchive({ tools: [], subagents: 'x, y' })
  assert.deepEqual(a.tools, [])
  assert.equal(a.skills, undefined)
  assert.deepEqual(a.subagents, ['x', 'y'])
  assert.equal(hasSection(a, 'tools'), true)
  assert.equal(hasSection(a, 'skills'), false)
})

test('computeApplyPlan: 勾选集→目标启停，stale 跳过，未定义段不碰', () => {
  const known = { tools: new Set(['a/t1', 'a/t2', 'b/t3']), skills: new Set(['dsh/s1', 'dsh/s2']) }
  const plan = computeApplyPlan(normalizeArchive({ tools: ['a/t1', 'gone/t9'] }), known)
  assert.deepEqual(plan.tools, { 'a/t1': true, 'a/t2': false, 'b/t3': false })
  assert.equal(plan.skills, null)
  assert.deepEqual(plan.stale, ['tools/gone/t9'])
})

test('computeApplyPlan: 段全不勾 = 全停（合法），两段同时应用', () => {
  const known = { tools: new Set(['a/t1']), skills: new Set(['dsh/s1']) }
  const plan = computeApplyPlan(normalizeArchive({ tools: [], skills: ['dsh/s1'] }), known)
  assert.deepEqual(plan.tools, { 'a/t1': false })
  assert.deepEqual(plan.skills, { 'dsh/s1': true })
})

test('restore: 快照键按快照值还原，快照后新增键保持现状', () => {
  const snapshot = snapshotRuntime({ 'a/t1': true, 'a/t2': false }, { 'dsh/s1': true })
  const plan = computeRestorePlan(snapshot, { tools: { 'a/t1': false, 'new/t': true }, skills: { 'dsh/s1': false } })
  assert.deepEqual(plan.tools, { 'a/t1': true, 'a/t2': false, 'new/t': true })
  assert.deepEqual(plan.skills, { 'dsh/s1': true })
})
