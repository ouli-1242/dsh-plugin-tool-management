// tests/history.test.mjs — fake-ctx integration tests for the History ops
// (list / archive / unarchive / delete / retention get+set) + the retention
// sweeper pure helper. The ported workspace service (lib/history/workspace.js)
// is not exercised here — it is upstream-proven by @michengai/dsh-archive-manager.
// Here we inject a FAKE workspaceRegistry via ctx.get('workspaceRegistry').
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'
import { parseJsonlTranscript, parseMarkdownTranscript } from '../lib/imports/parsers.js'

// Reuse the fake-ctx shape from mcpm.test.mjs, minimal for the HTTP route.
function makeCtx(home, files) {
  files = files || new Map()
  if (!files.has(join(home, 'settings.yaml'))) files.set(join(home, 'settings.yaml'), '')
  if (!files.has(join(home, 'profiles', 'web', 'cordis.patch.yml'))) files.set(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  if (!files.has(join(home, 'cordis.patch.yml'))) files.set(join(home, 'cordis.patch.yml'), '[]\n')
  let route = null
  const ctx = {
    timer: {},
    timeout: () => Promise.resolve(),
    settings: { prepareDocument: async () => join(home, 'settings.yaml') },
    sandboxPolicy: { resolve: async () => ({}) },
    tools: { register() {}, schemas: () => [], guard() { return () => {} }, restrict() { return () => {} } },
    webServer: { register(r) { route = r; return () => {} } },
    fs: {
      async resolve(p) { return p },
      async stat(p) { return files.has(p) ? { isFile: () => true, isDirectory: () => false } : undefined },
      async readText(p) { if (!files.has(p)) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e } return files.get(p) },
      async writeText(p, c) { files.set(p, String(c)) },
      async listDir() { return [] },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') d() },
    on() {},
    events: { dispatch: () => [] },
    get(name) { return name === 'workspaceRegistry' ? ctx._registry : name === 'sessions' ? ctx._sessions : name === 'sessionPersistence' ? ctx._persistence : undefined },
    skills: { registerProvider() {}, async snapshot() { return { skills: [], complete: true } }, async get() { return undefined } },
    _files: files,
    _route: () => route,
    _registry: undefined,
    _sessions: undefined,
  }
  return ctx
}

function call(route, payload, headers = {}, body = null) {
  const b = body === null ? JSON.stringify(payload) : body
  const req = { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management', ...headers }, on(ev, cb) { if (ev === 'data') cb(b); if (ev === 'end') cb() } }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b2) { this.bodyText = b2 || '' } }
  const p = route.handler(req, res)
  return (p ? Promise.resolve(p) : Promise.resolve()).then(() => ({ status: res.status, json: res.bodyText ? JSON.parse(res.bodyText) : null }))
}

// A fake workspace registry implementing the minimal HistoryRegistry surface.
// opts: { table?, workspaceIds?, unarchive?, requireTable? } —
//   table: Map<workspaceId, {path,title,sessionIds}>;
//   unarchive: boolean — expose unarchiveSessions for the batch op;
//   requireTable: false — omit requireTable/requireState to test the flat-list fallback.
function fakeRegistry(calls, details, opts) {
  opts = opts || {}
  const archived = new Set(details.map((d) => d.sessionId))
  const table = opts.table || new Map()
  const workspaceIds = opts.workspaceIds || []
  return {
    calls,
    async archiveSession(id) { calls.push(['archiveSession', id]); archived.add(id) },
    async unarchiveSession(id) { calls.push(['unarchiveSession', id]); archived.delete(id); return { archivedSessionIds: [...archived] } },
    async deleteSession(id) { calls.push(['deleteSession', id]); archived.delete(id) },
    async deleteArchivedSessions(target) { calls.push(['deleteArchivedSessions', target]); const del = target.scope === 'sessions' ? target.sessionIds : [...archived]; for (const id of del) archived.delete(id); return { requestedSessionIds: del, deletedSessionIds: del, skippedSessionIds: [], failures: [] } },
    async archivedSessionMetadata() { return { items: details.map((d) => ({ sessionId: d.sessionId, createdAt: d.createdAt })) } },
    async archivedSessionDetails() { return { items: details.map((d) => ({ sessionId: d.sessionId, createdAt: d.createdAt, cwd: d.cwd, title: d.title, archivedAt: d.archivedAt })) } },
    archivedAt(id) { const d = details.find((x) => x.sessionId === id); return d && d.archivedAt },
    ...(opts.requireTable === false ? {} : {
      requireTable() { return table },
      requireState() { return { workspaceIds } },
    }),
    ...(opts.listStoredHeaders === false ? {} : {
      async listStoredHeaders() {
        return opts.headers || details.map((d) => ({ id: d.sessionId, cwd: d.cwd, createdAt: d.createdAt }))
      },
    }),
    ...(opts.unarchive ? {
      async unarchiveSessions(target) {
        calls.push(['unarchiveSessions', target])
        const del = target.scope === 'sessions' ? target.sessionIds : [...archived]
        for (const id of del) archived.delete(id)
        return { unarchivedSessionIds: del, archivedSessionIds: [...archived] }
      },
    } : {}),
  }
}

test('history-list returns items + retentionDays; degrades when registry missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'history-list', args: {} })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /归档服务未挂载/)
})

test('history-list maps archivedSessionDetails into items + retentionDays', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const retentionPath = join(home, 'data', 'history-retention.json')
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry([], [
    { sessionId: 's1', createdAt: 1000, cwd: 'C:/proj', title: 'Hello', archivedAt: 2000 },
    { sessionId: 's2', createdAt: 3000, cwd: 'D:/x', title: undefined, archivedAt: 4000 },
  ])
  plugin.apply(ctx, { historyRetentionPath: retentionPath, sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-list', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.retentionDays, 0)
  assert.equal(r.json.items.length, 2)
  assert.equal(r.json.items[0].title, 'Hello')
  assert.equal(r.json.items[0].archivedAt, 2000)
  assert.equal(r.json.items[1].title, undefined)
})

test('history-archive / history-unarchive / history-delete route through the registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [{ sessionId: 's1', createdAt: 1, archivedAt: 2 }])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  let r = await call(ctx._route(), { op: 'history-archive', args: { sessionId: 's9' } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(calls[0], ['archiveSession', 's9'])
  r = await call(ctx._route(), { op: 'history-unarchive', args: { sessionId: 's9' } })
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.archivedSessionIds))
  r = await call(ctx._route(), { op: 'history-delete', args: { sessionId: 's1' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.deleted, true)
  assert.ok(calls.some((c) => c[0] === 'deleteSession' && c[1] === 's1'))
})

test('history-retention get/set persists + validates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const retentionPath = join(home, 'data', 'history-retention.json')
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [])
  plugin.apply(ctx, { historyRetentionPath: retentionPath, sweepIntervalMs: 0 })
  // default never (0)
  let r = await call(ctx._route(), { op: 'history-retention-get', args: {} })
  assert.equal(r.json.retentionDays, 0)
  // set 7
  r = await call(ctx._route(), { op: 'history-retention-set', args: { retentionDays: 7 } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.retentionDays, 7)
  const onDisk = JSON.parse(readFileSync(retentionPath, 'utf8'))
  assert.equal(onDisk.retentionDays, 7)
  assert.equal(typeof onDisk.updatedAt, 'number', 'set 记录修改时刻 updatedAt')
  // get reflects
  r = await call(ctx._route(), { op: 'history-retention-get', args: {} })
  assert.equal(r.json.retentionDays, 7)
  // invalid value rejected
  r = await call(ctx._route(), { op: 'history-retention-set', args: { retentionDays: -5 } })
  assert.equal(r.json.ok, false)
})

test('history write ops are token-gated (history-delete without token fails)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [{ sessionId: 's1', createdAt: 1 }])
  plugin.apply(ctx, { token: 'secret', sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-delete', args: { sessionId: 's1' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  assert.equal(calls.length, 0)
  // with token
  const r2 = await call(ctx._route(), { op: 'history-delete', args: { sessionId: 's1' } }, { 'x-dsh-token': 'secret' })
  assert.equal(r2.json.ok, true)
})

test('sweeper: 改保留期后从设置时刻重置倒计时；0 永不删除', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const retentionPath = join(home, 'data', 'history-retention.json')
  const calls = []
  const now = Date.now()
  const old = now - 40 * 86400000
  const fresh = now - 1000
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry(calls, [
    { sessionId: 's-old', createdAt: old, archivedAt: old },
    { sessionId: 's-fresh', createdAt: fresh, archivedAt: fresh },
  ])
  plugin.apply(ctx, { historyRetentionPath: retentionPath, sweepIntervalMs: 0 })
  // set 30 → updatedAt = now：已归档 40 天的 s-old 也从设置时刻重新计 → 全部豁免
  const r = await call(ctx._route(), { op: 'history-retention-set', args: { retentionDays: 30 } })
  assert.equal(r.json.ok, true)
  assert.equal(calls.filter((c) => c[0] === 'deleteArchivedSessions').length, 0,
    '修改保留期后倒计时重置，已归档 40 天的会话也豁免')
  // retention = 0 (never) → no delete
  const r2 = await call(ctx._route(), { op: 'history-retention-set', args: { retentionDays: 0 } })
  assert.equal(r2.json.ok, true)
  assert.equal(calls.length, 0, 'never retention must not delete')
})

test('sweeper: 重启后按持久化的 updatedAt 重置（归档早于设置也豁免）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const retentionPath = join(home, 'data', 'history-retention.json')
  const calls = []
  const now = Date.now()
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry(calls, [
    // s-old 归档 40 天前，但 3 天前改过保留期 → 从设置时刻重新计，尚未到期
    { sessionId: 's-old', createdAt: now - 40 * 86400000, archivedAt: now - 40 * 86400000 },
    { sessionId: 's-fresh', createdAt: now - 1000, archivedAt: now - 1000 },
  ])
  mkdirSync(dirname(retentionPath), { recursive: true })
  writeFileSync(retentionPath, JSON.stringify({ retentionDays: 7, updatedAt: now - 3 * 86400000 }), 'utf8')
  plugin.apply(ctx, { historyRetentionPath: retentionPath, sweepIntervalMs: 0 })
  // apply 启动时触发一次 sweep（fire-and-forget），等它跑完
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.filter((c) => c[0] === 'deleteArchivedSessions').length, 0,
    '归档早于设置时刻的会话从设置时刻重新计，40 天前归档也豁免')
})

test('sweeper: 旧配置（无 updatedAt）按归档时刻判定', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const retentionPath = join(home, 'data', 'history-retention.json')
  const calls = []
  const now = Date.now()
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry(calls, [
    { sessionId: 's-old', createdAt: now - 40 * 86400000, archivedAt: now - 40 * 86400000 },
    { sessionId: 's-fresh', createdAt: now - 1000, archivedAt: now - 1000 },
  ])
  mkdirSync(dirname(retentionPath), { recursive: true })
  writeFileSync(retentionPath, JSON.stringify({ retentionDays: 30 }), 'utf8')
  plugin.apply(ctx, { historyRetentionPath: retentionPath, sweepIntervalMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const del = calls.find((c) => c[0] === 'deleteArchivedSessions')
  assert.ok(del, '旧配置无 updatedAt → 按归档时刻判定，40 天前归档的会话到期')
  assert.deepEqual(del[1], { scope: 'sessions', sessionIds: ['s-old'] })
})

test('history-list missing sessionId rejected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-unarchive', args: {} })
  assert.equal(r.json.ok, false)
})

test('history-list carries workspace grouping info from requireTable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const table = new Map([
    ['ws1', { path: 'C:/a', title: 'Project A', sessionIds: ['s1'] }],
    ['ws2', { path: 'D:/b', title: 'Project B', sessionIds: [] }],
  ])
  ctx._registry = fakeRegistry([], [
    { sessionId: 's1', createdAt: 1000, cwd: 'C:/a', title: 'Hello', archivedAt: 2000 },
    { sessionId: 's2', createdAt: 3000, cwd: 'D:/x', title: 'Solo', archivedAt: 4000 },
  ], { table, workspaceIds: ['ws1', 'ws2'] })
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-list', args: {} })
  assert.equal(r.json.ok, true)
  // s1 属于 ws1；s2 不在任何 workspace → 无 workspaceId
  assert.equal(r.json.items[0].workspaceId, 'ws1')
  assert.equal(r.json.items[1].workspaceId, undefined)
  assert.deepEqual(r.json.workspaces.ws1, { title: 'Project A', path: 'C:/a' })
  assert.deepEqual(r.json.workspaces.ws2, { title: 'Project B', path: 'D:/b' })
})

test('history-list degrades to flat list when requireTable is missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry([], [{ sessionId: 's1', createdAt: 1000, archivedAt: 2000 }], { requireTable: false })
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-list', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.workspaces, undefined)
  assert.equal(r.json.items[0].workspaceId, undefined)
})

test('history-unarchive-batch routes through unarchiveSessions and degrades when unsupported', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [{ sessionId: 's1', createdAt: 1, archivedAt: 2 }], { unarchive: true })
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  let r = await call(ctx._route(), { op: 'history-unarchive-batch', args: { target: { scope: 'sessions', sessionIds: ['s1'] } } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.unarchivedSessionIds, ['s1'])
  assert.ok(calls.some((c) => c[0] === 'unarchiveSessions' && c[1].scope === 'sessions' && c[1].sessionIds[0] === 's1'))
  // 无 unarchiveSessions 的旧 registry → 明确错误
  const ctx2 = makeCtx(mkdtempSync(join(tmpdir(), 'dsh-hist-')))
  ctx2._registry = fakeRegistry([], [])
  plugin.apply(ctx2, { sweepIntervalMs: 0 })
  const r2 = await call(ctx2._route(), { op: 'history-unarchive-batch', args: { target: { scope: 'sessions', sessionIds: ['s1'] } } })
  assert.equal(r2.json.ok, false)
  assert.match(r2.json.error, /不支持批量恢复/)
})

test('history-delete-batch routes through deleteArchivedSessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [{ sessionId: 's1', createdAt: 1, archivedAt: 2 }])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-delete-batch', args: { target: { scope: 'sessions', sessionIds: ['s1'] } } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.deletedSessionIds, ['s1'])
  assert.ok(calls.some((c) => c[0] === 'deleteArchivedSessions' && c[1].scope === 'sessions' && c[1].sessionIds[0] === 's1'))
})

test('batch target validation rejects malformed targets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const cases = [
    [undefined, /缺少 target/],
    [{ scope: 'foo' }, /scope 不合法/],
    [{ scope: 'sessions', sessionIds: [] }, /非空的 sessionIds/],
    [{ scope: 'workspace' }, /需要 workspaceId/],
  ]
  for (const [target, re] of cases) {
    const r = await call(ctx._route(), { op: 'history-delete-batch', args: { target } })
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, re)
  }
  // 合法 all / ungrouped 通过
  for (const scope of ['all', 'ungrouped']) {
    const r = await call(ctx._route(), { op: 'history-delete-batch', args: { target: { scope } } })
    assert.equal(r.json.ok, true)
  }
})

test('batch ops are token-gated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [{ sessionId: 's1', createdAt: 1, archivedAt: 2 }], { unarchive: true })
  plugin.apply(ctx, { token: 'secret', sweepIntervalMs: 0 })
  for (const op of ['history-unarchive-batch', 'history-delete-batch']) {
    const before = calls.length
    const r = await call(ctx._route(), { op, args: { target: { scope: 'sessions', sessionIds: ['s1'] } } })
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /令牌/)
    assert.equal(calls.length, before, op + ' without token must not touch the registry')
    const r2 = await call(ctx._route(), { op, args: { target: { scope: 'sessions', sessionIds: ['s1'] } } }, { 'x-dsh-token': 'secret' })
    assert.equal(r2.json.ok, true)
  }
})

// ---------- history-import（从其他 Agent 导入对话并创建可继续会话）----------
function fakeSessions(calls) {
  return {
    calls,
    create(id, options) {
      calls.push({ id, options })
      return { id: id === undefined ? 'session-9' : id }
    },
  }
}

const CLAUDE_JSONL = [
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]}}',
].join('\n')

test('history-import creates a seeded session from a Claude Code JSONL transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._sessions = fakeSessions(calls)
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'claude.jsonl', content: CLAUDE_JSONL, cwd: 'C:/proj' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.sessionId, 'session-9')
  assert.equal(r.json.count, 2)
  assert.equal(calls.length, 1)
  const create = calls[0]
  assert.equal(create.id, undefined, 'store mints the session id')
  assert.deepEqual(create.options.meta, { cwd: 'C:/proj', createdAt: create.options.meta.createdAt })
  assert.ok(Number.isSafeInteger(create.options.meta.createdAt))
  assert.equal(create.options.seed.length, 2)
  assert.equal(create.options.seed[0].type, 'user/message')
  assert.equal(create.options.seed[0].seq, 0)
  assert.equal(create.options.seed[0].surfaceOp, 'append')
  assert.equal(create.options.seed[0].data.role, 'user')
  assert.equal(create.options.seed[0].data.content[0].text, 'hello')
  assert.equal(create.options.seed[1].type, 'assistant/message')
  assert.equal(create.options.seed[1].seq, 1)
  assert.deepEqual(create.options.seed[1].data.message.source, { kind: 'model', provider: 'imported', model: 'imported' })
  assert.ok(Array.isArray(create.options.seed[1].data.stream))
  // 非法 cwd（相对路径）→ 忽略，不传给 meta
  const r2 = await call(ctx._route(), { op: 'history-import', args: { fileName: 'a.md', content: '## User\nx', cwd: 'relative/dir' } })
  assert.equal(r2.json.ok, true)
  assert.equal(calls[1].options.meta.cwd, undefined)
})

test('history-import parses markdown and generic text too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._sessions = fakeSessions(calls)
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  let r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'chat.md', content: '## User\nq1\n## Assistant\na1' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.count, 2)
  assert.equal(calls[0].options.seed[0].data.content[0].text, 'q1')
  r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'chat.txt', content: 'User: one\nAssistant: two' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.count, 2)
  assert.equal(calls[1].options.seed[1].data.message.content[0].text, 'two')
})

test('history-import rejects empty content, unparseable input and missing sessions service', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._sessions = fakeSessions([])
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  // 空内容
  let r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'a.jsonl', content: '' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /缺少文件内容/)
  // 无法识别的对话（JSONL 里全是 system/tool）
  r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'a.jsonl', content: '{"type":"system","message":{"role":"system","content":"x"}}' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /未能从该文件中识别出对话内容/)
  // 无 sessions 服务
  const ctx2 = makeCtx(mkdtempSync(join(tmpdir(), 'dsh-hist-')))
  ctx2._registry = fakeRegistry([], [])
  plugin.apply(ctx2, { sweepIntervalMs: 0 })
  r = await call(ctx2._route(), { op: 'history-import', args: { fileName: 'a.txt', content: 'User: hi' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /sessions\.create/)
})

test('history-import is token-gated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._sessions = fakeSessions(calls)
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { token: 'secret', sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-import', args: { fileName: 'a.jsonl', content: CLAUDE_JSONL } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  assert.equal(calls.length, 0)
  const r2 = await call(ctx._route(), { op: 'history-import', args: { fileName: 'a.jsonl', content: CLAUDE_JSONL } }, { 'x-dsh-token': 'secret' })
  assert.equal(r2.json.ok, true)
})

// ---------- history-export ----------

const EXPORT_EVENTS = [
  { type: 'user/message', seq: 0, data: { id: 'm0', role: 'user', content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/message', seq: 1, data: { message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '你好！' }] } } },
  { type: 'tool/message', seq: 2, data: { id: 'm2', content: [{ type: 'tool_result', content: 'x' }] } },
]

test('history-export writes markdown transcripts; cold sessions are skipped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-exp-'))
  const ctx = makeCtx(home)
  ctx._sessions = { get: (id) => (id === 's1' ? { snapshotEvents: () => EXPORT_EVENTS } : undefined) }
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s1', 's-cold'], format: 'markdown', outDir } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.exported.length, 1, 's1 导出成功')
  assert.equal(r.json.exported[0].sessionId, 's1')
  assert.equal(r.json.exported[0].count, 2, '工具消息不进入导出的轮次')
  assert.equal(r.json.skipped.length, 1)
  assert.equal(r.json.skipped[0].sessionId, 's-cold')
  assert.match(r.json.skipped[0].error, /不在活动存储/)
  const file = readFileSync(join(outDir, 's1.md'), 'utf8')
  assert.ok(file.includes('## User\n你好'), 'markdown 含 User 轮')
  assert.ok(file.includes('### Assistant\n你好！'), 'markdown 含 Assistant 轮')
  // 往返：导出的 markdown 可被本插件解析器重新解析成同样的轮次
  const turns = parseMarkdownTranscript(file)
  assert.deepEqual(turns.map((t) => t.text), ['你好', '你好！'])
})

test('history-export jsonl round-trips through the import parser', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-exp-'))
  const ctx = makeCtx(home)
  ctx._sessions = { get: () => ({ snapshotEvents: () => EXPORT_EVENTS }) }
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s1'], format: 'jsonl', outDir } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.exported[0].fileName, 's1.jsonl')
  const file = readFileSync(join(outDir, 's1.jsonl'), 'utf8')
  const turns = parseJsonlTranscript(file)
  assert.deepEqual(turns.map((t) => t.text), ['你好', '你好！'])
})

test('history-export validates args and is token-gated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._sessions = { get: () => ({ snapshotEvents: () => EXPORT_EVENTS }) }
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { token: 'secret', sweepIntervalMs: 0 })
  // 无 token → 拒绝
  let r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s1'], format: 'markdown', outDir: 'D:/x' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  const tok = { 'x-dsh-token': 'secret' }
  // 空会话列表
  r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: [], format: 'markdown', outDir: 'D:/x' } }, tok)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /至少选择/)
  // 非法格式
  r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s1'], format: 'pdf', outDir: 'D:/x' } }, tok)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /format/)
  // 相对路径
  r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s1'], format: 'markdown', outDir: 'relative/dir' } }, tok)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /绝对路径/)
  // 无 sessions 服务
  const ctx2 = makeCtx(mkdtempSync(join(tmpdir(), 'dsh-hist-')))
  ctx2._registry = fakeRegistry([], [])
  plugin.apply(ctx2, { token: 'secret', sweepIntervalMs: 0 })
  r = await call(ctx2._route(), { op: 'history-export', args: { sessionIds: ['s1'], format: 'markdown', outDir: 'D:/x' } }, tok)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /sessions\.get/)
})

test('history-sessions enumerates all stored sessions with archived flag', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const table = new Map([
    ['ws1', { path: 'C:/a', title: 'Alpha', sessionIds: ['s1', 's-live'] }],
  ])
  ctx._registry = fakeRegistry([], [
    { sessionId: 's1', createdAt: 1000, cwd: 'C:/a', title: 'Hello', archivedAt: 2000 },
  ], {
    table,
    workspaceIds: ['ws1'],
    headers: [
      { id: 's1', cwd: 'C:/a', createdAt: 1000 },
      { id: 's-live', cwd: 'C:/a', createdAt: 3000 },
      { id: 's-other', createdAt: 5000 },
    ],
  })
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-sessions', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.items.length, 3, '全部持久化会话都被枚举')
  const byId = Object.fromEntries(r.json.items.map((i) => [i.sessionId, i]))
  assert.equal(byId['s1'].archived, true, '归档会话带 archived=true')
  assert.equal(byId['s1'].workspaceId, 'ws1')
  assert.equal(byId['s-live'].archived, false, '未归档会话 archived=false')
  assert.equal(byId['s-live'].workspaceId, 'ws1')
  assert.equal(byId['s-other'].archived, false)
  assert.equal(byId['s-other'].workspaceId, undefined, '未归组会话无 workspaceId')
})

test('history-export reads cold sessions via sessionPersistence.prepare', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-exp-'))
  const ctx = makeCtx(home)
  ctx._sessions = { get: () => undefined } // 全部冷会话
  let disposed = 0
  ctx._persistence = {
    async prepare(id) {
      return { session: { snapshotEvents: () => EXPORT_EVENTS }, [Symbol.dispose]: () => { disposed++ } }
    },
  }
  ctx._registry = fakeRegistry([], [])
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-export', args: { sessionIds: ['s-cold'], format: 'markdown', outDir } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.exported.length, 1)
  assert.equal(r.json.exported[0].sessionId, 's-cold')
  assert.equal(disposed, 1, '恢复的只读句柄被 dispose')
  const file = readFileSync(join(outDir, 's-cold.md'), 'utf8')
  assert.ok(file.includes('## User\n你好'))
})

test('history-export-defaults returns an absolute default dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-export-defaults', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(typeof r.json.defaultDir, 'string')
  assert.ok(r.json.defaultDir.length > 0, 'default dir non-empty')
  assert.ok(/^([A-Za-z]:[\\/]|\\\\|\/)/.test(r.json.defaultDir), 'default dir is absolute')
})

test('dir-list validates path and lists directories', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  // 空目录 → 根视图（Windows 盘符列表或 /）
  let r = await call(ctx._route(), { op: 'dir-list', args: { dir: '' } })
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.entries), 'root returns an entries array')
  // 不存在的目录 → 错误
  r = await call(ctx._route(), { op: 'dir-list', args: { dir: join(home, 'no-such-dir-9f3a') } })
  assert.equal(r.json.ok, false)
  // 文件路径 → 不是目录
  const filePath = join(home, 'a-file.txt')
  writeFileSync(filePath, 'x')
  r = await call(ctx._route(), { op: 'dir-list', args: { dir: filePath } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /不是目录/)
  // 存在的目录 → 只列子目录（不含文件），parent 为上一级
  mkdirSync(join(home, 'sub'), { recursive: true })
  writeFileSync(join(home, 'sub', 'inner.txt'), 'x')
  writeFileSync(join(home, 'top.txt'), 'x')
  r = await call(ctx._route(), { op: 'dir-list', args: { dir: home } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.current, home)
  assert.equal(r.json.parent, dirname(home))
  const names = r.json.entries.map((e) => e.name)
  assert.ok(names.includes('sub'), 'sub dir listed')
  assert.ok(!names.includes('top.txt'), 'files not listed')
})

test('history-sessions filters out subagent-derived sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  ctx._registry = fakeRegistry([], [], {
    headers: [
      { id: 's-main', cwd: 'C:/a', createdAt: 1000 },
      { id: 's-sub', cwd: 'C:/a', createdAt: 2000, parentSession: 's-main', origin: 'subagent' },
    ],
  })
  plugin.apply(ctx, { sweepIntervalMs: 0 })
  const r = await call(ctx._route(), { op: 'history-sessions', args: {} })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.items.map((i) => i.sessionId), ['s-main'], '子代理会话被过滤')
})

test('history-archive-batch archives sessions; token-gated', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const ctx = makeCtx(home)
  const calls = []
  ctx._registry = fakeRegistry(calls, [])
  plugin.apply(ctx, { token: 'secret', sweepIntervalMs: 0 })
  // 无 token → 拒绝
  let r = await call(ctx._route(), { op: 'history-archive-batch', args: { sessionIds: ['s1', 's2'] } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  const tok = { 'x-dsh-token': 'secret' }
  // 空列表
  r = await call(ctx._route(), { op: 'history-archive-batch', args: { sessionIds: [] } }, tok)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /至少选择/)
  // 成功：逐个归档
  r = await call(ctx._route(), { op: 'history-archive-batch', args: { sessionIds: ['s1', 's2'] } }, tok)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.archived, ['s1', 's2'])
  assert.equal(r.json.failed.length, 0)
  assert.ok(calls.some((c) => c[0] === 'archiveSession' && c[1] === 's1'))
  assert.ok(calls.some((c) => c[0] === 'archiveSession' && c[1] === 's2'))
})
