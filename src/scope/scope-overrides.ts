// 会话作用域覆盖（侧车 `scope-overrides.json`）的**形状与判定** —— 纯函数，不碰磁盘。
//
// 为什么单独一个文件：这份形状有三个使用方（HTTP ops、注入器、模型工具），而判定规则
// （三态 → 二态、自动清除、僵尸覆盖）只有一份。抄进任何一处都会分叉。
//
// ## 四层叠加（0.21.2）
//
// 一个会话看到的东西按四层叠加，自上而下：
//
//   1. **会话覆盖**（`scope[domain][key]`）—— 在这个对话里显式拨过的开关，永远赢；
//   2. **场景层**（`scope.scene` 存在 = 处于场景模式）—— 按场景档案**实时**计算：
//      档案里有这一段 → 勾了的为开、没勾的为关；没有这一段 → 这一层没话说，落到下一层；
//   3. **基线**（`scope.detached === true` 时）—— 会话**创建时**的冻结快照（`baseline`）。
//      退出场景落回这里（不是落回全局 —— 全局是会变的）；
//   4. **全局**（实时）—— 前三层都没话说时才轮到它。
//
// ## 三态存储、二态展示
//
//   · 键不存在      = 这一层没话说（落到下一层）
//   · true / false  = 这一层显式开 / 关
//
// 界面上只有两种勾：开着（绿）/ 关着（灰）—— 不再区分"全局的绿"与"会话的蓝"：
// 停在某一层时看到的**就是这个对话的生效值**，一种颜色，没有第二层信息要读。
//
// ## 自动清除（写侧与读侧各一次）
//
//   写侧：新值 == **下层此刻的值** → 删掉这个键（点回"跟随"不该留一条永远相等的覆盖）
//   读侧：值 == 下层值 → 视为无覆盖（下层后来被改成同一个值，那条覆盖就不该再起作用）
//
// 「下层」= 场景层（进入场景时）→ 基线（脱离时）→ 全局，与 `layeredFlag` 同一顺序。
//
// **进入场景时 `scene` 等于全局场景不自动清除**：场景模式是一种模式（档案里没写的段
// 跟随下层），不是一个格的取值 —— 与全局那个场景是不是同一个名字无关。
//
// ## 两条域边界
//
//   · **记忆不收场景层**（`sceneFlagOf` 对 memory 恒 undefined）：记忆的"在哪一层"由场景名
//     与逐条开关决定，档案的 memories 段已废弃（P5）。正文投影归记忆域，这里只管开关。
//   · **词表收场景层**：`mcpTools` 的键是 `<server>/<tool>`、`skillSources` 的键是来源 root，
//     档案里对应的段落分别是 `mcp`（每个服务器 '*' 或工具名清单）与 `skills`（勾选的技能键，
//     来源层由此反推："这个来源下有勾中的技能 = 开"）。
//
// ## 模型工具表不在七域里（0.21.2）
//
// `toolTableHidden` 是**整份关停名单**，不是逐格布尔：工具表在 `tool-table.json` / 方案里
// 本来就是这个形状，拆成一格一覆盖只会多出第二份真相。取数顺序也不同 ——
// 本对话那份 → 创建时抄的基线 → 实时全局（老会话的兜底），全局只给新对话当默认模板。
// 场景绑定的方案在**进入那一次**套到本对话（不是常驻的一层），退出时连场景里改的一起清掉。

import type { SceneArchive } from '../memories/archive.js'
import { normalizePresetId } from '../prompts/preset-id.js'
import type { IntentState } from './intent.js'

/** 布尔型覆盖域：一个域一张 `key → 开/关` 表。 */
export const SCOPE_FLAG_DOMAINS = ['skills', 'subagents', 'memory', 'quickPrompts', 'mcp', 'mcpTools', 'skillSources'] as const

/** 布尔型覆盖域的名字。 */
export type ScopeFlagDomain = (typeof SCOPE_FLAG_DOMAINS)[number]

/** 全部覆盖域：布尔型七个 + 场景（单选，不是开关）。 */
export const SCOPE_DOMAINS = ['scene', ...SCOPE_FLAG_DOMAINS] as const

/** 覆盖域的名字。 */
export type ScopeDomain = (typeof SCOPE_DOMAINS)[number]

/**
 * 会话创建时的冻结快照（`退出模式` 要回到的那一份）。
 *
 * 为什么冻结时点：用户裁定「退出模式 = 退出到这个会话最开始的样子，不要退回到全局，
 * 因为全局是会变的」。所以基线的**值**在会话创建那一刻取定，此后全局怎么改都与它无关。
 */
export interface SessionBaseline {
  /** 创建时全局正在用的场景（`null` = 当时没有场景）。 */
  scene: string | null
  /** 创建时各域各键的全局开关。 */
  flags: Record<string, Record<string, boolean>>
  /**
   * 创建时全局的模型工具表关停名单（0.21.2）。
   *
   * 工具表是**每个对话一份**：创建时抄下全局那份，此后全局再改也与这个对话无关。
   * 空数组是有效值（"这个对话全都要"），与"没记过"（`undefined`）不是一回事。
   */
  toolTableHidden?: string[]
  capturedAt?: string
}

/** 一个会话的覆盖。没有任何覆盖也没有基线 = 跟随全局。 */
export interface SessionScope {
  /** 进入的场景名。存在 = 这个对话处于**场景模式**（场景层生效）。 */
  scene?: string
  /** 已退出场景模式：下层从"全局"换成 `baseline`（会话创建时的样子）。 */
  detached?: boolean
  /** 会话创建时的冻结快照（进入 / 退出场景前确保有）。 */
  baseline?: SessionBaseline
  skills?: Record<string, boolean>
  subagents?: Record<string, boolean>
  memory?: Record<string, boolean>
  quickPrompts?: Record<string, boolean>
  /** MCP **服务器级**：`serverName → 本会话可不可见`。 */
  mcp?: Record<string, boolean>
  /** MCP **逐工具**：`<server>/<tool>` → 本会话可不可见（拨开一个全局关着的工具也走这里）。 */
  mcpTools?: Record<string, boolean>
  /** 技能**来源**：root key → 本会话可不可见（拨开时按租约运行，见 op 侧）。 */
  skillSources?: Record<string, boolean>
  /**
   * 本会话的提示词覆盖（0.21.2）：取代**用户级那一槽**（场景预设 / `~/.dsh/AGENTS.md`），
   * 项目指令链仍拼在前面。两字段互斥，`content` 有值时 `presetId` 必须为空。
   *
   * 写的是侧车，**永远不写** `~/.dsh/AGENTS.md`；预设被删除后解析时退化回全局链。
   */
  prompt?: SessionPromptOverride
  /**
   * 本对话的**模型工具表关停名单**（0.21.2）：不在这个列表里的工具对模型可见。
   *
   * 它是整份名单而不是逐工具布尔：工具表本来就是"一份关停名单"，整份存才与
   * `tool-table.json` / 方案同一个形状。没有这一项 = 跟随 `baseline.toolTableHidden`
   * （= 创建时抄的全局那份）；空数组 = 本对话全都要。
   */
  toolTableHidden?: string[]
  /** 会话锁：只冻结这个会话自己的覆盖，不影响全局写入（决策 12）。 */
  locked?: boolean
}

/** 会话级提示词覆盖：引用一份预设，或一段本会话自定义正文（互斥）。 */
export interface SessionPromptOverride {
  /** 引用某个预设（应用操作产生）；预设被全局删除 → 解析时退化回快照。 */
  presetId?: string
  /** 会话自定义正文（快捷编辑产生）；上限与 `AGENTS_MD_MAX_BYTES` 同闸。 */
  content?: string
  /**
   * 本会话首次被注入器看见时 `~/.dsh/AGENTS.md` 的冻结字节快照（0.21.2 第三轮）。
   *
   * **不是用户覆盖**：`hasPromptOverride` 不看它，`overrideCountOf` 也不数它；
   * 它只回答"这个会话的全局基线是哪一版"。没有它（捕获失败 / 老装配）= 退化到当前文件。
   * 空串是有效值（创建时文件不存在 / 为空）—— 它会挡住之后写进文件的内容。
   */
  baseline?: string
}

/** 提示词覆盖正文的上限（与 `~/.dsh/AGENTS.md` 的 64 KiB 同闸，防绕过预算）。 */
export const PROMPT_CONTENT_MAX_BYTES = 65536

/**
 * 把一份 `~/.dsh/AGENTS.md` 原文夹进快照预算（0.21.2 第三轮）。
 *
 * 与官方 `truncateUtf8` 同一手法：按字节截断并退到 UTF-8 字符边界，不切出半个字。
 * 捕获与"快照 == 当前文件"的比对都走它 —— 否则一个超过 64 KiB 的文件会永远判"有差异"，
 * 每隔 5 轮把自检点亮一次（实际内容并没有变）。
 */
export function clampPromptBaseline(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= PROMPT_CONTENT_MAX_BYTES) return text
  let end = PROMPT_CONTENT_MAX_BYTES
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * 隔离粒度（0.21.2，0.21.2+ 补 `global`）。
 *
 *   · `global`    —— **没有会话层**：所有读写直接落到各域的全局状态（加会话管理之前的样子）；
 *   · `session`   —— 每个对话一份覆盖；
 *   · `workspace` —— 同一工作区（会话头 `cwd` 归一后相同）的对话共用一份覆盖。
 *
 * 它**不是**覆盖本身的一部分：模式是全局设置，切换只改变"用哪把键去查"。三种模式共用同一张
 * `sessions` 表，切走时记录原样留着 —— 所以来回切换是回到各自上一次的样子，不丢设置。
 *
 * `global` 与另外两种不是"同一把键的另一种拼法"，而是**键不存在**：键解析返回空，读侧自然
 * 落到全局，且不产生租约（会话里"开"就是全局开）。这一点由 `scope/resolve.ts` 落实。
 *
 * 取不到 / 非法值按 `session` 处理（老文件 / 手改坏值都退回会话粒度）。
 */
export type ScopeMode = 'global' | 'session' | 'workspace'

/** 三种隔离粒度（界面与校验共用，顺序即界面顺序：从最粗到最细）。 */
export const SCOPE_MODES: readonly ScopeMode[] = Object.freeze(['global', 'session', 'workspace'])

/** 夹一个模式；不认识的按会话粒度。 */
export function normalizeScopeMode(raw: unknown): ScopeMode {
  if (raw === 'global' || raw === 'workspace') return raw
  return 'session'
}

/** 侧车 `scope-overrides.json` 的形状。 */
export interface ScopeOverrides {
  version: 1
  /**
   * 当前隔离粒度。缺省 = `session`（0.21.2 及更早写出的文件）。
   *
   * 工作区记录与会话记录同处 `sessions` 表：工作区键是 `ws:<归一化 cwd>`（见
   * `scope/workspace-key.ts`）。放同一张表是刻意的 —— 场景改名 / 删除 / 改绑工具表的
   * `mutateAll` 只需要扫一遍，不必维护第二套遍历。
   */
  mode: ScopeMode
  sessions: Record<string, SessionScope>
}

/** 覆盖键的长度上限：键是技能 / 人设 / 记忆 / 快捷词 / 服务器名 / 工具全名，最长的是记忆 id。 */
const MAX_KEY_LENGTH = 256

/**
 * 记录键（会话 id / `ws:` 工作区键）的长度上限。
 *
 * 工作区键里带完整 cwd，比普通覆盖键长；侧车 JSON 没有键长限制，这里只是挡住手改的
 * 异常大键。生成侧另有一道 900 字符的闸（`workspace-key.ts`），两边留出前缀余量。
 */
const MAX_RECORD_KEY_LENGTH = 1024

/** 是不是布尔型覆盖域。 */
export function isFlagDomain(domain: unknown): domain is ScopeFlagDomain {
  return typeof domain === 'string' && (SCOPE_FLAG_DOMAINS as readonly string[]).includes(domain)
}

/** 是不是覆盖域（含 `scene`）。 */
export function isScopeDomain(domain: unknown): domain is ScopeDomain {
  return domain === 'scene' || isFlagDomain(domain)
}

/** 一个键能不能进覆盖表：非空、不超长、不含控制字符（键最终会进 JSON，不参与路径拼接）。 */
function validKey(key: unknown): key is string {
  // `__proto__` 会在普通对象上改原型而不是落一个自有属性 —— 侧车里出现它时按非法键丢弃。
  return typeof key === 'string' && key !== '' && key !== '__proto__' && key.length <= MAX_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(key)
}

/**
 * 记录键（会话 id / 工作区键）的合法形状。与 `validKey` 的区别只有长度上限：
 * 工作区键里带 cwd，可能比 256 长；其余判定（空、原型污染、控制字符）完全相同。
 */
export function validRecordKey(key: unknown): key is string {
  return typeof key === 'string' && key !== '' && key !== '__proto__' && key.length <= MAX_RECORD_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(key)
}

/** 夹一张 `key → boolean` 表：丢掉非法键与非布尔值；空了就返回 undefined（不落一个空对象）。 */
function normalizeFlagMap(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, boolean> = Object.create(null)
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!validKey(key)) continue
    if (typeof value !== 'boolean') continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 把任意输入夹成合法侧车（坏输入不抛）。
 *
 * 只做形状收敛，**不做**「值 == 下层」的判定 —— 那需要全局快照与场景档案，见 `pruneScope`。
 * 读盘时不做这一步是刻意的：下层快照要扫技能目录与补丁，不能让"读一份侧车"变成一次全量扫描。
 */
export function normalizeScopeOverrides(raw: unknown): ScopeOverrides {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const mode = normalizeScopeMode(obj.mode)
  const sessionsRaw = obj.sessions && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)
    ? (obj.sessions as Record<string, unknown>)
    : {}
  const sessions: Record<string, SessionScope> = Object.create(null)
  for (const [sessionId, value] of Object.entries(sessionsRaw)) {
    // 工作区键（`ws:<cwd>`）也在这张表里，长度上限与普通覆盖键不同（见 validRecordKey）。
    if (!validRecordKey(sessionId)) continue
    const scope = normalizeSessionScope(value)
    if (scope !== undefined) sessions[sessionId] = scope
  }
  return { version: 1, mode, sessions }
}

/**
 * 夹一份工具名名单。与 `normalizeFlagMap` 不同，**空数组是有效值**（"一个都不关"），
 * 只有"不是数组"才返回 undefined（这一层没话说）。
 */
function normalizeToolNameList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (!validKey(item)) continue
    if (out.indexOf(item) < 0) out.push(item)
  }
  return out
}

/** 夹一份基线快照；形状不对返回 undefined。 */
export function normalizeBaseline(raw: unknown): SessionBaseline | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const flags: Record<string, Record<string, boolean>> = Object.create(null)
  const flagsRaw = obj.flags && typeof obj.flags === 'object' && !Array.isArray(obj.flags)
    ? (obj.flags as Record<string, unknown>)
    : {}
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = normalizeFlagMap(flagsRaw[domain])
    if (map !== undefined) flags[domain] = map
  }
  const scene = obj.scene === null || obj.scene === undefined
    ? null
    : (validKey(obj.scene) ? String(obj.scene) : null)
  const toolTableHidden = normalizeToolNameList(obj.toolTableHidden)
  return {
    scene,
    flags,
    ...(toolTableHidden === undefined ? {} : { toolTableHidden }),
    ...(typeof obj.capturedAt === 'string' && obj.capturedAt !== '' ? { capturedAt: obj.capturedAt } : {}),
  }
}

/**
 * 夹一份提示词覆盖；`content` / `presetId` 互斥（content 优先），快照始终并存。
 *
 * 快照超预算 → 只丢快照（内容覆盖照样生效）；只有快照的条目超预算 → 整条丢弃。
 * 空对象 / 坏输入返回 undefined。
 */
export function normalizePromptOverride(raw: unknown): SessionPromptOverride | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const baseline = typeof obj.baseline === 'string' && Buffer.byteLength(obj.baseline, 'utf8') <= PROMPT_CONTENT_MAX_BYTES
    ? obj.baseline
    : undefined
  const withBaseline = baseline === undefined ? {} : { baseline }
  if (typeof obj.content === 'string' && obj.content.trim() !== '' && Buffer.byteLength(obj.content, 'utf8') <= PROMPT_CONTENT_MAX_BYTES) {
    return { content: obj.content, ...withBaseline }
  }
  // presetId 同时是**磁盘目录名**：侧车被手改 / 旧版本写进来的构造值不能原样透到注入侧的
  // 读盘路径（`presets/<id>/AGENTS.md`）。规则与预设库同一份（0.21.2 复核）。
  if (typeof obj.presetId === 'string') {
    const preset = normalizePresetId(obj.presetId)
    if (preset.ok) return { presetId: preset.id, ...withBaseline }
  }
  if (baseline !== undefined) return { baseline }
  return undefined
}

/**
 * 本会话有没有**用户写的**提示词覆盖（0.21.2 第三轮：快照不算）。
 *
 * 冻结快照是系统捕获，每个会话都有；拿 `scope.prompt !== undefined` 当覆盖判据会把
 * 所有会话都判成"有覆盖" —— 官方 carrier 被全量拦下、下拉框每条都显示「1 项」。
 */
export function hasPromptOverride(scope: SessionScope | undefined): boolean {
  const prompt = scope?.prompt
  return prompt !== undefined && (prompt.content !== undefined || prompt.presetId !== undefined)
}

/** 本会话的冻结快照（`undefined` = 还没捕获 / 捕获失败）。 */
export function promptBaselineOf(scope: SessionScope | undefined): string | undefined {
  return scope?.prompt?.baseline
}

/**
 * 只取**用户写的**那一半（`content` / `presetId`），不带快照。
 *
 * 注入器、`scope-get`、`scope-prompt-set` 共用这一份投影：快照是系统元数据，
 * 混进"覆盖"会让界面与注入判据都把它当成用户操作。
 */
export function promptOverrideOf(scope: SessionScope | undefined): { presetId?: string; content?: string } | undefined {
  const prompt = scope?.prompt
  if (prompt === undefined) return undefined
  if (prompt.content !== undefined) return { content: prompt.content }
  if (prompt.presetId !== undefined) return { presetId: prompt.presetId }
  return undefined
}

/** 夹一个会话的覆盖；全部字段都无效时返回 undefined。 */
export function normalizeSessionScope(raw: unknown): SessionScope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const out: SessionScope = Object.create(null)
  if (typeof obj.scene === 'string' && validKey(obj.scene)) out.scene = obj.scene
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = normalizeFlagMap(obj[domain])
    if (map !== undefined) out[domain] = map
  }
  if (obj.detached === true) out.detached = true
  const prompt = normalizePromptOverride(obj.prompt)
  if (prompt !== undefined) out.prompt = prompt
  const toolTableHidden = normalizeToolNameList(obj.toolTableHidden)
  if (toolTableHidden !== undefined) out.toolTableHidden = toolTableHidden
  const baseline = normalizeBaseline(obj.baseline)
  if (baseline !== undefined) out.baseline = baseline
  if (obj.locked === true) out.locked = true
  // 只有 `locked` / `baseline` 也算一条有效记录：锁可以先挂上、覆盖后加；基线在会话创建时
  // 就落盘（退出模式要回到它，而"创建时"这个时点只有那一刻能取到）。
  return isKeepableScope(out) ? out : undefined
}

/**
 * 这条记录要不要留在侧车里 —— 一条覆盖都没有（`locked` / `baseline` 不算覆盖，它们是元数据）
 * 也必须留住的情况：锁着（`locked`）或存了基线（`baseline`）。detached 同理
 * （"退出到创建时的样子"本身就是一种状态）。
 */
export function isKeepableScope(scope: SessionScope | undefined): boolean {
  if (scope === undefined) return false
  if (scope.scene !== undefined) return true
  if (scope.locked === true) return true
  if (scope.detached === true) return true
  if (scope.baseline !== undefined) return true
  if (scope.toolTableHidden !== undefined) return true
  if (scope.prompt !== undefined) return true
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = scope[domain]
    if (map !== undefined && Object.keys(map).length > 0) return true
  }
  return false
}

/** 一条覆盖都没有（`locked` / `baseline` / 提示词快照 / `detached` 不算"覆盖"）。 */
export function isEmptyScope(scope: SessionScope | undefined): boolean {
  if (scope === undefined) return false
  if (scope.scene !== undefined) return false
  if (scope.toolTableHidden !== undefined) return false
  if (hasPromptOverride(scope)) return false
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = scope[domain]
    if (map !== undefined && Object.keys(map).length > 0) return false
  }
  return true
}

/** 一条覆盖里的条目数（`scene` 算一条，每个键算一条；`locked` / 基线 / 提示词快照不算）—— 下拉框显示「N 项」。 */
export function overrideCountOf(scope: SessionScope | undefined): number {
  if (scope === undefined) return 0
  let n = scope.scene === undefined ? 0 : 1
  // 工具表是一整份名单，算一条设置（不按名字个数膨胀下拉框的计数）。
  // 与基线是同一份时不算：`scope-get` 的剪枝本来就不显示它，计数再算一条会让下拉框
  // 说「1 项」、打开却什么都没有（进过绑定同一份方案的场景再退出就会留下这种残留）。
  if (scope.toolTableHidden !== undefined && !sameToolNameList(scope.toolTableHidden, scope.baseline?.toolTableHidden)) n += 1
  if (hasPromptOverride(scope)) n += 1
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = scope[domain]
    if (map !== undefined) n += Object.keys(map).length
  }
  return n
}

/**
 * 把一条记录**播种**到另一层（会话 ↔ 工作区）时的形状。
 *
 * 去掉两样：
 *   - `locked`：锁是"保护这一层不被改"的元数据，跟着复制会把整个工作区 / 一批会话
 *     突然锁死，不是用户这次切换的意图。
 *   - `detached`：它说的是"**这一层**退出过场景模式、下层从全局换成它自己的基线"，
 *     是这一层的历史，不是一份能复制给另一层的设置（详见下面那段）。
 *
 * 其余字段（含基线、提示词冻结快照、工具表）照抄 —— 少了基线，退出场景 / 工具表回落会踩空。
 */
export function scopeForLayerSeed(scope: SessionScope | undefined): SessionScope | undefined {
  if (scope === undefined) return undefined
  const out: SessionScope = { ...scope }
  delete out.locked
  /**
   * `detached` 不搬（2026-10-22 实测，用户报「场景勾着但没注入」）。
   *
   * 搬到刚建出来的层上后果是**无声**的：`sessionScenePinOf` 见到 `detached` 就回
   * `baseline.scene ?? null`；基线里当时没有场景 ⇒ 新层一出生就"钉住没有场景"，
   * 场景段当场停止注入。而界面上显示的还是全局那个场景的勾选 —— 用户看到的就是
   * 「场景勾着，上下文里却没有场景」，且切换场景之后才恢复。
   *
   * 剥掉 `detached` 后下层变回全局。为了不丢用户原本看到的生效值，把基线里**显式**的
   * 那些物化进覆盖（源层写过的照样压在上面）。基线本身留着：工具表名单与提示词快照
   * 仍按它取（见 `sessionToolTableHidden`）。
   *
   * 基线里的场景只在它是**真实场景名**时才显式钉住 —— `null` 是"当时就没有场景"，
   * 那种情况下跟随全局才是原意，不能再钉成"没有场景"。
   */
  if (out.detached === true) {
    const base = out.baseline
    delete out.detached
    if (base !== undefined) {
      for (const domain of SCOPE_FLAG_DOMAINS) {
        const fromBase = base.flags?.[domain]
        if (fromBase === undefined) continue
        out[domain] = { ...fromBase, ...(out[domain] ?? {}) }
      }
      const baseScene = base.scene
      if (typeof baseScene === 'string' && baseScene !== '') out.scene = baseScene
    }
  }
  return isKeepableScope(out) ? out : undefined
}

/**
 * 一个会话**生效**的模型工具表关停名单（0.21.2）。
 *
 * 顺序：本对话自己的整份名单 → 创建时抄的基线 → 实时全局（老会话没有基线时的兜底）。
 * 全局只给新对话当默认模板；已有对话不会再跟着全局变。
 */
export function sessionToolTableHidden(
  scope: SessionScope | undefined,
  globalHidden: readonly string[],
): string[] {
  const list = scope?.toolTableHidden !== undefined
    ? scope.toolTableHidden
    : scope?.baseline?.toolTableHidden
  return (list === undefined ? globalHidden : list).slice()
}

// ── 场景层（按档案实时计算）──────────────────────────────────────────────
//
// 语义与全局场景引擎**逐字一致**（勾选集 = 该场景下开着的东西）：段已定义 → 对全部已知键
// 出值（勾了 true / 没勾 false）；段未定义 → 这个域不碰（返回 undefined，落到下一层）。
// 由 `computeMcpPlan` / `computeSkillsPlan` 的同一套档案形状推导，不另立一份规则。

/**
 * 场景层对某域某键的值。`undefined` = 档案里没有这一段（这一层没话说）。
 *
 * @param domain 只认档案里真有段落的六个域（memory 恒 undefined，见文件头）。
 */
export function sceneFlagOf(archive: SceneArchive | undefined, domain: ScopeFlagDomain, key: string): boolean | undefined {
  if (archive === undefined) return undefined
  if (domain === 'memory') return undefined
  if (domain === 'skills') {
    if (archive.skills === undefined) return undefined
    return archive.skills.indexOf(key) >= 0
  }
  if (domain === 'subagents') {
    if (archive.subagents === undefined) return undefined
    return archive.subagents.indexOf(key) >= 0
  }
  if (domain === 'quickPrompts') {
    if (archive.quickPrompts === undefined) return undefined
    return archive.quickPrompts.indexOf(key) >= 0
  }
  if (domain === 'skillSources') {
    if (archive.skills === undefined) return undefined
    // 来源层的推导与 `computeSkillsPlan` 的 `sourceSwitches` 同一口径：这个来源下有勾中的
    // 技能 = 开（只看已勾的键，不做前缀模糊匹配）。
    const prefix = key + '/'
    return archive.skills.some((k) => k.startsWith(prefix))
  }
  // mcp / mcpTools 共用 `mcp` 段的两级形态（服务器 '*' | 工具名清单 | 键缺失 = 整台未勾）。
  if (archive.mcp === undefined) return undefined
  if (domain === 'mcp') return archive.mcp[key] !== undefined
  const slash = key.indexOf('/')
  if (slash <= 0) return undefined
  const server = key.slice(0, slash)
  const tool = key.slice(slash + 1)
  const spec = archive.mcp[server]
  if (spec === undefined) return false            // 整台未勾 = 它的工具全关
  if (spec === '*') return true                   // 勾了整台 = 全部工具
  return spec.indexOf(tool) >= 0                  // 勾了清单 = 成员开、其余关
}

/**
 * 四层叠加后某域某键的**下层值**（覆盖之下的那一层）：场景层 → 基线（脱离时）→ undefined。
 * 调用方拿到 undefined 时去问全局（实时值在这四层之外，本函数不读它）。
 */
export function layeredFlag(
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
  domain: ScopeFlagDomain,
  key: string,
): boolean | undefined {
  if (scope === undefined) return undefined
  const sceneVal = scope.scene !== undefined ? sceneFlagOf(archive, domain, key) : undefined
  if (sceneVal !== undefined) return sceneVal
  if (scope.detached === true) {
    const base = scope.baseline?.flags?.[domain]?.[key]
    if (typeof base === 'boolean') return base
  }
  return undefined
}

/** 覆盖表里有没有 `prefix` 开头且值为 true 的键（上层闸推导用）。 */
function hasTruePrefix(map: Record<string, boolean> | undefined, prefix: string): boolean {
  if (map === undefined) return false
  for (const [k, v] of Object.entries(map)) if (v === true && k.startsWith(prefix)) return true
  return false
}

/**
 * 本会话的**上层闸推导**：把某条工具 / 技能显式拨开，就认它所在的整台服务器 / 来源也是开
 * （0.21.2 复核）。没有这条推导，全局后来关掉服务器 / 来源时，会话里那条显式开启会变成
 * "界面开着、模型调不到"——读侧（可见性 / 认领 / 目录）与界面各说各话。
 *
 * 只做**正向**推导：显式关一条子项不关上层。显式的上层覆盖（含关）由调用方先判。
 */
export function childClaimsUpper(
  scope: SessionScope | undefined,
  domain: ScopeFlagDomain,
  key: string,
): boolean {
  const prefix = key + '/'
  if (domain === 'mcp') return hasTruePrefix(scope?.mcpTools, prefix)
  if (domain === 'skillSources') return hasTruePrefix(scope?.skills, prefix)
  return false
}

/**
 * 四层叠加后某域某键的**下层值**，含上层闸推导（覆盖之下那一层）：场景层 → 基线（脱离时）
 * → undefined。调用方拿到 undefined 时去问全局（实时值在这四层之外，本函数不读它）。
 *
 * 与 `layeredFlag` 的差别只有上层闸这一条：`layeredFlag` 回答"下层（场景 / 基线）说了什么"，
 * 写侧判自动清除要用它；这里回答"去掉这一格的覆盖之后，它会是什么"，读侧判生效值用它。
 */
export function layeredFlagWithChildren(
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
  domain: ScopeFlagDomain,
  key: string,
): boolean | undefined {
  if (childClaimsUpper(scope, domain, key)) return true
  return layeredFlag(scope, archive, domain, key)
}

/** 某域某键的**生效值**（覆盖 → 场景层 → 基线 → 全局）。 */
export function effectiveFlag(
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
  domain: ScopeFlagDomain,
  key: string,
  globalValue: boolean,
): boolean {
  const over = scope?.[domain]?.[key]
  if (typeof over === 'boolean') return over
  const lower = layeredFlagWithChildren(scope, archive, domain, key)
  return lower === undefined ? globalValue : lower
}

/** 某域某键的**覆盖值**（没覆盖 = undefined）。 */
export function overrideOf(scope: SessionScope | undefined, domain: ScopeFlagDomain, key: string): boolean | undefined {
  const raw = scope?.[domain]?.[key]
  return typeof raw === 'boolean' ? raw : undefined
}

/**
 * 本会话生效的场景名。`undefined` = 跟随全局。
 *
 * 三条来路：进入的场景 → 基线里的场景（脱离时）→ 没有（跟随全局）。基线里记的是
 * `null`（创建时就没有场景）时按 `undefined` 返回：消费方（记忆 / 提示词）只有
 * "钉某个场景"与"跟随全局"两态，没有"钉住没有场景"这一态。
 */
export function sessionSceneOf(scope: SessionScope | undefined): string | undefined {
  if (scope === undefined) return undefined
  if (scope.scene !== undefined) return scope.scene
  if (scope.detached === true) {
    const base = scope.baseline?.scene
    if (typeof base === 'string' && base !== '') return base
  }
  return undefined
}

/**
 * 本会话**钉住的场景**（三态，0.21.2 复核）：`string` = 钉住它；`null` = 钉住"没有场景"
 * （已脱离且基线里就没有场景）；`undefined` = 跟随全局。
 *
 * 与 `sessionSceneOf` 的差别只在 `null` 这一支：那个函数把"创建时没有场景"折成 undefined，
 * 注入侧照着它走就会在退出场景后跟着**后来**才启用的全局场景看记忆 / 提示词 —— 界面
 * （`layerParentSnapshot` 报 `scene: null`）与上下文各说各话，而且别的对话切全局场景会
 * 悄悄改这个对话的上下文。注入侧（记忆 / 提示词 / 场景绑定）一律用这个函数。
 */
export function sessionScenePinOf(scope: SessionScope | undefined): string | null | undefined {
  if (scope === undefined) return undefined
  if (scope.scene !== undefined) return scope.scene
  if (scope.detached === true) {
    const base = scope.baseline?.scene
    return typeof base === 'string' && base !== '' ? base : null
  }
  return undefined
}

/**
 * 这个会话的**可显示生效值**：覆盖 → 场景层 → 基线 → 全局，逐键算出后只回"与全局不同"的那些。
 *
 * 给界面与模型工具用（它们手里都有各域自己的全局值，照旧 `map[key] ?? global` 取用即可）。
 * 空对象 = 这个方向与全局完全一致（跟随）。
 */
export function effectiveDiff(
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
  global: ScopeGlobalSnapshot,
): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {}
  if (scope === undefined) return out
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const g = global.flags[domain] ?? {}
    const over = scope[domain]
    // 键集合 = 全局快照里的那些（界面 / 模型能拨的键也就是它们）+ 覆盖表里已记下的键。
    const keys = new Set<string>([...Object.keys(g), ...Object.keys(over ?? {})])
    const diff: Record<string, boolean> = {}
    for (const key of keys) {
      const v = effectiveFlag(scope, archive, domain, key, g[key] === true)
      if (v !== (g[key] === true)) diff[key] = v
    }
    if (Object.keys(diff).length > 0) out[domain] = diff
  }
  return out
}

/**
 * 写入一个布尔覆盖，返回**新**会话覆盖（不改入参）。
 *
 * 新值 == **下层值**（场景层 / 基线 / 全局，由调用方按 `layeredFlag` 先算好）→ 删掉这个键
 * （自动清除）；域表空了就把域整个删掉；什么也不剩且没有元数据时返回 `{ scope: undefined }`，
 * 由调用方删掉会话条目。
 */
export function applyFlag(
  scope: SessionScope | undefined,
  domain: ScopeFlagDomain,
  key: string,
  value: boolean,
  parentValue: boolean,
): { scope: SessionScope | undefined; changed: boolean } {
  const base = scope === undefined ? {} : scope
  const current = base[domain]
  const map: Record<string, boolean> = Object.assign(Object.create(null), current === undefined ? {} : current)
  const before = typeof map[key] === 'boolean' ? map[key] : undefined
  const next = value === parentValue ? undefined : value
  if (next === before) return { scope, changed: false }
  if (next === undefined) delete map[key]
  else map[key] = next
  const out: SessionScope = { ...base }
  if (Object.keys(map).length > 0) out[domain] = map
  else delete out[domain]
  return { scope: isKeepableScope(out) ? out : undefined, changed: true }
}

/**
 * 进入场景：清掉七个域的显式覆盖（场景模式从场景的状态开始），删 `detached`，写 `scene`。
 *
 * `toolTableHidden` **不在这里清**：工具表是每个对话自己的整份名单，场景没绑方案时
 * 不该碰它；绑了方案时由 op 层在这一次写入里整份替换（0.21.2）。
 */
export function enterSceneInScope(scope: SessionScope | undefined, scene: string): { scope: SessionScope; changed: boolean } {
  const out: SessionScope = { ...(scope === undefined ? {} : scope), scene }
  delete out.detached
  for (const domain of SCOPE_FLAG_DOMAINS) delete out[domain]
  // 提示词覆盖是会话层显式设置，不进场景快照、进出场景都不清（0.21.2）。
  return { scope: out, changed: true }
}

/**
 * 退出场景：删 `scene` 与七个域的显式覆盖，写 `detached`（下层换成基线 = 会话创建时的样子）。
 *
 * 显式覆盖也一起清：用户裁定「退出到这个会话最开始的样子」—— 场景模式期间拨过的所有开关
 * 都不该留到退出之后。`locked` 与 `baseline` 保留（前者是元数据，后者正是要回到的那一份）。
 */
export function exitSceneInScope(scope: SessionScope | undefined): { scope: SessionScope; changed: boolean } {
  const out: SessionScope = { ...(scope === undefined ? {} : scope), detached: true }
  delete out.scene
  for (const domain of SCOPE_FLAG_DOMAINS) delete out[domain]
  // 工具表也回到会话创建时抄的那份（`baseline.toolTableHidden`）：
  // 与其余开关同一条「退出到这个会话最开始的样子」。
  delete out.toolTableHidden
  return { scope: out, changed: true }
}

/** 挂上基线（已存在就不动 —— 先记的才是"创建时"那一份）。 */
export function withBaseline(scope: SessionScope | undefined, baseline: SessionBaseline): { scope: SessionScope; changed: boolean } {
  const base = scope === undefined ? {} : scope
  if (base.baseline !== undefined && base.baseline.capturedAt !== undefined) return { scope: base, changed: false }
  const out: SessionScope = { ...base, baseline }
  return { scope: out, changed: true }
}

/** 两张工具名名单是不是同一份（顺序无关；空数组与 undefined 不等价）。 */
export function sameToolNameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((name) => set.has(name))
}

/** 把 `key → boolean` 表里 `from/` 开头的键换成 `to/`；没换返回原对象（调用方据此判 changed）。 */
function renameKeyPrefix(map: Record<string, boolean>, from: string, to: string): Record<string, boolean> {
  const prefix = from + '/'
  let hit = false
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) { hit = true; break }
  }
  if (!hit) return map
  const out: Record<string, boolean> = Object.create(null)
  for (const [key, value] of Object.entries(map)) {
    out[key.startsWith(prefix) ? to + '/' + key.slice(prefix.length) : key] = value
  }
  return out
}

/**
 * 场景**改名**后同步一个会话（0.21.2 复核）。返回原引用 = 这个会话与旧名无关。
 *
 * 场景名会出现在两处键里：`scene` / `baseline.scene`，以及记忆键（`<场景>/<名>`）
 * —— 改名会迁移 `index.rules` 的键，会话覆盖不跟着换前缀就会指向不存在的记忆。
 * 技能 / 服务器 / 人设 / 快捷词的键都不含场景名，不动。
 */
export function renameSceneInScope(
  scope: SessionScope | undefined,
  from: string,
  to: string,
): { scope: SessionScope | undefined; changed: boolean } {
  if (scope === undefined || from === '' || to === '' || from === to) return { scope, changed: false }
  let changed = false
  const out: SessionScope = { ...scope }
  if (out.scene === from) { out.scene = to; changed = true }
  if (out.memory !== undefined) {
    const renamed = renameKeyPrefix(out.memory, from, to)
    if (renamed !== out.memory) { out.memory = renamed; changed = true }
  }
  const baseline = out.baseline
  if (baseline !== undefined) {
    let baseChanged = false
    const nextBase: SessionBaseline = { ...baseline }
    if (nextBase.scene === from) { nextBase.scene = to; baseChanged = true }
    const memory = nextBase.flags?.memory
    if (memory !== undefined) {
      const renamed = renameKeyPrefix(memory, from, to)
      if (renamed !== memory) {
        nextBase.flags = { ...nextBase.flags, memory: renamed }
        baseChanged = true
      }
    }
    if (baseChanged) { out.baseline = nextBase; changed = true }
  }
  return { scope: changed ? out : scope, changed }
}

/**
 * 场景**删除**后同步一个会话（0.21.2 复核）。
 *
 * 会话正停在这个场景里 → 按「退出场景」处理（下层换成基线；场景期间拨过的开关与场景
 * 套上的工具表一起清掉）。所有会话里指向该场景记忆的覆盖也一并删掉 —— 那些记忆条目
 * 已经随场景进了回收站，留下的是一个永远对不上的键。
 *
 * `baseline.flags.memory` 里属于该场景的键**保留**：基线是"创建时"的历史事实，场景若从
 * 回收站恢复，这些键仍然描述那一刻的启停。只有 `baseline.scene` 必须清掉 —— 否则退出
 * 模式后会一直指向一个不存在的场景（`sessionSceneOf` 会拿它当生效场景）。
 */
export function removeSceneInScope(
  scope: SessionScope | undefined,
  scene: string,
): { scope: SessionScope | undefined; changed: boolean } {
  if (scope === undefined || scene === '') return { scope, changed: false }
  let changed = false
  let next: SessionScope
  if (scope.scene === scene) {
    next = exitSceneInScope(scope).scope
    changed = true
  } else {
    next = { ...scope }
  }
  if (next.memory !== undefined) {
    const prefix = scene + '/'
    const kept: Record<string, boolean> = Object.create(null)
    let dropped = false
    for (const [key, value] of Object.entries(next.memory)) {
      if (key.startsWith(prefix)) { dropped = true; continue }
      kept[key] = value
    }
    if (dropped) {
      changed = true
      if (Object.keys(kept).length > 0) next.memory = kept
      else delete next.memory
    }
  }
  if (next.baseline !== undefined && next.baseline.scene === scene) {
    next.baseline = { ...next.baseline, scene: null }
    changed = true
  }
  if (!changed) return { scope, changed: false }
  return { scope: isKeepableScope(next) ? next : undefined, changed: true }
}

/**
 * 场景里的工具表方案**改了**以后，把新名单同步到停在这个场景里的会话（0.21.2 复核）。
 *
 * 工具表是进场景那一刻抄进 `toolTableHidden` 的（与 mcp / 技能等"按档案实时算"的域不同），
 * 方案后来怎么改都到不了已经进来的会话 —— 用户改了绑定、本对话却还按旧名单。`hidden`
 * 给 `null` = 方案已不存在 / 解绑，保持现状（与场景表单「解绑 = 保持现状」同一句话）。
 */
export function setSceneToolTableInScope(
  scope: SessionScope | undefined,
  scene: string,
  hidden: readonly string[] | null,
): { scope: SessionScope | undefined; changed: boolean } {
  if (scope === undefined || hidden === null || scope.scene !== scene) return { scope, changed: false }
  if (sameToolNameList(scope.toolTableHidden, hidden)) return { scope, changed: false }
  return { scope: { ...scope, toolTableHidden: hidden.slice() }, changed: true }
}

/**
 * `mcpTools` 键（`<server>/<tool>`）里的 server 段。
 *
 * 会话 MCP 判定的候选集合要收它：只把整串键塞进 `serverNameCandidates` 会得到
 * `a/tool` 这种不是服务器的名字，server 名本身含 `__` 时切分就认不出来（0.21.2）。
 */
export function mcpToolServerSegments(map: Record<string, boolean> | undefined): string[] {
  if (map === undefined) return []
  const out: string[] = []
  for (const key of Object.keys(map)) {
    const slash = key.indexOf('/')
    if (slash > 0) out.push(key.slice(0, slash))
  }
  return out
}

/** 全局快照里本插件认识的那一份（`scene` 是当前场景名，`flags` 是各域各键的全局开关）。 */
export interface ScopeGlobalSnapshot {
  scene: string | null
  flags: Record<string, Record<string, boolean>>
  /**
   * 这一轮**没读到**的域（`scene` 也在这里，名字就是 `'scene'`）。
   *
   * 读不到的域**不能拿来判"值 == 下层"**：那份快照里它是空的，于是"关掉某个东西"
   * 会被判成"与下层同值"而自动清除 —— 一次读盘失败就静默删掉用户的设置。
   * 写侧据此拒绝对该域的写入，读侧据此跳过该域的剪枝。
   */
  unavailable?: readonly string[]
  /**
   * 三格真租约的**意图**（0.21.2：MCP 服务器 / 技能来源 / 单条技能）。`flags` 里那几格给的
   * 是意图的布尔投影（blocked 也投影成 false），这里保留三态：界面要区分「关着」与「彻底停止」。
   */
  intent?: {
    mcp: Record<string, IntentState>
    skillSources: Record<string, IntentState>
    skills: Record<string, IntentState>
  }
  /**
   * 本会话之外**还在认领**这一格的会话数（0.21.2，租约的读侧 —— 七个域都给）。
   *
   * 界面据此显示「临时运行 · N 个对话」：全局 off 但连接在跑，用户要能看见为什么。
   * 会话层拨关时也用它提示"别的对话还在用，连接不会停"。
   *
   * **全部读时现算**（0.21.2 第四轮，`scanSessionClaims`）：会话的删除 / 归档 / 恢复 / 重启
   * 都不走插件的写 op，没有任何触发点可挂 —— 挂在对账器内存缓存上的那三个域（mcp /
   * skillSources / skills）会因此停在旧值。现算之后这一份恒等于"此刻的会话清单"。
   *
   * 三格真租约（mcp / skillSources / skills）会顺带把资源拉起来；另外四格
   * （mcpTools / memory / subagents / quickPrompts）没有要落地的运行态，认领数按有效层现算 ——
   * 用户要的答案是同一个：这一格现在开着，是因为全局，还是因为某个对话。
   */
  leases?: {
    mcp: Record<string, number>
    skillSources: Record<string, number>
    skills: Record<string, number>
    mcpTools: Record<string, number>
    memory: Record<string, number>
    subagents: Record<string, number>
    quickPrompts: Record<string, number>
  }
}

/**
 * 把场景层与基线**铺进**那份全局快照：得到的每一格就是"覆盖之下的下层值"。
 *
 * 键集合 = 全局快照里已有的那些键（界面能拨的键也就是它们）—— 场景档案里的勾选键若已经
 * 不在快照里（技能被删 / 服务器被移除），它本来也没地方显示，不在这里补。
 */
export function layerParentSnapshot(
  global: ScopeGlobalSnapshot,
  scope: SessionScope | undefined,
  archive: SceneArchive | undefined,
): ScopeGlobalSnapshot {
  if (scope === undefined) return global
  const flags: Record<string, Record<string, boolean>> = {}
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const merged: Record<string, boolean> = { ...(global.flags[domain] ?? {}) }
    if (scope.detached === true) {
      const base = scope.baseline?.flags?.[domain]
      if (base !== undefined) {
        for (const key of Object.keys(merged)) {
          const v = base[key]
          if (typeof v === 'boolean') merged[key] = v
        }
      }
    }
    if (archive !== undefined && scope.scene !== undefined) {
      for (const key of Object.keys(merged)) {
        const v = sceneFlagOf(archive, domain, key)
        if (v !== undefined) merged[key] = v
      }
    }
    flags[domain] = merged
  }
  const scene = scope.scene !== undefined
    ? scope.scene
    : (scope.detached === true ? (scope.baseline?.scene ?? null) : global.scene)
  return { scene, flags, ...(global.unavailable === undefined ? {} : { unavailable: global.unavailable }) }
}

/**
 * 按下层快照**剪掉**与下层同值的覆盖（读侧判定，见文件头）。
 *
 * 只出结论、不落盘：`scope-get` 是只读 op，在它里面写盘会把它变成写操作
 * （令牌门禁与流水的判据都会跟着错）。真正的清理由写侧自动清除与启动对账负责。
 */
export function pruneScope(scope: SessionScope | undefined, parent: ScopeGlobalSnapshot): SessionScope | undefined {
  if (scope === undefined) return undefined
  const unavailable = new Set(parent.unavailable ?? [])
  const out: SessionScope = {}
  // `scene` 不参与剪枝：场景模式是模式，与全局那个场景同名也照样留住。
  if (scope.scene !== undefined) out.scene = scope.scene
  for (const domain of SCOPE_FLAG_DOMAINS) {
    const map = scope[domain]
    if (map === undefined) continue
    // 该域这一轮没读到 → 整张表原样保留（见 `unavailable` 的注释）。
    if (unavailable.has(domain)) { out[domain] = { ...map }; continue }
    const kept: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(map)) {
      // 压制子项推导的显式「关」：它等于下层，但删掉它上层就会被子项推导回"开"——不是冗余。
      if (value === false && childClaimsUpper(scope, domain, key)) { kept[key] = value; continue }
      if (parent.flags[domain]?.[key] !== value) kept[key] = value
    }
    if (Object.keys(kept).length > 0) out[domain] = kept
  }
  // 提示词覆盖与下层无关（它是"用户级那一槽换成哪份正文"，不是开关），原样保留。
  if (scope.prompt !== undefined) out.prompt = { ...scope.prompt }
  const toolTableHidden = scope.toolTableHidden
  if (toolTableHidden !== undefined) {
    const base = scope.baseline?.toolTableHidden
    // 与基线是同一份（顺序无关）就不留这条覆盖；没有基线时保留（否则会退回实时全局）。
    const sameAsBaseline = base !== undefined &&
      base.length === toolTableHidden.length &&
      toolTableHidden.every((name) => base.indexOf(name) >= 0)
    if (!sameAsBaseline) out.toolTableHidden = toolTableHidden.slice()
  }
  if (scope.detached === true) out.detached = true
  if (scope.baseline !== undefined) out.baseline = scope.baseline
  if (scope.locked === true) out.locked = true
  return isKeepableScope(out) ? out : undefined
}