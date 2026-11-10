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
import type { JsonFileRead } from '../mcp/disabled-tools.js'

/** 策略文件的目录（hub 内相对路径）。 */
export const EVOLUTION_DIR = 'evolution'
export const EVOLUTION_SETTINGS_FILE = 'evolution/settings.json'
export const EVOLUTION_WORKSPACES_FILE = 'evolution/workspaces.json'
export const EVOLUTION_SESSIONS_FILE = 'evolution/sessions.json'

/** 工作区身份：`workspaceScopeKeyOf` 的键取 sha256 前 16 位。 */
export function workspaceHashOf(scopeKey: string): string {
  return createHash('sha256').update(String(scopeKey)).digest('hex').slice(0, WORKSPACE_HASH_LEN)
}

/** 学到的笔记用什么口吻写（用户 2026-11-10：默认简洁高效，不要表情和语气词）。 */
export type NoteStyle = 'efficient' | 'friendly' | 'minimal' | 'custom'

/** 每种风格给模型的一句话指引（注入进自动段与复习器提示）。custom 用用户自己的话。 */
export const NOTE_STYLE_GUIDE: Record<Exclude<NoteStyle, 'custom'>, string> = {
  efficient: 'Write terse and factual: no emoji, no tone words, no filler; one imperative sentence.',
  friendly: 'Write plain and warm but still short: no emoji, no exclamation marks.',
  minimal: 'Write in as few words as possible.',
}

/** 把任意输入洗成合法风格与自定义文本（custom 文本截到 200 字符）。 */
export function normalizeNoteStyle(raw: any): { style: NoteStyle; custom: string } {
  const preset = (s: unknown): NoteStyle | null =>
    (typeof s === 'string' && (s === 'efficient' || s === 'friendly' || s === 'minimal' || s === 'custom')) ? s as NoteStyle : null
  // 两种输入形态：裸字符串（老接口 / 界面快捷写法）或 { style, custom } 对象。
  const style = raw !== null && typeof raw === 'object' ? preset(raw.style) : preset(raw)
  const custom = raw !== null && typeof raw === 'object' && typeof raw.custom === 'string'
    ? raw.custom.trim().slice(0, 200)
    : ''
  return {
    // custom 没给文本 = 没法注入指引，退回 efficient，绝不注入一句空话。
    style: (style === null || (style === 'custom' && custom === '')) ? 'efficient' : style,
    custom: style === 'custom' ? custom : '',
  }
}

/** 生效的风格指引（一句话，注入用）。 */
export function noteStyleGuideOf(style: NoteStyle, custom: string): string {
  if (style === 'custom') return custom.trim()
  return NOTE_STYLE_GUIDE[style]
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
   * 是否注入。`undefined` = 跟随 `enabled`（见 resolveEffectiveConfig）。
   * 独立出来的理由：用户可能"不想学，但之前学的还能用"，也可能"先攒着，回头再看"。
   */
  inject?: boolean
  reviewEveryTurns?: number
  maxReviewsPerSession?: number
  /** 复习用哪个模型；空串 = 会话当前模型。 */
  model?: string
  /** 笔记风格：efficient（默认）/ friendly / minimal / custom。 */
  noteStyle?: NoteStyle
  /** noteStyle=custom 时的自定义指引（≤200 字符）。 */
  noteStyleText?: string
}

/** 全局设置：所有字段都有值。 */
export interface EvolutionSettings extends Required<Omit<EvolutionOverrides, 'inject'>> {
  inject?: boolean
}

/**
 * 出厂值。两个开关都 `false` 是硬要求：这个功能改变的是「agent 可以不经用户要求就写记忆」，
 * 授权边界的变更必须由用户显式打开。
 */
export const DEFAULT_EVOLUTION_SETTINGS: EvolutionSettings = {
  learnGlobal: false,
  learnWorkspace: false,
  reviewEveryTurns: 8,
  maxReviewsPerSession: 2,
  model: '',
  noteStyle: 'efficient',
  noteStyleText: '',
}

/** 解析后的生效配置，附带「哪一档说了算」。 */
export interface EffectiveEvolutionConfig extends EvolutionSettings {
  /** 两项任一为真；工具可见性与后台复习读它。 */
  enabled: boolean
  /** `inject` 已按「跟随 enabled」解析过，不是 undefined。 */
  inject: boolean
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
 * 上限是工作区的人不该突然获得写全局的资格。`learnScope` 除 `off` 外没有实际限制作用，
 * 因此不参与迁移。旧值在 `enabled=false` 时一律两项全关。
 */
function legacyLearnFlags(raw: any): { global: boolean; workspace: boolean } | undefined {
  if (typeof raw?.enabled !== 'boolean') return undefined
  if (raw.enabled === false) return { global: false, workspace: false }
  if (raw.writeTarget === 'workspace' || raw.writeTarget === 'session') return { global: false, workspace: true }
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
  const inject = typeof r.inject === 'boolean' ? r.inject : undefined
  const legacy = legacyLearnFlags(r)
  const style = normalizeNoteStyle(r.noteStyle === undefined && r.noteStyleText === undefined
    ? undefined
    : { style: r.noteStyle, custom: r.noteStyleText })
  return {
    learnGlobal: typeof r.learnGlobal === 'boolean' ? r.learnGlobal : (legacy?.global ?? d.learnGlobal),
    learnWorkspace: typeof r.learnWorkspace === 'boolean' ? r.learnWorkspace : (legacy?.workspace ?? d.learnWorkspace),
    ...(inject !== undefined ? { inject } : {}),
    reviewEveryTurns: intOf(r.reviewEveryTurns, d.reviewEveryTurns, 1, 100),
    maxReviewsPerSession: intOf(r.maxReviewsPerSession, d.maxReviewsPerSession, 0, 20),
    model: typeof r.model === 'string' ? r.model : d.model,
    noteStyle: style.style,
    noteStyleText: style.custom,
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
  if (typeof r.inject === 'boolean') out.inject = r.inject
  if (typeof r.reviewEveryTurns === 'number' && Number.isFinite(r.reviewEveryTurns)) out.reviewEveryTurns = intOf(r.reviewEveryTurns, 8, 1, 100)
  if (typeof r.maxReviewsPerSession === 'number' && Number.isFinite(r.maxReviewsPerSession)) out.maxReviewsPerSession = intOf(r.maxReviewsPerSession, 2, 0, 20)
  if (typeof r.model === 'string') out.model = r.model
  if (r.noteStyle !== undefined || r.noteStyleText !== undefined) {
    const style = normalizeNoteStyle({ style: r.noteStyle, custom: r.noteStyleText })
    out.noteStyle = style.style
    if (style.style === 'custom') out.noteStyleText = style.custom
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
 * `inject` 的默认值**跟随解析后的 `enabled`**：全新安装（全局关）不会因为磁盘上有历史文件
 * 而注入自动记忆。用户要"不学但用已有的"，显式设 `inject=true`。
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
  // 全局也可能显式设了 `inject`（"只记不用"）；只查两层覆盖会把它当成"没设"。
  const injectRaw = pick('inject') ?? global.inject
  return {
    learnGlobal,
    learnWorkspace,
    enabled,
    inject: injectRaw === undefined ? enabled : injectRaw,
    reviewEveryTurns: pick('reviewEveryTurns') ?? global.reviewEveryTurns,
    maxReviewsPerSession: pick('maxReviewsPerSession') ?? global.maxReviewsPerSession,
    model: pick('model') ?? global.model,
    noteStyle: pick('noteStyle') ?? global.noteStyle,
    noteStyleText: pick('noteStyleText') ?? global.noteStyleText,
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
  writeSettings(next: EvolutionSettings): Promise<{ ok: true; settings: EvolutionSettings } | { ok: false; error: string }>
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

  async function writeSettings(next: EvolutionSettings): Promise<{ ok: true; settings: EvolutionSettings } | { ok: false; error: string }> {
    await ensureEvolutionDir()
    return deps.withWriteLock(async () => {
      const read = await readForWrite(hubPath(EVOLUTION_SETTINGS_FILE), '自主记忆设置')
      if (!read.ok) return read
      const normalized = normalizeEvolutionSettings({ ...normalizeEvolutionSettings(read.raw), ...next })
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
