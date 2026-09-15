// test/archive.test.mjs —— 场景档案纯逻辑 + 引擎状态机冒烟（node --test）。跑 lib 编译产物，改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArchive, normalizeMcpSpec, hasSection, computeMcpPlan, computeSkillsPlan, snapshotRuntime } from '../lib/rules/archive.js'
import { createArchiveEngine } from '../lib/rules/archive-engine.js'

test('normalizeArchive: 段存在性独立于集合空否；mcp 两级规范化', () => {
  const a = normalizeArchive({ mcp: { github: '*', tavily: 'a, b' }, skills: [] })
  assert.deepEqual(a.mcp, { github: '*', tavily: ['a', 'b'] })
  assert.equal(a.subagents, undefined)
  assert.equal(hasSection(a, 'mcp'), true)
  assert.equal(hasSection(a, 'skills'), true)
  assert.equal(hasSection(a, 'subagents'), false)
})

test('normalizeMcpSpec: 保留空清单（合法值）；畸形形态丢弃', () => {
  // 空清单 = 勾了服务器但一个工具都不勾 → 该服务器全部停用，必须能持久化。
  assert.deepEqual(normalizeMcpSpec({ github: [], tavily: '' }), { github: [], tavily: [] })
  // 畸形值（null/数字/对象）不是勾选集，丢弃；非对象整体返回 undefined。
  assert.deepEqual(normalizeMcpSpec({ a: null, b: 1, c: { x: 1 }, d: '*' }), { d: '*' })
  assert.equal(normalizeMcpSpec(null), undefined)
  assert.equal(normalizeMcpSpec([1, 2]), undefined)
})

test('computeMcpPlan: 勾选集 → 停用补集（未勾整台停；勾 * 全启用；勾清单 = known − 勾选）', () => {
  const plan = computeMcpPlan(
    { github: '*', context7: ['query-docs', 'ghost'], tavily: [] },
    {
      configuredServers: ['github', 'context7', 'tavily', 'serena'],
      knownTools: { github: ['x', 'y'], context7: ['query-docs', 'other'], tavily: [], serena: ['s1'] },
    },
  )
  assert.deepEqual(plan.entries.github, [])          // 勾 '*' = 整台启用
  assert.deepEqual(plan.entries.context7, ['other']) // known − 勾选
  assert.deepEqual(plan.entries.tavily, [])          // 勾了但 known 为空 → 无法枚举补集
  assert.deepEqual(plan.entries.serena, ['*'])       // 未勾 = 整台停用
  assert.deepEqual(plan.wildcards, ['serena'])
  assert.deepEqual(plan.stale, ['mcp/context7/ghost', 'mcp/tavily/*'])
})

test('computeMcpPlan: 已勾服务器且工具全不勾 = 全部停用（known 非空）', () => {
  const plan = computeMcpPlan({ github: [] }, { configuredServers: ['github'], knownTools: { github: ['a', 'b'] } })
  assert.deepEqual(plan.entries.github, ['a', 'b'])
  assert.deepEqual(plan.stale, [])
})

test('computeMcpPlan: 已配置但未运行（knownTools 空）→ 不把勾选清单报成 stale，只报 server/*', () => {
  const plan = computeMcpPlan({ idle: ['x', 'y'] }, { configuredServers: ['idle'], knownTools: { idle: [] } })
  assert.deepEqual(plan.entries.idle, [])
  assert.deepEqual(plan.stale, ['mcp/idle/*'])
})

test('computeMcpPlan: 档案里不存在于配置的服务器 → stale 且不写入', () => {
  const plan = computeMcpPlan({ gone: ['t'] }, { configuredServers: ['github'], knownTools: {} })
  assert.deepEqual(plan.entries.github, ['*'])   // github 未勾 → 整台停用
  assert.equal(plan.entries.gone, undefined)
  assert.deepEqual(plan.stale, ['mcp/gone'])
})

test('computeSkillsPlan: 勾选集→目标启停，stale 上报', () => {
  const plan = computeSkillsPlan(['dsh/s1', 'gone/s'], new Set(['dsh/s1', 'dsh/s2']))
  assert.deepEqual(plan.target, { 'dsh/s1': true, 'dsh/s2': false })
  assert.deepEqual(plan.stale, ['skills/gone/s'])
})

test('snapshotRuntime: 深拷贝停用表与技能表（快照后改写原表不影响快照）', () => {
  const raw = { github: ['*'], tavily: [] }
  const snapshot = snapshotRuntime(raw, { 'dsh/s1': true })
  raw.github.push('extra')
  assert.deepEqual(snapshot.mcp, { github: ['*'], tavily: [] })
  assert.deepEqual(snapshot.skills, { 'dsh/s1': true })
})

// ── 引擎状态机（deps 全注入，无需真实 I/O）─────────────────────────────────

function makeEngine(overrides = {}) {
  const state = {
    slice: {
      archives: { s1: { mcp: { github: '*' }, skills: ['dsh/a'] }, memo: { subagents: ['p1'] } },
      mode: { scene: null, snapshot: null },
      active: null,
    },
    mcpRaw: { github: ['locked'] },
    skills: { 'dsh/a': false, 'dsh/b': false },
    // P5：服务器级 / 来源级启停现状。默认空 = 不产生上层切换（既有用例的行为不变）。
    mcpServers: [],
    skillSources: [],
  }
  const clone = (v) => JSON.parse(JSON.stringify(v))
  const deps = {
    loadSlice: async () => clone(state.slice),
    saveSlice: async (slice) => { state.slice = clone(slice) },
    configuredServers: async () => ['github', 'tavily'],
    serverKnownTools: async () => ({ github: ['t1', 't2'], tavily: [] }),
    currentMcpRaw: async () => clone(state.mcpRaw),
    applyMcpEntries: async (entries) => { state.mcpRaw = clone(entries) },
    mcpServerStates: async () => clone(state.mcpServers),
    applyMcpServerSwitches: async (switches) => {
      for (const s of switches) {
        const row = state.mcpServers.find((x) => x.id === s.id)
        if (row) row.disabled = !s.enabled
      }
    },
    skillSourceStates: async () => clone(state.skillSources),
    applySkillSourceSwitches: async (switches) => {
      for (const s of switches) {
        const row = state.skillSources.find((x) => x.root === s.root)
        if (row) row.enabled = s.enabled
      }
    },
    knownSkillKeys: async () => new Set(['dsh/a', 'dsh/b']),
    currentSkills: async () => ({ ...state.skills }),
    applySkills: async (target) => { state.skills = { ...target } },
    // v0.8 子智能体开关：进/退模式时启用/停回档案勾选的人设。
    disabledPersonas: async (names) => [],
    applySubagentSwitches: async (switches) => {},
    sceneExists: async (name) => name === 's1' || name === 'memo',
    knownPersonas: async () => new Set(['p1']),
    ...overrides,
  }
  return { engine: createArchiveEngine(deps), state }
}

test('引擎 scene-archive-save: 空段可持久化（全不勾 = 全部停用），全 stale 段才丢弃', async () => {
  const { engine, state } = makeEngine()
  const first = await engine.ops['scene-archive-save']({ scene: 's1', archive: { mcp: {}, skills: [] } })
  assert.equal(first.ok, true)
  assert.deepEqual(state.slice.archives.s1.mcp, {})      // 空段保留（全不勾 = 全部停用）
  assert.deepEqual(state.slice.archives.s1.skills, [])
  const second = await engine.ops['scene-archive-save']({ scene: 's1', archive: { mcp: {}, skills: [], subagents: ['ghost'] } })
  assert.deepEqual(second.stale, ['subagents/ghost'])
  assert.equal(state.slice.archives.s1.subagents, undefined)     // 全 stale → 段丢弃
  assert.deepEqual(state.slice.archives.s1.mcp, {})              // 其余段不受影响
})

test('引擎 scene-mode-set: 应用补集 + 记忆收窄；退出恢复快照但不动记忆', async () => {
  const { engine, state } = makeEngine()
  const entered = await engine.ops['scene-mode-set']({ scene: 's1' })
  assert.equal(entered.ok, true)
  assert.deepEqual(state.mcpRaw, { github: [], tavily: ['*'] })   // github 勾 '*' → 全启用；tavily 未勾 → 整台停
  assert.deepEqual(state.skills, { 'dsh/a': true, 'dsh/b': false })
  assert.deepEqual(state.slice.active, ['s1'])                    // 记忆收窄到该场景
  assert.equal(state.slice.mode.scene, 's1')

  const exited = await engine.ops['scene-mode-set']({ scene: null })
  assert.equal(exited.ok, true)
  // 快照原文还原：模式自己写进去的 tavily: ['*'] 随之消失，退出后用户环境不被静默停用。
  assert.deepEqual(state.mcpRaw, { github: ['locked'] })
  assert.deepEqual(state.skills, { 'dsh/a': false, 'dsh/b': false })
  assert.equal(state.slice.mode.scene, null)
  assert.deepEqual(state.slice.active, ['s1'])                    // 记忆启用集不随退出恢复（设计 §2.2）
})

test('引擎 scene-mode-set: 仅记忆场景不建快照；仅子智能体场景启用绑定人设并建快照，mode 与 active 一起写', async () => {
  // P6 契约变更：场景开关成为唯一入口，纯记忆/纯人设场景点开关不能再报错；
  // 而且 mode.scene 必须写入（顶部「当前模式」横幅的渲染条件就是它）。
  // v0.8：subagents 段也算「应用」——进入时把绑定的人设启用（快照记录停回名单）。
  const { engine, state } = makeEngine()
  const r = await engine.ops['scene-mode-set']({ scene: 'memo' })
  assert.equal(r.ok, true)
  assert.equal(r.mode.scene, 'memo')
  assert.deepEqual(r.applied, { mcp: false, skills: false, subagents: true })
  assert.deepEqual(state.mcpRaw, { github: ['locked'] })     // MCP 运行时原样
  assert.deepEqual(state.slice.mode.snapshot.subagents, undefined) // 快照无停回名单（本来全启用）
  assert.equal(state.slice.mode.scene, 'memo')               // mode.scene 照常写入
  assert.deepEqual(state.slice.active, ['memo'])             // 与 mode 恒等
})

test('引擎 scene-mode-set: 应用失败 → 运行时回滚 + 模式写回，错误如实标「已回滚」', async () => {
  // 技能通道第一次调用炸（进入模式时），回滚那次正常 —— 模拟可恢复的写入故障。
  let failOnce = true
  const { engine, state } = makeEngine({
    applySkills: async (target) => {
      if (failOnce) { failOnce = false; throw new Error('boom') }
      state.skills = { ...target }
    },
  })
  const r = await engine.ops['scene-mode-set']({ scene: 's1' })
  assert.equal(r.ok, false)
  assert.match(r.error, /已回滚/)
  assert.deepEqual(state.mcpRaw, { github: ['locked'] })          // MCP 也一起退（不是只回滚技能）
  assert.equal(state.slice.mode.scene, null)
  assert.equal(state.slice.active, null)
})

test('引擎 scene-mode-set: 回滚本身失败 → 错误文本标「回滚未完成」，不谎报已回滚', async () => {
  const { engine, state } = makeEngine({
    applySkills: async () => { throw new Error('boom') },
    applyMcpEntries: async () => { throw new Error('mcp down') },
  })
  const r = await engine.ops['scene-mode-set']({ scene: 's1' })
  assert.equal(r.ok, false)
  assert.match(r.error, /回滚未完成/)
  assert.deepEqual(state.mcpRaw, { github: ['locked'] })
  assert.equal(state.slice.mode.scene, null)
})
