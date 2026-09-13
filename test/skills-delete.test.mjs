// test/skills-delete.test.mjs —— 「哪些技能可以删」的契约。
//
// 产品裁定（用户要求）：
//   - 用户级来源 **DSH 技能 / 导入技能**（`~/.dsh/skills/`、`~/.dsh/tool-management/skills/`）
//     **不可删除** —— 技能只能停用，避免把用户自己放进去的技能从磁盘上搬走；
//   - 删除只对**项目级来源**（`<项目>/.dsh/skills`）开放。
//
// 这里守两件事：① 来源定义上的可删除位正确；② 真的调用删除时**在碰文件之前**就拒绝。
//
// 跑 lib 编译产物；改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSkill, userRoots, customRootKey, addCustomRoot } from '../lib/skills/core.js'

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

test('来源定义：用户级 dsh / hub 可写但不可删；可写性不受影响', () => {
  const roots = userRoots()
  const byKey = Object.fromEntries(roots.map((r) => [r.key, r]))
  for (const key of ['dsh', 'hub']) {
    assert.ok(byKey[key], `缺少来源 ${key}`)
    assert.equal(byKey[key].mutable, true, `${key} 应该仍可写（要能在这里创建/导入技能）`)
    assert.notEqual(byKey[key].deletable, true, `${key} 不应标记为可删除`)
  }
  // 其余来源（外部目录）本来就不能删
  for (const root of roots) {
    if (root.scope === 'project') continue
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

test('删除被拒：dsh / hub 在碰文件之前就返回 error.skill.notDeletable', async () => {
  const ctx = await withSkills()
  try {
    const before = await readFile(join(ctx.dshSkill, 'SKILL.md'), 'utf8')
    for (const target of ctx.targets) {
      const result = await deleteSkill(target.root, target.name)
      assert.equal(result.ok, false, `${target.root.key}: 删除必须被拒绝`)
      assert.equal(
        result.code,
        'error.skill.notDeletable',
        `${target.root.key}: 错误码应为 error.skill.notDeletable（实际 ${result.code}）`,
      )
      assert.ok(result.error && result.error.length > 0, `${target.root.key}: 拒绝要带可读原因`)
    }
    // 文件必须原地不动（连回收站都不该出现）
    assert.equal(existsSync(ctx.dshSkill), true, 'DSH 技能目录不能被搬走')
    assert.equal(existsSync(ctx.hubSkill), true, '导入技能目录不能被搬走')
    assert.equal(await readFile(join(ctx.dshSkill, 'SKILL.md'), 'utf8'), before, '内容不能被改动')
    assert.equal(existsSync(join(ctx.home, 'tool-management', 'trash')), false, '不该产生回收站条目')
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
