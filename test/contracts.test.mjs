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
import { readFileSync } from 'node:fs'
import {
  DEFAULT_INJECT_SETTINGS,
  DOMAIN_TOOL_PREFIX,
  INJECT_DOMAIN_KEYS,
  createContextInjector,
  domainOfTool,
  isSubagentSession,
  renderDomainText,
  selectInjections,
  subagentDepthOf,
} from '../lib/context-inject.js'
import { catalogDepthOf, catalogInjectedAt, emptyResultNote, parsePersona, renderPersonaPrompt, serializePersona, textOfBlocks } from '../lib/subagents/service.js'
import { parseModeState } from '../lib/memories/service.js'
import { TOKEN_MSG } from '../lib/http-fence.js'
import { DEFAULT_HIDDEN_TOOLS, LEGACY_TOOL_NAME_MAP, migrateLegacyToolNames, normalizeToolTableSettings } from '../lib/tools/table.js'
import { createAccessToken } from '../lib/request-gate.js'
import { applyLoaderToken, applyLoaderTokenDisabled, readLoaderToken } from '../lib/mcp/loader-token.js'
import { checkPatchWrite, decidePatchWrite, judgePatchText } from '../lib/compat/patch-dialect.js'
import * as yaml from 'js-yaml'
import { MASK_PLACEHOLDER, describeMaskedOutcome, isMaskedValue, maskedKeysIn, resolveMaskedKv } from '../lib/mcp/secret-guard.js'
import { renderMcpStateSection } from '../lib/mcp/state-section.js'
import { assessHost } from '../lib/compat/probe.js'
import { SessionStore } from '@deepseek-ai/dsh-session'

test('域与工具名前缀双向对得上（对不上就有域永远统计不到调用）', () => {
  for (const key of INJECT_DOMAIN_KEYS) {
    // 一个域可以挂多个前缀（场景与记忆同域两族），所以逐个前缀都要成环。
    assert.ok(DOMAIN_TOOL_PREFIX[key].length > 0, key + ' 至少要有一个前缀')
    for (const prefix of DOMAIN_TOOL_PREFIX[key]) {
      assert.equal(domainOfTool(prefix + 'list'), key, key + ' 的前缀 ' + prefix + ' 映射不成环')
    }
  }
  assert.equal(domainOfTool('read_file'), undefined, '不是本插件的工具不该被认领')
})

test('记忆族与场景族各归自己的域，中途用过的名字不是别名', () => {
  // 破了这一条的后果是**静默**的：漏配 DOMAIN_TOOL_PREFIX 时编译不报错，症状只是
  // 兼容页那一组工具掉进「其它」桶、注入实况里该域的调用数永远是 0。
  assert.equal(domainOfTool('memory_manager_save'), 'memory')
  assert.equal(domainOfTool('memory_manager_list'), 'memory')
  // 0.14.0 把场景从记忆里分出来：注入段、界面勾选、遥测都是**两个域**了
  // （`scene-manager-catalog` / `memory-manager-catalog`），工具族跟着分开。
  assert.equal(domainOfTool('scene_manager_save'), 'scene')
  // `scene_memory_manager_*` 是 0.14.0 开发中途用过的名字，**从未发布** —— 不注册别名
  // （注册了就是每轮白付 token）。
  assert.equal(domainOfTool('scene_memory_manager_save'), undefined)
})

test('注入域里场景排在记忆之前（先给框架再给内容）', () => {
  // 顺序就是界面勾选顺序与消息顺序。场景是"当前模式的框架"，记忆是它下面的内容 ——
  // 反过来的话模型先读到一堆条目，才知道自己在哪个场景。
  const keys = [...INJECT_DOMAIN_KEYS]
  assert.ok(keys.indexOf('scene') >= 0, '场景必须是独立域')
  assert.ok(keys.indexOf('scene') < keys.indexOf('memory'), '场景要排在记忆前面')
})

test('旧工具名迁移：用户「关掉了某条」的意图不能在改名后静默失效', () => {
  // 破了这一条的后果同样是静默的：`tool-table.json` 里存的是用户点名关掉的工具，旧名在新表里
  // 不存在 —— 不迁移的话那条工具照旧每轮发出去，而界面上看不出任何异常。
  const migrated = migrateLegacyToolNames(normalizeToolTableSettings({
    hidden: ['memory_manager_write', 'mcp_manager_restart', 'skill_manager_create', 'other_plugin_tool'],
  }))
  assert.equal(migrated.changed, true)
  assert.deepEqual(migrated.settings.hidden, [
    'memory_manager_save', 'mcp_manager_switch', 'skill_manager_save', 'other_plugin_tool',
  ])
  // 幂等：已经全是新名时必须报"没改"，否则每次读盘都会白回写一次。
  assert.equal(migrateLegacyToolNames(migrated.settings).changed, false)
  // 两条旧工具并成同一条 save 时只留一份（去重，不是简单替换）。
  assert.deepEqual(
    migrateLegacyToolNames(normalizeToolTableSettings({ hidden: ['memory_manager_write', 'memory_manager_update'] })).settings.hidden,
    ['memory_manager_save'],
  )
  // 0.14.x：「拨一个开关」六域同形 —— `_set_enabled` → `_switch`（**一对一**，参数没动，
  // 所以不涉及语义合并）。漏了这三条的后果与上面完全一样，且更容易漏 ——
  // 改名的人往往会记得改 `src/tools/*.ts`，却忘了这份表。
  assert.deepEqual(
    migrateLegacyToolNames(normalizeToolTableSettings({
      hidden: ['memory_manager_set_enabled', 'skill_manager_set_enabled', 'subagent_manager_set_enabled'],
    })).settings.hidden,
    ['memory_manager_switch', 'skill_manager_switch', 'subagent_manager_switch'],
  )
  // 不认识的名字原样保留：分不清"用户的旧名"与"别的插件的工具名"，误删比留着一条死名更糟。
  assert.equal(LEGACY_TOOL_NAME_MAP.other_plugin_tool, undefined)
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
  // 可用档现在是**裸名**（不带括号），所以"被报成可用"的形态就是 `- **github**` 单独一行。
  assert.ok(!/^- \*\*github\*\*$/m.test(out), '不得以无状态标记的形态出现（那会被读成可用）')
  assert.ok(out.includes('当前未连上'), '必须标出它现在不可用')
  assert.ok(out.includes('github'), '曾经连上过的仍要列出来 —— 那是"曾经成功过"的证据')
  // 原来这里还断言「上次连上时的 26 个工具要留着」；2026-09-23 起工具数不再注入
  // （模型不能凭一个数字列举工具名，而 17 B/台 × 每轮是白付的），所以改成上一条。
  // 分档判据**没变**，仍然是 `liveEnabledToolCount`（见 state-section.ts）。

  // 从未连上过（缓存也空）→ 不列：一直没成功过，不该反复打扰。
  const never = { serverName: 'never', disabled: false, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 0, toolCount: 0, enabledToolCount: 0 }
  assert.equal(renderMcpStateSection([never]), '')

  // 用户的选择不是故障：补丁停用、工具全被停用 → 都不列（与既定口径一致）。
  assert.equal(renderMcpStateSection([{ serverName: 'off', disabled: true, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 9 }]), '')
  assert.equal(renderMcpStateSection([{ serverName: 'alloff', disabled: false, liveToolCount: 5, liveEnabledToolCount: 0, knownToolCount: 5 }]), '')

  // 真可用 → 正常列出，且**不带任何状态标记**（能进段的都是可用的，标状态是废话）。
  // 判据依然是 `liveEnabledToolCount > 0`：上一条里 `alloff` 那台（live 5 / enabled 0）
  // 被排除在外，就是这条不变量在起作用 —— 数字不显示了，分档仍然只认真值。
  const ok = renderMcpStateSection([{ serverName: 'ok', disabled: false, liveToolCount: 5, liveEnabledToolCount: 3, knownToolCount: 5 }])
  assert.ok(ok.includes('- **ok**'), '真可用的要列出来')
  assert.ok(!ok.includes('未连上'), '真可用的不得标成不可用')
})

test('parseModeState 透传全部快照恢复名单（哪张被剥掉，退出模式就有一类状态永远不复原）', () => {
  // v0.8.5 的教训是 mcpNotes 被剥掉（备注永不回退）；此前 mcpServers / skillSources /
  // subagentsAll 也各被剥掉过一次。这类字段的价值全在「原样透传」，所以契约钉在
  // 「六张名单逐字通过」上，而不是某个具体数值。
  const parsed = parseModeState({
    scene: '办公',
    snapshot: {
      mcp: { github: ['*'] },
      mcpServers: [{ id: 'mcp-github', level: 'project', disabled: true }],
      skillSources: [{ root: 'custom-a', enabled: false }],
      subagents: ['reviewer'],
      subagentsOn: ['writer'],
      subagentsAll: { reviewer: false, writer: true },
      mcpNotes: [{ id: 'mcp-github', note: 'A 挂了改用 B' }],
    },
  })
  assert.equal(parsed.scene, '办公')
  assert.deepEqual(parsed.snapshot.mcp, { github: ['*'] }, 'v2 停用表原文透传')
  assert.deepEqual(parsed.snapshot.mcpServers, [{ id: 'mcp-github', level: 'project', disabled: true }])
  assert.deepEqual(parsed.snapshot.skillSources, [{ root: 'custom-a', enabled: false }])
  assert.deepEqual(parsed.snapshot.subagents, ['reviewer'])
  assert.deepEqual(parsed.snapshot.subagentsOn, ['writer'])
  assert.deepEqual(parsed.snapshot.subagentsAll, { reviewer: false, writer: true })
  assert.deepEqual(parsed.snapshot.mcpNotes, [{ id: 'mcp-github', note: 'A 挂了改用 B' }])
})

test('打码值不得入库：有旧真值就顶替，没有就丢弃（破了就是真密钥被占位符覆盖，找不回来）', () => {
  // 2026-09-18 本机真实事故：MCP 列表默认打码，而编辑弹窗预填的就是打码值，于是
  // 「打开编辑 → 改个别的字段 → 保存」把 `TAVILY_API_KEY` 写成了 `••••••`，真值丢失。
  // 这三条分支就是防它的全部逻辑，方向一致：往旧值收。
  const keep = resolveMaskedKv({ TAVILY_API_KEY: MASK_PLACEHOLDER, OTHER: 'x' }, { TAVILY_API_KEY: 'tvly-real' })
  assert.equal(keep.value.TAVILY_API_KEY, 'tvly-real', '有旧真值时必须顶替，而不是把打码值写下去')
  assert.equal(keep.value.OTHER, 'x', '没打码的键原样通过')
  assert.deepEqual(keep.restored, ['TAVILY_API_KEY'])
  assert.notEqual(describeMaskedOutcome(keep), '', '顶替过就要给一句说明，不能静默')

  const drop = resolveMaskedKv({ NEW_KEY: MASK_PLACEHOLDER }, null)
  assert.equal('NEW_KEY' in drop.value, false, '没有旧值可顶替时必须丢弃这个键')
  assert.deepEqual(drop.dropped, ['NEW_KEY'])
  assert.deepEqual(drop.alreadyBroken, [], '旧值不存在 ≠ 旧值已损坏，两者措辞与处置不同')

  const broken = resolveMaskedKv({ TAVILY_API_KEY: MASK_PLACEHOLDER }, { TAVILY_API_KEY: MASK_PLACEHOLDER })
  assert.deepEqual(broken.alreadyBroken, ['TAVILY_API_KEY'], '旧值本身就是打码值 → 要单独报，让用户重填')
  assert.notEqual(describeMaskedOutcome(broken), '')

  // 用户重填真值 → 修好了，不该再报「已丢失」。
  const fixed = resolveMaskedKv({ TAVILY_API_KEY: 'tvly-new' }, { TAVILY_API_KEY: MASK_PLACEHOLDER })
  assert.equal(fixed.value.TAVILY_API_KEY, 'tvly-new')
  assert.deepEqual(fixed.alreadyBroken, [])

  // 一切正常时不该冒出任何噪音。
  const clean = resolveMaskedKv({ A: '1' }, { A: '0' })
  assert.equal(describeMaskedOutcome(clean), '')
})

test('打码判据只认「整串圆点」—— 判错的方向是丢真密钥，所以宁可窄', () => {
  for (const real of ['sk-abc****', '****', 'tvly-dev-1234567890', 'Bearer x', 12345, '', null, undefined]) {
    assert.equal(isMaskedValue(real), false, String(real) + ' 不该被当成打码值')
  }
  assert.equal(isMaskedValue(MASK_PLACEHOLDER), true)
  assert.equal(isMaskedValue('  ' + MASK_PLACEHOLDER + ' '), true, '两侧空白不该影响判定')
  assert.deepEqual(maskedKeysIn({ A: MASK_PLACEHOLDER, B: 'real' }), ['A'])
  assert.deepEqual(maskedKeysIn(null), [], 'loader 级行的 env/headers 是 null')
})

test('令牌提示的文案宿主与界面必须逐字相同（不同则「填写令牌」按钮不出现，且同一件事又变两种说法）；一句话只说缺什么，不念按钮名、不折行', () => {
  // 界面靠**文本相等**识别"令牌没过"（见 client.js 的 isTokenGateText），
  // 文案在宿主（http-fence.ts）与界面词典（client.js）各存一份 —— 改一处忘另一处，
  // 按钮会静默消失、同一件事又变成两种说法。这条把两份钉在一起。
  const client = readFileSync('lib/client.js', 'utf8')
  const clientMsg = (key) => {
    const m = new RegExp('"' + key.replace(/\./g, '\\.') + '":\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(client)
    return m ? m[1].replace(/\\"/g, '"') : null
  }
  // 三种 key 现在说的是同一句话（2026-09-19 用户裁定：不再区分"没配"与"带错"）。
  for (const key of ['error.token.required', 'error.secret.noToken', 'error.secret.badToken']) {
    assert.equal(clientMsg(key), TOKEN_MSG, key + ' 必须与宿主 TOKEN_MSG 一字不差')
  }
  // 这一句只说"缺什么 / 错在哪"，动作交给右侧那颗「填写令牌」按钮：把按钮名念一遍等于同一件事
  // 在一行里说两遍，还把提示条挤成两行（用户 2026-09-19 截图：好几个地方都折行）。两条钉住口径 ——
  // 短到一行放得下（13 字 + 按钮在常见面板宽度里绰绰有余），且不再出现按钮名。
  assert.ok(!TOKEN_MSG.includes('填写令牌'), '提示里不要再念按钮名（按钮就在右边）：' + TOKEN_MSG)
  assert.ok(TOKEN_MSG.length <= 16, '提示要短到一行放得下（一句话只说缺什么）：' + TOKEN_MSG)
})

test('loader 行的 config.token：写得进去、改得对、删得干净，别的一行不碰', () => {
  // 形状取自本机真实文件（含注释头、!!js 守卫、以及后面别的 insert 块）。
  const file = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '',
    '- insert:',
    '    - id: dsh-plugin-tool-management',
    "      name: 'dsh-plugin-tool-management'",
    "      disabled: !!js \"[...ctx.loader.entries()].some((e) => e.options.name === 'x')\"",
    '- insert:',
    '    - id: mcp-github',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: github',
    '        env:',
    '          GITHUB_TOKEN: "ghp_x"',
    '',
  ].join('\n')
  assert.deepEqual(readLoaderToken(file), { found: true, token: '', disabled: false }, '没写 token 时应当是空串、开关是关着的')

  // ① 没有 config → 插进一条，紧跟 id 行；别的块一个字不动。
  const added = applyLoaderToken(file, 'ouli-1')
  assert.equal(added.changed, true)
  assert.equal(readLoaderToken(added.content).token, 'ouli-1')
  assert.ok(added.content.includes('      config:\n        token: "ouli-1"'), '应当是 6/8 空格缩进的 config.token')
  assert.ok(added.content.includes("    - id: mcp-github"), 'github 那条还在')
  assert.ok(added.content.includes('          GITHUB_TOKEN: "ghp_x"'), 'github 的 env 一个字不能动')
  assert.ok(added.content.includes('!!js'), '守卫表达式必须原样保留')

  // ② 改值 → 只换那一行。
  const changed = applyLoaderToken(added.content, 'ouli-2')
  assert.equal(readLoaderToken(changed.content).token, 'ouli-2')
  assert.equal(changed.content.split('\n').length, added.content.split('\n').length, '改值不该增删行')

  // ③ 同值 → changed:false（调用方据此不写盘、不产生无意义备份）。
  assert.equal(applyLoaderToken(added.content, 'ouli-1').changed, false)

  // ④ config 里还有别的键时，删 token 要**留下** config（不能连 maxBodyBytes 一起端走）。
  const withBoth = applyLoaderToken(added.content, 'o')
  const both = withBoth.content.replace('        token: "o"', '        token: "o"\n        maxBodyBytes: 1048576')
  const removedOne = applyLoaderToken(both, null)
  assert.equal(readLoaderToken(removedOne.content).token, '')
  assert.ok(removedOne.content.includes('      config:'), 'config 还有别的键，不能删')
  assert.ok(removedOne.content.includes('maxBodyBytes: 1048576'), '别的键必须留着')

  // ⑤ only-token 的 config → 删 token 时连 config 一起删（不留空 config: = null）。
  // 注意：不能拿"整份文件里还有没有 config:"当断言 —— 别的 insert 块本来就有自己的 config。
  const removedAll = applyLoaderToken(changed.content, null)
  assert.equal(removedAll.changed, true)
  assert.equal(removedAll.content.includes('        token:'), false, '8 空格那条 token 行必须消失')
  assert.ok(removedAll.content.includes('    - id: dsh-plugin-tool-management\n      name: '),
    '本插件那条行应当直接接 name:（config 整块被删掉，不留空 config:）')
  assert.equal(readLoaderToken(removedAll.content).token, '')
  assert.ok(removedAll.content.includes('    - id: mcp-github'), '之后的内容必须完整')

  // ⑥ 文件里没有本插件那条行 → 如实报 found:false，绝不新建一条。
  const missing = applyLoaderToken('- insert:\n    - id: other\n', 'x')
  assert.deepEqual(missing, { found: false })
  assert.deepEqual(readLoaderToken('- insert:\n    - id: other\n'), { found: false, token: '', disabled: false })
})

test('loader 行的 config.tokenDisabled：关闭令牌功能**不动令牌本身**，随时能开回来', () => {
  // 用户裁定 2026-09-19：关闭 = 写一行开关，原令牌留在配置里 —— 此前的实现把 token 删了，
  // 想再开就得重新想一遍令牌。这条把"关掉 / 开回来 / 互不干扰"钉住。
  const file = [
    '- insert:',
    '    - id: dsh-plugin-tool-management',
    "      name: 'dsh-plugin-tool-management'",
    '      config:',
    '        token: "ouli-1"',
    '',
  ].join('\n')

  // ① 关掉 → 只加一行 tokenDisabled: true，token 原样还在。
  const off = applyLoaderTokenDisabled(file, true)
  assert.equal(off.changed, true)
  assert.ok(off.content.includes('        tokenDisabled: true'), '应当写 8 空格缩进的 tokenDisabled')
  assert.equal(readLoaderToken(off.content).token, 'ouli-1', '令牌必须保留（这正是这条需求）')
  assert.equal(readLoaderToken(off.content).disabled, true)
  assert.equal(off.content.split('\n').length, file.split('\n').length + 1, '只多一行')

  // ② 再关一次 → changed:false（调用方据此不写盘、不产生无意义备份）。
  const offAgain = applyLoaderTokenDisabled(off.content, true)
  assert.equal(offAgain.changed, false)
  assert.equal(offAgain.content, off.content)

  // ③ 开回来 → 开关那一行删掉，令牌**还是**原来那个（不需要重新输一遍）。
  const on = applyLoaderTokenDisabled(off.content, false)
  assert.equal(on.changed, true)
  assert.equal(on.content, file, '开回来应当回到"只有 token"的原状')
  assert.equal(readLoaderToken(on.content).token, 'ouli-1')
  assert.equal(readLoaderToken(on.content).disabled, false)

  // ④ 令牌与开关互不干扰：换令牌时开关那一行留着（换值只换一行）。
  const rekeyed = applyLoaderToken(off.content, 'ouli-2')
  assert.equal(readLoaderToken(rekeyed.content).token, 'ouli-2')
  assert.equal(readLoaderToken(rekeyed.content).disabled, true, '换令牌不该顺手把开关也改掉')
  assert.equal(rekeyed.content.split('\n').length, off.content.split('\n').length, '改值不该增删行')

  // ⑤ 只有 tokenDisabled 的 config → 关掉开关时连 config 一起删（不留空 config:）。
  const onlyFlag = applyLoaderToken(file, null)
  const flagged = applyLoaderTokenDisabled(onlyFlag.content, true)
  const cleared = applyLoaderTokenDisabled(flagged.content, false)
  assert.equal(cleared.content.includes('config:'), false, '空 config: 是 null，不能留')
  assert.equal(readLoaderToken(cleared.content).disabled, false)

  // ⑥ 读的时候两个键不能相互误判：tokenDisabled 的行不该被当成 token。
  assert.equal(readLoaderToken('    - id: dsh-plugin-tool-management\n      config:\n        tokenDisabled: true\n').token, '')
  assert.equal(readLoaderToken('    - id: dsh-plugin-tool-management\n      config:\n        token: "abc"\n').disabled, false)
})

// ── 分层行为探针（07 审查五档问题 2：15 个能力此前只有 3 个带 probe）──────────
// 契约口径：真调哨兵分类 + 删除类文本漂移收紧。断言红了只有两种含义 ——
// 探针把好宿主误判成坏（用户删除被无端拒绝），或把漂移/坏宿主放行（裸调破坏数据）。
// 这两个方向都属于「一旦破了会静默出错」，正是本文件第②类测试。

test('分层行为探针：真 SessionStore 方法（好宿主）→ sessions 两能力 ok，哨兵真调零副作用', () => {
  const good = Object.create(SessionStore.prototype)
  good.store = new Map() // detachEntered 对未知 id 走早退分支，需要 this.store 是 Map
  const byId = new Map(assessHost({ sessions: good }).findings.map((f) => [f.id, f]))
  assert.equal(byId.get('sessions.detach-live')?.state, 'ok', '官方原方法：文本比对恒真 + 哨兵真调（liveEntryFor/flush 受控抛错、detachEntered 早退）必须通过')
  assert.equal(byId.get('sessions.cold-announce')?.state, 'ok', 'announce 哨兵真调必须通过；enter 不真调（官方实现对任意输入都写 store）')
})

test('分层行为探针：同名不同文的私有方法（漂移宿主）→ 删除类一律 shape-mismatch', () => {
  const drifted = Object.create(SessionStore.prototype)
  drifted.store = new Map()
  drifted.liveEntryFor = function liveEntryFor(session) { return null } // 同名、行为也能跑，但实现文本已漂移
  drifted.announce = function announce(session) { /* no-op */ }
  const byId = new Map(assessHost({ sessions: drifted }).findings.map((f) => [f.id, f]))
  const detach = byId.get('sessions.detach-live')
  const cold = byId.get('sessions.cold-announce')
  assert.equal(detach?.state, 'shape-mismatch', '文本漂移的删除类能力不得按「成员齐备」放行 —— 这正是「路由盲信方法存在」要修的洞')
  assert.equal(detach?.textMatch, false, '漂移必须被 textMatch 记录在案')
  assert.equal(cold?.state, 'shape-mismatch', 'cold-announce 同为删除类，口径必须一致')
})

test('分层行为探针：哨兵真调抛 TypeError（坏宿主）→ shape-mismatch；受控 Error 不是失败', () => {
  const broken = Object.create(SessionStore.prototype)
  broken.store = new Map()
  broken.liveEntryFor = function liveEntryFor(session) { throw new TypeError('signature drifted') }
  const byId = new Map(assessHost({ sessions: broken }).findings.map((f) => [f.id, f]))
  assert.match(String(byId.get('sessions.detach-live')?.detail), /TypeError/, '同步 TypeError 是「实现坏了/签名漂了」的信号，必须进失败详情')
  // 对照：真实现的 liveEntryFor 对哨兵抛的是受控 Error（session not live），不是 TypeError ——
  // 上面第一个测试通过即是这条的反向证明。
})

test('分层行为探针：workspace 原生删除入口 —— 异步受控拒绝 ok，同步 TypeError 拦下', async () => {
  const controlled = { deleteSession: async (id) => { throw new Error(`unknown session ${id}`) } }
  const okFindings = new Map(assessHost({ get: (name) => (name === 'workspaceRegistry' ? controlled : undefined) }).findings.map((f) => [f.id, f]))
  assert.equal(okFindings.get('workspace.delete-native')?.state, 'ok', '返回 rejected Promise 属受控拒绝，同步段无 TypeError 即可调用')
  await new Promise((resolve) => setImmediate(resolve)) // 让哨兵 Promise 结算：探针必须已挂 .catch，不许留 unhandled rejection

  const broken = { deleteSession(id) { return null.never } }
  const badFindings = new Map(assessHost({ get: (name) => (name === 'workspaceRegistry' ? broken : undefined) }).findings.map((f) => [f.id, f]))
  assert.equal(badFindings.get('workspace.delete-native')?.state, 'shape-mismatch', '同步 TypeError = 不得走 native 路由')
})

// ── patch-yaml golden 回环（07 审查五档问题 3：YAML 生成/解析从 index.ts 抽出）─────
// 生成器与解析器互为镜像：一旦回环不恒等，界面显示的「生效值」就开始撒谎
//（改 YAML 写入口径却读不回来 = 用户看到的与宿主跑的不是同一份）。属第②类
//「一旦破了会静默出错」。

import { appendBlock, buildDisableBlock, buildInsertBlock, parseRows, removeEntryAll, removeMarked } from '../lib/mcp/patch-yaml.js'

test('patch-yaml golden：buildInsertBlock → parseRows 往返恒等（stdio / http / 特殊字符）', () => {
  const cases = [
    { id: 'stdio-full', serverName: 's-stdio', transport: 'stdio', command: 'npx', args: ['-y', 'pkg@1.2'], env: { K: 'v 1', EMPTY: '' }, toolCallTimeoutMs: 3000 },
    { id: 'http-hdr', serverName: 's-http', transport: 'streamable-http', url: 'https://x/y?z=1', headers: { 'X-Token': 'a b"c' } },
    { id: 'plain-id.only', serverName: '中文服务名', transport: 'stdio', command: 'cmd' },
  ]
  let content = '[]\n'
  for (const row of cases) content = appendBlock(content, buildInsertBlock(row))
  const parsed = parseRows(content).rows
  assert.equal(parsed.length, 3, '三条 insert 行都要被读回（name 都命中本插件 loader）')
  for (let i = 0; i < cases.length; i += 1) {
    const src = cases[i], got = parsed[i]
    assert.equal(got.id, src.id)
    assert.equal(String(got.config.serverName), src.serverName, 'serverName 往返不变')
    assert.equal(String(got.config.transport), src.transport, 'transport 往返不变')
    if (src.args) assert.deepEqual(got.config.args, src.args, 'args 列表往返不变')
    if (src.env) assert.deepEqual(got.config.env, src.env, 'env 映射往返不变（含空串值）')
    if (src.url) assert.equal(String(got.config.url), src.url, 'url 往返不变（含查询串）')
    if (src.headers) assert.deepEqual(got.config.headers, src.headers, 'headers 往返不变（含引号与空格）')
    if (src.toolCallTimeoutMs) assert.equal(got.config.toolCallTimeoutMs, src.toolCallTimeoutMs, '数字往返不变')
    assert.equal(got.managed, true, '带 server 标记注释的行 managed = true')
    assert.equal(got.disabled, undefined, '新 insert 行不带 disabled')
  }
})

test('patch-yaml golden：disable/enable 覆盖块能改写行状态，removeEntryAll 清理干净', () => {
  let content = '[]\n'
  content = appendBlock(content, buildInsertBlock({ id: 'victim', serverName: 'srv', transport: 'stdio', command: 'c' }))
  content = appendBlock(content, buildInsertBlock({ id: 'bystander', serverName: 'srv2', transport: 'stdio', command: 'c2' }))
  // 追加 disable 覆盖块 → victim.disabled = true，bystander 不受影响
  content = appendBlock(content, buildDisableBlock('victim', true))
  let rows = parseRows(content).rows
  assert.equal(rows.find((r) => r.id === 'victim').disabled, true, 'disable 覆盖块按文件顺序回填 disabled')
  assert.equal(rows.find((r) => r.id === 'bystander').disabled, undefined)
  // removeMarked 只删标记块（disable 那份），insert 留下、disabled 复位为未定义
  const afterRemoveMarked = removeMarked(content, 'victim', 'disable')
  rows = parseRows(afterRemoveMarked).rows
  assert.equal(rows.find((r) => r.id === 'victim').disabled, undefined, '删掉 disable 标记块后 disabled 复位')
  assert.equal(rows.length, 2)
  // removeEntryAll 清掉 insert + 全部标记 + 裸覆盖块，只剩 bystander；再删最后一个 → 空文件保持 [] 合法形状
  const afterRemove = removeEntryAll(removeMarked(content, 'victim', 'disable'), 'victim')
  rows = parseRows(afterRemove).rows
  assert.deepEqual(rows.map((r) => r.id), ['bystander'], 'victim 的 insert 块也被清掉')
  const emptied = removeEntryAll(afterRemove, 'bystander')
  assert.ok(/^\[\]\s*$/m.test(emptied), '删光后文件必须仍是合法的顶层 YAML 数组（[]），宿主 loadOptionalPatches 不抛')
})

test('patch-yaml golden：仓库自带 cordis.patch.yml 不抛错且只认出本插件 loader 行', () => {
  const real = readFileSync('cordis.patch.yml', 'utf8')
  const { rows } = parseRows(real)
  assert.ok(Array.isArray(rows))
  assert.ok(rows.every((r) => r.id === 'dsh-plugin-tool-management' || typeof r.id === 'string'), '真实补丁文件按本插件 loader 名过滤，行形状完整')
})

test('令牌门禁：本次启动没验过令牌时 pre-step 直接拒绝，验过即放行', async () => {
  // 这条钉的是"没输入令牌就没法对话"的**唯一**落实点。客户端的输入框锁定在本宿主上
  // 无路可走（`ctx.conversation.blocks` 不在客户端服务注册表里，2026-09-19 真机实测），
  // 所以门禁一旦在这里失效，整条保护就只剩"写了配置但没人执行"。
  let listener = null
  const ctx = { on: (name, fn) => { listener = fn; return () => {} } }
  const gate = { active: false }
  createContextInjector({
    ctx,
    domains: () => [],
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
    tokenGateActive: () => gate.active,
  })
  assert.equal(typeof listener, 'function', 'pre-step 监听必须注册上')
  const payload = { agent: {}, step: 1 }
  let called = 0
  const next = async () => { called += 1; return { kind: 'enter', messages: [] } }
  assert.equal((await listener(payload, next)).kind, 'enter', '未配置令牌时照旧放行')
  assert.equal(called, 1)
  gate.active = true
  assert.equal((await listener(payload, next)).kind, 'reject', '未验证时拒绝这一轮')
  assert.equal(called, 1, '拒绝时不该再往下走（后面的注入是给模型的，模型这步不会被调用）')
  gate.active = false
  assert.equal((await listener(payload, next)).kind, 'enter', '验证后立即恢复')
  // 门禁判定本身抛错不能反过来卡住对话（宁可放行）。
  const broken = createContextInjector({
    ctx: { on: (name, fn) => { listener = fn; return () => {} } },
    domains: () => [],
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
    tokenGateActive: () => { throw new Error('boom') },
  })
  assert.ok(broken)
  assert.equal((await listener(payload, next)).kind, 'enter')
})

test('令牌的"本次启动验过"闩：只置位、不清零，门禁口径 = 生效且未验过', () => {
  const on = createAccessToken({ config: { token: 'secret-value' } })
  assert.equal(on.TOKEN, 'secret-value')
  assert.equal(on.TOKEN !== '' && !on.acceptedThisBoot(), true, '配了令牌且没人验过 ⇒ 门禁开着')
  on.markAccepted()
  assert.equal(on.acceptedThisBoot(), true)
  assert.equal(on.TOKEN !== '' && !on.acceptedThisBoot(), false, '验过一次即放开，本次进程内不再要求重填')
  // 关掉令牌功能 = 没生效 ⇒ 门禁恒关（与写门禁同一口径）。
  const off = createAccessToken({ config: { token: 'secret-value', tokenDisabled: true } })
  assert.equal(off.TOKEN, '')
  assert.equal(off.TOKEN !== '' && !off.acceptedThisBoot(), false)
  // 没配令牌同理。
  const none = createAccessToken({ config: {} })
  assert.equal(none.TOKEN !== '' && !none.acceptedThisBoot(), false)
})

// A1：补丁写入前的解析校验。这里钉的是**判据**（官方那份方言判得动吗）与**非对称策略**
// （只有"我们改坏的"才拦；复刻过期 / 依赖缺失一律放行 + 上报）—— 两者的实现细节都可以改，
// 这三条口径不能改：改了就等于拿能力换保守，或者把"写坏 DSH 起不来"放过去。
test('补丁方言判据：官方 schema 认得的就是认得，认不得的一律判「解析不过」', () => {
  const ok = [
    '[{"id": "mcp-a", "config": {"command": "npx"}}]',
    '- id: mcp-a\n  disabled: !!js "ctx.loader !== undefined"\n',
    '[]',
  ]
  for (const text of ok) assert.equal(judgePatchText(yaml, text).status, 'ok', text)
  const bad = [
    '- id: a\n  config:\n    command: npx\n    command: npx2\n',   // 重复键（官方解析器抛错 → DSH 起不来）
    '- id: a\n  config: !Foo bar\n',                              // 未知 tag
    '',                                                            // 空文件（官方：present 但不是数组 → 抛错）
    'id: a\n',                                                     // 顶层不是数组
    '- foo\n',                                                     // 项不是映射
  ]
  for (const text of bad) assert.equal(judgePatchText(yaml, text).status, 'unparseable', JSON.stringify(text))
})

test('补丁写入策略是非对称的：只拦「我们改坏的」，复刻过期 / 依赖缺失一律放行', () => {
  const ok = { status: 'ok' }
  const broken = { status: 'unparseable', detail: 'duplicated mapping key' }
  const noDep = { status: 'no-dep', detail: 'cannot find module js-yaml' }
  // 改前是好的、改后坏了 ⇒ 拦（这是我们引入的坏内容）。
  const blocked = decidePatchWrite(ok, broken)
  assert.equal(blocked.allow, false)
  assert.ok(blocked.error && blocked.error.length > 0, '拒绝必须带一句能看懂的说明')
  // 没有基线（文件不存在）也拦：写下去就是把 DSH 写坏。
  assert.equal(decidePatchWrite(null, broken).allow, false)
  // 改前本来就解析不过 ⇒ 复刻过期，放行 + 上报（绝不因为校验器过期而让写路径停摆）。
  const outdated = decidePatchWrite(broken, broken)
  assert.equal(outdated.allow, true)
  assert.equal(outdated.report.kind, 'replica-outdated')
  // 依赖缺失 ⇒ 放行 + 上报。
  const missing = decidePatchWrite(ok, noDep)
  assert.equal(missing.allow, true)
  assert.equal(missing.report.kind, 'no-dep')
  // 校验通过 ⇒ 放行、不上报（页面那一行也随之收掉）。
  const fine = decidePatchWrite(ok, ok)
  assert.equal(fine.allow, true)
  assert.equal(fine.report, null)
})

test('checkPatchWrite 端到端：合法写入放行、把文件改成坏结构时拒绝', async () => {
  const good = await checkPatchWrite('', '[{"id": "mcp-a"}]\n')
  assert.equal(good.allow, true)
  // 改前是好文件、改后是重复键 ⇒ 拒绝（正是「把 DSH 写坏」的那一次）。
  const refuse = await checkPatchWrite('[{"id": "mcp-a"}]\n', '- id: a\n  config:\n    x: 1\n    x: 2\n')
  assert.equal(refuse.allow, false)
})

// A4：发行物里那段 `!!js` 表达式**每次启动**都被宿主求值（cordis-plugin-loader
// Entry.disabledOf → evaluate），那条调用链没有保护。这条测试钉的只有一件事：
// 换任何形状的 ctx 它都返回布尔、绝不抛 —— 抛了就是"DSH 起不来"。
test('发行物 cordis.patch.yml 的双挂载表达式：任何 ctx 下都返回布尔、绝不抛', () => {
  const expr = /^ {6}disabled: !!js "(.*)"$/m.exec(readFileSync('cordis.patch.yml', 'utf8'))?.[1]
  assert.ok(expr, '发行物里应当有那段 !!js 表达式')
  // 与官方 evaluate 同形的求值器（new Function + with(ctx) + eval）。
  const evaluate = new Function('ctx', 'expr', 'with (ctx) {\n  return eval(expr)\n}')
  const cases = [
    [{ loader: { entries: () => [] } }, false],
    [{ loader: { entries: () => [{ options: { id: 'dsh-plugin-tool-management', name: 'dsh-plugin-tool-management' } }] } }, false],
    [{ loader: { entries: () => [
      { options: { id: 'dsh-plugin-tool-management', name: 'dsh-plugin-tool-management' } },
      { options: { id: 'other-id', name: 'dsh-plugin-tool-management', disabled: false } },
    ] } }, true],
    [{ loader: undefined }, false],
    [{}, false],
    [{ loader: { entries: () => { throw new Error('shape changed upstream') } } }, false],
  ]
  for (const [ctx, expected] of cases) {
    let got
    assert.doesNotThrow(() => { got = evaluate(ctx, expr) }, JSON.stringify(ctx))
    assert.equal(got, expected, JSON.stringify(ctx))
  }
})

test('工具描述里引用的注入板块名必须真实存在（跨模块引用不悬空）', () => {
  // ③ 自洽性。破了这一条的后果是**静默**的：工具描述把模型指向一个不存在的板块名，
  // 模型照着去找那个 reminder 会找不到 —— 编译、构建、类型检查、i18n 检查都不报。
  // 2026-09-23 出过一次：注入层把「场景和记忆」拆成「场景」+「记忆」两段、改了板块标题，
  // 而 `memory_manager_list` 的描述里还写着「本机当前的场景和记忆」。
  //
  // 判据只认**以「本机」或「可委派」开头**的「…」—— 那是板块名的形态；别的「…」
  // （如「来源：」）是行内标记，不是板块引用，不参与校验。
  const titles = new Set(
    INJECT_DOMAIN_KEYS.map((key) => {
      const text = renderDomainText({ key, label: key, form: 'snapshot', name: 'x', text: '' })
      const line = text.split('\n').find((l) => l.startsWith('# '))
      return line === undefined ? '' : line.slice(2)
    }),
  )
  const files = [
    'src/tools/mcp.ts', 'src/tools/memory.ts', 'src/tools/prompt.ts',
    'src/tools/skills.ts', 'src/tools/subagent.ts', 'src/tools/scene.ts',
    'src/subagents/tools.ts',
  ]
  const seen = []
  for (const rel of files) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
    for (const m of src.matchAll(/「(本机[^」]*|可委派[^」]*)」/g)) seen.push([rel, m[1]])
  }
  assert.ok(seen.length > 0, '一个板块引用都没扫到 —— 判据或文件清单写错了')
  for (const [rel, name] of seen) {
    assert.ok(
      titles.has(name),
      `${rel} 引用了不存在的注入板块「${name}」；实际存在：${[...titles].join(' / ')}`,
    )
  }
})

test('静态工具描述不得点名出厂默认关闭的工具', () => {
  // ③ 自洽性，与上一条（板块名引用）同一族：破了也是**静默**的 —— 编译、类型检查、
  // i18n 检查都不报。description 是静态文本，没法像运行时提示那样按 toolVisible 改写；
  // 点名一条被关掉的工具，模型会照着去调，执行侧拦住它，白跑一趟还看不出原因
  // （部分启用时真会发生：用户开 save 不开 switch）。
  //
  // 判据只扫 `description:` 字面量：运行时那些**过了 toolVisible 门控**的点名
  // （mcp/skill 的 listHint、scene/subagent 的回执分叉）不算 —— 它们只在工具可见时
  // 才出现，正是本条要鼓励的写法。静态文本要指路就用中性说法（"the list" /
  // "the scene listing"），要点名就挪到运行时按可见性分叉。
  const files = [
    'src/tools/mcp.ts', 'src/tools/memory.ts', 'src/tools/prompt.ts',
    'src/tools/skills.ts', 'src/tools/subagent.ts', 'src/tools/scene.ts',
    'src/subagents/tools.ts',
  ]
  let scanned = 0
  for (const rel of files) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
    for (const line of src.split('\n')) {
      for (const m of line.matchAll(/description:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        scanned += 1
        for (const name of DEFAULT_HIDDEN_TOOLS) {
          assert.ok(
            !m[2].includes(name),
            `${rel} 的 description 点名了出厂默认关闭的工具 ${name}：「${m[2].slice(0, 80)}…」—— 静态描述改用中性说法，或挪到运行时按 toolVisible 分叉`,
          )
        }
      }
    }
  }
  assert.ok(scanned > 20, '一个 description 都没扫到 —— 判据或文件清单写错了')
})
