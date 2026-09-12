// tests/presets.test.mjs — end-to-end tests for the Scenes ops over the real
// HTTP route: preset roster (system + user), copy-create isolation, delete
// restrictions, scenes.json binding, set-default sidecar, and id validation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'

// Fake Cordis ctx (same shape as rules.test.mjs).
function makeCtx(home) {
  let route = null
  const listeners = new Map()
  const ctx = {
    timer: {},
    timeout: () => Promise.resolve(),
    settings: { prepareDocument: async () => join(home, 'settings.yaml') },
    sandboxPolicy: { resolve: async () => ({}) },
    tools: { register() {}, schemas: () => [], guard() { return () => {} }, restrict() { return () => {} } },
    webServer: { register(r) { route = r; return () => {} } },
    fs: {
      async resolve(p) { return p },
      async stat(p) { return undefined },
      async readText(p) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e },
      async writeText() {},
      async listDir() { return [] },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') d() },
    on(ev, cb) { listeners.set(ev, cb) },
    events: { dispatch: () => [] },
    get() { return undefined },
    skills: { registerProvider() {}, async snapshot() { return { skills: [], complete: true } }, async get() { return undefined } },
    _route: () => route,
    _listeners: listeners,
  }
  return ctx
}

function call(route, payload, headers = {}) {
  const b = JSON.stringify(payload)
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management', ...headers },
    on(ev, cb) { if (ev === 'data') cb(b); if (ev === 'end') cb() },
  }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b2) { this.bodyText = b2 || '' } }
  const p = route.handler(req, res)
  return (p ? Promise.resolve(p) : Promise.resolve()).then(() => ({ status: res.status, json: res.bodyText ? JSON.parse(res.bodyText) : null }))
}

const temp = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scenes-e2e-'))
  return {
    home,
    presetsRoot: join(home, '.agent-presets'),
    rulesRoot: join(home, 'rules'),
    stateDir: join(home, 'tool-management'),
    settingsSidecar: join(home, 'dsh-plugin-tool-management-settings.json'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

const apply = (t, extra) => {
  const ctx = makeCtx(t.home)
  plugin.apply(ctx, Object.assign({ presetsRoot: t.presetsRoot, rulesRoot: t.rulesRoot, rulesStateDir: t.stateDir }, extra || {}))
  return ctx
}

test('scenes: roster lists the system preset; scene-list binds empty groups', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    const r = await call(ctx._route(), { op: 'scene-list', args: {} })
    assert.equal(r.json.ok, true)
    const standard = r.json.presets.find((p) => p.id === 'standard')
    assert.ok(standard, 'system preset standard listed')
    assert.equal(standard.trust, 'system')
    assert.equal(standard.healthy, true)
    const scene = r.json.scenes.find((s) => s.presetId === 'standard')
    assert.ok(scene, 'scene row for standard')
    assert.deepEqual(scene.groups, [])
    assert.equal(scene.isDefault, false)
  } finally { t.cleanup() }
})

test('scenes: create copies a user preset wholesale and keeps isolation', async () => {
  const t = temp()
  try {
    // 手工建一个 user preset（含附件目录）。
    const srcDir = join(t.presetsRoot, 'office-base')
    mkdirSync(join(srcDir, 'templates'), { recursive: true })
    writeFileSync(join(srcDir, 'agent.cordis.yml'), 'name: office-base\n', 'utf8')
    writeFileSync(join(srcDir, 'templates', 'report.md'), 'report body', 'utf8')

    const ctx = apply(t)
    let r = await call(ctx._route(), { op: 'scene-create', args: { from: 'office-base', id: 'office-copy', name: '办公副本' } })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.preset.id, 'office-copy')
    // 整目录复制：内容一致。
    const copyYaml = readFileSync(join(t.presetsRoot, 'office-copy', 'agent.cordis.yml'), 'utf8')
    assert.match(copyYaml, /name: office-base/)
    assert.equal(readFileSync(join(t.presetsRoot, 'office-copy', 'templates', 'report.md'), 'utf8'), 'report body')
    // 就地修改副本不影响原目录。
    writeFileSync(join(t.presetsRoot, 'office-copy', 'agent.cordis.yml'), 'name: office-copy\n', 'utf8')
    assert.match(readFileSync(join(t.presetsRoot, 'office-base', 'agent.cordis.yml'), 'utf8'), /name: office-base/)
    // scenes.json 出现绑定记录。
    const scenes = JSON.parse(readFileSync(join(t.stateDir, 'scenes.json'), 'utf8'))
    assert.ok(scenes.presets['office-copy'], 'binding recorded in scenes.json')
    // 复制后 scene-list 能看到 user preset。
    r = await call(ctx._route(), { op: 'scene-list', args: {} })
    const copied = r.json.presets.find((p) => p.id === 'office-copy')
    assert.ok(copied)
    assert.equal(copied.trust, 'user')
  } finally { t.cleanup() }
})

test('scenes: system preset is read-only; remove refuses with error.scenes.systemPreset', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    let r = await call(ctx._route(), { op: 'scene-remove', args: { id: 'standard' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.scenes.systemPreset')
    // 不存在 id → notFound。
    r = await call(ctx._route(), { op: 'scene-remove', args: { id: 'nope' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.rules.notFound')
  } finally { t.cleanup() }
})

test('scenes: set-groups writes scenes.json and is idempotent', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    // 先建规则分组，再绑定。
    let r = await call(ctx._route(), { op: 'rules-create', args: { group: 'office', name: 'doc', description: 'd', body: 'b' } })
    assert.equal(r.json.ok, true)
    r = await call(ctx._route(), { op: 'scene-set-groups', args: { presetId: 'standard', groups: ['office'] } })
    assert.equal(r.json.ok, true)
    assert.deepEqual(r.json.scene.groups, ['office'])
    const scenes = JSON.parse(readFileSync(join(t.stateDir, 'scenes.json'), 'utf8'))
    assert.deepEqual(scenes.presets.standard.groups, ['office'])
    // 幂等：重复写同一集合。
    r = await call(ctx._route(), { op: 'scene-set-groups', args: { presetId: 'standard', groups: ['office'] } })
    assert.equal(r.json.ok, true)
    assert.deepEqual(r.json.scene.groups, ['office'])
    // 非法分组名 → 拒绝。
    r = await call(ctx._route(), { op: 'scene-set-groups', args: { presetId: 'standard', groups: ['Bad Group'] } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.rules.invalidGroup')
  } finally { t.cleanup() }
})

test('scenes: broken preset is listed unhealthy without crashing', async () => {
  const t = temp()
  try {
    mkdirSync(join(t.presetsRoot, 'broken'), { recursive: true }) // 目录存在但缺 agent.cordis.yml
    const ctx = apply(t)
    const r = await call(ctx._route(), { op: 'scene-list', args: {} })
    assert.equal(r.json.ok, true)
    const broken = r.json.presets.find((p) => p.id === 'broken')
    assert.ok(broken, 'broken preset still listed')
    assert.equal(broken.healthy, false)
    assert.match(broken.reason || '', /agent\.cordis\.yml/)
  } finally { t.cleanup() }
})

test('scenes: set-default records into the plugin settings sidecar', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    let r = await call(ctx._route(), { op: 'scene-create', args: { from: 'standard', id: 'daily', name: '日常' } })
    assert.equal(r.json.ok, true)
    r = await call(ctx._route(), { op: 'scene-set-default', args: { id: 'daily' } })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.default, 'daily')
    const settings = JSON.parse(readFileSync(t.settingsSidecar, 'utf8'))
    assert.equal(settings.defaultAgentPreset, 'daily')
    r = await call(ctx._route(), { op: 'scene-list', args: {} })
    const row = r.json.scenes.find((s) => s.presetId === 'daily')
    assert.equal(row.isDefault, true)
  } finally { t.cleanup() }
})

test('scenes: create validates id and rejects duplicates', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    let r = await call(ctx._route(), { op: 'scene-create', args: { from: 'standard', id: 'Bad ID', name: 'x' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.rules.invalidName')
    r = await call(ctx._route(), { op: 'scene-create', args: { from: 'standard', id: 'daily', name: 'x' } })
    assert.equal(r.json.ok, true)
    r = await call(ctx._route(), { op: 'scene-create', args: { from: 'standard', id: 'daily', name: 'x' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.scenes.duplicate')
    // 来源不存在 → notFound。
    r = await call(ctx._route(), { op: 'scene-create', args: { from: 'ghost', id: 'daily2', name: 'x' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'error.rules.notFound')
  } finally { t.cleanup() }
})

test('scenes: remove deletes the user preset directory and its binding', async () => {
  const t = temp()
  try {
    const ctx = apply(t)
    let r = await call(ctx._route(), { op: 'scene-create', args: { from: 'standard', id: 'temp1', name: 'x' } })
    assert.equal(r.json.ok, true)
    assert.ok(existsSync(join(t.presetsRoot, 'temp1')))
    r = await call(ctx._route(), { op: 'scene-remove', args: { id: 'temp1' } })
    assert.equal(r.json.ok, true)
    assert.ok(!existsSync(join(t.presetsRoot, 'temp1')), 'preset dir removed')
    const scenes = JSON.parse(readFileSync(join(t.stateDir, 'scenes.json'), 'utf8'))
    assert.ok(!scenes.presets.temp1, 'binding removed')
    assert.equal(readdirSync(t.presetsRoot).length, 0, 'no leftover entries')
  } finally { t.cleanup() }
})
