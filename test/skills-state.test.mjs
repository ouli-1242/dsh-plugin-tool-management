// test/skills-state.test.mjs —— 技能管理器状态文件（$DSH_HOME/tool-management/state.json）的读取韧性。
//
// 这条来自一次真实故障：v0.4 给技能来源加了 `hub`，而校验器要求**每个**可启停来源
// 都在 `sources` 里有布尔值、在 `disabledSkills` 里有数组。用户磁盘上那份状态文件是加 hub
// **之前**写的，于是「版本升级本身」把它判成非法 → fail-closed：所有来源停用、写入锁定，
// Skills 页弹「状态文件不可读，已拒绝覆盖」，而文件一个字节都没坏。
//
// 现在默认来源（dsh / hub）不再进 `sources` 表：它们必须读取，没有来源开关，所以校验器
// 对它们豁免布尔值要求，归一化也会把旧文档里写过的 `sources.hub` 丢掉。
//
// 守的契约：**缺键（我们后来加过的东西）必须自愈，真损坏（类型错、版本不认识）仍要拒绝。**
//
// 跑 lib 编译产物；改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManagerState, userRoots, managerStatePath, isDefaultSkillSource } from '../lib/skills/core.js'

/** 在临时 $DSH_HOME 里放一份状态文件，返回该目录。 */
async function withStateFile(content) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-state-'))
  const home = join(base, '.dsh')
  await mkdir(join(home, 'tool-management'), { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  if (content !== undefined) await writeFile(join(home, 'tool-management', 'state.json'), content, 'utf8')
  return {
    home,
    restore() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    },
  }
}

const rootKeys = () => userRoots().map((r) => r.key)

test('缺键自愈：旧状态文件没有后来新增的来源 → 补齐默认值，不 fail-closed', async () => {
  const keys = rootKeys()
  assert.ok(keys.length >= 2, '至少要有多个来源才谈得上缺键')
  // 默认来源（dsh / hub）没有来源开关，压根不进 sources 表，所以「后来新增的来源」
  // 只能拿可启停来源举例。
  const switchable = keys.filter((k) => !isDefaultSkillSource(k))
  assert.ok(switchable.length >= 2, '至少要有多个可启停来源')
  // 模拟「加 codex / claude 之前」的文档：只认识第一个可启停来源
  const legacy = {
    version: 1,
    sources: { [switchable[0]]: false },
    disabledSkills: { dsh: ['find-extensions'], [switchable[0]]: [] },
    enabledSkills: { dsh: [], [switchable[0]]: [] },
  }
  const ctx = await withStateFile(JSON.stringify(legacy, null, 2))
  try {
    const r = await readManagerState()
    assert.equal(r.warning, null, '缺键不该产生告警')
    assert.equal(r.writable, true, '缺键不该锁死写入')
    for (const key of keys) {
      assert.ok(Array.isArray(r.state.disabledSkills[key]), `${key} 的 disabledSkills 桶应被补齐`)
      assert.ok(Array.isArray(r.state.enabledSkills[key]), `${key} 的 enabledSkills 桶应被补齐`)
      if (!isDefaultSkillSource(key))
        assert.equal(typeof r.state.sources[key], 'boolean', `${key} 的 sources 布尔值应被补齐`)
    }
    // 新来源默认启用（与 defaultManagerState 一致），既有设置原样保留
    assert.equal(r.state.sources[switchable[0]], false, '文件里写过的值必须保留')
    assert.deepEqual(r.state.disabledSkills.dsh, ['find-extensions'], '既有禁用列表必须保留')
  } finally {
    ctx.restore()
  }
})

/**
 * 默认来源（dsh / hub）必须读取，没有来源开关。旧版本允许停用 hub，那份状态文件里
 * 可能留着 `sources.hub = false`、甚至 `removedSources: ['hub']` —— 归一化必须把这两处
 * 残留一并丢掉，否则升级后 hub 里的技能会「凭空消失」（目录还在，只是不读了）。
 */
test('默认来源的残留策略位被丢弃：sources.hub / removedSources 里的 hub 都不算数', async () => {
  const legacy = {
    version: 1,
    sources: { hub: false, dsh: false, agents: false },
    removedSources: ['hub', 'agents'],
    disabledSkills: { hub: [] },
    enabledSkills: { hub: [] },
  }
  const ctx = await withStateFile(JSON.stringify(legacy, null, 2))
  try {
    const r = await readManagerState()
    assert.equal(r.writable, true, '这类残留不该把状态文件判成损坏')
    assert.equal(r.state.sources.hub, undefined, 'sources 表里不该再有 hub 这个键')
    assert.equal(r.state.sources.dsh, undefined, 'sources 表里不该有 dsh 这个键')
    assert.equal(r.state.sources.agents, false, '可启停来源的值照常保留（对照）')
    assert.deepEqual(r.state.removedSources, ['agents'], 'removedSources 里的默认来源必须被丢掉')
  } finally {
    ctx.restore()
  }
})

test('文件不存在 → 默认状态，可用可写', async () => {
  const ctx = await withStateFile(undefined)
  try {
    const r = await readManagerState()
    assert.equal(r.warning, null)
    assert.equal(r.writable, true)
    for (const key of rootKeys()) assert.ok(Array.isArray(r.state.disabledSkills[key]))
  } finally {
    ctx.restore()
  }
})

test('真损坏仍拒绝：version 不认识 / 不是 JSON / 类型不对 → warning + 锁定 + 全部来源停用', async () => {
  const cases = [
    ['version 2', JSON.stringify({ version: 2, sources: {}, disabledSkills: {}, enabledSkills: {} })],
    ['不是 JSON', '{ this is not json'],
    ['sources 是数组', JSON.stringify({ version: 1, sources: [], disabledSkills: {}, enabledSkills: {} })],
    ['disabledSkills 条目不是数组', JSON.stringify({ version: 1, sources: {}, disabledSkills: { dsh: 'find-extensions' }, enabledSkills: {} })],
  ]
  for (const [label, content] of cases) {
    const ctx = await withStateFile(content)
    try {
      const r = await readManagerState()
      assert.equal(r.writable, false, `${label}: 应锁定写入`)
      assert.equal(r.warning && r.warning.code, 'warning.state.invalid', `${label}: 应给出 warning.state.invalid`)
      assert.equal(r.warning.params.path, managerStatePath(), `${label}: 告警应带路径`)
      const keys = rootKeys().filter((k) => !isDefaultSkillSource(k))
      assert.deepEqual(keys.filter((k) => r.state.sources[k] !== false), [], `${label}: 所有可启停来源都应停用（fail-closed）`)
    } finally {
      ctx.restore()
    }
  }
})
