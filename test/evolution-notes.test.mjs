// 自主记忆独立库的一次性迁移与回收站。
//
// 钉的是三类**静默**错误：
//   ① 迁移把用户手写的记忆也搬走 / 覆盖 —— 数据丢失，且没有回滚；
//   ② 标记写早了 —— 中途崩了之后下次不再跑，一半条目永远留在旧目录里；
//   ③ 旧会话/场景条目直接以 active 身份进全局 —— "这次对话才成立"的旧约束
//      突然在所有项目生效，用户根本不知道它从哪来。
//
// 一律读回真文件核对：迁移是文件搬家，只测返回值等于没测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoNotesRootOf, migrateLegacyAutoNotes, targetGroupOf, trashAutoNote } from '../lib/evolution/notes.js'

const WS = 'abcd1234abcd1234'

/** 最小 frontmatter：parseSkillDoc 只认顶层 `key: value`，迁移读的 origin 就在这里。 */
const doc = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n' + body + '\n'

/** 旧库四种层各放一条 auto 文件，再放一份用户手写的（不该被搬）。 */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evo-notes-'))
  const stateDir = join(home, 'tool-management')
  const memoriesRoot = join(stateDir, 'memories')
  mkdirSync(join(memoriesRoot, 'global'), { recursive: true })
  mkdirSync(join(memoriesRoot, '_ws', WS), { recursive: true })
  mkdirSync(join(memoriesRoot, '_session', 's-1'), { recursive: true })
  mkdirSync(join(memoriesRoot, 'code'), { recursive: true })
  writeFileSync(join(memoriesRoot, 'global', 'auto-global.md'), doc({ origin: 'auto', auto_status: 'active', auto_key: 'style' }, '回答先给结论'))
  writeFileSync(join(memoriesRoot, '_ws', WS, 'auto-ws.md'), doc({ origin: 'auto', auto_status: 'active' }, '这个仓库用 pnpm'))
  writeFileSync(join(memoriesRoot, '_session', 's-1', 'auto-sess.md'), doc({ origin: 'auto', auto_status: 'active' }, '这次别动 migrations'))
  writeFileSync(join(memoriesRoot, 'code', 'auto-scene.md'), doc({ origin: 'auto', auto_status: 'active' }, '这个场景不要用表格'))
  writeFileSync(join(memoriesRoot, 'global', 'user-note.md'), doc({ origin: 'user' }, '手写的规则'))
  return {
    stateDir, memoriesRoot, autoRoot: autoNotesRootOf(stateDir),
    done() { rmSync(home, { recursive: true, force: true }) },
  }
}

test('迁移：auto 条目按层搬进独立库；_session / 场景条目标 archived；用户文件不动', async () => {
  const h = harness()
  try {
    const r = await migrateLegacyAutoNotes({ memoriesRoot: h.memoriesRoot, stateDir: h.stateDir, workspaceHash: WS })
    assert.equal(r.error, undefined)
    assert.equal(r.ran, true)
    assert.equal(r.moved, 4)
    assert.equal(r.skipped, 1, '用户手写的文件不该被搬走')
    assert.equal(r.archived, 2, '_session 与场景条目缺稳定身份，落工作区但标 archived')

    // 全局 / 工作区原样保留且仍是 active
    assert.ok(readAuto(h, 'global', 'auto-global.md').includes('auto_status: active'))
    assert.ok(readAuto(h, '_ws/' + WS, 'auto-ws.md').includes('auto_status: active'))
    // 旧会话条目：有工作区身份 → 落工作区 + archived + 记来源（用户看得懂它从哪来）
    const sess = readAuto(h, '_ws/' + WS, 'auto-sess.md')
    assert.match(sess, /auto_status: archived/)
    assert.match(sess, /auto_migrated_from: _session\/s-1/)
    // 旧场景条目同理
    assert.match(readAuto(h, '_ws/' + WS, 'auto-scene.md'), /auto_status: archived/)

    // 旧文件改名留档（.migrated 后缀不是 .md，发现器不会再扫到）
    assert.equal(existsSync(join(h.memoriesRoot, 'global', 'auto-global.md')), false)
    assert.equal(existsSync(join(h.memoriesRoot, 'global', 'auto-global.md.migrated')), true)
    // 用户手写文件原地不动
    assert.equal(existsSync(join(h.memoriesRoot, 'global', 'user-note.md')), true)
    // 标记最后才写：中途崩了下次会重跑，比"标记在、一半文件没搬"好
    assert.equal(existsSync(join(h.autoRoot, '.migrated')), true)
  } finally { h.done() }
})

function readAuto(h, group, name) {
  return readFileSync(join(h.autoRoot, group, name), 'utf8')
}

test('迁移：幂等 —— 标记在就不再跑；没有工作区身份时旧条目落全局并标 archived', async () => {
  const h = harness()
  try {
    const first = await migrateLegacyAutoNotes({ memoriesRoot: h.memoriesRoot, stateDir: h.stateDir })
    assert.equal(first.ran, true)
    assert.equal(first.archived, 2)
    // 没 workspaceHash：旧会话/场景条目落全局 + archived —— 不丢，但也不该在所有项目生效
    assert.match(readAuto(h, 'global', 'auto-sess.md'), /auto_status: archived/)
    assert.match(readAuto(h, 'global', 'auto-scene.md'), /auto_status: archived/)

    const again = await migrateLegacyAutoNotes({ memoriesRoot: h.memoriesRoot, stateDir: h.stateDir })
    assert.equal(again.ran, false, '标记文件在：第二次直接返回，不重复搬')
    assert.equal(again.moved, 0)
  } finally { h.done() }
})

test('targetGroupOf：四种旧 group 的去向（前两种原样，后两种标 archived）', () => {
  assert.deepEqual(targetGroupOf('global'), { group: 'global', archived: false })
  assert.deepEqual(targetGroupOf('_ws/' + WS), { group: '_ws/' + WS, archived: false })
  assert.deepEqual(targetGroupOf('_session/s-1', WS), { group: '_ws/' + WS, archived: true })
  assert.deepEqual(targetGroupOf('code', WS), { group: '_ws/' + WS, archived: true })
  assert.deepEqual(targetGroupOf('_session/s-1'), { group: 'global', archived: true })
  assert.deepEqual(targetGroupOf('code'), { group: 'global', archived: true })
})

test('trashAutoNote：正文进 evolution/trash 可找回；id 非法 / 文件不在返回 false', async () => {
  const h = harness()
  try {
    await migrateLegacyAutoNotes({ memoriesRoot: h.memoriesRoot, stateDir: h.stateDir, workspaceHash: WS })
    assert.equal(await trashAutoNote(h.autoRoot, h.stateDir, 'global/auto-global'), true)
    const trash = readdirSync(join(h.stateDir, 'evolution', 'trash')).filter((f) => f.endsWith('.md'))
    assert.equal(trash.length, 1, '回收站里有一份可找回的正文')
    assert.equal(existsSync(join(h.autoRoot, 'global', 'auto-global.md')), false)
    // 再删一次：文件已经不在
    assert.equal(await trashAutoNote(h.autoRoot, h.stateDir, 'global/auto-global'), false)
    // 非法 id（没有 group）
    assert.equal(await trashAutoNote(h.autoRoot, h.stateDir, 'no-slash'), false)
  } finally { h.done() }
})
