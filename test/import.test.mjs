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

test('expandUploads: .md 直通；非 .md 直传报问题；zip 保留全部扩展名（bundle 附件需要）且过滤非法路径', () => {
  const r = expandUploads([
    uploaded('人设A.md', '# A'),
    uploaded('notes.txt', 'x'),
    zipUpload('pack.zip', {
      'scene-a/memo.md': '# memo',
      'scene-a/SKILL.md': '# bundle',
      'scene-a/img.png': 'fakepng',
      'deep/nested/other.MD': '# upper',
      'readme.txt': 'keep me',
    }),
  ])
  assert.deepEqual(r.entries.map((e) => e.path).sort(), ['deep/nested/other.MD', 'readme.txt', 'scene-a/SKILL.md', 'scene-a/img.png', 'scene-a/memo.md', '人设A.md'])
  assert.deepEqual(r.problems.map((p) => p.name), ['notes.txt'])
})

test('expandUploads: 空内容与超量文件只记问题，不阻断同批', () => {
  const r = expandUploads([uploaded('empty.md', ''), uploaded('ok.md', '# ok')])
  assert.deepEqual(r.entries.map((e) => e.path), ['ok.md'])
  assert.deepEqual(r.problems.map((p) => p.name), ['empty.md'])
})

test('expandUploads: zip 内超 8 MiB 的条目必须回报原因（曾静默丢失，2026-09-13 实测）', () => {
  const big = 'A'.repeat(8 * 1024 * 1024 + 1)
  const r = expandUploads([zipUpload('pack.zip', {
    'scene-a/SKILL.md': '# bundle',
    'scene-a/huge.bin': big,
  })])
  assert.deepEqual(r.entries.map((e) => e.path), ['scene-a/SKILL.md'])
  assert.deepEqual(r.problems.map((p) => p.name), ['scene-a/huge.bin'])
})

test('expandUploads: zip 内条目超 2000 只报一次（不刷屏），其余条目照常保留', () => {
  const files = {}
  for (let i = 0; i < 2001; i++) files[`s/e${String(i).padStart(4, '0')}.md`] = '# x'
  const r = expandUploads([zipUpload('pack.zip', files)])
  assert.equal(r.entries.length, 2000)
  assert.equal(r.problems.length, 1)
})

test('planPersonaImport: 只看文件名（zip 目录层级忽略）；同批次重名与非法名跳过', () => {
  const r = planPersonaImport([
    { path: 'pack/a/code-review.md', bytes: new Uint8Array([1]) },
    { path: 'b/java-expert.md', bytes: new Uint8Array([2]) },
    { path: 'b/java-expert.md', bytes: new Uint8Array([3]) },
    { path: 'bad/na:me.md', bytes: new Uint8Array([4]) },
  ])
  assert.deepEqual(r.targets.map((t) => t.name), ['code-review', 'java-expert'])
  assert.equal(r.problems.length, 2)
})

test('planMemoryImport: zip 内目录当场景；裸 .md 落默认场景；空默认 = 全局；zip 根层 SKILL.md 没有名字可跳过', () => {
  const nested = planMemoryImport([
    { path: 'work/standup.md', bytes: new Uint8Array([1]) },
    { path: 'work/deep/todo.md', bytes: new Uint8Array([2]) },
    { path: 'loose.md', bytes: new Uint8Array([3]) },
  ], '在线')
  assert.deepEqual(nested.targets.map((t) => `${t.group}|${t.name}|${t.kind}`), ['work|standup|flat', 'work/deep|todo|flat', '在线|loose|flat'])

  const globalOnly = planMemoryImport([{ path: 'loose.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(globalOnly.targets.map((t) => `${t.group}|${t.name}`), ['|loose'])

  const rootSkill = planMemoryImport([{ path: 'SKILL.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(rootSkill.targets, [])
  assert.match(rootSkill.problems[0].reason, /没有目录名/)

  const caseVariant = planMemoryImport([{ path: 'work/skill.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(caseVariant.targets, [])
  assert.match(caseVariant.problems[0].reason, /大小写变体/)
})

test('planMemoryImport: <场景>/<名>/SKILL.md 规划为 bundle，同层非 .md 作附件；多级场景保留前缀', () => {
  const r = planMemoryImport([
    { path: '工作/release/SKILL.md', bytes: new Uint8Array([1]) },
    { path: '工作/release/img.png', bytes: new Uint8Array([2]) },
    { path: '工作/release/data.json', bytes: new Uint8Array([3]) },
    { path: 'a/b/rel/SKILL.md', bytes: new Uint8Array([4]) },
  ], '')
  assert.equal(r.targets.length, 2)
  const [bundle, nested] = r.targets
  assert.deepEqual(`${bundle.group}|${bundle.name}|${bundle.kind}`, '工作|release|bundle')
  assert.deepEqual(bundle.attachments.map((a) => a.name), ['img.png', 'data.json'])
  assert.deepEqual(`${nested.group}|${nested.name}|${nested.kind}`, 'a/b|rel|bundle')
  assert.deepEqual(nested.attachments, [])
  assert.deepEqual(r.problems, [])
})

test('planMemoryImport: bundle 内 .md 同层条目与深层附件明确跳过；附件超量/非法名回报', () => {
  const r = planMemoryImport([
    { path: 'b1/SKILL.md', bytes: new Uint8Array([1]) },
    { path: 'b1/notes.md', bytes: new Uint8Array([2]) },
    { path: 'b1/assets/img.png', bytes: new Uint8Array([3]) },
    { path: 'b1/bad:name.png', bytes: new Uint8Array([4]) },
    ...Array.from({ length: 34 }, (_, i) => ({ path: `b1/att-${i}.bin`, bytes: new Uint8Array([5]) })),
  ], '')
  assert.equal(r.targets.length, 1)
  assert.equal(r.targets[0].attachments.length, 32)
  const reasons = r.problems.map((p) => p.reason)
  assert.ok(reasons.some((x) => x.includes('bundle 是叶子')), JSON.stringify(reasons))
  assert.ok(reasons.some((x) => x.includes('一层附件')), JSON.stringify(reasons))
  assert.ok(reasons.some((x) => x.includes('附件名不合法')), JSON.stringify(reasons))
  assert.ok(reasons.filter((x) => x.includes('附件超过')).length >= 1, JSON.stringify(reasons))
})

test('planMemoryImport: 同批次 flat 与 bundle 撞 id → 重名跳过', () => {
  const r = planMemoryImport([
    { path: '工作/standup.md', bytes: new Uint8Array([1]) },
    { path: '工作/standup/SKILL.md', bytes: new Uint8Array([2]) },
  ], '')
  assert.equal(r.targets.length, 1)
  assert.deepEqual(r.problems.map((p) => p.reason), ['同批次重名，已跳过'])
})

test('端到端（同一批）：zip → 展开 → 记忆落点规划', () => {
  const { entries, problems } = expandUploads([
    zipUpload('memories.zip', { '工作/standup.md': '# 站会', 'global-note.md': '# 全局' }),
  ])
  const planned = planMemoryImport(entries, '')
  assert.deepEqual(problems, [])
  assert.deepEqual(planned.targets.map((t) => `${t.group}|${t.name}`).sort(), ['|global-note', '工作|standup'])
})

test('端到端：人设 zip 混入附件图片 → 只规划 .md 人设，非 .md 静默忽略', () => {
  const { entries } = expandUploads([
    zipUpload('personas.zip', { 'code-review.md': '# cr', 'shots/demo.png': 'fakepng' }),
  ])
  const planned = planPersonaImport(entries)
  assert.deepEqual(planned.targets.map((t) => t.name), ['code-review'])
  assert.deepEqual(planned.problems, [])
})

test('planMemoryImport: 场景名非法（含路径分隔符等）整条跳过', () => {
  const r = planMemoryImport([{ path: 'bad:scene/x.md', bytes: new Uint8Array([1]) }], '')
  assert.deepEqual(r.targets, [])
  assert.equal(r.problems.length, 1)
})

test('isValidImportGroup: 空串（全局）合法；多级路径逐段校验', () => {
  assert.equal(isValidImportGroup(''), true)
  assert.equal(isValidImportGroup('a/b'), true)
  assert.equal(isValidImportGroup('a//b'), false)
  assert.equal(isValidImportName('a'.repeat(65)), false)
  assert.equal(isValidImportName('a'.repeat(64)), true)
})
