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
import { isAbsolute, join } from 'node:path'
import { DEFAULT_EVOLUTION_SETTINGS, workspaceHashOf } from '../lib/evolution/config.js'
import { createEvolutionState, tierOf } from '../lib/evolution/state.js'
import { createLearner, pickField, titleOf } from '../lib/evolution/write.js'
import { textWidthOf } from '../lib/text-width.js'
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
        const layer = layerOfGroup(group)
        // 门禁按层过滤：工作区条目必须带归属，否则会被当成"别的仓库"。
        const workspace = layer === 'workspace' && group.startsWith('_ws/') ? group.slice('_ws/'.length) : ''
        entries.push({
          id: g.replace(/\.md$/, ''),
          layer,
          key: pickField(text, 'auto_key'),
          text: bodyOf(text),
          status: pickField(text, 'auto_status') || 'active',
          origin: pickField(text, 'origin') === 'auto' ? 'auto' : 'user',
          enabled: true,
          ...(workspace !== '' ? { workspace } : {}),
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
    // 没给引句 = 模型自己的推断：证据源是 `model_inference`。档位不落库，由 `tierOf` 从证据算。
    assert.equal(entry.evidence[0].source, 'model_inference')
    assert.equal(tierOf(entry.evidence), 'inferred')

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

test('title：learn 写入 auto_title，catalog 与重建都带上；update 可改可清', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { title: '  包管理器  ', text: '这个仓库统一用 pnpm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(pickField(h.readDoc(r.id), 'auto_title'), '包管理器', '名称要 trim 后落盘')
    assert.equal(h.readCatalog().entries[r.id].title, '包管理器')
    const rebuilt = await buildCatalog(h.memoriesRoot, h.readIndex())
    assert.equal(rebuilt.entries[r.id].title, '包管理器', 'catalog 重建不能丢名称')

    // 只改正文：名称不动。
    assert.equal((await h.learner.update(r.id, '这个仓库统一用 pnpm，不要用 npm')).ok, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_title'), '包管理器')
    assert.equal(h.readCatalog().entries[r.id].title, '包管理器')

    // 改名称：文件与 catalog 一起变。
    assert.equal((await h.learner.update(r.id, '这个仓库统一用 pnpm', '', 'Node 包管理器')).ok, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_title'), 'Node 包管理器')
    assert.equal(h.readCatalog().entries[r.id].title, 'Node 包管理器')

    // 清空名称：字段与 catalog 键都删掉，列表按首句兜底。
    assert.equal((await h.learner.update(r.id, '这个仓库统一用 pnpm', '', '')).ok, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_title'), '')
    assert.equal('title' in h.readCatalog().entries[r.id], false)
  } finally { h.done() }
})

test('三条写路径都清掉废弃的 auto_confidence', async () => {
  // `auto_confidence` 是旧版按「模型自报置信度」排序时留下的字段，现在排序改用证据档位，
  // 它没有任何读取方。留着不会出错，但会让读代码的人以为置信度还在起作用 ——
  // 那正是「假功能」的样子。三条写路径（合并 / 状态变更 / 用户编辑）都要清。
  const h = harness()
  try {
    const r = await h.learner.learn(
      { title: '包管理器', text: '这个仓库统一用 pnpm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    // 造一份带旧字段的文件：真实盘上就有这种条目（候选长期不经过清理路径）。
    const docPath = join(h.memoriesRoot, r.id + '.md')
    writeFileSync(docPath, h.readDoc(r.id).replace('auto_status:', 'auto_confidence: "0.40"\nauto_status:'), 'utf8')
    assert.equal(pickField(h.readDoc(r.id), 'auto_confidence'), '0.40', '前置条件：旧字段在盘上')
    // 用户编辑这条路径此前漏了清理。
    assert.equal((await h.learner.update(r.id, '这个仓库统一用 pnpm，不要用 npm')).ok, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_confidence'), '', 'update 要清掉废弃字段')
  } finally { h.done() }
})

test('autoActive：工作区 + 用户原话直接生效，且证据不冒充用户批准', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const r = await h.learner.learn(
      { text, key: 'package-manager', quote: text, autoActive: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'active')
    assert.equal(r.autoActive, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    const entry = h.readState().entries[r.id]
    assert.equal(entry.evidence[0].source, 'user_explicit', '没有用户确认，不能写成 user_approved')
    assert.equal(entry.pendingReason, undefined)
  } finally { h.done() }
})

test('autoActive：全局 / 做法类 / 模型推断 / 歧义都直接生效', async () => {
  const h = harness()
  try {
    const globalText = '用户喜欢简洁的回答'
    userSaid(globalText)
    const global = await h.learner.learn(
      { text: globalText, key: 'answer-style', quote: globalText, layer: 'global', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(global.status, 'active')

    const procText = '发布前先跑构建再打 tag'
    userSaid(procText)
    const procedure = await h.learner.learn(
      { text: procText, key: 'release-steps', quote: procText, kind: 'procedure', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(procedure.status, 'active')

    const inferred = await h.learner.learn(
      { text: '这个仓库可能用 pnpm', key: 'pkg-guess', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(inferred.status, 'active')

    const mixedText = '所有项目都统一用 pnpm'
    userSaid(mixedText)
    const mixed = await h.learner.learn(
      { text: mixedText, key: 'pnpm-all', quote: mixedText, layer: 'workspace', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(mixed.status, 'active')

    const ambiguousText = '这次先这样，以后都别用 npm'
    userSaid(ambiguousText)
    const ambiguous = await h.learner.learn(
      { text: ambiguousText, key: 'ambiguous', quote: ambiguousText, autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(ambiguous.status, 'active', '自动确认由 agent 承担歧义判断')
  } finally { h.done() }
})

test('autoActive：合并进已有候选时一并升 active', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'package-manager', quote: text },
      cfgOf(), envOf(),
    )
    assert.equal(first.status, 'candidate')
    const merged = await h.learner.learn(
      { text, key: 'package-manager', quote: text, autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(merged.ok, true, merged.error)
    assert.equal(merged.merged, true)
    assert.equal(merged.status, 'active')
    assert.equal(pickField(h.readDoc(merged.id), 'auto_status'), 'active')
  } finally { h.done() }
})

test('自动确认路径也要把 kind 与保质期一起落对', async () => {
  // 自动确认 = 不弹卡，由 agent 自己承担判断。这条路径此前只验证了「状态直接生效」，
  // 没验证类型与保质期 —— 而它们才是「这条什么时候会消失」的依据。
  // 事实 / 做法 30 天后提醒复核，偏好 / 纠正不过期；判错方向会让一条会过期的做法永久驻留。
  const h = harness()
  try {
    const cases = [
      ['procedure', '发布前先跑构建再打 tag', '30'],
      ['fact', '这个仓库的测试跑在 node 24 上', '30'],
      ['preference', '回答用中文', '3650'],
      ['correction', '你刚才又把版本号改错了', '3650'],
    ]
    for (const [kind, text, ttl] of cases) {
      userSaid(text)
      const r = await h.learner.learn(
        { text, key: 'k-' + kind, quote: text, kind, autoActive: true },
        cfgOf(), envOf(),
      )
      assert.equal(r.ok, true, r.error)
      assert.equal(r.status, 'active', kind + '：自动确认后应直接生效')
      assert.equal(r.kind, kind, kind + '：返回里要带类型')
      const doc = h.readDoc(r.id)
      assert.equal(pickField(doc, 'auto_kind'), kind, kind + '：类型要落盘')
      assert.equal(pickField(doc, 'auto_ttl_days'), ttl, kind + '：保质期要按类型算')
    }
  } finally { h.done() }
})

test('setEnabled：只拨索引，不改状态、不搬文件、不进回收站', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', approved: true },
      cfgOf(), envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'active')

    const off = await h.learner.setEnabled(r.id, false)
    assert.equal(off.ok, true, off.error)
    assert.equal(h.readIndex().rules[r.id].enabled, false)
    assert.equal(h.readCatalog().entries[r.id].enabled, false)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active', '开关不改状态')
    assert.equal(existsSync(join(h.stateDir, 'trash', 'memories-trash')), false, '不进回收站')

    const on = await h.learner.setEnabled(r.id, true)
    assert.equal(on.ok, true, on.error)
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].enabled, true)
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

test('preview：预演只跑两次门禁，不再另算一次自动路径', async () => {
  const h = harness()
  try {
    const text = '这个仓库统一用 pnpm'
    userSaid(text)
    const ok = await h.learner.preview(
      { text, key: 'package-manager', quote: text },
      cfgOf(), envOf(),
    )
    assert.equal(ok.ok, true, ok.error)
    // 预演按「用户已批准」跑第二遍门禁，回包里的 status 就是点下推荐层后的结果；
    // 以前另跑的第三遍（autoConfirm 路径）已删，`direct` 不能再出现。
    assert.equal(ok.approved, true)
    assert.equal(ok.status, 'active')
    assert.equal('direct' in ok, false)

    const globalText = '用户喜欢简洁的回答'
    userSaid(globalText)
    const global = await h.learner.preview(
      { text: globalText, key: 'answer-style', quote: globalText, layer: 'global' },
      cfgOf(), envOf(),
    )
    assert.equal(global.ok, true, global.error)
    assert.equal(global.status, 'active')
    assert.equal('direct' in global, false)
  } finally { h.done() }
})

test('learn：正文按显示宽度限制（1200 汉字 / 2400 字母）', async () => {
  const h = harness()
  try {
    const longZh = '提交前先跑完整构建与测试，确认所有用例通过后再打标签。'.repeat(50)
    const r = await h.learner.learn({ text: longZh }, cfgOf(), envOf())
    assert.equal(r.ok, false)
    assert.equal(r.code, 'too-long')
    assert.match(r.error, /limit is 2400/)

    // 1200 汉字 = 宽度 2400，是允许值；1201 个汉字才超限。
    const zh1200 = ('提交前先跑完整构建与测试。'.repeat(120)).slice(0, 1200)
    assert.equal(textWidthOf(zh1200), 2400)
    const okZh = await h.learner.learn({ text: zh1200 }, cfgOf(), envOf())
    assert.notEqual(okZh.code, 'too-long', '1200 汉字应进入门禁，而不是被长度拦下')

    // 英文按同一把尺：2400 字母 = 宽度 2400；2401 才超限。
    const okEn = await h.learner.learn({ text: 'a'.repeat(2400) }, cfgOf(), envOf())
    assert.notEqual(okEn.code, 'too-long', '2400 字母应进入门禁')
    const en2401 = await h.learner.learn({ text: 'a'.repeat(2401) }, cfgOf(), envOf())
    assert.equal(en2401.code, 'too-long')

    // 混排：600 汉字 + 1200 字母 = 宽度 2400。
    const mixed = '汉'.repeat(600) + 'a'.repeat(1200)
    assert.equal(textWidthOf(mixed), 2400)
    const okMixed = await h.learner.learn({ text: mixed }, cfgOf(), envOf())
    assert.notEqual(okMixed.code, 'too-long')
  } finally { h.done() }
})

test('titleOf：标题按显示宽度截断（50 汉字 / 100 字母）', () => {
  assert.equal(titleOf('汉'.repeat(50)), '汉'.repeat(50))
  assert.equal(titleOf('汉'.repeat(51)), '汉'.repeat(50))
  assert.equal(titleOf('a'.repeat(100)), 'a'.repeat(100))
  assert.equal(titleOf('a'.repeat(101)), 'a'.repeat(100))
})

test('merge：同 key 且说法几乎一样 → 只加证据与边界，不新建第二个文件', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang' },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.ok, true, first.error)

    const second = await h.learner.learn(
      { title: '提交语言', text: '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文', key: 'commit-lang' },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.ok, true, second.error)
    assert.equal(second.merged, true, '同一件事的两种说法必须合并，否则每说一次长一条')
    assert.equal(second.id, first.id)

    assert.deepEqual(h.docs(), [first.id], '目录里只该有一个文件')
    const doc = h.readDoc(first.id)
    assert.match(pickField(doc, 'auto_alias'), /不要写英文/, '新说法要记成别名（用户下次能看见差别）')
    assert.equal(pickField(doc, 'auto_boundary'), '', '别名不是边界：混进 boundary 会让适用条件读不出来')
    assert.equal(pickField(doc, 'auto_title'), '提交语言', '合并时给旧条目补上名称')
    assert.equal(h.readCatalog().entries[first.id].title, '提交语言')
    assert.equal(h.readState().entries[first.id].evidence.length, 2, '两次说法 = 两条证据')
  } finally { h.done() }
})

test('merge：显式 slot 写回文件与 catalog（否则按新 slot 找不到，重建还会漂回去）', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang' },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.ok, true, first.error)
    const second = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文', key: 'commit-message-lang' },
      cfgOf(),
      envOf(),
    )
    assert.equal(second.merged, true)
    assert.equal(pickField(h.readDoc(first.id), 'auto_key'), 'commit-message-lang', '文件里的 slot 要跟着新名字')
    assert.equal(h.readCatalog().entries[first.id].key, 'commit-message-lang', 'catalog 与文件同源')
    // 没有显式 slot 时不能拿派生出来的 slug 覆盖掉稳定句柄。
    const third = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文' },
      cfgOf(),
      envOf(),
    )
    assert.equal(third.merged, true)
    assert.equal(pickField(h.readDoc(first.id), 'auto_key'), 'commit-message-lang', '缺省 slot 不该改写已有的那个')
  } finally { h.done() }
})

test('supersede：同 key 但说的不是一回事 → 旧的标 superseded，同 key 只留一条生效', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    const second = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，别用 npm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'candidate')
    assert.ok(r.pendingReason, '候选必须带上"为什么待确认"')
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'candidate')
    assert.equal(h.readCatalog().entries[r.id].status, 'candidate', '候选不该被注入')

    const ok = await h.learner.approve(r.id)
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.status, 'active')
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'active')
    assert.equal(h.readState().entries[r.id].pendingReason, undefined, '确认过就不该再挂"待确认"')
    assert.equal(h.readIndex().rules[r.id].enabled, true)
    assert.equal(h.readCatalog().entries[r.id].status, 'active', 'catalog 不跟着改 = 确认了还是不注入')

    // 证据升级（2026-11-10）：页面上确认的也是"用户看过这条原文" —— 推断证据升为
    // user_approved（0.85）。只升状态不动证据的话，注入门槛（L1 ≥ 0.7）永远放不过
    // 0.4 的推断，症状是"界面显示生效、上下文里永远看不见"。
    const stAfter = h.readState().entries[r.id]
    // 档位取代 confidence 小数：批准过的条目证据升到 `user_approved` → 档位 `confirmed`。
    assert.equal(stAfter.tier ?? 'confirmed', 'confirmed')
    assert.ok(stAfter.evidence.every((e) => e.source !== 'model_inference'), '推断证据应已全部升级')
    // catalog 不再存 confidence 副本：档位从 state 的证据算，派生数据里没有它。
    assert.equal('confidence' in h.readCatalog().entries[r.id], false)

    // 已归档 / 已取代的不许"确认复活"（那会绕过墓碑）
    await h.learner.forget(r.id, { actor: 'user' })
    const again = await h.learner.approve(r.id)
    assert.equal(again.ok, false)
    assert.equal(again.code, 'not-pending')
  } finally { h.done() }
})

test('approve：只取代同工作区的同 key 旧条目', async () => {
  const h = harness()
  try {
    const otherHash = 'ffffffffffffffff'
    const a = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(a.status, 'active')
    const b = await h.learner.learn(
      { text: '这个仓库统一用 yarn', key: 'package-manager' },
      cfgOf(),
      { ...envOf(), workspaceHash: otherHash },
    )
    assert.equal(b.status, 'candidate')

    const approved = await h.learner.approve(b.id)
    assert.equal(approved.ok, true, approved.error)
    assert.equal(pickField(h.readDoc(a.id), 'auto_status'), 'active', '别的工作区的同 key 旧条目不能被带走')
    assert.equal(pickField(h.readDoc(b.id), 'auto_status'), 'active')
  } finally { h.done() }
})

test('learn 没有引句一律落候选并说明理由，档位由证据算', async () => {
  const h = harness()
  try {
    // 两条都没有 `quote`：来源由系统判定为 `model_inference`，于是都要等用户确认。
    // 旧的 `tool_verified` 自报档已删除 —— 模型无从声明"我验证过"。
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.ok, true, first.error)
    assert.equal(first.status, 'candidate')
    assert.ok(first.pendingReason, '没有引句 = 推断，必须说明为什么等确认')
    assert.equal(first.tier, 'inferred')

    const inferred = await h.learner.learn(
      { text: '回答先给结论，再给理由', key: 'answer-style' },
      cfgOf(),
      envOf(),
    )
    assert.equal(inferred.ok, true, inferred.error)
    assert.equal(inferred.status, 'candidate')
    assert.ok(inferred.pendingReason, '模型推断要说明为什么等确认')
    assert.equal(tierOf(h.readState().entries[inferred.id].evidence), 'inferred')

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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '提交信息用中文', key: 'commit-lang' },
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

test('同一个 key 反复删只留一条墓碑', async () => {
  // 查询侧 `tombstonedBy` 用 `find()` 只认第一条，后面的墓碑永远不会被读到 ——
  // 留着纯占空间，而 `state.json` 每写一次就要整份序列化一遍。
  const h = harness()
  try {
    // 不能用「学三次删三次」来构造：第二次 learn 就会被墓碑拦住（那是另一条防线，
    // 见下一个测试）。这里直接对同一条 id 反复 forget，模拟用户在别处重复删。
    const r = await h.learner.learn({ text: '提交信息用中文', key: 'commit-lang' }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    for (let i = 0; i < 3; i++) await h.learner.forget(r.id, { actor: 'user' })
    const sameKey = h.readState().tombstones.filter((t) => t.key === 'commit-lang')
    assert.equal(sameKey.length, 1, '同 key 的墓碑必须只有一条，实际 ' + sameKey.length)
  } finally { h.done() }
})

test('墓碑拦截：删过的东西不能被「再说一遍」悄悄复活', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn(
      { text: '提交信息用中文', key: 'commit-lang' },
      cfgOf(),
      envOf(),
    )
    await h.learner.forget(r.id, { actor: 'user' })
    // 没给 remove 回调时正文故意留着（少删一次好过悄悄真删）—— 记下现状，下面只验"没有新增"。
    const before = h.docs()
    assert.deepEqual(before, [r.id])

    const again = await h.learner.learn(
      { text: '提交信息用中文', key: 'commit-lang' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '别动 migrations', layer: 'session' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm', key: 'package-manager' },
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
    assert.equal(pickField(doc, 'description'), '', '不再写 description：注入行直接取正文')
    const after = h.readCatalog().entries[r.id]
    assert.equal(after.oneLine, '这个仓库统一用 pnpm，不要用 npm')
    assert.ok(after.estTokens > 0)
    assert.notEqual(after.oneLine, before.oneLine)
    // catalog 重建后摘要不能退回旧说法
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
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    await h.learner.learn(
      { text: '这个仓库改用 npm 了，pnpm 不再可用', key: 'package-manager' },
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
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager' },
      cfgOf(),
      envOf(),
    )
    const second = await h.learner.learn(
      { text: '这个仓库改用 npm 了，pnpm 不再可用', key: 'package-manager' },
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
      { text: '回答先给结论，再给理由', key: 'answer-style' },
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
    for (const field of ['auto_status', 'auto_key', 'auto_kind', 'auto_basis', 'auto_workspace']) {
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

test('合并时 kind 变了要跟着改 TTL，否则第一次学错就永久固化', async () => {
  // `kind` 决定保质期：`fact` / `procedure` 30 天后提醒复核，`preference` / `correction` 不过期。
  // 早先合并只改状态与正文相关字段，`auto_kind` / `auto_ttl_days` 停在第一次的值 ——
  // 一条做法被误判成 correction（3650 天）之后，再合并多少次都改不回来。
  const h = harness()
  try {
    const text = '重开子代理时把已确认的结论写成简报'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'subagent-brief', quote: text, kind: 'correction', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(first.ok, true, first.error)
    const before = h.readDoc(first.id)
    assert.equal(pickField(before, 'auto_kind'), 'correction')
    assert.equal(pickField(before, 'auto_ttl_days'), '3650', 'correction 不过期')

    // 同一个 key 再学一次，这次判对了是 procedure → kind 与 TTL 都要跟着改。
    const again = await h.learner.learn(
      { text, key: 'subagent-brief', quote: text, kind: 'procedure', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(again.ok, true, again.error)
    const after = h.readDoc(first.id)
    assert.equal(pickField(after, 'auto_kind'), 'procedure', 'kind 要跟着合并走')
    assert.equal(pickField(after, 'auto_ttl_days'), '30', 'TTL 跟着 kind 重算')
  } finally { h.done() }
})

test('learn 的返回带 kind：回执要能告诉模型它最终被记成什么类型', async () => {
  // 类型决定保质期。模型没传 `kind` 时是 `inferKind` 按措辞猜的 —— 返回里不带这个值，
  // 工具回执就无从回显，模型也就不知道自己那条被判成了做法还是纠正。
  const h = harness()
  try {
    const text = '提交信息一律用中文'
    userSaid(text)
    const explicit = await h.learner.learn(
      { text, key: 'commit-lang', quote: text, kind: 'preference', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(explicit.ok, true, explicit.error)
    assert.equal(explicit.kind, 'preference', '显式给的类型要原样返回')

    // 不给类型时返回推断结果，而不是空 —— 空值会让回执少一行，模型看不出被猜成了什么。
    const inferred = await h.learner.learn(
      { text: '测试数据放在 tmp 目录', key: 'tmp-dir', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(inferred.ok, true, inferred.error)
    assert.equal(typeof inferred.kind, 'string', '推断出的类型也要返回')
    assert.ok(['preference', 'fact', 'correction', 'procedure'].includes(inferred.kind), '必须是四个已知类型之一')
  } finally { h.done() }
})

test('编辑时能改 kind：按新类型重算 TTL，catalog 同步', async () => {
  // 模型判错类型时，这是**唯一**的修正入口 —— 否则一条被误判成 `correction` 的做法
  // 会永久驻留（那个类型不过期），用户毫无办法。
  const h = harness()
  try {
    const text = '重开子代理时把已确认的结论写成简报'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'subagent-brief', quote: text, kind: 'correction', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(first.ok, true, first.error)
    assert.equal(pickField(h.readDoc(first.id), 'auto_ttl_days'), '3650')

    // 只改类型：正文传空串，应该保留原正文。
    const edited = await h.learner.update(first.id, '', '', undefined, 'procedure')
    assert.equal(edited.ok, true, edited.error)
    const doc = h.readDoc(first.id)
    assert.equal(pickField(doc, 'auto_kind'), 'procedure', '类型要改过来')
    assert.equal(pickField(doc, 'auto_ttl_days'), '30', 'TTL 跟着新类型重算')
    assert.match(doc, /重开子代理时把已确认的结论写成简报/, '只改类型时正文不能被清空')
    assert.equal(h.readCatalog().entries[first.id].kind, 'procedure', 'catalog 与文件同源')
  } finally { h.done() }
})

test('编辑时 kind 没变就不动 TTL', async () => {
  const h = harness()
  try {
    const text = '发布前先跑构建再打 tag'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'release-steps', quote: text, kind: 'procedure', ttlDays: 90, autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(first.ok, true, first.error)
    const edited = await h.learner.update(first.id, text, '', undefined, 'procedure')
    assert.equal(edited.ok, true, edited.error)
    assert.equal(pickField(h.readDoc(first.id), 'auto_ttl_days'), '90', '类型没变，显式 TTL 不该被冲掉')
  } finally { h.done() }
})

test('合并改了 kind 时，catalog 与文件必须同源', async () => {
  // catalog 是注入与列表的唯一数据源，文件是落盘真相。两边 kind 分家会出现：
  // 列表显示 procedure、注入按 correction 的保质期算，谁也说不清哪份对。
  const h = harness()
  try {
    const text = '重开子代理时把已确认的结论写成简报'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'subagent-brief', quote: text, kind: 'correction', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(first.ok, true, first.error)
    assert.equal(h.readCatalog().entries[first.id].kind, 'correction')

    const again = await h.learner.learn(
      { text, key: 'subagent-brief', quote: text, kind: 'procedure', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(again.ok, true, again.error)
    const docKind = pickField(h.readDoc(first.id), 'auto_kind')
    const catKind = h.readCatalog().entries[first.id].kind
    assert.equal(docKind, 'procedure', '文件里的 kind 要更新')
    assert.equal(catKind, 'procedure', 'catalog 的 kind 要与文件同源')
    assert.equal(docKind, catKind)
  } finally { h.done() }
})

test('合并时 kind 没变就不动 TTL，用户的显式 ttlDays 不被覆盖', async () => {
  const h = harness()
  try {
    const text = '发布前先跑构建再打 tag'
    userSaid(text)
    const first = await h.learner.learn(
      { text, key: 'release-steps', quote: text, kind: 'procedure', ttlDays: 90, autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(first.ok, true, first.error)
    assert.equal(pickField(h.readDoc(first.id), 'auto_ttl_days'), '90')

    const again = await h.learner.learn(
      { text, key: 'release-steps', quote: text, kind: 'procedure', autoActive: true },
      cfgOf(), envOf(),
    )
    assert.equal(again.ok, true, again.error)
    assert.equal(pickField(h.readDoc(first.id), 'auto_ttl_days'), '90', 'kind 没变，显式 TTL 不该被冲掉')
  } finally { h.done() }
})

test('organize → applyOrganize(merge)：保留项正文不动、被并项转 superseded、证据并过来', async () => {
  const h = harness()
  try {
    const a = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang' },
      cfgOf(),
      envOf(),
    )
    const b = await h.learner.learn(
      { text: '提交信息别写英文', key: 'commit-message-lang' },
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
    assert.match(pickField(h.readDoc(a.id), 'auto_alias'), /不要写英文/, '被并项的说法要记成保留项的别名')
    assert.equal(h.readState().entries[a.id].evidence.length, 2, '证据并过来，置信度才不会因为少了一条而掉')

    // 再算一次不该再出同一对：草案必须以"当前状态"为输入，否则界面点两次都成功。
    const again = await h.learner.organize('workspace')
    assert.equal(again.ok, true, again.error)
    assert.equal(again.drafts.filter((d) => d.action === 'merge').length, 0)
  } finally { h.done() }
})

test('applyOrganize(merge) 自己再拦一次跨类型：应用的是客户端手里的旧草案', async () => {
  // 草案阶段已经拦过一次（`draftOrganize` 要求同 kind）。这里再拦，是因为「应用」回传的
  // 是客户端手里的旧草案 —— 期间若有一条被改了类型，两道校验之间就有空档。
  // 合错了不报错，只会让一条做法悄悄变成永不过期。
  const h = harness()
  try {
    const a = await h.learner.learn(
      { text: '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文', key: 'commit-lang', kind: 'procedure' },
      cfgOf(), envOf(),
    )
    const b = await h.learner.learn(
      { text: '提交信息别写英文', key: 'commit-message-lang', kind: 'preference' },
      cfgOf(), envOf(),
    )
    assert.equal(a.ok, true, a.error)
    assert.equal(b.ok, true, b.error)
    assert.equal(pickField(h.readDoc(a.id), 'auto_kind'), 'procedure')
    assert.equal(pickField(h.readDoc(b.id), 'auto_kind'), 'preference')

    // 绕过草案直接应用（模拟旧草案 / 手改过的回传）。
    const res = await h.learner.applyOrganize({ action: 'merge', ids: [a.id, b.id], keep: a.id })
    assert.equal(res.ok, false, '跨类型合并必须被拒')
    assert.equal(res.code, 'kind-mismatch')
    assert.match(res.error, /procedure/)
    assert.match(res.error, /preference/)
    // 被拒之后两条都还在，谁也没被 superseded。
    assert.equal(pickField(h.readDoc(a.id), 'auto_status') !== 'superseded', true)
    assert.equal(pickField(h.readDoc(b.id), 'auto_status') !== 'superseded', true)
  } finally { h.done() }
})

// ── 对话卡片：批准直接生效 ─────────────────────────────────────────────────

test('preview：只读预演不落盘；批准后 model_inference 直接生效并升级证据', async () => {
  const h = harness()
  try {
    const req = { text: '这个仓库统一用 pnpm', key: 'package-manager' }
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
    assert.equal(st.entries[r.id].pendingReason, undefined)
    assert.equal(st.entries[r.id].evidence[0].source, 'user_approved')
    assert.equal(st.entries[r.id].tier ?? 'confirmed', 'confirmed')
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
    const req = { text: '这个仓库统一用 pnpm，不要用 npm。', key: 'package-manager' }
    const p = await h.learner.preview(req, cfgOf(), envOf())
    assert.equal(p.ok, true, p.error)
    assert.equal(p.status, 'candidate')
    assert.equal(p.reviewCode, 'user-conflict')

    const r = await h.learner.learn({ ...req, approved: true }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    assert.equal(r.status, 'candidate')
    assert.equal(r.reviewCode, 'user-conflict')
    assert.ok(r.pendingReason)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'candidate')
  } finally { h.done() }
})

test('approved + 同 key 生效旧说法：新说法直接取代旧的', async () => {
  const h = harness()
  try {
    const first = await h.learner.learn(
      { text: '这个仓库统一用 pnpm，不要用 npm', key: 'package-manager', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(first.status, 'active')
    const second = await h.learner.learn(
      { text: '这个仓库统一用 yarn', key: 'package-manager', approved: true },
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
      { text: '所有项目统一用 pnpm 管理依赖', key: 'pkg-global', layer: 'global', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(globalFirst.layer, 'global')
    const workspace = await h.learner.learn(
      { text: '所有项目统一用 pnpm 管理依赖', key: 'pkg-global', layer: 'workspace', approved: true },
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
      { text: '发布前先跑完整测试', key: 'release-test', approved: true },
      cfgOf(),
      envOf(),
    )
    await h.learner.setStatus(old.id, 'archived', 'user')
    const r = await h.learner.learn(
      { text: '发布前先跑完整测试', key: 'release-test', approved: true },
      cfgOf(),
      envOf(),
    )
    assert.equal(r.ok, true, r.error)
    assert.notEqual(r.id, old.id, '归档条目不能吞掉新学到的同一条')
    assert.equal(r.status, 'active')
    assert.equal(pickField(h.readDoc(old.id), 'auto_status'), 'archived')
  } finally { h.done() }
})

test('state.json 损坏：留存副本、写下隔离标记、此后的写入一律拒绝', async () => {
  // 这条链最危险的失败不是「读坏」，而是**读坏之后继续写**：文件被搬走后下一次读得到
  // `missing`，那是全新用户的正常状态 —— 于是任意一次写（编辑一条笔记、每日维护扫描）
  // 都会把空状态整份写回，entries 与 tombstones 一起清零。墓碑丢了，用户删过的内容会被
  // 自动路径重新学回来；证据链丢了，已确认的记忆失去「凭什么记」。两者都不可重建。
  const h = harness()
  try {
    const stateFile = join(h.stateDir, 'evolution', 'state.json')
    mkdirSync(join(h.stateDir, 'evolution'), { recursive: true })
    writeFileSync(stateFile, '{ this is not json')
    const bad = await h.state.readFresh()
    assert.equal(bad.ok, false)
    assert.match(bad.error, /已被隔离/)
    const q = await h.state.quarantined()
    assert.ok(q, '必须留下隔离标记')
    // `keptFile` 唯一的用途是写进给用户看的那句话，必须是**能直接打开的绝对路径**。
    // 早先这里存的是 hub 相对路径（`corruptBackupPath()` 的返回值），用户拿到一个没法用的路径。
    assert.equal(isAbsolute(q.keptFile), true, 'keptFile 必须是绝对路径：' + q.keptFile)
    assert.equal(existsSync(q.keptFile), true, '留存副本必须真的落盘：' + q.keptFile)
    assert.match(bad.error, new RegExp(q.keptFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '报错文案里要带上那个路径')
    // 原文件一个字节都不动：它是用户唯一的证据链。
    assert.equal(readFileSync(stateFile, 'utf8'), '{ this is not json')
    // 隔离期间任何写入都必须被拒 —— 包括绕过 readFresh 直接调 write 的那种。
    const w = await h.state.write({ version: 1, entries: {}, tombstones: [], watermarks: {} })
    assert.equal(w.ok, false, '隔离期间不许落盘')
    assert.equal(readFileSync(stateFile, 'utf8'), '{ this is not json')
  } finally { h.done() }
})
