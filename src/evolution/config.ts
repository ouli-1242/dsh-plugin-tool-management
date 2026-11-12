// 自主记忆的三级开关：全局 / 工作区 / 会话。
//
// 为什么三级而不是一个总开关：用户的两个真实诉求 ——「只给这个对话开」「只给这个项目开」——
// 一个布尔值都表达不了。要么全局开（每个新会话都学，敏感项目里是负担），要么全局关
// （想试的会话也开不了）。三级覆盖是能同时满足这两句话的最小结构。
//
// 为什么下层能覆盖上层的「关」：如果规定「全局关了下面一律不能开」，那"全局关、只给这个
// 对话开"就无法表达。所以解析规则是**就近优先**，不是"与"。
//
// 与 `scope-overrides.json` 的区别（两个东西长得很像，不能混）：
//   - 那一份管「这个会话的逐条开关存在哪一格」（作用域粒度），是 UI 偏好；
//   - 这一份管「这个环境允不允许主动学」，是策略。
//   层（记忆存在哪）永远用真实 sid 与真实 cwd，不读作用域粒度 —— 见 docs 01-model §4。

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { hubPath } from '../hub.js'
import { WORKSPACE_HASH_LEN } from '../memories/constants.js'
import { charWidth } from '../text-width.js'
import type { JsonFileRead } from '../mcp/disabled-tools.js'
import {
  NOTE_RATE_DEFAULTS, NOTE_RATE_MINUTES_MAX, NOTE_RATE_MINUTES_MIN, NOTE_RATE_NOTES_MAX, NOTE_RATE_NOTES_MIN,
} from './limits.js'

/** 策略文件的目录（hub 内相对路径）。 */
export const EVOLUTION_DIR = 'evolution'
export const EVOLUTION_SETTINGS_FILE = 'evolution/settings.json'
export const EVOLUTION_WORKSPACES_FILE = 'evolution/workspaces.json'
export const EVOLUTION_SESSIONS_FILE = 'evolution/sessions.json'

/** 工作区身份：`workspaceScopeKeyOf` 的键取 sha256 前 16 位。 */
export function workspaceHashOf(scopeKey: string): string {
  return createHash('sha256').update(String(scopeKey)).digest('hex').slice(0, WORKSPACE_HASH_LEN)
}

/** 内置笔记风格。`default` 是均衡档：1–2 句，结论 + 关键理由。 */
export type BuiltinNoteStyle = 'default' | 'detailed' | 'minimal'
/** 自定义风格的引用前缀；后面接 `CustomNoteStyle.id`。 */
export const CUSTOM_NOTE_STYLE_PREFIX = 'custom:'
/** 自定义风格：名称给用户认，`guide` 给模型看。 */
export interface CustomNoteStyle {
  id: string
  name: string
  guide: string
}

/** 用户最多保存几档自定义风格。 */
export const MAX_CUSTOM_NOTE_STYLES = 3
/** 名称的显示宽度上限（半角单位）：16 个字母，或 8 个汉字（每个算 2）。 */
export const MAX_CUSTOM_NOTE_STYLE_NAME_WIDTH = 16
/** 宽字符（汉字 / 全角 / emoji）个数上限：8 个。 */
export const MAX_CUSTOM_NOTE_STYLE_WIDE = 8
/** 自定义指引上限：与旧 `noteStyleText` 同一长度，足够写清口吻。 */
export const MAX_CUSTOM_NOTE_STYLE_GUIDE = 200

/** 选中的风格：内置档，或 `custom:<id>`。 */
export type NoteStyle = BuiltinNoteStyle | `${typeof CUSTOM_NOTE_STYLE_PREFIX}${string}`

/**
 * 每种内置风格给模型的一句话指引（注入进自动段与复习器提示）。
 *
 * 长度也归这里管：复习器的基础提示不再硬写「一句」，否则详细档与它直接打架。
 */
export const NOTE_STYLE_GUIDE: Record<BuiltinNoteStyle, string> = {
  default: 'Write one or two clear sentences: the conclusion first, then the key reason only when it changes how the note is applied. No emoji, no tone words, no filler.',
  detailed: 'Write a complete note in two or three short sentences: state the conclusion first, then the reason and any conditions or exceptions. No emoji, no tone words, no filler.',
  minimal: 'Write in as few words as possible.',
}

/** 旧值 → 新值：`efficient` 改名为 `default`，`friendly` 并入 `detailed`。 */
function styleIdOf(raw: unknown): NoteStyle | undefined {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === 'efficient') return 'default'
  if (s === 'friendly') return 'detailed'
  if (s === 'default' || s === 'detailed' || s === 'minimal') return s
  if (s.startsWith(CUSTOM_NOTE_STYLE_PREFIX) && s.length > CUSTOM_NOTE_STYLE_PREFIX.length) return s as NoteStyle
  return undefined
}

/** 名称显示宽度：汉字 / 全角 / emoji 算 2，其余算 1。客户端 `evoNameMetrics` 同一口径。 */
/**
 * 名称截断：宽度最多 16 个半角单位，且宽字符最多 8 个。
 * 于是中文最多 8 个字，英文最多 16 个字母，混排同时受两者约束。
 */
function truncateStyleName(s: string): string {
  let out = ''
  let width = 0
  let wide = 0
  for (const ch of s) {
    const w = charWidth(ch)
    const nextWide = wide + (w === 2 ? 1 : 0)
    if (width + w > MAX_CUSTOM_NOTE_STYLE_NAME_WIDTH || nextWide > MAX_CUSTOM_NOTE_STYLE_WIDE) break
    out += ch
    width += w
    wide = nextWide
  }
  return out
}

/**
 * 自定义风格列表归一化：最多 3 个，名称按显示宽度截断，指引截到 200 字符。
 *
 * id 只保留安全字符；缺失 / 重复时补一个 `cN`。id 是 `noteStyle` 的引用键，
 * 不能为空，也不能重复 —— 否则选中一个会命中另一个。
 */
function normalizeCustomStyles(raw: unknown): CustomNoteStyle[] {
  if (!Array.isArray(raw)) return []
  const out: CustomNoteStyle[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = truncateStyleName(String((item as any).name ?? '').trim().replaceAll(/\s+/g, ' '))
    const guide = String((item as any).guide ?? '').trim().replaceAll(/\s+/g, ' ').slice(0, MAX_CUSTOM_NOTE_STYLE_GUIDE)
    if (name === '' || guide === '') continue
    let id = String((item as any).id ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    if (id === '' || seen.has(id)) {
      let n = out.length + 1
      while (seen.has('c' + n)) n++
      id = 'c' + n
    }
    seen.add(id)
    out.push({ id, name, guide })
    if (out.length >= MAX_CUSTOM_NOTE_STYLES) break
  }
  return out
}

/** 选中的风格是否还指向一个存在的自定义档。 */
function styleAvailable(style: NoteStyle, customStyles: readonly CustomNoteStyle[]): boolean {
  if (style === 'default' || style === 'detailed' || style === 'minimal') return true
  const id = style.slice(CUSTOM_NOTE_STYLE_PREFIX.length)
  return customStyles.some((s) => s.id === id)
}

/**
 * 把任意输入洗成合法风格与自定义风格列表。
 *
 * 兼容两种旧设置：`efficient` / `friendly` 改名；`noteStyle=custom` + `noteStyleText`
 * 的单条自定义文本迁移成一条名为「我的风格」的自定义档。迁移只发生在读设置时，
 * `writeSettings` 落盘的是新形状，所以旧字段不会一直存在。
 */
export function normalizeNoteStyle(raw: any): { style: NoteStyle; customStyles: CustomNoteStyle[] } {
  // 兼容裸字符串（老接口 / 测试直接传 `'detailed'`）。
  const r = raw !== null && typeof raw === 'object' ? raw : { style: raw }
  const legacyText = typeof r.custom === 'string'
    ? r.custom.trim().replaceAll(/\s+/g, ' ').slice(0, MAX_CUSTOM_NOTE_STYLE_GUIDE)
    : ''
  let customStyles = normalizeCustomStyles(r.customStyles)
  if (r.style === 'custom' && legacyText !== '' && customStyles.length === 0) {
    customStyles = [{ id: 'legacy', name: '我的风格', guide: legacyText }]
  }
  let style: NoteStyle = r.style === 'custom' && legacyText !== ''
    ? `custom:legacy`
    : (styleIdOf(r.style) ?? 'default')
  // 选中的自定义档被删掉 / 引用了不存在的 id：退回默认档，绝不注入一句空指引。
  if (!styleAvailable(style, customStyles)) style = 'default'
  return { style, customStyles }
}

/** 生效的风格指引（一句话，注入用）。找不到自定义档时退回默认档。 */
export function noteStyleGuideOf(style: NoteStyle, customStyles: readonly CustomNoteStyle[] = []): string {
  if (style.startsWith(CUSTOM_NOTE_STYLE_PREFIX)) {
    const id = style.slice(CUSTOM_NOTE_STYLE_PREFIX.length)
    return customStyles.find((s) => s.id === id)?.guide ?? NOTE_STYLE_GUIDE.default
  }
  return NOTE_STYLE_GUIDE[style as BuiltinNoteStyle] ?? NOTE_STYLE_GUIDE.default
}

/**
 * 注入到自主记忆段的风格行；默认档返回空串。
 *
 * 默认档不注入：`memory_note` 的工具描述已经约束了均衡写法，再发一行只是常驻 token。
 * 非默认档（详细 / 极简 / 自定义）才需要把实际风格告诉模型。
 */
export function noteStyleLineOf(style: NoteStyle, customStyles: readonly CustomNoteStyle[] = []): string {
  if (style === 'default') return ''
  const guide = noteStyleGuideOf(style, customStyles)
  return guide === '' ? '' : `When saving a new learned note, write it in this style: ${guide}`
}

/** 全局默认值与可覆盖字段的公共形状。 */
export interface EvolutionOverrides {
  /**
   * 全局层是否启用：同时决定「允不允许学」与「注不注入」。
   *
   * 两个开关取代了旧的 `enabled` + `learnScope` + `writeTarget` 三件套：旧模型里
   * 「在哪学」和「最多写到哪」是两条正交轴，但界面上从来没有暴露过后两者，用户实际
   * 只会问「全局要不要 / 工作区要不要」。两项都关 = 功能关闭。
   */
  learnGlobal?: boolean
  /** 工作区层是否启用；语义同上。 */
  learnWorkspace?: boolean
  /**
   * 自动确认：不再弹范围卡，层与内容全交给 agent 决定。
   *
   * 关闭时（默认）交互式 learn 每次都弹卡，后台复习学到的条目落「待确认」。
   * 开着时两条路都直接生效 —— 后台复习同样跟随这一位，**不是**恒为自动：
   * 复习的输入是另一个模型写的转述，未经任何人过目就进入之后每一次对话的上下文，
   * 与「没卡片时仍待确认」的承诺冲突（判定见 `review.ts` 的 `autoActive` 一处）。
   */
  autoConfirm?: boolean
  maxReviewsPerSession?: number
  /**
   * 学习频率的窗口长度（分钟）。全局 / 工作区共用；
   * 每一层各自在窗口内计数，互不占用名额。
   */
  learnWindowMinutes?: number
  /** 每个窗口内每层最多新增多少条自主记忆；合并 / 更新不占名额。 */
  maxLearnsPerWindow?: number
  /**
   * 复习用哪个模型；空串 = 会话当前模型。
   *
   * 只换**模型**，不换推理强度：`review.ts` 的 `prepareCall` 不传 `reasoningEffort`，
   * 由适配器按该模型的默认档补齐（官方 `LlmCallConfigAdapterDefaults` 只有
   * `reasoningEffort` 与 `maxTokens` 两项）。所以把对话调到最高档，后台复习仍是默认档 ——
   * 成本不跟着涨，用户不必为此担心。
   */
  model?: string
  /** 笔记风格：default（默认）/ detailed / minimal / custom:<id>。 */
  noteStyle?: NoteStyle
}

/** 全局设置：所有字段都有值。自定义风格的**定义**只存全局，覆盖层只能选不能改。 */
export interface EvolutionSettings extends Required<EvolutionOverrides> {
  customNoteStyles: CustomNoteStyle[]
}

/**
 * 出厂值。两个开关都 `false` 是硬要求：这个功能改变的是「agent 可以不经用户要求就写记忆」，
 * 授权边界的变更必须由用户显式打开。
 */
export const DEFAULT_EVOLUTION_SETTINGS: EvolutionSettings = {
  learnGlobal: false,
  learnWorkspace: false,
  autoConfirm: false,
  maxReviewsPerSession: 3,
  learnWindowMinutes: NOTE_RATE_DEFAULTS.minutes,
  maxLearnsPerWindow: NOTE_RATE_DEFAULTS.notes,
  model: '',
  noteStyle: 'default',
  customNoteStyles: [],
}

/** 解析后的生效配置，附带「哪一档说了算」。 */
export interface EffectiveEvolutionConfig extends EvolutionSettings {
  /**
   * 两项任一为真；工具可见性、注入与后台复习都读它。
   *
   * 注入没有独立开关：层的开关就是唯一的授权边界，「关掉」必须连注入一起关，
   * 否则界面上那颗开关会变成假动作。
   */
  enabled: boolean
  /** 最具体的那一档：界面显示「来源：本工作区设置」。 */
  source: 'global' | 'workspace' | 'session'
  /** 解析时用的身份，注入层要用它过滤层。 */
  workspaceKey?: string
  workspaceHash?: string
  sessionId?: string
}

const boolOf = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/**
 * 旧配置 → 两个新开关。
 *
 * 旧版有 `enabled` + `learnScope` + `writeTarget` 三个字段，但界面只暴露过 `enabled`；
 * `writeTarget` 是「最多写到哪」的上限，升级时把它翻译成「只开哪一层」最接近原意：
 * 上限是工作区的人不该突然获得写全局的资格。`learnScope='off'` 是旧版的「不学」开关，
 * 即使 `enabled=true` 也必须迁成两项全关，否则升级后会在用户没点头的情况下开始学习。
 * 旧值在 `enabled=false` 时同样两项全关。
 */
function legacyLearnFlags(raw: any): { global: boolean; workspace: boolean } | undefined {
  if (typeof raw?.enabled !== 'boolean') return undefined
  if (raw.enabled === false || raw.learnScope === 'off') return { global: false, workspace: false }
  // `writeTarget` 是旧版的显式上限；`learnScope` 是更早的同类概念（`workspace` / `session` 都表示
  // "只在这个项目里学"）。两个字段都认，否则只写了 `learnScope='workspace'` 的旧配置会掉进
  // 下面的兜底、升级后**从工作区扩大到全局** —— 那是用户从没同意过的权限变化。
  if (raw.writeTarget === 'workspace' || raw.writeTarget === 'session') return { global: false, workspace: true }
  if (raw.learnScope === 'workspace' || raw.learnScope === 'session') return { global: false, workspace: true }
  return { global: true, workspace: true }
}

const intOf = (v: unknown, fallback: number, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}

/** 宽松读：坏值一律回退到出厂值，不抛错（界面要能打开）。 */
export function normalizeEvolutionSettings(raw: any): EvolutionSettings {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_EVOLUTION_SETTINGS
  const legacy = legacyLearnFlags(r)
  const style = normalizeNoteStyle({
    style: r.noteStyle,
    customStyles: r.customNoteStyles,
    custom: r.noteStyleText,
  })
  return {
    learnGlobal: typeof r.learnGlobal === 'boolean' ? r.learnGlobal : (legacy?.global ?? d.learnGlobal),
    learnWorkspace: typeof r.learnWorkspace === 'boolean' ? r.learnWorkspace : (legacy?.workspace ?? d.learnWorkspace),
    autoConfirm: typeof r.autoConfirm === 'boolean' ? r.autoConfirm : d.autoConfirm,
    maxReviewsPerSession: intOf(r.maxReviewsPerSession, d.maxReviewsPerSession, 0, 20),
    learnWindowMinutes: intOf(r.learnWindowMinutes, d.learnWindowMinutes, NOTE_RATE_MINUTES_MIN, NOTE_RATE_MINUTES_MAX),
    maxLearnsPerWindow: intOf(r.maxLearnsPerWindow, d.maxLearnsPerWindow, NOTE_RATE_NOTES_MIN, NOTE_RATE_NOTES_MAX),
    model: typeof r.model === 'string' ? r.model : d.model,
    noteStyle: style.style,
    customNoteStyles: style.customStyles,
  }
}

/** 覆盖层归一化：只保留**明确写了**的字段，没写的保持 undefined（= 继承）。 */
export function normalizeOverrides(raw: any): EvolutionOverrides {
  const r = raw && typeof raw === 'object' ? raw : {}
  const out: EvolutionOverrides = {}
  const legacy = legacyLearnFlags(r)
  if (typeof r.learnGlobal === 'boolean') out.learnGlobal = r.learnGlobal
  else if (legacy !== undefined) out.learnGlobal = legacy.global
  if (typeof r.learnWorkspace === 'boolean') out.learnWorkspace = r.learnWorkspace
  else if (legacy !== undefined) out.learnWorkspace = legacy.workspace
  if (typeof r.autoConfirm === 'boolean') out.autoConfirm = r.autoConfirm
  if (typeof r.maxReviewsPerSession === 'number' && Number.isFinite(r.maxReviewsPerSession)) out.maxReviewsPerSession = intOf(r.maxReviewsPerSession, DEFAULT_EVOLUTION_SETTINGS.maxReviewsPerSession, 0, 20)
  if (typeof r.learnWindowMinutes === 'number' && Number.isFinite(r.learnWindowMinutes)) out.learnWindowMinutes = intOf(r.learnWindowMinutes, NOTE_RATE_DEFAULTS.minutes, NOTE_RATE_MINUTES_MIN, NOTE_RATE_MINUTES_MAX)
  if (typeof r.maxLearnsPerWindow === 'number' && Number.isFinite(r.maxLearnsPerWindow)) out.maxLearnsPerWindow = intOf(r.maxLearnsPerWindow, NOTE_RATE_DEFAULTS.notes, NOTE_RATE_NOTES_MIN, NOTE_RATE_NOTES_MAX)
  if (typeof r.model === 'string') out.model = r.model
  // 覆盖层只选风格，不定义自定义档；`custom:<id>` 是否存在由 resolveEffectiveConfig 校验。
  if (r.noteStyle !== undefined) {
    const style = styleIdOf(r.noteStyle)
    if (style !== undefined) out.noteStyle = style
  }
  return out
}

/** 这一层是否真的覆盖了至少一个字段（用于界面显示"来源"）。 */
export function hasOverrides(o: EvolutionOverrides | undefined): boolean {
  if (!o) return false
  return Object.keys(o).some((k) => (o as Record<string, unknown>)[k] !== undefined)
}

/**
 * 逐字段解析：会话 → 工作区 → 全局，取第一个有定义的。
 *
 * 注入与学习共用同一道开关：`enabled` 为假就既不学也不注入。曾经有过一颗独立的
 * 「学但不注入」开关，它让「学但不生效」与「关掉这一层」两套授权边界并存，用户无法
 * 从界面判断哪一颗才决定上下文内容 —— 已删除，不再保留字段。
 *
 * ⚠️ 旧配置里可能还存着 `inject`。这里**刻意忽略它**：它已不是受支持的字段，
 * 认它等于让那些用户的自主记忆永久不注入，而界面上已没有地方能改回来。
 */
export function resolveEffectiveConfig(
  global: EvolutionSettings,
  workspace?: EvolutionOverrides,
  session?: EvolutionOverrides,
): EffectiveEvolutionConfig {
  const layers = [session, workspace].filter((x): x is EvolutionOverrides => x !== undefined)
  const pick = <K extends keyof EvolutionOverrides>(k: K): EvolutionOverrides[K] | undefined => {
    for (const layer of layers) {
      const v = layer[k]
      if (v !== undefined) return v
    }
    return undefined
  }
  const learnGlobal = pick('learnGlobal') ?? global.learnGlobal
  const learnWorkspace = pick('learnWorkspace') ?? global.learnWorkspace
  const enabled = learnGlobal || learnWorkspace
  // 自定义档的定义永远来自全局；覆盖层只能选，不能改。选中的 id 被删掉时退回默认档。
  const customStyles = global.customNoteStyles ?? []
  const pickedStyle = pick('noteStyle')
  const noteStyle = pickedStyle !== undefined && styleAvailable(pickedStyle, customStyles)
    ? pickedStyle
    : (styleAvailable(global.noteStyle, customStyles) ? global.noteStyle : 'default')
  return {
    learnGlobal,
    learnWorkspace,
    autoConfirm: pick('autoConfirm') ?? global.autoConfirm,
    enabled,
    maxReviewsPerSession: pick('maxReviewsPerSession') ?? global.maxReviewsPerSession,
    learnWindowMinutes: pick('learnWindowMinutes') ?? global.learnWindowMinutes,
    maxLearnsPerWindow: pick('maxLearnsPerWindow') ?? global.maxLearnsPerWindow,
    model: pick('model') ?? global.model,
    noteStyle,
    customNoteStyles: customStyles,
    source: hasOverrides(session) ? 'session' : hasOverrides(workspace) ? 'workspace' : 'global',
  }
}

/** 一份工作区记录（`workspaces.json` 的 value）。 */
export interface WorkspaceRecord {
  /** 作用域键 `ws:<归一化路径>`。 */
  key: string
  /** 归一化前的真实 cwd（界面显示用）。 */
  cwd: string
  /** 目录名（界面显示用）。 */
  label: string
  createdAt: string
  lastSeenAt: string
  /** 路径不存在时的时间戳；null / 缺失 = 还在。 */
  missingAt?: string | null
  evolution?: EvolutionOverrides
}

/** 一份会话记录（`sessions.json` 的 value）。 */
export interface SessionRecord {
  lastSeenAt: string
  evolution?: EvolutionOverrides
}

export interface WorkspacesFile { version: 1; workspaces: Record<string, WorkspaceRecord> }
export interface SessionsFile { version: 1; sessions: Record<string, SessionRecord> }

export function normalizeWorkspacesFile(raw: any): WorkspacesFile {
  const r = raw && typeof raw === 'object' ? raw : {}
  const src = r.workspaces && typeof r.workspaces === 'object' ? r.workspaces : {}
  const workspaces: Record<string, WorkspaceRecord> = {}
  for (const [hash, value] of Object.entries<any>(src)) {
    if (!/^[0-9a-f]{8,64}$/.test(hash) || !value || typeof value !== 'object') continue
    if (typeof value.key !== 'string' || value.key === '') continue
    workspaces[hash] = {
      key: value.key,
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      label: typeof value.label === 'string' ? value.label : '',
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
      ...(typeof value.missingAt === 'string' || value.missingAt === null ? { missingAt: value.missingAt } : {}),
      ...(value.evolution !== undefined ? { evolution: normalizeOverrides(value.evolution) } : {}),
    }
  }
  return { version: 1, workspaces }
}

export function normalizeSessionsFile(raw: any): SessionsFile {
  const r = raw && typeof raw === 'object' ? raw : {}
  const src = r.sessions && typeof r.sessions === 'object' ? r.sessions : {}
  const sessions: Record<string, SessionRecord> = {}
  for (const [sid, value] of Object.entries<any>(src)) {
    if (sid === '' || !value || typeof value !== 'object') continue
    sessions[sid] = {
      lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
      ...(value.evolution !== undefined ? { evolution: normalizeOverrides(value.evolution) } : {}),
    }
  }
  return { version: 1, sessions }
}

/** 依赖：与 `settings-sidecars` 同一套（同一把写锁，避免与设置写入互相踩）。 */
export interface EvolutionConfigDeps {
  ensurePaths(): Promise<unknown>
  readJsonFile(abs: string): Promise<any>
  readJsonFileStrict(abs: string): Promise<JsonFileRead>
  writeJsonFile(abs: string, data: any): Promise<void>
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  message(e: unknown): string
}

/** 三级开关的读写门面。 */
export interface EvolutionConfigStore {
  readSettings(force?: boolean): Promise<EvolutionSettings>
  settingsSync(): EvolutionSettings
  readWorkspaces(force?: boolean): Promise<WorkspacesFile>
  readSessions(force?: boolean): Promise<SessionsFile>
  /** 读三份并解析；`scopeKey` / `sid` 由调用方从 agent 取（本模块不碰宿主对象）。 */
  effective(scopeKey: string | undefined, sid: string | undefined): Promise<EffectiveEvolutionConfig>
  /** 写全局设置（整体替换，未知字段丢弃）。 */
  /** 写全局设置。传**部分字段**：落盘时与锁内新读到的磁盘值合并，不覆盖并发改动。 */
  writeSettings(patch: Partial<EvolutionSettings>): Promise<{ ok: true; settings: EvolutionSettings } | { ok: false; error: string }>
  /** 写某个工作区的覆盖（`overrides` 为 undefined 表示清除覆盖）。 */
  writeWorkspace(scopeKey: string, cwd: string, label: string, overrides: EvolutionOverrides | undefined): Promise<{ ok: true; hash: string } | { ok: false; error: string }>
  /** 标记 / 清除工作区失效（不刷新 lastSeenAt）。 */
  markWorkspaceMissing(hash: string, missingAt: string | null): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>
  /** 写某个会话的覆盖。 */
  writeSession(sid: string, overrides: EvolutionOverrides | undefined): Promise<{ ok: true } | { ok: false; error: string }>
}

const TTL_MS = 3000

/**
 * 建一份三级开关的门面。与 `createSettingsSidecars` 同构：读宽松（坏文件回默认，界面能开），
 * 写严格（坏文件拒绝保存，避免用默认值覆盖用户刚改的配置）。
 */
export function createEvolutionConfig(deps: EvolutionConfigDeps): EvolutionConfigStore {
  let settingsCache: { at: number; value: EvolutionSettings } | null = null
  let workspacesCache: { at: number; value: WorkspacesFile } | null = null
  let sessionsCache: { at: number; value: SessionsFile } | null = null

  /**
   * 写之前把 `evolution/` 建出来。`writeJsonFile` 只做原子写，不建父目录（它假定调用方
   * 已经在 hub 根下）。少了这一步，第一次打开开关时会以 ENOENT 失败。
   */
  async function ensureEvolutionDir(): Promise<void> {
    await deps.ensurePaths()
    await mkdir(hubPath(EVOLUTION_DIR), { recursive: true })
  }

  async function readForWrite(abs: string, label: string): Promise<{ ok: true; raw: any } | { ok: false; error: string }> {
    const read = await deps.readJsonFileStrict(abs)
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return {
        ok: false,
        error: `${label}文件${read.status === 'corrupt' ? '损坏' : '不可读'}，已拒绝保存：${read.error}`,
      }
    }
    return { ok: true, raw: read.status === 'ok' ? read.value : null }
  }

  async function readSettings(force = false): Promise<EvolutionSettings> {
    if (settingsCache && !force && Date.now() - settingsCache.at < TTL_MS) return settingsCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(EVOLUTION_SETTINGS_FILE))
    settingsCache = { at: Date.now(), value: normalizeEvolutionSettings(raw) }
    return settingsCache.value
  }

  function settingsSync(): EvolutionSettings {
    if (settingsCache) return settingsCache.value
    void readSettings().catch(() => {})
    return DEFAULT_EVOLUTION_SETTINGS
  }

  async function readWorkspaces(force = false): Promise<WorkspacesFile> {
    if (workspacesCache && !force && Date.now() - workspacesCache.at < TTL_MS) return workspacesCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(EVOLUTION_WORKSPACES_FILE))
    workspacesCache = { at: Date.now(), value: normalizeWorkspacesFile(raw) }
    return workspacesCache.value
  }

  async function readSessions(force = false): Promise<SessionsFile> {
    if (sessionsCache && !force && Date.now() - sessionsCache.at < TTL_MS) return sessionsCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(EVOLUTION_SESSIONS_FILE))
    sessionsCache = { at: Date.now(), value: normalizeSessionsFile(raw) }
    return sessionsCache.value
  }

  async function effective(scopeKey: string | undefined, sid: string | undefined): Promise<EffectiveEvolutionConfig> {
    const [global, workspaces, sessions] = await Promise.all([readSettings(), readWorkspaces(), readSessions()])
    const hash = scopeKey ? workspaceHashOf(scopeKey) : undefined
    const workspace = hash ? workspaces.workspaces[hash]?.evolution : undefined
    const session = sid ? sessions.sessions[sid]?.evolution : undefined
    const resolved = resolveEffectiveConfig(global, workspace, session)
    return {
      ...resolved,
      ...(scopeKey !== undefined ? { workspaceKey: scopeKey } : {}),
      ...(hash !== undefined ? { workspaceHash: hash } : {}),
      ...(sid !== undefined ? { sessionId: sid } : {}),
    }
  }

  async function writeSettings(patch: Partial<EvolutionSettings>): Promise<{ ok: true; settings: EvolutionSettings } | { ok: false; error: string }> {
    await ensureEvolutionDir()
    return deps.withWriteLock(async () => {
      const read = await readForWrite(hubPath(EVOLUTION_SETTINGS_FILE), '自主记忆设置')
      if (!read.ok) return read
      // **基线取锁内新读到的磁盘值**，不是调用方手里那份可能已经过期的完整对象。
      // 早先签名收的是 `EvolutionSettings`（完整），调用方用 3 秒缓存的 `readSettings()`
      // 拼出整份再传进来 —— 两个窗口同时改不同字段时，后写的会用旧值覆盖前一个的改动。
      const normalized = normalizeEvolutionSettings({ ...normalizeEvolutionSettings(read.raw), ...patch })
      await deps.writeJsonFile(hubPath(EVOLUTION_SETTINGS_FILE), normalized)
      settingsCache = { at: Date.now(), value: normalized }
      return { ok: true as const, settings: normalized }
    })
  }

  async function writeWorkspace(
    scopeKey: string,
    cwd: string,
    label: string,
    overrides: EvolutionOverrides | undefined,
  ): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
    const hash = workspaceHashOf(scopeKey)
    await ensureEvolutionDir()
    return deps.withWriteLock(async () => {
      const read = await readForWrite(hubPath(EVOLUTION_WORKSPACES_FILE), '工作区记录')
      if (!read.ok) return read
      const current = normalizeWorkspacesFile(read.raw)
      const now = new Date().toISOString()
      const prev = current.workspaces[hash]
      current.workspaces[hash] = {
        key: scopeKey,
        cwd,
        label,
        createdAt: prev?.createdAt || now,
        lastSeenAt: now,
        ...(prev?.missingAt !== undefined ? { missingAt: prev.missingAt } : {}),
        ...(overrides === undefined ? {} : { evolution: overrides }),
      }
      await deps.writeJsonFile(hubPath(EVOLUTION_WORKSPACES_FILE), current)
      workspacesCache = { at: Date.now(), value: current }
      return { ok: true as const, hash }
    })
  }

  /**
   * 标记 / 清除工作区失效。
   *
   * 为什么不复用 `writeWorkspace`：那个方法每次都会刷新 `lastSeenAt`，而失效扫描的
   * 语义正相反 —— 目录都不在了，"刚刚见过"是假话。而且它需要 scopeKey 与 cwd，
   * 扫描手上只有 hash。
   */
  async function markWorkspaceMissing(
    hash: string,
    missingAt: string | null,
  ): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
    await ensureEvolutionDir()
    return deps.withWriteLock(async () => {
      const read = await readForWrite(hubPath(EVOLUTION_WORKSPACES_FILE), '工作区记录')
      if (!read.ok) return read
      const current = normalizeWorkspacesFile(read.raw)
      const prev = current.workspaces[hash]
      if (!prev) return { ok: true as const, changed: false }
      if ((prev.missingAt ?? null) === missingAt) return { ok: true as const, changed: false }
      current.workspaces[hash] = { ...prev, missingAt }
      await deps.writeJsonFile(hubPath(EVOLUTION_WORKSPACES_FILE), current)
      workspacesCache = { at: Date.now(), value: current }
      return { ok: true as const, changed: true }
    })
  }

  async function writeSession(
    sid: string,
    overrides: EvolutionOverrides | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> {    await ensureEvolutionDir()
    return deps.withWriteLock(async () => {
      const read = await readForWrite(hubPath(EVOLUTION_SESSIONS_FILE), '会话记录')
      if (!read.ok) return read
      const current = normalizeSessionsFile(read.raw)
      current.sessions[sid] = {
        lastSeenAt: new Date().toISOString(),
        ...(overrides === undefined ? {} : { evolution: overrides }),
      }
      await deps.writeJsonFile(hubPath(EVOLUTION_SESSIONS_FILE), current)
      sessionsCache = { at: Date.now(), value: current }
      return { ok: true as const }
    })
  }

  return { readSettings, settingsSync, readWorkspaces, readSessions, effective, writeSettings, writeWorkspace, markWorkspaceMissing, writeSession }
}
