// dsh-plugin-tool-management — host half, written in TypeScript to the DeepSeek Harness
// plugin development standard (https://deepseek-harness.github.io/deepseek-harness/develop/basic/):
//   * object-form Cordis plugin: { name, inject, apply } (docs: "对象形式")
//   * required services declared in `inject` — the framework guarantees they are
//     ready before apply runs, and reloads the plugin if one disappears
//   * agent-facing capability exposed as registered tools (ctx.tools.register +
//     defineTool), the documented way to add model-callable abilities
//   * UI-facing capability exposed via a webServer exact route (used by the
//     client half), registered defensively
//
// Build: `tsc -p tsconfig.json` compiles this to lib/index.js (the shipped
// artifact — same convention as DSH's own packages, which ship compiled JS).

import type { Context } from '@deepseek-ai/cordis'
import { symbols } from '@deepseek-ai/cordis'
import { defineTool as hostDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createHistoryDomain } from './sessions/history.js'
import type { SessionsRegistry } from './sessions/history.js'
import { createSkillsService, pluginLog } from './skills/service.js'
import { renameWithRetry } from './skills/core.js'
import { createPromptsService } from './prompts/service.js'
import { createQuickPromptsService } from './prompts/quick-service.js'
import { isValidPresetId } from './prompts/preset-id.js'
import { isInsideRoot, isInsideRootResolved } from './paths.js'
import { DEFAULT_PROFILE_NAME, MCP_CLIENT_MODULE, MCP_TOOL_PREFIX, PROFILE_CANDIDATES, serverNameCandidates, splitMcpToolName, type McpToolNameParts } from './host-names.js'
import { createMemoriesService, planMemoryExport } from './memories/service.js'
import { createArchiveEngine } from './memories/archive-engine.js'
import { createSnapshotOps } from './ops/snapshot.js'
import { AUDIT_TARGET_CONFIG, clearAudit, readAudit, recordAudit, recordOpAudit } from './audit-log.js'
import { readIndexSync } from './memories/index-io.js'
import { runStateDoctor } from './ops/state-doctor.js'
import { createSubagentService, decideToolFilter, defaultPersonasDir, validPersonaName } from './subagents/service.js'
import type { ToolFilterDecision } from './subagents/service.js'
import { createSubagentCatalog } from './subagents/catalog.js'
import { createSkillCatalog } from './skills/catalog.js'
import {
  createContextInjector,
  subagentDepthOf,
  type LiveInjectionSnapshot,
} from './context-inject.js'
import { isApprovalNever } from './approval-policy.js'
import {
  DEFAULT_HIDDEN_TOOLS,
  FACTORY_TOOL_TABLE_PRESET,
  normalizeToolTableSettings,
  type ToolTableSettings,
} from './tools/table.js'
import { createToolTableSwitch } from './tool-table-switch.js'
import { createSettingsSidecars } from './settings-sidecars.js'
// 改名 / 进场景 / 存档案的联动（op 重包，2026-10-01 从本文件 apply 闭包整段抽出）。
import { installSceneLinkage } from './scene-linkage.js'
// 访问令牌的宿主侧配置读写（2026-10-01 从本文件 apply 闭包整段抽出，依赖显式传参）。
import { createTokenConfig } from './token-config.js'
import { EXPECTED_MIN_HOST_VERSION, EXPECTED_PEER_RANGE, VERIFIED_HOST_VERSION, summarize } from './compat/probe.js'
import { checkPatchWrite, takePatchGuardWarnings } from './compat/patch-dialect.js'
import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'
import { assessPresetReach, injectionFactsOf, presetRosterOf, readCompositionFacts, reachNoticeForAgent } from './compat/preset-reach.js'
import { installHttpApi, type WebServerService } from './http-api.js'
import { createMcpManager } from './mcp/manager.js'
// 确认卡回显"新 URL"时要打码（查询串里的凭据不该明文进卡片），口径与列表视图同一份实现。
import { maskUrlQuery } from './mcp/secret-guard.js'
import { createCandidates } from './scenes/candidates.js'
import type { PluginInventoryService, ToolsService } from './mcp/manager.js'

// 「已知工具」归一化与「当前可用工具数」原本定义在本文件（导出仅为测试接缝），
// 2026-09-19 随 MCP 域搬进 ./mcp/manager.ts。这里保持原路径可导出，契约不变。
export { normalizeKnownTools, countEnabledTools } from './mcp/manager.js'
import { planOverrideCompaction } from './mcp/override-blocks.js'
import { applyLoaderToken, applyLoaderTokenDisabled, buildLoaderOverrideEntry, readLoaderToken, scanLoaderRows } from './mcp/loader-token.js'
// cordis.patch.yml 受管行的生成/解析/块编辑（2026-09-19 从本文件 apply 闭包抽出，纯字符串运算）。
import { appendBlock, buildDisableBlock, buildInsertBlock, parseRows, removeEntryAll, removeMarked, spliceRanges, splitLines, type ManagedRow } from './mcp/patch-yaml.js'
import { describeMaskedOutcome, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from './mcp/secret-guard.js'
import { DEFAULT_MCP_NOTE_MAX_LENGTH, createMcpStateCatalog, normalizeMcpNote } from './mcp/state-section.js'
import { hubBackupDir, hubPath, hubRoot, migrateHubLayoutSync, relocateEntries } from './hub.js'
// 分域的 HTTP ops（2026-09-19 从本文件 handlers 表抽出，依赖显式传参）。
import { buildCompatOps } from './ops/compat.js'
import { buildPromptOps } from './ops/prompts.js'
import { buildQuickPromptOps } from './ops/quick-prompts.js'
import { buildSessionOps } from './ops/sessions.js'
// HTTP 请求准入与 handlers 后处理（2026-09-19 从本文件 apply 闭包抽出，依赖显式传参）。
import { createAccessToken, createFrozenGate, createOpWhitelist, createSceneLock, guardModelOp, guardModelOps, installHandlerGuards } from './request-gate.js'
// `isReadCall` 随 HTTP 路由一起搬走了（写门禁与审计流水都读同一份登记表判据）。
import { auditOpRegistry, auditProblems } from './op-registry.js'
import { buildSceneSyncOps } from './ops/scene-sync.js'
import { buildCandidateOps } from './ops/candidates.js'
// model 工具（ctx.tools.register）按域分文件；共享的依赖形状见 tools/deps.ts。
import { buildMcpTools } from './tools/mcp.js'
import { buildSkillTools } from './tools/skills.js'
import { buildPromptTools } from './tools/prompt.js'
import { buildMemoryTools } from './tools/memory.js'
import { buildSceneTools } from './tools/scene.js'
import { buildSubagentTools } from './tools/subagent.js'
import { createScenePromptSync } from './scene-prompt-sync.js'
import { defineSubagentManagerListTool, defineSubagentManagerRunTool } from './subagents/tools.js'
import { detectFormat, extractText, parseGenericText, parseJsonlTranscript, parseMarkdownTranscript } from './imports/parsers.js'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { zipSync } from 'fflate'

// ---------------------------------------------------------------------------
// Minimal structural types for the service surfaces this plugin touches.
// The full contracts live in the corresponding @deepseek-ai packages; these
// local interfaces keep the build dependency surface small.
//
// HttpReq / HttpRes / WebServerService 原本也住在这里：2026-10-01 随 HTTP 路由正文
// 一起搬进 ./http-api.ts（只有那条路由与下面的 DshContext.webServer 用得到）。
// ---------------------------------------------------------------------------

interface FsService {
  resolve(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean } | undefined>
  readText(path: string): Promise<string>
  writeText(path: string, content: string, encoding?: unknown, flag?: unknown, policy?: unknown): Promise<void>
  listDir(path: string): Promise<Array<{ name: string }>>
}

interface SettingsService {
  prepareDocument(): Promise<unknown>
}

interface SandboxPolicyService {
  resolve(options: { mode: string }): Promise<unknown>
}






// ---------- Skills management types (minimal surface of ctx.skills) ----------
interface SkillInvocation {
  modelInvocable: boolean
  userInvocable: boolean
}
interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocation
  source: string
  provider: string
  resourceBase?: unknown
  path?: string
}
interface SkillDefinition extends SkillSummary {
  content: string
  metadata?: unknown
}
interface SkillProviderControl {
  signal: { aborted: boolean; addEventListener(type: string, fn: () => void, opts?: unknown): void }
  invalidate(): void
}
interface SkillService {
  registerProvider(create: (control: SkillProviderControl) => {
    name: string
    list(options?: unknown): Promise<SkillSummary[] | { candidates: SkillSummary[]; complete: boolean }>
    get(candidate: SkillSummary, options?: unknown): Promise<SkillDefinition | undefined>
  }): unknown
  snapshot(options?: unknown): Promise<{ skills: SkillSummary[]; complete: boolean }>
  get(name: string, options?: unknown): Promise<SkillDefinition | undefined>
}

interface DshContext extends Context {
  timer: unknown
  fs: FsService
  settings: SettingsService
  sandboxPolicy: SandboxPolicyService
  webServer: WebServerService
  skills: SkillService
  timeout(delay: number): Promise<void>
}

// ---------------------------------------------------------------------------
// Transcript export helpers — mirror the import parsers (src/imports/parsers.js)
// so an exported file can be imported back losslessly. Pure Node, no ctx.
// ---------------------------------------------------------------------------

/** 从会话事件数组提取用户/助手纯文本轮次（与导入解析器对称）。 */
function extractTurnsFromEvents(events: unknown[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as { type?: string; data?: { content?: unknown; message?: { content?: unknown } } }
    let content: unknown
    if (e.type === 'user/message') content = e.data && e.data.content
    else if (e.type === 'assistant/message') content = e.data && e.data.message && e.data.message.content
    else continue
    const text = extractText(content).trim()
    if (text) turns.push({ role: e.type === 'user/message' ? 'user' : 'assistant', text })
  }
  return turns
}

/** 序列化为可再导入的转录文本：Codex 风格 Markdown 或 Claude Code 风格 JSONL。 */
function serializeTurns(turns: Array<{ role: 'user' | 'assistant'; text: string }>, format: 'markdown' | 'jsonl'): string {
  if (format === 'jsonl') {
    return turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.text } })).join('\n')
  }
  return turns.map((t) => (t.role === 'user' ? '## User\n' : '### Assistant\n') + t.text).join('\n\n')
}

/**
 * `inject` 的服务名清单（单一来源）：既声明给宿主，也是「挂载心跳」与 doctor 核对的内容。
 *
 * 为什么值得单列：任何一个名字被官方改名，本插件**根本不会 apply** —— 实测（2026-09-20，本仓库
 * cordis）cordis 对未解析的 inject 既不抛错、不打日志、不发 warning，只把该 Fiber 停在非活动态。
 * 那种情形下探测表 / 上报通道 / 兼容页**全都不存在**（失败域里一个信号都没有），本插件两次
 * "宿主起不来"的历史事故也属于这一类。心跳文件是事后唯一的线索：doctor 读它 + 这份名单，
 * 才能说清"插件这一轮没挂上，去核对这几个服务名"。
 */
export const INJECT_SERVICES = [
  'timer', 'fs', 'settings', 'sandboxPolicy', 'webServer', 'tools', 'skills', 'sessions',
  'agents', 'workspaceRegistry', 'sessionProjectionCache', 'sessionPersistence',
] as const

/** 工具表设置预热完成前的答案：一个都不关（见 apply 里 toolTableHidden 的注释）。 */
const EMPTY_TOOL_SET: ReadonlySet<string> = new Set()

export default {
  name: 'dsh-plugin-tool-management-host',
  inject: [...INJECT_SERVICES],
  apply(ctx: DshContext, config?: Record<string, unknown>) {
    // 布局迁移必须**先于任何读盘**：hub 内的旧名（`agents-md/` → `prompts/` 等）与
    // `$DSH_HOME` 根下的插件侧车 / 日志 / patch 备份，都要在服务读它们之前搬到位。
    // 同步执行：一次性的几次 stat/rename，换来「没有并发窗口」；失败只跳过该项，不抛错。
    migrateHubLayoutSync()
    const fs = ctx.fs
    const settings = ctx.settings
    const sandboxPolicy = ctx.sandboxPolicy
    const webServer = ctx.webServer
    const tools = ctx.tools
    const agents = ctx.get('agents') as unknown as {
      create?(options: Record<string, unknown>): Promise<unknown>
    } | undefined
    // pluginInventory is optional: probe at use time, degrade to no live info.
    const pluginInventory = ctx.get('pluginInventory') as PluginInventoryService | undefined

    // Package version, surfaced in the Settings pages and the HTTP API. Read
    // from the installed package.json so it always matches the release tag.
    let PKG_VERSION = 'unknown'
    try {
      PKG_VERSION = (createRequire(import.meta.url)('../package.json') as { version?: string }).version || 'unknown'
    } catch (e) { /* keep unknown */ }

    // 访问令牌（2026-09-19 抽到 ./request-gate.ts）：配置里的存量令牌 / 生效令牌 / 比对 /
    // 进程标识。引用点用解构保持原名字，index.ts 的调用处一行未改。
    const { CONFIG_TOKEN, TOKEN_DISABLED, TOKEN, tokenMatches, BOOT_ID, acceptedThisBoot, markAccepted, unmarkAccepted } = createAccessToken({ config })

    const wait = (ms: number) => ctx.timeout(ms)
    const message = (e: unknown) => String((e && (e as Error).message) || e)

    let writeChain: Promise<void> = Promise.resolve()
    function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = writeChain.then(() => fn(), () => fn())
      writeChain = run.then(() => undefined, () => undefined)
      return run
    }

    // ---------- skills management (core service, ported from dsh-skills-manager) ----------
    // 文件操作核心在 ./skills/core.js 与 ./skills/readonly-discovery.js（原样移植，
    // 来源裁剪为 dsh/agents/codex/claude）；服务层把 core 的结果适配成 { op, args }
    // 协议，并在全局层与每个活动 agent 的 scope 内注册 manager provider：
    // rank 覆盖实现不改源文件的启停；外部来源由 provider 接入。
    const skillsService = createSkillsService(ctx)
    try {
      ctx.effect(() => skillsService.registerProviders(), 'dsh-plugin-tool-management: skills providers')
    } catch (e) {
      console.error('[dsh-plugin-tool-management] skills provider setup failed:', message(e))
      // B3：技能 provider 没挂上 → 技能页与 agent 技能目录静默失效。此前只落 console。
      noteRuntime({
        id: 'skills-provider',
        label: '技能 provider 装配',
        kind: 'read',
        fallback: 'inform-only',
        detail: '技能 provider 装配失败（' + message(e) + '）：技能启用/停用与 agent 技能目录这一轮不生效。',
        detailKey: 'skills-provider',
        params: { reason: message(e) },
      })
    }

    // ---------- 提示词预设库（hub/prompts/）+ 切换 ----------
    // DSH 全局指令基线只有 ~/.dsh/AGENTS.md 一个文件，无内置多预设切换；
    // 本服务在 hub 内 prompts/ 维护预设库，「应用」= 写入 ~/.dsh/AGENTS.md，
    // 下一轮对话生效：宿主 dsh-agent-instructions 每个 agent/pre-step 都会 **stat 比对版本**，
    // 变了才重读（`dsh-agent-instructions/lib/index.js:992` 每步探测、`:1012-1013` 命中
    // "path/version/digest 一致"即跳过读取、`:1016` 才是真正的 read）。写文件必改 version
    // ⇒ 短路失效 ⇒ 下一步重读，所以"下一轮生效"成立。
    //
    // 一条**没被任何注释记录**的依赖点：本服务用 node:fs 直写 AGENTS.md，不产生
    // `touchedPaths`；而官方的增量刷新由 `tools/result` 的文件触碰驱动（白名单只有
    // read/write/edit），且"有 pending 投影且无 touchedPaths"时整轮不探测、直接返回旧消息
    // ⇒ 插件的改动**永远走不到增量投影分支**，只能被基线 stat 分支捞回。别指望靠"宿主
    // 也会自己发现"来兜底。
    // presetsDir 可由 config 注入（测试用），否则落到 $DSH_HOME/tool-management/prompts。
    // v0.4：旧位置（插件目录 data/agents-md-presets/）在启动时搬入 hub——
    // 插件目录在 npm 安装下会被覆盖，放用户数据在那里本身就丢数据风险。
    const PLUGIN_ROOT = (() => {
      try { return dirname(createRequire(import.meta.url).resolve('../package.json')) } catch { return process.cwd() }
    })()
    const legacyPromptsDir = join(PLUGIN_ROOT, 'data', 'agents-md-presets')
    const promptsDir = String((config as { presetsDir?: unknown } | undefined)?.presetsDir || hubPath('prompts'))
    void relocateEntries(legacyPromptsDir, promptsDir, (n) => n !== '__last-applied__')
      .catch(() => 0)
    const promptsService = createPromptsService(ctx, {
      presetsDir: promptsDir,
      getGlobalAgentsMdPath: async () => {
        const p = await ensurePaths()
        const sep = p.home.indexOf('\\') >= 0 ? '\\' : '/'
        return p.home + sep + 'AGENTS.md'
      },
    })

    // ---------- 快捷提示词（hub/quick-prompts/）----------
    // 与上面的预设库**两份存储**，不是同一份加个标记位：`list()` 只扫自己目录，所以快捷词
    // 天然进不了「应用 / 场景绑定 / 注入 / 模型工具」这四条只认 hub/prompts/ 的路径。
    // 理由见 ./prompts/quick-service.ts 头注。
    const quickPromptsDir = hubPath('quick-prompts')
    const quickPromptsService = createQuickPromptsService({ dir: quickPromptsDir })
    const quickPromptOps = buildQuickPromptOps(quickPromptsService)

    // ---------- rules（规则/记忆，v0.4）----------
    // 记忆真源 $DSH_HOME/tool-management/memories/<场景>/<name>.md（仅用户级，D1）。
    // **场景是显式记录**（memories-index.json 的 scenes 切片）：含保留场景 `global`（界面「全局」，
    // 其记忆注入任何对话），空场景也合法存在——不再是"恰好有这个目录名"的隐式约定。
    // 单投影 = 活动场景记忆 → 上下文注入（自动在场，模型无需调用任何工具；见下方注入通道）。
    // 原"始终层写 ~/.dsh/AGENTS.md"已下线（变更单 01 §4/§10）：公共基线由 _shared/ 承担。
    // 旧的 $DSH_HOME/scene-memory 与 $DSH_HOME/rules 由服务在首次读盘前搬入本目录。
    // memoriesRoot / memoriesStateDir / memoriesScenesDir 仅测试注入，生产留空由服务按 DSH_HOME 解析。
    const memoriesService = createMemoriesService(ctx, {
      memoriesRoot: String((config as { memoriesRoot?: unknown } | undefined)?.memoriesRoot || ''),
      stateDir: String((config as { memoriesStateDir?: unknown } | undefined)?.memoriesStateDir || ''),
      scenesDir: String((config as { memoriesScenesDir?: unknown } | undefined)?.memoriesScenesDir || ''),
      // 场景记忆段预算（字节），默认 131072（= DEFAULT_MAX_BYTES，128 KiB）；仅用于测试与特殊部署调优。
      ...(Number.isFinite(Number((config as { rulesMaxBytes?: unknown } | undefined)?.rulesMaxBytes))
        ? { maxBytes: Number((config as { rulesMaxBytes?: unknown }).rulesMaxBytes) }
        : {}),
      // 全局 AGENTS.md 的**宿主实际读的那一份**（profile home 下，与上面 `getGlobalAgentsMdPath`
      // 同源）。`readGlobalAgentsMdSync` 的去重/兜底必须读它 —— `resolveDshHome()` 是另一条
      // 独立来源（见 `ensurePaths` 的注释「不合并是有意的」），两边不同时会取到另一个文件、
      // 去重永远不相等 → 同一份预设正文注入两遍（审查 P2-19）。
      // 惰性求值：`cached` 在下面的 path discovery 段才声明（`let`），而本箭头函数只在 op
      // 被调用时才求值 —— 那时 `ensurePaths()` 早已跑过。外面这层 `try` 是防**将来**有人在
      // apply 中途同步调用 memories op 那种时序（`let` 的 TDZ 会抛 ReferenceError）。
      globalAgentsMdPath: () => {
        try {
          const p = cached
          if (!p) return null
          const sep = p.home.indexOf('\\') >= 0 ? '\\' : '/'
          return p.home + sep + 'AGENTS.md'
        } catch { return null }
      },
    })
    // 场景记忆段的注册/生命周期由下面的注入通道统一管（memoriesService.memoryText / promptText）。

    // ---------- 场景档案引擎（设计 §2）----------
    // deps 把既有写通道（MCP 单工具启停 / 技能启停）注入引擎；引擎自身串行，
    // 状态机与纯逻辑在 ./memories/archive*.ts。mcpmToolEnabled / readDisabledTools
    // 为函数声明（提升），此处引用安全。
    // MCP 工具全名 → `{ server, tool }`。**切分规则只有一套**：`splitMcpToolName`
    // （`host-names.ts`），与执行侧守卫 `mcp.isToolDisabled` 走的是同一个函数（2026-09-30 审查 N1）。
    // 这里只负责把**候选 serverName 集合**传进去 —— 集合不同是切分结论不同的另一个来源，
    // 所以集合也用同一个 builder（`serverNameCandidates`）从**同一批表**（停用表 ∪ 已知工具缓存）
    // 取并集，不在这里手写 `Object.keys`。
    const toolKeyParts = (
      toolName: string,
      serverNames: Iterable<string>,
    ): McpToolNameParts | null => splitMcpToolName(toolName, serverNames)
    /**
     * 一次扫描同时给出三样东西（避免为了三份视图各扫一遍磁盘）：
     *  - `states`：**真实生效**的技能 `<rootKey>/<name>` → boolean；
     *  - `shadowed`：被同名技能覆盖的键集合（`sk.shadowedBy` 存在）；
     *  - `all`：全部键 → boolean（被覆盖的副本记 `false`，但键保留）。
     *
     * 为什么要区分：`sk.enabled` 只有**同名竞争的胜者**才有值，被覆盖的副本恒为 `undefined`。
     * 旧实现用 `sk.enabled !== false` 取值，把副本误判成「已启用」，于是场景模式退出回放快照时
     * 会凭空往 `enabledSkills` 写条目；反过来把副本当成「已停用」又会在进入模式时把用户
     * 显式启用的记录改写成显式停用。两种都会在「同名竞争消失 / 来源重新打开」后改变实际行为。
     */
    async function skillScan(): Promise<{
      states: Record<string, boolean>
      shadowed: Set<string>
      all: Record<string, boolean>
      /** 结构不完整（缺 frontmatter / 名字非法 / 描述为空）的键：core 一律拒绝启停。 */
      unloadable: Set<string>
    }> {
      const r: any = await skillsService.ops['skill-state']({})
      const states: Record<string, boolean> = {}
      const all: Record<string, boolean> = {}
      const shadowed = new Set<string>()
      const unloadable = new Set<string>()
      for (const root of ((r && r.data && r.data.roots) || [])) {
        for (const sk of (root.skills || [])) {
          const name = String(sk.declaredName || sk.name || '')
          if (!name) continue
          const key = String(root.key || '') + '/' + name
          // 结构不完整的技能在 core 里**一律拒绝启停**（error.skill.notLoadable）：
          // 档案里若残留这样的键，旧实现会把 `applySkills` 的"应用失败"抛出去，于是
          // **整个场景进不去**。这里单独收集，与「被覆盖」同口径处理（见 applySkills）。
          if (sk.loadable === false) unloadable.add(key)
          if (sk.shadowedBy) {
            shadowed.add(key)
            all[key] = false
            continue
          }
          const on = sk.enabled === true
          states[key] = on
          all[key] = on
        }
      }
      return { states, shadowed, all, unloadable }
    }
    /**
     * 档案里**能写、且写了有意义**的技能键：既不被同名技能覆盖，结构也完整。
     *
     * 为什么要单独给一个集合：档案的语义是「勾选集 = 该场景下开着的东西」，而被覆盖的副本
     * 永远不可能生效（`applySkills` 直接跳过），结构不完整的更是启停都被 core 拒绝 ——
     * 它们进档案只会造成「档案说开着、运行时说关着」（用户实测：启动目录后档案里多出被覆盖
     * 的那个技能，而技能页显示它并未启动）。保存档案时按这个集合校验，顺带清理历史残留。
     */
    async function selectableSkillKeys(): Promise<Set<string>> {
      const { shadowed, unloadable } = await skillScan()
      const all = new Set(Object.keys(await skillStates()))
      for (const k of shadowed) all.delete(k)
      for (const k of unloadable) all.delete(k)
      return all
    }
    async function skillStates(): Promise<Record<string, boolean>> {
      // knownSkillKeys 需要**全量键**（含被覆盖的副本）：场景档案里允许勾选任意一条技能，
      // 用生效集去校验会把合法勾选判成 stale 丢掉。
      return (await skillScan()).all
    }

    // 整体替换关停名单的那一步抽成具名函数：引擎的 apply 依赖与「修改场景」表单的
    // 即时生效（scene-sync 包装）共用同一条写路径，不能各抄一份。
    const applyToolTableHiddenNow = async (hidden: string[]) => {
      // 与 `tool-table` op 写分支同一条路径、同一顺序：落盘 → 重排可见性 → 两个目录重算。
      // 绕开这套顺序就会留下「名单已经改了、工具下一轮还发给模型」这种最难查的状态。
      const current = await readToolTableSettings()
      const next: ToolTableSettings = {
        hidden: normalizeToolTableSettings({ hidden }).hidden.filter((name) => toolTableSizes.has(name)),
        presets: current.presets,
      }
      const saved = await writeToolTableSettings(next)
      if (!saved.ok) throw new Error(saved.error)
      mcp.scheduleToolRestrictions()
      await Promise.all([
        skillCatalog.refresh().catch(() => { /* 目录刷新失败不该让工具表写入算失败（与 op 侧同口径） */ }),
        subagentCatalog.refresh().catch(() => { /* 同上 */ }),
      ])
    }

    const archiveService = createArchiveEngine({
      // 引擎每应用/还原一次整套档案记一条流水（source='engine'，见 ./audit-log.ts）。
      // 记在边界这一层而不是往五个 apply* 里散着写：一条流水说的是「引擎动了整个环境」，
      // 与同一次进入里面板/模型那条记录天然按秒分组显示。
      audit: (op: string, target: string) => recordAudit({ ts: Date.now(), op, target: target || AUDIT_TARGET_CONFIG, source: 'engine' }),
      // ── 模型工具表（0.15.0 C1）：场景可以绑一份方案，进场景整体换成那一份 ──
      currentToolTableHidden: async () => [...(await readToolTableSettings()).hidden],
      toolTablePresetHidden: async (name: string) => {
        const s = await readToolTableSettings()
        // 用户存的方案**优先**：万一有人把方案起名叫 'factory-default'，他要的是自己那份。
        const hit = s.presets.filter((p) => p.name === name)[0]
        if (hit) return [...hit.hidden]
        return name === FACTORY_TOOL_TABLE_PRESET ? [...DEFAULT_HIDDEN_TOOLS] : null
      },
      applyToolTableHidden: applyToolTableHiddenNow,
      loadSlice: async () => ({ ...(await memoriesService.readArchiveSlice()) }),
      // `fields` 必须原样透传：它决定"本次只写哪几片"，是审查 P2-3 里防丢更新的关键。
      saveSlice: (slice, fields) => memoriesService.patchIndex(slice, fields),
      saveArchive: (scene, archive) => memoriesService.saveArchive(scene, archive),
      // 与 `serverKnownTools` 用同一个出口：都是「补丁里配了哪些 serverName」。
      // 早先这里走 `mcpmListView()` —— 那份会顺带枚举工具 schema 并回写「已知工具」缓存，
      // 而档案引擎只要名字（2026-09-30 审查 N1 顺带收窄）。
      configuredServers: () => mcp.configuredServerNames(),
      serverKnownTools: async () => {
        const out: Record<string, string[]> = {}
        const raw = await mcp.readDisabledTools()
        for (const [server, list] of Object.entries(raw)) out[server] = list.filter((t) => t !== '*')
        // 「已知工具」缓存：未运行服务器也能按最后见过的名单计算补集。
        const known = await mcp.readKnownMcpTools()
        for (const [server, list] of Object.entries(known)) {
          out[server] = [...new Set([...(out[server] || []), ...list.map((item) => item.name)])].sort()
        }
        // 候选集合必须在**往 out 里补 live 工具之前**取：补进去的键是从 schema 名切出来的，
        // 拿它当候选就成了循环论证（切错了也照样"命中"）。
        //
        // 三个来源里，补丁那份（`configuredServerNames`）是唯一与切分结果无关的 —— 停用表的键
        // 来自界面勾选、缓存键来自上一次切分，单靠它们会锁死错误结论（审查 N1 / R3）。
        let configured: string[] = []
        try { configured = await mcp.configuredServerNames() } catch { /* 补丁读不到 → 退化为另两份 */ }
        const serverNames = serverNameCandidates(configured, raw, known)
        let schemas: any[] = []
        try { schemas = await tools.schemas() } catch { /* 无 live 工具 → 仅停用表 + 缓存 */ }
        for (const s of schemas) {
          const p = toolKeyParts(String((s && s.name) || ''), serverNames)
          if (!p) continue
          const list = out[p.server] || (out[p.server] = [])
          if (list.indexOf(p.tool) < 0) list.push(p.tool)
        }
        return out
      },
      currentMcpRaw: () => mcp.readDisabledTools(),
      applyMcpEntries: async (entries: Record<string, string[]>) => {
        await mcp.writeDisabledTools(entries)
      },
      knownSkillKeys: async () => new Set(Object.keys(await skillStates())),
      // 档案保存校验用：被同名覆盖的副本与结构不完整的技能都不算「可勾选」（见 selectableSkillKeys）。
      selectableSkillKeys,
      // 快照只取**真实生效**的条目（不含被同名覆盖的副本）——副本不参与模式应用，
      // 退出回放时也不该去动它们，否则会改写用户对副本的显式策略记录。
      currentSkills: async () => (await skillScan()).states,
      applySkills: async (target: Record<string, boolean>) => {
        // 三道过滤，缺一不可：
        //  1. 被同名覆盖的副本直接跳过——它们本来就不生效，写策略只会污染用户的记录。
        //  2. 结构不完整的技能也跳过——core 对它们一律拒绝启停（error.skill.notLoadable），
        //     不跳过就会抛成"应用失败"，**整个场景进不去**（老档案里的残留键能踩到）。
        //  3. **已经处于目标状态的技能不再写**。`applySkills` 写的是显式策略记录，而目标
        //     状态是生效状态，两者不等价：对已经生效为「停用」的技能再 disable 一次，
        //     只是把「没有记录」固化成「显式停用」，场景模式进出一次就会改写 state.json。
        const { states, shadowed, unloadable } = await skillScan()
        for (const [key, on] of Object.entries(target)) {
          const i = key.indexOf('/')
          if (i <= 0) throw new Error(`技能 key 不合法: ${key}`)
          // 被同名覆盖的副本跳过（它本来就不生效，写策略只会污染用户的记录）。
          if (shadowed.has(key)) continue
          // 结构不完整的技能跳过：core 对它们**一律拒绝启停**（error.skill.notLoadable），
          // 继续往下走会抛成"应用失败"，**整个场景就进不去了**（老档案里的残留键能踩到）。
          if (unloadable.has(key)) continue
          if (states[key] === on) continue
          const root = key.slice(0, i)
          const name = key.slice(i + 1)
          const r: any = await skillsService.ops[on ? 'skill-enable' : 'skill-disable']({ root, name })
          if (r && r.ok === false) throw new Error(`技能 ${key} 应用失败: ${r.error}`)
        }
      },
      // ── 服务器级 / 来源级启停（P5）────────────────────────────────────────────
      // 为什么档案必须能改**上层**：工具级停用只在「服务器已经加载」时才有意义 ——
      // 服务器没起来，它的工具根本不存在，勾选与否毫无区别。技能同理：来源关闭时，
      // 技能级的 enable 会被 core 的 sourceEnabled 判定直接吞掉。
      // 只报**补丁文件里真实存在**的行（level = project/global）；loader 级条目改不了补丁。
      mcpServerStates: async () => {
        const r: any = await mcp.mcpmListView()
        const out: Array<{ id: string; serverName: string; level: string; disabled: boolean }> = []
        for (const row of ((r && r.rows) || [])) {
          const level = String((row && row.level) || '')
          if (level !== 'global' && level !== 'project') continue
          out.push({
            id: String(row.id),
            serverName: String(row.serverName || row.id),
            level,
            disabled: !!row.disabled,
          })
        }
        return out
      },
      applyMcpServerSwitches: async (switches) => {
        for (const s of switches) {
          const r: any = await mcp.ops['mcpm-set-enabled']({ id: s.id, level: s.level, enabled: s.enabled })
          if (r && r.ok === false) throw new Error(`MCP 服务器 ${s.id} ${s.enabled ? '启用' : '停用'}失败：${r.error}`)
        }
        // 补丁改动由宿主热重载（实测 ≤5s）。这里**不等**，避免进入模式被拖住十几秒；
        // 界面在应用完成后即可用，工具集合会在数秒内补齐。
      },
      // 场景备注（v0.8.1）：备注写在 hub 内的 `mcp-notes.json`（按 loader id），
      // 场景档案按 serverName 存 —— 引擎负责映射与读写，与 mcpm-note 同一条写锁。
      currentMcpNotes: async () => ({ ...(await mcp.readNotes()) }),
      applyMcpNotes: async (entries) => {
        // 映射规则（按 serverName 存的档案 → 按 loader id 存的备注）留在引擎这一侧，
        // manager 只负责「在写锁内读-改-写」这一件事。
        await mcp.updateNotes((map) => {
          for (const e of entries) {
            if (e.note) map[e.id] = e.note
            else delete map[e.id]
          }
        })
      },
      mcpIdOfServer: async (serverName) => {
        const r: any = await mcp.mcpmListView()
        for (const row of ((r && r.rows) || [])) {
          if (String(row.serverName || row.id) === serverName) return String(row.id)
        }
        return undefined
      },
      skillSourceStates: async () => {
        const r: any = await skillsService.ops['skill-state']({})
        const roots = (r && r.data && r.data.roots) || []
        const out: Array<{ root: string; enabled: boolean }> = []
        for (const root of roots) {
          const key = String((root && root.key) || '')
          if (!key) continue
          // 默认来源（dsh / hub）不能停用（core 会拒绝）→ 不进切换集，避免无谓报错。
          if (root.defaultSource === true) continue
          out.push({ root: key, enabled: root.enabled === true })
        }
        return out
      },
      /**
       * 来源级启停（进入 / 退出 / 就地重应用共用）。
       *
       * 容错口径（用户 2026-09-17 报「退出模式失败 → 卡在场景里」之后加的）：**结构性**失败
       * （来源解析不到 / 该来源本来就不允许启停）只记警告并跳过 —— 这一行与本次改动无关，
       * 拿它中断整个恢复只会把用户困在场景里；**写盘**类失败仍然抛错，那说明确实没还原成功。
       * 结构性失败的正解在 `skills/service.ts` 的 `requestSwitchRoot`（项目来源按 key 前缀解析）。
       */
      applySkillSourceSwitches: async (switches) => {
        const skipped: string[] = []
        for (const s of switches) {
          const op = s.enabled ? 'skill-source-enable' : 'skill-source-disable'
          let r: any
          try {
            r = await skillsService.ops[op]({ root: s.root })
          } catch (e) {
            r = { ok: false, error: message(e), code: '' }
          }
          if (r && r.ok === false) {
            const code = String((r && r.code) || '')
            const structural = code === 'error.root.readonly' || code === 'error.root.unknown' ||
              /来源不存在|不允许启用或停用/.test(String(r.error || ''))
            if (structural) {
              skipped.push(`${s.root}（${r.error}）`)
              continue
            }
            throw new Error(`技能来源 ${s.root} ${s.enabled ? '启用' : '停用'}失败：${r.error}`)
          }
        }
        if (skipped.length) {
          ctx.logger?.warn?.(`scene: 跳过无法启停的技能来源 —— ${skipped.join('、')}`)
        }
      },
      sceneExists: async (name) => {
        const r: any = await memoriesService.ops['rules-list']({})
        return !!(r && r.ok !== false && (r.scenes || []).some((s: any) => s.name === name))
      },
      // 人设名全集（保存 subagents 段时校验并报 stale，与 mcp/skills 两段同口径）。
      knownPersonas: async () => new Set((await subagentService.list()).map((p) => p.name)),
      // 人设开关读/写（进入模式：勾了的启用、未勾的停用；退出按快照两个方向还原）。
      disabledPersonas: async (names: string[]) => subagentService.enabledStore.disabledAmong(names),
      enabledPersonas: async (names: string[]) => subagentService.enabledStore.enabledAmong(names),
      applySubagentSwitches: async (switches: Array<{ name: string; enabled: boolean }>) => {
        const off = switches.filter((s) => !s.enabled).map((s) => s.name)
        const on = switches.filter((s) => s.enabled).map((s) => s.name)
        if (off.length) await subagentService.enabledStore.setEnabled(off, false)
        if (on.length) await subagentService.enabledStore.setEnabled(on, true)
        void subagentCatalog.refresh()
      },
      // 快捷提示词（0.18.0）：档案定义了 quickPrompts 段时，进入场景 = 把每一条的开关置成
      // 「在不在这份清单里」，退出按快照还原。读写的就是提示词页那颗开关的同一份存储
      // （`hub/quick-prompts/<id>/meta.json`），不在别处再算一套状态。
      knownQuickPrompts: async () => {
        const r = await quickPromptsService.list()
        return new Set(r.ok === true ? r.prompts.map((p) => p.id) : [])
      },
      quickPromptStates: async () => {
        const r = await quickPromptsService.list()
        if (r.ok !== true) throw new Error(r.error)
        return Object.fromEntries(r.prompts.map((p) => [p.id, p.enabled !== false]))
      },
      applyQuickPromptSwitches: async (switches: Array<{ id: string; enabled: boolean }>) => {
        // 已不存在的 id 由 setEnabled 自己回 ok:false —— 这里**不**把它抛出去：退出场景时
        // "还原一条已被删掉的快捷词"没有可写的地方，让它报错会把整次退出卡住
        // （与 mcpServerRowsToRestore「现在已不存在的行直接跳过」同一口径）。
        for (const s of switches) await quickPromptsService.setEnabled(s.id, s.enabled)
      },
      // 记忆 id 全集。引擎已不消费（memories 段 P5 起废弃），实现保留以维持接口形状。
      knownMemoryIds: async () => {
        const r: any = await memoriesService.ops['rules-list']({})
        return new Set<string>(((r && r.rules) || []).filter((x: any) => !x.shadowed).map((x: any) => String(x.id)))
      },
    })

    // ---------- 轻量子智能体（设计 §3）----------
    // 人设 = $DSH_HOME/tool-management/subagents/<name>.md；运行走官方 ctx.subagents.start（spawn provider）。
    // sceneLists 供场景绑定校验：启用场景（rules-list 的 active 行）档案里的 subagents 并集。
    // stateDir 与 rules 共用同一个覆盖键（测试注入一致）；子智能体开关存 <stateDir>/subagents-index.json。
    const subagentService = createSubagentService(ctx, { stateDir: String((config as { memoriesStateDir?: unknown } | undefined)?.memoriesStateDir || '') })
    const subagentSceneLists = async (): Promise<string[][]> => {
      const slice = await memoriesService.readArchiveSlice()
      const r: any = await memoriesService.ops['rules-list']({})
      if (!r || r.ok === false) return []
      return (r.scenes || [])
        .filter((s: any) => s.active)
        .map((s: any) => slice.archives[s.name]?.subagents ?? [])
    }

    // ---------- 模型工具表开关（侧车 `tool-table.json`，界面在「兼容」页）→ ./tool-table-switch.ts ----------
    // 那 134 行整段搬进同目录模块（侧车 TTL 缓存、三条写路径、`tool-table` op 正文），闭包名字
    // 走 deps。工具体积表 toolTableSizes 按**同一个 Map 对象**交回来：注册口（defineTool 那层）
    // 在外面写它、op 与场景写路径读它 —— 交回对象而不是复制，所以母文件这几处一个字都不用改。
    // 这段仍然留在两个目录之前：目录里那句「用 `X` 查」的提示要读 toolTableHidden —— 搬走的是
    // 这段的正文，不是这段的顺序（顺序就是依赖顺序）。
    // mcp / skillCatalog / subagentCatalog 在本块之后才建，按 getter 交进去：取值发生在真正要
    // 用的那一刻，与原闭包同形，既不撞 TDZ 也不动搬走的那些行。
    const {
      toolTableSizes, recordToolSize, readToolTableSettings, toolTableHidden,
      writeToolTableSettings, toolTableReport, toolTableOp,
    } = createToolTableSwitch({
      ensurePaths, readJsonFile, writeJsonFile, withWriteLock, message, EMPTY_TOOL_SET,
      get mcp() { return mcp },
      get skillCatalog() { return skillCatalog },
      get subagentCatalog() { return subagentCatalog },
    })

    // ---------- 「有官方等价物 ⇒ 我们让位」----------
    // 官方 `skill` 工具（`@deepseek-ai/dsh-tool-skill`）与我们的 `skill_manager_read` 是同一
    // 件事：按名字给正文。标准类预设下它在场，第二份就是白付的 174 tok/轮。
    //
    // 判据抄官方自己的写法（`dsh-tool-skill/lib/index.js:207`：`ctx.tools.get(skillTool.name,
    // agent) === skillTool`）—— 拿 agent 当 scope 问"这个 agent 解析得到 `skill` 吗"。比读
    // 预设组合文件更准：它观察的是**这个 agent 实际能看见什么**（限定到该 scope 的同名 shadow
    // 也算数），而组合文件只能说"配了"。判不出来时返回空 = 不让位：少一条拿正文的路，比多花
    // 174 tok 糟。
    //
    // 与注入侧的关系：那边（`CARRIER_FACT_OF`）按组合事实决定"官方目录在场就不注入我们的
    // 目录"，这边按解析结果决定"官方加载器在场就不下发我们的加载器"。两者只在一种情形下
    // 不一致 —— 组合里挂了、但这个 agent 的 scope 里解析不到（被别的限制摘掉）：那时注入侧
    // 跳过我们的目录，这里仍然保留我们的工具，方向是对的（模型手里还有 list + read）。
    /** `[官方工具名, 我们该让位的工具]` —— 只有技能这一对（官方没有 MCP 管理 / 记忆 / AGENTS 编辑工具）。 */
    const CARRIER_DUPLICATES: ReadonlyArray<readonly [string, string]> = [['skill', 'skill_manager_read']]
    const carrierHiddenToolsFor = async (agent: unknown): Promise<string[]> => {
      // 拿不到 agent 就什么都不让位：`get(name, undefined)` 问的是**全局视图**，而官方那些
      // 工具是按预设挂进 agent 那一层的 —— 问错对象会得出相反的结论。
      if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) return []
      const scope = agent as object
      const out: string[] = []
      for (const [carrier, ours] of CARRIER_DUPLICATES) {
        try {
          if (tools.get(carrier, scope) !== undefined) out.push(ours)
        } catch { /* 读不到 = 不让位 */ }
      }
      return out
    }

    // ---------- 注入通道（场景 / 记忆 / MCP / 技能 / 子智能体 / 提示词，各一条消息）----------
    // 这些文本以前是 systemPrompt 段（persona complete 会整段压掉）。现在改走官方的
    // 「每步注入一条合成消息」通道（skill-catalog / AGENTS.md / 时间上下文同款）：
    // 任何预设都到得了，内容没变不重发。**每个域一条自己的消息**（来源 kind 各不同，
    // 轨迹里各自一行），见 src/context-inject.ts 的文件头。
    //   - 场景和记忆：场景名 + 场景说明 + 记忆正文（同一份文本；场景与记忆是绑定的）。
    //   - 人设：本插件自造的概念，宿主没有对应物 → 模型不知道有哪些人设，subagent_manager_run 不会被触发。
    //   - MCP：启停只改工具 schema，没有任何显式状态陈述 → 模型不知道有哪些 server，
    //     更拿不到用户写的**备注**（那是写给「未来的模型」的决策提示，工具 schema 永远传达不到）。
    // 各域只列「名字 + 摘要」，正文/工具清单绝不进上下文。
    // 口径与理由分别见 src/subagents/catalog.ts、src/mcp/state-section.ts。
    const subagentCatalog = createSubagentCatalog({
      list: () => subagentService.list(),
      sceneLists: subagentSceneLists,
      // 人在「兼容」页把 `subagent_manager_list` 关掉后，截断提示里那句「用 X 查」就是假的。
      listToolVisible: () => !toolTableHidden().has('subagent_manager_list'),
    })
    // ⚠️ 取数必须用 mcpmRowsWithNotes(false)：true 会带上**未打码**的 url/headers/env（含明文密钥）。
    // 技能目录与提示词两个域是**官方载体的兜底**：预设挂得到官方
    // dsh-tool-skill / dsh-agent-instructions 时注入侧会跳过它们（见 context-inject.ts 的
    // CARRIER_FACT_OF），挂不到（极简）时才由这里送 —— 所以极简下也能按开关决定要不要。
    const skillCatalog = createSkillCatalog({
      state: () => skillsService.ops['skill-state']({}),
      listToolVisible: () => !toolTableHidden().has('skill_manager_list'),
    })

    // 三份界面设置侧车（inject / scene / slash）拆到 ./settings-sidecars.ts：读走 3 秒 TTL 缓存，
    // 写共用上面那条串行写锁。工厂只在这里调用一次，三份缓存仍是「每次 apply 一份」。
    // 传的是 apply 作用域里那几个函数声明的引用（提升已初始化），不是快照值。
    const {
      readInjectSettings,
      injectSettingsSync,
      injectNoticeOptions,
      injectSettingsOp,
      readSceneSettings,
      sceneSettingsOp,
      readSlashSettings,
      slashSettingsOp,
    } = createSettingsSidecars({
      ensurePaths,
      readJsonFile,
      writeJsonFile,
      withWriteLock,
      message,
    })

    // 注入实况（只读诊断）：注入器的 live() 读回"最近活跃会话"可见表面上的各域文本。
    // 挂在 apply 作用域：`injection-live` op 与注入器不在同一层（effect 内部）。
    let contextInjectorLive: (() => LiveInjectionSnapshot) | null = null
    // 采纳遥测的入口（同样是 apply 作用域的中转）：工具注册在 effect 之外，
    // 拿不到 effect 内部的 `injector`；经这个 `let` 中转，热更新重建注入器也能跟上。
    let contextInjectorNote: ((toolName: string, agent: unknown) => void) | null = null
    try {
      ctx.effect(() => {
        const injector = createContextInjector({
          ctx,
          // 顺序即界面勾选与消息顺序（用户裁定 2026-09-16）：场景和记忆 → MCP → 技能 →
          // 子智能体 → 提示词。form 是宿主语义轴：记忆是「当前状态」（snapshot，后发取代先发），
          // 三个目录是 catalog，提示词是 instructions（与官方 AGENTS.md 那条行同一形态）。
          //
          // `applicableTo`（2026-09-17 方案 A）：子智能体域按"**目录该不该注入到这么深的
          // 会话**"（人设的 `catalogDepth`，默认 1 = 只在顶层注入）判断，**不是**"能不能
          // 委派"。委派可行性由官方决定：`dsh-tool-subagent` 默认 `maxDepth: 3`，provider
          // 只在传了该值时才校验，所以子代理本来就能继续嵌套（用户实测确认）。此前判据叫
          // "还有没有委派预算"、语义是"还能不能委派"，那是错的 —— 详见 service.ts 里
          // `catalogDepth` 字段的注释。目录正文也按同一个判据过滤（`text(agent)`），两处同源
          // 所以不会分叉。
          //
          // 场景与记忆（2026-09-17 用户裁定；2026-09-23 拆成两个域）：**都只在顶层注入**。
          // 记忆是"父会话的现场"，不是子代理完成任务所需的事实 —— 塞进一次性子会话只会与
          // 角色定义争注意力（实测：子代理跑审查时，上下文里同时躺着人设与整份记忆）。
          // 场景段同理：它说的是"父会话现在处在哪个模式"，而子代理根本没有"模式"可言。
          // 子代理手里有 `memory_manager_list/read` 与 `scene_manager_save`，需要什么自己取；
          // 父代理上下文里也有，相关事实应当由它写进 `task`（子代理的上下文 = 角色 + 任务）。
          // 其余三域对任何深度都成立：提示词是用户规则（本插件的立身之本就是"覆盖到子代理"）、
          // 技能目录与 MCP 状态是"操作这台机器所需的事实"（子代理手里就有 `skill` / `mcp__*`
          // 工具，不知道清单就只能瞎调）。
          domains: () => [
            // 场景（**框架**）：启用的场景 + 场景说明（用户的约定）。排第一 —— 先让模型知道
            // "现在在哪个场景、这个场景的约定是什么"，再读下面的记忆条目。
            { key: 'scene', name: 'tool-management:scene', label: '场景', form: 'snapshot', text: () => memoriesService.sceneCatalogText(), applicableTo: (agent) => subagentDepthOf(agent) === 0 },
            // 记忆（**内容**）：各场景下的条目。与场景段同源、同一条 `applicableTo`。
            { key: 'memory', name: 'tool-management:memory', label: '记忆', form: 'snapshot', text: () => memoriesService.memoryText(), applicableTo: (agent) => subagentDepthOf(agent) === 0 },
            { key: 'mcp', name: 'tool-management:mcp-state', label: 'MCP 服务器', form: 'catalog', text: () => mcp.stateCatalog.text() },
            { key: 'skills', name: 'tool-management:skill-catalog', label: '技能目录', form: 'catalog', text: () => skillCatalog.text() },
            {
              key: 'subagents',
              name: 'tool-management:subagents',
              label: '子智能体',
              form: 'catalog',
              text: (agent) => subagentCatalog.text(agent),
              applicableTo: (agent) => subagentCatalog.catalogVisibleAt(subagentDepthOf(agent)),
            },
            { key: 'prompt', name: 'tool-management:prompt', label: '提示词', form: 'instructions', text: () => memoriesService.promptText(), files: () => memoriesService.promptFiles() },
          ],
          settings: () => injectSettingsSync(),
          // 工具表开关：`how` 行里点名工具的那几句要跟着它换话术（关掉的不点名）。
          hiddenTools: toolTableHidden,
          factsFor: (agent) => candidates.presetFactsForAgent(agent),
          // 令牌门禁（2026-09-19，用户裁定「宿主侧硬拦截」）：令牌**在生效**（`TOKEN !== ''`，
          // 关掉或没配都是空串）而本次启动还没有人验过 ⇒ 这一步不放行，宿主把 turn 收成
          // `blocked`。这是"没输入令牌就没法对话"的唯一真正落实 —— 客户端那条输入框锁定在
          // 本宿主上无路可走（`ctx.conversation.blocks` 不存在，见 ContextInjectorDeps 注释）。
          // 只读 op 不受影响，所以「工具 → 兼容」页照常能打开、能填令牌 —— 解铃就在那里。
          tokenGateActive: () => TOKEN !== '' && !acceptedThisBoot(),
        })
        contextInjectorLive = () => injector.live()
        contextInjectorNote = (toolName, agent) => injector.noteToolUse(toolName, agent)
        return () => { contextInjectorLive = null; contextInjectorNote = null; injector.dispose() }
      }, 'dsh-plugin-tool-management: context injection')
    } catch (e) {
      console.error('[dsh-plugin-tool-management] context injection setup failed:', message(e))
      // B3：装配失败此前只落 console —— 用户界面上"注入块看起来正常、实际什么都没注入"。
      noteRuntime({
        id: 'context-injection',
        label: '上下文注入通道',
        kind: 'read',
        fallback: 'inform-only',
        detail: '注入通道装配失败（' + message(e) + '）：全部注入域的内容这一轮不会被送进模型。',
        detailKey: 'context-injection',
        params: { reason: message(e) },
      })
    }
    void readInjectSettings().catch(() => {})
    // B3 挂载心跳：apply 真跑到了这里，就记一笔「本插件在这一刻挂上了、声明的是这 12 个服务名」。
    // 官方改名 inject 服务名时插件**不会 apply**，界面上「连插件都不见了」—— 那时唯一的线索
    // 就是这份心跳没更新。doctor 读 hub/mount.json 并打印，配合官方日志即可定论（实测见
    // INJECT_SERVICES 的注释）。失败只记日志，绝不因为它挡住启动。
    void writeJsonFile(hubPath('mount.json'), {
      at: Date.now(),
      iso: new Date().toISOString(),
      version: PKG_VERSION,
      injects: [...INJECT_SERVICES],
      // 宿主**进程身份**（2026-09-30 审查 §5 F1）：插件与宿主同进程，所以 `pid` 就是宿主的 pid，
      // 而 `hostStartedAt` 是本进程的启动时刻（`Date.now() - uptime`）。有了这两个值，doctor
      // 才能把「这份心跳是不是**这一轮**宿主写的」变成一条可计算的结论：
      //   pid 已经不存在 → 宿主自那以后重启过（或那次运行已结束）；
      //   pid 还在      → 心跳来自当前正在跑的宿主进程，插件这一轮**确实挂上了**。
      // 此前只有时间戳，用户必须自己记得"我什么时候重启的"才能解读它。
      pid: process.pid,
      hostStartedAt: Date.now() - Math.round(process.uptime() * 1000),
    }).catch((e) => { ctx.logger?.warn?.('mount heartbeat write failed: ' + message(e)) })
    // B3 符号断言：probe.ts 的 unwrap 用硬编码的 `Symbol.for('cordis.original')`，与 cordis
    // 导出的 `symbols.original` 必须是同一个符号。不是的话，探针会把代理当原始对象、身份判定失真。
    try {
      if (Symbol.for('cordis.original') === (symbols as { original?: symbol }).original) {
        clearRuntimeNote('cordis-original-symbol')
      } else {
        noteRuntime({
          id: 'cordis-original-symbol',
          label: 'cordis 原始对象符号',
          kind: 'read',
          fallback: 'inform-only',
          detail: 'cordis 导出的 symbols.original 与 Symbol.for("cordis.original") 不是同一个符号：能力探测可能把代理当原始对象，身份判定会失真。',
          detailKey: 'cordis-original-symbol',
        })
      }
    } catch (e) { /* 拿不到 symbols 就跳过（探针自己也有一条退路） */ }
    // 预热放到下一轮事件循环：此时 apply 的同步初始化（补丁路径、tools 服务…）已全部完成，
    // 避免在初始化中途就去读 MCP 补丁与工具 schema。
    setTimeout(() => {
      void subagentCatalog.warm().catch(() => { /* 预热失败只影响首屏速度，下次读会重建 */ })
      void mcp.stateCatalog.warm().catch(() => { /* 同上 */ })
      void skillCatalog.warm().catch(() => { /* 同上 */ })
    }, 0)
    // 技能写操作成功后立即重算目录（SWR：text() 同步返回缓存值，写后主动 refresh）。
    // 与下面人设目录同一手法：写入口只有 service 的 writeOps，不需要在界面层逐个补。
    for (const opName of skillsService.writeOps) {
      const original = skillsService.ops[opName]
      if (typeof original !== 'function') continue
      skillsService.ops[opName] = async (args: any) => {
        const result = await original(args)
        if (result && result.ok !== false) void skillCatalog.refresh().catch(() => { /* SWR 主动刷新失败只影响缓存新鲜度，下次读会重建，不该带崩写操作的结果 */ })
        return result
      }
    }
    // 人设写操作成功后立即重算目录（SWR：text() 同步返回缓存值，写后主动 refresh）。
    // 包装在 service 的 ops 上：写入口只有这一处，不需要在界面层逐个补。
    for (const opName of subagentService.writeOps) {
      const original = subagentService.ops[opName]
      if (typeof original !== 'function') continue
      subagentService.ops[opName] = async (args: any) => {
        const result = await original(args)
        if (result && result.ok !== false) void subagentCatalog.refresh().catch(() => { /* 同上：刷新失败不影响本次写操作的结果 */ })
        return result
      }
    }
    // ---------- 改名 / 进场景 / 存档案的联动（op 重包） ----------
    // 正文 2026-10-01 整段搬到 ./scene-linkage.ts（一字未改，只把七个 apply 作用域名字改走
    // deps）。调用点位置原样不动 —— 重包的是那四个 service 对象上的 ops 表，而下游（handlers
    // 表、工具依赖表）取的是**当时那份函数**：包晚了，联动对它们就不存在。
    // 两个**定义在本调用之后**的名字用 getter 传：`mcp` 在 MCP 管理域那一段才建、
    // `lockedSceneNames` 在场景锁那一层才解构 —— 直接放进对象字面量会当场踩 TDZ，
    // 而取用它们的时机是请求期，那时两个 const 都已初始化完。
    installSceneLinkage({
      memoriesService, subagentService, archiveService, quickPromptOps, subagentCatalog,
      get mcp() { return mcp },
      get lockedSceneNames() { return lockedSceneNames },
    })

    // HTTP 写 / 敏感 op 白名单（2026-09-19 抽到 ./request-gate.ts）：四个 service 自报的
    // writeOps，加上本文件内联域（mcpm-* / skill-open / agentsmd-* / history-*）。
    const { WRITE_OPS, SENSITIVE_OPS } = createOpWhitelist({
      writeOps: {
        skills: skillsService.writeOps,
        memories: memoriesService.writeOps,
        archives: archiveService.writeOps,
        subagents: subagentService.writeOps,
      },
    })

    // 兼容体检的日志去重：同一宿主版本只写一条 compat/probe，避免轮询刷屏。
    // 用对象持有（而不是 let）是因为这份状态要传给 ops/compat.ts —— 它跨调用可变，
    // 传引用才能让"记到哪一次"两侧都看见。
    const compatLog: { version?: string } = {}

    // 注册不上工具时的如实清单（`subagent_manager_*`，见下方 "子智能体工具" 一节）：
    // 以前只有一行 console.error，模型侧「查无此工具」、界面没有任何痕迹。这里把失败
    // 记下来，再由 `subagent-list`（页面横幅）与 `preset-tools`（工具列表接口）带出去。
    const subagentToolFailures: Array<{ name: string; reason: string }> = []
    // 用对象持有（而不是 let + 数组两件）：注册失败的记录要传给 tools/subagent.ts 去 push，
    // 而界面（子智能体页黄条）与 preset-tools 的 `unavailable` 读的是同一份数组 —— 传引用
    // 才能让"记到哪一条"两侧都看见。`logged` 保证控制台只报一次。
    const subagentFailures = { list: subagentToolFailures, logged: false }

    // 归档会话域（2026-09-19 抽到 ./sessions/history.ts）：侧车账本落点与搬迁、
    // 保留期设置与到期清扫、批量操作目标校验、归档列表分组视图。构造实例、首次清扫、
    // 挂周期定时器都在工厂内完成 —— 它们原本就写在 apply() 的同一位置。
    const history = createHistoryDomain({ ctx, config, pluginRoot: PLUGIN_ROOT, message })

    // ── 场景提示词 → 全局基线（AGENTS.md）同步 ────────────────────────────────
    //
    // 用户裁定（2026-09-15）：「切换场景，对应的提示词直接把 AGENTS.md 直接修改」。
    // 实现收在 ./scene-prompt-sync.ts（可在临时目录上端到端验证）：启用/切换场景、
    // 关掉场景、改绑定、编辑"驱动基线的那份预设"四个动作都会同步；关掉场景时按
    // 进场景前的基线快照（`scene-baseline.json`，hub 内）原文写回。
    const scenePromptSync = createScenePromptSync({
      prompts: promptsService,
      rules: memoriesService,
      baselineFile: hubPath('scene-baseline.json'),
      logger: ctx.logger,
    })

    /**
     * 把同步结果并进 op 响应：只在原操作成功时同步，失败原样透传。
     * 同步失败**不改**原操作的成功结论（场景确实切了），而是把原因放进 `agentsMd.error`，
     * 由界面如实显示成警告 —— 绝不假装文件已经改好。
     */
    const withAgentsMdSync = (res: any): Promise<any> => scenePromptSync.withSync(res)

    /**
     * **应用提示词预设的唯一入口**（界面 op 与模型工具共用）。
     *
     * 场景接管期间（启用场景 / 全局绑定在驱动基线）：
     *   - 应用**同一份** = 重新应用（把被手改的基线写回去），走场景同步；
     *   - 应用**别的份** = 换掉这个场景的绑定（用户裁定 2026-09-17：未锁定时切换要可用，
     *     并且同步写进场景档案）。绑定改完再走一次场景同步，于是「场景页显示什么 / 实际注入
     *     什么 / 谁是引用方」三处立刻重新对齐（此前的做法是直接拒绝，用户得先退出场景）。
     * 锁定由 `guardLockedOps` 挡住（agentsmd-apply 在冻结清单里）；模型工具
     * `prompt_manager_apply` 不经过 handlers，execute 里自带 `lockedSceneGuard`（F-001）。
     */
    async function applyPresetGuarded(id: string): Promise<{ ok: true; id: string; backedUp?: boolean; viaScene?: boolean; scene?: string } | { ok: false; error: string; code?: string; params?: Record<string, string> }> {
      const driver = await scenePromptSync.driver()
      if (driver) {
        const target = String(id ?? '').trim()
        if (driver.presetId !== target) {
          const rebound: any = await memoriesService.ops['rules-update-scene']({ name: driver.scene, prompt: target })
          if (!rebound || rebound.ok === false) {
            return {
              ok: false,
              code: 'error.agentsMd.sceneRebindFailed',
              error: `无法把场景「${driver.label}」的提示词绑定改成「${target}」：${(rebound && rebound.error) || '未知原因'}`,
              params: { scene: driver.label, target, reason: String((rebound && rebound.error) || '未知原因') },
            }
          }
        }
        const r = await scenePromptSync.sync()
        if (r.error) return { ok: false, error: r.error }
        // 带上场景名：调用方要能如实告诉用户「改的是哪个场景的绑定」，而不是笼统说
        // 「已应用到 AGENTS.md」——场景驱动时写进 AGENTS.md 的内容来自场景绑定。
        return { ok: true, id, viaScene: true, scene: driver.label }
      }
      return promptsService.apply(id)
    }

    /** 删除拒绝里的引用说明（人话；与界面标签同一套结构化事实）。 */
    const promptRefReason = (ref: { kind?: string; label?: string; active?: boolean }): string => {
      if (ref && ref.kind === 'scene') return `场景「${ref.label || ''}」${ref.active ? '（已启用）' : ''}绑定了它`
      if (ref && ref.kind === 'restore') return '它就是退出场景后要恢复的全局提示词'
      return '~/.dsh/AGENTS.md 当前内容就是它'
    }

    // ---------- path discovery ----------
    // Known limitation: profile detection probes PROFILE_CANDIDATES ('web' then
    // 'headless', see host-names.ts) by presence of profiles/<name>/cordis.patch.yml,
    // then falls back to any profile that has one, and finally to
    // DEFAULT_PROFILE_NAME. A profile whose directory name matches none of these
    // and has no patch file yet is not detected.
    let cached: { home: string; profileDir: string; profileName: string; projectPatch: string; globalPatch: string; bundlePatch: string } | null = null
    async function ensurePaths() {
      if (cached) return cached
      let home: string | null = null
      let derivedProfileDir: string | null = null
      let derivedProfileName: string | null = null
      let docObserved: string | undefined
      let docError: string | undefined
      try {
        // 注意：这里的 home 来自宿主文档路径的切片，与 `skills/core.js` 的
        // `resolveDshHome()`（`$DSH_HOME` ‖ `~/.dsh`）是**两条独立来源**，本插件同时用着两者。
        // 不合并是有意的：合并会改变所有 profile 补丁的落点，属于行为变更，留给结构性重构那一档。
        const doc = await settings.prepareDocument()
        if (typeof doc === 'string' && doc) {
          docObserved = doc
          const i = Math.max(doc.lastIndexOf('\\'), doc.lastIndexOf('/'))
          const docDir = i > 0 ? doc.slice(0, i) : doc
          // 0.1.7 起 `prepareDocument()` 返回的是 **profile 补丁**（`configEditor.documentPath`，
          // 形如 `<home>\profiles\web\cordis.patch.yml`）；0.1.5 返回的才是主目录下的设置文档。
          // 直接切片会把 profile 目录当成主目录 —— globalPatch 随之指到 profile 补丁，
          // 全局补丁里那些 MCP 行就全部读不到了（0.15.0 实测）。所以先认这个形状：
          // 目录以 `profiles\<name>` 结尾 ⇒ 它自己就是 profileDir，主目录上溯两级。
          const profileShaped = /^(.+)[\\/]profiles[\\/]([^\\/]+)$/.exec(docDir)
          if (profileShaped) {
            home = profileShaped[1]
            derivedProfileDir = docDir
            derivedProfileName = profileShaped[2]
          } else {
            home = docDir
          }
        }
      } catch (e) {
        docError = String((e as { message?: string })?.message ?? e)
      }
      if (!home) {
        // 推导失败从「静默抛错」升级为「具名上报 + 抛错」：这条路径正是 0.1.7 升级事故的
        // 源头（prepareDocument 返回语义一变这里就指错目录，MCP 页与补丁读写全部失明），
        // 下次契约再变，兼容页必须第一眼看到推导挂了，而不是等某个页面空白再倒查。
        noteRuntime({
          id: 'paths.home-derivation',
          label: '主目录推导',
          kind: 'read',
          fallback: 'refuse-operation',
          detail: docError !== undefined
            ? `settings.prepareDocument() 抛错：${docError}。主目录推导失败，MCP 页与补丁读写不可用。`
            : 'settings.prepareDocument() 未返回可用路径（宿主路径契约可能又变了）。主目录推导失败，MCP 页与补丁读写不可用。',
        })
        throw new Error('无法确定 DSH 主目录（settings.prepareDocument 未返回路径）')
      }
      const sep = home.indexOf('\\') >= 0 ? '\\' : '/'
      // prepareDocument 给出的就是**现存**的 profile 补丁路径（官方注释如此），所以
      // 推导出的 profileDir 直接可信；只有它没给出 profile 形状时才走下面的候选探测。
      const profileShapedPatchExists = derivedProfileDir !== null
        && (await exists(derivedProfileDir + sep + 'cordis.patch.yml'))
      // —— 推导自检（0.15.0）：健康时不留 note（运行时上报一律渲染成兼容页的问题行，
      // 常驻健康行会违反「琥珀只留给故障」的口径），只在推导结果反常时记，恢复时收掉。
      // 两条不变量照着 0.1.7 事故的形状挑：那次推出的「主目录」其实存在（是 profile 目录），
      // 存在性检查抓不住，**profiles 子目录**检查才抓得住 —— 主目录下永远有 profiles\
      //（本插件自己的 profile 就住在里面）。官方再改一次语义，两道检查至少一道当场报警。
      const derivationNote = (detail: string): void => {
        noteRuntime({
          id: 'paths.home-derivation',
          label: '主目录推导',
          kind: 'read',
          fallback: 'refuse-operation',
          detail,
        })
      }
      if (!(await exists(home))) {
        derivationNote(`推导出的主目录不存在：${home}（设置文档路径：${docObserved ?? '未知'}）。推导结果不可信，MCP 页与补丁读写会落空。`)
      } else if (!(await exists(home + sep + 'profiles'))) {
        derivationNote(`推导出的主目录下没有 profiles 目录：${home}（设置文档路径：${docObserved ?? '未知'}）。主目录很可能指错了 —— 直接切片一个 profile 补丁路径就是这个形状；MCP 页与补丁读写会读错文件。`)
      } else if (derivedProfileDir !== null && !profileShapedPatchExists) {
        derivationNote(`设置文档路径呈 profile 目录形状，但其中没有 cordis.patch.yml：${docObserved}。官方承诺返回「现存」的 profile 补丁路径，形状对不上说明契约又变了；已回退候选探测。`)
      } else {
        clearRuntimeNote('paths.home-derivation')
      }
      let profileDir: string | null = profileShapedPatchExists ? derivedProfileDir : null
      let profileName = derivedProfileName ?? DEFAULT_PROFILE_NAME
      for (const name of profileDir === null ? PROFILE_CANDIDATES : []) {
        if (await exists(home + sep + 'profiles' + sep + name + sep + 'cordis.patch.yml')) {
          profileDir = home + sep + 'profiles' + sep + name
          profileName = name
          break
        }
      }
      if (!profileDir) {
        try {
          const t = await fs.resolve(home + sep + 'profiles')
          const entries = await fs.listDir(t)
          for (const e of entries) {
            if (e.name === 'node_modules') continue
            if (await exists(home + sep + 'profiles' + sep + e.name + sep + 'cordis.patch.yml')) {
              profileDir = home + sep + 'profiles' + sep + e.name
              profileName = e.name
              break
            }
          }
        } catch (e) { /* ignore */ }
      }
      if (!profileDir) profileDir = home + sep + 'profiles' + sep + DEFAULT_PROFILE_NAME
      cached = {
        home,
        profileDir,
        profileName,
        projectPatch: profileDir + sep + 'cordis.patch.yml',
        globalPatch: home + sep + 'cordis.patch.yml',
        // 0.1.7 bundle 层：插件包内自己的 cordis.patch.yml（`dsh.bundle.patch`）定义 loader
        // 条目。它只是「覆盖目标存在吗」的凭证与读取参照，**绝不是令牌的写点** —— 那份文件
        // 是仓库镜像（sync 每次构建覆盖），把令牌写进去等于把明文密钥提交进仓库。
        bundlePatch: profileDir + sep + 'node_modules' + sep + 'dsh-plugin-tool-management' + sep + 'cordis.patch.yml',
      }
      return cached
    }

    async function exists(abs: string): Promise<boolean> {
      try {
        const t = await fs.resolve(abs)
        return (await fs.stat(t)) !== undefined
      } catch (e) { return false }
    }

    // 一次性数据迁移（旧插件名 / 旧侧车名 / 旧 hub 目录名）已统一收进 hub.ts 的
    // `migrateHubLayoutSync()`（在 apply() 开头、任何读盘之前同步跑一次）——
    // 这里不再维护第二份迁移表，避免两处口径漂移。

    async function readPatch(abs: string): Promise<string> {
      try {
        const t = await fs.resolve(abs)
        return await fs.readText(t)
      } catch (e) {
        if (String((e as { code?: string }).code) === 'FS_NOT_FOUND') return ''
        throw e
      }
    }

    // Timestamped copies of the previous patch content. The template upstream
    // learned this the hard way: a bad edit to cordis.patch.yml can stop DSH
    // from booting, so the pre-write file must stay recoverable without git.
    const KEEP_PATCH_BACKUPS = 5
    /**
     * 备份名里的时间戳：**到毫秒 + 进程内序号**（定宽）。
     *
     * 为什么不能只到秒（2026-09-30 审查 P2-5）：同一次操作里常常连写两遍补丁（`mcpm-set-enabled`
     * 的强制写 + 恢复写、整理补丁的批量写），两次落在同一秒时**后一份备份会覆盖前一份** ——
     * `KEEP_PATCH_BACKUPS=5` 于是不是"留 5 个历史状态"而是"留 5 个秒"，最坏情况下唯一能回滚的
     * 中间副本被挤掉。序号保证同一毫秒内也不撞名。
     *
     * 两段都是**定宽**，所以按名字排序仍然等于按时间排序（`listPatchBackups` 的剪枝依赖这一点）。
     */
    let backupSeq = 0
    function backupStamp(): string {
      const d = new Date()
      const p = (n: number, w = 2) => String(n).padStart(w, '0')
      backupSeq = (backupSeq + 1) % 1000
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds(), 3) + p(backupSeq, 3)
    }
    // 改 patch 前的自动备份：写在 `hub/backups/`（不再堆在 `$DSH_HOME` 根下）。
    // 两个 patch 都叫 `cordis.patch.yml`（全局 + `profiles/<名字>/`），所以备份名里带上层级，
    // 否则两处在同一个目录里互相撞名、互相挤掉。最坏情况（配置写坏导致 DSH 起不来）
    // 按文档里的路径找回：`~/.dsh/tool-management/backups/`。
    async function backupPatchFile(abs: string, previous: string): Promise<void> {
      const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'))
      if (i <= 0) return
      const base = abs.slice(i + 1)
      const profile = /(?:^|[\\/])profiles[\\/]([^\\/]+)$/.exec(abs.slice(0, i))
      const tag = profile ? 'profile-' + profile[1].replace(/[^A-Za-z0-9._-]/g, '_') : 'global'
      const stem = base + '.' + tag
      const dir = hubBackupDir()
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, stem + '.bak-' + backupStamp()), previous, 'utf8')
      try {
        // 旧位置的备份没有层级后缀（迁移搬进来的），只统计不删错别人的。
        const mine = (name: string): boolean => name.startsWith(stem + '.bak-') || (tag === 'global' && name.startsWith(base + '.bak-'))
        const names = (await readdir(dir)).filter(mine).sort()
        for (const stale of names.slice(0, Math.max(0, names.length - KEEP_PATCH_BACKUPS))) {
          await unlink(join(dir, stale))
        }
      } catch (e) { /* pruning is best-effort */ }
    }

    /**
     * 备份名：`cordis.patch.yml[.<层级标签>].bak-<时间戳>`。
     *
     * ⚠ 不能用 `hub.ts` 的 `isPatchBackupName` 来列目录：它只认**没有层级标签**的老名字
     * （`cordis.patch.yml.bak-<时间戳>`，那是备份还堆在 `$DSH_HOME` 根下的时期的产物），
     * 而现在 `backupPatchFile` 写出来的名字都带 `.global` / `.profile-<名>` 标签 ——
     * 用它列目录会得到 0 份。它的用途是启动期搬运旧文件，语义不同，别混。
     */
    function isBackupFileName(name: string): boolean {
      // 两代时间戳都认：老名字到秒（`\d{6}`），0.17.0 起加了毫秒与序号（共 `\d{12}`）。
      // 只认新格式会让**存量备份**在清单与自动剪枝里集体消失 —— 它们既不再被剪掉，
      // 也不再出现在「清理旧备份」里，等于把明文密钥副本永久留在盘上。
      return /^cordis\.patch\.yml(?:\.[A-Za-z0-9._-]+)?\.bak-\d{8}-\d{6}(?:\d{6})?$/.test(basename(String(name || '')))
    }

    /**
     * 一份备份属于**哪一份 patch**（备份名里的层级标签）。
     *
     * 保留 N 份必须按层级分别算 —— 全局一份、每个 profile 一份，各自独立留 N 份
     * （这才是 `KEEP_PATCH_BACKUPS` 的真实语义；全局共 N 份会把别的层级的备份挤掉）。
     * 更早期的备份没有标签，统一归到 `legacy`，同样单独留 N 份。
     */
    function backupLevelOf(name: string): string {
      if (/\.global\.bak-/.test(name)) return 'global'
      const m = /\.profile-([^.]+)\.bak-/.exec(name)
      return m ? 'profile:' + m[1] : 'legacy'
    }

    /** `hub/backups/` 里的 patch 备份清单（只读；新的在前）。 */
    async function listPatchBackups(): Promise<Array<{ name: string; level: string; mtime: number; size: number }>> {
      const dir = hubBackupDir()
      let names: string[]
      try { names = await readdir(dir) } catch { return [] }
      const out: Array<{ name: string; level: string; mtime: number; size: number }> = []
      for (const name of names) {
        if (!isBackupFileName(name)) continue
        try {
          const st = await stat(join(dir, name))
          if (!st.isFile()) continue
          out.push({ name, level: backupLevelOf(name), mtime: Number(st.mtimeMs) || 0, size: Number(st.size) || 0 })
        } catch { /* 单个文件 stat 不了就跳过，不阻断清单 */ }
      }
      return out.sort((a, b) => b.mtime - a.mtime)
    }

    /**
     * 清理旧备份：**每个层级各删最旧的若干份**（`delByLevel[层级] = 份数`，该层不足就删空它）。
     *
     * 为什么需要它：每份备份都是**整份 patch 的副本**，`env` / `headers` 与 `config.token`
     * 在里面是明文 —— 5 份备份就是 5 份明文副本，而它们常常挤在几分钟内（本机实测 4 分钟），
     * 对"回滚"几乎没有额外价值，对"密钥扩散"却全是成本。自动剪枝只保证上限，不提供"我现在
     * 就想把它们清掉"的出口 —— 这个 op 就是那个出口。
     *
     * 口径沿革（用户裁定 2026-09-19）：先是"每层留 N 份"，再改成"每层各删 N 份"，最后落到
     * **每个层级各选一份数** —— 两个层级的份数本来就不等（实测 4 / 5），共用一个 N 时总数
     * 只能凑出偶数、份数少的那层先被删光就断档（选 5 得到 9），选中的档位与"删了几个"对不上。
     * 逐层各选就没这个限制，而且"这一份是从哪层删的"一一对应。
     *
     * 只删 `hub/backups/` 下的备份文件，**不碰活动配置**。
     */
    async function cleanPatchBackups(delByLevel: Record<string, number>): Promise<{ removed: string[]; failed: string[]; kept: number }> {
      const dir = hubBackupDir()
      const all = await listPatchBackups()
      const byLevel = new Map<string, Array<{ name: string }>>()
      for (const f of all) {
        const list = byLevel.get(f.level)
        if (list) list.push(f)
        else byLevel.set(f.level, [f])
      }
      const doomed: string[] = []
      // 清单新的在前 → 留下前 (份数 - 该层要删的数) 份，删掉剩下的（正是最旧的那几份）。
      // 层级之间互不牵连：某一层份数少只影响它自己，不再有"共用一个 N"带来的断档。
      for (const [level, list] of byLevel) {
        const n = Math.max(0, Math.min(list.length, Math.floor(Number((delByLevel || {})[level]) || 0)))
        for (const f of list.slice(list.length - n)) doomed.push(f.name)
      }
      const removed: string[] = []
      const failed: string[] = []
      for (const name of doomed) {
        try { await unlink(join(dir, name)); removed.push(name) } catch { failed.push(name) }
      }
      return { removed, failed, kept: all.length - removed.length }
    }

    /**
     * 写**宿主**的补丁文件（全局 + profile 各一份），是插件里唯一改宿主配置的地方。
     *
     * 为什么固定用 `danger-full-access`：目标是 `~/.dsh/cordis.patch.yml` 与
     * `profiles/<名>/cordis.patch.yml`，都在插件自己的数据目录（`hub/`）之外，属于宿主配置；
     * 写它们必须显式升级沙箱策略，没有更窄的模式可用（本文件只声明了
     * `resolve({ mode })`，不去猜官方还有哪些模式 —— 要用别的模式得先读官方源码确认）。
     *
     * 调用面（19 处，务必保持收敛）：MCP 域的增 / 改 / 删 / 启停 / 全部启停 / 整理补丁 /
     * 重启 / 导入 / 导出，以及「设置令牌」。技能 / 记忆 / 提示词 / 子智能体 / 场景 /
     * 历史这些域**一概不经过这里**，它们只写 `hub/` 下自己的文件。
     * 新增"要改宿主配置"的路径请走这个函数（备份与原子替换都在这里），不要绕过它自己写；
     * 反过来，不写宿主配置的动作也不该调用它 —— 多用一次就多扩散一次策略升级。
     */
    async function writePatch(abs: string, content: string): Promise<void> {
      const policy = await sandboxPolicy.resolve({ mode: 'danger-full-access' })
      let previous = ''
      try { previous = await readPatch(abs) } catch (e) { /* 读不到就没有基线，校验按「没有基线」判 */ }
      // 写前校验（非对称策略，理由与三条分支见 compat/patch-dialect.ts 的文件头）：
      // 只有「我们这次把产物改成了官方解析不了的样子」才拦；复刻过期 / 依赖缺失一律放行 + 上报。
      const verdict = await checkPatchWrite(previous, content)
      if (!verdict.allow) throw new Error(verdict.error)
      try {
        if (previous && previous !== content) await backupPatchFile(abs, previous)
      } catch (e) { /* a failed backup must never block the write */ }
      // 同目录临时文件 + rename 原子替换：进程中断/磁盘满最坏留下一个 .tmp 兄弟，
      // 不会截断补丁本体。官方 app-boot 写这两个补丁文件用的是同一套模式
      // （`filename + '.tmp'` → rename + 瞬时错误重试，lib/index.js `_writeFile`），
      // 所以 HMR 对 rename 的容忍不需要额外验证。内容写仍走宿主 fs 服务
      // （沙箱策略与审批语义不变），rename 只是元数据动作。
      const temp = abs + '.' + randomUUID().slice(0, 8) + '.dsh-tmp'
      try {
        await fs.writeText(await fs.resolve(temp), content, undefined, undefined, policy)
        await renameWithRetry(temp, abs)
      } catch (e) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw e
      }
    }

    /**
     * 写入回执的 warning 附着点：把本次请求里「补丁校验没做成」的结论挂在结果上。
     *
     * 口径与既有回执一致 —— `warning` 是**一个字符串**（MCP 域已有同款字段，界面按
     * `mcp.msg.warn` 渲染）。原有 warning 保留，本插件的追加在后面，用「；」分隔。
     */
    function withPatchWarnings(result: any): any {
      const warnings = takePatchGuardWarnings()
      if (warnings.length === 0 || !result || typeof result !== 'object') return result
      const extra = warnings.join('；')
      if (typeof result.warning === 'string' && result.warning !== '') return { ...result, warning: result.warning + '；' + extra }
      return { ...result, warning: extra }
    }

    // ---------- 访问令牌：宿主侧配置的读写（兼容页就地开关） ----------
    // 正文 2026-10-01 整段搬到 ./token-config.ts（一字未改，只把八个 apply 作用域名字改走
    // deps）。这一段是 apply 里唯一**改写宿主启动配置**的手：四个方向的凭证判据、写点优先级、
    // 拒写形状全在那一层的注释里。这里按原位置建一次工厂 —— 它没有状态，两个出口仍然只被
    // apply 末尾的 HTTP 路由就地调用（刻意不进 handlers 表，模型关不掉访问令牌）。
    const { tokenConfigState, tokenConfigure } = createTokenConfig({
      ensurePaths, readPatch, writePatch, withWriteLock, message,
      TOKEN, CONFIG_TOKEN, tokenMatches,
    })

    // ---------- 通用侧车 JSON 读写 ----------
    // 为什么留在 index.ts：注入设置（inject-settings.json）也在用这一对，搬进
    // ./mcp/manager.ts 就得为一对 6 行函数再加一层 deps 转发。
    async function readJsonFile(abs: string): Promise<any> {
      try { return JSON.parse(await readFile(abs, 'utf8')) } catch (e) { return null }
    }
    async function writeJsonFile(abs: string, data: any): Promise<void> {
      await writeFile(abs, JSON.stringify(data, null, 2) + '\n', 'utf8')
    }

    // ---------- MCP 管理域 ----------
    // 侧车读写（备注 / 设置 / 停用表）+ 补丁受管行的生成与块编辑 + 16 个 op，实现在
    // ./mcp/manager.ts（2026-09-19 从本闭包原样抽出，约 1300 行）。
    //
    // 为什么经工厂 + 返回对象，而不是把函数留在这里：这一域有**反向依赖** —— 注入通道要
    // 打码后的列表行、场景档案引擎要读写停用表与备注、工具门禁要读 TTL 缓存判断某工具是否
    // 被停用、审批策略要读插件设置。以前这些靠闭包隐式共享（谁在用什么看不出来），现在全部
    // 经返回的 McpManager 显式暴露。
    const mcp = createMcpManager({
      readJsonFile,
      writeJsonFile,
      ensurePaths,
      withWriteLock,
      message,
      tools,
      pluginInventory,
      settings,
      readPatch,
      writePatch,
      memoriesService,
      wait,
      // 兼容页「模型工具表」关掉的工具与 MCP 停用工具**合并成一次 restrict**：官方
      // `tools.restrict()` 是"每个 scope 一层限制"，两边各调一次会互相覆盖（后一层赢）。
      // 名单的合法性（只含已注册工具）由 manager 那边与 schemas() 求交后保证。
      pluginHiddenTools: () => [...toolTableHidden()],
      // 有官方等价物时逐 agent 让位（见上面 CARRIER_DUPLICATES 的注释）。
      carrierHiddenTools: carrierHiddenToolsFor,
    })

    // ---------- ops ----------
    async function pluginVersion(): Promise<any> {
      return { ok: true, version: PKG_VERSION }
    }


    // ---------- open a skill source in the OS default editor ----------
    // Fire-and-forget: the launcher detaches, so a hanging editor never blocks
    // the request. Only existing Markdown source files are accepted — the route
    // is same-origin + token gated, but it must not become a "launch anything"
    // primitive.
    function openWithSystemEditor(abs: string): boolean {
      try {
        const platform = process.platform
        const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
        const child = spawn(command, [abs], { detached: true, stdio: 'ignore', windowsHide: true })
        child.on('error', () => {})
        child.unref()
        return true
      } catch (e) { return false }
    }
    async function skillOpen(args: any): Promise<any> {
      const abs = String((args && args.path) || '').trim()
      if (!abs) return { ok: false, error: '缺少 path' }
      if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(abs)) return { ok: false, error: '需要绝对路径' }
      // 接受面与报错文案必须一致：这里认 `.md` / `.markdown` / `.txt`，错误文案就得照实说
      // （此前写"只支持打开 Markdown 源文件"，把 `.txt` 藏在接受面里 —— 用户按文案判断
      // 哪些文件能开，会与实际对不上）。
      if (!/\.(md|markdown|txt)$/i.test(abs)) return { ok: false, error: '只支持打开文本源文件（.md / .markdown / .txt）' }
      // 边界：只允许打开「技能来源」或人设目录里的文件。这个 op 会把路径交给系统默认编辑器，
      // 不设边界就等于「任意绝对路径 → 启动外部程序」（此前只校验了后缀与存在性）。
      const inPersonas = await isInsideRootResolved(defaultPersonasDir(), abs).catch(() => false)
      if (!inPersonas && !(await skillsService.isInsideKnownSkillRoot(abs))) {
        return { ok: false, error: '只能打开技能来源或人设目录内的文件' }
      }
      if (!(await exists(abs))) return { ok: false, error: '文件不存在：' + abs }
      if (!openWithSystemEditor(abs)) return { ok: false, error: '无法调用系统默认打开方式' }
      return { ok: true, path: abs }
    }

    /** 调用方 agent 跑在哪个 Agent 预设上；判断不了返回 null（绝不猜）。 */
    function currentPresetId(agentCtx: unknown): string | null {
      if (agentCtx === undefined || agentCtx === null) return null
      try {
        const roster = candidates.presetRoster()
        if (roster === undefined || typeof roster.composedPreset !== 'function') return null
        const id = String(roster.composedPreset(agentCtx) ?? '')
        return id === '' ? null : id
      } catch { return null }
    }

    /**
     * 人设的工具限制：按**当前会话的预设**决定这次委派下发什么（规则见 decideToolFilter）。
     * 已知工具名 = 宿主平面（含 MCP）∪ 当前预设的工具；枚举失败时退化成宿主平面，
     * 于是模式名单里的预设侧工具会被如实记为"当前不存在"，而不是造成官方 restrict 抛错。
     */
    async function subagentToolFilterFor(persona: any, agentCtx: unknown): Promise<ToolFilterDecision> {
      let hostNames: string[] = []
      try {
        hostNames = ((await tools.schemas()) || []).map((s: any) => String(s.name)).filter(Boolean)
      } catch { hostNames = [] }
      const mcp = hostNames.filter((name) => name.startsWith(MCP_TOOL_PREFIX))
      const known = new Set<string>(hostNames)
      const presetId = currentPresetId(agentCtx)
      if (presetId !== null) for (const name of await candidates.presetToolNames(presetId)) known.add(name)
      return decideToolFilter(persona, presetId, { names: known, mcp })
    }


    // ---------- 候选源（场景 / 表单的取数）----------
    // 实现在 ./scenes/candidates.ts（2026-09-19 从本闭包 10 段抽出，约 260 行）。
    // 放在这里而不是更早：它要 mcp（读停用表）与 toolKeyParts（416 行的 const），
    // 而唯一在更早处引用它的地方（注入 deps 的 factsFor）是箭头函数，调用发生在之后。
    const candidates = createCandidates({
      get: (name: string) => ctx.get(name),
      tools,
      mcp,
      skillsService,
      memoriesService,
      toolKeyParts,
    })


    // 提示词预设域的 op 表。单独提出来是为了让**模型工具**能复用同一份判定：
    // `prompt_manager_list` 以前直调 `promptsService.list()`，于是它报的「生效中」是
    // **文件比对**口径（预设正文 == ~/.dsh/AGENTS.md），而界面报的是 `agentsmd-list` 的口径
    // （启用的场景绑了预设时，**只有那份**算生效中）—— 同一件事两个答案，场景驱动时工具就在
    // 说假话。工具改走 op 之后两边只有一份判定。
    const promptOps = buildPromptOps({
      promptsService,
      scenePromptSync,
      // 显式转发而不是整表传入：这两个 op 名字写死在这里，rules 域哪天改名会立刻红，
      // 不会静默变成 undefined 调用。
      rulesOps: {
        'rules-list': (args: any) => memoriesService.ops['rules-list'](args),
        'rules-rebind-prompt': (args: any) => memoriesService.ops['rules-rebind-prompt'](args),
      },
      applyPresetGuarded,
      withAgentsMdSync,
      promptRefReason,
      warn: (m: string) => { ctx.logger?.warn?.(m) },
    })

    const handlers: Record<string, (args: any) => Promise<any>> = {
      'plugin-version': pluginVersion,
      // 「最近改动」流水的读侧（0.15.0 B2）：只读 hub 里的 `audit.jsonl`，倒序、可按域过滤。
      'audit-list': async (args: any) => ({ ok: true, entries: await readAudit(args || {}) }),
      // 清空流水。清完这一条 op 自己会被下面的包装层记进新流水（"谁清过"也留痕）。
      'audit-clear': async () => await clearAudit(),
      'skill-open': skillOpen,
      // MCP 域 16 个 op（实现在 ./mcp/manager.ts）
      ...mcp.ops,
      // 技能管理 ops（由 ./skills/service.js 提供）：skill-state / skill-detail /
      // skill-browse / skill-enable / skill-disable / skill-source-enable /
      // skill-source-disable / skill-create / skill-import / skill-upload /
      // skill-delete / skill-trash-restore / skill-trash-delete
      // 成功返回 {ok:true, data}；core 业务失败原样透传 {ok:false, error, code?, params?}。
      ...skillsService.ops,
      // rules ops（由 ./memories/service.js 提供）：rules-list / rules-read / rules-budget /
      // rules-diagnose / rules-create / rules-update / rules-remove / rules-restore /
      // rules-attach / rules-detach / rules-trash-list / rules-trash-remove /
      // rules-toggle / rules-set-index / rules-set-active / rules-create-scene /
      // rules-remove-scene。
      // 成功返回扁平 {ok:true, ...}（不套 data），失败 {ok:false, error, code?}。
      ...memoriesService.ops,
      // 场景档案 ops（由 ./memories/archive-engine.ts 提供）：scene-mode-get /
      // scene-archive-save / scene-mode-set。成功返回扁平 {ok:true, ...}，
      // 失败 {ok:false, error}；写 op 已含 archiveService.writeOps 门禁派生。
      ...archiveService.ops,
      // 子智能体 ops（由 ./subagents/service.ts 提供）：subagent-list/get（只读）
      // + subagent-create/update/delete（写，writeOps 已派生进门禁）。
      ...subagentService.ops,
      // 兼容 / 注入 / 备份域（ops/compat.ts 提供）：compat-status / preset-reach /
      // inject-settings / backups-list / backups-clean / injection-live。
      // 依赖显式传参，不再靠闭包隐式捕获。
      ...buildCompatOps({
        getSessionsRegistry: history.getSessionsRegistry,
        tools,
        readInjectSettings,
        injectSettingsOp,
        readSlashSettings,
        toolTableOp,
        toolTableReport: () => toolTableReport(),
        presetRoster: candidates.presetRoster,
        listPatchBackups,
        cleanPatchBackups,
        getContextInjectorLive: () => contextInjectorLive,
        // 功能总览（B6）的三层合成：令牌实况与兼容页「访问令牌」同源；场景锁定与写门禁同源；
        // 停用工具的两个口径读 mcp 的 TTL 缓存（无 I/O）。
        readTokenState: async () => ({ active: TOKEN !== '', accepted: TOKEN !== '' && acceptedThisBoot() }),
        lockedSceneNames: () => lockedSceneNames(),
        disabledToolSummary: () => mcp.disabledToolSummary(),
        injectServiceCount: INJECT_SERVICES.length,
        message,
        compatLog,
      }),
      // AGENTS.md / 提示词预设域（ops/prompts.ts 提供，见上方 promptOps）。
      ...promptOps,
      // 快捷提示词域（ops/quick-prompts.ts）：quickprompt-list / -create / -update /
      // -toggle / -remove 与回收站三条。它**不**碰 AGENTS.md、不进场景、不进注入。
      ...quickPromptOps,
      // 归档会话域（ops/history.ts 提供）：history-list / history-sessions /
      // history-export-defaults / dir-list / history-archive / history-archive-batch /
      // history-unarchive / history-delete / history-unarchive-batch / history-delete-batch /
      // history-workspace-register / history-import / bundle-export / history-export /
      // history-retention-get / history-retention-set。
      ...buildSessionOps({
        getSessionsRegistry: history.getSessionsRegistry,
        message,
        readHistoryRetention: history.readHistoryRetention,
        writeHistoryRetention: history.writeHistoryRetention,
        sweepHistory: history.sweepHistory,
        buildHistoryGroups: (registry, items) => history.buildHistoryGroups(registry as SessionsRegistry, items),
        restoreWorkspaceAccounting: history.restoreWorkspaceAccounting,
        parseHistoryBatchTarget: history.parseHistoryBatchTarget,
        // 直接把官方入口传进去：宿主没挂 agents 或没有 create 时是 undefined，
        // history-import 会据此返回「当前环境不支持创建会话」而不是运行时炸。
        createSession: agents?.create,
        host: <T>(name: string): T | undefined => ctx.get(name) as T | undefined,
        promptsDir,
        quickPromptsDir,
        rulesList: (args: any) => memoriesService.ops['rules-list'](args),
        skillDetail: (args: any) => skillsService.ops['skill-detail'](args),
        extractTurnsFromEvents,
        serializeTurns,
      }),
      // rules 域里要走「场景 ↔ 全局基线同步」包装的四个写 op（ops/scene-sync.ts 提供）。
      // 必须排在 ...memoriesService.ops 之后 —— 这里是显式覆盖同名 op，不是新增。
      ...buildSceneSyncOps({
        withAgentsMdSync,
        // 「两轴恒等」（ops/scene-sync.ts 文件头）：`rules-set-active` 要能把运行时跟着
        // 启用集合一起切。`scene-mode-set` 取**包过一层的那份**（锁定守卫 + 目录重算），
        // 且按调用时取（这里是组装期，联动在 931 行就已装好）。
        currentModeScene: async () => {
          const slice = await memoriesService.readArchiveSlice()
          return slice.mode && slice.mode.scene ? slice.mode.scene : null
        },
        sceneModeSet: (args: any) => archiveService.ops['scene-mode-set'](args),
        onToolTablePresetChanged: async (scene: string, value: string) => {
          // 「修改场景」里改绑工具表方案且改的是**当前启用场景** → 立即把关停名单整体换成
          // 那一份（与「改档案 = 立刻生效」同口径）。解绑（''）按下拉里的承诺 =「保持现状」，
          // 运行时不动；悬空绑定（方案已删）也不在这里硬失败，交给引擎进出场景时的 stale 处理。
          const slice = await memoriesService.readArchiveSlice()
          if (!slice.mode || slice.mode.scene !== scene || !value) return
          const s = await readToolTableSettings()
          const hit = s.presets.filter((p) => p.name === value)[0]
          const hidden = hit ? [...hit.hidden] : (value === FACTORY_TOOL_TABLE_PRESET ? [...DEFAULT_HIDDEN_TOOLS] : null)
          if (!hidden) return
          await applyToolTableHiddenNow(hidden)
        },
        // 快捷提示词：改的是**当前启用场景**时按新勾选集立刻应用一次 —— 走的就是「保存档案 =
        // 立刻生效」那条路（`scene-archive-save` 内含 stale 清理、运行时重应用与快照并入），
        // 不在这里另写一套应用逻辑。解绑（null）不回滚：这一域回到"保持现状"，而进场景前那批
        // 开关仍在模式快照里，退出照常还原。
        onQuickPromptsChanged: async (scene: string, value: string[] | null) => {
          const slice = await memoriesService.readArchiveSlice()
          if (!slice.mode || slice.mode.scene !== scene || value === null) return
          const cur = slice.archives[scene] || {}
          await archiveService.ops['scene-archive-save']({ scene, archive: { ...cur, quickPrompts: value } })
        },
        rulesOps: {
          'rules-set-active': (args: any) => memoriesService.ops['rules-set-active'](args),
          'rules-update-scene': (args: any) => memoriesService.ops['rules-update-scene'](args),
          'rules-create-scene': (args: any) => memoriesService.ops['rules-create-scene'](args),
          'rules-remove-scene': (args: any) => memoriesService.ops['rules-remove-scene'](args),
        },
      }),
      // 场景档案与候选源（ops/scene.ts 提供）：preset-tools / model-candidates / scene-inventory。
      ...buildCandidateOps({
        presetToolCandidates: candidates.presetToolCandidates,
        modelCandidates: candidates.modelCandidates,
        modelReasoning: candidates.modelReasoning,
        getToolFailures: () => subagentToolFailures,
        mcpmListView: mcp.mcpmListView,
        toolStates: candidates.toolStates,
        skillRows: candidates.skillRows,
        subagentList: () => subagentService.list(),
        readDisabledTools: mcp.readDisabledTools,
        presetNames: candidates.presetNames,
        memorySceneCandidates: candidates.memorySceneCandidates,
        memoryCandidates: candidates.memoryCandidates,
      }),
      // 场景页的界面设置（读 / 写）：进入场景前要不要弹预览卡。按写操作门禁（它写侧车），
      // 但**不进场景冻结** —— 它是界面提示，与五个管理域的只读无关（见 scene-settings.ts）。
      'scene-settings': (args: any) => sceneSettingsOp(args),
      // 斜杠命令入口的开关（读 / 写）：客户端 boot 时读一次决定挂不挂 `/` 菜单里的「工具」段，
      // 兼容页那两颗开关写一次。同 `scene-settings`：按写门禁但不冻结（见 slash-settings.ts）。
      'slash-settings': (args: any) => slashSettingsOp(args),
      // state-doctor：跨域**悬空引用**体检（只读，实现与理由见 src/ops/state-doctor.ts）。
      // 这里只做"把权威集合取来"这一件事 —— 某一域读失败就传 null，体检会把它记进
      // `skipped` 而不是当成"该域没有悬空项"（读不到 ≠ 不存在，报成后者就是骗人）。
      'state-doctor': async () => {
        const stateDir = String((config as { memoriesStateDir?: unknown } | undefined)?.memoriesStateDir || '')
        const safe = async <T>(read: () => Promise<T>): Promise<T | null> => {
          try { return await read() } catch { return null }
        }
        const report = await runStateDoctor({
          index: () => readIndexSync(stateDir),
          presetIds: async () => {
            const r = await safe(async () => promptsService.list())
            return r && r.ok ? r.presets.map((p) => p.id) : null
          },
          serverNames: async () => {
            const r = await safe(mcp.mcpmListView)
            if (!r) return null
            const out: string[] = []
            for (const row of ((r as any).rows || [])) {
              const n = String((row && row.serverName) || '')
              if (n && out.indexOf(n) < 0) out.push(n)
            }
            return out
          },
          skillKeys: async () => {
            const r = await safe(skillStates)
            return r === null ? null : new Set(Object.keys(r))
          },
          personaNames: async () => {
            const r = await safe(() => subagentService.list())
            return r === null ? null : new Set(r.map((p) => p.name))
          },
        })
        return { ok: true, ...report }
      },
    }

    // MCP 写操作成功后立即重算状态段（SWR：text() 同步返回缓存值，写后主动 refresh）。
    // 覆盖所有会改变「哪些 server 可用 / 有哪些备注」的写入口 —— 集中在这一处包，
    // 不需要在界面层逐个补（漏一个就会出现「改了但模型看不到」的静默不一致）。
    for (const opName of ['mcpm-add', 'mcpm-edit', 'mcpm-remove', 'mcpm-set-enabled', 'mcpm-set-all',
      'mcpm-restart', 'mcpm-note', 'mcpm-tool-enabled', 'mcpm-import', 'mcpm-compact', 'mcpm-tools-refresh']) {
      const original = handlers[opName]
      if (typeof original !== 'function') continue
      handlers[opName] = async (args: any) => {
        const result = await original(args)
        if (result && result.ok !== false) void mcp.stateCatalog.refresh()
        return result
      }
    }

    // 场景锁定查询（2026-09-19 抽到 ./request-gate.ts）：读 rules-list 得到锁定场景与当前场景。
    const { lockedSceneNames, activeSceneName, lockedSceneGuard } = createSceneLock({
      readSceneList: () => memoriesService.ops['rules-list']({}),
    })

    // ---------- 场景内改开关 = 同步改档案（v0.9.2）----------
    /**
     * 用户裁定（2026-09-17）：场景**未锁定**时，页面上的开关（MCP / 技能 / 子智能体 / 提示词）
     * 照常可用，改动**同步写进当前场景的档案**；只有「锁定」才冻结这些开关。
     * 记忆不在此列 —— 它的开关是 `rules[*].enabled` 单一真相源，本来就不经过场景档案。
     *
     * 为什么必须同步：档案的语义是「勾选集 = 该场景下开着的东西，段未定义 = 全关」（见
     * archive-engine 的四域同口径）。只改运行时、不改档案，退出场景会被快照整体回滚 ——
     * 用户看到的「改了」是假的；写进档案才既当下生效、下次进这个场景又照样生效。
     * 新增 / 改名 / 删除 / 备注 / 导入导出这些**内容**操作不进档案（它们不是场景维度）。
     */

    /**
     * 技能档案 key 映射：`<来源 key>\u0000<条目名>` → `{ 档案 key, selectable }`。
     *
     * `selectable=false` = 被同名技能覆盖的副本，或结构不完整（core 拒绝启停）——
     * 这两种都**不可能生效**，勾进档案只会让「档案说开着、技能页说没启动」（用户实测）。
     * `skill-disable` 不受此限：它只是把键从档案里删掉，任何键都可以删。
     */
    async function skillArchiveKeys(): Promise<Map<string, { key: string; selectable: boolean }>> {
      const map = new Map<string, { key: string; selectable: boolean }>()
      try {
        const r: any = await skillsService.ops['skill-state']({})
        for (const root of ((r && r.data && r.data.roots) || [])) {
          const rootKey = String((root && root.key) || '')
          if (!rootKey) continue
          for (const sk of ((root && root.skills) || [])) {
            const entry = String((sk && sk.name) || '')
            if (!entry) continue
            // 与 skillRows / skillScan 同口径：档案里存**声明名**（frontmatter name）。
            // 用条目名拼 key 会被保存时的 stale 校验当成未知键丢掉。
            map.set(rootKey + '\u0000' + entry, {
              key: rootKey + '/' + String(sk.declaredName || entry),
              selectable: !sk.shadowedBy && sk.loadable !== false,
            })
          }
        }
      } catch { /* 读不到状态 → 调用方退化为原样拼 key */ }
      return map
    }

    /**
     * 某个来源下的技能档案 key（来源级开关用）：
     *  - `all`：该来源下**全部**键 —— 停用来源时按它清理（连历史残留一起清掉）；
     *  - `selectable`：真正**生效得了**的那些 —— 启用来源时只并入这一批。
     */
    async function skillArchiveKeysOfRoot(rootKey: string): Promise<{ all: string[]; selectable: string[] }> {
      const all: string[] = []
      const selectable: string[] = []
      try {
        const r: any = await skillsService.ops['skill-state']({})
        for (const root of ((r && r.data && r.data.roots) || [])) {
          if (String((root && root.key) || '') !== rootKey) continue
          for (const sk of ((root && root.skills) || [])) {
            const name = String((sk && sk.declaredName) || (sk && sk.name) || '')
            if (!name) continue
            const key = rootKey + '/' + name
            all.push(key)
            if (!sk.shadowedBy && sk.loadable !== false) selectable.push(key)
          }
        }
      } catch { /* 读不到 → 空列表 */ }
      return { all, selectable }
    }

    /** 字符串数组的「勾上 / 取消」（已处于目标状态时原样返回，避免无谓的档案写入）。 */
    function toggleInList(list: string[], key: string, on: boolean): string[] {
      if (!key) return list
      const has = list.indexOf(key) >= 0
      if (on === has) return list
      return on ? [...list, key] : list.filter((x) => x !== key)
    }

    /** loader 条目 id → 服务器名（档案的 mcp 段按 serverName 存）。 */
    async function serverNameOfId(id: string): Promise<string | null> {
      try {
        const r: any = await mcp.mcpmListView()
        for (const row of ((r && r.rows) || [])) {
          if (String((row && row.id) || '') === id) return String(row.serverName || row.id)
        }
      } catch { /* 读不到 → null（这一笔不同步，如实跳过） */ }
      return null
    }

    /**
     * 某台服务器当前**启用**的工具名（把档案里的 `'*'` 具化成具体名单时用）。
     *
     * live schema 优先（就是此刻真的存在的工具）；服务器没跑起来时退回「最后见过的工具名单 −
     * 停用表」——与 `computeMcpPlan` 的 `knownTools` 同源，别把「不知道」当成「一个都没有」。
     */
    async function enabledToolNames(server: string): Promise<string[]> {
      const live = await (async () => {
        try {
          const r: any = await mcp.ops['mcpm-tools']({ serverName: server })
          return ((r && r.tools) || []).filter((t: any) => t.enabled !== false).map((t: any) => String(t.name))
        } catch { return [] }
      })()
      if (live.length) return live
      try {
        const known = (await mcp.readKnownMcpTools())[server] || []
        const off = new Set(await mcp.readDisabledTools().then((m) => m[server] || []))
        if (off.has('*')) return []
        return known.map((item) => String(item.name)).filter((n) => !off.has(n))
      } catch { return [] }
    }

    /**
     * 把一次开关落到当前场景的档案上。
     * 返回 null = 无需改动（没有活动场景 / 已锁定 / 这一笔不影响档案）；
     * 返回字符串 = 档案没跟上（运行时已经生效，如实告诉用户，而不是假装成功）。
     *
     * **串行闸门**（2026-09-19 修）：档案是「读 → 改 → 写」三步，而撤销是**并发**发的
     * （`runUndo` 对每条改动各发一个请求）。5 条并发时每个请求都从同一份「全开」快照出发、
     * 各自只删掉自己那一台，最后落盘的是"只删掉一台"的结果 —— 表现就是**撤销把状态改成
     * 了反的**：场景里原本只开 1 台 MCP，全选后点撤销，结果变成 5 台开、1 台关。
     * 技能页同理（`skill-set-all` 逐条并发）。`scene-archive-save` 自己虽有写队列，
     * 但读发生在那条队列之外，所以队列救不了这个竞态 —— 必须把整段读改写串起来。
     * 非场景模式下没有这一步同步，所以只有"开着场景模式"才复现。
     */
    let sceneSyncTail: Promise<unknown> = Promise.resolve()
    function syncSwitchToScene(opName: string, args: any): Promise<string | null> {
      const run = () => syncSwitchToSceneLocked(opName, args)
      const next = sceneSyncTail.then(run, run)
      // 尾巴只用于排序，不传播结果/错误（否则一次失败会让后续每一次都跟着拒绝）。
      sceneSyncTail = next.then(() => undefined, () => undefined)
      return next
    }
    async function syncSwitchToSceneLocked(opName: string, args: any): Promise<string | null> {
      const scene = await activeSceneName()
      if (!scene) return null
      if ((await lockedSceneNames()).includes(scene)) return null
      // 开关方向。**先按 op 名判定「动词即方向」的那几个**，再看 `args.enabled`：
      // `skill-enable` / `skill-disable` / `skill-source-enable` / `skill-source-disable`
      // 的参数里**根本没有 `enabled` 字段**（只有 root / name），早先统一读 `args.enabled`
      // 会把它们一律读成 false，于是「在场景里打开某个技能」被同步成「关闭」——目标集合
      // 一次变化都没有 → 直接早退不写盘，用户看到的就是「开关了但档案不跟着变」
      // （2026-09-17 用真实产物复现）。反向更糟：启用一个来源会被同步成「把该来源下的
      // 技能全部从档案里删掉」，档案与运行时当场对不上。
      // 其余 op 仍按宿主逐字对齐：`mcpm-tool-enabled` 的语义是「缺省 = 启用」（`enabled !== false`）。
      const enabled = opName === 'skill-enable' || opName === 'skill-source-enable'
        ? true
        : opName === 'skill-disable' || opName === 'skill-source-disable'
          ? false
          : args && typeof args.enabled === 'boolean'
            ? args.enabled === true
            : opName === 'mcpm-tool-enabled'
      let next: any
      let cur: any = {}
      try {
        const slice = await memoriesService.readArchiveSlice()
        cur = (slice.archives && slice.archives[scene]) || {}
        next = { ...cur }
        switch (opName) {
          case 'skill-enable':
          case 'skill-disable': {
            const root = String((args && args.root) || 'dsh')
            const entry = String((args && args.name) || '')
            const hit = (await skillArchiveKeys()).get(root + '\u0000' + entry)
            const key = (hit && hit.key) || root + '/' + entry
            // 勾进来这件事只对**生效得了**的技能做：被同名覆盖的副本、结构不完整的技能
            // 写进去也永远不生效（运行时那一步本来就跳过了它们），档案就会开始说谎。
            // 取消勾选（enabled=false）不受限——它只是把键删掉，历史残留正好顺手清掉。
            if (enabled && hit && !hit.selectable) return null
            next.skills = toggleInList(Array.isArray(next.skills) ? next.skills.slice() : [], key, enabled)
            break
          }
          case 'skill-set-all': {
            const items: any[] = Array.isArray(args && args.items) ? args.items : []
            const map = await skillArchiveKeys()
            let list: string[] = Array.isArray(next.skills) ? next.skills.slice() : []
            for (const item of items) {
              const root = String((item && item.root) || '')
              const entry = String((item && item.name) || '')
              if (!root || !entry) continue
              const hit = map.get(root + '\u0000' + entry)
              if (enabled && hit && !hit.selectable) continue
              list = toggleInList(list, (hit && hit.key) || root + '/' + entry, enabled)
            }
            next.skills = list
            break
          }
          case 'skill-source-enable':
          case 'skill-source-disable': {
            // 来源级没有独立字段：档案靠「来源下有没有被勾的技能」反推（computeSkillsPlan）。
            // 启用时只并入**生效得了**的技能（被覆盖的副本/结构不完整的整批不进档案）；
            // 停用时按**全部**键清（连历史残留一起清掉）。
            const keys = await skillArchiveKeysOfRoot(String((args && args.root) || ''))
            const pick = enabled ? keys.selectable : keys.all
            let list: string[] = Array.isArray(next.skills) ? next.skills.slice() : []
            if (enabled) { for (const k of pick) if (list.indexOf(k) < 0) list.push(k) }
            else { const drop = new Set(pick); list = list.filter((k) => !drop.has(k)) }
            next.skills = list
            break
          }
          case 'mcpm-set-enabled': {
            const server = await serverNameOfId(String((args && args.id) || ''))
            if (!server) return null
            next.mcp = { ...(next.mcp || {}) }
            if (enabled) next.mcp[server] = '*'
            else delete next.mcp[server]
            break
          }
          case 'mcpm-set-all': {
            if (!enabled) { next.mcp = {}; break }
            const all: Record<string, string> = {}
            try {
              const r: any = await mcp.mcpmListView()
              for (const row of ((r && r.rows) || [])) {
                const n = String((row && row.serverName) || '')
                if (n) all[n] = '*'
              }
            } catch { return null }
            next.mcp = all
            break
          }
          case 'mcpm-tool-enabled': {
            const server = String((args && args.serverName) || '')
            const tool = String((args && args.tool) || '')
            if (!server || !tool) return null
            const has = next.mcp && Object.prototype.hasOwnProperty.call(next.mcp, server)
            // 服务器没勾 = 该场景下这台服务器关着，工具级开关在运行时本来就不生效（工具不存在）。
            if (!has) return null
            const spec = next.mcp[server]
            if (spec === '*') {
              // '*' = 全部工具。只有「关掉某个工具」才需要具化；否则 '*' 已经涵盖了启用这一笔。
              if (enabled) return null
              const live = await enabledToolNames(server)
              next.mcp = { ...next.mcp, [server]: live.filter((t) => t !== tool) }
            } else {
              const list = Array.isArray(spec) ? spec.slice() : []
              next.mcp = {
                ...next.mcp,
                [server]: enabled
                  ? (list.indexOf(tool) < 0 ? [...list, tool] : list)
                  : list.filter((t) => t !== tool),
              }
            }
            break
          }
          case 'subagent-toggle': {
            const name = String((args && args.name) || '')
            next.subagents = toggleInList(Array.isArray(next.subagents) ? next.subagents.slice() : [], name, enabled)
            break
          }
          case 'quickprompt-toggle': {
            // 与上面几段**不同**：这一段未定义说的是"这一域保持现状"，不是"一个都没勾"。
            // 所以在没绑定的场景里手动勾一条快捷词，不该悄悄把它变成"按场景勾选"——
            // 那会让下一次进场景的行为整个换掉（用户看到的只是"我开了一个开关"）。
            if (!Array.isArray(next.quickPrompts)) return null
            const id = String((args && args.id) || '')
            if (!id) return null
            next.quickPrompts = toggleInList(next.quickPrompts.slice(), id, enabled)
            break
          }
          default: return null
        }
      } catch (e) {
        return message(e)
      }
      // 空段 = 未定义（「一个都没勾 = 全关」），删掉以免两种语义并存（与 scene-archive-save 同口径）。
      for (const seg of ['skills', 'subagents']) {
        const list = next[seg]
        if (Array.isArray(list) && list.length === 0) delete next[seg]
      }
      if (next.mcp && Object.keys(next.mcp).length === 0) delete next.mcp
      if (JSON.stringify(next) === JSON.stringify(cur)) return null   // 档案本来就是这样 → 不写盘
      // 与「在档案弹窗里点保存」走同一条路：落盘 + 就地重应用 + 快照并入（退出仍按进场景前还原）。
      try {
        const save: any = archiveService.ops['scene-archive-save']
        const res: any = await save({ scene, archive: next })
        if (res && res.ok === false) return String(res.error || '场景档案保存失败')
        if (res && res.applyError) return String(res.applyError)
      } catch (e) {
        return message(e)
      }
      return null
    }

    // handlers 后处理（2026-09-19 抽到 ./request-gate.ts）：场景锁定守卫、开关同步档案、
    // 读 op 的 anyLocked/activeScene 注解、子智能体失败清单 attach。
    // 顺序即语义（先装的在内层），整段搬运未改。
    //
    // 整机迁移快照（0.15.0 C2）在门禁装好**之前**并入 handlers：它自己不写任何域的数据，
    // 而是逐域调 handlers 表里那些 op —— 装好后取到的就是带门禁的那一份，场景锁定期间各域
    // 自己拒绝，迁移这边不必再判一套锁。
    const snapshotOps = createSnapshotOps({
      invokeOp: (name: string, args: any) => {
        const fn = handlers[name]
        return fn ? fn(args || {}) : Promise.resolve({ ok: false, error: '未知操作: ' + name })
      },
      hubPath,
      ensurePaths,
      pluginVersion: () => PKG_VERSION,
      promptsDir: () => promptsDir,
      quickPromptsDir: () => quickPromptsDir,
      message,
    })
    Object.assign(handlers, snapshotOps)

    installHandlerGuards({
      handlers,
      lockedSceneNames,
      activeSceneName,
      syncSwitchToScene,
      subagentToolFailures,
    })

    // A1 的"机器那一边"：拿**真实** op 表与 `./op-registry.ts` 对账，四个方向都查（未归类 /
    // 幽灵条目 / serviceWrite 与 service 自报分叉 / 只读与写自相矛盾）。
    // 为什么值得在启动期花这一次遍历：门禁失守的症状从来不是报错，而是"没配令牌也能写"或
    // "锁定的场景能被改"（0.6.0 / 0.7.0 / 0.10.0 已失守四次）。少一个 op 没登记，这里当场
    // 在兼容页挂一条降级，而不是等到出事再倒查。
    {
      const problems = auditProblems(auditOpRegistry(Object.keys(handlers), [
        ...skillsService.writeOps,
        ...memoriesService.writeOps,
        ...archiveService.writeOps,
        ...subagentService.writeOps,
      ]))
      if (problems.length) {
        ctx.logger?.warn?.(`op 登记表与实际 op 表对不上（${problems.length} 处）：${problems.join('；')}`)
        noteRuntime({
          id: 'op-registry',
          label: 'op 门禁登记表对账',
          kind: 'read',
          fallback: 'inform-only',
          detail: `${problems.length} 处对不上：${problems.slice(0, 6).join('；')}${problems.length > 6 ? ' 等' : ''}`
            + ' —— 未归类的 op 不受写门禁与场景冻结约束。修法：在 src/op-registry.ts 补登记那一条。',
        })
      } else {
        clearRuntimeNote('op-registry')
      }
    }

    // ---------- agent-facing tools (standard ctx.tools.register + defineTool) ----------
    const text = (value: string) => [{ type: 'text' as const, text: value }]
    /**
     * 采纳遥测：把每个工具包一层，模型一调就记一笔"哪个域被伸手了"（见 context-inject 的
     * `noteToolUse`）。计数在宿主工具对象之外，所以**参数校验失败也算**——我们要测的是
     * "模型知不知道有这个域、会不会去用"，不是"调用写得对不对"。
     *
     * 只统计本插件自己的工具，不走 `tools/result` 这类宿主事件：事件的作用域语义一旦变化，
     * 遥测会静默变成 0，而 0 恰好会被读成"模型从来不用"——一个假结论比没有结论更糟。
     * 包自己的工具是确定性的：工具在，观测就在。
     */
    const trackAdoption = (def: ToolDefinition): ToolDefinition => {
      const name = String((def as { name?: unknown }).name ?? '')
      const run = (def as { execute?: unknown }).execute
      if (name === '' || typeof run !== 'function') return def
      return {
        ...def,
        async execute(args: unknown, exec: unknown) {
          try { if (contextInjectorNote !== null) contextInjectorNote(name, exec && (exec as { agent?: unknown }).agent) } catch { /* 遥测绝不能影响工具 */ }
          return (run as (a: unknown, e: unknown) => unknown)(args, exec)
        },
      } as ToolDefinition
    }
    /**
     * 与宿主 `defineTool` **同签名的**本地包装。
     *
     * 为什么用同名遮蔽而不是逐个改 14 个注册点：采纳遥测必须覆盖**每一个**域工具，
     * 漏一个就得到"这个域从来没用过"的假结论。遮蔽 import 让"新加工具自动被统计"成为
     * 默认，而不是靠后来者记得手动加。
     *
     * 类型上刻意**不重写签名**，而是把箭头函数断言成 `typeof hostDefineTool`：宿主签名带
     * `const S/O` 类型参数，照着写一遍会让 TS 在每个调用点上多展开一层 `InferObject<S, ?>`，
     * 直接撞 "Excessive stack depth comparing types"（实测）。断言成宿主自己的类型之后，
     * 14 个调用点的参数表推断与改造前**完全一致** —— 宿主改签名时该报错的地方照旧报错；
     * 包装体本身只是转发（参数收 `unknown`、原样交给宿主），不参与推断，也就没有可失效的类型。
     */
    const hostDefineToolAny = hostDefineTool as unknown as (options: unknown) => ToolDefinition
    const defineTool = ((options: unknown): ToolDefinition =>
      trackAdoption(hostDefineToolAny(options))) as unknown as typeof hostDefineTool

    // 各域共用的那一份依赖（形状见 tools/deps.ts）。defineTool 带着遥测一起传下去 ——
    // 各域必须用它，直接 import 宿主的那个会丢掉采纳统计。
    /**
     * 「最近改动」流水的模型侧挂点（0.15.0 B2）。
     *
     * 为什么包在**交给工具的 op 表**上而不是散进每个 op：op 执行有多条入口路径（HTTP 路由、
     * 模型工具的 execute、场景引擎），而判断「谁干的」这件事只有调用点知道 —— 在 op 里自己猜
     * 调用方就是猜。这里给工具看到的表包一层，界面上 handlers 表那份原样不动，两条路各记各的。
     * 只多记一条流水：不改行为、不改返回值、也不吞异常（写类与成败的判据在 ./audit-log.ts）。
     */
    /**
     * **模型侧的冻结闸**（审查 F3，0.17.0）：与 HTTP handlers 用同一个判据函数。
     *
     * 此前冻结只装在 `handlers` 上，而模型工具拿的是 `service.ops` 的副本 —— 于是「锁一个
     * **非活动**场景」在 HTTP 上被拒、在模型侧五个域（技能/记忆/MCP/子智能体/场景档案）
     * 全放行：`lockedSceneGuard()` 只看**当前**场景，锁的是别的场景时它返回 null。
     * 一个界面禁用、模型可写的门禁，等于没有门禁。
     *
     * 装在这里而不是 service.ops 上：进/退场景的运行时应用直调 `service.ops`
     * （`applySkills` / `applyMcpServerSwitches` / …），装在那一层会把场景自己锁死（见
     * `createFrozenGate` 的注释）。`auditOps` 返回的是**新表**，原表不受影响。
     */
    const frozenGate = createFrozenGate({ lockedSceneNames, activeSceneName })
    // 被拒时不记流水：什么都没改，记下来只会把真变更淹没（与只读 op 同一口径）。
    const modelAudit = (opName: string, args: any, result: any) => recordOpAudit(opName, args, 'model', result)
    const auditOps = <T extends Record<string, unknown>>(ops: T): T => guardModelOps(ops, frozenGate, modelAudit)
    const auditFn = (opName: string, fn: (args: any) => Promise<any>) =>
      guardModelOp(opName, fn, frozenGate, modelAudit)
    const toolDeps = {
      defineTool,
      // 量体积只认**注册成功**的那些（注册失败的域工具本来就不在模型工具表里）——
      // 兼容页「模型工具表」块的分组与 ≈token 都取自这里，那是这份设置唯一的数字来源。
      register: (def: ToolDefinition) => { recordToolSize(def); tools.register(def) },
      lockedSceneGuard,
      syncSwitchToScene,
      // 错误句里点名工具前要先问一句（判据与两个目录的 `listToolVisible` 同一份缓存）。
      toolVisible: (name: string) => !toolTableHidden().has(name),
      reachNoticeForAgent,
      presetRoster: candidates.presetRoster,
      injectNoticeOptions,
      message,
    }
    const mcpToolOps = auditOps(mcp.ops)
    buildMcpTools({
      ...toolDeps,
      mcpmListView: mcp.mcpmListView,
      mcpmTools: mcp.ops['mcpm-tools'],
      mcpmSetEnabled: mcpToolOps['mcpm-set-enabled'],
      mcpmRestart: mcpToolOps['mcpm-restart'],
      mcpmToolEnabled: mcpToolOps['mcpm-tool-enabled'],
      mcpmAdd: mcpToolOps['mcpm-add'],
      mcpmEdit: mcpToolOps['mcpm-edit'],
      mcpmNote: mcpToolOps['mcpm-note'],
      // **故意不接 `mcpm-reveal`**：`mcp_manager_save` 的改分支用 `mcpmListView()` 的
      // 打码视图填回省略字段，由 `mcpm-edit` 的 `resolveMaskedKv` / `resolveMaskedUrl`
      // 还原真值 —— 那条路本来就是给"表单里出现打码值"设计的（界面编辑框预填的就是它）。
      // 让模型驱动的工具在进程内读明文凭据，是另一条没人设计过、也没有测试覆盖的路径。
    })
    buildSkillTools({ ...toolDeps, skillsOps: auditOps(skillsService.ops) })
    // 传 op 表而不是 promptsService：「生效中」的判定只有 `agentsmd-list` 里有（场景绑定
    // 的那份才算），直调服务会得到文件比对口径 —— 场景驱动时工具会报一个与界面不同的答案。
    //
    // `applyPresetGuarded` 是模型侧**唯一**不经 op 表的写路径（`prompt_manager_apply` 直接调它，
    // 见上面 `frozenGate` 的注释），所以冻结闸要在这里显式套一层 —— 它对应的 HTTP op 是
    // `agentsmd-apply`（冻结清单里那条）。少了这一层，"锁着**别的**场景"时模型仍能换掉当前
    // 场景的提示词绑定（审查 F3 的另一半）。
    const applyPresetForModel = async (id: string) => {
      const denied = await frozenGate('agentsmd-apply', { id })
      return denied ? { ok: false as const, error: denied } : applyPresetGuarded(id)
    }
    buildPromptTools({ ...toolDeps, promptOps: auditOps(promptOps), applyPresetGuarded: applyPresetForModel, promptsDir })
    buildMemoryTools({ ...toolDeps, rulesOps: auditOps(memoriesService.ops) })
    // 场景族（tools/scene.ts）：列场景与档案（`_list`）+ 建场景 / 写档案 / 绑提示词（`_save`）
    // + 进入与退出（`_switch`）。
    // 传**包装后**的 `archiveService.ops`：`scene-archive-save` 与 `scene-mode-set` 都在本文件
    // 被包了一层（前者联动人设开关、后者带锁定守卫与目录重算），工具走同一条路才有同一套行为。
    //
    // `sceneActivate` 传的是 **handlers 表里那份**（`buildSceneSyncOps` 覆盖过的）：AGENTS.md
    // 同步在包装里，直调 `memoriesService.ops['rules-set-active']` 会静默漏掉"把场景绑定的
    // 预设正文写进 `~/.dsh/AGENTS.md`、退出时恢复基线"这一步。传 handlers 里那份而不是在这里
    // 再包一次，是为了让工具与 HTTP API 共用同一个实现（不会各自漂移）。
    buildSceneTools({
      ...toolDeps,
      rulesOps: auditOps(memoriesService.ops),
      archiveOps: auditOps(archiveService.ops),
      sceneActivate: auditFn('rules-set-active', (args: any) => handlers['rules-set-active'](args)),
    })
    buildSubagentTools({
      ...toolDeps,
      // 只换掉工具看到的 `ops` 那一层（原型链回真实服务，其余读法一字不动）。
      subagentService: Object.assign(Object.create(subagentService), { ops: auditOps(subagentService.ops) }),
      sceneLists: subagentSceneLists,
      toolFilterFor: subagentToolFilterFor,
      failures: subagentFailures,
    })

    if (typeof ctx.on === 'function') {
      // 三个确认门的统一前裁决。口径（用户裁定，方案 B）：会话审批策略为 never（「完全权限」预设）
      // = 用户已在预设层面预先批准一切确认门，**直接放行**并写审计日志留痕。
      // 不能把 ask 丢给审批层：宿主 decide() 对 never 直接返回 rejected（fail-closed），确认卡
      // 永远弹不出，模型只会收到一句无信息量的「用户拒绝」。这与官方子代理工具（无 ask 门）
      // 在完全权限下的行为一致；探测实现与回归测试见 approval-policy.ts（必须 ctx.get('approval')，
      // 不能用 ctx.approval——inject 未声明该服务时 cordis 代理会抛 "cannot get property without inject"）。
      const CONFIRM_LABELS: Record<string, string> = {
        // 0.14.0 起 create 与 update 并成 save（标签取中性的「保存」：改一份已有技能时
        // "新建"是句假话）。危险度不变 —— 两者都往 hub 落文件。
        skill_manager_save: '「保存技能」',
        // 0.14.0 起 write/update 并成一条 upsert，标签取中性的「保存记忆」：「写入」在改一条
        // 已有记忆时是句假话（与同一轮修 `prompt_manager_list` 的「生效中」同一个口径）。
        memory_manager_save: '「保存记忆」',
        // 场景族的唯一写工具。无条件问（不设开关）—— 它改的是"进入这个场景时会切换哪些
        // mcp / 技能 / 人设"，改错了影响的是用户切场景之后的**整个运行时环境**，而不是一次
        // 输出。与 skill / subagent 的 save 同一档（都是"以后每次都按它来"的长期资产）。
        scene_manager_save: '「保存场景」',
        // 0.14.0 的边界是"启用与进入留在界面"，0.14.x 补上这条工具后它成为**改运行时**的那一条：
        // 六处开关一起动 + 收窄注入 + 改写 AGENTS.md。危险度高于 `_save`（那个只写剧本），
        // 所以门禁同档、不降。
        scene_manager_switch: '「切换场景」',
        subagent_manager_run: '「运行子代理」',
        // 0.14.0 起 create 与 update 并成 save（标签取中性的「保存人设」：改一份已有文件时
        // "新建"是句假话）。危险度不变 —— 两者都往 hub 里落/整份重写一份文件。
        subagent_manager_save: '「保存人设」',
        // 0.14.0 起 add 与 edit 并成 save，模型侧能塞进任意 command/args 的仍只有这一个工具
        // —— 门禁挂在它上面即覆盖整个模型可达面。标签取中性的「保存」：改一台已有服务器
        // （含改 URL / 命令）与新增一台是同一档危险度，但"新增"在改分支上是句假话。
        mcp_manager_save: '「保存 MCP 服务器」',
      }
      const bypassedByFullAccess = (exec: any): boolean => {
        if (!isApprovalNever(ctx, exec)) return false
        // 留痕：完全权限下跳过确认属于「用户已授权」，但要可审计（日志失败不阻塞主流程）。
        pluginLog()('confirm-bypass', `完全权限（approval=never）：跳过${CONFIRM_LABELS[String(exec && exec.name)]}的确认，直接放行`).catch(() => {})
        return true
      }
      // 确认门是「问用户要不要做」，如果这个请求本来就做不成，弹卡 / 写 bypass 日志只会产生
      // 一次无效审批：用户批准之后模型收到的是「人设不可用」/「人设不存在」/「人设已存在」。
      // 所以先校验，再决定要不要问。校验本身不可用时返回 true（保持原行为，
      // 绝不因为探测失败而少问一次）。
      const subagentManagerRunTargetExists = async (exec: any): Promise<boolean> => {
        try {
          const name = String((exec && exec.arguments && exec.arguments.agent) || '').trim()
          if (!name) return false
          const list = await subagentService.list()
          return list.some((p) => p.name === name)
        } catch (e) {
          return true
        }
      }
      // 0.14.0 删掉了 `subagentWriteWouldApply`：它是为"create 要目标未被占用 / update 要
      // 改名已存在"这套两工具分工写的裁决。合并成一条 upsert 之后它恒为"会应用"（判定只剩
      // "存在就改、不存在就建"，没有第三种情况），留着就是一个永远返回 true 的函数。
      ;(ctx.on as (event: string, cb: (exec: any, next: () => unknown) => unknown) => unknown)('tools/pre-execute', async (exec, next) => {
        if (!exec || !CONFIRM_LABELS[String(exec.name)]) return next()
        if (exec.name === 'subagent_manager_run' && !(await subagentManagerRunTargetExists(exec))) return next()
        if (bypassedByFullAccess(exec)) return next()
        if (exec.name === 'skill_manager_save') {
          // 卡是**执行前**弹的：此时工具还没读 `skill-state`，走建还是改还没判出来，
          // 所以 reason 只能取并集。0.14.0 起 create 与 update 并成一条 upsert。
          return Promise.resolve({ kind: 'ask', reason: 'Create or overwrite a skill under ~/.dsh/tool-management/skills' })
        }
        if (exec.name === 'mcp_manager_save') {
          // 为什么必须问：stdio 服务器是宿主按你给的 command/args **spawn** 出来的进程
          // （见 http-fence.ts 对 mcpm-add 的说明），且这条目会写进配置长期生效。
          // 写一个技能文件都要问，注册一条能起进程的配置却直接放行，是门禁倒挂 ——
          // 危险度与门禁强度必须同向。
          // 卡里回显将执行的命令行：用户批准的是「跑这条命令」，不是「加一个服务器」。
          // 0.14.0 起 save 也覆盖"改一台已存在的服务器"，此时把**旧命令**一并摆出来：
          // 「把 `npx A` 改成 `npx B`」与「新增一台跑 `npx B` 的」是两件不同的事，
          // 只报新那句会让一次改命令看起来像新建。
          const a = (exec && exec.arguments) || {}
          const server = String(a.server || '')
          const transport = String(a.transport || '')
          const cmd = [a.command, a.args]
            .map((x) => String(x ?? '').trim())
            .filter((x) => x !== '')
            .join(' ')
          // 新 URL 走打码形态：查询串里的凭据不该明文进确认卡（与列表视图同一份实现）。
          // 旧 URL 已经是打码的 —— 它来自列表视图。
          const nextLine = transport === 'stdio'
            ? (cmd ? `stdio command: ${cmd}` : 'stdio command: (empty)')
            : `${transport || 'streamable-http'} url: ${String(maskUrlQuery(String(a.url || '')) || '(empty)')}`
          let cur: any = null
          try {
            const r: any = await mcp.mcpmListView()
            cur = ((r && r.rows) || []).find((x: any) => String(x.serverName) === server) || null
          } catch { /* 拿不到现状就按"新增"的口径报：宁可少说一句，也不因此拦住操作 */ }
          let detail = nextLine
          if (cur) {
            const curCmd = [cur.command, Array.isArray(cur.args) ? cur.args.join(' ') : cur.args]
              .map((x) => String(x ?? '').trim())
              .filter((x) => x !== '')
              .join(' ')
            const curLine = String(cur.transport) === 'stdio'
              ? `stdio command: ${curCmd || '(empty)'}`
              : `${String(cur.transport || 'streamable-http')} url: ${String(cur.url || '(empty)')}`
            detail = `current — ${curLine}; new — ${nextLine}`
          }
          return Promise.resolve({
            kind: 'ask',
            reason: `${cur ? 'Update' : 'Add'} MCP server「${server}」— ${detail}. A stdio server is spawned by the host and the entry persists in the config.`,
          })
        }
        if (exec.name === 'memory_manager_save') {
          // D2：模型写规则默认需确认；设置关闭后直接放行。ask 无应答者时降级为拒绝（fail-closed），
          // 不在此处做任何兜底放行。
          // 0.14.0 起 write/update 并成一条 upsert，reason 必须同时覆盖两种可能：卡是**执行前**
          // 弹的，此时工具还没跑，走"建"还是"改"要读一次 `rules-list` 才知道。旧实现按工具名
          // 分叉出两句，合并后只能取并集 —— 不能只留 "write"，那会让一次覆盖已有内容的操作
          // 在卡上看起来像新建（危险度与门禁强度必须同向）。
          const what = 'Create or overwrite a memory under ~/.dsh/tool-management/memories'
          return mcp.readPluginSettings()
            .then((s) => (s.requireConfirmForModelRuleWrite ? { kind: 'ask', reason: what } : next()))
            .catch(() => ({ kind: 'ask', reason: what }))
        }
        if (exec.name === 'scene_manager_save') {
          // 与记忆 save 的区别：**不设开关**。记忆写入有 `requireConfirmForModelRuleWrite`
          // 可以放行，场景写入没有 —— 它改的是"用户切进这个场景之后，哪些 mcp / 技能 / 人设
          // 会开、其余全部关掉"，那是一次环境切换的剧本，不是一份可以事后改的文档。
          // 卡里回显场景名与这次要写的档案段（用户批准的是"这个场景进入时开这些"）。
          const a = (exec && exec.arguments) || {}
          const scene = String(a.scene || '')
          const secs = ['mcp', 'skills', 'subagents'].filter((k) => a[k] !== undefined)
          const detail = secs.length
            ? `archive sections: ${secs.join(', ')}`
            : 'record only (label / description / prompt)'
          return Promise.resolve({
            kind: 'ask',
            reason: `Save scene「${scene}」— ${detail}. Entering it switches on exactly what this scene lists and turns everything else off.`,
          })
        }
        if (exec.name === 'scene_manager_switch') {
          // 与 `scene_manager_save` 同一档（都无条件问），但**问的是另一件事**：
          // save 改的是"以后进这个场景会怎样"（一份剧本），switch 改的是**现在** ——
          // 六处开关一起动（MCP 服务器级/工具级、技能来源级/技能级、人设、备注覆盖），
          // 注入范围随之收窄，并且**改写 `~/.dsh/AGENTS.md`**（本插件唯一会动那个文件的
          // 动作，覆盖前 5 代备份）。危险度只高不低，所以门禁强度不降。
          // 卡里回显动作与目标场景：用户批准的是"现在就切到 X"，不是"改一下 X 的配置"。
          const a = (exec && exec.arguments) || {}
          const action = String(a.action || '')
          const scene = String(a.scene || '')
          const what = action === 'exit'
            ? 'Leave the current scene — restore the runtime switches and the AGENTS.md baseline saved on entry'
            : `Enter scene「${scene}」— apply its archive (everything it does not list goes off), narrow injection to its memories, and apply its bound prompt preset to AGENTS.md`
          return Promise.resolve({ kind: 'ask', reason: what })
        }
        if (exec.name === 'subagent_manager_save') {
          // 与 `skill_manager_save` 完全对称：往 hub 里落一份新文件 / 整份重写一份现有文件。
          // 无条件问（不设开关）—— 人设是"以后每次委派都按它来"的长期资产，改错了影响的是
          // 后续所有子代理的行为，而不是一次输出。
          // 改分支尤其：`subagent-update` 走 serializePersona 整份重写，改名还会连带改
          // 场景档案里的绑定 —— 那是一次会影响环境配置的操作，不是一句文案修改。
          // 建还是改要读一次现状才知道（工具侧也是执行时才读），所以这里查一下名单：
          // 只报"新建"会让一次整份重写看起来像加了个文件，反过来也一样。
          const a = (exec && exec.arguments) || {}
          const name = String(a.name || '')
          let exists = false
          try {
            const docs: any[] = await subagentService.list()
            exists = docs.some((p) => String(p && p.name) === name)
          } catch { /* 读不到现状就按"新建"的口径报：宁可少说一句，也不因此拦住操作 */ }
          const what = exists
            ? `Rewrite persona「${name}」${a.nextName ? ` and rename it to「${String(a.nextName)}」(scene-profile bindings follow the rename)` : ''}`
            : `Create persona「${name}」under ~/.dsh/tool-management/subagents`
          return Promise.resolve({ kind: 'ask', reason: what })
        }
        // subagent_manager_run：子代理运行花真 token：默认确认（requireConfirmForModelSubagentRun !== false），可关。
        // `inherit: true` 时子代理会读到本次会话已完成的对话 —— 卡里如实说明（用户批准的是
        // "把这段对话交给它"，不只是"跑个子代理"）。文案只在与 fork 有关的部分分叉。
        const inherits = !!(exec && exec.arguments && exec.arguments.inherit)
        const ask = { kind: 'ask' as const, reason: inherits ? 'Run a subagent on this conversation (it inherits the conversation; consumes tokens)' : 'Run a subagent (consumes tokens)' }
        return mcp.readPluginSettings()
          .then((s) => ((s as any).requireConfirmForModelSubagentRun !== false ? ask : next()))
          .catch(() => ask)
      })
    }

    // ---------- per-tool MCP switches: execution guard + visibility ----------
    try {
      mcp.warmUp().catch(() => { /* side-car unavailable → no restrictions */ })
    } catch (e) { /* ignore */ }
    // 可见性半边（B1）：官方 `tools.restrict()` 要求 **agent scope**，所以停用的工具要
    // 逐个 agent 应用 —— 与技能侧同一套生命周期写法（`agent/created` / `agent/disposed`
    // + 启动期扫一遍 `agents.list()`，见 skills/service.ts）。
    if (typeof ctx.on === 'function') {
      try {
        ctx.effect(() => {
          const stop = (ctx.on as (event: string, cb: (payload: any) => void) => (() => void) | void)('agent/created', (payload) => {
            mcp.attachAgent(payload && payload.agent)
          })
          return typeof stop === 'function' ? stop : () => { /* noop */ }
        }, 'dsh-plugin-tool-management: mcp visibility (agent created)')
        ctx.effect(() => {
          const stop = (ctx.on as (event: string, cb: (payload: any) => void) => (() => void) | void)('agent/disposed', (payload) => {
            mcp.detachAgent(payload && payload.agent)
          })
          return typeof stop === 'function' ? stop : () => { /* noop */ }
        }, 'dsh-plugin-tool-management: mcp visibility (agent disposed)')
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') as { list?: () => unknown[] } | undefined : undefined
        if (agents && typeof agents.list === 'function') {
          for (const agent of agents.list()) mcp.attachAgent(agent)
        }
      } catch (e) { /* agents 服务不可用 → 仅靠事件（与技能侧同一退路） */ }
    }
    if (typeof tools.guard === 'function') {
      ctx.effect(() => tools.guard!((exec) => {
        try {
          // Reads the TTL cache without I/O: the guard runs on the hot path.
          if (mcp.isToolDisabled(String((exec && exec.name) || ''))) {
            return '该工具已在 MCP 管理页停用'
          }
          // 兼容页关掉的工具：可见性半边（restrict）正常时模型根本看不到它，走到这里只有两种
          // 可能 —— 名字是猜的，或者可见性半边没生效（那条降级会上报）。执行侧一律拦住。
          if (toolTableHidden().has(String((exec && exec.name) || ''))) {
            return '该工具已在「兼容」页的模型工具表里关掉（要它先在那里打开）'
          }
        } catch (e) { /* fallthrough to allow */ }
        return undefined
      }), 'dsh-plugin-tool-management: disabled mcp tool guard')
    }
    if (typeof ctx.on === 'function') {
      try {
        // MCP servers (de)register their tools as instances come and go; the
        // visible-set restriction must track that — and so must the MCP state
        // section: 工具加载完成后若不重算，注入文本会一直停留在「空/旧集合」的缓存值上
        //（用户切 MCP 后立即看上下文注入就是空段 —— 2026-09-16 实测）。
        ctx.effect(() => {
          const stop = (ctx.on as (event: string, cb: () => void) => (() => void) | void)('tools/change', () => {
            mcp.scheduleToolRestrictions()
            void mcp.stateCatalog.refresh()
          })
          return typeof stop === 'function' ? stop : () => {}
        }, 'dsh-plugin-tool-management: tools/change listener')
      } catch (e) { /* ignore */ }
    }
    ctx.effect(() => () => {
      mcp.dispose()
    }, 'dsh-plugin-tool-management: tool restriction cleanup')

    // ---------- HTTP API route (UI half), registered defensively ----------
    // 正文 2026-10-01 整段搬到 ./http-api.ts（一字未改，只把 apply 作用域的名字改走 deps）。
    // 位置也保持原样：这一段是 apply 的最后一条注册，前面的 handlers 表 / 门禁 / 白名单都已就位。
    // 传引用而不是快照：`handlers` 在本调用之前还被 Object.assign 追加过、被 installHandlerGuards
    // 逐条重包过，注册之后请求期读的也是当时的最新那份。
    installHttpApi({
      ctx, config, webServer, handlers, message, withPatchWarnings,
      tokenConfigState, tokenConfigure,
      CONFIG_TOKEN, TOKEN_DISABLED, TOKEN, tokenMatches, BOOT_ID, markAccepted, unmarkAccepted,
      WRITE_OPS, SENSITIVE_OPS,
    })

  },
}

