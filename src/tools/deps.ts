// model 工具（ctx.tools.register + defineTool）各域共用的依赖与 helper。
//
// 为什么单独一个文件：各注入域的工具都要同一批依赖（defineTool 包装、注册出口、场景锁定
// 守卫、注入边界提示），各写一份会漂移。

import { defineTool as hostDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScopeFlagDomain, SessionScope } from '../scope/scope-overrides.js'

/** 工具回执的正文块形状（与宿主内容块同形，只带 text）。 */
export type TextPart = Array<{ type: 'text'; text: string }>

/** 每个工具 output.render 的统一出口：把字符串包成宿主要的 content 数组。 */
export function text(value: string): TextPart {
  return [{ type: 'text', text: value }]
}

/**
 * 名单渲染：超过 `TOOL_NAME_LIST_CAP` 项就截断，并把总数写在后面（"…(N total)"）。
 *
 * 为什么两个地方都要它：`scene_manager_list` 用它列档案，`scene_manager_save` 用它
 * 在回执里回显"这一次替换挤掉了什么"。两处都必须**点名、不能只给数量** —— 只给数量
 * 答不了"我这次给出去的段会不会盖掉原来勾着的那些"，而那正是会静默出错的地方。
 * 截断则是因为这些文字都要进上下文，不能无上限。
 */
export const TOOL_NAME_LIST_CAP = 6
/** 把工具名列表折成一句可读文案（超长只报前几个与总数）。 */
export function toolNameList(list: readonly string[]): string {
  if (!list.length) return 'none'
  const head = list.slice(0, TOOL_NAME_LIST_CAP).join(', ')
  return list.length > TOOL_NAME_LIST_CAP ? head + ' ...(' + list.length + ' total)' : head
}

/**
 * 同 `candidateNote`，候选已经在手上时用这个（同步、不读盘）。
 *
 * 多数错误路径上数据本来就扫到了（`rules-list` / `skill-state` / `rows` 都在作用域里），
 * 再包一层 thunk 只是绕路。
 */
export function existingNote(names: readonly unknown[], label: string): string {
  const list = (names || []).map((v) => String(v ?? '').trim()).filter((v) => v !== '')
  if (!list.length) return ''
  return ' Existing ' + label + ': ' + toolNameList(list) + '.'
}

/**
 * 错误消息里的「现成候选」：只在出错时出现，不进 schema，所以不占每轮预算。
 *
 * 为什么不写进参数说明：候选随数据变，写进描述必然很快过期，而且每轮都要付一次 token。
 * 模型缺参数、名字打错之后再告诉它「现成的是这几个」，正好是它需要的那一刻 —— 这也正是
 * 口语请求最容易断的一环（用户说「删掉那条记忆」，模型手里只有一个叫法，没有 id）。
 *
 * `read` 失败一律返回空串：取候选失败绝不能改变错误结论 —— 原报错更接近真相。
 */
export async function candidateNote(read: () => Promise<readonly unknown[]>, label: string): Promise<string> {
  let raw: readonly unknown[] = []
  try { raw = await read() } catch { return '' }
  return existingNote(raw, label)
}

/**
 * 运行时点名一条工具：在它手里才点名，否则退回中性说法。
 *
 * 静态描述里不能这么做（契约测试会拦），而且指一条模型没有的工具本来就是把它往墙上推。
 * 错误消息与回执是运行时分支、可以点名，但判据仍是 `toolVisibleFor` —— 「这是错误消息
 * 所以随便写」是错的理解：那条约束的实质是「不让模型看见它手里没有的东西」，与字符串
 * 写在哪一行无关。
 *
 * 判定本身抛错时按**不可见**处理：中性说法永远成立，点名可能落空。
 */
export function toolOrNeutral(
  deps: ToolDomainDeps,
  agent: unknown,
  tool: string,
  named: string,
  neutral: string,
): string {
  let visible = false
  try { visible = deps.toolVisibleFor(tool, agent) } catch { visible = false }
  return visible ? named : neutral
}

/** `locateSkillRoot` 的结论。 */
export interface SkillRootLookup {
  /** `skill-state` 探测成功了吗。false = 探不到，调用方应退回旧默认、别在这里编结论。 */
  ok: boolean
  /** 命中时：这个技能的**胜出副本**所在来源键；没命中 = null。 */
  root: string | null
  /**
   * 胜出副本的**声明名**（`declaredName || name`）。
   *
   * 会话覆盖的键用的是声明名（与面板、注入段、模型列表同一份 canonical），而
   * `skill-enable` 这类全局 op 认的是**目录名** —— 两者不同时必须分开取。
   */
  canonical: string | null
  /** 探到的全部来源键（没命中时用来把错误说清楚：查过哪些地方）。 */
  roots: string[]
  /** 全部命中（同名的每一份副本），供"指定了 root"的调用方取那个来源里的声明名。 */
  matches: Array<{ root: string; canonical: string; shadowedBy: string }>
  /**
   * 这次扫到的全部技能名（去重，按来源顺序）。
   *
   * 只为「没有这个技能」那条错误：名字打错时，模型缺的不是"查过哪些来源"（它已经知道了），
   * 而是"现成的有哪些"。顺手带出来，省掉错误路径上再来一次 `skill-state`。
   */
  names: string[]
}

/**
 * 按名字找技能落在哪个来源（root）。
 *
 * 为什么需要它：`skill-create` 的默认落点是 **hub**
 * （`tool-management/skills/`，与界面「创建技能」一致），而 `skill-enable` / `skill-disable` /
 * `skill-prefer` / `skill-delete` 这些 op 的默认 root 是 **dsh**。于是「建完就启用」这条
 * 最自然的链路必然报「技能不存在」—— 同一个动作在工具侧落 hub、在开关侧查 dsh。
 * 默认值改哪边都不对（面板显式传 root，两边都依赖自己的默认），所以判定放到工具侧：
 * **没给 root 就在全部来源里按名字找胜出副本**，找到哪个就用哪个。
 *
 * 选取口径与 `skill_manager_read` 同一套（`markWinners` 已标出影子副本）：先取没被
 * `shadowedBy` 盖住的那一份（同名组里胜出的只有一个），都没有就取第一个。
 */
export async function locateSkillRoot(
  skillsOps: Record<string, (args: any) => Promise<any>>,
  name: string,
): Promise<SkillRootLookup> {
  const empty: SkillRootLookup = { ok: true, root: null, canonical: null, roots: [], matches: [], names: [] }
  const wanted = String(name || '').trim()
  if (wanted === '') return empty
  let state: any
  try {
    state = await skillsOps['skill-state']({})
  } catch {
    return { ok: false, root: null, canonical: null, roots: [], matches: [], names: [] }
  }
  if (!state || state.ok === false) return { ok: false, root: null, canonical: null, roots: [], matches: [], names: [] }
  const roots: string[] = []
  const names: string[] = []
  const hits: Array<{ root: string; canonical: string; shadowedBy: string }> = []
  for (const root of (state.data && state.data.roots) || []) {
    roots.push(String(root.key || ''))
    for (const skill of root.skills || []) {
      // 与 list / read / save 同一套名字口径：`declaredName || name`，再比目录名。
      const canonical = String(skill.declaredName || skill.name || '')
      if (canonical !== '' && names.indexOf(canonical) < 0) names.push(canonical)
      if (canonical !== wanted && String(skill.name || '') !== wanted) continue
      hits.push({
        root: String(root.key || ''),
        canonical: String(skill.declaredName || skill.name || wanted),
        shadowedBy: skill.shadowedBy && skill.shadowedBy.root ? String(skill.shadowedBy.root) : '',
      })
    }
  }
  const winner = hits.find((hit) => hit.shadowedBy === '') || hits[0]
  return { ok: true, root: winner ? winner.root : null, canonical: winner ? winner.canonical : null, roots, matches: hits, names }
}

/** 各工具域共用的依赖：宿主服务、共享工具表与文案助手。 */
export interface ToolDomainDeps {
  /**
   * 与宿主 defineTool **同签名的本地包装**（已包了采纳遥测，见 index.ts 的 trackAdoption）。
   *
   * 类型刻意用宿主自己的签名：重写成 `(options: unknown) => ToolDefinition` 会让每个调用点
   * 的 parameters / output 推断退化成 unknown —— 参数表写错也不再报错，等于把 18 个工具的
   * 声明校验一次性丢掉。宿主改签名时该红的地方照旧红，这才是要保住的东西。
   */
  defineTool: typeof hostDefineTool
  register(def: ToolDefinition): void
  /** 场景锁定守卫：返回拒绝文案，null = 未锁定。 */
  lockedSceneGuard(): Promise<string | null>
  /**
   * 这条工具**在这个 agent 手里吗**：全局开关 + 该 scope 的工具表 + 该 scope 的工具限制
   * （人设的 `toolsDeny` 经官方 `tools.restrict` 装上的那层）并起来。
   *
   * 只为一件事：错误与回执里点名工具的那句（"用 `mcp_manager_list` 看清单"）在工具被关掉后
   * 就是把模型往墙上推 —— 它照那句去调，执行侧拦住它，白跑一趟还查不出原因。
   * 判据与注入框架 `how` 行同源（index.ts 的 `injectHiddenToolsFor`），不再定义第二份。
   *
   * **不存在"只读全局开关"的那一档**：工具表按作用域各一份，只看全局会在
   * 「这个对话把它关了」时点名一条模型没有的工具 —— 那正是这一档必须带 agent 的原因。
   *
   * 拿不到 agent 时只按全局开关判 —— 问不了就不多隐藏，与"读不到 = 按还在手里算"
   * 同一条安全方向。
   */
  toolVisibleFor(name: string, agent: unknown): boolean
  /**
   * 开关类改动同步进当前场景档案（与 handlers 层同一套同步）。
   * 返回同步失败原因；undefined = 同步成功（工具回执据此决定是否带 WARN）。
   */
  syncSwitchToScene(op: string, args: any): Promise<string | null>
  /**
   * 注入边界提示：压制型预设（persona complete / 关闭运行时上下文）下本插件默认不注入，
   * 此时工具是模型唯一的入口。不说清的话，模型会把「看不到」当成「不存在」。
   */
  reachNoticeForAgent(roster: unknown, agentCtx: unknown, options: unknown): Promise<string>
  presetRoster(): unknown
  injectNoticeOptions(): unknown
  message(e: unknown): string
  /**
   * 当前隔离粒度（同步）。三种：`global` / `session` / `workspace`。
   *
   * 工具需要它只有一个原因：`scope` 参数的**默认值**得跟着走。`global` 粒度下没有会话层，
   * `scope: "session"`（以及省略 scope 时的默认）都必须落到全局 —— 否则会写进一个不存在的
   * 键，或者更糟：让 agent 回报「只影响这个对话」，而实际什么都没改。
   *
   * 未接这条通道 = 按 `session`（宿主缺这个字段时行为不变）。
   */
  scopeMode?(): 'global' | 'session' | 'workspace'
  /**
   * 写**本会话**的一个开关覆盖（模型工具默认写会话）。
   *
   * 为什么做成一条窄接口而不是把整个 scopeStore 递进来：工具只该有"改这一条"这一个动作。
   * 递整个 store 等于让二十几个工具各自去决定"写哪一层"，而这一层的语义（自动清除、
   * 会话锁）只有一份实现。
   *
   * 返回值与 `scope-set` op 同形：`{ok, cleared?, error?}`。`cleared` = 这次写入等于全局值，
   * 覆盖被自动清掉（回执要如实说"回到跟随全局"）。
   */
  sessionScopeSet?(
    agent: unknown,
    domain: 'skills' | 'subagents' | 'memory' | 'quickPrompts' | 'mcp' | 'mcpTools' | 'skillSources' | 'scene',
    key: string,
    value: boolean | string | null,
  ): Promise<{ ok: boolean; cleared?: boolean; warnings?: string[]; error?: string }>
  /**
   * 写**全局意图**：MCP 服务器 / 技能来源的全局开关。
   *
   * 与旧路径的区别是"off 不再等于立刻停"：off 之后仍被会话认领的资源保持运行（租约），
   * 只是别的会话看不到；只有 `blocked`（持久停机）会连租约一起停。全局动作走这里，
   * 不再直接改补丁 / 来源状态 —— 后者是运行态，由对账器维持成 `意图 ∪ 租约`。
   */
  scopeIntentSet?(
    domain: 'mcp' | 'skillSources',
    keys: string[],
    value: 'on' | 'off' | 'blocked',
  ): Promise<{ ok: boolean; warnings?: string[]; error?: string; sceneSyncError?: string }>
  /**
   * 本会话某一格的四层并值（读侧）：覆盖 → 场景层 → 基线 → `undefined`（= 跟随全局）。
   *
   * 给列表类工具用：它们手里有完整的条目清单（技能 / 人设 / 记忆 / 工具），逐条问这一格
   * "本会话的显式层是什么"，undefined 就落到该域自己的全局值 —— 不需要另建一份全集。
   */
  sessionFlagOf?(agent: unknown, domain: ScopeFlagDomain, key: string): boolean | undefined
  /**
   * 本会话的身份与覆盖：读侧那一半。
   *
   * 两个用途，缺一不可：
   *   · `sessionId` —— 有些 op 按会话取数据（`rules-list` / `skill-state`：项目技能根按
   *     会话的 cwd 推导），不给就退回"全部活动会话的并集"，两个对话看到同一份清单；
   *   · `scope` —— 逐条开关的覆盖，列表工具据此把"本会话关掉的那几条"标出来。
   *
   * 取不到会话 = `null`（按全局处理，不报错；见 scope/resolve.ts 文件头）。
   */
  sessionScope?(agent: unknown): { sessionId: string; scope: SessionScope | undefined } | null
}

/**
 * 取本会话的身份与覆盖。宿主没接这条通道、或取不到会话 → `null`（= 按全局）。
 *
 * 与 `overridesOfExec`（subagents/tools.ts）同一条纪律：解析失败不抛给模型 ——
 * 一次"读不到会话"不该让列表工具整个失败。
 */
export function sessionScopeOf(
  deps: ToolDomainDeps,
  agent: unknown,
): { sessionId: string; scope: SessionScope | undefined } | null {
  if (deps.sessionScope === undefined) return null
  try { return deps.sessionScope(agent) } catch { return null }
}

/**
 * 全局动作的回执尾注：**只在这个对话真有该域覆盖时**才出现。
 *
 * 为什么需要：`*_save` / `*_remove` / `prompt_manager_*` 动的是磁盘上的那一份 —— 技能、
 * 人设、场景、MCP 服务器、提示词预设都是**机器级**对象，没有"本会话的一份"。模型据此
 * 回一句"已删除"时，用户很容易读成"只在这个对话里删掉了"。而这一层恰恰最容易撞上
 * 会话覆盖：本会话把它关着、用户说"删了吧"，删完之后那条覆盖还留着（读时忽略，对账才清），
 * 界面上那一格仍标着「本会话」。
 *
 * 没有覆盖时返回 `''` —— 绝大多数调用走这条路，一个字都不多付。
 */
export function globalActionNote(deps: ToolDomainDeps, agent: unknown, domain: ScopeFlagDomain | 'scene', noun: string): string {
  const scoped = sessionScopeOf(deps, agent)
  const n = domain === 'scene'
    ? (scoped?.scope?.scene === undefined ? 0 : 1)
    : (() => {
      const map = scoped?.scope?.[domain]
      return map === undefined ? 0 : Object.keys(map).length
    })()
  if (n === 0) return ''
  return '\nnote: this is a global change (every conversation). This conversation has ' + n +
    ' of its own ' + noun + ' switch(es), which still take precedence here — clear them if this change should apply to it too.'
}

/**
 * 一条工具这次的 `scope` 到底走哪条路（含全局粒度）。
 *
 * 唯一的判定点。三种粒度下 `scope` 的**默认值**不同：
 *
 *   · `global`    —— 省略 / `"session"` / `"global"` 全部走全局。会话层根本不存在，
 *                    没有"只改这一处"这回事；把 session 当全局是**正确**而非宽松。
 *   · `session`   —— 省略 = 本对话；`"global"` = 机器级。
 *   · `workspace` —— 省略 = 本工作区（键是 `ws:<cwd>`）；`"global"` = 机器级。
 *
 * 为什么收成一处：10 个工具各写一遍 `String(args.scope || 'session') !== 'global'`，
 * 加粒度时必然漏掉一两处 —— 漏掉的那处会在全局粒度下静默写进空键。
 */
export function effectiveScope(deps: ToolDomainDeps, args: unknown): 'session' | 'global' {
  const raw = (args as { scope?: unknown } | null)?.scope
  if (deps.scopeMode?.() === 'global') return 'global'
  return raw === 'global' ? 'global' : 'session'
}

/** 会话层此刻存在吗（全局粒度下不存在）。用于回执措辞与"要不要过会话锁"。 */
export function sessionLayerOn(deps: ToolDomainDeps): boolean {
  return deps.scopeMode?.() !== 'global'
}

/**
 * 全局动作的**歧义守卫**（会话层下拒绝并说明）。
 *
 * 只加在**有会话层同胞**的那几条上：技能 / 人设 / 场景 / MCP 服务器各自都有一条
 * `*_manager_switch` 能按会话改「看不看得到」，于是「删掉它」在会话语境里天然有歧义 ——
 * 用户说的可能是「这个对话里别再用它」，而这条工具动的是磁盘上的那一份。
 *
 * **缺省不拒**（`scope` 省略 = 全局，行为不变）：这几条工具每个都要付 token，
 * 而"每次删除都先失败一次再重试"是纯摩擦 —— 模型并不知道用户此刻在面板里编辑哪一层。
 * 真正要挡的是**模型自己以为在改会话**：它显式写了 `scope: "session"` 时，这里当场纠回来，
 * 而不是静默地改掉全局。
 *
 * 全局粒度下直接放行（`isolationOff`）：那一档没有会话层，`scope: "session"` 的所指就是
 * 全局，拒绝它只会让模型白跑一趟。
 *
 * 加在：技能 / 人设 / 场景 / MCP 四条 `*_save`、五条 `*_remove`。
 * 不加在：`memory_manager_save`（落 `<场景>/<名字>`，写哪儿由 id 自己说清）、
 * `*_manager_switch`（它们本来就按会话写，`scope` 是真的）。
 * `prompt_manager_apply` 也从清单里去掉了：它的参数表里没有
 * `scope`，守卫读不到东西 —— 模型按 schema 不可能传，这条守卫等于永不触发，留着只会
 * 让人以为它被守住了。提示词只有全局一层，参数表已经说清。
 */
export function requireGlobalScope(args: unknown, what: string, isolationOff = false): void {
  if (isolationOff) return
  const scope = (args as { scope?: unknown } | null)?.scope
  if (scope === undefined || scope === 'global') return
  throw new Error(
    'this is a global action (' + what + ' exist once for the whole machine, so there is no per-conversation version to change). '
    + 'Drop scope, or pass scope="global", to change the machine-wide one. '
    + 'To change what THIS conversation sees instead, use the matching *_manager_switch.',
  )
}

/**
 * 模型面 `scope` 参数的共同措辞。
 *
 * 为什么收成一处：同一件事（这一格只有全局一层）此前在 14 个参数上各写一套，最长的一条
 * 563 字符 —— 这些字节每个请求都跟着工具表发一遍。可写会话层的那几条各域还要补自己的
 * 存储名与租约语义，所以只收这一类。
 *
 * `unless isolation is off`：全局粒度下没有会话层，`scope: "session"` 的所指
 * 就是全局，守卫也放行 —— 只说"被拒"会让模型在一个合法的调用前先自我否决。
 */
export function scopeGlobalOnlyDesc(what: string, instead: string): string {
  return 'Always global — ' + what + ' ("session" is refused unless isolation is off); ' + instead + '.'
}

/**
 * 模型面「会话层」`scope` 参数的共同措辞。
 *
 * 为什么不能写死 "this conversation only"：隔离粒度可切（`scope-mode-set`）。切到工作区后
 * `session` 这一档写的是 `ws:<cwd>` 那一格 —— **同工作区的每个对话都读它**；关掉隔离
 * （`global`）之后连这一格都没有，写的就是机器级那一份。
 *
 * 所以措辞必须**对三种粒度同时成立**：先点名「这个对话」，再补上两档更宽的情形。
 * 原措辞 "this conversation only; invisible to other conversations" 在工作区粒度下
 * 是假话 —— 用户说「只在这个对话关掉」，agent 照做，实际把同工作区另外几个对话一起关了。
 *
 * 尾注 `tail` 由各域自己补（租约语义、状态文件位置、是否切运行时）。
 */
export function scopeSessionDesc(tail: string): string {
  return 'session (default) = this conversation; its whole workspace under workspace isolation; machine-wide once isolation is off. ' + tail
}

/**
 * 会话层写入回执的统一后缀：按**当前隔离粒度**说清影响范围。
 *
 * 为什么必须带 `deps`：粒度是运行时事实（可切），而这句话会被 agent 原样转述给用户。
 * 此前写成「this conversation, or every conversation in its workspace under workspace
 * isolation」—— 三档同时成立，于是它什么都没说：用户问「是不是只影响这个对话」，
 * agent 只能把这句话再念一遍。拿得到粒度就写死一档；拿不到（宿主没接这条通道）
 * 才退回那句兜底。
 *
 * 只在会话层真的被写到时才用。全局粒度下 `effectiveScope` 会把所有写入导向全局，
 * 回执走各域原有的"机器级"措辞，不会到这里。
 *
 * 回执不是常驻成本（只在调用时出现一次），所以这里可以写全，不必像工具描述那样抠字：
 * agent 会把这句话原样转述给用户，含糊的措辞比长一点的措辞贵得多。
 */
export function scopeOnlyNote(deps: ToolDomainDeps): string {
  const mode = deps.scopeMode?.()
  if (mode === 'workspace') return ' **for this whole workspace only** (every conversation in it; other workspaces are unaffected)'
  if (mode === 'session') return ' **for this conversation only**'
  return ' **for this scope only** (this conversation, or every conversation in its workspace under workspace isolation)'
}

/**
 * 「全局没动、别人不受影响」那句：谁算「别人」由粒度决定。
 *
 * 工作区粒度下同工作区的其它对话读的是**同一格**，照旧写 "other conversations keep
 * theirs" 就是假话 —— 而且它与同一句回执里的 `scopeOnlyNote` 直接打架。
 */
export function globalUnchangedNote(deps: ToolDomainDeps): string {
  return deps.scopeMode?.() === 'workspace'
    ? 'The global setting is unchanged; other workspaces keep theirs.'
    : 'The global setting is unchanged; other conversations keep theirs.'
}

/** 全局粒度下写入回执的说明：让 agent 别把这句转述成"只影响这个对话"。 */
export function isolationOffNote(deps: ToolDomainDeps): string {
  return deps.scopeMode?.() === 'global'
    ? ' Isolation is off (global mode), so this is the machine-wide setting — every conversation sees it.'
    : ''
}
