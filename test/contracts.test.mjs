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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  shouldAnnounceCleared,
  subagentDepthOf,
} from '../lib/context-inject.js'
import { newestDomainTexts, PLUGIN_KINDS } from '../lib/context-inject-surface.js'
import { catalogDepthOf, catalogInjectedAt, emptyResultNote, parsePersona, renderPersonaPrompt, serializePersona, textOfBlocks } from '../lib/subagents/service.js'
import { decodeYamlScalar, rewriteFrontmatterFields, yamlScalar } from '../lib/skills/frontmatter.js'
import { parseModeState } from '../lib/memories/service.js'
import { buildMemoryOps } from '../lib/ops/memory.js'
import { TOKEN_MSG } from '../lib/http-fence.js'
import { DEFAULT_HIDDEN_TOOLS, LEGACY_TOOL_NAME_MAP, migrateLegacyToolNames, normalizeToolTableSettings } from '../lib/tools/table.js'
import { argConditionalConfirmReason } from '../lib/confirm-gate.js'
import { createAccessToken, createFrozenGate, guardModelOps, installHandlerGuards } from '../lib/request-gate.js'
import { officeKitApplies } from '../lib/skills/official.js'
import { applyLoaderToken, applyLoaderTokenDisabled, readLoaderToken } from '../lib/mcp/loader-token.js'
import { checkPatchWrite, decidePatchWrite, judgePatchText } from '../lib/compat/patch-dialect.js'
import * as yaml from 'js-yaml'
import { MASK_PLACEHOLDER, describeMaskedOutcome, isMaskedUrl, isMaskedValue, maskSecretValue, maskUrlQuery, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from '../lib/mcp/secret-guard.js'
import { isValidTrashPayloadPath, isPatchBackupName, moveOutOfTrash, moveToTrash, readTrashPayloadFiles } from '../lib/hub.js'
import { isIndexQuarantined, readIndex, writeFileAtomically, writeIndex } from '../lib/memories/index-io.js'
import { MCP_CLIENT_MODULE, MCP_TOOL_PREFIX, ambiguousServerNames, looksLikeMcpPrefixDrift, serverNameCandidates, splitMcpToolName } from '../lib/host-names.js'
import { isToolDisabledIn } from '../lib/mcp/manager.js'
import { renderMcpStateSection } from '../lib/mcp/state-section.js'
import { EXPECTED_PEER_RANGE, assessHost, hostPackageDirsFromPath, hostVersionOf, looksLikeHostPackageDir } from '../lib/compat/probe.js'
import { pickBestCompatible, sourcePlan } from '../lib/update-check.js'
import { scanLoaderRows } from '../lib/mcp/loader-token.js'
import { isValidGroupPath, isValidGroupSegment } from '../lib/memories/constants.js'
import { createMemoriesService } from '../lib/memories/service.js'
import { deleteSkill, forgetSource, importUploadedSkill, listProviderCandidates, permanentlyDeleteTrash, restoreTrash, setPreferredSkill, setSkillEnabled, setSourceRemoved, state, userRoots } from '../lib/skills/core.js'
// 字符串形态的 RootInput 是**路径**不是 key（见 rootDefinition），所以这里按 key 取定义对象。
import { rootByKey } from '../lib/skills/skill-roots.js'
// 技能管理器状态：两份策略名单（disabled / enabled）的互斥与自愈。
import { managerStatePath } from '../lib/skills/skill-roots.js'
import { readManagerState } from '../lib/skills/manager-state.js'
import { isValidSegment } from '../lib/paths.js'
import { PROMPT_CONTENT_MAX_BYTES, applyFlag, clampPromptBaseline, enterSceneInScope, exitSceneInScope, hasPromptOverride, isEmptyScope, isKeepableScope, mcpToolServerSegments, normalizeScopeMode, normalizeScopeOverrides, normalizeSessionScope, overrideCountOf, promptBaselineOf, promptOverrideOf, pruneScope, scopeForLayerSeed, sessionScenePinOf, sessionToolTableHidden } from '../lib/scope/scope-overrides.js'
import { WORKSPACE_SCOPE_KEY_MAX, WORKSPACE_SCOPE_PREFIX, isWorkspaceScopeKey, scopeKeyLabel, scopeKeyOfRow, workspaceCwdOfScopeKey, workspaceScopeKeyOf } from '../lib/scope/workspace-key.js'
import { chooseUserPromptLayer, promptBaselineDiffers } from '../lib/memories/prompt-layer.js'
import { suppressedKindsForSession } from '../lib/context-inject.js'
import { normalizeScopeIntent, pruneIntentKeys, INTENT_DOMAINS, claimsResource, planReconcile, resolveResource, scanSessionClaims } from '../lib/scope/intent.js'
import { pruneSessionScopes } from '../lib/scope/store.js'
import { createSkillCatalog, renderSkillCatalog, renderSkillCatalogDelta, skillCatalogNeedsTakeover } from '../lib/skills/catalog.js'
import { createMcpStateCatalog } from '../lib/mcp/state-section.js'
import { discoverProjectInstructions, findInstructionProjectRoot, renderProjectInstructions } from '../lib/prompts/project-instructions.js'
import { OP_REGISTRY, contradictoryEntries, frozenOps, isReadCall, opClassOf, unclassifiedOps, writeWhenUnwritten } from '../lib/op-registry.js'
import { appendOverrideEntry } from '../lib/token-config.js'
import { assertStamp, normalizeStamp, stampConflict, stampOfText } from '../lib/stale-write.js'
import { searchMemories, snippetOf } from '../lib/memories/search.js'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { buildSessionOps } from '../lib/ops/sessions.js'
import { ArchiveWorkspaceRegistry } from '../lib/sessions/workspace.js'
import { createHistoryDomain } from '../lib/sessions/history.js'
import { buildTrashOps } from '../lib/ops/trash.js'
import { bundleDocName, GLOBAL_SCENE, LEGACY_BUNDLE_DOC, MEMORIES_TRASH_DIR, SHARED_GROUP } from '../lib/memories/constants.js'
import { buildSceneSyncOps } from '../lib/ops/scene-sync.js'
import { detectFormat, parseMarkdownTranscript } from '../lib/imports/parsers.js'
import { extractExportTurns, serializeTranscript } from '../lib/exports/transcript.js'
import { buildPromptOps } from '../lib/ops/prompts.js'
import { createPromptsService } from '../lib/prompts/service.js'
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

test('MCP 段只列此刻真有工具的 server：缓存不得冒充现状，掉线档一律不进', () => {
  // 关键不变量：`toolCount`（含「已知工具」缓存）在服务器连不上时依然 > 0，所以它
  // **不能**用来判可用性 —— 判据必须是 `liveEnabledToolCount`（只来自真实 schema）。
  // 破掉的后果是静默的：段里说"可用"、模型照着去调 `mcp__X__*`，而那个工具根本没注册。
  //
  // 2026-10-19 用户裁定收紧：掉线的 server（曾经连上过、当前一个工具都没注册）**整台不进段** ——
  // 「没连接的 mcp 注入上下文是垃圾信息，只有真启动的才需要注入上下文」。所以这里从原来的
  // 「标 not connected now 也要列」改成「连名都不出现」。代价（见 state-section.ts 文件头）：
  // 用户写在那台 server 上的备注也没有载体了，模型看不到「A 不可用时改用 B」这类提示。
  const offline = {
    serverName: 'github', disabled: false,
    toolCount: 26, enabledToolCount: 26,      // 缓存算出来的两个数：依然是 26
    liveToolCount: 0, liveEnabledToolCount: 0, // 真实注册：一个都没有
    knownToolCount: 26,                        // 曾经连上过 —— 现在也不再构成列出的理由
  }
  assert.equal(renderMcpStateSection([offline]), '', '掉线的 server 不得进段（含名与备注）')

  // 同一条不变量放在混合清单上：一台可用 + 一台掉线 → 段里只有可用的那一台。
  // 单服务器清单证明不了"被筛掉"（整段为空也可能是别的理由），混合才证明是分档在起作用。
  const mixed = renderMcpStateSection([
    { serverName: 'live', disabled: false, liveToolCount: 5, liveEnabledToolCount: 3, knownToolCount: 5 },
    offline,
  ])
  assert.ok(mixed.includes('live'), '可用的要列出来')
  assert.ok(!mixed.includes('github'), '掉线的不得跟着混进来')

  // 从未连上过（缓存也空）→ 同样不列：与掉线同一档处理（2026-10-19 起两路合一）。
  const never = { serverName: 'never', disabled: false, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 0, toolCount: 0, enabledToolCount: 0 }
  assert.equal(renderMcpStateSection([never]), '')

  // 用户的选择不是故障：补丁停用 → 不列。
  assert.equal(renderMcpStateSection([{ serverName: 'off', disabled: true, liveToolCount: 0, liveEnabledToolCount: 0, knownToolCount: 9 }]), '')

  // 工具全被停用 → 列出来并标注（server 此刻在跑，只是工具被关掉；不是"缺失"）。
  // 这是 2026-10-18 起保留的第二档，也是掉线档删除后**唯一**带状态标记的一档。
  const alloff = renderMcpStateSection([{ serverName: 'alloff', disabled: false, liveToolCount: 5, liveEnabledToolCount: 0, knownToolCount: 5 }])
  assert.ok(alloff.includes('alloff'), '工具全停的 server 仍要列出来')
  assert.ok(alloff.includes('no tools enabled here'), '必须标注成"工具全停"而不是裸名')

  // 真可用 → 正常列出，且**不带任何状态标记**（能进段的都是可用的，标状态是废话）。
  // 判据依然是 `liveEnabledToolCount > 0`：上面 `alloff` 那台（live 5 / enabled 0）
  // 被标成工具全停而不是裸名，就是这条不变量在起作用 —— 数字不显示了，分档仍然只认真值。
  const ok = renderMcpStateSection([{ serverName: 'ok', disabled: false, liveToolCount: 5, liveEnabledToolCount: 3, knownToolCount: 5 }])
  assert.ok(ok.includes('- **ok**'), '真可用的要列出来')
  assert.ok(!ok.includes('未连上'), '真可用的不得标成不可用')

  // 会话逐工具关停（0.21.2 复核）：本会话把唯一可用的工具关掉 → 与"工具全停"同一档
  // （模型一条也调不到）；本会话显式开的工具要能越过全局停用表把可用数补回来。
  const sessTools = {
    serverName: 'sess', disabled: false, liveToolCount: 2, liveEnabledToolCount: 1,
    liveTools: ['a', 'b'], liveEnabledTools: ['a'], knownToolCount: 2,
  }
  const sessOff = renderMcpStateSection([sessTools], {}, true, [], { on: [], off: ['sess/a'] })
  assert.ok(sessOff.includes('no tools enabled here'), '本会话把可用工具全关掉 → 标成工具全停')
  const sessOn = renderMcpStateSection([sessTools], {}, true, [], { on: ['sess/b'], off: ['sess/a'] })
  assert.ok(sessOn.includes('- **sess**'), '本会话显式开着的工具要被算进可用数')
  assert.ok(!sessOn.includes('no tools enabled here'), '还有一条能调 → 不得标成工具全停')
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

test('登记表查找不走原型链：`constructor` / `toString` 不算已登记', () => {
  // 破了这一条的后果是**静默的**：`OP_REGISTRY['constructor']` 命中 Object 构造函数，
  // 于是 `constructor` 被当成"已登记"——对账漏报，`isReadCall` 拿不到 `writeWhen` 反而
  // 碰巧按写处理。HTTP 侧的 `handlers[op]` 更直接：未知 op 被当成可调用函数执行。
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(opClassOf(name), undefined, name + ' 不是登记项')
    assert.equal(isReadCall(name, {}), false, name + ' 未登记 → 按写处理')
    assert.deepEqual(unclassifiedOps([name]), [name], name + ' 必须报未登记')
  }
  assert.ok(opClassOf('rules-list'), '真实登记项照常取得到')
  assert.deepEqual(unclassifiedOps(['rules-list']), [], '真实登记项不算未登记')
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
  // 判据只认**以 `Current ` 开头**的双引号串 —— 那是板块名的形态（2026-10-18 起六个板块
  // 统一成英文 `Current <域>`，见 context-inject-frame.ts 的 `DomainFrame.title`）；别的引号
  // （如 `"shadowed-by:<root>"` / `"Instructions from:"`）是行内标记，不是板块引用，不参与校验。
  // ⚠️ 这个前缀**会与散文撞车**：撞了就改散文的引号，别放宽判据 —— 放宽会变成静默的
  // 假阴性（真有引用漏改也不报）。
  const titles = new Set(
    INJECT_DOMAIN_KEYS.map((key) => {
      const rendered = renderDomainText({ key, label: key, form: 'snapshot', name: 'x', text: '' })
      const line = rendered.text.split('\n').find((l) => l.startsWith('# '))
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
    for (const m of src.matchAll(/"(Current [^"]*)"/g)) seen.push([rel, m[1]])
  }
  assert.ok(seen.length > 0, '一个板块引用都没扫到 —— 判据或文件清单写错了')
  for (const [rel, name] of seen) {
    assert.ok(
      titles.has(name),
      `${rel} 引用了不存在的注入板块 "${name}"；实际存在：${[...titles].join(' / ')}`,
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


// ── 会话作用域：记忆段按会话分桶（0.21.2）────────────────────────────────────
//
// 这一条钉的是**串内容**：两份不同的会话覆盖必须算出两段不同的正文，且两份缓存
// 各自命中各自的结果。破了它的症状是「A 的场景记忆出现在 B 的上下文里」——
// 不报错、只在两个会话交替使用时出现，是整个会话作用域里最难查的一类。

// ── 会话作用域：技能目录与项目根（0.21.2）────────────────────────────────────
//
// 两条不变量：① 会话覆盖关掉的技能不进目录（同一个 agent 与不传覆盖必须给出两份不同的
// 目录）；② 项目技能根的 cwd 取**本会话**那一个，不是所有活动会话的并集 —— 后者会让
// A 对话看到 B 项目的技能。

// ── 项目指令链（0.21.2）────────────────────────────────────────────────────
//
// 这一族钉的是**与官方同构**：候选名、项目根判据、祖先链顺序、同目录去重、段前缀。
// 破了任一条的症状是"项目 AGENTS.md 读不到 / 读重了 / 顺序反了"——都不报错，
// 只是模型拿到一份错的规则。
//
// 行为表（0.21.2，见 prompts/project-instructions.ts 文件头）：
//   未钉住 + 官方在  → 官方送（本插件不发）
//   未钉住 + 官方不在 → 本插件送项目链 + 用户级
//   钉住 + 预设非空   → 本插件送项目链 + 场景预设（用户级槽位被替换）
//   钉住 + 预设为空   → 项目链 + 用户级（退化，不丢东西）
//
// 这条测试钉的是**前两条能分开**：官方在时注入侧跳过提示词域，官方不在时才发。
// 破了它的症状是"同一份 AGENTS.md 在上下文里出现两遍"或"一遍都没有"。
test('提示词投递：官方载体在时让位，不在时兜底；钉住场景时强制让位', () => {
  const domains = [{ key: 'prompt', name: 'x', label: '提示词', form: 'instructions', text: () => 'PLUGIN-PROMPT' }]
  const settings = { underSuppressingPresets: true, domains: { scene: true, memory: true, mcp: true, skills: true, subagents: true, prompt: true } }

  // 官方在 → 本插件不发（否则同一份正文进两遍）。
  const withCarrier = selectInjections(domains, settings, { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: false })
  assert.equal(withCarrier.length, 0, '官方载体在时不重复发')

  // 官方不在（极简）→ 本插件兜底发。
  const withoutCarrier = selectInjections(domains, settings, { suppressing: false, carriesAgentsMd: false, carriesSkillCatalog: false })
  assert.equal(withoutCarrier.length, 1, '官方不在时兜底发')
  assert.equal(withoutCarrier[0].text, 'PLUGIN-PROMPT')

  // 域被关掉 → 不发。
  const off = { ...settings, domains: { ...settings.domains, prompt: false } }
  assert.equal(selectInjections(domains, off, { suppressing: false, carriesAgentsMd: false, carriesSkillCatalog: false }).length, 0, '域关掉时不发')

  // 压制型预设 + 没开「仍然注入」→ 一个都不发（跟随预设）。
  assert.equal(selectInjections(domains, { ...settings, underSuppressingPresets: false }, { suppressing: true, carriesAgentsMd: false, carriesSkillCatalog: false }).length, 0, '压制型预设下跟随')
})
test('项目指令链：候选名 / 祖先链顺序 / 同目录去重 / 段前缀与官方同构', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-proj-instr-'))
  try {
    const root = join(home, 'repo')
    const sub = join(root, 'pkg')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(root, '.git'))
    // 根级 AGENTS.md + CLAUDE.md（主候选两份都要收）
    writeFileSync(join(root, 'AGENTS.md'), 'ROOT-AGENTS')
    writeFileSync(join(root, 'CLAUDE.md'), 'ROOT-CLAUDE')
    // 子目录的本地覆盖层
    writeFileSync(join(sub, 'AGENTS.local.md'), 'SUB-LOCAL')

    const files = discoverProjectInstructions(sub)
    const displays = files.map((f) => f.displayPath)
    // 顺序：宽 → 窄；每级主候选在前、本地覆盖层在后。
    assert.deepEqual(displays, ['AGENTS.md', 'CLAUDE.md', join('pkg', 'AGENTS.local.md')],
      '祖先链由宽到窄，主候选在前、本地覆盖层在后')

    // 段前缀与官方 sectionText 逐字同形。
    const rendered = renderProjectInstructions(files)
    assert.ok(rendered.text.startsWith('Instructions from: AGENTS.md\n\nROOT-AGENTS'), '段前缀与官方同形')
    assert.ok(rendered.text.includes('Instructions from: ' + join('pkg', 'AGENTS.local.md') + '\n\nSUB-LOCAL'), '窄的那一级也在')
    assert.equal(rendered.omitted.length, 0, '预算够时不丢任何一份')

    // 同目录去重：同一个目录里两份内容相同（trim 后）只留第一份（官方按**目录**去重，
    // 不是全局去重 —— 同一份内容出现在两个目录时两份都要留，它们说的是不同层级的规则）。
    const sameDir = join(home, 'same')
    mkdirSync(sameDir, { recursive: true })
    writeFileSync(join(sameDir, 'AGENTS.md'), 'DUP')
    writeFileSync(join(sameDir, 'CLAUDE.md'), '  DUP  ')
    const deduped = discoverProjectInstructions(sameDir).map((f) => f.displayPath)
    assert.deepEqual(deduped, ['AGENTS.md'], '同目录同内容只留第一份')

    // 反过来：同内容跨目录必须**都留**（不同层级的规则）。
    writeFileSync(join(sub, 'AGENTS.md'), 'ROOT-AGENTS')
    const cross = discoverProjectInstructions(sub).map((f) => f.displayPath)
    assert.ok(cross.includes('AGENTS.md'), '根级那份保留')
    assert.ok(cross.includes(join('pkg', 'AGENTS.md')), '跨目录同内容也保留（去重只在目录内）')

    // 项目根判据：没有 .git 时 cwd 自己就是根（与官方 findProjectRoot 一致）。
    const plain = join(home, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'AGENTS.md'), 'PLAIN')
    assert.equal(findInstructionProjectRoot(plain), resolve(plain), '没有 .git 时根就是 cwd')
    assert.deepEqual(discoverProjectInstructions(plain).map((f) => f.displayPath), ['AGENTS.md'], '非 git 目录也读得到')

    // 预算超了从**最宽**那一头丢：更具体的优先保留。
    const tight = renderProjectInstructions(files, 40)
    assert.ok(tight.omitted.length > 0, '预算不足时确有丢弃')
    assert.equal(tight.omitted[0], 'AGENTS.md', '从最宽的那一份开始丢')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 会话作用域：MCP 状态段（0.21.2）──────────────────────────────────────────
//
// 本会话停用的服务器**整条不进段**（与全局停用同形）：列出来只会让模型去试一条它调不到的路。
// 缓存同样必须按会话分桶，否则 A 的段会出现在 B 的上下文里。
test('MCP 状态段按会话过滤：本会话停用的服务器不进段，且缓存不得跨会话顶替', () => {
  const rows = [
    { id: 'mcp-a', serverName: 'alpha', liveToolCount: 3, liveEnabledToolCount: 3, notes: 'use when x fails' },
    { id: 'mcp-b', serverName: 'beta', liveToolCount: 2, liveEnabledToolCount: 2 },
  ]
  const global = renderMcpStateSection(rows)
  assert.ok(global.includes('alpha') && global.includes('beta'), '全局口径两台都在')

  const scoped = renderMcpStateSection(rows, {}, true, ['beta'])
  assert.ok(scoped.includes('alpha'), '没被停用的那台仍在')
  assert.equal(scoped.includes('beta'), false, '本会话停用的服务器不进段')

  // 缓存分桶：两个 agent 的两份隐藏名单必须各自命中各自的渲染结果。
  const scope = { a: ['beta'], b: [] }
  const cat = createMcpStateCatalog({
    rows: async () => ({ ok: true, rows }),
    sessionServerHidden: (agent, serverName) => (scope[(agent && agent.id) || 'b'] || []).indexOf(String(serverName)) >= 0,
  }, { ttlMs: 60000 })
  return cat.warm().then(() => {
    const a = cat.text({ id: 'a' })
    const b = cat.text({ id: 'b' })
    assert.equal(a.includes('beta'), false, 'agent a 看不到 beta')
    assert.ok(b.includes('beta'), 'agent b 仍看得到 beta')
    assert.equal(cat.text({ id: 'a' }), a, 'a 的结果不得被 b 顶掉')
  })
})

test('技能目录按会话过滤：本会话关掉的不进目录，且缓存不得跨会话顶替', () => {
  const data = {
    roots: [
      { key: 'dsh', skills: [
        { declaredName: 'alpha', description: 'A', enabled: true, modelInvocable: true },
        { declaredName: 'beta', description: 'B', enabled: true, modelInvocable: true },
      ] },
    ],
  }
  const global = renderSkillCatalog(data)
  assert.ok(global.includes('alpha') && global.includes('beta'), '全局口径两条都在')

  const scoped = renderSkillCatalog(data, undefined, undefined, true, { skill: (key) => (key === 'dsh/beta' ? false : undefined) })
  assert.ok(scoped.includes('alpha'), '会话覆盖没关的那条仍在')
  assert.equal(scoped.includes('beta'), false, '会话覆盖关掉的那条不进目录')

  // 反向：全局关着、本会话显式开着 → 必须进目录（覆盖是双向的）
  const offGlobal = { roots: [{ key: 'dsh', skills: [{ declaredName: 'gamma', description: 'G', enabled: false, modelInvocable: true }] }] }
  assert.equal(renderSkillCatalog(offGlobal).includes('gamma'), false, '全局关着不进目录')
  assert.ok(renderSkillCatalog(offGlobal, undefined, undefined, true, { skill: (key) => (key === 'dsh/gamma' ? true : undefined) }).includes('gamma'), '本会话显式开启要进目录')

  // 来源一格（skillSources，0.21.2）：来源关着时**一条都不进** —— 界面把整组按关显示、
  // 执行守卫也 deny，目录如果还列着里面某条技能，就是显示与上下文各说各话。要开这条技能
  // 得先开它的来源（写侧拨开子项时会一并认领上层，不会留下"来源关、子项开"的状态）。
  const sourceOff = { source: (rootKey) => (rootKey === 'dsh' ? false : undefined) }
  assert.equal(
    renderSkillCatalog(data, undefined, undefined, true, sourceOff).includes('beta'),
    false,
    '来源关着时没点过的技能不进目录',
  )
  assert.equal(
    renderSkillCatalog(data, undefined, undefined, true, {
      ...sourceOff,
      skill: (key) => (key === 'dsh/beta' ? true : undefined),
    }).includes('beta'),
    false,
    '来源关着时技能级为开也不进目录（来源闸始终生效）',
  )

  // 缓存分桶：`layerFor` 按 agent 取层、`layerKeyFor` 给层指纹，两个 agent 必须各自命中
  // 各自的渲染结果。破了它 = A 的目录出现在 B 的上下文里（与记忆段那条同一类故障）。
  const scope = { a: { 'dsh/beta': false }, b: undefined }
  const layerFor = (agent) => {
    const map = scope[(agent && agent.id) || 'b']
    if (!map) return undefined
    return { skill: (key) => (key in map ? map[key] : undefined) }
  }
  const cat = createSkillCatalog({
    state: async () => ({ ok: true, data }),
    layerFor: (agent) => layerFor(agent),
    layerKeyFor: (agent) => JSON.stringify(scope[(agent && agent.id) || 'b'] ?? null),
  }, { ttlMs: 60000 })
  return cat.warm().then(() => {
    const a = cat.text({ id: 'a' })
    const b = cat.text({ id: 'b' })
    assert.equal(a.includes('beta'), false, 'agent a 看不到 beta')
    assert.ok(b.includes('beta'), 'agent b 仍看得到 beta')
    // 再问一次 a：缓存被 b 顶掉就会在这一步露出来
    assert.equal(cat.text({ id: 'a' }), a, 'a 的结果不得被 b 顶掉')
    assert.ok(cat.text({ id: 'a' }).includes('alpha'), 'a 的另一条照常')
  })
})

// ── 写操作之后的那一拍不能变成「目录没了」（2026-10-22 用户实测）──────────────
//
// 症状：对话中途拨开一条技能，模型先收到一条「Cleared — 不再有效」，下一轮才看到真正
// 的清单。来路是 `refresh()` 先把缓存清空、再异步重算，而注入通道的 `text()` / `delta()`
// 是**同步**的 —— 那一拍读到空串，下游按"这一域没内容"发了一条假的「已清空」。
// 这两条钉住：刷新窗口里同步读不塌，等刷新落地后读到的是新值。
test('技能目录：refresh 之后同步读仍是上一份，等它落地才换成新值', () => {
  const first = { roots: [{ key: 'dsh', skills: [{ declaredName: 'alpha', description: 'A', enabled: true, modelInvocable: true }] }] }
  const second = { roots: [{ key: 'dsh', skills: [{ declaredName: 'alpha', description: 'A', enabled: true, modelInvocable: true }, { declaredName: 'gamma', description: 'G', enabled: true, modelInvocable: true }] }] }
  let current = first
  const cat = createSkillCatalog({ state: async () => ({ ok: true, data: current }) }, { ttlMs: 60000 })
  return cat.warm().then(() => {
    assert.ok(cat.ready({ id: 'a' }) === true, '预热过就算在手里')
    assert.equal(cat.text({ id: 'a' }).includes('gamma'), false, '初始清单没有 gamma')
    current = second
    const pending = cat.refresh()
    // 刷新进行中：同步读**不得塌成空串**（旧实现在这里返回 ''，注入侧据此发「已清空」）
    assert.ok(cat.ready({ id: 'a' }) === true, '重算期间仍算"数据在手"')
    assert.ok(cat.text({ id: 'a' }).includes('alpha'), '重算期间至少还是上一份')
    return pending.then(() => {
      assert.ok(cat.text({ id: 'a' }).includes('gamma'), '重算落地后读到新值')
      assert.equal(cat.delta({ id: 'a' }), '', '没有会话层时没有差异行')
    })
  })
})

// 冷缓存（首轮 / 被顶掉 / 还没预热）：`ready()` 必须报 false，好让注入侧这一轮沉默 ——
// "还没读到"与"真的空了"是两回事，后者会收到一条假的「已清空」。
test('技能目录：没预热过的会话 ready 为假、文本为空', () => {
  const cat = createSkillCatalog({ state: async () => ({ ok: true, data: { roots: [] } }) }, { ttlMs: 60000 })
  assert.equal(cat.ready({ id: 'never' }), false, '没取过数就不算在手里')
  assert.equal(cat.text({ id: 'never' }), '', '冷缓存返回空串（调用方据此判定"这一轮不发"）')
  assert.equal(cat.delta({ id: 'never' }), '', '冷缓存的差异行同样为空')
})

// 重算进行中又来了一个写操作：`refresh()` 不许并到在飞的那一次上 —— 并过去的话拿回的是
// 刷新前的旧任务（旧 generation，结果会被作废），缓存停在旧数据，而调用方以为算完了。
test('技能目录：重算进行中再 refresh 会另起一次，不会并到旧任务上', () => {
  let calls = 0
  let release = null
  const cat = createSkillCatalog({
    state: () => { calls += 1; return calls === 1 ? Promise.resolve({ ok: true, data: { roots: [] } }) : new Promise((r) => { release = r }) },
  }, { ttlMs: 60000 })
  return cat.warm().then(() => {
    assert.equal(calls, 1, '预热只算一次')
    // 在飞的那一次（第二次）挂住不放
    void cat.refresh()
    assert.equal(calls, 2, '第一次 refresh 起了一次重算')
    // 第二次 refresh：必须再起一次，不能并到挂着的那次上
    let done = false
    const second = cat.refresh().then(() => { done = true })
    assert.equal(calls, 3, '重算进行中也要另起一次')
    release({ ok: true, data: { roots: [] } })
    return second.then(() => { assert.equal(done, true, '第二次 refresh 等的是自己那次') })
  })
})

// ── 官方载体在送时的"差异行"通道（0.21.2）───────────────────────────────────
//
// 破了它的症状就是用户 2026-10-20 实测的那两幕：对话中途进场景，全局提示词与技能目录
// 各再进一遍 —— 接管整份会拦下官方，但只拦得住之后的步骤，官方第 1 轮那条已经在历史里
// 收不回，于是模型手里两份。这两条钉住：同文/无差异时**一条都不发**，有差异时只发差异。
test('差异行通道：官方在送整份时只补本会话差异，无差异时不发', () => {
  const settings = { underSuppressingPresets: true, domains: { scene: true, memory: true, mcp: true, skills: true, subagents: true, prompt: true } }
  const officialOn = { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: true }
  const officialOff = { suppressing: false, carriesAgentsMd: false, carriesSkillCatalog: false }
  const domains = [{
    key: 'skills', name: 'x', label: '技能目录', form: 'catalog',
    text: () => 'FULL-CATALOG', delta: () => 'DELTA-LINE',
  }]

  const sent = selectInjections(domains, settings, officialOn)
  assert.equal(sent.length, 1, '有差异时官方那份照发，本插件补一行')
  assert.equal(sent[0].text, 'DELTA-LINE')
  assert.equal(sent[0].delta, true, '差异行要带标记（框架据此不套整份目录的说明句）')

  assert.equal(selectInjections([{ ...domains[0], delta: () => '   ' }], settings, officialOn).length, 0, '没有差异 = 一条都不发')

  const minimal = selectInjections(domains, settings, officialOff)
  assert.equal(minimal.length, 1)
  assert.equal(minimal[0].text, 'FULL-CATALOG', '官方不在（极简）时照旧发整份')
  assert.equal(minimal[0].delta, undefined, '整份不是差异行')

  // 没有 delta 出口的域（提示词）行为一字不变：官方在就不发。
  const promptOnly = [{ key: 'prompt', name: 'p', label: '提示词', form: 'instructions', text: () => 'P' }]
  assert.equal(selectInjections(promptOnly, settings, officialOn).length, 0, '提示词域没给 delta 就照旧让位')

  // 「注入实况」的口径必须与发送一致，否则界面说"官方在送"而模型其实收到了我们一行。
  assert.equal(explainInjections(domains, settings, officialOn).skills, 'sent', '有差异行时报 sent')
  assert.equal(explainInjections([{ ...domains[0], delta: () => '' }], settings, officialOn).skills, 'official', '无差异时报 official')

  // 差异行的框架：只有标题 + 正文，不套 `how` / 边界句（那两句说的是整份目录）。
  const rendered = renderDomainText({ key: 'skills', name: 'x', label: '技能目录', form: 'catalog', text: 'DELTA-LINE', delta: true }, () => false, false)
  assert.ok(rendered.text.includes('# Current skills'), '板块标题仍在')
  assert.ok(rendered.text.includes('DELTA-LINE'))
  assert.equal(rendered.text.includes('A skill is a reusable set'), false, '差异行不套整份目录的说明句')
  assert.equal(rendered.text.includes('Only enabled skills are listed'), false, '差异行不套边界句')
})

// ── 技能目录整份接管（0.21.2 第二轮）─────────────────────────────────────────
//
// 用户 2026-10-21 真机发现：A 会话启动技能（租约运行中）时，B 会话的官方 available_skills
// 仍列出它（官方按机器启停列，不知道租约 / 会话层），插件随后再补一行 "not available here"
// —— 模型先看到技能、再被告知不可用。新口径与提示词域同一哲学：有差异时拦下官方那份，
// 由插件送会话版整份；没有差异时一条都不动（官方照送、插件不出声）。
test('技能目录接管判据：delta 非空才拦官方，空 / 纯空白都不拦', () => {
  const settings = { underSuppressingPresets: true, domains: { scene: true, memory: true, mcp: true, skills: true, subagents: true, prompt: true } }
  const data = { roots: [{ key: 'dsh', enabled: true, skills: [{ declaredName: 'alpha', description: 'A', enabled: true, modelInvocable: true }] }] }
  const diff = renderSkillCatalogDelta(data, { skill: () => false })
  assert.ok(diff.trim() !== '', '夹具必须真的有差异')

  assert.equal(skillCatalogNeedsTakeover(''), false, '没有差异行 → 不接管')
  assert.equal(skillCatalogNeedsTakeover(' \n\t '), false, '纯空白不算差异')
  assert.equal(skillCatalogNeedsTakeover(diff), true, '有差异行 → 接管')

  assert.equal(suppressedKindsForSession(settings, false, false).has('skill-catalog'), false, '无差异不拦官方')
  assert.equal(suppressedKindsForSession(settings, false, true).has('skill-catalog'), true, '有差异拦官方')
  // 域被用户关掉时照旧拦（既有口径：官方被拦 + 插件不发）。
  const off = { ...settings, domains: { ...settings.domains, skills: false } }
  assert.equal(suppressedKindsForSession(off, false, false).has('skill-catalog'), true, '域关掉时拦')
  // 提示词接管的既有行为不受影响。
  assert.equal(suppressedKindsForSession(settings, true, false).has('agent-instructions'), true, '提示词接管照旧拦 AGENTS.md')
})

// 「已清空」的四种**不发**情形（纯函数，直接钉）：这条通知的字面意思是"这份内容已失效，
// 别再用"，所以只有"上一轮确有一条、这一轮确实一条都没有"时才发。漏掉任何一条，
// 模型收到的都是谎报 —— 2026-10-22 用户实测的那条假「Cleared」正是漏了 pending 这一格。
test('「已清空」判定：取数失败 / 数据未到手 / 已经通知过 / 从没注入过，都不发', () => {
  const had = { body: 'OLD' }
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: false, previous: had }), true, '曾经有、现在没有 → 发')
  assert.equal(shouldAnnounceCleared({ published: true, failed: false, pending: false, previous: had }), false, '这一轮发了内容就无所谓通知')
  assert.equal(shouldAnnounceCleared({ published: false, failed: true, pending: false, previous: had }), false, '取数失败 ≠ 没有内容（审查 P1-8）')
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: true, previous: had }), false, '数据还没到手 ≠ 没有内容（2026-10-22 实测）')
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: false, previous: { cleared: true, body: 'OLD' } }), false, '已经通知过就不叠发（2026-10-19 实测）')
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: false, previous: undefined }), false, '从没注入过的域没有旧内容要作废')
  // 唯一的放宽：接管时官方那份已被拦下、会话版又为空 → 必须补一条。
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: false, previous: undefined, takeoverEmpty: true }), true, '接管 + 会话版为空要补通知')
  assert.equal(shouldAnnounceCleared({ published: false, failed: false, pending: true, previous: undefined, takeoverEmpty: true }), false, '同样受 pending 约束')
})

test('技能目录接管：官方被摘掉后送会话版整份，差异行只作兜底', () => {
  const settings = { underSuppressingPresets: true, domains: { scene: true, memory: true, mcp: true, skills: true, subagents: true, prompt: true } }
  const domains = [{ key: 'skills', name: 'x', label: '技能目录', form: 'catalog', text: () => 'SESSION-CATALOG', delta: () => 'DELTA-LINE' }]
  const carrier = { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: true }
  // 正常装配：有差异时注入器把 carriesSkillCatalog 改成 false（见 context-inject.ts）。
  const takeoverFacts = { ...carrier, carriesSkillCatalog: false }
  const full = selectInjections(domains, settings, takeoverFacts)
  assert.equal(full.length, 1)
  assert.equal(full[0].text, 'SESSION-CATALOG', '接管后送整份')
  assert.equal(full[0].delta, undefined, '整份不是差异行')
  assert.equal(explainInjections(domains, settings, takeoverFacts).skills, 'sent', '实况按整份口径报 sent')

  // 旧装配（没接判据）：仍走兜底差异行。
  const fallback = selectInjections(domains, settings, carrier)
  assert.equal(fallback[0].text, 'DELTA-LINE')
  assert.equal(fallback[0].delta, true)

  // 会话版为空：不送正文，实况报 empty（注入器据此补「已清空」）。
  const emptyDomains = [{ ...domains[0], text: () => '' }]
  assert.equal(selectInjections(emptyDomains, settings, takeoverFacts).length, 0)
  assert.equal(explainInjections(emptyDomains, settings, takeoverFacts).skills, 'empty')
})

test('技能目录接管端到端：拦官方、送会话版整份；无差异时不误拦', async () => {
  const officialEvent = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'OFFICIAL-CATALOG' }], source: { kind: 'skill-catalog', form: 'catalog' } },
  }
  const agent = { session: { seq: 1, surface: { nodes: [0] }, eventAt: () => officialEvent } }
  const carrier = { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: true }
  const officialDecision = () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'OFFICIAL-CATALOG' }] }],
  })
  const drive = async (domains, diverged, target = agent) => {
    let listener = null
    const injector = createContextInjector({
      ctx: { on: (_name, fn) => { listener = fn; return () => {} } },
      domains: () => domains,
      settings: () => DEFAULT_INJECT_SETTINGS,
      factsFor: async () => carrier,
      skillCatalogDiverged: () => diverged,
    })
    try {
      return await listener({ agent: target, step: 2 }, async () => officialDecision())
    } finally { injector.dispose() }
  }

  const domains = [{
    key: 'skills', name: 'x', label: '技能目录', form: 'catalog',
    text: () => 'SESSION-CATALOG',
    delta: () => 'DELTA-LINE',
  }]
  const out = await drive(domains, true)
  assert.equal(out.messages.some((m) => (m.source || {}).kind === 'skill-catalog'), false, '有差异时官方那条必须被拦')
  const ours = out.messages.filter((m) => (m.source || {}).kind === 'skill-manager-catalog')
  assert.equal(ours.length, 1, '插件送会话版整份')
  assert.ok(ours[0].content[0].text.includes('SESSION-CATALOG'))
  assert.ok(ours[0].content[0].text.includes('Supersedes earlier injected content'), '首份会话版要带取代声明')

  // 无差异：官方照常放行，插件不出声（S3）。
  const quiet = [{ ...domains[0], delta: () => '   ' }]
  const out2 = await drive(quiet, false)
  assert.equal(out2.messages.some((m) => (m.source || {}).kind === 'skill-catalog'), true, '无差异时官方照送')
  assert.equal(out2.messages.some((m) => (m.source || {}).kind === 'skill-manager-catalog'), false, '无差异时插件不出声')

  // 会话版为空但官方那份在表面上：补一条「已清空」，不让错误清单继续有效。
  const out3 = await drive([{ ...domains[0], text: () => '' }], true)
  assert.equal(out3.messages.some((m) => (m.source || {}).kind === 'skill-catalog'), false, '官方仍被拦')
  const notices = out3.messages.filter((m) => (m.source || {}).kind === 'skill-manager-catalog' && (m.source || {}).form === 'notice')
  assert.equal(notices.length, 1, '会话版为空时补一条「已清空」')

  // 接管开始后 delta 归空：官方不会重发同一摘要（它第 1 轮那条仍与机器一致），所以不能
  // 立刻交还 —— 否则插件会补一条假的「官方已接管」，而模型手里最新的仍是插件那份。
  // 继续接管 + 内容没变 = 官方被拦、插件一条都不发。
  // 表面上那条「插件旧消息」直接用上面**真发出去的那一条**（`ours[0]`）：手写 `source` 会漏掉
  // 框架指纹 `frame`（0.21.3 起它是去重判据的一位），于是"内容没变"永远判不出来，这条断言
  // 就退化成摆设 —— 真实会话里每轮重发，测试却是绿的。
  const pluginEvent = { type: 'user/message', data: { content: ours[0].content, source: ours[0].source } }
  const tookOverAgent = {
    session: { seq: 2, surface: { nodes: [0, 1] }, eventAt: (seq) => (Number(seq) === 1 ? pluginEvent : officialEvent) },
  }
  const out4 = await drive(domains, false, tookOverAgent)
  assert.equal(out4.messages.some((m) => (m.source || {}).kind === 'skill-catalog'), false, '接管过之后官方仍被拦')
  assert.equal(out4.messages.some((m) => (m.source || {}).kind === 'skill-manager-catalog'), false, '内容没变就一个字都不发（不补假通知）')
})

test('技能目录端到端：数据还没到手的那一拍不许发假的「已清空」', async () => {
  // 复现 2026-10-22 用户实测：对话中途拨开一条技能 → 对账拉起运行态 → 目录缓存被打回
  // 重算 → 紧接着的那一拍 `text()` 读到空串 → 注入侧发一条「Cleared — 不再有效」，
  // 下一轮才看到真正的清单。修法：域声明 `pending()`，数据不在手时这一轮沉默。
  const officialEvent = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'OFFICIAL-CATALOG' }], source: { kind: 'skill-catalog', form: 'catalog' } },
  }
  const carrier = { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: true }
  const drive = async (domains, diverged) => {
    // 表面上有一条插件自己发的旧目录（seq 1）→ "曾经有内容"
    const pluginEvent = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'PLUGIN-OLD' }],
        source: { kind: 'skill-manager-catalog', form: 'catalog', body: 'SESSION-CATALOG' },
      },
    }
    const agent = { session: { seq: 2, surface: { nodes: [0, 1] }, eventAt: (seq) => (Number(seq) === 1 ? pluginEvent : officialEvent) } }
    let listener = null
    const injector = createContextInjector({
      ctx: { on: (_name, fn) => { listener = fn; return () => {} } },
      domains: () => domains,
      settings: () => DEFAULT_INJECT_SETTINGS,
      factsFor: async () => carrier,
      skillCatalogDiverged: () => diverged,
    })
    try {
      return await listener({ agent, step: 2 }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'OFFICIAL-CATALOG' }] }] }))
    } finally { injector.dispose() }
  }
  const base = { key: 'skills', name: 'x', label: '技能目录', form: 'catalog', delta: () => 'DELTA-LINE' }

  // 冷缓存：一条都不该发（既不重发旧清单，也不说它失效）。
  const cold = await drive([{ ...base, text: () => '', pending: () => true }], true)
  assert.equal(cold.messages.some((m) => (m.source || {}).kind === 'skill-catalog'), false, '接管中官方仍被拦')
  assert.equal(
    cold.messages.some((m) => (m.source || {}).form === 'notice'),
    false,
    '数据没到手 → 不发「已清空」（上一轮那份仍然有效）',
  )
  assert.equal(cold.messages.some((m) => (m.source || {}).kind === 'skill-manager-catalog'), false, '没有内容可发')

  // 对照组：数据在手、确实是空的 → 照旧补一条「已清空」（这条不能一起被改没了）。
  const empty = await drive([{ ...base, text: () => '', pending: () => false }], true)
  assert.equal(
    empty.messages.filter((m) => (m.source || {}).form === 'notice').length,
    1,
    '真的空着才发通知',
  )
})

test('提示词快照接管端到端：拦官方 AGENTS.md、送快照整份；接管后不交还', async () => {
  const officialEvent = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'OFFICIAL-AGENTS' }], source: { kind: 'agent-instructions', form: 'instructions' } },
  }
  const agent = { session: { seq: 1, surface: { nodes: [0] }, eventAt: () => officialEvent } }
  const carrier = { suppressing: false, carriesAgentsMd: true, carriesSkillCatalog: true }
  const officialDecision = () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'agent-instructions', form: 'instructions' }, content: [{ type: 'text', text: 'OFFICIAL-AGENTS' }] }],
  })
  const drive = async (domains, diverged, target = agent) => {
    let listener = null
    const injector = createContextInjector({
      ctx: { on: (_name, fn) => { listener = fn; return () => {} } },
      domains: () => domains,
      settings: () => DEFAULT_INJECT_SETTINGS,
      factsFor: async () => carrier,
      promptBaselineDiverged: () => diverged,
    })
    try {
      return await listener({ agent: target, step: 2 }, async () => officialDecision())
    } finally { injector.dispose() }
  }
  const domains = [{ key: 'prompt', name: 'x', label: '提示词', form: 'instructions', text: () => 'FROZEN-BODY' }]
  const out = await drive(domains, true)
  assert.equal(out.messages.some((m) => (m.source || {}).kind === 'agent-instructions'), false, '快照与文件不一致时官方那条必须被拦')
  const ours = out.messages.filter((m) => (m.source || {}).kind === 'prompt-manager-catalog')
  assert.equal(ours.length, 1, '插件送快照链整份')
  assert.ok(ours[0].content[0].text.includes('FROZEN-BODY'))
  assert.ok(ours[0].content[0].text.includes('Supersedes earlier injected content'), '首份快照版要带取代声明')

  // 一致：官方照送，插件不出声（新会话首轮 / P4）。
  const out2 = await drive(domains, false)
  assert.equal(out2.messages.some((m) => (m.source || {}).kind === 'agent-instructions'), true, '无差异时官方照送')
  assert.equal(out2.messages.some((m) => (m.source || {}).kind === 'prompt-manager-catalog'), false, '无差异时插件不出声')

  // 接管过之后差异归零：官方不会重发同一摘要，插件必须继续接管；内容没变就一个字都不发。
  // 同前一条：回灌**真发出去的那条**，手写 source 会漏掉框架指纹 `frame`。
  const pluginEvent = { type: 'user/message', data: { content: ours[0].content, source: ours[0].source } }
  const tookOverAgent = {
    session: { seq: 2, surface: { nodes: [0, 1] }, eventAt: (seq) => (Number(seq) === 1 ? pluginEvent : officialEvent) },
  }
  const out3 = await drive(domains, false, tookOverAgent)
  assert.equal(out3.messages.some((m) => (m.source || {}).kind === 'agent-instructions'), false, '接管过之后官方仍被拦')
  assert.equal(out3.messages.some((m) => (m.source || {}).kind === 'prompt-manager-catalog'), false, '内容没变就不重发（不补假通知）')
})

test('技能目录差异：只报本会话与全局不一致的条目，两个方向都要说清', () => {
  const data = {
    roots: [
      { key: 'dsh', enabled: true, skills: [
        { declaredName: 'alpha', description: 'A', enabled: true, modelInvocable: true },
        { declaredName: 'beta', description: 'B', enabled: true, modelInvocable: true },
      ] },
    ],
  }
  assert.equal(renderSkillCatalogDelta(data, undefined), '', '没有会话层 = 没有差异')
  assert.equal(renderSkillCatalogDelta(data, { skill: () => undefined }), '', '会话层没说话 = 没有差异')

  const off = renderSkillCatalogDelta(data, { skill: (key) => (key === 'dsh/beta' ? false : undefined) })
  assert.ok(off.includes('beta') && !off.includes('alpha'), '只报被关掉的那一条')
  assert.ok(off.includes('not available here'), '方向要说清（本会话看不到）')

  const on = renderSkillCatalogDelta(
    { roots: [{ key: 'dsh', enabled: true, skills: [{ declaredName: 'gamma', description: 'G', enabled: false, modelInvocable: true }] }] },
    { skill: (key) => (key === 'dsh/gamma' ? true : undefined) },
  )
  assert.ok(on.includes('gamma') && on.includes('- available here:'), '官方那份没有的条目 → 报"这里可用"')
  assert.equal(off.includes('global') || off.includes('machine'), false, '正文不得提"全局 / 机器"—— 模型不知道有这两层设置')

  // 来源闸：租约把来源拉起来跑（全局目录会把它算成开着），没认领的会话必须看到"这里不可用"。
  const leased = renderSkillCatalogDelta(data, { source: () => false })
  assert.ok(leased.includes('alpha') && leased.includes('beta'), '来源被本会话判关时里面的技能都要报')

  // 影子副本 / 不可调用的条目：它们两边都不在目录里，不该出现在差异里。
  const shadowed = {
    roots: [{ key: 'dsh', enabled: true, skills: [
      { declaredName: 'dup', description: 'D', enabled: true, modelInvocable: true },
      { declaredName: 'dup', description: 'D2', enabled: true, modelInvocable: true, shadowedBy: 'dsh' },
      { declaredName: 'nocall', description: 'N', enabled: true, modelInvocable: false },
    ] }],
  }
  assert.equal(renderSkillCatalogDelta(shadowed, { skill: () => undefined }), '', '会话层没说话 = 没有差异')
  const shadowDiff = renderSkillCatalogDelta(shadowed, { skill: () => false })
  assert.ok(shadowDiff.includes('`dup`'), '真正生效的那一份要报')
  assert.equal(shadowDiff.includes('nocall'), false, '不可调用的条目两边都不在目录里，不算差异')
  assert.equal(shadowDiff.split('dup').length - 1, 1, '影子副本不得再报一次同名条目')

  // 目录出口：全局口径（没有会话 id）永远不出差异行 —— 差异本来就是相对全局算的。
  const cat = createSkillCatalog({
    state: async () => ({ ok: true, data }),
    sessionIdFor: (agent) => (agent && agent.id) || null,
    layerFor: (agent) => (agent && agent.id) === 'a' ? { skill: (key) => (key === 'dsh/beta' ? false : undefined) } : undefined,
    layerKeyFor: (agent) => String((agent && agent.id) || ''),
  }, { ttlMs: 60000 })
  return cat.warmSession('a').then(() => {
    assert.ok(cat.delta({ id: 'a' }).includes('beta'), '会话 a 有差异行')
    assert.equal(cat.delta({ id: 'b' }), '', '会话 b 没说话 = 没差异')
    assert.equal(cat.delta(undefined), '', '全局口径不出差异行')
  })
})

test('记忆段按会话分桶：两个会话的覆盖各算各的，缓存不得互相顶替', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scope-mem-'))
  try {
    const stateDir = join(home, 'tool-management')
    const memoriesRoot = join(stateDir, 'memories')
    for (const scene of ['alpha', 'beta']) {
      mkdirSync(join(memoriesRoot, scene), { recursive: true })
      writeFileSync(join(memoriesRoot, scene, scene + '-note.md'), '---\nname: ' + scene + '-note\ndescription: d\n---\nBODY-' + scene.toUpperCase() + '\n')
    }
    const svc = createMemoriesService({}, { memoriesRoot, stateDir })
    // 全局当前场景 = alpha
    await svc.patchIndex({ active: ['alpha'] }, ['active'])

    // 全局口径：只有 alpha 进段
    const globalText = svc.memoryText()
    assert.ok(globalText.includes('BODY-ALPHA'), '全局口径应含 alpha')
    assert.equal(globalText.includes('BODY-BETA'), false, '全局口径不该含 beta')

    // 会话 A 覆盖到 beta：同一份磁盘、同一时刻，段必须换成 beta 的内容
    const a = svc.memoryText({ sessionId: 'sess-a', scene: 'beta' })
    assert.ok(a.includes('BODY-BETA'), '会话 A 应看到 beta')
    assert.equal(a.includes('BODY-ALPHA'), false, '会话 A 不该看到全局的 alpha')

    // 关键：再问一次全局，必须**还是** alpha —— 缓存被会话 A 顶掉就是串内容
    const globalAgain = svc.memoryText()
    assert.equal(globalAgain, globalText, '会话 A 算过之后，全局口径必须逐字节不变')

    // 会话 B 不带场景覆盖（跟随全局）→ 与全局一致，且不得是 A 的 beta
    const b = svc.memoryText({ sessionId: 'sess-b' })
    assert.equal(b, globalText, '跟随全局的会话必须拿到全局那一份')

    // 逐条开关覆盖：关掉 alpha 之后全局口径里那条消失，但会话 A（beta）不受影响
    const off = svc.memoryText({ sessionId: 'sess-c', memory: { 'alpha/alpha-note': false } })
    assert.equal(off.includes('BODY-ALPHA'), false, '逐条覆盖关掉的记忆不得进段')
    const aAgain = svc.memoryText({ sessionId: 'sess-a', scene: 'beta' })
    assert.ok(aAgain.includes('BODY-BETA'), '别的会话的逐条覆盖不得影响会话 A')

    // 场景段同一条：覆盖到 beta 时会话 A 的清单里是 beta
    const aCatalog = svc.sceneCatalogText({ sessionId: 'sess-a', scene: 'beta' })
    assert.ok(aCatalog.includes('beta'), '会话 A 的场景段应含 beta')
    const gCatalog = svc.sceneCatalogText()
    assert.ok(gCatalog.includes('alpha'), '全局场景段应含 alpha')
    assert.equal(gCatalog.includes('beta'), false, '全局场景段不该含 beta')
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
  // 只有一代：历史上这里是「每适配一代新 rc 就追加一段」，范围于是累积成
  // 0.1.7 || 0.2.0 || 0.2.1 三代并集，等于向 npm 声明「当前版本支持 0.1.7 起的每一代」——
  // 而代码是按 0.2.1 的契约写的。那种声明最坏的结果是"装上了但某几个动作悄悄失效"。
  // 这条断言把「逐段写」和「累积各代」区分开：可以有多段比较器，但只能有一个 `||` 分支。
  assert.equal(
    EXPECTED_PEER_RANGE.split('||').length,
    1,
    '范围只声明当前适配的那一代，不累积历史各代（旧宿主装旧版本）',
  )
  // engines.dsh 与 peer range 也必须同源：前者是 dsh plugin 安装期的检查，后者是 npm 的
  // peer 校验，两处说法不一致时用户会看到「装的时候说支持、跑的时候说不支持」。
  assert.equal(pkg.engines?.dsh, EXPECTED_PEER_RANGE, 'engines.dsh 与 peer range 必须同一个字符串')
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
  for (const own of ['mcp_manager_list', 'mcp_manager_save', 'mcp_manager_switch', 'mcp_anything']) {
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

test('「已清空」通知不占内容键位：它之后内容恢复的域必须能重发', async () => {
  // 钉的是 2026-10-19 修的那个 bug：`form === 'notice'` 的消息曾占着 `newestDomainTexts` 的键位，
  // 于是同域恢复内容时扫描到的仍是那条通知（`body` 恒为 undefined）→ 判据永远落在"内容变了"
  // 那一侧 → 该域再也不注入（用户实测：退出场景再进「测试」场景，场景 / MCP / 技能 / 子智能体
  // 四条一条都没重发）。破了不会有任何报错，只是静默地少发，所以必须钉。
  const INJECT_KIND = { scene: 'scene-manager-catalog' }
  // 假会话：表面 = seq 0（内容）→ seq 1（已清空通知）→ seq 2（内容恢复）。
  // 自新到旧扫描，正确行为是返回 seq 2 的正文（跳过 seq 1 的通知）。
  const events = new Map([
    [0, { type: 'user/message', data: { content: [{ type: 'text', text: 'first-body' }], source: { kind: INJECT_KIND.scene, form: 'snapshot', body: 'first-body' } } }],
    [1, { type: 'user/message', data: { content: [{ type: 'text', text: 'cleared' }], source: { kind: INJECT_KIND.scene, form: 'notice' } } }],
    [2, { type: 'user/message', data: { content: [{ type: 'text', text: 'restored-body' }], source: { kind: INJECT_KIND.scene, form: 'snapshot', body: 'restored-body' } } }],
  ])
  const agent = {
    session: {
      seq: 3,
      surface: { nodes: [0, 1, 2] },
      eventAt: (seq) => events.get(Number(seq)),
    },
  }
  const out = newestDomainTexts(agent, PLUGIN_KINDS)
  const entry = out.get('scene')
  assert.ok(entry !== undefined, '内容恢复的域必须被扫到')
  assert.equal(entry.body, 'restored-body', '必须返回最新那条**内容**消息的 body，而不是被通知挡在后面')
  assert.notEqual(entry.form, 'notice', '返回的不能是通知形态')
  assert.equal(entry.cleared, false, '通知之后又有内容 = 已经不再是「已清空」')

  // 反向（同一件事的另一半，2026-10-19 用户实测的第二个症状）：**最新一条就是通知**时，
  // `cleared` 必须为真，否则「该不该补发通知」没有依据 → 每个空域每轮都补发一条「Cleared」。
  // 而 `body` 仍要给出更早那条内容的指纹（内容恢复时靠它判"变没变"）。
  const noticeAgent = {
    session: { seq: 2, surface: { nodes: [0, 1] }, eventAt: (seq) => events.get(Number(seq)) },
  }
  const clearedEntry = newestDomainTexts(noticeAgent, PLUGIN_KINDS).get('scene')
  assert.ok(clearedEntry !== undefined)
  assert.equal(clearedEntry.cleared, true, '最新一条是通知 → 必须标记为已清空（否则每轮补发）')
  assert.equal(clearedEntry.body, 'first-body', '已清空仍要带更早那条内容的指纹，供内容恢复时比对')
})

test('注入去重端到端：内容没变就不发，变了才发（判据行本身不能丢）', async () => {
  // 上一条钉的是扫描侧的判据，这一条钉**发送侧的判据**（`createContextInjector` 的 pre-step）。
  // 为什么必须端到端：2026-10-19 的一次注释编辑把 `if (current !== undefined && current.body ===
  // rendered.body) continue` 整行删掉了，纯函数测试全绿（扫描侧没坏），而真实会话里六个域每一轮
  // 全量重发 —— 用户实测「每次对话都注入上下文」。只有驱动真监听器才拦得住这种丢失。
  //
  // 假会话：**先让插件自己发一条**，再把它发出来的那条当"上一轮的消息"。
  // 手写 `source` 会漏掉框架指纹 `frame`（0.21.3 起它是判据的一位），于是"没变"永远判不出来 ——
  // 测试一直绿，真实会话里每轮重发，正好是这条要拦的东西。
  const domains = [{ key: 'mcp', name: 'c', label: 'MCP', form: 'catalog', text: () => '上一轮的域正文' }]
  let listener = null
  const ctx = { on: (_name, fn) => { listener = fn; return () => {} } }
  const injector = createContextInjector({
    ctx,
    domains: () => domains,
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
  })
  assert.equal(typeof listener, 'function', 'pre-step 监听必须注册上')
  const blank = { session: { seq: 0, surface: { nodes: [] }, eventAt: () => undefined } }
  // 第一拍按真实情形给一条用户消息：`step 1 且一条消息都没有` 时注入器直接返回（空 turn
  // 不注入，官方同款守卫），那是另一条契约，不在这里测。
  const firstOut = await listener({ agent: blank, step: 1 }, async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '你好' }] }] }))
  const emitted = firstOut.messages.find((m) => (m.source || {}).kind === 'mcp-manager-catalog')
  assert.ok(emitted !== undefined, '空表面必须发一条')
  assert.equal(typeof emitted.source.frame, 'string', '发出的消息必须带框架指纹（下一轮靠它判「没变」）')
  // 第一步：表面上已有同域、同正文、同框架的注入 → 一条都不该新增。
  const injectedEvent = { type: 'user/message', data: { content: emitted.content, source: emitted.source } }
  const agent = { session: { seq: 5, surface: { nodes: [0] }, eventAt: () => injectedEvent } }
  const out = await listener({ agent, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const appended = out.messages.filter((m) => (m.source || {}).kind === 'mcp-manager-catalog')
  assert.equal(appended.length, 0, '内容一个字没变就不该再发（每轮重发就是这里失守')
  injector.dispose()

  // 同一套驱动方式，另一半：该域这一轮**没有内容**，而表面上最新一条已经是「已清空」通知
  // → 一条都不该新增。这一条守的是"每个空域每轮补发一条 Cleared"（2026-10-19 用户实测）。
  let listener2 = null
  const clearedEvent = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '通知' }], source: { kind: 'mcp-manager-catalog', form: 'notice' } },
  }
  const clearedAgent = { session: { seq: 3, surface: { nodes: [0] }, eventAt: () => clearedEvent } }
  const emptyDomains = [{ key: 'mcp', name: 'c', label: 'MCP', form: 'catalog', text: () => '' }]
  const ctx2 = { on: (_name, fn) => { listener2 = fn; return () => {} } }
  const injector2 = createContextInjector({
    ctx: ctx2,
    domains: () => emptyDomains,
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
  })
  const out2 = await listener2({ agent: clearedAgent, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const again = out2.messages.filter((m) => (m.source || {}).kind === 'mcp-manager-catalog')
  assert.equal(again.length, 0, '已经是「已清空」的域不该每轮再补一条通知')
  injector2.dispose()

  // 第三半（2026-10-21 真机发现）：最新一条是「已清空」通知，域重新打开后内容恢复、
  // 且与更早那条逐字节相同。通知带的 `body` 只是旧指纹，不能拿它判"没变" —— 否则
  // 模型看到的最新消息仍是「不再发送」，而内容其实已经回来了。
  let listener3 = null
  const oldContentEvent = {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: '更早的内容' }],
      source: { kind: 'mcp-manager-catalog', form: 'catalog', body: 'same-body' },
    },
  }
  const restoredAgent = {
    session: {
      seq: 2,
      surface: { nodes: [0, 1] },
      eventAt: (seq) => (Number(seq) === 1 ? clearedEvent : oldContentEvent),
    },
  }
  const restoredDomains = [{ key: 'mcp', name: 'c', label: 'MCP', form: 'catalog', text: () => 'same-body' }]
  const ctx3 = { on: (_name, fn) => { listener3 = fn; return () => {} } }
  const injector3 = createContextInjector({
    ctx: ctx3,
    domains: () => restoredDomains,
    settings: () => DEFAULT_INJECT_SETTINGS,
    factsFor: async () => undefined,
  })
  const out3 = await listener3({ agent: restoredAgent, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const restored = out3.messages.filter((m) => (m.source || {}).kind === 'mcp-manager-catalog')
  assert.equal(restored.length, 1, '「已清空」之后内容恢复必须重发（即使正文与更早那条相同）')
  assert.equal(restored[0].source.form, 'catalog', '重发的必须是内容，不是又一条通知')
  injector3.dispose()
})

test('URL 打码必须覆盖 userinfo / 片段，且打码值在任何写路径都进不去补丁', () => {
  // 破了这一条的后果是**凭据外泄 + 反向数据丢失**（审查 F5 / F4）：
  //   `new URL()` 把 userinfo 与 fragment 存在 `username/password` 与 `hash` 里，只替换 `search`
  //   的话 `https://user:pass@host/mcp`（Basic-Auth，MCP 托管服务真实存在的形态）与
  //   `https://host/mcp#access_token=…`（连 `?` 都没有）会**整条原样返回** —— 而这两条路正是
  //   免令牌出口（mcpm-list / 模型工具 / 快照导出）。
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

// ── 0.18.5：恢复回执的形状 + 转录导出的两档 ──────────────────────────────────
//
// 这两组都属于「破了会静默出错」那一类：
//   · 恢复：官方 `unarchiveSession` 是 `Promise<void>`，门面把 undefined 原样透传、op 层
//     再去读它的字段就抛 TypeError —— 而宿主**已经恢复成功**了，用户看到的是「操作失败」。
//   · 导出：`extractText` 只判「有没有 text 字段」，而 `ReasoningBlock` 恰好是
//     `{type:'reasoning', text}`，于是思考一直混在助手正文里导出去（0.16.x 已在子智能体
//     侧修过同一类缺陷，导出侧是它的第二个出口）。

/** 驱动门面 `unarchiveSession`：只替换它真正碰到的那几个面。
 *  `hostReturns` 是宿主方法的返回值 —— 官方契约是 undefined，测试要的就是能传 undefined。 */
const unarchiveHarness = ({ archiveSet, hostPresent = true, hostReturns = undefined }) => {
  const proto = ArchiveWorkspaceRegistry.prototype
  const fake = Object.create(proto)
  const registry = { archivedSessionIds: [...archiveSet] }
  if (hostPresent) registry.unarchiveSession = async () => hostReturns
  fake.registry = registry
  fake.ctx = { logger: { warn: () => {} } }
  fake.bridge = { checkWorkspace: () => {} }
  fake.reconcileArchiveLedger = async () => {}
  fake.enqueueOperation = (fn) => fn()
  fake.sessionKnown = async () => true
  fake.requireState = () => ({ workspaceIds: [], archivedSessionIds: [...registry.archivedSessionIds] })
  fake.setState = async (next) => { registry.archivedSessionIds = [...next.archivedSessionIds] }
  fake.ensureArchivedAtLoaded = async () => {}
  fake.archivedAtMap = new Map([['s1', 1]])
  fake.saveArchivedAt = async () => {}
  return { fake, registry, run: () => proto.unarchiveSession.call(fake, 's1') }
}
const isArchiveSetResult = (r) => Array.isArray(r && r.archivedSessionIds) && r.archivedSessionIds.every((x) => typeof x === 'string')

test('恢复归档：门面不认宿主的返回值，两条分支同一个形状', async () => {
  // ① 官方契约 Promise<void>（宿主返回 undefined）—— 此前正是这里透传出去把 op 层炸掉的
  const native = unarchiveHarness({ archiveSet: ['s1', 's2'] })
  assert.ok(isArchiveSetResult(await native.run()), '宿主什么都不回时也要给出归档集合')

  // ② 宿主没有原生入口 → 自持分支。形状必须一模一样：两条分支给出不同形状就是崩溃来源
  const own = unarchiveHarness({ archiveSet: ['s1', 's2'], hostPresent: false })
  assert.ok(isArchiveSetResult(await own.run()))
  assert.deepEqual(own.registry.archivedSessionIds, ['s2'], '自持分支要真的把这条移出去')

  // ③ 权威集合读成非数组 → 宁可报空集也不能抛（恢复已经成功了）
  const broken = unarchiveHarness({ archiveSet: ['s1'] })
  broken.registry.archivedSessionIds = undefined
  assert.deepEqual(await broken.run(), { archivedSessionIds: [] })
})

test('history-unarchive 不得依赖注册表的返回值', async () => {
  const res = await buildSessionOps(archiveOpsDeps({ unarchiveSession: async () => undefined }))['history-unarchive']({ sessionId: 's1' })
  assert.equal(res.ok, true, '注册表什么都不回时，恢复成功必须报成成功')
  assert.equal(res.sessionId, 's1', '回执要带目标 id（审计流水按它记）')
  assert.equal(res.archivedSessionIds, undefined, '不把整个归档集合快照发给界面（界面根本不读）')
})

// 用户 2026-10-12 报障：工作区文件夹早删了，界面还在给「重新登记」。
// 根因是 canRegister 曾经写成「宿主 sessionPaths 命中 || 目录存在」—— 宿主索引里残留
// 已删目录的 sessionId 时，前半条就把它放行了，界面于是给了一个注定失败的入口
// （宿主 registerWorkspace 的 realpath 会拒）。这条钉死：canRegister 只能来自「目录真的存在」。
test('分组：目录已被删除时不得给「重新登记」入口，且两种组都要标出目录已不存在', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hist-groups-'))
  try {
    const liveDir = join(root, 'live')
    mkdirSync(liveDir, { recursive: true })
    const deadDir = join(root, 'gone') // 故意不创建：模拟「文件夹已被删」
    const liveGoneDir = join(root, 'live-gone') // 同上，但它挂着一条活登记
    const domain = createHistoryDomain({
      // fake-ctx：effect 立即执行并 dispose（与 trash-retention 那边同一套写法）。
      ctx: { effect: (fn) => { const d = fn(); if (typeof d === 'function') d() }, get: () => undefined, logger: { warn() {} } },
      config: {
        archivedAtFile: join(root, 'a.json'),
        workspaceSnapshotFile: join(root, 'w.json'),
        historyRetentionPath: join(root, 'r.json'),
      },
      pluginRoot: root,
      message: (e) => String((e && e.message) || e),
    })
    const registry = {
      requireTable: () => new Map([
        ['w1', { id: 'w1', title: 'Live', path: liveDir, sessionIds: ['s-live'] }],
        // 活登记但文件夹已删：登记还在、目录没了，界面同样要出声。
        ['w2', { id: 'w2', title: 'LiveGone', path: liveGoneDir, sessionIds: ['s-livegone'] }],
      ]),
      requireState: () => ({ workspaceIds: ['w1', 'w2'], archivedSessionIds: [] }),
      workspaceSnapshot: async () => new Map(),
      // 关键：宿主索引里还挂着已删目录的 sessionId（canonical 命中那条老判据）。
      sessionPaths: new Map([['s-dead', deadDir]]),
      headers: new Map(),
    }
    const { groups } = await domain.buildHistoryGroups(registry, [
      { sessionId: 's-live', cwd: liveDir },
      { sessionId: 's-livegone', cwd: liveGoneDir },
      { sessionId: 's-dead', cwd: deadDir },
    ])
    const detached = groups.find((g) => g.kind === 'detached')
    assert.ok(detached, '目录已删的会话仍要能分组 —— 不然它在界面上凭空消失')
    assert.equal(detached.dirMissing, true, '目录已删必须标出来：界面靠这个字段给用户提示')
    assert.ok(!detached.canRegister, '目录已删不得给「重新登记」入口（宿主 realpath 本来就会拒，点了才报错等于骗人）')
    const liveGone = groups.find((g) => g.id === 'ws:w2')
    assert.equal(liveGone?.dirMissing, true, '活登记的文件夹被删也要标出来 —— 登记还在不代表目录还在')
    const liveOk = groups.find((g) => g.id === 'ws:w1')
    assert.ok(liveOk && !liveOk.dirMissing, '目录还在的活登记不得被误标')
    assert.ok(!liveOk.canRegister, '活登记本来就不需要「重新登记」入口')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 一份带思考 + 工具调用 + 工具结果的事件序列。工具内容里埋了会劈开轮次的行首标记。 */
const transcriptEvents = (toolOut = '1  export function f() {}') => [
  { type: 'user/message', data: { content: [{ type: 'text', text: '看下 a.ts' }] } },
  { type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: '思考内容：先读文件' },
    { type: 'tool-call', id: 'c1', name: 'fs_read', arguments: '{"path":"a.ts"}' },
    { type: 'text', text: '第 3 行少了括号' },
  ] } } },
  // 同一个调用的 log-only 事件：两处都收、按 call id 去重，只认一边会在某种宿主形状下丢光工具调用
  { type: 'tool/call', data: { callId: 'c1', name: 'fs_read', arguments: '{"path":"a.ts"}' } },
  { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: toolOut }] } } },
]

test('导出的正文只取 text 块，思考不混进来', () => {
  for (const mode of ['simple', 'tools', 'full']) {
    const assistant = extractExportTurns(transcriptEvents(), mode).find((t) => t.role === 'assistant')
    assert.equal(assistant.text, '第 3 行少了括号', `${mode} 档的正文不得含思考`)
  }
  assert.equal(extractExportTurns(transcriptEvents(), 'simple')[0].details.length, 0, '简洁档没有附加段')
  const details = extractExportTurns(transcriptEvents(), 'full').flatMap((t) => t.details)
  assert.ok(details.some((d) => d.text.includes('思考内容')), '最高档要带上思考')
  assert.equal(details.filter((d) => d.text.includes('{"path":"a.ts"}')).length, 1, '同一个调用不得既从块又从事件重复成段')
})

test('三档累进：中间档有工具、没有思考', () => {
  const details = extractExportTurns(transcriptEvents(), 'tools').flatMap((t) => t.details)
  assert.ok(details.some((d) => d.text.includes('{"path":"a.ts"}')), '中间档要带上工具调用')
  assert.ok(!details.some((d) => d.text.includes('思考内容')), '中间档不得含思考 —— 这一档存在的唯一理由')
  // 累进性：每一档的附加段都得是上一档的超集。破了就不是"多一档"，是三份互不包含的产物。
  const tiers = ['simple', 'tools', 'full'].map((m) => extractExportTurns(transcriptEvents(), m).flatMap((t) => t.details).map((d) => d.text))
  assert.ok(tiers[0].every((x) => tiers[1].includes(x)), 'simple ⊆ tools')
  assert.ok(tiers[1].every((x) => tiers[2].includes(x)), 'tools ⊆ full')
})

test('详细档的附加段不会伪装成说话人边界（markdown 回流）', () => {
  // 工具结果里埋 ## User 与 **Assistant:** —— 不缩进就会在再导入时把一轮劈成几轮。
  const events = transcriptEvents('1  line\n## User\n**Assistant:** 都想冒充一次\n')
  const simple = parseMarkdownTranscript(serializeTranscript(extractExportTurns(events, 'simple'), 'markdown'))
  assert.equal(simple.length, 2, '前置条件：这份事件序列是两轮')
  for (const mode of ['tools', 'full']) {
    const back = parseMarkdownTranscript(serializeTranscript(extractExportTurns(events, mode), 'markdown'))
    assert.deepEqual(back.map((t) => t.role), simple.map((t) => t.role), `${mode} 档回流的轮次角色必须与简洁档一致`)
    assert.equal(back.length, simple.length, `${mode} 档的附加段不得新增轮次`)
  }
})

test('工具结果按上限截断，并如实报出原文总长', () => {
  const huge = 'X'.repeat(50000)
  const out = extractExportTurns(transcriptEvents(huge), 'full').flatMap((t) => t.details).find((d) => d.text.startsWith('XXXX'))
  assert.ok(out, '这条工具结果要在')
  assert.ok(out.text.length < 2500, `输出必须被压到上限附近，实收 ${out.text.length}`)
  assert.match(out.text, /50000/, '且要说清原文到底多长')
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

test('删除保护：场景绑定与「当前应用的」拦得住，播种出来的副本必须放行', async () => {
  // 用户 2026-10-10：「当前应用的提示词如果直接删除，~/.dsh/AGENTS.md 还存在，当前应用的
  // 提示词应该不能删除」。删掉之后文件内容一字不变、**照旧生效**，但界面上再没有预设对应它 ——
  // 用户看到的是「我删了，怎么全局提示词还在？」。所以拦住，并引导先「取消应用」。
  //
  // 同时钉住**另一头**：播种出来的副本（内容与 AGENTS.md 相同、却从未被「应用」过）必须放行。
  // 拦它就是死路 —— 那份没有「应用前的状态」可撤销，取消应用也关不掉，出路文案会变成空头支票。
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
      promptRefReason: (ref) => (ref.kind === 'scene' ? `场景「${ref.label || ''}」绑定了它` : (ref.applied === true ? '它正被「应用」在 ~/.dsh/AGENTS.md 里' : '~/.dsh/AGENTS.md 当前内容就是它')),
      warn: () => {},
    }
    return { removed, ops: buildPromptOps(deps) }
  }

  // ① 当前应用的（file + applied）→ 拦，且文案必须给出真的能用的出路
  const applied = build(new Map([['p1', [{ kind: 'file', applied: true }]]]))
  const refused = await applied.ops['agentsmd-remove']({ id: 'p1' })
  assert.equal(refused.ok, false, '当前应用的那份不能直接删')
  assert.equal(refused.code, 'error.agentsMd.referenced')
  assert.match(refused.error, /取消应用/, '出路要写出来 —— 它真的能解除（见 ② 的反向）')
  assert.deepEqual(applied.removed, [], '拒绝时绝不能真的删')

  // ② 播种出来的副本（file 但没有 applied）→ 必须放行
  const seeded = build(new Map([['p1', [{ kind: 'file', applied: false }]]]))
  assert.equal((await seeded.ops['agentsmd-remove']({ id: 'p1' })).ok, true, '播种副本必须删得掉（拦它无出路）')
  assert.deepEqual(seeded.removed, ['p1'])

  // ③ 反向：`restore` 照旧不拦（退出场景的恢复走快照里的正文，不读预设目录）
  const restoreOnly = build(new Map([['p1', [{ kind: 'restore' }]]]))
  assert.equal((await restoreOnly.ops['agentsmd-remove']({ id: 'p1' })).ok, true)

  // ④ 两类同时命中时，两条出路都要给出来
  const both = build(new Map([['p1', [{ kind: 'scene', scene: 's', label: 's', active: true }, { kind: 'file', applied: true }]]]))
  const two = await both.ops['agentsmd-remove']({ id: 'p1' })
  assert.equal(two.ok, false)
  assert.match(two.error, /退出场景/, '场景那条出路')
  assert.match(two.error, /取消应用/, '当前应用那条出路')
})

test('「应用前没有 AGENTS.md」必须被记下来，否则取消应用是条死路', async () => {
  // 破了会**静默出错**：`backupGlobal()` 一旦在文件不存在时什么都不写，"应用前没有这个文件"
  // 就不可恢复 —— 取消应用恒判 noBackup、永远关不掉；而界面给出的出路「删除这份预设」并不
  // 成立（`remove()` 只把预设目录移进回收站，一个字节都不碰 AGENTS.md）。用户按提示操作完，
  // 文件连内容都没变（2026-10-10 实测反馈：「取消应用，AGENTS.md 还是存在」）。
  //
  // 这里只钉两条语义边界，不钉文案、不钉备份文件名：
  //   ① 应用前不存在 → 取消应用**删掉文件**（= 真逆操作）；界面能提前知道（unapplyRemoves）。
  //   ② 应用前是**空文件**（0 字节）→ 只写回内容，**文件不删** ——「空文件」与「没有文件」是两件事。
  //   ③ 从没「应用」过 → 仍然拒绝，且理由是可分辨的 noBackup（不是一句写盘失败）。
  const root = mkdtempSync(join(tmpdir(), 'dsh-unapply-'))
  try {
    const globalPath = join(root, 'AGENTS.md')
    const svc = createPromptsService({}, { presetsDir: join(root, 'tool-management', 'prompts'), getGlobalAgentsMdPath: async () => globalPath })
    const read = () => { try { return readFileSync(globalPath, 'utf8') } catch { return null } }

    // ① 应用前文件不存在
    assert.equal(read(), null, '起点没有 AGENTS.md')
    await svc.create('甲', { content: '# 甲\n' })
    await svc.apply('甲')
    assert.equal(read(), '# 甲\n', '应用后写入预设正文')
    assert.equal((await svc.getCurrent()).unapplyRemoves, true, '界面必须能提前知道这一步会删文件')
    const removed = await svc.unapply()
    assert.equal(removed.ok, true, '取消应用必须走得通（此前恒判 noBackup）')
    assert.equal(removed.removed, true, '结果要如实说是删文件那一支')
    assert.equal(read(), null, '文件被删掉 —— 这才是"应用前的状态"')

    // ② 应用前是空文件：走写回内容那一支，文件不能消失
    writeFileSync(globalPath, '', 'utf8')
    await svc.apply('甲')
    assert.equal((await svc.getCurrent()).unapplyRemoves, false, '文件存在（哪怕 0 字节）→ 不是删文件那一支')
    const restored = await svc.unapply()
    assert.equal(restored.removed, undefined, '不删文件')
    assert.equal(read(), '', '内容写回空的，文件仍在')

    // ③ 从没应用过：拒绝，且文件一个字节都不动
    writeFileSync(globalPath, '# 手写\n', 'utf8')
    const never = createPromptsService({}, { presetsDir: join(root, 'never-applied'), getGlobalAgentsMdPath: async () => globalPath })
    const refused = await never.unapply()
    assert.equal(refused.ok, false)
    assert.equal(refused.noBackup, true, '没有应用记录时给 noBackup，界面才能说清出路')
    assert.equal(read(), '# 手写\n', '拒绝时文件不动')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('「取消应用」回到的是链起点而不是上一步：应用 a 再应用 b 之后仍能回到「没有文件」', async () => {
  // 破了会**静默出错**：`backupGlobal()` 若每写一笔都刷新起点槽位，第 ③ 步「应用 b」就会把
  // 第 ② 步记下的"起点不存在"刷成 a 的内容 —— 于是 ④「取消应用」把 a 的内容写进文件、a 的
  // 开关自己亮起来，两颗开关互相点亮、AGENTS.md 永远在，**回不到"没有文件"**。
  // 用户 2026-10-10 实测：「原本没有 AGENTS.md，新建 a 提示词和 b 提示词，启动 a，然后启动 b；
  // 不启动 a 也不启动 b，~/.dsh/AGENTS.md 没有消失」。
  //
  // 钉的是语义（一步回到起点 / 链结束后开关灭），不是文案与备份文件名：
  //   ① 起点没有文件 → a → b → 取消 = **删掉文件**（不是写回 a 的内容）；
  //   ② 链结束后没有起点可回（`unapplyAvailable === false`），再点一次被拒；
  //   ③ 起点有手写内容 → a → b → 取消 = 回到那份手写内容（不是"上一步" a 的内容）；
  //   ④ 链结束后的下一次应用 = 开一条**新链**，起点是当时的文件状态。
  const root = mkdtempSync(join(tmpdir(), 'dsh-chain-'))
  try {
    const globalPath = join(root, 'AGENTS.md')
    const svc = createPromptsService({}, { presetsDir: join(root, 'tool-management', 'prompts'), getGlobalAgentsMdPath: async () => globalPath })
    const read = () => { try { return readFileSync(globalPath, 'utf8') } catch { return null } }

    await svc.create('a', { content: '# a\n' })
    await svc.create('b', { content: '# b\n' })

    // ① 起点没有文件
    assert.equal(read(), null, '起点没有 AGENTS.md')
    await svc.apply('a')
    await svc.apply('b')
    assert.equal(read(), '# b\n', '应用 b 之后文件里是 b')
    assert.equal((await svc.getCurrent()).unapplyRemoves, true, '「起点不存在」必须一路留到链尾，不能被中间那笔覆盖')
    const back = await svc.unapply()
    assert.equal(back.ok, true)
    assert.equal(back.removed, true, '取消应用要删掉文件（起点不存在），而不是写回 a 的内容')
    assert.equal(read(), null, '一步回到「没有文件」—— 用户报的就是这条')

    // ② 链已结束
    const after = await svc.getCurrent()
    assert.equal(after.unapplyAvailable, false, '链结束后没有起点可回 → 开关该灭')
    assert.equal(after.lastApplied, null, '链结束后不再指向任何预设')
    const again = await svc.unapply()
    assert.equal(again.ok, false)
    assert.equal(again.noBackup, true, '再点一次要被拒，不能凭空回退')

    // ③ 起点有手写内容
    writeFileSync(globalPath, '# 手写\n', 'utf8')
    await svc.apply('a')
    await svc.apply('b')
    const back2 = await svc.unapply()
    assert.equal(back2.removed, undefined, '起点有内容 → 不删文件')
    assert.equal(read(), '# 手写\n', '回到链起点，而不是"上一步" a 的内容')

    // ④ 链结束后再应用 = 新链
    await svc.apply('a')
    await svc.unapply()
    assert.equal(read(), '# 手写\n', '新链的起点是上一次取消之后的文件状态')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

// ── 0.18.0：场景「启用集合 ↔ 当前模式」两轴恒等（服务端兜）────────────────────
//
// 为什么值得钉：破的时候是**静默**的 —— 面板开关亮了、`/` 里勾上了，档案里的 MCP / 技能
// 却没应用（用户 2026-10-01 实测：进不去也退不出，两个方向各坏一次）。这条不变量原本靠
// 每个调用方各开两枪维持，漏一个入口就坏一个入口，现在收到 `rules-set-active` 的包装层里，
// 所以钉包装层，不钉界面。
test('写启用集合必须先把运行时切到位；引擎拒绝时启用集合一个字都不写', async () => {
  const harness = ({ modeScene = null, engine = { ok: true, stale: [] }, base = { ok: true, activeMode: 'custom', scenes: [] } }) => {
    const calls = { mode: [], base: [], sync: 0 }
    const ops = buildSceneSyncOps({
      withAgentsMdSync: async (res) => { calls.sync += 1; return res },
      currentModeScene: async () => modeScene,
      sceneModeSet: async (args) => { calls.mode.push(args.scene); return engine },
      rulesOps: {
        'rules-set-active': async (args) => { calls.base.push(args); return base },
        'rules-update-scene': async () => ({ ok: true }),
        'rules-create-scene': async () => ({ ok: true }),
        'rules-remove-scene': async () => ({ ok: true }),
      },
    })
    return { op: ops['rules-set-active'], calls }
  }

  // 进入：先切运行时，再写启用集合。
  const enter = harness({ modeScene: null })
  assert.equal((await enter.op({ scenes: ['代码'] })).ok, true)
  assert.deepEqual(enter.calls.mode, ['代码'])
  assert.equal(enter.calls.base.length, 1)

  // 恒等时不重复切：面板与模型工具各开两枪，第二枪必须是空操作（否则一次点击应用两遍档案）。
  const same = harness({ modeScene: '代码' })
  await same.op({ scenes: ['代码'] })
  assert.deepEqual(same.calls.mode, [])
  assert.equal(same.calls.base.length, 1)

  // 退出：空集合 = 运行时回自由模式（引擎只落 mode，启用集合由这一步补齐）。
  const exit = harness({ modeScene: '代码' })
  await exit.op({ scenes: [] })
  assert.deepEqual(exit.calls.mode, [null])

  // 引擎拒绝（当前模式被锁 / 场景不存在 / 绑的工具表方案已删）→ 启用集合与 AGENTS.md 都不许动。
  // 这一条是本文件存在的理由：反过来（先写启用集合）留下的就是"开关过去了、运行时没切"。
  const denied = harness({ modeScene: '代码', engine: { ok: false, error: '场景「代码」已锁定：先解锁再关闭' } })
  assert.equal((await denied.op({ scenes: [] })).ok, false)
  assert.deepEqual(denied.calls.base, [])
  assert.equal(denied.calls.sync, 0)

  // 参数形态不归这层管：多场景 / `all` / 缺参一律不动运行时，交给原 op 校验并报错。
  for (const args of [{ scenes: ['A', 'B'] }, { all: true }, {}, { scenes: 'A' }]) {
    const h = harness({ modeScene: null })
    await h.op(args)
    assert.deepEqual(h.calls.mode, [], JSON.stringify(args))
    assert.equal(h.calls.base.length, 1, JSON.stringify(args))
  }

  // 保留名恒常生效：只勾「全局」与原 op 一样读成"清空"（同一份常量，不是各抄一套）。
  const reserved = harness({ modeScene: '代码' })
  await reserved.op({ scenes: [GLOBAL_SCENE, SHARED_GROUP] })
  assert.deepEqual(reserved.calls.mode, [null])

  // 引擎跳过的档案键要随回执出去，否则"进了，但没全进"是静默的。
  const stale = harness({ modeScene: null, engine: { ok: true, stale: ['已删的服务器'] } })
  assert.deepEqual((await stale.op({ scenes: ['代码'] })).modeStale, ['已删的服务器'])
})


// ── 0.19.1：客户端接口路径的静态对账（漏配 = 按钮点下去毫无反应）──────────────────
//
// 这一类漏配已经出现三次：`/source-remove` / `/source-restore` 漏过（42-shared-ui.js 里
// 留着前科注释），2026-10-10 又漏了 `/source-forget` —— 技能回收站「目录」那一块的批量
// 永久删除整批全灭，界面报「已删除 0 条来源记录，6 条失败：unknown action: /source-forget」。
//
// 症状之所以难查：`callApi` 对未知路径直接 `Promise.reject({ error: 'unknown action: …' })`，
// 而调用点大多 `.catch(swallowPostError)`，于是**没有类型错误、没有构建报错、没有日志**，
// 只有用户点下去的那一刻才知道。所以做成静态对账：用过的路径字面量集合 ⊆ 映射表键集合。
test('客户端用到的接口路径必须都在 OP_BY_PATH 里，否则调用点静默 reject', () => {
  const client = readFileSync('lib/client.js', 'utf8')
  // 注释里会引用这些路径（解释前科用），先剥掉注释再扫，否则说明文字会被当成调用点。
  const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const mapBlock = /var OP_BY_PATH = \{([\s\S]*?)\}/.exec(code)
  assert.ok(mapBlock, 'OP_BY_PATH 必须还在（定义在 42-shared-ui.js）')
  const mapped = new Set([...mapBlock[1].matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]))
  assert.ok(mapped.size > 5, '映射表没解析出来，只认出 ' + mapped.size + ' 条')
  // 调用点只认**字面量路径**（`callApi("/x"` / `post("/x"`）。写成变量（`callApi(path, …)`）
  // 会绕开这条检查 —— 所以新代码请写字面量路径，别把路径藏进变量。
  const used = new Set()
  for (const m of code.matchAll(/(?:callApi|post)\(\s*"(\/[^"]*)"/g)) used.add(m[1])
  assert.ok(used.size >= 8, '没扫到调用点，判据失效（只认出 ' + used.size + ' 条）')
  const missing = [...used].filter((p) => !mapped.has(p)).sort()
  assert.deepEqual(missing, [], '这些路径没进 OP_BY_PATH，点下去只会 reject("unknown action")：' + missing.join(', '))
})

// ── 0.19.1：记忆回收站必须与其它回收站同一套（用户 2026-10-10）────────────────────
//
// 用户报的两条：「记忆回收站没有全选」「样式和别的回收站不一样，应该统一」。此前记忆页
// 自己手写了一份回收站弹窗，于是它缺批量条、用的还是 `.dsm-trash-box` 那套旧结构。
// 这条钉住"它走共享 TrashModal"这个事实：破了就说明又有人把手写版搬回来了。
test('记忆回收站走共享 TrashModal（带批量删除），不再是一份手写弹窗', () => {
  const memRaw = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '47-memory.js'), 'utf8')
  // 剥掉注释再断言：注释里正解释着"以前用的是 .dsm-trash-box"，不该被当成代码。
  const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(memRaw)
  // 宿主页只负责开关弹窗：挂共享 TrashModal 并声明本页的域（domain = memories）。
  assert.match(src, /React\.createElement\(TrashModal, \{/, '记忆回收站必须用共享 TrashModal')
  assert.match(src, /domain: 'memories'/, '记忆回收站必须声明 domain = memories')
  // 反向：手写那套结构不得复活 —— 它有旧类名与"点一下开一个二次确认弹窗"的老路径。
  assert.ok(!src.includes('dsm-trash-box'), '不要再用旧的 .dsm-trash-box 手写列表')
  assert.ok(!src.includes("type: 'trash-delete'"), '二次确认已由共享组件行内处理，不要再挂独立弹窗')
  // 反向：清单 / 恢复 / 永久删除 / 批量都下沉进共享组件，宿主页不该再自己调这几个 op
  // （2026-10-12 改成域驱动：`onPurgeMany` / `onRestore` / `idOf` 这套回调 prop 已不存在）。
  assert.ok(!src.includes('rules-trash-list'), '清单读取已下沉进共享组件，宿主页不该再自己拉')
  assert.ok(!src.includes('rules-trash-remove'), '永久删除（含批量）已下沉进共享组件')

  // 共享组件侧：记忆域必须把两件事说全 —— 主键是 trashId、恢复/永久删除各走本页自己的 op。
  const shared = strip(readFileSync(join(import.meta.dirname, '..', 'src', 'client', '42-shared-ui.js'), 'utf8'))
  assert.match(shared, /idOf: function \(it\) \{ return it\.trashId \}/, '条目主键是 trashId，要靠 idOf 告诉共享组件')
  // 恢复走本页自己的 op，主键参数名 trashId。第二个参数 `dedupe` 是「撞名先问一句」确认过之后
  // 那一次（用户 2026-10-14）：第一次照旧发，服务端撞名就拒并回候选名字，用户点确认才带上它。
  assert.match(shared, /apiCall\('rules-restore', \{ trashId: it\.trashId, dedupe: dedupe === true \}\)/, '恢复走本页自己的 op（rules-restore）')
  assert.match(shared, /apiCall\('rules-trash-remove', \{ trashId: it\.trashId \}\)/, '永久删除走单条 op，参数名 trashId（批量由组件逐条循环）')
})

// 用户 2026-10-12 报障：技能回收站的「恢复 / 永久删除 / 全选」在场景锁定期间照常可点，
// 点下去才吃一个冻结错误 —— 而同一个弹窗里提示词 / 人设 / 记忆那几组都是灰的。
// 根因是 `GROUPS[*].frozen` 与 op-registry 的 `frozen` 标记分了家：技能与目录两组写着
// false，它们背后的四条 op 其实全都标着 frozen。
// 这条不看文案、只看数据：**每组的 frozen 必须等于它那几条 op 在 registry 里的 frozen**
//（全冻结 → 组冻结；一条都不冻 → 组不冻）。改一处忘了另一处，这里就红。
test('回收站各组的冻结标记必须与 op-registry 同源（界面灰不灰 == 服务端拒不拒）', () => {
  const shared = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '42-shared-ui.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // GROUPS 就写在 TrashModal 里、缩进八格；用同缩进的闭合括号切出每一组。
  const blockOf = (name) => {
    const start = shared.indexOf('\n        ' + name + ': {')
    assert.ok(start >= 0, name + ' 组必须还在 GROUPS 里（组名是 TRASH_DOMAINS 的引用键）')
    const end = shared.indexOf('\n        },', start)
    assert.ok(end > start, name + ' 组的闭合括号找不到 —— 解析器要跟着改')
    return shared.slice(start, end)
  }
  for (const name of ['presets', 'quick', 'skills', 'dirs', 'agents', 'scenes', 'memories']) {
    const block = blockOf(name)
    const declared = /frozen:\s*(true|false)/.exec(block)
    assert.ok(declared, name + ' 组必须显式写 frozen（缺省等于不冻，是踩过的坑）')
    // 这一组真正会调的写 op：restore / purge 两条（`reload` 是只读的 skill-state，不计）。
    const ops = [...block.matchAll(/apiCall\('([a-z0-9-]+)'/g)].map((m) => m[1])
    assert.ok(ops.length > 0, name + ' 组必须至少有一条写 op')
    const expectFrozen = ops.every((op) => OP_REGISTRY[op] && OP_REGISTRY[op].frozen === true)
    assert.equal(declared[1] === 'true', expectFrozen,
      name + ' 组的 frozen 与 op-registry 对不上：'
      + ops.map((op) => op + '=' + (OP_REGISTRY[op] && OP_REGISTRY[op].frozen === true)).join(' '))
  }
})

// ── 回收站「详情」与「永久删除来源记录」（用户 2026-10-12 第四轮）────────────────────────
//
// 两件事的共同点是"界面画的与服务端做的必须是同一件事"：
//   · 详情是**只读**预览，所以它必须在场景锁定时照样可用（锁的是写，不是看）；
//   · 永久删除要真的删得掉 —— codex / claude 这类来源路径每次启动都会重新推导出来，
//     只从 removedSources 里摘掉的话下一轮它又回来了，那颗按钮就成了假的。

test('回收站「详情」：只读预览不得受冻结影响，目录组不读盘，详情键永不置灰', () => {
  const shared = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '42-shared-ui.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // ① `trash-preview` 必须是只读 op，且不在冻结清单里 —— 否则锁定态下点「详情」会被服务端拒。
  assert.equal(OP_REGISTRY['trash-preview'] && OP_REGISTRY['trash-preview'].readonly, true,
    'trash-preview 必须登记为只读（详情是看，不是改）')
  assert.ok(!frozenOps().includes('trash-preview'), '只读的详情 op 不得进冻结清单')
  assert.ok(shared.includes("apiCall('trash-preview'"), '负载类条目的详情必须打 trash-preview')
  // ② 参数名：每条记录的"身份"各域不同，必须走 idOfOf 换算，且 domain 传组 id。
  assert.match(shared, /apiCall\('trash-preview', \{ domain: g\.id, id: id \}\)/,
    'trash-preview 的 domain 必须是组 id、id 必须经 idOfOf 换算')
  // ③ 目录组**不读盘**：这条记录本来就只是「不再读取」，磁盘上什么都没动 ——
  //    去读那个目录等于把用户的 ~/.codex 整个列到界面上，那是另一个功能。
  const dirsStart = shared.indexOf('\n        dirs: {')
  const dirsBlock = shared.slice(dirsStart, shared.indexOf('\n        },', dirsStart))
  assert.ok(/previewMeta:\s*function/.test(dirsBlock), '目录组必须走 previewMeta（来源信息表），不读盘')
  assert.ok(!dirsBlock.includes('trash-preview'), '目录组不得去打 trash-preview')
  // ④ 「详情」键是**看**：锁定态下恢复 / 永久删除都灰了，这一颗必须还亮着。
  const peek = /React\.createElement\('button', \{ key: 'peek'[^}]*\}/.exec(shared)
  assert.ok(peek, '「详情」行内键必须还在（用户要求回收站每条信息都有详情）')
  assert.ok(!/disabled/.test(peek[0]), '「详情」不得写 disabled —— 它是看不是改，锁定态下也要能点')
})

test('永久删除来源记录：连「已移除」那行都不留，默认来源拒之门外，磁盘一个字节不动', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-forget-'))
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
    const codex = userRoots().find((r) => r.key === 'codex')
    assert.ok(codex, 'codex 来源必须还在（这条测试的靶子）')
    // 目录里放一份技能，用来证明"永久删除之后它真的不再被读取"。
    mkdirSync(join(codex.path, 'demo'), { recursive: true })
    writeFileSync(join(codex.path, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: x\n---\n\n正文\n')
    const onDisk = readFileSync(join(codex.path, 'demo', 'SKILL.md'), 'utf8')

    const keys = async () => (await state({ projectCwds: [] })).roots.map((r) => r.key)
    assert.ok((await keys()).includes('codex'), '未移除时 codex 必须在来源列表里')

    // ① 先「移除来源」：仍然留一行（供「恢复读取」），但不再扫描。
    await setSourceRemoved(codex, true, undefined)
    let snapshot = await state({ projectCwds: [] })
    const removedRow = snapshot.roots.find((r) => r.key === 'codex')
    assert.ok(removedRow && removedRow.removed === true, '移除后必须还留一行，否则界面无从提供「恢复读取」')
    assert.equal(removedRow.removable, true, 'codex 本来就是 removable —— 回收站里那颗「永久删除」的依据')
    assert.deepEqual(removedRow.skills, [], '已移除的来源不得再扫描出技能')

    // ② 永久删除：连行都不留 —— 这正是用户要的那件事（否则那颗键是假按钮）。
    const res = await forgetSource('codex', undefined)
    assert.notEqual(res && res.ok, false, '永久删除一条按约定发现的来源必须成功')
    assert.ok(!(await keys()).includes('codex'), '永久删除后不得再列出这条来源（连"已移除"那行也不留）')
    const candidates = await listProviderCandidates({})
    assert.ok(!candidates.some((c) => c.locator && c.locator.rootKey === 'codex'),
      '永久删除的来源不得再进 provider 候选（模型侧也不能拿到）')

    // ③ 磁盘一个字节不动：这是"删记录"，不是"删文件"。
    assert.equal(readFileSync(join(codex.path, 'demo', 'SKILL.md'), 'utf8'), onDisk, '源文件不得被改动')

    // ④ 默认来源必须拒（它们必须读取，从来不在移除候选里）；未知来源同样拒。
    for (const key of ['dsh', 'hub']) {
      const bad = await forgetSource(key, undefined)
      assert.equal(bad && bad.ok, false, key + ' 是默认来源，不得永久删除')
    }
    assert.equal((await forgetSource('no-such-root', undefined)).ok, false, '未知来源必须拒')

    // ⑤ 两条 op 在门禁上同权：都是写、都冻结（界面灰不灰 == 服务端拒不拒）。
    for (const op of ['skill-custom-remove', 'skill-source-forget']) {
      assert.equal(OP_REGISTRY[op] && OP_REGISTRY[op].serviceWrite, true, op + ' 必须是 serviceWrite')
      assert.equal(OP_REGISTRY[op] && OP_REGISTRY[op].frozen, true, op + ' 必须冻结')
    }
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('回收站负载只读预览：清单不进详情、二进制不硬转文本、链接不跟随', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-peek-'))
  try {
    writeFileSync(join(dir, 'manifest.json'), '{"内部":"清单，不是用户删掉的那份东西"}')
    writeFileSync(join(dir, 'body.md'), '# 正文\n')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'inside')
    // 指向目录外的链接：详情**不得**跟着它把根外的文件读出来。
    const outside = join(dir, '..', 'outside-secret.txt')
    writeFileSync(outside, 'SECRET')
    let linked = true
    try { symlinkSync(outside, join(dir, 'link.txt'), 'file') } catch { linked = false }

    const files = await readTrashPayloadFiles(dir)
    const paths = files.map((f) => f.path)
    assert.ok(!paths.includes('manifest.json'), '清单文件不进详情')
    assert.ok(paths.includes('body.md') && paths.includes('sub/inner.txt'), '正文与嵌套负载都要在')
    const blob = files.find((f) => f.path === 'blob.bin')
    assert.equal(blob && blob.binary, true, '含 NUL 的文件必须标成二进制')
    assert.equal(blob && blob.text, undefined, '二进制不得硬转成文本')
    if (linked) assert.ok(!paths.includes('link.txt'), '符号链接不得被跟随（根外的文件不许读出来）')
    assert.equal(readFileSync(outside, 'utf8'), 'SECRET', '只读预览不得改动任何文件')
    rmSync(outside, { force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op 登记表里的每一条都必须真被接上（只登记不接线 = 界面撞 unknown action）', () => {
  // 反例（2026-10-12 实际发生）：`trash-preview` 只写进了 op-registry，memories service 的
  // ops 表漏了它 —— 于是「回收站 → 详情」点下去撞一个 unknown action，而启动期那条
  // `auditOpRegistry` 对账只是往兼容页挂一条**降级提示**，不会拦住这次发布。
  // 这条测试把"登记了就得有人接"钉死在构建期。
  const root = join(import.meta.dirname, '..', 'src')
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      // `src/client` 不算证据：那里是**调用方**，写着 op 名字只说明界面会打这个请求，
      // 完全可能压根没有 handler（正是这条测试要抓的形状）。
      if (e.isDirectory()) { if (e.name !== 'client') walk(p) }
      else if (/\.(ts|js|mjs)$/.test(e.name) && e.name !== 'op-registry.ts') files.push(p)
    }
  }
  walk(root)
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const missing = Object.keys(OP_REGISTRY).filter((op) =>
    !corpus.includes("'" + op + "'") && !corpus.includes('"' + op + '"'))
  assert.deepEqual(missing, [],
    '这些 op 只登记在 op-registry 里、没有任何一处接上（点下去只会 reject）：' + missing.join(', '))
})

test('回收站详情：技能条目名走「安全路径段」，hub / 记忆条目名走严格白名单', async () => {
  // 靶心：技能回收站的条目名是 `${Date.now()}-${randomUUID()}`（多段连字符），**不满足**
  // hub 那套 `^[a-z0-9]+-[a-z0-9]{1,32}$`。统一用白名单判的话，每一条技能条目都会被判成
  // "不存在" —— 界面上就是「详情」点下去弹一句"回收站条目不存在"，而且只有技能这一域坏。
  const home = mkdtempSync(join(tmpdir(), 'dsh-peek-id-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const stateDir = join(home, 'state')
    const skillsTrashDir = join(home, 'tool-management', 'trash', 'skills-trash')
    const ops = buildTrashOps({ stateDir, skillsTrashDir })

    // ① 技能域：真实形状的条目名必须能查到详情，清单文件不进结果。
    const skillId = '1760000000000-3f2a1b4c-5d6e-4f70-8a91-2b3c4d5e6f70'
    mkdirSync(join(skillsTrashDir, skillId), { recursive: true })
    writeFileSync(join(skillsTrashDir, skillId, 'SKILL.md'), '# 技能正文\n')
    writeFileSync(join(skillsTrashDir, skillId, 'metadata.json'), '{"name":"demo"}')
    const skill = await ops.trashPreview({ domain: 'skills', id: skillId })
    assert.equal(skill.ok, true, '技能条目必须能查详情：' + skill.error)
    assert.deepEqual(skill.files.map((f) => f.path), ['SKILL.md'], '清单（metadata.json）不进详情')

    // ② 穿越名一律拒（临时目录也不放行：`listTrash()` 本来就不列它们）。
    for (const bad of ['..', '../x', 'a/b', '.stage-abc', '', 'a\b']) {
      const res = await ops.trashPreview({ domain: 'skills', id: bad })
      assert.equal(res.ok, false, '技能域的非法 id 必须拒：' + JSON.stringify(bad))
    }

    // ③ 记忆域：条目名由 `newTrashId()` 生成，严格白名单照旧 —— 两套判据不能互相放松。
    const memId = 'lz8k3f-a1b2c3d4'
    const memDir = join(stateDir, MEMORIES_TRASH_DIR, memId)
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'rule.md'), '记忆正文')
    const mem = await ops.trashPreview({ domain: 'memories', id: memId })
    assert.equal(mem.ok, true, '记忆条目必须能查详情：' + mem.error)
    assert.deepEqual(mem.files.map((f) => f.path), ['rule.md'])
    assert.equal((await ops.trashPreview({ domain: 'memories', id: skillId })).ok, false,
      '记忆域不认多段连字符的 id（两套判据不得混用）')

    // ④ 目录组没有负载可查：明确拒（界面那边走 previewMeta，本来就不会打过来）。
    assert.equal((await ops.trashPreview({ domain: 'dirs', id: memId })).ok, false, '目录组不支持详情')
    // ⑤ 条目目录不存在 = 死链，必须报错而不是回一份空列表。
    assert.equal((await ops.trashPreview({ domain: 'skills', id: '1760000000000-deadbeef' })).ok, false,
      '目录不存在必须报「条目不存在」，不能回空 files（那会被界面说成"没有可显示的文件"）')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 令牌横幅「前往」键（2026-10-12）─────────────────────────────────────────────
//
// 这一条**只钉可点性，不钉配色**。用户同一次提了两件事：改黄底黄字（视觉，改一句 CSS
// 就会变，属本文件开头声明"明确不测"的排版类）+ 修两个点击 bug（行为，坏了是静默的）。
// 前者交给眼睛和用户裁定，后者必须钉住 —— 否则下次重构把 no-drag 抹掉，表现只是
// "这颗键时灵时不灵"，没有任何报错。
test('令牌横幅那颗键压在宿主标题栏拖拽区上：两颗键必须自己声明 no-drag', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '10-css.js'), 'utf8')
  const ruleOf = (selector) => {
    const i = css.indexOf(selector + '{')
    assert.ok(i >= 0, '找不到 CSS 规则：' + selector)
    return css.slice(i, css.indexOf('}', i) + 1)
  }
  // 先钉住前提：横幅是 fixed 顶部居中的"穿透"说明条，这正是它落进拖拽区的原因。
  // 哪天横幅挪到别处了，这条测试的前提就没了 —— 那时应当重判，而不是留着一条
  // 替不存在的问题站岗的断言。
  const banner = ruleOf('.dsm-token-banner')
  assert.match(banner, /position:fixed/, '前提变了：横幅不再是 fixed 的浮层')
  assert.match(banner, /top:12px/, '前提变了：横幅不再压在窗口顶部，拖拽区那条理由要重判')
  assert.match(banner, /pointer-events:none/, '前提变了：横幅不再是"只说明、不挡路"的穿透层')
  // 拖拽区（-webkit-app-region:drag）是按**布局矩形**算的，与谁画在上面无关：宿主把
  // 标题栏那一横条做成了拖拽区，横幅里两颗键的上半截就落进去 —— 按下去是拖窗口，
  // 只有露在拖拽区外的下半截真的点到按钮（用户原话："这个按钮只能点击下半部分"）。
  // 键必须逐颗写 no-drag：横幅其余部分是 pointer-events:none，只在键上声明才不会
  // 把整条横幅变成"拖不动窗口"的洞。
  for (const selector of ['.dsm-token-banner-go', '.dsm-token-banner-close']) {
    const rule = ruleOf(selector)
    assert.match(rule, /pointer-events:auto/, selector + ' 必须自己拿回 pointer-events（父级是 none）')
    assert.match(rule, /-webkit-app-region:no-drag/,
      selector + ' 必须声明 -webkit-app-region:no-drag —— 否则压在标题栏拖拽区上只有下半截能点')
  }
})

test('横幅「填写令牌」走自包含弹窗：填对自动关，拿不到 react-dom 时也不得静默', () => {
  const strip = (file) => readFileSync(join(import.meta.dirname, '..', 'src', 'client', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const helpers = strip('20-helpers.js')
  const applyHead = strip('40-apply-head.js')
  const shared = strip('42-shared-ui.js')
  const mcp = strip('41-mcp.js')
  const compat = strip('22-compat-page.js')

  // ① 横幅那颗键开弹窗，不再跳页。用户 2026-10-12 的裁定：跳页要求设置面板已经挂载
  //    （`navigateToTab` 只在 ToolsSection 挂载时才有值），而横幅在**任何**页面都会出现 ——
  //    一个自包含的输入框把整条依赖去掉，不必再去认领宿主的设置导航行。
  assert.ok(applyHead.includes('openTokenDialog()'), '横幅那颗键必须开填写弹窗')
  assert.ok(!/addEventListener\('click', function \(\) \{ openTokenPanel\(\) \}\)/.test(applyHead),
    '横幅不得再走"跳兼容页" —— 从对话页点它时设置面板往往根本没开')
  assert.ok(applyHead.includes("t('token.jump')"), '键文案 = 「填写令牌」（token.jump）')

  // ② 弹窗本体：输入 → 交给本进程 → 问宿主 → 认可就关。
  const dlg = /function TokenUnlockDialog\(props\)\s*\{([\s\S]*?)\n    \}/.exec(shared)
  assert.ok(dlg, 'TokenUnlockDialog 必须还在（横幅那颗键的落点）')
  const body = dlg[1]
  assert.ok(body.includes('setAccessToken('), '必须先把握在手里的令牌交给本进程（与兼容页 saveToken 同序）')
  assert.ok(body.includes("apiCall('token-status'"), '必须问宿主认不认这串')
  assert.match(body, /if \(r\.accepted === true\) \{ props\.onClose\(\); return \}/,
    '宿主认可就必须**自动关闭** —— 用户提这个方案时的原话就是"输入正确后自动关闭弹窗"')
  assert.ok(body.includes('applyTokenStatusSideEffects('),
    '锁态/提示的口径必须与兼容页同源，不得在这里另判一遍')
  assert.ok(!/setTokenLock\(/.test(body), '这里不得自己判锁态（判据只有 applyTokenStatusSideEffects 一处）')
  assert.ok(body.includes("e.key === 'Enter'"), '回车 = 解锁（与兼容页解锁面板同一口径）')
  assert.ok(body.includes('h(Modal'), '复用共享 Modal：遮罩 / 焦点陷阱 / Esc 不该再手写一份')

  // ③ 建根失败必须退回跳转，不能静默 —— 2026-10-12 那个 bug 的教训就是"点了没反应"。
  const open = /const openTokenDialog = function \(\)\s*\{([\s\S]*?)\n        \}/.exec(applyHead)
  assert.ok(open, 'openTokenDialog 必须还在')
  assert.ok(open[1].includes("require('react-dom/client')"),
    '用宿主 ModuleLoader 的 react-dom/client 建根（同生态的 dsh-better-sidebar 也是这么做的）')
  assert.ok(open[1].includes('openTokenPanel()'),
    '拿不到 react-dom 必须退回跳兼容页 —— 点一下必须有事发生')

  // ④ 判据唯一：兼容页那份也必须调它，而不是自己再抄一遍公式。
  //    抄两份的后果是同一个响应在两边判出不同结论，而这两个结论直接决定"能不能发消息"。
  assert.ok(compat.includes('applyTokenStatusSideEffects(r)'),
    '兼容页的 applyTokenState 必须共用同一份判据')
  assert.ok(!/setTokenLock\(r\.active === true/.test(compat),
    '兼容页不得再自己抄一遍锁态公式')

  // ⑤ 跳页那套必须拆干净：留着就是"两套机制并存"，下次改的人不知道该信哪条。
  for (const dead of ['clickOwnSettingsNav', 'pendingTab', 'setTokenPanelText', 'consumePendingTab']) {
    assert.ok(!helpers.includes(dead) && !mcp.includes(dead), '跳页方案的残留必须拆干净：' + dead)
  }
})

test('场景编辑页：令牌门禁那句话不得当成「场景名」的字段级错误再重复一遍', () => {
  const scenes = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '45-scenes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 保存失败时 `sceneForm.error` 会被塞进 `translateError(t, res)`，其中"缺少访问令牌，或令牌不对"
  // 属于门禁、不属于场景名：弹窗头部 TokenGateNotice 已经说了一遍（还带「填写令牌」），
  // 字段下面再来一次既是重复，又会顺手把名称框标成非法（用户 2026-10-12：「场景名下面的删除」）。
  assert.match(scenes, /var fieldError = isTokenGateText\(sceneForm\.error\) \? null : sceneForm\.error/,
    '字段级错误必须把令牌门禁那句滤掉（名称本身的校验错误照旧显示）')
  assert.ok(!/className: 'dsm-control' \+ \(sceneForm\.error \?/.test(scenes),
    '名称框的 invalid 态必须跟着 fieldError 走 —— 令牌没过不是"场景名填错了"')
  assert.ok(!/dsm-rule-hint' \}, sceneForm\.error\)/.test(scenes),
    '字段下面不得再直接渲染 sceneForm.error（否则那句门禁文案会回来）')
})

// ── 记忆行的量值与行内动作（2026-10-12 立，2026-10-16 用户改口径）─────────────────
test('记忆行：体积与附件走 nameAfter 槽且无边框，编辑/删除收进 ⋯ 菜单', () => {
  const strip = (file) => readFileSync(join(import.meta.dirname, '..', 'src', 'client', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const shared = strip('42-shared-ui.js')
  const memory = strip('47-memory.js')
  const dict = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '30-dict.js'), 'utf8')

  // ① 共享件要有一个"名称紧邻之后"的槽位，且位置在 name 与 tag 之间。
  //    不能借 tag 槽：tag 的契约是"至多 1 个需要处理的 tag"（状态类），体积是量值类，
  //    两者会同时出现（被覆盖 + 有体积），挤一个槽就丢一个。
  const listrow = /function ListRow\(props\)\s*\{([\s\S]*?)\n    \}/.exec(shared)
  assert.ok(listrow, 'ListRow 必须还在')
  assert.match(listrow[1], /props\.nameAfter/,
    'ListRow 必须有 nameAfter 槽（体积标签要挂在名称旁，不是挤在第二行的描述后面）')
  const nameRow = /dsm-listrow-name-row'[\s\S]*?props\.tag \|\| null\)/.exec(listrow[1])
  assert.ok(nameRow, '名称行必须还在')
  assert.ok(nameRow[0].indexOf('props.nameAfter') > nameRow[0].indexOf('props.name'),
    'nameAfter 必须排在名称**之后**')
  assert.ok(nameRow[0].indexOf('props.tag') > nameRow[0].indexOf('props.nameAfter'),
    'nameAfter 必须排在 tag **之前**（体积贴名称，状态 tag 在后）')

  // ② 记忆行把体积交给这个槽。2026-10-16 用户第二轮裁定：它**不带边框** —— 一屏六条就是
  //    十二个描边胶囊、还跟卡头那些状态标签同形，读下来满眼都是"标签"。边框只留给状态。
  const row = /function renderRuleRow\(r, sceneActive\)\s*\{([\s\S]*?)\n          \}/.exec(memory)
  assert.ok(row, 'renderRuleRow 必须还在')
  assert.match(row[1], /nameAfter:[^\n]*sizeTag/, '体积必须走 nameAfter 槽（旁边再挂一枚附件标记也算，别退回第二行）')
  assert.match(row[1], /className:\s*'dsm-qty'/,
    '体积必须是 .dsm-qty（弱色等宽、无边框）—— 换回 .dsm-tag 就把边框加回来了')
  // 附件标记与体积同属"量值"，必须一起走 qtyBits（缺件时不留孤点）。0.21.2 起这一槽
  // 前面还挂着租约徽章（`leaseTag`），所以这里认的是「qtyBits 里含 sizeTag 与 attachNode」，
  // 而不是"qtyBits 的第一个实参恰好是 sizeTag"。
  const qty = /nameAfter:\s*qtyBits\(([^\n]*)\)/.exec(row[1])
  assert.ok(qty, 'nameAfter 必须由 qtyBits 拼（多个量值之间用分隔点，不能各自 createElement）')
  assert.match(qty[1], /sizeTag/, '体积必须在 qtyBits 里')
  assert.match(qty[1], /attachNode/, '附件标记必须在 qtyBits 里（缺件时不留孤点）')

  // ②b 行内只留开关这一颗常驻控件（用户 2026-10-16：「记忆看起来很乱」→ 选定收进 ⋯ 菜单）。
  //     红框删除是这一屏里最抢眼的东西，六行就是六个红框；它现在只是菜单里一行红字。
  assert.match(row[1], /actions:\s*\[React\.createElement\(RowMenu/, '编辑/删除必须收在 RowMenu 里')
  assert.ok(!/dsm-btn-danger/.test(row[1]), '记忆行不得再常驻 quiet-danger 按钮')
  assert.match(shared, /function RowMenu\(props\)/, 'RowMenu 必须是共享件（别的列表页要用同一颗）')
  assert.match(shared, /role: 'menu'/, '菜单要带 menu / menuitem 语义，不能只是一堆按钮')

  // ③ 「bundle」形态标签不再显示；但它**不能**因此被当成死键清掉：42 片回收站 / 导出
  //    里按 'memory.form.' + … **计算**取词，静态扫描看不见 —— 删掉键的后果是界面上
  //    直接显示 "memory.form.bundle" 这个原始键名，且没有任何报错。
  const metaBits = /var metaBits = \[([\s\S]*?)\n            \]/.exec(row[1])
  assert.ok(metaBits, 'metaBits 必须还在')
  assert.ok(!metaBits[1].includes('memory.form.bundle'), '记忆行不再显示「bundle」形态标签（用户裁定）')
  assert.ok(metaBits[1].includes('memory.form.flat') === false, '记忆行也不显示 flat（原本就没显示）')
  assert.match(shared, /t\('memory\.form\.' \+/, 'memory.form.* 仍在被计算键取词，两个键都必须保留')
  for (const key of ['memory.form.flat', 'memory.form.bundle']) {
    assert.ok(dict.includes('"' + key + '"'), '词典里不能少 ' + key + '（42 片按计算键取词，删了会显示原始键名）')
  }
})

// 用户 2026-10-14 第二轮：「先出现一个小弹窗，说明存在同名记忆/场景/……；选择确认后新建带
// （*）的记忆/场景……」。此前撞名是在提交那一刻**静默退号**（`测` → `测（1）`）—— 用户看着
// 输入框里写着「测」、磁盘上却叫「测（1）」，没有任何一处说过这件事。
//
// 这条钉的是**设计本身**，不是实现细节：撞名必须经过确认窗，退号只发生在用户点过确认之后；
// 认撞名靠错误码不靠文案；回执报最终名字不报原名。改名字/换写法都不该让它红。
test('同名一律先问一句：四个域的新建与恢复都要过确认窗，不许静默退号', () => {
  const clientDir = join(import.meta.dirname, '..', 'src', 'client')
  // 剥掉注释再断言：这几处注释里正解释着"以前是静默退号"，不该被当成代码。
  const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const read = (name) => strip(readFileSync(join(clientDir, name), 'utf8'))
  const shared = read('42-shared-ui.js')

  // ① 共用原语只有一份 —— 八个入口各抄一遍退号逻辑，必然有抄漏的那一个。
  assert.match(shared, /function uniqueName\(raw, taken, style\)/, '共享退号函数必须还在')
  assert.match(shared, /function DupNameDialog\(props\)/, '共享同名确认窗必须还在')
  // 两档写法：技能必须走 `-1`（技能条目名要过 KEBAB_RE，全角括号会被 toKebab 抹成 `-`），
  // 其余三域走全角括号。**这一条是能力，不是写法** —— 少一档就有某个域写出来一个磁盘不认的名字。
  assert.match(shared, /name \+ '-' \+ i/, '技能域退号必须用半角连字符（kebab 约束）')
  assert.match(shared, /name \+ '（' \+ i \+ '）'/, '其余三域退号必须用全角括号')
  // 占用表按 own property 判：直接取属性会把原型上的 constructor / toString 算成"已占用"，
  // 用户给记忆起名叫 `constructor` 就会被莫名退号。
  assert.match(shared, /Object\.prototype\.hasOwnProperty\.call\(taken, n\)/, '占用表必须按 own property 判')

  // ② 五个新建入口（记忆页 / 场景编辑器的记忆草稿 / 场景页 / 技能页 / 子智能体页）都得挂上
  //    确认窗，否则那一页又回到"名字被悄悄改掉"。不钉函数名与参数形状 —— 只钉"这一页有它"。
  for (const [file, label] of [
    ['47-memory.js', '记忆页'],
    ['45-scenes.js', '场景页（含场景编辑器的记忆草稿）'],
    ['43-skills.js', '技能页'],
    ['46-subagents.js', '子智能体页'],
  ]) {
    const src = read(file)
    assert.match(src, /DupNameDialog/, label + ' 必须渲染共享的同名确认窗（撞名不许静默退号）')
    assert.match(src, /uniqueName\(/, label + ' 退号必须走共享的 uniqueName')
  }

  // ③ 四个回收站组：恢复要能把"用户确认过了"这件事传下去（确认后的第二次调用），
  //    回执要报**最终名字**。
  for (const [group, op] of [
    ['skills', 'skill-trash-restore'], ['agents', 'subagent-trash-restore'],
    ['scenes', 'scene-trash-restore'], ['memories', 'rules-restore'],
  ]) {
    const at = shared.indexOf("apiCall('" + op + "', {")
    assert.ok(at >= 0, group + ' 组的恢复必须调本域自己的 op：' + op)
    assert.ok(shared.slice(at, at + 160).includes('dedupe'),
      group + ' 组的恢复必须能把 dedupe 传下去（用户点过确认才按退号的名字重发）')
  }
  for (const kind of ['skill', 'subagent', 'scene', 'memory']) {
    assert.ok(shared.includes("dupKind: 'dup.kind." + kind + "'"), '四个域都要声明 dupKind（弹窗里的名词）：' + kind)
  }
  assert.match(shared, /res\.renamed === true \? 'done\.restoredAs' : 'done\.restored'/,
    '退号恢复的回执必须用「已恢复为」，不能报回收站里那个原名')
  // 认撞名靠**错误码**，不是比文案（文案随语言与措辞变）。
  assert.match(shared, /res\.code === 'error\.dup\.conflict'/, '撞名判据是错误码 error.dup.conflict')
  // 批量恢复不弹窗（一次勾八条弹八个窗没人受得了），只有单条才弹。
  assert.match(shared, /items\.length === 1[^\n]*isDupConflict/, '只有单条恢复撞名才弹确认窗')
})

// 上一条的宿主侧：四个回收站恢复 op 必须「缺省撞名即拒、带 dedupe 才退号」，且拒的时候
// 连**候选名字**一起回 —— 少了它，弹窗只能说"有同名"，说不出"确认后会叫什么"，用户点确认
// 等于闭着眼睛改名字。
test('四个回收站恢复 op：缺省撞名即拒，带 dedupe 才退号，拒时回候选名字', () => {
  const srcDir = join(import.meta.dirname, '..', 'src')
  const read = (p) => readFileSync(join(srcDir, p), 'utf8')
  for (const [file, label] of [
    ['ops/trash.ts', '记忆'],
    ['ops/scene-records.ts', '场景'],
    ['skills/skill-trash.ts', '技能'],
    ['subagents/service.ts', '人设'],
  ]) {
    const src = read(file)
    // 四个域统一的错误码：界面按它认撞名。原先各用各的（技能 error.trash.conflict、
    // 记忆 error.rules.exists、场景借用 error.rules.invalidGroup、人设压根没有码），
    // 界面根本分不出"撞名"和"名字非法"。
    assert.match(src, /error\.dup\.conflict/, label + '回收站恢复撞名必须用统一错误码 error.dup.conflict')
    // 缺省必须是「拒」：`dedupe !== true` 这个判据要显式写出来。一个默认静默改名的恢复口，
    // 早晚会有人踩。
    assert.match(src, /dedupe !== true/, label + '回收站恢复缺省必须是「撞名即拒」')
    // 候选名字（`params.next`）—— 弹窗里那句"确认后会叫 X（1）"就是它。
    assert.match(src, /next/, label + '回收站恢复撞名必须回候选名字（params.next）')
  }
  // 技能域用 `-1` 而不是全角括号：技能条目名必须过 KEBAB_RE。
  assert.match(read('skills/skill-trash.ts'), /`\$\{name\}-\$\{i\}`/, '技能退号必须用半角连字符（kebab 约束）')
  // 三个"名字即文件名"的域用全角括号。
  for (const [file, label] of [['ops/trash.ts', '记忆'], ['ops/scene-records.ts', '场景'], ['subagents/service.ts', '人设']]) {
    assert.match(read(file), /`\$\{name\}（\$\{i\}）`/, label + '退号必须用全角括号')
  }
})

// 反向：**新建**那四条 op 一条都不许认 `dedupe`。模型工具（memory_manager_* / skill_manager_* /
// 子智能体 / 场景）靠"同名即拒"决定这次是新建还是更新 —— 给它们加一个自动改名开关，等于把
// 那条语义从根上改掉。界面侧的退号是本地算好名字再传下去的（见上两条测试），不碰 op。
test('四条新建 op 不许认 dedupe：模型工具靠"同名即拒"判断新建还是更新', () => {
  const srcDir = join(import.meta.dirname, '..', 'src')
  const read = (p) => readFileSync(join(srcDir, p), 'utf8')
  // 三条"撞名即拒"的必须还在。
  assert.match(read('ops/memory.ts'), /error\.rules\.exists/, '记忆新建撞名仍必须拒绝')
  assert.match(read('skills/core.ts'), /error\.create\.conflict/, '技能新建撞名仍必须拒绝')
  assert.match(read('subagents/service.ts'), /人设已存在/, '人设新建撞名仍必须拒绝')
  // 场景新建是**幂等 upsert**（已存在则更新描述/标签，不报错），模型工具依赖这条 ——
  // 所以它连撞名判据都不能有，界面那一步才只能自己查 `data.scenes`。
  const createScene = /async function rulesCreateScene\(args: any\)[\s\S]*?\n  \}/.exec(read('ops/scene-records.ts'))
  assert.ok(createScene, 'rulesCreateScene 必须还在（解析器要跟着改）')
  assert.ok(!createScene[0].includes('error.dup.conflict'),
    '新建场景必须保持幂等 upsert：不许加撞名拒绝，更不许退号')
  assert.ok(!createScene[0].includes('dedupe'), '新建场景不许认 dedupe')
})

// rules-attach 的落点断言：与 rules-detach 同一道 refuseOutsideRoot —— locateRule 只 lstat
// 正文末级，场景 / bundle 目录若是指向记忆根外的符号链接，附件就会写到根外。这里钉
// 「断言先于写盘、拒绝原样透传」：拒绝返回时根本走不到写盘那一步。
test('rules-attach：附件落点必须先过根内断言，拒绝时写盘一步都到不了', async () => {
  const asked = []
  const ops = buildMemoryOps({
    parseId: (id) => {
      const i = id.indexOf('/')
      return i > 0 && i < id.length - 1 ? { group: id.slice(0, i), name: id.slice(i + 1) } : null
    },
    locateRule: async (group, name) => ({
      id: `${group}/${name}`, group, name, kind: 'bundle',
      docPath: `/fake/${group}/${name}/${name}.md`, entryPath: `/fake/${group}/${name}`,
    }),
    refuseOutsideRoot: async (target) => {
      asked.push(target)
      return { ok: false, error: '拒绝操作：解析后的落点不在记忆根目录内', code: 'error.rules.outsideRoot' }
    },
    listAttachments: async () => [],
  })
  const res = await ops.rulesAttach({
    id: 's/bundle',
    files: [{ name: 'a.png', data: Buffer.from('x').toString('base64') }],
  })
  assert.equal(res.ok, false, '断言拒绝必须原样透传')
  assert.equal(res.code, 'error.rules.outsideRoot')
  assert.equal(asked.length, 1, '逐附件都要问一次断言')
  assert.ok(asked[0].endsWith('a.png'), '断言问的是附件的实际落点')
})

// ── 退号恢复必须改**声明名**，不能只改文件夹名 ────────────────────────────────
//
// 用户 2026-10-14 报的：同名技能退号恢复出 `1-1` 目录，但里面的 SKILL.md 仍写着 `name: 1`。
//
// 为什么这是 bug 而不是"显示问题"：技能的同名判定取的是 frontmatter 的 `name:`
// （`canonicalSkillName` = `declaredName || name`），**不是文件夹名** —— 技能页的同名分组、
// `preferredSkills` 首选表、喂给宿主的 provider 候选名，全都以它为准。于是恢复出来的那份
// 会跟原件被判成同名，技能页给它一颗「启用这个」；而那颗按钮写的是"用哪个**来源**"，
// 两份都在同一个来源目录里，按下去什么都不会变 —— 用户点完看到"已改为生效"，实际没有任何变化。
//
// 这条钉的是**不变量**：退号恢复之后，恢复出来的技能与原件不再是同名。
test('退号恢复技能：目录名与 frontmatter 的声明名必须一起改，且其余字节原样', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-restore-name-'))
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
    const hub = join(home, 'tool-management', 'skills')
    const docPath = (name) => join(hub, name, 'SKILL.md')
    // 文档里故意放三样"改名字不该碰"的东西：块标量、嵌套字段、正文。
    // 只要实现走的是"按当前模板重写一遍"，这三样里至少一样会被抹掉。
    const doc = (name) => `---\nname: ${name}\ndescription: |\n  原件简介\n  第二行\ndisable-model-invocation: true\nmetadata:\n  source: local\n---\n\n正文第一行\n正文第二行\n`
    mkdirSync(join(hub, 'demo'), { recursive: true })
    writeFileSync(docPath('demo'), doc('demo'))

    // 删进回收站 → 再建一个同名原件占住 `demo` 这个名字 → 恢复时必然撞名。
    const deleted = await deleteSkill(rootByKey('hub'), 'demo', undefined)
    assert.ok(deleted.id && deleted.name === 'demo', 'deleteSkill 应返回回收站条目（夹具前提）')
    assert.ok(!existsSync(docPath('demo')), '删除后目录应已移走')
    mkdirSync(join(hub, 'demo'), { recursive: true })
    writeFileSync(docPath('demo'), doc('demo'))

    // 缺省撞名即拒，并回候选名字（界面弹窗靠它写出"确认后会叫 demo-1"）。
    const rejected = await restoreTrash(deleted.id, undefined)
    assert.equal(rejected.ok, false, '缺省撞名必须拒绝，不许静默退号')
    assert.equal(rejected.code, 'error.dup.conflict', '撞名判据是错误码')
    assert.equal(rejected.params.next, 'demo-1', '拒的时候要把候选名字一起回')

    const restored = await restoreTrash(deleted.id, undefined, { dedupe: true })
    // 成功形状没有 `ok: true`（`TrashRestoreResult` 的 `ok` 是可选字段）—— 认成功看有没有
    // `error`，认落盘名看 `name`。
    assert.equal(restored.error, undefined, '带 dedupe 才退号恢复')
    assert.equal(restored.name, 'demo-1', '落盘名是退号后的名字')
    assert.equal(restored.renamed, true, '必须自报退过号（回执要用「已恢复为」）')

    // 核心断言：目录名与声明名一起改，其余字节逐字不变。
    const after = readFileSync(docPath('demo-1'), 'utf8')
    assert.match(after, /^name: demo-1$/m, '恢复出来的技能必须声明新名字 —— 否则它仍与原件同名')
    assert.equal(
      after.replace('name: demo-1', 'name: demo'),
      doc('demo'),
      '除了 name 那一行，块标量 / 嵌套字段 / 正文都必须逐字保留（恢复不是按模板重写）',
    )

    // 不变量：恢复之后两份不再是同名，谁都不该被标成"被同名覆盖"。
    const rows = (await state({ projectCwds: [] })).roots.flatMap((r) => r.skills.map((s) => ({ root: r.key, s })))
    for (const name of ['demo', 'demo-1']) {
      const row = rows.find((x) => x.root === 'hub' && x.s.name === name)
      assert.ok(row, '两份都必须在列表里：' + name)
      assert.equal(row.s.shadowedBy, undefined, name + ' 不该被判成同名覆盖（声明名已经不同了）')
    }
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 「启用这个」只服务于**跨来源**的同名之争 ──────────────────────────────────
//
// 用户 2026-10-14 的第二半句：「启动这个应该是不同文件夹的同名技能才有的功能」。
//
// `preferredSkills` 表按声明名索引、值是一个**来源 key** —— 它天生只能表达"用哪个来源的
// 副本"，表达不了"用这个文件夹而不是那个文件夹"。所以同一个来源目录里出现两份声明同名的
// 技能时（两个文件夹都写着 `name: X`），那颗「启用这个」按下去什么都不会变，却会回一句
// "已改为生效" —— 技能页把它摆在两份同名之间，用户只能自己发现这是假按钮。
//
// 判据必须是**数据里能读出来的**，不能靠界面猜：`shadowedBy.root === 本行来源 key`
// ⟺ 撞名发生在这个来源目录内部。界面按它收掉按钮；跨来源时照旧给。
//
// 「被覆盖」这个标记**不收** —— 同来源里的落选那份确实不会被加载，如实说比不说好。
test('「启用这个」只给跨来源的同名：同一来源内部的撞名不得提供来源级动作', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shadow-scope-'))
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
    const put = (rootDir, folder, declared) => {
      mkdirSync(join(rootDir, folder), { recursive: true })
      writeFileSync(join(rootDir, folder, 'SKILL.md'), `---\nname: ${declared}\ndescription: ${folder}\n---\n\n${folder}\n`)
    }
    const hub = join(home, 'tool-management', 'skills')
    const dsh = join(home, 'skills')
    mkdirSync(hub, { recursive: true })
    mkdirSync(dsh, { recursive: true })
    // 同一来源（hub）里两份都声明 `dup`：这是目录自己的数据问题，不是"两份副本挑一份"。
    put(hub, 'dup', 'dup')
    put(hub, 'dup-1', 'dup')
    // 跨来源：hub 与 dsh 各一份声明 `cross`，这才是真正要挑来源的同名之争。
    put(hub, 'cross', 'cross')
    put(dsh, 'cross', 'cross')

    const snapshot = await state({ projectCwds: [] })
    const rows = snapshot.roots.flatMap((r) => r.skills.map((s) => ({ root: r.key, s })))
    const dupRows = rows.filter((x) => x.s.declaredName === 'dup')
    assert.equal(dupRows.length, 2, '同一来源里的两份同名都必须列出来')
    // 落选那份照样标"被覆盖"（它确实不会被加载），但标记必须**指回自己的来源**——
    // 界面就是靠这一点知道"这份没有别的来源可换"，从而不给那颗假按钮。
    const dupLoser = dupRows.find((x) => x.s.shadowedBy)
    assert.ok(dupLoser, '同一来源里的落选那份仍要标出"没被加载"（不许装作它生效了）')
    assert.equal(
      dupLoser.s.shadowedBy.root,
      dupLoser.root,
      '同来源内部撞名的 shadowedBy.root 必须等于本行来源 key —— 界面按这个判据收掉「启用这个」',
    )

    const crossRows = rows.filter((x) => x.s.declaredName === 'cross')
    assert.equal(crossRows.length, 2, '跨来源的两份都要列出')
    const crossLoser = crossRows.find((x) => x.s.shadowedBy)
    assert.ok(crossLoser, '跨来源必须有一份被覆盖')
    assert.notEqual(
      crossLoser.s.shadowedBy.root,
      crossLoser.root,
      '跨来源撞名的 shadowedBy.root 必须指向**另一个**来源 —— 这时「启用这个」才真的能换掉生效的那一份',
    )
    assert.equal(crossRows.filter((x) => x.s.winner === true).length, 1, '跨来源必须恰好一份是赢家')

    // 界面侧的同一件事：按钮挂在 `shadowedBy.root !== 本行来源` 上，不是挂在"有没有被覆盖"上。
    // 这里只钉判据，不钉函数名与 DOM 形状（改排版/改文案不该让它红）。
    const skills = readFileSync(join(import.meta.dirname, '..', 'src', 'client', '43-skills.js'), 'utf8')
    assert.match(
      skills.replace(/\/\*[\s\S]*?\*\//g, ''),
      /shadowedBy\.root !== root\.key/,
      '「启用这个」必须按"被覆盖的是不是别的来源"来决定给不给',
    )
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 技能状态：两份名单互斥，坏了要能自愈（用户 2026-10-14 实测被锁死）──────────
//
// 出事的那份文件：`disabledSkills.hub` 与 `enabledSkills.hub` **同时**含 `1-1`。
// 链路是「显式启用 → 删除 → 从回收站恢复」：删除不清策略，恢复又要默认停用，
// 于是同一个名字落进了两份名单。`validManagerStateDocument` 把这种文档整份判非法 →
// 插件 fail-closed 停用**所有**技能，而且 `writable` 一并变 false —— 界面上连一个
// 开关都按不动，用户被锁死在一份自己造不出来的状态里。
//
// 这条钉两件事：写入侧必须维护互斥（`markSkillsDisabled`），读取侧必须能自愈
// （`normalizeManagerState`），自愈方向取保守的一边（保留"关"、摘掉"开"）。
test('技能策略两份名单互斥：写入不制造冲突，读出能自愈且只往保守方向收敛', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-policy-mutex-'))
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
    const hub = join(home, 'tool-management', 'skills')
    mkdirSync(join(hub, 'demo'), { recursive: true })
    writeFileSync(join(hub, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: "x"\n---\n\nbody\n')

    // ① 写入侧：显式启用过 → 再被「默认停用」过一遍，两份名单不能同时含它。
    await setSkillEnabled(rootByKey('hub'), 'demo', true, undefined)
    const { markSkillsDisabled } = await import('../lib/skills/core.js')
    await markSkillsDisabled([{ root: 'hub', name: 'demo' }], undefined)
    const afterMark = await readManagerState()
    assert.equal(afterMark.writable, true, '默认停用之后状态文件必须仍是可读可写的')
    assert.deepEqual(afterMark.state.disabledSkills.hub, ['demo'], '默认停用应当落到 disabled')
    assert.deepEqual(
      afterMark.state.enabledSkills.hub || [],
      [],
      '名字进了 disabled 就必须从 enabled 摘掉 —— 两份名单互斥',
    )

    // ② 读取侧自愈：手写一份"两边都有"的坏文件，读出来必须救得回来，
    //    且收敛方向是"关着"（不得静默把技能打开并送进模型上下文）。
    writeFileSync(managerStatePath(home), `${JSON.stringify({
      version: 1,
      sources: {},
      disabledSkills: { hub: ['demo', 'stale'] },
      enabledSkills: { hub: ['demo'] },
      customRoots: [],
      preferredSkills: {},
      removedSources: [],
      forgottenSources: [],
    }, null, 2)}\n`)
    const healed = await readManagerState()
    assert.equal(healed.writable, true, '坏文件必须被自愈救回，不能 fail-closed 把所有技能锁死')
    assert.equal(healed.warning, null, '自愈不该留下"状态文件不可读"的横幅')
    assert.deepEqual(healed.state.enabledSkills.hub || [], [], '自愈要把冲突的名字从 enabled 摘掉')
    assert.deepEqual(healed.state.disabledSkills.hub, ['demo', 'stale'], '自愈保留 disabled（保守方向）')
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 会话作用域（0.21.2）──────────────────────────────────────────────────────
//
// 这一族只钉**纯函数不变量**：三态存储 / 二态展示的判定、自动清除的两个方向、
// 读不到的全局值不得拿来剪枝。界面与接线交给 `npm run build` 与真实使用。
test('会话覆盖的三态与自动清除：等于全局就是没有覆盖（写侧与读侧各判一次）', () => {
  // 侧车里的键表是**无原型对象**（防 `__proto__` 改写原型）；这里只比较内容，
  // 不用严格原型比较 —— 那个差异是实现细节，不是这条不变量要钉的东西。
  const plain = (v) => JSON.parse(JSON.stringify(v))
  // ① 键不存在 = 跟随全局；写入一个**等于全局**的值 → 不落条目（否则界面会有个永远
  //    与全局同值的蓝勾，用户看不出差别、也不知道自己点过一次本会话）。
  assert.equal(applyFlag(undefined, 'skills', 'dsh/a', false, false).scope, undefined, '写等于全局 → 不留覆盖')
  assert.deepEqual(plain(applyFlag(undefined, 'skills', 'dsh/a', true, false).scope), { skills: { 'dsh/a': true } }, '写不等于全局 → 留覆盖')

  // ② 已有覆盖，再写回全局值 → 当场清掉。
  assert.equal(applyFlag({ skills: { 'dsh/a': true } }, 'skills', 'dsh/a', false, false).scope, undefined, '写回全局值 → 清掉')

  // ③ 只清目标键，同域其余键保留。
  assert.deepEqual(
    plain(applyFlag({ skills: { 'dsh/a': true, 'dsh/b': true } }, 'skills', 'dsh/a', false, false).scope),
    { skills: { 'dsh/b': true } },
    '清一个键不得牵连同域其它键',
  )

  // ④ 场景是**模式**不是取值（0.21.2）：进入总是写 scene（与全局同名也留 —— 它是
  //    "按这个场景的档案走"，不是一个格的值）；进入时清掉七域的显式覆盖；退出换下层
  //    为基线（detached），覆盖一起清、锁保留。
  assert.deepEqual(plain(enterSceneInScope(undefined, 'web').scope), { scene: 'web' }, '进入场景：写 scene')
  assert.deepEqual(
    plain(enterSceneInScope({ skills: { 'dsh/a': true } }, 'web').scope),
    { scene: 'web' },
    '进入场景：清掉七域的显式覆盖',
  )
  assert.deepEqual(
    plain(exitSceneInScope({ scene: 'web', skills: { 'dsh/a': true }, locked: true }).scope),
    { detached: true, locked: true },
    '退出场景：换下层为基线，覆盖清掉、锁保留',
  )

  // ⑤ 读侧（pruneScope）：全局后来被改成与覆盖同值 → 那条覆盖视为不存在；
  //    **scene 不参与剪枝**（它是模式，与全局同名也保留）。
  const global = { scene: 'web', flags: { skills: { 'dsh/a': false }, subagents: {}, memory: {}, quickPrompts: {}, mcp: {}, mcpTools: {}, skillSources: {} } }
  assert.equal(pruneScope({ skills: { 'dsh/a': false } }, global), undefined, '僵尸覆盖（与全局同值）读时剪掉')
  assert.deepEqual(pruneScope({ skills: { 'dsh/a': true } }, global), { skills: { 'dsh/a': true } }, '与全局不同的覆盖保留')
  assert.deepEqual(pruneScope({ scene: 'web' }, global), { scene: 'web' }, '场景是模式：与全局同名也保留')
  assert.deepEqual(pruneScope({ scene: 'api' }, global), { scene: 'api' }, '场景不同 → 保留')

  // ⑥ 会话锁可以单独存在：只挂锁、还没有任何覆盖时，这条记录**不得**被当成空丢掉
  //    （丢了就等于"锁上之后自己解开"）。
  assert.deepEqual(
    plain(normalizeScopeOverrides({ sessions: { s1: { locked: true } } }).sessions.s1),
    { locked: true },
    '只有锁的会话记录必须保留',
  )
  assert.deepEqual(
    applyFlag({ locked: true }, 'skills', 'dsh/a', false, false).scope,
    { locked: true },
    '最后一个覆盖被清掉时锁要留着',
  )

  // ⑦ 全局读不到的那一域**不剪枝**：一次读盘失败不得把用户的设置静默删掉。
  const partial = { scene: null, flags: { skills: {}, subagents: {}, memory: {}, quickPrompts: {}, mcp: {} }, unavailable: ['skills'] }
  assert.deepEqual(
    pruneScope({ skills: { 'dsh/a': false } }, partial),
    { skills: { 'dsh/a': false } },
    '全局值读不到的域不得按"空快照"剪枝',
  )

  // ⑧ 坏输入一律夹掉，不抛：会话覆盖坏了最坏是回到全局，不该让面板或注入通道跟着挂。
  assert.deepEqual(plain(normalizeScopeOverrides(null)), { version: 1, mode: 'session', sessions: {} }, 'null → 空表 + 按会话')
  assert.equal(normalizeScopeMode('workspace'), 'workspace')
  assert.equal(normalizeScopeMode('nope'), 'session', '坏值退回按会话')
  assert.equal(normalizeScopeMode(undefined), 'session')
  assert.equal(plain(normalizeScopeOverrides({ mode: 'workspace' })).mode, 'workspace', '模式跟着侧车落盘')
  assert.equal(plain(normalizeScopeOverrides({ mode: 'nope' })).mode, 'session')
  assert.deepEqual(
    plain(normalizeScopeOverrides({ sessions: { s: { skills: { '': true, ok: 'yes', good: false } } } }).sessions.s),
    { skills: { good: false } },
    '非法键与非布尔值丢掉',
  )
  assert.deepEqual(plain(normalizeScopeOverrides({ sessions: { '': { scene: 'x' } } }).sessions), {}, '非法会话 id 丢掉')

  // ⑨ 覆盖条数（下拉框「N 项」）：scene 算一条、每个键算一条，locked 不算。
  assert.equal(overrideCountOf({ scene: 'web', skills: { a: true, b: false } }), 3, '条数口径')
  assert.equal(overrideCountOf(undefined), 0, '没有覆盖 = 0 项')

  // ⑩ 模型工具表按对话（0.21.2）：每个对话一份整名单，全局只给新对话当默认。
  //    判据三条：本对话 > 创建时基线 > 实时全局；空名单是有效值（"全都要"）。
  assert.deepEqual(
    sessionToolTableHidden({ toolTableHidden: ['a'], baseline: { toolTableHidden: ['b'] } }, ['c']),
    ['a'],
    '本对话那份赢过基线与全局',
  )
  assert.deepEqual(
    sessionToolTableHidden({ baseline: { toolTableHidden: ['b'] } }, ['c']),
    ['b'],
    '没单独设置时用创建时抄的那份（全局后来改了也不算）',
  )
  assert.deepEqual(sessionToolTableHidden(undefined, ['c']), ['c'], '没有基线的老会话退回全局')
  assert.deepEqual(sessionToolTableHidden({ toolTableHidden: [] }, ['c']), [], '空名单 = 本对话全都要')
  assert.equal(overrideCountOf({ toolTableHidden: ['a', 'b', 'c'] }), 1, '整份工具表算一条设置，不按名字个数膨胀')

  // 进出场景：进入**不碰**工具表（场景没绑方案时对话自己调过的那份得留着），
  // 退出回到基线（与其他开关同一条「退出到这个会话最开始的样子」）。
  assert.deepEqual(
    plain(enterSceneInScope({ toolTableHidden: ['a'] }, 'web').scope),
    { scene: 'web', toolTableHidden: ['a'] },
    '进入场景：没绑方案时本对话的工具表保持不变',
  )
  assert.deepEqual(
    plain(exitSceneInScope({ scene: 'web', toolTableHidden: ['a'], baseline: { toolTableHidden: ['b'] } }).scope),
    { detached: true, baseline: { toolTableHidden: ['b'] } },
    '退出场景：工具表回到创建时那份',
  )

  // 读侧剪枝：与基线同值（顺序无关）的显式名单不留；不同就留；没基线也留。
  const ttGlobal = { scene: null, flags: {} }
  assert.deepEqual(
    pruneScope({ toolTableHidden: ['a', 'b'], baseline: { toolTableHidden: ['b', 'a'] } }, ttGlobal),
    { baseline: { toolTableHidden: ['b', 'a'] } },
    '与基线同值的工具表读时剪掉',
  )
  assert.deepEqual(
    plain(pruneScope({ toolTableHidden: ['a'], baseline: { toolTableHidden: ['b'] } }, ttGlobal).toolTableHidden),
    ['a'],
    '与基线不同的工具表保留',
  )
  assert.deepEqual(
    plain(pruneScope({ toolTableHidden: [] }, ttGlobal).toolTableHidden),
    [],
    '没有基线时空名单也要留着（否则等于退回全局）',
  )

  // 落盘形状：坏名字夹掉、空名单留着、基线里那一份也要留着。
  assert.deepEqual(
    plain(normalizeScopeOverrides({ sessions: { s: { toolTableHidden: ['a', '', 'a', 7, '__proto__'] } } }).sessions.s),
    { toolTableHidden: ['a'] },
    '工具表名单：非字符串 / 空串 / 非法键丢掉，重复只留一份',
  )
  assert.deepEqual(
    plain(normalizeScopeOverrides({ sessions: { s: { toolTableHidden: [] } } }).sessions.s),
    { toolTableHidden: [] },
    '空名单是有效值，不得被当成"没有设置"丢掉',
  )
  assert.deepEqual(
    plain(normalizeScopeOverrides({ sessions: { s: { baseline: { scene: null, flags: {}, toolTableHidden: ['x'] } } } }).sessions.s),
    { baseline: { scene: null, flags: {}, toolTableHidden: ['x'] } },
    '基线里的工具表那份要跟着落盘',
  )
})

// ── 意图 / 租约：运行态 = 意图 ∪ 租约（0.21.2）──────────────────────────────
//
// 这组判据错了的症状与用户实测的那条一模一样：会话里打开一台全局关着的服务器，
// 新会话也看得到它。纯函数层面把三条不变量钉死，比在界面里复现一次故障可靠。
test('意图对账：运行态 = 意图 ∪ 租约，blocked 压过租约，升级不把租约读成全局', () => {
  // off + 有租约 → 保持运行，意图不动（用户裁定「仍按租约运行」）
  assert.deepEqual(planReconcile([{ key: 'a', intent: 'off', running: true, claims: 2, explicitClaims: 2 }]), [])
  // off + 最后一个租约消失 → 停
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 0, explicitClaims: 0 }]),
    [{ key: 'a', runningNext: false }],
  )
  // blocked + 租约 → 停（显式拒绝压过租约与一切会话层）
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'blocked', running: true, claims: 2, explicitClaims: 2 }]),
    [{ key: 'a', runningNext: false }],
  )
  // 还没有意图记录、补丁开着、有**显式**会话覆盖 → 那是旧版本的"会话级开启"，
  // 记 off 让它落回租约（不把运行态照抄成全局开启）
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: undefined, running: true, claims: 1, explicitClaims: 1 }]),
    [{ key: 'a', intentNext: 'off' }],
  )
  // 没有显式覆盖、只是场景勾中 → 就是普通的全局开启
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: undefined, running: true, claims: 1, explicitClaims: 0 }]),
    [{ key: 'a', intentNext: 'on' }],
  )
  // 外部改动（启动 / 全局场景应用之后）：没有租约时才采纳
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'on', running: false, claims: 0, explicitClaims: 0 }], { adoptExternal: true }),
    [{ key: 'a', intentNext: 'off' }],
  )
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 0, explicitClaims: 0 }], { adoptExternal: true }),
    [{ key: 'a', intentNext: 'on' }],
  )
  // 有租约时运行态与意图不同是**正常**的，不采纳
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 1, explicitClaims: 1 }], { adoptExternal: true }),
    [],
  )
})

test('资源可见性：blocked 压过会话层；意图 off 时只有认领的会话看得到', () => {
  assert.deepEqual(resolveResource('blocked', true), { visible: false, claim: false }, '彻底停止压过会话层')
  assert.deepEqual(resolveResource('off', true), { visible: true, claim: true }, '全局 off + 会话认领 = 租约可见')
  assert.deepEqual(resolveResource('off', false), { visible: false, claim: false }, '会话也没认领 = 看不到')
  assert.deepEqual(resolveResource('off', undefined), { visible: false, claim: false }, '全局 off、无会话层 = 看不到')
  assert.deepEqual(resolveResource('on', false), { visible: false, claim: false }, '全局 on、本会话关掉 = 看不到')
  assert.deepEqual(resolveResource('on', true), { visible: true, claim: false }, '全局 on + 本会话开着 = 看得到')
  assert.deepEqual(resolveResource(undefined, undefined), { visible: undefined, claim: false }, '没有意图 = 交给运行态')
})

test('意图侧车：坏输入夹成空表，三态之外的取值丢掉', () => {
  const empty = normalizeScopeIntent(null)
  assert.equal(Object.keys(empty.mcp).length, 0)
  assert.equal(Object.keys(empty.skillSources).length, 0)
  const parsed = normalizeScopeIntent({ mcp: { a: 'blocked', b: 'yes', '': 'on' }, skillSources: { root: 'off' } })
  assert.equal(parsed.mcp.a, 'blocked')
  assert.equal(parsed.mcp.b, undefined)
  assert.equal(parsed.mcp[''], undefined)
  assert.equal(parsed.skillSources.root, 'off')
})

// ── 0.21.2 加固：四条不变式（契约级，纯函数）────────────────────────────────
//
// 这组用例钉的是**判据本身**，不是某一次故障的界面表现（AGENTS.md 口径：只钉纯函数不变量）。

test('意图域：含 skills 且冻结（增删域要同时改读写四处，冻结让漏改当场红）', () => {
  assert.deepEqual([...INTENT_DOMAINS], ['mcp', 'skillSources', 'skills'], '三格都是进程级资源，缺一个就有域没有意图层')
  assert.equal(Object.isFrozen(INTENT_DOMAINS), true, '冻结：运行期改它等于让读侧悄悄分叉')
  assert.throws(() => { INTENT_DOMAINS.push('memory') }, 'memory 是纯视图域，不该进意图层')
})

test('键归一化：技能的意图键恒为 <root>/<声明名>，目录名不进键', () => {
  // 目录名（`my-skill`）与声明名（`My Skill`）不同时，四处必须用声明名那一套：
  // 覆盖表写、意图写、租约读、徽章计数。用目录名写进去 = 一条永远读不到的意图。
  const plain = (v) => JSON.parse(JSON.stringify(v))
  const root = 'dsh'
  const dirName = 'my-skill'
  const declaredName = 'My Skill'
  const key = root + '/' + declaredName
  assert.equal(key.indexOf(root + '/'), 0, '键形状必须是 <root>/<声明名>')
  assert.notEqual(key, root + '/' + dirName, '目录名与声明名不同时，两者不是同一个键')
  // 同一形状在覆盖表 / 档案 / 意图三处都能被同一个字符串命中。
  const overrides = normalizeScopeOverrides({ sessions: { s: { skills: { [key]: false } } } }).sessions.s
  assert.deepEqual(plain(overrides.skills), { [key]: false })
  const intent = normalizeScopeIntent({ skills: { [key]: 'off' } })
  assert.equal(intent.skills[key], 'off')
})

test('归档认领：归档会话不持有资源；清单读不到时不剪（读不到 ≠ 全被删了）', () => {
  // 展示侧（徽章计数）与执行侧（租约）共用这一份判据 —— 两边分开写就会
  // 「徽章说还有人在用」而资源已经被停掉。
  assert.equal(claimsResource({ archived: true }, true), false, '归档会话不认领')
  assert.equal(claimsResource({ archived: false }, true), true, '活跃会话认领')
  assert.equal(claimsResource(undefined, true), false, '清单里没有（已删除 / 孤儿）不认领')
  assert.equal(claimsResource(undefined, false), true, '清单一条都没读到 → 宁可多留一个租约')
  // 端到端口径：认领会话归档后，全局 off 的资源该停。
  const claims = { archived: false }
  const archivedClaims = { archived: true }
  const decide = (c) => planReconcile([{ key: 'srv', intent: 'off', running: true, claims: claimsResource(c, true) ? 1 : 0, explicitClaims: 0 }])
  assert.deepEqual(decide(claims), [], '有活跃认领 → 保持运行（租约）')
  assert.deepEqual(decide(archivedClaims), [{ key: 'srv', runningNext: false }], '认领会话归档 → 资源停')
})

// ── 0.21.2 第四轮：痕迹闸门与七域统一认领扫描（契约级，纯函数）──────────────
//
// 用户报障 A：会话里开了一台全局关着的 mcp，重启后这一格变成"全局开着"。病根是启动对账
// 在没有租约时就把运行态采纳成了全局 `on` —— 而"没有租约"有四条路径（会话已归档 / 已删除 /
// 清单半冷 / 侧车读失败），条条都是**会话留下的运行态**被读成了"用户全局开过"。
test('痕迹闸门：侧车里还有会话痕迹时不把运行态采纳成全局 on', () => {
  const adopt = { adoptExternal: true }
  // 无痕迹 + 运行中 + 没有租约 → 采纳（用户手改补丁 / 官方页面 / 全局场景）。
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 0, explicitClaims: 0, traced: false }], adopt),
    [{ key: 'a', intentNext: 'on' }],
  )
  // **有痕迹** → 不采纳：那是某个会话拨开的运行态，运行态按 claims>0 落（这里是停机）。
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 0, explicitClaims: 0, traced: true }], adopt),
    [{ key: 'a', runningNext: false }],
  )
  // 有痕迹且还有活跃认领 → 保持运行，意图不动（租约照旧）。
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 2, explicitClaims: 1, traced: true }], adopt),
    [],
  )
  // 没给 `traced`（`scope-set` 之后的普通对账）→ 与旧行为一致：采纳只看有没有租约。
  assert.deepEqual(
    planReconcile([{ key: 'a', intent: 'off', running: true, claims: 0, explicitClaims: 0 }], adopt),
    [{ key: 'a', intentNext: 'on' }],
  )
})

test('七域认领扫描：认领 / 显式 / 痕迹三份口径各归各位', () => {
  const rows = [{ id: 'live' }, { id: 'arch', archived: true }, { id: 'sceneOnly' }]
  const sessions = {
    live: { mcp: { github: true } },
    arch: { mcp: { github: true } },
    ghost: { mcp: { github: true } },                                  // 清单里没有（已删除 / 孤儿）
    quiet: { prompt: { presetId: 'p' } },                              // 一个域都没话说
    sceneOnly: { scene: 's1' },
  }
  const out = scanSessionClaims({
    sessions,
    rows,
    archiveOf: (scope) => (scope.scene === 's1' ? { skills: ['root/sk'] } : undefined),
    targets: { mcp: ['github', 'nobody'], skills: ['root/sk'], skillSources: ['root'] },
  })
  // 认领：只算**未归档、且在清单里**的会话。
  assert.deepEqual(out.claims.mcp.get('github'), ['live'])
  assert.equal(out.claims.mcp.get('nobody'), undefined, '没人认领的键不落表')
  // 显式：不做归档 / 清单过滤 —— 升级首轮判"旧版本的会话级开启"要的就是这份。
  assert.deepEqual(out.explicit.mcp.get('github'), ['live', 'arch', 'ghost'])
  // 痕迹：归档 / 孤儿留下的条目也算（痕迹闸门靠它拒绝采纳）。
  assert.equal(out.traced.mcp.has('github'), true)
  assert.equal(out.traced.mcp.has('nobody'), false)
  // 场景层（进场景时勾中的键）同样是认领，来源格由它的技能反推。
  assert.deepEqual(out.claims.skills.get('root/sk'), ['sceneOnly'])
  assert.deepEqual(out.claims.skillSources.get('root'), ['sceneOnly'])
  assert.equal(out.traced.skillSources.has('root'), true)
})

test('七域认领扫描：detached 会话按基线认领（不需要显式覆盖）', () => {
  // 退出场景后会话停在自己的基线层上：基线里开着、全局已关的键仍要算认领，
  // 否则退出场景的那一刻服务器 / 技能来源会被停掉，用户看到的是"退出就把东西关了"。
  const baseline = {
    capturedAt: '2026-10-21T00:00:00.000Z',
    scene: null,
    flags: { skills: { 'dsh/x': true }, mcp: { srv: true }, memory: {} },
    toolTableHidden: [],
  }
  const out = scanSessionClaims({
    sessions: { d: { detached: true, baseline } },
    rows: [{ id: 'd' }],
    archiveOf: () => undefined,
    targets: { skills: ['dsh/x'], mcp: ['srv'] },
  })
  assert.deepEqual(out.claims.skills.get('dsh/x'), ['d'], '基线为开 = 认领')
  assert.deepEqual(out.claims.mcp.get('srv'), ['d'], 'mcp 同一条判据')
  assert.deepEqual(out.explicit.skills.get('dsh/x'), undefined, '基线不是显式覆盖')
})

test('七域认领扫描：清单读不到时不剪（读不到 ≠ 全被删了）', () => {
  const out = scanSessionClaims({
    sessions: { s: { memory: { m1: true } } },
    rows: [],
    archiveOf: () => undefined,
    targets: { memory: ['m1'] },
  })
  assert.deepEqual(out.claims.memory.get('m1'), ['s'], '清单一条都没读到 → 宁可多留一个租约')
})

test('七域认领扫描：逐工具 / 单条技能为开也认领它所在的整台服务器 / 来源', () => {
  const out = scanSessionClaims({
    sessions: { s: { mcpTools: { 'srv/tool': true }, skills: { 'root/one': true } } },
    rows: [{ id: 's' }],
    archiveOf: () => undefined,
    targets: { mcp: ['srv'], skillSources: ['root'] },
  })
  assert.deepEqual(out.claims.mcp.get('srv'), ['s'], '工具能调的前提是那台服务器在跑')
  assert.deepEqual(out.claims.skillSources.get('root'), ['s'], '来源不启用时 core 不会加载那条技能')
  assert.deepEqual(out.explicit.mcp.get('srv'), ['s'])
  assert.equal(out.traced.mcp.has('srv'), true, '逐工具为开也算这一格的会话痕迹')
})

test('七域认领扫描：上层被显式关掉时，子项为开不再认领它', () => {
  // 历史侧车 / 手改文件可能留下"来源关、里面一条技能为开"的矛盾状态。界面按来源关显示、
  // 执行守卫也 deny —— 这时再认领来源只会白跑一台服务器并挂一条假的「临时运行」。
  const out = scanSessionClaims({
    sessions: { s: {
      mcp: { srv: false }, mcpTools: { 'srv/tool': true },
      skillSources: { root: false }, skills: { 'root/one': true },
    } },
    rows: [{ id: 's' }],
    archiveOf: () => undefined,
    targets: { mcp: ['srv'], skillSources: ['root'] },
  })
  assert.deepEqual(out.claims.mcp.get('srv'), undefined, '服务器显式关：工具为开不认领')
  assert.deepEqual(out.claims.skillSources.get('root'), undefined, '来源显式关：技能为开不认领')
  assert.deepEqual(out.explicit.mcp.get('srv'), undefined, '也不该记成显式认领')
  assert.equal(out.traced.mcp.has('srv'), false, '不留下痕迹（否则对账会拒绝采纳外部关闭）')
})

test('会话提示词覆盖：形状收敛、互斥与预算（content > presetId，超 64 KiB 整条丢弃）', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  const both = normalizeSessionScope({ prompt: { presetId: 'p', content: 'hello' } })
  assert.deepEqual(plain(both.prompt), { content: 'hello' }, 'content 有值时清掉 presetId（互斥）')
  assert.deepEqual(plain(normalizeSessionScope({ prompt: { presetId: 'p' } }).prompt), { presetId: 'p' })
  assert.equal(normalizeSessionScope({ prompt: { content: 'x'.repeat(PROMPT_CONTENT_MAX_BYTES + 1) } }), undefined, '超预算整条丢弃，不写半截')
  assert.equal(normalizeSessionScope({ prompt: { content: 'a'.repeat(PROMPT_CONTENT_MAX_BYTES) } }).prompt.content.length, PROMPT_CONTENT_MAX_BYTES, '恰好等于上限保留')
  assert.equal(normalizeSessionScope({ prompt: { presetId: '__proto__' } }), undefined, '非法 presetId 丢弃')
  assert.equal(normalizeSessionScope({ prompt: { content: 42 } }), undefined, '非字符串正文丢弃')
  assert.doesNotThrow(() => normalizeScopeOverrides({ sessions: { s: { prompt: { content: 42 } } } }), '坏输入不抛')
  // prompt 是"一条覆盖"：算进下拉计数，并让条目可保留 / 非空。
  assert.equal(isKeepableScope({ prompt: { presetId: 'p' } }), true)
  assert.equal(isEmptyScope({ prompt: { presetId: 'p' } }), false)
  assert.equal(overrideCountOf({ prompt: { presetId: 'p' } }), 1)
  // 进出场景不清提示词覆盖（它不进场景模式快照）。
  assert.deepEqual(plain(enterSceneInScope({ prompt: { content: 'x' } }, 'web').scope.prompt), { content: 'x' })
  assert.deepEqual(plain(exitSceneInScope({ prompt: { content: 'x' }, scene: 'web' }).scope.prompt), { content: 'x' })
  // 剪枝不按下层清 prompt（它不是开关，没有"与下层同值"这一态）。
  assert.deepEqual(plain(pruneScope({ prompt: { presetId: 'p' } }, { scene: null, flags: {} }).prompt), { presetId: 'p' })
})

test('提示词用户级槽位顺序：会话正文 > 会话预设 > 场景预设 > 冻结快照 > AGENTS.md', () => {
  const pick = (over) => chooseUserPromptLayer({ sessionContent: false, sessionPreset: false, scenePreset: false, sessionBaseline: false, globalFile: false, ...over })
  assert.equal(pick({ sessionContent: true, sessionPreset: true, scenePreset: true, sessionBaseline: true, globalFile: true }), 'session-content')
  assert.equal(pick({ sessionPreset: true, scenePreset: true, sessionBaseline: true, globalFile: true }), 'session-preset')
  assert.equal(pick({ scenePreset: true, sessionBaseline: true, globalFile: true }), 'scene-preset')
  assert.equal(pick({ sessionBaseline: true, globalFile: true }), 'session-baseline', '快照压过当前文件')
  assert.equal(pick({ globalFile: true }), 'global-file', '没有快照才轮到当前文件（退化路径）')
  assert.equal(pick({}), null)
})

test('提示词冻结快照：白名单 / 预算 / 不计数 / 场景与剪枝都保留', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  // 只有快照的条目：要留住（isKeepable），但不是"用户覆盖"（不计入下拉 / 不触发接管判据）。
  const only = normalizeSessionScope({ prompt: { baseline: '' } })
  assert.deepEqual(plain(only.prompt), { baseline: '' }, '空串快照是有效值（创建时文件为空），不能丢')
  assert.equal(promptBaselineOf(only), '')
  assert.equal(hasPromptOverride(only), false, '快照是系统捕获，不是用户覆盖')
  assert.equal(isKeepableScope(only), true, '快照随会话条目生灭，条目本身要留住')
  assert.equal(isEmptyScope(only), true, '没有用户覆盖 = 空（不影响下拉的"N 项"）')
  assert.equal(overrideCountOf(only), 0, '快照不数进覆盖条目')
  // 用户覆盖与快照并存：投影只露用户那一半。
  const both = normalizeSessionScope({ prompt: { presetId: 'p', baseline: 'BASE' } })
  assert.deepEqual(plain(both.prompt), { presetId: 'p', baseline: 'BASE' })
  assert.deepEqual(promptOverrideOf(both), { presetId: 'p' }, '快照不混进覆盖投影')
  assert.equal(hasPromptOverride(both), true)
  assert.equal(overrideCountOf(both), 1)
  // 64 KiB 闸：超大快照单独出现整条丢弃；与 content 并存时只丢快照。
  assert.equal(normalizeSessionScope({ prompt: { baseline: 'x'.repeat(PROMPT_CONTENT_MAX_BYTES + 1) } }), undefined)
  assert.deepEqual(
    plain(normalizeSessionScope({ prompt: { content: 'c', baseline: 'x'.repeat(PROMPT_CONTENT_MAX_BYTES + 1) } }).prompt),
    { content: 'c' },
  )
  // 截断必须落在 UTF-8 字符边界上（半个字符会变成替换符，正文指纹也跟着变）。
  const clamped = clampPromptBaseline('é'.repeat(40000))
  assert.ok(Buffer.byteLength(clamped, 'utf8') <= PROMPT_CONTENT_MAX_BYTES)
  assert.equal(clamped.includes('\uFFFD'), false)
  // 进出场景、剪枝都不清快照（快照不是场景层的东西）。
  assert.equal(promptBaselineOf(enterSceneInScope({ prompt: { baseline: 'B' } }, 'web').scope), 'B')
  assert.equal(promptBaselineOf(exitSceneInScope({ scene: 'web', prompt: { baseline: 'B' } }).scope), 'B')
  assert.equal(promptBaselineOf(pruneScope({ prompt: { baseline: 'B' } }, { scene: null, flags: {} })), 'B')
})

test('提示词快照差异判据：无快照 / 读不到文件不拦，内容变了才拦', () => {
  assert.equal(promptBaselineDiffers(undefined, 'x'), false, '没有快照 = 这一层没意见（让位给官方）')
  assert.equal(promptBaselineDiffers('x', undefined), false, '当前文件读不到 = 这一轮不接管，不能两份都拦')
  assert.equal(promptBaselineDiffers('x', 'x'), false, '一致 = 官方照送')
  assert.equal(promptBaselineDiffers('x', 'y'), true, '内容变了 = 接管')
  assert.equal(promptBaselineDiffers('', 'x'), true, '创建时为空、后来写进内容 = 也要冻结')
  const big = 'x'.repeat(PROMPT_CONTENT_MAX_BYTES + 100)
  assert.equal(promptBaselineDiffers(clampPromptBaseline(big), big), false, '超预算文件按同一预算夹完再比，不能每轮都判"变了"')
})

test('有会话提示词覆盖时拦官方 agent-instructions（无覆盖不拦）', () => {
  const on = { ...DEFAULT_INJECT_SETTINGS, domains: { ...DEFAULT_INJECT_SETTINGS.domains } }
  assert.equal(suppressedKindsForSession(on, true).has('agent-instructions'), true)
  assert.equal(suppressedKindsForSession(on, false).has('agent-instructions'), false)
  // 域本身被关掉时同样在集合里（官方被拦 + 插件不发 = 本会话没有提示词）。
  const off = { ...on, domains: { ...on.domains, prompt: false } }
  assert.equal(suppressedKindsForSession(off, false).has('agent-instructions'), true)
})

test('MCP 逐工具键的 server 段并入切分候选（server 名含 __ 时仍能认对）', () => {
  assert.deepEqual(mcpToolServerSegments({ 'a__b/tool': true, 'no-slash': true }), ['a__b'])
  assert.deepEqual(mcpToolServerSegments(undefined), [])
  const candidates = serverNameCandidates(['a__b'], mcpToolServerSegments({ 'a__b/tool': true }))
  const parts = splitMcpToolName('mcp__a__b__tool', candidates)
  assert.equal(parts.server, 'a__b')
  assert.equal(parts.tool, 'tool')
})

test('侧车 GC：已删除会话的条目剪掉，归档未删除的保留（可恢复）', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  const sessions = {
    live: { skills: { 'dsh/a': true } },
    archived: { scene: 'web' },
    deleted: { skills: { 'dsh/b': false } },
  }
  const kept = pruneSessionScopes(sessions, new Set(['live', 'archived']))
  assert.deepEqual(Object.keys(plain(kept.sessions)).sort(), ['archived', 'live'], '归档未删除的保留')
  assert.equal(kept.pruned, 1, '已删除的那一条被剪掉')
  // 全都不在清单里 = 全剪（调用方负责在清单读不到时**不调**这个函数，见 store.ts）。
  assert.equal(pruneSessionScopes(sessions, new Set()).pruned, 3)
  // 剪枝不改入参（调用方可能还要读它）。
  assert.equal(Object.keys(sessions).length, 3)
})

// ── 隔离粒度：按会话 / 按工作区（0.21.2）────────────────────────────────────
test('工作区作用域键：同一工作区归一成同一个键，没有 cwd 退回会话', () => {
  // Windows 盘符大小写 / 分隔符 / 末尾斜杠同一口径（与工作区挂回、下拉分组同一份归一）。
  assert.equal(workspaceScopeKeyOf('C:\\Proj\\'), WORKSPACE_SCOPE_PREFIX + 'c:\\proj')
  assert.equal(workspaceScopeKeyOf('c:/proj'), workspaceScopeKeyOf('C:\\Proj\\'))
  assert.equal(workspaceScopeKeyOf('/Users/me/proj/'), 'ws:/Users/me/proj')
  assert.equal(workspaceScopeKeyOf(''), undefined, '没有 cwd = 不共享')
  assert.equal(workspaceScopeKeyOf(undefined), undefined)
  // 超长路径不截断：宁可退回会话隔离，也不让两个工作区撞成一个键。
  assert.equal(workspaceScopeKeyOf('x'.repeat(WORKSPACE_SCOPE_KEY_MAX)), undefined)
  assert.equal(isWorkspaceScopeKey('ws:C:\\proj'), true)
  assert.equal(isWorkspaceScopeKey('ws:'), false)
  assert.equal(isWorkspaceScopeKey('abc'), false)
  assert.equal(workspaceCwdOfScopeKey('ws:C:\\proj'), 'C:\\proj')
  assert.equal(workspaceCwdOfScopeKey('abc'), undefined)
  // 错误提示里不点名原始键：工作区键显示目录名，会话键原样。
  assert.equal(scopeKeyLabel('ws:c:\\proj'), 'proj')
  assert.equal(scopeKeyLabel('ws:/Users/me/my-proj/'), 'my-proj')
  assert.equal(scopeKeyLabel('s1'), 's1')

  assert.equal(scopeKeyOfRow({ id: 's1', cwd: 'C:\\P\\' }, 'workspace'), 'ws:c:\\p')
  assert.equal(scopeKeyOfRow({ id: 's1', cwd: '' }, 'workspace'), 's1', '没有 cwd → 按会话独立')
  assert.equal(scopeKeyOfRow({ id: 's1', cwd: 'C:\\P\\' }, 'session'), 's1', '会话模式不看 cwd')
})

test('工作区模式认领：同一工作区的未归档会话一起认领，归档的不算', () => {
  const rows = [
    { id: 'a1', cwd: 'C:\\Proj' },
    { id: 'a2', cwd: 'c:/proj/' },
    { id: 'arch', cwd: 'C:\\Proj', archived: true },
    { id: 'b1', cwd: 'C:\\Other' },
    { id: 'solo', cwd: '' },
  ]
  const sessions = {
    'ws:c:\\proj': { mcp: { srv: true } },
    'ws:c:\\other': { mcp: { srv: true }, mcpTools: { 'srv/tool': true } },
    solo: { mcp: { srv: true } },
    // 被工作区收编的旧会话记录：工作区模式下不能算租约（键不落在任何工作区桶里，
    // 也没有 cwd 让它成为独立会话）。
    a1: { mcp: { srv: true } },
  }
  const out = scanSessionClaims({
    sessions,
    rows,
    mode: 'workspace',
    archiveOf: () => undefined,
    targets: { mcp: ['srv'] },
  })
  // a1 / b1 各认一次；a2 同一工作区；arch 归档不认；solo 没有 cwd 按会话独立。
  assert.deepEqual(out.claims.mcp.get('srv').slice().sort(), ['a1', 'a2', 'b1', 'solo'])
  // 显式不做归档过滤（升级推断）：归档会话的旧覆盖仍是证据；工作区键没有真实会话时不算。
  assert.deepEqual(out.explicit.mcp.get('srv').slice().sort(), ['a1', 'a2', 'arch', 'b1', 'solo'])
  assert.equal(out.traced.mcp.has('srv'), true)
  // 逐工具为开同样按工作区里的会话认领。
  const tools = scanSessionClaims({ sessions, rows, mode: 'workspace', archiveOf: () => undefined, targets: { mcpTools: ['srv/tool'] } })
  assert.deepEqual(tools.claims.mcpTools.get('srv/tool'), ['b1'], '逐条工具按工作区里的会话认领')
  // 会话模式下 ws: 键不参与；a1 的记录照旧算认领。
  const sessionMode = scanSessionClaims({ sessions, rows, archiveOf: () => undefined, targets: { mcp: ['srv'] } })
  assert.deepEqual(sessionMode.claims.mcp.get('srv').slice().sort(), ['a1', 'solo'], '会话模式按会话 id 各归各的')
})

test('工作区模式认领：清单读不到时留一个占位租约，不把资源停掉', () => {
  const out = scanSessionClaims({
    sessions: { 'ws:c:\\proj': { mcp: { srv: true } } },
    rows: [],
    mode: 'workspace',
    archiveOf: () => undefined,
    targets: { mcp: ['srv'] },
  })
  assert.deepEqual(out.claims.mcp.get('srv'), ['ws:c:\\proj'], '读不到 ≠ 全被删了')
  assert.deepEqual(out.explicit.mcp.get('srv'), undefined, '工作区键不是可升级推断的旧会话 id')
})

test('模式切换播种：prune 保留工作区键，克隆到另一层时剥掉锁', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  // GC 不剪 ws: 键：它没有对应的宿主会话，但它不是"已删除的会话"。
  const kept = pruneSessionScopes(
    { 'ws:c:\\p': { scene: 'web' }, gone: { scene: 'x' } },
    new Set(),
  )
  assert.deepEqual(plain(kept.sessions), { 'ws:c:\\p': { scene: 'web' } })
  assert.equal(kept.pruned, 1)
  // 播种 = 把一侧的记录做成另一侧的初始值；锁跟着层走，不跟内容走。
  assert.deepEqual(plain(scopeForLayerSeed({ locked: true, skills: { a: true } })), { skills: { a: true } })
  assert.equal(scopeForLayerSeed({ locked: true }), undefined, '只有锁 = 没有可播种的内容')
  assert.equal(scopeForLayerSeed(undefined), undefined)
})

test('模式切换播种：detached 不跟着搬，否则新层一出生就钉住"没有场景"', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  // 源层"退出过场景"且基线里当时没有场景：直接搬 detached 会让新层 = 钉住没有场景，
  // 场景段当场停止注入（用户报的「场景勾着却没注入」）。剥掉后应回到"跟随全局"。
  const fromNoScene = scopeForLayerSeed({
    detached: true,
    baseline: { scene: null, flags: { skills: { a: true, b: false } } },
    prompt: { baseline: 'x' },
  })
  assert.equal(fromNoScene.detached, undefined, 'detached 不搬')
  assert.equal(sessionScenePinOf(fromNoScene), undefined, '新层跟随全局，而不是钉住"没有场景"')
  // 基线里显式写的开关要物化进覆盖，否则剥掉 detached 就等于把用户看到的生效值丢了。
  assert.deepEqual(plain(fromNoScene.skills), { a: true, b: false })
  assert.deepEqual(plain(fromNoScene.prompt), { baseline: 'x' }, '提示词快照照旧留着')
  // 基线里是**真实场景名**时，显式钉住它（用户看到的还是这个场景）。
  const fromScene = scopeForLayerSeed({ detached: true, baseline: { scene: 'web', flags: {} } })
  assert.equal(sessionScenePinOf(fromScene), 'web')
  // 源层自己的显式覆盖压在基线之上。
  const overridden = scopeForLayerSeed({
    detached: true,
    baseline: { scene: null, flags: { skills: { a: false } } },
    skills: { a: true },
  })
  assert.deepEqual(plain(overridden.skills), { a: true })
})

// ── frontmatter 标量编码与行级保留（0.21.2 P2-5）────────────────────────
// 破了会静默改数据：描述里带 `: ` 的旧写法让 js-yaml 解析失败，编辑一条记忆丢嵌套字段。

test('YAML 标量：该引号的都被引号包住，自家解码器与 js-yaml 都还原原字符串', () => {
  const values = [
    'plain',
    'a: b',
    'a # b',
    '123',
    'true',
    'yes',
    '2026-10-22',
    ' padded ',
    "it's",
    'a"b',
    '',
    '[x]',
    '- dash',
    'null',
  ]
  for (const value of values) {
    const encoded = yamlScalar(value)
    assert.ok(!encoded.includes('\n'), '标量必须是一行：' + JSON.stringify(value))
    assert.equal(decodeYamlScalar(encoded), value, '自家读侧往返：' + JSON.stringify(value))
    assert.equal(yaml.load('k: ' + encoded).k, value, 'js-yaml 读侧不得改变类型或值：' + JSON.stringify(value))
  }
  // 普通文本保持裸写，不制造无意义的引号噪声。
  assert.equal(yamlScalar('普通描述'), '普通描述')
})

test('记忆更新只替换 name/description 取值行，嵌套、未知键、注释与顺序原样保留', () => {
  const before = [
    '---',
    'name: old',
    'description: old desc',
    'metadata:',
    '  source: hand-written',
    '# 保留这条注释',
    'custom: value',
    '---',
    '',
    'body line',
  ].join('\r\n')
  const after = rewriteFrontmatterFields(
    before,
    { name: 'new: name', description: 'desc: with # marks' },
    'new body',
  )
  assert.ok(after.includes('  source: hand-written'), '嵌套字段不得丢')
  assert.ok(after.includes('# 保留这条注释'), '注释不得丢')
  assert.ok(after.includes('custom: value'), '未知键不得丢')
  assert.ok(!after.replace(/\r\n/g, '').includes('\n'), 'CRLF 文件的换行风格不得漂移')
  assert.ok(after.indexOf('name:') < after.indexOf('description:'), '字段顺序保持')
  assert.ok(after.endsWith('\r\nnew body'), '正文整体替换')
  // 读回来确认新值可被自家解析器还原。
  assert.ok(after.includes('name: "new: name"'))
  assert.ok(after.includes('description: "desc: with # marks"'))
})

test('记忆更新删除 description 时只删它自己的取值行，其余字段仍在', () => {
  const before = '---\nname: n\ndescription: d\ncustom: keep\n---\n\nbody\n'
  const after = rewriteFrontmatterFields(before, { name: 'n', description: null }, 'body')
  assert.ok(!after.includes('description:'), 'description 必须被删掉')
  assert.ok(after.includes('custom: keep'), '其余字段仍保留')
})

test('人设 frontmatter：含冒号的描述可往返，output 新旧两种写法都能读', () => {
  const serialized = serializePersona({
    description: 'Use when: reviewing # things',
    provider: 'p',
    model: 'm',
    output: ['first: thing', 'second'],
    body: 'You are X',
  })
  const fm = serialized.split('---')[1]
  const yamlDoc = yaml.load(fm)
  assert.equal(yamlDoc.description, 'Use when: reviewing # things', 'js-yaml 不得截断含 `: ` 的值')
  assert.deepEqual(yamlDoc.output, ['first: thing', 'second'], 'output 落盘为 YAML 序列')
  const parsed = parsePersona(serialized, 'x')
  assert.equal(parsed.description, 'Use when: reviewing # things')
  assert.equal(parsed.output, 'first: thing\nsecond')
  // 旧文件（重复 output 键）继续可读，不强制迁移。
  const old = '---\ndescription: old\noutput: a: b\noutput: c\n---\n\nbody\n'
  assert.equal(parsePersona(old, 'x').output, 'a: b\nc')
})

test('人设描述里的保留字/数字形态写成引号标量，读回仍是字符串', () => {
  const serialized = serializePersona({ description: '123', provider: 'null', body: 'x' })
  const yamlDoc = yaml.load(serialized.split('---')[1])
  assert.equal(yamlDoc.description, '123')
  assert.equal(yamlDoc.provider, 'null')
  assert.equal(parsePersona(serialized, 'x').description, '123')
  assert.equal(parsePersona(serialized, 'x').provider, 'null')
})

test('人设名单字段逐条转义可往返：逗号 / 冒号 / 引号 / 换行 / 保留字', () => {
  const tricky = ['read_file', 'a,b', 'c: d', 'e"f', "g'h", 'true', '含，全角逗号', 'multi\nline']
  const serialized = serializePersona({
    tools: ['x'],
    toolsDeny: tricky,
    toolsByPreset: { std: { mode: 'deny', names: tricky } },
    body: 'b',
  })
  const parsed = parsePersona(serialized, 'p')
  assert.deepEqual(parsed.tools, ['x'])
  assert.deepEqual(parsed.toolsDeny, tricky, '含逗号 / 冒号 / 引号 / 换行的名字都要原样回读')
  assert.deepEqual(parsed.toolsByPreset.std.names, tricky, 'toolsByPreset 的名单同一口径')
  // 单条加引的名单（整行恰好以引号开头收尾）也不能被整值解码提前解开。
  const single = serializePersona({ toolsDeny: ['a,b'], body: 'b' })
  assert.deepEqual(parsePersona(single, 'p').toolsDeny, ['a,b'])
  // 未转义的旧格式（存量文件）照旧可读。
  assert.deepEqual(parsePersona('---\ntoolsDeny: a, b\n---\n\nbody\n', 'p').toolsDeny, ['a', 'b'])
})

// ── 令牌覆盖条目的追加（0.21.2 P2-7）────────────────────────────────────
// 破了会静默写坏启动配置：空补丁 `[]` 后面直接拼 `- id: …`，官方 js-yaml 解析直接失败。

test('令牌覆盖条目：空内容 / 空补丁 `[]` / 普通内容都写出合法 YAML', () => {
  const entry = '- id: dsh-plugin-tool-management\n  config:\n    token: "t0k"'
  const parse = (text) => yaml.load(text)

  const fromEmpty = appendOverrideEntry('', entry)
  assert.deepEqual(parse(fromEmpty), [{ id: 'dsh-plugin-tool-management', config: { token: 't0k' } }], '空内容')
  assert.equal(fromEmpty.startsWith('\n'), false, '空内容不该在文件开头留空行')

  const fromBracket = appendOverrideEntry('[]\n', entry)
  assert.deepEqual(parse(fromBracket), [{ id: 'dsh-plugin-tool-management', config: { token: 't0k' } }], '`[]` 被替换而不是追加')

  const fromBracketNoNewline = appendOverrideEntry('[]', entry)
  assert.deepEqual(parse(fromBracketNoNewline), [{ id: 'dsh-plugin-tool-management', config: { token: 't0k' } }], '无尾换行的 `[]`')

  const existing = '- id: other\n'
  const merged = appendOverrideEntry(existing, entry)
  assert.deepEqual(parse(merged), [{ id: 'other' }, { id: 'dsh-plugin-tool-management', config: { token: 't0k' } }], '普通内容追加到末尾')
})

// ── 并发编辑指纹（0.21.2 Phase 4.1）──────────────────────────────────────
// 破了会静默丢改动：两个窗口同时编辑，后保存的那份整份覆盖前一份。

test('stale-write：指纹随内容变、不带指纹不拦、不符给出冲突回执', async () => {
  assert.equal(stampOfText('a'), stampOfText('a'), '同内容指纹稳定')
  assert.notEqual(stampOfText('a'), stampOfText('b'), '内容变则指纹变')
  assert.equal(stampOfText(null), null, '文件不存在 = null')
  assert.equal(normalizeStamp(undefined), null, '没带 = null')
  assert.equal(normalizeStamp('  '), null, '空串 = 没带')
  assert.equal(normalizeStamp(123), null, '非字符串 = 没带')

  const stamp = stampOfText('v1')
  assert.equal(stampConflict(stamp, undefined), null, '不传 expectedStamp = 旧行为')
  assert.equal(stampConflict(stamp, stamp), null, '一致就放行')
  const conflict = stampConflict(stamp, stampOfText('v2'))
  assert.equal(conflict.code, 'stale-write')
  assert.equal(conflict.ok, false)
  assert.equal(conflict.current.stamp, stamp, '回执带上当前指纹，界面可据此重载')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-stale-'))
  const file = join(dir, 'doc.md')
  try {
    writeFileSync(file, 'one')
    await assertStamp(file, stampOfText('one'))
    writeFileSync(file, 'two')
    await assert.rejects(() => assertStamp(file, stampOfText('one')), (e) => e.code === 'stale-write' && e.current === stampOfText('two'))
    await assertStamp(file, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 记忆搜索（0.21.2 Phase 4.3）──────────────────────────────────────────
// 破了会静默答错：排序或截断变了，模型拿到的"最相关"就不是用户想找的那条。

test('记忆搜索：多词 AND、大小写不敏感、排序按命中字段、空 query 不返回全部', () => {
  const docs = [
    { id: 'global/deploy', name: 'deploy', group: 'global', description: 'how to ship', tags: ['ops'], body: 'run the deploy script', enabled: true },
    { id: 'global/deploy-notes', name: 'deploy-notes', group: 'global', description: 'deploy details', tags: [], body: 'notes about shipping', enabled: false },
    { id: 'work/incident', name: 'incident', group: 'work', description: 'deploy rollback', tags: ['deploy'], body: 'when a deploy fails', enabled: true },
  ]
  assert.deepEqual(searchMemories(docs, ''), [], '空 query 返回空，不是全部')
  assert.deepEqual(searchMemories(docs, '   '), [], '纯空白同理')

  const hits = searchMemories(docs, 'deploy')
  assert.equal(hits.length, 3)
  assert.equal(hits[0].name, 'deploy', '名称精确排第一')
  assert.equal(hits[1].name, 'deploy-notes', '名称前缀排第二')
  assert.equal(hits[2].name, 'incident', '只在描述 / 标签 / 正文命中的排后面')

  assert.equal(searchMemories(docs, 'DEPLOY').length, 3, '大小写不敏感')
  assert.deepEqual(searchMemories(docs, 'deploy rollback').map((h) => h.name), ['incident'], '多词是 AND')
  assert.deepEqual(searchMemories(docs, 'deploy nothing'), [], '任一词不命中就排除')
  assert.equal(searchMemories(docs, 'deploy')[1].enabled, false, 'enabled 原样带出（会话投影由调用方合成）')
  assert.equal(searchMemories(docs, 'deploy', 2).length, 2, 'limit 生效')
})

test('记忆搜索片段：压平换行、围绕命中截断、总长不超过 160', () => {
  const body = 'x'.repeat(200) + ' needle ' + 'y'.repeat(200)
  const snippet = snippetOf(body, ['needle'])
  assert.ok(snippet.length <= 160, '片段长度上限：' + snippet.length)
  assert.ok(snippet.includes('needle'), '片段必须含命中词')
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), '两侧都有省略号')
  assert.equal(snippetOf('short body', ['short']), 'short body', '短文本原样返回')
  assert.equal(snippetOf('a\nb   c', []), 'a b c', '换行与多余空白压平')
})

test('记忆搜索工具出厂默认关闭（schema 成本按需付）', () => {
  assert.ok(DEFAULT_HIDDEN_TOOLS.includes('memory_manager_search'))
})

test('确认门按「动作 × 作用域」判定：恢复路径不拦，机器级写入才拦', () => {
  const asks = (name, args, mode = 'session') => argConditionalConfirmReason(name, args, mode) !== null
  // 删除：trash 才是删除；list 是读、restore 是恢复（与 restart 同一档，不该拦）
  assert.equal(asks('memory_manager_remove', { action: 'trash', id: 'global/x' }), true)
  assert.equal(asks('memory_manager_remove', { action: 'restore', id: 't1' }), false)
  assert.equal(asks('skill_manager_remove', { action: 'list' }), false)
  // 缺 id 的删除注定失败：弹卡等于让用户批准一次做不成的操作
  assert.equal(asks('memory_manager_remove', { action: 'trash' }), false)
  // 提示词：正向应用要问，撤销（apply=false）不问
  assert.equal(asks('prompt_manager_apply', { id: 'p' }), true)
  assert.equal(asks('prompt_manager_apply', { id: 'p', apply: false }), false)
  // MCP：restart 是服务器挂掉时的恢复路径（场景锁都为它开口），stop 是机器级停机
  assert.equal(asks('mcp_manager_switch', { server: 's', action: 'stop' }), true)
  assert.equal(asks('mcp_manager_switch', { server: 's', action: 'restart' }), false)
  // 开关：默认写本会话（爆炸半径一个对话）不问，机器级才问
  assert.equal(asks('memory_manager_switch', { memory: 'global/a', enabled: false }), false)
  assert.equal(asks('memory_manager_switch', { memory: 'global/a', enabled: false, scope: 'global' }), true)
  assert.equal(asks('skill_manager_switch', { name: 'x', enabled: false }, 'global'), true)
  // 参数不成立时不拦：让工具自己报错，别产生无效审批
  assert.equal(asks('subagent_manager_switch', { name: 'x' }), false)
})

// 签发端与校验端的指纹必须同口径（#22）：get-current 发的是 stampOfText 16 位指纹，
// apply 核对时也要先算指纹再比 —— 任何一侧拿正文当指纹，应用预设就会恒判冲突静默失效。
// deps 全部注入假实现：钉的是口径不变量，不碰真实文件与服务。
test('提示词指纹签发/校验同口径：get-current 发的 stamp 原样带回 apply 必须放行，外部改动后才拒', async () => {
  const content = '# 全局提示词\n\n正文内容。\n'
  let currentOnDisk = { ok: true, content, presetId: null, lastApplied: null, exists: true, unapplyAvailable: false, unapplyRemoves: false }
  const applied = []
  const ops = buildPromptOps({
    promptsService: { getCurrent: async () => currentOnDisk },
    scenePromptSync: {},
    rulesOps: {},
    applyPresetGuarded: async (id) => { applied.push(id); return { ok: true, id } },
    withAgentsMdSync: async (res) => res,
    promptRefReason: () => '',
    warn: () => {},
  })
  const current = await ops['agentsmd-get-current']()
  assert.equal(current.ok, true)
  assert.match(current.stamp, /^[0-9a-f]{16}$/, '签发端给的是 16 位内容指纹')
  // 内容未动：签发端指纹原样回传 → 放行写入
  const ok = await ops['agentsmd-apply']({ id: 'p1', expectedStamp: current.stamp })
  assert.equal(ok.ok, true)
  assert.deepEqual(applied, ['p1'])
  // 外部改了文件：同一个旧指纹 → stale-write 拒绝，回执带磁盘上的新指纹
  currentOnDisk = { ...currentOnDisk, content: content + '\n外部追加的一段。\n' }
  const stale = await ops['agentsmd-apply']({ id: 'p1', expectedStamp: current.stamp })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale-write')
  assert.match(stale.current.stamp, /^[0-9a-f]{16}$/)
  assert.equal(applied.length, 1, '被拒的那次不能写入')
})

test('更新检查的源计划：宿主顺序优先、私有源不被公网测速挤后、无登记回退单源', () => {
  const npm = 'https://registry.npmjs.org/'
  const mirror = 'https://registry.npmmirror.com/'
  // 取不到宿主登记：空计划，调用方走 npm 官方单源
  assert.deepEqual(sourcePlan(null, mirror), [])
  // 配置为空：pnpm 解析值在前，fallback 随后
  assert.deepEqual(sourcePlan({ registry: null, resolved: npm, fallbackRegistries: [mirror] }, null), [npm, mirror])
  // 测速命中是计划成员且首项为公网源：提到最前
  assert.deepEqual(sourcePlan({ registry: null, resolved: npm, fallbackRegistries: [mirror] }, mirror), [mirror, npm])
  // 首项是私有源：即使测速命中，也不许把它挤后
  const privateRegistry = 'https://npm.corp.example/npm/'
  assert.deepEqual(
    sourcePlan({ registry: privateRegistry, resolved: null, fallbackRegistries: [mirror] }, mirror),
    [privateRegistry, mirror],
  )
  // 重复、非法地址被去掉；URL 规范化（末尾斜杠、主机小写）
  assert.deepEqual(
    sourcePlan({ registry: 'https://REGISTRY.NPMJS.ORG', resolved: null, fallbackRegistries: ['https://registry.npmjs.org/', 'ftp://x/', 'not a url'] }, null),
    [npm],
  )
})

test('更新检查跳过 deprecated 版本：只废弃版可用时宁可不推荐', () => {
  const range = '>=0.2.1-rc.3 <0.2.2'
  const host = '0.2.1-rc.3'
  const versions = {
    '0.21.9': { engines: { dsh: range } },
    '0.21.10': { engines: { dsh: range }, deprecated: 'broken release' },
    '0.21.8': { engines: { dsh: range } },
  }
  assert.equal(pickBestCompatible(versions, host), '0.21.9')
  assert.equal(pickBestCompatible({ '0.21.10': { engines: { dsh: range }, deprecated: 'broken release' } }, host), null)
  assert.equal(pickBestCompatible({ '0.21.9': { engines: { dsh: range }, deprecated: false } }, host), '0.21.9')
})

test('意图清理只删除清单里不存在的键，无变化时返回原对象', () => {
  const base = normalizeScopeIntent({
    mcp: {},
    skillSources: { 'src/a': 'on', 'src/b': 'blocked' },
    skills: { 'src/a/skill': 'off' },
  })
  const pruned = pruneIntentKeys(base, 'skillSources', new Set(['src/a']))
  assert.deepEqual(Object.keys(pruned.skillSources), ['src/a'])
  assert.equal(pruned.skillSources['src/a'], 'on')
  assert.equal(pruned.skills['src/a/skill'], 'off', '别的域原样保留')
  assert.equal(pruneIntentKeys(base, 'skillSources', new Set(['src/a', 'src/b'])), base)
})

test('宿主发现同时认平铺与全局 npm 的嵌套布局，拒绝只有 dsh 壳的顶层目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-root-'))
  const writePackage = (dir, name, version) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  try {
    // 全局安装：<prefix>/node_modules/@deepseek-ai 只有 dsh；身份包在 dsh/node_modules 里。
    const shell = join(root, 'global', 'node_modules', '@deepseek-ai')
    const nested = join(shell, 'dsh', 'node_modules', '@deepseek-ai')
    writePackage(join(shell, 'dsh'), '@deepseek-ai/dsh', '0.2.1-rc.5')
    writePackage(join(nested, 'cordis'), '@deepseek-ai/cordis', '4.0.5')
    writePackage(join(nested, 'dsh-tools'), '@deepseek-ai/dsh-tools', '0.2.1-rc.5')
    assert.equal(looksLikeHostPackageDir(shell), false, '只有 dsh 壳的顶层不是宿主目录')
    assert.equal(looksLikeHostPackageDir(nested), true, '嵌套层才是宿主目录')
    assert.deepEqual(hostPackageDirsFromPath(join(nested, 'dsh-tools', 'lib', 'index.js')), [nested, shell], '由近到远给出两层，交给调用方按内容挑')
    assert.equal(hostVersionOf(nested), '0.2.1-rc.5')

    // 平铺布局：npx 缓存与桌面 asar 的形态。
    const flat = join(root, 'npx', 'node_modules', '@deepseek-ai')
    writePackage(join(flat, 'dsh'), '@deepseek-ai/dsh', '0.2.1-rc.5')
    writePackage(join(flat, 'cordis'), '@deepseek-ai/cordis', '4.0.5')
    writePackage(join(flat, 'dsh-tools'), '@deepseek-ai/dsh-tools', '0.2.1-rc.5')
    assert.equal(looksLikeHostPackageDir(flat), true)
    assert.equal(hostVersionOf(flat), '0.2.1-rc.5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('LibreOffice Kit 段按正文判断，不写死技能名', () => {
  // 操作技能正文自述要这段路径；创作技能不提 LibreOffice。
  assert.equal(officeKitApplies('Use the installed LibreOffice Kit CLI through the shell with the absolute Node and CLI paths supplied below.'), true)
  assert.equal(officeKitApplies('Read, create, edit and validate Word documents (.docx).'), false)
  // 大小写与行内位置都不影响。
  assert.equal(officeKitApplies('依赖 libreoffice 完成渲染'), true)
})
