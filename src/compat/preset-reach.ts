/**
 * 预设注入可达性：只读地回答「本插件注入的内容，在当前预设下是否真的到得了模型」。
 *
 * 为什么需要它
 * ------------
 * 插件在 `agent/pre-step` 注入一条合成消息，告诉模型四件事：场景记忆、子智能体目录、带用户
 * 备注的 MCP 服务器清单、场景提示词（见 `src/context-inject.ts`）。预设仍可以拒绝这一切：
 * `@deepseek-ai/dsh-persona` 的 `complete: true` 声明自己的提示词是唯一一份，
 * `includeRuntimeContext: false` 关掉官方运行时快照 —— 出厂 `minimal` 预设两者都开。此时插件
 * 默认不注入（用户可在兼容页强制打开），任何界面都不能声称注入到了。
 *
 * 另一个不同的问题是官方载体在不在：`@deepseek-ai/dsh-agent-instructions`（AGENTS.md）与
 * `@deepseek-ai/dsh-tool-skill`（技能目录）是 Web bundle 为按预设行让位而关掉的宿主行 ——
 * 两者都不挂的预设，无论声明什么 persona，模型都拿不到 AGENTS.md 正文与技能目录。
 *
 * 量什么、怎么量
 * --------------
 * 答案来自每个预设自己的组合文本，经 roster 的公开 `read(id)` 读取 —— 是证据，不是推断，且
 * 不触发挂载：
 *
 *   - `personaComplete` / `includeRuntimeContext`：预设是否声明「只要我自己的提示词」？
 *     （两者都会压掉插件注入的文本）
 *   - `agentInstructions`：`@deepseek-ai/dsh-agent-instructions` 挂了吗？
 *     （把 `~/.dsh/AGENTS.md` 送进对话的那一行）
 *   - `toolSkill`：`@deepseek-ai/dsh-tool-skill` 挂了吗？（把技能目录给模型的那一行）
 *   - `mcpClient`：组合是否挂了自己的 MCP 客户端？（出厂预设都不挂，所以 MCP 工具来自宿主
 *     平面，在任何预设下都可调用 —— 见 `ReachContext.mcpTools`）
 *
 * 工具不是文本 —— 这个区分就是全部要点：
 *
 *   - 工具平面（宿主，与预设无关）：插件自己的模型工具与所有 `mcp__*` 工具注册在宿主平面
 *     （本插件在 profile patch 里的 loader 行），所以每个预设的会话都能解析到它们。
 *   - 文本平面（随预设变化）：插件注入的运行时快照、AGENTS.md 载体、技能目录。「可调用」不等于
 *     「知道」：`minimal` 下模型能调用每个 `mcp__*` 工具，却对背后的服务器一无所知 —— 没有名字、
 *     没有工具数、没有启用状态，也没有用户的备注。
 *
 * 读取不触发挂载：`list()` / `read(id)` / `readDocument(id)` 都是 roster 读，构建矩阵不会提前
 * 激活预设 —— 与 `compositionInventory()` 给插件列表界面的保证相同。
 *
 * 本模块刻意只做告知：从不改变注入内容，也从不拒绝操作。预设要求不加额外文本，正是其作者
 * 想要的结果；插件的职责是把这件事说出来，并指向能覆盖它的开关。
 */
import { MCP_CLIENT_MODULE } from '../host-names.js'
import { noteRuntime } from './runtime-notes.js'

// 本模块扫描的客户端名是 `MCP_CLIENT_MODULE`（见 `host-names.ts`）：它指**装在一个组合
// 内部**的 MCP 客户端。出厂预设一个都不装，所以 MCP 工具通常来自宿主平面（`$DSH_HOME/
// cordis.patch.yml` 那一层），在任何预设下都可调；用户自写的预设若自带客户端，那些工具
// 只在该预设下存在 —— 这一列扫的就是两者的区别。但工具可达性不是这一列的答案：服务器清单
// 与用户备注是一段**提示词**，无论哪个客户端供工具，complete 人设都会把它压掉。

/** 某份组合是否挂了某个模块，以及它是不是开着。 */
export type ModulePresence = 'mounted' | 'absent' | 'conditional'

/**
 * 一项能力在某个预设下是否到得了模型。
 *
 * `absent` 是路由事实（这一行不在组合里），不是失败；`suppressed` 表示行可能挂着，但 persona
 * 的 complete 标志把其他所有提示词段都挡在提示词外。
 */
export type ReachState = 'ok' | 'suppressed' | 'absent' | 'unknown'

/** 从**单个**预设的组合文本里解析出来的事实。 */
export interface CompositionFacts {
  /** 只有活的 `@deepseek-ai/dsh-persona` 行明确声明时才为 `true`。 */
  readonly personaComplete: boolean | 'unknown'
  /**
   * persona 行的 `includeRuntimeContext`（schema 默认 `true`）。
   *
   * `false` 会让 `dsh-persona` 调用 `systemPrompt.suppressRuntimeContext()`，关掉官方运行时
   * 上下文快照（sandbox / approval policy）—— 若本插件的文本走 `systemPrompt.context()`，
   * 也会一起被杀掉。出厂 `minimal` 预设就开着它，这正是插件注入改走 `agent/pre-step` 消息
   * 通道的原因（见 src/context-inject.ts）。
   */
  readonly includeRuntimeContext: boolean | 'unknown'
  /** 预设是否挂了这一行 persona（否则回落到全局）。 */
  readonly personaMounted: boolean
  readonly agentInstructions: ModulePresence
  readonly toolSkill: ModulePresence
  /** 组合是否挂了自己的 MCP 客户端。 */
  readonly mcpClient: ModulePresence
  /** 文本解析失败的原因（解析成功时缺省）。 */
  readonly parseFailure?: string
}

/** 一个预设的可达性行。 */
export interface PresetReachRow {
  readonly presetId: string
  readonly name?: string
  readonly trust?: string
  readonly isDefault: boolean
  readonly personaComplete: boolean | 'unknown'
  readonly personaMounted: boolean
  readonly agentInstructions: ModulePresence
  readonly toolSkill: ModulePresence
  /** 本插件注入的场景目录（启用的场景 + 各自描述）。 */
  readonly scene: ReachState
  /** 本插件注入的记忆条目（挂在各场景下）。 */
  readonly memory: ReachState
  /** `~/.dsh/AGENTS.md`，由 `dsh-agent-instructions` 承载。 */
  readonly agentsMd: ReachState
  /** `skill` 工具发布的技能目录。 */
  readonly skillCatalog: ReachState
  /** 官方委派工具（`subagent`）；`minimal` 预设不挂它。 */
  readonly subagent: ReachState
  /** MCP 工具：预设自带客户端就用它，否则用宿主平面那套。 */
  readonly mcp: ReachState
  /** persona `complete: true` 或 `includeRuntimeContext: false` —— 该预设不要任何额外文本。 */
  readonly suppressing: boolean
  /** 预设根本组不出会话时的原因（发现阶段报的）。 */
  readonly broken?: string
  /** 这一行的答案为什么是 `unknown`。 */
  readonly reason?: string
}

/** 整张矩阵，按设置页要的样子给。 */
export interface PresetReachReport {
  readonly rows: readonly PresetReachRow[]
  readonly defaultId: string | null
  readonly generatedAt: number
  readonly summary: string
  readonly blockers: readonly string[]
  /** 宿主平面的 MCP 状态；每条没有自带客户端的行都会重复带上它。 */
  readonly mcpTools?: number
}

/** 调用方补的宿主平面事实 —— 任何组合文本都答不出这些。 */
export interface ReachContext {
  /** 宿主平面上活的 `mcp__*` 工具数；探测失败时缺省。 */
  readonly mcpTools?: number
  /**
   * 插件的注入设置（调用方已加载时传入）：打开 `underSuppressingPresets` 后，压制型预设不再
   * 藏起插件的文本；被关掉的域如实报 `absent`，而不是 `ok`。
   */
  readonly inject?: {
    readonly underSuppressingPresets: boolean
    readonly domains: Readonly<Record<string, boolean>>
  }
}

/**
 * 注入决策需要的预设事实（src/context-inject.ts）：预设是否要求「只要我自己的提示词」，
 * 以及它挂了哪些官方载体 —— 插件的兜底域只在那些载体缺席时触发（AGENTS.md、技能目录），
 * 两边因此不会把同一份文本送两次。
 */
export interface PresetInjectionFacts {
  /** persona `complete: true` 或 `includeRuntimeContext: false` —— 预设不要额外文本。 */
  readonly suppressing: boolean
  /** 组合挂了 `@deepseek-ai/dsh-agent-instructions`（`~/.dsh/AGENTS.md` 载体）。 */
  readonly carriesAgentsMd: boolean
  /** 组合挂了 `@deepseek-ai/dsh-tool-skill`（官方技能目录 + loader）。 */
  readonly carriesSkillCatalog: boolean
}

/** 预设是否声明「不要额外文本」：persona `complete: true` 或运行时上下文关闭。 */
export function isSuppressingPreset(facts: CompositionFacts): boolean {
  return facts.personaComplete === true || facts.includeRuntimeContext === false
}

/** 把组合事实映射成注入决策要的形状（解析失败 = 不算压制）。 */
export function injectionFactsOf(facts: CompositionFacts | undefined): PresetInjectionFacts | undefined {
  if (facts === undefined) return undefined
  return {
    suppressing: isSuppressingPreset(facts),
    carriesAgentsMd: facts.agentInstructions === 'mounted',
    carriesSkillCatalog: facts.toolSkill === 'mounted',
  }
}

/** 这几个模块挂没挂，直接决定可达性。 */
const PERSONA_MODULE = '@deepseek-ai/dsh-persona'
const AGENT_INSTRUCTIONS_MODULE = '@deepseek-ai/dsh-agent-instructions'
const TOOL_SKILL_MODULE = '@deepseek-ai/dsh-tool-skill'

const NAME_LINE = /^(\s*)name:\s*(['"]?)([^'"\s#]+)\2\s*(?:#.*)?$/
const ENTRY_LINE = /^(\s*)-\s/
const DISABLED_LINE = /^\s*disabled:\s*(.+?)\s*(?:#.*)?$/
const COMPLETE_LINE = /^\s*complete:\s*(true|false)\s*(?:#.*)?$/
const RUNTIME_CONTEXT_LINE = /^\s*includeRuntimeContext:\s*(true|false)\s*(?:#.*)?$/

/** 行首空白宽度，当嵌套层级用。 */
function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * 拥有 `nameIndex` 的那一行所辖的文本行。
 *
 * 行从 `name:` 上方最近、缩进更浅的条目 bullet 开始（`cordis:group` 里的嵌套行仍拿到自己的
 * 块），到下一个缩进不深于该 bullet 的条目为止。
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
 * 拥有 `nameIndex` 的那一行如何决定启用状态。
 *
 * `!!js` 表达式只有挂载后才有答案，所以保持 `'conditional'` 而不猜 —— 与
 * `compositionInventory()` 对其 disabled 门采用同一规则。
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

/** 点名 `specifier` 的任意一行是否留在了组合里。 */
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
 * 从一份组合文本里解析决定可达性的事实。
 *
 * 刻意用文本扫描而不是 YAML 加载：本模块不能新增解析器依赖，而它问的每个问题都能由行内的
 * key/value 回答。匹配锚定整行，所以多行标量里嵌套的 `complete: true` 不会造成误报。
 *
 * 从不抛错：解析不了就降级为 `unknown`，调用方据此渲染成「判断不了」而不是「没问题」。
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
    // schema 默认 `true`：挂载的 persona 行没写这个标志时保留官方运行时上下文
    // （只有 `false` 才压制）。
    let includeRuntimeContext: boolean | 'unknown' = true
    let personaMounted = false
    for (let i = 0; i < lines.length; i += 1) {
      const named = NAME_LINE.exec(lines[i])
      if (named === null || named[3] !== PERSONA_MODULE) continue
      // 停用的人设行不会遮蔽部署的人设。
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

/** 把解析出的事实映射成用户可见的那五列能力。 */
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
    // 用户实测—— 把注入域全关掉后，标准 / ptc / 创造三行的技能与提示词
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

  // 子智能体列：与记忆 / MCP 两列**同口径** —— 答"人设目录
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
 * 本模块读取的 roster 接口。每个成员都可选，所以没有 agent-preset 服务的部署会降级成一条
 * blocker 行，而不是抛错。
 *
 * 组合文本有两个官方入口（同一宿主的两代实现）：
 *   - 0.1.5 的 `read(id)`：直接返回组合文本；
 *   - 0.1.7 的 `readDocument(id)`：返回 `AgentPresetDocument`，组合 YAML 在 `.content`
 *     字段（`{ agentPreset, content, name?, description? }`）。
 * 读取顺序固定「read 优先，readDocument 兜底」—— 两代宿主都能读。
 */
export interface PresetRosterLike {
  list?: () => Promise<unknown>
  read?: (id: string) => Promise<string>
  readDocument?: (id: string) => Promise<unknown>
  composedPreset?: (agentCtx: unknown) => string | undefined
  defaultId?: string
}

/**
 * 读一个预设的组合文本。两代宿主同一个出口：
 * `read(id)`（0.1.5 直返文本）或 `readDocument(id).content`（0.1.7 文档对象）。
 * 两者都不可用时抛错，由调用方决定降级口径 —— reason 文案由此保持单一来源。
 *
 * 兜底路径的可见性：兜底成功不留运行时上报 —— 上报一律渲染成问题行，而「read 改名
 * readDocument 后走兜底」是 0.1.7 的正常形态，不是降级（琥珀只留给故障）。这里只在真异常
 * （readDocument 在场但文档缺 `.content`）时留痕。同 id 覆盖，不堆积。
 */
export async function readCompositionText(roster: PresetRosterLike, presetId: string): Promise<string> {
  if (typeof roster.read === 'function') {
    return String((await roster.read(presetId)) ?? '')
  }
  if (typeof roster.readDocument === 'function') {
    const doc = (await roster.readDocument(presetId)) as { content?: unknown } | null | undefined
    if (doc === null || typeof doc !== 'object' || doc.content === undefined) {
      // 文档形状的第二次漂移：readDocument 在、`.content` 不在 —— 当年 read 改名的翻版。
      noteRuntime({
        id: 'preset.roster-read-route',
        label: '预设名册读取',
        kind: 'read',
        fallback: 'inform-only',
        detail: `readDocument(${presetId}) 返回的文档没有 content 字段：组合文本按空处理，注入边界将显示「无法判断」。宿主的名册文档契约可能又变了。`,
      })
    }
    return String(doc?.content ?? '')
  }
  throw new Error('预设名单未提供 read()/readDocument()：无法读取组合文件')
}

/** 从 cordis 上下文里取出预设名单；取不到就返回 undefined，不抛错。 */
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

  if (typeof roster.read !== 'function' && typeof roster.readDocument !== 'function') {
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
      reason: '预设名单未提供 read()/readDocument()：无法读取组合文件',
    }
  }

  let text: string
  try {
    text = await readCompositionText(roster, presetId)
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
 * 算出整张「预设 × 能力」矩阵。
 *
 * 全程只读：某个预设的文本读不出来，只在它自己那行给出 `reason`，不让整份报告失败。
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
 * 模型工具在结果后面追加的一行边界提示。
 *
 * 这一句是整套修正里承重的那一半：模型在压制型预设下列出记忆，会默认这些记忆已经在
 * 上下文里。MCP 与子智能体目录同理 —— 预设把插件的运行时快照挡在对话之外时，这三者都
 * 到不了模型，所以提示要说清「改调哪个工具」，以及用户在哪里能把这个开关打开。
 *
 * 纯函数、同步，便于契约测试把措辞钉在事实上。
 *
 * 写法纪律：
 *   - **不点名任何工具**。这条提示挂在 5 个发现型工具上，点名就必然出现循环
 *     （`mcp_manager_list` 的结果里写着「用 mcp_manager_list 查询」——
 *     用户实测发现）。按域名过滤只是把循环换成残缺列表；干脆不枚举：**域 → 工具**的
 *     映射属于工具描述（常驻层），提示只负责说清「什么不在你上下文里」。
 *   - 全域一句话说完，不逐域展开；不复述工具 schema 的细节。
 *   - 不把「被 persona complete 压制」当成不可改变的事实：本插件走 pre-step 注入消息
 *     （src/context-inject.ts），压制型预设下**默认不注入但可以打开**，提示里如实给出
 *     这个开关的位置。
 *
 * @returns 提示文本；没有内容落在上下文外时返回空串
 */
export function reachNoticeFor(
  presetId: string,
  facts: CompositionFacts,
  inject?: { readonly underSuppressingPresets?: boolean; readonly domains?: Readonly<Record<string, boolean>> },
): string {
  const parts: string[] = []
  const domainOff = (key: string): boolean => inject?.domains?.[key] === false
  if (isSuppressingPreset(facts) && inject?.underSuppressingPresets !== true) {
    // 不写「（想让它在这类预设下也注入：插件的「兼容」页 → 注入。）」：那是给人看的操作路径
    // （界面怎么点），而这段文字进的是工具回执 —— 回执留在 transcript 里，比工具 schema 还贵
    // （每次调用都会带一份）。判据与场景锁定守卫一致：守卫 / 提示只陈述事实，「怎么改」由模型
    // 自己向用户解释。
    parts.push(
      `预设「${presetId}」声明只要它自己的文本（persona complete / 关闭运行时上下文）：` +
      '本插件注入的 —— 场景、记忆、MCP、技能、子智能体、提示词 —— 默认不注入，' +
      '需要时用对应的 list / read 工具按需读取；不要假设你已经看到它们。',
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
 * 为一次工具调用所属的 agent 求边界提示。
 *
 * 所有失败路径都返回空串 —— 边界提示绝不能把一次成功读取变成错误。
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
  if (presetId === '' || (typeof roster.read !== 'function' && typeof roster.readDocument !== 'function')) return ''
  try {
    return reachNoticeFor(presetId, readCompositionFacts(await readCompositionText(roster, presetId)), inject)
  } catch {
    return ''
  }
}
