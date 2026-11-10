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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EVOLUTION_SETTINGS, workspaceHashOf } from '../lib/evolution/config.js'
import { createEvolutionState } from '../lib/evolution/state.js'
import { createLearner, pickField } from '../lib/evolution/write.js'
import { captureUserTexts } from '../lib/evolution/evidence.js'
import { layerOfGroup } from '../lib/memories/constants.js'
import { buildCatalog } from '../lib/memories/catalog.js'
import { archiveAutoNote } from '../lib/evolution/notes.js'

const HUB = 'tool-management'
const WS_KEY = 'D:/work/demo'
const WS_HASH = workspaceHashOf(WS_KEY)

/** 生效配置：全开、路由决定层（测试里逐个覆盖它关心的字段）。 */
const cfgOf = (over = {}) => ({
  ...DEFAULT_EVOLUTION_SETTINGS,
  learnGlobal: true,
  learnWorkspace: true,
  enabled: true,
  inject: true,
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
/** 把一句用户原话放进证据缓存：`user_explicit` 的引句要能核对上。 */
const userSaid = (text) => captureUserTexts('s-1', [{ role: 'user', content: text }])

test('learn：正文 / state / 索引 / catalog 四处一起落，且一律先落待确认', async () => {
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
    assert.equal(r.status, 'candidate', '没有任何卡片批准，学完只能进待确认')

    // ① 正文：frontmatter 带上「谁写的 / 什么状态 / 靠什么证据」
    const doc = h.readDoc(r.id)
    assert.equal(pickField(doc, 'origin'), 'auto')
    assert.equal(pickField(doc, 'auto_key'), 'package-manager')
    assert.equal(pickField(doc, 'auto_status'), 'candidate')
    assert.equal(pickField(doc, 'auto_workspace'), WS_HASH, '工作区层必须记下归属，否则换台机器就串了')

    // ② state：证据链只有一份真相
    const st = h.readState()
    const entry = st.entries[r.id]
    assert.ok(entry, 'state 里必须有这条（没有就等于"没有来源的记忆"）')
    assert.equal(entry.evidence.length, 1)
    assert.equal(entry.evidence[0].source, 'tool_verified')
    assert.ok(entry.confidence > 0.5)

    // ③ 索引：候选不注入靠的是 status，不靠索引停用 —— 索引保持启用，确认后无需再补一次写
    assert.equal(h.readIndex().rules[r.id].enabled, true)

    // ④ catalog：注入只读它，缺了这条就"学了但看不见"；候选在，但 status 把它挡在注入之外
    const cat = h.readCatalog()
    assert.ok(cat.entries[r.id], 'catalog 必须有条目')
    assert.equal(cat.entries[r.id].layer, 'workspace')
    assert.equal(cat.entries[r.id].status, 'candidate')
    assert.ok(cat.entries[r.id].estTokens > 0)
  } finally { h.done() }
})

test('autoActive：工作区 + 用户原话直接生效，且证据不冒充用户批准', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const r = await h.learner.learn(
      { text, key: 'package-manager', source: 'user_explicit', quote: text, autoActive: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'active')
    assert.equal(r.autoActive, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    const entry = h.readState().entries[r.id]
    assert.equal(entry.evidence[0].source, 'user_explicit', '没有用户确认，不能写成 user_approved')
    assert.equal(entry.needsReview, undefined)
  } finally { h.done() }
})

test('autoActive：全局 / 做法类 / 模型推断 / 全局措辞都只进候选', async () => {
  const h = harness()
  try {
    const globalText = '用户喜欢简洁的回答'
    userSaid(globalText)
    const global = await h.learner.learn(
      { text: globalText, key: 'answer-style', source: 'user_explicit', quote: globalText, layer: 'global', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(global.status, 'candidate', '全局层必须等用户确认')

    const procText = '发布前先跑构建再打 tag'
    userSaid(procText)
    const procedure = await h.learner.learn(
      { text: procText, key: 'release-steps', source: 'user_explicit', quote: procText, kind: 'procedure', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(procedure.status, 'candidate', '做法类必须等用户确认')

    const inferred = await h.learner.learn(
      { text: '这个仓库可能用 pnpm', key: 'pkg-guess', source: 'model_inference', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(inferred.status, 'candidate', '模型推断不能直接生效')

    const mixedText = '所有项目都统一用 pnpm'
    userSaid(mixedText)
    const mixed = await h.learner.learn(
      { text: mixedText, key: 'pnpm-all', source: 'user_explicit', quote: mixedText, layer: 'workspace', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(mixed.status, 'candidate', '工作区层出现跨项目措辞，说明可能判错层，交给卡片')
  } finally { h.done() }
})

test('autoActive：合并进已有候选时一并升 active', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'package-manager', source: 'user_explicit', quote: text },
      cfgOf(), envOf(),
    )
    assert.equal(first.status, 'candidate')
    const merged = await h.learner.learn(
      { text, key: 'package-manager', source: 'user_explicit', quote: text, autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(merged.ok, true, merged.error)
    assert.equal(merged.merged, true)
    assert.equal(merged.status, 'active')
    assert.equal(pickField(h.readDoc(merged.id), 'auto_status'), 'active')
  } finally { h.done() }
})

test('forget：不存在的 id 返回 not-found，不写空墓碑', async () => {
  const h = harness()
  try {
    const r = await h.learner.forget('_ws/abcd/nope', { actor: 'model' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'not-found')
    assert.equal(existsSync(join(h.stateDir, 'evolution', 'state.json')), false, '不该为了一个不存在的条目写 state')
  } finally { h.done() }
})

test('preview：direct 结果区分「可自动生效」与「必须确认」', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const ok = await h.learner.preview(
      { text, key: 'package-manager', source: 'user_explicit', quote: text },
      cfgOf(), envOf(),
    )
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.direct.status, 'active')
    assert.equal(ok.direct.autoActive, true)

    const globalText = '用户喜欢简洁的回答'
    userSaid(globalText)
    const global = await h.learner.preview(
      { text: globalText, key: 'answer-style', source: 'user_explicit', quote: globalText, layer: 'global' },
      cfgOf(), envOf(),
    )
    assert.equal(global.ok, true, global.error)
    assert.equal(global.direct.status, 'candidate')
    assert.equal(global.direct.autoActive, false)
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

    // 证据升级（2026-11-10）：页面上确认的也是"用户看过这条原文" —— 推断证据升为
    // user_approved（0.85）。只升状态不动证据的话，注入门槛（L1 ≥ 0.7）永远放不过
    // 0.4 的推断，症状是"界面显示生效、上下文里永远看不见"。
    const stAfter = h.readState().entries[r.id]
    assert.equal(stAfter.confidence, 0.85)
    assert.ok(stAfter.evidence.every((e) => e.source !== 'model_inference'), '推断证据应已全部升级')
    assert.equal(h.readCatalog().entries[r.id].confidence, 0.85)

    // 已归档 / 已取代的不许"确认复活"（那会绕过墓碑）
    await h.learner.forget(r.id, { actor: 'user' })
    const again = await h.learner.approve(r.id)
    assert.equal(again.ok, false)
    assert.equal(again.code, 'not-pending')
  } finally { h.done() }
})

test('learn 来源只影响信心与待确认理由，不影响「是否生效」：一律候选', async () => {
  const h = harness()
  try {
    const verified = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(verified.ok, true, verified.error)
    assert.equal(verified.status, 'candidate')
    assert.equal(verified.needsReview, undefined, '工具验证过的推断不需要额外解释，但仍是候选')
    assert.ok(verified.confidence > 0.5)

    const inferred = await h.learner.learn(
      { text: '回答先给结论，再给理由', key: 'answer-style', source: 'model_inference' },
      cfgOf(),
      envOf(),
    )
    assert.equal(inferred.ok, true, inferred.error)
    assert.equal(inferred.status, 'candidate')
    assert.ok(inferred.needsReview, '模型推断要说明为什么等确认')
    assert.equal(h.readState().entries[inferred.id].confidence, 0.4)

    // 没有确认就没有生效路径：收件箱里的条目一条都不该是 active / core / playbook。
    const injectable = Object.values(h.readCatalog().entries)
      .filter((e) => e.status === 'active' || e.status === 'core' || e.status === 'playbook')
    assert.deepEqual(injectable, [])
  } finally { h.done() }
})

test('计数：注入只记进快照的那次，读只记模型 read；缺失条目静默跳过', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    await h.learner.noteInjected([r.id, 'missing/id'])
    await h.learner.noteInjected([r.id])
    await h.learner.noteRead(r.id)

    const c = h.readState().entries[r.id].counters
    assert.equal(c.injected, 2)
    assert.equal(c.read, 1)
    assert.ok(c.lastInjectedAt, '注入时间要落，衰减与排序都读它')
    assert.ok(c.lastUsedAt)
  } finally { h.done() }
})

test('用户动作版本号：确认 / 停用 / 删除各 +1，学习写入不 +1', async () => {
  const h = harness()
  try {
    const revOf = () => h.readState().watermarks.autoRevision ?? 0
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(revOf(), 0, '学习不重发本会话的自动段')
    await h.learner.approve(r.id)
    assert.equal(revOf(), 1)
    await h.learner.setStatus(r.id, 'archived')
    assert.equal(revOf(), 2)
    await h.learner.forget(r.id)
    assert.equal(revOf(), 3)
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

test('停用写回收站副本；restoreFromTrash 恢复并删副本；purgeTrash 连正文一起删', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)

    assert.equal((await h.learner.setStatus(r.id, 'archived')).ok, true)
    const trashDir = join(h.stateDir, 'trash', 'memories-trash')
    const ids = readdirSync(trashDir)
    assert.equal(ids.length, 1, '停用必须在回收站留一份可恢复的副本')
    const manifest = JSON.parse(readFileSync(join(trashDir, ids[0], 'manifest.json'), 'utf8'))
    assert.equal(manifest.auto, true)
    assert.equal(manifest.autoId, r.id)
    assert.equal(manifest.autoLayer, 'workspace')

    const back = await h.learner.restoreFromTrash(ids[0])
    assert.equal(back.ok, true, back.error)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    assert.deepEqual(readdirSync(trashDir), [], '恢复后副本必须消失，不能在回收站留幽灵')
    assert.equal(h.readIndex().rules[r.id].enabled, true)

    assert.equal((await h.learner.setStatus(r.id, 'archived')).ok, true)
    const again = readdirSync(trashDir)
    assert.equal(again.length, 1)
    const purged = await h.learner.purgeTrash(again[0])
    assert.equal(purged.ok, true, purged.error)
    assert.equal(existsSync(join(h.memoriesRoot, r.id + '.md')), false, '永久删除要连原地正文一起删')
    assert.deepEqual(readdirSync(trashDir), [])
    assert.equal(h.readCatalog().entries[r.id].status, 'archived')
  } finally { h.done() }
})

test('restoreFromTrash：正文被旧版搬走时从副本还原，并补回索引的启用位', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    await h.learner.setStatus(r.id, 'archived')
    const trashDir = join(h.stateDir, 'trash', 'memories-trash')
    const trashId = readdirSync(trashDir)[0]
    // 模拟旧版把正文搬进别处：原文件不在，只有回收站副本。
    rmSync(join(h.memoriesRoot, r.id + '.md'))

    const back = await h.learner.restoreFromTrash(trashId)
    assert.equal(back.ok, true, back.error)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    assert.deepEqual(readdirSync(trashDir), [])
    // 关键：索引也要回 true，否则下一次 catalog 重建会按旧索引把它重新排除。
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].enabled, true)
  } finally { h.done() }
})

test('purgeTrash：正文不是 archived 时只清孤儿副本，不误删正文', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    // 模拟「停用写盘失败」留下的孤儿副本：正文仍在可注入状态，回收站里却有一份。
    const trashId = await archiveAutoNote(h.memoriesRoot, h.stateDir, r.id, 'workspace')
    assert.notEqual(trashId, null)

    const purged = await h.learner.purgeTrash(trashId)
    assert.equal(purged.ok, false)
    assert.equal(purged.code, 'not-archived')
    assert.equal(existsSync(join(h.memoriesRoot, r.id + '.md')), true, '正在注入的正文不能被永久删除')
    assert.notEqual(pickField(h.readDoc(r.id), 'auto_status'), 'archived')
    assert.deepEqual(readdirSync(join(h.stateDir, 'trash', 'memories-trash')), [], '孤儿副本要清掉')
  } finally { h.done() }
})

test('update：只换正文，catalog 摘要跟着变；frontmatter / 状态不动', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    const before = h.readCatalog().entries[r.id]
    const revisionBefore = h.readState().watermarks.autoRevision ?? 0

    const up = await h.learner.update(r.id, '这个仓库统一用 pnpm，不要用 npm')
    assert.equal(h.readState().watermarks.autoRevision, revisionBefore + 1, '编辑要让注入快照失效')
    assert.equal(up.ok, true, up.error)
    const doc = h.readDoc(r.id)
    assert.match(doc, /统一用 pnpm，不要用 npm/)
    assert.equal(pickField(doc, 'auto_key'), 'package-manager', '编辑不能动 frontmatter 身份')
    assert.equal(pickField(doc, 'auto_status'), 'candidate', '编辑不改状态')
    assert.equal(pickField(doc, 'description'), '这个仓库统一用 pnpm，不要用 npm', 'description 也要跟着正文走')
    const after = h.readCatalog().entries[r.id]
    assert.equal(after.oneLine, '这个仓库统一用 pnpm，不要用 npm')
    assert.ok(after.estTokens > 0)
    assert.notEqual(after.oneLine, before.oneLine)
    // catalog 重建后摘要不能退回旧说法（description 已同步）
    const rebuilt = await buildCatalog(h.memoriesRoot, h.readIndex())
    assert.equal(rebuilt.entries[r.id].oneLine, '这个仓库统一用 pnpm，不要用 npm')

    // 空正文拒绝
    assert.equal((await h.learner.update(r.id, '   ')).ok, false)

    // 并发编辑：带上打开时的指纹，文件已变就拒绝覆盖
    const detail = await h.learner.describe(r.id)
    const stale = await h.learner.update(r.id, '另一个窗口写的', 'deadbeef')
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale')
    const fresh = await h.learner.update(r.id, '另一个窗口写的', detail.hash)
    assert.equal(fresh.ok, true, fresh.error)
    assert.match(h.readDoc(r.id), /另一个窗口写的/)
  } finally { h.done() }
})

test('update：已被取代的条目拒绝编辑（改了也不会注入）', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    await h.learner.learn(
      { text: '这个仓库改用 npm 了，pnpm 不再可用', key: 'package-manager', source: 'user_explicit' },
      cfgOf(),
      envOf(),
    )
    const up = await h.learner.update(first.id, '改个说法')
    assert.equal(up.ok, false)
    assert.equal(up.code, 'superseded')
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
      { text: '提交信息别写英文', key: 'commit-message-lang', source: 'tool_verified' },
      cfgOf(),
      envOf(),
    )
    assert.equal(a.ok, true, a.error)
    assert.equal(b.ok, true, b.error)
    // 写入管线现在会跨 key 合并相似文本；这里模拟**历史上已经并存**的两条：
    // 把 b 的正文改成与 a 几乎一样的说法，状态与证据保持 learn 写下的那份。
    const bPath = join(h.memoriesRoot, b.id + '.md')
    writeFileSync(bPath, readFileSync(bPath, 'utf8').replace(
      /\n---\n[\s\S]*$/,
      '\n---\n\n所有提交信息都用中文写，不要写英文，因为团队里有人不看英文\n',
    ))
    assert.equal(h.docs().length, 2)

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

// ── 对话卡片：批准直接生效 ─────────────────────────────────────────────────

test('preview：只读预演不落盘；批准后 model_inference 直接生效并升级证据', async () => {
  const h = harness()
  try {
    const req = { text: '这个仓库统一用 pnpm', key: 'package-manager', source: 'model_inference' }
    const p = await h.learner.preview(req, cfgOf(), envOf())
    assert.equal(p.ok, true, p.error)
    assert.equal(p.status, 'active')
    assert.equal(p.layer, 'workspace')
    assert.deepEqual([...p.allowedLayers].sort(), ['global', 'workspace'])
    assert.deepEqual(h.docs(), [], '预演不能写正文')
    let hasState = true
    try { h.readState() } catch { hasState = false }
    assert.equal(hasState, false, '预演不能写 state')

    const r = await h.learner.learn({ ...req, approved: true }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'active')
    assert.equal(r.approved, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    const st = h.readState()
    assert.equal(st.entries[r.id].needsReview, undefined)
    assert.equal(st.entries[r.id].evidence[0].source, 'user_approved')
    assert.equal(st.entries[r.id].confidence, 0.85)
    assert.ok((st.watermarks.autoRevision ?? 0) > 0, '卡片批准是用户动作，要 bump 版本号')
  } finally { h.done() }
})

test('approved + 与用户手写记忆冲突：仍然 candidate，卡片不越过用户记忆', async () => {
  const h = harness()
  try {
    mkdirSync(join(h.memoriesRoot, 'global'), { recursive: true })
    writeFileSync(join(h.memoriesRoot, 'global', 'pkg.md'), [
      '---', 'name: pkg', 'description: 用户写的包管理器约定', 'origin: user', '---', '',
      '这个仓库统一用 pnpm，不要用 npm', '',
    ].join('\n'))
    const req = { text: '这个仓库统一用 pnpm，不要用 npm。', key: 'package-manager', source: 'model_inference' }
    const p = await h.learner.preview(req, cfgOf(), envOf())
    assert.equal(p.ok, true, p.error)
    assert.equal(p.status, 'candidate')
    assert.equal(p.reviewCode, 'user-conflict')

    const r = await h.learner.learn({ ...req, approved: true }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'candidate')
    assert.equal(r.reviewCode, 'user-conflict')
    assert.ok(r.needsReview)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'candidate')
  } finally { h.done() }
})

test('approved + 同 key 生效旧说法：新说法直接取代旧的', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', source: 'tool_verified', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.status, 'active')
    const second = await h.learner.learn(
      { text: '这个仓库统一用 yarn', key: 'package-manager', source: 'model_inference', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.ok, true, second.error)
    assert.equal(second.status, 'active')
    assert.deepEqual(second.supersedes, [first.id])
    assert.equal(pickField(h.readDoc(first.id), 'auto_status'), 'superseded')
  } finally { h.done() }
})

test('approved + 跨层相似条目：按用户选的层新建，并取代另一层的旧说法', async () => {
  const h = harness()
  try {
    const globalFirst = await h.learner.learn(
      { text: '所有项目统一用 pnpm 管理依赖', key: 'pkg-global', source: 'tool_verified', layer: 'global', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(globalFirst.layer, 'global')
    const workspace = await h.learner.learn(
      { text: '所有项目统一用 pnpm 管理依赖', key: 'pkg-global', source: 'model_inference', layer: 'workspace', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(workspace.ok, true, workspace.error)
    assert.equal(workspace.layer, 'workspace')
    assert.deepEqual(workspace.supersedes, [globalFirst.id])
    assert.equal(pickField(h.readDoc(globalFirst.id), 'auto_status'), 'superseded')
  } finally { h.done() }
})

test('archived 相似条目不再被当成合并目标（新条目不生效的旧坑）', async () => {
  const h = harness()
  try {
    const old = await h.learner.learn(
      { text: '发布前先跑完整测试', key: 'release-test', source: 'tool_verified', approved: true },
      cfgOf(),
      envOf(),
    )
    await h.learner.setStatus(old.id, 'archived', 'user')
    const r = await h.learner.learn(
      { text: '发布前先跑完整测试', key: 'release-test', source: 'model_inference', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.notEqual(r.id, old.id, '归档条目不能吞掉新学到的同一条')
    assert.equal(r.status, 'active')
    assert.equal(pickField(h.readDoc(old.id), 'auto_status'), 'archived')
  } finally { h.done() }
})
