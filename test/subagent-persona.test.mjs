// test/subagent-persona.test.mjs —— 人设 frontmatter 解析/序列化的往返契约（node --test）。
//
// 锁的点：`provider` 与 `model` 是模型路由的两半（DSH 的 resolveModel(provider, model)
// 不做 `provider/model` 字符串拆分），UI 保存与文件重读两侧都不能丢——否则跨来源指定模型
// （如 sensenova 的 sensenova-6.8-flash-lite）会静默落回主会话的 provider 并解析失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePersona, serializePersona, createSubagentService } from '../lib/subagents/service.js'

const doc = (raw, name = 'p') => parsePersona(raw, name)

test('parsePersona：description / provider / model / tools 四个键都认', () => {
  const d = doc('---\ndescription: 一句话\nprovider: sensenova\nmodel: sensenova-6.8-flash-lite\ntools: read_file, glob\n---\n\n正文\n')
  assert.equal(d.description, '一句话')
  assert.equal(d.provider, 'sensenova')
  assert.equal(d.model, 'sensenova-6.8-flash-lite')
  assert.deepEqual(d.tools, ['read_file', 'glob'])
  assert.equal(d.body, '正文')
})

test('parsePersona：未知键忽略；无 frontmatter 时描述取正文首行', () => {
  const withUnknown = doc('---\nfoo: bar\nmodel: m1\n---\n\n正文\n')
  assert.equal(withUnknown.model, 'm1')
  assert.equal(withUnknown.provider, undefined)
  const plain = doc('\n\n第一行是描述\n第二行\n')
  assert.equal(plain.description, '第一行是描述')
  assert.equal(plain.body, '第一行是描述\n第二行')
  assert.equal(plain.model, undefined)
})

test('parsePersona：tools 支持中英文逗号与空白', () => {
  assert.deepEqual(doc('---\ntools: a, b，c ,  \n---\n\nx\n').tools, ['a', 'b', 'c'])
})

test('serializePersona：只写填过的键，provider 排在 model 之前', () => {
  const text = serializePersona({ description: 'd', provider: 'sensenova', model: 'm', tools: ['a', 'b'], body: 'B' })
  assert.equal(text, '---\ndescription: d\nprovider: sensenova\nmodel: m\ntools: a, b\n---\n\nB\n')
  assert.equal(serializePersona({ body: 'only body' }), '---\n---\n\nonly body\n')
})

test('往返（UI 保存 → 重读）不丢 provider/model/tools/description', () => {
  const args = { description: '跨来源', provider: 'sensenova', model: 'sensenova-6.8-flash-lite', tools: ['read_file'], body: '人设正文' }
  const back = doc(serializePersona(args))
  assert.equal(back.description, args.description)
  assert.equal(back.provider, args.provider)
  assert.equal(back.model, args.model)
  assert.deepEqual(back.tools, args.tools)
  assert.equal(back.body, '人设正文')
})

test('往返：只给 model（继承主会话 provider）时 provider 保持缺省', () => {
  const back = doc(serializePersona({ description: 'd', model: 'deepseek-flash', body: 'B' }))
  assert.equal(back.model, 'deepseek-flash')
  assert.equal(back.provider, undefined)
})

test('parsePersona / serializePersona：工具黑名单 toolsDeny 往返不丢', () => {
  const back = doc(serializePersona({ description: 'd', tools: ['read_file'], toolsDeny: ['bash', 'pwsh'], body: 'B' }))
  assert.deepEqual(back.tools, ['read_file'])
  assert.deepEqual(back.toolsDeny, ['bash', 'pwsh'])
})

test('create 会在目录不存在时把它建出来（v0.4 人设搬到 hub 内的新目录）', async () => {
  // 回归点：活体验收时 subagent-create 直接 ENOENT —— 旧目录 $DSH_HOME/subagents/ 一直有人建，
  // 换成 hub 内的 agents/ 后全新安装并不存在这个目录，写入前必须先 mkdir。
  const base = await mkdtemp(join(tmpdir(), 'dsh-persona-'))
  const dir = join(base, 'tool-management', 'agents')
  const svc = createSubagentService({}, { subagentsDir: dir })

  const created = await svc.ops['subagent-create']({ name: 'probe', description: 'd', tools: ['read_file'], toolsDeny: ['bash'], body: 'B' })
  assert.equal(created.ok, true, '目录不存在时创建应成功（不存在则自动建）')

  const files = await readdir(dir)
  assert.deepEqual(files, ['probe.md'])
  const raw = await readFile(join(dir, 'probe.md'), 'utf8')
  assert.match(raw, /toolsDeny: bash/)

  // 读回：黑名单从文件里真的被解析回来（不是只写不读）。
  const got = await svc.ops['subagent-get']({ name: 'probe' })
  assert.equal(got.ok, true)
  assert.deepEqual(got.persona.tools, ['read_file'])
  assert.deepEqual(got.persona.toolsDeny, ['bash'])

  // 重名仍拒绝（mkdir 不该把「已存在」检查挤掉）。
  const again = await svc.ops['subagent-create']({ name: 'probe', description: 'd', body: 'B' })
  assert.equal(again.ok, false)
  assert.match(again.error, /已存在/)
})
