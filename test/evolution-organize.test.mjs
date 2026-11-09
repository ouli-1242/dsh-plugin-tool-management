// 「整理记忆」草案的纯函数测试。
//
// 这一层不碰磁盘，所以能直接钉住"什么该建议、什么不该"。落盘（applyOrganize）的测试在
// evolution-write.test.mjs 里 —— 两件事分开测：草案算错和草案执行错是两种 bug，
// 混在一条用例里断言失败时看不出是哪一边。
import test from 'node:test'
import assert from 'node:assert/strict'
import { draftOrganize } from '../lib/evolution/organize.js'

const DAY = 86400_000

/** 一条自动记忆的视图（`ExistingEntry` 的那几个字段）。 */
const entryOf = (id, layer, key, text, status = 'active') => ({ id, layer, key, text, status, origin: 'auto' })

/** 一条 state（默认：有置信度、没被用过）。 */
const stateOf = (over = {}) => ({
  evidence: [],
  counters: { injected: 0, read: 0, helpful: 0, harmful: 0 },
  transitions: [],
  confidence: 0.8,
  ...over,
})

const idsOf = (drafts) => drafts.map((d) => d.action + ' ' + d.ids.join('+'))

test('merge：同层、不同 key、说法几乎一样 → 建议合并，保留置信度高的那条', () => {
  const a = entryOf('_ws/h1/commit-lang', 'workspace', 'commit-lang', '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文')
  const b = entryOf('_ws/h1/commit-message-lang', 'workspace', 'commit-message-lang', '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文')
  const drafts = draftOrganize({
    entries: [a, b],
    states: { [a.id]: stateOf({ confidence: 0.8 }), [b.id]: stateOf({ confidence: 0.95 }) },
  })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].action, 'merge')
  assert.equal(drafts[0].keep, b.id, '保留置信度高的那条（用户更可能认它）')
  assert.deepEqual(drafts[0].ids, [b.id, a.id])
  assert.match(drafts[0].reason, /86%/, '理由要给出可核对的相似度')
})

test('merge：跨层不合并（同样的句子在工作区与全局是两件不同的事）', () => {
  const a = entryOf('_ws/h1/commit-lang', 'workspace', 'commit-lang', '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文')
  const b = entryOf('global', 'global', 'commit-message-lang', '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文')
  const drafts = draftOrganize({ entries: [a, b], states: { [a.id]: stateOf(), [b.id]: stateOf() } })
  assert.deepEqual(drafts.filter((d) => d.action === 'merge'), [])
})

test('merge：同 key 不算合并（同 key 的两条是数据问题，不是整理问题）', () => {
  const a = entryOf('_ws/h1/a', 'workspace', 'same', '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文')
  const b = entryOf('_ws/h1/b', 'workspace', 'same', '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文')
  assert.deepEqual(draftOrganize({ entries: [a, b], states: {} }), [])
})

test('archive：候选放了三周没人确认 → 建议归档（不删）', () => {
  const now = Date.now()
  const a = entryOf('_ws/h1/old-guess', 'workspace', 'old-guess', '可能喜欢简短回答', 'candidate')
  const drafts = draftOrganize({
    entries: [a],
    states: { [a.id]: stateOf({ confidence: 0.4, transitions: [{ at: new Date(now - 22 * DAY).toISOString(), from: 'draft', to: 'candidate', actor: 'learn', reason: 'x' }] }) },
    now,
  })
  assert.deepEqual(idsOf(drafts), ['archive ' + a.id])
  assert.match(drafts[0].reason, /22 days/)
})

test('archive：注入很多次一次没帮上、置信度又低 → 建议归档', () => {
  const a = entryOf('_ws/h1/noise', 'workspace', 'noise', '某个没用的推断', 'active')
  const drafts = draftOrganize({
    entries: [a],
    states: { [a.id]: stateOf({ confidence: 0.5, counters: { injected: 30, read: 0, helpful: 0, harmful: 0 } }) },
  })
  assert.deepEqual(idsOf(drafts), ['archive ' + a.id])
})

test('archive：刚学会的候选不动它（还没到能判断的时候）', () => {
  const a = entryOf('_ws/h1/new', 'workspace', 'new', '昨天才学到的一句', 'candidate')
  const drafts = draftOrganize({
    entries: [a],
    states: { [a.id]: stateOf({ confidence: 0.4, transitions: [{ at: new Date(Date.now() - DAY).toISOString(), from: 'draft', to: 'candidate', actor: 'learn', reason: 'x' }] }) },
  })
  assert.deepEqual(drafts, [])
})

test('promote：高置信 + 真的帮上过两次 → 建议提升为用户记忆', () => {
  const a = entryOf('_ws/h1/answer-style', 'workspace', 'answer-style', '回答先给结论再给理由')
  const drafts = draftOrganize({
    entries: [a],
    states: { [a.id]: stateOf({ confidence: 0.9, counters: { injected: 5, read: 1, helpful: 2, harmful: 0 } }) },
  })
  assert.deepEqual(idsOf(drafts), ['promote ' + a.id])
  assert.match(drafts[0].reason, /helped 2 times/)
})

test('promote：帮上过但置信度不够 → 不提升（提升是给"我认了"的，不是给"可能吧"的）', () => {
  const a = entryOf('_ws/h1/guess', 'workspace', 'guess', '也许该这样')
  const drafts = draftOrganize({
    entries: [a],
    states: { [a.id]: stateOf({ confidence: 0.6, counters: { injected: 5, read: 0, helpful: 3, harmful: 0 } }) },
  })
  assert.deepEqual(drafts, [])
})

test('被合并吸收的条目不再出第二份草案（否则点两次第二次必然失败）', () => {
  const a = entryOf('_ws/h1/commit-lang', 'workspace', 'commit-lang', '所有提交信息都用中文写，不要用英文，因为团队里有人不看英文')
  const b = entryOf('_ws/h1/commit-message-lang', 'workspace', 'commit-message-lang', '所有提交信息都用中文写，不要写英文，因为团队里有人不看英文')
  const drafts = draftOrganize({
    entries: [a, b],
    states: {
      [a.id]: stateOf({ confidence: 0.95, counters: { injected: 5, read: 0, helpful: 3, harmful: 0 } }),
      [b.id]: stateOf({ confidence: 0.8 }),
    },
  })
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].action, 'merge', '两条都被合并占用，不该再出 promote')
})

test('用户记忆不参与整理（草案只动 agent 学的那一半）', () => {
  const user = { id: 'global/tone', layer: 'global', key: '', text: '回答先给结论', status: 'active', origin: 'user' }
  const auto = entryOf('_ws/h1/x', 'workspace', 'x', '回答先给结论')
  const drafts = draftOrganize({ entries: [user, auto], states: {} })
  assert.deepEqual(drafts, [], '用户记忆的删改走记忆页原来的入口，不归这里管')
})

test('已归档 / 已取代的条目不进草案', () => {
  const a = entryOf('_ws/h1/a', 'workspace', 'a', '旧说法', 'archived')
  const b = entryOf('_ws/h1/b', 'workspace', 'b', '更旧的说法', 'superseded')
  assert.deepEqual(draftOrganize({ entries: [a, b], states: {} }), [])
})
