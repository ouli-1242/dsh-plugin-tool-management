// 自主记忆 P1 的**落盘**测试：写入管线的六步、合并、遗忘与「读坏就停写」。
//
// 为什么单独一份、且要落真文件（而不是只测门禁的返回值）：P1 里最容易静默坏掉的是
// **顺序与一致性** ——
//   · 文件写了但 state 没写 → 下次读不到证据，条目退化成"没有来源的记忆"；
//   · state 写坏了却继续写 → 覆盖掉证据与墓碑，删过的东西复活；
//   · forget 只改了状态没进回收站 → 用户以为删了，文件还躺在磁盘上。
// 这三类的共同点是不报错、界面也不一定看得出来。所以这里一律读回真文件核对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EVOLUTION_SETTINGS, workspaceHashOf } from '../lib/evolution/config.js'
import { createEvolutionState } from '../lib/evolution/state.js'
import { createLearner, pickField } from '../lib/evolution/write.js'
import { layerOfGroup } from '../lib/memories/constants.js'
import { buildCatalog } from '../lib/memories/catalog.js'

const HUB = 'tool-management'
const WS_KEY = 'D:/work/demo'
const WS_HASH = workspaceHashOf(WS_KEY)

/** 生效配置：全开、路由决定层（测试里逐个覆盖它关心的字段）。 */
const cfgOf = (over = {}) => ({
  ...DEFAULT_EVOLUTION_SETTINGS,
  enabled: true,
  inject: true,
  learnScope: 'workspace',
  writeTarget: 'route',
  source: 'global',
  ...over,
})

/** 严格读：把「文件不在」与「坏了」分开 —— 与 index.ts 里那份同语义（state 依赖它区分）。 */
async function readJsonFileStrict(abs) {
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch (e) {
    if (String(e?.code || '') === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', error: String(e?.message || e) }
  }
  try {
    return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) }
  } catch (e) {
    return { status: 'corrupt', error: String(e?.message || e) }
  }
}

/**
 * 最小可用的序列化：`key: value` 一行一个。
 *
 * 刻意**不**复用记忆域的完整实现 —— 那会把"测试自己拼得对不对"和"学习管线写得对不对"
 * 搅在一起。这里要钉的是管线把哪些字段写进去了，不是 YAML 转义。
 */
const serializeRuleFile = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n' + body + '\n'

/**
 * 取正文（去掉 frontmatter）。
 *
 * 生产里 `existingEntries` 喂的是 `snapshot.bodies`（**正文**）。整份文件丢进去会把
 * frontmatter 的字也算进相似度，同义句就永远够不到阈值 —— 症状是"合并从不发生"，
 * 而门禁代码看起来完全正常。
 */
const bodyOf = (text) => {
  const s = String(text ?? '')
  if (!s.startsWith('---\n')) return s.trim()
  const end = s.indexOf('\n---', 4)
  return end < 0 ? s.trim() : s.slice(end + 4).trim()
}

/** 搭一套隔离环境并返回 learner + 目录 + 读回工具。 */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evo-write-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const stateDir = join(home, HUB)
  const memoriesRoot = join(stateDir, 'memories')
  mkdirSync(memoriesRoot, { recursive: true })

  const state = createEvolutionState({
    ensurePaths: async () => mkdirSync(join(stateDir, 'evolution'), { recursive: true }),
    readJsonFileStrict,
    message: (e) => String(e?.message || e),
  })

  /** 扫盘当成"现有条目"：与生产里 catalog 的口径一致（只认 origin=auto 的自动条目）。 */
  async function existingEntries() {
    const entries = []
    const walk = (dir, group) => {
      let list
      try { list = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of list) {
        const p = join(dir, e.name)
        const g = group === '' ? e.name : `${group}/${e.name}`
        if (e.isDirectory()) { walk(p, g); continue }
        if (!e.name.endsWith('.md')) continue
        const text = readFileSync(p, 'utf8')
        entries.push({
          id: g.replace(/\.md$/, ''),
          layer: layerOfGroup(group),
          key: pickField(text, 'auto_key'),
          text: bodyOf(text),
          status: pickField(text, 'auto_status') || 'active',
          origin: pickField(text, 'origin') === 'auto' ? 'auto' : 'user',
        })
      }
    }
    walk(memoriesRoot, '')
    return { entries, knownScenes: new Set(['code']) }
  }

  const learner = createLearner({
    state,
    existingEntries,
    knownWorkspaces: async () => new Set([WS_HASH]),
    serializeRuleFile,
    memoriesRoot,
    stateDir,
    invalidateSnapshot: () => {},
    withWriteLock: (fn) => fn(),
    message: (e) => String(e?.message || e),
  })

  return {
    home, stateDir, memoriesRoot, learner, state,
    /** 收尾：恢复环境变量并删临时目录。 */
    done() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    },
    readState() {
      return JSON.parse(readFileSync(join(stateDir, 'evolution', 'state.json'), 'utf8'))
    },
    readIndex() {
      return JSON.parse(readFileSync(join(stateDir, 'memories-index.json'), 'utf8'))
    },
    readCatalog() {
      return JSON.parse(readFileSync(join(stateDir, 'evolution', 'catalog.json'), 'utf8'))
    },
    readDoc(id) {
      return readFileSync(join(memoriesRoot, id + '.md'), 'utf8')
    },
    docs() {
      const out = []
      const walk = (dir, group) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const g = group === '' ? e.name : `${group}/${e.name}`
          if (e.isDirectory()) walk(join(dir, e.name), g)
          else if (e.name.endsWith('.md')) out.push(g.replace(/\.md$/, ''))
        }
      }
      walk(memoriesRoot, '')
      return out.sort()
    },
  }
}

const envOf = () => ({ sessionId: 's-1', workspaceHash: WS_HASH })

test('learn：正文 / state / 索引 / catalog 四处一起落，且索引是「学完就生效」', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.layer, 'workspace')
    assert.equal(r.merged, false)

    // ① 正文：frontmatter 带上「谁写的 / 什么状态 / 靠什么证据」
    const doc = h.readDoc(r.id)
    assert.equal(pickField(doc, 'origin'), 'auto')
    assert.equal(pickField(doc, 'auto_key'), 'package-manager')
    assert.equal(pickField(doc, 'auto_status'), 'active')
    assert.equal(pickField(doc, 'auto_workspace'), WS_HASH, '工作区层必须记下归属，否则换台机器就串了')

    // ② state：证据链只有一份真相
    const st = h.readState()
    const entry = st.entries[r.id]
    assert.ok(entry, 'state 里必须有这条（没有就等于"没有来源的记忆"）')
    assert.equal(entry.evidence.length, 1)
    assert.equal(entry.evidence[0].source, 'tool_verified')
    assert.ok(entry.confidence > 0.5)

    // ③ 索引：自动记忆学完必须立刻 enabled，否则等于没学（下一轮不注入）
    assert.equal(h.readIndex().rules[r.id].enabled, true)

    // ④ catalog：注入只读它，缺了这条就"学了但看不见"
    const cat = h.readCatalog()
    assert.ok(cat.entries[r.id], 'catalog 必须有条目')
    assert.equal(cat.entries[r.id].layer, 'workspace')
    assert.ok(cat.entries[r.id].estTokens > 0)
  } finally { h.done() }
})

test('merge：同 key 且说法几乎一样 → 只加证据与边界，不新建第二个文件', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.ok, true, first.error)

    const second = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.ok, true, second.error)
    assert.equal(second.merged, true, '同一件事的两种说法必须合并，否则每说一次长一条')
    assert.equal(second.id, first.id)

    assert.deepEqual(h.docs(), [first.id], '目录里只该有一个文件')
    const doc = h.readDoc(first.id)
    assert.match(pickField(doc, 'auto_boundary'), /不要写英文/, '新说法要补进边界（用户下次能看见差别）')
    assert.equal(h.readState().entries[first.id].evidence.length, 2, '两次说法 = 两条证据')
  } finally { h.done() }
})

test('supersede：同 key 但说的不是一回事 → 旧的标 superseded，同 key 只留一条生效', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    const second = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，别用 npm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.ok, true, second.error)
    assert.equal(second.merged, false)
    assert.deepEqual(second.supersedes, [first.id], '说法差得远就不该硬合并，而是取代')

    const oldDoc = h.readDoc(first.id)
    assert.equal(pickField(oldDoc, 'auto_status'), 'superseded')
    assert.equal(pickField(oldDoc, 'auto_superseded_by'), second.id)
    assert.equal(h.readIndex().rules[first.id].enabled, false, '旧条目的索引必须停用（两处都写才是双保险）')
    assert.equal(h.readIndex().rules[second.id].enabled, true)
    // 同 key 重复说不会在**生效集合**里长出第二条：文件多一个历史版本，注入只取新的那条。
    const active = Object.values(h.readCatalog().entries).filter((e) => e.key === 'package-manager' && e.enabled)
    assert.equal(active.length, 1, '生效的永远只有一条')
  } finally { h.done() }
})

test('approve：候选 → 生效，四处一起改（文件 / state / 索引 / catalog）', async () => {
  const h = harness()
  try {
    // 模型推断只能进候选（不注入）—— 这是九道门里最重要的一条保守策略
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'model_inference' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'candidate')
    assert.ok(r.needsReview, '候选必须带上"为什么待确认"')
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'candidate')
    assert.equal(h.readCatalog().entries[r.id].status, 'candidate', '候选不该被注入')

    const ok = await h.learner.approve(r.id)
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.status, 'active')
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    assert.equal(h.readState().entries[r.id].needsReview, undefined, '确认过就不该再挂"待确认"')
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].status, 'active', 'catalog 不跟着改 = 确认了还是不注入')

    // 已归档 / 已取代的不许"确认复活"（那会绕过墓碑）
    await h.learner.forget(r.id, { actor: 'user' })
    const again = await h.learner.approve(r.id)
    assert.equal(again.ok, false)
    assert.equal(again.code, 'not-pending')
  } finally { h.done() }
})

test('learn(via=tool, approved)：确认卡批下来的推断一次到位 —— 生效 + user_approved 证据', async () => {
  const h = harness()
  try {
    // 对话工具路径：执行到 learner 这一步 = 用户已在确认卡上按了「同意」。
    // 卡片就是确认：直接生效、不再挂"待确认"，证据升级为 user_approved（0.85），
    // 页面里不需要（也不应该）再点一次「确认」。
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'model_inference', via: 'tool', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'active')
    assert.equal(r.needsReview, undefined)

    const doc = h.readDoc(r.id)
    assert.equal(pickField(doc, 'auto_status'), 'active')
    assert.equal(pickField(doc, 'auto_confidence'), '0.85')

    const st = h.readState().entries[r.id]
    assert.equal(st.evidence.length, 1)
    assert.equal(st.evidence[0].source, 'user_approved')
    assert.equal(st.confidence, 0.85)

    // 学完即注入：索引与 catalog 都是 active + enabled
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].status, 'active')

    // 完全权限跳过卡的那一半：生效，但证据保持 model_inference（0.4），不虚报。
    const bypassed = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', source: 'model_inference', via: 'tool' },
      cfgOf(),
      envOf(),
    )
    assert.equal(bypassed.ok, true, bypassed.error)
    assert.equal(bypassed.status, 'active')
    assert.equal(bypassed.confidence, 0.4)
    const st2 = h.readState().entries[bypassed.id]
    assert.equal(st2.evidence[0].source, 'model_inference')
  } finally { h.done() }
})

test('forget：正文交给回收站、条目从 state 消失、索引停用、墓碑落盘', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '提交信息用中文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)

    const removed = []
    const out = await h.learner.forget(r.id, { actor: 'user', remove: async (id) => { removed.push(id); return true } })
    assert.equal(out.ok, true, out.error)
    assert.deepEqual(removed, [r.id], '必须走记忆域的删除路径（它才负责进回收站）')

    assert.equal(h.readState().entries[r.id], undefined, 'state 里不该再有这条')
    assert.equal(h.readIndex().rules[r.id].enabled, false, '索引必须停用：手改正文没改状态时靠这道兜底')
    const tomb = h.readState().tombstones
    assert.equal(tomb.length, 1)
    assert.equal(tomb[0].key, 'commit-lang')
    assert.ok(Date.parse(tomb[0].until) > Date.now() + 20 * 86400_000, '墓碑至少留 20 天以上')

    // 最要命的一条：正文如果还写着 active，下一次**全量重建**（启动 / 任何记忆写都会跑）
    // 就会把它原样复活，用户看到"删了又回来"且没有任何提示。
    const rebuilt = await buildCatalog(h.memoriesRoot, h.readIndex())
    assert.equal(rebuilt.entries[r.id].status, 'archived')
  } finally { h.done() }
})

test('墓碑拦截：删过的东西不能被「再说一遍」悄悄复活', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '提交信息用中文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    await h.learner.forget(r.id, { actor: 'user' })
    // 没给 remove 回调时正文故意留着（少删一次好过悄悄真删）—— 记下现状，下面只验"没有新增"。
    const before = h.docs()
    assert.deepEqual(before, [r.id])

    const again = await h.learner.learn(
      { text: '提交信息用中文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(again.ok, false)
    assert.equal(again.code, 'tombstoned')
    assert.match(again.error, /deleted/i, '回执要说清"删过、什么时候能再提"，否则模型会一直重试')
    assert.deepEqual(h.docs(), before, '被墓碑拦住时不得留下任何新文件')
  } finally { h.done() }
})

test('state 读坏就停写：不撤已写的东西，也不覆盖证据与墓碑', async () => {
  const h = harness()
  try {
    mkdirSync(join(h.stateDir, 'evolution'), { recursive: true })
    writeFileSync(join(h.stateDir, 'evolution', 'state.json'), '{ 这不是 JSON')

    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'state-unreadable')
    assert.match(r.error, /state\.json/)
    assert.deepEqual(h.docs(), [], '读不出状态时一个文件都不该写 —— 否则等于在无证据的情况下落盘')
    // 坏文件原样留着：用户还能去修，别"帮"他覆盖掉
    assert.equal(readFileSync(join(h.stateDir, 'evolution', 'state.json'), 'utf8'), '{ 这不是 JSON')
  } finally { h.done() }
})

test('会话层：sid 不能当目录名时拒，不静默落到别的层', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '别动 migrations', source: 'tool_verified', layer: 'session' },
      cfgOf(),
      { sessionId: '..', workspaceHash: WS_HASH },
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad-session')
    assert.deepEqual(h.docs(), [])
  } finally { h.done() }
})

// ── P1 补充：停用 / 恢复 / 提升 / 整理 ─────────────────────────────────────

test('setStatus：停用只转状态、不搬文件；恢复后索引与 catalog 都回来', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)

    const off = await h.learner.setStatus(r.id, 'archived')
    assert.equal(off.ok, true, off.error)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'archived')
    assert.equal(h.readIndex().rules[r.id].enabled, false)
    assert.equal(h.readCatalog().entries[r.id].enabled, false)
    // 关键词：**不搬文件**。这是「停用」与「删除」的全部区别，也是它可恢复的前提。
    assert.deepEqual(h.docs(), [r.id], '停用不该把正文移走')
    assert.equal(h.readState().entries[r.id].transitions.at(-1).to, 'archived')

    const on = await h.learner.setStatus(r.id, 'active')
    assert.equal(on.ok, true, on.error)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].enabled, true)
  } finally { h.done() }
})

test('setStatus：已被取代的条目拒绝恢复（新旧两条同时注入 = 模型看到矛盾）', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    const second = await h.learner.learn(
      { text: '这个仓库改用 npm 了，pnpm 不再可用', key: 'package-manager', source: 'user_explicit' },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.ok, true, second.error)
    const revive = await h.learner.setStatus(first.id, 'active')
    assert.equal(revive.ok, false)
    assert.equal(revive.code, 'superseded')
    assert.match(revive.error, /conflicting/i)
  } finally { h.done() }
})

test('promote：正文搬进用户记忆全局场景、auto_* 删干净、原文件进自主回收站', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '回答先给结论，再给理由', key: 'answer-style', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    const p = await h.learner.promote(r.id)
    assert.equal(p.ok, true, p.error)
    assert.equal(p.promoted, true)

    // 自主库与用户记忆是**两个目录**：只在原地改 origin 会让它两边都不出现
    // （不进自动 catalog、也不在用户记忆段）—— 症状是"点了提升，这条凭空消失"。
    const promotedId = 'global/' + String(r.id).split('/').pop()
    const doc = h.readDoc(promotedId)
    assert.equal(pickField(doc, 'origin'), 'user')
    // 留一个 auto_ 字段就会在下一次全量重建时被重新收进自动段 —— 提升等于没提升。
    for (const field of ['auto_status', 'auto_key', 'auto_kind', 'auto_confidence', 'auto_basis', 'auto_workspace']) {
      assert.equal(pickField(doc, field), '', field + ' 必须删掉')
    }
    // 原件移进自主回收站（evolution/trash，可人工找回），不留在原地变成幽灵。
    let gone = false
    try { h.readDoc(r.id) } catch { gone = true }
    assert.ok(gone, '原文件不该还留在自主库')
    const trash = readdirSync(join(h.stateDir, 'evolution', 'trash')).filter((f) => f.endsWith('.md'))
    assert.equal(trash.length, 1, '回收站里该有一份可找回的正文')

    assert.equal(h.readState().entries[r.id], undefined, '它不再是自动条目，state 里不该留着')
    assert.equal(h.readCatalog().entries[r.id], undefined, 'catalog 只索引自动条目')
    assert.equal(h.readIndex().rules[promotedId].enabled, true, '提升后仍要注入（走用户记忆那条路）')
    assert.equal(h.readIndex().rules[r.id], undefined, '自动索引里已移出')
  } finally { h.done() }
})

test('organize → applyOrganize(merge)：保留项正文不动、被并项转 superseded、证据并过来', async () => {
  const h = harness()
  try {
    const a = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    const b = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文', key: 'commit-message-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(a.ok, true, a.error)
    assert.equal(b.ok, true, b.error)
    assert.equal(h.docs().length, 2, '不同 key 不会被写入管线合并')

    const plan = await h.learner.organize('workspace')
    assert.equal(plan.ok, true, plan.error)
    const merge = plan.drafts.find((d) => d.action === 'merge')
    assert.ok(merge, '相似度 0.86 的两条该出合并草案')

    const res = await h.learner.applyOrganize(merge)
    assert.equal(res.ok, true, res.error)
    assert.equal(pickField(h.readDoc(b.id), 'auto_status'), 'superseded')
    assert.match(pickField(h.readDoc(a.id), 'auto_boundary'), /不要写英文/, '被并项的说法要补进保留项的边界')
    assert.equal(h.readState().entries[a.id].evidence.length, 2, '证据并过来，置信度才不会因为少了一条而掉')

    // 再算一次不该再出同一对：草案必须以"当前状态"为输入，否则界面点两次都成功。
    const again = await h.learner.organize('workspace')
    assert.equal(again.ok, true, again.error)
    assert.equal(again.drafts.filter((d) => d.action === 'merge').length, 0)
  } finally { h.done() }
})
