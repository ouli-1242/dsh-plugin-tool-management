// test/hub-layout.test.mjs —— v0.4 统一数据目录（~/.dsh/tool-management/）+ 显式场景记录。
//
// 覆盖三件容易回归的事：
//   ① 旧布局（$DSH_HOME/scene-memory/ 与更旧的 $DSH_HOME/rules/）搬进 hub，且**不覆盖**已有目标；
//   ② 场景是显式记录：空场景存在、保留场景 global 恒在、global 不可删、子场景挡住父场景删除；
//   ③ 记忆必须落到已存在的场景里（不存在 → 明确报错，不静默造场景）。
//
// 跑 lib 编译产物，改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRulesService, GLOBAL_SCENE, GLOBAL_SCENE_LABEL } from '../lib/rules/service.js'
import { relocateEntries, pathExists } from '../lib/hub.js'

/** 起一个把记忆/场景/侧车都指到临时目录的 rules 服务（不碰真实 ~/.dsh）。 */
async function makeService() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-hub-'))
  const stateDir = join(base, 'tool-management')
  const rulesRoot = join(stateDir, 'memories')
  const scenesDir = join(stateDir, 'scenes')
  const service = createRulesService({}, { rulesRoot, stateDir, scenesDir })
  return { base, stateDir, rulesRoot, scenesDir, service }
}

const readIndex = async (stateDir) => JSON.parse(await readFile(join(stateDir, 'rules-index.json'), 'utf8'))

test('relocateEntries：搬移顶层条目、跳过隐藏项、目标已存在时不覆盖', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-hub-move-'))
  const from = join(base, 'old')
  const to = join(base, 'new')
  await mkdir(from, { recursive: true })
  await mkdir(to, { recursive: true })
  await writeFile(join(from, 'a.md'), 'A')
  await writeFile(join(from, '.hidden'), 'H')
  await writeFile(join(from, 'b.md'), 'OLD-B')
  await writeFile(join(to, 'b.md'), 'NEW-B')

  const moved = await relocateEntries(from, to)

  assert.equal(moved, 1, '只应搬 a.md（.hidden 跳过、b.md 已存在不覆盖）')
  assert.equal(await readFile(join(to, 'a.md'), 'utf8'), 'A')
  assert.equal(await readFile(join(to, 'b.md'), 'utf8'), 'NEW-B', '目标已有内容必须保留（绝不覆盖）')
  assert.equal(await pathExists(join(from, 'a.md')), false, '源文件应已搬走')
  assert.equal(await pathExists(join(from, '.hidden')), true, '隐藏项原地不动')
})

test('迁移：旧 scene-memory 的根层 .md → memories/global/，场景目录 → memories/<场景>/', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-hub-legacy-'))
  const dshHome = join(base, '.dsh')
  const legacy = join(dshHome, 'scene-memory')
  await mkdir(join(legacy, '办公'), { recursive: true })
  await writeFile(join(legacy, '总则.md'), '# 总则')
  await writeFile(join(legacy, '办公', '周报.md'), '# 周报')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    // 生产路径解析依赖 $DSH_HOME；这里让服务自行解析，以验证默认落点。
    const service = createRulesService({}, { rulesRoot: '', stateDir: '', scenesDir: '' })
    const r = await service.ops['rules-list']({})
    assert.equal(r.ok, true)

    assert.equal(existsSync(join(dshHome, 'tool-management', 'memories', 'global', '总则.md')), true, '根层记忆应迁入 global 场景')
    assert.equal(existsSync(join(dshHome, 'tool-management', 'memories', '办公', '周报.md')), true, '场景目录整体迁移')

    const byId = Object.fromEntries(r.rules.map((x) => [x.id, x]))
    assert.ok(byId['global/总则'], '迁移后的根层记忆 id 应为 global/总则')
    assert.ok(byId['办公/周报'])
    const scenes = Object.fromEntries(r.scenes.map((s) => [s.name, s]))
    assert.equal(scenes[GLOBAL_SCENE].label, GLOBAL_SCENE_LABEL)
    assert.equal(scenes[GLOBAL_SCENE].count, 1)
    assert.equal(scenes['办公'].count, 1)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

test('场景记录：保留场景 global 恒存在、空场景合法、创建带描述', async () => {
  const { stateDir, service } = await makeService()

  let r = await service.ops['rules-list']({})
  const names = r.scenes.map((s) => s.name)
  assert.deepEqual(names, [GLOBAL_SCENE], '一开始只有保留场景 global')
  assert.equal(r.scenes[0].label, GLOBAL_SCENE_LABEL)
  assert.equal(r.scenes[0].global, true)
  assert.equal(r.scenes[0].active, true, 'global 恒常参与注入')

  const created = await service.ops['rules-create-scene']({ name: '办公', description: '公司日常事务' })
  assert.equal(created.ok, true)
  assert.equal(created.scene.description, '公司日常事务')

  r = await service.ops['rules-list']({})
  const office = r.scenes.find((s) => s.name === '办公')
  assert.ok(office, '空场景（还没有记忆）也必须出现在场景列表里')
  assert.equal(office.count, 0)
  assert.equal(office.description, '公司日常事务')

  const index = await readIndex(stateDir)
  assert.equal(index.scenes['办公'].description, '公司日常事务')
  assert.equal(index.scenes[GLOBAL_SCENE].label, GLOBAL_SCENE_LABEL)
})

test('场景更新：改描述/标签；global 的显示名不可被改掉', async () => {
  const { service } = await makeService()
  await service.ops['rules-create-scene']({ name: '办公' })

  const up = await service.ops['rules-update-scene']({ name: '办公', description: '新的说明', label: 'Office' })
  assert.equal(up.ok, true)
  assert.equal(up.scene.description, '新的说明')
  assert.equal(up.scene.label, 'Office')

  const cleared = await service.ops['rules-update-scene']({ name: '办公', description: '' })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.scene.description, undefined, '空描述 = 清掉该字段')

  const g = await service.ops['rules-update-scene']({ name: GLOBAL_SCENE, label: '随便改' })
  assert.equal(g.ok, true)
  assert.equal(g.scene.label, GLOBAL_SCENE_LABEL, '保留场景的显示名固定为「全局」')

  const missing = await service.ops['rules-update-scene']({ name: '不存在' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'error.rules.notFound')
})

test('记忆写入：必须落到已存在的场景；留空 = 保留场景 global', async () => {
  const { service } = await makeService()

  const orphan = await service.ops['rules-create']({ group: '还没建的场景', name: 'x', body: '正文' })
  assert.equal(orphan.ok, false)
  assert.equal(orphan.code, 'error.rules.sceneNotFound', '不存在的场景必须明确报错，而不是静默造场景')

  const g = await service.ops['rules-create']({ group: '', name: '总则', body: '全局记忆正文' })
  assert.equal(g.ok, true)
  assert.equal(g.rule.id, `${GLOBAL_SCENE}/总则`, '留空场景落到保留场景 global')

  await service.ops['rules-create-scene']({ name: '办公' })
  // 单选模型：新建场景默认不启用，显式启用后才进投影。
  await service.patchIndex({ active: ['办公'] })
  const ok = await service.ops['rules-create']({ group: '办公', name: '周报', body: '办公记忆正文' })
  assert.equal(ok.ok, true)
  assert.equal(ok.rule.id, '办公/周报')

  // 投影：global 恒注入；已启用的办公场景也注入。
  const budget = await service.ops['rules-budget']({})
  assert.match(budget.items.map((i) => i.id).join(','), /global\/总则/)
  assert.match(budget.items.map((i) => i.id).join(','), /办公\/周报/)
})

test('删除场景：global 不可删；有记忆/不存在都要明确报错；空场景可删并清掉记录', async () => {
  const { service } = await makeService()

  const g = await service.ops['rules-remove-scene']({ name: GLOBAL_SCENE })
  assert.equal(g.ok, false)
  assert.equal(g.code, 'error.rules.reservedScene')

  const missing = await service.ops['rules-remove-scene']({ name: '查无此场景' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'error.rules.notFound')

  // 场景名是单个路径段：多段名在创建与删除两侧口径一致，都判非法。
  assert.equal((await service.ops['rules-create-scene']({ name: '团队/前端' })).ok, false)
  assert.equal((await service.ops['rules-remove-scene']({ name: '团队/前端' })).code, 'error.rules.invalidGroup')

  await service.ops['rules-create-scene']({ name: '团队' })
  await service.ops['rules-create']({ group: '团队', name: '周报', body: '正文' })
  const nonEmpty = await service.ops['rules-remove-scene']({ name: '团队' })
  assert.equal(nonEmpty.ok, false)
  assert.equal(nonEmpty.code, 'error.rules.sceneNotEmpty', '场景里还有记忆时不可删')

  assert.equal((await service.ops['rules-remove']({ id: '团队/周报' })).ok, true)
  assert.equal((await service.ops['rules-remove-scene']({ name: '团队' })).ok, true)
  const r = await service.ops['rules-list']({})
  assert.equal(r.scenes.some((s) => s.name === '团队'), false, '场景记录应随目录一起删除')
})

test('体检：没有归属场景的记忆（直接放在 memories/ 根层）必须被报出来', async () => {
  const { rulesRoot, service } = await makeService()
  await mkdir(rulesRoot, { recursive: true })
  await writeFile(join(rulesRoot, '游离.md'), '---\nname: 游离\ndescription: 没有场景\n---\n\n正文\n')

  const d = await service.ops['rules-diagnose']({})
  assert.equal(d.ok, true)
  const issue = d.issues.find((i) => i.code === 'noScene')
  assert.ok(issue, '游离记忆应有 noScene 告警（否则它是静默失效的数据）')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.ruleId, '游离')

  // 它也不该进入投影（没有归属场景 = 不注入）。
  const budget = await service.ops['rules-budget']({})
  assert.equal(budget.items.some((i) => i.id === '游离'), false)
})

test('导入：引用到的场景自动补记录并回传，路径落进 memories/<场景>/', async () => {
  const { stateDir, rulesRoot, service } = await makeService()
  // 上传契约：HTTP 端把文件体转成 base64（`data` 字段），见 imports/upload.ts decodeBase64。
  const data = Buffer.from('---\nname: 新记忆\ndescription: 导入的\n---\n\n正文\n', 'utf8').toString('base64')

  const r = await service.ops['rules-import']({ scene: '导入场景', files: [{ name: '新记忆.md', data }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.imported, ['导入场景/新记忆'])
  assert.deepEqual(r.scenes, ['导入场景'], '被补出来的场景要回传给 UI，不能静默')

  const index = await readIndex(stateDir)
  assert.ok(index.scenes['导入场景'])
  assert.equal(existsSync(join(rulesRoot, '导入场景', '新记忆.md')), true)
})

test('空状态：全新目录下服务可用（段为空、无异常），并建出 global 目录', async () => {
  const { rulesRoot, service } = await makeService()
  const r = await service.ops['rules-list']({})
  assert.equal(r.ok, true)
  assert.deepEqual(r.rules, [])
  const budget = await service.ops['rules-budget']({})
  assert.equal(budget.usedBytes, 0)
  assert.equal(budget.truncated, false)
  assert.equal(existsSync(join(rulesRoot, GLOBAL_SCENE)), true, '首次读盘就该把 global 场景目录建出来')
  await rm(join(rulesRoot, GLOBAL_SCENE), { recursive: true, force: true })
})

test('paths：rules-list 回传真实目录，供 UI 显示（不再由界面硬编码 scene-memory）', async () => {
  const { stateDir, rulesRoot, scenesDir, service } = await makeService()
  const r = await service.ops['rules-list']({})
  assert.equal(r.paths.memories, rulesRoot)
  assert.equal(r.paths.scenes, scenesDir)
  assert.equal(r.paths.hub, stateDir)
  assert.equal((await stat(rulesRoot)).isDirectory(), true)
})

test('记忆勾选（档案 memories 段）：只注入勾选的记忆，文件不动', async () => {
  const { stateDir, service } = await makeService()
  await service.ops['rules-create-scene']({ name: '办公' })
  await service.ops['rules-create']({ group: '办公', name: '甲', body: '甲正文' })
  await service.ops['rules-create']({ group: '办公', name: '乙', body: '乙正文' })
  // 单选模型：新建场景默认不启用；不启用就没有「没段 = 全部注入」这回事。
  await service.patchIndex({ active: ['办公'] })

  const before = await service.ops['rules-budget']({})
  // 顺序由渲染顺序决定（场景 order → 记忆 order/名称），locale 相关 → 比较集合而非顺序。
  assert.deepEqual(before.items.map((i) => i.id).sort(), ['办公/甲', '办公/乙'].sort(), '没有 memories 段时两条都注入')

  // 只勾甲：段已定义 → 乙不进系统提示词。
  await service.patchIndex({ archives: { 办公: { memories: ['办公/甲'] } } })
  const after = await service.ops['rules-budget']({})
  assert.deepEqual(after.items.map((i) => i.id), ['办公/甲'])

  // 勾选只影响投影：两条记忆文件都还在，列表里也都还在。
  const listed = await service.ops['rules-list']({})
  assert.deepEqual(listed.rules.map((x) => x.id).sort(), ['办公/甲', '办公/乙'].sort())
  assert.equal(existsSync(join(stateDir, 'memories', '办公', '乙.md')), true)

  // 段清空 = 该场景记忆全部不注入（与其余段「已定义但空 = 全部停用」同构）。
  await service.patchIndex({ archives: { 办公: { memories: [] } } })
  assert.deepEqual((await service.ops['rules-budget']({})).items, [])

  // 移掉段 → 回到「不碰」。
  await service.patchIndex({ archives: {} })
  assert.deepEqual((await service.ops['rules-budget']({})).items.map((i) => i.id).sort(), ['办公/甲', '办公/乙'].sort())
})

test('保留场景 global 的记忆不受其它场景的勾选段影响（global 恒定注入）', async () => {
  const { service } = await makeService()
  await service.ops['rules-create']({ group: '', name: '总则', body: '总则正文' })
  await service.ops['rules-create-scene']({ name: '办公' })
  await service.ops['rules-create']({ group: '办公', name: '甲', body: '甲正文' })

  // 办公场景启用后，它的段把记忆收窄为「一条都不勾」：办公的记忆不注入，global 的仍注入。
  // （不启用时这条断言会碰巧通过——办公的记忆本就不会注入——所以必须显式启用。）
  await service.patchIndex({ active: ['办公'], archives: { 办公: { memories: [] } } })
  const items = (await service.ops['rules-budget']({})).items.map((i) => i.id)
  assert.deepEqual(items, [GLOBAL_SCENE + '/总则'], 'global 是恒定注入的保留场景')
})
