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
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { ArchiveWorkspaceRegistry as HistoryService, workspaceBaseName, workspacePathKey } from './history/workspace.js'
import { createSkillsService, pluginLog } from './skills/service.js'
import { createAgentsMdService } from './agents-md/service.js'
import { createRulesService } from './rules/service.js'
import { createArchiveEngine } from './rules/archive-engine.js'
import { createSubagentService } from './subagents/service.js'
import { isApprovalNever } from './approval-policy.js'
import { EXPECTED_PEER_RANGE, VERIFIED_HOST_VERSION, summarize } from './compat/probe.js'
import { assessPresetReach, presetRosterOf, reachNoticeForAgent } from './compat/preset-reach.js'
import { fenceRejection, secretOpRejection, type ConnectionSeam } from './http-fence.js'
import { hubPath, hubRoot, relocateEntries } from './hub.js'
import { createScenePromptSync } from './scene-prompt-sync.js'
import { defineSubagentListTool, defineSubagentRunTool } from './subagents/tools.js'
import { detectFormat, extractText, parseGenericText, parseJsonlTranscript, parseMarkdownTranscript } from './imports/parsers.js'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Minimal structural types for the service surfaces this plugin touches.
// The full contracts live in the corresponding @deepseek-ai packages; these
// local interfaces keep the build dependency surface small.
// ---------------------------------------------------------------------------

interface HttpReq {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: string, callback: (chunk?: unknown) => void): void
}

interface HttpRes {
  writeHead(code: number, headers?: Record<string, string>): void
  end(body?: string): void
}

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

interface WebServerService {
  register(route: { kind: 'exact'; path: string; handler(req: HttpReq, res: HttpRes): void }): () => void
}

interface ToolsService {
  register(definition: ToolDefinition): () => void
  schemas(): Array<{ name: string }>
  /**
   * Optional (dsh-tools): remove global tool names from every scope's
   * model-visible schema list. Fails on names that are not currently
   * registered, so callers must intersect with schemas() first.
   */
  restrict?(filter: { deny?: readonly string[] }): () => void
  /**
   * Optional (dsh-tools): monotonic execution guard — a returned reason string
   * denies the call before the tool body runs.
   */
  guard?(guard: (execution: { name?: string }) => string | undefined): () => void
}

interface PluginInventoryEntry {
  entryId: string
  moduleName?: string
  enabled?: boolean
  fiberPhase?: string
}

interface PluginInventoryService {
  list(): Promise<{ entries: PluginInventoryEntry[] }>
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

/** 批量操作目标（与 deleteArchivedSessions 的 target 同构）。 */
type HistoryBatchTarget = {
  scope: 'all' | 'ungrouped' | 'sessions' | 'workspace'
  sessionIds?: string[]
  workspaceId?: string
}

/**
 * 归档列表的分组视图。宿主侧算好，客户端只按键归并：
 * `live` = 有活登记（含「路径命中但未记账」）；`detached` = 无活登记、按会话目录重建。
 */
type HistoryGroupView = {
  id: string
  title: string
  kind: 'live' | 'detached'
  /** 活登记为登记路径；重建组为会话目录（目录已不在时为 header 里的原始 cwd）。 */
  path?: string
  /** 该路径在插件「见过的登记」快照里出现过 —— 区分「曾登记、已被移除」与「从未登记」。 */
  registered?: boolean
  /** 目录当前存在，可一键重新登记为工作区（仅 detached 组有意义）。 */
  canRegister?: boolean
}

/** 归档工作区注册表（折叠自 dsh-archive-manager）的最小调用面。 */
interface HistoryRegistry {
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>
  deleteSession(sessionId: string): Promise<{ deleted: true }>
  deleteArchivedSessions(target: HistoryBatchTarget): Promise<{ requestedSessionIds: string[]; deletedSessionIds: string[]; skippedSessionIds: string[]; failures: Array<{ sessionId: string; message: string }> }>
  archivedSessionMetadata(): Promise<{ items: Array<{ sessionId: string; createdAt: number }> }>
  archivedSessionDetails?: () => Promise<{ items: Array<{ sessionId: string; createdAt?: number; cwd?: string; title?: string; archivedAt?: number }> }>
  archivedAt?(sessionId: string): number | undefined
  /** 可选：工作区记账表（ArchiveWorkspaceRegistry 提供），history-list 用它反查会话归属与组标题。 */
  requireTable?(): { get(id: string): { title?: string; path?: string; sessionIds: string[] } | undefined; entries(): Array<[string, { title?: string; path?: string; sessionIds: string[] }]> }
  /** 可选：注册表状态；workspaceIds 为权威显示顺序。 */
  requireState?(): { workspaceIds: string[] }
  /** 可选：会话 → 规范路径索引（宿主启动时对全部存储会话建立）。 */
  sessionPaths?: Map<string, string>
  /** 可选：会话 → header（含 cwd）。目录已不在时 cwd 仍是唯一归属线索。 */
  headers?: Map<string, { cwd?: string }>
  /** 可选：「见过的登记」快照（标题/路径），供登记被删后仍按目录显示原命名。 */
  workspaceSnapshot?(): Promise<Map<string, { path: string; title: string; id?: string; at: number }>>
  /** 可选：把当前活登记记入插件自己的快照（未变化时不写盘）。 */
  rememberWorkspaces?(records: Array<{ id?: string; path?: string; title?: string }>): Promise<void>
  /** 可选：为一个已存在目录重新创建宿主工作区登记，并把该目录下已知会话挂回（宿主 resolveByPath / create / attachSession）。 */
  registerWorkspace?(path: string, title?: string): Promise<{
    id: string
    title: string
    path: string
    created: boolean
    attached: string[]
    attachSkipped: Array<{ sessionId: string; reason: string }>
  }>
  /**
   * 可选：恢复归档后把工作区归属一起恢复（按会话 cwd 找到/重建登记并挂回其 sessionIds）。
   * 登记被删除后再重建的记录 `sessionIds` 是空的，不挂回的话恢复出来的会话在宿主侧就是「未分组」。
   */
  ensureWorkspaceAccounting?(sessionIds: string[]): Promise<{
    registered: Array<{ path: string; title: string; created: boolean }>
    attached: string[]
    skipped: Array<{ sessionId: string; reason: string }>
  }>
  /** 可选：批量恢复；缺失时 history-unarchive-batch 返回明确错误。 */
  unarchiveSessions?(target: HistoryBatchTarget): Promise<{ unarchivedSessionIds: string[]; archivedSessionIds: string[] }>
  /** 可选：枚举全部持久化会话（含未归档/冷会话）头部，供导出弹窗选择。 */
  listStoredHeaders?(): Promise<Array<{ id: string; cwd?: string; createdAt?: number }>>
  /** 可选：宿主能力评估快照（compat-status op 与设置页「兼容」页使用）。 */
  capabilities?(force?: boolean): import('./compat/probe.js').HostAssessment
  /** 可选：指定能力 id 中不可用的那些（只读路径降级用，不抛错）。 */
  capabilityRefusals?(ids: readonly string[]): import('./compat/probe.js').CapabilityRefusal[]
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

interface ManagedRow {
  id: string
  name?: string
  serverName?: string
  level?: 'project' | 'global'
  disabled?: boolean
  managed?: boolean
  config: Record<string, unknown>
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

export default {
  name: 'dsh-plugin-tool-management-host',
  inject: ['timer', 'fs', 'settings', 'sandboxPolicy', 'webServer', 'tools', 'skills', 'sessions', 'agents', 'workspaceRegistry', 'sessionProjectionCache', 'sessionPersistence'],
  apply(ctx: DshContext, config?: Record<string, unknown>) {
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
    // Agent 预设名单（@deepseek-ai/dsh-agent-presets）：同样是可选服务，按需取用。
    // 读它只为了回答"当前预设下本插件注入的东西到不到得了模型"——只读，不挂载任何预设。
    const presetRoster = () => presetRosterOf(ctx as unknown as { get?: (name: string) => unknown })

    // Package version, surfaced in the Settings pages and the HTTP API. Read
    // from the installed package.json so it always matches the release tag.
    let PKG_VERSION = 'unknown'
    try {
      PKG_VERSION = (createRequire(import.meta.url)('../package.json') as { version?: string }).version || 'unknown'
    } catch (e) { /* keep unknown */ }

    // Optional access token. Enabled by setting `config.token` on this plugin's
    // loader row (profile cordis.patch.yml override) or the
    // DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN env var. Two roles now:
    //   1. escape hatch — a correct token is accepted *in place of* the host's
    //      browser authentication, so curl/scripts and LAN tooling keep working;
    //   2. defense in depth — when set, every state-changing op additionally
    //      requires `x-dsh-token: <token>`.
    // It is NOT the primary gate anymore: the route calls the host's
    // connection.requestRejection fence first (Host must be loopback/LAN
    // IP-literal → defeats DNS rebinding, plus browser-session cookie auth),
    // so an unset token no longer means "anyone may call writes".
    // NOTE: the entry config arrives as the SECOND apply argument (Cordis
    // calls `callback(ctx, config)`) — never read it off `ctx.config`, which
    // is not an injected service and throws "cannot get property without
    // inject" at boot.
    const TOKEN = String((config as { token?: unknown } | undefined)?.token || process.env.DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN || '').trim()

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
    }

    // ---------- agents-md 预设库 + 切换 ----------
    // DSH 全局指令基线只有 ~/.dsh/AGENTS.md 一个文件，无内置多预设切换；
    // 本服务在 hub 内 agents-md/ 维护预设库，「应用」= 写入 ~/.dsh/AGENTS.md，
    // 新会话生效（当前会话不变，DSH 本身如此）。
    // presetsDir 可由 config 注入（测试用），否则落到 $DSH_HOME/tool-management/agents-md。
    // v0.4：旧位置（插件目录 data/agents-md-presets/）在启动时搬入 hub——
    // 插件目录在 npm 安装下会被覆盖，放用户数据在那里本身就丢数据风险。
    const PLUGIN_ROOT = (() => {
      try { return dirname(createRequire(import.meta.url).resolve('../package.json')) } catch { return process.cwd() }
    })()
    const legacyAgentsMdPresetsDir = join(PLUGIN_ROOT, 'data', 'agents-md-presets')
    const agentsMdPresetsDir = String((config as { presetsDir?: unknown } | undefined)?.presetsDir || hubPath('agents-md'))
    void relocateEntries(legacyAgentsMdPresetsDir, agentsMdPresetsDir, (n) => n !== '__last-applied__')
      .catch(() => 0)
    const agentsMdService = createAgentsMdService(ctx, {
      presetsDir: agentsMdPresetsDir,
      getGlobalAgentsMdPath: async () => {
        const p = await ensurePaths()
        const sep = p.home.indexOf('\\') >= 0 ? '\\' : '/'
        return p.home + sep + 'AGENTS.md'
      },
    })

    // ---------- rules（规则/记忆，v0.4）----------
    // 记忆真源 $DSH_HOME/tool-management/memories/<场景>/<name>.md（仅用户级，D1）。
    // **场景是显式记录**（rules-index.json 的 scenes 切片）：含保留场景 `global`（界面「全局」，
    // 其记忆注入任何对话），空场景也合法存在——不再是"恰好有这个目录名"的隐式约定。
    // 单投影 = 活动场景记忆 → per-agent systemPrompt 段（自动在场，模型无需调用任何工具）。
    // 原"始终层写 ~/.dsh/AGENTS.md"已下线（变更单 01 §4/§10）：公共基线由 _shared/ 承担。
    // 旧的 $DSH_HOME/scene-memory 与 $DSH_HOME/rules 由服务在首次读盘前搬入本目录。
    // rulesRoot / rulesStateDir / rulesScenesDir 仅测试注入，生产留空由服务按 DSH_HOME 解析。
    const rulesService = createRulesService(ctx, {
      rulesRoot: String((config as { rulesRoot?: unknown } | undefined)?.rulesRoot || ''),
      stateDir: String((config as { rulesStateDir?: unknown } | undefined)?.rulesStateDir || ''),
      scenesDir: String((config as { rulesScenesDir?: unknown } | undefined)?.rulesScenesDir || ''),
      // 场景记忆段预算（字节），默认 65536；仅用于测试与特殊部署调优。
      ...(Number.isFinite(Number((config as { rulesMaxBytes?: unknown } | undefined)?.rulesMaxBytes))
        ? { maxBytes: Number((config as { rulesMaxBytes?: unknown }).rulesMaxBytes) }
        : {}),
    })
    try {
      ctx.effect(() => rulesService.registerProviders(), 'dsh-plugin-tool-management: rules providers')
    } catch (e) {
      console.error('[dsh-plugin-tool-management] rules provider setup failed:', message(e))
    }

    // ---------- 场景档案引擎（设计 §2）----------
    // deps 把既有写通道（MCP 单工具启停 / 技能启停）注入引擎；引擎自身串行，
    // 状态机与纯逻辑在 ./rules/archive*.ts。mcpmToolEnabled / readDisabledTools
    // 为函数声明（提升），此处引用安全。
    const toolKeyParts = (toolName: string): { key: string; server: string; tool: string } | null => {
      if (!toolName.startsWith('mcp__')) return null
      const rest = toolName.slice(5)
      const i = rest.indexOf('__')
      if (i <= 0) return null
      const server = rest.slice(0, i)
      const tool = rest.slice(i + 2)
      return server && tool ? { key: server + '/' + tool, server, tool } : null
    }
    async function toolStates(): Promise<Record<string, boolean>> {
      const disabled = await readDisabledTools()
      const states: Record<string, boolean> = {}
      let schemas: any[] = []
      try { schemas = await tools.schemas() } catch { /* 无 live 工具 → 仅启停表 */ }
      const liveByServer: Record<string, string[]> = {}
      for (const s of schemas) {
        const p = toolKeyParts(String((s && s.name) || ''))
        if (!p) continue
        const list = liveByServer[p.server] || (liveByServer[p.server] = [])
        if (list.indexOf(p.tool) < 0) list.push(p.tool)
      }
      for (const [server, list] of Object.entries(disabled)) {
        // 整台停用（['*']）：在 live 工具上展开成具体键，不产出 `server/*` 伪键（那会污染勾选器）。
        if (list.indexOf('*') >= 0) {
          for (const t of (liveByServer[server] || [])) states[server + '/' + t] = false
          continue
        }
        for (const t of list) states[server + '/' + t] = false
      }
      for (const [server, list] of Object.entries(liveByServer)) {
        for (const t of list) if (!(server + '/' + t in states)) states[server + '/' + t] = true
      }
      return states
    }
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
    }> {
      const r: any = await skillsService.ops['skill-state']({})
      const states: Record<string, boolean> = {}
      const all: Record<string, boolean> = {}
      const shadowed = new Set<string>()
      for (const root of ((r && r.data && r.data.roots) || [])) {
        for (const sk of (root.skills || [])) {
          const name = String(sk.declaredName || sk.name || '')
          if (!name) continue
          const key = String(root.key || '') + '/' + name
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
      return { states, shadowed, all }
    }
    async function skillStates(): Promise<Record<string, boolean>> {
      // knownSkillKeys 需要**全量键**（含被覆盖的副本）：场景档案里允许勾选任意一条技能，
      // 用生效集去校验会把合法勾选判成 stale 丢掉。
      return (await skillScan()).all
    }
    const archiveService = createArchiveEngine({
      loadSlice: async () => ({ ...(await rulesService.readArchiveSlice()) }),
      saveSlice: (slice) => rulesService.patchIndex(slice),
      configuredServers: async () => {
        const r: any = await mcpmListView()
        const out: string[] = []
        for (const row of ((r && r.rows) || [])) {
          const n = String((row && row.serverName) || '')
          if (n && out.indexOf(n) < 0) out.push(n)
        }
        return out
      },
      serverKnownTools: async () => {
        const out: Record<string, string[]> = {}
        const raw = await readDisabledTools()
        for (const [server, list] of Object.entries(raw)) out[server] = list.filter((t) => t !== '*')
        let schemas: any[] = []
        try { schemas = await tools.schemas() } catch { /* 无 live 工具 → 仅启停表 */ }
        for (const s of schemas) {
          const p = toolKeyParts(String((s && s.name) || ''))
          if (!p) continue
          const list = out[p.server] || (out[p.server] = [])
          if (list.indexOf(p.tool) < 0) list.push(p.tool)
        }
        return out
      },
      currentMcpRaw: () => readDisabledTools(),
      applyMcpEntries: async (entries: Record<string, string[]>) => {
        const p = await ensurePaths()
        await withWriteLock(async () => {
          await writeJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE), entries)
        })
        disabledToolsCache = { at: Date.now(), value: entries }
        scheduleToolRestrictions()
      },
      knownSkillKeys: async () => new Set(Object.keys(await skillStates())),
      // 快照只取**真实生效**的条目（不含被同名覆盖的副本）——副本不参与模式应用，
      // 退出回放时也不该去动它们，否则会改写用户对副本的显式策略记录。
      currentSkills: async () => (await skillScan()).states,
      applySkills: async (target: Record<string, boolean>) => {
        // 两道过滤，缺一不可：
        //  1. 被同名覆盖的副本直接跳过——它们本来就不生效，写策略只会污染用户的记录。
        //  2. **已经处于目标状态的技能不再写**。`applySkills` 写的是显式策略记录，而目标
        //     状态是生效状态，两者不等价：对已经生效为「停用」的技能再 disable 一次，
        //     只是把「没有记录」固化成「显式停用」，场景模式进出一次就会改写 state.json。
        const { states, shadowed } = await skillScan()
        for (const [key, on] of Object.entries(target)) {
          const i = key.indexOf('/')
          if (i <= 0) throw new Error(`技能 key 不合法: ${key}`)
          if (shadowed.has(key)) continue
          if (states[key] === on) continue
          const root = key.slice(0, i)
          const name = key.slice(i + 1)
          const r: any = await skillsService.ops[on ? 'skill-enable' : 'skill-disable']({ root, name })
          if (r && r.ok === false) throw new Error(`技能 ${key} 应用失败: ${r.error}`)
        }
      },
      sceneExists: async (name) => {
        const r: any = await rulesService.ops['rules-list']({})
        return !!(r && r.ok !== false && (r.scenes || []).some((s: any) => s.name === name))
      },
      // 人设名全集（保存 subagents 段时校验并报 stale，与 mcp/skills 两段同口径）。
      knownPersonas: async () => new Set((await subagentService.list()).map((p) => p.name)),
      // 记忆 id 全集（保存 memories 段时校验并报 stale）。
      knownMemoryIds: async () => {
        const r: any = await rulesService.ops['rules-list']({})
        return new Set<string>(((r && r.rules) || []).filter((x: any) => !x.shadowed).map((x: any) => String(x.id)))
      },
    })

    // ---------- 轻量子智能体（设计 §3）----------
    // 人设 = $DSH_HOME/tool-management/agents/<name>.md；运行走官方 ctx.subagents.start（spawn provider）。
    // sceneLists 供场景绑定校验：启用场景（rules-list 的 active 行）档案里的 subagents 并集。
    const subagentService = createSubagentService(ctx, {})
    const subagentSceneLists = async (): Promise<string[][]> => {
      const slice = await rulesService.readArchiveSlice()
      const r: any = await rulesService.ops['rules-list']({})
      if (!r || r.ok === false) return []
      return (r.scenes || [])
        .filter((s: any) => s.active)
        .map((s: any) => slice.archives[s.name]?.subagents ?? [])
    }

    // HTTP 写操作门禁清单。skills/rules/档案引擎域由各自 service 导出的 writeOps 派生
    // （与其 ops 表同文件维护，新增写 op 改对应 service 即可）；本文件内联域
    // （mcpm-* / skill-open / agentsmd-* / history-*）在此列举。
    // 注意：必须在上述 service 创建之后构造（依赖其 writeOps）。
    const WRITE_OPS = new Set<string>([
      ...skillsService.writeOps,
      ...rulesService.writeOps,
      ...archiveService.writeOps,
      ...subagentService.writeOps,
      'mcpm-add', 'mcpm-edit', 'mcpm-remove', 'mcpm-set-enabled', 'mcpm-set-all', 'mcpm-restart',
      'mcpm-export', 'mcpm-import', 'mcpm-note', 'mcpm-settings', 'mcpm-tool-enabled',
      // mcpm-reveal returns UNMASKED secrets; even though it is a read, it is
      // token-gated like a write — on a LAN-exposed port the token must be the
      // last line of defense for plaintext credentials too, not just writes.
      'mcpm-reveal',
      'skill-open',
      // agents-md 写操作（create/update/remove 改预设库；apply 写全局 AGENTS.md；import 从外部内容建预设）
      'agentsmd-create', 'agentsmd-update', 'agentsmd-apply', 'agentsmd-remove', 'agentsmd-import',
      // history 写操作（archive/unarchive 改归档集合；delete 永久删除；retention-set 写保留期；
      // workspace-register 会新增一条宿主工作区登记，同样是写）
      'history-archive', 'history-unarchive', 'history-delete', 'history-retention-set',
      'history-unarchive-batch', 'history-delete-batch', 'history-import', 'history-export',
      'history-archive-batch', 'history-workspace-register',
    ])

    // 会泄露明文凭据 / 完整配置的 op：**必须**带对的访问令牌，没配令牌就一律拒绝
    // （判定在 http-fence.ts 的 secretOpRejection，含两种情况的区分与理由）。
    const SENSITIVE_OPS = new Set<string>(['mcpm-reveal', 'mcpm-export'])

    // 兼容体检的日志去重：同一宿主版本只写一条 compat/probe，避免轮询刷屏。
    let compatLoggedFor: string | undefined

    // ---------- independent history facade ----------
    // Keep the active workspaceRegistry/sessionProjectionCache instances intact.
    // Native archive extensions are delegated by capability, not package name.
    // Official gaps use a checked adapter (history/bridge.js); no service or
    // storage-domain replacement. Retention uses the existing sidecar ledger.
    // 历史侧车三件套（归档时刻账本 / 保留期设置 / 工作区登记快照）统一放 hub 根
    // （`$DSH_HOME/tool-management/`），**不放插件目录**：npm 安装下插件目录会被
    // `dsh plugin update` 整体替换，放那里等于"升级即丢账本"——账本一丢，保留期基线
    // 就从 archivedAt 退回 createdAt，归档会话会被提前清掉（v0.4 把 agents-md 预设
    // 搬进 hub 是同一条理由，见上方注释；这三个是当时漏掉的）。
    // 旧位置（插件目录 data/）在启动时一次性搬入：只搬不删、绝不覆盖、失败下次再试。
    const historyArchivedAtFile = String((config as { archivedAtFile?: unknown } | undefined)?.archivedAtFile || hubPath('history-archived-at.json'))
    const historyWorkspaceSnapshotFile = String((config as { workspaceSnapshotFile?: unknown } | undefined)?.workspaceSnapshotFile || hubPath('history-workspaces.json'))
    const historyRetentionPath = String((config as { historyRetentionPath?: unknown } | undefined)?.historyRetentionPath || hubPath('history-retention.json'))
    const historySidecarFiles = new Set(['history-archived-at.json', 'history-retention.json', 'history-workspaces.json'])
    const historyStandby = relocateEntries(join(PLUGIN_ROOT, 'data'), hubRoot(), (name) => historySidecarFiles.has(name))
      .catch(() => 0)
    const sweepIntervalMs = Number((config as { sweepIntervalMs?: unknown } | undefined)?.sweepIntervalMs || 0) || 6 * 60 * 60 * 1000
    let history: InstanceType<typeof HistoryService> | undefined
    ctx.effect(() => {
      const registry = ctx.get('workspaceRegistry')
      if (registry && typeof (registry as any).archiveSession === 'function') {
        history = new HistoryService(ctx, registry, {
          archivedAtFile: historyArchivedAtFile,
          workspaceSnapshotFile: historyWorkspaceSnapshotFile,
          ready: historyStandby,
        })
      }
      return async () => { const current = history; history = undefined; await current?.dispose() }
    }, 'dsh-plugin-tool-management: independent history')
    function getHistoryRegistry(): HistoryRegistry | undefined {
      return history as unknown as HistoryRegistry | undefined
    }
    // ── 场景提示词 → 全局基线（AGENTS.md）同步 ────────────────────────────────
    //
    // 用户裁定（2026-09-15）：「切换场景，对应的提示词直接把 AGENTS.md 直接修改」。
    // 实现收在 ./scene-prompt-sync.ts（可在临时目录上端到端验证）：启用/切换场景、
    // 关掉场景、改绑定、编辑"驱动基线的那份预设"四个动作都会同步；关掉场景时按
    // 进场景前的基线快照（`scene-baseline.json`，hub 内）原文写回。
    const scenePromptSync = createScenePromptSync({
      agentsMd: agentsMdService,
      rules: rulesService,
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
     * 恢复归档后的**归属恢复**（best-effort，绝不阻断恢复本身）：按会话 cwd 找到或重建
     * 工作区登记，并把会话挂回该登记的 `sessionIds`。恢复成功但归属恢复失败时返回 undefined，
     * 由客户端按"会话已恢复、工作区归属未恢复"如实呈现。
     */
    async function restoreWorkspaceAccounting(sessionIds: string[]): Promise<{
      registered: Array<{ path: string; title: string; created: boolean }>
      attached: string[]
      skipped: Array<{ sessionId: string; reason: string }>
    } | undefined> {
      const registry = getHistoryRegistry()
      if (!registry || typeof registry.ensureWorkspaceAccounting !== 'function' || !sessionIds.length) return undefined
      try { return await registry.ensureWorkspaceAccounting(sessionIds) } catch (e) {
        ctx.logger?.warn?.(`history: workspace accounting after restore failed: ${message(e)}`)
        return undefined
      }
    }
    /**
     * **当前生效的提示词预设 id**（界面「生效中」的那一份），供写操作做门禁：
     *   ① 启用的场景绑定了它 → 就是它（场景优先级最高，与 agentsmd-list 的标记同一口径）；
     *   ② 否则回退到文件比对（`~/.dsh/AGENTS.md` 内容 == 某份预设）。
     * 探测失败返回 `null`（调用方决定放行还是拒绝；当前只在删除上使用，放行 + warn）。
     */
    async function effectivePresetId(): Promise<string | null> {
      try {
        const r: any = await rulesService.ops['rules-list']({})
        const sp = r && r.ok ? r.scenePrompt : null
        if (sp && sp.scene && !sp.missing && sp.presetId) return String(sp.presetId)
      } catch (e) {
        ctx.logger?.warn?.(`agents-md: scene prompt probe failed: ${message(e)}`)
      }
      try {
        const cur: any = await agentsMdService.getCurrent()
        if (cur && cur.ok && cur.presetId) return String(cur.presetId)
      } catch (e) {
        ctx.logger?.warn?.(`agents-md: global baseline probe failed: ${message(e)}`)
      }
      return null
    }

    async function readHistoryRetention(): Promise<{ retentionDays: number; updatedAt: number }> {
      try {
        await historyStandby
        const raw = await readFile(historyRetentionPath, 'utf8')
        const obj = JSON.parse(raw)
        const days = Number((obj && (obj as { retentionDays?: unknown }).retentionDays) ?? 0)
        const updatedAt = Number((obj && (obj as { updatedAt?: unknown }).updatedAt) ?? 0)
        return {
          retentionDays: Number.isFinite(days) && days >= 0 ? days : 0,
          updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
        }
      } catch { return { retentionDays: 0, updatedAt: 0 } }
    }
    async function writeHistoryRetention(retentionDays: number): Promise<void> {
      await historyStandby
      const dir = dirname(historyRetentionPath)
      await mkdir(dir, { recursive: true })
      // updatedAt = 修改时刻：每次改保留期，已归档会话的到期基线重置为此时刻。
      await writeFile(historyRetentionPath, JSON.stringify({ retentionDays, updatedAt: Date.now() }), 'utf8')
    }
    /**
     * 计算到期应删的归档会话。基线 = max(archivedAt（账本）?? createdAt（元数据),
     * updatedAt（最近一次修改保留期的时刻）)。改保留期即重置倒计时：到期时刻从
     * 修改时刻起按新天数重新计算；updatedAt 缺失（旧配置）时退回归档时刻语义。
     * retentionDays <= 0 表示永久不删除，返回空集。纯函数：便于测试。
     */
    function expiredArchivedIds(
      items: Array<{ sessionId: string; createdAt?: number; archivedAt?: number }>,
      retentionDays: number,
      now: number,
      updatedAt = 0,
    ): string[] {
      if (!(retentionDays > 0)) return []
      const cutoff = now - retentionDays * 86400000
      const out: string[] = []
      for (const it of items) {
        const archived = (typeof it.archivedAt === 'number' && Number.isFinite(it.archivedAt))
          ? it.archivedAt
          : (typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) ? it.createdAt : undefined)
        if (archived === undefined) continue
        const baseline = updatedAt > 0 ? Math.max(archived, updatedAt) : archived
        if (baseline <= cutoff) out.push(it.sessionId)
      }
      return out
    }
    async function sweepHistory(): Promise<{ swept: string[] }> {
      const registry = getHistoryRegistry()
      if (!registry) return { swept: [] }
      const { retentionDays, updatedAt } = await readHistoryRetention()
      if (!(retentionDays > 0)) return { swept: [] }
      try {
        const details = (typeof registry.archivedSessionDetails === 'function')
          ? (await registry.archivedSessionDetails()).items
          : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }))
        const expired = expiredArchivedIds(details, retentionDays, Date.now(), updatedAt)
        if (expired.length === 0) return { swept: [] }
        const res = await registry.deleteArchivedSessions({ scope: 'sessions', sessionIds: expired })
        return { swept: res.deletedSessionIds || [] }
      } catch (e) {
        console.error('[dsh-plugin-tool-management] history sweep failed:', message(e))
        return { swept: [] }
      }
    }
    // 启动时扫一次，再周期复跑。fake-ctx 测试里 ctx.effect 立即调用并 dispose，
    // interval 未提供时退化为不挂钟（不阻塞测试）。
    try {
      void sweepHistory()
    } catch { /* 非致命 */ }
    try {
      ctx.effect(() => {
        const timer = ctx as unknown as { interval?: (cb: () => void, ms: number) => () => void; setInterval?: (cb: () => void, ms: number) => () => void }
        const fn = typeof timer.interval === 'function' ? timer.interval : (typeof timer.setInterval === 'function' ? timer.setInterval : undefined)
        if (!fn) return () => {}
        return fn(() => { void sweepHistory() }, sweepIntervalMs)
      }, 'dsh-plugin-tool-management: history sweep')
    } catch { /* timer 缺失时静默 */ }

    // ---------- path discovery ----------
    // Known limitation: profile detection probes 'web' then 'headless' by
    // presence of profiles/<name>/cordis.patch.yml, then falls back to any
    // profile that has one, and finally to 'web'. A profile whose directory
    // name matches none of these and has no patch file yet is not detected.
    let cached: { home: string; profileDir: string; profileName: string; projectPatch: string; globalPatch: string } | null = null
    async function ensurePaths() {
      if (cached) return cached
      let home: string | null = null
      try {
        const doc = await settings.prepareDocument()
        if (typeof doc === 'string' && doc) {
          const i = Math.max(doc.lastIndexOf('\\'), doc.lastIndexOf('/'))
          home = i > 0 ? doc.slice(0, i) : doc
        }
      } catch (e) { /* ignore */ }
      if (!home) throw new Error('无法确定 DSH 主目录（settings.prepareDocument 未返回路径）')
      await migrateRenamedData(home)
      const sep = home.indexOf('\\') >= 0 ? '\\' : '/'
      let profileDir: string | null = null
      let profileName = 'web'
      for (const name of ['web', 'headless']) {
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
      if (!profileDir) profileDir = home + sep + 'profiles' + sep + 'web'
      cached = {
        home,
        profileDir,
        profileName,
        projectPatch: profileDir + sep + 'cordis.patch.yml',
        globalPatch: home + sep + 'cordis.patch.yml',
      }
      return cached
    }

    async function exists(abs: string): Promise<boolean> {
      try {
        const t = await fs.resolve(abs)
        return (await fs.stat(t)) !== undefined
      } catch (e) { return false }
    }

    // ---------- one-time data migration (pre-rename sidecars & state) ----------
    // The plugin used to ship under the name dsh-skill-mcp-manager: its sidecar
    // JSON files and the skills state directory lived under the old prefix. On
    // first boot pull them to the new names so an upgraded install keeps its
    // data. Best effort — any failure just starts the new layout from scratch.
    async function migrateRenamedData(home: string): Promise<void> {
      const sep = home.indexOf('\\') >= 0 ? '\\' : '/'
      const pairs: Array<[string, string]> = [
        // 状态目录经历过两次改名：skill-mcp-manager → dsh-plugin-tool-management → tool-management
        ['skill-mcp-manager', 'tool-management'],
        ['dsh-plugin-tool-management', 'tool-management'],
        ['skill-mcp-manager-notes.json', 'dsh-plugin-tool-management-notes.json'],
        ['skill-mcp-manager-settings.json', 'dsh-plugin-tool-management-settings.json'],
        ['skill-mcp-manager-disabled-tools.json', 'dsh-plugin-tool-management-disabled-tools.json'],
        ['skill-mcp-manager-export.json', 'dsh-plugin-tool-management-export.json'],
      ]
      for (const [oldName, newName] of pairs) {
        try {
          const oldAbs = home + sep + oldName
          const newAbs = home + sep + newName
          if (!(await exists(oldAbs)) || (await exists(newAbs))) continue
          await rename(oldAbs, newAbs)
        } catch (e) { /* best effort */ }
      }
    }

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
    function backupStamp(): string {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    }
    async function backupPatchFile(abs: string, previous: string): Promise<void> {
      const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'))
      if (i <= 0) return
      const dir = abs.slice(0, i)
      const base = abs.slice(i + 1)
      await writeFile(abs + '.bak-' + backupStamp(), previous, 'utf8')
      try {
        const names = (await readdir(dir)).filter((name) => name.startsWith(base + '.bak-')).sort()
        for (const stale of names.slice(0, Math.max(0, names.length - KEEP_PATCH_BACKUPS))) {
          await unlink(dir + abs[i] + stale)
        }
      } catch (e) { /* pruning is best-effort */ }
    }

    async function writePatch(abs: string, content: string): Promise<void> {
      const t = await fs.resolve(abs)
      const policy = await sandboxPolicy.resolve({ mode: 'danger-full-access' })
      try {
        const previous = await readPatch(abs)
        if (previous && previous !== content) await backupPatchFile(abs, previous)
      } catch (e) { /* a failed backup must never block the write */ }
      await fs.writeText(t, content, undefined, undefined, policy)
    }

    // ---------- duplicate loader-id guard ----------
    // Two rows with the same loader id make the plugin composition fail to
    // boot (upstream hit exactly this after renaming an entry), so duplicates
    // are reported on read and new ones are refused before any write.
    function duplicateIdsOf(content: string): string[] {
      const counts = new Map<string, number>()
      for (const row of parseRows(content).rows) {
        if (!row.id) continue
        counts.set(row.id, (counts.get(row.id) || 0) + 1)
      }
      return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    }
    function duplicateGuard(before: string, after: string): { ok: false; error: string } | null {
      const known = new Set(duplicateIdsOf(before))
      const introduced = duplicateIdsOf(after).filter((id) => !known.has(id))
      if (!introduced.length) return null
      return { ok: false, error: '写入会产生重复的 loader id（重复 id 会导致 DSH 无法启动）：' + introduced.join('、') }
    }

    // ---------- YAML generation ----------
    function yq(v: unknown): string { return typeof v === 'string' ? JSON.stringify(v) : String(v) }
    function yplain(v: string): string { return /^[A-Za-z0-9_.:@%+=/-]+$/.test(v) ? v : yq(v) }

    function buildInsertBlock(row: { id: string; serverName: string; transport: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; toolCallTimeoutMs?: number }): string {
      const lines = [
        '# dsh-plugin-tool-management:server:' + row.id,
        '- insert:',
        '    - id: ' + yplain(row.id),
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: ' + yq(row.serverName),
        '        transport: ' + yq(row.transport),
      ]
      if (row.transport === 'streamable-http') {
        lines.push('        url: ' + yq(row.url || ''))
        const headers = row.headers || {}
        const hk = Object.keys(headers)
        if (hk.length) {
          lines.push('        headers:')
          for (const k of hk) lines.push('          ' + yq(k) + ': ' + yq(headers[k]))
        }
      } else {
        lines.push('        command: ' + yq(row.command || ''))
        const args = row.args || []
        if (args.length) {
          lines.push('        args:')
          for (const a of args) lines.push('          - ' + yq(a))
        }
        const env = row.env || {}
        const ek = Object.keys(env)
        if (ek.length) {
          lines.push('        env:')
          for (const k of ek) lines.push('          ' + yq(k) + ': ' + yq(env[k]))
        }
      }
      if (row.toolCallTimeoutMs) lines.push('        toolCallTimeoutMs: ' + Number(row.toolCallTimeoutMs))
      return lines.join('\n')
    }

    function buildDisableBlock(id: string, disabled: boolean): string {
      return [
        '# dsh-plugin-tool-management:' + (disabled ? 'disable' : 'enable') + ':' + id,
        '- id: ' + yplain(id),
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  disabled: ' + (disabled ? 'true' : 'false'),
      ].join('\n')
    }

    // ---------- YAML parsing (mini parser) ----------
    // Known limitation: this hand-rolled parser assumes the exact indentation
    // style that buildInsertBlock emits (config at 6 spaces, children at 8,
    // nested maps/lists at 10+). Hand-edited patch files using different
    // indentation may parse incorrectly — DSH itself only cares about the
    // effective YAML it reads, and this parser exists purely for the UI.
    function splitKV(text: string): { key: string; value: string } | null {
      const m = text.match(/^("(?:\\.|[^"])*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/)
      if (!m) return null
      return { key: unquote(m[1]), value: m[2] }
    }
    function unquote(v: string): any {
      if (v === undefined || v === null) return v
      const s = String(v).trim()
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try { return JSON.parse(s) } catch (e) { return s.slice(1, -1) }
      }
      if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
      if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter((x) => x !== '')
      if (s === 'true') return true
      if (s === 'false') return false
      if (/^-?\d+$/.test(s)) return Number(s)
      return s
    }

    function parseEntry(lines: string[]): { id?: string; name?: string; disabled?: boolean; config: Record<string, any> } {
      const entry: { id?: string; name?: string; disabled?: boolean; config: Record<string, any> } = { config: {} }
      let inConfig = false
      let configIndent = 0
      let nested: { key: string; indent: number; type: 'map' | 'list'; current: any } | null = null
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const indent = line.match(/^\s*/)![0].length
        let t = trimmed
        if (t.startsWith('- ')) t = t.slice(2).trim()
        const kv = splitKV(t)
        if (!kv) {
          if (inConfig && nested && nested.type === 'list') nested.current.push(unquote(t))
          continue
        }
        if (!inConfig) {
          if (kv.key === 'config' && kv.value === '') { inConfig = true; configIndent = indent; continue }
          if (kv.key === 'id') entry.id = unquote(kv.value)
          else if (kv.key === 'name') entry.name = unquote(kv.value)
          else if (kv.key === 'disabled') entry.disabled = kv.value === 'true'
          continue
        }
        if (indent <= configIndent) { inConfig = false; nested = null; continue }
        if (kv.value === '' && (kv.key === 'headers' || kv.key === 'env')) {
          nested = { key: kv.key, indent, type: 'map', current: {} }
          entry.config[kv.key] = nested.current
          continue
        }
        if (kv.value === '' && kv.key === 'args') {
          nested = { key: kv.key, indent, type: 'list', current: [] }
          entry.config[kv.key] = nested.current
          continue
        }
        if (nested && indent > nested.indent) {
          if (nested.type === 'map') nested.current[kv.key] = unquote(kv.value)
          else if (nested.type === 'list') nested.current.push(unquote(kv.value))
          continue
        }
        nested = null
        entry.config[kv.key] = unquote(kv.value)
      }
      return entry
    }

    function parseRows(content: string): { rows: ManagedRow[] } {
      const lines = content.split(/\r?\n/)
      const managedIds = new Set<string>()
      for (const line of lines) {
        // Markers written by either this plugin or the template upstream count
        // as managed (coexistence: both can edit the same patch file).
        const m = line.match(/^# (?:dsh-plugin-tool-management|dsh-mcp-manager):server:(.+)$/)
        if (m) managedIds.add(m[1].trim())
      }
      const rows: ManagedRow[] = []
      const overrides: Array<{ id: string; disabled?: boolean }> = []
      const blocks: Array<{ text: string }> = []
      let current: { text: string } | null = null
      for (const line of lines) {
        if (/^- /.test(line)) {
          current = { text: line }
          blocks.push(current)
        } else if (current) {
          current.text += '\n' + line
        }
      }
      for (const block of blocks) {
        const head = block.text.split('\n')[0]
        if (/^- insert:/.test(head)) {
          const parts = block.text.split('\n')
          const children: Array<{ lines: string[] }> = []
          let j = 0
          while (j < parts.length) {
            if (/^    - /.test(parts[j])) {
              const child = { lines: [parts[j]] }
              j++
              while (j < parts.length && !/^    - /.test(parts[j])) { child.lines.push(parts[j]); j++ }
              children.push(child)
            } else j++
          }
          for (const child of children) {
            const entry = parseEntry(child.lines)
            if (entry && entry.name === '@deepseek-ai/dsh-mcp-client') {
              rows.push({ id: entry.id!, name: entry.name, disabled: entry.disabled, config: entry.config, managed: managedIds.has(entry.id!) })
            }
          }
        } else {
          const entry = parseEntry(block.text.split('\n'))
          if (entry && entry.name === '@deepseek-ai/dsh-mcp-client') overrides.push({ id: entry.id!, disabled: entry.disabled })
        }
      }
      for (const o of overrides) {
        const row = rows.find((r) => r.id === o.id)
        if (row && o.disabled !== undefined) row.disabled = o.disabled
      }
      return { rows }
    }

    // ---------- line-based block editing ----------
    function splitLines(content: string): string[] { return content.split(/\r?\n/) }
    function joinLines(lines: string[]): string {
      let res = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
      if (!res.trim()) {
        res = '[]\n'
      } else if (!/^- /m.test(res) && !/^\[\]\s*$/m.test(res)) {
        // A patch file must stay a top-level YAML array: after removing the last
        // entry, emit [] so loadOptionalPatches never throws on a comments-only file.
        res = res.replace(/\n*$/, '\n[]\n')
      }
      return res
    }
    function escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

    function markerRanges(lines: string[], id: string, ops: string): Array<[number, number]> {
      const n = lines.length
      // Match this plugin's markers AND the template upstream's
      // (`# dsh-mcp-manager:server|disable|enable:<id>`) so an entry written by
      // either manager can be located and cleaned up without orphan blocks —
      // the two plugins are designed to coexist.
      const re = new RegExp('^# (?:dsh-plugin-tool-management|dsh-mcp-manager):(' + ops + '):' + escRe(id) + '$')
      const ranges: Array<[number, number]> = []
      for (let i = 0; i < n; i++) {
        if (!re.test(lines[i])) continue
        let j = i + 1
        while (j < n && !/^- /.test(lines[j])) j++
        let end = j
        if (j < n && /^- /.test(lines[j])) {
          let k = j + 1
          while (k < n && !/^- /.test(lines[k])) k++
          end = k
        }
        ranges.push([i, end])
      }
      return ranges
    }

    function insertBlockRange(lines: string[], id: string): [number, number] | null {
      const n = lines.length
      const entryRe = new RegExp('^\\s*- id: ' + escRe(id) + '\\s*$')
      for (let i = 0; i < n; i++) {
        if (!/^- insert:/.test(lines[i])) continue
        let end = i + 1
        while (end < n && !/^- /.test(lines[end])) end++
        if (lines.slice(i, end).some((l) => entryRe.test(l))) return [i, end]
      }
      return null
    }

    function bareOverrideRanges(lines: string[], id: string): Array<[number, number]> {
      const n = lines.length
      const re = new RegExp('^- id: ' + escRe(id) + '\\s*$')
      const ranges: Array<[number, number]> = []
      for (let i = 0; i < n; i++) {
        if (!re.test(lines[i])) continue
        let end = i + 1
        while (end < n && !/^- /.test(lines[end])) end++
        ranges.push([i, end])
      }
      return ranges
    }

    function spliceRanges(lines: string[], ranges: Array<[number, number]>): string {
      const remove = new Set<number>()
      for (const r of ranges) for (let i = r[0]; i < r[1]; i++) remove.add(i)
      return joinLines(lines.filter((_, i) => !remove.has(i)))
    }

    function removeEntryAll(content: string, id: string): string {
      const lines = splitLines(content)
      const ranges = markerRanges(lines, id, 'server|disable|enable')
      const ib = insertBlockRange(lines, id)
      if (ib) ranges.push(ib)
      ranges.push(...bareOverrideRanges(lines, id))
      return spliceRanges(lines, ranges)
    }

    function removeMarked(content: string, id: string, op: string): string {
      return spliceRanges(splitLines(content), markerRanges(splitLines(content), id, op))
    }

    function appendBlock(content: string, block: string): string {
      let c = content
      if (/^\[\]\s*$/m.test(c)) c = c.replace(/^\[\]\s*$/m, block + '\n')
      else c = c.replace(/\s*$/, '\n' + block + '\n')
      return c
    }

    // ---------- shared state ----------
    async function collectAll(): Promise<{ ids: Set<string>; serverNames: Set<string>; rows: Array<{ id: string; serverName: string; level: string; disabled: boolean }> }> {
      const p = await ensurePaths()
      const ids = new Set<string>()
      const serverNames = new Set<string>()
      const rows: Array<{ id: string; serverName: string; level: string; disabled: boolean }> = []
      for (const level of ['project', 'global']) {
        const abs = level === 'project' ? p.projectPatch : p.globalPatch
        let content = ''
        try { content = await readPatch(abs) } catch (e) { continue }
        const { rows: fileRows } = parseRows(content)
        for (const r of fileRows) {
          ids.add(r.id)
          const sn = r.config && r.config.serverName ? String(r.config.serverName) : r.id
          serverNames.add(sn)
          rows.push({ id: r.id, serverName: sn, level, disabled: !!r.disabled })
        }
      }
      return { ids, serverNames, rows }
    }

    const bareEntryId = (v: string) => { const s = String(v); const i = s.lastIndexOf(':'); return i >= 0 ? s.slice(i + 1) : s }

    async function liveEntry(id: string): Promise<PluginInventoryEntry | null> {
      if (!pluginInventory) return null
      try {
        const res = await pluginInventory.list()
        return res.entries.find((e) => e.moduleName === '@deepseek-ai/dsh-mcp-client' && bareEntryId(e.entryId) === id) || null
      } catch (e) { return null }
    }

    async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, stepMs: number): Promise<boolean> {
      const start = Date.now()
      for (;;) {
        const v = await pred()
        if (v) return true
        if (Date.now() - start > timeoutMs) return false
        await wait(stepMs)
      }
    }

    async function entryExists(id: string, level: string): Promise<boolean> {
      const p = await ensurePaths()
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      let content = ''
      try { content = await readPatch(abs) } catch (e) { return false }
      const { rows } = parseRows(content)
      if (rows.some((r) => r.id === id)) return true
      return (await liveEntry(id)) !== null
    }

    function normalizeRow(r: ManagedRow, level: string, abs: string) {
      const cfg = r.config || {}
      return {
        id: r.id,
        serverName: cfg.serverName || r.id,
        transport: cfg.transport || null,
        url: cfg.url || null,
        command: cfg.command || null,
        args: cfg.args || null,
        env: cfg.env || null,
        headers: cfg.headers || null,
        level,
        disabled: !!r.disabled,
        managed: !!r.managed,
      }
    }

    // ---------- import helpers ----------
    function toStrMap(v: unknown): Record<string, string> {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
      const out: Record<string, string> = {}
      for (const k of Object.keys(v)) out[k] = String((v as Record<string, unknown>)[k])
      return out
    }
    function normalizeImportItem(item: unknown): { ok: true; row: any } | { ok: false; error: string } {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: '条目不是对象' }
      const it = item as Record<string, unknown>
      const serverName = String(it.serverName || '').trim()
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 非法: ' + String(it.serverName) }
      const transport = it.transport === 'stdio' ? 'stdio' : 'streamable-http'
      const level = it.level === 'global' ? 'global' : 'project'
      const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const rawId = String(it.id || '').trim()
      const id = rawId && /^[A-Za-z0-9_.:@%+=/-]+$/.test(rawId) ? rawId : baseId
      const row: any = { id, serverName, transport, level, disabled: !!it.disabled }
      if (transport === 'streamable-http') {
        const url = String(it.url || '').trim()
        if (!/^https?:\/\//.test(url)) return { ok: false, error: serverName + ': url 非法' }
        row.url = url
        row.headers = toStrMap(it.headers)
      } else {
        const command = String(it.command || '').trim()
        if (!command) return { ok: false, error: serverName + ': command 缺失' }
        row.command = command
        row.args = Array.isArray(it.args) ? it.args.map(String) : []
        row.env = toStrMap(it.env)
      }
      return { ok: true, row }
    }

    // ---------- ops ----------
    async function pluginVersion(): Promise<any> {
      return { ok: true, version: PKG_VERSION }
    }

    // Tool preview for one MCP server: project the model-facing schemas down to
    // a name + description + parameter-summary list. The registry prefixes every
    // MCP tool with `mcp__<serverName>__`; we filter on that and strip the prefix
    // for display. Only the direct `properties` of the parameters object are
    // summarized — nested object/array children are omitted (one level is enough
    // for a preview, keeps the dialog readable).
    // ---------- plugin-owned side-car data (notes / settings) ----------
    // The patch file carries loader config only, so user-facing extras live in
    // small JSON files under the DSH home, next to the patch files they describe.
    function sidecarPath(home: string, name: string): string {
      return home + (home.indexOf('\\') >= 0 ? '\\' : '/') + name
    }
    async function readJsonFile(abs: string): Promise<any> {
      try { return JSON.parse(await readFile(abs, 'utf8')) } catch (e) { return null }
    }
    async function writeJsonFile(abs: string, data: any): Promise<void> {
      await writeFile(abs, JSON.stringify(data, null, 2) + '\n', 'utf8')
    }

    // User notes are keyed by loader id: they survive renames of the server
    // name and are never touched by config rewrites.
    //
    // Sidecar caches (notes / settings / disabled tools) are short-TTL: reads
    // hit the cache, but every WRITE re-reads the file (force=true) and merges
    // on top of the fresh on-disk state. Without the forced re-read, a manual
    // edit of the sidecar file would be silently overwritten by a stale cache.
    const SIDECAR_TTL_MS = 3000
    let notesCache: { at: number; value: Record<string, string> } | null = null
    async function readNotes(force = false): Promise<Record<string, string>> {
      if (notesCache && !force && Date.now() - notesCache.at < SIDECAR_TTL_MS) return notesCache.value
      const p = await ensurePaths()
      const raw = await readJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-notes.json'))
      const out: Record<string, string> = {}
      if (raw && typeof raw === 'object') {
        for (const key of Object.keys(raw)) {
          const value = (raw as Record<string, unknown>)[key]
          if (typeof value === 'string' && value.trim()) out[key] = value
        }
      }
      notesCache = { at: Date.now(), value: out }
      return out
    }
    async function mcpmNote(args: any): Promise<any> {
      const id = String((args && args.id) || '').trim()
      if (!id) return { ok: false, error: '缺少 id' }
      const note = String((args && args.note) == null ? '' : args.note).trim()
      const p = await ensurePaths()
      return withWriteLock(async () => {
        // Force re-read so an externally edited notes file is merged, not clobbered.
        const map = Object.assign({}, await readNotes(true))
        if (note) map[id] = note
        else delete map[id]
        try {
          await writeJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-notes.json'), map)
        } catch (e) {
          return { ok: false, error: '备注保存失败: ' + message(e) }
        }
        notesCache = { at: Date.now(), value: map }
        return { ok: true, notes: map }
      })
    }

    const SETTINGS_DEFAULTS = { pollIntervalMs: 5000, toolDescriptionMaxLength: 0, requireConfirmForModelRuleWrite: true, requireConfirmForModelSubagentRun: true }
    let pluginSettingsCache: { at: number; value: { pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean } } | null = null
    function clampInt(value: unknown, min: number, max: number, fallback: number): number {
      // Number(null) is 0 — treat missing/empty input as "use the default".
      if (value === null || value === undefined || value === '') return fallback
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }
    async function readPluginSettings(force = false): Promise<{ pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean }> {
      if (pluginSettingsCache && !force && Date.now() - pluginSettingsCache.at < SIDECAR_TTL_MS) return pluginSettingsCache.value
      const p = await ensurePaths()
      const raw = await readJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-settings.json'))
      pluginSettingsCache = {
        at: Date.now(),
        value: {
          pollIntervalMs: clampInt(raw && raw.pollIntervalMs, 2000, 60000, SETTINGS_DEFAULTS.pollIntervalMs),
          // 0 = keep descriptions in full (the UI default); > 0 truncates.
          toolDescriptionMaxLength: clampInt(raw && raw.toolDescriptionMaxLength, 0, 2000, SETTINGS_DEFAULTS.toolDescriptionMaxLength),
          // 模型写规则需确认（D2）：程序化强制，只读设置供 tools/pre-execute 判定。
          requireConfirmForModelRuleWrite: (raw && typeof raw.requireConfirmForModelRuleWrite === 'boolean')
            ? raw.requireConfirmForModelRuleWrite
            : SETTINGS_DEFAULTS.requireConfirmForModelRuleWrite,
          // 子代理运行花真 token：默认确认，设置可关（设计 §3.2）。
          requireConfirmForModelSubagentRun: (raw && typeof raw.requireConfirmForModelSubagentRun === 'boolean')
            ? raw.requireConfirmForModelSubagentRun
            : SETTINGS_DEFAULTS.requireConfirmForModelSubagentRun,
        },
      }
      return pluginSettingsCache.value
    }
    async function mcpmSettings(args: any): Promise<any> {
      const current = await readPluginSettings()
      if (!args || args.set !== true) return { ok: true, settings: current }
      const next = {
        pollIntervalMs: clampInt(args.pollIntervalMs, 2000, 60000, current.pollIntervalMs),
        toolDescriptionMaxLength: clampInt(args.toolDescriptionMaxLength, 0, 2000, current.toolDescriptionMaxLength),
        requireConfirmForModelRuleWrite: (args && typeof args.requireConfirmForModelRuleWrite === 'boolean')
          ? args.requireConfirmForModelRuleWrite
          : current.requireConfirmForModelRuleWrite,
        requireConfirmForModelSubagentRun: (args && typeof args.requireConfirmForModelSubagentRun === 'boolean')
          ? args.requireConfirmForModelSubagentRun
          : current.requireConfirmForModelSubagentRun,
      }
      const p = await ensurePaths()
      return withWriteLock(async () => {
        try {
          await writeJsonFile(sidecarPath(p.home, 'dsh-plugin-tool-management-settings.json'), next)
        } catch (e) {
          return { ok: false, error: '设置保存失败: ' + message(e) }
        }
        pluginSettingsCache = { at: Date.now(), value: next }
        return { ok: true, settings: next }
      })
    }

    // ---------- per-tool enable/disable (execution + visibility boundary) ----------
    // dsh-mcp-client has no per-tool config, but the DSH tool runtime exposes
    // two official seams: `tools.restrict({ deny })` removes a global tool from
    // every scope's model-visible schema list, and `tools.guard` denies the call
    // before the body runs. Disabled tools therefore become invisible AND
    // uncallable — no patch rewrite, no DSH restart.
    const DISABLED_TOOLS_FILE = 'dsh-plugin-tool-management-disabled-tools.json'
    let disabledToolsCache: { at: number; value: Record<string, string[]> } | null = null
    async function readDisabledTools(force = false): Promise<Record<string, string[]>> {
      if (disabledToolsCache && !force && Date.now() - disabledToolsCache.at < SIDECAR_TTL_MS) return disabledToolsCache.value
      const p = await ensurePaths()
      const raw = await readJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE))
      const out: Record<string, string[]> = {}
      if (raw && typeof raw === 'object') {
        for (const serverName of Object.keys(raw)) {
          const list = (raw as Record<string, unknown>)[serverName]
          if (Array.isArray(list)) {
            // `*` 必须原样保留：它是「整台服务器停用」的通配（场景档案未勾选的服务器写的就是它），
            // 被这里过滤掉的话 guard / restrict / 快照三条链路一起失效——整台停用变成空转。
            const names = list.map((name) => String(name)).filter((name) => name === '*' || /^[A-Za-z0-9_-]{1,128}$/.test(name))
            if (names.length) out[serverName] = names
          }
        }
      }
      disabledToolsCache = { at: Date.now(), value: out }
      return out
    }
    /** Fully-qualified model-facing names (`mcp__<serverName>__<tool>`) of every disabled tool. */
    function disabledToolNames(map: Record<string, string[]>): string[] {
      const out: string[] = []
      for (const serverName of Object.keys(map)) {
        for (const tool of map[serverName]) out.push('mcp__' + serverName + '__' + tool)
      }
      return out
    }
    /** 单工具停用判定（含整服务器通配 `*`——场景档案的"MCP 工具集=整台"写的就是它）。 */
    function isToolDisabled(map: Record<string, string[]>, fullName: string): boolean {
      if (!fullName.startsWith('mcp__')) return false
      const rest = fullName.slice(5)
      const i = rest.indexOf('__')
      if (i <= 0) return false
      const list = map[rest.slice(0, i)]
      if (!list) return false
      if (list.indexOf('*') >= 0) return true
      return list.indexOf(rest.slice(i + 2)) >= 0
    }
    async function mcpmToolEnabled(args: any): Promise<any> {
      const serverName = String((args && args.serverName) || '').trim()
      const tool = String((args && args.tool) || '').trim()
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 不合法' }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool)) return { ok: false, error: 'tool 名称不合法' }
      const enabled = (args && args.enabled) !== false
      const p = await ensurePaths()
      return withWriteLock(async () => {
        // Force re-read so an externally edited disabled-tools file is merged, not clobbered.
        const map = Object.assign({}, await readDisabledTools(true))
        const disabled = new Set(map[serverName] || [])
        if (enabled) disabled.delete(tool)
        else disabled.add(tool)
        if (disabled.size) map[serverName] = [...disabled].sort()
        else delete map[serverName]
        try {
          await writeJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE), map)
        } catch (e) {
          return { ok: false, error: '保存失败: ' + message(e) }
        }
        disabledToolsCache = { at: Date.now(), value: map }
        await applyToolRestrictions()
        return { ok: true, serverName, disabled: map[serverName] || [] }
      })
    }

    // Visibility seam: keep one active restriction, refreshed whenever the tool
    // set or the disabled set changes. `restrict` fails on unknown names, so the
    // deny list is always intersected with the currently registered tools.
    let restrictDisposer: (() => void) | null = null
    let restrictTimer: ReturnType<typeof setTimeout> | null = null
    async function applyToolRestrictions(): Promise<void> {
      if (typeof tools.restrict !== 'function') return
      // Force re-read: this runs on the tools/change path, which is rare, so a
      // stale cache must not keep an externally edited deny list hidden.
      const map = await readDisabledTools(true)
      // 通配 `*`（整服务器停用）先展开成已注册的全名，再与精确名单合并。
      const wanted = disabledToolNames(map)
      let registered: Set<string>
      try {
        registered = new Set((await tools.schemas()).map((schema) => String(schema.name)))
      } catch (e) { return }
      for (const [serverName, list] of Object.entries(map)) {
        if (list.indexOf('*') < 0) continue
        const prefix = 'mcp__' + serverName + '__'
        for (const fullName of registered) if (fullName.startsWith(prefix)) wanted.push(fullName)
      }
      const names = wanted.filter((name) => registered.has(name))
      if (restrictDisposer) { try { restrictDisposer() } catch (e) { /* ignore */ } restrictDisposer = null }
      if (!names.length) return
      try {
        restrictDisposer = tools.restrict({ deny: names })
      } catch (e) { /* registry race: the next tools/change event retries */ }
    }
    function scheduleToolRestrictions(): void {
      if (restrictTimer) return
      restrictTimer = setTimeout(() => {
        restrictTimer = null
        applyToolRestrictions().catch(() => { /* best effort */ })
      }, 300)
    }

    function truncateText(value: string, limit: number): string {
      if (!limit || value.length <= limit) return value
      return value.slice(0, Math.max(1, limit - 1)).replace(/\s+$/, '') + '…'
    }

    // ---------- secret masking (UI view only) ----------
    // Only sensitive-looking keys are masked; `$VAR` / `!!js` references are
    // indirections rather than secrets, so they stay readable. URL query strings
    // are redacted because MCP credentials often ride there.
    const SENSITIVE_KEY_RE = /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|signature|bearer)/i
    function maskSecretValue(value: unknown): string {
      const text = String(value == null ? '' : value)
      if (text === '') return ''
      if (text.startsWith('$')) return text
      if (/^!!js\s/.test(text)) return text
      return '••••••'
    }
    function maskValueMap(map: Record<string, string> | null, onlySensitiveKeys: boolean): Record<string, string> | null {
      if (!map || typeof map !== 'object') return map
      const out: Record<string, string> = {}
      for (const key of Object.keys(map)) {
        out[key] = (!onlySensitiveKeys || SENSITIVE_KEY_RE.test(key)) ? maskSecretValue(map[key]) : String(map[key])
      }
      return out
    }
    function maskUrlQuery(url: string | null): string | null {
      if (!url) return url
      try {
        const parsed = new URL(url)
        if (parsed.search) parsed.search = '?<redacted>'
        return parsed.toString()
      } catch (e) { return url }
    }
    /** Shared UI rows: mcpmList plus notes, secrets masked unless `reveal`. */
    async function mcpmRowsWithNotes(reveal: boolean): Promise<any> {
      const result: any = await mcpmList()
      if (!result || result.ok === false) return result
      const notes = await readNotes()
      const rows = (result.rows || []).map((row: any) => {
        const view: any = Object.assign({}, row, { notes: notes[row.id] || '' })
        if (!reveal) {
          view.url = maskUrlQuery(row.url)
          view.headers = maskValueMap(row.headers, true)
          view.env = maskValueMap(row.env, true)
        }
        return view
      })
      return Object.assign({}, result, { rows })
    }
    /** Default list view: secrets always masked. */
    async function mcpmListView(): Promise<any> {
      return mcpmRowsWithNotes(false)
    }
    /**
     * Plain-text view. Split from mcpm-list into its own op so it can live in
     * WRITE_OPS: `mcpm-list` stays token-free for rendering, while revealing
     * env/headers secrets requires `x-dsh-token` when a token is configured —
     * otherwise a LAN-exposed port would leak credentials read-only.
     */
    async function mcpmReveal(): Promise<any> {
      return mcpmRowsWithNotes(true)
    }

    async function mcpmTools(args: any): Promise<any> {
      const serverName = String(args && args.serverName || '').trim()
      if (!serverName) return { ok: false, error: 'serverName 不能为空' }
      const prefix = 'mcp__' + serverName + '__'
      let schemas: any[] = []
      try {
        schemas = await tools.schemas()
      } catch (e) {
        return { ok: false, error: message(e) }
      }
      const descriptionLimit = (await readPluginSettings()).toolDescriptionMaxLength
      const disabledMapHere = await readDisabledTools()
      const disabledHere = new Set(disabledMapHere[serverName] || [])
      const wildcardHere = disabledHere.has('*')
      const toolsList: any[] = []
      for (const s of schemas) {
        const fullName = String(s && s.name || '')
        if (!fullName.startsWith(prefix)) continue
        const rawName = fullName.slice(prefix.length)
        const params: any[] = []
        const props = s.parameters && typeof s.parameters === 'object' ? s.parameters.properties : null
        const requiredSet = new Set<string>()
        if (s.parameters && Array.isArray(s.parameters.required)) {
          for (const k of s.parameters.required) if (typeof k === 'string') requiredSet.add(k)
        }
        if (props && typeof props === 'object') {
          for (const [key, spec] of Object.entries(props as Record<string, any>)) {
            const ps = (spec && typeof spec === 'object') ? spec : {}
            params.push({
              key,
              required: requiredSet.has(key),
              type: typeof ps.type === 'string' ? ps.type : 'any',
              ...(typeof ps.description === 'string' ? { description: ps.description } : {}),
            })
          }
        }
        toolsList.push({
          name: rawName,
          description: truncateText(typeof s.description === 'string' ? s.description : '', descriptionLimit),
          enabled: wildcardHere ? false : !disabledHere.has(rawName),
          parameters: params,
        })
      }
      // Some dsh-tools builds strip restricted tools from schemas(); without
      // this merge a disabled tool would vanish from the dialog with no way to
      // re-enable it from the UI. Names come from the sidecar, so they always
      // stay reachable; the description is unavailable once the schema is gone.
      const listed = new Set(toolsList.map((t: any) => t.name))
      for (const name of disabledHere) {
        if (name === '*') continue // 整服务器通配：已在上方逐工具体现，不再展示占位行
        if (!listed.has(name)) {
          toolsList.push({ name, description: '（已停用；描述暂不可用）', enabled: false, parameters: [] })
        }
      }
      return { ok: true, tools: toolsList }
    }

    async function mcpmList(): Promise<any> {
      const p = await ensurePaths()
      const rows: any[] = []
      const errors: string[] = []
      for (const level of ['project', 'global']) {
        const abs = level === 'project' ? p.projectPatch : p.globalPatch
        let content = ''
        try { content = await readPatch(abs) } catch (e) { errors.push(level + ': ' + message(e)); continue }
        const { rows: fileRows } = parseRows(content)
        for (const r of fileRows) rows.push(normalizeRow(r, level, abs))
      }
      const toolCounts: Record<string, number> = {}
      try {
        const schemas = await tools.schemas()
        const seen = new Set<string>()
        for (const s of schemas) {
          const fullName = String(s && s.name || '')
          seen.add(fullName)
          const m = fullName.match(/^mcp__([A-Za-z0-9_-]+)__/)
          if (m) toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1
        }
        // Restricted tools may be absent from schemas(); they still belong to
        // the per-server count so the UI does not show a phantom drop.
        for (const fullName of disabledToolNames(await readDisabledTools())) {
          if (seen.has(fullName)) continue
          const m = fullName.match(/^mcp__([A-Za-z0-9_-]+)__/)
          if (m) toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1
        }
      } catch (e) { /* ignore */ }
      let live: PluginInventoryEntry[] = []
      if (pluginInventory) {
        try {
          const res = await pluginInventory.list()
          live = res.entries.filter((e) => e.moduleName === '@deepseek-ai/dsh-mcp-client')
        } catch (e) { /* ignore */ }
      }
      for (const e of live) {
        const bid = bareEntryId(e.entryId)
        const found = rows.find((r) => r.id === bid)
        if (found) found.live = { enabled: e.enabled, phase: e.fiberPhase }
        else rows.push({ id: e.entryId, serverName: e.entryId, transport: null, url: null, command: null, args: null, env: null, headers: null, level: 'loader', disabled: !e.enabled, managed: false, live: { enabled: e.enabled, phase: e.fiberPhase } })
      }
      for (const row of rows) {
        if (row.toolCount === undefined) row.toolCount = toolCounts[row.serverName] || 0
      }
      // A loader id that appears twice (same id in both patch files, or twice in
      // one) makes the composition fail to boot. Surface it instead of hiding it.
      const idCounts = new Map<string, number>()
      for (const row of rows) idCounts.set(String(row.id), (idCounts.get(String(row.id)) || 0) + 1)
      const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
      for (const row of rows) row.duplicate = duplicateIds.indexOf(String(row.id)) >= 0
      const warnings: string[] = []
      if (duplicateIds.length) warnings.push('检测到重复的 loader id（会导致 DSH 无法启动，请手动清理补丁文件）：' + duplicateIds.join('、'))
      return {
        ok: true,
        rows,
        paths: { project: p.projectPatch, global: p.globalPatch, home: p.home, profile: p.profileName },
        errors,
        warnings,
      }
    }

    async function mcpmAdd(args: any): Promise<any> {
      const p = await ensurePaths()
      const serverName = String(args.serverName || '').trim()
      const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http'
      const level = args.level === 'global' ? 'global' : 'project'
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' }
      const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const existing = await collectAll()
      if (existing.serverNames.has(serverName)) return { ok: false, error: 'serverName "' + serverName + '" 已存在' }
      let id = baseId
      let n = 2
      while (existing.ids.has(id)) { id = baseId + '-' + n; n++ }
      const row: any = { id, serverName, transport }
      if (transport === 'streamable-http') {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 需为 http(s):// 开头的地址' }
        row.url = url
        row.headers = parseKv(args.headers)
      } else {
        const command = String(args.command || '').trim()
        if (!command) return { ok: false, error: 'command 不能为空' }
        row.command = command
        row.args = parseArgs(args.args)
        row.env = parseKv(args.env)
      }
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      return withWriteLock(async () => {
        let content = ''
        try { content = await readPatch(abs) } catch (e) { return { ok: false, error: '读取补丁失败: ' + message(e) } }
        const before = content
        content = appendBlock(content, buildInsertBlock(row))
        if (args.enabled === false) content = appendBlock(content, buildDisableBlock(id, true))
        const guard = duplicateGuard(before, content)
        if (guard) return guard
        try {
          await writePatch(abs, content)
        } catch (e) {
          return { ok: false, error: '写入补丁失败: ' + message(e) }
        }
        return { ok: true, row: { ...row, level, disabled: args.enabled === false } }
      })
    }

    async function mcpmEdit(args: any): Promise<any> {
      const p = await ensurePaths()
      const id = String(args.id || '')
      const level = args.level === 'global' ? 'global' : 'project'
      if (!id) return { ok: false, error: '缺少 id' }
      const all = await collectAll()
      const cur = all.rows.find((r) => r.id === id)
      if (!cur) return { ok: false, error: '未找到条目 ' + id }
      const serverName = String(args.serverName || '').trim()
      const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http'
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' }
      if (serverName !== cur.serverName && all.serverNames.has(serverName)) return { ok: false, error: 'serverName "' + serverName + '" 已被其他服务占用' }
      const row: any = { id, serverName, transport }
      if (transport === 'streamable-http') {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 需为 http(s):// 开头的地址' }
        row.url = url
        row.headers = parseKv(args.headers)
      } else {
        const command = String(args.command || '').trim()
        if (!command) return { ok: false, error: 'command 不能为空' }
        row.command = command
        row.args = parseArgs(args.args)
        row.env = parseKv(args.env)
      }
      const oldAbs = cur.level === 'global' ? p.globalPatch : p.projectPatch
      const newAbs = level === 'global' ? p.globalPatch : p.projectPatch
      const block = buildInsertBlock(row)
      return withWriteLock(async () => {
        // Per-tool disable state is keyed by the serverName namespace: migrate
        // it when a rename moves the tools to a new prefix.
        if (serverName !== cur.serverName) {
          const toolMap = Object.assign({}, await readDisabledTools(true))
          if (toolMap[cur.serverName]) {
            toolMap[serverName] = toolMap[cur.serverName]
            delete toolMap[cur.serverName]
            try { await writeJsonFile(sidecarPath(p.home, DISABLED_TOOLS_FILE), toolMap) } catch (e) { /* non-fatal */ }
            disabledToolsCache = { at: Date.now(), value: toolMap }
          }
        }
        if (oldAbs !== newAbs) {
          // Level migration: remove from the old file, insert into the new one.
          // Not atomic, so keep the old content and restore it if the second
          // write fails — losing the entry is worse than a transient dup.
          const origOld = await readPatch(oldAbs)
          let c = origOld
          c = removeEntryAll(c, id)
          try {
            await writePatch(oldAbs, c)
          } catch (e) {
            return { ok: false, error: '写入失败: ' + message(e) }
          }
          let c2 = await readPatch(newAbs)
          const beforeNew = c2
          c2 = appendBlock(c2, block)
          if (cur.disabled) c2 = appendBlock(c2, buildDisableBlock(id, true))
          const migrationGuard = duplicateGuard(beforeNew, c2)
          if (migrationGuard) {
            try { await writePatch(oldAbs, origOld) } catch (e2) { /* best effort */ }
            return migrationGuard
          }
          try {
            await writePatch(newAbs, c2)
          } catch (e) {
            try { await writePatch(oldAbs, origOld) } catch (e2) { /* best effort */ }
            return { ok: false, error: '写入失败（已回滚）: ' + message(e) }
          }
        } else {
          let c = await readPatch(newAbs)
          const before = c
          c = removeEntryAll(c, id)
          c = appendBlock(c, block)
          if (cur.disabled) c = appendBlock(c, buildDisableBlock(id, true))
          const guard = duplicateGuard(before, c)
          if (guard) return guard
          await writePatch(newAbs, c)
        }
        return { ok: true }
      })
    }

    async function mcpmSetEnabled(args: any): Promise<any> {
      const p = await ensurePaths()
      const { id, level } = args
      const enabled = !!args.enabled
      if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
      if (!(await entryExists(id, level))) return { ok: false, error: '未找到条目 ' + id }
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      return withWriteLock(async () => {
        let c = await readPatch(abs)
        if (enabled) {
          // Drop every `disabled: true` override for this id. If the insert row
          // itself still says disabled (e.g. user hand-edited it), append an
          // explicit `disabled: false` override so the effective state flips.
          // Enable overrides are intentionally left in place — they are the
          // mechanism that lets a disabled-by-default row be turned on.
          c = removeMarked(c, id, 'disable')
          const { rows } = parseRows(c)
          const row = rows.find((r) => r.id === id)
          if (row && row.disabled) c = appendBlock(c, buildDisableBlock(id, false))
        } else {
          c = removeMarked(c, id, 'enable')
          // 幂等：已经生效为「停用」时不再追加 disable 块。无条件 append 会让每次点
          // 「停用」都往 patch 里塞一条重复条目（历史上 18 条互相矛盾的条目就是这么来的，
          // 最终生效值只能靠 last-wins 合并顺序猜），且文件会随每次启停线性膨胀。
          const { rows } = parseRows(c)
          const row = rows.find((r) => r.id === id)
          if (!row || !row.disabled) c = appendBlock(c, buildDisableBlock(id, true))
        }
        await writePatch(abs, c)
        return { ok: true }
      })
    }

    // Bulk enable/disable for every patch-resident server row. Covers both
    // levels at once, or a single level via args.level. Loader-only rows
    // (never written to a patch file) are out of scope. Each file is rewritten
    // at most once; rows already in the target state are left untouched.
    async function mcpmSetAll(args: any): Promise<any> {
      const p = await ensurePaths()
      const enabled = !!args.enabled
      const levelFilter = args.level === 'global' ? 'global' : args.level === 'project' ? 'project' : null
      return withWriteLock(async () => {
        const changed: string[] = []
        for (const level of ['project', 'global']) {
          if (levelFilter && levelFilter !== level) continue
          const abs = level === 'project' ? p.projectPatch : p.globalPatch
          let c = ''
          try { c = await readPatch(abs) } catch (e) { continue }
          const { rows } = parseRows(c)
          for (const row of rows) {
            if (!!row.disabled === !enabled) continue
            changed.push(row.id)
            if (enabled) {
              c = removeMarked(c, row.id, 'disable')
              const { rows: after } = parseRows(c)
              const still = after.find((r) => r.id === row.id)
              if (still && still.disabled) c = appendBlock(c, buildDisableBlock(row.id, false))
            } else {
              c = removeMarked(c, row.id, 'enable')
              c = appendBlock(c, buildDisableBlock(row.id, true))
            }
          }
          await writePatch(abs, c)
        }
        return { ok: true, enabled, changed }
      })
    }

    /** Effective disabled state of a patch row (insert-row flag merged with override blocks). */
    async function isRowDisabled(id: string, level: string): Promise<boolean> {
      const p = await ensurePaths()
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      try {
        const { rows } = parseRows(await readPatch(abs))
        const row = rows.find((r) => r.id === id)
        return row ? !!row.disabled : false
      } catch (e) { return false }
    }

    async function mcpmRestart(args: any): Promise<any> {
      const p = await ensurePaths()
      const { id, level } = args
      if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
      if (!(await entryExists(id, level))) return { ok: false, error: '未找到条目 ' + id }
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      // A restart reconnects the server; it must NOT flip the enabled state.
      // The recovery write below used to strip every disable override, which
      // silently re-enabled servers the user had disabled on purpose — so the
      // pre-restart state is captured and restored.
      const wasDisabled = await isRowDisabled(id, level)
      const warnings: string[] = []
      // Phase 1 write (short lock): force-disable. Stale disable overrides are
      // cleared first so duplicate blocks never accumulate.
      await withWriteLock(async () => {
        let c = await readPatch(abs)
        c = removeMarked(c, id, 'enable')
        c = removeMarked(c, id, 'disable')
        c = appendBlock(c, buildDisableBlock(id, true))
        await writePatch(abs, c)
      })
      if (pluginInventory) {
        const off = await waitFor(async () => {
          const e = await liveEntry(id)
          return e ? e.enabled === false : false
        }, 5000, 300)
        if (!off) warnings.push('loader 未在 5 秒内停用该服务')
      }
      await wait(1000)
      // Phase 2 write (short lock): restore the pre-restart state. The polling
      // waits deliberately run OUTSIDE the write lock — holding the global
      // write lock for up to ~11s stalled every other write op.
      await withWriteLock(async () => {
        let c = await readPatch(abs)
        c = removeMarked(c, id, 'disable')
        if (wasDisabled) c = appendBlock(c, buildDisableBlock(id, true))
        await writePatch(abs, c)
      })
      if (pluginInventory) {
        if (!wasDisabled) {
          const on = await waitFor(async () => {
            const e = await liveEntry(id)
            return e ? e.enabled === true : false
          }, 5000, 300)
          if (!on) warnings.push('loader 未在 5 秒内重新启用该服务')
        }
      } else await wait(1500)
      return warnings.length ? { ok: true, warning: warnings.join('；') } : { ok: true }
    }

    async function mcpmRemove(args: any): Promise<any> {
      const p = await ensurePaths()
      const { id, level } = args
      if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
      const abs = level === 'global' ? p.globalPatch : p.projectPatch
      return withWriteLock(async () => {
        let c = await readPatch(abs)
        c = removeEntryAll(c, id)
        await writePatch(abs, c)
        return { ok: true }
      })
    }

    async function mcpmExport(): Promise<any> {
      const p = await ensurePaths()
      const list = await mcpmList()
      const rows = (list.rows || []).filter((r: any) => r.level !== 'loader').map((r: any) => ({
        id: r.id,
        serverName: r.serverName,
        transport: r.transport,
        url: r.url || undefined,
        command: r.command || undefined,
        args: r.args || undefined,
        env: r.env || undefined,
        headers: r.headers || undefined,
        level: r.level,
        disabled: r.disabled,
      }))
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 2)
      let savedTo: string | null = null
      try {
        const abs = p.home + (p.home.indexOf('\\') >= 0 ? '\\' : '/') + 'dsh-plugin-tool-management-export.json'
        await writePatch(abs, json)
        savedTo = abs
      } catch (e) { /* non-fatal */ }
      return { ok: true, json, savedTo }
    }

    async function mcpmImport(args: any): Promise<any> {
      const p = await ensurePaths()
      const overwrite = !!(args && args.conflict === 'overwrite')
      let parsed: any = null
      try { parsed = JSON.parse(String(args.json || '')) } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + message(e) } }
      const entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : null)
      if (!entries) return { ok: false, error: '导入内容格式不正确：需要数组或 { rows: [...] }' }
      const added: string[] = []
      const overwritten: string[] = []
      const skipped: Array<{ id: string; reason: string }> = []
      for (const item of entries) {
        const norm = normalizeImportItem(item)
        if (!norm.ok) { skipped.push({ id: (item && (item.id || item.serverName)) || '?', reason: norm.error }); continue }
        const row = norm.row
        // Existence checks run INSIDE the write lock so two concurrent imports
        // (or an import racing an add) cannot both pass the same-id/same-name
        // check and duplicate rows (TOCTOU).
        const res = await withWriteLock(async () => {
          const existing = await collectAll()
          const idTaken = existing.ids.has(row.id)
          const nameTaken = existing.serverNames.has(row.serverName)
          // serverName is globally unique: a DIFFERENT id owning the name is
          // always skipped, even in overwrite mode.
          if (nameTaken && !idTaken) return { skipped: true, reason: 'serverName 已存在' }
          if (idTaken && !overwrite) return { skipped: true, reason: 'id 已存在' }
          if (idTaken && overwrite) {
            // Purge every trace of the id from BOTH patch files first, then
            // insert the imported row at its own level.
            for (const lvl of ['project', 'global']) {
              const lAbs = lvl === 'global' ? p.globalPatch : p.projectPatch
              let lContent = ''
              try { lContent = await readPatch(lAbs) } catch (e) { continue }
              lContent = removeEntryAll(lContent, row.id)
              try {
                await writePatch(lAbs, lContent)
              } catch (e) {
                return { skipped: true, reason: '覆盖旧条目失败: ' + message(e) }
              }
            }
          }
          const abs = row.level === 'global' ? p.globalPatch : p.projectPatch
          let c = await readPatch(abs)
          const before = c
          c = appendBlock(c, buildInsertBlock(row))
          if (row.disabled) c = appendBlock(c, buildDisableBlock(row.id, true))
          if (duplicateGuard(before, c)) return { skipped: true, reason: '会产生重复的 loader id' }
          await writePatch(abs, c)
          return { added: true, wasOverwrite: idTaken && overwrite }
        })
        if (res.added) {
          added.push(row.id)
          if (res.wasOverwrite) overwritten.push(row.id)
        } else skipped.push({ id: row.id, reason: (res && res.reason) || '写入失败' })
      }
      return overwrite ? { ok: true, added, overwritten, skipped } : { ok: true, added, skipped }
    }

    function parseKv(text: string): Record<string, string> {
      const out: Record<string, string> = {}
      String(text || '').split(/\r?\n/).forEach((line) => {
        const t = line.trim()
        if (!t || t.startsWith('#')) return
        const i = t.indexOf('=')
        if (i <= 0) return
        out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
      })
      return out
    }
    function parseArgs(text: string): string[] {
      return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '')
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
      if (!/\.(md|markdown|txt)$/i.test(abs)) return { ok: false, error: '只支持打开 Markdown 源文件' }
      if (!(await exists(abs))) return { ok: false, error: '文件不存在：' + abs }
      if (!openWithSystemEditor(abs)) return { ok: false, error: '无法调用系统默认打开方式' }
      return { ok: true, path: abs }
    }

    // 批量操作目标校验：scope 白名单；sessions 需非空 sessionIds；workspace 需
    // workspaceId。与 ArchiveWorkspaceRegistry.archivedBatchTargetSchema 语义一致。
    function parseHistoryBatchTarget(raw: unknown): { ok: true; target: HistoryBatchTarget } | { ok: false; error: string } {
      const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      if (!t) return { ok: false, error: '缺少 target' }
      const scope = t.scope
      if (scope !== 'all' && scope !== 'ungrouped' && scope !== 'sessions' && scope !== 'workspace') {
        return { ok: false, error: 'target.scope 不合法' }
      }
      if (scope === 'sessions') {
        if (!Array.isArray(t.sessionIds) || t.sessionIds.length === 0 ||
            t.sessionIds.some((id) => typeof id !== 'string' || !String(id).trim())) {
          return { ok: false, error: 'scope=sessions 需要非空的 sessionIds 数组' }
        }
      }
      if (scope === 'workspace' && !(typeof t.workspaceId === 'string' && String(t.workspaceId).trim())) {
        return { ok: false, error: 'scope=workspace 需要 workspaceId' }
      }
      return {
        ok: true,
        target: {
          scope,
          ...(scope === 'sessions' ? { sessionIds: (t.sessionIds as string[]).map((s) => String(s).trim()) } : {}),
          ...(scope === 'workspace' ? { workspaceId: String(t.workspaceId).trim() } : {}),
        },
      }
    }

    /**
     * 归档会话的归属解析（三级，宿主侧算好再给客户端）：
     *   1. 活登记的 sessionIds 命中            → 组 = 该登记；
     *   2. 未命中但规范路径命中某活登记        → 组 = 该登记（会话不在其记账里，属正常）；
     *   3. 没有任何活登记                      → 按会话目录重建分组（`path:<归一化路径>`），
     *      目录仍在则可一键重新登记（写回宿主），目录已不在则退到 header 里的原始 cwd。
     * 宿主删除工作区是硬删、不留墓碑，登记一没，`workspaceId` 就再也查不到；但会话目录
     * （`registry.sessionPaths` / header.cwd）还在，所以归属可以按目录重建、并在目录回来时
     * 自动并回同一组。除插件自己 `data/` 下的「见过的登记」快照外，本函数不写任何宿主状态。
     * 任何一步失败都降级为「不分组」，绝不阻断列表。
     */
    async function buildHistoryGroups(
      registry: HistoryRegistry,
      items: Array<{ sessionId: string; cwd?: string; workspaceId?: string; groupId?: string }>,
    ): Promise<{ groups: HistoryGroupView[]; workspaces: Record<string, { title: string; path?: string }> }> {
      const groups: HistoryGroupView[] = []
      const workspaces: Record<string, { title: string; path?: string }> = {}
      try {
        const groupsById = new Map<string, HistoryGroupView>()
        const liveByPath = new Map<string, string>()
        const owned = new Map<string, string>()
        const liveRecords: Array<{ id: string; path: string; title: string }> = []
        const table = typeof registry.requireTable === 'function' ? registry.requireTable() : undefined
        const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined
        if (table) {
          const ids = state && Array.isArray(state.workspaceIds) && state.workspaceIds.length
            ? state.workspaceIds
            : [...table.entries()].map(([id]) => id)
          for (const wid of ids) {
            const rec = table.get(wid)
            if (!rec || !Array.isArray(rec.sessionIds)) continue
            const path = typeof rec.path === 'string' && rec.path ? rec.path : undefined
            const title = (rec.title && String(rec.title)) || (path ? workspaceBaseName(path) : String(wid))
            for (const sid of rec.sessionIds) if (!owned.has(sid)) owned.set(sid, wid)
            if (path) {
              liveByPath.set(workspacePathKey(path), wid)
              liveRecords.push({ id: String(wid), path, title })
            }
            const view: HistoryGroupView = { id: 'ws:' + wid, title, kind: 'live', registered: true, ...(path ? { path } : {}) }
            groupsById.set(view.id, view)
            groups.push(view)
            workspaces[wid] = { title, ...(path ? { path } : {}) }
          }
        }
        // 「见过的登记」快照：登记被删后仍能给出原命名，并区分「已移除」与「从未登记」。
        const snapshot = typeof registry.workspaceSnapshot === 'function' ? await registry.workspaceSnapshot() : undefined
        if (liveRecords.length && typeof registry.rememberWorkspaces === 'function') {
          try { await registry.rememberWorkspaces(liveRecords) } catch { /* 快照写失败不影响分组 */ }
        }
        const sessionPaths = registry.sessionPaths instanceof Map ? registry.sessionPaths : undefined
        const headers = registry.headers instanceof Map ? registry.headers : undefined
        for (const it of items) {
          const sid = it.sessionId
          let wid = owned.get(sid)
          const canonical = sessionPaths ? sessionPaths.get(sid) : undefined
          if (wid === undefined && typeof canonical === 'string' && canonical) {
            const byPath = liveByPath.get(workspacePathKey(canonical))
            if (byPath !== undefined) wid = byPath
          }
          if (wid !== undefined) {
            it.workspaceId = wid
            it.groupId = 'ws:' + wid
            continue
          }
          let path = typeof canonical === 'string' && canonical ? canonical : undefined
          if (path === undefined && it.cwd) path = it.cwd
          if (path === undefined && headers) {
            const cwd = headers.get(sid)?.cwd
            if (typeof cwd === 'string' && cwd) path = cwd
          }
          if (!path) continue
          const key = 'path:' + workspacePathKey(path)
          it.groupId = key
          const known = snapshot ? snapshot.get(workspacePathKey(path)) : undefined
          const existing = groupsById.get(key)
          if (existing) {
            // 同目录的多个会话：目录存在（sessionPaths 命中）即可重新登记。
            if (canonical !== undefined) existing.canRegister = true
            continue
          }
          const view: HistoryGroupView = {
            id: key,
            title: known?.title || workspaceBaseName(path) || path,
            kind: 'detached',
            registered: known !== undefined,
            canRegister: canonical !== undefined,
            path: known?.path || path,
          }
          groupsById.set(key, view)
          groups.push(view)
        }
      } catch { /* 分组是增强：任何异常都退回扁平列表 */ }
      return { groups, workspaces }
    }

    /**
     * 记忆候选（档案编辑器第 4 段「记忆」）：`[{ id, scene, name, description }]`。
     * 只读、不读正文（勾选集只存 id）；任何异常降级为空列表，不让档案弹窗崩掉。
     */
    async function memoryCandidates(): Promise<Array<{ id: string; scene: string; name: string; description: string }>> {
      try {
        const r: any = await rulesService.ops['rules-list']({})
        if (!r || r.ok === false) return []
        return (r.rules || [])
          .filter((x: any) => !x.shadowed)
          .map((x: any) => ({
            id: String(x.id),
            scene: String(x.group || ''),
            name: String(x.name || ''),
            description: String(x.description || ''),
          }))
      } catch {
        return []
      }
    }

    /** 场景候选（档案编辑器第 4 段的分组维度）：`[{ name, label, description, count, global }]`。 */
    async function memorySceneCandidates(): Promise<Array<{ name: string; label: string; description: string; count: number; global: boolean }>> {
      try {
        const r: any = await rulesService.ops['rules-list']({})
        if (!r || r.ok === false) return []
        return (r.scenes || []).map((s: any) => ({
          name: String(s.name),
          label: String(s.label || s.name),
          description: String(s.description || ''),
          count: Number(s.count || 0),
          global: s.global === true,
        }))
      } catch {
        return []
      }
    }

    /**
     * 工具候选（人设的「工具白名单 / 黑名单」选择器）：
     * 取**全体 Agent 预设工具名的并集**——人设可能在任意预设下被子代理复用，
     * 只列当前会话的工具会让换预设后的子代理启动失败（官方 `toolFilter` 对未知名直接拒绝）。
     * 同时标注 `current`：当前会话可见的工具（其余只是「本预设可用，当前会话看不到」）。
     *
     * 每次调用都会为尚未挂载的预设建立 standing mount（官方语义：一个预设在本进程内只挂一次，
     * 正常创建会话时同样会挂），因此结果会按需缓存 60 秒，避免频繁枚举。
     */
    let presetToolsCache: { at: number; value: { tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string }> } } | null = null
    async function presetToolCandidates(): Promise<{ tools: Array<{ name: string; presets: string[]; current: boolean }>; presets: Array<{ id: string; name: string }> }> {
      if (presetToolsCache && Date.now() - presetToolsCache.at < 60000) return presetToolsCache.value
      const byName = new Map<string, { name: string; presets: Set<string>; current: boolean }>()
      const presets: Array<{ id: string; name: string }> = []
      // 当前会话的可见工具（用于标 current）；拿不到就全部按「非当前」处理。
      const currentNames = new Set<string>()
      try {
        const schemas = await tools.schemas()
        for (const s of schemas || []) currentNames.add(String((s as any).name))
      } catch { /* 无 live 工具 → current 全 false */ }

      const agentPresets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) as any
      if (agentPresets && typeof agentPresets.list === 'function') {
        try {
          const roster = await agentPresets.list()
          for (const p of roster || []) {
            const id = String((p && p.id) || '')
            if (!id) continue
            presets.push({ id, name: String((p && (p.name || p.id)) || id) })
            let scopeKey: unknown
            try {
              // 官方说明：该调用会确保预设的 standing mount（不创建 agent/session），
              // 已挂载的预设直接复用；正因如此才需要这里的 60 秒缓存。
              scopeKey = typeof agentPresets.standingKeyFor === 'function' ? await agentPresets.standingKeyFor(id) : undefined
            } catch { scopeKey = undefined }
            let names: string[] = []
            try {
              names = (await tools.schemas(scopeKey as any) || []).map((s: any) => String(s.name)).filter(Boolean)
            } catch { names = [] }
            for (const name of names) {
              // MCP 工具名形如 `mcp__<server>__<tool>`：面向上百个条目，噪声大于价值 → 不进候选。
              if (name.startsWith('mcp__')) continue
              const rec = byName.get(name) || { name, presets: new Set<string>(), current: false }
              rec.presets.add(id)
              byName.set(name, rec)
            }
          }
        } catch { /* 预设服务不可用 → 退回「仅当前会话工具」 */ }
      }
      // 当前会话的工具即便没有任何预设可枚举，也要出现在候选里（否则选择器是空的）。
      for (const name of currentNames) {
        if (name.startsWith('mcp__')) continue
        const rec = byName.get(name) || { name, presets: new Set<string>(), current: false }
        byName.set(name, rec)
      }
      for (const rec of byName.values()) rec.current = currentNames.has(rec.name)

      const value = {
        tools: [...byName.values()]
          .map((r) => ({ name: r.name, presets: [...r.presets].sort(), current: r.current }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        presets: presets.sort((a, b) => a.id.localeCompare(b.id)),
      }
      presetToolsCache = { at: Date.now(), value }
      return value
    }

    /**
     * 模型候选（人设的「模型」下拉）：宿主已注册的 provider + 各 provider 能宣告的模型。
     * 只读宿主 LLM 目录，**不发起网络请求**（`discoverModels` 会打端点，这里不用）；
     * 拿不到就返回空列表，UI 退回手填（跨来源模型如 sensenova 的手工条目仍需手填兜底）。
     * 返回扁平列表：DSH 的模型路由是 (provider, model) 一对，两个键必须同时给。
     */
    async function modelCandidates(): Promise<{ models: Array<{ provider: string; providerName: string; id: string; name: string }> }> {
      const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as any
      if (!llm || typeof llm.listProviders !== 'function') return { models: [] }
      let list: any[] = []
      try {
        list = llm.listProviders() || []
      } catch {
        return { models: [] }
      }
      const models: Array<{ provider: string; providerName: string; id: string; name: string }> = []
      const seen = new Set<string>()
      for (const p of list) {
        const provider = String((p && (p.id || p.provider)) || '')
        if (!provider) continue
        const providerName = String((p && (p.name || p.displayName)) || provider)
        let discovered: any[] = []
        try {
          // 适配器可选提供 listModels（官方 LlmAdapter 契约）；未提供时该 provider 只报名字。
          if (typeof llm.listModels === 'function') discovered = (await llm.listModels(provider)) || []
        } catch { /* 该 provider 的目录读失败 → 只报 provider 本身 */ }
        for (const m of discovered) {
          const id = String((m && (m.id || m.model)) || '')
          if (!id) continue
          const key = provider + '\u0000' + id
          if (seen.has(key)) continue
          seen.add(key)
          models.push({ provider, providerName, id, name: String((m && m.name) || id) })
        }
      }
      return { models }
    }

    const handlers: Record<string, (args: any) => Promise<any>> = {
      'plugin-version': pluginVersion,
      'mcpm-list': mcpmListView,
      'mcpm-reveal': mcpmReveal,
      'mcpm-note': mcpmNote,
      'mcpm-settings': mcpmSettings,
      'mcpm-tool-enabled': mcpmToolEnabled,
      'skill-open': skillOpen,
      'mcpm-tools': mcpmTools,
      'mcpm-add': mcpmAdd,
      'mcpm-edit': mcpmEdit,
      'mcpm-set-enabled': mcpmSetEnabled,
      'mcpm-set-all': mcpmSetAll,
      'mcpm-restart': mcpmRestart,
      'mcpm-remove': mcpmRemove,
      'mcpm-export': mcpmExport,
      'mcpm-import': mcpmImport,
      // 技能管理 ops（由 ./skills/service.js 提供）：skill-state / skill-detail /
      // skill-browse / skill-enable / skill-disable / skill-source-enable /
      // skill-source-disable / skill-create / skill-import / skill-upload /
      // skill-delete / skill-trash-restore / skill-trash-delete
      // 成功返回 {ok:true, data}；core 业务失败原样透传 {ok:false, error, code?, params?}。
      ...skillsService.ops,
      // rules ops（由 ./rules/service.js 提供）：rules-list / rules-read / rules-budget /
      // rules-diagnose / rules-create / rules-update / rules-remove / rules-restore /
      // rules-attach / rules-detach / rules-trash-list / rules-trash-remove /
      // rules-toggle / rules-set-index / rules-set-active / rules-create-scene /
      // rules-remove-scene。
      // 成功返回扁平 {ok:true, ...}（不套 data），失败 {ok:false, error, code?}。
      ...rulesService.ops,
      // 场景 ↔ 全局基线（AGENTS.md）同步：用户裁定「切换场景，对应的提示词直接把 AGENTS.md
      // 直接修改」，所以这四个 rules 写 op 走包装 —— 先执行原逻辑，成功后把当前场景绑定的
      // 提示词写进 `~/.dsh/AGENTS.md`（或关掉场景时恢复进场景前的基线），结果并进响应
      // 的 `agentsMd` 字段（`applied` / `restored` / `unchanged` / `error`）。
      // 放在 spread 之后，显式覆盖同名 op。
      'rules-set-active': async (args: any) => withAgentsMdSync(await rulesService.ops['rules-set-active'](args)),
      'rules-update-scene': async (args: any) => withAgentsMdSync(await rulesService.ops['rules-update-scene'](args)),
      'rules-create-scene': async (args: any) => withAgentsMdSync(await rulesService.ops['rules-create-scene'](args)),
      'rules-remove-scene': async (args: any) => withAgentsMdSync(await rulesService.ops['rules-remove-scene'](args)),
      // 场景档案 ops（由 ./rules/archive-engine.ts 提供）：scene-mode-get /
      // scene-archive-save / scene-mode-set。成功返回扁平 {ok:true, ...}，
      // 失败 {ok:false, error}；写 op 已含 archiveService.writeOps 门禁派生。
      ...archiveService.ops,
      // 子智能体 ops（由 ./subagents/service.ts 提供）：subagent-list/get（只读）
      // + subagent-create/update/delete（写，writeOps 已派生进门禁）。
      ...subagentService.ops,
      // 人设表单的两个候选源（只读，均为「按需拉取」——不进 scene-inventory，避免每次开档案弹窗都枚举预设）。
      // preset-tools：全体 Agent 预设工具名并集 + 各工具所属预设 + 当前会话是否可见。
      'preset-tools': async () => ({ ok: true, ...(await presetToolCandidates()) }),
      // model-candidates：宿主 LLM 目录里的 (provider, model) 对（不发网络请求）。
      'model-candidates': async () => ({ ok: true, ...(await modelCandidates()) }),
      // 场景档案勾选器数据源 v2：全部 MCP 服务器（含未运行）+ 技能全集 + 人设清单。
      'scene-inventory': async () => {
        const [rowsR, tools, skills, subs] = await Promise.all([mcpmListView(), toolStates(), skillStates(), subagentService.list()])
        const disabledRaw = await readDisabledTools()
        const rows: any[] = (rowsR && rowsR.rows) || []
        const mcpServers: any[] = []
        const seen = new Set<string>()
        for (const row of rows) {
          const name = String((row && row.serverName) || '')
          if (!name || seen.has(name)) continue
          seen.add(name)
          mcpServers.push({
            name,
            level: row.level || null,
            live: !!(row.live && row.live.enabled),
            serverDisabled: !!row.disabled,
            // 停用表里的 ['*'] = 整台工具停用（勾选器据此预勾，避免把"全停"读成"全启用"）。
            allToolsDisabled: (disabledRaw[name] || []).indexOf('*') >= 0,
            toolCount: typeof row.toolCount === 'number' ? row.toolCount : null,
          })
        }
        return {
          ok: true,
          mcpServers,
          tools: Object.entries(tools).map(([key, enabled]) => ({ key, enabled })),
          skills: Object.entries(skills).map(([key, enabled]) => ({ key, enabled })),
          subagents: subs.map((p) => ({ name: p.name, description: p.description })),
          // 档案编辑器第 4 段「记忆」的候选：场景 + 每个场景里的记忆条数。
          // 记忆正文不在这里返回（勾选集只存 id，渲染时才读盘）。
          scenes: await memorySceneCandidates(),
          memories: await memoryCandidates(),
        }
      },
      // AGENTS.md 预设库 ops（由 ./agents-md/service.js 提供）：agentsmd-list /
      // agentsmd-read / agentsmd-create / agentsmd-update / agentsmd-remove /
      // agentsmd-apply / agentsmd-get-current
      // 提示词预设库（由 ./agents-md/service.ts 提供）。这里把两件事对齐成用户看到的一份状态：
      //   - `active`（界面「生效中」）= **当前真正在起作用的基线**：启用的场景绑了预设就是它，
      //     否则才看文件比对（预设正文 == ~/.dsh/AGENTS.md）。用户裁定：「场景启动了，
      //     提示词页生效中的应该是场景选择的那个」。
      //   - `fileApplied` = 文件比对结果（AGENTS.md 里确实是它）。两者同时为真说明
      //     场景绑的就是已应用的那份，正文一致时宿主不会再注入第二遍（去重）。
      'agentsmd-list': async () => {
        const base = await agentsMdService.list()
        if (!base || base.ok === false) return base
        let scenePrompt: { scene: string | null; presetId: string | null; missing: boolean; duplicate?: boolean; bytes: number } | undefined
        try {
          const r: any = await rulesService.ops['rules-list']({})
          if (r && r.ok && r.scenePrompt) scenePrompt = r.scenePrompt
        } catch { /* 场景服务不可用 → 只回预设库 */ }
        const sceneId = scenePrompt && !scenePrompt.missing && scenePrompt.scene ? scenePrompt.presetId : null
        // 场景驱动时**只有场景绑的那份**算生效中（用户裁定）；文件里那份降级为「文件里是它」，
        // 因为场景的提示词已经接管基线。没有场景驱动时才按文件比对定「生效中」。
        const sceneDrives = sceneId !== null
        const presets = base.presets.map((p) => {
          const fileApplied = p.active === true
          const byScene = sceneDrives && sceneId === p.id
          const active = sceneDrives ? byScene : fileApplied
          return { ...p, active, fileApplied, activeVia: byScene ? 'scene' : (active && fileApplied ? 'file' : null) }
        })
        return { ...base, presets, ...(scenePrompt ? { scenePrompt } : {}) }
      },
      'agentsmd-read': (args: any) => agentsMdService.read(String((args && args.id) || '')),
      // content 与 from 都可选：新建弹窗里直接写正文（content），或从现有预设复制（from）。
      'agentsmd-create': (args: any) => agentsMdService.create(String((args && args.id) || ''), {
        ...(args && args.from ? { from: String(args.from) } : {}),
        ...(args && typeof args.content === 'string' ? { content: String(args.content) } : {}),
      }),
      // 保存：改正文 + 可选改名（nextId）。改名成功顺带把场景绑定一起改名 ——
      // 绑定存在 rules-index.json 里，预设库自己看不到，不叫这一声就会留悬空绑定。
      // 保存后同步一次全局基线：若改的正是「正在驱动基线的那份」，正文要跟着写进
      // `~/.dsh/AGENTS.md`（否则页面标着「生效中」而文件里还是旧内容）。
      'agentsmd-update': async (args: any) => {
        const res = await agentsMdService.update(
          String((args && args.id) || ''),
          String((args && args.content) ?? ''),
          args && args.nextId !== undefined ? String(args.nextId) : undefined,
        )
        if (!res || res.ok === false) return res
        let renamed: any = {}
        if (res.renamedFrom) {
          try {
            const r: any = await rulesService.ops['rules-rebind-prompt']({ from: res.renamedFrom, to: res.id })
            renamed = r && r.ok ? { reboundScenes: r.changed } : {}
          } catch { /* 改名同步失败不影响保存本身 */ }
        }
        return withAgentsMdSync({ ...res, ...renamed })
      },
      'agentsmd-apply': (args: any) => agentsMdService.apply(String((args && args.id) || '')),
      'agentsmd-get-current': () => agentsMdService.getCurrent(),
      // 删除：**正在生效的那份拒绝删除**（用户裁定）。生效 = 启用的场景绑定了它，
      // 否则 = 文件内容就是它。禁用的按钮只是提示，真正的门在这里（模型与旧页面也会走这条路）。
      // 探测失败时放行并记一条 warn：删预设不动 ~/.dsh/AGENTS.md，最坏是少一份副本，可重建。
      'agentsmd-remove': async (args: any) => {
        const id = String((args && args.id) || '')
        const effective = await effectivePresetId()
        if (effective !== null && effective === id) {
          return { ok: false, error: `「${id}」正在生效，不能删除：先启用别的场景或换绑提示词，或先把别的预设应用上去。` }
        }
        return agentsMdService.remove(id)
      },
      'agentsmd-import': (args: any) => agentsMdService.importPreset(String((args && args.id) || ''), String((args && args.content) ?? '')),
      // History（归档会话管理）ops。只读：history-list / history-retention-get；
      // 写：history-archive / history-unarchive / history-delete / history-retention-set。
      // workspaceRegistry 缺失（补丁未生效）时返回明确错误，不崩页面。
      'history-list': async () => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未就绪：请检查宿主 workspaceRegistry 服务。' }
        try {
          const items = (typeof registry.archivedSessionDetails === 'function')
            ? (await registry.archivedSessionDetails()).items
            : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }))
          const { retentionDays } = await readHistoryRetention()
          // 归属分组（best-effort）：活登记 → 路径命中 → 按会话目录重建。
          // 宿主删除工作区后登记消失，靠会话目录把分组补回来（详见 buildHistoryGroups）。
          const { groups, workspaces } = await buildHistoryGroups(registry, items as Array<{ sessionId: string; cwd?: string }>)
          return { ok: true, items, groups, workspaces, retentionDays }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      // 枚举全部持久化会话（含未归档/冷会话）供导出弹窗选择；只读，不门控。
      // 标题经投影缓存 best-effort；任何一步失败只降级为缺字段。
      'history-sessions': async () => {
        const registry = getHistoryRegistry()
        if (!registry || typeof registry.listStoredHeaders !== 'function') {
          return { ok: false, error: '当前环境不支持枚举全部会话（registry 未实现 listStoredHeaders）' }
        }
        try {
          const headers = await registry.listStoredHeaders()
          const archivedItems = typeof registry.archivedSessionDetails === 'function'
            ? (await registry.archivedSessionDetails()).items
            : (await registry.archivedSessionMetadata()).items
          const archived = new Set(archivedItems.map((i) => i.sessionId))
          const cache = ctx.get('sessionProjectionCache') as { cachedSnapshot?(header: unknown, seq: number, fields: string[]): { values?: { title?: string } } } | undefined
          const items: Array<{ sessionId: string; cwd?: string; createdAt?: number; title?: string; archived: boolean; workspaceId?: string; groupId?: string; cwdMissing?: boolean }> = []
          for (const h of headers) {
            const sessionId = h && typeof h.id === 'string' ? h.id : undefined
            if (!sessionId) continue
            // 过滤子代理派生的会话：不占用用户会话列表，也不应出现在导出选择里。
            if ((h as { origin?: string }).origin === 'subagent') continue
            const item: { sessionId: string; cwd?: string; createdAt?: number; title?: string; archived: boolean; workspaceId?: string; groupId?: string; cwdMissing?: boolean } = {
              sessionId,
              archived: archived.has(sessionId),
            }
            if (typeof h.cwd === 'string' && h.cwd) item.cwd = h.cwd
            if (typeof h.createdAt === 'number' && Number.isFinite(h.createdAt)) item.createdAt = h.createdAt
            if (cache && typeof cache.cachedSnapshot === 'function') {
              try {
                const snap = cache.cachedSnapshot(h, 0, ['title'])
                if (snap && snap.values && typeof snap.values.title === 'string') item.title = snap.values.title
              } catch { /* title best-effort */ }
            }
            // 工作区目录可能已被删除/移动（孤儿会话）：best-effort 标记，供导出选择时识别。
            if (item.cwd) {
              try {
                const st = await stat(item.cwd)
                item.cwdMissing = !st.isDirectory()
              } catch { item.cwdMissing = true }
            }
            items.push(item)
          }
          // 归属分组（与 history-list 同源）：导出弹窗的工作区筛选按同一套组 id。
          const { groups } = await buildHistoryGroups(registry, items)
          return { ok: true, items, groups }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      // 导出默认目录：桌面（存在时）否则用户主目录。只读，不门控。
      'history-export-defaults': async () => {
        let dir = homedir()
        try {
          const desktop = join(homedir(), 'Desktop')
          const st = await stat(desktop)
          if (st.isDirectory()) dir = desktop
        } catch { /* 桌面路径不可用 → 回退主目录 */ }
        return { ok: true, defaultDir: dir }
      },
      // 列出目录的子目录，供客户端「选择文件夹」弹窗逐级浏览。dir 为空时返回根
      // 视图（Windows 枚举盘符，其他平台返回 '/'）。只读，不门控。
      'dir-list': async (args: any) => {
        const raw = String((args && args.dir) || '').trim()
        try {
          if (!raw) {
            if (process.platform !== 'win32') return { ok: true, current: '/', parent: null, entries: [] }
            const drives: Array<{ name: string; path: string }> = []
            for (let c = 65; c <= 90; c++) {
              const root = String.fromCharCode(c) + ':\\'
              try { await stat(root); drives.push({ name: root, path: root }) } catch { /* 跳过不存在的盘符 */ }
            }
            return { ok: true, current: '', parent: null, entries: drives }
          }
          const st = await stat(raw)
          if (!st.isDirectory()) return { ok: false, error: '该路径不是目录' }
          const parent = dirname(raw)
          const names = await readdir(raw, { withFileTypes: true })
          const entries = names
            .filter((d) => d.isDirectory())
            .map((d) => ({ name: d.name, path: join(raw, d.name) }))
            .sort((a, b) => a.name.localeCompare(b.name))
          return { ok: true, current: raw, parent: parent === raw ? null : parent, entries }
        } catch (e) {
          return { ok: false, error: message(e) }
        }
      },
      'history-archive': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const sessionId = String((args && args.sessionId) || '').trim()
        if (!sessionId) return { ok: false, error: '缺少 sessionId' }
        try { await registry.archiveSession(sessionId); return { ok: true, sessionId } } catch (e) { return { ok: false, error: message(e) } }
      },      // 批量归档（导出弹窗「归档所选」）：把选中的会话收进 History，纳入保留期管理。
      'history-archive-batch': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const rawIds = (args && args.sessionIds) || []
        const ids = Array.isArray(rawIds) ? rawIds.map((s: unknown) => String(s).trim()).filter(Boolean) : []
        if (!ids.length) return { ok: false, error: '请至少选择一个会话' }
        const archived: string[] = []
        const failed: Array<{ sessionId: string; error: string }> = []
        for (const sessionId of ids) {
          try { await registry.archiveSession(sessionId); archived.push(sessionId) }
          catch (e) { failed.push({ sessionId, error: message(e) }) }
        }
        return { ok: true, archived, failed }
      },
      // 兼容体检：把"宿主到底支持哪些操作、哪些降级了、为什么"变成可读状态，
      // 而不是等用户点删除时才看见报错。只读，不改任何数据。
      'compat-status': async (args: any) => {
        const force = Boolean(args && args.refresh)
        try {
          const registry = getHistoryRegistry()
          const assessment = registry && typeof registry.capabilities === 'function'
            ? registry.capabilities(force)
            : undefined
          if (assessment === undefined) {
            return {
              ok: true,
              host: { version: 'unknown' },
              findings: [],
              degraded: [],
              blockers: ['归档服务未挂载：无法探测宿主能力'],
              summary: '宿主能力探测不可用（归档服务未挂载）',
            }
          }
          const summary = summarize(assessment)
          // 每次刷新都留一条结构化日志：升级当天就能在日志里看到降级发生。
          if (force || !compatLoggedFor || compatLoggedFor !== assessment.identity.version) {
            compatLoggedFor = assessment.identity.version
            void pluginLog()('compat/probe', {
              hostVersion: assessment.identity.version,
              summary,
              degraded: assessment.degraded.map((item: import('./compat/probe.js').CapabilityFinding) => ({ id: item.id, state: item.state, detail: item.detail })),
              blockers: assessment.identity.blockers,
              sameAsHost: assessment.identity.sameAsHost,
            }).catch(() => {})
          }
          return {
            ok: true,
            host: { version: assessment.identity.version, modules: assessment.identity.modules },
            sameAsHost: assessment.identity.sameAsHost,
            findings: assessment.findings,
            degraded: assessment.degraded,
            blockers: assessment.identity.blockers,
            mayDelete: assessment.mayDelete,
            verifiedVersion: VERIFIED_HOST_VERSION,
            expectedPeerRange: EXPECTED_PEER_RANGE,
            generatedAt: assessment.generatedAt,
            summary,
          }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      // 预设可达性矩阵：每个 Agent 预设下，本插件的注入类能力到不到得了模型。
      // 只读预设组合文本，不挂载任何预设、不改任何数据。回答的是"面板上说注入了，
      // 模型真的看得到吗" —— minimal 这类 persona complete 的预设会压制全部提示词段。
      'preset-reach': async () => {
        try {
          const report = await assessPresetReach(presetRoster())
          return { ok: true, ...report }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      'history-unarchive': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const sessionId = String((args && args.sessionId) || '').trim()
        if (!sessionId) return { ok: false, error: '缺少 sessionId' }
        try {
          const r = await registry.unarchiveSession(sessionId)
          const workspace = await restoreWorkspaceAccounting([sessionId])
          return { ok: true, archivedSessionIds: r.archivedSessionIds, ...(workspace ? { workspace } : {}) }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      'history-delete': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const sessionId = String((args && args.sessionId) || '').trim()
        if (!sessionId) return { ok: false, error: '缺少 sessionId' }
        try { await registry.deleteSession(sessionId); return { ok: true, sessionId, deleted: true } } catch (e) { return { ok: false, error: message(e) } }
      },
      'history-unarchive-batch': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        if (typeof registry.unarchiveSessions !== 'function') return { ok: false, error: '当前环境不支持批量恢复（registry 未实现 unarchiveSessions）' }
        const parsed = parseHistoryBatchTarget(args && args.target)
        if (!parsed.ok) return parsed
        try {
          const r = await registry.unarchiveSessions(parsed.target)
          const workspace = await restoreWorkspaceAccounting(r.unarchivedSessionIds || [])
          return { ok: true, unarchivedSessionIds: r.unarchivedSessionIds, archivedSessionIds: r.archivedSessionIds, ...(workspace ? { workspace } : {}) }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      'history-delete-batch': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const parsed = parseHistoryBatchTarget(args && args.target)
        if (!parsed.ok) return parsed
        try {
          const r = await registry.deleteArchivedSessions(parsed.target)
          return { ok: true, requestedSessionIds: r.requestedSessionIds, deletedSessionIds: r.deletedSessionIds, skippedSessionIds: r.skippedSessionIds, failures: r.failures }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      // 重新登记工作区（写宿主状态）：为「工作区已被删除、目录仍在」的分组补回一条登记。
      // 只在用户显式确认后调用；宿主 realpath 会拒绝不存在的目录，同路径已登记则幂等返回。
      // 不移动、不删除任何文件或会话，也不改写 sessionIds 记账。
      'history-workspace-register': async (args: any) => {
        const registry = getHistoryRegistry()
        if (!registry) return { ok: false, error: '归档服务未挂载' }
        const path = String((args && args.path) || '').trim()
        if (!path) return { ok: false, error: '缺少工作区目录 path' }
        if (typeof registry.registerWorkspace !== 'function') {
          return { ok: false, error: '当前环境不支持重新登记工作区（registry 未实现 registerWorkspace）' }
        }
        const title = args && args.title ? String(args.title) : undefined
        try {
          const workspace = await registry.registerWorkspace(path, title)
          return { ok: true, workspace }
        } catch (e) { return { ok: false, error: message(e) } }
      },
      // 从其他 Agent（Claude Code / Cursor JSONL、Codex Markdown、通用文本）导入对话，
      // 通过 sessions.create 的 seed 机制生成一个可继续对话的全新会话。
      'history-import': async (args: any) => {
        const fileName = String((args && args.fileName) || '').trim()
        const content = String((args && args.content) ?? '')
        if (!fileName || !content.trim()) return { ok: false, error: '缺少文件内容' }
        let turns: Array<{ role: 'user' | 'assistant'; text: string }>
        try {
          const format = detectFormat(fileName, content)
          turns = format === 'jsonl' ? parseJsonlTranscript(content)
            : format === 'markdown' ? parseMarkdownTranscript(content)
            : parseGenericText(content)
        } catch (e) {
          return { ok: false, error: '对话解析失败: ' + message(e) }
        }
        if (!turns.length) return { ok: false, error: '未能从该文件中识别出对话内容' }
        if (!agents || typeof agents.create !== 'function') return { ok: false, error: '当前环境不支持创建会话（agents.create 不可用）' }
        // 仅接受绝对路径的 cwd；非法或缺失时会话不带目录（归入未分组）。
        const cwdArg = String((args && args.cwd) || '').trim()
        const cwd = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwdArg) ? cwdArg : undefined
        // seed 事件信封：seq 从 0 连续、time 为安全整数、surface 事件必须带 surfaceOp:'append'。
        const base = Date.now()
        const seed = turns.map((turn, i) => ({
          type: turn.role === 'user' ? 'user/message' : 'assistant/message',
          seq: i,
          time: base + i,
          data: turn.role === 'user'
            ? { id: 'msg-' + i, role: 'user', content: [{ type: 'text', text: turn.text }], source: { kind: 'typed' } }
            : { message: { id: 'msg-' + i, role: 'assistant', content: [{ type: 'text', text: turn.text }], source: { kind: 'model', provider: 'imported', model: 'imported' } }, turn: i, step: 0, stream: [] },
          surfaceOp: 'append',
        }))
        try {
          // `sessions.create()` 只创建裸 Session；它不经过 DSH agent factory / workspace
          // / session-log，所以返回的内存 id 不会进入 UI 的会话列表。必须走官方的
          // `ctx.agents.create()`，它会在同一事务里创建 Agent、发布 Session，并触发宿主
          // 的持久化与 projection 链路。这里使用 UUID，避免 SessionStore 的裸自增 id 与
          // 宿主 API 会话 id 空间混用。
          const id = 'session-' + randomUUID()
          await agents.create({ sessionId: id, seed, ...(cwd ? { meta: { cwd } } : {}) })
          const sessions = ctx.get('sessions') as { get?(sessionId: string): unknown } | undefined
          const live = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
          if (live === undefined || live === null) {
            return { ok: false, error: `创建会话失败：宿主未登记该会话（${id}），未导入任何内容` }
          }
          return { ok: true, sessionId: id, count: turns.length }
        } catch (e) {
          return { ok: false, error: '创建会话失败: ' + message(e) }
        }
      },
      // 把选中的归档会话导出为可再导入的转录文件（Markdown / JSONL），写入指定目录。
      // 每个会话一个文件；读不到正文的冷会话列入 skipped，不中断其余导出。
      'history-export': async (args: any) => {
        const rawIds = (args && args.sessionIds) || []
        const ids = Array.isArray(rawIds) ? rawIds.map((s: unknown) => String(s).trim()).filter(Boolean) : []
        if (!ids.length) return { ok: false, error: '请至少选择一个会话' }
        const format = String((args && args.format) || 'markdown').toLowerCase()
        if (format !== 'markdown' && format !== 'jsonl') return { ok: false, error: 'format 需为 markdown 或 jsonl' }
        const outDir = String((args && args.outDir) || '').trim()
        if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(outDir)) return { ok: false, error: '导出目录需为绝对路径' }
        const sessions = ctx.get('sessions') as { get?(id: string): unknown } | undefined
        if (!sessions || typeof sessions.get !== 'function') return { ok: false, error: '当前环境不支持读取会话（sessions.get 不可用）' }
        // 读会话事件：先取活动 store；冷会话（进程重启后）从持久化后端恢复只读句柄。
        const readEvents = async (sessionId: string): Promise<unknown[] | undefined> => {
          const live = sessions.get!(sessionId)
          if (live && typeof (live as { snapshotEvents?: unknown }).snapshotEvents === 'function') {
            const ev = (live as { snapshotEvents(): unknown[] }).snapshotEvents()
            return Array.isArray(ev) ? ev : undefined
          }
          const persistence = ctx.get('sessionPersistence') as { prepare?(id: string): Promise<unknown> } | undefined
          if (persistence && typeof persistence.prepare === 'function') {
            try {
              const prep = await persistence.prepare(sessionId)
              const ps = prep && (prep as { session?: unknown }).session
              try {
                if (ps && typeof (ps as { snapshotEvents?: unknown }).snapshotEvents === 'function') {
                  const ev = (ps as { snapshotEvents(): unknown[] }).snapshotEvents()
                  return Array.isArray(ev) ? ev : undefined
                }
              } finally {
                const dispose = (prep as { [Symbol.dispose]?: () => void })[Symbol.dispose]
                if (typeof dispose === 'function') dispose()
              }
            } catch { return undefined }
          }
          return undefined
        }
        try {
          await mkdir(outDir, { recursive: true })
        } catch (e) {
          return { ok: false, error: '创建导出目录失败: ' + message(e) }
        }
        const ext = format === 'jsonl' ? '.jsonl' : '.md'
        const exported: Array<{ sessionId: string; fileName: string; path: string; count: number }> = []
        const skipped: Array<{ sessionId: string; error: string }> = []
        for (const sessionId of ids) {
          const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
          const fileName = safe + ext
          const path = join(outDir, fileName)
          try {
            const events = await readEvents(sessionId)
            const turns = extractTurnsFromEvents(events || [])
            if (!turns.length) {
              skipped.push({ sessionId, error: events ? '会话中没有可导出的消息' : '无法读取会话内容（不在活动存储且无持久化句柄）' })
              continue
            }
            await writeFile(path, serializeTurns(turns, format), 'utf8')
            exported.push({ sessionId, fileName, path, count: turns.length })
          } catch (e) {
            skipped.push({ sessionId, error: '导出失败: ' + message(e) })
          }
        }
        return { ok: true, exported, skipped }
      },
      'history-retention-get': async () => {
        const { retentionDays } = await readHistoryRetention()
        return { ok: true, retentionDays }
      },
      'history-retention-set': async (args: any) => {
        const days = Number((args && args.retentionDays) ?? -1)
        // 错误文案承诺的是「非负整数」，就按整数校验：1.5 这类小数以前会被静默取整成 1，
        // 用户看到的回执与输入不符。
        if (!Number.isSafeInteger(days) || days < 0) {
          return { ok: false, error: 'retentionDays 需为非负整数（0=永久不删除），收到: ' + String((args && args.retentionDays)) }
        }
        try {
          await writeHistoryRetention(days)
        } catch (e) {
          return { ok: false, error: '写入保留期失败: ' + message(e) }
        }
        // 设置变更后立即扫一次，UI 反映新策略。
        await sweepHistory().catch(() => {})
        return { ok: true, retentionDays: days }
      },
    }

    // ---------- agent-facing tools (standard ctx.tools.register + defineTool) ----------
    const text = (value: string) => [{ type: 'text' as const, text: value }]
    tools.register(defineTool({
      name: 'skill_mcp_manager_list',
      description: 'List all configured MCP servers (level, enabled state, live loader status, registered tool count).',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute() {
        const r = await mcpmList()
        if (!r.ok) throw new Error(r.error)
        const summary = (r.rows || []).map((x: any) => (
          x.id + ' | ' + x.serverName + ' | ' + x.level + ' | ' + (x.disabled ? 'disabled' : 'enabled') +
          (x.live ? ' | loader:' + (x.live.enabled ? 'on' : 'off') + (x.live.phase ? ':' + x.live.phase : '') : '') +
          (typeof x.toolCount === 'number' ? ' | tools:' + x.toolCount : '')
        ))
        return 'MCP servers:\n' + (summary.join('\n') || '(none)')
      },
    }))
    tools.register(defineTool({
      name: 'skill_mcp_manager_set_enabled',
      description: 'Enable or disable one configured MCP server (writes the patch file; takes effect via HMR).',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
        level: { type: 'string', required: true, description: 'project or global.' },
        enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await mcpmSetEnabled({ id: args.id, level: args.level, enabled: args.enabled })
        if (!r.ok) throw new Error(r.error)
        return 'OK: ' + args.id + ' now ' + (args.enabled ? 'enabled' : 'disabled')
      },
    }))
    tools.register(defineTool({
      name: 'skill_mcp_manager_restart',
      description: 'Restart one configured MCP server (disable + re-enable; reconnect and re-sync tools).',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
        level: { type: 'string', required: true, description: 'project or global.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await mcpmRestart({ id: args.id, level: args.level })
        if (!r.ok) throw new Error(r.error)
        return 'OK: ' + args.id + ' restarted'
      },
    }))
    tools.register(defineTool({
      name: 'skill_mcp_manager_add',
      description: 'Add a new MCP server (streamable-http or stdio) at project or global level.',
      parameters: {
        serverName: { type: 'string', required: true, description: 'Unique server name (1-32 chars, [A-Za-z0-9_-]).' },
        transport: { type: 'string', required: true, description: 'streamable-http or stdio.' },
        url: { type: 'string', description: 'Server URL (required for streamable-http).' },
        command: { type: 'string', description: 'Executable (required for stdio).' },
        args: { type: 'string', description: 'Arguments, space separated (stdio).' },
        headers: { type: 'string', description: 'Extra headers as key=value lines (streamable-http).' },
        env: { type: 'string', description: 'Extra env vars as key=value lines (stdio).' },
        level: { type: 'string', description: 'project or global (default project).' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await mcpmAdd(args)
        if (!r.ok) throw new Error(r.error)
        return 'OK: added ' + r.row.id + ' at ' + r.row.level
      },
    }))
    // Skill-facing tools: list, toggle, create. create is gated by the
    // tools/pre-execute hook below (the model must ask before writing files).
    tools.register(defineTool({
      name: 'skill_manager_list',
      description: 'List DSH skills across all sources (dsh/agents/codex/claude user roots and project roots) with their enabled state.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute() {
        const r = await skillsService.ops['skill-state']({})
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill-state failed')
        const data: any = r.data || {}
        const lines: string[] = []
        for (const root of data.roots || []) {
          for (const skill of root.skills || []) {
            lines.push((skill.name || skill.declaredName || '') + ' | ' + (root.key || '') + ' | ' + (skill.enabled ? 'enabled' : 'disabled'))
          }
        }
        return 'Skills:\n' + (lines.join('\n') || '(none)')
      },
    }))
    tools.register(defineTool({
      name: 'skill_manager_set_enabled',
      description: 'Enable or disable one DSH skill (manager policy only; skill source files are never modified).',
      parameters: {
        name: { type: 'string', required: true, description: 'Skill name (kebab-case).' },
        enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
        root: { type: 'string', description: 'Source root key (dsh/agents/codex/claude or a project key); default dsh.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const op = args.enabled ? 'skill-enable' : 'skill-disable'
        const r = await skillsService.ops[op]({ name: args.name, root: args.root || 'dsh' })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill toggle failed')
        return 'OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled')
      },
    }))
    tools.register(defineTool({
      name: 'skill_manager_create',
      // 落点必须和 UI「创建技能」一致：两者都走 core 的默认落点（hub 的
      // tool-management/skills/，hub 缺失时退回 DSH_HOME/skills）。以前这里硬编码
      // root:'dsh'，于是同一个「新建技能」动作，人点界面和模型调用会落到两个不同的根。
      description: 'Create a new local DSH skill under the tool-management skills root (DSH_HOME/tool-management/skills). Use only when the user explicitly asks to create or save a reusable skill.',
      parameters: {
        name: { type: 'string', required: true, description: 'Skill name; normalized to kebab-case.' },
        description: { type: 'string', required: true, description: 'A concise routing description for when to use the skill.' },
        body: { type: 'string', required: true, description: 'Markdown instructions that form the skill body.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await skillsService.ops['skill-create']({ name: args.name, description: args.description, body: args.body })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill create failed')
        const data: any = r.data || {}
        return 'Created DSH skill ' + (data.name || args.name) + ' at ' + (data.path || '(unknown)')
      },
    }))
    // AGENTS.md 预设库：模型可查/切，不能造/删（避免模型乱删用户预设）。
    tools.register(defineTool({
      name: 'agentsmd_list',
      description: 'List AGENTS.md presets in the plugin preset library (id, active state).',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(_args, exec: any) {
        const r = await agentsMdService.list()
        if (!r.ok) throw new Error(r.error)
        const summary = r.presets.map((p) => p.id + (p.active ? ' [active]' : ''))
        // 同上：AGENTS.md 由 dsh-agent-instructions 行承载，预设没挂这一行（或 persona
        // 是 complete）时文件内容不会进提示词。
        const notice = await reachNoticeForAgent(presetRoster(), exec && exec.agent && exec.agent.ctx)
        return 'AGENTS.md presets:\n' + (summary.join('\n') || '(none)') + '\n(Applying takes effect on the next session created; the current session is unchanged.)' + notice
      },
    }))
    tools.register(defineTool({
      name: 'agentsmd_apply',
      description: 'Apply one AGENTS.md preset by writing it to ~/.dsh/AGENTS.md. Takes effect on the next session created; the current session is unchanged.',
      parameters: {
        id: { type: 'string', required: true, description: 'Preset id (lowercase letters, digits, hyphens).' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await agentsMdService.apply(args.id)
        if (!r.ok) throw new Error(r.error)
        return 'OK: preset ' + args.id + ' applied to ~/.dsh/AGENTS.md (next session; current session unchanged' + (r.backedUp ? '; previous backed up to __last-applied__' : '') + ')'
      },
    }))
    // ---------- rules model tools（v0.4）----------
    // 活动场景的记忆正文会自动进入系统提示词（无需调用工具读取）；这里的工具用于
    // 查询/编辑规则本身。rule_manager_write 受 tools/pre-execute 审批门禁（D2）。
    // 路径锚点：$DSH_HOME/tool-management/memories/<场景>/…（场景 `global` = 界面「全局」）。
    tools.register(defineTool({
      name: 'rule_manager_list',
      description: 'List memories under ~/.dsh/tool-management/memories (id, scene, enabled, description).',
      parameters: {
        group: { type: 'string', description: 'Optional scene filter.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec: any) {
        const r: any = await rulesService.ops['rules-list'](args)
        if (!r || r.ok === false) throw new Error((r && r.error) || '读取规则失败')
        const lines = (r.rules || []).map((x: any) => (
          '- ' + x.id + ' [' + (x.group || '未归属场景') + '] ' + (x.enabled ? '已启用' : '已停用') +
          (x.description ? ' — ' + x.description : '')
        ))
        const scenes = (r.scenes || []).map((s: any) => (s.label || s.name) + (s.active ? '(启用)' : '(未启用)')).join('、')
        // 注入边界：预设可能压制提示词段（complete persona，或未挂 agent-instructions），
        // 此时列出的记忆**不在**模型上下文里。必须说出来，否则模型会假设自己已经看到正文。
        const notice = await reachNoticeForAgent(presetRoster(), exec && exec.agent && exec.agent.ctx)
        return '记忆（' + (r.rules || []).length + '）：\n' + (lines.join('\n') || '(无记忆)') +
          '\n场景：' + (scenes || '(无)') + (r.activeMode === 'all' ? '（默认全部启用）' : '（已收窄）') + notice
      },
    }))
    tools.register(defineTool({
      name: 'rule_manager_read',
      description: 'Read the full body of one memory under ~/.dsh/tool-management/memories.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id like <scene>/<name>.' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r: any = await rulesService.ops['rules-read'](args)
        if (!r || r.ok === false) throw new Error((r && r.error) || '读取规则失败')
        return '# ' + r.rule.id + '\n\n' + (r.rule.body || '')
      },
    }))
    tools.register(defineTool({
      name: 'rule_manager_write',
      description: 'Create a new memory as ~/.dsh/tool-management/memories/<scene>/<name>.md. The scene must already exist (use global for the always-on scene). It becomes active automatically once its scene is enabled. Requires user confirmation (configurable).',
      parameters: {
        group: { type: 'string', required: true, description: 'Scene name under ~/.dsh/tool-management/memories; `global` = the always-on scene (any Unicode except path separators and < > : " | ? *).' },
        name: { type: 'string', required: true, description: 'Memory name = the .md file name without the extension; any Unicode is fine (Chinese included), <=64 chars, no path separators or < > : " | ? *, must not start with a dot.' },
        description: { type: 'string', required: true, description: 'One-sentence description (<=500 chars).' },
        body: { type: 'string', required: true, description: 'Markdown body (<=256 KiB).' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args) {
        const r: any = await rulesService.ops['rules-create'](args)
        if (!r || r.ok === false) throw new Error((r && r.error) || '创建规则失败')
        return 'OK: memory ' + r.rule.id + '（场景「' + (r.rule.group || '未归属') + '」启用后自动生效）'
      },
    }))
    // ---------- 子智能体工具（subagent_list / subagent_run）----------
    // exec.agent / exec.signal 由工具运行时提供（parent 与取消信号的官方通道）。
    try {
      // 与其余 12 个工具同一条注册通道：defineTool 负责编译 parameters（object root + required），
      // 裸 register 会把未编译的参数声明直接发给模型 API。
      tools.register(defineTool(defineSubagentListTool({ list: () => subagentService.list(), sceneLists: subagentSceneLists })))
      tools.register(defineTool(defineSubagentRunTool({ ...subagentService, sceneLists: subagentSceneLists })))
    } catch (e) {
      console.error('[dsh-plugin-tool-management] subagent tool registration failed:', message(e))
    }

    if (typeof ctx.on === 'function') {
      // 三个确认门的统一前裁决。口径（用户裁定，方案 B）：会话审批策略为 never（「完全权限」预设）
      // = 用户已在预设层面预先批准一切确认门，**直接放行**并写审计日志留痕。
      // 不能把 ask 丢给审批层：宿主 decide() 对 never 直接返回 rejected（fail-closed），确认卡
      // 永远弹不出，模型只会收到一句无信息量的「用户拒绝」。这与官方子代理工具（无 ask 门）
      // 在完全权限下的行为一致；探测实现与回归测试见 approval-policy.ts（必须 ctx.get('approval')，
      // 不能用 ctx.approval——inject 未声明该服务时 cordis 代理会抛 "cannot get property without inject"）。
      const CONFIRM_LABELS: Record<string, string> = {
        skill_manager_create: '「新建技能」',
        rule_manager_write: '「写入记忆」',
        subagent_run: '「运行子代理」',
      }
      const bypassedByFullAccess = (exec: any): boolean => {
        if (!isApprovalNever(ctx, exec)) return false
        // 留痕：完全权限下跳过确认属于「用户已授权」，但要可审计（日志失败不阻塞主流程）。
        pluginLog()('confirm-bypass', `完全权限（approval=never）：跳过${CONFIRM_LABELS[String(exec && exec.name)]}的确认，直接放行`).catch(() => {})
        return true
      }
      // subagent_run 的目标人设是否真实存在。确认门是「问用户要不要做」，如果这个请求
      // 本来就做不成（人设不存在），弹卡 / 写 bypass 日志只会产生一次无效审批：
      // 用户批准之后模型收到的是「人设不可用」。所以先校验，再决定要不要问。
      // 校验本身不可用时返回 true（保持原行为，绝不因为探测失败而少问一次）。
      const subagentRunTargetExists = async (exec: any): Promise<boolean> => {
        try {
          const name = String((exec && exec.arguments && exec.arguments.agent) || '').trim()
          if (!name) return false
          const list = await subagentService.list()
          return list.some((p) => p.name === name)
        } catch (e) {
          return true
        }
      }
      ;(ctx.on as (event: string, cb: (exec: any, next: () => unknown) => unknown) => unknown)('tools/pre-execute', async (exec, next) => {
        if (!exec || !CONFIRM_LABELS[String(exec.name)]) return next()
        if (exec.name === 'subagent_run' && !(await subagentRunTargetExists(exec))) return next()
        if (bypassedByFullAccess(exec)) return next()
        if (exec.name === 'skill_manager_create') {
          return Promise.resolve({ kind: 'ask', reason: 'Create a new skill under ~/.dsh/tool-management/skills' })
        }
        if (exec.name === 'rule_manager_write') {
          // D2：模型写规则默认需确认；设置关闭后直接放行。ask 无应答者时降级为拒绝（fail-closed），
          // 不在此处做任何兜底放行。
          return readPluginSettings()
            .then((s) => (s.requireConfirmForModelRuleWrite
              ? { kind: 'ask', reason: 'Write a memory under ~/.dsh/tool-management/memories' }
              : next()))
            .catch(() => ({ kind: 'ask', reason: 'Write a memory under ~/.dsh/tool-management/memories' }))
        }
        // subagent_run：子代理运行花真 token：默认确认（requireConfirmForModelSubagentRun !== false），可关。
        return readPluginSettings()
          .then((s) => ((s as any).requireConfirmForModelSubagentRun !== false
            ? { kind: 'ask', reason: 'Run a subagent (consumes tokens)' }
            : next()))
          .catch(() => ({ kind: 'ask', reason: 'Run a subagent (consumes tokens)' }))
      })
    }

    // ---------- per-tool MCP switches: execution guard + visibility ----------
    try {
      readDisabledTools().then(() => applyToolRestrictions()).catch(() => { /* side-car unavailable → no restrictions */ })
    } catch (e) { /* ignore */ }
    if (typeof tools.guard === 'function') {
      ctx.effect(() => tools.guard!((exec) => {
        try {
          // Reads the TTL cache without I/O: the guard runs on the hot path.
          const value = disabledToolsCache ? disabledToolsCache.value : {}
          if (isToolDisabled(value, String((exec && exec.name) || ''))) {
            return '该工具已在 MCP 管理页停用'
          }
        } catch (e) { /* fallthrough to allow */ }
        return undefined
      }), 'dsh-plugin-tool-management: disabled mcp tool guard')
    }
    if (typeof ctx.on === 'function') {
      try {
        // MCP servers (de)register their tools as instances come and go; the
        // visible-set restriction must track that.
        ctx.effect(() => {
          const stop = (ctx.on as (event: string, cb: () => void) => (() => void) | void)('tools/change', () => scheduleToolRestrictions())
          return typeof stop === 'function' ? stop : () => {}
        }, 'dsh-plugin-tool-management: tools/change listener')
      } catch (e) { /* ignore */ }
    }
    ctx.effect(() => () => {
      if (restrictTimer) { clearTimeout(restrictTimer); restrictTimer = null }
      if (restrictDisposer) { try { restrictDisposer() } catch (e) { /* ignore */ } restrictDisposer = null }
    }, 'dsh-plugin-tool-management: tool restriction cleanup')

    // ---------- HTTP API route (UI half), registered defensively ----------
    if (webServer) {
      // Cap request bodies (88 MiB): skill-upload carries Base64 folder/ZIP
      // payloads (64 MiB of raw content). Reachability is decided by
      // fenceRejection() below — the host's Host/Origin + browser-session fence
      // (or a correct explicit token). `config.maxBodyBytes` overrides the cap
      // (tests use a small value).
      const configuredMaxBody = Number((config as { maxBodyBytes?: unknown } | undefined)?.maxBodyBytes)
      const MAX_BODY = Number.isFinite(configuredMaxBody) && configuredMaxBody > 0 ? configuredMaxBody : 88 * 1024 * 1024
      const readBody = (req: HttpReq) => new Promise<string>((resolve, reject) => {
        // Accumulate Buffers and decode ONCE at the end: decoding each chunk
        // separately corrupts multi-byte UTF-8 characters that straddle a
        // chunk boundary (e.g. long Chinese skill bodies).
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c) => {
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
          size += buf.length
          if (size > MAX_BODY) { reject(new Error('request body too large')); return }
          chunks.push(buf)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
      // 宿主 BrowserAuth 栅栏。宿主的鉴权**只包在它自己注册的路由上**——dsh-host-webserver
      // 没有全局中间件，既定约定是每个注册方自己调 connection.requestRejection(req)：
      // 它先做 Host/Origin 栅栏（Host 必须是回环或 deployment 派生的 LAN IP 字面量，
      // 这是 DNS rebinding 唯一伪造不了的头），再叠加 browser-session cookie 鉴权。
      // 本插件此前只查公开常量 x-dsh-plugin 与自比对（Origin.host === Host）的 "同源"，
      // 两者都挡不住 rebind 后的网页或本机任意进程 —— 等于没鉴权。现在优先走宿主栅栏。
      const connection = ((): ConnectionSeam | undefined => {
        try { return ctx.get('connection') as ConnectionSeam | undefined }
        catch { return undefined }
      })()
      try {
        // ctx.effect wires the route's disposer into this plugin's scope, so an
        // unload (HMR removal, disable, update) unregisters the route — the
        // documented cleanup contract (webServer.register does not auto-scope).
        ctx.effect(() => webServer.register({
          kind: 'exact',
          path: '/dsh-plugin-tool-management/api',
          handler: async (req, res) => {
            // 鉴权顺序：POST-only → 插件门禁头（防误触，不是凭证）→ 宿主栅栏
            // （Host/Origin + browser-session cookie）→ 可选访问令牌。令牌是本地工具与
            // LAN 部署的逃生门：**令牌正确即视为已授权**，可越过浏览器鉴权；
            // 未配置令牌时不再有"谁都放行"的缺口。
            const hdr = (name: string): string => {
              const v = req.headers?.[name]
              return Array.isArray(v) ? v[0] ?? '' : v ?? ''
            }
            if (String(req.method || 'POST').toUpperCase() !== 'POST') {
              res.writeHead(405, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            if (hdr('x-dsh-plugin') !== 'dsh-plugin-tool-management') {
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'missing plugin gate header' }))
              return
            }
            const tokenAccepted = TOKEN !== '' && hdr('x-dsh-token') === TOKEN
            if (!tokenAccepted) {
              const fence = fenceRejection(req, connection)
              if (fence) {
                res.writeHead(fence.status, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: fence.error }))
                return
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            try {
              let payload: any = {}
              try {
                payload = JSON.parse((await readBody(req)) || '{}')
              } catch (e) {
                if (String((e as Error)?.message).includes('body too large')) {
                  res.end(JSON.stringify({ ok: false, error: '请求体过大' }))
                  return
                }
                /* otherwise fall through with {} */
              }
              const op = String(payload.op || '')
              // 敏感 op（会吐明文密钥与完整配置）：**必须**带对的访问令牌，没配令牌
              // 就没有明文（判定与理由见 http-fence.ts 的 secretOpRejection）。
              // 之前这里只查"有没有 Origin 头"，而 token 为空时它形同虚设 —— 任何能
              // 打开 GUI 的浏览器都拿得到全部密钥原文。
              if (SENSITIVE_OPS.has(op)) {
                const gate = secretOpRejection({ tokenConfigured: TOKEN !== '', tokenAccepted })
                if (gate) {
                  res.end(JSON.stringify({ ok: false, error: gate.error, code: gate.code }))
                  return
                }
              }
              if (TOKEN && WRITE_OPS.has(op) && hdr('x-dsh-token') !== TOKEN) {
                res.end(JSON.stringify({ ok: false, error: '缺少或错误的访问令牌（x-dsh-token）' }))
                return
              }
              const fn = handlers[op]
              if (!fn) {
                res.end(JSON.stringify({ ok: false, error: '未知操作: ' + op }))
                return
              }
              const result = await fn(payload.args || {})
              res.end(JSON.stringify(result === undefined ? { ok: true } : result))
            } catch (e) {
              res.end(JSON.stringify({ ok: false, error: message(e) }))
            }
          },
        }), 'dsh-plugin-tool-management: api route')
      } catch (e) {
        // A registration failure must never take down the whole entry: log and continue.
        console.error('[dsh-plugin-tool-management] webServer route registration failed:', message(e))
      }
    }

    // ---------- 斜杠命令：已下线 ----------
    // 曾有 /mcp、/skills、/agents-md、/scene-memory 四条（注册到 commands 服务）。
    // 用户 2026-09-13 判定「斜杠命令没多大用」→ 全部删除：面板里每一项都有等价入口，
    // 而命令输出是纯文本快照，既不能操作也容易与面板状态不一致。
    // 保留这段注释是为了让「为什么没有 /mcp」这个问题有答案可查。
  },
}

