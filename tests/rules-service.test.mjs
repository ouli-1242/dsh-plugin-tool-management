// tests/rules-service.test.mjs — 规则/记忆（Rules v0.2）服务层单元测试。
// 直接 import 编译产物 lib/rules/service.js 的纯逻辑（不依赖 ctx，provider 不测）。
// 每个测试使用独立 mkdtemp 临时目录作为 rulesRoot / stateDir / AGENTS.md 目标，
// 结束清理。运行：npm run build && node --test tests/rules-service.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRulesService } from '../lib/rules/service.js'

function setup(options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-rules-'))
  const rulesRoot = join(base, 'rules')
  const stateDir = join(base, 'state')
  const agentsMd = join(base, 'dsh', 'AGENTS.md')
  mkdirSync(rulesRoot, { recursive: true })
  const deps = {
    rulesRoot,
    stateDir,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    getGlobalAgentsMdPath: async () => agentsMd,
  }
  const service = createRulesService({}, deps)
  return { base, rulesRoot, stateDir, agentsMd, service }
}

const cleanup = (t) => { try { rmSync(t.base, { recursive: true, force: true }) } catch { /* best effort */ } }

/** 写 flat 规则（frontmatter 为不含 `---` 包裹的行）。 */
function writeFlat(root, group, name, frontmatter, body = 'body text') {
  const dir = join(root, group)
  mkdirSync(dir, { recursive: true })
  const text = frontmatter ? `---\n${frontmatter}\n---\n${body}` : body
  writeFileSync(join(dir, name + '.md'), text, 'utf8')
}

/** 写 bundle 规则 <group>/<name>/SKILL.md。 */
function writeBundle(root, group, name, frontmatter, body = 'body text') {
  const dir = join(root, group, name)
  mkdirSync(dir, { recursive: true })
  const text = frontmatter ? `---\n${frontmatter}\n---\n${body}` : body
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
}

test('1. 递归发现：多层子目录 flat + bundle 规则都被发现', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, 'web/frontend', 'form-validation', 'name: form-validation\ndescription: 表单校验', 'f body')
    writeFlat(t.rulesRoot, 'web/frontend', 'mask-input', 'name: mask-input\ndescription: 掩码输入', 'm body')
    writeBundle(t.rulesRoot, 'web', 'color-system', 'name: color-system\ndescription: 配色系统', 'c body')
    const r = await t.service.ops['rules-list']({})
    assert.equal(r.ok, true)
    const ids = r.rules.map((x) => x.id).sort()
    assert.deepEqual(ids, ['web/color-system', 'web/frontend/form-validation', 'web/frontend/mask-input'])
    const fs = r.rules.find((x) => x.id === 'web/frontend/form-validation')
    assert.equal(fs.group, 'web/frontend')
    assert.equal(fs.form, 'flat')
    const bundle = r.rules.find((x) => x.id === 'web/color-system')
    assert.equal(bundle.group, 'web')
    assert.equal(bundle.form, 'bundle')
    assert.deepEqual(r.groups.map((g) => g.name).sort(), ['web', 'web/frontend'])
    assert.equal(r.groups.find((g) => g.name === 'web/frontend').count, 2)
  } finally { cleanup(t) }
})

test('2. 隐藏目录跳过、非 .md 忽略', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, '.hidden', 'secret', 'description: 不该被发现', 's')
    mkdirSync(join(t.rulesRoot, 'git'), { recursive: true })
    writeFileSync(join(t.rulesRoot, 'git', 'notes.txt'), 'not a rule', 'utf8') // 非 .md 忽略
    writeFlat(t.rulesRoot, 'git', 'commit-msg', 'description: 提交信息', 'c')
    const r = await t.service.ops['rules-list']({})
    assert.equal(r.ok, true)
    const ids = r.rules.map((x) => x.id)
    assert.deepEqual(ids, ['git/commit-msg'])
  } finally { cleanup(t) }
})

test('3. 无 frontmatter 文件派生：name=文件名、description=首个标题、descriptionDerived=true', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, 'misc', 'hello', '', '# 你好规则\n\nsome body lines')
    const r = await t.service.ops['rules-list']({})
    assert.equal(r.ok, true)
    const rule = r.rules.find((x) => x.id === 'misc/hello')
    assert.equal(rule.name, 'hello')
    assert.equal(rule.description, '你好规则')
    assert.equal(rule.descriptionDerived, true)
  } finally { cleanup(t) }
})

test('4. bundle 优先：同名 flat + bundle → bundle 存在，flat shadowed:true', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, 'git', 'commit', 'description: flat 版本', 'flat body')
    writeBundle(t.rulesRoot, 'git', 'commit', 'description: bundle 版本', 'bundle body')
    const r = await t.service.ops['rules-list']({})
    assert.equal(r.ok, true)
    const main = r.rules.find((x) => x.id === 'git/commit' && x.form === 'bundle')
    assert.ok(main, 'bundle 主条目应存在')
    assert.equal(main.description, 'bundle 版本')
    assert.equal(main.shadowed, undefined)
    const shadowed = r.rules.find((x) => x.id === 'git/commit' && x.form === 'flat')
    assert.ok(shadowed, 'shadowed flat 应作为独立条目列出（UI 标红）')
    assert.equal(shadowed.shadowed, true)
    assert.equal(shadowed.description, 'flat 版本')
  } finally { cleanup(t) }
})

test('5. flat 文件名 ≠ frontmatter name → 发现可列出，更新时拒绝 invalidName', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, 'git', 'foo', 'name: bar\ndescription: 声明名与文件名不一致', 'body')
    const list = await t.service.ops['rules-list']({})
    assert.equal(list.ok, true)
    const listed = list.rules.find((x) => x.id === 'git/foo')
    assert.ok(listed, '发现时该文件仍可列出')
    assert.equal(listed.name, 'bar') // frontmatter 声明名优先
    const upd = await t.service.ops['rules-update']({ id: 'git/foo', body: 'new body' })
    assert.equal(upd.ok, false)
    assert.equal(upd.code, 'error.rules.invalidName')
  } finally { cleanup(t) }
})

test('6. description >500 拒绝（descriptionTooLong）', async () => {
  const t = setup()
  try {
    const r = await t.service.ops['rules-create']({ group: 'g', name: 'r', description: 'x'.repeat(501), body: 'body' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'error.rules.descriptionTooLong')
  } finally { cleanup(t) }
})

test('7. 正文 >256KiB 拒绝（tooLarge）', async () => {
  const t = setup()
  try {
    const r = await t.service.ops['rules-create']({ group: 'g', name: 'r', description: 'd', body: 'x'.repeat((1 << 18) + 1) })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'error.rules.tooLarge')
    // 256KiB 恰好不超限（用 ASCII，256KiB = 262144 字节）
    const ok = await t.service.ops['rules-create']({ group: 'g', name: 'r', description: 'd', body: 'x'.repeat(1 << 18) })
    assert.equal(ok.ok, true)
  } finally { cleanup(t) }
})

test('8. group 名非法拒绝（invalidGroup）', async () => {
  const t = setup()
  try {
    for (const bad of ['Bad Group', 'a..b', 'a/b..c', '1'.repeat(65), '-lead', 'sub/-lead']) {
      const r = await t.service.ops['rules-create']({ group: bad, name: 'r', description: 'd', body: 'body' })
      assert.equal(r.ok, false, `group=${bad} 应拒绝`)
      assert.equal(r.code, 'error.rules.invalidGroup', `group=${bad}`)
    }
    // 合法多层分组可创建
    const ok = await t.service.ops['rules-create']({ group: 'web/frontend', name: 'form', description: 'd', body: 'body' })
    assert.equal(ok.ok, true)
  } finally { cleanup(t) }
})

test('9. CRUD 往返：create → list → read → update → remove → restore 逐字节一致', async () => {
  const t = setup()
  try {
    const c = await t.service.ops['rules-create']({ group: 'git', name: 'commit-msg', description: '提交信息', body: 'body line 1\nbody line 2' })
    assert.equal(c.ok, true)
    assert.equal(c.rule.id, 'git/commit-msg')
    const listed = await t.service.ops['rules-list']({})
    assert.equal(listed.rules.some((x) => x.id === 'git/commit-msg'), true)
    const rd = await t.service.ops['rules-read']({ id: 'git/commit-msg' })
    assert.equal(rd.ok, true)
    assert.equal(rd.rule.body, 'body line 1\nbody line 2')
    assert.equal(rd.rule.description, '提交信息')
    const fileBeforeUpdate = readFileSync(join(t.rulesRoot, 'git', 'commit-msg.md'), 'utf8')
    const u = await t.service.ops['rules-update']({ id: 'git/commit-msg', body: 'updated body' })
    assert.equal(u.ok, true)
    assert.equal(u.rule.id, 'git/commit-msg')
    const rd2 = await t.service.ops['rules-read']({ id: 'git/commit-msg' })
    assert.equal(rd2.rule.body, 'updated body')
    assert.equal(rd2.rule.description, '提交信息') // description 保留
    // 删除前先记录文件内容（update 后的），恢复后应逐字节一致
    const afterUpdate = readFileSync(join(t.rulesRoot, 'git', 'commit-msg.md'), 'utf8')
    assert.notEqual(afterUpdate, fileBeforeUpdate) // update 确实改了文件
    const rm = await t.service.ops['rules-remove']({ id: 'git/commit-msg' })
    assert.equal(rm.ok, true)
    assert.equal(typeof rm.trashId, 'string')
    assert.ok(rm.trashId.length > 0)
    assert.equal(existsSync(join(t.rulesRoot, 'git', 'commit-msg.md')), false)
    const rest = await t.service.ops['rules-restore']({ trashId: rm.trashId })
    assert.equal(rest.ok, true)
    assert.equal(rest.rule.id, 'git/commit-msg')
    const afterRestore = readFileSync(join(t.rulesRoot, 'git', 'commit-msg.md'), 'utf8')
    assert.equal(afterRestore, afterUpdate) // 逐字节一致
    assert.equal(existsSync(join(t.stateDir, 'rules-trash', rm.trashId)), false) // 回收站条目已移走
  } finally { cleanup(t) }
})

test('10. 索引：文件存在无记录按默认投影；索引有记录文件已删则清理', async () => {
  const t = setup()
  try {
    writeFlat(t.rulesRoot, 'misc', 'plain', 'description: 朴素规则', 'body')
    const r1 = await t.service.ops['rules-list']({})
    const plain = r1.rules.find((x) => x.id === 'misc/plain')
    assert.equal(plain.enabled, true)
    assert.equal(plain.always, false)
    assert.equal(plain.order, 1000)
    // 索引有记录后删文件 → list 清理记录
    const c = await t.service.ops['rules-create']({ group: 'misc', name: 'doomed', description: '将删除', body: 'body' })
    assert.equal(c.ok, true)
    const idxPath = join(t.stateDir, 'rules-index.json')
    assert.ok(readFileSync(idxPath, 'utf8').includes('misc/doomed'))
    rmSync(join(t.rulesRoot, 'misc', 'doomed.md'))
    await t.service.refresh() // 失效快照缓存后再 list，验证索引清理
    const r2 = await t.service.ops['rules-list']({})
    assert.equal(r2.rules.some((x) => x.id === 'misc/doomed'), false)
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'))
    assert.equal(idx.rules['misc/doomed'], undefined)
  } finally { cleanup(t) }
})

test('11. scenes.json 损坏 → 只读 _shared 不抛错', async () => {
  const t = setup()
  try {
    mkdirSync(t.stateDir, { recursive: true })
    writeFileSync(join(t.stateDir, 'scenes.json'), '{ not valid json', 'utf8')
    writeFlat(t.rulesRoot, '_shared', 'common', 'description: 通用规则', 'c')
    writeFlat(t.rulesRoot, 'work', 'task', 'description: 任务规则', 't')
    const projected = await t.service._listProjected('some-preset')
    assert.deepEqual(projected.map((x) => x.name).sort(), ['common'])
    // 未命中 preset（scenes 正常但无该 preset）同样退化 _shared
    writeFileSync(join(t.stateDir, 'scenes.json'), JSON.stringify({ version: 1, includeSharedDefault: true, presets: { code: { groups: ['work'] } } }), 'utf8')
    const projected2 = await t.service._listProjected('other-preset')
    assert.deepEqual(projected2.map((x) => x.name).sort(), ['common'])
    // 命中 preset：groups ∪ _shared
    const projected3 = await t.service._listProjected('code')
    assert.deepEqual(projected3.map((x) => x.name).sort(), ['common', 'task'])
  } finally { cleanup(t) }
})

test('12. 始终层：确定性排序、预算超限拒绝且不写文件、段替换保留既有内容', async () => {
  const t = setup()
  try {
    const c1 = await t.service.ops['rules-create']({ group: 'base', name: 'rule-a', description: '规则 A', body: 'AAA body', always: true })
    const c2 = await t.service.ops['rules-create']({ group: 'base', name: 'rule-b', description: '规则 B', body: 'BBB body', always: true })
    assert.equal(c1.ok, true)
    assert.equal(c2.ok, true)
    const content1 = readFileSync(t.agentsMd, 'utf8')
    assert.ok(content1.includes('<!-- generated by dsh-plugin-tool-management'))
    assert.ok(content1.includes('## 规则 A\n\nAAA body'))
    assert.ok(content1.includes('## 规则 B\n\nBBB body'))
    // 确定性：refresh 后字节一致（无时间戳/计数）
    await t.service.refresh()
    const content2 = readFileSync(t.agentsMd, 'utf8')
    assert.equal(content1, content2)
    // 排序：order 影响顺序
    await t.service.ops['rules-set-index']({ id: 'base/rule-b', order: 10 })
    await t.service.ops['rules-set-index']({ id: 'base/rule-a', order: 20 })
    await t.service.refresh()
    const content3 = readFileSync(t.agentsMd, 'utf8')
    assert.ok(content3.indexOf('## 规则 B') < content3.indexOf('## 规则 A'))

    // 段替换：文件含既有无关内容时保留
    writeFileSync(t.agentsMd, '# 我的全局指令\n\n用户内容\n\n' + content1 + '\n# 结尾大章节\n尾部\n', 'utf8')
    await t.service.refresh()
    const merged = readFileSync(t.agentsMd, 'utf8')
    assert.ok(merged.startsWith('# 我的全局指令\n\n用户内容'))
    assert.ok(merged.includes('# 结尾大章节\n尾部'))
    assert.ok(merged.includes('## 规则 A\n\nAAA body'))

    // 预算超限拒绝且不写文件
    const t2 = setup({ maxBytes: 64 })
    try {
      const blocked = await t2.service.ops['rules-create']({ group: 'g', name: 'big', description: '大规则', body: 'x'.repeat(200), always: true })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.code, 'error.rules.budgetExceeded')
      assert.equal(existsSync(join(t2.rulesRoot, 'g', 'big.md')), false, '超限时规则文件不应写入')
      assert.equal(existsSync(t2.agentsMd), false, '超限时 AGENTS.md 不应写入')
    } finally { cleanup(t2) }
  } finally { cleanup(t) }
})

test('13. rules-toggle always:true 后始终层出现该规则', async () => {
  const t = setup()
  try {
    const c = await t.service.ops['rules-create']({ group: 'g', name: 'persist', description: '常驻规则', body: '常驻正文' })
    assert.equal(c.ok, true)
    assert.equal(c.rule.always, false)
    assert.equal(existsSync(t.agentsMd), false, '无 always 规则时不写 AGENTS.md')
    const tg = await t.service.ops['rules-toggle']({ id: 'g/persist', always: true })
    assert.equal(tg.ok, true)
    assert.equal(tg.rule.always, true)
    const content = readFileSync(t.agentsMd, 'utf8')
    assert.ok(content.includes('## 常驻规则\n\n常驻正文'))
    // 再关掉 → 段移除（always 为空 → 不触碰文件？此处验证 toggle 后索引状态）
    const tg2 = await t.service.ops['rules-toggle']({ id: 'g/persist', always: false })
    assert.equal(tg2.ok, true)
    assert.equal(tg2.rule.always, false)
    // 关闭后重新 toggle enabled 不影响始终层
    const tg3 = await t.service.ops['rules-toggle']({ id: 'g/persist', enabled: false })
    assert.equal(tg3.ok, true)
    assert.equal(tg3.rule.enabled, false)
  } finally { cleanup(t) }
})
