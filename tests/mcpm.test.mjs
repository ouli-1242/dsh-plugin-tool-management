// tests/mcpm.test.mjs — fake-ctx integration tests for the MCP server CRUD
// ops (add/list/set-enabled/restart/remove/edit/import/export) plus the YAML
// generation, the optional token gate, and the request-body cap.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'

// Fake Cordis ctx exposing exactly the surfaces the plugin touches. Same shape
// as skills.test.mjs, extended with `config` for the token gate and
// `tools.schemas` for the live tool-count in mcpm-list.
function makeCtx(home, files, config, toolsSchemas) {
  files = files || new Map()
  if (!files.has(join(home, 'settings.yaml'))) files.set(join(home, 'settings.yaml'), '')
  if (!files.has(join(home, 'profiles', 'web', 'cordis.patch.yml'))) files.set(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  if (!files.has(join(home, 'cordis.patch.yml'))) files.set(join(home, 'cordis.patch.yml'), '[]\n')
  let route = null
  const listeners = new Map()
  const guards = []
  const restrictions = []
  const ctx = {
    timer: {},
    timeout: () => Promise.resolve(),
    settings: { prepareDocument: async () => join(home, 'settings.yaml') },
    sandboxPolicy: { resolve: async () => ({}) },
    tools: {
      register() {},
      schemas: () => toolsSchemas || [],
      guard(g) { guards.push(g); return () => {} },
      restrict(f) { restrictions.push(f); return () => {} },
    },
    webServer: { register(r) { route = r; return () => {} } },
    fs: {
      async resolve(p) { return p },
      async stat(p) { return files.has(p) ? { isFile: () => true, isDirectory: () => false } : undefined },
      async readText(p) {
        if (!files.has(p)) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e }
        return files.get(p)
      },
      async writeText(p, c) { files.set(p, String(c)) },
      async listDir() { return [] },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') d() },
    on(ev, cb) { listeners.set(ev, cb) },
    events: { dispatch: () => [] },
    get() { return undefined },
    skills: {
      registerProvider() {},
      async snapshot() { return { skills: [], complete: true } },
      async get() { return undefined },
    },
    config,
    _files: files,
    _route: () => route,
    _guards: guards,
    _restrictions: restrictions,
  }
  return ctx
}

function call(route, payload, headers = {}, body = null) {
  const b = body === null ? JSON.stringify(payload) : body
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management', ...headers },
    on(ev, cb) { if (ev === 'data') cb(b); if (ev === 'end') cb() },
  }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b2) { this.bodyText = b2 || '' } }
  const p = route.handler(req, res)
  return (p ? Promise.resolve(p) : Promise.resolve()).then(() => ({ status: res.status, json: res.bodyText ? JSON.parse(res.bodyText) : null }))
}

const PROJECT_PATCH = (home) => join(home, 'profiles', 'web', 'cordis.patch.yml')

test('mcpm-add (stdio) writes a well-formed insert block; mcpm-list reads it back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  let r = await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'github', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-github', args: '--foo bar', env: 'TOKEN=abc', level: 'project' } })
  assert.equal(r.json.ok, true)
  const patch = ctx._files.get(PROJECT_PATCH(home))
  assert.match(patch, /# dsh-plugin-tool-management:server:mcp-github/)
  assert.match(patch, /- insert:/)
  assert.match(patch, /serverName: "github"/)
  assert.match(patch, /command: "npx -y @modelcontextprotocol\/server-github"/)
  assert.match(patch, /args:/)
  assert.match(patch, /env:/)
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.ok, true)
  let row = r.json.rows.find((x) => x.id === 'mcp-github')
  assert.equal(row.serverName, 'github')
  assert.equal(row.transport, 'stdio')
  assert.equal(row.level, 'project')
  // The UI view masks sensitive values; the plaintext view is its own op.
  assert.deepEqual(row.env, { TOKEN: '••••••' })
  r = await call(ctx._route(), { op: 'mcpm-reveal', args: {} })
  row = r.json.rows.find((x) => x.id === 'mcp-github')
  assert.deepEqual(row.args, ['--foo', 'bar'])
  assert.deepEqual(row.env, { TOKEN: 'abc' })
})

test('mcpm-add (streamable-http) with headers; YAML-injection-safe quoting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  // command-like string with YAML metacharacters in url/headers must stay quoted
  let r = await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'http1', transport: 'streamable-http', url: 'https://host/mcp', headers: 'Authorization=Bearer x: y\nX-Foo=*bar' } })
  assert.equal(r.json.ok, true)
  const patch = ctx._files.get(PROJECT_PATCH(home))
  assert.match(patch, /url: "https:\/\/host\/mcp"/)
  assert.match(patch, /"Authorization": "Bearer x: y"/)
  assert.match(patch, /"X-Foo": "\*bar"/)
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  let row = r.json.rows.find((x) => x.id === 'mcp-http1')
  assert.equal(row.transport, 'streamable-http')
  // Only sensitive-looking keys are masked; custom headers stay readable.
  assert.deepEqual(row.headers, { Authorization: '••••••', 'X-Foo': '*bar' })
  r = await call(ctx._route(), { op: 'mcpm-reveal', args: {} })
  row = r.json.rows.find((x) => x.id === 'mcp-http1')
  assert.deepEqual(row.headers, { Authorization: 'Bearer x: y', 'X-Foo': '*bar' })
})

test('mcpm-set-enabled disables then re-enables (writes/removes disable override)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })
  let r = await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-svc1', level: 'project', enabled: false } })
  assert.equal(r.json.ok, true)
  let patch = ctx._files.get(PROJECT_PATCH(home))
  assert.match(patch, /# dsh-plugin-tool-management:disable:mcp-svc1/)
  assert.match(patch, /disabled: true/)
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-svc1').disabled, true)
  r = await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-svc1', level: 'project', enabled: true } })
  assert.equal(r.json.ok, true)
  patch = ctx._files.get(PROJECT_PATCH(home))
  assert.ok(!/disable:mcp-svc1/.test(patch), 'disable override removed')
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-svc1').disabled, false)
})

test('mcpm-restart returns ok (no pluginInventory → fallback wait)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc2', transport: 'stdio', command: 'echo hi' } })
  const r = await call(ctx._route(), { op: 'mcpm-restart', args: { id: 'mcp-svc2', level: 'project' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.warning, undefined)
})

test('mcpm-remove deletes insert + all marker blocks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'gone', transport: 'stdio', command: 'echo hi' } })
  await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-gone', level: 'project', enabled: false } })
  const r = await call(ctx._route(), { op: 'mcpm-remove', args: { id: 'mcp-gone', level: 'project' } })
  assert.equal(r.json.ok, true)
  const patch = ctx._files.get(PROJECT_PATCH(home))
  assert.ok(!patch.includes('mcp-gone'), 'all traces removed')
  const after = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(after.json.rows.some((x) => x.id === 'mcp-gone'), false)
})

test('mcpm-edit same level rewrites the row; cross-level migration moves it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'ed1', transport: 'stdio', command: 'old cmd' } })
  let r = await call(ctx._route(), { op: 'mcpm-edit', args: { id: 'mcp-ed1', level: 'project', serverName: 'ed1', transport: 'stdio', command: 'new cmd' } })
  assert.equal(r.json.ok, true)
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-ed1').command, 'new cmd')

  // migrate project → global
  r = await call(ctx._route(), { op: 'mcpm-edit', args: { id: 'mcp-ed1', level: 'global', serverName: 'ed1', transport: 'stdio', command: 'new cmd' } })
  assert.equal(r.json.ok, true)
  const proj = ctx._files.get(PROJECT_PATCH(home))
  const glob = ctx._files.get(join(home, 'cordis.patch.yml'))
  assert.ok(!proj.includes('mcp-ed1'), 'removed from project patch')
  assert.ok(glob.includes('mcp-ed1'), 'now in global patch')
})

test('mcpm-import adds new rows and skips existing ids/names; import respects write lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'exist', transport: 'stdio', command: 'echo' } })
  const json = JSON.stringify([
    { serverName: 'new1', transport: 'stdio', command: 'echo a', level: 'project' },
    { serverName: 'exist', transport: 'stdio', command: 'echo b' },
    { serverName: 'bad url', transport: 'streamable-http', url: 'not-a-url' },
  ])
  const r = await call(ctx._route(), { op: 'mcpm-import', args: { json } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.added, ['mcp-new1'])
  assert.equal(r.json.skipped.length, 2)
  // 'exist' derives the same id as the added row (mcp-exist) → id clash first;
  // 'bad url' fails serverName validation.
  assert.ok(r.json.skipped.some((s) => s.reason === 'id 已存在'))
  assert.ok(r.json.skipped.some((s) => /serverName 非法|url 非法/.test(s.reason)))
})

test('mcpm-export returns JSON without loader-only rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'exp1', transport: 'stdio', command: 'echo' } })
  const r = await call(ctx._route(), { op: 'mcpm-export', args: {} })
  assert.equal(r.json.ok, true)
  const parsed = JSON.parse(r.json.json)
  assert.ok(Array.isArray(parsed.rows))
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].serverName, 'exp1')
})

test('token gate: write ops rejected without x-dsh-token, read ops stay open', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  // entry config arrives as the SECOND apply argument (Cordis callback(ctx, config))
  plugin.apply(ctx, { token: 'sekrit' })
  // write op → 401 without token, ok with correct token
  let r = await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'tok1', transport: 'stdio', command: 'echo' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  r = await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'tok1', transport: 'stdio', command: 'echo' } }, { 'x-dsh-token': 'sekrit' })
  assert.equal(r.json.ok, true)
  // wrong token → 401
  r = await call(ctx._route(), { op: 'mcpm-remove', args: { id: 'mcp-tok1', level: 'project' } }, { 'x-dsh-token': 'nope' })
  assert.equal(r.json.ok, false)
  // The plaintext view is token-gated like a write (LAN exposure must not
  // leak env/headers secrets without the token), even though it only reads.
  r = await call(ctx._route(), { op: 'mcpm-reveal', args: {} })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /令牌/)
  r = await call(ctx._route(), { op: 'mcpm-reveal', args: {} }, { 'x-dsh-token': 'sekrit' })
  assert.equal(r.json.ok, true)
  // read ops still work without token
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.ok, true)
  r = await call(ctx._route(), { op: 'plugin-version', args: {} })
  assert.equal(r.json.ok, true)
})

test('request body cap rejects oversized payloads', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  // config.maxBodyBytes lets the test exercise the cap without an 88 MiB payload
  plugin.apply(ctx, { maxBodyBytes: 1024 * 1024 })
  const big = 'x'.repeat(2 * 1024 * 1024)
  const r = await call(ctx._route(), { op: 'mcpm-import', args: { json: big } }, {}, JSON.stringify({ op: 'mcpm-import', args: { json: big } }))
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /请求体过大/)
})

// --- mcpm-tools: MCP service tool preview ---
function makeToolsCtx(home, schemas) {
  const ctx = makeCtx(home)
  ctx.tools = { register() {}, schemas: () => schemas }
  return ctx
}

test('mcpm-tools lists tools for a server with name/description/parameter summary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const schemas = [
    { name: 'mcp__github__get_repo', description: 'Fetch a repository by name.', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, limit: { type: 'integer', description: 'max results' } }, required: ['repo'] } },
    { name: 'mcp__github__list_issues', description: 'List issues for a repo.', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' } }, required: ['repo'] } },
    { name: 'mcp__tavily__search', description: 'Web search.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'the query' } }, required: ['query'] } },
    { name: 'some_other_tool', description: 'Not MCP-prefixed, ignored.' },
  ]
  const ctx = makeToolsCtx(home, schemas)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'github' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.tools.length, 2)
  const getRepo = r.json.tools.find((t) => t.name === 'get_repo')
  assert.ok(getRepo, 'prefix stripped in display name')
  assert.equal(getRepo.description, 'Fetch a repository by name.')
  // parameter summary: key, required flag, type, description
  const repoParam = getRepo.parameters.find((p) => p.key === 'repo')
  assert.ok(repoParam)
  assert.equal(repoParam.required, true)
  assert.equal(repoParam.type, 'string')
  assert.equal(repoParam.description, 'owner/name')
  const limitParam = getRepo.parameters.find((p) => p.key === 'limit')
  assert.equal(limitParam.required, false)
  assert.equal(limitParam.type, 'integer')
})

test('mcpm-tools returns empty array for unknown server or no tools', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeToolsCtx(home, [{ name: 'mcp__tavily__search', description: 'x', parameters: { type: 'object', properties: {} } }])
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'nope' } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.tools, [])
})

test('mcpm-tools returns ok:false when schemas() throws', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  ctx.tools = { register() {}, schemas: () => { throw new Error('registry exploded') } }
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'github' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /registry exploded/)
})

test('mcpm-tools rejects empty serverName', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeToolsCtx(home, [])
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: '' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /serverName/)
})

// --- coexistence with the template upstream (@xxxyz/dsh-mcp-manager) ---
// Both managers edit the same cordis.patch.yml; entries written by either one
// must be readable, editable, and cleanly removable by the other. The template
// writes `# dsh-mcp-manager:...` marker comments — this plugin matches both
// marker spellings.

const LEGACY_PATCH = [
  '# dsh-mcp-manager:server:mcp-legacy',
  '- insert:',
  '    - id: mcp-legacy',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: legacy',
  '        transport: "streamable-http"',
  '        url: "https://example.test/mcp"',
  '# dsh-mcp-manager:disable:mcp-legacy',
  '- id: mcp-legacy',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  disabled: true',
  '',
].join('\n')

test('reads entries written by the template plugin (# dsh-mcp-manager markers)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const files = new Map()
  files.set(join(home, 'profiles', 'web', 'cordis.patch.yml'), LEGACY_PATCH)
  const ctx = makeCtx(home, files)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.ok, true)
  const row = r.json.rows.find((x) => x.id === 'mcp-legacy')
  assert.ok(row, 'template-plugin entry listed')
  assert.equal(row.serverName, 'legacy')
  assert.equal(row.managed, true, 'template marker recognized as managed')
  assert.equal(row.disabled, true, 'template disable override respected')
})

test('mcpm-remove cleans template-plugin blocks and marker comments', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const files = new Map()
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  files.set(patch, LEGACY_PATCH)
  const ctx = makeCtx(home, files)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-remove', args: { id: 'mcp-legacy', level: 'project' } })
  assert.equal(r.json.ok, true)
  const left = ctx._files.get(patch)
  assert.ok(!left.includes('mcp-legacy'), 'all legacy rows removed')
  assert.ok(!left.includes('dsh-mcp-manager'), 'no orphan template marker comments')
})

test('mcpm-set-enabled re-enables an entry disabled by the template plugin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const files = new Map()
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  files.set(patch, LEGACY_PATCH)
  const ctx = makeCtx(home, files)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-legacy', level: 'project', enabled: true } })
  assert.equal(r.json.ok, true)
  const left = ctx._files.get(patch)
  assert.ok(!/disabled:\s*true/.test(left), 'template disable block removed')
  const list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  const row = list.json.rows.find((x) => x.id === 'mcp-legacy')
  assert.equal(row.disabled, false, 'entry effective state is enabled')
})

test('mcpm-note keeps a user note across config rewrites; mcpm-settings clamps and persists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })

  let r = await call(ctx._route(), { op: 'mcpm-note', args: { id: 'mcp-svc1', note: 'A 挂了用 B' } })
  assert.equal(r.json.ok, true)
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-svc1').notes, 'A 挂了用 B')

  // The note lives in its own file, so rewriting the patch never touches it.
  await call(ctx._route(), { op: 'mcpm-edit', args: { id: 'mcp-svc1', serverName: 'svc1', transport: 'stdio', command: 'echo bye' } })
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-svc1').notes, 'A 挂了用 B')

  await call(ctx._route(), { op: 'mcpm-note', args: { id: 'mcp-svc1', note: '' } })
  r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.rows.find((x) => x.id === 'mcp-svc1').notes, '')

  r = await call(ctx._route(), { op: 'mcpm-settings', args: {} })
  assert.deepEqual(r.json.settings, { pollIntervalMs: 5000, toolDescriptionMaxLength: 0 })
  r = await call(ctx._route(), { op: 'mcpm-settings', args: { set: true, pollIntervalMs: 100, toolDescriptionMaxLength: 99999 } })
  assert.deepEqual(r.json.settings, { pollIntervalMs: 2000, toolDescriptionMaxLength: 2000 }, 'settings are clamped to sane ranges')
  r = await call(ctx._route(), { op: 'mcpm-settings', args: {} })
  assert.deepEqual(r.json.settings, { pollIntervalMs: 2000, toolDescriptionMaxLength: 2000 }, 'settings persist for the next read')
})

test('mcpm-list flags duplicate loader ids from a hand-edited patch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  const block = [
    '# dsh-plugin-tool-management:server:mcp-dup',
    '- insert:',
    '    - id: mcp-dup',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: "dup"',
    '        transport: "stdio"',
    '        command: "echo dup"',
    '',
  ].join('\n')
  ctx._files.set(PROJECT_PATCH(home), block + block)
  plugin.apply(ctx)
  const r = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.rows.filter((row) => row.id === 'mcp-dup').length, 2, 'both rows are listed')
  assert.ok(r.json.rows.every((row) => row.duplicate === true), 'duplicated rows are flagged')
  assert.ok(String(r.json.warnings[0]).includes('mcp-dup'), 'the warning names the duplicated id')
})

test('mcpm writes keep a timestamped backup of the previous patch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })
  await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-svc1', level: 'project', enabled: false } })
  const backups = readdirSync(dir).filter((name) => name.startsWith('cordis.patch.yml.bak-')).sort()
  assert.ok(backups.length >= 1, 'a timestamped backup exists after a rewrite')
  const recovered = readFileSync(join(dir, backups[backups.length - 1]), 'utf8')
  assert.match(recovered, /mcp-svc1/, 'the backup holds the content from before the last write')
  assert.ok(!/disable:mcp-svc1/.test(recovered), 'the backup predates the disable override')
})

test('host registers the /mcp, /skills and /agents-md chat commands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-cmd-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  const commands = {}
  ctx.get = (name) => (name === 'commands' ? { register(def) { commands[def.name] = def; return () => {} } } : undefined)
  plugin.apply(ctx, { presetsDir })
  assert.ok(commands.mcp, '/mcp is registered')
  assert.ok(commands.skills, '/skills is registered')
  assert.ok(commands['agents-md'], '/agents-md is registered')

  const added = await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })
  assert.equal(added.json.ok, true)
  const mcpText = await commands.mcp.handler()
  assert.equal(mcpText.kind, 'success')
  assert.match(mcpText.text, /svc1/)
  assert.match(mcpText.text, /Profile 级/)
  const skillsText = await commands.skills.handler()
  assert.equal(skillsText.kind, 'success')
  assert.ok(typeof skillsText.text === 'string' && skillsText.text.length > 0)

  const created = await call(ctx._route(), { op: 'agentsmd-create', args: { id: 'work' } })
  assert.equal(created.json.ok, true)
  const amdText = await commands['agents-md'].handler()
  assert.equal(amdText.kind, 'success')
  assert.match(amdText.text, /work/)
})

test('skill-open validates the path instead of launching anything unexpected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)

  let r = await call(ctx._route(), { op: 'skill-open', args: {} })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /path/)

  r = await call(ctx._route(), { op: 'skill-open', args: { path: 'relative/SKILL.md' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /绝对路径/)

  r = await call(ctx._route(), { op: 'skill-open', args: { path: 'C:\\tmp\\launcher.exe' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /Markdown/)

  r = await call(ctx._route(), { op: 'skill-open', args: { path: 'C:\\tmp\\missing.md' } })
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /不存在/)
})

test('per-tool disable persists, feeds mcpm-tools, the guard and the visibility filter', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const schemas = [{ name: 'mcp__svc1__alpha' }, { name: 'mcp__svc1__beta' }, { name: 'unrelated_tool' }]
  const ctx = makeCtx(home, null, undefined, schemas)
  plugin.apply(ctx)
  assert.equal(ctx._guards.length, 1, 'a global execution guard is registered')
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })

  let r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'svc1' } })
  assert.deepEqual(r.json.tools.map((tool) => tool.enabled), [true, true], 'every tool starts enabled')

  r = await call(ctx._route(), { op: 'mcpm-tool-enabled', args: { serverName: 'svc1', tool: 'alpha', enabled: false } })
  assert.equal(r.json.ok, true)

  // 执行边界：守卫拒绝被禁用的工具，其他工具不受影响
  const guard = ctx._guards[0]
  assert.match(guard({ name: 'mcp__svc1__alpha' }), /停用/)
  assert.equal(guard({ name: 'mcp__svc1__beta' }), undefined)
  assert.equal(guard({ name: 'unrelated_tool' }), undefined)

  // 可见性边界：只把被禁用的工具移出模型视图
  const lastRestriction = ctx._restrictions[ctx._restrictions.length - 1]
  assert.deepEqual(lastRestriction.deny, ['mcp__svc1__alpha'])

  r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'svc1' } })
  assert.deepEqual(r.json.tools.map((tool) => [tool.name, tool.enabled]), [['alpha', false], ['beta', true]])

  r = await call(ctx._route(), { op: 'mcpm-tool-enabled', args: { serverName: 'svc1', tool: 'alpha', enabled: true } })
  assert.equal(r.json.ok, true)
  assert.equal(guard({ name: 'mcp__svc1__alpha' }), undefined, 're-enabling lifts the denial')
})

test('mcpm-edit migrates per-tool disable state when the serverName changes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'old', transport: 'stdio', command: 'echo hi' } })
  await call(ctx._route(), { op: 'mcpm-tool-enabled', args: { serverName: 'old', tool: 'alpha', enabled: false } })
  const r = await call(ctx._route(), { op: 'mcpm-edit', args: { id: 'mcp-old', serverName: 'new', transport: 'stdio', command: 'echo hi' } })
  assert.equal(r.json.ok, true)
  const list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-old').serverName, 'new')
  const raw = JSON.parse(readFileSync(join(home, 'dsh-plugin-tool-management-disabled-tools.json'), 'utf8'))
  assert.deepEqual(raw.new, ['alpha'], 'the disabled list follows the rename')
  assert.equal(raw.old, undefined, 'the old namespace key is removed')
})

// --- regression tests for the adversarial-review fixes ---

test('mcpm-restart must not re-enable a server the user disabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc3', transport: 'stdio', command: 'echo hi' } })
  await call(ctx._route(), { op: 'mcpm-set-enabled', args: { id: 'mcp-svc3', level: 'project', enabled: false } })
  const r = await call(ctx._route(), { op: 'mcpm-restart', args: { id: 'mcp-svc3', level: 'project' } })
  assert.equal(r.json.ok, true)
  const list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-svc3').disabled, true, 'restart preserves the disabled state')
  const patch = ctx._files.get(PROJECT_PATCH(home))
  assert.match(patch, /# dsh-plugin-tool-management:disable:mcp-svc3/, 'the disable override is restored')
})

test('request body decodes multi-byte UTF-8 that straddles chunk boundaries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc1', transport: 'stdio', command: 'echo hi' } })
  const body = Buffer.from(JSON.stringify({ op: 'mcpm-note', args: { id: 'mcp-svc1', note: '中'.repeat(200) } }), 'utf8')
  // Split inside the 3-byte UTF-8 sequence of a Chinese character.
  const zh = Buffer.from('中', 'utf8')
  const mid = body.indexOf(zh) + 1
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management' },
    on(ev, cb) {
      if (ev === 'data') { cb(body.slice(0, mid)); cb(body.slice(mid)) }
      if (ev === 'end') cb()
    },
  }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b2) { this.bodyText = b2 || '' } }
  await ctx._route().handler(req, res)
  const parsed = JSON.parse(res.bodyText)
  assert.equal(parsed.ok, true)
  const list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-svc1').notes, '中'.repeat(200), 'no U+FFFD corruption across the chunk boundary')
})

test('mcpm-import conflict=overwrite replaces an existing id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'exist', transport: 'stdio', command: 'echo old' } })
  const json = JSON.stringify([{ serverName: 'exist', transport: 'stdio', command: 'echo new' }])
  let r = await call(ctx._route(), { op: 'mcpm-import', args: { json, conflict: 'overwrite' } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.added, ['mcp-exist'])
  assert.deepEqual(r.json.overwritten, ['mcp-exist'])
  let list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-exist').command, 'echo new')
  // serverName stays globally unique even in overwrite mode: a different id
  // owning the name is still skipped.
  const json2 = JSON.stringify([{ id: 'mcp-other', serverName: 'exist', transport: 'stdio', command: 'echo x' }])
  r = await call(ctx._route(), { op: 'mcpm-import', args: { json: json2, conflict: 'overwrite' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.added.length, 0)
  assert.ok(r.json.skipped.some((s) => s.reason === 'serverName 已存在'))
  list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.filter((x) => x.serverName === 'exist').length, 1, 'no duplicate server rows')
})

test('mcpm-set-all toggles every patch row (both levels, or one level)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const ctx = makeCtx(home)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'sva', transport: 'stdio', command: 'echo' } })
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svb', transport: 'stdio', command: 'echo' } })
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc', transport: 'stdio', command: 'echo', level: 'global' } })
  let r = await call(ctx._route(), { op: 'mcpm-set-all', args: { enabled: false } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.changed.length, 3)
  let list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.ok(list.json.rows.every((x) => x.disabled === true), 'all rows disabled')
  // One level only: project re-enables, global stays disabled.
  r = await call(ctx._route(), { op: 'mcpm-set-all', args: { enabled: true, level: 'project' } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.changed.sort(), ['mcp-sva', 'mcp-svb'])
  list = await call(ctx._route(), { op: 'mcpm-list', args: {} })
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-sva').disabled, false)
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-svb').disabled, false)
  assert.equal(list.json.rows.find((x) => x.id === 'mcp-svc').disabled, true, 'global row untouched by the project-level bulk op')
})

test('mcpm-tools keeps disabled tools listed when schemas() drops restricted tools', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const schemas = [{ name: 'mcp__svc9__alpha' }]
  const ctx = makeCtx(home, null, undefined, schemas)
  plugin.apply(ctx)
  await call(ctx._route(), { op: 'mcpm-add', args: { serverName: 'svc9', transport: 'stdio', command: 'echo hi' } })
  await call(ctx._route(), { op: 'mcpm-tool-enabled', args: { serverName: 'svc9', tool: 'alpha', enabled: false } })
  // Simulate a registry that strips restricted tools from schemas().
  schemas.length = 0
  const r = await call(ctx._route(), { op: 'mcpm-tools', args: { serverName: 'svc9' } })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.tools, [{ name: 'alpha', description: '（已停用；描述暂不可用）', enabled: false, parameters: [] }], 'the disabled tool stays re-enableable from the UI')
})

// --- custom skill roots (user-added read-only source directories) ---

test('custom skill roots: add → discover in skill-state → source toggle → remove', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home // skills core reads DSH_HOME for state + roots
  try {
    const { mkdirSync: mk, writeFileSync } = await import('node:fs')
    const dir = join(home, 'extra-skills')
    mk(join(dir, 'my-skill'), { recursive: true })
    writeFileSync(join(dir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: 测试自定义目录技能\n---\n正文\n', 'utf8')
    const ctx = makeCtx(home)
    plugin.apply(ctx)

    // reject relative paths
    let r = await call(ctx._route(), { op: 'skill-custom-add', args: { path: 'relative/dir' } })
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /绝对路径/)

    r = await call(ctx._route(), { op: 'skill-custom-add', args: { path: dir, label: '我的目录' } })
    assert.equal(r.json.ok, true)
    const key = r.json.data.key
    assert.match(key, /^custom-[a-f0-9]{16}$/)
    assert.equal(r.json.data.path, dir)

    // discovered as a user root with the skill inside
    let state = await call(ctx._route(), { op: 'skill-state', args: {} })
    assert.equal(state.json.ok, true)
    const root = state.json.data.roots.find((x) => x.key === key)
    assert.ok(root, 'custom root listed in skill-state')
    assert.equal(root.label, '我的目录')
    assert.equal(root.mutable, false)
    assert.ok(root.skills.some((s) => s.name === 'my-skill'), 'the skill inside is discovered')

    // source-level toggle disables the whole directory
    r = await call(ctx._route(), { op: 'skill-source-disable', args: { root: key } })
    assert.equal(r.json.ok, true)
    state = await call(ctx._route(), { op: 'skill-state', args: {} })
    const disabledRoot = state.json.data.roots.find((x) => x.key === key)
    assert.equal(disabledRoot.enabled, false)
    assert.equal(disabledRoot.skills.find((s) => s.name === 'my-skill').enabled, false)

    // remove cleans the root and its policy keys
    r = await call(ctx._route(), { op: 'skill-custom-remove', args: { key } })
    assert.equal(r.json.ok, true)
    state = await call(ctx._route(), { op: 'skill-state', args: {} })
    assert.equal(state.json.data.roots.some((x) => x.key === key), false, 'custom root gone after removal')
    const stateFile = JSON.parse(readFileSync(join(home, 'tool-management', 'state.json'), 'utf8'))
    assert.equal(stateFile.customRoots.length, 0)
    assert.equal(stateFile.sources[key], undefined)
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
  }
})
