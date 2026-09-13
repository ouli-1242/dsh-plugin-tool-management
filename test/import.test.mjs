// test/import.test.mjs —— 导入通道纯逻辑冒烟（node --test）。跑 lib 编译产物，改 src 后先 npm run build。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import {
  normalizeEntryPath,
  isZipBytes,
  expandUploads,
  planPersonaImport,
  planMemoryImport,
  isValidImportName,
  isValidImportGroup,
} from '../lib/imports/upload.js'

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const uploaded = (name, text) => ({ name, data: b64(text) })
const zipUpload = (name, files) => ({
  name,
  data: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])))).toString('base64'),
})

test('normalizeEntryPath: 反斜杠归一、丢弃 . 与空段；绝对路径/.. 穿越/隐藏项 → null', () => {
  assert.equal(normalizeEntryPath('a\\b.md'), 'a/b.md')
  assert.equal(normalizeEntryPath('./a//b.md'), 'a/b.md')
  assert.equal(normalizeEntryPath('/etc/passwd'), null)
  assert.equal(normalizeEntryPath('C:\\tmp\\x.md'), null)
  assert.equal(normalizeEntryPath('a/../../x.md'), null)
  assert.equal(normalizeEntryPath('.hidden/x.md'), null)
  assert.equal(normalizeEntryPath(''), null)
})

test('isZipBytes: 认魔数不认扩展名', () => {
  assert.equal(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), true)
  assert.equal(isZipBytes(new Uint8Array([0x23, 0x20, 0x68])), false)
  assert.equal(isZipBytes(new Uint8Array([0x50, 0x4b])), false)
})

test('expandUploads: .md 直通；非 .md 报问题；zip 展开只取 .md 且过滤非法路径', () => {
  const r = expandUploads([
    uploaded('人设A.md', '# A'),
    uploaded('notes.txt', 'x'),
    zipUpload('pack.zip', {
      'scene-a/memo.md': '# memo',
      'scene-a/SKILL.md': '# bundle',
      'deep/nested/other.MD': '# upper',
      'readme.txt': 'skip me',
    }),
  ])
  assert.deepEqual(r.entries.map((e) => e.path).sort(), ['deep/nested/other.MD', 'scene-a/SKILL.md', 'scene-a/memo.md', '人设A.md'])
  assert.deepEqual(r.problems.map((p) => p.name), ['notes.txt'])
})

test('expandUploads: 空内容与超量文件只记问题，不阻断同批', () => {
  const r = expandUploads([uploaded('empty.md', ''), uploaded('ok.md', '# ok')])
  assert.deepEqual(r.entries.map((e) => e.path), ['ok.md'])
  assert.deepEqual(r.problems, [{ name: 'empty.md', reason: '内容为空' }])
})

test('planPersonaImport: 只看文件名（zip 目录层级忽略）；同批次重名与非法名跳过', () => {
  const r = planPersonaImport([
    { path: 'pack/a/code-review.md', bytes: new Uint8Array([1]) },
    { path: 'b/java-expert.md', bytes: new Uint8Array([2]) },
    { path: 'b/java-expert.md', bytes: new Uint8Array([3]) },
    { path: 'bad/na:me.md', bytes: new Uint8Array([4]) },
  ])
  assert.deepEqual(r.targets.map((t) => t.name), ['code-review', 'java-expert'])
  assert.deepEqual(r.problems.map((p) => p.reason), ['同批次重名，已跳过', '人设名不合法（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）'])
})

test('planMemoryImport: zip 内目录当场景；裸 .md 落默认场景；空默认 = 全局；SKILL.md 跳过', () => {
  const nested = planMemoryImport([
    { path: 'work/standup.md', bytes: new Uint8Array([1]) },
    { path: 'work/deep/todo.md', bytes: new Uint8Array([2]) },
    { path: 'loose.md', bytes: new Uint8Array([3]) },
  ], '在线')
  assert.deepEqual(nested.targets.map((t) => `${t.group}|${t.name}`), ['work|standup', 'work/deep|todo', '在线|loose'])

  const globalOnly = planMemoryImport([{ path: 'loose.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(globalOnly.targets.map((t) => `${t.group}|${t.name}`), ['|loose'])

  const bundle = planMemoryImport([{ path: 'work/SKILL.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(bundle.targets, [])
  assert.match(bundle.problems[0].reason, /bundle 形态/)
})

test('planMemoryImport: 场景名非法（含路径分隔符等）整条跳过', () => {
  const r = planMemoryImport([{ path: 'bad:scene/x.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(r.targets, [])
  assert.deepEqual(r.problems.map((p) => p.reason), ['场景名不合法，已跳过'])
})

test('端到端（同一批）：zip → 展开 → 记忆落点规划', () => {
  const { entries, problems } = expandUploads([
    zipUpload('memories.zip', { '工作/standup.md': '# 站会', 'global-note.md': '# 全局' }),
  ])
  const planned = planMemoryImport(entries, '')
  assert.deepEqual(problems, [])
  assert.deepEqual(planned.targets.map((t) => `${t.group}|${t.name}`).sort(), ['|global-note', '工作|standup'])
})

test('isValidImportGroup: 空串（全局）合法；多级路径逐段校验', () => {
  assert.equal(isValidImportGroup(''), true)
  assert.equal(isValidImportGroup('a/b'), true)
  assert.equal(isValidImportGroup('a//b'), false)
  assert.equal(isValidImportName('a'.repeat(65)), false)
  assert.equal(isValidImportName('a'.repeat(64)), true)
})
