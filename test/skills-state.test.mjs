// test/skills-state.test.mjs —— 技能管理器状态文件（$DSH_HOME/tool-management/state.json）的读取韧性。
//
// 这条来自一次真实故障：v0.4 给技能来源加了 `hub`，而校验器要求**每个** `userRoots()` 来源
// 都在 `sources` 里有布尔值、在 `disabledSkills` 里有数组。用户磁盘上那份状态文件是加 hub
// **之前**写的，于是「版本升级本身」把它判成非法 → fail-closed：所有来源停用、写入锁定，
// Skills 页弹「状态文件不可读，已拒绝覆盖」，而文件一个字节都没坏。
//
// 守的契约：**缺键（我们后来加过的东西）必须自愈，真损坏（类型错、版本不认识）仍要拒绝。**
//
// 跑 lib 编译产物；改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManagerState, userRoots, managerStatePath } from '../lib/skills/core.js'

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
  const newer = keys.filter((k) => k !== 'dsh')
  // 模拟「加 hub 之前」的文档：只认识第一个非 dsh 来源
  const legacy = {
    version: 1,
    sources: { [newer[0]]: false },
    disabledSkills: { dsh: ['find-extensions'], [newer[0]]: [] },
    enabledSkills: { dsh: [], [newer[0]]: [] },
  }
  const ctx = await withStateFile(JSON.stringify(legacy, null, 2))
  try {
    const r = await readManagerState()
    assert.equal(r.warning, null, '缺键不该产生告警')
    assert.equal(r.writable, true, '缺键不该锁死写入')
    for (const key of keys) {
      assert.ok(Array.isArray(r.state.disabledSkills[key]), `${key} 的 disabledSkills 桶应被补齐`)
      assert.ok(Array.isArray(r.state.enabledSkills[key]), `${key} 的 enabledSkills 桶应被补齐`)
      if (key !== 'dsh') assert.equal(typeof r.state.sources[key], 'boolean', `${key} 的 sources 布尔值应被补齐`)
    }
    // 新来源默认启用（与 defaultManagerState 一致），既有设置原样保留
    assert.equal(r.state.sources[newer[0]], false, '文件里写过的值必须保留')
    assert.deepEqual(r.state.disabledSkills.dsh, ['find-extensions'], '既有禁用列表必须保留')
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
      const keys = rootKeys().filter((k) => k !== 'dsh')
      assert.deepEqual(keys.filter((k) => r.state.sources[k] !== false), [], `${label}: 所有外部来源都应停用（fail-closed）`)
    } finally {
      ctx.restore()
    }
  }
})
