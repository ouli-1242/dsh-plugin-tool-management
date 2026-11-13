// 可见性同步装层的契约测试。
//
// 钉的是一条**一旦破了就会静默出错**的事：`attachAgent` 的同步段必须把该摘的工具
// 一次摘干净。宿主在 `agent/created` 返回后**立刻**组装首轮工具表，异步段晚一步 ——
// 轨迹上就会出现「新增 N 个」紧跟「移除 N 个」，或者子代理第 1 步工具表里有、第 2 步没了
// （issue #29 的形态）。这类偏差不会报错，只会让模型少一条路或多一条路。
//
// 只测"同步装完之后 deny 名单对不对"，不测文案、不测日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolVisibility } from '../lib/mcp/tool-visibility.js'

/** 一套最小假宿主：工具全集、agent scope、restrict 的记账。 */
function fakeHost({ all, pluginHidden = [], carrierOf = () => [], overlayOf }) {
  const state = { deny: null, installs: 0 }
  const scopedTools = {
    restrict({ deny }) {
      state.deny = [...deny]
      state.installs += 1
      return () => { state.deny = null }
    },
  }
  const agent = { id: 'agent', ctx: { tools: scopedTools } }
  const tools = {
    get(name) { return all.includes(name) ? { name } : undefined },
    async schemas() { return all.map((name) => ({ name })) },
  }
  const vis = createToolVisibility({
    readJsonFile: async () => ({}),
    readJsonFileStrict: async () => ({ ok: true, value: {} }),
    writeJsonFile: async () => {},
    ensurePaths: async () => ({}),
    withWriteLock: (fn) => fn(),
    message: (e) => String(e?.message ?? e),
    tools,
    normalizeKnownTools: () => [],
    mcpSidecar: () => '/tmp/none.json',
    SIDECAR_TTL_MS: 1000,
    MCP_DISABLED_TOOLS_FILE: 'disabled',
    MCP_KNOWN_TOOLS_FILE: 'known',
    pluginHiddenTools: () => pluginHidden,
    carrierHiddenTools: (a) => carrierOf(tools, a),
    ...(overlayOf === undefined ? {} : { sessionToolTableOverlay: (a) => overlayOf(tools, a) }),
  })
  return { vis, agent, state }
}

test('同步装层：载体在场时，本该让位的工具在首轮就不在工具表里', () => {
  const { vis, agent, state } = fakeHost({
    all: ['skill', 'skill_manager_read', 'read', 'write'],
    // 生产实现就是这个形状：官方 `skill` 在 agent 手里 → 藏 `skill_manager_read`。
    carrierOf: (tools, a) => (tools.get('skill', a) !== undefined ? ['skill_manager_read'] : []),
  })
  vis.attachAgent(agent)
  assert.deepEqual(state.deny, ['skill_manager_read'], '同步段就该把它摘掉，不能等异步')
  assert.equal(state.installs, 1)
})

test('同步装层：载体不在时不误摘（读不到 = 不让位）', () => {
  const { vis, agent, state } = fakeHost({
    all: ['skill_manager_read', 'read', 'write'],
    carrierOf: (tools, a) => (tools.get('skill', a) !== undefined ? ['skill_manager_read'] : []),
  })
  vis.attachAgent(agent)
  assert.equal(state.deny, null, '没有载体就没有该让位的工具，一层都不用装')
})

test('同步装层：全局关掉的工具与载体让位并进同一层', () => {
  const { vis, agent, state } = fakeHost({
    all: ['skill', 'skill_manager_read', 'memory_manager_note', 'read'],
    pluginHidden: ['memory_manager_note'],
    carrierOf: (tools, a) => (tools.get('skill', a) !== undefined ? ['skill_manager_read'] : []),
  })
  vis.attachAgent(agent)
  assert.deepEqual([...state.deny].sort(), ['memory_manager_note', 'skill_manager_read'])
})

test('同步装层：会话 allow 不能把载体让位那条重新放回来', async () => {
  // 现场：全局工具表关着两条，本会话的创建时 baseline 不含它们 → 会话覆盖算出 allow。
  // 会话 allow 该赢过全局关停（用户显式重新打开），但**不能**赢过载体让位 ——
  // 让位判的是"官方 skill 已在场，这条只是重复"，不是可见性偏好。
  // 两段一旦判反，首轮有、第二步没，轨迹上又是一次「移除工具」。
  const { vis, agent, state } = fakeHost({
    all: ['skill', 'skill_manager_read', 'memory_manager_get', 'read'],
    pluginHidden: ['skill_manager_read', 'memory_manager_get'],
    carrierOf: (tools, a) => (tools.get('skill', a) !== undefined ? ['skill_manager_read'] : []),
    overlayOf: () => ({ allow: ['skill_manager_read', 'memory_manager_get'], deny: [] }),
  })
  vis.attachAgent(agent)
  const syncDeny = state.deny === null ? [] : [...state.deny].sort()
  assert.deepEqual(syncDeny, ['skill_manager_read'], '会话 allow 只减全局那半边，载体让位加在它之后')
  await new Promise((r) => setTimeout(r, 20))
  const asyncDeny = state.deny === null ? [] : [...state.deny].sort()
  assert.deepEqual(asyncDeny, syncDeny, '同步段与异步段必须给出同一份名单')
})

test('同步装层：载体判据返回 Promise 时跳过它，其余同步判据照装', async () => {
  const { vis, agent, state } = fakeHost({
    all: ['skill', 'skill_manager_read', 'memory_manager_note', 'read'],
    pluginHidden: ['memory_manager_note'],
    // 旧实现（异步）仍要能工作：同步段不等它，但不能连别的判据一起放弃。
    carrierOf: async () => ['skill_manager_read'],
  })
  vis.attachAgent(agent)
  assert.deepEqual(state.deny, ['memory_manager_note'], '同步段先装能算出来的那部分')
  // 异步段随后补齐载体让位（`attachAgent` 里那条 promise 链）。
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual([...state.deny].sort(), ['memory_manager_note', 'skill_manager_read'])
})
