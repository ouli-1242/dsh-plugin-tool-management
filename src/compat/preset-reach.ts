/**
 * Agent-preset injection reachability — the read-only answer to
 * "does what this plugin injects actually reach the model under the preset
 * this session runs?".
 *
 * WHY THIS EXISTS
 * ---------------
 * `prompt-sections.ts` registers a per-agent `systemPrompt` section, and the
 * registration SUCCEEDS under every preset. But `@deepseek-ai/dsh-persona`
 * with `complete: true` makes the prompt registry restore its prefix as the
 * ONLY section at assembly time, so the section never reaches the model — and
 * the plugin had no way to notice. The memories page kept reporting
 * "injected" while the model saw nothing.
 *
 * WHAT IS MEASURED, AND HOW
 * -------------------------
 * Answers come from each preset's own composition text, read through the
 * roster's public `read(id)` — evidence, not inference, and no mount:
 *
 *   - `personaComplete`: does the preset mount `@deepseek-ai/dsh-persona`
 *     with `complete: true`? (that flag suppresses EVERY other prompt section)
 *   - `agentInstructions`: is `@deepseek-ai/dsh-agent-instructions` mounted?
 *     (the row that carries `~/.dsh/AGENTS.md` into the prompt)
 *   - `toolSkill`: is `@deepseek-ai/dsh-tool-skill` mounted?
 *     (the row that gives the model the skill catalog)
 *   - `subagentTool`: is `@deepseek-ai/dsh-tool-subagent` mounted?
 *     (the official delegation tool; the shipped `minimal` preset has none)
 *   - `mcpClient`: does the composition mount its own MCP client?
 *     (the shipped presets mount none, so MCP comes from the host plane and is
 *     equally available under every preset — see `ReachContext.mcpTools`)
 *
 * The plugin's own 14 model tools need NO probe: they register in the HOST
 * plane (this plugin's loader row in the profile patch), so every preset's
 * session resolves them. Verified against the shipped `minimal` preset on
 * 2026-09-14: tools callable, skill catalog absent, memory and AGENTS.md
 * injection suppressed.
 *
 * Reading never mounts. `list()`/`read(id)` are roster reads, so building the
 * matrix cannot activate a preset early — the same guarantee
 * `compositionInventory()` gives the plugin-listing surfaces.
 *
 * This module is deliberately advisory: it never changes what is injected and
 * never refuses an operation. A preset that suppresses prompt text is doing
 * exactly what its author asked for; the plugin's job is to say so out loud
 * instead of reporting a success the model cannot observe.
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
  /** Whether the preset mounts that persona row at all (global fallback otherwise). */
  readonly personaMounted: boolean
  readonly agentInstructions: ModulePresence
  readonly toolSkill: ModulePresence
  /** Whether the composition mounts its own official delegation tool. */
  readonly subagentTool: ModulePresence
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
  /** Scene memories registered by this plugin. */
  readonly memory: ReachState
  /** `~/.dsh/AGENTS.md`, carried by `dsh-agent-instructions`. */
  readonly agentsMd: ReachState
  /** The skill catalog the `skill` tool publishes. */
  readonly skillCatalog: ReachState
  /** The official delegation tool (`subagent`), which `minimal` does not mount. */
  readonly subagent: ReachState
  /** MCP tools: this preset's own client, else the host-plane set. */
  readonly mcp: ReachState
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
}

/** Module specifiers whose mounting decides reachability. */
const PERSONA_MODULE = '@deepseek-ai/dsh-persona'
const AGENT_INSTRUCTIONS_MODULE = '@deepseek-ai/dsh-agent-instructions'
const TOOL_SKILL_MODULE = '@deepseek-ai/dsh-tool-skill'
/**
 * The OFFICIAL delegation tool. Absent in the shipped `minimal` preset, present
 * in the other three — the one column whose answer really does differ per
 * preset. (This plugin's own `subagent_list`/`subagent_run` are host-plane and
 * therefore preset-independent; the page's footer says so.)
 */
const SUBAGENT_TOOL_MODULE = '@deepseek-ai/dsh-tool-subagent'
/**
 * An MCP client mounted INSIDE a composition. The shipped presets mount none,
 * so MCP normally comes from the host plane (the `$DSH_HOME/cordis.patch.yml`
 * layer) and works under every preset; a user-authored preset that mounts its
 * own client only carries MCP under itself, and this scan is how the page can
 * tell the two apart.
 */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

const NAME_LINE = /^(\s*)name:\s*(['"]?)([^'"\s#]+)\2\s*(?:#.*)?$/
const ENTRY_LINE = /^(\s*)-\s/
const DISABLED_LINE = /^\s*disabled:\s*(.+?)\s*(?:#.*)?$/
const COMPLETE_LINE = /^\s*complete:\s*(true|false)\s*(?:#.*)?$/

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
        personaMounted: false,
        agentInstructions: 'absent',
        toolSkill: 'absent',
        subagentTool: 'absent',
        mcpClient: 'absent',
        parseFailure: '组合文件为空',
      }
    }

    let personaComplete: boolean | 'unknown' = false
    let personaMounted = false
    for (let i = 0; i < lines.length; i += 1) {
      const named = NAME_LINE.exec(lines[i])
      if (named === null || named[3] !== PERSONA_MODULE) continue
      // A disabled persona row does not shadow the deployment persona.
      if (presenceForRow(lines, i) === 'absent') continue
      personaMounted = true
      for (const line of rowBlockAround(lines, i)) {
        const complete = COMPLETE_LINE.exec(line)
        if (complete !== null) {
          personaComplete = complete[1] === 'true'
          break
        }
      }
      break
    }

    return {
      personaComplete,
      personaMounted,
      agentInstructions: presenceOf(lines, AGENT_INSTRUCTIONS_MODULE),
      toolSkill: presenceOf(lines, TOOL_SKILL_MODULE),
      subagentTool: presenceOf(lines, SUBAGENT_TOOL_MODULE),
      mcpClient: presenceOf(lines, MCP_CLIENT_MODULE),
    }
  } catch (error) {
    return {
      personaComplete: 'unknown',
      personaMounted: false,
      agentInstructions: 'absent',
      toolSkill: 'absent',
      subagentTool: 'absent',
      mcpClient: 'absent',
      parseFailure: String((error as Error)?.message ?? error),
    }
  }
}

/** Map parsed facts onto the five user-visible capability columns. */
export function deriveReach(
  facts: CompositionFacts,
  ctx?: ReachContext,
): Pick<PresetReachRow, 'memory' | 'agentsMd' | 'skillCatalog' | 'subagent' | 'mcp'> {
  const suppressed = facts.personaComplete === true
  const personaUnknown = facts.personaComplete === 'unknown'

  let memory: ReachState = suppressed ? 'suppressed' : personaUnknown ? 'unknown' : 'ok'

  let agentsMd: ReachState
  if (suppressed) agentsMd = 'suppressed'
  else if (personaUnknown) agentsMd = 'unknown'
  else if (facts.agentInstructions === 'absent') agentsMd = 'absent'
  else if (facts.agentInstructions === 'conditional') agentsMd = 'unknown'
  else agentsMd = 'ok'

  let skillCatalog: ReachState
  if (facts.toolSkill === 'mounted') skillCatalog = 'ok'
  else if (facts.toolSkill === 'conditional') skillCatalog = 'unknown'
  else skillCatalog = 'absent'

  // The official delegation tool is a plain mounting fact: it is a model-facing
  // tool row, so nothing the persona does can hide it.
  let subagent: ReachState
  if (facts.subagentTool === 'mounted') subagent = 'ok'
  else if (facts.subagentTool === 'conditional') subagent = 'unknown'
  else subagent = 'absent'

  // MCP: a client mounted in THIS composition only serves this preset; otherwise
  // the answer is the host plane's, which every preset shares. An unknown host
  // count is reported as `unknown` rather than assumed to be fine.
  let mcp: ReachState
  if (facts.mcpClient === 'mounted') mcp = 'ok'
  else if (facts.mcpClient === 'conditional') mcp = 'unknown'
  else if (ctx === undefined || ctx.mcpTools === undefined) mcp = 'unknown'
  else mcp = ctx.mcpTools > 0 ? 'ok' : 'absent'

  return { memory, agentsMd, skillCatalog, subagent, mcp }
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
    : `预设 ${rows.length} 个 · 抑制记忆注入 ${suppressed} 个 · 技能目录缺失 ${rows.filter((row) => row.skillCatalog === 'absent').length} 个 · 无官方子智能体工具 ${rows.filter((row) => row.subagent === 'absent').length} 个`

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
 * already in its context. Pure and synchronous so a contract test can pin the
 * wording to the facts.
 *
 * @returns the notice, or `''` when nothing is suppressed.
 */
export function reachNoticeFor(presetId: string, facts: CompositionFacts): string {
  const parts: string[] = []
  if (facts.personaComplete === true) {
    parts.push(
      `场景记忆正文与 ~/.dsh/AGENTS.md 都不会自动进入你的上下文：预设「${presetId}」的 persona 是 complete，提示词只保留该 persona 本身。`,
      '不要假设你已经看到任何记忆正文；需要内容时用 rule_manager_read 逐条读取。',
    )
  } else if (facts.agentInstructions === 'absent') {
    parts.push(`~/.dsh/AGENTS.md 不会自动进入你的上下文：预设「${presetId}」未挂载 @deepseek-ai/dsh-agent-instructions。`)
  }
  if (facts.toolSkill === 'absent') {
    parts.push(`技能目录在该预设下不可见（未挂载 @deepseek-ai/dsh-tool-skill）。`)
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
    return reachNoticeFor(presetId, readCompositionFacts(String((await roster.read(presetId)) ?? '')))
  } catch {
    return ''
  }
}
