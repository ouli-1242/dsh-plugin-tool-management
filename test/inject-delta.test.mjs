// 记忆增量注入的纯函数：差集、渲染、发不发（全量 / 差集 / 跳过）与可见 id 收集。
//
// 这一组不碰宿主消息通道（那条由 build + 真机验证），只钉"哪些条目算新增 / 更新 / 删除"、
// "什么时候必须回全量"这两件会静默出错的事。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  diffCount,
  diffIncremental,
  planIncremental,
  renderIncrementalDelta,
} from '../lib/context-inject-delta.js'
import { newestDomainTexts, PLUGIN_KINDS } from '../lib/context-inject-surface.js'

const snapshot = (entries, opts = {}) => ({
  text: opts.text ?? 'full text',
  entries,
  truncated: opts.truncated === true,
  mode: opts.mode ?? 'm',
})

const stateOf = (entries, opts = {}) => ({
  mode: opts.mode ?? 'm',
  baseId: opts.baseId ?? 'base',
  deltaIds: opts.deltaIds ?? [],
  deltaCount: opts.deltaCount ?? 0,
  truncated: opts.truncated === true,
  entries: new Map(entries.map((entry) => [entry.key, { text: entry.text, ...(entry.group !== undefined ? { group: entry.group } : {}) }])),
})

const visible = (...ids) => new Set(ids)

test('差集按 key 认身份：新增 / 改正文 / 换场景 / 删除各归各位', () => {
  const previous = new Map([
    ['a', { text: 'A old', group: 'Scene: one' }],
    ['b', { text: 'B old', group: 'Scene: one' }],
    ['c', { text: 'C old', group: 'Scene: one' }],
    ['d', { text: 'D old', group: 'Scene: one' }],
  ])
  const diff = diffIncremental(previous, [
    { key: 'a', text: 'A old', group: 'Scene: one' }, // 没变
    { key: 'b', text: 'B new', group: 'Scene: one' }, // 改正文
    { key: 'c', text: 'C old', group: 'Scene: two' }, // 换场景
    { key: 'e', text: 'E new', group: 'Scene: two' }, // 新增
  ])
  assert.deepEqual(diff.added.map((entry) => entry.key), ['e'])
  assert.deepEqual(diff.updated.map((entry) => entry.key), ['b', 'c'])
  assert.deepEqual(diff.removed.map((entry) => entry.key), ['d'])
  assert.equal(diffCount(diff), 4)
})

test('差集正文：三类各有标题、按场景分组、删除只留第一行', () => {
  const text = renderIncrementalDelta({
    added: [
      { key: 'a', text: '- **A** — new\n\nsecond line', group: 'Scene: Work' },
      { key: 'n', text: '- **Note** — learned' }, // 无分组 = 自主笔记
    ],
    updated: [{ key: 'b', text: '- **B** — changed', group: 'Scene: Work' }],
    removed: [{ key: 'c', text: '- **C** — old body\n\nsecond line', group: 'Scene: Home' }],
  })
  assert.match(text, /only the entries below changed/)
  assert.match(text, /## Added\n\n### Scene: Work\n\n- \*\*A\*\* — new/)
  assert.match(text, /### Learned notes\n\n- \*\*Note\*\* — learned/)
  assert.match(text, /## Updated\n\n### Scene: Work\n\n- \*\*B\*\* — changed/)
  assert.match(text, /## Removed\n\n### Scene: Home\n\n- \*\*C\*\* — old body\n?$/)
  assert.ok(!/## Removed[\s\S]*second line/.test(text), '删除项不重贴旧正文')
  // 空差集不产生正文（调用方据此回全量）。
  assert.equal(renderIncrementalDelta({ added: [], updated: [], removed: [] }), '')
})

test('规划：首次 / 账本不可见 / 环境变 / 连续差集过多 → 全量', () => {
  const entries = [{ key: 'a', text: 'A' }]
  const full = (extra = {}) => planIncremental({
    snapshot: snapshot(entries),
    state: stateOf(entries, extra),
    visibleIds: visible('base'),
    fullText: 'x'.repeat(200),
  })
  assert.equal(planIncremental({ snapshot: snapshot(entries), state: undefined, visibleIds: visible('base'), fullText: 'x'.repeat(200) }).kind, 'full')
  assert.equal(full({ baseId: 'gone' }).kind, 'full', '全量已被压缩掉')
  assert.equal(full({ deltaIds: ['gone'] }).kind, 'full', '某条差集已被压缩掉')
  assert.equal(full({ mode: 'other' }).kind, 'full', '场景 / 预算档 / 工作区变了')
  assert.equal(full({ deltaCount: 10 }).kind, 'full', '连续差集到上限')
  assert.equal(full().kind, 'none', '账本有效且条目没变')
})

test('规划：截断态只在两边一致时交给上层判「没变」', () => {
  const entries = [{ key: 'a', text: 'A' }]
  const plan = (stateTruncated, nowTruncated) => planIncremental({
    snapshot: snapshot(entries, { truncated: nowTruncated }),
    state: stateOf(entries, { truncated: stateTruncated }),
    visibleIds: visible('base'),
    fullText: 'x'.repeat(200),
  })
  assert.equal(plan(true, true).kind, 'none', '一直是截断态且条目没变 → 不重发')
  assert.equal(plan(false, true).kind, 'full', '刚进入截断 → 未列出清单变了，回全量')
  assert.equal(plan(true, false).kind, 'full', '从截断恢复 → 账本只含当时入选的条目，回全量')
})

test('规划：有变化且差集更小才发差集；太大就回全量', () => {
  const previous = [{ key: 'a', text: 'A' }]
  const next = [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }]
  const small = planIncremental({
    snapshot: snapshot(next),
    state: stateOf(previous),
    visibleIds: visible('base'),
    fullText: 'x'.repeat(2000),
  })
  assert.equal(small.kind, 'delta')
  assert.match(small.text, /## Added/)
  const large = planIncremental({
    snapshot: snapshot(next),
    state: stateOf(previous),
    visibleIds: visible('base'),
    fullText: 'short',
  })
  assert.equal(large.kind, 'full', '差集不比全量小')
  const many = planIncremental({
    snapshot: snapshot(Array.from({ length: 41 }, (_, i) => ({ key: 'k' + i, text: 'v' + i }))),
    state: stateOf([]),
    visibleIds: visible('base'),
    fullText: 'x'.repeat(10000),
  })
  assert.equal(many.kind, 'full', '变化条数过多')
})

test('可见 id 收集：不因其它域先收齐而漏掉更旧的增量基准', () => {
  const message = (id, kind, body) => ({
    id,
    content: [{ type: 'text', text: '<system-reminder>\n' + body + '\n</system-reminder>' }],
    source: { kind, form: 'snapshot', body, frame: 'f' },
  })
  const agent = {
    session: {
      deriveMessages: () => [
        message('base', 'memory-global-catalog', 'full'),
        message('delta', 'memory-global-catalog', 'delta'),
        message('s', 'scene-manager-catalog', 'scene'),
        message('w', 'memory-workspace-catalog', 'workspace'),
        message('m', 'mcp-manager-catalog', 'mcp'),
        message('k', 'skill-manager-catalog', 'skills'),
        message('a', 'subagent-manager-catalog', 'subagents'),
        message('p', 'prompt-manager-catalog', 'prompt'),
      ],
    },
  }
  const ids = new Set()
  const out = newestDomainTexts(agent, PLUGIN_KINDS, ids)
  assert.equal(out.get('memoryGlobal').body, 'delta', '最新一条内容仍是差集消息')
  assert.ok(ids.has('base'), '更旧的全量 id 也要收进来')
  assert.ok(ids.has('delta'))
  assert.equal(ids.size, 8)
})
