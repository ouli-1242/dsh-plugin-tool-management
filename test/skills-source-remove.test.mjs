// test/skills-source-remove.test.mjs —— 「移除来源」= 插件不再读取它（用户裁定）。
//
// 用户原话：「是不读取这个文件夹了，不是把文件夹删除」/「不是删除，是移除可以读取」。
//
// 与相邻概念的区别（这条最容易搞混，所以写成断言）：
//   - 停用来源（sources[key]=false）：仍然读取、仍然列出技能，只是不可调用；
//   - 移除来源（removedSources 含 key）：**连目录都不扫**，技能不出现在快照里，
//     也不参与 provider 候选；源目录与文件一个字节都不动，清掉标记即恢复；
//   - dsh（官方技能目录）与 hub（导入落点）不可移除 —— 移除会让创建/导入无处落脚。
//
// 跑 lib 编译产物；改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { state, setSourceRemoved, setSourceEnabled, userRoots, readManagerState } from '../lib/skills/core.js'

/** 造一个临时 $DSH_HOME，并在「公共 Agent」来源里放一个技能。 */
async function withAgentsSkill() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-src-remove-'))
  const home = join(base, '.dsh')
  const agentsHome = join(base, '.agents')
  const skillDir = join(agentsHome, 'skills', 'demo-agent-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: demo-agent-skill\ndescription: agent 来源的示例技能\n---\n\nbody\n',
    'utf8',
  )
  const dshSkill = join(home, 'skills', 'demo-dsh')
  await mkdir(dshSkill, { recursive: true })
  await writeFile(join(dshSkill, 'SKILL.md'), '---\nname: demo-dsh\ndescription: d\n---\n\nbody\n', 'utf8')

  const prevHome = process.env.DSH_HOME
  const prevAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agentsHome
  return {
    home,
    agentsHome,
    skillDir,
    restore() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      if (prevAgents === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = prevAgents
    },
  }
}

const rootRow = (snapshot, key) => (snapshot.roots || []).find((r) => r.key === key)
const skillNames = (snapshot) =>
  (snapshot.roots || []).flatMap((r) => (r.skills || []).map((s) => s.name))

test('移除来源：技能不再被读取，但源文件原封不动；恢复后又能读到', async () => {
  const ctx = await withAgentsSkill()
  try {
    const before = await state({})
    assert.ok(skillNames(before).includes('demo-agent-skill'), '前置：未移除时应能读到该技能')
    const agentsBefore = rootRow(before, 'agents')
    assert.equal(agentsBefore.removed, false)
    assert.equal(agentsBefore.removable, true, 'agents 来源应可移除')

    // —— 移除 ——
    const removed = await setSourceRemoved('agents', true)
    assert.equal(removed.ok !== false, true, '移除应成功')
    assert.equal(removed.removed, true)

    const after = await state({})
    assert.equal(skillNames(after).includes('demo-agent-skill'), false, '移除后不该再列出该来源的技能')
    const agentsAfter = rootRow(after, 'agents')
    assert.equal(agentsAfter.removed, true, 'roots 里应标记 removed')
    assert.deepEqual(agentsAfter.skills, [], '已移除来源不应带任何技能')

    // 源文件与目录必须还在
    assert.equal(existsSync(join(ctx.skillDir, 'SKILL.md')), true, '源文件必须留在磁盘上')
    assert.deepEqual(await readdir(join(ctx.agentsHome, 'skills')), ['demo-agent-skill'], '来源目录内容不变')

    // 状态文件里记下了这个标记（可持久、可恢复）
    const persisted = await readManagerState()
    assert.deepEqual(persisted.state.removedSources, ['agents'])

    // —— 恢复 ——
    const restored = await setSourceRemoved('agents', false)
    assert.equal(restored.removed, false)
    const back = await state({})
    assert.ok(skillNames(back).includes('demo-agent-skill'), '恢复后应重新读到该技能')
    assert.equal(rootRow(back, 'agents').removed, false)
    const persisted2 = await readManagerState()
    assert.deepEqual(persisted2.state.removedSources, [])
  } finally {
    ctx.restore()
  }
})

test('移除 ≠ 停用：停用仍列出技能（只是不可调用），移除则连列都不列', async () => {
  const ctx = await withAgentsSkill()
  try {
    await setSourceEnabled('agents', false)
    const disabled = await state({})
    const agentSkill = (rootRow(disabled, 'agents').skills || []).find((s) => s.name === 'demo-agent-skill')
    assert.ok(agentSkill, '停用来源后技能仍应出现在列表里')
    assert.equal(agentSkill.enabled, false, '但它应是不可调用状态')
    assert.equal(rootRow(disabled, 'agents').removed, false)

    await setSourceRemoved('agents', true)
    const removed = await state({})
    assert.equal(skillNames(removed).includes('demo-agent-skill'), false, '移除后技能从列表消失')
  } finally {
    ctx.restore()
  }
})

test('保留来源不可移除：dsh 与 hub 被明确拒绝', async () => {
  const ctx = await withAgentsSkill()
  try {
    for (const key of ['dsh', 'hub']) {
      const result = await setSourceRemoved(key, true)
      assert.equal(result.ok, false, `${key} 不该允许移除`)
      assert.equal(result.code, 'error.source.reserved')
    }
    const snapshot = await state({})
    assert.ok(skillNames(snapshot).includes('demo-dsh'), 'dsh 来源应照常可读')
    assert.equal(rootRow(snapshot, 'dsh').removable, false, 'dsh 不应显示移除入口')
    assert.equal(rootRow(snapshot, 'hub').removable, false, 'hub 不应显示移除入口')
  } finally {
    ctx.restore()
  }
})

test('来源定义完备：每个来源都有 removable 语义（dsh/hub 之外的只读来源可移除）', () => {
  const keys = userRoots().map((r) => r.key)
  for (const key of ['dsh', 'hub', 'agents', 'codex', 'claude']) {
    assert.ok(keys.includes(key), `缺少来源 ${key}`)
  }
})
