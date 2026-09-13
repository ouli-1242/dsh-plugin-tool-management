// test/archive.test.mjs —— 场景档案纯逻辑冒烟（node --test）。跑 lib 编译产物，改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArchive, hasSection, computeMcpPlan, computeSkillsPlan, snapshotRuntime, computeRestorePlan } from '../lib/rules/archive.js'

test('normalizeArchive: 段存在性独立于集合空否；mcp 两级规范化', () => {
  const a = normalizeArchive({ mcp: { github: '*', tavily: 'a, b' }, skills: [] })
  assert.deepEqual(a.mcp, { github: '*', tavily: ['a', 'b'] })
  assert.equal(a.subagents, undefined)
  assert.equal(hasSection(a, 'mcp'), true)
  assert.equal(hasSection(a, 'skills'), true)
  assert.equal(hasSection(a, 'subagents'), false)
})

test('computeMcpPlan: 勾选服务器→停用名单，* 整台，未勾→清空，未配置→stale', () => {
  const plan = computeMcpPlan(
    { github: '*', context7: ['query-docs', 'ghost'], tavily: [] },
    { configuredServers: ['github', 'context7', 'tavily', 'serena'], knownTools: { github: ['x', 'y'], context7: ['query-docs', 'other'], tavily: [], serena: ['s1'] } },
  )
  assert.deepEqual(plan.entries.github, ['*'])
  assert.deepEqual(plan.wildcards, ['github'])
  assert.deepEqual(plan.entries.context7, ['query-docs', 'ghost'])
  assert.deepEqual(plan.entries.tavily, [])
  assert.deepEqual(plan.entries.serena, [])
  assert.deepEqual(plan.stale, ['mcp/context7/ghost'])
})

test('computeMcpPlan: 档案里不存在于配置的服务器 → stale 且不写入', () => {
  const plan = computeMcpPlan({ gone: ['t'] }, { configuredServers: ['github'], knownTools: {} })
  assert.deepEqual(plan.entries.github, [])
  assert.equal(plan.entries.gone, undefined)
  assert.deepEqual(plan.stale, ['mcp/gone'])
})

test('computeSkillsPlan: 勾选集→目标启停，stale 上报', () => {
  const plan = computeSkillsPlan(['dsh/s1', 'gone/s'], new Set(['dsh/s1', 'dsh/s2']))
  assert.deepEqual(plan.target, { 'dsh/s1': true, 'dsh/s2': false })
  assert.deepEqual(plan.stale, ['skills/gone/s'])
})

test('restore: mcp 按快照原文整体还原（含 *），快照后新增键保持现状；技能同前', () => {
  const snapshot = snapshotRuntime({ github: ['*'], tavily: [] }, { 'dsh/s1': true })
  const plan = computeRestorePlan(snapshot, { mcp: { github: [], tavily: [], fresh: ['f'] }, skills: { 'dsh/s1': false } })
  assert.deepEqual(plan.mcp, { github: ['*'], tavily: [], fresh: ['f'] })
  assert.deepEqual(plan.skills, { 'dsh/s1': true })
})
