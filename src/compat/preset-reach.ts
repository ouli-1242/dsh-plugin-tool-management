/**
 * Agent-preset injection reachability — the read-only answer to
 * "does what this plugin injects actually reach the model under the preset
 * this session runs?".
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin TELLS the model four things (scene memories, the subagent roster,
 * the MCP server list with the user's notes, and the scene prompt) by injecting
 * a synthetic message at `agent/pre-step` (see `src/context-inject.ts`). A preset
 * can still decide it wants none of that: `@deepseek-ai/dsh-persona` with
 * `complete: true` declares its prompt the only one, and `includeRuntimeContext:
 * false` switches the official runtime-context snapshot off — the shipped
 * `minimal` preset sets both. The plugin then injects nothing by default (the
 * user can force it on the compat page), and no surface may claim otherwise.
 *
 * A second, different question is whether the OFFICIAL carriers are mounted at
 * all: `@deepseek-ai/dsh-agent-instructions` (AGENTS.md) and
 * `@deepseek-ai/dsh-tool-skill` (the skill catalog) are host rows that the Web
 * bundle disables in favour of per-preset rows — a preset that mounts neither
 * gives the model no AGENTS.md text and no skill catalog, whichever persona it
 * declares.
 *
 * WHAT IS MEASURED, AND HOW
 * -------------------------
 * Answers come from each preset's own composition text, read through the
 * roster's public `read(id)` — evidence, not inference, and no mount:
 *
 *   - `personaComplete` / `includeRuntimeContext`: does the preset declare
 *     "nothing but my prompt"? (both suppress plugin-injected text)
 *   - `agentInstructions`: is `@deepseek-ai/dsh-agent-instructions` mounted?
 *     (the row that carries `~/.dsh/AGENTS.md` into the conversation)
 *   - `toolSkill`: is `@deepseek-ai/dsh-tool-skill` mounted?
 *     (the row that gives the model the skill catalog)
 *   - `mcpClient`: does the composition mount its own MCP client?
 *     (the shipped presets mount none, so MCP *tools* come from the host plane
 *     and are callable under every preset — see `ReachContext.mcpTools`)
 *
 * TOOLS ARE NOT TEXT — the distinction is the whole point:
 *
 *   - TOOL plane (host, preset-independent): the plugin's own model tools and
 *     every `mcp__*` tool register in the HOST plane (this plugin's loader row in
 *     the profile patch), so every preset's session resolves them.
 *   - TEXT plane (preset-dependent): the runtime snapshot the plugin injects, the
 *     AGENTS.md carrier, and the skill catalog. Callable is not the same as
 *     known: under `minimal` the model can call every `mcp__*` tool while knowing
 *     nothing about the servers behind them — no names, no tool counts, no
 *     enablement, and none of the user's notes.
 *
 * Reading never mounts. `list()`/`read(id)` are roster reads, so building the
 * matrix cannot activate a preset early — the same guarantee
 * `compositionInventory()` gives the plugin-listing surfaces.
 *
 * This module is deliberately advisory: it never changes what is injected and
 * never refuses an operation. A preset that asks for no extra text is doing
 * exactly what its author asked for; the plugin's job is to say so out loud and
 * point at the switch that overrides it.
 */
import { MCP_CLIENT_MODULE } from '../host-names.js'

/**
 * `MCP_CLIENT_MODULE` (from `host-names.ts`) is the client name this module scans
 * for: an MCP client mounted INSIDE a composition. The shipped presets mount
 * none, so MCP tools normally come from the host plane
 * (the `$DSH_HOME/cordis.patch.yml` layer) and are callable under every preset; a
 * user-authored preset that mounts its own client only carries those tools under
 * itself, and this scan is how the page can tell the two apart. Tool reachability
 * is not the column's answer, though — the server list and the user's notes are a
 * prompt section, which a complete persona suppresses whichever client serves the
 * tools.
 */

/** Whether one composition mounts a given module, and whether it is switched on. */
export type ModulePresence = 'mounted' | 'absent' | 'conditional'

/**
 * Whether one capability reaches the model under a preset.
 *
 * `absent` is a routing fact (the row is not in this composition), not a
 * failure; `suppressed` means the row may be mounted but the persona's
 * complete flag keeps every other prompt section out of the prompt.
 */
export type ReachState = 'ok' | 'suppressed' | 'absent' | 'unknown'

/** Facts parsed out of ONE preset's composition text. */
export interface CompositionFacts {
  /** `true` only when a live `@deepseek-ai/dsh-persona` row declares it. */
  readonly personaComplete: boolean | 'unknown'
  /**
   * The persona row's `includeRuntimeContext` (schema default `true`).
   *
   * `false` makes `dsh-persona` call `systemPrompt.suppressRuntimeContext()`, which kills the
   * official runtime-context snapshot (sandbox / approval policy) — and would kill this
   * plugin's text too if it went through `systemPrompt.context()`. The shipped `minimal`
   * preset sets it; that is why the plugin's injection lives on the `agent/pre-step` message
   * channel instead (see src/context-inject.ts).
   */
  readonly includeRuntimeContext: boolean | 'unknown'
  /** Whether the preset mounts that persona row at all (global fallback otherwise). */
  readonly personaMounted: boolean
  readonly agentInstructions: ModulePresence
  readonly toolSkill: ModulePresence
  /** Whether the composition mounts its own MCP client. */
  readonly mcpClient: ModulePresence
  /** Why the text could not be parsed, when it could not. */
  readonly parseFailure?: string
}

/** One preset's reachability row. */
export interface PresetReachRow {
  readonly presetId: string
  readonly name?: string
  readonly trust?: string
  readonly isDefault: boolean
  readonly personaComplete: boolean | 'unknown'
  readonly personaMounted: boolean
  readonly agentInstructions: ModulePresence
  readonly toolSkill: ModulePresence
  /** The scene catalog this plugin injects (enabled scenes + their descriptions). */
  readonly scene: ReachState
  /** Memory entries this plugin injects (under each scene). */
  readonly memory: ReachState
  /** `~/.dsh/AGENTS.md`, carried by `dsh-agent-instructions`. */
  readonly agentsMd: ReachState
  /** The skill catalog the `skill` tool publishes. */
  readonly skillCatalog: ReachState
  /** The official delegation tool (`subagent`), which `minimal` does not mount. */
  readonly subagent: ReachState
  /** MCP tools: this preset's own client, else the host-plane set. */
  readonly mcp: ReachState
  /** persona `complete: true` or `includeRuntimeContext: false` — the preset asks for no extra text. */
  readonly suppressing: boolean
  /** Why the preset cannot compose a session at all, when discovery said so. */
  readonly broken?: string
  /** Why this row's answers are `unknown`, when they are. */
  readonly reason?: string
}

/** The whole matrix, as surfaced to the settings page. */
export interface PresetReachReport {
  readonly rows: readonly PresetReachRow[]
  readonly defaultId: string | null
  readonly generatedAt: number
  readonly summary: string
  readonly blockers: readonly string[]
  /** Host-plane MCP state, repeated on every row that carries no MCP client. */
  readonly mcpTools?: number
}

/** Facts the caller contributes about the host plane (no composition can answer them). */
export interface ReachContext {
  /** Live `mcp__*` tool count on the host plane; `undefined` when the probe failed. */
  readonly mcpTools?: number
  /**
   * The plugin's injection settings, when the caller has them loaded: with
   * `underSuppressingPresets` on, a suppressing preset no longer hides the plugin's text,
   * and a domain switched off is honestly `absent` rather than `ok`.
   */
  readonly inject?: {
    readonly underSuppressingPresets: boolean
    readonly domains: Readonly<Record<string, boolean>>
  }
}

/**
 * The preset facts the injection decision needs (src/context-inject.ts): whether the preset
 * asks for "nothing but my prompt", and which OFFICIAL carriers it mounts — the plugin's
 * fallback domains only fire where those carriers are missing (AGENTS.md, the skill catalog),
 * so the two sides never deliver the same text twice.
 */
export interface PresetInjectionFacts {
  /** persona `complete: true` or `includeRuntimeContext: false` — the preset wants no extra text. */
  readonly suppressing: boolean
  /** The composition mounts `@deepseek-ai/dsh-agent-instructions` (the `~/.dsh/AGENTS.md` carrier). */
  readonly carriesAgentsMd: boolean
  /** The composition mounts `@deepseek-ai/dsh-tool-skill` (the official skill catalog + loader). */
  readonly carriesSkillCatalog: boolean
}

/** Whether a preset declares "no extra text": persona `complete: true` or runtime context off. */
export function isSuppressingPreset(facts: CompositionFacts): boolean {
  return facts.personaComplete === true || facts.includeRuntimeContext === false
}

/** Map composition facts onto the injection decision's facts (parse failure → not suppressing). */
export function injectionFactsOf(facts: CompositionFacts | undefined): PresetInjectionFacts | undefined {
  if (facts === undefined) return undefined
  return {
    suppressing: isSuppressingPreset(facts),
    carriesAgentsMd: facts.agentInstructions === 'mounted',
    carriesSkillCatalog: facts.toolSkill === 'mounted',
  }
}

/** Module specifiers whose mounting decides reachability. */
const PERSONA_MODULE = '@deepseek-ai/dsh-persona'
const AGENT_INSTRUCTIONS_MODULE = '@deepseek-ai/dsh-agent-instructions'
const TOOL_SKILL_MODULE = '@deepseek-ai/dsh-tool-skill'

const NAME_LINE = /^(\s*)name:\s*(['"]?)([^'"\s#]+)\2\s*(?:#.*)?$/
const ENTRY_LINE = /^(\s*)-\s/
const DISABLED_LINE = /^\s*disabled:\s*(.+?)\s*(?:#.*)?$/
const COMPLETE_LINE = /^\s*complete:\s*(true|false)\s*(?:#.*)?$/
const RUNTIME_CONTEXT_LINE = /^\s*includeRuntimeContext:\s*(true|false)\s*(?:#.*)?$/

/** Leading whitespace width of a line, used as its nesting level. */
function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * The lines belonging to the composition row that owns `nameIndex`.
 *
 * The row starts at the nearest entry bullet above the `name:` line that is
 * less indented than it (a nested row inside a `cordis:group` still gets its
 * own block) and ends at the next bullet at or above that bullet's indent.
 */
function rowBlockAround(lines: readonly string[], nameIndex: number): readonly string[] {
  const nameIndent = indentOf(lines[nameIndex])
  let start = nameIndex
  for (let i = nameIndex - 1; i >= 0; i -= 1) {
    const entry = ENTRY_LINE.exec(lines[i])
    if (entry !== null && entry[1].length < nameIndent) {
      start = i
      break
    }
  }
  const entryIndent = indentOf(lines[start])
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const entry = ENTRY_LINE.exec(lines[i])
    if (entry !== null && entry[1].length <= entryIndent) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

/**
 * How the row owning `nameIndex` decides enablement.
 *
 * `!!js` expressions are only answerable inside a mount, so they stay
 * `'conditional'` rather than being guessed — the same rule
 * `compositionInventory()` applies to its disabled gates.
 */
function presenceForRow(lines: readonly string[], nameIndex: number): ModulePresence {
  for (const line of rowBlockAround(lines, nameIndex)) {
    const disabled = DISABLED_LINE.exec(line)
    if (disabled === null) continue
    const value = disabled[1].trim()
    if (value === 'true') return 'absent'
    if (value.startsWith('!!js')) return 'conditional'
    return 'mounted'
  }
  return 'mounted'
}

/** Whether ANY row naming `specifier` survives into the composition. */
function presenceOf(lines: readonly string[], specifier: string): ModulePresence {
  let best: ModulePresence = 'absent'
  for (let i = 0; i < lines.length; i += 1) {
    const named = NAME_LINE.exec(lines[i])
    if (named === null || named[3] !== specifier) continue
    const presence = presenceForRow(lines, i)
    if (presence === 'mounted') return 'mounted'
    if (presence === 'conditional') best = 'conditional'
  }
  return best
}

/**
 * Parse the facts that decide reachability out of one composition's text.
 *
 * Deliberately a text scan rather than a YAML load: this module must not add
 * a parser dependency, and every question it asks is answered by a row's own
 * key/value lines. A `complete: true` nested inside a multi-line scalar cannot
 * produce a false positive because the match is anchored to a whole line.
 *
 * Never throws: unparsable input degrades to `unknown`, which the caller
 * renders as "could not tell" instead of "fine".
 */
export function readCompositionFacts(text: string): CompositionFacts {
  try {
    const lines = String(text ?? '').split(/\r?\n/)
    if (lines.length <= 1 && lines[0] === '') {
      return {
        personaComplete: 'unknown',
        includeRuntimeContext: 'unknown',
        personaMounted: false,
        agentInstructions: 'absent',
        toolSkill: 'absent',
        mcpClient: 'absent',
        parseFailure: '组合文件为空',
      }
    }

    let personaComplete: boolean | 'unknown' = false
    // Schema default is `true`: a mounted persona row that does not state the flag keeps
    // the official runtime context (only `false` suppresses it).
    let includeRuntimeContext: boolean | 'unknown' = true
    let personaMounted = false
    for (let i = 0; i < lines.length; i += 1) {
      const named = NAME_LINE.exec(lines[i])
      if (named === null || named[3] !== PERSONA_MODULE) continue
      // A disabled persona row does not shadow the deployment persona.
      if (presenceForRow(lines, i) === 'absent') continue
      personaMounted = true
      for (const line of rowBlockAround(lines, i)) {
        const complete = COMPLETE_LINE.exec(line)
        if (complete !== null) personaComplete = complete[1] === 'true'
        const runtime = RUNTIME_CONTEXT_LINE.exec(line)
        if (runtime !== null) includeRuntimeContext = runtime[1] === 'true'
      }
      break
    }

    return {
      personaComplete,
      includeRuntimeContext,
      personaMounted,
      agentInstructions: presenceOf(lines, AGENT_INSTRUCTIONS_MODULE),
      toolSkill: presenceOf(lines, TOOL_SKILL_MODULE),
      mcpClient: presenceOf(lines, MCP_CLIENT_MODULE),
    }
  } catch (error) {
    return {
      personaComplete: 'unknown',
      includeRuntimeContext: 'unknown',
      personaMounted: false,
      agentInstructions: 'absent',
      toolSkill: 'absent',
      mcpClient: 'absent',
      parseFailure: String((error as Error)?.message ?? error),
    }
  }
}

/** Map parsed facts onto the five user-visible capability columns. */
export function deriveReach(
  facts: CompositionFacts,
  ctx?: ReachContext,
): Pick<PresetReachRow, 'scene' | 'memory' | 'agentsMd' | 'skillCatalog' | 'subagent' | 'mcp'> {
  const suppressed = isSuppressingPreset(facts)
  const personaUnknown = facts.personaComplete === 'unknown'
  const forceUnderSuppressing = ctx?.inject?.underSuppressingPresets === true
  const domainOff = (key: string): boolean => ctx?.inject?.domains?.[key] === false

  /**
   * 本插件自己的文本（场景 / 记忆 / MCP 服务器与备注 / 技能目录 / 子智能体目录 / 提示词）
   * 走 `agent/pre-step` 注入消息（src/context-inject.ts）—— 不再依赖系统提示词段，所以
   * `persona complete` 压不到它。可达性只看两件事：域开关有没有关、预设压制时有没有开
   * 「仍然注入」。预设信息读不到（`personaUnknown` 且无压制信号）时按可达处理。
   */
  const pluginText = (key: string): ReachState => {
    if (domainOff(key)) return 'absent'
    if (suppressed && !forceUnderSuppressing) return 'suppressed'
    return 'ok'
  }
  const scene = pluginText('scene')
  const memory = pluginText('memory')
  const mcp = pluginText('mcp')

  /**
   * 官方两条行承载的能力（提示词 / 技能目录）：挂得上就官方送（它也走 pre-step 注入消息，
   * persona `complete` 压不到），挂不上就由本插件的同名域兜底 —— 所以"这一行没挂"不等于
   * "模型看不到"，只有兜底域也关掉（或缺省 `跟随预设`）时才是。
   */
  const officialOrFallback = (domainKey: string, carrier: ModulePresence): ReachState => {
    // 官方那条行挂着 = **官方自己送到**，与本插件的域开关无关（开关只管本插件的兜底）：
    // 用户实测（2026-09-16）—— 把注入域全关掉后，标准 / ptc / 创造三行的技能与提示词
    // 依然应该是绿的（模型确实拿得到，官方 `dsh-tool-skill` / `dsh-agent-instructions` 送），
    // 只有极简那行是红的（两条行都没挂 + 兜底也关着）。
    if (carrier === 'mounted') return 'ok'
    // 组合文本读不出来时既不能断言官方到得了，也不能断言本插件会兜底
    // （注入侧对读不到的预设保守跳过兜底域）→ 如实报"判断不了"。
    if (personaUnknown) return 'unknown'
    // 官方行"可能挂着"（有条件启用）同样判断不了：注入侧对本插件兜底域的门槛是"官方明确没挂"
    // （`carrier !== false`），所以这种预设下兜底根本不会发，官方挂不挂只有挂载期才知道。
    if (carrier === 'conditional') return 'unknown'
    if (domainOff(domainKey)) return 'absent'
    if (suppressed && !forceUnderSuppressing) return 'suppressed'
    return 'ok'
  }
  const agentsMd = officialOrFallback('prompt', facts.agentInstructions)
  const skillCatalog = officialOrFallback('skills', facts.toolSkill)

  // 子智能体列（用户裁定 2026-09-16 第二版）：与记忆 / MCP 两列**同口径** —— 答"人设目录
  // 到不到得了模型"。内容由本插件的注入域送达，跑起来用本插件自己的 `subagent_manager_run`
  // （宿主平面工具，任何预设下都在），所以可达性只看域开关与压制。此前这一列只答"官方
  // `dsh-tool-subagent` 挂没挂"——于是极简下就算开了「极简模式也注入」也永远红着，而那条官方
  // 工具只是另一种委派入口（它认的是通用子代理，不认本插件的人设目录），与人设可达无关。
  const subagent = pluginText('subagents')

  // MCP 列答的是"服务器清单与备注到不到得了"：宿主工具数不再参与 —— 清单为空时注入出去
  // 也是空段（没什么可看的），"有几台 server"由插件页面回答，不是这一列的事。
  return { scene, memory, agentsMd, skillCatalog, subagent, mcp }
}

/**
 * The roster surface this module reads. Every member is optional so a
 * deployment without `@deepseek-ai/dsh-agent-presets` degrades to a blocker
 * line instead of a throw.
 */
export interface PresetRosterLike {
  list?: () => Promise<unknown>
  read?: (id: string) => Promise<string>
  composedPreset?: (agentCtx: unknown) => string | undefined
  defaultId?: string
}

/** Narrow the roster off a cordis context without throwing. */
export function presetRosterOf(ctx: { get?: (name: string) => unknown }): PresetRosterLike | undefined {
  try {
    const value = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    return value === null || typeof value !== 'object' ? undefined : (value as PresetRosterLike)
  } catch {
    return undefined
  }
}

async function composeRow(roster: PresetRosterLike, meta: Record<string, unknown>, ctx?: ReachContext): Promise<PresetReachRow> {
  const presetId = String(meta.id ?? '')
  const name = typeof meta.name === 'string' ? meta.name : undefined
  const trust = typeof meta.trust === 'string' ? meta.trust : undefined
  const broken = typeof meta.broken === 'string' ? meta.broken : undefined
  const isDefault = roster.defaultId !== undefined && String(roster.defaultId) === presetId
  const base = {
    presetId,
    ...(name === undefined ? {} : { name }),
    ...(trust === undefined ? {} : { trust }),
    isDefault,
    ...(broken === undefined ? {} : { broken }),
  }

  if (typeof roster.read !== 'function') {
    return {
      ...base,
      personaComplete: 'unknown',
      personaMounted: false,
      agentInstructions: 'absent',
      toolSkill: 'absent',
      suppressing: false,
      scene: 'unknown',
      memory: 'unknown',
      agentsMd: 'unknown',
      skillCatalog: 'unknown',
      subagent: 'unknown',
      mcp: 'unknown',
      reason: '预设名单未提供 read()：无法读取组合文件',
    }
  }

  let text: string
  try {
    text = String((await roster.read(presetId)) ?? '')
  } catch (error) {
    return {
      ...base,
      personaComplete: 'unknown',
      personaMounted: false,
      agentInstructions: 'absent',
      toolSkill: 'absent',
      suppressing: false,
      scene: 'unknown',
      memory: 'unknown',
      agentsMd: 'unknown',
      skillCatalog: 'unknown',
      subagent: 'unknown',
      mcp: 'unknown',
      reason: `读取组合失败：${String((error as Error)?.message ?? error)}`,
    }
  }

  const facts = readCompositionFacts(text)
  const reach = deriveReach(facts, ctx)
  return {
    ...base,
    personaComplete: facts.personaComplete,
    personaMounted: facts.personaMounted,
    agentInstructions: facts.agentInstructions,
    toolSkill: facts.toolSkill,
    suppressing: isSuppressingPreset(facts),
    ...reach,
    ...(facts.parseFailure === undefined ? {} : { reason: `解析组合失败：${facts.parseFailure}` }),
  }
}

/**
 * Build the whole preset × capability matrix.
 *
 * Read-only end to end; a preset whose text cannot be read yields a named
 * `reason` on its own row rather than failing the report.
 */
export async function assessPresetReach(roster: PresetRosterLike | undefined, ctx?: ReachContext): Promise<PresetReachReport> {
  const generatedAt = Date.now()
  const mcpField = ctx?.mcpTools === undefined ? {} : { mcpTools: ctx.mcpTools }
  if (roster === undefined || typeof roster.list !== 'function') {
    return {
      rows: [],
      defaultId: null,
      generatedAt,
      ...mcpField,
      summary: '预设可达性不可用（宿主未挂载 Agent 预设服务）',
      blockers: ['agentPresets 服务未挂载：无法判断各预设下的注入边界'],
    }
  }

  let presets: unknown[]
  try {
    const listed = await roster.list()
    presets = Array.isArray(listed) ? listed : []
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
    return {
      rows: [],
      defaultId: null,
      generatedAt,
      ...mcpField,
      summary: '预设可达性不可用（读取预设名单失败）',
      blockers: [`读取预设名单失败：${detail}`],
    }
  }

  const rows: PresetReachRow[] = []
  for (const raw of presets) {
    if (raw === null || typeof raw !== 'object') continue
    const meta = raw as Record<string, unknown>
    if (String(meta.id ?? '') === '') continue
    rows.push(await composeRow(roster, meta, ctx))
  }

  const suppressed = rows.filter((row) => row.memory === 'suppressed').length
  const summary = rows.length === 0
    ? '未发现任何 Agent 预设'
    : `预设 ${rows.length} 个 · 压制型预设（本插件默认不注入）${suppressed} 个 · 提示词通道缺失 ${rows.filter((row) => row.agentsMd === 'absent').length} 个 · 技能目录缺失 ${rows.filter((row) => row.skillCatalog === 'absent').length} 个 · 子智能体目录缺失 ${rows.filter((row) => row.subagent === 'absent').length} 个`

  return {
    rows,
    defaultId: roster.defaultId === undefined ? null : String(roster.defaultId),
    generatedAt,
    ...mcpField,
    summary,
    blockers: [],
  }
}

/**
 * The one-line boundary notice a model tool appends to its result.
 *
 * This is the load-bearing half of the fix: a model that lists memories while
 * running under a suppressing preset would otherwise assume those memories are
 * already in its context. The same reasoning covers MCP and the subagent roster:
 * none of them reach the model while the preset keeps the plugin's runtime
 * snapshot out of the conversation, so the notice says which tool to call
 * instead — and where the user can flip that off.
 *
 * Pure and synchronous so a contract test can pin the wording to the facts.
 *
 * 写法纪律（2026-09-16 第三版）：
 *   - **不点名任何工具**。这条提示挂在 5 个发现型工具上，点名就必然出现循环
 *     （`mcp_manager_list` 的结果里写着「用 mcp_manager_list 查询」——
 *     用户实测发现）。按域名过滤只是把循环换成残缺列表；干脆不枚举：**域 → 工具**的
 *     映射属于工具描述（常驻层），提示只负责说清「什么不在你上下文里」。
 *   - 全域一句话说完，不逐域展开；不复述工具 schema 的细节。
 *   - 第二版把"被 persona complete 压制"当成不可改变的事实；现在本插件改走 pre-step
 *     注入消息（src/context-inject.ts），压制型预设下**默认不注入但可以打开**，
 *     提示里如实给出这个开关的位置。
 *
 * @returns the notice, or `''` when nothing is out of context.
 */
export function reachNoticeFor(
  presetId: string,
  facts: CompositionFacts,
  inject?: { readonly underSuppressingPresets?: boolean; readonly domains?: Readonly<Record<string, boolean>> },
): string {
  const parts: string[] = []
  const domainOff = (key: string): boolean => inject?.domains?.[key] === false
  if (isSuppressingPreset(facts) && inject?.underSuppressingPresets !== true) {
    parts.push(
      `预设「${presetId}」声明只要它自己的文本（persona complete / 关闭运行时上下文）：` +
      '本插件注入的 —— 场景、记忆、MCP、技能、子智能体、提示词 —— 默认不注入，' +
      '需要时用对应的 list / read 工具按需读取；不要假设你已经看到它们。' +
      '（想让它在这类预设下也注入：插件的「兼容」页 → 注入。）',
    )
  } else {
    if (facts.agentInstructions !== 'mounted' && domainOff('prompt')) {
      parts.push(`提示词（~/.dsh/AGENTS.md）不会自动进入你的上下文：预设「${presetId}」未挂载 @deepseek-ai/dsh-agent-instructions，本插件的注入兜底也关着。`)
    }
    if (facts.toolSkill !== 'mounted' && domainOff('skills')) {
      parts.push('技能目录不在你的上下文里（官方 @deepseek-ai/dsh-tool-skill 行没挂，本插件的注入兜底也关着）。')
    }
  }
  if (parts.length === 0) return ''
  return '\n\n⚠ 当前预设的注入边界：' + parts.join(' ')
}

/**
 * Resolve the notice for the agent a tool call runs as.
 *
 * Every failure path answers `''` — a boundary notice must never turn a
 * successful read into an error.
 */
export async function reachNoticeForAgent(
  roster: PresetRosterLike | undefined,
  agentCtx: unknown,
  inject?: { readonly underSuppressingPresets?: boolean; readonly domains?: Readonly<Record<string, boolean>> },
): Promise<string> {
  if (roster === undefined || typeof roster.composedPreset !== 'function' || agentCtx === undefined || agentCtx === null) return ''
  let presetId = ''
  try {
    presetId = String(roster.composedPreset(agentCtx) ?? '')
  } catch {
    return ''
  }
  if (presetId === '' || typeof roster.read !== 'function') return ''
  try {
    return reachNoticeFor(presetId, readCompositionFacts(String((await roster.read(presetId)) ?? '')), inject)
  } catch {
    return ''
  }
}
