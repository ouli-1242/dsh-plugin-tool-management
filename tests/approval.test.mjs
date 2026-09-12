// tests/approval.test.mjs — programmatic approval gate for rule_manager_write
// (D2). The gate is registered via ctx.on('tools/pre-execute') and must return
// `ask` while requireConfirmForModelRuleWrite is on, fall through to next() when
// the setting is off, and never touch other tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'

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

function call(route, payload) {
  const b = JSON.stringify(payload)
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management' },
    on(ev, cb) { if (ev === 'data') cb(b); if (ev === 'end') cb() },
  }
  const res = { status: 200, bodyText: '', writeHead(c) { this.status = c }, end(b2) { this.bodyText = b2 || '' } }
  const p = route.handler(req, res)
  return (p ? Promise.resolve(p) : Promise.resolve()).then(() => ({ status: res.status, json: res.bodyText ? JSON.parse(res.bodyText) : null }))
}

test('approval: rule_manager_write asks by default; falls through when disabled; ignores other tools', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-'))
  const ctx = makeCtx(home)
  try {
    plugin.apply(ctx, { rulesRoot: join(home, 'rules'), rulesStateDir: join(home, 'tool-management') })
    const handler = ctx._listeners.get('tools/pre-execute')
    assert.ok(handler, 'tools/pre-execute hook is registered')

    // ① 默认 requireConfirmForModelRuleWrite:true → ask（fail-closed 安全默认）
    const asked = await handler({ name: 'rule_manager_write' }, () => 'ALLOWED')
    assert.deepEqual(asked, { kind: 'ask', reason: 'Write a rule under ~/.dsh/rules' })

    // ③ 非该工具名时直接放行，不影响其他工具
    const allowed = await handler({ name: 'mcpm-add' }, () => 'ALLOWED')
    assert.equal(allowed, 'ALLOWED')
    const skillCreate = await handler({ name: 'skill_manager_create' }, () => 'ALLOWED')
    assert.deepEqual(skillCreate, { kind: 'ask', reason: 'Create a new skill under DSH_HOME/skills' })

    // ② 关闭确认 → 放行（next()）
    const r = await call(ctx._route(), { op: 'mcpm-settings', args: { set: true, requireConfirmForModelRuleWrite: false } })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.settings.requireConfirmForModelRuleWrite, false)
    const passed = await handler({ name: 'rule_manager_write' }, () => 'ALLOWED')
    assert.equal(passed, 'ALLOWED')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
