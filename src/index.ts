// dsh-plugin-tool-management —— 宿主侧，按 DeepSeek Harness 插件开发规范
// （https://deepseek-harness.github.io/deepseek-harness/develop/basic/）用 TypeScript 写成：
//   * 对象形式 Cordis 插件：{ name, inject, apply }
//   * 必需服务在 `inject` 里声明 —— 框架保证它们在 apply 之前就绪，某个消失时重载插件
//   * 面向 agent 的能力以注册工具的形式暴露（ctx.tools.register + defineTool）
//   * 面向界面的能力经 webServer 精确路由暴露（客户端那一半用），注册时按缺失降级
//
// 构建：`tsc -p tsconfig.json` 编到 lib/index.js —— 交付的就是编译产物，与 DSH 自己的
// 包同一惯例。

import type { Context } from '@deepseek-ai/cordis'
import { symbols } from '@deepseek-ai/cordis'
import { defineTool as hostDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createHistoryDomain } from './sessions/history.js'
import type { SessionsRegistry } from './sessions/history.js'
import { createSkillsService, pluginLog } from './skills/service.js'
import { renameWithRetry, resolveDshHome, trashRootPath } from './skills/core.js'
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
import { hasQuarantineMarker, readQuarantineMarker, writeFileAtomically } from './memories/index-io.js'
import { registerBootReconciler, reconcileMcpRestart, runBootReconcilers } from './boot/reconcile.js'
import { pruneDesktopAuthCookies } from './desktop-cookie-prune.js'
import { hasMcpRestartMarker, processAlive, readMcpRestartMarker } from './mcp/restart-marker.js'
import { runStateDoctor } from './ops/state-doctor.js'
import { createSubagentService, decideToolFilter, defaultPersonasDir, validPersonaName } from './subagents/service.js'
import type { ToolFilterDecision } from './subagents/service.js'
import { createSubagentCatalog } from './subagents/catalog.js'
import { createSkillCatalog, skillCatalogNeedsTakeover } from './skills/catalog.js'
import {
  createContextInjector,
  HOW_NAMED_TOOLS,
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
// 改名 / 进场景 / 存档案的联动（op 重包，从本文件 apply 闭包整段抽出）。
import { installSceneLinkage } from './scene-linkage.js'
// 访问令牌的宿主侧配置读写（从本文件 apply 闭包整段抽出，依赖显式传参）。
import { createTokenConfig } from './token-config.js'
import { EXPECTED_MIN_HOST_VERSION, EXPECTED_PEER_RANGE, VERIFIED_HOST_VERSION, summarize } from './compat/probe.js'
import { checkPatchWrite, notePatchWriteWarning, takePatchGuardWarnings } from './compat/patch-dialect.js'
import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'
import { assessPresetReach, injectionFactsOf, presetRosterOf, readCompositionFacts, reachNoticeForAgent } from './compat/preset-reach.js'
import { installHttpApi, type WebServerService } from './http-api.js'
import { createMcpManager } from './mcp/manager.js'
import type { JsonFileRead } from './mcp/disabled-tools.js'
// 确认卡回显"新 URL"时要打码（查询串里的凭据不该明文进卡片），口径与列表视图同一份实现。
import { maskUrlQuery } from './mcp/secret-guard.js'
import { createCandidates } from './scenes/candidates.js'
import type { PluginInventoryService, ToolsService } from './mcp/manager.js'

// 「已知工具」归一化与「当前可用工具数」原本定义在本文件（导出仅为测试接缝），
export { normalizeKnownTools, countEnabledTools } from './mcp/manager.js'
import { planOverrideCompaction } from './mcp/override-blocks.js'
import { applyLoaderToken, applyLoaderTokenDisabled, buildLoaderOverrideEntry, readLoaderToken, scanLoaderRows } from './mcp/loader-token.js'
// cordis.patch.yml 受管行的生成/解析/块编辑（从本文件 apply 闭包抽出，纯字符串运算）。
import { appendBlock, buildDisableBlock, buildInsertBlock, parseRows, removeEntryAll, removeMarked, spliceRanges, splitLines, type ManagedRow } from './mcp/patch-yaml.js'
import { describeMaskedOutcome, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from './mcp/secret-guard.js'
import { DEFAULT_MCP_NOTE_MAX_LENGTH, createMcpStateCatalog, normalizeMcpNote } from './mcp/state-section.js'
import { hubBackupDir, hubPath, hubRoot, migrateHubLayoutSync, relocateEntries } from './hub.js'
// 分域的 HTTP ops（从本文件 handlers 表抽出，依赖显式传参）。
import { buildCompatOps } from './ops/compat.js'
import { createUpdateChecker } from './update-check.js'
import { buildDiagnostics, type DiagnosticsSidecar } from './diagnostics.js'
import { buildPromptOps } from './ops/prompts.js'
import { buildQuickPromptOps } from './ops/quick-prompts.js'
import { buildScopeOps, type ScopeSessionRow } from './ops/scope.js'
import { buildSessionOps } from './ops/sessions.js'
import { buildTrashRetentionOps } from './ops/trash-retention.js'
// 会话作用域：侧车 scope-overrides.json + 五条 op + 启动对账。
import { rememberSessionCwd, scopeKeyOfAgent, scopeKeyOfIdSync, sessionIdentityOf, sessionIdOf, sessionScopeIdOf } from './scope/resolve.js'
import { createScopeStore } from './scope/store.js'
import { isWorkspaceScopeKey, scopeKeyLabel, workspaceScopeKeyOf } from './scope/workspace-key.js'
import { createIntentStore } from './scope/intent-store.js'
import {
  effectiveLayerOf,
  intentOf,
  isIntentDomain,
  planReconcile,
  resolveResource,
  scanSessionClaims,
  withIntent,
  type ClaimScanResult,
  type ClaimScanTargets,
  type IntentDomain,
  type IntentState,
  type ScopeIntent,
  type ScopeReconcileReport,
} from './scope/intent.js'
import {
  SCOPE_FLAG_DOMAINS,
  clampPromptBaseline,
  hasPromptOverride,
  layeredFlag,
  mcpToolServerSegments,
  promptBaselineOf,
  promptOverrideOf,
  removeSceneInScope,
  renameSceneInScope,
  sceneFlagOf,
  sessionScenePinOf,
  sessionSceneOf,
  sessionToolTableHidden,
  setSceneToolTableInScope,
  withBaseline,
  type ScopeFlagDomain,
  type ScopeGlobalSnapshot,
  type SessionBaseline,
  type SessionScope,
} from './scope/scope-overrides.js'
import type { SceneArchive } from './memories/archive.js'
import type { MemoryScopeOverride, PromptScopeOverride } from './memories/service.js'
import { promptBaselineDiffers } from './memories/prompt-layer.js'
// 回收站保留期：侧车 `hub/trash-retention.json` + 六类回收站的到期清扫。
import { createTrashRetentionDomain } from './trash-retention.js'
// HTTP 请求准入与 handlers 后处理（从本文件 apply 闭包抽出，依赖显式传参）。
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
import { buildRemoveTools } from './tools/remove.js'
import { buildSceneTools } from './tools/scene.js'
import { buildSubagentTools } from './tools/subagent.js'
import { ARG_CONDITIONAL_CONFIRM_TOOLS, argConditionalConfirmReason } from './confirm-gate.js'
import { createScenePromptSync } from './scene-prompt-sync.js'
import { defineSubagentManagerListTool, defineSubagentManagerRunTool } from './subagents/tools.js'
import { extractExportTurns, serializeTranscript } from './exports/transcript.js'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { zipSync } from 'fflate'

// ---------------------------------------------------------------------------
// 本插件碰到的服务面，只声明最小结构类型。完整契约在对应的 @deepseek-ai 包里；
// 本地只留用得上的几个成员，免得构建期多出一堆依赖。
//
// HttpReq / HttpRes / WebServerService 原本也住在这里：随 HTTP 路由正文
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






// ---------- 技能管理类型（ctx.skills 的最小面）----------
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
// 对话导出在 src/exports/transcript.ts。
// ---------------------------------------------------------------------------

/**
 * `inject` 的服务名清单（单一来源）：既声明给宿主，也是「挂载心跳」与 doctor 核对的内容。
 *
 * 为什么值得单列：任何一个名字被官方改名，本插件**根本不会 apply** —— 实测（本仓库
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

    // 桌面壳每次启动换一条鉴权 cookie 却不清理旧的，堆多了 welcome 握手会被拒
    // （界面表现为「Web authentication failed」，应用起不来）。这里同步跑在装配期，
    // 早于桌面端发起握手；失败静默，理由见模块注释。
    pruneDesktopAuthCookies()

    // 启动期对账：把「上个进程没干完」的状态补完。必须在任何读盘之前注册
    // 因为 reconciler 自己是要读盘的；但**跑**要放到服务装配完之后 —— 它要用到
    // stateDir / prompts 这些只在 apply() 里才确定的东西。调用点见下面 runBootReconcilers()。
    registerBootReconciler({
      id: 'memories-index-guard',
      label: '记忆索引隔离守卫',
      async run() {
        // 只探测、不自动修：自动修复要么读留存文件（可能更糟），要么重写空索引（丢数据）。
        // 隔离状态的正确出口是**用户点一下**（ops 层 memories-index-repair），
        // 或者用户手工删掉 .corrupt-* 与标记后重启。
        const key = resolve(hubRoot())
        if (!hasQuarantineMarker(hubRoot())) return
        console.warn(
          '[dsh-plugin-tool-management] 检测到记忆索引被隔离（memories-index.json 不在原位）。'
          + '已拒绝一切写入以免覆盖你的数据；请在「记忆管理」页点「一键修复」恢复。',
        )
        void key
      },
      async probe() {
        if (!hasQuarantineMarker(hubRoot())) return []
        const info = await readQuarantineMarker(hubRoot())
        return [{
          id: 'index-quarantined',
          label: '记忆索引被隔离',
          detail: info
            ? `记忆索引此前解析失败，已被改名留存为 ${basename(info.corruptFile)}(隔离时间 ${new Date(info.at).toLocaleString('zh-CN')}，写入版本 ${info.pluginVersion})。当前已拒绝一切记忆写入。`
            : '记忆索引此前解析失败，已被改名留存。当前已拒绝一切记忆写入。',
          detailKey: 'index-quarantined',
          params: { pluginVersion: info?.pluginVersion ?? '', corruptFile: info?.corruptFile ?? '' },
        }]
      },
    })
    // 第二个 reconciler：MCP 重启中断在阶段 1。**自动恢复**（与索引守卫相反）——
    // 重启语义就是「状态与重启前一致」，而重启前状态能从补丁备份反推出来，恢复方向明确。
    // 但它必须等 mcp 装配完（run 里要用 mcpm-set-enabled 的语义），所以 run 在下面注册。
    registerBootReconciler({
      id: 'mcp-restart-recovery',
      label: 'MCP 重启中断收尾',
      async run() {
        await reconcileMcpRestart({
          isRowDisabled: (id, level) => mcp.isRowDisabledPublic(id, level),
          setRowEnabled: (id, level, enabled) => mcp.ops['mcpm-set-enabled']({ id, level, enabled }),
          backupDir: () => hubBackupDir(),
          readBackup: (abs) => readPatch(abs),
          effectiveDisabledIn: (content, id) => mcp.effectiveDisabledIn(content, id),
        })
      },
      async probe() {
        if (!hasMcpRestartMarker()) return []
        const marker = await readMcpRestartMarker()
        if (!marker) return []
        // pid 还活着 = 那次重启可能还在跑，那不是「没干完」。如实分开两种措辞。
        const alive = processAlive(marker.pid)
        return [{
          id: 'mcp-restart-pending',
          label: 'MCP 重启未完成',
          detail: alive
            ? `「${marker.server}」的重启还在进行中（pid ${marker.pid} 仍活着）。若它卡住，可再点一次「重连」。`
            : `「${marker.server}」的重启中断在阶段 ${marker.phase}，该服务当前停在停用态。本次启动会自动按重启前的状态恢复；若已恢复则此提示随之消失。`,
          detailKey: 'mcp-restart-pending',
          params: { server: marker.server, level: marker.level, phase: marker.phase, pid: marker.pid, alive },
        }]
      },
    })

    // 第三个 reconciler：全局意图与租约的对账。启动时先对齐"上个进程留下的
    // 运行态"：意图没有记录的新装 / 升级首轮从补丁反推（显式会话覆盖还在的按租约处理，
    // 不让旧版本的"会话级开启"变成全局开启）；之后运行态恒为 `意图 ∪ 租约`。
    //
    // ⚠️ **注册序即执行序，且这一条必须先于 `scope-overrides-orphans`**（下面的孤儿清理，
    // `runBootReconcilers` 逐条 await）。痕迹闸门认的就是"侧车里还留着那个会话的条目"：
    // 会话被删除后，采纳判定的那一刻条目**还在**才算痕迹（这份痕迹正好随后被孤儿清理抹掉）。
    // 顺序一旦调换，删除场景的痕迹在采纳判定时已经不在，运行态会被读成"用户全局开过" ——
    // 也就是用户报障 A 的第二条路径复活。
    registerBootReconciler({
      id: 'scope-intent',
      label: '全局意图与租约对账',
      async run() {
        await enqueueScopeReconcile({ adoptExternal: true })
      },
    })

    const fs = ctx.fs
    const settings = ctx.settings
    const sandboxPolicy = ctx.sandboxPolicy
    const webServer = ctx.webServer
    const tools = ctx.tools
    const agents = ctx.get('agents') as unknown as {
      create?(options: Record<string, unknown>): Promise<unknown>
    } | undefined
    // pluginInventory 是可选的：用到时才探，拿不到就退化成「没有实时信息」。
    const pluginInventory = ctx.get('pluginInventory') as PluginInventoryService | undefined

    // 包版本，设置页与 HTTP API 都会吐。从**装着的** package.json 读，
    // 这样它永远与发布标签一致。
    let PKG_VERSION = 'unknown'
    // 本插件自己声明的宿主范围：更新检查用它区分「没有兼容版本」与「当前这版就不兼容」。
    let PKG_DSH_RANGE: string | null = null
    try {
      const pkg = createRequire(import.meta.url)('../package.json') as { version?: string; engines?: { dsh?: string } }
      PKG_VERSION = pkg.version || 'unknown'
      PKG_DSH_RANGE = pkg.engines && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null
    } catch (e) { /* keep unknown */ }

    // 访问令牌（抽到 ./request-gate.ts）：配置里的存量令牌 / 生效令牌 / 比对 /
    // 进程标识。引用点用解构保持原名字，index.ts 的调用处一行未改。
    const { CONFIG_TOKEN, CONFIG_TOKEN_FROM_FILE, TOKEN_DISABLED, TOKEN, tokenMatches, BOOT_ID, acceptedThisBoot, markAccepted, unmarkAccepted } = createAccessToken({ config })

    const wait = (ms: number) => ctx.timeout(ms)
    const message = (e: unknown) => String((e && (e as Error).message) || e)

    let writeChain: Promise<void> = Promise.resolve()
    function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = writeChain.then(() => fn(), () => fn())
      writeChain = run.then(() => undefined, () => undefined)
      return run
    }

    // ---------- 技能管理（核心服务，移植自 dsh-skills-manager）----------
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
    // ---------- 会话作用域：侧车 hub/scope-overrides.json ----------
    // 「同一台机器上多个对话各用一套设置」的叠加层：全局那一份一个字都不动，这里只记
    // **某个会话与全局不一样的地方**。三态存储 / 二态展示 / 自动清除的判定全在
    // ./scope/scope-overrides.ts（纯函数），本处只建读写通道。
    //
    // 为什么排在各域之前：下面每个域（快捷词 / 记忆 / 技能 / 子智能体 / MCP）都要问它
    // "这个会话的覆盖是什么"，而它自身不依赖任何一个域。
    const scopeStore = createScopeStore({
      withWriteLock,
      message,
      // 侧车 GC 的"活着的会话"：宿主**已知的全部**会话（含归档、含未挂回工作区的孤儿）——
      // 不能用下拉框那份清单（它按当前会话区成员过滤，会把孤儿当已删除）。
      // 读不到返回 null，store 那边按"不剪"处理（读不到 ≠ 全被删了）。
      liveSessionIds: () => liveSessionIds(),
    })
    // 预热：注入侧的 `scopeOfSync` 在缓存为空时一律按全局算（安全但不隔离）。启动时先读一次，
    // 让「重启后第一轮」也能看到上次钉住的场景 / 覆盖，而不是要等到第二轮。
    void scopeStore.read().catch(() => { /* 读不到 = 空表，注入侧按全局走 */ })

    // ── 作用域键解析────────────────────────────────────────────────
    //
    // 会话模式 = 会话 id；工作区模式 = `ws:<cwd>`。注入 / 守卫 / 工具表 / 提示词这些热路径
    // （同步）用 agent 自带 / 记忆下来的 cwd；ops 入口拿到的可能是真实 sessionId（斜杠菜单）
    // 或工作区键（面板），异步那一路查一次会话清单补齐。
    /** 当前隔离粒度（同步；侧车缓存未加载时按 session）。 */
    const scopeMode = () => scopeStore.modeSync()
    /** agent → 作用域键。 */
    const scopeKeyForAgent = (agent: unknown): string | null => scopeKeyOfAgent(agent, scopeMode())
    /** 会话 id / 作用域键 → 作用域键（同步；冷会话 cwd 未知时原样退回会话键）。 */
    const scopeKeyForIdSync = (id: string): string => scopeKeyOfIdSync(id, scopeMode())
    /** 会话 id / 作用域键 → 作用域键（异步；cwd 未知时查一次会话清单并记住）。 */
    async function scopeKeyForId(id: string): Promise<string> {
      if (id === '' || scopeMode() !== 'workspace' || isWorkspaceScopeKey(id)) return id
      const sync = scopeKeyForIdSync(id)
      if (sync !== id) return sync
      try {
        const rows = await scopeSessionRows()
        const row = rows.find((item) => item.id === id)
        if (row !== undefined && row.cwd) {
          rememberSessionCwd(id, row.cwd)
          return scopeKeyForIdSync(id)
        }
      } catch { /* 清单读不到 → 回退会话键（宁可少共享，不串工作区） */ }
      return id
    }
    // 全局意图：`hub/scope-intent.json`。「全局开关 = 用户想要什么」与「补丁 / 来源
    // 状态 = 为了租约此刻在跑什么」分开记，对账器把后者维持成 `意图 ∪ 租约`（见 scope/intent.ts）。
    const intentStore = createIntentStore({ withWriteLock, message })
    void intentStore.read().catch(() => { /* 读不到 = 没有意见，对账从运行态反推 */ })
    // 租约的**同步视图**（对账器每次跑完刷新）：注入 / 守卫 / 全局场景应用都要在热路径上
    // 回答"这一台现在有谁在认领"，不能每次都去算一遍全集。空表 = 还没对账过（按无租约处理）。
    let mcpLeasesSync = new Map<string, string[]>()
    let sourceLeasesSync = new Map<string, string[]>()
    /** 单条技能的租约：键是 `<root>/<声明名>`。 */
    let skillLeasesSync = new Map<string, string[]>()
    /** 对账串行链：写 op 会 await 它（拿回执），启动 / 场景联动只排进队列。 */
    let reconcileChain: Promise<void> = Promise.resolve()
    /**
     * **原始**的技能清单 op：包装版会顺带给每条补 `intent` / `globalOn` / 租约计数
     * （一次 `scanClaimsOnce`，要读会话清单并扫整张覆盖表）。内部路径（全局快照、对账、
     * 场景引擎、技能目录）只读 `enabled` / `roots`，走包装版等于每读一次清单多做一次租约扫描
     * —— 斜杠菜单一次下钻能叠出好几份，正是「切到某个域要等很久」的一截。
     */
    const rawSkillState = skillsService.ops['skill-state']
    // 技能清单的每个来源带上意图三态 + 租约计数（面板与模型工具读同一份）。
    // 包在 service 的 op 上而不是 HTTP 层：`skill_manager_list` 也直调这条 op ——
    // 只包一层的话，模型看到的"来源开着"会是租约拉起后的运行态，而用户看的是意图。
    skillsService.ops['skill-state'] = async (args: any) => annotateSkillState(await rawSkillState(args))
    // 单条技能的启停落在 core 那张**机器级**策略表上（官方 provider 按进程发布它），所以它
    // 与 MCP / 来源同一条：全局开关写的是**意图**，运行态由对账器维持 `意图 ∪ 租约`。
    // 原始 op 留出来给对账器与场景引擎直接落运行态 —— 包过一层的那条会再写一次意图、
    // 再排一次对账，自己跟自己打转。
    const rawSkillEnable = skillsService.ops['skill-enable']
    const rawSkillDisable = skillsService.ops['skill-disable']
    const rawSkillSetAll = skillsService.ops['skill-set-all']
    /**
     * 来源启停的**原始** op：包装层会在每次写后刷一遍技能目录，场景批量应用时
     * 一域要拨好几条 —— 逐条各刷一遍等于把每个会话的目录扫好几轮。这里绕过包装，
     * 由调用方在整批落地后统一刷一次（见 `applySkillSourceSwitches` 的末尾）。
     */
    const rawSkillSourceEnable = skillsService.ops['skill-source-enable']
    const rawSkillSourceDisable = skillsService.ops['skill-source-disable']
    /**
     * 把启停入参（`root` + 目录名或声明名）换成意图 / 覆盖那套键 `<root>/<声明名>`。
     *
     * 必须换：界面与模型工具传的是**目录名**，而注入段、场景档案、会话覆盖一律按声明名建键
     * —— 名字不同的那条技能如果按目录名记意图，那条意图永远读不到（面板仍显示关着，
     * 而对账器以为它开着）。扫描放在写之前，蹭的还是上一轮读到的缓存。
     */
    async function skillIntentKeys(items: ReadonlyArray<{ root?: unknown; name?: unknown }>): Promise<{ keys: string[]; unmapped: string[] }> {
      const wanted = items
        .map((it) => ({ root: String((it && it.root) || ''), name: String((it && it.name) || '') }))
        .filter((it) => it.root !== '' && it.name !== '')
      if (wanted.length === 0) return { keys: [], unmapped: [] }
      const byDir = new Map<string, string>()
      try {
        const r: any = await rawSkillState({})
        for (const root of ((r && r.data && r.data.roots) || []) as any[]) {
          const rootKey = String((root && root.key) || '')
          if (rootKey === '') continue
          for (const sk of ((root && root.skills) || []) as any[]) {
            const declared = String((sk && (sk.declaredName || sk.name)) || '')
            const dir = String((sk && sk.name) || '')
            if (declared === '' || dir === '') continue
            const key = rootKey + '/' + declared
            byDir.set(rootKey + '\u0000' + dir, key)
            if (!byDir.has(rootKey + '\u0000' + declared)) byDir.set(rootKey + '\u0000' + declared, key)
          }
        }
      } catch { /* 扫不到 → 下面按"映射不出来"处理：不写意图，如实告警 */ }
      const out: string[] = []
      const unmapped: string[] = []
      for (const it of wanted) {
        const key = byDir.get(it.root + '\u0000' + it.name)
        // **键归一化不变式**：读侧（目录 / 档案 / 覆盖 / 徽章计数）一律按
        // `<root>/<声明名>`，所以映射不出来时**不写**这条意图 —— 写一条读侧永远对不上的键，
        // 比不写更坏：用户点了关、对账器以为还开着，而界面上永远看不到那条记录。
        // 这条键也确实不该有意图：它要么已被删除，要么这一轮根本没扫到，对账器不会为它出决策。
        if (key === undefined) { unmapped.push(it.root + '/' + it.name); continue }
        if (!out.includes(key)) out.push(key)
      }
      if (unmapped.length > 0) {
        console.warn('[dsh-plugin-tool-management] 技能键没能归一化成 <root>/<声明名>，本次不写全局意图：' + unmapped.join('、'))
      }
      return { keys: out, unmapped }
    }
    /** 把「这些键没能归一化」并进 op 回执（回执形状不变，只多一条 warnings）。 */
    function withIntentWarnings(result: any, unmapped: readonly string[]): any {
      if (unmapped.length === 0 || !result || typeof result !== 'object') return result
      const note = '这些技能没能对上声明名，本次没有记下全局意图（下一轮对账会按运行态反推）：' + unmapped.join('、')
      const prev = Array.isArray(result.warnings) ? result.warnings : []
      return { ...result, warnings: [...prev, note] }
    }
    /**
     * 全局开关写完运行态之后补上意图，并把对账排进队列（运行态 := 意图 ∪ 租约）。
     *
     * 对账**不**采纳外部改动：这一轮的运行态就是我们刚写的，采纳会让别的会话的租约被
     * 误读成"用户全局开过"。
     */
    async function noteSkillIntent(keys: readonly string[], on: boolean): Promise<void> {
      if (keys.length === 0) return
      await intentStore.mutate((current) => withIntent(current, 'skills', keys, on ? 'on' : 'off'))
        .catch(() => { /* 写失败 → 对账从运行态反推 */ })
      void enqueueScopeReconcile().catch(() => { /* 下一轮写 op 还会对账 */ })
    }
    skillsService.ops['skill-enable'] = async (args: any) => {
      const { keys, unmapped } = await skillIntentKeys([{ root: args && args.root, name: args && args.name }])
      const r = await rawSkillEnable(args)
      if (r && r.ok === false) return r
      await noteSkillIntent(keys, true)
      return withIntentWarnings(r, unmapped)
    }
    skillsService.ops['skill-disable'] = async (args: any) => {
      const { keys, unmapped } = await skillIntentKeys([{ root: args && args.root, name: args && args.name }])
      const r = await rawSkillDisable(args)
      if (r && r.ok === false) return r
      await noteSkillIntent(keys, false)
      return withIntentWarnings(r, unmapped)
    }
    skillsService.ops['skill-set-all'] = async (args: any) => {
      const items: any[] = Array.isArray(args && args.items) ? args.items : []
      const { keys, unmapped } = await skillIntentKeys(items)
      const r = await rawSkillSetAll(args)
      if (r && r.ok === false) return r
      await noteSkillIntent(keys, (args && args.enabled) === true)
      return withIntentWarnings(r, unmapped)
    }

    const quickPromptsDir = hubPath('quick-prompts')
    const quickPromptsService = createQuickPromptsService({ dir: quickPromptsDir })
    const quickPromptOps = buildQuickPromptOps(quickPromptsService, {
      // 会话层：列表按本会话的生效值算 enabled（侧车一个字不动）。四层并值——
      // 覆盖 → 场景层 → 基线 → undefined（= 交给 op 自己的全局值）。
      flagFor: (sessionId) => flagResolverOfSession(sessionId, 'quickPrompts'),
    })

    // ── 会话层解析：四层并值的唯一出处 ─────────────────────────────
    //
    //   行情的四层：会话覆盖 → 场景层（在场景模式时按档案实时算）→ 基线（脱离时）→ 全局。
    //   前两层 + 基线在这里收口（`flagResolverOfSession` / `layeredFlag`），全局由各消费方
    //   （各域自己的 op / 目录）照旧兜底 —— 所以消费方拿到的签名统一是
    //   `(key) => boolean | undefined`，`undefined` = "这一层没话说，去问全局"。
    //
    //   为什么做成解析器而不是合并好的表：键全集在各消费方手里（技能清单 / 服务器行 /
    //   人设清单），在这里攒一份全集等于把"哪些算存在"抄第二遍。
    /** 某个会话进入的场景档案（同步；没进场景 / 档案读不到 → undefined）。 */
    function sceneArchiveOfSession(scope: SessionScope | undefined): SceneArchive | undefined {
      if (scope?.scene === undefined) return undefined
      return memoriesService.sceneArchiveOf(scope.scene)
    }
    /**
     * 某个会话某一格的**有效层**解析器（覆盖 → 场景层 → 基线）。没有任何一层时返回
     * `undefined` —— 快路径：调用方全按全局算，一个字节都不改。
     *
     * 必须带上显式覆盖：调用方（技能目录 / 人设目录 / 快捷提示词 / 列表工具）拿到的是
     * "这一格在本会话里是什么"，不是"覆盖之下的那一层"。少了它，会话里拨的开关只在
     * `effectiveDiff`（界面画勾）里生效，注入与工具看到的仍是下层值。
     */
    function flagResolverOfSession(sessionId: string | null, domain: ScopeFlagDomain): ((key: string) => boolean | undefined) | undefined {
      if (sessionId === null) return undefined
      const scope = scopeStore.scopeOfSync(scopeKeyForIdSync(sessionId))
      if (scope === undefined) return undefined
      if (scope.scene === undefined && scope.detached !== true && scope[domain] === undefined) return undefined
      const archive = sceneArchiveOfSession(scope)
      return (key: string) => effectiveLayerOf(scope, archive, domain, key)
    }
    /** 按 agent 取（注入侧专用）。 */
    function flagResolverOfAgent(agent: unknown, domain: ScopeFlagDomain): ((key: string) => boolean | undefined) | undefined {
      return flagResolverOfSession(scopeKeyForAgent(agent), domain)
    }
    /**
     * 本会话的**层指纹**（覆盖 + 进入的场景档案 + 意图代次）。注入目录的渲染缓存键吃它 ——
     * 少了它，同一个会话拨过开关之后目录不会重算（键里只有 sessionId 是不够的）；意图代次
     * 则覆盖"没有会话层、但全局意图改了"的那一半（技能来源的可见性依赖它）。
     */
    function layerKeyOfAgent(agent: unknown): string {
      const rev = 'i' + intentStore.revision()
      const sessionId = scopeKeyForAgent(agent)
      if (sessionId === null) return rev
      const scope = scopeStore.scopeOfSync(sessionId)
      if (scope === undefined) return rev
      return JSON.stringify([scope, sceneArchiveOfSession(scope) ?? null, rev])
    }

    /**
     * 某个会话的记忆域覆盖（带层语义）。**唯一**的一处转换：侧车形状 →
     * 记忆域要的那两项。
     *
     * 两个入口都走它 —— 注入域（同步，`text(agent)` 契约）与 `rules-list`（按 sessionId）。
     * 分开写两份转换就是给"注入看到 A、界面看到 B"留机会，而那种症状没有任何报错。
     *
     * 记忆**不走场景层**（档案里"哪些记忆进"由场景名 + 逐条开关决定，见 scope-overrides.ts
     * 文件头），但基线要铺（脱离时 = 创建时的逐条开关）。场景名走 `sessionScenePinOf`：
     * 进入的场景 → 基线里的场景（脱离时）→ 跟随全局。基线里记的是"创建时没有场景"时
     * 必须传 `null`（钉住没有场景），不能折成 undefined 去跟随**后来**才启用的全局场景。
     */
    const memoryScopeOfSession = (sessionId: string): MemoryScopeOverride | undefined => {
      // 工作区模式下，面板 / 斜杠菜单给的真实 sessionId 先折成作用域键（同步；cwd 见过才算）。
      const scopeId = scopeKeyForIdSync(sessionId)
      const scope = scopeStore.scopeOfSync(scopeId)
      if (scope === undefined) return undefined
      const scene = sessionScenePinOf(scope)
      const base = scope.detached === true ? scope.baseline?.flags?.memory : undefined
      const memory = base === undefined ? scope.memory : { ...base, ...(scope.memory ?? {}) }
      return {
        sessionId: scopeId,
        ...(scene === undefined ? {} : { scene }),
        ...(memory === undefined ? {} : { memory }),
      }
    }

    /**
     * 注入侧取本会话的记忆覆盖：**同步**，因为注入域的 `text(agent)` 是同步契约。
     * 取不到会话 id → `undefined` = 跟随全局（风险表最后一条）。
     */
    function memoryScopeOf(agent: unknown): MemoryScopeOverride | undefined {
      const sessionId = scopeKeyForAgent(agent)
      return sessionId === null ? undefined : memoryScopeOfSession(sessionId)
    }

    /**
     * 提示词冻结快照：**首见捕获**，内存先生效、异步落侧车。
     *
     * 为什么在注入器里捕获：插件拿不到宿主「会话创建」事件，只能在第一次看见这个会话时
     * 取当前 `~/.dsh/AGENTS.md`。对还没有快照的老会话，等价于「从现在起冻结」。
     *
     * 两处状态：
     *   - 侧车 `prompt.baseline` 是持久的那一份（跨重启、归档恢复都在）；
     *   - `pendingPromptBaselines` 是「已捕获但落盘还没成功」的那一份 —— 写盘失败不能让
     *     本进程里的冻结失效（失败只意味着重启后会重新捕获）。写成功就删掉。
     *
     * 捕获本身**不读用户覆盖**：不管这个会话有没有 content / presetId，快照都要落，
     * 否则用户清掉覆盖的那一刻会解冻到当时的全局文件（不是会话创建时的基线）。
     */
    const pendingPromptBaselines = new Map<string, string>()
    function persistPromptBaseline(sessionId: string, text: string): void {
      void scopeStore.mutate(sessionId, (cur) => {
        // 锁内再判一次：并发 / 上一个进程可能已经写过，绝不覆盖已有快照。
        if (cur?.prompt?.baseline !== undefined) return cur
        return {
          ...(cur === undefined ? {} : cur),
          prompt: { ...(cur?.prompt === undefined ? {} : cur.prompt), baseline: text },
        }
      }).then((res) => {
        if (res.ok) pendingPromptBaselines.delete(sessionId)
        // 失败不报警：下一轮注入会拿着 pending 再试；本进程内冻结照旧生效。
      }).catch(() => { /* 同上 */ })
    }
    /**
     * 取本会话的冻结快照；没有就**现在捕获**一份。`undefined` = 读文件失败（这一轮不捕获，
     * 注入退化为当前文件）。
     */
    function ensurePromptBaseline(sessionId: string): string | undefined {
      // 工作区模式下把真实 sessionId 折成作用域键：冻结快照按工作区存，工作区里第一个
      // 被注入的会话负责捕获。已经是 ws: 键的原样通过。
      const scopeId = scopeKeyForIdSync(sessionId)
      // 全局粒度 = 没有会话层，也就没有"这个会话出生时的 AGENTS.md"这回事：一个空键
      // 什么都存不下（`mutate('')` 会被合法键检查拒掉），继续往下走就是每轮一次注定
      // 失败的写盘。返回 undefined = 这一轮不冻结，与"读文件失败"同一条降级。
      if (scopeId === '') return undefined
      const stored = promptBaselineOf(scopeStore.scopeOfSync(scopeId))
      if (stored !== undefined) return stored
      const pending = pendingPromptBaselines.get(scopeId)
      if (pending !== undefined) {
        // 上次落盘没成功 → 再排一次（成功后从 pending 删除）。
        persistPromptBaseline(scopeId, pending)
        return pending
      }
      let text: string
      try { text = clampPromptBaseline(memoriesService.promptBaselineText()) } catch { return undefined }
      pendingPromptBaselines.set(scopeId, text)
      persistPromptBaseline(scopeId, text)
      return text
    }
    /**
     * 注入侧判据：本会话的快照与当前 `~/.dsh/AGENTS.md` 是否不一致（同步）。
     *
     * 首见那一轮先捕获、按「无差异」返回（快照就是这一版，官方照送）。之后文件怎么改，
     * 本会话都判有差异 → 拦官方、由插件送快照链。读文件失败按「无差异」处理 ——
     * 宁可让官方照旧、也不能在这一轮把两份都拦掉。
     */
    function promptBaselineDivergedOf(agent: unknown): boolean {
      const sessionId = scopeKeyForAgent(agent)
      if (sessionId === null) return false
      const baseline = ensurePromptBaseline(sessionId)
      let current: string
      try { current = memoriesService.promptBaselineText() } catch { return false }
      return promptBaselineDiffers(baseline, current)
    }

    /**
     * 注入侧取本会话的提示词作用域：`cwd` 定位项目指令链、`scene` 是生效场景
     * `override` 是会话级提示词覆盖、`baseline` 是冻结快照（第三轮）。
     *
     * 提示词**接管官方那条 AGENTS.md** 的三种情形：有覆盖、快照与当前文件不一致、本插件
     * 此前已为该会话送过提示词（接管持续）。接管时拦下 `agent-instructions`（仅本会话），
     * 由插件送用户级整份；首份带「Supersedes …」把已进历史的官方那份压下去。无接管时维持
     * 原口径：官方在送就让位（见 domain 注释）。
     *
     * 取不到会话 → `undefined`（= 不带项目链）。
     */
    function promptScopeOf(agent: unknown): PromptScopeOverride | undefined {
      const identity = sessionIdentityOf(agent)
      if (identity === null) return undefined
      // 子代理 / 侧聊继承所属用户会话的提示词作用域；工作区模式下再折到工作区键。
      // cwd 仍用会话自己的 —— 项目指令链按它所在的工作目录往上找，与父会话通常相同。
      //
      // `null` = 全局粒度（没有会话层），**不能**退回 `identity.sessionId`：切到「全部全局」
      // 之后侧车里那些旧会话记录仍然留着（`switchMode` 刻意保留，切回「按对话」还要用），
      // 退回它等于让它们继续生效 —— 同一个全局设置下，这个对话按它当年钉的场景 / 覆盖走、
      // 别的对话按全局走。判定侧（`promptOverrideActiveOf` / `promptBaselineDivergedOf`）
      // 在 `null` 时一律按"没有覆盖"算，这里若还读旧记录，两边就自相矛盾：判定说不接管，
      // 正文却是按覆盖算出来的。
      const key = scopeKeyForAgent(agent)
      const scope = key === null ? undefined : scopeStore.scopeOfSync(key)
      const scene = sessionScenePinOf(scope)
      const override = promptOverrideOf(scope)
      // 首见捕获也在这里兜一次：`promptBaselineDiverged` 与域取数各自独立，
      // 任何一个先跑到都能保证快照落下来。（`key === null` 时不捕获：全局档没有
      // "这个对话出生时的 AGENTS.md"这回事，见 `ensurePromptBaseline`。）
      const baseline = key === null ? undefined : ensurePromptBaseline(key)
      if (identity.cwd === undefined && scene === undefined && override === undefined && baseline === undefined) return undefined
      return {
        ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
        ...(scene === undefined ? {} : { scene }),
        ...(override === undefined ? {} : { override }),
        ...(baseline === undefined ? {} : { baseline }),
      }
    }

    /** 本会话有没有**用户写的**提示词覆盖（注入侧同步判据：拦官方 kind / 决定 replacing）。 */
    function promptOverrideActiveOf(agent: unknown): boolean {
      const sessionId = scopeKeyForAgent(agent)
      return sessionId === null ? false : hasPromptOverride(scopeStore.scopeOfSync(sessionId))
    }

    /**
     * 按会话 id 取提示词作用域（`scope-get` 的编辑预填用）。
     *
     * 没有 agent，取不到 `cwd` —— 预填的是**用户级那一槽**（会话覆盖 / 场景预设 / 快照），
     * 项目指令链本来就不在这里编辑，不影响写回（写回只存用户级正文）。
     * 快照用侧车那份 / 内存里待落盘的那份，**不在这里新捕获**（界面读不该改状态）。
     */
    function promptScopeOfSession(sessionId: string): PromptScopeOverride | undefined {
      const scopeId = scopeKeyForIdSync(sessionId)
      const scope = scopeStore.scopeOfSync(scopeId)
      const scene = sessionScenePinOf(scope)
      const override = promptOverrideOf(scope)
      const baseline = promptBaselineOf(scope) ?? pendingPromptBaselines.get(scopeId)
      if (scene === undefined && override === undefined && baseline === undefined) return undefined
      return {
        ...(scene === undefined ? {} : { scene }),
        ...(override === undefined ? {} : { override }),
        ...(baseline === undefined ? {} : { baseline }),
      }
    }

    /**
     * 某台 MCP 服务器在某个会话里的解析：**注入段 / 工具表 / 执行守卫三处同源**。
     *
     *   有效层（覆盖 → 场景层 → 基线）→ 全局意图（on / off / blocked）→ 运行态兜底。
     *
     * `visible === undefined` 只在"意图还没落盘、会话层也没话说"时出现（升级首轮 / 新服务器），
     * 调用方按运行态处理。`claim` = 全局意图不是 on，但这个会话要它（租约的来源）。
     */
    function mcpServerViewOf(sessionId: string | null, serverName: string): ReturnType<typeof resolveResource> {
      const intent = intentOf(intentStore.snapshot(), 'mcp', serverName)
      const scope = sessionId === null ? undefined : scopeStore.scopeOfSync(scopeKeyForIdSync(sessionId))
      const archive = sceneArchiveOfSession(scope)
      const lower = effectiveLayerOf(scope, archive, 'mcp', serverName)
      return resolveResource(intent, lower)
    }

    /** 某个技能来源在某个会话里的解析（与 `mcpServerViewOf` 同一套判据）。 */
    function skillSourceViewOf(sessionId: string | null, rootKey: string): ReturnType<typeof resolveResource> {
      const intent = intentOf(intentStore.snapshot(), 'skillSources', rootKey)
      const scope = sessionId === null ? undefined : scopeStore.scopeOfSync(scopeKeyForIdSync(sessionId))
      const archive = sceneArchiveOfSession(scope)
      const lower = effectiveLayerOf(scope, archive, 'skillSources', rootKey)
      return resolveResource(intent, lower)
    }

    /**
     * 单条技能在某个会话里的解析（与来源 / 服务器同一套判据）。
     *
     * 为什么单条技能也要走意图：那张策略表是**机器级**的，租约把它拉起来之后
     * `skill-state` 回的是运行态，直接读就等于"某个对话开了一条技能，别的对话也看得见"
     * —— 与服务器那格修过的串味同一条路径。`visible === undefined`（没有意图、会话层也没
     * 说话）时调用方按运行态兜底。
     */
    function skillViewOf(sessionId: string | null, key: string): ReturnType<typeof resolveResource> {
      const intent = intentOf(intentStore.snapshot(), 'skills', key)
      const scope = sessionId === null ? undefined : scopeStore.scopeOfSync(scopeKeyForIdSync(sessionId))
      const archive = sceneArchiveOfSession(scope)
      const lower = effectiveLayerOf(scope, archive, 'skills', key)
      return resolveResource(intent, lower)
    }

    /**
     * 此刻是否有技能 / 来源**只靠别的会话的租约**在跑（同步）。
     *
     * 为什么需要它：拦官方技能目录的判据本来是 `skillCatalog.delta()`，而那份差异要读
     * **本会话的目录数据** —— 它是异步取的（`skill-state` 冷启实测 3.4s），新对话第一轮
     * 常常还没到，于是差异算成空、官方那份照旧到达模型。官方那份列的是**运行态**，其中就
     * 包含别的会话靠租约开着的技能 —— 用户实测：新建一个对话、什么都没设置，上下文里却出现
     * 了别的对话开的三条技能。租约表是对账器维护的同步视图，判"这个会话该不该看到官方那份"
     * 不需要等目录数据。
     *
     * 认领者名单里放的是**真实会话 id**（清单读不到时才退成作用域键），所以两个都比对。
     * 本会话自己认领的那条不算差异：官方列出它来对这个会话也是对的。
     */
    function skillCatalogHasForeignLease(agent: unknown): boolean {
      const mine: string[] = []
      const sid = sessionIdOf(agent)
      if (sid !== null) mine.push(sid)
      const scopeKey = scopeKeyForAgent(agent)
      if (scopeKey !== null && !mine.includes(scopeKey)) mine.push(scopeKey)
      if (mine.length === 0) return false
      const claimedByMe = (list: readonly string[]): boolean => list.some((id) => mine.includes(id))
      for (const list of skillLeasesSync.values()) if (!claimedByMe(list)) return true
      for (const list of sourceLeasesSync.values()) if (!claimedByMe(list)) return true
      return false
    }

    /**
     * 会话 MCP 判定的**唯一快照**：执行守卫（`sessionMcpVerdictSync`，同步）与
     * 可见性限制层（`sessionMcpOverlayOf`，异步）共用这一份。
     *
     * 为什么必须共用（守卫与可见性一致不变式）：两处对同一个 `(agent, server)` 必须得出
     * 同一个 verdict —— 否则模型「看得见却调不动」或「看不见却调得动」，两种症状都没有报错，
     * 只能靠人肉撞见。三样东西必须同源：
     *   · 会话覆盖：`scopeStore.scopeOfSync`（同一个 TTL 缓存）；
     *   · 全局意图：`intentStore.snapshot`（同一个快照）；
     *   · 工具名切分的候选 serverName 集合：**只有**这个函数算得出来。
     *
     * 候选集合只用**同步可读**的那几张表（覆盖 / 基线 / 档案 / 意图键）。这不是偷懒：
     * 会话层要判的每一台服务器，必然出现在这四张表之一（要么有意图记录，要么有覆盖键），
     * 而 `configured` / 停用表 / 已知工具缓存都是异步读盘 —— 守卫在热路径上（同步契约）
     * 拿不到它们，两路各用一套就等于把「切分结论可能不同」重新引回来。
     * 认不出的名字由 `splitMcpToolName` 按最后一个 `__` 兜底（与显示侧同一口径），
     * 名字本身含 `__` 的歧义由 `ambiguousServerNames` 另行上报。
     */
    function sessionMcpContextOf(agent: unknown): {
      sessionId: string | null
      scope: SessionScope | undefined
      archive: SceneArchive | undefined
      candidates: Set<string>
    } {
      const sessionId = scopeKeyForAgent(agent)
      const scope = sessionId === null ? undefined : scopeStore.scopeOfSync(sessionId)
      const archive = sceneArchiveOfSession(scope)
      const candidates = serverNameCandidates(
        scope?.mcp, mcpToolServerSegments(scope?.mcpTools),
        scope?.baseline?.flags?.mcp, mcpToolServerSegments(scope?.baseline?.flags?.mcpTools),
        archive?.mcp,
        Object.keys(intentStore.snapshot().mcp),
      )
      return { sessionId, scope, archive, candidates }
    }

    /**
     * 一个已切开的工具全名在本会话里的 verdict：`allow` / `deny` / `undefined`（交给全局）。
     *
     * **判据只有这一份**（守卫与可见性层都调它）：服务器可见性（三处同源）+ 工具格 / 服务器格
     * 的有效层。`allow` 的语义在两处相同 —— 越过全局停用表（本会话显式开着）。
     */
    function mcpVerdictOf(
      ctx: ReturnType<typeof sessionMcpContextOf>,
      parts: McpToolNameParts,
    ): 'allow' | 'deny' | undefined {
      const view = mcpServerViewOf(ctx.sessionId, parts.server)
      if (view.visible === false) return 'deny'
      const toolVal = effectiveLayerOf(ctx.scope, ctx.archive, 'mcpTools', parts.server + '/' + parts.tool)
      if (toolVal === false) return 'deny'
      if (toolVal === true) return 'allow'
      if (effectiveLayerOf(ctx.scope, ctx.archive, 'mcp', parts.server) === true) return 'allow'
      return undefined
    }

    /**
     * 本会话的 MCP 覆盖**同步判定**（执行守卫用）：`allow` / `deny` / `undefined`
     * （undefined = 交给全局守卫）。
     *
     * 判据：服务器可见性（三处同源）+ `(server, tool)` 两格的有效层：
     *   · 服务器看不到（本会话关掉 / 场景没勾 / 全局意图 off 且本会话没认领 / blocked）→ deny；
     *   · 工具格或服务器格显式"关" → deny；显式"开" → allow（越过全局停用表）；
     *   · 都没话说 → undefined（全局守卫照旧守停用表与工具表）。
     * 名字切不开时按 undefined（少一层保险，不会多放行）。
     *
     * 失败方向（与 `sessionMcpOverlayOf` 同向，见那里的说明）：本函数体包在调用方的
     * try/catch 里，抛错 = 不拦 —— 会话层是叠在全局之上的视图，读一次侧车失手不该让模型
     * 在对话中途丢掉工具；全局守卫与停用表照旧生效。
     */
    function sessionMcpVerdictSync(agent: unknown, toolName: string): 'allow' | 'deny' | undefined {
      const ctx = sessionMcpContextOf(agent)
      const parts = toolKeyParts(toolName, ctx.candidates)
      if (parts === null) return undefined
      return mcpVerdictOf(ctx, parts)
    }

    /**
     * 本会话的 MCP 可见性覆盖（restrict 层用）：在**此刻注册着的**工具全名上算
     * `{ allow, deny }`（名单语义见 mcp/manager.ts 的 deps 注释）。
     *
     * 没有会话层也要算：全局意图 off 的服务器可能是**别的会话**的租约在跑，它的工具此刻
     * 注册在宿主里 —— 不隐藏的话，没有覆盖的新会话照样看得到（正是这次要修的串味）。
     *
     * 失败方向：**与执行守卫同向 = fail-open（不额外限制）**。理由：这一层是叠在全局规则
     * 之上的会话视图，`tools.schemas()` 读一次失败就整层 deny 会让每个对话在那一瞬间丢掉
     * 全部工具（比"本会话没藏住"难看得多），而且下一轮 `tools/change` 会重算回来。
     * 守卫那边同一条：算不出来就不拦，全局停用表 / 工具表照旧。两处同向，才不会出现
     * 「看不见却调得动」。
     */
    async function sessionMcpOverlayOf(agent: unknown): Promise<{ allow: string[]; deny: string[] }> {
      const empty = { allow: [] as string[], deny: [] as string[] }
      const ctx = sessionMcpContextOf(agent)
      const intentSnapshot = intentStore.snapshot()
      const hasGlobalFilter = Object.values(intentSnapshot.mcp).some((state) => state === 'off' || state === 'blocked')
      const hasSessionLayer = ctx.scope !== undefined &&
        (ctx.scope.scene !== undefined || ctx.scope.detached === true || ctx.scope.mcp !== undefined || ctx.scope.mcpTools !== undefined)
      if (!hasGlobalFilter && !hasSessionLayer) return empty
      let schemas: any[] = []
      try { schemas = await tools.schemas() } catch { return empty }
      if (schemas.length === 0) return empty
      const allow: string[] = []
      const deny: string[] = []
      for (const s of schemas) {
        const name = String((s && s.name) || '')
        const parts = toolKeyParts(name, ctx.candidates)
        if (parts === null) continue
        const verdict = mcpVerdictOf(ctx, parts)
        if (verdict === 'deny') deny.push(name)
        else if (verdict === 'allow') allow.push(name)
      }
      return { allow, deny }
    }

    /**
     * 读一次侧车 + 会话清单，按给定键集合扫一遍七域认领（`scanSessionClaims`）。
     *
     * 展示侧（徽章 / 下拉条数）与执行侧（对账租约）现在都走这一趟 —— 扫描逻辑只此一份。
     *
     * @param strict 用**严格读**取侧车（`readStrict`：文件在却读不动 / 解析不了就抛）。
     *   `readable === false` 表示没读出来，而空侧车在痕迹闸门眼里等于"这一格从没被会话动过"
     *   —— 与"宁可少采纳，不误提升"正好相反，所以调用方必须把读失败当成**处处有痕迹**处理。
     */
    async function scanClaimsOnce(targets: ClaimScanTargets, strict = false): Promise<{ scan: ClaimScanResult; readable: boolean }> {
      let sessions: Record<string, SessionScope> = {}
      let readable = false
      try {
        sessions = (strict ? await scopeStore.readStrict() : await scopeStore.read()).sessions
        readable = true
      } catch { /* 读不到 → 空表；保守口径见 `strict` 的说明 */ }
      let rows: ScopeSessionRow[] = []
      try { rows = await scopeSessionRows() } catch { rows = [] }
      try {
        return { scan: scanSessionClaims({ sessions, rows, mode: scopeMode(), archiveOf: sceneArchiveOfSession, targets }), readable }
      } catch {
        // 装饰性读数：算不出来不该让列表 op / 面板整份失败（下一轮再算）。
        // `readable: false` 让它与"侧车读不出来"同档 —— 对账那边必须保守（不采纳运行态）。
        return { scan: scanSessionClaims({ sessions: {}, rows: [], mode: scopeMode(), archiveOf: () => undefined, targets }), readable: false }
      }
    }

    /**
     * 本会话生效的模型工具表关停名单。
     *
     * 每个对话一份：本对话自己的整份名单 → 创建时抄的基线 → 实时全局（老会话没有基线时
     * 的兜底）。全局只给新对话当默认模板；已有对话不会再跟着全局变。
     */
    function toolTableHiddenForSession(sessionId: string | null): ReadonlySet<string> {
      const globalHidden = toolTableHidden()
      if (sessionId === null) return globalHidden
      const scope = scopeStore.scopeOfSync(scopeKeyForIdSync(sessionId))
      if (scope === undefined) return globalHidden
      if (scope.toolTableHidden === undefined && scope.baseline?.toolTableHidden === undefined) return globalHidden
      return new Set(sessionToolTableHidden(scope, [...globalHidden]))
    }

    /**
     * 本会话相对全局的工具表差异（restrict 层用）：`allow` = 本会话重新打开、
     * `deny` = 本会话关掉。与 MCP 的 overlay 同一条合并路径（见 mcp/manager.ts）。
     */
    function sessionToolTableOverlayOf(agent: unknown): { allow: string[]; deny: string[] } {
      const sessionId = scopeKeyForAgent(agent)
      if (sessionId === null) return { allow: [], deny: [] }
      const scope = scopeStore.scopeOfSync(sessionId)
      if (scope === undefined) return { allow: [], deny: [] }
      if (scope.toolTableHidden === undefined && scope.baseline?.toolTableHidden === undefined) {
        return { allow: [], deny: [] }
      }
      const effective = new Set(sessionToolTableHidden(scope, [...toolTableHidden()]))
      const globalHidden = toolTableHidden()
      const allow: string[] = []
      const deny: string[] = []
      // 只算本插件注册过的工具：MCP 工具走各自的 mcp / mcpTools 覆盖，不混进这一域。
      for (const name of toolTableSizes.keys()) {
        const hiddenHere = effective.has(name)
        const hiddenGlobal = globalHidden.has(name)
        if (!hiddenHere && hiddenGlobal) allow.push(name)
        else if (hiddenHere && !hiddenGlobal) deny.push(name)
      }
      return { allow, deny }
    }

    /**
     * 某台服务器在本会话里是不是**隐藏**的（状态段 / `mcp_manager_list` 逐行问）。
     * 场景模式里"没勾的服务器"算隐藏；全局意图 off（不论连接是不是别的会话的租约）也算。
     */
    function sessionServerHiddenOf(agent: unknown, serverName: string): boolean {
      return mcpServerViewOf(scopeKeyForAgent(agent), serverName).visible === false
    }

    // ---------- rules（规则/记忆，v0.4）----------
    // 记忆真源 $DSH_HOME/tool-management/memories/<场景>/<name>.md（仅用户级，D1）。
    // **场景是显式记录**（memories-index.json 的 scenes 切片）：含保留场景 `global`（界面「全局」，
    // 其记忆注入任何对话），空场景也合法存在——不再是"恰好有这个目录名"的隐式约定。
    // 单投影 = 活动场景记忆 → 上下文注入（自动在场，模型无需调用任何工具；见下方注入通道）。
    // 原"始终层写 ~/.dsh/AGENTS.md"已下线：公共基线由 _shared/ 承担。
    // 旧的 $DSH_HOME/scene-memory 与 $DSH_HOME/rules 由服务在首次读盘前搬入本目录。
    // memoriesRoot / memoriesStateDir / memoriesScenesDir 仅测试注入，生产留空由服务按 DSH_HOME 解析。
    const memoriesService = createMemoriesService(ctx, {
      memoriesRoot: String((config as { memoriesRoot?: unknown } | undefined)?.memoriesRoot || ''),
      stateDir: String((config as { memoriesStateDir?: unknown } | undefined)?.memoriesStateDir || ''),
      scenesDir: String((config as { memoriesScenesDir?: unknown } | undefined)?.memoriesScenesDir || ''),
      // 技能回收站根目录：只给回收站「详情」（`trash-preview`）读技能条目用。路径的唯一定义
      // 在 skills/skill-roots.ts（`trashRootPath()`），这里原样转手，不在记忆域重算一遍 ——
      // 重算就是第二个真相源，改一处忘一处时详情会指向一个空目录。
      skillsTrashDir: trashRootPath(),
      // 场景记忆段预算（字节），默认 131072（= DEFAULT_MAX_BYTES，128 KiB）；仅用于测试与特殊部署调优。
      ...(Number.isFinite(Number((config as { rulesMaxBytes?: unknown } | undefined)?.rulesMaxBytes))
        ? { maxBytes: Number((config as { rulesMaxBytes?: unknown }).rulesMaxBytes) }
        : {}),
      // 全局 AGENTS.md 的**宿主实际读的那一份**（profile home 下，与上面 `getGlobalAgentsMdPath`
      // 同源）。`readGlobalAgentsMdSync` 的去重/兜底必须读它 —— `resolveDshHome()` 是另一条
      // 独立来源（见 `ensurePaths` 的注释「不合并是有意的」），两边不同时会取到另一个文件、
      // 去重永远不相等 → 同一份预设正文注入两遍。
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
      // 会话层覆盖：记忆域按会话投影场景与逐条开关。侧车归 scopeStore 管
      // （它有自己的 TTL 缓存），这里只转手 —— 记忆域不引第二份读取点。
      scopeOverrideOf: memoryScopeOfSession,
    })
    // 场景记忆段的注册/生命周期由下面的注入通道统一管（memoriesService.memoryText / promptText）。

    // ---------- 场景档案引擎----------
    // deps 把既有写通道（MCP 单工具启停 / 技能启停）注入引擎；引擎自身串行，
    // 状态机与纯逻辑在 ./memories/archive*.ts。mcpmToolEnabled / readDisabledTools
    // 为函数声明（提升），此处引用安全。
    // MCP 工具全名 → `{ server, tool }`。**切分规则只有一套**：`splitMcpToolName`
    // （`host-names.ts`），与执行侧守卫 `mcp.isToolDisabled` 走的是同一个函数。
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
      /** 键（`<root>/<声明名>`）→ core 启停 op 要的条目名（目录 / 文件名）。 */
      entryNames: Record<string, string>
    }> {
      const r: any = await rawSkillState({})
      const states: Record<string, boolean> = {}
      const all: Record<string, boolean> = {}
      const shadowed = new Set<string>()
      const unloadable = new Set<string>()
      const entryNames: Record<string, string> = {}
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
          // core 按**条目名**（目录 / 文件名）解析，声明名与它可以不同：传错会得到
          // 「技能不存在: <声明名>」（真机，pdf-skill / pdf-reader）。
          entryNames[key] = String(sk.name || name)
        }
      }
      return { states, shadowed, all, unloadable, entryNames }
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
    /**
     * 一份工具表方案 → 关停名单。用户存的方案**优先**：万一有人把方案起名叫
     * 'factory-default'，他要的是自己那份。方案不存在返回 null。
     *
     * 全局进场景与**本对话**进场景共用这一份：两处各写一遍，某天改名规则一改就会分叉。
     */
    const toolTablePresetHidden = async (name: string): Promise<string[] | null> => {
      const s = await readToolTableSettings()
      const hit = s.presets.filter((p) => p.name === name)[0]
      if (hit) return [...hit.hidden]
      return name === FACTORY_TOOL_TABLE_PRESET ? [...DEFAULT_HIDDEN_TOOLS] : null
    }

    const applyToolTableHiddenNow = async (hidden: string[]) => {
      // 与 `tool-table` op 写分支同一条路径、同一顺序：落盘 → 重排可见性 → 两个目录重算。
      // 绕开这套顺序就会留下「名单已经改了、工具下一轮还发给模型」这种最难查的状态。
      // **锁内读-改-写**：presets 必须取锁内最新值，否则并发的存方案会被这次整表写覆盖。
      const saved = await mutateToolTableSettings((current) => ({
        hidden: normalizeToolTableSettings({ hidden }).hidden.filter((name) => toolTableSizes.has(name)),
        presets: current.presets,
      }))
      if (!saved.ok) throw new Error(saved.error || toolTableWriteError())
      mcp.scheduleToolRestrictions()
      // 目录重算不挡写入回执（与技能写 op 同一条）：保留旧值的 SWR 让下一拍注入
      // 不会读到空，晚一步到新清单是可接受的代价。场景进入会走到这里，等它等于多等一轮全量扫描。
      scheduleSkillCatalogRefresh()
      void subagentCatalog.refresh().catch(() => { /* 同上 */ })
    }

    // ── 场景生命周期 → 会话覆盖的同步────────────────────────────
    // 场景改名 / 删除 / 改绑工具表都发生在**场景**这一层，而停在里面的会话各有一份
    // `scope.scene` / `toolTableHidden`。这三件事以前没人通知会话：
    //   · 删除：会话停在"幽灵场景"，所有域静默退回全局、记忆注入还漏掉全局场景；
    //   · 改名：会话指向旧名；下次新建同名场景会被**自动进入**；
    //   · 改绑工具表：已经进来的会话一直按旧名单（其余域是读档案实时算的）。
    // 三处都做同一件事：在写锁内一次改完所有会话，再让可见性 / 目录 / 对账跟上。

    /** 场景改名后把会话里的场景名与记忆键换到新名。 */
    async function syncSessionsForSceneRename(from: string, to: string): Promise<void> {
      if (from === '' || to === '' || from === to) return
      try {
        const res = await scopeStore.mutateAll((scope) => {
          const r = renameSceneInScope(scope, from, to)
          return r.changed ? r.scope : scope
        })
        if (!res.ok) {
          ctx.logger?.warn?.('场景改名后的会话同步失败：' + res.error)
        }
      } catch (e) {
        ctx.logger?.warn?.('场景改名后的会话同步失败：' + message(e))
      }
    }

    /** 场景删除后让停在里面的会话退出场景，并清掉指向该场景记忆的覆盖。 */
    async function syncSessionsForSceneRemoval(name: string): Promise<void> {
      if (name === '') return
      try {
        const res = await scopeStore.mutateAll((scope) => {
          const r = removeSceneInScope(scope, name)
          return r.changed ? r.scope : scope
        })
        if (!res.ok) {
          ctx.logger?.warn?.('场景删除后的会话同步失败：' + res.error)
          return
        }
        if (res.changed === 0) return
        // 会话的场景层被清掉 = MCP / 技能 / 人设的可见集合可能变了；工具表也可能回到基线。
        mcp.scheduleToolRestrictions()
        scheduleSkillCatalogRefresh()
        void subagentCatalog.refresh().catch(() => { /* 同上 */ })
        // 认领可能跟着场景一起消失：最后一个租约用完的资源要停。
        void enqueueScopeReconcile({ adoptExternal: false }).catch(() => { /* 下一轮写 op 还会对账 */ })
      } catch (e) {
        ctx.logger?.warn?.('场景删除后的会话同步失败：' + message(e))
      }
    }

    /** 场景改绑工具表方案后，把新名单同步到停在这个场景里的会话。`presetName` 为空 = 保持现状。 */
    async function syncSessionsForSceneToolTable(scene: string, presetName: string): Promise<void> {
      if (scene === '' || presetName === '') return
      try {
        let hidden: string[] | null = null
        try { hidden = await toolTablePresetHidden(presetName) } catch { hidden = null }
        // 方案已不存在：保持现状（与场景表单「悬空绑定不硬失败」同口径）。
        if (hidden === null) return
        const filtered = hidden.filter((name) => toolTableSizes.has(name))
        const res = await scopeStore.mutateAll((scope) => {
          const r = setSceneToolTableInScope(scope, scene, filtered)
          return r.changed ? r.scope : scope
        })
        if (!res.ok) {
          ctx.logger?.warn?.('场景工具表方案同步到会话失败：' + res.error)
          return
        }
        if (res.changed === 0) return
        mcp.scheduleToolRestrictions()
        scheduleSkillCatalogRefresh()
        void subagentCatalog.refresh().catch(() => { /* 同上 */ })
      } catch (e) {
        ctx.logger?.warn?.('场景工具表方案同步到会话失败：' + message(e))
      }
    }

    /**
     * 场景应用**要停**一个资源之前的租约保护。
     *
     * 判据是"还有没有会话在认领"，不是对账器缓存里的 `*LeasesSync`：那张表只收
     * 「意图已经不是 on」的租约，而全局场景要停的常常正是**意图还开着**的资源 ——
     * 先写 off 再查旧表，必然查不到认领，于是停掉 → 对账按 claims 重新拉起，
     * 一次换场景就是一次闪断。这里直接读会话认领（与徽章 / 对账同一份扫描）。
     *
     * 读不到就**保护**（不真停）：宁可多留一个租约，也不能把正在用的会话的连接停掉。
     */
    async function claimedInSessions(
      domain: 'mcp' | 'skillSources' | 'skills',
      keys: readonly string[],
    ): Promise<{ claimed: Set<string>; readable: boolean }> {
      const unique = [...new Set(keys)]
      if (unique.length === 0) return { claimed: new Set<string>(), readable: true }
      try {
        const { scan, readable } = await scanClaimsOnce({ [domain]: unique })
        const claimed = new Set<string>()
        for (const key of unique) {
          if ((scan.claims[domain].get(key) || []).length > 0) claimed.add(key)
        }
        return { claimed, readable }
      } catch {
        return { claimed: new Set<string>(), readable: false }
      }
    }

    /**
     * 场景应用写全局意图：`blocked`（统一关闭）是比场景更强的用户要求，场景不得覆盖它
     * —— 只有全局意图开关（`scope-intent-set`）能解除。不挡的话，进一次包含这台服务器 /
     * 这条技能的场景，就会把「统一关闭」悄悄降级成 off，之后任何会话的租约都能把它拉起来。
     */
    function withSceneIntent(current: ScopeIntent, domain: IntentDomain, key: string, state: IntentState): ScopeIntent {
      if (intentOf(current, domain, key) === 'blocked') return current
      return withIntent(current, domain, [key], state)
    }

    const archiveService = createArchiveEngine({
      // 引擎每应用/还原一次整套档案记一条流水（source='engine'，见 ./audit-log.ts）。
      // 记在边界这一层而不是往五个 apply* 里散着写：一条流水说的是「引擎动了整个环境」，
      // 与同一次进入里面板/模型那条记录天然按秒分组显示。
      audit: (op: string, target: string) => recordAudit({ ts: Date.now(), op, target: target || AUDIT_TARGET_CONFIG, source: 'engine' }),
      // ── 模型工具表：场景可以绑一份方案，进场景整体换成那一份 ──
      currentToolTableHidden: async () => [...(await readToolTableSettings()).hidden],
      toolTablePresetHidden,
      applyToolTableHidden: applyToolTableHiddenNow,
      loadSlice: async () => ({ ...(await memoriesService.readArchiveSlice()) }),
      // `fields` 必须原样透传：它决定"本次只写哪几片"，漏传就会把没提到的切片一并覆盖掉。
      saveSlice: (slice, fields) => memoriesService.patchIndex(slice, fields),
      saveArchive: (scene, archive) => memoriesService.saveArchive(scene, archive),
      // 与 `serverKnownTools` 用同一个出口：都是「补丁里配了哪些 serverName」。
      // 早先这里走 `mcpmListView()` —— 那份会顺带枚举工具 schema 并回写「已知工具」缓存，
      // 而档案引擎只要名字。
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
        // 来自界面勾选、缓存键来自上一次切分，单靠它们会锁死错误结论。
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
      applyMcpEntries: async (entries: Record<string, string[]>, reason: 'scene-apply' | 'scene-restore') => {
        await mcp.writeDisabledTools(entries, { reason })
      },
      knownSkillKeys: async () => new Set(Object.keys(await skillStates())),
      // 档案保存校验用：被同名覆盖的副本与结构不完整的技能都不算「可勾选」（见 selectableSkillKeys）。
      selectableSkillKeys,
      // 快照只取**真实生效**的条目（不含被同名覆盖的副本）——副本不参与模式应用，
      // 退出回放时也不该去动它们，否则会改写用户对副本的显式策略记录。
      currentSkills: async () => (await skillScan()).states,
      applySkills: async (target: Record<string, boolean>) => {
        // 与 MCP / 来源同一条：场景引擎改的是**全局定义** → 先写意图，再落运行态
        // （运行态恒为 `意图 ∪ 租约`，只改策略表的话下一轮对账会按旧意图改回来）。
        //
        // 四道过滤，缺一不可：
        //  1. 被同名覆盖的副本直接跳过——它们本来就不生效，写策略只会污染用户的记录。
        //  2. 结构不完整的技能也跳过——core 对它们一律拒绝启停（error.skill.notLoadable），
        //     不跳过就会抛成"应用失败"，**整个场景进不去**（老档案里的残留键能踩到）。
        //  3. **已经不存在的技能也跳过**（用户反馈「启动的场景里有被删除的内容，
        //     就导致没办法退出」）：快照 / 档案里记的是"进场景那一刻还在"的键，场景期间那条
        //     技能被删掉之后，退出时按快照回放必然报 `技能不存在`，于是整次退出被这一条打断、
        //     mode 停在原地 —— 用户被困在场景里。没有可写的对象，跳过才是对的。
        //  4. **生效值已经是目标的技能不再写**。写的是显式记录，而目标是生效状态，两者不等价：
        //     对已经停用的技能再 disable 一次，只是把"没有记录"固化成"显式停用"，
        //     场景模式进出一次就会改写 state.json。意图那一格同口径。
        const { states, shadowed, unloadable, entryNames } = await skillScan()
        const intentSnap = intentStore.snapshot()
        /** 全局「统一关闭」的技能：场景不得覆盖（见 `withSceneIntent`），物理启停也一并跳过。 */
        const blocked = new Set<string>()
        const planned: Array<{ key: string; on: boolean; intentChanged: boolean }> = []
        const skipped: string[] = []
        for (const [key, on] of Object.entries(target)) {
          const i = key.indexOf('/')
          if (i <= 0) throw new Error(`技能 key 不合法: ${key}`)
          // 被同名覆盖的副本跳过（它本来就不生效，写策略只会污染用户的记录）。
          if (shadowed.has(key)) continue
          // 结构不完整的技能跳过：core 对它们**一律拒绝启停**（error.skill.notLoadable），
          // 继续往下走会抛成"应用失败"，**整个场景就进不去了**（老档案里的残留键能踩到）。
          if (unloadable.has(key)) continue
          // 这次扫描里根本没有这个键 = 技能已被删除（或所在目录已消失）：没有可写的对象。
          if (!(key in states)) { skipped.push(`${key}（已不存在）`); continue }
          // 全局统一关闭压过场景（与 `scope-set` 拒写「开」同一条）：既不改意图也不动策略表。
          // 技能还要看所在来源：来源被统一关闭时，技能级开关开着也加载不到（来源闸恒生效）。
          if (intentOf(intentSnap, 'skills', key) === 'blocked' ||
            intentOf(intentSnap, 'skillSources', key.slice(0, i)) === 'blocked') {
            blocked.add(key)
            if (on) skipped.push(`${key}（已在全局「统一关闭」）`)
            continue
          }
          const wanted: IntentState = on ? 'on' : 'off'
          const cur = intentOf(intentSnap, 'skills', key)
          // 没有意见且生效值已是目标 → 这一格什么都不写（第 4 道过滤）。
          if (cur === undefined && states[key] === on) continue
          planned.push({ key, on, intentChanged: cur !== wanted })
        }
        const writes = planned.filter((p) => p.intentChanged)
        if (writes.length > 0) {
          await intentStore.mutate((current) => {
            let next = current
            for (const s of writes) next = withSceneIntent(next, 'skills', s.key, s.on ? 'on' : 'off')
            return next
          }).catch(() => { /* 写失败 → 对账会从运行态反推；不拦场景应用 */ })
        }
        // 租约保护：判据改成**会话认领**，不再只看 `skillLeasesSync`
        // —— 后者只收「意图已不是 on」的租约，而场景刚要停的常常是意图还开着、被某个
        // 会话显式开着的那一条。意图上面已经写成 off，这里若是租约就只让对账维持运行。
        const stoppingSkills = planned.filter((p) => !p.on && states[p.key] === true).map((p) => p.key)
        const skillClaims = await claimedInSessions('skills', stoppingSkills)
        for (const p of planned) {
          if (states[p.key] === p.on) continue
          const i = p.key.indexOf('/')
          // 不真停：策略表是进程级的，停了那个会话当轮就加载不到。运行态留给对账维持开。
          if (!p.on && (skillLeasesSync.has(p.key) || !skillClaims.readable || skillClaims.claimed.has(p.key))) continue
          const r: any = await (p.on ? rawSkillEnable : rawSkillDisable)({ root: p.key.slice(0, i), name: entryNames[p.key] || p.key.slice(i + 1) })
          if (r && r.ok === false) {
            // 结构性失败（这一条现在解不开）只记警告并跳过 —— 与 applySkillSourceSwitches
            // 同一条口径：拿它中断整个进入 / 退出只会把用户困在场景里，而这一行与本次改动无关。
            const code = String((r && r.code) || '')
            if (code === 'error.skill.notFound' || code === 'error.skill.notLoadable' || code === 'error.skill.noFrontmatter') {
              skipped.push(`${p.key}（${r.error}）`)
              continue
            }
            throw new Error(`技能 ${p.key} 应用失败: ${r.error}`)
          }
        }
        // 排一轮对账：把被跳过的租约补回来，并采纳外部改动。
        if (planned.length > 0) {
          void enqueueScopeReconcile({ adoptExternal: true }).catch(() => { /* 下一轮写 op 还会对账 */ })
          // 原始启停 op 没有包装层那次目录重算；整批技能应用完之后补一次（不阻塞场景回执）。
          scheduleSkillCatalogRefresh()
        }
        if (skipped.length) {
          ctx.logger?.warn?.(`scene: 跳过无法应用的技能 —— ${skipped.join('、')}`)
        }
      },
      // ── 服务器级 / 来源级启停 ─────────────────────────────────────
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
        // 场景引擎改的是**全局定义**：先按 id → serverName 归一，再把意图写下来。
        // 不能只写补丁：补丁是运行态，而运行态恒为 `意图 ∪ 租约` —— 只改补丁的话，
        // 下一轮对账会按旧意图把它改回去（全局场景的改动就丢了）。
        const rows = await mcp.patchServerRows().catch(() => [])
        const nameOf = new Map(rows.map((row) => [row.level + '\u0000' + row.id, row.serverName]))
        const intentSnap = intentStore.snapshot()
        const wanted = new Map<string, boolean>()
        for (const s of switches) {
          const name = nameOf.get(s.level + '\u0000' + s.id)
          if (name === undefined) continue
          const prev = wanted.get(name)
          wanted.set(name, prev === undefined ? s.enabled : prev || s.enabled)
        }
        // 全局「统一关闭」压过场景：不改意图、不动补丁（见 `withSceneIntent`）。
        const blocked = new Set<string>()
        for (const [name, enabled] of [...wanted]) {
          if (intentOf(intentSnap, 'mcp', name) !== 'blocked') continue
          wanted.delete(name)
          blocked.add(name)
          if (enabled) ctx.logger?.warn?.(`场景要启用 MCP 服务器「${name}」，但它已在全局「统一关闭」：已跳过`)
        }
        if (wanted.size > 0) {
          await intentStore.mutate((current) => {
            let next = current
            for (const [name, enabled] of wanted) next = withSceneIntent(next, 'mcp', name, enabled ? 'on' : 'off')
            return next
          }).catch(() => { /* 写失败 → 对账会从运行态反推；不拦场景应用 */ })
        }
        // 租约保护：按**会话认领**判，理由见 `claimedInSessions`。
        const stoppingMcp = [...new Set(switches
          .filter((s) => !s.enabled)
          .map((s) => nameOf.get(s.level + '\u0000' + s.id))
          .filter((name): name is string => name !== undefined))]
        const mcpClaims = await claimedInSessions('mcp', stoppingMcp)
        for (const s of switches) {
          const name = nameOf.get(s.level + '\u0000' + s.id)
          if (name !== undefined && blocked.has(name)) continue
          // 不真停：连接是进程级的，停了那个会话当轮就没有工具。意图已经写成 off，
          // 运行态留给对账维持开（并只对认领者可见）。
          if (!s.enabled && name !== undefined && (mcpLeasesSync.has(name) || !mcpClaims.readable || mcpClaims.claimed.has(name))) continue
          const r: any = await mcp.ops['mcpm-set-enabled']({ id: s.id, level: s.level, enabled: s.enabled })
          if (r && r.ok === false) throw new Error(`MCP 服务器 ${s.id} ${s.enabled ? '启用' : '停用'}失败：${r.error}`)
        }
        // 排一轮对账：把被跳过的租约补回来（若开关期间认领变了），并采纳外部改动。
        void enqueueScopeReconcile({ adoptExternal: true }).catch(() => { /* 下一轮写 op 还会对账 */ })
        // 补丁改动由宿主热重载（实测 ≤5s）。这里**不等**，避免进入模式被拖住十几秒；
        // 界面在应用完成后即可用，工具集合会在数秒内补齐。
      },
      // 场景备注：备注写在 hub 内的 `mcp-notes.json`（按 loader id），
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
        const r: any = await rawSkillState({})
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
       * 容错口径（用户反馈「退出模式失败 → 卡在场景里」之后加的）：**结构性**失败
       * （来源解析不到 / 该来源本来就不允许启停）只记警告并跳过 —— 这一行与本次改动无关，
       * 拿它中断整个恢复只会把用户困在场景里；**写盘**类失败仍然抛错，那说明确实没还原成功。
       * 结构性失败的正解在 `skills/service.ts` 的 `requestSwitchRoot`（项目来源按 key 前缀解析）。
       */
      applySkillSourceSwitches: async (switches) => {
        // 与 MCP 同一条：场景引擎改的是全局定义 → 先写意图，再改来源状态（见
        // applyMcpServerSwitches 的注释；运行态 = 意图 ∪ 租约）。
        const intentSnap = intentStore.snapshot()
        // 全局「统一关闭」压过场景：不改意图、不动来源状态（见 `withSceneIntent`）。
        const blocked = new Set<string>()
        for (const s of switches) {
          if (intentOf(intentSnap, 'skillSources', s.root) !== 'blocked') continue
          blocked.add(s.root)
          if (s.enabled) ctx.logger?.warn?.(`场景要启用技能来源「${s.root}」，但它已在全局「统一关闭」：已跳过`)
        }
        if (switches.length > 0) {
          await intentStore.mutate((current) => {
            let next = current
            for (const s of switches) {
              if (blocked.has(s.root)) continue
              next = withSceneIntent(next, 'skillSources', s.root, s.enabled ? 'on' : 'off')
            }
            return next
          }).catch(() => { /* 写失败 → 对账会从运行态反推 */ })
        }
        // 租约保护：按会话认领判，与 MCP / 单条技能同一条（见 `claimedInSessions`）。
        const sourceClaims = await claimedInSessions('skillSources', switches.filter((s) => !s.enabled).map((s) => s.root))
        const skipped: string[] = []
        for (const s of switches) {
          if (blocked.has(s.root)) continue
          // 不真停：技能级 enable 依赖来源启用；意图已经写成 off，运行态留给对账维持开。
          if (!s.enabled && (sourceLeasesSync.has(s.root) || !sourceClaims.readable || sourceClaims.claimed.has(s.root))) continue
          // 用原始 op：整批来源切换结束后只刷一次目录（见本函数末尾）。
          const raw = s.enabled ? rawSkillSourceEnable : rawSkillSourceDisable
          let r: any
          try {
            r = await raw({ root: s.root })
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
        void enqueueScopeReconcile({ adoptExternal: true }).catch(() => { /* 下一轮写 op 还会对账 */ })
        // 整批来源切换完只刷一次目录（原始 op 没有包装层那次刷新）。不 await：场景切换的
        // 回执不该等目录重算，缓存保留旧值，下一轮注入不会读到空。
        if (switches.length > 0) scheduleSkillCatalogRefresh()
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
      // 快捷提示词：档案定义了 quickPrompts 段时，进入场景 = 把每一条的开关置成
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

    // ---------- 轻量子智能体----------
    // 人设 = $DSH_HOME/tool-management/subagents/<name>.md；运行走官方 ctx.subagents.start（spawn provider）。
    // stateDir 与 rules 共用同一个覆盖键（测试注入一致）；子智能体开关存 <stateDir>/subagents-index.json。
    const subagentService = createSubagentService(ctx, { stateDir: String((config as { memoriesStateDir?: unknown } | undefined)?.memoriesStateDir || '') })
    /** 某个 agent 生效的场景（含基线那一份）：string = 钉住，null = 钉住没有，undefined = 跟随全局。 */
    const sceneOverrideOfAgent = (agent: unknown): string | null | undefined => {
      const sessionId = scopeKeyForAgent(agent)
      return sessionId === null ? undefined : sessionScenePinOf(scopeStore.scopeOfSync(sessionId))
    }
    // sceneLists 供场景绑定校验：启用场景（rules-list 的 active 行）档案里的 subagents 并集。
    // 会话进入场景时取**那个场景**的绑定 —— 否则会话层切了场景、人设目录还按全局
    // 正在用的那个场景过滤。钉住"没有场景"（脱离且基线无场景）→ 不按任何场景绑定过滤。
    const subagentSceneLists = async (agent?: unknown): Promise<string[][]> => {
      const pinned = sceneOverrideOfAgent(agent)
      if (pinned === null) return []
      if (pinned !== undefined) {
        const bound = memoriesService.sceneSubagentsOf(pinned)
        // 档案没定义 subagents 段 = 不过滤（与引擎同口径）。
        return bound === undefined ? [] : [bound]
      }
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
      toolTableSizes, recordToolSize, readToolTableSettings, toolTableState, toolTableWriteError, toolTableHidden,
      mutateToolTableSettings, toolTableReport, toolTableOp,
    } = createToolTableSwitch({
      ensurePaths, readJsonFileStrict, writeJsonFile, withWriteLock, message, EMPTY_TOOL_SET,
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

    /**
     * 这条工具**在这个 agent 手里吗** —— 注入侧（`how` 行、两个目录的尾句）与工具回执共用的一份。
     *
     * 两条路并起来，缺一条框架文本就会说谎：
     *   ① `toolTableHidden()` —— 兼容页「模型工具表」的全局开关。**必须留着**：它读的是设置
     *      本身，与"限制层装没装上"无关（可见性的重放有 300ms 去抖，只问可见性会有一个窗口漏报）。
     *   ② `tools.get(name, agent)` —— 拿 agent 当 scope 问"它解析得到这个名字吗"，与
     *      `carrierHiddenToolsFor` 同一套官方写法。这一条覆盖**人设的工具限制**：
     *      `decideToolFilter` 算出的 allow/deny 由官方在子代理启动时 `tools.restrict` 装到那个
     *      scope 上（`dsh-subagent/lib/index.js:522`），全局开关表里看不到它 —— 于是人设砍掉
     *      `skill_manager_read` 之后，技能目录照注、`how` 行照样点名一个模型手里没有的工具。
     *      拿不到 agent 时跳过：`get(name, undefined)` 问的是**全局视图**，会得出相反结论。
     *
     * 为什么要有这一份：此前只有全局开关一条路，于是
     * `mcp_manager_switch` 的 `listHint`、技能目录与子智能体目录的尾句都会点名一条**这个模型
     * 手里没有的**工具。它是这两处的唯一判据 —— 工具侧经 `toolVisibleFor` 依赖拿，注入侧经
     * `injectHiddenToolsFor` 拿，同一个函数，不定义第二份。
     */
    const toolVisibleFor = (name: string, agent: unknown): boolean => {
      // 工具表按对话解析（本对话名单 → 基线 → 全局）；拿不到 agent 时按全局。
      if (toolTableHiddenForSession(scopeKeyForAgent(agent)).has(name)) return false
      if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) return true
      try { return tools.get(name, agent as object) !== undefined } catch { return true /* 读不到 = 按还在手里算 */ }
    }

    /**
     * `how` 行点名过的工具里，**这个 agent 手里没有**的那些（注入器每步同步问一次）。
     * 判据就是上面那份 `toolVisibleFor`，这里只把它收成一份集合交给注入框架。
     */
    const injectHiddenToolsFor = (agent: unknown): ReadonlySet<string> => {
      const hidden = new Set<string>(toolTableHiddenForSession(scopeKeyForAgent(agent)))
      for (const name of HOW_NAMED_TOOLS) if (!toolVisibleFor(name, agent)) hidden.add(name)
      return hidden
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
      // 人在「兼容」页把 `subagent_manager_list` 关掉、或某个人设用 `toolsDeny` 砍掉它之后，
      // 截断提示里那句「用 X 查」就是假的。判据按 **agent**：
      // 与 `how` 行、MCP 回执同一份 `toolVisibleFor`，不再只看全局开关。
      listToolVisible: (agent) => toolVisibleFor('subagent_manager_list', agent),
      // 会话层：四层并值（覆盖 → 场景层绑定 → 基线）。本会话开的**能救回**
      // 场景绑定的排除项；没话说时目录自己落到全局口径（场景绑定 ∩ 全局启停）。
      flagFor: (agent) => flagResolverOfAgent(agent, 'subagents'),
      layerKeyFor: (agent) => layerKeyOfAgent(agent),
    })
    // ⚠️ 取数必须用 mcpmRowsWithNotes(false)：true 会带上**未打码**的 url/headers/env（含明文密钥）。
    // 技能目录与提示词两个域是**官方载体的兜底**：预设挂得到官方
    // dsh-tool-skill / dsh-agent-instructions 时注入侧会跳过它们（见 context-inject.ts 的
    // CARRIER_FACT_OF），挂不到（极简）时才由这里送 —— 所以极简下也能按开关决定要不要。
    const skillCatalog = createSkillCatalog({
      // 项目技能根按**本会话的 cwd** 推导：不给 sessionId 时是全部活动会话的
      // cwd 并集，两个对话会看到同一份清单（A 能看到 B 项目的技能）。
      state: (sessionId) => rawSkillState(sessionId === undefined ? {} : { sessionId }),
      // 注入侧按 agent 取会话 id；取不到 = 全局口径。
      sessionIdFor: (agent) => sessionScopeIdOf(agent) ?? undefined,
      // 与子智能体目录同一份判据：只看全局开关时，人设用
      // `toolsDeny` 砍掉 `skill_manager_list` 之后，技能目录尾句照样点名一条它手里没有的工具。
      listToolVisible: (agent) => toolVisibleFor('skill_manager_list', agent),
      // 会话层：两格 —— 技能（覆盖 → 场景层 → 基线 + 全局意图）与来源（同一条）。
      //
      // 两格**总是给**：策略表 / 来源状态是机器级的，租约期间读到的是运行态。不给会话层
      // 就等于把"A 开了一条技能，B 也看见"留在原地 —— 用户实测的那条串味。
      // 返回 `undefined` 的那一格（没有意图、会话层也没说话）由目录自己落到运行态。
      layerFor: (agent) => {
        const sessionId = scopeKeyForAgent(agent)
        const skill = (key: string) => skillViewOf(sessionId, key).visible
        const source = (rootKey: string) => skillSourceViewOf(sessionId, rootKey).visible
        return { skill, source }
      },
      layerKeyFor: (agent) => layerKeyOfAgent(agent),
    })
    /**
     * 技能目录重算的**合并调度**。
     *
     * 一次场景应用 / 连点几个开关会在几百毫秒内落下好几笔写；每笔各刷一次目录，会让
     * `refresh()` 反复换代、把上一波还没跑完的扫描作废再起一波 —— 磁盘和事件循环都被
     * 同一件事占满，所有域的请求跟着变慢。这里把同一小段时间里的刷新并成一次。
     *
     * 目录是 SWR：旧值保留在缓存里，晚 120ms 重算不会让注入读到空，也不影响写回执。
     */
    let skillCatalogRefreshTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleSkillCatalogRefresh(): void {
      if (skillCatalogRefreshTimer !== null) return
      skillCatalogRefreshTimer = setTimeout(function () {
        skillCatalogRefreshTimer = null
        void skillCatalog.refresh().catch(() => { /* 下一轮读会重建，不影响已完成的写 */ })
      }, 120)
    }

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
      readSidebarSettings,
      sidebarSettingsOp,
    } = createSettingsSidecars({
      ensurePaths,
      readJsonFile,
      readJsonFileStrict,
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
          // 顺序即界面勾选与消息顺序：场景和记忆 → MCP → 技能 →
          // 子智能体 → 提示词。form 是宿主语义轴：记忆是「当前状态」（snapshot，后发取代先发），
          // 三个目录是 catalog，提示词是 instructions（与官方 AGENTS.md 那条行同一形态）。
          //
          // 深度判据（`applicableTo`）**逐域写在域声明上**，三个域各一条，语义都**不是**"能不能
          // 委派"。委派可行性由官方决定：`dsh-subagent` 默认 `maxDepth: 1`（0.2.1 实测核对），provider 只在
          // 传了该值时才校验，所以子代理本来就能继续嵌套（用户实测确认）。此前判据叫"还有没有
          // 委派预算"、语义是"还能不能委派"，那是错的 —— 详见 service.ts 里 `catalogDepth` 的注释。
          //   · 场景与记忆：**恒为"只在顶层"**。这两段说的是**父会话的处境**（此刻在哪个场景、
          //     这个场景下攒了什么），子代理要什么由父代理写进委派说明；记忆本体又是几 KB 的
          //     常驻文本，子代理真有需要可以自己用 `memory_manager_*` 取。放它们进子会话，
          //     子代理的上下文就不再收敛为「角色 + 任务」。（曾把这两条放开到所有深度，已回退。）
          //   · 子智能体目录：人设的 `catalogDepth`（默认 1 = 只在顶层）—— 它问的是"**目录该不该
          //     注入到这么深的会话**"，与"这个域要不要注入"是两件事。目录正文也按同一判据过滤
          //     （`text(agent)`），两处同源所以不会分叉。
          //   · MCP / 技能 / 提示词：不分深度。
          //
          // 同一张 `domains` 表管着六个域的开关，没有按会话分流的第二张表 —— 那张
          // `subagentDomains` 已删：人设身份在官方机制里取不到（descriptor 是字段白名单、
          // 冷恢复只还原 provider/model/effort）。
          domains: () => [
            // 场景（**框架**）：启用的场景 + 场景说明（用户的约定）。排第一 —— 先让模型知道
            // "现在在哪个场景、这个场景的约定是什么"，再读下面的记忆条目。
            // 场景与记忆两域**按会话取覆盖**：`scopeOf(agent)` 给出本会话的场景与逐条
            // 开关，取不到会话 id 时返回 undefined = 跟随全局（风险表最后一条：取不到不猜）。
            { key: 'scene', name: 'tool-management:scene', label: '场景', form: 'snapshot', text: (agent) => memoriesService.sceneCatalogText(memoryScopeOf(agent)), applicableTo: (agent) => subagentDepthOf(agent) === 0 },
            // 记忆（**内容**）：各场景下的条目。与场景段同源、同一条 `applicableTo`。
            { key: 'memory', name: 'tool-management:memory', label: '记忆', form: 'snapshot', text: (agent) => memoriesService.memoryText(memoryScopeOf(agent)), applicableTo: (agent) => subagentDepthOf(agent) === 0 },
            // `pending`：启动 / 重连窗口里段是空的，但"空"不等于"用户关光了" —— 这一轮沉默，
            // 别先发一条「已清空」再在 server 连上后发一次内容（两次注入，第一次还是假的）。
            { key: 'mcp', name: 'tool-management:mcp-state', label: 'MCP 服务器', form: 'catalog', text: (agent) => mcp.stateCatalog.text(agent), pending: (agent) => mcp.stateCatalog.pending(agent) },
            // 有差异（租约 / 会话覆盖）时注入器拦下官方那份，由 `text` 送会话版整份
            // ；`delta` 保留为接管判据未接上时的兜底差异行。
            //
            // `pending`：清单数据还没到手时**这一轮什么都不说** ——
            // `text()` 在冷缓存下只能返回空串，而注入侧把"空串"理解成"这一域没内容"，
            // 于是会向模型发一条假的「已清空」。写操作把目录打回重算的那一拍正是这种情形
            // （用户实测：对话中途拨开一条技能，模型先被告知目录失效）。
            {
              key: 'skills', name: 'tool-management:skill-catalog', label: '技能目录', form: 'catalog',
              text: (agent) => skillCatalog.text(agent),
              delta: (agent) => skillCatalog.delta(agent),
              pending: (agent) => skillCatalog.ready(agent) === false,
            },
            {
              key: 'subagents',
              name: 'tool-management:subagents',
              label: '子智能体',
              form: 'catalog',
              text: (agent) => subagentCatalog.text(agent),
              applicableTo: (agent) => subagentCatalog.catalogVisibleAt(subagentDepthOf(agent), agent),
            },
            // 提示词：`cwd` 决定项目指令链从哪一级往上找；会话层有覆盖时由本域送
            // 会话版整份（官方 `agent-instructions` 这一步被拦下，见 context-inject 的 suppress 并集）。
            // 没有覆盖时维持原口径：官方载体在送就让位，极简 / 压制型预设下由这里兜底。
            { key: 'prompt', name: 'tool-management:prompt', label: '提示词', form: 'instructions', text: (agent) => memoriesService.promptText(promptScopeOf(agent)), files: (agent) => memoriesService.promptFiles(promptScopeOf(agent)) },
          ],
          settings: () => injectSettingsSync(),
          // 隔离粒度：注入侧据此在**一条**消息里写一行「设置写在哪一层」。工具 schema 是静态的，
          // 三档并列写在 `scope` 参数里，模型读不出自己处在哪一档（见 `scopeLineOf`）。
          scopeMode: () => scopeMode(),
          // 工具表开关：`how` 行里点名工具的那几句要跟着它换话术（关掉的不点名）。
          hiddenTools: injectHiddenToolsFor,
          // 提示词：预设事实原样交给注入侧。会话覆盖 / 接管判定在注入器里用
          // **同步表面扫描**做（`promptOverrideActive` + 本会话已发过的插件提示词）——
          // 那里才能在"清覆盖后退回全局版"时把官方那条继续拦下并重发一份正确的正文。
          // 技能目录：有差异时同样整份接管 —— 不能先让模型看到官方那份
          // 本对话口径不对的清单，再补一行纠正。判据真算 delta（租约造成的差异侧车里没有
          // 覆盖记录），复用目录自己的 SWR 缓存，不另造第二份。
          factsFor: (agent) => candidates.presetFactsForAgent(agent),
          /** 本会话有提示词覆盖（同步）：注入侧据此拦官方那条，并放宽 supersede 判据。 */
          promptOverrideActive: promptOverrideActiveOf,
          /**
           * 本会话的快照与当前 AGENTS.md 不一致（同步，第三轮）：拦官方 agent-instructions、
           * 由插件送快照链整份。首见捕获也在这个回调里（内存先生效、异步落侧车）。
           */
          promptBaselineDiverged: promptBaselineDivergedOf,
          /**
           * 本会话技能目录与官方口径不一致（同步）：注入侧据此拦官方 skill-catalog（接管后持续到目录离开可见表面）。
           * 两条判据并列：目录数据已到时按差异算；**没到的那一拍**（新对话首轮常见）改看租约表，
           * 否则官方那份带运行态的清单会先到达模型（见 `skillCatalogHasForeignLease`）。
           */
          skillCatalogDiverged: (agent) => skillCatalogNeedsTakeover(skillCatalog.delta(agent)) || skillCatalogHasForeignLease(agent),
          // 令牌门禁：令牌**在生效**（`TOKEN !== ''`，
          // 关掉或没配都是空串）而本次启动还没有人验过 ⇒ 这一步不放行，宿主把 turn 收成
          // `blocked`。这是"没输入令牌就没法对话"的唯一真正落实 —— 客户端那条输入框锁定在
          // 本宿主上无路可走（`ctx.conversation.blocks` 不存在，见 ContextInjectorDeps 注释）。
          // 只读 op 不受影响，所以「工具管理 → 兼容」页照常能打开、能填令牌 —— 解铃就在那里。
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
      // 宿主**进程身份**：插件与宿主同进程，所以 `pid` 就是宿主的 pid，
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
    // 预热放到下一轮事件循环：此时 apply 的同步初始化已全部完成，
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
        // **不阻塞写回执**：refresh 会把每个已知会话的目录重扫一遍，等它落地等于
        // 一次技能开关 / 场景应用要多等几秒 —— 用户实测「实际开启要等很久」「切换提醒要等很久」。
        // 目录缓存现在保留上一份数据（见 skills/catalog.ts 的 refresh），所以先回执不会出现
        // 那一拍读到空而误报「已清空」；新清单晚一步到达，下一轮注入自然会带上。
        if (result && result.ok !== false) scheduleSkillCatalogRefresh()
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
    // 正文 整段搬到 ./scene-linkage.ts（一字未改，只把七个 apply 作用域名字改走
    // deps）。调用点位置原样不动 —— 重包的是那四个 service 对象上的 ops 表，而下游（handlers
    // 表、工具依赖表）取的是**当时那份函数**：包晚了，联动对它们就不存在。
    // 两个**定义在本调用之后**的名字用 getter 传：`mcp` 在 MCP 管理域那一段才建、
    // `lockedSceneNames` 在场景锁那一层才解构 —— 直接放进对象字面量会当场踩 TDZ，
    // 而取用它们的时机是请求期，那时两个 const 都已初始化完。
    installSceneLinkage({
      memoriesService, subagentService, archiveService, quickPromptOps, subagentCatalog,
      get mcp() { return mcp },
      get lockedSceneNames() { return lockedSceneNames },
      // 档案保存里的工具表方案（模型 / 全局场景的入口）：同步到停在这个场景里的会话。
      onSceneToolTableChanged: (scene, preset) => syncSessionsForSceneToolTable(scene, preset),
    })

    // HTTP 写 / 敏感 op 白名单（抽到 ./request-gate.ts）：四个 service 自报的
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

    // 归档会话域（抽到 ./sessions/history.ts）：侧车账本落点与搬迁、
    // 保留期设置与到期清扫、批量操作目标校验、归档列表分组视图。构造实例、首次清扫、
    // 挂周期定时器都在工厂内完成 —— 它们原本就写在 apply() 的同一位置。
    const history = createHistoryDomain({ ctx, config, pluginRoot: PLUGIN_ROOT, message })

    // 第三个 reconciler：会话覆盖的**孤儿清理**。会话被永久删除之后，它的覆盖
    // 条目（`scope-overrides.json` 的 `sessions[id]`）就再没有任何入口能看到它 —— 下拉框
    // 按会话头枚举，头没了那条就永远列不出来，只会越积越多。
    //
    // 只清**真删除**的：归档会话的头仍在 `listStoredHeaders()` 里，所以归档
    // 的覆盖会被保留，恢复后自动回来。读不到会话清单时**什么都不删** —— 那说明宿主那边
    // 出了问题，此时清表等于把用户的全部设置一次性抹掉。
    registerBootReconciler({
      id: 'scope-overrides-orphans',
      label: '会话作用域孤儿清理',
      async run() {
        const registry = history.getSessionsRegistry()
        if (!registry || typeof registry.listStoredHeaders !== 'function') return
        const headers = await registry.listStoredHeaders()
        const live = new Set(headers.map((h) => String((h as { id?: unknown }).id ?? '')).filter((id) => id !== ''))
        if (live.size === 0) return
        const overrides = await scopeStore.read(true)
        // 工作区键不是会话 id，不在孤儿判据里（见 store 的 pruneSessionScopes）。
        const orphans = Object.keys(overrides.sessions).filter((id) => !isWorkspaceScopeKey(id) && !live.has(id))
        if (orphans.length === 0) return
        for (const id of orphans) await scopeStore.clearSession(id)
        scopeStore.invalidate()
      },
      async probe() {
        const registry = history.getSessionsRegistry()
        if (!registry || typeof registry.listStoredHeaders !== 'function') return []
        const headers = await registry.listStoredHeaders()
        const live = new Set(headers.map((h) => String((h as { id?: unknown }).id ?? '')).filter((id) => id !== ''))
        if (live.size === 0) return []
        const overrides = await scopeStore.read(true)
        const orphans = Object.keys(overrides.sessions).filter((id) => !isWorkspaceScopeKey(id) && !live.has(id))
        if (orphans.length === 0) return []
        return [{
          id: 'scope-overrides-orphans',
          label: '会话作用域孤儿条目',
          detail: `${orphans.length} 条会话覆盖指向已删除的会话（${orphans.map((id) => id.slice(0, 8)).join('、')}）。本次启动已自动清理；若仍出现，说明会话库那边读不到头。`,
          detailKey: 'scope-overrides-orphans',
          params: { count: orphans.length },
        }]
      },
    })

    // 第四个 reconciler：**悬空场景引用**的自愈。
    //
    // 场景删除 / 改名发生在场景层，老写路径不会回头改会话的 `scope.scene`。
    // 停在一个已不存在场景里的会话会静默退回全局 —— 更糟的是 `sessionSceneOf` 仍拿旧名
    // 当生效场景，记忆注入只取 `_shared + global`、漏掉全局当前场景；之后若有人新建同名
    // 场景，这些会话还会**自动进入**它。删除 / 改名的新路径已经就地同步；这一条兜住
    // 历史数据与同步失败的那一次。
    //
    // 必须在 `scope-overrides-orphans` **之后**（注册序即执行序）：先剪掉已删除会话，
    // 不必再为它们读场景表。
    registerBootReconciler({
      id: 'scope-sessions-dangling-scene',
      label: '会话场景引用自愈',
      async run() {
        let known: Set<string>
        try {
          const r: any = await memoriesService.ops['rules-list']({})
          if (!r || r.ok === false) return
          known = new Set((r.scenes || []).map((s: any) => String((s && s.name) || '')).filter((name: string) => name !== ''))
        } catch { return }
        const res = await scopeStore.mutateAll((scope) => {
          if (scope.scene === undefined || known.has(scope.scene)) return scope
          const r = removeSceneInScope(scope, scope.scene)
          return r.changed ? r.scope : scope
        })
        if (!res.ok || res.changed === 0) return
        mcp.scheduleToolRestrictions()
        scheduleSkillCatalogRefresh()
        void subagentCatalog.refresh().catch(() => { /* 同上 */ })
        // 这次清理可能带走了认领（场景档案原本把资源拉起来）→ 按不采纳对账收一遍。
        await enqueueScopeReconcile({ adoptExternal: false }).catch(() => { /* 面板挂载那一轮还会再对 */ })
      },
    })

    // 回收站保留期域：与上面的 history 同形 —— 构造、首次清扫、周期定时器都在
    // 工厂内完成。默认保留期是 `0`（永久保留），所以对没打开过这个开关的宿主来说，
    // 启动那次清扫读完侧车就返回了，一次磁盘遍历都不做。
    //
    // 记忆回收站那两条**走 memories 域的 op**，不在这里重抄路径与 manifest 形状：它在
    // `hub/trash/memories-trash/`（与其余五类同处一处，原先在 hub 根下的独立
    // 目录），形状由 memories 域自己定 —— 重抄一遍只会得到第二份会漂移的真相。
    const trashRetention = createTrashRetentionDomain({
      ctx,
      config,
      memories: {
        list: async () => {
          const res: any = await memoriesService.ops['rules-trash-list']({})
          const entries: any[] = res && Array.isArray(res.entries) ? res.entries : []
          return entries
            .map((e) => ({
              id: String((e && e.trashId) || ''),
              name: String((e && e.name) || ''),
              deletedAt: String((e && e.deletedAt) || ''),
            }))
            // 没有 id 的条目删不掉，也不能记流水 —— 在这里挡掉，免得把一条坏数据一路带到
            // 「永久删除」那一步才失败。
            .filter((e) => e.id !== '')
        },
        purge: (id) => memoriesService.ops['rules-trash-remove']({ trashId: id }),
      },
    })

    // ── 场景提示词 → 全局基线（AGENTS.md）同步 ────────────────────────────────
    //
    // 用户要求：「切换场景，对应的提示词直接把 AGENTS.md 直接修改」。
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
     *   - 应用**别的份** = 换掉这个场景的绑定（用户要求 ：未锁定时切换要可用，
     *     并且同步写进场景档案）。绑定改完再走一次场景同步，于是「场景页显示什么 / 实际注入
     *     什么 / 谁是引用方」三处立刻重新对齐（此前的做法是直接拒绝，用户得先退出场景）。
     * 锁定由 `guardLockedOps` 挡住（agentsmd-apply 在冻结清单里）；模型工具
     * `prompt_manager_apply` 不经过 handlers，execute 里自带 `lockedSceneGuard`（F-001）。
     */
    async function applyPresetGuarded(id: string): Promise<{ ok: true; id: string; backedUp?: boolean; viaScene?: boolean; scene?: string; label?: string } | { ok: false; error: string; code?: string; params?: Record<string, string> }> {
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
        // `scene` 是**名字**（`scene_manager_*` 认的那个），`label` 只是界面显示名：
        // 两个都回，调用方才不会把「全局」当成场景名去转述（那个名字是 `global`）。
        return { ok: true, id, viaScene: true, scene: driver.scene, label: driver.label }
      }
      return promptsService.apply(id)
    }

    /** 删除拒绝里的引用说明（人话；与界面标签同一套结构化事实）。 */
    const promptRefReason = (ref: { kind?: string; label?: string; active?: boolean; applied?: boolean }): string => {
      if (ref && ref.kind === 'scene') return `场景「${ref.label || ''}」${ref.active ? '（已启用）' : ''}绑定了它`
      if (ref && ref.kind === 'restore') return '它就是退出场景后要恢复的全局提示词'
      if (ref && ref.applied === true) return '它正被「应用」在 ~/.dsh/AGENTS.md 里'
      return '~/.dsh/AGENTS.md 当前内容就是它'
    }

    // ---------- path discovery ----------
    // 已知限制：profile 探测按 profiles/<name>/cordis.patch.yml 是否存在，依次试
    // PROFILE_CANDIDATES（'web' → 'headless'，见 host-names.ts），再退回"任何有补丁的
    // profile"，最后落到 DEFAULT_PROFILE_NAME。目录名不在候选里、又还没有补丁文件的
    // profile 探测不到。
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
          // 全局补丁里那些 MCP 行就全部读不到了（实测如此）。所以先认这个形状：
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
      // —— 推导自检：健康时不留 note（运行时上报一律渲染成兼容页的问题行，
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

    // 每次写补丁前留一份带时间戳的副本：cordis.patch.yml 改坏能让 DSH 起不来，
    // 所以写前那份必须不靠 git 也能拿回来。
    const KEEP_PATCH_BACKUPS = 5
    /**
     * 备份名里的时间戳：**到毫秒 + 进程内序号**（定宽）。
     *
     * 为什么不能只到秒：同一次操作里常常连写两遍补丁（`mcpm-set-enabled`
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
      // 补丁备份含明文 env / headers 凭据：POSIX 上 0600。备份名带时间戳，每次都是新文件，
      // writeFile 的 mode 会生效；Windows 忽略。
      await writeFile(join(dir, stem + '.bak-' + backupStamp()), previous, { encoding: 'utf8', mode: 0o600 })
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
      // 两代时间戳都认：老名字到秒（`\d{6}`），加了毫秒与序号（共 `\d{12}`）。
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
     * 口径沿革：先是"每层留 N 份"，再改成"每层各删 N 份"，最后落到
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
      } catch (e) {
        // 备份失败不阻断写入（旧行为），但必须让回执说出来：用户以为有备份、
        // 出事时却找不到那才是更坏的结局。warning 走与补丁校验同一条消费式通道。
        notePatchWriteWarning('补丁备份失败（写入照常进行，但没有可回滚副本）：' + message(e))
      }
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
    // 正文 整段搬到 ./token-config.ts（一字未改，只把八个 apply 作用域名字改走
    // deps）。这一段是 apply 里唯一**改写宿主启动配置**的手：四个方向的凭证判据、写点优先级、
    // 拒写形状全在那一层的注释里。这里按原位置建一次工厂 —— 它没有状态，两个出口仍然只被
    // apply 末尾的 HTTP 路由就地调用（刻意不进 handlers 表，模型关不掉访问令牌）。
    const { tokenConfigState, tokenConfigure } = createTokenConfig({
      ensurePaths, readPatch, writePatch, withWriteLock, message,
      TOKEN, CONFIG_TOKEN, CONFIG_TOKEN_FROM_FILE, tokenMatches,
    })

    // ---------- 通用侧车 JSON 读写 ----------
    // 为什么留在 index.ts：注入设置（inject-settings.json）也在用这一对，搬进
    // ./mcp/manager.ts 就得为一对 6 行函数再加一层 deps 转发。
    async function readJsonFile(abs: string): Promise<any> {
      try { return JSON.parse(await readFile(abs, 'utf8')) } catch (e) { return null }
    }
    /**
     * 严格读：把「文件不在」与「读不出来 / 解析不了」分开。
     *
     * 停用表是安全控制，不能沿用 readJsonFile 的「异常 = null = 空表」。这里不调
     * ensurePaths —— 侧车落点走 resolveDshHome，与补丁路径推导无关。
     */
    async function readJsonFileStrict(abs: string): Promise<JsonFileRead> {
      let text: string
      try {
        text = await readFile(abs, 'utf8')
      } catch (e) {
        if (String((e as { code?: string })?.code || '') === 'ENOENT') return { status: 'missing' }
        return { status: 'unreadable', error: message(e) }
      }
      try {
        // Windows 编辑器可能在开头写 BOM；它不是结构错误，先去掉再解析。
        return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) }
      } catch (e) {
        return { status: 'corrupt', error: message(e) }
      }
    }
    async function writeJsonFile(abs: string, data: any): Promise<void> {
      // 侧车是插件私有配置（备注 / 设置 / 停用表 / 工具表 / 令牌相关状态），
      // POSIX 上按 0600 落盘；Windows 的 mode 语义不生效，无需特判。
      await writeFileAtomically(abs, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    }

    // ---------- MCP 管理域 ----------
    // 侧车读写（备注 / 设置 / 停用表）+ 补丁受管行的生成与块编辑 + 16 个 op，实现在
    // ./mcp/manager.ts（从本闭包原样抽出，约 1300 行）。
    //
    // 为什么经工厂 + 返回对象，而不是把函数留在这里：这一域有**反向依赖** —— 注入通道要
    // 打码后的列表行、场景档案引擎要读写停用表与备注、工具门禁要读 TTL 缓存判断某工具是否
    // 被停用、审批策略要读插件设置。以前这些靠闭包隐式共享（谁在用什么看不出来），现在全部
    // 经返回的 McpManager 显式暴露。
    const mcp = createMcpManager({
      readJsonFile,
      readJsonFileStrict,
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
      // 状态段尾句那句「用 `mcp_manager_list` 查」的前提：与技能 / 子智能体两个目录同一份判据
      // 。
      listToolVisible: (agent: unknown) => toolVisibleFor('mcp_manager_list', agent),
      // 会话层：两半各管一头 ——
      //   · `sessionMcpOverlay`（异步）给 restrictAgent：在**此刻注册着的**工具全名上算
      //     allow / deny（deny 追加、allow 从全局停用名单里减掉，见 tool-visibility.ts）；
      //   · `sessionHiddenServer`（同步）给状态段与 mcp_manager_list 逐行问。
      sessionMcpOverlay: (agent: unknown) => sessionMcpOverlayOf(agent),
      // 模型工具表也按对话走：本对话的整份关停名单与全局的差异并进同一层 restrict。
      sessionToolTableOverlay: (agent: unknown) => sessionToolTableOverlayOf(agent),
      sessionHiddenServer: (agent: unknown, serverName: string) => sessionServerHiddenOf(agent, serverName),
      // 逐工具会话判定：状态段按它把「本会话把工具全关了」的服务器标成不可用。
      // 每次渲染只建一次会话快照（覆盖 / 场景层 / 基线 / 意图四张表），逐工具再问不会重算。
      sessionToolVerdictFor: (agent?: unknown) => {
        const ctx = sessionMcpContextOf(agent)
        // 没有任何会话层 → 逐工具判定恒为 undefined，省掉每台服务器每条工具的层级计算
        // （这段在注入热路径上，每个 step 都会跑一次）。
        const scope = ctx.scope
        const hasLayer = scope !== undefined &&
          (scope.scene !== undefined || scope.detached === true || scope.mcp !== undefined || scope.mcpTools !== undefined)
        if (!hasLayer) return () => undefined
        return (serverName: string, tool: string) => mcpVerdictOf(ctx, {
          key: serverName + '/' + tool,
          server: serverName,
          tool,
          certain: true,
        })
      },
      // 本次启动 id：重启标记用它区分「同一轮启动内的重放」与「上一个进程留下的」。
      bootId: () => BOOT_ID,
    })

    // ---------- ops ----------
    async function pluginVersion(): Promise<any> {
      return { ok: true, version: PKG_VERSION }
    }


    // ---------- 用系统默认编辑器打开技能来源 ----------
    // 发出去就不管：启动器自己 detach，编辑器卡住也不会挂住请求。只接受**已存在的
    // Markdown 源文件** —— 这条路由虽然同源 + token 门控，也不能变成「启动任意程序」的入口。
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
    // 实现在 ./scenes/candidates.ts（从本闭包 10 段抽出，约 260 行）。
    // 放在这里而不是更早：它要 mcp（读停用表）与 toolKeyParts（416 行的 const），
    // 而唯一在更早处引用它的地方（注入 deps 的 factsFor）是箭头函数，调用发生在之后。
    // 本插件注册过的工具名。**唯一**可靠的"插件工具"判据：官方没有工具级归属接口
    // （`ToolSchema` 无归属字段、`ToolRuntime` 公开面无来源、`tools/change` 无载荷），
    // 但自己注册了什么自己当然知道。登记点在下面 `toolDeps.register`（2115 行那个漏斗，
    // 六个域的构建器全部经它），所以不可能漂移 —— 新增工具自动进集合，不用维护前缀表。
    const selfToolNames = new Set<string>()
    const candidates = createCandidates({
      get: (name: string) => ctx.get(name),
      tools,
      mcp,
      skillsService,
      memoriesService,
      toolKeyParts,
      // 传 getter 而不是快照：登记发生在 apply 过程中（本行之后 600 余行），
      // 而这个工厂现在就要构造完。
      selfToolNames: () => selfToolNames,
    })


    // 提示词预设域的 op 表。单独提出来是为了让**模型工具**能复用同一份判定：
    // `prompt_manager_list` 以前直调 `promptsService.list()`，于是它报的「生效中」是
    // **文件比对**口径（预设正文 == ~/.dsh/AGENTS.md），而界面报的是 `agentsmd-list` 的口径
    // （启用的场景绑了预设时，**只有那份**算生效中）—— 同一件事两个答案，场景驱动时工具就在
    // 说假话。工具改走 op 之后两边只有一份判定。
    /**
     * 本会话**真正注入**的提示词正文（去掉「Instructions from:」来源行）。
     * `scope-get` 的 `prompt.effective` 与提示词页的「会话层沿用哪一份预设」共用这一份。
     */
    const sessionPromptTextOf = (sessionId: string): string => {
      try {
        // 编辑框要的是**正文**：`Instructions from:` 那行由解析层在注入时生成，
        // 留着它保存会多套一层来源头（下次解析再加一条会话覆盖的来源行）。
        // 工作区模式：真实 sessionId 先折成作用域键（`promptScopeOfSession` 内部也会再折一次）。
        return memoriesService.promptText(promptScopeOfSession(scopeKeyForIdSync(sessionId))).replace(/^Instructions from: [^\n]*\n\n/, '')
      } catch { return '' }
    }
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
      sessionPromptText: sessionPromptTextOf,
      warn: (m: string) => { ctx.logger?.warn?.(m) },
    })

    // ---------- 会话作用域的全局快照与会话清单----------
    // 两件事都**复用各域自己的 op**，不另读一遍磁盘：全局值就是那几条列表 op 回的 enabled
    // 字段，抄第二份判定必然分叉（某天 core 改了"未记录 = 启用"的口径，这边不会跟着变）。
    //
    // 读失败只让**那一域**空着：空着 = "全局没有开着的项"，覆盖因此**不会被判成同值而清掉**
    // —— 宁可多留一条覆盖，也不能因为一次读盘失败把用户的设置静默删掉。
    async function scopeGlobalSnapshot(): Promise<ScopeGlobalSnapshot> {
      const flags: Record<string, Record<string, boolean>> = { skills: {}, subagents: {}, memory: {}, quickPrompts: {}, mcp: {}, mcpTools: {}, skillSources: {} }
      const unavailable: string[] = []
      let scene: string | null = null
      // 意图：MCP 与技能来源两格的"全局值"现在是**意图**，不是补丁 / 来源状态。
      // 读不到 = 没有意见 → 那两格退回运行态（见 planReconcile 的升级推断）。
      let intentSnapshot: ScopeIntent = intentStore.snapshot()
      try { intentSnapshot = await intentStore.read() } catch { /* 读不到 = 没有意见 */ }
      const settle = async (domain: string, run: () => Promise<void>): Promise<void> => {
        try { await run() } catch { unavailable.push(domain) }
      }
      // 场景与记忆共用同一次 `rules-list`（它一次回齐 activeScene 与 rules）。分开 settle
      // 是为了"某一份读失败只影响那一域"这条口径——读失败时两域一起标 unavailable。
      const sceneAndMemory = settle('scene', async () => {
        // 两域共用这一次读：**读失败/抛异常时两域都要标 unavailable**，否则场景写被拒、
        // 记忆写却按"全局全关"去判同值 —— 一次显式开启会被当场清掉。
        const r: any = await memoriesService.ops['rules-list']({}).catch((e: unknown) => {
          unavailable.push('memory')
          throw e
        })
        if (!r || r.ok === false) {
          unavailable.push('memory')
          throw new Error('rules-list failed')
        }
        scene = r.activeScene ? String(r.activeScene) : null
        // 记忆的全局口径是**索引里的 enabled**（缺省 = 启用），键与档案里那份一致：
        // `<场景>/<名>`。读 `rules-list` 而不是直接读索引，是为了与界面看到的是同一份投影。
        for (const rule of (r.rules || [])) {
          if (rule && rule.id) flags.memory[String(rule.id)] = rule.enabled !== false
        }
      })
      await Promise.all([
        sceneAndMemory,
        settle('skills', async () => {
          const r: any = await rawSkillState({}).catch((e: unknown) => {
            // 两域共用这一次扫描：读失败时技能与来源一起标 unavailable，否则"关掉一个来源"
            // 会被判成"与全局同值（空表）"而自动清除。
            unavailable.push('skillSources')
            throw e
          })
          // `ok:false` 是**读失败**（core 扫描出错），不是"全都没开"。当成空表会让写侧
          // 把一次关闭判成"与全局同值"而自动清除，所以这一域整体标 unavailable。
          if (!r || r.ok === false) { unavailable.push('skillSources'); throw new Error('skill-state failed') }
          const data = r.data ? r.data : r
          for (const root of ((data && data.roots) || [])) {
            // 来源一格与技能一格共用这次扫描。来源的全局值是**意图**：
            // on / off / blocked 以意图为准，没记录才落到运行态（`root.enabled`，缺省 = 开）。
            const rootKey = String(root.key || '')
            if (rootKey) {
              const state = intentOf(intentSnapshot, 'skillSources', rootKey)
              flags.skillSources[rootKey] = state === 'on' ? true
                : (state === 'off' || state === 'blocked') ? false
                  : root.enabled !== false
            }
            for (const sk of (root.skills || [])) {
              const name = String(sk.declaredName || sk.name || '')
              if (!name || !rootKey) continue
              // 单条技能的全局值也是**意图**优先：租约期间运行态是开着的
              // 直接读 `sk.enabled` 会把"某个对话临时开着"报成"全局开着"，
              // 新会话于是继承那条技能 —— 与服务器那格修过的串味同一条路径。
              const skillKey = rootKey + '/' + name
              const skillState = intentOf(intentSnapshot, 'skills', skillKey)
              flags.skills[skillKey] = skillState === 'on' ? true
                : (skillState === 'off' || skillState === 'blocked') ? false
                  : sk.enabled === true
            }
          }
        }),
        settle('subagents', async () => {
          const r: any = await subagentService.ops['subagent-list']({})
          if (!r || r.ok === false) throw new Error('subagent-list failed')
          for (const p of ((r && r.subagents) || [])) {
            if (p && p.name) flags.subagents[String(p.name)] = p.enabled === true
          }
        }),
        settle('quickPrompts', async () => {
          const r: any = await quickPromptsService.list()
          if (!r || r.ok === false) throw new Error('quickprompt-list failed')
          for (const p of ((r && r.prompts) || [])) {
            if (p && p.id) flags.quickPrompts[String(p.id)] = p.enabled === true
          }
        }),
        settle('mcp', async () => {
          // MCP 的全局口径 = **意图**。不能用补丁当全局值：补丁是 `意图 ∪ 租约`
          // 把租约当成全局开着，正是"会话开了 mcp，新会话也注入"那条串味路径。
          // 也不能用逐工具停用表：那张表的 `*` 是场景档案把整台工具收窄，与服务器开没开是两件事。
          // 意图没有记录时（升级首轮 / 新服务器）才退回补丁的启停值。
          const states = await mcp.configuredServerStates()
          for (const row of states) {
            const name = String(row.serverName)
            const state = intentOf(intentSnapshot, 'mcp', name)
            flags.mcp[name] = state === 'on' ? true
              : (state === 'off' || state === 'blocked') ? false
                : row.disabled !== true
          }
        }),
        // 逐工具一格：`<server>/<tool>` → 全局可见性。真值与 `mcpTools` 覆盖表
        // 场景档案的 `mcp` 段（工具清单）都按同一批键对齐 —— 用 `candidates.toolStates()`
        // （停用表 ∪ live schema 的同一份推导），不另算一遍。
        settle('mcpTools', async () => {
          const states = await candidates.toolStates()
          for (const [key, enabled] of Object.entries(states)) flags.mcpTools[key] = enabled === true
        }),
      ])
      // 租约计数：**七个域全部读时现算**。此前 mcp / skillSources / skills
      // 三格读的是对账器维护的内存 Map —— 而会话的删除 / 归档 / 恢复 / 重启都不走插件的写 op，
      // 没有任何路径会去刷那三个 Map，徽章于是停在旧值（用户报障 B / C）。现算把"谁记得刷新它"
      // 这条依赖整个删掉：会话清单此刻长什么样，徽章就是什么样。
      //
      // 只问**全局关着**的那些格：开着的那些本来就该显示成开着，数它没有意义，而记忆这类域
      // 可能有几百条键 —— 每次读面板都全扫一遍是不必要的成本。
      // 键集合的口径：**意图域**只数「意图不是 on」的键（全局开着不是租约，统一关闭没有
      // 租约这回事）；**纯视图域**只数「全局关着」的键。两句话都只回答"这一格该不该挂徽章"。
      const leaseKeys: Partial<Record<ScopeFlagDomain, readonly string[]>> = {}
      for (const domain of SCOPE_FLAG_DOMAINS) {
        const all = Object.keys(flags[domain] ?? {})
        const intentDomain: IntentDomain | null = isIntentDomain(domain) ? domain : null
        const keys = intentDomain !== null
          ? all.filter((key) => {
            const state = intentOf(intentSnapshot, intentDomain, key)
            return state !== 'on' && state !== 'blocked'
          })
          : all.filter((key) => flags[domain][key] !== true)
        if (keys.length > 0) leaseKeys[domain] = keys
      }
      const { scan: leaseScan } = await scanClaimsOnce(leaseKeys)
      const leaseCounts = (domain: ScopeFlagDomain): Record<string, number> => {
        const out: Record<string, number> = {}
        for (const [key, list] of leaseScan.claims[domain]) out[key] = list.length
        return out
      }
      // 场景页的「全部关闭」：只数**会话层进入过场景**的未归档会话 / 工作区。全局正在用的
      // 那个场景是全局设置，不算临时运行；没有场景覆盖时连会话清单都不读。
      let sceneLeases = 0
      const sceneLeaseCounts: Record<string, number> = Object.create(null)
      try {
        const overrides = await scopeStore.read()
        const sceneIds = Object.entries(overrides.sessions)
          .filter(([, scope]) => typeof scope.scene === 'string' && scope.scene !== '')
          .map(([id]) => id)
        if (sceneIds.length > 0) {
          const rows = await scopeSessionRows()
          const archived = new Set(rows.filter((row) => row.archived === true).map((row) => row.id))
          for (const id of sceneIds) {
            if (archived.has(id)) continue
            const name = String(overrides.sessions[id].scene)
            sceneLeaseCounts[name] = (sceneLeaseCounts[name] || 0) + 1
            sceneLeases += 1
          }
        }
      } catch { /* 读不到 = 没有临时场景 */ }
      return {
        scene,
        flags,
        unavailable,
        // 三态意图与租约计数（界面用）：`flags` 把 blocked 投影成 false，分不出「关着」与
        // 「统一关闭」；租约计数则是全局 off 却仍在跑的唯一解释。
        intent: { mcp: intentSnapshot.mcp, skillSources: intentSnapshot.skillSources, skills: intentSnapshot.skills },
        leases: {
          mcp: leaseCounts('mcp'),
          skillSources: leaseCounts('skillSources'),
          skills: leaseCounts('skills'),
          mcpTools: leaseCounts('mcpTools'),
          memory: leaseCounts('memory'),
          subagents: leaseCounts('subagents'),
          quickPrompts: leaseCounts('quickPrompts'),
        },
        sceneLeases,
        sceneLeaseCounts,
      }
    }

    /**
     * `scope-get` 用的全局快照：**同一拍的重复读合成一次**（in-flight 合流 + 150ms 短 TTL）。
     *
     * 为什么必须有：一次 `scopeGlobalSnapshot()` 要把 `rules-list` / `skill-state` /
     * `mcpm-list` / `subagent-list` / 快捷词五批读全跑一遍（`skill-state` 冷启实测 3.4s），
     * 而斜杠菜单每敲一个键问一次、面板每切一层问一次，同一次交互里六个域行还会各自把这些
     * op 再读一遍 —— 一份现状被读成好几遍，界面就卡在"等最慢那一批"上。
     *
     * TTL 只取 150ms：它要合的是**同一拍内的重复读**，不是拿缓存换新鲜度。写之后最坏 150ms
     * 才反映到"全局值"这一栏，而各域自己的列表 op 一个字都没缓存（面板画的勾来自那些 op
     * 与 `effective` 差异，不经过这里）。读失败不进缓存：下一次照实重读。
     */
    const SCOPE_GLOBAL_TTL_MS = 150
    let scopeGlobalCache: { at: number; value: Promise<ScopeGlobalSnapshot> } | null = null
    function scopeGlobalSnapshotShared(): Promise<ScopeGlobalSnapshot> {
      const now = Date.now()
      if (scopeGlobalCache !== null && now - scopeGlobalCache.at < SCOPE_GLOBAL_TTL_MS) return scopeGlobalCache.value
      const value = scopeGlobalSnapshot()
      value.catch(() => {
        if (scopeGlobalCache !== null && scopeGlobalCache.value === value) scopeGlobalCache = null
      })
      scopeGlobalCache = { at: now, value }
      return value
    }

    /** 会话**创建时**的冻结快照（基线）：全局快照原样存下 + 时间戳。读失败返回 null（调用方如实降级）。 */
    async function captureBaselineSnapshot(): Promise<SessionBaseline | null> {
      try {
        const snap = await scopeGlobalSnapshot()
        // 模型工具表也抄一份：每个对话从创建那一刻起有自己的整份名单。
        // 先 await 一次设置读取，避免缓存还冷时把"一个都不关"抄成基线。
        const toolTable = await readToolTableSettings()
        return {
          scene: snap.scene,
          flags: snap.flags,
          toolTableHidden: toolTable.hidden.slice(),
          capturedAt: new Date().toISOString(),
        }
      } catch { return null }
    }

    /**
     * 给某个会话把基线记下来（已有就跳过）。**创建时**记才有意义 —— 「退出模式」要回到的是
     * 那一刻的样子，此后全局怎么变都与它无关。best effort：记不上就退出时如实降级为跟随全局。
     */
    async function ensureBaselineFor(sessionId: string): Promise<void> {
      if (sessionId === '') return
      // 调用方可能给真实会话 id（agent/created）或工作区键（面板）。统一折到当前模式的键。
      const scopeId = scopeKeyForIdSync(sessionId)
      // 全局粒度：会话层不存在，基线没有落脚处（`mutate('')` 必失败）。切回会话 / 工作区
      // 粒度时基线由注入侧与下一次 `agent/created` 重新捕获 —— 少一份快照不影响正确性，
      // 只影响那一档"退出场景回到创建时样子"的精度，而那个档位此刻根本没被使用。
      if (scopeId === '') return
      const current = scopeStore.scopeOfSync(scopeId)
      if (current?.baseline !== undefined && current.baseline.capturedAt !== undefined) return
      const baseline = await captureBaselineSnapshot()
      if (baseline === null) return
      try { await scopeStore.mutate(scopeId, (cur) => withBaseline(cur, baseline).scope) } catch { /* best effort */ }
    }

    /**
     * 租约认领：哪些**未归档**会话在某一格上"要"它。
     *
     * 判据 = 有效层（覆盖 → 场景层 → 基线）为 true。它**不**看全局意图 —— 是不是租约由
     * 调用方按"意图不是 on"来判。显式覆盖另数一份：升级首轮用它判断"补丁开着"是不是
     * 旧版本"会话里打开全局关着的服务器"那次拉起留下的运行态（见 scope/intent.ts）。
     *
     * 归档会话不算（它的覆盖留着，但会话已经不用了）；已删除的会话也不算 —— 清单读不到时
     * 不做这条判定，宁可多留一个租约，也不能把正在用的会话的服务器停掉。
     *
     * 扫描本身在 `scanSessionClaims`（与展示侧同一份），这里只做域名的映射与严格读的包装。
     */
    async function leaseClaimsOf(servers: readonly string[], sources: readonly string[], skillKeys: readonly string[] = []): Promise<{
      mcp: Map<string, string[]>
      skillSources: Map<string, string[]>
      skills: Map<string, string[]>
      mcpExplicit: Map<string, string[]>
      sourceExplicit: Map<string, string[]>
      skillExplicit: Map<string, string[]>
      /** 侧车里有没有会话痕迹（域 → 键）。`null` = 侧车**没读出来** → 调用方一律当有痕迹。 */
      traced: Record<ScopeFlagDomain, Set<string>> | null
    }> {
      const empty = (): Map<string, string[]> => new Map<string, string[]>()
      const targets: ClaimScanTargets = {}
      if (servers.length > 0) targets.mcp = servers
      if (sources.length > 0) targets.skillSources = sources
      if (skillKeys.length > 0) targets.skills = skillKeys
      if (Object.keys(targets).length === 0) {
        const traced = {} as Record<ScopeFlagDomain, Set<string>>
        for (const domain of SCOPE_FLAG_DOMAINS) traced[domain] = new Set()
        return { mcp: empty(), skillSources: empty(), skills: empty(), mcpExplicit: empty(), sourceExplicit: empty(), skillExplicit: empty(), traced }
      }
      // **严格读**：痕迹闸门要在"这份侧车没读出来"时保守 ——
      // 而吞错语义下空表与读失败长得一模一样，那正好会把"不采纳"翻成"采纳"。
      const { scan, readable } = await scanClaimsOnce(targets, true)
      return {
        mcp: scan.claims.mcp,
        skillSources: scan.claims.skillSources,
        skills: scan.claims.skills,
        mcpExplicit: scan.explicit.mcp,
        sourceExplicit: scan.explicit.skillSources,
        skillExplicit: scan.explicit.skills,
        traced: readable ? scan.traced : null,
      }
    }

    /**
     * 把对账排进串行链（写 op 会 await 它取回执；启动 / 场景联动只排队）。
     * 并发调用不会并行写补丁 —— 两轮同时改同一份补丁会互相覆盖。
     */
    function enqueueScopeReconcile(opts: { adoptExternal?: boolean } = {}): Promise<ScopeReconcileReport> {
      const run = reconcileChain.then(() => reconcileScopeResourcesOnce(opts), () => reconcileScopeResourcesOnce(opts))
      reconcileChain = run.then(() => { /* 结果已交给调用方 */ }, () => { /* 同上 */ })
      return run
    }

    /**
     * 一趟意图对账：`运行态 := 意图 ∪ 租约`。
     *
     * 读失败**整轮放弃**、保留现状 —— 按空表对账会把用户的服务器 / 来源全部停掉。
     * 每一笔失败逐条记进报告（写 op 如实带出），不中断其余行：一台服务器补丁写失败
     * 不该让别的会话的租约也起不来。
     *
     * `adoptExternal` 只在启动与全局场景应用之后给（见 scope/intent.ts）：
     * 用户手改补丁 / 官方页面改了来源 / 场景引擎刚应用完，运行态与意图不一致是**外部改动**，
     * 没有租约时以运行态为准；有租约时那本来就是租约该有的样子，不采纳。
     */
    async function reconcileScopeResourcesOnce(opts: { adoptExternal?: boolean } = {}): Promise<ScopeReconcileReport> {
      const report: ScopeReconcileReport = { started: [], stopped: [], failed: [] }
      let intent: ScopeIntent
      let patchRows: Array<{ id: string; serverName: string; level: 'global' | 'project'; disabled: boolean }>
      let roots: any[]
      try {
        intent = await intentStore.read(true)
        const [rowsResult, skillResult] = await Promise.all([
          mcp.patchServerRows(),
          rawSkillState({}),
        ])
        patchRows = rowsResult
        const st: any = skillResult
        roots = st && st.ok !== false ? ((st.data && st.data.roots) || []) : []
      } catch {
        return report
      }
      const byServer = new Map<string, Array<{ id: string; level: 'global' | 'project'; disabled: boolean }>>()
      for (const row of patchRows) {
        const list = byServer.get(row.serverName) || []
        list.push({ id: row.id, level: row.level, disabled: row.disabled })
        byServer.set(row.serverName, list)
      }
      const servers = [...byServer.keys()]
      const sourceRows = roots
        .map((root) => ({
          key: String((root && root.key) || ''),
          enabled: root && root.enabled !== false,
          defaultSource: root && root.defaultSource === true,
        }))
        .filter((root) => root.key !== '')
      const sources = sourceRows.map((root) => root.key)
      // 单条技能一行：`running` 取 core 那份策略表的实际启停。
      // 影子副本不进对账 —— 同名只有胜出者会被 core 加载，去启用副本等于白写一次；
      // 没有声明名的条目同理（键都对不上，写进去就是一条永远读不到的策略）。
      //
      // ⚠️ 键用**声明名**（`dsh/pdf-reader`），core 的启停 op 用**条目名 / 目录名**
      // （`pdf-skill`）。两者可以不同（SKILL.md 的 `name` 与文件夹名各写各的），
      // 把声明名传给 core 会得到「技能不存在: pdf-reader」（真机：重启后
      // 租约里的技能拉不起来）。界面的启停 op 收的是 `sk.name`，与这里同一个口径。
      const skillRows: Array<{ key: string; root: string; name: string; running: boolean }> = []
      for (const root of roots) {
        const rootKey = String((root && root.key) || '')
        if (rootKey === '') continue
        for (const sk of ((root && root.skills) || []) as any[]) {
          if (!sk || sk.shadowedBy) continue
          const name = String(sk.declaredName || sk.name || '')
          if (name === '') continue
          skillRows.push({ key: rootKey + '/' + name, root: rootKey, name: String(sk.name || name), running: sk.enabled === true })
        }
      }
      const claims = await leaseClaimsOf(servers, sources, skillRows.map((row) => row.key)).catch(() => ({
        mcp: new Map<string, string[]>(),
        skillSources: new Map<string, string[]>(),
        skills: new Map<string, string[]>(),
        mcpExplicit: new Map<string, string[]>(),
        sourceExplicit: new Map<string, string[]>(),
        skillExplicit: new Map<string, string[]>(),
        // 连扫描都没跑成 → 一切按"有痕迹"算（最保守的一档，见 `planReconcile` 的痕迹闸门）。
        traced: null,
      }))
      // 痕迹闸门：`traced === null` = 侧车没读出来，一律当有痕迹 ——
      // 宁可少采纳（运行态落回 claims>0），也不把某个会话留下的运行态提升成全局 `on`。
      const tracedOf = (domain: ScopeFlagDomain, key: string): boolean =>
        claims.traced === null || (claims.traced[domain]?.has(key) ?? false)
      const mcpDecisions = planReconcile(servers.map((server) => {
        const rows = byServer.get(server) || []
        return {
          key: server,
          intent: intentOf(intent, 'mcp', server),
          // 同名（project + global 各一台）任一行开着 = 整名开着（与会话覆盖按 serverName 键一致）。
          running: rows.some((row) => !row.disabled),
          claims: (claims.mcp.get(server) || []).length,
          explicitClaims: (claims.mcpExplicit.get(server) || []).length,
          traced: tracedOf('mcp', server),
        }
      }), { adoptExternal: opts.adoptExternal === true })
      const sourceDecisions = planReconcile(sourceRows.map((root) => ({
        key: root.key,
        intent: intentOf(intent, 'skillSources', root.key),
        running: root.enabled,
        claims: (claims.skillSources.get(root.key) || []).length,
        explicitClaims: (claims.sourceExplicit.get(root.key) || []).length,
        traced: tracedOf('skillSources', root.key),
      })), { adoptExternal: opts.adoptExternal === true })
      const skillDecisions = planReconcile(skillRows.map((row) => ({
        key: row.key,
        intent: intentOf(intent, 'skills', row.key),
        running: row.running,
        claims: (claims.skills.get(row.key) || []).length,
        explicitClaims: (claims.skillExplicit.get(row.key) || []).length,
        traced: tracedOf('skills', row.key),
      })), { adoptExternal: opts.adoptExternal === true })
      // ① 意图采纳（升级推断 / 外部改动）一次落盘。写失败不拦运行态 —— 下一轮会再试。
      const intentWrites: Array<{ domain: IntentDomain; key: string; state: IntentState }> = []
      for (const d of mcpDecisions) if (d.intentNext !== undefined) intentWrites.push({ domain: 'mcp', key: d.key, state: d.intentNext })
      for (const d of sourceDecisions) if (d.intentNext !== undefined) intentWrites.push({ domain: 'skillSources', key: d.key, state: d.intentNext })
      for (const d of skillDecisions) if (d.intentNext !== undefined) intentWrites.push({ domain: 'skills', key: d.key, state: d.intentNext })
      let finalIntent = intent
      if (intentWrites.length > 0) {
        const res = await intentStore.mutate((current) => {
          let next = current
          for (const write of intentWrites) next = withIntent(next, write.domain, [write.key], write.state)
          return next
        })
        if (res.ok) finalIntent = res.intent
        else report.failed.push({ domain: 'mcp', key: '*', error: '意图写入失败: ' + res.error })
      }
      const decisionOf = (list: typeof mcpDecisions, key: string) => list.find((d) => d.key === key)
      // ② 运行态：MCP 补丁。
      let mcpChanged = false
      for (const decision of mcpDecisions) {
        if (decision.runningNext === undefined) continue
        let okAll = true
        for (const row of byServer.get(decision.key) || []) {
          try {
            const r: any = await mcp.ops['mcpm-set-enabled']({ id: row.id, level: row.level, enabled: decision.runningNext })
            if (!r || r.ok === false) {
              okAll = false
              report.failed.push({ domain: 'mcp', key: decision.key, error: String((r && r.error) || '写补丁失败') })
            }
          } catch (e) {
            okAll = false
            report.failed.push({ domain: 'mcp', key: decision.key, error: message(e) })
          }
        }
        if (!okAll) continue
        mcpChanged = true
        ;(decision.runningNext ? report.started : report.stopped).push({ domain: 'mcp', key: decision.key })
      }
      const mcpIntentChanged = intentWrites.some((write) => write.domain === 'mcp')
      if (mcpChanged || mcpIntentChanged) {
        void mcp.stateCatalog.refresh().catch(() => { /* 下一轮对账还会再刷 */ })
        // 工具注册 / 注销、以及**意图变化**都要重排可见性：全局 off 之后，别的会话（含没有
        // 覆盖的新会话）必须立刻看不到这台服务器的工具 —— 连接还在跑（租约），但仅对认领者可见。
        mcp.scheduleToolRestrictions()
      }
      // ③ 运行态：技能来源。默认来源（dsh / hub）不能停用，core 会拒绝 —— 跳过。
      let sourceChanged = false
      for (const decision of sourceDecisions) {
        if (decision.runningNext === undefined) continue
        const root = sourceRows.find((row) => row.key === decision.key)
        if (root === undefined || root.defaultSource) continue
        try {
          const r: any = await skillsService.ops[decision.runningNext ? 'skill-source-enable' : 'skill-source-disable']({ root: decision.key })
          if (r && r.ok === false) {
            report.failed.push({ domain: 'skillSources', key: decision.key, error: String(r.error || '启用 / 停用来源失败') })
            continue
          }
          sourceChanged = true
          ;(decision.runningNext ? report.started : report.stopped).push({ domain: 'skillSources', key: decision.key })
        } catch (e) {
          report.failed.push({ domain: 'skillSources', key: decision.key, error: message(e) })
        }
      }
      // 来源与单条技能的目录重算合并到 ④ 之后一次做：两处各刷一次会让同一轮对账把
      // 每个会话的目录扫两遍（`refresh` 会换代并作废在飞的那一批）。
      // ④ 运行态：单条技能。这一格的策略表是**机器级**的 —— core 按进程发布
      //    官方 `skill` 工具只认那张表。所以"本对话开一条全局关着的技能"必须临时落进表里
      //    才加载得了；不落地就是目录写着有、真调用必拒的空头承诺。
      //    走**没被包过一层**的原始 op：包过的那条会先写意图再排对账，这里再调就自己跟自己打转。
      let skillChanged = false
      for (const decision of skillDecisions) {
        if (decision.runningNext === undefined) continue
        const row = skillRows.find((r) => r.key === decision.key)
        if (row === undefined) continue
        try {
          const r: any = await (decision.runningNext ? rawSkillEnable : rawSkillDisable)({ root: row.root, name: row.name })
          if (r && r.ok === false) {
            report.failed.push({ domain: 'skills', key: decision.key, error: String(r.error || '启用 / 停用技能失败') })
            continue
          }
          skillChanged = true
          ;(decision.runningNext ? report.started : report.stopped).push({ domain: 'skills', key: decision.key })
        } catch (e) {
          report.failed.push({ domain: 'skills', key: decision.key, error: message(e) })
        }
      }
      if (skillChanged || sourceChanged || intentWrites.some((write) => write.domain === 'skills' || write.domain === 'skillSources')) {
        // **不阻塞对账回执**（与来源那一格同一条）：这条链是 `scope-set` → 对账 →
        // 这里，等目录重算落地等于每次拨开关都多等一轮全量扫描。旧数据保留在缓存里，注入侧
        // 不会读到空，也就不会误发「已清空」；新清单晚一步到，下一轮注入自然带上。
        scheduleSkillCatalogRefresh()
      }
      // ④ 刷新租约的同步视图（注入 / 守卫 / 场景联动读它）。
      //    租约 = 最终运行态为开、意图不是 on、且真的有会话在认领。
      const nextMcpLeases = new Map<string, string[]>()
      for (const server of servers) {
        const decision = decisionOf(mcpDecisions, server)
        const rows = byServer.get(server) || []
        const running = decision && decision.runningNext !== undefined ? decision.runningNext : rows.some((row) => !row.disabled)
        const state = decision && decision.intentNext !== undefined ? decision.intentNext : intentOf(finalIntent, 'mcp', server)
        const list = claims.mcp.get(server) || []
        if (running && state !== 'on' && list.length > 0) nextMcpLeases.set(server, list)
      }
      mcpLeasesSync = nextMcpLeases
      const nextSourceLeases = new Map<string, string[]>()
      for (const root of sourceRows) {
        const decision = decisionOf(sourceDecisions, root.key)
        const running = decision && decision.runningNext !== undefined ? decision.runningNext : root.enabled
        const state = decision && decision.intentNext !== undefined ? decision.intentNext : intentOf(finalIntent, 'skillSources', root.key)
        const list = claims.skillSources.get(root.key) || []
        if (running && state !== 'on' && list.length > 0) nextSourceLeases.set(root.key, list)
      }
      sourceLeasesSync = nextSourceLeases
      // ⑤ 单条技能的租约：与上面两格同一条判据（运行着、意图不是 on、有会话在认领）。
      const nextSkillLeases = new Map<string, string[]>()
      for (const row of skillRows) {
        const decision = decisionOf(skillDecisions, row.key)
        const running = decision && decision.runningNext !== undefined ? decision.runningNext : row.running
        const state = decision && decision.intentNext !== undefined ? decision.intentNext : intentOf(finalIntent, 'skills', row.key)
        const list = claims.skills.get(row.key) || []
        if (running && state !== 'on' && list.length > 0) nextSkillLeases.set(row.key, list)
      }
      skillLeasesSync = nextSkillLeases
      return report
    }

    /**
     * 给 MCP 列表行补三个字段：`intent`（三态）/ `globalOn`（意图优先，运行态兜底）/
     * `leaseCount`（有几个别的会话在认领它）。
     *
     * 面板的全局开关必须读 `globalOn` 而不是 `disabled`：后者是运行态，租约期间两者不同 ——
     * 读 `disabled` 会把"全局关着、只为几个对话临时跑着"显示成"全局开着"。
     */
    /**
     * `leaseCount` **现算**：读的是此刻的会话清单，不是对账器上一次留下的
     * 内存 Map —— 后者在"会话被删除 / 归档 / 恢复"之后没人刷（那些操作不走插件的写 op）。
     */
    async function annotateMcpRows(result: any): Promise<any> {
      if (!result || result.ok === false) return result
      const intent = intentStore.snapshot()
      const rowsIn = ((result.rows || []) as any[])
      const names = [...new Set(rowsIn.map((row) => String((row && (row.serverName || row.id)) || '')).filter((name) => name !== ''))]
      const { scan } = names.length > 0 ? await scanClaimsOnce({ mcp: names }) : { scan: null }
      const rows = rowsIn.map((row: any) => {
        const name = String((row && (row.serverName || row.id)) || '')
        const state = intentOf(intent, 'mcp', name)
        // 全局开着（`on`）不是租约；统一关闭（`blocked`）压过一切会话层 —— 两种都不挂徽章。
        const leaseCount = state === 'on' || state === 'blocked' || scan === null ? 0 : (scan.claims.mcp.get(name) || []).length
        return {
          ...row,
          intent: state ?? null,
          globalOn: state === 'on' ? true : (state === 'off' || state === 'blocked') ? false : row.disabled !== true,
          leaseCount,
        }
      })
      return { ...result, rows }
    }

    /**
     * 技能清单的来源行：与 `annotateMcpRows` 同一套字段与口径（`globalOn` 是意图，不是运行态）。
     * `leaseCount` 同样**现算**。
     */
    async function annotateSkillState(result: any): Promise<any> {
      if (!result || result.ok === false) return result
      const intent = intentStore.snapshot()
      const rootsIn: any[] = (result.data && typeof result.data === 'object' ? (result.data.roots || []) : (result.roots || [])) as any[]
      const sourceKeys: string[] = []
      const skillKeys: string[] = []
      for (const root of rootsIn) {
        const key = String((root && root.key) || '')
        if (key !== '') sourceKeys.push(key)
        for (const sk of ((root && root.skills) || []) as any[]) {
          const name = String((sk && (sk.declaredName || sk.name)) || '')
          if (key !== '' && name !== '') skillKeys.push(key + '/' + name)
        }
      }
      const targets: ClaimScanTargets = {}
      if (sourceKeys.length > 0) targets.skillSources = sourceKeys
      if (skillKeys.length > 0) targets.skills = skillKeys
      const { scan } = Object.keys(targets).length > 0 ? await scanClaimsOnce(targets) : { scan: null }
      const leaseOf = (domain: ScopeFlagDomain, key: string, state: IntentState | undefined): number =>
        state === 'on' || state === 'blocked' || scan === null ? 0 : (scan.claims[domain].get(key) || []).length
      const decorate = (root: any): any => {
        const key = String((root && root.key) || '')
        const state = intentOf(intent, 'skillSources', key)
        // 单条技能也带上三件：界面上的「临时运行 · N 个对话」与"全局开着吗"
        // 都读这份，缺了它界面就会把租约期间的开着说成用户全局开过。
        const skills = ((root && root.skills) || []).map((sk: any) => {
          const name = String((sk && (sk.declaredName || sk.name)) || '')
          if (key === '' || name === '') return sk
          const skillKey = key + '/' + name
          const skillState = intentOf(intent, 'skills', skillKey)
          return {
            ...sk,
            intent: skillState ?? null,
            globalOn: skillState === 'on' ? true
              : (skillState === 'off' || skillState === 'blocked') ? false
                : sk.enabled !== false,
            leaseCount: leaseOf('skills', skillKey, skillState),
          }
        })
        return {
          ...root,
          skills,
          intent: state ?? null,
          globalOn: state === 'on' ? true : (state === 'off' || state === 'blocked') ? false : root.enabled !== false,
          leaseCount: leaseOf('skillSources', key, state),
        }
      }
      if (result.data && typeof result.data === 'object') {
        return { ...result, data: { ...result.data, roots: ((result.data.roots || []) as any[]).map(decorate) } }
      }
      return { ...result, roots: ((result.roots || []) as any[]).map(decorate) }
    }

    /**
     * 宿主**已知的全部**会话 id（含归档、含未挂回工作区的孤儿）—— 侧车 GC 的判据。
     *
     * 与 `scopeSessionRows` 的区别是这条**不做**"当前会话区成员"过滤：那一层过滤是下拉框的
     * 展示口径（列出来只会是一串同名条目），而 GC 要回答的是"宿主还认得这个会话吗"。
     * 拿展示口径去剪，会把"只是没挂回工作区"的会话当成已删除、连覆盖一起抹掉 —— 那不可恢复。
     *
     * 读不到 / 一条都没有时返回 `null`：不剪（读不到 ≠ 全被删了）。
     */
    async function liveSessionIds(): Promise<ReadonlySet<string> | null> {
      const registry = history.getSessionsRegistry()
      if (!registry || typeof registry.listStoredHeaders !== 'function') return null
      try {
        const headers = await registry.listStoredHeaders()
        const out = new Set<string>()
        for (const header of headers) {
          const id = header && typeof (header as { id?: unknown }).id === 'string' ? String((header as { id: string }).id) : ''
          // 子代理派生的会话不占用户会话列表（与 history-sessions 同一条过滤），
          // 但它们的覆盖本来也不会存在 —— 不放进集合只是让 GC 顺手清掉可能的残留。
          if (id !== '' && (header as { origin?: string }).origin !== 'subagent') out.add(id)
        }
        return out.size > 0 ? out : null
      } catch { return null }
    }

    /**
     * 下拉框的会话清单：**当前会话区里的**会话（与侧栏同源），带归档标记。
     *
     * "当前会话区" = 宿主工作区记账表里的会话成员：只读 `sessionIds` 并集。持久化目录里
     * 还有大量未挂回任何工作区的旧会话（同一目录重建登记后留下的孤儿），它们不在侧栏里，
     * 列进下拉只会是一串同名条目。归档标记照留：`scope-sessions-list` 用它滤掉，租约
     * 认领也按它跳过。
     *
     * 归档集合优先读**公开 getter** `archivedSessionIds`：`requireState()` 是宿主私有成员，
     * 缺它时整条归档判定会静默失效（所有归档会话都漏进下拉）。表格也按 `history-list`
     * 同一条取法（`requireState().workspaceIds` → `table.entries()`）兜底；两样都读不到时
     * 不按成员过滤，宁可多列也不把该显示的会话藏起来。
     */
    async function scopeSessionRows(): Promise<ScopeSessionRow[]> {
      const registry = history.getSessionsRegistry()
      if (!registry || typeof registry.listStoredHeaders !== 'function') return []
      const headers = await registry.listStoredHeaders()
      let archived = new Set<string>()
      try {
        const direct = (registry as { archivedSessionIds?: unknown }).archivedSessionIds
        if (Array.isArray(direct)) archived = new Set(direct.map((id) => String(id)))
        else {
          const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined
          if (state && Array.isArray(state.archivedSessionIds)) archived = new Set(state.archivedSessionIds.map((id) => String(id)))
          else archived = new Set((await registry.archivedSessionMetadata()).items.map((i) => String(i.sessionId)))
        }
      } catch { /* 归档集合读不到 → 全按未归档（宁可多列一条，也不把该显示的会话藏起来） */ }
      // 当前会话区成员（工作区记账表里的 sessionIds 并集）。
      let owned: Set<string> | null = null
      try {
        const table = typeof registry.requireTable === 'function'
          ? registry.requireTable() as { entries?(): Array<[string, { sessionIds?: readonly string[] }]>; get?(id: string): { sessionIds?: readonly string[] } | undefined }
          : undefined
        if (table) {
          const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined
          const ids = state && Array.isArray(state.workspaceIds) && state.workspaceIds.length
            ? state.workspaceIds.map((id) => String(id))
            : (typeof table.entries === 'function' ? [...table.entries()].map(([id]) => String(id)) : [])
          owned = new Set<string>()
          for (const wid of ids) {
            const rec = typeof table.get === 'function' ? table.get(wid) : undefined
            for (const sid of rec && Array.isArray(rec.sessionIds) ? rec.sessionIds : []) owned.add(String(sid))
          }
        }
      } catch { owned = null }
      const cache = ctx.get('sessionProjectionCache') as {
        cachedSnapshot?(header: unknown, keys?: string[]): { values?: Record<string, unknown> } | undefined
      } | undefined
      const headerIndex = registry.headers instanceof Map ? registry.headers : undefined
      const titleOf = (id: string, header: unknown): string | undefined => {
        if (!cache || typeof cache.cachedSnapshot !== 'function') return undefined
        // 先试宿主索引里的 header：持久化清单给的那份缺少投影缓存校验用的身份字段。
        for (const candidate of [headerIndex ? headerIndex.get(id) : undefined, header]) {
          if (candidate === undefined || candidate === null) continue
          try {
            const snap = cache.cachedSnapshot(candidate, ['title'])
            const title = snap && snap.values ? snap.values.title : undefined
            if (typeof title === 'string' && title !== '') return title
          } catch { /* 这一份不认，试下一份 */ }
        }
        return undefined
      }
      const rows: ScopeSessionRow[] = []
      for (const header of headers) {
        const id = header && typeof (header as { id?: unknown }).id === 'string' ? String((header as { id: string }).id) : ''
        if (id === '') continue
        // 子代理派生的会话不占用户会话列表（与 history-sessions 同一条过滤）。
        if ((header as { origin?: string }).origin === 'subagent') continue
        if (owned !== null && !owned.has(id)) continue
        const cwd = (header as { cwd?: unknown }).cwd
        const cwdText = typeof cwd === 'string' ? cwd : ''
        if (cwdText !== '') rememberSessionCwd(id, cwdText)
        const fallback = cwdText !== '' ? basename(cwdText) : id.slice(0, 8)
        // 归档标记照留：下拉把它滤掉，租约认领也按它跳过（归档会话不再占着连接）。
        rows.push({ id, title: titleOf(id, header) || fallback, count: 0, archived: archived.has(id), cwd: cwdText })
      }
      return rows
    }
    /**
     * 会话摘要（下拉框用）：真实标题 + 有没有过用户输入。
     *
     * 为什么直接读 `storages/session_projcache` 的文件：宿主的 `cachedSnapshot(header)`
     * 只对**已加载**的会话给值，冷会话读出来是空 —— 于是下拉里全是没标题的空壳
     * 。投影缓存文件是宿主自己在磁盘上的权威副本，布局稳定
     * （`record.rows.title.val` / `record.rows.titleInput.val.count`）。读不到就返回
     * undefined，调用方保留兜底标题、也不做空壳过滤。30 秒 TTL：自动起标题是低频动作。
     */
    const scopeSummaryCache = new Map<string, { at: number; value: { title?: string; hasMessages: boolean } | undefined }>()
    const SCOPE_SUMMARY_TTL_MS = 30000
    /**
     * 上限 200 条 LRU。此前只有 TTL 判断、**从不淘汰**：过期条目一直躺在 Map 里
     * 每个被下拉框看过的会话都留一条，长期运行的实例上这是无界增长（每条还攥着标题字符串）。
     * 键是会话 id，Map 保序 ⇒ 命中时移到队尾，头部就是最久没用的那条。
     */
    const SCOPE_SUMMARY_MAX = 200
    async function scopeSessionSummary(sessionId: string): Promise<{ title?: string; hasMessages: boolean } | undefined> {
      const hit = scopeSummaryCache.get(sessionId)
      if (hit !== undefined) {
        if (Date.now() - hit.at < SCOPE_SUMMARY_TTL_MS) {
          scopeSummaryCache.delete(sessionId)
          scopeSummaryCache.set(sessionId, hit)
          return hit.value
        }
        scopeSummaryCache.delete(sessionId)
      }
      let value: { title?: string; hasMessages: boolean } | undefined
      // 会话 id 要拼进路径，只认安全字符。
      if (/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
        try {
          const file = join(resolveDshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
          const record = (JSON.parse(await readFile(file, 'utf8')) as {
            record?: { rows?: Record<string, { val?: unknown }> }
          }).record
          const rows = record && record.rows ? record.rows : undefined
          if (rows !== undefined) {
            const titleRow = rows.title
            const title = titleRow && typeof titleRow.val === 'string' && titleRow.val !== '' ? titleRow.val : undefined
            const input = rows.titleInput ? rows.titleInput.val as { count?: unknown } | undefined : undefined
            const count = input && typeof input.count === 'number' ? input.count : undefined
            // titleInput 不在（老缓存）→ 按有内容算，宁可多列，不误藏。
            const hasMessages = title !== undefined || count === undefined || count > 0
            value = { ...(title !== undefined ? { title } : {}), hasMessages }
          }
        } catch { /* 文件不存在 / 解析失败：按取不到处理 */ }
      }
      scopeSummaryCache.set(sessionId, { at: Date.now(), value })
      while (scopeSummaryCache.size > SCOPE_SUMMARY_MAX) {
        const oldest = scopeSummaryCache.keys().next()
        if (oldest.done) break
        scopeSummaryCache.delete(oldest.value)
      }
      return value
    }

    /** 两份工具名名单是否同一份（顺序无关）。 */
    function sameToolNameList(a: readonly string[], b: readonly string[]): boolean {
      if (a.length !== b.length) return false
      const set = new Set(b)
      return a.every((name) => set.has(name))
    }

    /**
     * 回给界面的**会话层**工具表：这一层生效的关停名单 + 来源（本对话 / 创建时 / 全局兜底）。
     * 与全局那份同一形状（`hidden` / `presets` / `report`），界面不需要分两套读法。
     */
    function toolTableSessionPayload(sessionId: string, scope: SessionScope | undefined, settings: ToolTableSettings): any {
      // 只报注册过的名字：基线 / 方案里可能留着更早版本关停过、如今已不存在的工具。
      const hidden = sessionToolTableHidden(scope, settings.hidden).filter((name) => toolTableSizes.has(name))
      const source = scope?.toolTableHidden !== undefined
        ? 'session'
        : (scope?.baseline?.toolTableHidden !== undefined ? 'baseline' : 'global')
      return {
        ok: true,
        sessionId,
        scopeKind: isWorkspaceScopeKey(sessionId) ? 'workspace' : 'session',
        hidden,
        globalHidden: settings.hidden.slice(),
        presets: settings.presets,
        defaultHidden: [...DEFAULT_HIDDEN_TOOLS],
        report: toolTableReport(hidden),
        source,
        locked: scope?.locked === true,
        // 侧车 unknown：界面禁写并说明原因（会话覆盖也不该在"读不准全局"时落盘）。
        ...toolTableState(),
      }
    }

    /**
     * `tool-table` 的会话分支：
     *   · 带 `sessionId` 读 → 本对话生效名单；
     *   · 带 `sessionId` + `set` → **整份替换**本对话的名单（不写全局）；
     *   · 方案存 / 删仍是全局库，会话层直接拒绝（界面把入口置灰）。
     *
     * 为什么整份写、不做逐工具覆盖：工具表本来就以"关停名单"为真源，整份替换与
     * `tool-table.json` / 方案同一个形状；基线那份在退出场景时负责还原。
     */
    async function toolTableOpWithScope(args: any): Promise<any> {
      const rawId = String((args && args.sessionId) || '').trim()
      if (rawId === '') return toolTableOp(args)
      // 全局粒度：没有会话层可写。`scope-sessions-list` 那一档返回空表，界面也不会传出这一层；
      // 走到这里说明是旧调用 / 斜杠菜单的存量参数 —— 与其静默写进一个读不到的格子，不如说清。
      if (scopeMode() === 'global') {
        return { ok: false, error: '隔离已关闭（全局模式）：没有会话层可写。要改就改全局设置，或先把隔离粒度调成「按对话」/「按工作区」。' }
      }
      // 面板给的是当前层的键；斜杠 / 旧调用可能给真实 sessionId → 统一折到当前模式。
      const sessionId = await scopeKeyForId(rawId)
      const settings = await readToolTableSettings()
      // 侧车 unknown：会话覆盖也拒绝写入 —— 基线 / 全局兜底都读不准，落一份基于空表的
      // 覆盖只会把问题搬到会话层。读取（上面那次）仍按"上次成功值 → 出厂默认"服务。
      if (args && args.set === true && toolTableState().state === 'unknown') {
        return { ok: false, error: toolTableWriteError() }
      }
      let scope = scopeStore.scopeOfSync(sessionId)
      if (!args || args.set !== true) {
        // 方案库是全局的：会话层只负责"读这一层 / 应用一份方案"，不在这里存删。
        if (args && (args.presetSave !== undefined || args.presetDelete !== undefined)) {
          return { ok: false, code: 'globalOnly' }
        }
        return toolTableSessionPayload(sessionId, scope, settings)
      }
      if (scope?.locked === true) {
        const layer = isWorkspaceScopeKey(sessionId) ? '工作区' : '会话'
        return { ok: false, error: `${layer}「${scopeKeyLabel(sessionId)}」的作用域已锁定：先解锁再改` }
      }
      // 第一次写时补一份基线：退出场景要回到"这个对话创建时"的那份名单。
      if (scope?.baseline === undefined) {
        const baseline = await captureBaselineSnapshot().catch(() => null)
        if (baseline !== null) {
          try { await scopeStore.mutate(sessionId, (cur) => withBaseline(cur, baseline).scope) } catch { /* best effort */ }
          scope = scopeStore.scopeOfSync(sessionId)
        }
      }
      // 只收注册过的工具名：陌生名字会让官方 restrict 抛错。
      const target = normalizeToolTableSettings({ hidden: args.hidden }).hidden
        .filter((name) => toolTableSizes.has(name))
      // 老会话的基线里没有这一栏：第一次写时按**当前全局**补一份，
      // 否则退出场景会退回"实时全局"，与"每个对话从创建起有自己的那份"这条口径不符。
      const backfillBaselineTt = scope?.baseline !== undefined && scope.baseline.toolTableHidden === undefined
      const base = scope?.baseline?.toolTableHidden ?? (backfillBaselineTt ? settings.hidden : undefined)
      try {
        await scopeStore.mutate(sessionId, (cur) => {
          const out: SessionScope = { ...(cur === undefined ? {} : cur) }
          if (backfillBaselineTt && out.baseline !== undefined) {
            out.baseline = { ...out.baseline, toolTableHidden: settings.hidden.slice() }
          }
          // 与基线同值就不留显式名单：退出场景 / 全局再变时少一条永远相等的覆盖。
          if (base !== undefined && sameToolNameList(target, base)) delete out.toolTableHidden
          else out.toolTableHidden = target.slice()
          return Object.keys(out).length > 0 ? out : undefined
        })
      } catch (e) {
        return { ok: false, error: '保存失败: ' + message(e) }
      }
      mcp.scheduleToolRestrictions()
      // 同上：会话工具表保存也不等两个目录重算。
      scheduleSkillCatalogRefresh()
      void subagentCatalog.refresh().catch(() => { /* 同上 */ })
      scope = scopeStore.scopeOfSync(sessionId)
      return toolTableSessionPayload(sessionId, scope, settings)
    }

    // 更新检查：只读、后台预热、绝不自动更新。宿主版本在**请求时**才探测 ——
    // 启动期做一次全量能力探测不划算，而且探测结果本来就可能随装配阶段变化。
    // 缓存落 hub 根，`update-status` 与启动预热共用同一个 in-flight 请求。
    const updateChecker = createUpdateChecker({
      stateDir: hubPath(),
      current: PKG_VERSION,
      currentEngines: PKG_DSH_RANGE,
      hostVersion: () => {
        try {
          const registry = history.getSessionsRegistry()
          const capabilities = registry && typeof registry.capabilities === 'function' ? registry.capabilities() : undefined
          return capabilities && capabilities.identity ? String(capabilities.identity.version || '') : null
        } catch { return null }
      },
      profile: () => cached?.profileName,
    })
    // 预热不 await：更新检查失败（无网 / 代理 / registry 故障）不影响任何启动路径。
    updateChecker.start()

    const handlers: Record<string, (args: any) => Promise<any>> = {
      'plugin-version': pluginVersion,
      // 「最近改动」流水的读侧：只读 hub 里的 `audit.jsonl`，倒序、可按域过滤。
      'audit-list': async (args: any) => ({ ok: true, entries: await readAudit(args || {}) }),
      // 清空流水。清完这一条 op 自己会被下面的包装层记进新流水（"谁清过"也留痕）。
      'audit-clear': async () => await clearAudit(),
      'skill-open': skillOpen,
      // MCP 域 17 个 op（实现在 ./mcp/manager.ts）
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
        updateChecker,
        getSessionsRegistry: history.getSessionsRegistry,
        tools,
        readInjectSettings,
        injectSettingsOp,
        readSlashSettings,
        toolTableOp: (args: any) => toolTableOpWithScope(args),
        toolTableReport: () => toolTableReport(),
        // 先读一次：预热前 state 是乐观的 'ok'，而这一行要回答的是"文件现在能不能读"。
        toolTableState: async () => { await readToolTableSettings(); return toolTableState() },
        presetRoster: candidates.presetRoster,
        listPatchBackups,
        cleanPatchBackups,
        getContextInjectorLive: () => contextInjectorLive,
        // 功能总览的三层合成：令牌实况与兼容页「访问令牌」同源；场景锁定与写门禁同源；
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
      // history-export-defaults / dir-list /
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
        extractTurnsFromEvents: extractExportTurns,
        serializeTurns: serializeTranscript,
      }),
      // 回收站保留期（ops/trash-retention.ts）：trash-retention-get（只读）/
      // trash-retention-set（写 + 冻结；成功后立即扫一次，见该文件文件头）。
      // 清扫本身**不在这里**——它是引擎的后台动作，由 trashRetention 域自己挂启动与周期。
      ...buildTrashRetentionOps({
        read: trashRetention.read,
        write: trashRetention.write,
        sweep: trashRetention.sweep,
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
        // 会话同步：改名 / 删除发生在场景层，停在里面（或引用它）的会话要跟着走。
        onSceneRenamed: (from, to) => syncSessionsForSceneRename(from, to),
        onSceneRemoved: (name) => syncSessionsForSceneRemoval(name),
        onToolTablePresetChanged: async (scene: string, value: string) => {
          // 「修改场景」里改绑工具表方案且改的是**当前启用场景** → 立即把关停名单整体换成
          // 那一份（与「改档案 = 立刻生效」同口径）。解绑（''）按下拉里的承诺 =「保持现状」，
          // 运行时不动；悬空绑定（方案已删）也不在这里硬失败，交给引擎进出场景时的 stale 处理。
          //
          // 会话层：工具表是按对话的一份，停在**这个场景**里的会话各自
          // 也有一份抄下来的名单 —— 与全局模式无关，先把它们一起换掉。
          if (value) await syncSessionsForSceneToolTable(scene, value)
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
        readDisabledToolsResult: mcp.readDisabledToolsResult,
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
      // 侧栏入口的开关（读 / 写）：客户端 boot 时读一次决定注不注册侧栏那一行，兼容页那颗
      // 按钮写一次。同 `slash-settings`：按写门禁但不冻结（见 sidebar-settings.ts）。
      'sidebar-settings': (args: any) => sidebarSettingsOp(args),
      // 会话作用域五条（ops/scope.ts）：scope-get / scope-set / scope-clear /
      // scope-sessions-list / scope-lock。**都不冻结** —— 场景锁冻结的是全局写入，
      // 而这里改的是叠加在全局之上的会话视图（理由见 ops/scope.ts 文件头）。
      // 全局快照与真值同源：场景取 `rules-list` 的 activeScene，技能取 `skill-state` 的
      // enabled，人设取 `subagent-list` 的 enabled，快捷词取 `quickprompt-list` 的 enabled，
      // MCP 取补丁层的启停（`configuredServerStates`，与界面开关同一份真值；不是逐工具停用表）。
      // **一处读失败只让那一域空着**（= 没有全局开着的项），不整体失败：读不到全局时把覆盖
      // 判成"等于全局"会让覆盖被误清。
      ...buildScopeOps({
        store: scopeStore,
        // 真实 sessionId（斜杠菜单 / 旧调用）→ 当前模式的作用域键；面板传的 `ws:` 键原样。
        resolveKey: (idOrKey) => scopeKeyForId(idOrKey),
        mode: () => scopeMode(),
        // 切换粒度后：可见性层、两个目录、租约都要按新键重算一遍（与写覆盖后的通知同一条出口）。
        onModeChanged: (_mode) => {
          mcp.scheduleToolRestrictions()
          scheduleSkillCatalogRefresh()
          void subagentCatalog.refresh().catch(() => { /* 同上 */ })
          void enqueueScopeReconcile({ adoptExternal: false }).catch(() => { /* 面板下一次刷新还会再对 */ })
        },
        global: () => scopeGlobalSnapshotShared(),
        sessions: () => scopeSessionRows(),
        summaryOf: (id) => scopeSessionSummary(id),
        // 场景档案（同步）：场景层按它实时计算（档案改了，下一个请求就跟着变）。
        sceneArchiveOf: (scene) => memoriesService.sceneArchiveOf(scene),
        // 模型工具表：进场景时把绑定方案套到**本对话**；注册表用来滤掉历史名字。
        toolTablePresetHidden,
        toolTableAvailable: () => toolTableSizes,
        sceneExists: async (name) => {
          const r: any = await memoriesService.ops['rules-list']({})
          return !!(r && r.ok !== false && (r.scenes || []).some((s: any) => String(s.name) === name))
        },
        // 写会话覆盖 / 意图之后的意图对账：运行态 := 意图 ∪ 租约（见 reconcileScopeResourcesOnce）。
        reconcile: (opts) => enqueueScopeReconcile(opts),
        // 全局意图写入（scope-intent-set）：只写侧车，运行态交给对账器。
        writeIntent: async (domain, keys, state) => {
          const res = await intentStore.mutate((current) => withIntent(current, domain, keys, state))
          return res.ok ? null : res.error
        },
        // 基线：会话**创建时**的冻结快照 —— 启动期与 agent/created 各调一次（`ensureBaselineFor`）。
        captureBaseline: () => captureBaselineSnapshot(),
        // 会话提示词：应用前读一次正文（校验存在性 + 拒绝空预设）
        // scope-get 的预填走同一条解析链（含场景预设 / AGENTS.md 退化）。
        presetContent: async (id) => {
          const r: any = await promptOps['agentsmd-read']({ id })
          return r && r.ok !== false && typeof r.content === 'string' ? String(r.content) : null
        },
        promptTextOf: (sessionId) => sessionPromptTextOf(sessionId),
        // 首次写会话提示词前把冻结快照补上（面板可能先于第一条消息打开，注入侧还没捕获过）。
        ensurePromptBaseline: (sessionId) => ensurePromptBaseline(sessionId),
        // MCP 覆盖改的是「本会话可见的工具」—— 写侧不重排的话，官方 restrict 层要等下一次
        // 无关的 tools/change 才跟上（拨回开关后模型那边仍看不到工具）。其余域由各自的
        // 注入目录按每次 step 读取，不需要通知。
        onChanged: (_sessionId, domain) => {
          if (domain === 'mcp' || domain === 'mcpTools' || domain === 'scene' || domain === 'toolTable' || domain === '') mcp.scheduleToolRestrictions()
          // 工具表换了（进场景套方案 / 会话层改名单 / 清掉）→ 两个目录里那句
          // 「用 `X_manager_list` 查」得跟着重算，否则会点名一条本对话没有的工具。
          if (domain === 'scene' || domain === 'toolTable' || domain === '') {
            scheduleSkillCatalogRefresh()
            void subagentCatalog.refresh().catch(() => { /* 同上 */ })
          }
        },
        message,
      }),
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
          // 隔离守卫：本进程没触发过隔离时，磁牌文件是唯一线索（重启后即如此）。
          indexQuarantined: async () => {
            try { return await readQuarantineMarker(hubRoot()) } catch { return null }
          },
          // MCP 重启中断：pid 活着 = 那次重启可能还在跑，如实报 alive
          // 由体检那边决定算不算问题。
          mcpRestartPending: async () => {
            try {
              const marker = await readMcpRestartMarker()
              if (!marker) return null
              return {
                server: marker.server, level: marker.level, phase: marker.phase,
                pid: marker.pid, alive: processAlive(marker.pid),
              }
            } catch { return null }
          },
        })
        return { ok: true, ...report }
      },
      // 诊断包：只读、纯文本、**白名单字段**。不含密钥 / 正文 / 日志内容 ——
      // 令牌只报"配没配 / 这次生效没有"，侧车只报存在性、大小与时间。
      // 直接复用同一次装配里的只读 op（compat-status / state-doctor），不另写一份探测。
      'diagnostics': async () => {
        const safe = async <T>(read: () => Promise<T>): Promise<T | null> => {
          try { return await read() } catch { return null }
        }
        const compat = await safe(async () => handlers['compat-status']({}))
        const doctor = await safe(async () => handlers['state-doctor']({}))
        const rules = await safe(async () => memoriesService.ops['rules-list']({}))
        const presets = await safe(async () => promptsService.list())
        const personas = await safe(async () => subagentService.list())
        const skills = await safe(skillStates)
        const mcpRows = await safe(async () => mcp.mcpmListView())
        const quarantine = await safe(async () => readQuarantineMarker(hubRoot()))
        const toolTable = await safe(async () => { await readToolTableSettings(); return toolTableState() })

        const sidecarNames = [
          'memories-index.json', 'mcp-disabled-tools.json', 'tool-table.json',
          'scope-overrides.json', 'scope-intent.json',
          'inject-settings.json', 'scene-settings.json', 'slash-settings.json', 'sidebar-settings.json',
          'mcp-notes.json', 'mcp-settings.json', 'mcp-known-tools.json',
          'subagents-index.json', 'skills-state.json', 'mount.json', 'audit.jsonl',
        ]
        const sidecars: DiagnosticsSidecar[] = []
        for (const name of sidecarNames) {
          const abs = hubPath(name)
          let bytes: number | null = null
          let mtime: string | null = null
          let exists = false
          try {
            const st = await stat(abs)
            exists = st.isFile()
            bytes = exists ? st.size : null
            mtime = exists ? st.mtime.toISOString() : null
          } catch { /* 不存在或读不到：下面按状态区分 */ }
          let state: DiagnosticsSidecar['state'] = exists ? 'present' : 'missing'
          if (name === 'memories-index.json') {
            if (quarantine) state = 'corrupt'
            else if (exists) state = 'ok'
          } else if (name === 'mcp-disabled-tools.json') {
            const issue = mcp.disabledToolsIssue()
            state = issue ? issue : (exists ? 'ok' : 'missing')
          } else if (name === 'tool-table.json') {
            state = toolTable && toolTable.state === 'unknown' ? (toolTable.issue || 'unreadable') : (exists ? 'ok' : 'missing')
          }
          sidecars.push({ name, state, bytes, mtime })
        }

        const counts: Record<string, number> = {}
        if (rules && rules.ok !== false) {
          counts['场景'] = Array.isArray(rules.scenes) ? rules.scenes.length : 0
          counts['记忆'] = Array.isArray(rules.rules) ? rules.rules.length : 0
        }
        if (presets && presets.ok !== false) counts['提示词'] = Array.isArray(presets.presets) ? presets.presets.length : 0
        if (Array.isArray(personas)) counts['人设'] = personas.length
        if (skills) counts['技能'] = Object.keys(skills).length
        if (mcpRows && mcpRows.ok !== false) counts['MCP'] = Array.isArray(mcpRows.rows) ? mcpRows.rows.length : 0

        let auditBytes: number | null = null
        try { auditBytes = (await stat(hubPath('audit.jsonl'))).size } catch { auditBytes = null }

        const update = updateChecker.peek()
        const text = buildDiagnostics({
          pluginVersion: PKG_VERSION,
          hostVersion: compat && compat.host ? String(compat.host.version || '') || null : null,
          verifiedVersion: compat ? String(compat.verifiedVersion || '') || null : null,
          platform: { os: process.platform, node: process.version },
          dataDir: hubRoot(),
          token: { configured: CONFIG_TOKEN !== '', active: TOKEN !== '' },
          update: update
            ? { status: update.status, current: update.current, bestCompatible: update.bestCompatible }
            : null,
          compat: compat
            ? {
              findings: Array.isArray(compat.findings) ? compat.findings.length : 0,
              degraded: Array.isArray(compat.degraded) ? compat.degraded.length : 0,
              blockers: Array.isArray(compat.blockers) ? compat.blockers : [],
              unverified: Array.isArray(compat.unverified) ? compat.unverified : [],
              separateCopies: Object.keys(compat.sameAsHost || {}).filter((k) => (compat.sameAsHost || {})[k] === false),
            }
            : null,
          sidecars,
          counts,
          log: { path: hubPath('audit.jsonl'), bytes: auditBytes },
          doctor: doctor && doctor.ok !== false
            ? { findings: Array.isArray(doctor.findings) ? doctor.findings : [], skipped: Array.isArray(doctor.skipped) ? doctor.skipped : [] }
            : null,
        })
        return { ok: true, text }
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

    // 场景锁定查询（抽到 ./request-gate.ts）：读 rules-list 得到锁定场景与当前场景。
    // 场景锁与「当前场景」的**共享读缓存**。
    //
    // 为什么必须有：`annotateLocked`（request-gate.ts）给 5 个列表 op 的响应补
    // `anyLocked` / `activeScene`，它要**同时**问 `lockedSceneNames()` 与
    // `activeSceneName()` —— 而这两个函数在 `createSceneLock` 里各调一次
    // `readSceneList()`，也就是**每个列表 op 都把 `rules-list` 整跑两遍**
    // （`buildSnapshot` 扫全部记忆文件 + 整份 `memories-index.json` 落盘）。
    // 实测（web 端）：`skill-state` 冷启 3.4s / 热启 7ms，而 `state()`
    // 单独跑只要 106ms —— 差额主要就是这两遍重复读，且它压在每一个热门列表 op 上
    // （skill-state / mcpm-list / agentsmd-list / subagent-list / mcpm-reveal）。
    //
    // TTL 取 1000ms，与 `skills/service.ts` 的 `STATE_TTL_MS` 同一条：都只影响
    // 「同一窗口内重复问同一份只读现状」，而任何**写**路径之后都不读它 ——
    // 锁定/场景变化由写操作自己触发（`rules-scene-lock` / `rules-set-active` 等
    // 都会走到 `refresh()`），下一次读自然是新值。并发吃同一个 in-flight promise，
    // 不会因为加缓存变成 N 次磁盘读。
    const SCENE_FACTS_TTL_MS = 1000
    let sceneFacts: { at: number; value: Promise<any> } | null = null
    function readSceneFacts(): Promise<any> {
      if (sceneFacts && Date.now() - sceneFacts.at < SCENE_FACTS_TTL_MS) return sceneFacts.value
      const value = memoriesService.ops['rules-list']({})
      // 失败也进缓存（短 TTL）：连续 5 个列表 op 撞同一次故障时，不该把磁盘读放大 5 倍。
      value.catch(() => undefined)
      sceneFacts = { at: Date.now(), value }
      return value
    }
    const { lockedSceneNames, activeSceneName, lockedSceneGuard } = createSceneLock({
      readSceneList: () => readSceneFacts(),
    })

    // ---------- 场景内改开关 = 同步改档案 ----------
    /**
     * 用户要求：场景**未锁定**时，页面上的开关（MCP / 技能 / 子智能体 / 提示词）
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
        const r: any = await rawSkillState({})
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
        const r: any = await rawSkillState({})
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
      // 停用表 unknown：这个函数的返回值会被**写进场景档案**。此时既不能报"全部启用"
      // （空数组 = 全部停用，正是旧的错误结果），也不能猜 —— 直接抛，让这一笔同步失败，
      // 由档案同步的回执如实告诉用户（见 syncSceneArchive 的 catch）。
      const read = await mcp.readDisabledToolsResult()
      if (read.status === 'corrupt' || read.status === 'unreadable') {
        throw new Error('MCP 停用表状态不可读，无法把「全部工具」具化成名单（本笔未写入档案）')
      }
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
     * **串行闸门**：档案是「读 → 改 → 写」三步，而撤销是**并发**发的
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
      // （用真实产物复现）。反向更糟：启用一个来源会被同步成「把该来源下的
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
          case 'scope-intent-set': {
            // 全局意图改的是"这个场景下开着哪些东西"本身：MCP 段按服务器名勾选，
            // 来源段按"来源下可生效的技能"并入 / 清出（与来源开关同一条反推口径）。
            const domain = String((args && args.domain) || '')
            const state = String((args && args.value) || '')
            const keys: string[] = Array.isArray(args && args.keys)
              ? (args.keys as unknown[]).map((key) => String(key))
              : (args && args.key !== undefined && String(args.key) !== '' ? [String(args.key)] : [])
            if (domain === 'mcp') {
              const mcpSection = { ...((next.mcp && typeof next.mcp === 'object') ? next.mcp : {}) }
              for (const server of keys) {
                if (state === 'on') mcpSection[server] = '*'
                else delete mcpSection[server]
              }
              next.mcp = mcpSection
            } else if (domain === 'skillSources') {
              let list: string[] = Array.isArray(next.skills) ? next.skills.slice() : []
              for (const root of keys) {
                const rootKeys = await skillArchiveKeysOfRoot(root)
                const pick = state === 'on' ? rootKeys.selectable : rootKeys.all
                if (state === 'on') {
                  for (const key of pick) if (list.indexOf(key) < 0) list.push(key)
                } else {
                  const drop = new Set(pick)
                  list = list.filter((key) => !drop.has(key))
                }
              }
              next.skills = list
            }
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

    // handlers 后处理（抽到 ./request-gate.ts）：场景锁定守卫、开关同步档案、
    // 读 op 的 anyLocked/activeScene 注解、子智能体失败清单 attach。
    // 顺序即语义（先装的在内层），整段搬运未改。
    //
    // 整机迁移快照在门禁装好**之前**并入 handlers：它自己不写任何域的数据，
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
    // MCP 列表的两个视图补上意图 / 租约字段（见 annotateMcpRows）。放在 installHandlerGuards
    // 之前：冻结 / 档案同步 / 锁定标注那几层包的是最终这一份。
    for (const opName of ['mcpm-list', 'mcpm-reveal'] as const) {
      const original = handlers[opName]
      if (typeof original === 'function') handlers[opName] = async (args: any) => annotateMcpRows(await original(args))
    }

    installHandlerGuards({
      handlers,
      lockedSceneNames,
      activeSceneName,
      syncSwitchToScene,
      subagentToolFailures,
    })

    // 场景事实缓存的主动失效：锁定 / 切换 / 建档改档一旦成功，1s TTL 内的旧结论
    // （「没有锁定」「旧的活动场景」）不能再被冻结门禁与 anyLocked 注解读到 ——
    // TTL 只为合并同一拍的重复读，不该吞掉刚发生的写。
    for (const opName of ['rules-scene-lock', 'rules-set-active', 'rules-create-scene', 'rules-update-scene', 'rules-remove-scene', 'scene-archive-save', 'scene-mode-set']) {
      const original = handlers[opName]
      if (typeof original !== 'function') continue
      handlers[opName] = async (args: any) => {
        const res = await original(args)
        if (res && res.ok !== false) sceneFacts = null
        return res
      }
    }

    // A1 的"机器那一边"：拿**真实** op 表与 `./op-registry.ts` 对账，四个方向都查（未归类 /
    // 幽灵条目 / serviceWrite 与 service 自报分叉 / 只读与写自相矛盾）。
    // 为什么值得在启动期花这一次遍历：门禁失守的症状从来不是报错，而是"没配令牌也能写"或
    // "锁定的场景能被改"（这条纪律已经失守过四次）。少一个 op 没登记，这里当场
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
     * 直接撞 "Excessive stack depth comparing types"。断言成宿主自己的类型之后，
     * 14 个调用点的参数表推断与改造前**完全一致** —— 宿主改签名时该报错的地方照旧报错；
     * 包装体本身只是转发（参数收 `unknown`、原样交给宿主），不参与推断，也就没有可失效的类型。
     */
    const hostDefineToolAny = hostDefineTool as unknown as (options: unknown) => ToolDefinition
    const defineTool = ((options: unknown): ToolDefinition =>
      trackAdoption(hostDefineToolAny(options))) as unknown as typeof hostDefineTool

    // 各域共用的那一份依赖（形状见 tools/deps.ts）。defineTool 带着遥测一起传下去 ——
    // 各域必须用它，直接 import 宿主的那个会丢掉采纳统计。
    /**
     * 「最近改动」流水的模型侧挂点。
     *
     * 为什么包在**交给工具的 op 表**上而不是散进每个 op：op 执行有多条入口路径（HTTP 路由、
     * 模型工具的 execute、场景引擎），而判断「谁干的」这件事只有调用点知道 —— 在 op 里自己猜
     * 调用方就是猜。这里给工具看到的表包一层，界面上 handlers 表那份原样不动，两条路各记各的。
     * 只多记一条流水：不改行为、不改返回值、也不吞异常（写类与成败的判据在 ./audit-log.ts）。
     */
    /**
     * **模型侧的冻结闸**：与 HTTP handlers 用同一个判据函数。
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
      //
      // 同一行里登记 `selfToolNames`：六个域的构建器全部经这个漏斗，所以它就是"本插件注册了
      // 哪些工具"的权威清单。`tools.register` 抛（重名 / 保留名）时不登记 —— 那份不在表里，
      // 也不该出现在「工具限制」的候选里。
      register: (def: ToolDefinition) => { recordToolSize(def); tools.register(def); selfToolNames.add(String(def.name)) },
      lockedSceneGuard,
      syncSwitchToScene,
      // 错误句与回执里点名工具前要先问一句：工具表按作用域各一份，还要算上该 agent 的
      // 工具限制（人设 `toolsDeny`）。与注入侧 `injectHiddenToolsFor` 同一个函数。
      toolVisibleFor: (name: string, agent: unknown) => toolVisibleFor(name, agent),
      reachNoticeForAgent,
      presetRoster: candidates.presetRoster,
      injectNoticeOptions,
      message,
      // 当前隔离粒度：写类工具据此决定 `scope` 的**默认值**。`global` 粒度下
      // 会话层不存在，省略 scope 的写入必须落到全局 —— 见 `effectiveScope`。
      scopeMode: () => scopeMode(),
      // 会话层：写类工具**默认写会话**，`scope: "global"` 才走各域原路径。
      // 这里只提供"改本会话这一条"的窄接口 —— 自动清除 / 会话锁 / 侧车落盘的判定都在
      // ops/scope.ts 那一份实现里，工具不重复实现。
      sessionScopeSet: (agent: unknown, domain: any, key: string, value: any) => {
        const sessionId = scopeKeyForAgent(agent)
        if (sessionId === null) return Promise.resolve({ ok: false, error: 'no session id on this agent: cannot write a per-conversation switch' })
        // `scene` 走 `value`（场景名 / null），其余各域走 `key` + `value` —— 与 `scope-set` op
        // 的入参形状逐字对齐，不在这里再造一套（再造一套就是两份会分叉的协议）。
        const args = domain === 'scene' ? { sessionId, domain, value } : { sessionId, domain, key, value }
        return handlers['scope-set'](args) as Promise<{ ok: boolean; cleared?: boolean; warnings?: string[]; error?: string }>
      },
      // 全局意图：模型工具的 `scope: "global"` 走这里，不再直接改补丁 / 来源状态。
      // 场景档案的同步由工具自己调 `syncSwitchToScene('scope-intent-set', …)`（与面板同一条）。
      scopeIntentSet: (domain: 'mcp' | 'skillSources', keys: string[], value: 'on' | 'off' | 'blocked') =>
        handlers['scope-intent-set']({ domain, keys, value }) as Promise<{ ok: boolean; warnings?: string[]; error?: string; sceneSyncError?: string }>,
      // 读侧那一半：列表工具按会话取数据（项目技能根按会话 cwd）+ 标出本会话的
      // 逐条开关。与写侧同一个 store，读到的永远是刚写进去的那一份（TTL 300ms 只对外部改文件生效）。
      sessionScope: (agent: unknown) => {
        const sessionId = scopeKeyForAgent(agent)
        if (sessionId === null) return null
        return { sessionId, scope: scopeStore.scopeOfSync(sessionId) }
      },
      // 某一格的**四层并值**：列表类工具逐条问它（undefined = 落到该域的全局值）。
      sessionFlagOf: (agent: unknown, domain: any, key: string) => {
        const resolver = flagResolverOfAgent(agent, domain)
        return resolver === undefined ? undefined : resolver(key)
      },
    }
    const mcpToolOps = auditOps(mcp.ops)
    buildMcpTools({
      ...toolDeps,
      // 会话层：本会话隐藏的服务器在清单里与全局停用同形（默认不列、all=true 标注）。
      // 逐行问谓词 —— 行数组就是全集（判据：覆盖 → 场景层 → 基线）。
      sessionHiddenServer: (agent: unknown, serverName: string) => sessionServerHiddenOf(agent, serverName),
      // 模型侧也读意图（`globalOn` / `intent` / `leaseCount`）：它看到的"全局开着"必须与用户
      // 面板一致，而不是租约拉起后的运行态。
      mcpmListView: async () => annotateMcpRows(await mcp.mcpmListView()),
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
    // 场景的提示词绑定。
    const applyPresetForModel = async (id: string) => {
      const denied = await frozenGate('agentsmd-apply', { id })
      return denied ? { ok: false as const, error: denied } : applyPresetGuarded(id)
    }
    // 取消应用同理：`agentsmd-unapply` 在冻结清单里，模型侧不经 op 表直调就要在这里显式过
    // 冻结闸（与 apply 同一形状）—— 少了这一层，锁着场景时模型仍能撤掉当前基线。
    const unapplyPresetForModel = async () => {
      const denied = await frozenGate('agentsmd-unapply', {})
      return denied
        ? { ok: false as const, error: denied }
        : (promptOps['agentsmd-unapply'] as () => Promise<{ ok: boolean; error?: string; removed?: boolean }>)()
    }
    buildPromptTools({ ...toolDeps, promptOps: auditOps(promptOps), applyPresetGuarded: applyPresetForModel, unapplyPreset: unapplyPresetForModel, promptsDir })
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
      rulesOps: {
        ...auditOps(memoriesService.ops),
        // 模型改场景记录也要走 handlers 里那份包装（buildSceneSyncOps）：`scene_manager_save`
        // 会经 `rules-create-scene` 改写 / 解绑**当前启用场景**的提示词，直调原 op 会静默漏掉
        // AGENTS.md 同步与工具表 / 快捷词即时生效（与下面 `sceneActivate` 同一条纪律）。
        'rules-create-scene': auditFn('rules-create-scene', (args: any) => handlers['rules-create-scene'](args)),
        'rules-update-scene': auditFn('rules-update-scene', (args: any) => handlers['rules-update-scene'](args)),
      },
      archiveOps: {
        ...auditOps(archiveService.ops),
        // 模型把工具表方案写在**档案**里（不经 `rules-update-scene` 的绑定回调）：
        // 已经停在这个场景里的会话会一直按旧名单。保存前记下旧绑定，成功且确实变了时补一次
        // 会话同步（与面板改绑同一条路）。没变就不动 —— 会话里手动调整过的名单不该被一次
        // 无关保存覆盖。
        'scene-archive-save': auditFn('scene-archive-save', async (args: any) => {
          const scene = String((args && args.scene) || '')
          const archive = args && args.archive && typeof args.archive === 'object' ? args.archive : null
          const hasPreset = archive !== null && Object.prototype.hasOwnProperty.call(archive, 'toolTablePreset')
          const nextPreset = hasPreset ? String(archive.toolTablePreset || '') : ''
          let prevPreset = ''
          if (hasPreset && scene !== '') {
            try { prevPreset = String(memoriesService.sceneArchiveOf(scene)?.toolTablePreset || '') } catch { prevPreset = '' }
          }
          const res: any = await archiveService.ops['scene-archive-save'](args)
          if (hasPreset && scene !== '' && nextPreset !== '' && nextPreset !== prevPreset && res && res.ok !== false) {
            await syncSessionsForSceneToolTable(scene, nextPreset).catch(() => { /* 下次进 / 退场景会对齐 */ })
          }
          return res
        }),
      },
      sceneActivate: auditFn('rules-set-active', (args: any) => handlers['rules-set-active'](args)),
    })
    buildSubagentTools({
      ...toolDeps,
      // 只换掉工具看到的 `ops` 那一层（原型链回真实服务，其余读法一字不动）。
      subagentService: Object.assign(Object.create(subagentService), { ops: auditOps(subagentService.ops) }),
      sceneLists: subagentSceneLists,
      toolFilterFor: subagentToolFilterFor,
      // 会话层：四层并值 —— 本会话关掉的人设看不见、也调不动；显式开着的
      // （含场景绑定的排除项被救回来的那些）看得见、调得动。
      subagentFlagFor: (exec: unknown) => flagResolverOfAgent((exec as { agent?: unknown } | null)?.agent, 'subagents'),
      // 原始覆盖表只给列表那句"显式关了几条"的统计用。
      subagentOverridesFor: (exec: unknown) => {
        const scopeId = scopeKeyForAgent((exec as { agent?: unknown } | null)?.agent)
        return scopeId === null ? undefined : scopeStore.scopeOfSync(scopeId)?.subagents
      },
      failures: subagentFailures,
    })
    // 删除 / 回收站族（tools/remove.ts）：五个域各一条 `*_manager_remove`。
    // 此前模型只能停用、不能删除。删除一律进回收站（可恢复）；**不做永久删除**（低频且
    // 不可恢复，留给面板）。`sceneRemove` 传 handlers 里那份（`withAgentsMdSync` 包过），
    // 与 `sceneActivate` 同一条纪律：直调 `memoriesService.ops` 会静默漏掉 AGENTS.md 那一步。
    buildRemoveTools({
      ...toolDeps,
      memoryOps: auditOps(memoriesService.ops),
      skillOps: auditOps(skillsService.ops),
      subagentOps: auditOps(subagentService.ops),
      promptOps: auditOps(promptOps),
      // 场景回收站（`scene-trash-list` / `scene-trash-restore`）在 **memoriesService** 的 op 表里
      // （`archiveService` 只有 scene-mode-get / -set / scene-archive-save 三条）。
      sceneOps: auditOps(memoriesService.ops),
      sceneRemove: auditFn('rules-remove-scene', (args: any) => handlers['rules-remove-scene'](args)),
    })

    if (typeof ctx.on === 'function') {
      // 三个确认门的统一前裁决。口径（方案 B）：会话审批策略为 never（「完全权限」预设）
      // = 用户已在预设层面预先批准一切确认门，**直接放行**并写审计日志留痕。
      // 不能把 ask 丢给审批层：宿主 decide() 对 never 直接返回 rejected（fail-closed），确认卡
      // 永远弹不出，模型只会收到一句无信息量的「用户拒绝」。这与官方子代理工具（无 ask 门）
      // 在完全权限下的行为一致；探测实现与回归测试见 approval-policy.ts（必须 ctx.get('approval')，
      // 不能用 ctx.approval——inject 未声明该服务时 cordis 代理会抛 "cannot get property without inject"）。
      const CONFIRM_LABELS: Record<string, string> = {
        // create 与 update 并成 save（标签取中性的「保存」：改一份已有技能时
        // "新建"是句假话）。危险度不变 —— 两者都往 hub 落文件。
        skill_manager_save: '「保存技能」',
        // write/update 并成一条 upsert，标签取中性的「保存记忆」：「写入」在改一条
        // 已有记忆时是句假话（与同一轮修 `prompt_manager_list` 的「生效中」同一个口径）。
        memory_manager_save: '「保存记忆」',
        // 场景族的唯一写工具。无条件问（不设开关）—— 它改的是"进入这个场景时会切换哪些
        // mcp / 技能 / 人设"，改错了影响的是用户切场景之后的**整个运行时环境**，而不是一次
        // 输出。与 skill / subagent 的 save 同一档（都是"以后每次都按它来"的长期资产）。
        scene_manager_save: '「保存场景」',
        // 边界是"启用与进入留在界面"，补上这条工具后它成为**改运行时**的那一条：
        // 六处开关一起动 + 收窄注入 + 改写 AGENTS.md。危险度高于 `_save`（那个只写剧本），
        // 所以门禁同档、不降。
        scene_manager_switch: '「切换场景」',
        subagent_manager_run: '「运行子代理」',
        // create 与 update 并成 save（标签取中性的「保存人设」：改一份已有文件时
        // "新建"是句假话）。危险度不变 —— 两者都往 hub 里落/整份重写一份文件。
        subagent_manager_save: '「保存人设」',
        // add 与 edit 并成 save，模型侧能塞进任意 command/args 的仍只有这一个工具
        // —— 门禁挂在它上面即覆盖整个模型可达面。标签取中性的「保存」：改一台已有服务器
        // （含改 URL / 命令）与新增一台是同一档危险度，但"新增"在改分支上是句假话。
        mcp_manager_save: '「保存 MCP 服务器」',
        // 删除与「应用提示词」原先只有描述里的 consent 句。它们动的都是磁盘上那一份：
        // 删除进回收站可恢复，应用改写的是全局 AGENTS.md 基线 —— 与上面几条同一档，
        // 门禁不该比"往 hub 里写一个技能文件"更松。
        memory_manager_remove: '「删除记忆」',
        skill_manager_remove: '「删除技能」',
        subagent_manager_remove: '「删除人设」',
        scene_manager_remove: '「删除场景」',
        prompt_manager_remove: '「删除提示词预设」',
        prompt_manager_apply: '「应用提示词预设」',
        // 四条 switch 只在**机器级**写入时问一次（判据在 `confirm-gate.ts`）。
        // 默认写本会话，爆炸半径只有一个对话 —— 给默认路径挂卡是纯摩擦。
        mcp_manager_switch: '「MCP 服务器开关」',
        memory_manager_switch: '「记忆开关」',
        skill_manager_switch: '「技能开关」',
        subagent_manager_switch: '「人设开关」',
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
      // 不需要 `subagentWriteWouldApply` 那种裁决：它是为"create 要目标未被占用 / update 要
      // 改名已存在"这套两工具分工写的。合并成一条 upsert 之后它恒为"会应用"（判定只剩
      // "存在就改、不存在就建"，没有第三种情况），留着就是一个永远返回 true 的函数。
      ;(ctx.on as (event: string, cb: (exec: any, next: () => unknown) => unknown) => unknown)('tools/pre-execute', async (exec, next) => {
        if (!exec || !CONFIRM_LABELS[String(exec.name)]) return next()
        if (exec.name === 'subagent_manager_run' && !(await subagentManagerRunTargetExists(exec))) return next()
        // 按参数判定的那批（删除的 trash、开关的机器级写入、提示词的正向应用）：
        // 先算"这一次要不要问"，不问就直接放行 —— 不能落到末尾那条 "Run a subagent" 的
        // 兜底分支上。bypass 放到判定之后：`remove list` 这类根本不问的调用不该在
        // 审计日志里留下一条"跳过了确认"。
        const confirmName = String(exec.name)
        if (ARG_CONDITIONAL_CONFIRM_TOOLS.has(confirmName)) {
          const reason = argConditionalConfirmReason(confirmName, exec.arguments, await scopeStore.mode())
          if (reason === null) return next()
          if (bypassedByFullAccess(exec)) return next()
          return Promise.resolve({ kind: 'ask', reason })
        }
        if (bypassedByFullAccess(exec)) return next()
        if (exec.name === 'skill_manager_save') {
          // 卡是**执行前**弹的：此时工具还没读 `skill-state`，走建还是改还没判出来，
          // 所以 reason 只能取并集。 create 与 update 并成一条 upsert。
          return Promise.resolve({ kind: 'ask', reason: 'Create or overwrite a skill under ~/.dsh/tool-management/skills' })
        }
        if (exec.name === 'mcp_manager_save') {
          // 为什么必须问：stdio 服务器是宿主按你给的 command/args **spawn** 出来的进程
          // （见 http-fence.ts 对 mcpm-add 的说明），且这条目会写进配置长期生效。
          // 写一个技能文件都要问，注册一条能起进程的配置却直接放行，是门禁倒挂 ——
          // 危险度与门禁强度必须同向。
          // 卡里回显将执行的命令行：用户批准的是「跑这条命令」，不是「加一个服务器」。
          // save 也覆盖"改一台已存在的服务器"，此时把**旧命令**一并摆出来：
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
          // write/update 并成一条 upsert，reason 必须同时覆盖两种可能：卡是**执行前**
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

    // ---------- 逐工具 MCP 开关：执行拦截 + 可见性 ----------
    try {
      mcp.warmUp().catch((e) => {
        // 读失败本身已经由四态读落过 note；这里只接住“读成功但预热后半段失败”的异常。
        if (mcp.disabledToolsIssue() === null) {
          noteRuntime({
            id: 'mcp-disabled-tools',
            label: 'MCP 停用表',
            kind: 'read',
            fallback: 'refuse-operation',
            detail: 'MCP 停用表预热失败（' + message(e) + '）：MCP 工具保持拒绝，直到读取成功或重置。',
            detailKey: 'mcp-disabled-tools.warmup',
            params: { reason: message(e) },
          })
        }
      })
    } catch (e) { /* apply 里的同步异常同样由 unknown 状态兜底 */ }
    // 可见性半边：官方 `tools.restrict()` 要求 **agent scope**，所以停用的工具要
    // 逐个 agent 应用 —— 与技能侧同一套生命周期写法（`agent/created` / `agent/disposed`
    // + 启动期扫一遍 `agents.list()`，见 skills/service.ts）。
    if (typeof ctx.on === 'function') {
      try {
        ctx.effect(() => {
          const stop = (ctx.on as (event: string, cb: (payload: any) => void) => (() => void) | void)('agent/created', (payload) => {
            mcp.attachAgent(payload && payload.agent)
            // 技能目录按会话 cwd 取数：先热一份，否则该会话首轮注入会少掉整段目录。
            // 子代理热的是**所属用户会话**那一份：它的目录 / 覆盖都继承父会话（见 `sessionScopeIdOf`）。
            const scopeSid = sessionScopeIdOf(payload && payload.agent)
            if (scopeSid !== null) void skillCatalog.warmSession(scopeSid)
            // 基线：**创建时**记一份"这个会话最开始的样子"——「退出模式」要回到它
            // 而只有现在这一刻取得才是创建时的样子（子代理会话不记：它们不占用户会话）。
            const sid = sessionIdOf(payload && payload.agent)
            if (sid !== null && subagentDepthOf(payload && payload.agent) === 0) void ensureBaselineFor(scopeKeyForAgent(payload && payload.agent) ?? sid)
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
          for (const agent of agents.list()) {
            mcp.attachAgent(agent)
            const scopeSid = sessionScopeIdOf(agent)
            if (scopeSid !== null) void skillCatalog.warmSession(scopeSid)
            // 老会话（本功能上线前创建的）没有基线：启动时补记一份"现在"——
            // 取不到创建时那一刻，这是能做到的最好一份（记不上时退出会如实降级为跟随全局）。
            const sid = sessionIdOf(agent)
            if (sid !== null && subagentDepthOf(agent) === 0) void ensureBaselineFor(scopeKeyForAgent(agent) ?? sid)
          }
        }
      } catch (e) { /* agents 服务不可用 → 仅靠事件（与技能侧同一退路） */ }
    }
    if (typeof tools.guard === 'function') {
      try {
        ctx.effect(() => tools.guard!((exec) => {
          const name = String((exec && exec.name) || '')
          const isMcpTool = name.startsWith(MCP_TOOL_PREFIX)
          try {
            // unknown 必须先于会话 verdict：本会话显式开着也不能越过“停用表读不出来”。
            if (isMcpTool && mcp.disabledToolsState() === 'unknown') {
              return 'MCP 停用表不可读：所有 MCP 工具已暂时拒绝调用（请在 MCP 页重置停用表）'
            }
            // 会话层的判定：它有两个方向 —— `deny` 是"这个对话里关掉了"
            // `allow` 是"这个对话里显式开着"，后者要能**越过全局停用表**（逐工具开关按会话
            // 独立：全局关着的工具，本会话开着就该能调）。判据见 `sessionMcpVerdictSync`。
            const verdict = sessionMcpVerdictSync(exec && exec.agent, name)
            if (verdict === 'deny') return '该工具在本次对话中已停用（其他对话不受影响）'
            // 只读 TTL 缓存、不做 I/O —— 这段跑在每一次工具调用的热路径上。
            if (verdict !== 'allow' && mcp.isToolDisabled(name)) {
              return '该工具已在 MCP 管理页停用'
            }
            // 兼容页关掉的工具：可见性半边（restrict）正常时模型根本看不到它，走到这里只有两种
            // 可能 —— 名字是猜的，或者可见性半边没生效（那条降级会上报）。执行侧一律拦住。
            if (toolTableHiddenForSession(scopeKeyForAgent(exec && exec.agent)).has(name)) {
              return '该工具已在本对话的模型工具表里关掉（要它先在那里打开）'
            }
          } catch (e) {
            // 守卫自身算不出来时，MCP 工具必须 fail-closed；其余工具保持原来的放行方向，
            // 避免一个守卫 bug 让整个工具表都不可用。
            if (isMcpTool) return 'MCP 停用表状态不可读：已拒绝调用'
          }
          return undefined
        }), 'dsh-plugin-tool-management: disabled mcp tool guard')
        clearRuntimeNote('mcp-tool-guard')
      } catch (e) {
        noteRuntime({
          id: 'mcp-tool-guard',
          label: 'MCP 工具执行守卫',
          kind: 'write',
          fallback: 'inform-only',
          detail: '执行守卫注册失败（' + message(e) + '）：停用的 MCP 工具可能仍可被调用；可见性摘除与停用表仍会尽力生效。',
          detailKey: 'mcp-tool-guard.register-failed',
          params: { reason: message(e) },
        })
      }
    } else {
      noteRuntime({
        id: 'mcp-tool-guard',
        label: 'MCP 工具执行守卫',
        kind: 'write',
        fallback: 'inform-only',
        detail: '宿主 tools 服务没有 guard（官方接口变了）：执行侧拦截不存在，停用的 MCP 工具可能仍可被调用。',
        detailKey: 'mcp-tool-guard.missing',
      })
    }
    if (typeof ctx.on === 'function') {
      try {
        // MCP 服务器随实例增删注册 / 注销工具，可见集限制必须跟着变，状态段也是：
        // 工具加载完成后若不重算，注入文本会一直停在「空 / 旧集合」的缓存值上
        //（用户切 MCP 后立刻看上下文注入就是空段 —— 实测）。
        ctx.effect(() => {
          /**
           * 状态段重算的**定窗节流**。
           *
           * 这里原来是裸的 `void mcp.stateCatalog.refresh()`：`tools/change` 来一条就全量重算
           * 一次。而 `refresh()` 会作废缓存并跑 `rows()`（= `mcpmList`，要枚举每个服务器的工具
           * schema、还要逐个读补丁文件），是整条事件链上最重的一步。一旦上游把 `tools/change`
           * 发得密（自激环、或别的插件反复重注册工具），本插件就被动地按同频重解析一遍 ——
           * 报告人在空闲态量到 ~17.8 次/秒 `tools/change`，对应 `readPluginMeta` 20 秒 434 次、
           * 单核 ~46%。
           *
           * 为什么这样写：**前缘立刻刷**，真实的一笔工具变化不拖延（面板里改完马上看注入就是
           * 新值）；窗口内（2s）后续事件只记一个"欠一笔"，窗口结束时补刷 —— 既有上界
           * （≤0.5 次/秒），又不会把连续事件里的最后一笔丢掉。
           *
           * 为什么不怕漏：状态段本身是 SWR，`text()` 在 `ttlMs`（3s）过期后会自己 revalidate，
           * 所以即使尾刷被卸载打断，下一次读也会重建，不会长期停在旧值。
           */
          const MCP_STATE_REFRESH_WINDOW_MS = 2000
          let timer: ReturnType<typeof setTimeout> | null = null
          let pending = false
          const flush = (): void => {
            pending = false
            void mcp.stateCatalog.refresh().catch(() => { /* 下一轮读按 TTL 重建，不影响已完成的写 */ })
          }
          const schedule = (): void => {
            if (timer !== null) { pending = true; return }
            flush()
            timer = setTimeout(function () {
              timer = null
              if (pending) schedule()
            }, MCP_STATE_REFRESH_WINDOW_MS)
          }
          const stop = (ctx.on as (event: string, cb: () => void) => (() => void) | void)('tools/change', () => {
            mcp.scheduleToolRestrictions()
            schedule()
          })
          return () => {
            // 卸载时把窗口定时器一起收掉：留着它会在 dispose 之后再跑一次全量重算。
            if (timer !== null) { clearTimeout(timer); timer = null }
            pending = false
            if (typeof stop === 'function') stop()
          }
        }, 'dsh-plugin-tool-management: tools/change listener')
      } catch (e) { /* ignore */ }
    }
    ctx.effect(() => () => {
      mcp.dispose()
    }, 'dsh-plugin-tool-management: tool restriction cleanup')

    // ---------- 启动期对账：放在装配末尾 ----------
    // reconciler 在前面注册，但**跑**必须等这里 —— 它们要读 hub、比有效状态，都发生在装配之后。
    // 不 await：apply() 不是异步函数，且启动期对账只是收尾，不能拖住 apply。
    void runBootReconcilers().catch(() => { /* 框架自己已逐条 try，这里兜底 */ })

    // ---------- HTTP API 路由（界面那一半），注册时按容错处理 ----------
    // 正文 整段搬到 ./http-api.ts（一字未改，只把 apply 作用域的名字改走 deps）。
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

