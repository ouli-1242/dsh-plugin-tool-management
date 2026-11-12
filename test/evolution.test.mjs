// 自主记忆 P0 的契约测试。
//
// 只钉三类「一旦破了会静默出错」的东西（与 contracts.test.mjs 同一条规矩）：
//   ① 三级开关的继承方向 —— 解析错了，用户以为关了其实开着，不报错；
//   ② 保留组不能进场景 —— 进了就会以 `## Scene: _ws` 注入，模型当成用户场景；
//   ③ 会话层隔离 —— 串了就是隐私事故，且没有任何提示。
//
// 不测文案、不测字段顺序、不测 catalog 的具体 token 数（那些改一句话就红）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_EVOLUTION_SETTINGS,
  normalizeEvolutionSettings,
  resolveEffectiveConfig,
  workspaceHashOf,
} from '../lib/evolution/config.js'
import { isReservedGroup, layerOfGroup } from '../lib/memories/constants.js'
import { ensureSceneRecords, resolveActiveScenes } from '../lib/memories/projection.js'
import { buildCatalog, visibleEntries } from '../lib/memories/catalog.js'

const G = DEFAULT_EVOLUTION_SETTINGS

test('三级开关：下层可以覆盖上层的「关」', () => {
  // 全局关 + 工作区开 → 开（只给这个项目开）
  assert.equal(resolveEffectiveConfig(G, { learnWorkspace: true }).enabled, true)
  // 全局开 + 会话关 → 关（这个对话别学）
  assert.equal(resolveEffectiveConfig({ ...G, learnGlobal: true }, undefined, { learnGlobal: false, learnWorkspace: false }).enabled, false)
  // 会话优先于工作区
  assert.equal(resolveEffectiveConfig(G, { learnWorkspace: true }, { learnGlobal: false, learnWorkspace: false }).enabled, false)
  // 都没设 → 全局
  assert.equal(resolveEffectiveConfig({ ...G, learnGlobal: true }, {}, {}).enabled, true)
})

test('两层开关：只开一层时 enabled 仍为真，另一层保持关', () => {
  const onlyWorkspace = resolveEffectiveConfig({ ...G, learnWorkspace: true })
  assert.equal(onlyWorkspace.enabled, true)
  assert.equal(onlyWorkspace.learnGlobal, false)
  assert.equal(onlyWorkspace.learnWorkspace, true)
  const onlyGlobal = resolveEffectiveConfig({ ...G, learnGlobal: true })
  assert.equal(onlyGlobal.enabled, true)
  assert.equal(onlyGlobal.learnGlobal, true)
  assert.equal(onlyGlobal.learnWorkspace, false)
})

test('inject 恒等于 enabled：层开关是唯一授权边界', () => {
  assert.equal(resolveEffectiveConfig(G).inject, false)
  assert.equal(resolveEffectiveConfig({ ...G, learnGlobal: true }).inject, true)
  // 独立的「只学不用」开关已下线：配置里残留的 `inject: false` 被刻意忽略，
  // 否则界面上没有入口能把它改回来，那些用户的自主记忆会永久不注入。
  assert.equal(resolveEffectiveConfig({ ...G, learnGlobal: true, inject: false }).inject, true)
  // 反过来，显式 true 也不能越过层开关。
  assert.equal(resolveEffectiveConfig({ ...G, learnGlobal: false, learnWorkspace: false, inject: true }).inject, false)
})

test('source 报最具体的那一档（界面显示「来源」）', () => {
  assert.equal(resolveEffectiveConfig(G).source, 'global')
  assert.equal(resolveEffectiveConfig(G, { learnWorkspace: true }).source, 'workspace')
  assert.equal(resolveEffectiveConfig(G, { learnWorkspace: true }, { learnGlobal: false, learnWorkspace: false }).source, 'session')
  // 空对象不算覆盖
  assert.equal(resolveEffectiveConfig(G, {}, {}).source, 'global')
})

test('autoConfirm：默认关，可全局设置，下层可覆盖', () => {
  assert.equal(G.autoConfirm, false)
  assert.equal(normalizeEvolutionSettings({ autoConfirm: true }).autoConfirm, true)
  assert.equal(normalizeEvolutionSettings({ autoConfirm: 'yes' }).autoConfirm, false)
  assert.equal(resolveEffectiveConfig({ ...G, autoConfirm: true }).autoConfirm, true)
  assert.equal(resolveEffectiveConfig({ ...G, autoConfirm: true }, { autoConfirm: false }).autoConfirm, false)
  assert.equal(resolveEffectiveConfig({ ...G, autoConfirm: false }, undefined, { autoConfirm: true }).autoConfirm, true)
})

test('旧配置迁移：enabled + writeTarget 翻译成两个开关', () => {
  const both = normalizeEvolutionSettings({ enabled: true, learnScope: 'global', writeTarget: 'route' })
  assert.equal(both.learnGlobal, true)
  assert.equal(both.learnWorkspace, true)
  const workspaceOnly = normalizeEvolutionSettings({ enabled: true, writeTarget: 'workspace' })
  assert.equal(workspaceOnly.learnGlobal, false)
  assert.equal(workspaceOnly.learnWorkspace, true)
  const off = normalizeEvolutionSettings({ enabled: false })
  assert.equal(off.learnGlobal, false)
  assert.equal(off.learnWorkspace, false)
  // 旧版 learnScope='off' 是「不学」开关：enabled=true 也不该在升级后开始学。
  const scopeOff = normalizeEvolutionSettings({ enabled: true, learnScope: 'off', writeTarget: 'global' })
  assert.equal(scopeOff.learnGlobal, false)
  assert.equal(scopeOff.learnWorkspace, false)
})

test('坏值回退出厂值，不抛错', () => {
  const s = normalizeEvolutionSettings({ learnGlobal: 'yes', learnWorkspace: 42, maxReviewsPerSession: 'nope' })
  assert.equal(s.learnGlobal, G.learnGlobal)
  assert.equal(s.learnWorkspace, G.learnWorkspace)
  assert.equal(s.maxReviewsPerSession, G.maxReviewsPerSession)
  // 合法但越界的值夹到下限 0（0 = 不复习，不是坏值）。
  assert.equal(normalizeEvolutionSettings({ maxReviewsPerSession: -3 }).maxReviewsPerSession, 0)
})

test('layerOfGroup：保留组按前缀判，其余都是场景层', () => {
  assert.equal(layerOfGroup('global'), 'global')
  assert.equal(layerOfGroup('_ws/3f2a9c1e8b7d4a06'), 'workspace')
  assert.equal(layerOfGroup('_session/s-abc'), 'session')
  assert.equal(layerOfGroup('代码'), 'scene')
  // `_shared` 是历史公共基线，不单独成层
  assert.equal(layerOfGroup('_shared'), 'scene')
  assert.equal(isReservedGroup('_ws/3f2a'), true)
  assert.equal(isReservedGroup('_session/s'), true)
  assert.equal(isReservedGroup('_auto'), true)
  assert.equal(isReservedGroup('代码'), false)
})

test('保留组不进启用场景集合，也不会被补成场景记录', () => {
  const index = { version: 1, rules: {}, groups: {}, scenes: { global: { label: '全局', order: 0 } } }
  const { active } = resolveActiveScenes(index, ['global', '_ws', '_session', '代码'])
  assert.equal(active.has('_ws'), false)
  assert.equal(active.has('_session'), false)
  assert.equal(active.has('global'), true)
  assert.equal(active.has('代码'), true)

  const bare = { version: 1, rules: {}, groups: {}, scenes: {} }
  ensureSceneRecords(bare, ['global', '_ws', '_session', '代码'])
  assert.equal(bare.scenes['_ws'], undefined)
  assert.equal(bare.scenes['_session'], undefined)
  assert.ok(bare.scenes['代码'])
})

test('工作区 hash 稳定且长度固定', () => {
  const a = workspaceHashOf('ws:c:/users/ouli/project')
  assert.equal(a, workspaceHashOf('ws:c:/users/ouli/project'))
  assert.equal(a.length, 16)
  assert.match(a, /^[0-9a-f]{16}$/)
})

test('catalog：_ws 下没写 origin 的条目按自动记忆收进来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evo-'))
  try {
    mkdirSync(join(root, '_ws', '3f2a9c1e8b7d4a06'), { recursive: true })
    writeFileSync(
      join(root, '_ws', '3f2a9c1e8b7d4a06', 'pkg.md'),
      '---\nname: pkg\ndescription: 这个仓库用 pnpm\nauto_kind: preference\nauto_status: active\nauto_key: package-manager\n---\n\n这个仓库统一用 pnpm。\n',
    )
    const index = { version: 1, rules: {}, groups: {}, scenes: {} }
    const catalog = await buildCatalog(root, index)
    const entry = catalog.entries['_ws/3f2a9c1e8b7d4a06/pkg']
    assert.ok(entry, '工作区层的条目应当进 catalog')
    assert.equal(entry.layer, 'workspace')
    assert.equal(entry.workspace, '3f2a9c1e8b7d4a06')
    assert.equal(entry.status, 'active')
    assert.equal(entry.key, 'package-manager')
    assert.match(entry.oneLine, /pnpm/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catalog：手写记忆（origin=user）不进自动索引', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evo-'))
  try {
    mkdirSync(join(root, 'global'), { recursive: true })
    writeFileSync(join(root, 'global', 'tone.md'), '---\nname: tone\ndescription: 回答先给结论\n---\n\n回答先给结论。\n')
    const index = { version: 1, rules: {}, groups: {}, scenes: {} }
    const catalog = await buildCatalog(root, index)
    assert.deepEqual(Object.keys(catalog.entries), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catalog：会话层只认自己的 sid（结构性隔离的第二道保险）', () => {
  const base = {
    layer: 'session', workspace: '', scene: '', kind: 'fact', key: '', status: 'active',
    oneLine: 'x', bytes: 1, estTokens: 1, confidence: 0.9, pinned: false, enabled: true,
    mtime: 0, size: 1, hash: '',
  }
  const catalog = {
    version: 1,
    builtAt: '',
    entries: {
      '_session/s-1/a': { ...base, id: '_session/s-1/a', session: 's-1' },
      '_session/s-2/b': { ...base, id: '_session/s-2/b', session: 's-2' },
    },
  }
  const visible = visibleEntries(catalog, { sessionId: 's-1' })
  assert.deepEqual(visible.map((e) => e.id), ['_session/s-1/a'])
  // 拿不到 sid 时一条都不选（宁可少注入，也不串会话）
  assert.deepEqual(visibleEntries(catalog, {}), [])
})
