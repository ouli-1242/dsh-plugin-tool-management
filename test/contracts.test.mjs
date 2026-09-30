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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_INJECT_SETTINGS,
  DOMAIN_TOOL_PREFIX,
  INJECT_DOMAIN_KEYS,
  createContextInjector,
  domainOfTool,
  explainInjections,
  isSubagentSession,
  renderDomainText,
  selectInjections,
  subagentDepthOf,
} from '../lib/context-inject.js'
import { catalogDepthOf, catalogInjectedAt, emptyResultNote, parsePersona, renderPersonaPrompt, serializePersona, textOfBlocks } from '../lib/subagents/service.js'
import { parseModeState } from '../lib/memories/service.js'
import { TOKEN_MSG } from '../lib/http-fence.js'
import { DEFAULT_HIDDEN_TOOLS, LEGACY_TOOL_NAME_MAP, migrateLegacyToolNames, normalizeToolTableSettings } from '../lib/tools/table.js'
import { createAccessToken, createFrozenGate, guardModelOps, installHandlerGuards } from '../lib/request-gate.js'
import { applyLoaderToken, applyLoaderTokenDisabled, readLoaderToken } from '../lib/mcp/loader-token.js'
import { checkPatchWrite, decidePatchWrite, judgePatchText } from '../lib/compat/patch-dialect.js'
import * as yaml from 'js-yaml'
import { MASK_PLACEHOLDER, describeMaskedOutcome, isMaskedUrl, isMaskedValue, maskSecretValue, maskUrlQuery, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from '../lib/mcp/secret-guard.js'
import { isValidTrashPayloadPath, isPatchBackupName, moveOutOfTrash, moveToTrash } from '../lib/hub.js'
import { isIndexQuarantined, readIndex, writeFileAtomically, writeIndex } from '../lib/memories/index-io.js'
import { MCP_CLIENT_MODULE, MCP_TOOL_PREFIX, ambiguousServerNames, looksLikeMcpPrefixDrift, serverNameCandidates, splitMcpToolName } from '../lib/host-names.js'
import { isToolDisabledIn } from '../lib/mcp/manager.js'
import { renderMcpStateSection } from '../lib/mcp/state-section.js'
import { EXPECTED_PEER_RANGE, assessHost } from '../lib/compat/probe.js'
import { scanLoaderRows } from '../lib/mcp/loader-token.js'
import { isValidGroupPath, isValidGroupSegment } from '../lib/memories/constants.js'
import { createMemoriesService } from '../lib/memories/service.js'
import { importUploadedSkill, listProviderCandidates, permanentlyDeleteTrash, setPreferredSkill, setSkillEnabled, state, userRoots } from '../lib/skills/core.js'
import { isValidSegment } from '../lib/paths.js'
import { contradictoryEntries, frozenOps, isReadCall, writeWhenUnwritten } from '../lib/op-registry.js'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { buildSessionOps } from '../lib/ops/sessions.js'
import { ArchiveWorkspaceRegistry } from '../lib/sessions/workspace.js'
import { buildTrashOps } from '../lib/ops/trash.js'
import { bundleDocName, LEGACY_BUNDLE_DOC, MEMORIES_TRASH_DIR } from '../lib/memories/constants.js'
import { detectFormat } from '../lib/imports/parsers.js'
import { buildPromptOps } from '../lib/ops/prompts.js'
import { createScenePromptSync } from '../lib/scene-prompt-sync.js'

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
  // "不打断"不等于"当成没内容"（0.17.0 审查 P1-8）：取数抛异常必须能被上报与解释。
  // 破了它的后果是**静默的**——通道把该域读成"这一轮没内容"，进而向模型发一条假的
  // 「已清空」，模型据此认为那份内容已失效，下一轮内容恢复后又重发一次。
  const failed = new Set()
  const errors = []
  selectInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {}, (key, error) => { failed.add(key); errors.push(error.message) })
  assert.deepEqual([...failed], ['memory'], '抛异常的域要经 onError 报出去')
  assert.deepEqual(errors, ['boom'], '原始异常要原样带给调用方（降级说明要用它）')
  assert.equal(explainInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {}, failed).memory, 'error', '实况要报「取数失败」而不是「无内容」')
  assert.equal(explainInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {}).memory, 'empty', '不传失败集合时保持旧口径（向后兼容）')
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

import { appendBlock, buildDisableBlock, buildInsertBlock, insertEntryIds, parseRows, removeEntryAll, removeMarked } from '../lib/mcp/patch-yaml.js'

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

test('两态 op 的写判据：`set:true` 之外还有别的写触发键，漏一个就是配了令牌也能改侧车', () => {
  // 破了这一条的后果是**静默的**：`tool-table` 的 `presetSave` / `presetDelete` 只动
  // `presets`、**不动 `hidden`**，所以绕过 `set` —— 只认 `set === true` 的判据把这两条
  // 当成纯读放行，于是配了令牌的宿主上，一次免令牌请求就能改侧车（审查 F2，0.17.0）。
  assert.equal(isReadCall('tool-table', {}), true, '空 args 是读')
  assert.equal(isReadCall('tool-table', { set: false }), true, 'set:false 仍是读')
  assert.equal(isReadCall('tool-table', { set: true, hidden: [] }), false, 'set:true 是写')
  assert.equal(isReadCall('tool-table', { presetSave: 'x' }), false, 'presetSave 是写')
  assert.equal(isReadCall('tool-table', { presetDelete: 'x' }), false, 'presetDelete 是写')
  for (const op of ['inject-settings', 'scene-settings', 'mcpm-settings']) {
    assert.equal(isReadCall(op, {}), true, op + '：空 args 是读')
    assert.equal(isReadCall(op, { set: true }), false, op + '：set:true 是写')
  }
  // 没带判据的 op 一律按写处理（"不知道就别放行"）—— 否则某个畸形 args 会恰好免门禁。
  assert.equal(isReadCall('skill-delete', {}), false, '没声明判据的写 op 按写处理')
  assert.equal(isReadCall('rules-list', {}), false, '只读 op 不是两态，返回 false')
  assert.equal(isReadCall('no-such-op', {}), false, '未登记的 op 按写处理')
  // 判据本身要与登记表自洽：有 `writeWhen` 就必须标 `write`，且不得同时标 `readonly`。
  assert.deepEqual(writeWhenUnwritten(), [], '带写判据却没标写的条目：那份判据永远不会被问到')
  assert.deepEqual(contradictoryEntries(), [], '只读与写自相矛盾的条目')
})

test('场景冻结：HTTP handlers 与模型侧 op 表用同一份判据，锁着**别的**场景时两侧都要拒', async () => {
  // F3 的靶心：此前冻结只装在 handlers 上，模型工具拿的是 service.ops 的副本，唯一守卫
  // `lockedSceneGuard()` 又只看**当前**场景 —— 于是「锁一个非活动场景」在 HTTP 上被拒、
  // 在模型侧五个域全放行。一个界面禁用、模型可写的门禁等于没有门禁。
  // 这条测试把两个入口拉到一起，用**真实的** installHandlerGuards / guardModelOps /
  // createFrozenGate 逐 op 比对结论 —— 两侧分家就红。
  const LOCKED = ['别的场景']
  const deps = { lockedSceneNames: async () => LOCKED, activeSceneName: async () => '办公' }
  const names = frozenOps()
  assert.ok(names.length > 0, '冻结清单不能是空的（空 = 这道门禁形同虚设）')

  const handlers = {}
  for (const op of [...names, 'rules-scene-lock', 'scene-mode-set', 'rules-list']) {
    handlers[op] = async () => ({ ok: true })
  }
  installHandlerGuards({
    handlers, ...deps, syncSwitchToScene: async () => null, subagentToolFailures: [],
  })

  const raw = {}
  for (const op of names) raw[op] = async () => ({ ok: true })
  const modelOps = guardModelOps(raw, createFrozenGate(deps))

  // ① 两侧结论必须逐 op 一致（args 用空对象：三种口径在空 args 下都有确定答案）。
  for (const op of names) {
    const viaHttp = await handlers[op]({})
    const viaModel = await modelOps[op]({})
    assert.equal(viaModel.ok === false, viaHttp.ok === false, op + '：两个入口的结论必须一致')
  }

  // ② 锁着**非活动**场景，五个域的写 op 一律拒（这是 F3 的直接断言）。
  for (const [op, args] of [
    ['skill-enable', {}], ['rules-update', {}], ['mcpm-add', {}],
    ['subagent-create', {}], ['agentsmd-apply', {}], ['scene-archive-save', { scene: '别的场景' }],
  ]) {
    assert.equal((await modelOps[op](args)).ok, false, op + '：锁着非活动场景时模型侧必须拒')
    assert.equal((await handlers[op](args)).ok, false, op + '：HTTP 侧同样拒')
  }

  // ③ 模型侧的表是**新表**：场景引擎直调的原表必须原样不动（否则进/退场景会被自己锁死）。
  assert.equal((await raw['skill-enable']({})).ok, true, 'guardModelOps 不得改动传入的表')

  // ④ 防过度冻结（R1）：这几条必须放行，否则锁上就解不开、出不来。
  assert.equal((await handlers['rules-scene-lock']({})).ok, true, '解锁开关不能被冻结挡住')
  assert.equal((await handlers['scene-mode-set']({ scene: null })).ok, true, '场景启停本身不在冻结清单里')
  assert.equal(await createFrozenGate(deps)('mcpm-restart', {}), null, 'restart 不在冻结清单里（它是卡住时的恢复路径）')
  assert.equal(await createFrozenGate(deps)('rules-list', {}), null, '只读 op 不受冻结影响')

  // ⑤ `rules-set-active` 是 active-scene 口径：锁的是**别的**场景时它照旧可用（不该被牵连），
  //    只有"正在生效的那个场景被锁"才管 —— 此时同集合重复提交仍放行，改集合才拒。
  assert.equal(await createFrozenGate(deps)('rules-set-active', { scenes: [] }), null, '锁的是别的场景，不该牵连它')
  const activeLocked = createFrozenGate({ lockedSceneNames: async () => ['办公'], activeSceneName: async () => '办公' })
  assert.equal(await activeLocked('rules-set-active', { scenes: ['办公'] }), null, '同集合重复提交放行')
  assert.ok(await activeLocked('rules-set-active', { scenes: [] }), '锁定期间清空启用集合要拒（否则模型侧写门禁失效）')
  assert.ok(await activeLocked('rules-set-active', { scenes: ['另一个'] }), '锁定期间换成别的场景同样要拒')

  // ⑥ 没有场景锁着时一条都不拦（别把正常路径一起冻住）。
  const open = createFrozenGate({ lockedSceneNames: async () => [], activeSceneName: async () => null })
  for (const op of names) assert.equal(await open(op, {}), null, op + '：无锁定时不得拦')
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

// ── 0.17.0：对抗性审查收尾的四条不变量 ──────────────────────────────────────
// 它们都是"破了之后**静默**出错"那一类（AGENTS.md 允许的②），且与文案/排版无关。

test('URL 打码：凭据参数名不止四个，且打码值回写时认得出', () => {
  // 破了这一条的后果是**凭据外泄**：整机迁移的导出物（默认打码）就是要拷去 U 盘 / 另一台
  // 机器的，而 MCP 托管服务的凭据主流写法是 `?api_key=` / `?access_token=` 这类 ——
  // 0.16.6 的内联窄正则只认 key/token/secret/password 四个名字，其余全部明文导出（审查 P0-4）。
  for (const q of ['api_key=sk-1', 'access_token=sk-2', 'client_secret=sk-3', 'sig=sk-4', 'X-Amz-Signature=sk-5', 'subscription-key=sk-6']) {
    const url = 'https://mcp.example.com/sse?' + q
    const masked = maskUrlQuery(url)
    assert.notEqual(masked, url, q + ' 必须被打码')
    assert.ok(!masked.includes('sk-'), q + ' 的值不得留在打码结果里')
    assert.ok(masked.startsWith('https://mcp.example.com/sse'), '路径与主机要保留（它是该服务的身份）')
    assert.equal(isMaskedUrl(masked), true, q + ' 的打码结果必须能被 isMaskedUrl 认出 —— 认不出就会在回写时被当成真地址写进补丁')
  }
  // 非绝对 URL 同样要打码，且**同样要认得出**：少了 isMaskedUrl 的字符串分支，
  // 这一侧的"打码"会变成一次反向的数据丢失。
  const rel = maskUrlQuery('/mcp/sse?api_key=sk-7')
  assert.ok(!rel.includes('sk-7'))
  assert.equal(isMaskedUrl(rel), true)
  assert.equal(isMaskedUrl('https://x/y?api_key=sk-8'), false, '真地址不得被误判成打码值（判错的方向是丢真配置）')
  // `$VAR` / `!!js` 是**间接引用**而不是密钥：打成占位符再导回来只会丢键。
  assert.equal(maskSecretValue('$TAVILY_API_KEY'), '$TAVILY_API_KEY')
  assert.equal(maskSecretValue('!!js process.env.X'), '!!js process.env.X')
})

test('回收站负载名：目录树负载放行，路径穿越一律拒绝', () => {
  // 破了这一条的后果是**静默的**：场景里的记忆天然是目录树（bundle 形态
  // `<场景>/<名>/<名>.md`），负载名谓词一旦拒收 `/`，删除能成功、恢复必失败，
  // 且失败后场景目录已非空 —— 这个场景再也恢复不了（2026-09-30 审查 P0-2，实测复现）。
  for (const good of ['rule.md', 'bundle1/bundle1.md', 'a/b/c.md', '.DS_Store']) {
    assert.equal(isValidTrashPayloadPath(good), true, good + ' 应当放行')
  }
  for (const bad of ['../evil.md', 'a/../../evil.md', '/abs/evil.md', 'C:\evil.md', 'a\b.md', 'manifest.json', 'a//b.md', './a.md', '..', '.', '']) {
    assert.equal(isValidTrashPayloadPath(bad), false, JSON.stringify(bad) + ' 必须拒绝')
  }
})

test('回收站往返：嵌套负载搬得进也搬得出，非法负载名当场拒绝且不搬动任何文件', async () => {
  // 这两件事必须一起成立：只放行不拒绝 = 给了任意相对路径；只拒绝不放行 = 恢复必然失败。
  const home = mkdtempSync(join(tmpdir(), 'dsh-trash-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const scene = join(home, 'memories', '办公')
    mkdirSync(join(scene, 'bundle1'), { recursive: true })
    writeFileSync(join(scene, 'bundle1', 'bundle1.md'), 'bundle body')
    const trashed = await moveToTrash('scenes', '办公', [{ from: join(scene, 'bundle1', 'bundle1.md'), dest: 'bundle1/bundle1.md' }], { record: null })
    assert.equal(trashed.ok, true, '嵌套负载要能进回收站')
    const back = join(home, 'restore', '办公', 'bundle1', 'bundle1.md')
    await moveOutOfTrash('scenes', trashed.id, 'bundle1/bundle1.md', back)
    assert.equal(readFileSync(back, 'utf8'), 'bundle body', '要能按原相对路径放回')
    // 入口拒绝：源文件必须原地不动（宁可这次删不掉，也不能留下一个"将来恢复不了"的条目）
    const victim = join(home, 'victim.md')
    writeFileSync(victim, 'keep me')
    const bad = await moveToTrash('scenes', 'x', [{ from: victim, dest: '../escape.md' }])
    assert.equal(bad.ok, false, '穿越负载名必须被拒')
    assert.equal(existsSync(victim), true, '被拒后源文件原地未动')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('回收站条目 id：穿越名在「拼路径」与「硬删除」两条路上都进不去', async () => {
  // 破了这一条的后果比丢一条严重得多：回收站条目的 id 会被拼成 `<root>/<id>`，
  // 而 `..` 解析后正是**回收站根目录** —— 一次「删除某一条」会变成「把 trash/ 下
  // 技能/场景/子智能体/提示词四类回收站整体送进系统回收站」，且返回 ok:true
  // （0.17.0 审查 F1，已端到端实测复现）。所以两侧都钉：单段名校验必须拒绝穿越名，
  // 且 core 的硬删除兜底对穿越名一律 notFound、不碰任何文件。
  for (const bad of ['.', '..', '...', '../x', 'a/../..', '..\\x', 'x/..', '', '  ', 'CON', 'nul.md']) {
    assert.equal(isValidSegment(bad), false, JSON.stringify(bad) + ' 必须被判为非法段名')
  }
  // 正例：本模块自己生成的 id 形状必须放行 —— 否则「能列出来、删不掉」。
  for (const ok of ['m1abc2d3-deadbeef', 'abc-1', 'A1-b2']) {
    assert.equal(isValidSegment(ok), true, JSON.stringify(ok) + ' 是合法条目 id 形状，不得误拒')
  }
  for (const bad of ['.', '..']) {
    const res = await permanentlyDeleteTrash(bad, undefined)
    assert.equal(res.ok, false, JSON.stringify(bad) + ' 不得被删除')
    assert.equal(res.code, 'error.trash.notFound', JSON.stringify(bad) + ' 应报条目不存在')
  }
})

test('记忆索引：读失败按「不可信」处理（拒写），只有文件不存在才算新用户', async () => {
  // 破了这一条的后果是**静默的数据丢失**：一次瞬时读失败（Windows 上杀软/索引器/备份软件
  // 占住会报 EACCES/EBUSY）被当成"没有索引"，紧接着任何一次写都会把空索引落盘 ——
  // 场景记录 / 档案 / 启用集合 / 每条记忆的启停排序标签备注 / 模式快照一起没（审查 P0-1）。
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-idx-'))
  const unreadable = mkdtempSync(join(tmpdir(), 'dsh-idx-'))
  try {
    const index = await readIndex(fresh)
    assert.equal(isIndexQuarantined(fresh), false, '文件不存在 = 全新用户，不隔离')
    await writeIndex(fresh, { ...index, active: ['x'] }) // 新用户路径必须还能写
    // 用同名目录制造"文件在、但读不到"（EISDIR，等价于 EACCES/EBUSY 那条路）
    mkdirSync(join(unreadable, 'memories-index.json'), { recursive: true })
    const fallback = await readIndex(unreadable)
    assert.equal(isIndexQuarantined(unreadable), true, '读失败必须判定为不可信')
    await assert.rejects(() => writeIndex(unreadable, fallback), /拒绝写入/, '不可信时写必须被拒（否则整份配置被空索引覆盖）')
  } finally {
    rmSync(fresh, { recursive: true, force: true })
    rmSync(unreadable, { recursive: true, force: true })
  }
})

// ── 0.17.0 第二批（P1 / P2 正确性与数据完整性）────────────────────────────────

test('patch 解析：insertEntryIds 扫全部 insert 子条目（重复 id 守卫不能只看 MCP 行）', () => {
  // 破了这一条的后果是 **DSH 起不来**：同 id 的两条 insert 会让插件组装失败。而守卫原先走
  // `parseRows`（只收 `name === MCP_CLIENT_MODULE` 的行），导入一条非 MCP loader 就能撞出
  // 第二条同 id 条目而守卫看不见（审查 P1-5）。
  const content = [
    '- insert:',
    '    - id: mcp-a',
    '      name: "' + MCP_CLIENT_MODULE + '"',
    '- insert:',
    '    - id: dsh-plugin-tool-management',
    '      name: "@deepseek-ai/dsh-other-loader"',
    '- id: mcp-a',
    '  disabled: true',
  ].join('\n')
  assert.deepEqual(insertEntryIds(content).sort(), ['dsh-plugin-tool-management', 'mcp-a'])
  // 顶层覆盖块不计入：它的 id 与某个 insert 相同是**正常用法**，不是重复。
  assert.equal(insertEntryIds(content).filter((x) => x === 'mcp-a').length, 1)
  assert.deepEqual(parseRows(content).rows.map((r) => r.id), ['mcp-a'], 'parseRows 仍只收 MCP 行')
})

test('patch 编辑：removeEntryAll 保留含手写 config 的覆盖块，只删纯块', () => {
  // 破了这一条的后果是**静默丢掉用户手写的配置**：补丁按 loader id 生效，用户在覆盖块里
  // 手写 config 是合法且有用的，而 `mcpm-edit` / `mcpm-remove` 会把它整块删掉（审查 P2-6）。
  const content = [
    '- id: mcp-a',
    '  name: "' + MCP_CLIENT_MODULE + '"',
    '  disabled: true',
    '- id: mcp-a',
    '  config:',
    '    serverName: hand-written',
  ].join('\n')
  const out = removeEntryAll(content, 'mcp-a')
  assert.ok(out.includes('hand-written'), '手写 config 的块必须保留')
  assert.ok(!out.includes('disabled: true'), '纯块仍要删掉（否则删服务器会留下空转的覆盖块）')
})

test('patch 解析：读不出来的 disabled 不当成显式 false', () => {
  // `!!js` 这类写法此前被算成 `disabled = false`，于是"读不出来"与"明确启用"混成一个值，
  // 覆盖块会拿它去改写当前生效值（审查 P2-6）。
  const content = '- insert:\n    - id: mcp-b\n      name: "' + MCP_CLIENT_MODULE + '"\n      disabled: !!js process.env.OFF\n'
  const row = parseRows(content).rows[0]
  assert.ok(row, 'insert 行要能解析出来')
  assert.equal(row.disabled, undefined, '读不出来的值 → undefined（不表态）')
})

test('原子写：内容完整、不留 temp、并发不产生半截文件', async () => {
  // 全局 AGENTS.md 与 scene-baseline.json 都改走它（审查 P2-2 / P2-16）：前者是宿主每步重读
  // 的文件，半截内容会直接进模型上下文；后者损坏会让「退出场景恢复 AGENTS.md」静默失效。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-'))
  try {
    const target = join(dir, 'AGENTS.md')
    await writeFileAtomically(target, 'v1')
    assert.equal(readFileSync(target, 'utf8'), 'v1')
    await Promise.all([writeFileAtomically(target, 'A'.repeat(20000)), writeFileAtomically(target, 'B'.repeat(20000))])
    const final = readFileSync(target, 'utf8')
    assert.ok(final === 'A'.repeat(20000) || final === 'B'.repeat(20000), '并发写后是完整的一份（不是交错/半截）')
    assert.deepEqual(readdirSync(dir), ['AGENTS.md'], '没有残留 temp')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 0.17.0 第三批（P2 表剩余项 + §5 F 项）────────────────────────────────────
// 同一条筛选标准：破了之后**静默**出错、且与文案/排版无关。

test('patch 生成：认不出来的超时值不得写成 NaN，0 也不得写成 0ms', () => {
  // `toolCallTimeoutMs` 从手写补丁读回来是字符串（`unquote` 只认纯数字）。此前 `Number("abc")`
  // → `NaN` 落盘，宿主读到的是一个**不是超时毫秒数**的值，而界面显示"已配置"（审查 P2-13）。
  // `0` 是界面上"没填"的读法 —— 写成 `toolCallTimeoutMs: 0` 会让每次工具调用立刻超时。
  const base = { id: 'mcp-x', serverName: 'x', transport: 'stdio', command: 'npx' }
  assert.ok(!/NaN/.test(buildInsertBlock({ ...base, toolCallTimeoutMs: 'abc' })), '字符串 "abc" 不得产生 NaN')
  assert.ok(!/toolCallTimeoutMs/.test(buildInsertBlock({ ...base, toolCallTimeoutMs: '30s' })), '"30s" 整行不写')
  assert.ok(!/toolCallTimeoutMs/.test(buildInsertBlock({ ...base, toolCallTimeoutMs: 0 })), '0 不写（= 用宿主默认）')
  assert.match(buildInsertBlock({ ...base, toolCallTimeoutMs: 30000 }), /toolCallTimeoutMs: 30000/)
})

test('patch 编辑：折叠空行不得动到块标量内部的内容（含 tag / anchor / 两种指示符顺序）', () => {
  // 破了这一条的后果是**静默改写用户手写的表达式**：块标量（`!!js |`）的内容就是换行与缩进，
  // 而 `joinLines` 每次行级编辑都会把整份文件的 3+ 连续换行折掉（审查 P2-7）。
  // 补丁照旧能读、表达式照旧能 eval，只是算出来的值变了。
  //
  // 形态必须逐个覆盖（审查 F6）：CHANGELOG 与 `blockScalarLineMask` 的注释都**点名** `!!js |`，
  // 而这条用例原来用的是**裸 `script: |`** —— 声称覆盖的形态恰好是没被覆盖的那个。
  // `|2-` 这种"缩进指示符在截断指示符之前"的写法 YAML 规范也允许。
  const wrap = (header) => [
    '- id: other-plugin',
    '  config:',
    '    script: ' + header,
    '      one',
    '',
    '',
    '',
    '      two',
    '',
    '- insert:',
    '    - id: mcp-a',
    '      name: "' + MCP_CLIENT_MODULE + '"',
  ].join('\n')
  for (const header of ['|', '!!js |', '!tag |', '&a |', '|2-', '|-2', '>', '|+', '|2']) {
    const out = removeEntryAll(wrap(header), 'mcp-a')
    const inside = out.slice(0, out.indexOf('- insert:'))
    assert.ok(/\n\n\n\n/.test(inside), '块标量 `' + header + '` 内部的连续空行必须保留')
    assert.ok(out.includes('two'), '块标量内容完好：' + header)
  }
  // 序列项形态的块标量（`- |`）同样是内容，不是排版。
  const seq = [
    '- insert:', '    - id: mcp-a', '      name: "' + MCP_CLIENT_MODULE + '"',
    '      args:', '        - |', '          a', '', '', '', '          b',
    '', '- id: mcp-b', '  disabled: true',
  ].join('\n')
  assert.ok(/\n\n\n\n/.test(removeEntryAll(seq, 'mcp-b')), '序列项块标量 `- |` 内部空行必须保留')

  // 认不出的疑似块标量头 → **整份文件不折叠**（第二道闸）。方向是不对称的：少一次排版归一化
  // 只是文件里多几个空行（肉眼可见、可再折叠），而猜错一次就静默改掉了用户写的表达式。
  const weird = ['- id: other-plugin', '  config:', '    script: !!js|', '      one', '', '', '', '      two', '', '- id: mcp-b', '  disabled: true'].join('\n')
  assert.ok(/\n\n\n\n/.test(removeEntryAll(weird, 'mcp-b')), '认不出的疑似块标量头不得让折叠动手')

  // 反向对照：块标量**之外**仍要折叠（否则反复增删会让文件积出越来越长的空行）。
  const content = wrap('!!js |')
  const out = removeEntryAll(content, 'mcp-a')
  assert.ok(!/\n\n\n/.test(out.slice(out.indexOf('- insert:'))), '块标量之外仍折叠到最多 1 个空行')
  const outside = ['- id: a', '  name: "x"', '', '', '', '', '- id: b', '  name: "y"'].join('\n')
  assert.ok(!/\n\n\n/.test(removeMarked(outside, 'nope', 'server')), '块标量之外仍折叠到最多 1 个空行')
})

test('restart 恢复：insert 行自带 disabled 的形状下，重启后必须回到重启前的生效状态', () => {
  // 破了这一条的后果是**服务器被留在停用态**：阶段 1 强制写停用、阶段 2 只把覆盖块删掉，
  // 生效值就**回落**到 insert 行自带的 `disabled: true` —— 而重启前的生效值其实是 false
  // （靠一条 enable 覆盖块启用）。重启语义是"状态与重启前一致"（审查 P2-11）。
  const eff = (c) => { const r = parseRows(c).rows.find((x) => x.id === 'mcp-a'); return r ? !!r.disabled : false }
  const base = ['- insert:', '    - id: mcp-a', '      name: "' + MCP_CLIENT_MODULE + '"', '      disabled: true'].join('\n')
  // 真实故障形状：enable 覆盖块由本插件自己写出（带标记注释，阶段 1 才删得掉）
  const start = appendBlock(base, buildDisableBlock('mcp-a', false))
  assert.equal(eff(start), false, '起点：生效值 = 启用（靠覆盖块）')
  const wasDisabled = eff(start)
  // 阶段 1
  let c = removeMarked(start, 'mcp-a', 'enable')
  c = removeMarked(c, 'mcp-a', 'disable')
  c = appendBlock(c, buildDisableBlock('mcp-a', true))
  assert.equal(eff(c), true, '阶段 1：强制停用生效')
  // 老写法（只删 disable、wasDisabled 为假时不补）会留在停用态
  assert.equal(eff(removeMarked(c, 'mcp-a', 'disable')), true, '复现：老写法会回落到 insert 行的 true')
  // 现在的写法：比较后显式补一条覆盖
  let next = removeMarked(c, 'mcp-a', 'disable')
  next = removeMarked(next, 'mcp-a', 'enable')
  if (eff(next) !== wasDisabled) next = appendBlock(next, buildDisableBlock('mcp-a', wasDisabled))
  assert.equal(eff(next), wasDisabled, '现在的写法：回到重启前的生效状态')
  // 生效值本来就对时不补（不无谓地增长补丁文件）
  const plain = ['- insert:', '    - id: mcp-a', '      name: "' + MCP_CLIENT_MODULE + '"', '      disabled: true'].join('\n')
  let same = removeMarked(appendBlock(plain, buildDisableBlock('mcp-a', true)), 'mcp-a', 'disable')
  const before = same.split('\n').length
  if (eff(same) !== true) same = appendBlock(same, buildDisableBlock('mcp-a', true))
  assert.equal(same.split('\n').length, before, '生效值本来就对时不补覆盖块')
})

test('loader 行形状：insert 子条目与顶层覆盖条目必须分开识别', () => {
  // 破了这一条的后果是**令牌功能整条不可用**：判据「本插件 loader 行出现在两份补丁里 =
  // DSH 起不来」只对 insert 条目成立，而 0.1.7 bundle 挂载下令牌的写点本来就是覆盖条目
  // —— 把覆盖条目也算成"第二份补丁"，所有令牌操作都会被拒（审查 P2-12）。
  const mixed = [
    '- insert:',
    '    - id: dsh-plugin-tool-management',
    "      name: 'dsh-plugin-tool-management'",
    '- id: dsh-plugin-tool-management',
    '  config:',
    '    token: "x"',
  ].join('\n')
  const rows = scanLoaderRows(mixed)
  assert.equal(rows.insert.length, 1, 'insert 子条目被认出')
  assert.equal(rows.override.length, 1, '顶层覆盖条目被认出（不混进 insert）')
  assert.deepEqual(scanLoaderRows('[]\n'), { insert: [], override: [] })
})

test('场景名口径：命名路径必须单段，定位路径按完整路径', () => {
  // 破了这一条的后果是**静默失效**：`a/b` 这种多段名写进 active 后，注入时桶名是 `a`、
  // active 里写的是 `a/b`，两边对不上 —— 用户看到的是"开关点了、场景没生效"，零报错。
  // 而定位路径（改名旧名 / 锁定 / 删除 / 恢复）必须容许完整路径，否则历史与导入留下的
  // 多段记录会变成"看得见、动不了"的死条目（审查 P2-4）。
  assert.equal(isValidGroupSegment('a/b'), false, '命名路径：单段谓词拒绝 a/b')
  assert.equal(isValidGroupSegment('办公'), true)
  assert.equal(isValidGroupPath('a/b'), true, '定位路径：路径谓词接受 a/b')
  assert.equal(isValidGroupPath('/a'), false)
  assert.equal(isValidGroupPath('a/'), false)
  assert.equal(isValidGroupPath('a/../b'), false, '路径谓词仍拒绝穿越')
})

test('档案切片写：只声明写的字段才动，场景档案按增量落盘', async () => {
  // 破了这一条的后果是**丢更新**：`loadSlice` 在写队列外读、`saveSlice` 在队列内写，
  // 两者之间的窗口里另一个写者改过的字段会被陈旧的整片回写抹掉（审查 P2-3）。
  const home = mkdtempSync(join(tmpdir(), 'dsh-slice-'))
  try {
    const stateDir = join(home, 'tool-management')
    const memoriesRoot = join(stateDir, 'memories')
    mkdirSync(memoriesRoot, { recursive: true })
    const svc = createMemoriesService({}, { memoriesRoot, stateDir })
    const file = join(stateDir, 'memories-index.json')
    await svc.patchIndex({ archives: { A: { skills: ['s1'] } }, active: ['A'], mode: { scene: null, snapshot: null } })
    const seed = JSON.parse(readFileSync(file, 'utf8'))
    seed.scenes = { A: { order: 1 }, B: { order: 2 } }
    writeFileSync(file, JSON.stringify(seed, null, 2))
    const read = () => JSON.parse(readFileSync(file, 'utf8'))

    const stale = await svc.readArchiveSlice()
    await svc.patchIndex({ ...stale, mode: { scene: 'A', snapshot: { mcp: {}, skills: {}, subagents: [] } } }, ['mode'])
    assert.equal(read().mode.scene, 'A', '只声明 mode 时 mode 落盘')
    assert.deepEqual(read().active, ['A'], 'active 保留（不被陈旧整片回写覆盖）')
    assert.ok(read().archives.A, 'archives 保留')

    // 两个写者各按陈旧切片保存**不同场景**的档案
    await svc.saveArchive('B', { skills: ['b-skill'] })
    await svc.saveArchive('A', { skills: ['a-skill'] })
    assert.equal(read().archives.B.skills[0], 'b-skill', '并发写别的场景不被覆盖')
    assert.equal(read().archives.A.skills[0], 'a-skill', '目标场景按增量更新')
    await svc.saveArchive('A', null)
    assert.equal(read().archives.A, undefined, 'saveArchive(scene, null) 删掉该场景的档案')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('技能上传：尾随空格的 .. 不得逃出暂存目录，正常点文件照常放行', async () => {
  // 这不是"口径分叉"，是**路径逃逸**：Windows 的路径归一化会裁掉段尾的点与空格，
  // 于是 `.. `（`..` 加空格）在 CreateFileW 眼里就是 `..`；而 `isSameOrDescendant` 只按
  // 字符串比，判不出 `.. /x` 越界（审查 P2-17）。反向那一半同样重要：技能包带
  // `.DS_Store` 是常态（macOS 解压必带），一律拒绝会让正常技能导不进来。
  const home = mkdtempSync(join(tmpdir(), 'dsh-upload-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
    const res = await importUploadedSkill({
      name: 'evil-skill',
      entries: [
        { path: 'SKILL.md', data: b64('---\nname: evil-skill\ndescription: x\n---\nbody\n') },
        { path: '.. /pwned.md', data: b64('ESCAPED') },
      ],
    }, undefined, {})
    assert.equal(res && res.ok, false, '含 ".. " 的上传必须被拒')
    const found = []
    const walk = (dir, depth) => {
      if (depth > 3 || !existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isFile() && e.name === 'pwned.md') found.push(p)
        if (e.isDirectory()) walk(p, depth + 1)
      }
    }
    walk(home, 0)
    walk(join(home, '..'), 1)
    assert.deepEqual(found, [], '暂存目录外不得落下任何文件')

    const okRes = await importUploadedSkill({
      name: 'good-skill',
      entries: [
        { path: 'SKILL.md', data: b64('---\nname: good-skill\ndescription: y\n---\nbody\n') },
        { path: '.DS_Store', data: b64('junk') },
      ],
    }, undefined, {})
    assert.notEqual(okRes && okRes.ok, false, '正常点文件（.DS_Store）不被拒')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('备份名与 peer range：两代时间戳都认、两份范围不漂移', () => {
  // 备份名：只认新格式会让**存量备份**从清单与自动剪枝里集体消失（明文密钥副本永久留盘）；
  // 只认老格式则新写的备份永远不被剪掉。两代都得认（审查 P2-5）。
  assert.equal(isPatchBackupName('cordis.patch.yml.bak-20260930-120000'), true, '老格式（到秒）')
  assert.equal(isPatchBackupName('cordis.patch.yml.bak-20260930-120000123456'), true, '新格式（毫秒 + 进程内序号）')
  assert.equal(isPatchBackupName('cordis.patch.yml.bak-20260930-12000'), false, '位数不对不误收')
  // peer range：`probe.ts` 的 EXPECTED_PEER_RANGE 与 package.json 的 peerDependencies 必须
  // 是同一个字符串 —— 漂移会让"界面/doctor 报的范围"与"安装期实际校验的范围"各说各话
  // （审查 §5 F9 / §5.4）。不带上界（`^` 隐含 `<0.3.0`，会在宿主发稳定版 0.3.0 时挡安装）。
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const ranges = Object.entries(pkg.peerDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range)
  assert.ok(ranges.length > 0, 'package.json 里应当有 dsh-* 的 peer range')
  for (const range of ranges) assert.equal(range, EXPECTED_PEER_RANGE)
  assert.ok(!EXPECTED_PEER_RANGE.includes('^'), '范围不得带 caret 上界')
})

test('MCP 工具名前缀只有一处定义', () => {
  // 前缀是宿主侧的字符串契约，插件里十余处按它拼/按它解析。破了这一条（有人又写死一份
  // mcp__ 字面量）就会在官方改前缀时漏改，而守卫会**静默放行**（审查 §5 F6）。
  assert.equal(MCP_TOOL_PREFIX, 'mcp__')
  const files = ['mcp/manager.ts', 'mcp/patch-yaml.ts', 'index.ts', 'ops/compat.ts', 'scenes/candidates.ts']
  for (const rel of files) {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', rel), 'utf8')
    // 允许出现在注释里（解释契约用），不允许出现在**字符串字面量**里。
    const codeOnly = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!codeOnly.includes("'mcp__'"), rel + ' 里不得再写死 mcp__ 字面量（应引用 MCP_TOOL_PREFIX）')
    assert.ok(!codeOnly.includes('"mcp__"'), rel + ' 里不得再写死 mcp__ 字面量（应引用 MCP_TOOL_PREFIX）')
  }
})

test('前缀漂移的证据判据：本插件自己的工具名不算证据', () => {
  // 这条判据存在的唯一理由是**避免误报**：本插件的工具叫 `mcp_manager_list` 之类，
  // 同样「以 mcp 开头但不是 mcp__」—— 不排除它们，兼容页会在每台机器上报一条错的诊断
  // （"官方可能改了前缀"），只要当前没有 MCP 服务器在跑就成立。
  for (const own of ['mcp_manager_list', 'mcp_manager_save', 'mcp_manager_inspect', 'mcp_anything']) {
    assert.equal(looksLikeMcpPrefixDrift(own), false, own + ' 是本插件自己的工具名，不得算证据')
  }
  for (const foreign of ['mcp:github:search', 'mcp-github-search', 'mcpX']) {
    assert.equal(looksLikeMcpPrefixDrift(foreign), true, foreign + ' 是"词根后换了分隔符"的形态，应算证据')
  }
  // 光一个 `mcp` 不算：判据要求"词根 + 一个非下划线字符"，而一个工具名不可能是孤零零的词根
  // （它是 `<前缀><服务器>__<工具>` 的形状）。放宽到"只要求 mcp 词根"会重新引入误报面。
  assert.equal(looksLikeMcpPrefixDrift('mcp'), false)
  // 认的前缀本身当然不算证据（否则上报永远触发）。
  assert.equal(looksLikeMcpPrefixDrift(MCP_TOOL_PREFIX + 'github__search'), false)
  assert.equal(looksLikeMcpPrefixDrift('read_file'), false)
  assert.equal(looksLikeMcpPrefixDrift(''), false)
})

// ── 0.17.0 第四批：注入域的「读失败 ≠ 没有内容」（审查 F7）─────────────────────
//
// 这一批只钉**判据**：注入通道只认抛异常（见 `selectInjections` 的 `onError`），所以域的
// `text()` 实现必须把"读失败"与"真的空"分开。夹具用「拿目录占住文件/目录的位置」制造
// 非 ENOENT 的 IO 失败（Windows 上 `chmod 000` 无效，本仓既有做法即此）：
//   `readdirSync(文件)` → ENOTDIR   `readFileSync(目录)` → EISDIR
// 两者都不是 ENOENT，正是"读失败"那一类；路径**不存在**才是 ENOENT（全新用户）。

test('注入域取数：读失败必须抛，路径不存在仍返回空串（假「已清空」的根因）', () => {
  // 破了这一条的后果是**对模型说谎**：注入通道把空串读成"这一轮没内容"，在该域此前发布过时
  // 发一条「已清空 —— 此前注入的同类内容不再有效」。第一版修复只覆盖了"抛异常"那一半，
  // 而真实世界里的 IO 失败走的正是 `catch → return ''` 这条路（审查 F7）。
  const root = mkdtempSync(join(tmpdir(), 'dsh-f7-'))
  const stateDir = join(root, 'tool-management')
  const memoriesRoot = join(stateDir, 'memories')
  try {
    // ① 正常态：有内容
    mkdirSync(join(memoriesRoot, 'global'), { recursive: true })
    writeFileSync(join(memoriesRoot, 'global', 'note.md'), '---\nname: note\n---\n\n正文甲\n')
    writeFileSync(join(stateDir, 'memories-index.json'), JSON.stringify({ version: 1, rules: {}, groups: {} }))
    const svc = createMemoriesService({}, { memoriesRoot, stateDir })
    const good = svc.memoryText()
    assert.ok(good.includes('正文甲'), '正常态应读到记忆正文')

    // ② memories 根被一个**文件**占住 → ENOTDIR（非 ENOENT）→ 必须抛
    rmSync(memoriesRoot, { recursive: true, force: true })
    writeFileSync(memoriesRoot, 'not a dir')
    assert.throws(() => svc.memoryText(), /ENOTDIR/, '记忆目录读不动 → 抛（不发假「已清空」）')
    assert.throws(() => svc.sceneCatalogText(), /ENOTDIR/, '场景目录读不动 → 抛')

    // ③ 恢复可读 → 上一轮内容没被覆盖，自动回到原值
    rmSync(memoriesRoot, { force: true })
    mkdirSync(join(memoriesRoot, 'global'), { recursive: true })
    writeFileSync(join(memoriesRoot, 'global', 'note.md'), '---\nname: note\n---\n\n正文甲\n')
    assert.equal(svc.memoryText(), good, '恢复可读后逐字节回到原值（期间没把缓存写成空）')

    // ④ 索引被一个**目录**占住 → EISDIR → 不可信 → 抛（不能把"全部未启用"当成"用户清空了"）
    const idxHome = join(root, 'idx')
    mkdirSync(join(idxHome, 'memories-index.json'), { recursive: true })
    const idxSvc = createMemoriesService({}, {
      globalAgentsMdPath: () => join(idxHome, 'AGENTS.md'),
      memoriesRoot: join(idxHome, 'memories'),
      stateDir: idxHome,
    })
    assert.throws(() => idxSvc.memoryText(), /索引/, '索引读不到 → 抛')
    assert.throws(() => idxSvc.promptText(), /索引/, '索引读不到 → 提示词域也抛（无从得知绑了哪份预设）')

    // ⑤ 预设正文被一个**目录**占住 → 抛（不能静默退回"没有提示词"）
    const pState = join(root, 'preset')
    mkdirSync(join(pState, 'prompts', 'p1', 'AGENTS.md'), { recursive: true })
    writeFileSync(join(pState, 'memories-index.json'), JSON.stringify({
      version: 1, rules: {}, groups: {}, scenes: { global: { order: 0, prompt: 'p1' } },
    }))
    const pSvc = createMemoriesService({}, {
      globalAgentsMdPath: () => join(pState, 'AGENTS.md'),
      memoriesRoot: join(pState, 'memories'),
      stateDir: pState,
    })
    assert.throws(() => pSvc.promptText(), /不是一个文件/, '预设正文读不动 → 抛')

    // ⑥ 反向：路径**不存在** = 全新用户 → 空串、不抛（R2：别把"正常空"变成 error）
    const freshHome = join(root, 'fresh')
    const fresh = createMemoriesService({}, {
      globalAgentsMdPath: () => join(freshHome, 'AGENTS.md'),
      memoriesRoot: join(freshHome, 'tool-management', 'memories'),
      stateDir: join(freshHome, 'tool-management'),
    })
    assert.equal(fresh.memoryText(), '', '全新用户：记忆域空串、不抛')
    assert.equal(fresh.sceneCatalogText(), '', '全新用户：场景域空串、不抛')
    assert.equal(fresh.promptText(), '', '全新用户：提示词域空串、不抛')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('注入域取数失败 → 通道报 error 且该域不进「已清空」那条路', () => {
  // 上一条钉的是**判据**（谁该抛），这一条钉的是**两半接得上**：抛出去的异常必须真的变成
  // `onError` → `failedKeys` → 实况 `error`。两半任缺一半，修复都不成立（F7 的原文即此）。
  const domains = [
    { key: 'memory', name: 'm', label: '记忆', form: 'snapshot', text: () => { throw new Error('ENOTDIR') } },
    // 好域用 `mcp`：提示词 / 技能目录有官方载体，`facts` 缺省时会被判成"官方在送"而不进列表。
    { key: 'mcp', name: 'c', label: 'MCP', form: 'catalog', text: () => 'OK' },
  ]
  const failed = new Set()
  const out = selectInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {}, (key) => failed.add(key))
  assert.deepEqual(out.map((s) => s.key), ['mcp'], '取数失败的域跳过，其余照发')
  assert.deepEqual([...failed], ['memory'], '失败必须经 onError 报出去（`createContextInjector` 据此跳过「已清空」）')
  assert.equal(explainInjections(domains, DEFAULT_INJECT_SETTINGS, undefined, {}, failed).memory, 'error', '实况报故障，不是「无内容」')
  // 反向：返回空串（不抛）仍是 `empty` —— 那是"本来就没有"，不该被报成故障。
  const emptyDomains = [
    { key: 'memory', name: 'm', label: '记忆', form: 'snapshot', text: () => '' },
  ]
  const noneFailed = new Set()
  selectInjections(emptyDomains, DEFAULT_INJECT_SETTINGS, undefined, {}, (key) => noneFailed.add(key))
  assert.equal(noneFailed.size, 0, '空串不算失败（否则全新用户每轮都报琥珀）')
  assert.equal(explainInjections(emptyDomains, DEFAULT_INJECT_SETTINGS, undefined, {}, noneFailed).memory, 'empty')
})

test('URL 打码必须覆盖 userinfo / 片段，且打码值在任何写路径都进不去补丁', () => {
  // 破了这一条的后果是**凭据外泄 + 反向数据丢失**（审查 F5 / F4）：
  //   `new URL()` 把 userinfo 与 fragment 存在 `username/password` 与 `hash` 里，只替换 `search`
  //   的话 `https://user:pass@host/mcp`（Basic-Auth，MCP 托管服务真实存在的形态）与
  //   `https://host/mcp#access_token=…`（连 `?` 都没有）会**整条原样返回** —— 而这两条路正是
  //   免令牌出口（mcpm-list / mcpm-inspect / 模型工具 / 快照导出）。
  const userinfo = maskUrlQuery('https://user:pass@host/mcp')
  assert.ok(!userinfo.includes('pass'), 'userinfo 里的口令不得留在打码结果里')
  assert.ok(userinfo.startsWith('https://') && userinfo.includes('@host/mcp'), '主机与路径要保留（它是该服务的身份）')
  assert.equal(isMaskedUrl(userinfo), true, 'userinfo 打码结果必须认得出')
  const frag = maskUrlQuery('https://host/mcp#access_token=abc')
  assert.ok(!frag.includes('abc'), '片段里的令牌不得留在打码结果里')
  assert.equal(isMaskedUrl(frag), true, '片段打码结果必须认得出')
  // 非绝对 / 协议相对地址的兜底分支同样要覆盖这三处（少了它，"打码"会变成反向数据丢失）。
  assert.equal(isMaskedUrl(maskUrlQuery('//user:pass@host/mcp')), true)
  assert.equal(isMaskedUrl(maskUrlQuery('/api#token=x')), true)
  // 反向：真地址不得被误判（判错的方向是丢真配置）。
  for (const real of ['https://host/mcp', 'https://host/mcp?a=b', 'https://host/mcp?a=b#c', 'https://user@host/mcp']) {
    assert.equal(isMaskedUrl(real), false, real + ' 是真地址，不得误判成打码值')
  }

  // 收敛方向：有旧真值就顶替；没有就**拒绝**（URL 不是可丢的键值对 —— 丢掉查询串等于写下一个
  // "能连上但鉴权失败"的地址，界面与用户都会以为配置还完好）。
  assert.deepEqual(resolveMaskedUrl(maskUrlQuery('https://host/mcp?k=v'), 'https://host/mcp?k=v'), { value: 'https://host/mcp?k=v', restored: true, unrecoverable: false })
  assert.equal(resolveMaskedUrl(maskUrlQuery('https://host/mcp?k=v'), null).unrecoverable, true)

  // 结构性兜底：`buildInsertBlock` 是所有 MCP 写路径的**唯一** YAML 出口。断言此前只查
  // env / headers（注释自己写着"URL 的打码是另一套……不在这里"），于是 mcpm-add / mcpm-import
  // 两条写路径都没有 `resolveMaskedUrl`，打码 URL 会原样落盘**且不产生任何 warning**（F4）。
  const httpRow = (url) => ({ id: 'x', serverName: 'x', transport: 'streamable-http', url })
  assert.throws(() => buildInsertBlock(httpRow(maskUrlQuery('https://host/mcp?k=v'))), /打码形态/, '查询串形态必须被拦下')
  assert.throws(() => buildInsertBlock(httpRow(maskUrlQuery('https://u:p@host/mcp'))), /打码形态/, 'userinfo 形态必须被拦下')
  assert.throws(() => buildInsertBlock(httpRow(maskUrlQuery('https://host/mcp#t=1'))), /打码形态/, '片段形态必须被拦下')
  assert.ok(buildInsertBlock(httpRow('https://host/mcp?k=v')).includes('k=v'), '真 URL 照旧写入')
})

// ── 0.17.0 第五批：同名首选必须同时作用于界面与模型（审查 F8）────────────────
//
// 这一条钉的是**两侧同源**：管理页挑赢家用 `groupLoadableSkillsByName(items, preferred)`，
// 模型侧 provider（`listProviderCandidates`）此前调同一个函数时**漏传 `preferred`**，
// 于是「同名首选」只在界面上生效 —— 用户把 A 设为首选，界面把 A 标成「同名首选」、
// 把 B 标成「被覆盖」，模型侧却仍按 rank 拿到 B。**界面说的和模型用的不是同一份，且无人报错。**
//
// 夹具：hub（rank 350）与 dsh（rank 400）各放一份声明名同为 `demo` 的技能。
// 不设首选时 rank 高的赢；设了首选后两侧都必须换成首选来源。
// 破了这一条的后果是静默的：界面全绿、模型拿错正文，用户没有任何线索。

test('同名首选：界面赢家与 provider 赢家必须是同一份（含首选来源被停用时）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-f8-'))
  const prev = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
    DSH_CODEX_HOME: process.env.DSH_CODEX_HOME,
    DSH_CLAUDE_HOME: process.env.DSH_CLAUDE_HOME,
  }
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(home, '.agents')
  process.env.DSH_CODEX_HOME = join(home, '.codex')
  process.env.DSH_CLAUDE_HOME = join(home, '.claude')
  try {
    const put = (rootDir, body) => {
      mkdirSync(join(rootDir, 'demo'), { recursive: true })
      writeFileSync(join(rootDir, 'demo', 'SKILL.md'), `---\nname: demo\ndescription: ${body}\n---\n\n${body}\n`)
    }
    const hubDir = join(home, 'tool-management', 'skills')
    const dshDir = join(home, 'skills')
    mkdirSync(hubDir, { recursive: true })
    mkdirSync(dshDir, { recursive: true })
    put(hubDir, 'hub 副本')
    put(dshDir, 'dsh 副本')

    // 两侧各问一次「demo 是谁」，必须给同一个答案。
    const bothWinners = async () => {
      const snapshot = await state({ projectCwds: [] })
      const rows = snapshot.roots.flatMap((r) => r.skills.map((s) => ({ root: r.key, s })))
      const catalog = rows.find((x) => x.s.declaredName === 'demo' && x.s.winner === true)
      const provider = (await listProviderCandidates({})).find((c) => c.name === 'demo')
      return { catalog, provider, rows }
    }

    const before = await bothWinners()
    assert.ok(before.catalog, '界面必须挑出一个赢家')
    assert.equal(before.provider.locator.rootKey, before.catalog.root, '无首选时两侧赢家同源')
    const rankWinner = before.catalog.root

    // 首选另一份（rank 更低的那个），两侧必须一起改口。
    const other = rankWinner === 'dsh' ? 'hub' : 'dsh'
    const target = userRoots().find((r) => r.key === other)
    const res = await setPreferredSkill(target, 'demo', true, undefined)
    assert.equal(res.root, other, '首选应写入成功')

    const after = await bothWinners()
    assert.equal(after.catalog.root, other, '界面赢家应换成首选来源')
    assert.equal(after.provider.locator.rootKey, other, 'provider 赢家必须一起换成首选来源（F8 核心）')
    assert.equal(after.catalog.s.preferred, true, '界面要自报这是显式选择')
    assert.equal(
      after.rows.find((x) => x.root === rankWinner).s.shadowedBy.enabled,
      true,
      '被覆盖行要带上赢家的启用状态（赢家启用 → true）',
    )

    // 首选来源自己停用：它照样赢（停用不参与选赢家），但两份都不生效 ——
    // 界面必须能说出这件事，所以被覆盖行要拿到 `shadowedBy.enabled === false`。
    await setSkillEnabled(target, 'demo', false, undefined)
    const disabled = await bothWinners()
    assert.equal(disabled.catalog.root, other, '停用不参与选赢家，首选来源仍赢')
    assert.equal(disabled.catalog.s.enabled, false, '赢家自己停用 → 不生效')
    assert.equal(
      disabled.rows.find((x) => x.root === rankWinner).s.shadowedBy.enabled,
      false,
      '被覆盖行必须知道赢家已停用（否则界面会说「同名技能 X 正在生效」——那是假话）',
    )
    assert.equal(disabled.provider.locator.rootKey, other, '两侧仍必须同源')

    // 写操作只记录选择、不启停任何东西，所以照旧成功；但回执必须自报「不会生效」。
    const warn = await setPreferredSkill(target, 'demo', true, undefined)
    assert.equal(warn.effective, false, '首选停用来源 → 回执要说清楚不会生效')
    assert.match(String(warn.warning), /两份都不生效/, '并给出可读的原因')
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 0.17.0 第六批：「只能删已归档」必须是**不变量**（审查 F9 / F10）────────────
//
// 这一条钉的不是实现细节，是一条安全性质：**任何一条删除路径都不得永久删除未归档的会话**。
// 它此前在两个地方不成立 ——
//   F9：单删的判据取的是**有损投影** `archivedSessionMetadata().items`（读不到头部的条目被
//       静默跳过），于是一个**确实已归档**、只是头部暂时读不到的会话被判「未归档」，回一句
//       「请先归档，再删除」——诊断是错的（真因是读失败）；而批量路径用权威集合能删，
//       同一份数据两条路给出相反结论。
//   F10：级联删除（`deleteDescendants`）只按 `parentSession + origin: subagent` 收集就删，
//       **完全不查归档集合**。删一个已归档父会话，会把它**未归档**的子代理会话一起永久删掉；
//       op 入口那层的收敛拦不住 —— 级联发生在删除主体内部，不经过任何 op 门禁。
//
// 判据统一到 `requireState().archivedSessionIds`（权威集合，宿主契约由 compat 探针核对）。

const archiveOpsDeps = (registry) => ({
  getSessionsRegistry: () => registry,
  message: (e) => String((e && e.message) || e),
  readHistoryRetention: async () => ({ retentionDays: 30 }),
  writeHistoryRetention: async () => {},
  sweepHistory: async () => undefined,
  buildHistoryGroups: async () => ({ groups: [], workspaces: [] }),
  restoreWorkspaceAccounting: async () => undefined,
  parseHistoryBatchTarget: (t) => ({ ok: true, target: t }),
  host: () => undefined,
  promptsDir: '.',
  rulesList: async () => ({}),
  skillDetail: async () => ({}),
  extractTurnsFromEvents: () => [],
  serializeTurns: () => '',
})

/** 造一个只实现删除相关面的 registry。`headerReadable: false` 模拟「已归档但头部读不到」：
 * 权威集合里有这条，有损投影里没有 —— 正是 F9 的分歧点。 */
const fakeArchiveRegistry = ({ archivedIds, headerReadable }) => {
  const deleted = []
  return {
    deleted,
    requireState: () => ({ workspaceIds: [], archivedSessionIds: [...archivedIds] }),
    archivedSessionMetadata: async () => ({
      items: headerReadable ? archivedIds.map((id) => ({ sessionId: id, createdAt: 1 })) : [],
    }),
    deleteSession: async (id) => { deleted.push(id); return { deleted: true } },
    archiveSession: async () => {},
    unarchiveSession: async () => ({ archivedSessionIds: [] }),
    deleteArchivedSessions: async () => ({ requestedSessionIds: [], deletedSessionIds: [], skippedSessionIds: [], failures: [] }),
  }
}

test('单删的归档判据取权威集合，不是有损投影（F9）', async () => {
  // ① 已归档 + 头部读不到 → 允许删除（不得误报「未归档」）
  const ok = fakeArchiveRegistry({ archivedIds: ['s1'], headerReadable: false })
  const okRes = await buildSessionOps(archiveOpsDeps(ok))['history-delete']({ sessionId: 's1' })
  assert.equal(okRes.ok, true, '已归档的会话必须能删（投影丢了它不等于它没归档）')
  assert.deepEqual(ok.deleted, ['s1'], '且确实执行了删除')

  // ② 真未归档 → 拒绝（收敛方向不能被削弱）
  const no = fakeArchiveRegistry({ archivedIds: ['s1'], headerReadable: false })
  const noRes = await buildSessionOps(archiveOpsDeps(no))['history-delete']({ sessionId: 'other' })
  assert.equal(noRes.ok, false, '真未归档必须拒绝')
  assert.deepEqual(no.deleted, [], '拒绝时不得动删除')

  // ③ 归档状态读不到 → 拒绝（fail-closed），且文案指向真因
  const broken = fakeArchiveRegistry({ archivedIds: ['s1'], headerReadable: true })
  broken.requireState = () => { throw new Error('state unavailable') }
  const brokenRes = await buildSessionOps(archiveOpsDeps(broken))['history-delete']({ sessionId: 's1' })
  assert.equal(brokenRes.ok, false, '状态未知时宁可删不掉')
  assert.match(String(brokenRes.error), /无法确认会话的归档状态/, '文案要说明是状态读不到')

  // ④ 旧宿主（无 requireState）→ 退回投影，方向仍是 fail-closed（投影只会更小）
  const legacy = fakeArchiveRegistry({ archivedIds: ['s1'], headerReadable: false })
  delete legacy.requireState
  const legacyRes = await buildSessionOps(archiveOpsDeps(legacy))['history-delete']({ sessionId: 's1' })
  assert.equal(legacyRes.ok, false, '旧宿主上宁可不删')

  // ⑤ 被保留的未归档子会话要出现在回执里（界面/模型据此知道「这一支没有全没」）
  const keptRegistry = fakeArchiveRegistry({ archivedIds: ['s1'], headerReadable: true })
  keptRegistry.deleteSession = async () => ({ deleted: true, keptUnarchivedDescendants: ['c1'] })
  const keptRes = await buildSessionOps(archiveOpsDeps(keptRegistry))['history-delete']({ sessionId: 's1' })
  assert.deepEqual(keptRes.keptUnarchivedDescendants, ['c1'])
})

/** 驱动 `deleteDescendants` 的判据：它只用到几个可替换的方法，替换掉即可隔离行为，
 * 不必立起整个注册表。`stateThrows` 用来模拟「归档集合读不到」。 */
const cascadeHarness = ({ children, stored, archivedIds, stateThrows = false }) => {
  const proto = ArchiveWorkspaceRegistry.prototype
  const fake = Object.create(proto)
  const deleted = []
  const logs = []
  fake.ctx = {
    get: (name) => (name === 'sessions' ? { list: () => children } : undefined),
    logger: { warn: (...args) => logs.push(args.join(' ')) },
  }
  fake.requireState = () => {
    if (stateThrows) throw new Error('state unavailable')
    return { workspaceIds: [], archivedSessionIds: [...archivedIds] }
  }
  fake.listStoredHeaders = async () => stored
  fake.sessionKnown = async () => true
  fake.deleteSessionCore = async (id) => { deleted.push(id); return { deleted: true } }
  return { deleted, logs, run: (id) => proto.deleteDescendants.call(fake, id) }
}
const subagentHeader = (id, parent) => ({ id, parentSession: parent, origin: 'subagent' })

test('级联删除只吃已归档的子会话，未归档的一律保留（F10）', async () => {
  // ① 只删已归档的；未归档的保留并回传
  const mixed = cascadeHarness({
    children: [{ id: 'c-live', header: subagentHeader('c-live', 'p') }],
    stored: [subagentHeader('c-arch', 'p'), subagentHeader('c-live', 'p')],
    archivedIds: ['p', 'c-arch'],
  })
  const kept = await mixed.run('p')
  assert.deepEqual(mixed.deleted, ['c-arch'], '未归档的子会话绝不能被级联删掉')
  assert.deepEqual(kept, ['c-live'], '被保留的 id 要回给调用方')
  assert.ok(mixed.logs.some((l) => /unarchived subagent/.test(l)), '保留这件事必须留痕')

  // ② 全部已归档 → 全删，且没有保留
  const all = cascadeHarness({
    children: [{ id: 'c1', header: subagentHeader('c1', 'p') }],
    stored: [subagentHeader('c1', 'p'), subagentHeader('c2', 'p')],
    archivedIds: ['p', 'c1', 'c2'],
  })
  const allKept = await all.run('p')
  assert.deepEqual([...all.deleted].sort(), ['c1', 'c2'])
  assert.deepEqual(allKept, [])

  // ③ 归档集合读不到 → 一个都不删（fail-closed：不能凭未知状态做不可逆操作）
  const blind = cascadeHarness({
    children: [{ id: 'c1', header: subagentHeader('c1', 'p') }],
    stored: [subagentHeader('c1', 'p')],
    archivedIds: ['p', 'c1'],
    stateThrows: true,
  })
  await blind.run('p')
  assert.deepEqual(blind.deleted, [], '归档集合读不到时一个都不删')
  assert.ok(blind.logs.some((l) => /descendant enumeration/.test(l)), '且要上报枚举失败')

  // ④ fork 分支（非 subagent）不参与级联 —— 既有约束不得回退
  const fork = cascadeHarness({
    children: [{ id: 'fork', header: { id: 'fork', parentSession: 'p', origin: 'user' } }],
    stored: [{ id: 'fork', parentSession: 'p', origin: 'user' }],
    archivedIds: ['p', 'fork'],
  })
  await fork.run('p')
  assert.deepEqual(fork.deleted, [], 'fork 分支是独立用户会话，绝不能被级联删除')
})

// ── 0.17.0 第七批：P2 四条（F11–F14）─────────────────────────────────────────
//
// 这一批的共同性质是**失败必须可见、且可重试**：
//   F11 记忆回收站恢复失败没有回滚 → 目标留半份内容、回收站条目仍在 → 下次恢复撞
//       「同名记忆已存在」→ 这条记忆**永远恢复不了**，只能人工去删目录。
//       （CHANGELOG 早就声明「恢复失败时把已放回的文件退回回收站」，但那条回滚只实现在
//        场景回收站，记忆回收站这一条缺了。）
//   F12 `.txt` 无条件按 generic 解析 → 改名成 `transcript.txt` 的 JSONL 被整份折成**一条**
//       user 消息、结构全失、零警告，op 还回 `{ok:true,count:1}`。
//   F13 提示词「被引用」探测失败即放行删除 → 删掉场景绑定的那一份，场景驱动静默失效，
//       而 AGENTS.md 停在场景态。
//   F14 场景基线写失败被吞 → AGENTS.md 已切进场景态但**退不回来**，用户看到的是
//       「没场景驱动所以什么都没做」。

test('`.txt` 按内容嗅探，不再一律当纯文本（F12）', () => {
  const jsonl = [
    JSON.stringify({ type: 'summary', summary: '摘要' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '在的' } }),
  ].join('\n')
  // `.txt` 是最常被改名的扩展名（客户端拿不到文件名时自己就默认 transcript.txt）
  assert.equal(detectFormat('transcript.txt', jsonl), 'jsonl', '改名 .txt 的 JSONL 必须被嗅探出来')
  assert.equal(detectFormat('transcript.txt', '## User\n\n你好\n\n## Assistant\n\n在的\n'), 'markdown')
  // 反向：真的纯文本不得被误判（判错的方向是把普通文本按 JSONL 解析）
  assert.equal(detectFormat('transcript.txt', '第一行\n第二行\n第三行\n'), 'generic')
  // 显式扩展名仍直判，不受嗅探影响
  assert.equal(detectFormat('x.jsonl', '第一行\n'), 'jsonl')
  assert.equal(detectFormat('x.md', '第一行\n'), 'markdown')
  // 嗅探只看前几行：JSON 行落在窗口之外不误判（窗口大小见 sniffFormat）
  assert.equal(detectFormat('x.txt', '一\n二\n三\n四\n五\n' + JSON.stringify({ role: 'user', content: 'x' })), 'generic')
})

test('记忆回收站恢复失败必须回滚，且回收站条目仍在（F11）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-f11-'))
  const stateDir = join(root, 'tool-management')
  const memoriesRoot = join(stateDir, 'memories')
  const group = '办公'
  const name = '笔记'
  const trashId = '20260930-abc123'
  const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
  try {
    const reset = () => {
      rmSync(memoriesRoot, { recursive: true, force: true })
      mkdirSync(memoriesRoot, { recursive: true })
    }
    const makeTrash = (form) => {
      rmSync(trashDir, { recursive: true, force: true })
      mkdirSync(trashDir, { recursive: true })
      writeFileSync(join(trashDir, 'manifest.json'), JSON.stringify({ group, name, form, deletedAt: '2026-09-30T00:00:00.000Z' }))
      if (form === 'bundle') {
        mkdirSync(join(trashDir, 'bundle'), { recursive: true })
        writeFileSync(join(trashDir, 'bundle', bundleDocName(name)), '正文')
      } else writeFileSync(join(trashDir, 'rule.md'), '正文')
    }
    const ops = buildTrashOps({
      stateDir, memoriesRoot, scenesRoot: join(stateDir, 'scenes'), maxBytes: 1024,
      snapshot: async () => ({}), invalidateSnapshot: () => {}, sceneMemory: () => ({}), scenePrompt: () => ({}),
      parseId: (id) => { const i = id.lastIndexOf('/'); return i < 0 ? { group: '', name: id } : { group: id.slice(0, i), name: id.slice(i + 1) } },
      locateRule: async (g, n) => {
        for (const cand of [bundleDocName(n), LEGACY_BUNDLE_DOC]) {
          const p = join(memoriesRoot, g, n, cand)
          if (existsSync(p)) return { id: `${g}/${n}`, group: g, name: n, kind: 'bundle', docPath: p, entryPath: join(memoriesRoot, g, n) }
        }
        const flat = join(memoriesRoot, g, n + '.md')
        return existsSync(flat) ? { id: g ? `${g}/${n}` : n, group: g, name: n, kind: 'flat', docPath: flat, entryPath: flat } : null
      },
      refuseOutsideRoot: async () => null,
      buildProjected: async (id) => ({ id }),
      sceneRows: () => [], copyIntoMemoriesTrash: async () => 'x', listAttachments: async () => [],
      serializeRuleFile: () => '', serializeUpdatedFile: () => '', ensureLayout: async () => {}, presetExistsSync: () => false,
    })

    // ① bundle：落点被一个**文件**占住 → cp 失败。locateRule 认不出它（既非 bundle 也非 flat），
    //    所以能走到复制这一步 —— 这正是真实世界里「上次恢复留了半份」的形状。
    reset()
    makeTrash('bundle')
    const groupDir = join(memoriesRoot, group)
    mkdirSync(groupDir, { recursive: true })
    const target = join(groupDir, name)
    writeFileSync(target, '半份内容')
    const first = await ops.rulesRestore({ trashId })
    assert.equal(first.ok, false, '复制失败要回失败，不是把异常抛给调用方')
    assert.match(String(first.error), /回收站条目仍在/, '文案要说清可以直接重试')
    assert.equal(existsSync(target), false, '半份落点必须被清掉，否则下次恢复撞「同名记忆已存在」')
    assert.ok(existsSync(join(trashDir, 'manifest.json')), '回收站条目不能被删（删了就没得重试了）')
    rmSync(target, { force: true })
    assert.equal((await ops.rulesRestore({ trashId })).ok, true, '排除障碍后必须能恢复（这正是「永远恢复不了」要消掉的状态）')

    // ② flat：回收站里没有正文 → copyFile 失败 → 同样不得留下半份、不得删条目
    reset()
    makeTrash('flat')
    rmSync(join(trashDir, 'rule.md'), { force: true })
    const second = await ops.rulesRestore({ trashId })
    assert.equal(second.ok, false)
    assert.equal(existsSync(join(memoriesRoot, group, name + '.md')), false, 'flat 落点不得有残留')
    assert.ok(existsSync(join(trashDir, 'manifest.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提示词引用探测失败 → 拒绝删除，且文案指向「探测失败」（F13）', async () => {
  const build = (refsValue) => {
    const removed = []
    const deps = {
      promptsService: {
        remove: async (id) => { removed.push(id); return { ok: true, id } },
        getCurrent: async () => ({ ok: true, content: '', presetId: null, exists: false }),
        apply: async (id) => ({ ok: true, id, backedUp: true }),
        restore: async () => ({ ok: true, backedUp: true }),
        importPreset: async () => ({ ok: true }), trashList: async () => ({ ok: true, entries: [] }),
        trashRestore: async () => ({ ok: true }), trashDelete: async () => ({ ok: true }),
      },
      scenePromptSync: { refs: async () => refsValue, withSync: async (r) => r, state: async () => null, driver: async () => null, sync: async () => ({}) },
      rulesOps: { 'rules-list': async () => ({ ok: true }), 'rules-rebind-prompt': async () => ({ ok: true }) },
      applyPresetGuarded: async () => ({ ok: true }),
      withAgentsMdSync: async (r) => r,
      promptRefReason: (ref) => String((ref && ref.label) || (ref && ref.kind) || ''),
      warn: () => {},
    }
    return { removed, ops: buildPromptOps(deps) }
  }

  // `refs()` 返回 null 只代表**三类探测里至少一类读盘失败**（全新环境没有场景时返回的是空表），
  // 所以拒绝不会堵住正常路径。放行则会删掉场景绑定的那一份 → 场景驱动静默失效。
  const blind = build(null)
  const refused = await blind.ops['agentsmd-remove']({ id: 'p1' })
  assert.equal(refused.ok, false, '探测失败必须拒绝删除')
  assert.equal(refused.code, 'error.agentsMd.refProbeFailed', '拒绝码要区分「探测失败」与「有引用」')
  assert.deepEqual(blind.removed, [], '拒绝时绝不能真的删')

  // 反向：有引用照旧拒绝（原行为不变）；无引用照旧放行
  const referenced = build(new Map([['p1', [{ kind: 'scene', scene: 's', label: 's', active: true }]]]))
  assert.equal((await referenced.ops['agentsmd-remove']({ id: 'p1' })).code, 'error.agentsMd.referenced')
  assert.deepEqual(referenced.removed, [])
  const clean = build(new Map())
  assert.equal((await clean.ops['agentsmd-remove']({ id: 'p1' })).ok, true)
  assert.deepEqual(clean.removed, ['p1'])
})

test('场景基线写失败必须上报，且与「AGENTS.md 未写入」分开（F14）', async () => {
  const syncDeps = (baselineFile) => ({
    prompts: {
      apply: async (id) => ({ ok: true, id, backedUp: true }),
      restore: async () => ({ ok: true, backedUp: true }),
      getCurrent: async () => ({ ok: true, content: '原基线', presetId: null, exists: true }),
    },
    rules: { ops: { 'rules-list': async () => ({ ok: true, scenePrompt: { scene: 's1', presetId: 'p1' } }) } },
    baselineFile,
    logger: { warn: () => {} },
  })

  // ① 基线写不进去（把 baselineFile 指到一个**目录**上）→ 场景照旧进入，但必须带出「没有退路」
  const root = mkdtempSync(join(tmpdir(), 'dsh-f14-'))
  try {
    const blocked = join(root, 'baseline.json')
    mkdirSync(blocked, { recursive: true })
    const res = await createScenePromptSync(syncDeps(blocked)).sync()
    assert.equal(res.applied, 'p1', '场景该进还是要进（那是用户的要求）')
    assert.equal(res.error, undefined, 'AGENTS.md 是写成了的 —— 不能把「已切进场景」说成「未写入」')
    assert.ok(typeof res.baselineError === 'string' && res.baselineError.length > 0, '「没有退路」必须单独说出来')
    assert.match(String(res.baselineError), /恢复不回原来的内容/, '文案要讲清后果')

    // ② 反向：能正常写时不得出现 baselineError
    const healthy = await createScenePromptSync(syncDeps(join(root, 'ok.json'))).sync()
    assert.equal(healthy.baselineError, undefined)
    assert.ok(existsSync(join(root, 'ok.json')), '基线要确实落盘')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MCP 全名的切分只有一套规则：执行侧守卫与界面键必须同源（N1）', () => {
  // 形态甲：**工具名含 `__`**。0.16.7 那版显示侧取「最后一个 `__`」（切出 srv__a / b），
  // 守卫取「最长已知 serverName 前缀」（切出 srv / a__b）—— 同一份数据两边结论不同，
  // 于是界面上的勾选落不到停用表里那条键上。
  const withToolUnderscore = 'mcp__srv__a__b'
  assert.equal(isToolDisabledIn({ srv: ['a__b'] }, withToolUnderscore), true)
  assert.deepEqual(splitMcpToolName(withToolUnderscore, ['srv']), { key: 'srv/a__b', server: 'srv', tool: 'a__b', certain: true })

  // 形态乙：**serverName 含 `__`**。0.16.6 及以前守卫取「第一个 `__`」，把 server 截成 `a`
  // → 查表不命中 → 返回 false，**放行一个真的被停用的工具**。守卫挂在 `tools.guard` 上，
  // 所以那是执行侧失效，不只是显示问题。
  const withServerUnderscore = 'mcp__a__b__c'
  assert.equal(isToolDisabledIn({ a__b: ['c'] }, withServerUnderscore), true)
  assert.deepEqual(splitMcpToolName(withServerUnderscore, ['a__b']), { key: 'a__b/c', server: 'a__b', tool: 'c', certain: true })

  // 整台停用（`*`）在两种形态下都要拦得住；不在表里的一律放行。
  assert.equal(isToolDisabledIn({ a__b: ['*'] }, withServerUnderscore), true)
  assert.equal(isToolDisabledIn({ srv: ['*'] }, withToolUnderscore), true)
  assert.equal(isToolDisabledIn({ srv: ['other'] }, withToolUnderscore), false)

  // 不是 MCP 工具名（含本插件自己的 `mcp_manager_*`）两侧都不认；tool 为空的名也不认。
  assert.equal(splitMcpToolName('mcp_manager_list', ['srv']), null)
  assert.equal(isToolDisabledIn({ srv: ['a__b'] }, 'mcp_manager_list'), false)
  assert.equal(splitMcpToolName('mcp__srv__', ['srv']), null)
  assert.equal(isToolDisabledIn({ srv: [''] }, 'mcp__srv__'), false)

  // 一个候选都没命中 → 按最后一个 `__` 兜底，并**如实标注不确定**（N2 据此出声，不假装切对了）。
  assert.deepEqual(splitMcpToolName(withToolUnderscore, []), { key: 'srv__a/b', server: 'srv__a', tool: 'b', certain: false })

  // 守卫**不能**共用显示侧的候选集合：集合放宽到「全部已配置服务器」会 fail-open。
  // 真实 serverName 是 `a`（宿主按第一个 `__` 归属），而 `a` 的 `b__c` 被停用：
  const realMap = { a: ['b__c'] }
  assert.equal(splitMcpToolName(withServerUnderscore, ['a']).server, 'a', '窄集合 = 停用表键 → 切出 a / b__c')
  assert.equal(isToolDisabledIn(realMap, withServerUnderscore), true, '因此拦得住')
  const widened = splitMcpToolName(withServerUnderscore, ['a', 'a__b'])
  assert.equal(widened.server, 'a__b', '放宽后最长匹配落到 a__b，tool 只剩 c')
  assert.equal(realMap[widened.server], undefined, '要查的键不存在 → 返回 false（放行）')

  // 候选集合 builder：表与名字清单都吃，重复合并、空值忽略。
  assert.deepEqual([...serverNameCandidates({ a: 1 }, ['b', 'c'], null, undefined, { c: 1 })].sort(), ['a', 'b', 'c'])
})

test('切不准的时候要出声：命名歧义判据必须零误报（N2）', () => {
  // 没有歧义形状时**必须一条都不出** —— 与 `looksLikeMcpPrefixDrift` 同一条纪律：
  // 误报会让这条上报变成每台机器都亮的噪声，等于没有。
  assert.deepEqual(ambiguousServerNames(['dhole', 'context7', 'playwright']), { withSeparator: [], prefixPairs: [] })
  assert.deepEqual(ambiguousServerNames([]), { withSeparator: [], prefixPairs: [] })
  // 单个下划线不是分隔符（`a_b` 是合法且常见的 serverName）
  assert.deepEqual(ambiguousServerNames(['a_b', 'c_d']), { withSeparator: [], prefixPairs: [] })
  // 同根但不成 `__` 前缀关系，不算一对
  assert.deepEqual(ambiguousServerNames(['a', 'b__c']), { withSeparator: ['b__c'], prefixPairs: [] })

  // 两种形状各取一例；互为前缀时，长的那半必然也含 `__`（前缀关系蕴含含 `__`），
  // 所以上报侧取"更具体"的那条、只出一行 —— 判据这里两者都如实给出。
  assert.deepEqual(ambiguousServerNames(['a__b', 'ok']), { withSeparator: ['a__b'], prefixPairs: [] })
  assert.deepEqual(ambiguousServerNames(['a', 'a__b']), { withSeparator: ['a__b'], prefixPairs: [['a', 'a__b']] })
  // 去重：同一个名字出现多次不影响结论
  assert.deepEqual(ambiguousServerNames(['a', 'a', 'a__b', 'a__b']), { withSeparator: ['a__b'], prefixPairs: [['a', 'a__b']] })
})
