// Contract tests for src/compat/probe.ts (built to lib/compat/probe.js).
//
// The probe is the single gate that decides what this plugin may do to the
// host's data, so it is tested against the REAL published host classes
// (prototype chains via Object.create), not against hand-rolled lookalikes:
// a lookalike would let the probe's reference comparisons silently rot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  assessHost,
  routeFor,
  refusalsFor,
  requireRoute,
  summarize,
  CapabilityRefusalError,
  VERIFIED_HOST_VERSION,
} from '../lib/compat/probe.js'

const require = createRequire(import.meta.url)
const { WorkspaceRegistry } = require('@deepseek-ai/dsh-workspace')
const { SessionProjectionCache } = require('@deepseek-ai/dsh-session-projection-cache')

/** A workspace registry instance whose members are the REAL prototypes. */
function realRegistry(overrides = {}) {
  const registry = Object.create(WorkspaceRegistry.prototype)
  Object.assign(registry, {
    requireState: () => ({ archivedSessionIds: [], workspaceIds: [] }),
    requireTable: () => ({ get: () => undefined, entries: () => [] }),
    readSessionHeader: async () => ({ id: 's1' }),
    indexHeader: async () => {},
    enqueueOperation: async (fn) => fn(),
    setState: async () => {},
    archiveSession: async () => {},
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    entities: new Map(),
    ...overrides,
  })
  return registry
}

function realCache(overrides = {}) {
  const cache = Object.create(SessionProjectionCache.prototype)
  Object.assign(cache, {
    write: async () => {},
    put: async () => {},
    requireTable: () => ({ delete: async () => true, get: () => undefined }),
    delete: async () => true,
    whenIdle: async () => {},
    ...overrides,
  })
  return cache
}

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

/** A cordis-like context: only `get` and `logger` are read by the probe. */
function fakeCtx({ registry, cache, sessions } = {}) {
  const services = {
    workspaceRegistry: registry,
    sessionProjectionCache: cache,
    sessions,
    sessionPersistence: { list: async () => [] },
  }
  return {
    get: (name) => services[name],
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
}

/**
 * Mask members of a real host object so they read as ABSENT.
 * `delete obj.member` is not enough: the real implementations live on the
 * prototype chain, which is exactly the point of testing against them.
 */
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

const finding = (assessment, id) => assessment.findings.find((item) => item.id === id)

test('assessHost：形状完备（UI 与日志都按这个形状渲染）', () => {
  const assessment = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions: realSessions() }))
  assert.ok(Array.isArray(assessment.findings) && assessment.findings.length > 0)
  assert.equal(typeof assessment.identity.version, 'string')
  assert.equal(typeof assessment.identity.modules, 'object')
  assert.equal(typeof assessment.identity.sameAsHost, 'object')
  assert.ok(Array.isArray(assessment.identity.blockers))
  assert.ok(Array.isArray(assessment.degraded))
  assert.equal(typeof assessment.mayDelete, 'boolean')
  assert.equal(typeof assessment.generatedAt, 'number')
  for (const item of assessment.findings) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.label, 'string')
    assert.ok(['read', 'write', 'delete'].includes(item.kind))
    assert.ok(['ok', 'missing-member', 'shape-mismatch', 'not-available'].includes(item.state))
    assert.ok(['native-entry', 'degrade-read', 'disable-destructive'].includes(item.fallback))
    assert.equal(typeof item.detail, 'string')
    assert.ok(Array.isArray(item.missing))
  }
  // Module identity must be reported per package, never collapsed.
  assert.ok(Object.keys(assessment.identity.sameAsHost).length >= 5)
})

test(`本机宿主（本次验证版本 ${VERIFIED_HOST_VERSION}）上，删除链路所需能力必须全部 ok`, () => {
  const assessment = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions: realSessions() }))
  for (const id of [
    'workspace.read-state',
    'workspace.read-table',
    'workspace.index-shape',
    'workspace.read-header',
    'workspace.enqueue',
    'workspace.set-state',
    'workspace.index-header',
    'projection.write',
    'projection.delete-native',
  ]) {
    const item = finding(assessment, id)
    assert.ok(item !== undefined, `能力 ${id} 缺失于探测表`)
    assert.equal(item.state, 'ok', `${id} 在本机宿主应为 ok，实际 ${item.state}：${item.detail}`)
  }
  assert.equal(assessment.mayDelete, true)
})

test('插件与宿主共享同一模块实体：文本比对不再是否决条件', () => {
  const assessment = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions: realSessions() }))
  // 用真实原型方法充当宿主实现时，identity 必须成立（本仓库已去重：junction 到宿主安装）。
  const identityValues = Object.values(assessment.identity.sameAsHost).filter((value) => value !== null)
  assert.ok(identityValues.length > 0, '至少应能比较一个包的模块实体')
  // identity 全部为 true 时，blockers 必须为空 —— 反之亦然，两者不许互相矛盾。
  if (identityValues.every((value) => value === true)) {
    assert.deepEqual(assessment.identity.blockers, [])
  }
})

test('成员改名（模拟上游重构）→ 具名降级，而不是抛错', () => {
  const registry = absent(realRegistry(), ['requireState'])
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const item = finding(assessment, 'workspace.read-state')
  assert.equal(item.state, 'missing-member')
  assert.deepEqual(item.missing, ['requireState'])
  assert.equal(item.fallback, 'degrade-read')
  assert.equal(assessment.mayDelete, true, '只读能力缺失不应阻断删除链路')
})

test('行为探测：requireState() 形状变了 → shape-mismatch（读得到但读不懂）', () => {
  const registry = realRegistry({ requireState: () => ({ archivedSessionIds: 'not-an-array' }) })
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const item = finding(assessment, 'workspace.read-state')
  assert.equal(item.state, 'shape-mismatch')
  assert.match(item.detail, /archivedSessionIds/)
  assert.equal(routeFor(assessment, 'list').via, 'none')
})

test('行为探测：requireState() 抛错 → shape-mismatch 且带原始信息', () => {
  const registry = realRegistry({ requireState: () => { throw new Error('boom-shape') } })
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const item = finding(assessment, 'workspace.read-state')
  assert.equal(item.state, 'shape-mismatch')
  assert.match(item.detail, /boom-shape/)
})

test('服务整体缺失 → not-available（ctx.get 返回 undefined）', () => {
  const assessment = assessHost(fakeCtx({ registry: undefined, cache: undefined, sessions: undefined }))
  assert.equal(finding(assessment, 'workspace.read-state').state, 'not-available')
  assert.ok(assessment.degraded.length >= 5)
  assert.equal(assessment.mayDelete, false)
})

test('索引字段类型变化 → missing-member，且点明是哪个字段', () => {
  const registry = realRegistry({ headers: [] })
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const item = finding(assessment, 'workspace.index-shape')
  assert.equal(item.state, 'missing-member')
  assert.deepEqual(item.missing, ['headers(非 Map)'])
})

test('路由选择：宿主有原生入口就走原生，没有才走适配层', () => {
  const nativeHost = assessHost(fakeCtx({ registry: realRegistry({ archiveSession: async () => {} }), cache: realCache(), sessions: realSessions() }))
  assert.equal(routeFor(nativeHost, 'archive').via, 'native')

  // 真实宿主没有原生归档扩展接口：掩掉它，适配层必须接管。
  const adapterOnly = absent(realRegistry(), ['archiveSession'])
  const adapterHost = assessHost(fakeCtx({ registry: adapterOnly, cache: realCache(), sessions: realSessions() }))
  assert.equal(routeFor(adapterHost, 'archive').via, 'adapter')
})

test('路由选择：原生入口缺失时不会因为"部分可用"而误走适配层', () => {
  // 原生入口与适配层必需的串行写事务同时缺失 → 两条路都不可用，必须如实说 none。
  const registry = absent(realRegistry(), ['archiveSession', 'enqueueOperation'])
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const decision = routeFor(assessment, 'archive')
  assert.equal(decision.via, 'none')
  assert.ok(decision.refusals.some((item) => item.id === 'workspace.enqueue'))
  assert.ok(decision.refusals.every((item) => item.detail.length > 0 && item.recovery.length > 0))
})

test('删除路由：实时会话接口缺失 → 拒绝，且信息里给出能力名与原因', () => {
  const sessions = absent(realSessions(), ['liveEntryFor'])
  const assessment = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions }))
  const decision = routeFor(assessment, 'delete')
  assert.equal(decision.via, 'none')
  const refusal = decision.refusals.find((item) => item.id === 'sessions.detach-live')
  assert.ok(refusal !== undefined)
  assert.match(refusal.detail, /liveEntryFor/)
  assert.ok(refusal.recovery.length > 0)
  assert.throws(() => requireRoute(assessment, 'delete'), CapabilityRefusalError)
})

test('CapabilityRefusalError：错误文本自解释（操作名 + 能力 + 恢复指引）', () => {
  const sessions = absent(realSessions(), ['flush'])
  const assessment = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions }))
  const decision = routeFor(assessment, 'delete')
  const error = new CapabilityRefusalError('delete', decision.refusals)
  assert.equal(error.name, 'CapabilityRefusalError')
  assert.match(error.message, /宿主不支持该操作（delete）/)
  assert.match(error.message, /实时会话落盘与分离/)
  assert.match(error.message, /更新本插件/)
})

test('refusalsFor：只报不在 ok 的能力，顺序与请求一致', () => {
  const registry = absent(realRegistry(), ['setState'])
  const assessment = assessHost(fakeCtx({ registry, cache: realCache(), sessions: realSessions() }))
  const refusals = refusalsFor(assessment, ['workspace.enqueue', 'workspace.set-state', 'workspace.read-state'])
  assert.deepEqual(refusals.map((item) => item.id), ['workspace.set-state'])
})

test('summarize：日志与页面标题用的一行摘要', () => {
  const ok = assessHost(fakeCtx({ registry: realRegistry(), cache: realCache(), sessions: realSessions() }))
  assert.match(summarize(ok), /^宿主 \S+ · 能力 \d+\/\d+ · /)
  const broken = assessHost(fakeCtx({}))
  assert.match(summarize(broken), /降级 \d+ 项/)
})

test('探测是只读的：不写宿主状态、不调用写方法', () => {
  // 用一个"一旦被写调用就炸"的宿主对象，证明探测只走只读路径。
  const registry = realRegistry({
    setState: () => { throw new Error('probe must not call setState') },
    indexHeader: () => { throw new Error('probe must not call indexHeader') },
    enqueueOperation: () => { throw new Error('probe must not call enqueueOperation') },
    archiveSession: () => { throw new Error('probe must not call archiveSession') },
  })
  const cache = realCache({
    write: () => { throw new Error('probe must not call write') },
    put: () => { throw new Error('probe must not call put') },
    delete: () => { throw new Error('probe must not call delete') },
  })
  assert.doesNotThrow(() => assessHost(fakeCtx({ registry, cache, sessions: realSessions() })))
})
