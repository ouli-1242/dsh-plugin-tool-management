// tests/skills.test.mjs — 技能管理 ops 集成测试（新 op 协议：core 服务层）。
// 与旧版不同：core.js 直接使用 node:fs，因此测试用真实临时目录 + DSH_*_HOME
// 环境变量指向临时根，而非内存 fs。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'

const makeSkillMd = (name, description, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\nbody of ${name}\n`

function writeSkill(rootDir, name, description, extra = '') {
  mkdirSync(join(rootDir, name), { recursive: true })
  writeFileSync(join(rootDir, name, 'SKILL.md'), makeSkillMd(name, description, extra))
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'dsm-skm-'))
  const home = join(base, 'dsh-home')
  const roots = {
    dsh: join(home, 'skills'),
    agents: join(base, 'agents-home', 'skills'),
    codex: join(base, 'codex-home', 'skills'),
    claude: join(base, 'claude-home', 'skills'),
  }
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })
  writeSkill(roots.dsh, 'dsh-skill-a', 'DSH skill A')
  writeSkill(roots.dsh, 'dsh-skill-b', 'DSH skill B')
  writeSkill(roots.agents, 'agents-skill', 'Agents skill')
  writeSkill(roots.claude, 'claude-skill', 'Claude skill')
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(base, 'agents-home')
  process.env.DSH_CODEX_HOME = join(base, 'codex-home')
  process.env.DSH_CLAUDE_HOME = join(base, 'claude-home')
  return { base, home, roots }
}

function cleanup(env) {
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
  delete process.env.DSH_CODEX_HOME
  delete process.env.DSH_CLAUDE_HOME
  try { rmSync(env.base, { recursive: true, force: true }) } catch { /* best effort */ }
}

function makeCtx() {
  const providers = []
  const disposers = []
  const services = {
    skills: {
      registerProvider(create) {
        providers.push(create({ signal: { aborted: false, addEventListener() {} }, invalidate() {} }))
        return () => {}
      },
    },
    sessions: { list: () => [] },
    agents: { list: () => [] },
  }
  const ctx = {
    timer: {},
    timeout: () => Promise.resolve(),
    settings: { prepareDocument: async () => '' },
    sandboxPolicy: { resolve: async () => ({}) },
    tools: { register() {}, schemas: () => [] },
    webServer: {
      register(route) { ctx._route = route; return () => {} },
    },
    fs: {
      async resolve(p) { return p },
      async stat() { return undefined },
      async readText() { throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' }) },
      async writeText() {},
      async listDir() { return [] },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    on() { return () => {} },
    emit() {},
    get(name) { return services[name] },
    skills: services.skills,
    _providers: providers,
    _disposers: disposers,
    _route: null,
  }
  return ctx
}

function call(route, payload, headers = {}) {
  const body = JSON.stringify(payload)
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management', host: '127.0.0.1:3080', ...headers },
    on(ev, cb) { if (ev === 'data') cb(body); if (ev === 'end') cb() },
  }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b) { this.bodyText = b || '' } }
  return Promise.resolve(route.handler(req, res)).then(() => ({ status: res.status, json: res.bodyText ? JSON.parse(res.bodyText) : null }))
}

const statePath = (env) => join(env.home, 'dsh-plugin-tool-management', 'state.json')

test('skill-state lists skills across the four roots with summary', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-state', args: {} })
    assert.equal(r.json.ok, true)
    const data = r.json.data
    const keys = data.roots.map((x) => x.key)
    assert.ok(keys.includes('dsh') && keys.includes('agents') && keys.includes('claude'), 'user roots present: ' + keys.join(','))
    const dsh = data.roots.find((x) => x.key === 'dsh')
    assert.deepEqual(dsh.skills.map((s) => s.name).sort(), ['dsh-skill-a', 'dsh-skill-b'])
    const claude = data.roots.find((x) => x.key === 'claude')
    assert.equal(claude.skills[0].name, 'claude-skill')
    assert.ok(data.summary && typeof data.summary.total === 'number', 'summary present')
  } finally { cleanup(env) }
})

test('skill-disable records state, advertises a shadow candidate, and leaves the source file untouched', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-disable', args: { root: 'dsh', name: 'dsh-skill-a' } })
    assert.equal(r.json.ok, true)
    const state = JSON.parse(readFileSync(statePath(env), 'utf8'))
    assert.ok(state.disabledSkills.dsh.includes('dsh-skill-a'), 'disabled list persisted')
    const provider = ctx._providers[0]
    assert.ok(provider, 'manager provider registered')
    const candidate = (await provider.list({})).find((c) => c.name === 'dsh-skill-a')
    assert.ok(candidate, 'shadow candidate advertised')
    assert.equal(candidate.invocation.modelInvocable, false)
    assert.equal(candidate.provider, 'dsh-plugin-tool-management-external')
    assert.match(readFileSync(join(env.roots.dsh, 'dsh-skill-a', 'SKILL.md'), 'utf8'), /description: DSH skill A/, 'source untouched')
    // re-enable clears it
    const r2 = await call(ctx._route, { op: 'skill-enable', args: { root: 'dsh', name: 'dsh-skill-a' } })
    assert.equal(r2.json.ok, true)
    const after = (await provider.list({})).find((c) => c.name === 'dsh-skill-a')
    assert.equal(after.invocation.modelInvocable, true)
  } finally { cleanup(env) }
})

test('external roots (agents/claude) are provided by the manager with their source identity', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const provider = ctx._providers[0]
    const candidates = await provider.list({})
    const claude = candidates.find((c) => c.name === 'claude-skill')
    assert.ok(claude, 'claude skill provided')
    assert.equal(claude.source, 'agent-claude')
    assert.equal(claude.rank, 530)
    assert.equal(claude.invocation.modelInvocable, true)
    const def = await provider.get(claude, {})
    assert.match(def.content, /body of claude-skill/)
  } finally { cleanup(env) }
})

test('skill-detail returns body, frontmatter and diagnostics', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-detail', args: { root: 'dsh', name: 'dsh-skill-b' } })
    assert.equal(r.json.ok, true)
    assert.match(r.json.data.body, /body of dsh-skill-b/)
    assert.equal(r.json.data.frontmatter.name, 'dsh-skill-b')
    assert.ok(Array.isArray(r.json.data.diagnostics), 'diagnostics array')
  } finally { cleanup(env) }
})

test('skill-create writes a skill under DSH_HOME/skills', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-create', args: { root: 'dsh', name: 'created-skill', description: 'Made by test', body: 'do things' } })
    assert.equal(r.json.ok, true)
    const md = readFileSync(join(env.roots.dsh, 'created-skill', 'SKILL.md'), 'utf8')
    assert.match(md, /name: created-skill/)
    assert.match(md, /do things/)
  } finally { cleanup(env) }
})

test('skill-delete moves to trash and trash-restore brings it back', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const del = await call(ctx._route, { op: 'skill-delete', args: { root: 'dsh', name: 'dsh-skill-b' } })
    assert.equal(del.json.ok, true)
    assert.ok(!existsSync(join(env.roots.dsh, 'dsh-skill-b')), 'skill moved out of the root')
    const st = await call(ctx._route, { op: 'skill-state', args: {} })
    const trash = st.json.data.trash
    assert.equal(trash.length, 1, 'trash has one entry')
    const restore = await call(ctx._route, { op: 'skill-trash-restore', args: { id: trash[0].id } })
    assert.equal(restore.json.ok, true)
    assert.ok(existsSync(join(env.roots.dsh, 'dsh-skill-b', 'SKILL.md')), 'skill restored')
  } finally { cleanup(env) }
})

test('skill-source-disable turns a whole external source off', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-source-disable', args: { root: 'agents' } })
    assert.equal(r.json.ok, true)
    const provider = ctx._providers[0]
    const candidate = (await provider.list({})).find((c) => c.name === 'agents-skill')
    if (candidate) assert.equal(candidate.invocation.modelInvocable, false, 'source-off skill not invocable')
    const state = JSON.parse(readFileSync(statePath(env), 'utf8'))
    assert.equal(state.sources.agents, false)
  } finally { cleanup(env) }
})

test('skill-browse lists directories without following links', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-browse', args: { path: env.home } })
    assert.equal(r.json.ok, true)
    assert.ok(Array.isArray(r.json.data.entries), 'browse returns entries')
  } finally { cleanup(env) }
})

test('skill ops keep the CSRF gate', async () => {
  const env = setup()
  try {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const r = await call(ctx._route, { op: 'skill-state', args: {} }, { 'x-dsh-plugin': 'wrong' })
    assert.equal(r.status, 403)
  } finally { cleanup(env) }
})
