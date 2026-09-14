// test/skills-delete.test.mjs —— 「哪些技能可以删、哪些来源不能动」的契约。
//
// 用户裁定的来源语义（两组正好相反，只记住一半就会改错）：
//   - **默认来源** `dsh`（~/.dsh/skills/）与 `hub`（~/.dsh/tool-management/skills/）：
//     来源路径**必须读取**（不可移除、不可停用），但里面的技能**可以删**（移入插件回收站）；
//   - **其他来源**（公共 Agent / Codex / Claude / 自定义绝对路径）：来源路径**可以不读取**
//     （可停用、可移除），但里面的技能**不能删**（只读）。
//
// 一句话记法：`mutable` 与 `deletable` 同向，`removable` 与 `mutable` 反向。
//
// 这里守三件事：① 来源定义上的可写/可删/只读位正确；② 默认来源的技能删得掉、且**能恢复**
// （回收站记的来源元数据要对，否则搬进去就回不来）；③ 只读来源在碰文件之前就拒绝。
//
// 跑 lib 编译产物；改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSkill,
  userRoots,
  customRootKey,
  addCustomRoot,
  isDefaultSkillSource,
  listTrash,
  restoreTrash,
} from '../lib/skills/core.js'

/** 在临时 $DSH_HOME 里铺两个技能：一个在 DSH 来源、一个在导入技能来源。 */
async function withSkills() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-delete-'))
  const home = join(base, '.dsh')
  const dshSkill = join(home, 'skills', 'demo-dsh')
  const hubSkill = join(home, 'tool-management', 'skills', 'demo-hub')
  await mkdir(dshSkill, { recursive: true })
  await writeFile(join(dshSkill, 'SKILL.md'), '---\nname: demo-dsh\ndescription: d\n---\n\nbody\n', 'utf8')
  await mkdir(hubSkill, { recursive: true })
  await writeFile(join(hubSkill, 'SKILL.md'), '---\nname: demo-hub\ndescription: h\n---\n\nbody\n', 'utf8')
  // 生产路径解析依赖 $DSH_HOME（且 core.js 在调用时读，不是模块加载时）
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // 规范化后的 root 定义必须**从 userRoots() 里取**：它们带 deletable / mutable 等标记，
  // 自己拼一个 { key, path } 会在路径校验处被判为「不属于任何已知来源」。
  const byKey = Object.fromEntries(userRoots().map((r) => [r.key, r]))
  return {
    home,
    dshSkill,
    hubSkill,
    targets: [
      { root: byKey.dsh, name: 'demo-dsh' },
      { root: byKey.hub, name: 'demo-hub' },
    ],
    restore() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    },
  }
}

test('来源定义：默认来源 dsh / hub 可写且里面的技能可删；外部来源只读且不可删', () => {
  const roots = userRoots()
  const byKey = Object.fromEntries(roots.map((r) => [r.key, r]))
  for (const key of ['dsh', 'hub']) {
    assert.ok(byKey[key], `缺少来源 ${key}`)
    assert.equal(byKey[key].mutable, true, `${key} 应该可写（要能在这里创建/导入技能）`)
    assert.equal(byKey[key].deletable, true, `${key} 可删（移入插件回收站，可恢复）`)
    assert.equal(isDefaultSkillSource(key), true, `${key} 应被认作默认来源`)
  }
  // 其余用户级来源（外部 Agent 目录）只读：既不能写，也不能删
  for (const root of roots) {
    if (root.scope === 'project' || isDefaultSkillSource(root)) continue
    assert.equal(root.mutable, false, `${root.key} 应该是只读来源`)
    assert.notEqual(root.deletable, true, `${root.key} 不应标记为可删除`)
  }
})

test('导入技能的界面名是「导入技能」（不再是「管理器技能」）', () => {
  const hub = userRoots().find((r) => r.key === 'hub')
  assert.equal(hub.label, '导入技能')
})

/**
 * 显示名的实际来源：客户端 `rootDisplayName` 是**词典优先、宿主 label 兜底**
 * （`translateOrFallback(t, 'root.' + localeKey, root.label)`）。
 *
 * 这条护栏来自一次真漏改：宿主侧 label 已改成「导入技能」（API 也回传新值），
 * 但客户端词典里的 `root.hub` 忘了同步 —— 界面上仍然显示「管理器技能」。
 * 只查宿主 label 是查不出来的，必须查词典。
 */
test('客户端词典：root.hub 必须是「导入技能」（词典优先于宿主 label，漏改看不出来）', () => {
  const client = readFileSync('src/client.js', 'utf8')
  assert.equal(/管理器技能/.test(client), false, '客户端词典/文案里不该再有「管理器技能」')
  assert.equal(/Manager skills/.test(client), false, '英文侧不该再有 "Manager skills"')
  // 只取**词典条目**（`"root.hub": "..."`），不要把 `t("root.hub")` 的调用行也当成条目
  const entries = client.split('\n').filter((line) => /"root\.hub"\s*:/.test(line))
  assert.ok(entries.length >= 2, `词典应有中英两条 root.hub，实际 ${entries.length} 条`)
  for (const line of entries) {
    assert.ok(/导入技能|Imported skills/.test(line), `root.hub 的显示名没改：${line.trim().slice(0, 120)}`)
  }
})

test('默认来源的技能删得掉：进插件回收站，并且能从回收站原样放回', async () => {
  const ctx = await withSkills()
  try {
    const before = {
      dsh: await readFile(join(ctx.dshSkill, 'SKILL.md'), 'utf8'),
      hub: await readFile(join(ctx.hubSkill, 'SKILL.md'), 'utf8'),
    }
    const ids = []
    for (const target of ctx.targets) {
      const result = await deleteSkill(target.root, target.name)
      assert.equal(result.ok !== false, true, `${target.root.key}: 默认来源的技能应可删（实际 ${result.code || ''}）`)
      assert.ok(result.id, `${target.root.key}: 应返回回收站条目 id`)
      ids.push(result.id)
      assert.equal(result.root.key, target.root.key, `${target.root.key}: 元数据应记住来源 key`)
      assert.equal(result.root.scope, 'user', `${target.root.key}: 用户级来源必须记成 user scope`)
    }
    // 技能已从各自来源目录里搬走（不是留在原地）
    assert.equal(existsSync(ctx.dshSkill), false, 'DSH 技能应被移走')
    assert.equal(existsSync(ctx.hubSkill), false, '导入技能应被移走')

    // 回收站里能查到两条，且来源名可分辨（hub 不该被显示成 DSH 技能）
    const items = await listTrash()
    assert.deepEqual(items.map((item) => item.name).sort(), ['demo-dsh', 'demo-hub'])
    assert.deepEqual(
      items.map((item) => item.root.key).sort(),
      ['dsh', 'hub'],
      '回收站条目必须记住各自来源，否则恢复时不知道放回哪里',
    )

    // 逐个恢复：内容必须与删除前逐字节一致（这是「可删」的前提 —— 删的是位置，不是内容）
    for (const [index, id] of ids.entries()) {
      const restored = await restoreTrash(id)
      assert.equal(restored.ok !== false, true, `恢复 ${id} 应成功（实际 ${restored && restored.code}）`)
      const name = ctx.targets[index].name
      const dir = name === 'demo-dsh' ? ctx.dshSkill : ctx.hubSkill
      assert.equal(existsSync(dir), true, `${name} 应回到原来源目录`)
      assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), before[name === 'demo-dsh' ? 'dsh' : 'hub'], '内容必须逐字节一致')
    }
    assert.deepEqual(await listTrash(), [], '恢复后回收站应清空')
  } finally {
    ctx.restore()
    await rm(join(ctx.home, '..'), { recursive: true, force: true })
  }
})

test('对照：另一个「可写但不可删」的来源（自定义目录）走的是同一道闸', async () => {
  const ctx = await withSkills()
  try {
    // 自定义目录是只读来源，删除会被「只读」拦下；这条用来确认两道闸的区别是有意的：
    // 只读来源 → error.root.readonly；可写但用户级 → error.skill.notDeletable。
    const customPath = join(ctx.home, 'skills-SuperWork')
    await mkdir(join(customPath, 'demo-custom'), { recursive: true })
    await writeFile(join(customPath, 'demo-custom', 'SKILL.md'), '---\nname: demo-custom\ndescription: c\n---\n\nbody\n', 'utf8')
    await addCustomRoot(customPath, 'SuperWork 测试目录')
    const key = customRootKey(customPath)
    const result = await deleteSkill({ key, path: customPath }, 'demo-custom')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'error.root.readonly', '只读来源仍然报 error.root.readonly')
    assert.equal(existsSync(join(customPath, 'demo-custom')), true, '只读来源的文件也不能被搬走')
  } finally {
    ctx.restore()
    await rm(join(ctx.home, '..'), { recursive: true, force: true })
  }
})
