// 对话内「这条记忆放哪」卡片的纯函数不变量：选项顺序、答案映射、失败分类。
//
// 这三件事错一个的后果都不是报错，而是**静默错层**或**静默丢笔记**：
//   · 答案标签改一个字符 → 用户点了「全局」，映射不到，笔记退回待确认；
//   · 选项顺序错 → 推荐层不是第一项，用户按习惯点第一项却落到另一层；
//   · 失败分类错 → 没有 answerer 的会话把笔记丢掉，或关掉卡片反而保存了。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScopeQuestion, scopeChoiceOf, scopeFailureOf,
  SCOPE_GLOBAL_LABEL, SCOPE_SKIP_LABEL, SCOPE_WORKSPACE_LABEL,
} from '../lib/evolution/scope-card.js'

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
  assert.equal(q.options[0].label, SCOPE_WORKSPACE_LABEL, '推荐层必须是第一项')
  assert.match(q.options[0].description, /推荐|Recommended/)
  assert.equal(q.options[q.options.length - 1].label, SCOPE_SKIP_LABEL, '跳过永远最后')
  assert.match(q.detail, /这个仓库统一用 pnpm/)
  assert.match(q.detail, /CI 仍用 npm/)
  assert.match(q.detail, /global\/pkg/)
  assert.match(q.detail, /_ws\/abcd\/pkg-old/)
  // 只有一层可选时也照样给出「不加入」
  const one = buildScopeQuestion({ text: 'x', recommended: 'global', allowed: ['global'] })
  assert.deepEqual(one.options.map((o) => o.label), [SCOPE_GLOBAL_LABEL, SCOPE_SKIP_LABEL])
})

test('答案映射：按 label 回层；认不出就返回 null（调用方退回待确认，不猜）', () => {
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [SCOPE_GLOBAL_LABEL] }] }), { choice: 'global' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [SCOPE_WORKSPACE_LABEL] }] }), { choice: 'workspace' })
  assert.deepEqual(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [SCOPE_SKIP_LABEL] }] }), { choice: 'skip' })
  // 「其它」输入：原样带回，不拿它猜层
  assert.deepEqual(
    scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [SCOPE_SKIP_LABEL], custom: '  先别记 ' }] }),
    { choice: 'skip', custom: '先别记' },
  )
  assert.equal(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: ['未知选项'] }] }), null)
  assert.equal(scopeChoiceOf({ answers: [{ id: 'memory-scope', selected: [], custom: '随便' }] }), null)
  assert.equal(scopeChoiceOf(undefined), null)
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
