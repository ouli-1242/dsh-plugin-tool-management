// tests/agentsmd.test.mjs — AGENTS.md 预设库 + 切换 的 op 行为测试。
// 风格与 mcpm.test.mjs 一致：fake-ctx（内存 fs Map）+ plugin.apply(ctx) 拿 route
// + call(route,{op,args})。预设库目录用真实临时目录（mkdtempSync），由 config
// 注入 presetsDir，service 用 node:fs 直接操作它（与 skills 域同款真实-fs 风格）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import plugin from '../lib/index.js'

// 与 mcpm.test.mjs 同形的 fake ctx；config 透传（用于注入 presetsDir / token）。
function makeCtx(home, files, config, toolsSchemas) {
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
    tools: { register() {}, schemas: () => toolsSchemas || [], guard() { return () => {} }, restrict() { return () => {} } },
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
    get() { return undefined },
    skills: { registerProvider() {}, async snapshot() { return { skills: [], complete: true } }, async get() { return undefined } },
    config,
    _files: files,
    _route: () => route,
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

test('agentsmd-list: 空预设库且无全局 AGENTS.md → 返回空 presets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const r = await call(ctx._route(), { op: 'agentsmd-list', args: {} })
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.presets, [])
})

test('agentsmd-list: 库内有 default/strict 两个预设 → 返回两个 id，无 active（全局文件不存在）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  mkdirSync(join(presetsDir, 'default'), { recursive: true })
  writeFileSync(join(presetsDir, 'default', 'AGENTS.md'), '# default\n')
  mkdirSync(join(presetsDir, 'strict-safety'), { recursive: true })
  writeFileSync(join(presetsDir, 'strict-safety', 'AGENTS.md'), '# strict\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const r = await call(ctx._route(), { op: 'agentsmd-list', args: {} })
  assert.equal(r.json.ok, true)
  const ids = r.json.presets.map((p) => p.id).sort()
  assert.deepEqual(ids, ['default', 'strict-safety'])
  assert.deepEqual(r.json.presets.map((p) => p.active), [false, false])
})

test('agentsmd-read: 返回某预设的 AGENTS.md 文本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  mkdirSync(join(presetsDir, 'default'), { recursive: true })
  writeFileSync(join(presetsDir, 'default', 'AGENTS.md'), '# default rules\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const r = await call(ctx._route(), { op: 'agentsmd-read', args: { id: 'default' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.content, '# default rules\n')
})

test('agentsmd-read: 不存在的 id → ok:false', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const r = await call(ctx._route(), { op: 'agentsmd-read', args: { id: 'nope' } })
  assert.equal(r.json.ok, false)
})

test('agentsmd-read: 非法 id（含路径分隔/点号）→ ok:false，防目录穿越', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  for (const id of ['a/b', '..', 'a..b', 'A-B', 'has space']) {
    const r = await call(ctx._route(), { op: 'agentsmd-read', args: { id } })
    assert.equal(r.json.ok, false, 'id 应被拒: ' + id)
  }
})

test('agentsmd 工作流: create → update → apply(备份) → get-current → remove', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const route = ctx._route()

  // create 空白模板
  let r = await call(route, { op: 'agentsmd-create', args: { id: 'work' } })
  assert.equal(r.json.ok, true, 'create 应成功')
  r = await call(route, { op: 'agentsmd-read', args: { id: 'work' } })
  assert.equal(r.json.ok, true)
  assert.ok(r.json.content.length > 0, '空白模板应有占位文本')

  // update
  r = await call(route, { op: 'agentsmd-update', args: { id: 'work', content: '# v1\n' } })
  assert.equal(r.json.ok, true, 'update 应成功')
  r = await call(route, { op: 'agentsmd-read', args: { id: 'work' } })
  assert.equal(r.json.content, '# v1\n')

  // 第一次 apply（全局初始不存在 → 不备份）
  r = await call(route, { op: 'agentsmd-apply', args: { id: 'work' } })
  assert.equal(r.json.ok, true, 'apply 应成功')
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# v1\n')

  // update v2 + 第二次 apply（备份 v1 到 __last-applied__）
  r = await call(route, { op: 'agentsmd-update', args: { id: 'work', content: '# v2\n' } })
  assert.equal(r.json.ok, true)
  r = await call(route, { op: 'agentsmd-apply', args: { id: 'work' } })
  assert.equal(r.json.ok, true)
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# v2\n')
  assert.equal(readFileSync(join(presetsDir, '__last-applied__', 'AGENTS.md'), 'utf8'), '# v1\n', '备份应为 apply 前的全局内容')

  // get-current：全局=v2，匹配 work
  r = await call(route, { op: 'agentsmd-get-current', args: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.content, '# v2\n')
  assert.equal(r.json.presetId, 'work')

  // list 中 work 标 active
  r = await call(route, { op: 'agentsmd-list', args: {} })
  const work = r.json.presets.find((p) => p.id === 'work')
  assert.equal(work.active, true, 'work 应标生效中')

  // remove 生效中的 work（允许）
  r = await call(route, { op: 'agentsmd-remove', args: { id: 'work' } })
  assert.equal(r.json.ok, true, '删生效中预设应允许')
  r = await call(route, { op: 'agentsmd-list', args: {} })
  assert.equal(r.json.presets.find((p) => p.id === 'work'), undefined, 'work 应已删除')

  // remove __last-applied__ → 拒绝（备份槽不可删）
  r = await call(route, { op: 'agentsmd-remove', args: { id: '__last-applied__' } })
  assert.equal(r.json.ok, false, '删备份槽应被拒')
})

test('agentsmd-create: 从现有预设复制 / 重复 id / 非法 id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  mkdirSync(join(presetsDir, 'default'), { recursive: true })
  writeFileSync(join(presetsDir, 'default', 'AGENTS.md'), '# d\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const route = ctx._route()

  // 从现有复制
  let r = await call(route, { op: 'agentsmd-create', args: { id: 'copy', from: 'default' } })
  assert.equal(r.json.ok, true, '复制应成功')
  r = await call(route, { op: 'agentsmd-read', args: { id: 'copy' } })
  assert.equal(r.json.content, '# d\n', '复制内容应等价源')

  // 重复 id
  r = await call(route, { op: 'agentsmd-create', args: { id: 'default' } })
  assert.equal(r.json.ok, false, '重复 id 应拒')

  // 非法 id
  r = await call(route, { op: 'agentsmd-create', args: { id: 'A B' } })
  assert.equal(r.json.ok, false, '非法 id 应拒')

  // from 不存在
  r = await call(route, { op: 'agentsmd-create', args: { id: 'x', from: 'nope' } })
  assert.equal(r.json.ok, false, 'from 不存在应拒')
})

test('agentsmd 初始化: 库空且全局 AGENTS.md 存在 → list 自动建 default 预设（内容=全局）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  writeFileSync(join(home, 'AGENTS.md'), '# global rules\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  let r = await call(ctx._route(), { op: 'agentsmd-list', args: {} })
  assert.equal(r.json.ok, true)
  assert.ok(r.json.presets.find((p) => p.id === 'default'), '应自动建 default')
  r = await call(ctx._route(), { op: 'agentsmd-read', args: { id: 'default' } })
  assert.equal(r.json.content, '# global rules\n', 'default 内容应=全局')
})

test('agentsmd 初始化: 库已有 default → 不覆盖（幂等）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  mkdirSync(join(presetsDir, 'default'), { recursive: true })
  writeFileSync(join(presetsDir, 'default', 'AGENTS.md'), '# old\n')
  writeFileSync(join(home, 'AGENTS.md'), '# global\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const r = await call(ctx._route(), { op: 'agentsmd-read', args: { id: 'default' } })
  assert.equal(r.json.content, '# old\n', '已有 default 不应被覆盖')
})

test('agentsmd-import: 从文本内容建预设，read 回读一致', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const route = ctx._route()
  const r = await call(route, { op: 'agentsmd-import', args: { id: 'imported', content: '# hello\n' } })
  assert.equal(r.json.ok, true, 'import 应成功')
  const r2 = await call(route, { op: 'agentsmd-read', args: { id: 'imported' } })
  assert.equal(r2.json.ok, true)
  assert.equal(r2.json.content, '# hello\n', '内容应一致')
})

test('agentsmd-import: 重复 id / 非法 id → ok:false', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amd-'))
  const presetsDir = mkdtempSync(join(tmpdir(), 'dsh-amd-presets-'))
  mkdirSync(join(presetsDir, 'default'), { recursive: true })
  writeFileSync(join(presetsDir, 'default', 'AGENTS.md'), '# old\n')
  const ctx = makeCtx(home, undefined, { presetsDir })
  plugin.apply(ctx, { presetsDir })
  const route = ctx._route()
  let r = await call(route, { op: 'agentsmd-import', args: { id: 'default', content: '# x\n' } })
  assert.equal(r.json.ok, false, '重复 id 应拒')
  r = await call(route, { op: 'agentsmd-import', args: { id: 'A B', content: '# x\n' } })
  assert.equal(r.json.ok, false, '非法 id 应拒')
})
