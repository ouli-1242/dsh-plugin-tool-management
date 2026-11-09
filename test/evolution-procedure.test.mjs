// P4 程序性记忆：步骤、成功计数、playbook 注入、技能提议的 lint 与回滚。
//
// 这一批最容易"看起来好了、其实没生效"的地方有三处，所以测试一律读回真文件 / 真状态：
//   · frontmatter 只认标量 —— 步骤塞进去会被截断，而写入不报错；
//   · playbook 注入只放标题 —— 忘了改渲染，模型每轮都会收到十几行步骤；
//   · 技能写完不 lint —— createSkill 返回 OK 但清单里是一条 loadable:false 的废技能。
// 技能侧用一套假的 skillsOps，故意把"文件写上了"和"宿主能加载"拆成两步，才能测到回滚。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  cleanSteps, parseProcedureSteps, renderProcedureBody, procedureTitleOf,
  canPromotePlaybook, recordProcedureUse, skillNameOf, skillDraftOf, lintSkillText,
  createProcedureSkillStore, PLAYBOOK_SUCCESS_THRESHOLD,
} from '../lib/evolution/procedure.js'
import { normalizeProcedure } from '../lib/evolution/state.js'
import { lineOf, renderAutoBlock } from '../lib/memories/render-auto.js'
import { DEFAULT_EVOLUTION_SETTINGS, workspaceHashOf } from '../lib/evolution/config.js'
import { createEvolutionState } from '../lib/evolution/state.js'
import { createLearner, pickField } from '../lib/evolution/write.js'
import { layerOfGroup } from '../lib/memories/constants.js'
import { buildEvolutionOps } from '../lib/ops/evolution.js'

const message = (e) => String(e?.message || e)
const HUB = 'tool-management'
const WS_KEY = 'D:/work/demo'
const WS_HASH = workspaceHashOf(WS_KEY)

const cfgOf = (over = {}) => ({
  ...DEFAULT_EVOLUTION_SETTINGS,
  enabled: true,
  inject: true,
  learnScope: 'workspace',
  writeTarget: 'route',
  source: 'global',
  ...over,
})

// ───────────────────────────── 纯函数 ─────────────────────────────

test('cleanSteps：剥掉编号前缀、去空、限长限条数', () => {
  assert.deepEqual(cleanSteps(['1. 跑测试', '- 打 tag', '  3) 推上去  ', '', 42, 'x'.repeat(500)]),
    ['跑测试', '打 tag', '推上去', 'x'.repeat(240)])
  const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. step${i}`)
  assert.equal(cleanSteps(many).length, 12)
})

test('renderProcedureBody → parseProcedureSteps 往返一致', () => {
  const steps = ['先跑 pnpm test', '打 tag 并推到远端', '确认 CI 全绿']
  const body = renderProcedureBody('发布流程按这三步走', 'CI 挂了就先停', steps)
  assert.match(body, /## 步骤/)
  assert.match(body, /边界：CI 挂了就先停/)
  assert.deepEqual(parseProcedureSteps(body), steps)
  // 没有步骤时退回旧的一句话形态，不凭空造出流程。
  const plain = renderProcedureBody('这是个做法', undefined, [])
  assert.deepEqual(parseProcedureSteps(plain), [])
  assert.match(plain, /做法类/)
})

test('parseProcedureSteps：不把 prose 里的编号当流程，遇到下一个标题就停', () => {
  assert.deepEqual(parseProcedureSteps('一句话结论\n这里有 1. 个数字，但不是流程。'), [])
  const body = '## 步骤\n1. A\n2. B\n\n## 注意\n- 不要跳过测试\n- 以项目文件为准\n'
  assert.deepEqual(parseProcedureSteps(body), ['A', 'B'])
})

test('procedureTitleOf：取第一句、压平空白、限长、有兜底', () => {
  assert.equal(procedureTitleOf('发布流程按这三步走。CI 挂了就停。', 'deploy-flow'), '发布流程按这三步走')
  assert.equal(procedureTitleOf('  换行\n也算   空白  '), '换行 也算 空白')
  assert.equal(procedureTitleOf(''), 'procedure')
  assert.equal(procedureTitleOf('', 'deploy-flow'), 'deploy-flow')
  assert.equal(procedureTitleOf('x'.repeat(200)).length, 60)
})

test('canPromotePlaybook：治理表的每一道都拦得住', () => {
  const base = { kind: 'procedure', status: 'core', steps: ['a', 'b'], successes: 3, harmful: 0 }
  assert.equal(canPromotePlaybook(base).ok, true)
  assert.equal(canPromotePlaybook({ ...base, kind: 'fact' }).reason, 'not-a-procedure')
  assert.equal(canPromotePlaybook({ ...base, steps: [] }).reason, 'no-steps')
  assert.equal(canPromotePlaybook({ ...base, status: 'active' }).reason, 'not-core')
  assert.equal(canPromotePlaybook({ ...base, status: 'playbook' }).reason, 'already-playbook')
  assert.equal(canPromotePlaybook({ ...base, successes: 2 }).reason, 'not-proven')
  assert.equal(canPromotePlaybook({ ...base, harmful: 1 }).reason, 'harmful')
  assert.equal(canPromotePlaybook({ ...base, needsReview: 'ttl' }).reason, 'needs-review')
  assert.equal(PLAYBOOK_SUCCESS_THRESHOLD, 3)
})

test('recordProcedureUse：成功与失败分开记，时间戳各自独立', () => {
  const a = recordProcedureUse(undefined, true, '2026-11-09T00:00:00Z')
  assert.deepEqual(a, { steps: [], successes: 1, failures: 0, lastSucceededAt: '2026-11-09T00:00:00Z' })
  const b = recordProcedureUse(a, false, '2026-11-10T00:00:00Z')
  assert.equal(b.successes, 1)
  assert.equal(b.failures, 1)
  assert.equal(b.lastFailedAt, '2026-11-10T00:00:00Z')
  assert.equal(b.lastSucceededAt, '2026-11-09T00:00:00Z')
})

test('normalizeProcedure：脏记录不拖垮 state，空步骤视为不存在', () => {
  assert.equal(normalizeProcedure(null), undefined)
  assert.equal(normalizeProcedure({ steps: [] }), undefined)
  assert.equal(normalizeProcedure({ steps: 'not an array' }), undefined)
  const p = normalizeProcedure({ steps: [' a ', 7, ''], successes: -3, failures: '2', lastSucceededAt: 'x' })
  assert.deepEqual(p, { steps: ['a'], successes: 0, failures: 2, lastSucceededAt: 'x' })
})

test('skillNameOf：中文标题落空时用可复现的哈希兜底', () => {
  assert.equal(skillNameOf('deploy-flow', '发布流程'), 'deploy-flow')
  assert.equal(skillNameOf('', '发布流程'), skillNameOf('', '发布流程'))
  assert.match(skillNameOf('', '发布流程'), /^learned-[0-9a-f]{8}$/)
  assert.notEqual(skillNameOf('', '发布流程'), skillNameOf('', '另一份流程'))
})

test('skillDraftOf：body 不含 frontmatter，步骤、边界、来源都在', () => {
  const d = skillDraftOf({
    id: '_ws/h/deploy-flow', key: 'deploy-flow', title: '发布流程',
    description: '发布流程按这三步走', steps: ['跑测试', '打 tag', '推远端'],
    boundary: 'CI 用 npm', successes: 3,
  })
  assert.equal(d.name, 'deploy-flow')
  assert.match(d.description, /成功 3 次/)
  assert.equal(d.body.startsWith('---'), false)
  assert.match(d.body, /_ws\/h\/deploy-flow/)
  assert.match(d.body, /## 边界/)
  assert.deepEqual(parseProcedureSteps(d.body), ['跑测试', '打 tag', '推远端'])
})

test('lintSkillText：合法文件通过，五种坏法各自报得出原因', () => {
  const d = skillDraftOf({ id: 'x', key: 'deploy-flow', title: '发布流程', description: '', steps: ['跑测试', '打 tag'], successes: 3 })
  const good = `---\nname: ${d.name}\ndescription: ${d.description}\n---\n\n${d.body}\n`
  assert.equal(lintSkillText(good, d.name).ok, true)
  assert.match(lintSkillText('', d.name).errors.join(), /empty file/)
  assert.match(lintSkillText(`---\ndescription: x\n---\n\n${d.body}\n`, d.name).errors.join(), /missing name/)
  assert.match(lintSkillText(good.replace('name: deploy-flow', 'name: other'), d.name).errors.join(), /name mismatch/)
  assert.match(lintSkillText('---\nname: deploy-flow\ndescription: x\n---\n', d.name).errors.join(), /empty body/)
  assert.match(lintSkillText('---\nname: deploy-flow\ndescription: x\n---\n\n一句话，没有步骤。\n', d.name).errors.join(), /fewer than 2 steps/)
  assert.match(lintSkillText(good + '\u0000', d.name).errors.join(), /NUL byte/)
})

// ───────────────────────────── 注入 ─────────────────────────────

const playbookEntry = (over = {}) => ({
  id: '_ws/h/deploy-flow', layer: 'workspace', workspace: 'h', scene: '', session: '',
  kind: 'procedure', key: 'deploy-flow', status: 'playbook', title: '发布流程',
  oneLine: '1. 跑测试 2. 打 tag 3. 推远端', bytes: 30, estTokens: 10,
  confidence: 0.9, pinned: false, enabled: true, mtime: Date.now(), size: 90, hash: '',
  ...over,
})

test('lineOf：playbook 只放标题与 id，绝不展开步骤', () => {
  const line = lineOf(playbookEntry())
  assert.match(line, /^- \[proc\] 发布流程/)
  assert.match(line, /id: _ws\/h\/deploy-flow/)
  assert.doesNotMatch(line, /跑测试|打 tag|推远端/)
  // 普通 procedure 仍带全文（模型要据此决定做不做）。
  assert.match(lineOf(playbookEntry({ status: 'core' })), /跑测试/)
})

test('renderAutoBlock：playbook 能进注入且按 L0 常驻', () => {
  const entry = playbookEntry()
  const state = {
    version: 1, tombstones: [], watermarks: {},
    entries: { [entry.id]: { evidence: [], counters: { injected: 0, read: 0, helpful: 0, harmful: 0 }, transitions: [], confidence: 0 } },
  }
  const r = renderAutoBlock({ entries: [entry], state, scope: { workspaceHash: 'h' }, userSegmentTokens: 0 })
  assert.equal(r.count, 1)
  assert.match(r.text, /\[proc\] 发布流程/)
  assert.doesNotMatch(r.text, /跑测试/)
  assert.equal(r.byLayer.workspace, 1)
})

// ───────────────────────────── learner 落盘 ─────────────────────────────

async function readJsonFileStrict(abs) {
  let text
  try { text = readFileSync(abs, 'utf8') } catch (e) {
    if (String(e?.code || '') === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', error: String(e?.message || e) }
  }
  try { return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) } } catch (e) {
    return { status: 'corrupt', error: String(e?.message || e) }
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
  const home = mkdtempSync(join(tmpdir(), 'dsh-evo-proc-'))
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
          id: g.replace(/\.md$/, ''), layer: layerOfGroup(group),
          key: pickField(text, 'auto_key'), text: bodyOf(text),
          status: pickField(text, 'auto_status') || 'active',
          origin: pickField(text, 'origin') === 'auto' ? 'auto' : 'user',
        })
      }
    }
    walk(memoriesRoot, '')
    return { entries, knownScenes: new Set(['code']) }
  }
  const learner = createLearner({
    state, existingEntries,
    knownWorkspaces: async () => new Set([WS_HASH]),
    serializeRuleFile, memoriesRoot, stateDir,
    invalidateSnapshot: () => {},
    withWriteLock: (fn) => fn(),
    message,
  })
  return {
    home, stateDir, memoriesRoot, learner, state,
    done() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    },
    readState() { return JSON.parse(readFileSync(join(stateDir, 'evolution', 'state.json'), 'utf8')) },
    readCatalog() { return JSON.parse(readFileSync(join(stateDir, 'evolution', 'catalog.json'), 'utf8')) },
    readDoc(id) { return readFileSync(join(memoriesRoot, id + '.md'), 'utf8') },
  }
}

const envOf = () => ({ sessionId: 's-1', workspaceHash: WS_HASH })

test('learn(procedure + steps)：frontmatter 只放标量，结构化步骤进 state', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn({
      text: '发布流程按这三步走', kind: 'procedure', key: 'deploy-flow',
      source: 'tool_verified', steps: ['1. 跑 pnpm test', '2. 打 tag', '3. 推到远端'],
      boundary: 'CI 用 npm',
    }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    const doc = h.readDoc(r.id)
    assert.equal(pickField(doc, 'auto_title'), '发布流程按这三步走')
    assert.equal(pickField(doc, 'auto_steps'), '3')
    assert.match(doc, /## 步骤/)
    assert.deepEqual(parseProcedureSteps(bodyOf(doc)), ['跑 pnpm test', '打 tag', '推到远端'])
    const st = h.readState().entries[r.id]
    assert.deepEqual(st.procedure.steps, ['跑 pnpm test', '打 tag', '推到远端'])
    assert.equal(st.procedure.successes, 0)
    assert.equal(h.readCatalog().entries[r.id].title, '发布流程按这三步走')
  } finally { h.done() }
})

test('recordProcedure：三次成功自动升 playbook，失败不计数', async () => {
  const h = harness()
  try {
    const r = await h.learner.learn({
      text: '发布流程', kind: 'procedure', key: 'deploy-flow', source: 'user_explicit',
      quote: '按这个流程发布', steps: ['跑测试', '打 tag', '推远端'],
    }, cfgOf(), envOf())
    assert.equal(r.ok, true, r.error)
    // P1 的门禁把 procedure 一律降成 candidate + needsReview（做法类要先确认）。
    // 阶梯是 candidate → active → core → playbook，逐级走完才有资格晋升。
    const approved = await h.learner.approve(r.id)
    assert.equal(approved.ok, true, approved.error)
    const core = await h.learner.setStatus(r.id, 'core', 'user')
    assert.equal(core.ok, true, core.error)

    const a = await h.learner.recordProcedure(r.id, false)
    assert.equal(a.successes, 0)
    assert.equal(a.failures, 1)
    const b = await h.learner.recordProcedure(r.id, true)
    assert.equal(b.successes, 1)
    assert.equal(b.promoted, false)
    await h.learner.recordProcedure(r.id, true)
    const d = await h.learner.recordProcedure(r.id, true)
    assert.equal(d.successes, 3)
    assert.equal(d.promoted, true)
    assert.equal(pickField(h.readDoc(r.id), 'auto_status'), 'playbook')
    assert.equal(h.readCatalog().entries[r.id].status, 'playbook')
    assert.equal(h.readState().entries[r.id].procedure.successes, 3)
    // 时间线里能看出是谁、为什么晋升的。
    const last = h.readState().entries[r.id].transitions.at(-1)
    assert.equal(last.to, 'playbook')
    assert.equal(last.actor, 'dream')
  } finally { h.done() }
})

test('recordProcedure：非 procedure / 没有步骤都拒绝，不写脏计数', async () => {
  const h = harness()
  try {
    const fact = await h.learner.learn({ text: '这个仓库用 pnpm', key: 'pkg', source: 'tool_verified' }, cfgOf(), envOf())
    assert.equal(fact.ok, true, fact.error)
    const bad = await h.learner.recordProcedure(fact.id, true)
    assert.equal(bad.code, 'not-a-procedure')
    const proc = await h.learner.learn({ text: '一句话做法', kind: 'procedure', key: 'vague', source: 'model_inference' }, cfgOf(), envOf())
    assert.equal(proc.ok, true, proc.error)
    const noSteps = await h.learner.recordProcedure(proc.id, true)
    assert.equal(noSteps.code, 'no-steps')
    // setStatus 也不让没有步骤的条目伪装成 playbook。
    assert.equal((await h.learner.setStatus(proc.id, 'playbook', 'user')).code, 'not-a-procedure')
  } finally { h.done() }
})

// ───────────────────────────── 技能提议 store ─────────────────────────────

/** 假的技能域：把"写文件"与"清单里可加载"拆开，才能测到 lint / 回滚。 */
function fakeSkills(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evo-skill-'))
  const calls = []
  const registry = []
  const ops = {
    'skill-state': async () => {
      calls.push(['state'])
      return { ok: true, data: { roots: [{ key: 'dsh', skills: registry.map((x) => ({ ...x })) }] } }
    },
    'skill-create': async (a) => {
      calls.push(['create', a.name])
      if (opts.createFails) return { ok: false, error: 'disk full' }
      const path = join(home, 'skills', a.name, 'SKILL.md')
      mkdirSync(dirname(path), { recursive: true })
      // 故意可以写坏：lint 必须自己读回文件，不能信 create 的 OK。
      const head = opts.badFrontmatter
        ? '---\ndescription: no name here\n---\n'
        : `---\nname: ${a.name}\ndescription: ${a.description}\n---\n`
      writeFileSync(path, head + '\n' + (opts.badBody ? '只有一句话。\n' : a.body), 'utf8')
      registry.push({ name: a.name, declaredName: a.name, loadable: opts.unloadable === true ? false : true })
      return { ok: true, data: { name: a.name, path, root: 'dsh' } }
    },
    'skill-delete': async (a) => {
      calls.push(['delete', a.name, a.root])
      const i = registry.findIndex((x) => x.name === a.name)
      if (i >= 0) registry.splice(i, 1)
      return { ok: true }
    },
  }
  return {
    ops, calls, registry, home,
    store: createProcedureSkillStore({ stateDir: join(home, HUB), skillsOps: ops, withWriteLock: (fn) => fn(), message }),
    done() { rmSync(home, { recursive: true, force: true }) },
  }
}

const draftInput = (over = {}) => ({
  id: '_ws/h/deploy-flow', key: 'deploy-flow', title: '发布流程',
  description: '发布流程按这三步走', steps: ['跑测试', '打 tag', '推远端'],
  boundary: 'CI 用 npm', successes: 3, ...over,
})

test('propose → apply：写后 lint 通过，learned 名单记一条', async () => {
  const f = fakeSkills()
  try {
    const p = await f.store.propose(draftInput())
    assert.equal(p.ok, true, p.error)
    assert.equal(p.proposal.name, 'deploy-flow')
    assert.equal(p.proposal.installedAt, undefined)
    const listed = await f.store.list()
    assert.equal(listed.proposals.length, 1)
    assert.equal(listed.learned.length, 0)

    const out = await f.store.apply('deploy-flow', true)
    assert.equal(out.ok, true, out.error)
    assert.match(out.path, /SKILL\.md$/)
    assert.equal((await f.store.learned())[0].name, 'deploy-flow')
    const after = (await f.store.list()).proposals[0]
    assert.ok(after.installedAt)
    assert.equal(after.lastError, undefined)
    assert.deepEqual(f.calls.map((x) => x[0]), ['state', 'create', 'state'])
  } finally { f.done() }
})

test('apply：confirm 不是 true 就不写；重复应用被拒', async () => {
  const f = fakeSkills()
  try {
    await f.store.propose(draftInput())
    const no = await f.store.apply('deploy-flow', false)
    assert.equal(no.ok, false)
    assert.equal(no.rolledBack, false)
    assert.equal(f.calls.filter((x) => x[0] === 'create').length, 0)
    assert.equal((await f.store.apply('deploy-flow', true)).ok, true)
    const again = await f.store.apply('deploy-flow', true)
    assert.equal(again.ok, false)
    assert.match(again.error, /已经生成过/)
  } finally { f.done() }
})

test('apply：lint 不过 / 清单不可加载都回滚，learned 不留脏记录', async () => {
  for (const opts of [{ badFrontmatter: true }, { badBody: true }, { unloadable: true }]) {
    const f = fakeSkills(opts)
    try {
      await f.store.propose(draftInput())
      const out = await f.store.apply('deploy-flow', true)
      assert.equal(out.ok, false)
      assert.equal(out.rolledBack, true)
      assert.equal((await f.store.learned()).length, 0)
      assert.equal(f.registry.length, 0, '技能必须被移走')
      assert.ok(f.calls.some((x) => x[0] === 'delete'), '必须调 skill-delete 回滚')
      const p = (await f.store.list()).proposals[0]
      assert.ok(p.rolledBackAt)
      assert.match(p.lastError, opts.unloadable ? /清单里找不到|不可加载/ : /lint 未通过/)
    } finally { f.done() }
  }
})

test('apply：create 失败 / 同名已存在都不覆盖，也不误删别人的技能', async () => {
  const failed = fakeSkills({ createFails: true })
  try {
    await failed.store.propose(draftInput())
    const out = await failed.store.apply('deploy-flow', true)
    assert.equal(out.ok, false)
    assert.equal(out.rolledBack, false)
    assert.equal((await failed.store.learned()).length, 0)
  } finally { failed.done() }

  const taken = fakeSkills()
  try {
    taken.registry.push({ name: 'deploy-flow', declaredName: 'deploy-flow', loadable: true })
    await taken.store.propose(draftInput())
    const out = await taken.store.apply('deploy-flow', true)
    assert.equal(out.ok, false)
    assert.match(out.error, /不覆盖/)
    assert.equal(taken.calls.filter((x) => x[0] === 'create').length, 0)
    assert.equal(taken.calls.filter((x) => x[0] === 'delete').length, 0)
  } finally { taken.done() }
})

test('rollback：只回滚本功能生成的技能，摘掉徽章且草案可再提议', async () => {
  const f = fakeSkills()
  try {
    assert.equal((await f.store.rollback('not-mine')).ok, false)
    await f.store.propose(draftInput())
    assert.equal((await f.store.apply('deploy-flow', true)).ok, true)
    const out = await f.store.rollback('deploy-flow')
    assert.equal(out.ok, true, out.error)
    assert.equal((await f.store.learned()).length, 0)
    assert.equal(f.registry.length, 0)
    const p = (await f.store.list()).proposals[0]
    assert.equal(p.installedAt, undefined)
    assert.ok(p.rolledBackAt)
    // 回滚过还能再生成一次（不是一条死掉的提案）。
    assert.equal((await f.store.apply('deploy-flow', true)).ok, true)
  } finally { f.done() }
})

test('propose：少于两步拒绝；坏草案文件不让整个列表打不开', async () => {
  const f = fakeSkills()
  try {
    const bad = await f.store.propose(draftInput({ steps: ['只有一步'] }))
    assert.equal(bad.ok, false)
    assert.equal((await f.store.list()).proposals.length, 0)
    await f.store.propose(draftInput())
    mkdirSync(join(f.home, HUB, 'evolution', 'procedures'), { recursive: true })
    writeFileSync(join(f.home, HUB, 'evolution', 'procedures', 'broken.json'), '{ not json', 'utf8')
    const list = await f.store.list()
    assert.equal(list.proposals.length, 1)
  } finally { f.done() }
})

// ───────────────────────────── op 接线 ─────────────────────────────

function opFixture(over = {}) {
  const calls = []
  const entry = playbookEntry()
  const base = {
    config: { async effective() { return { enabled: true } } },
    runtime: {
      view() {
        return {
          catalog: { entries: { [entry.id]: entry } },
          state: {
            watermarks: {},
            entries: { [entry.id]: { evidence: [], counters: { injected: 0, read: 0, helpful: 0, harmful: 0 }, transitions: [], procedure: { steps: ['跑测试', '打 tag'], successes: 3, failures: 0 } } },
          },
        }
      },
      invalidate() { calls.push(['invalidate']) },
    },
    learner: {
      async describe(id) {
        return { ok: true, id, title: '发布流程', body: '## 步骤\n1. 跑测试\n2. 打 tag\n', boundary: 'CI 用 npm', kind: 'procedure' }
      },
      async recordProcedure(id, ok) { calls.push(['record', id, ok]); return { ok: true, id, successes: 3, failures: 0, promoted: true } },
    },
    procedureSkills: () => ({
      async list() { return { proposals: [{ name: 'deploy-flow' }], learned: [{ name: 'other', memoryId: entry.id, at: 'x' }] } },
      async learned() { return [{ name: 'other', memoryId: entry.id, at: 'x' }] },
      async propose(input) { calls.push(['propose', input.id]); return { ok: true, proposal: { name: 'deploy-flow' } } },
      async apply(name, confirm) { calls.push(['apply', name, confirm]); return { ok: true, name, path: '/x/SKILL.md' } },
      async rollback(name) { calls.push(['rollback', name]); return { ok: true, name } },
    }),
    message,
    ...over,
  }
  return { ops: buildEvolutionOps(base), calls, base }
}

test('evolution-procedures：一次给出步骤、可否晋升、草案与 learned', async () => {
  const f = opFixture()
  const r = await f.ops['evolution-procedures']({})
  assert.equal(r.ok, true)
  assert.equal(r.entries.length, 1)
  assert.deepEqual(r.entries[0].steps, ['跑测试', '打 tag'])
  assert.equal(r.entries[0].successes, 3)
  assert.equal(r.entries[0].canProposeSkill, true)
  assert.equal(r.entries[0].canPromote, false, '已经是 playbook 了')
  assert.equal(r.proposals.length, 1)
  assert.equal(r.learned.length, 1)
})

test('P4 写 op：confirm 原样转发，成功才失效缓存', async () => {
  const f = opFixture()
  assert.equal((await f.ops['evolution-procedure-done']({ id: 'x', ok: false })).promoted, true)
  assert.equal((await f.ops['evolution-skill-propose']({ id: '_ws/h/deploy-flow' })).ok, true)
  assert.equal((await f.ops['evolution-skill-apply']({ name: 'deploy-flow', confirm: false })).ok, true)
  assert.equal((await f.ops['evolution-skill-rollback']({ name: 'deploy-flow' })).ok, true)
  // 缓存失效夹在中间，按事件类型挑出来比按下标更稳（也顺带验证每条写 op 都失效了）。
  assert.deepEqual(f.calls.filter((x) => x[0] === 'record'), [['record', 'x', false]])
  assert.deepEqual(f.calls.filter((x) => x[0] === 'propose'), [['propose', '_ws/h/deploy-flow']])
  assert.deepEqual(f.calls.filter((x) => x[0] === 'apply'), [['apply', 'deploy-flow', false]])
  assert.deepEqual(f.calls.filter((x) => x[0] === 'rollback'), [['rollback', 'deploy-flow']])
  // 出草案不动记忆库，不必失效快照；另外三条都改了状态或技能，必须失效。
  assert.equal(f.calls.filter((x) => x[0] === 'invalidate').length, 3)
})

test('P4 op：没接线如实报错，learned 徽章缺接线时返回空名单', async () => {
  const f = opFixture({ procedureSkills: () => null })
  assert.equal((await f.ops['evolution-skill-propose']({ id: 'x' })).code, 'no-store')
  assert.equal((await f.ops['evolution-skill-apply']({ name: 'x', confirm: true })).code, 'no-store')
  assert.deepEqual((await f.ops['evolution-learned-skills']({})).skills, [])
  const noLearner = opFixture({ learner: undefined })
  assert.equal((await noLearner.ops['evolution-procedures']({})).code, 'unavailable')
})
