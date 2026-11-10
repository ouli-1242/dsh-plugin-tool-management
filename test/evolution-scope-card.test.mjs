// 对话内「这条记忆放哪」卡片的纯函数不变量：语言、选项顺序、答案映射、失败分类。
//
// 这几件事错一个的后果都不是报错，而是**静默错层**或**静默丢笔记**：
//   · 答案标签改一个字符 → 用户点了「全局」，映射不到，笔记退回待确认；
//   · 语言判错 → 中文正文配英文按钮，用户读不懂；
//   · 选项顺序错 → 推荐层不是第一项，用户按习惯点第一项却落到另一层；
//   · 失败分类错 → 没有 answerer 的会话把笔记丢掉，或关掉卡片反而保存了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScopeQuestion, scopeChoiceOf, scopeFailureOf, cardLangOf } from '../lib/evolution/scope-card.js'

test('语言：正文含中文用中文卡片，否则英文；不再中英并排', () => {
  assert.equal(cardLangOf('这个仓库统一用 pnpm'), 'zh')
  assert.equal(cardLangOf('The repo uses pnpm'), 'en')
  const zh = buildScopeQuestion({ text: '这个仓库统一用 pnpm', recommended: 'workspace', allowed: ['global', 'workspace'] })
  assert.equal(zh.header, '自主记忆')
  assert.equal(zh.question, '记住这条？')
  assert.deepEqual(zh.options.map((o) => o.label), ['本工作区记忆', '全局记忆', '不加入'])
  assert.match(zh.detail, /想改措辞/)
  const en = buildScopeQuestion({ text: 'The repo uses pnpm', recommended: 'workspace', allowed: ['global', 'workspace'] })
  assert.equal(en.header, 'Memory')
  assert.equal(en.question, 'Save this?')
  assert.deepEqual(en.options.map((o) => o.label), ['This workspace', 'Global memory', 'Don\'t save'])
  assert.match(en.detail, /Want different wording/)
})

test('卡片：推荐层排第一，跳过永远最后；detail 带上要保存的正文与合并信息', () => {
  const q = buildScopeQuestion({
    text: '这个仓库统一用 pnpm',
    boundary: 'CI 仍用 npm',
    recommended: 'workspace',
    allowed: ['global', 'workspace'],
    mergeInto: 'global/pkg',
    supersedes: ['_ws/abcd/pkg-old'],
  })
  assert.equal(q.id, 'memory-scope')
  assert.equal(q.multiSelect, false)
  assert.equal(q.options[0].label, '本工作区记忆', '推荐层必须是第一项')
  assert.match(q.options[0].description, /推荐/)
  assert.equal(q.options[q.options.length - 1].label, '不加入', '跳过永远最后')
  assert.match(q.detail, /这个仓库统一用 pnpm/)
  assert.match(q.detail, /CI 仍用 npm/)
  assert.match(q.detail, /global\/pkg/)
  assert.match(q.detail, /_ws\/abcd\/pkg-old/)
  // 只有一层可选时也照样给出「不加入」
  const one = buildScopeQuestion({ text: 'x', recommended: 'global', allowed: ['global'] })
  assert.deepEqual(one.options.map((o) => o.label), ['Global memory', 'Don\'t save'])
})

test('答案映射：按 label 回层；认不出就返回 null（调用方退回待确认，不猜）', () => {
  const zh = buildScopeQuestion({ text: '中文', recommended: 'global', allowed: ['global', 'workspace'] })
  const [zg, zw, zs] = zh.options.map((o) => o.label)
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [zg] }] }), { choice: 'global' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [zw] }] }), { choice: 'workspace' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [zs] }] }), { choice: 'skip' })
  const en = buildScopeQuestion({ text: 'English', recommended: 'global', allowed: ['global', 'workspace'] })
  const [eg, ew, es] = en.options.map((o) => o.label)
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [eg] }] }), { choice: 'global' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [ew] }] }), { choice: 'workspace' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [es] }] }), { choice: 'skip' })
  assert.equal(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: ['未知选项'] }] }), null)
  assert.equal(scopeChoiceOf(undefined), null)
})

test('自定义输入：返回 revise，原样带回用户的话（不写盘，交回模型重写）', () => {
  assert.deepEqual(
    scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [], custom: '  改成只在写代码时用 ' }] }),
    { choice: 'revise', custom: '改成只在写代码时用' },
  )
  // 官方单选在 custom 非空时会清空 selected；即使客户端同时给了 selected，也按 revise 处理。
  assert.deepEqual(
    scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: ['全局记忆'], custom: '换个说法' }] }),
    { choice: 'revise', custom: '换个说法' },
  )
})

test('失败分类：关卡片 = 不保存；取消 = 上抛；没有 answerer = 退回待确认', () => {
  // 客户端取消抛的是字符串（waterfall.reject("ASK_CANCELLED")），不是 Error
  assert.equal(scopeFailureOf('ASK_CANCELLED'), 'skip')
  assert.equal(scopeFailureOf({ code: 'ASK_CANCELLED' }), 'skip')
  assert.equal(scopeFailureOf({ code: 'ASK_ABORTED' }), 'abort')
  assert.equal(scopeFailureOf('ASK_ABORTED'), 'abort')
  for (const code of ['NO_PROVIDER', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER', 'WHATEVER']) {
    assert.equal(scopeFailureOf({ code }), 'fallback', code)
  }
  assert.equal(scopeFailureOf(undefined), 'fallback')
})
