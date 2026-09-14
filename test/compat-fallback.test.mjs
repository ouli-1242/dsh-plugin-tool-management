// 契约测试：能力门禁在**写路径之前**拦截，并且拦截后不留下任何副作用。
//
// 与 compat-probe.test.mjs 的分工：那个文件验证"探测本身对不对"（形状、行为、
// 路由选择）；这个文件验证"探测结果真的被用来挡写操作吗"——即 history/bridge.js
// 这门面在能力缺失时的行为。两者的失败模式不同：探测错了是误报，门禁没接上是
// **数据被未知实现改动**，后者严重得多。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { createHistoryBridge, CapabilityRefusalError } from '../lib/history/bridge.js'

const require = createRequire(import.meta.url)
const { WorkspaceRegistry } = require('@deepseek-ai/dsh-workspace')
const { SessionProjectionCache } = require('@deepseek-ai/dsh-session-projection-cache')

/** 真实原型 + 可控成员：掩掉某个成员就等于"宿主这次没有它"。 */
function absent(target, names) {
  const hidden = new Set(names)
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && hidden.has(property)) return undefined
      return Reflect.get(object, property, receiver)
    },
    has(object, property) {
      if (typeof property === 'string' && hidden.has(property)) return false
      return Reflect.has(object, property)
    },
  })
}

function realRegistry(overrides = {}) {
  const registry = Object.create(WorkspaceRegistry.prototype)
  Object.assign(registry, {
    requireState: () => ({ archivedSessionIds: [], workspaceIds: [] }),
    requireTable: () => ({ get: () => undefined, entries: () => [] }),
    readSessionHeader: async () => ({ id: 's1' }),
    indexHeader: async () => {},
    enqueueOperation: async (fn) => fn(),
    setState: async () => {},
    // 注意：真实宿主 0.1.5-rc.2 **没有**原生归档扩展接口，所以这里默认不给
    // archiveSession/unarchiveSession 等；需要"原生入口存在"的用例自行覆盖。
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    entities: new Map(),
    ...overrides,
  })
  return registry
}

/** 实时会话服务：删除路由需要它，缺失会被能力门禁挡住。 */
function realSessions(overrides = {}) {
  return {
    get: () => undefined,
    flush: async () => {},
    liveEntryFor: () => ({ id: 'entry' }),
    detachEntered: () => {},
    enter: async () => ({ id: 'entry' }),
    announce: () => {},
    ...overrides,
  }
}

function realCache(overrides = {}) {
  const cache = Object.create(SessionProjectionCache.prototype)
  // 与真实 rc.2 一致：**没有**原生 delete / whenIdle，插件包裹写路径来补屏障。
  Object.assign(cache, {
    write: async () => {},
    put: async () => {},
    requireTable: () => ({ delete: async () => true }),
    ...overrides,
  })
  return cache
}

/** 自带删除屏障的缓存（更晚的宿主可能出现）：插件此时不得包裹任何方法。 */
function cacheWithBarrier(overrides = {}) {
  return realCache({ delete: async () => true, whenIdle: async () => {}, ...overrides })
}

/** 记录副作用：门禁失败时这些计数必须全是 0。 */
function spyLedger() {
  return { writes: 0, deletes: 0, enqueues: 0, stateSets: 0, headersIndexed: 0 }
}

/**
 * 门面用的假 ctx。`services` 里的对象就是"宿主实现"，`ledger` 记录任何写调用。
 * @param options - 可控的宿主部件与副作用账本。
 */
function fakeCtx({ registry, cache, sessions, ledger = spyLedger() } = {}) {
  const services = {
    workspaceRegistry: registry,
    sessionProjectionCache: cache,
    sessions,
    sessionPersistence: { list: async () => [] },
  }
  return {
    ctx: {
      get: (name) => services[name],
      on: () => () => {},
      logger: { warn: () => {}, error: () => {}, info: () => {} },
    },
    ledger,
  }
}

test('能力齐全时不抛错：门面正常接管（本机宿主形态）', () => {
  const registry = realRegistry()
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  // 实测：rc.2 的 WorkspaceRegistry.prototype 只有 archiveSession 这一个原生归档入口，
  // 恢复/批量/删除都没有 → 归档走原生，删除只能走适配层。
  assert.equal(typeof registry.archiveSession, 'function', '前置条件：原生 archiveSession 存在')
  assert.equal(registry.deleteSession, undefined, '前置条件：无原生 deleteSession')
  assert.equal(bridge.checkWorkspace('archive').via, 'native')
  assert.equal(bridge.checkWorkspace('delete').via, 'adapter')
  const assessment = bridge.capabilities(true)
  assert.equal(typeof assessment.identity.version, 'string')
  assert.equal(assessment.mayDelete, true, 'rc.2 的缓存自带删除屏障，删除必须可用')
})

test('宿主存在原生归档入口时，归档路由选原生而不是适配层', () => {
  const registry = realRegistry({ archiveSession: async () => {} })
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  assert.equal(bridge.checkWorkspace('archive').via, 'native')
})

test('串行写事务缺失 → 归档在**任何写入之前**被拒，且 registry 一个方法都没被调', async () => {
  const ledger = spyLedger()
  // 同时掩掉原生归档入口，让归档不得不走适配层 —— 这正是缺失能力会造成伤害的那条路。
  const registry = absent(realRegistry({
    enqueueOperation: async (fn) => { ledger.enqueues += 1; return fn() },
    setState: async () => { ledger.stateSets += 1 },
  }), ['enqueueOperation', 'archiveSession'])
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  assert.throws(() => bridge.checkWorkspace('archive'), CapabilityRefusalError)
  assert.throws(() => bridge.enqueue(() => { ledger.writes += 1 }), CapabilityRefusalError)
  assert.deepEqual(ledger, { writes: 0, deletes: 0, enqueues: 0, stateSets: 0, headersIndexed: 0 })
})

test('索引字段类型变了 → 拒绝，且不触碰宿主的任何写方法', () => {
  const ledger = spyLedger()
  const registry = realRegistry({ headers: [], enqueueOperation: async (fn) => { ledger.enqueues += 1; return fn() } })
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  // 原生归档入口在场 → 门禁走 native 路由后由索引形状检查拦截（两条护栏都要在）。
  assert.throws(() => bridge.enqueue(() => { ledger.writes += 1 }), (error) => {
    assert.ok(error instanceof CapabilityRefusalError || /工作区索引/.test(error.message))
    assert.match(error.message, /工作区索引/)
    return true
  })
  assert.equal(ledger.enqueues, 0, '索引形状不兼容时不得进入宿主的串行写事务')
})

test('投影缓存缺失 → beginDelete 拒绝，且没有开始装写屏障', async () => {
  const registry = realRegistry()
  const { ctx } = fakeCtx({ registry, cache: undefined })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  await assert.rejects(() => bridge.beginDelete('s1', { id: 's1' }), (error) => {
    assert.ok(error instanceof CapabilityRefusalError)
    assert.match(error.message, /projection|投影缓存/)
    return true
  })
})

test('宿主自带删除屏障时不包裹缓存：只读探测，不改宿主对象', async () => {
  // 更晚的宿主可能自带 delete + whenIdle → 门面必须直接用宿主的，不做 monkey patch。
  const cache = cacheWithBarrier()
  const originalPut = cache.put
  const originalWrite = cache.write
  const registry = realRegistry()
  const { ctx } = fakeCtx({ registry, cache, sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  await bridge.beginDelete('s1', { id: 's1' })
  assert.equal(cache.put, originalPut, '不得替换宿主缓存方法')
  assert.equal(cache.write, originalWrite, '不得替换宿主缓存方法')
})

test('宿主没有删除屏障时包裹缓存，并在 dispose 后原样还原', async () => {
  // 真实 rc.2 形态：没有 delete / whenIdle → 必须装上写屏障，dispose 后还原。
  const cache = realCache()
  const originalPut = cache.put
  const originalWrite = cache.write
  const registry = realRegistry()
  const { ctx } = fakeCtx({ registry, cache, sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  await bridge.beginDelete('s1', { id: 's1' })
  assert.notEqual(cache.put, originalPut, '缺屏障时必须装上写屏障')
  assert.notEqual(cache.write, originalWrite, '缺屏障时必须装上写屏障')
  await bridge.dispose()
  assert.equal(cache.put, originalPut, 'dispose 后必须还原宿主自己的实现')
  assert.equal(cache.write, originalWrite, 'dispose 后必须还原宿主自己的实现')
})

test('缓存写路径缺成员 → 装屏障时拒绝（不是装半个屏障后失败在链路中段）', async () => {
  const cache = absent(realCache(), ['put'])
  const registry = realRegistry()
  const { ctx } = fakeCtx({ registry, cache, sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  await assert.rejects(() => bridge.beginDelete('s1', { id: 's1' }), (error) => {
    assert.ok(error instanceof CapabilityRefusalError)
    assert.match(error.message, /put/)
    return true
  })
})

test('refusalsFor：能力缺失时给出可读条目，不抛错（只读路径降级用）', () => {
  const registry = absent(realRegistry(), ['requireState'])
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  const bridge = createHistoryBridge(ctx, registry, () => {})
  const refusals = bridge.refusalsFor('read', ['workspace.read-state', 'workspace.enqueue'])
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].id, 'workspace.read-state')
  assert.ok(refusals[0].detail.length > 0 && refusals[0].recovery.length > 0)
})

test('观测器只挂 domain/changed，不篡改 archiveSession', () => {
  const registry = realRegistry()
  const originalArchive = registry.archiveSession
  const events = []
  const { ctx } = fakeCtx({ registry, cache: realCache(), sessions: realSessions() })
  ctx.on = (name) => { events.push(name); return () => {} }
  const bridge = createHistoryBridge(ctx, registry, () => {})
  bridge.observe()
  bridge.observe() // 幂等：重复 observe 不应再挂一次
  assert.deepEqual(events, ['domain/changed'])
  assert.equal(registry.archiveSession, originalArchive, '不得替换宿主的 archiveSession')
})
