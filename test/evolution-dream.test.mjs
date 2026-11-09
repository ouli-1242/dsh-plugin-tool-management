// dream（P3）的测试：草案校验、生成、应用、回滚与漂移保护。
//
// 这份测试的重点不是"模型说了什么"，而是**代码守住了哪些不变量**：
//   · 跨层 / 用户记忆 / 锁定条目永远不进草案；
//   · 应用前的备份必须能 100% 盖回去；
//   · 应用之后又学了新东西时，回滚必须拒绝（除非用户明确强制）——
//     否则一次误点会连带撤销刚学会的几条，而用户根本不会知道。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDreamPrompt,
  createDreamer,
  parseDreamPlan,
  shouldDreamToday,
  shouldRetryDream,
  MAX_DREAM_OPS,
} from '../lib/evolution/dream.js'
import { DEFAULT_EVOLUTION_SETTINGS, workspaceHashOf } from '../lib/evolution/config.js'
import { createEvolutionState } from '../lib/evolution/state.js'
import { createEpisodeStore } from '../lib/evolution/episodes.js'
import { createLearner, pickField } from '../lib/evolution/write.js'
import { layerOfGroup } from '../lib/memories/constants.js'

const HUB = 'tool-management'
const WS_KEY = 'D:/work/dream-demo'
const WS_HASH = workspaceHashOf(WS_KEY)

const cfgOf = (over = {}) => ({
  ...DEFAULT_EVOLUTION_SETTINGS,
  enabled: true,
  inject: true,
  learnScope: 'workspace',
  writeTarget: 'route',
  // 后台整理跑在没有对话的时机，`liveRoute` 通常是空的 —— 模型必须由配置兜底。
  model: 'p/m',
  source: 'global',
  ...over,
})

const message = (e) => String(e?.message || e)

async function readJsonFileStrict(abs) {
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch (e) {
    if (String(e?.code || '') === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', error: message(e) }
  }
  try {
    return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) }
  } catch (e) {
    return { status: 'corrupt', error: message(e) }
  }
}

const serializeRuleFile = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n' + body + '\n'

const bodyOf = (text) => {
  const s = String(text ?? '')
  if (!s.startsWith('---\n')) return s.trim()
  const end = s.indexOf('\n---', 4)
  return end < 0 ? s.trim() : s.slice(end + 4).trim()
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evo-dream-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const stateDir = join(home, HUB)
  const memoriesRoot = join(stateDir, 'memories')
  mkdirSync(memoriesRoot, { recursive: true })

  const state = createEvolutionState({
    ensurePaths: async () => mkdirSync(join(stateDir, 'evolution'), { recursive: true }),
    readJsonFileStrict,
    message,
  })

  async function listEntries() {
    const entries = []
    const walk = (dir, group) => {
      let list
      try { list = readdirSafe(dir) } catch { return }
      for (const e of list) {
        const p = join(dir, e.name)
        const g = group === '' ? e.name : `${group}/${e.name}`
        if (e.isDirectory()) { walk(p, g); continue }
        if (!e.name.endsWith('.md')) continue
        const text = readFileSync(p, 'utf8')
        entries.push({
          id: g.replace(/\.md$/, ''),
          path: p,
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
    existingEntries: listEntries,
    knownWorkspaces: async () => new Set([WS_HASH]),
    serializeRuleFile,
    memoriesRoot,
    stateDir,
    invalidateSnapshot: () => {},
    withWriteLock: (fn) => fn(),
    message,
  })

  const episodes = createEpisodeStore({ stateDir, message })

  return {
    home, stateDir, memoriesRoot, learner, state, episodes,
    done() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    },
    readState: () => JSON.parse(readFileSync(join(stateDir, 'evolution', 'state.json'), 'utf8')),
    readDoc: (id) => readFileSync(join(memoriesRoot, id + '.md'), 'utf8'),
    /** 与 index 里那份 `evolutionEntryView` 同构（catalog 的替身）。 */
    async view() {
      const { entries } = await listEntries()
      const st = (await state.read()).state
      return entries
        .filter((e) => e.origin === 'auto')
        .map((e) => {
          const s = st.entries[e.id]
          return {
            id: e.id,
            layer: e.layer,
            key: e.key,
            status: e.status,
            origin: 'auto',
            oneLine: e.text.replaceAll(/\s+/g, ' ').slice(0, 160),
            confidence: s?.confidence ?? 0,
            tokens: Math.max(1, Math.ceil(e.text.length / 3)),
            ...(s?.locked ? { locked: true } : {}),
            helpful: s?.counters?.helpful ?? 0,
            harmful: s?.counters?.harmful ?? 0,
            evidence: 0,
          }
        })
    },
  }
}

function readdirSafe(dir) {
  return readdirSync(dir, { withFileTypes: true })
}

/** 一个只会吐固定文本的假模型。 */
function fakeLlm(text) {
  return {
    async prepareCall() {
      return {
        config: {},
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text }
          })()
        },
      }
    },
  }
}

const entry = (over) => ({
  id: 'x',
  layer: 'workspace',
  key: '',
  status: 'active',
  origin: 'auto',
  oneLine: '',
  confidence: 0.8,
  tokens: 10,
  helpful: 0,
  harmful: 0,
  evidence: 1,
  ...over,
})

// ── 校验 ───────────────────────────────────────────────────────────────────

test('parseDreamPlan：合法的三条 op 原样通过', () => {
  const ctx = {
    entries: [
      entry({ id: '_ws/h/a', key: 'pnpm' }),
      entry({ id: '_ws/h/b', key: 'lockfile' }),
      // 升 core 必须是 active（candidate 得先转正）且 helpful ≥ 3。
      entry({ id: '_ws/h/c', status: 'active', helpful: 3 }),
      entry({ id: '_ws/h/d' }),
    ],
  }
  const r = parseDreamPlan({
    ops: [
      { op: 'merge', keep: '_ws/h/a', drop: ['_ws/h/b'], reason: 'same rule' },
      { op: 'archive', id: '_ws/h/d', reason: 'stale' },
      { op: 'promote', id: '_ws/h/c', status: 'core', reason: 'used a lot' },
    ],
  }, ctx)
  assert.equal(r.ok, true)
  assert.equal(r.dropped, 0)
  assert.deepEqual(r.plan.ops.map((o) => o.op), ['merge', 'archive', 'promote'])
})

test('parseDreamPlan：跨层合并、用户记忆、锁定条目都进不来', () => {
  const ctx = {
    entries: [
      entry({ id: '_ws/h/a' }),
      entry({ id: 'global/b', layer: 'global' }),
      entry({ id: '_ws/h/u', origin: 'user' }),
      entry({ id: '_ws/h/l', locked: true }),
    ],
  }
  const r = parseDreamPlan({
    ops: [
      { op: 'merge', keep: '_ws/h/a', drop: ['global/b'], reason: 'x' },
      { op: 'merge', keep: '_ws/h/a', drop: ['_ws/h/u'], reason: 'x' },
      { op: 'archive', id: '_ws/h/l', reason: 'x' },
      { op: 'archive', id: '_ws/h/u', reason: 'x' },
    ],
  }, ctx)
  assert.equal(r.ok, true)
  assert.equal(r.plan.ops.length, 0)
  assert.equal(r.dropped, 4)
})

test('parseDreamPlan：把 core 并进非 core = 悄悄降级，拒绝', () => {
  const ctx = { entries: [entry({ id: 'a', status: 'active' }), entry({ id: 'b', status: 'core' })] }
  const r = parseDreamPlan({ ops: [{ op: 'merge', keep: 'a', drop: ['b'], reason: 'same' }] }, ctx)
  assert.equal(r.plan.ops.length, 0)
  assert.equal(r.dropped, 1)
})

test('parseDreamPlan：promote 的门槛与治理表一致（候选要 0.6 或两条证据）', () => {
  const ctx = {
    entries: [
      entry({ id: 'weak', status: 'candidate', confidence: 0.4, evidence: 1 }),
      entry({ id: 'strong', status: 'candidate', confidence: 0.4, evidence: 2 }),
      entry({ id: 'core-weak', helpful: 1 }),
      entry({ id: 'core-ok', helpful: 3 }),
      // 候选直接升 core = 跳过"转正"这一步，治理表里没有这条跃迁。
      entry({ id: 'skip', status: 'candidate', confidence: 0.9, helpful: 5 }),
    ],
  }
  const r = parseDreamPlan({
    ops: [
      { op: 'promote', id: 'weak', status: 'active', reason: 'x' },
      { op: 'promote', id: 'strong', status: 'active', reason: 'x' },
      { op: 'promote', id: 'core-weak', status: 'core', reason: 'x' },
      { op: 'promote', id: 'core-ok', status: 'core', reason: 'x' },
      { op: 'promote', id: 'skip', status: 'core', reason: 'x' },
    ],
  }, ctx)
  assert.deepEqual(r.plan.ops.map((o) => o.id), ['strong', 'core-ok'])
  assert.equal(r.dropped, 3)
})

test('parseDreamPlan：同一 id 只能出现在一条 op 里，超过上限截断', () => {
  const many = Array.from({ length: MAX_DREAM_OPS + 5 }, (_, i) => entry({ id: 'e' + i }))
  const ctx = { entries: many }
  const ops = many.map((e) => ({ op: 'archive', id: e.id, reason: 'x' }))
  const r = parseDreamPlan({ ops }, ctx)
  assert.equal(r.ok, true)
  assert.equal(r.plan.ops.length, MAX_DREAM_OPS)
  // 第一条 merge 已经吃掉了 keep，后面再 archive keep 必须无效。
  const r2 = parseDreamPlan({
    ops: [
      { op: 'merge', keep: 'e0', drop: ['e1'], reason: 'x' },
      { op: 'archive', id: 'e0', reason: 'again' },
    ],
  }, ctx)
  assert.deepEqual(r2.plan.ops.map((o) => o.op), ['merge'])
})

test('buildDreamPrompt：只给一行摘要，不塞正文；id 必须在', () => {
  const p = buildDreamPrompt({
    entries: [entry({ id: '_ws/h/abc', oneLine: '用 pnpm 而不是 npm' })],
    episodes: [],
    corrections: [],
  })
  assert.match(p, /_ws\/h\/abc/)
  assert.match(p, /用 pnpm 而不是 npm/)
  assert.match(p, /只输出 JSON/)
})

// ── 生成 / 应用 / 回滚 ─────────────────────────────────────────────────────

/** 造 4 条同一层、不同 key 的活条目，满足"库不够大就不整理"的门槛。 */
async function seed(h) {
  const ids = []
  const rows = [
    ['pnpm', '这个仓库统一用 pnpm', 'tool_verified'],
    ['lockfile', '不要提交 pnpm-lock.yaml 之外的锁文件', 'tool_verified'],
    ['node', 'Node 版本用 20 LTS', 'tool_verified'],
    ['test', '跑测试用 node --test', 'tool_verified'],
  ]
  for (const [key, text, source] of rows) {
    const r = await h.learner.learn({ text, key, source }, cfgOf(), { sessionId: 's-1', workspaceHash: WS_HASH })
    assert.equal(r.ok, true, r.error)
    ids.push(r.id)
  }
  return ids
}

function makeDreamer(h, llmText, now) {
  return createDreamer({
    llm: fakeLlm(llmText),
    learner: h.learner,
    state: h.state,
    episodes: h.episodes,
    entries: () => h.viewEntries ?? [],
    rebuildCatalog: async () => {},
    memoriesRoot: h.memoriesRoot,
    stateDir: h.stateDir,
    withWriteLock: (fn) => fn(),
    log: async () => {},
    message,
    ...(now !== undefined ? { now: () => now } : {}),
  })
}

test('dream：生成草案但不改库；watermark 记下时间', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    const now = Date.parse('2026-05-01T10:00:00Z')
    const llm = JSON.stringify({
      ops: [{ op: 'merge', keep: ids[0], drop: [ids[1]], reason: 'same package-manager rule' }],
    })
    const dreamer = makeDreamer(h, llm, now)
    const out = await dreamer.dream(cfgOf(), null)
    assert.equal(out.ok, true, out.error)
    assert.equal(out.ops, 1)
    // 库没动：两条都还是 active。
    assert.equal(pickField(h.readDoc(ids[0]), 'auto_status'), 'active')
    assert.equal(pickField(h.readDoc(ids[1]), 'auto_status'), 'active')
    // 草案落盘。
    const draft = JSON.parse(readFileSync(join(h.stateDir, 'evolution/dreams', out.draftId, 'draft.json'), 'utf8'))
    assert.equal(draft.plan.ops.length, 1)
    assert.equal(draft.model, 'p/m')
    // 状态水位：试过 + 成功都记。
    const st = h.readState()
    assert.ok(st.watermarks.lastDreamAt)
    assert.ok(st.watermarks.lastDreamTryAt)
  } finally {
    h.done()
  }
})

test('dream：库太小直接拒绝，不烧模型', async () => {
  const h = harness()
  try {
    await h.learner.learn({ text: '用 pnpm', key: 'pnpm', source: 'tool_verified' }, cfgOf(), { sessionId: 's-1', workspaceHash: WS_HASH })
    h.viewEntries = await h.view()
    let called = 0
    const dreamer = createDreamer({
      llm: { async prepareCall() { called++; return { config: {}, stream: () => (async function* () {})() } } },
      learner: h.learner,
      state: h.state,
      episodes: h.episodes,
      entries: () => h.viewEntries,
      rebuildCatalog: async () => {},
      memoriesRoot: h.memoriesRoot,
      stateDir: h.stateDir,
      withWriteLock: (fn) => fn(),
      log: async () => {},
      message,
    })
    const out = await dreamer.dream(cfgOf(), null)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'too-small')
    assert.equal(called, 0)
  } finally {
    h.done()
  }
})

test('dream：既没有 live 路由也没有配置模型 → 直接返回，不调模型', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    let called = 0
    const text = JSON.stringify({ ops: [{ op: 'archive', id: ids[3], reason: 'duplicate' }] })
    const dreamer = createDreamer({
      llm: {
        async prepareCall() {
          called++
          return { config: {}, stream: () => (async function* () { yield { type: 'text-delta', text } })() }
        },
      },
      learner: h.learner,
      state: h.state,
      episodes: h.episodes,
      entries: () => h.viewEntries,
      rebuildCatalog: async () => {},
      memoriesRoot: h.memoriesRoot,
      stateDir: h.stateDir,
      withWriteLock: (fn) => fn(),
      log: async () => {},
      message,
    })
    const out = await dreamer.dream(cfgOf({ model: '' }), null)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'no-model')
    assert.equal(called, 0)
    // live 路由能兜住：这一轮对话用的什么模型，整理就用什么。
    const live = await dreamer.dream(cfgOf({ model: '' }), { provider: 'live', model: 'm2' })
    assert.equal(live.ok, true, live.error)
    assert.equal(called, 1)
    const draft = JSON.parse(readFileSync(join(h.stateDir, 'evolution/dreams', live.draftId, 'draft.json'), 'utf8'))
    assert.equal(draft.model, 'live/m2')
  } finally {
    h.done()
  }
})

test('apply：改状态、备份文件，重复应用被拒', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    const llm = JSON.stringify({ ops: [{ op: 'merge', keep: ids[0], drop: [ids[1]], reason: 'same' }] })
    const dreamer = makeDreamer(h, llm, Date.parse('2026-05-01T10:00:00Z'))
    const draft = await dreamer.dream(cfgOf(), null)
    assert.equal(draft.ok, true, draft.error)

    const applied = await dreamer.apply(draft.draftId)
    assert.equal(applied.ok, true, applied.error)
    assert.equal(pickField(h.readDoc(ids[0]), 'auto_status'), 'active')
    assert.equal(pickField(h.readDoc(ids[1]), 'auto_status'), 'superseded')

    const dir = join(h.stateDir, 'evolution/dreams', draft.draftId)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'applied')
    assert.ok(manifest.backup.includes('memories/' + ids[1] + '.md'))
    assert.ok(manifest.stateHash)
    // 备份里存的是应用**前**的正文。
    const backup = readFileSync(join(dir, 'backup/memories', ids[1] + '.md'), 'utf8')
    assert.equal(pickField(backup, 'auto_status'), 'active')

    const again = await dreamer.apply(draft.draftId)
    assert.equal(again.ok, false)
    assert.equal(again.code, 'already-applied')
  } finally {
    h.done()
  }
})

test('apply：草案与现有库对不上时整批拒绝（stale），不写半个', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    const draftId = '20260501-100000'
    const dir = join(h.stateDir, 'evolution/dreams', draftId)
    mkdirSync(dir, { recursive: true })
    const plan = { version: 1, createdAt: new Date().toISOString(), ops: [{ op: 'archive', id: ids[0], reason: 'x' }, { op: 'archive', id: 'gone', reason: 'x' }], notes: '' }
    writeFileSync(join(dir, 'draft.json'), JSON.stringify({ version: 1, id: draftId, createdAt: plan.createdAt, model: 'm', plan, dropped: 0, tokensBefore: 1, tokensAfter: 0 }))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id: draftId, createdAt: plan.createdAt, status: 'draft', backup: [], results: [] }))
    const dreamer = makeDreamer(h, '{}')
    const out = await dreamer.apply(draftId)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'stale')
    assert.equal(pickField(h.readDoc(ids[0]), 'auto_status'), 'active')
  } finally {
    h.done()
  }
})

test('revert：正文与 state 一起回到应用前', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    const before = h.readState()
    const llm = JSON.stringify({ ops: [{ op: 'merge', keep: ids[0], drop: [ids[1]], reason: 'same' }] })
    const dreamer = makeDreamer(h, llm, Date.parse('2026-05-01T10:00:00Z'))
    const draft = await dreamer.dream(cfgOf(), null)
    assert.equal((await dreamer.apply(draft.draftId)).ok, true)

    const back = await dreamer.revert(draft.draftId)
    assert.equal(back.ok, true, back.error)
    assert.equal(pickField(h.readDoc(ids[1]), 'auto_status'), 'active')
    const after = h.readState()
    // 证据 / 计数器 / 状态全部回到应用前。
    assert.deepEqual(after.entries[ids[1]].evidence, before.entries[ids[1]].evidence)
    assert.equal(after.entries[ids[1]].confidence, before.entries[ids[1]].confidence)
    const manifest = JSON.parse(readFileSync(join(h.stateDir, 'evolution/dreams', draft.draftId, 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'reverted')
  } finally {
    h.done()
  }
})

test('revert：应用之后又学了新东西 → 拒绝；force 才越过', async () => {
  const h = harness()
  try {
    const ids = await seed(h)
    h.viewEntries = await h.view()
    const llm = JSON.stringify({ ops: [{ op: 'archive', id: ids[0], reason: 'x' }] })
    const dreamer = makeDreamer(h, llm, Date.parse('2026-05-01T10:00:00Z'))
    const draft = await dreamer.dream(cfgOf(), null)
    assert.equal((await dreamer.apply(draft.draftId)).ok, true)

    // 应用之后再学一条：state.json 变了，整份回滚会把它一起抹掉。
    await h.learner.learn({ text: '部署用 make deploy', key: 'deploy', source: 'tool_verified' }, cfgOf(), { sessionId: 's-2', workspaceHash: WS_HASH })

    const blocked = await dreamer.revert(draft.draftId)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'drift')
    assert.equal(pickField(h.readDoc(ids[0]), 'auto_status'), 'archived')

    const forced = await dreamer.revert(draft.draftId, { force: true })
    assert.equal(forced.ok, true, forced.error)
    assert.equal(pickField(h.readDoc(ids[0]), 'auto_status'), 'active')
  } finally {
    h.done()
  }
})

test('shouldDreamToday / shouldRetryDream：每日一次、失败 6 小时后才再试', () => {
  const now = Date.parse('2026-05-01T10:00:00Z')
  assert.equal(shouldDreamToday(cfgOf(), undefined, now), true)
  assert.equal(shouldDreamToday(cfgOf(), new Date(now - 3600_000).toISOString(), now), false)
  assert.equal(shouldDreamToday(cfgOf(), new Date(now - 25 * 3600_000).toISOString(), now), true)
  assert.equal(shouldDreamToday(cfgOf({ dream: 'off' }), undefined, now), false)
  assert.equal(shouldDreamToday(cfgOf({ enabled: false }), undefined, now), false)
  assert.equal(shouldRetryDream(undefined, now), true)
  assert.equal(shouldRetryDream(new Date(now - 3600_000).toISOString(), now), false)
  assert.equal(shouldRetryDream(new Date(now - 7 * 3600_000).toISOString(), now), true)
})
