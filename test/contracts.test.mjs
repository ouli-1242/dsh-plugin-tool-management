// 契约级测试 —— 只钉**不会因为改文案、改排版、改实现细节而红**的东西。
//
// 用户 2026-09-17 定的规矩：不要刻舟求剑的测试，只有最宽泛的才需要。理由是细粒度测试
// 每次改动都红，红到后来没人看，等于没有测试；构建成功 + 真实使用才是验收。
//
// 所以这里只留三类，加一条断言前先问"这会不会因为我改一句话就红"：
//   ① **与宿主的契约** —— 深度探针读哪几个字段、预算判据是哪条公式。宿主换了口径就必须红。
//   ② **一旦破了会静默出错的** —— 注入抛错会打断会话、遥测抛错会打断工具调用、
//      人设正文里留下未注册的提示词变量会让子代理启动失败。这些"不抛"本身就是功能。
//   ③ **自洽性** —— 域与工具名前缀必须双向对得上（对不上就是某个域永远统计不到）。
//
// 明确不测：文案、排版、目录行格式、计数器的具体数值、frontmatter 的写法变体。
// 那些交给 `npm run build` 与真实使用。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INJECT_SETTINGS,
  DOMAIN_TOOL_PREFIX,
  INJECT_DOMAIN_KEYS,
  createContextInjector,
  domainOfTool,
  isSubagentSession,
  selectInjections,
  subagentDepthOf,
} from '../lib/context-inject.js'
import { catalogDepthOf, catalogInjectedAt, emptyResultNote, parsePersona, renderPersonaPrompt, serializePersona, textOfBlocks } from '../lib/subagents/service.js'
import { renderMcpStateSection } from '../lib/mcp/state-section.js'

test('域与工具名前缀双向对得上（对不上就有域永远统计不到调用）', () => {
  for (const key of INJECT_DOMAIN_KEYS) {
    assert.equal(domainOfTool(DOMAIN_TOOL_PREFIX[key] + 'list'), key, key + ' 的前缀映射不成环')
  }
  assert.equal(domainOfTool('read_file'), undefined, '不是本插件的工具不该被认领')
})

test('深度探针读的是官方那几个字段，取最大者', () => {
  assert.equal(subagentDepthOf({ session: { header: {} } }), 0)
  assert.equal(subagentDepthOf({ session: { header: { origin: 'subagent' } } }), 1, 'origin 是硬信号，至少算 1 层')
  assert.equal(subagentDepthOf({ session: { header: { origin: 'subagent', delegationDepth: 2 } } }), 2)
  assert.equal(subagentDepthOf({ session: { header: {} }, options: { subagentDepth: 3 } }), 3, '运行期选项也要认')
  assert.equal(subagentDepthOf(undefined), 0, '拿不到现场按顶层算')
  assert.equal(isSubagentSession({ session: { header: { origin: 'subagent' } } }), true)
})

test('目录注入深度：默认 1，判据是「深度 < 深度值」', () => {
  const plain = {}
  const raised = { catalogDepth: 2 }
  assert.equal(catalogDepthOf(plain), 1)
  assert.equal(catalogDepthOf(raised), 2)
  // 默认 1 = 只在顶层注入目录，子会话收不到。
  assert.equal(catalogInjectedAt(plain, 0), true)
  assert.equal(catalogInjectedAt(plain, 1), false)
  // 2 = 顶层和子会话都注入，孙会话不注入。
  assert.equal(catalogInjectedAt(raised, 1), true)
  assert.equal(catalogInjectedAt(raised, 2), false)
  // 非法值退回默认（默认只注入顶层，噪声最小，是安全方向）。
  for (const bad of [-1, 1.5, Number.NaN, '2']) {
    assert.equal(catalogDepthOf({ catalogDepth: bad }), 1, String(bad) + ' 该退回默认')
  }
})

test('人设的目录注入深度能读能写（含旧的 maxDepth 键）', () => {
  assert.equal(parsePersona('---\ncatalogDepth: 2\n---\n\n正文', 'p').catalogDepth, 2)
  // 旧键仍可读：0.9.5 定稿前这个字段叫 maxDepth。
  assert.equal(parsePersona('---\nmaxDepth: 2\n---\n\n正文', 'p').catalogDepth, 2)
  assert.equal(parsePersona('---\ndescription: 只有描述\n---\n\n正文', 'p').catalogDepth, undefined)
  // 写回一律用新键，且默认值不落盘。
  assert.ok(serializePersona({ name: 'p', body: '正文', catalogDepth: 2 }).includes('catalogDepth: 2'))
  assert.ok(!serializePersona({ name: 'p', body: '正文', catalogDepth: 1 }).includes('catalogDepth'))
})

test('注入通道吞掉域异常：一次坏掉的注入不该打断会话', () => {
  const domains = [
    { key: 'memory', name: 'm', label: '记忆', form: 'snapshot', text: () => { throw new Error('boom') } },
    { key: 'mcp', name: 'c', label: 'MCP', form: 'catalog', text: () => 'OK' },
  ]
  const out = selectInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {})
  assert.deepEqual(out.map((s) => s.key), ['mcp'], '坏掉的域跳过，好的域照发')
  // 域开关关掉就不进（界面上那个勾选框的语义）。
  const off = { ...DEFAULT_INJECT_SETTINGS, domains: { ...DEFAULT_INJECT_SETTINGS.domains, mcp: false } }
  assert.deepEqual(selectInjections(domains, off, undefined, {}).map((s) => s.key), [])
})

test('遥测不反噬：任何输入都不抛（它绝不能影响工具调用本身）', () => {
  const injector = createContextInjector({
    ctx: {},
    domains: () => [],
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
  })
  assert.doesNotThrow(() => injector.noteToolUse('memory_manager_list', undefined))
  assert.doesNotThrow(() => injector.noteToolUse(undefined, {}))
  assert.doesNotThrow(() => injector.live())
  assert.doesNotThrow(() => injector.dispose())
})

test('人设正文进系统提示词时不会留下未注册的提示词变量', () => {
  // 破了这一条的后果是**硬失败**：宿主对系统提示词做严格变量插值，命中未注册的
  // `{{name}}` 就抛错，子代理根本起不来。所以这里只钉"没有连续的左花括号"这个不变量，
  // 不钉框长什么样 —— 文案随改，这条不能破。
  const out = renderPersonaPrompt(parsePersona('---\ndescription: 审查\n---\n\n输出格式：{{summary}}。', 'p'))
  assert.ok(!out.includes('{{'), '不得留下会被当成变量引用的连续左花括号')
  assert.ok(out.replace(/\u200b/g, '').includes('{{summary}}'), '拆开而已，可见字符一个不丢')
})

test('子代理结果只取 text 块：思考绝不进正文', () => {
  // 属"破了会静默出错"那一类：`TextBlock` 与 `ReasoningBlock` 结构相同（都带 string 的 text），
  // 少一个 `type` 判断就会把模型的思考当正文返回给调用方 —— 不抛错、不报错，只是结果里混进
  // 自我校验，或者整段都是思考。本机 298 条终局消息里 98.7% 命中过。
  // 只钉"思考不进、正文进"这个不变量，不钉兜底文案怎么写。
  const blocks = [
    { type: 'reasoning', text: '让我先数一遍：1、2、3，都齐了。' },
    { type: 'text', text: '结论：三个文件都已改好。' },
    { type: 'tool-call', id: 'x', name: 'read', arguments: '{}' },
  ]
  const out = textOfBlocks(blocks, 'text')
  assert.ok(out.includes('结论'), '正文必须在')
  assert.ok(!out.includes('让我先数一遍'), '思考不得混进正文')

  // 只有思考时不能返回空串（否则调用方会读成"子代理没干活"），也不能把思考塞回来。
  const thinkingOnly = [{ type: 'reasoning', text: '想了很多但没写出结论' }]
  const note = emptyResultNote(thinkingOnly, 'max-tokens')
  assert.ok(note.length > 0, '有产出但没正文也要给一句说明')
  assert.ok(!note.includes('想了很多但没写出结论'), '说明里不得夹带思考正文')
  assert.ok(emptyResultNote([], 'completed').length > 0, '彻底没有输出同样要有说明')
  // 「干了活没写出正文」与「什么都没产出」必须能区分开 —— 这是这个兜底存在的理由：
  // 混成同一句会让调用方把一次有产出的委派读成空跑。
  assert.notEqual(note, emptyResultNote([], 'max-tokens'), '有产出与没产出不得同话')
  // 实测：这个兜底几乎总是"没能正常跑完"的信号，所以说明必须随收尾原因变化 ——
  // 否则调用方会把"撞 token 上限"读成"忘了写结论"，原样重发一次再撞一次。
  assert.notEqual(note, emptyResultNote(thinkingOnly, 'error'), '不同收尾原因该给不同对策')

  // 畸形块不该让摊平抛错（结果处理在委派的收尾路径上，抛出去会顶掉整个返回）。
  assert.equal(textOfBlocks(null, 'text'), '')
  assert.equal(textOfBlocks([null, 42, { type: 'text' }], 'text'), '')
})

test('MCP 段不拿缓存冒充现状：连不上的 server 不得被报成可用', () => {
  // 关键不变量：`toolCount`（含「已知工具」缓存）在服务器连不上时依然 > 0，所以它
  // **不能**用来判可用性 —— 判据必须是 `liveEnabledToolCount`（只来自真实 schema）。
  // 破掉的后果是静默的：段里说"可用"、模型照着去调 `mcp__X__*`，而那个工具根本没注册。
  const offline = {
    serverName: 'github', disabled: false,
    toolCount: 26, enabledToolCount: 26,      // 缓存算出来的两个数：依然是 26
    liveToolCount: 0, liveEnabledToolCount: 0, // 真实注册：一个都没有
    knownToolCount: 26,                        // 但曾经连上过
  }
  const out = renderMcpStateSection([offline])
  assert.ok(!/- \*\*github\*\*（\d+ 个工具）/.test(out), '不得以「N 个工具」的可用形态出现')
  assert.ok(out.includes('当前未连上'), '必须标出它现在不可用')
  assert.ok(out.includes('26'), '上次连上时的工具数要留着 —— 那是"曾经成功过"的证据')

  // 从未连上过（缓存也空）→ 不列：一直没成功过，不该反复打扰。
  const never = { serverName: 'never', disabled: false, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 0, toolCount: 0, enabledToolCount: 0 }
  assert.equal(renderMcpStateSection([never]), '')

  // 用户的选择不是故障：补丁停用、工具全被停用 → 都不列（与既定口径一致）。
  assert.equal(renderMcpStateSection([{ serverName: 'off', disabled: true, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 9 }]), '')
  assert.equal(renderMcpStateSection([{ serverName: 'alloff', disabled: false, liveToolCount: 5, liveEnabledToolCount: 0, knownToolCount: 5 }]), '')

  // 真可用 → 正常列出，且数字是**真实可用数**（不是缓存数）。
  const ok = renderMcpStateSection([{ serverName: 'ok', disabled: false, liveToolCount: 5, liveEnabledToolCount: 3, knownToolCount: 5 }])
  assert.ok(ok.includes('- **ok**（3 个工具）'), '列出的数字必须是真实可用数')
})
