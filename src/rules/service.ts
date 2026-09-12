// dsh-plugin-tool-management —— 规则/记忆（Rules v0.2）服务层。
//
// 规则 = $DSH_HOME/rules/<group>/<name>.md（flat）或 <group>/<name>/SKILL.md（bundle）。
// 双投影：按需层（provider.ts，按会话 agentPreset 过滤投影为 skill 目录条目）；
// 始终层（project.ts，always && enabled 规则确定性拼接进 ~/.dsh/AGENTS.md）。
//
// 状态分层（三份文件各司其职，互不写回）：
//   - 规则文件：正文真源。frontmatter 可声明 name/description/whenToUse/always/globs/metadata。
//   - rules-index.json：启停/常驻/排序/标签等**索引为准**字段（always/enabled 不写回规则文件）。
//   - scenes.json：场景过滤 —— 按会话 agentPreset 决定可见分组。
//
// 发现必须自实现（不复用 readonly-discovery）：可写来源只扫一层会压扁子目录分组，
// 而规则的分组天然是多层的；且 readonly-discovery 的 flat 只认顶层。
//
// 错误约定：业务校验失败返回 { ok:false, error: 中文, code, params? }（与 skills core 一致）；
// ops 成功返回扁平 { ok:true, ... }，不套 { ok:true, data }。

import { randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { KEBAB_RE, parseBoolValue, parseSkillDoc, resolveDshHome, toKebab, unquote } from '../skills/core.js'
import { createRuleProviderRegistrar } from './provider.js'
import {
  compareAlways,
  compileAlwaysProjection,
  DEFAULT_MAX_BYTES,
  writeAlwaysProjection,
  type AlwaysRuleInput,
} from './project.js'

// ── 常量 ───────────────────────────────────────────────────────────────────

const MAX_SOURCE_DEPTH = 64          // 与 core.js 一致
const MAX_DIRECTORIES = 2000         // 目录预算
const MAX_ENTRIES = 20000            // 条目预算
const MAX_GROUP_SEGMENT_LENGTH = 64  // 分组目录段名长度上限
const MAX_DESCRIPTION_LENGTH = 500   // 派生/显式描述上限（派生超长截断，显式超长拒绝）
const MAX_RULE_BYTES = 1 << 18       // 正文上限 256 KiB
const DEFAULT_ORDER = 1000           // 默认投影 order（索引无记录时）
const DEFAULT_GROUP_ORDER = 1000     // 新分组默认 order
const SNAPSHOT_TTL_MS = 1000         // 读路径短 TTL 缓存，吸收 UI 密集轮询
const SHARED_GROUP = '_shared'       // 场景约定：共享分组（所有场景默认可见）
const GROUP_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/
const INDEX_VERSION = 1
const SCENES_VERSION = 1

const message = (e: unknown): string => String((e && (e as Error).message) || e)
const fail = (code: string, error: string): { ok: false; error: string; code: string } => ({ ok: false, error, code })
const identity = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

// ── 对外接口 ───────────────────────────────────────────────────────────────

export interface RulesDeps {
  /** 规则根目录（绝对路径；空串/未提供时按 $DSH_HOME/rules 解析）。 */
  rulesRoot: string
  /** 侧车目录（索引/场景/回收站；空串/未提供时按 $DSH_HOME/tool-management 解析）。 */
  stateDir: string
  /** 始终层预算上限（字节），默认 65536。 */
  maxBytes?: number
  /** 解析 DSH 全局 AGENTS.md 的绝对路径。 */
  getGlobalAgentsMdPath: () => Promise<string>
}

export interface Rule {
  id: string
  group: string
  name: string
  /** 对外契约用 form（与 §7.1 一致）；内部发现用 DiscoveredEntry.kind。 */
  form: 'flat' | 'bundle'
  /** 规则文件绝对路径（flat= .md；bundle= SKILL.md）。 */
  path: string
  description: string
  descriptionDerived?: boolean
  whenToUse?: string
  globs?: string
  metadata?: unknown
  always: boolean
  enabled: boolean
  order: number
  tags: string[]
  pinned: boolean
  note: string
  updatedAt?: string
  /** 同名 bundle 存在时被遮蔽的 flat（UI 标红，不参与投影）。 */
  shadowed?: boolean
}

export interface GroupRow {
  name: string
  label: string
  order: number
  count: number
}

export interface RulesService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 注册 agent-scope 规则 provider；返回清理函数（配合 ctx.effect）。 */
  registerProviders: () => () => void
  /** 失效 provider 缓存 + 重投影始终层（写操作后调用）。 */
  refresh: () => Promise<void>
  // ── 内部（provider.ts 使用）──
  _invalidate: () => void
  _listProjected: (preset?: string) => Promise<Array<{ name: string; description: string }>>
  _getProjected: (candidate: any) => Promise<any>
}

// ── 内部类型 ───────────────────────────────────────────────────────────────

interface ParsedSkillDoc {
  fields: Array<{ key: string; raw: string }>
  map: Record<string, unknown>
  body: string
  hasFrontmatter: boolean
}

interface DiscoveredEntry {
  id: string
  group: string
  name: string
  kind: 'flat' | 'bundle'
  docPath: string
  entryPath: string
  /** 仅 shadowed flat 条目：同名 bundle 优先后被遮蔽（UI 标红）。 */
  shadowed?: boolean
}

interface Snapshot {
  rules: Rule[]
  groups: GroupRow[]
  warnings: string[]
  truncated: boolean
  entries: Map<string, DiscoveredEntry>
  bodies: Map<string, string>
}

interface RulesIndex {
  version: 1
  rules: Record<string, RuleIndexEntry>
  groups: Record<string, GroupIndexEntry>
}

interface RuleIndexEntry {
  order?: number
  tags?: string[]
  pinned?: boolean
  always?: boolean
  enabled?: boolean
  note?: string
  updatedAt?: string
}

interface GroupIndexEntry {
  order?: number
  label?: string
}

interface ScenesFile {
  version: 1
  includeSharedDefault: boolean
  presets: Record<string, { groups: string[]; note?: string }>
}

// ── 文件工具 ───────────────────────────────────────────────────────────────

/** 同目录临时文件 + rename 原子写（临时名 `.xxx.dsh-rules-<uuid>.tmp`）。 */
async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

// ── 分组名校验 ─────────────────────────────────────────────────────────────

function isValidGroupSegment(segment: string): boolean {
  return segment === SHARED_GROUP || (GROUP_SEGMENT_RE.test(segment) && segment.length <= MAX_GROUP_SEGMENT_LENGTH)
}

/** group 可多层（a/b/c），每段必须合法；_shared 作为共享分组保留名放行。 */
function isValidGroupPath(group: string): boolean {
  if (typeof group !== 'string' || group === '' || group.startsWith('/') || group.endsWith('/')) return false
  return group.split('/').every(isValidGroupSegment)
}

// ── 递归发现 ───────────────────────────────────────────────────────────────

/**
 * BFS 发现（realpath 防环、深度/目录/条目预算），与 readonly-discovery 同构，
 * 但规则的分组是**多层相对路径**（readonly-discovery 的 group 恒为第一层）。
 *
 * 目录语义：目录含 SKILL.md → 它是 bundle 规则（叶子，不再深入），其「父路径」
 * 是分组、目录名是规则名；否则它是分组/子分组，继续遍历其下 .md（flat，任意层级）
 * 与子目录。同名 flat 与 bundle 冲突时 bundle 优先，flat 记入 shadowed。
 */
async function discover(rulesRoot: string): Promise<{ entries: Map<string, DiscoveredEntry>; shadowed: DiscoveredEntry[]; groups: Set<string>; warnings: string[]; truncated: boolean }> {
  const entries = new Map<string, DiscoveredEntry>()
  const shadowed: DiscoveredEntry[] = []
  const groups = new Set<string>()
  const warnings: string[] = []
  const rootPath = resolve(rulesRoot)
  try {
    const st = await lstat(rootPath)
    if (!st.isDirectory() || st.isSymbolicLink()) return { entries, shadowed, groups, warnings, truncated: false }
  } catch {
    return { entries, shadowed, groups, warnings, truncated: false }
  }
  const queue: Array<{ path: string; group: string; depth: number; ancestors: Set<string> }> = [
    { path: rootPath, group: '', depth: 0, ancestors: new Set() },
  ]
  let directories = 0
  let itemCount = 0
  let truncated = false

  const addEntry = (entry: DiscoveredEntry): void => {
    const existing = entries.get(entry.id)
    if (!existing) {
      entries.set(entry.id, entry)
      return
    }
    if (entry.kind === 'bundle' && existing.kind === 'flat') {
      shadowed.push({ ...existing, shadowed: true })
      entries.set(entry.id, entry)
      return
    }
    if (entry.kind === 'flat' && existing.kind === 'bundle') {
      shadowed.push({ ...entry, shadowed: true })
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (directories >= MAX_DIRECTORIES || itemCount >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const current = queue[cursor]
    let realDirectory: string
    let dirents: import('node:fs').Dirent[] = []
    try {
      realDirectory = await realpath(current.path)
      if (current.ancestors.has(identity(realDirectory))) continue
      const dir = await readdir(current.path, { withFileTypes: true })
      directories++
      for (const item of dir) {
        if (itemCount >= MAX_ENTRIES) {
          truncated = true
          break
        }
        itemCount++
        dirents.push(item)
      }
    } catch {
      continue // 失效链接或不可读目录不阻断其他来源
    }

    // bundle 检查：当前目录（非根）含 SKILL.md → 它是规则叶子，父路径为分组。
    if (current.group !== '') {
      const docPath = join(current.path, 'SKILL.md')
      try {
        const st = await lstat(docPath)
        if (st.isFile() && !st.isSymbolicLink()) {
          const sepIdx = current.group.lastIndexOf('/')
          const parentGroup = sepIdx >= 0 ? current.group.slice(0, sepIdx) : ''
          const name = sepIdx >= 0 ? current.group.slice(sepIdx + 1) : current.group
          const id = parentGroup ? `${parentGroup}/${name}` : name
          addEntry({ id, group: parentGroup, name, kind: 'bundle', docPath, entryPath: current.path })
          continue
        }
      } catch {
        /* 无 SKILL.md → 作为分组继续 */
      }
    }
    if (current.group !== '') groups.add(current.group)

    dirents.sort((a, b) => a.name.localeCompare(b.name))
    const ancestors = new Set(current.ancestors).add(identity(realDirectory))
    for (const item of dirents) {
      if (item.name.startsWith('.')) continue // 隐藏目录/文件跳过
      const path = join(current.path, item.name)
      try {
        const st = await lstat(path)
        if (st.isDirectory() || st.isSymbolicLink()) {
          if (st.isSymbolicLink() && !(await statDirIsDirectory(path))) continue
          if (!isValidGroupSegment(item.name)) {
            warnings.push(`跳过非法分组目录：${current.group ? current.group + '/' : ''}${item.name}`)
            continue
          }
          if (current.depth >= MAX_SOURCE_DEPTH || queue.length >= MAX_DIRECTORIES) {
            truncated = true
            continue
          }
          queue.push({
            path,
            group: current.group ? `${current.group}/${item.name}` : item.name,
            depth: current.depth + 1,
            ancestors,
          })
          continue
        }
        if (!st.isFile()) continue
        if (!item.name.toLowerCase().endsWith('.md')) continue // 只认 .md
        const name = item.name.slice(0, -3)
        const id = current.group ? `${current.group}/${name}` : name
        addEntry({ id, group: current.group, name, kind: 'flat', docPath: path, entryPath: path })
      } catch {
        /* 来源在扫描期间失效时跳过 */
      }
    }
  }
  return { entries, shadowed, groups, warnings, truncated }
}

/** 符号链接目录：lstat 得链接后，stat 确认为目录才进入（防链接到文件）。 */
async function statDirIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ── 规则解析 + 派生 ────────────────────────────────────────────────────────

/** 派生 description：首个 `#` 标题 → 首个非空行；截断 500 字符。 */
function deriveDescription(body: string): string {
  const text = String(body ?? '').trim()
  if (!text) return ''
  const heading = /^#\s+(.+)$/m.exec(text)
  const raw = heading && heading[1].trim() ? heading[1].trim() : text.split(/\r?\n/, 1)[0].trim()
  return raw.slice(0, MAX_DESCRIPTION_LENGTH)
}

interface DerivedFields {
  name: string
  description: string
  descriptionDerived: boolean
  whenToUse?: string
  globs?: string
  metadata?: unknown
  always: boolean
}

/** 从 frontmatter/正文派生字段（派生只存在于内存投影，不写回文件）。 */
function deriveFromDoc(entry: DiscoveredEntry, doc: ParsedSkillDoc): DerivedFields {
  const declaredName = doc.map.name != null && String(doc.map.name).trim() !== '' ? unquote(String(doc.map.name)).trim() : ''
  const name = declaredName || entry.name
  let description = doc.map.description != null ? unquote(String(doc.map.description)).trim() : ''
  let descriptionDerived = false
  if (description === '') {
    description = deriveDescription(doc.body)
    descriptionDerived = true
  }
  const globs = doc.map.globs != null && String(doc.map.globs).trim() !== '' ? String(doc.map.globs).trim() : undefined
  let whenToUse: string | undefined
  if (doc.map.whenToUse != null && String(doc.map.whenToUse).trim() !== '') {
    whenToUse = String(doc.map.whenToUse).trim()
  } else if (globs) {
    whenToUse = `适用路径：${globs}`
  }
  const alwaysRaw = doc.map.always
  const always = alwaysRaw == null || String(alwaysRaw).trim() === '' ? false : (parseBoolValue(String(alwaysRaw)) ?? false)
  const metadata = doc.map.metadata !== undefined ? doc.map.metadata : undefined
  return { name, description, descriptionDerived, whenToUse, globs, metadata, always }
}

/** 合并索引字段（enabled/always/order 等以索引为准；无记录走默认投影）。 */
function projectRule(entry: DiscoveredEntry, derived: DerivedFields, idxEntry: RuleIndexEntry | undefined): Rule {
  const rule: Rule = {
    id: entry.id,
    group: entry.group,
    name: derived.name,
    form: entry.kind,
    path: entry.docPath,
    description: derived.description,
    ...(derived.descriptionDerived ? { descriptionDerived: true } : {}),
    ...(derived.whenToUse !== undefined ? { whenToUse: derived.whenToUse } : {}),
    ...(derived.globs !== undefined ? { globs: derived.globs } : {}),
    ...(derived.metadata !== undefined ? { metadata: derived.metadata } : {}),
    always: idxEntry?.always ?? false,
    enabled: idxEntry?.enabled ?? true,
    order: idxEntry?.order ?? DEFAULT_ORDER,
    tags: Array.isArray(idxEntry?.tags) ? (idxEntry!.tags as string[]) : [],
    pinned: idxEntry?.pinned === true,
    note: typeof idxEntry?.note === 'string' ? idxEntry.note : '',
    ...(typeof idxEntry?.updatedAt === 'string' ? { updatedAt: idxEntry.updatedAt } : {}),
  }
  return rule
}

// ── 侧车文件（索引 / 场景）─────────────────────────────────────────────────

const defaultIndex = (): RulesIndex => ({ version: INDEX_VERSION, rules: {}, groups: {} })

async function readIndex(stateDir: string): Promise<RulesIndex> {
  try {
    const raw = await readFile(join(stateDir, 'rules-index.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<RulesIndex>
    if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.rules !== 'object' || parsed.rules === null) throw new Error('bad index')
    return {
      version: INDEX_VERSION,
      rules: (parsed.rules || {}) as Record<string, RuleIndexEntry>,
      groups: (parsed.groups || {}) as Record<string, GroupIndexEntry>,
    }
  } catch {
    return defaultIndex()
  }
}

async function writeIndex(stateDir: string, index: RulesIndex): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFileAtomically(join(stateDir, 'rules-index.json'), JSON.stringify(index, null, 2))
}

const defaultScenes = (): ScenesFile => ({ version: SCENES_VERSION, includeSharedDefault: true, presets: {} })

async function readScenes(stateDir: string): Promise<ScenesFile> {
  try {
    const raw = await readFile(join(stateDir, 'scenes.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ScenesFile>
    if (!parsed || parsed.version !== SCENES_VERSION || typeof parsed.presets !== 'object' || parsed.presets === null) throw new Error('bad scenes')
    return {
      version: SCENES_VERSION,
      includeSharedDefault: parsed.includeSharedDefault !== false,
      presets: (parsed.presets || {}) as ScenesFile['presets'],
    }
  } catch {
    return defaultScenes()
  }
}

/**
 * 场景解析：agentPreset 命中 → 可见分组 = groups ∪（includeSharedDefault 时 _shared）；
 * 未命中 / 文件缺失或损坏 → 退化 ["_shared"]，不抛错。
 */
function visibleGroupsForPreset(preset: string | undefined, scenes: ScenesFile): string[] {
  if (typeof preset === 'string' && scenes.presets[preset]) {
    const groups = new Set<string>(scenes.presets[preset].groups || [])
    if (scenes.includeSharedDefault) groups.add(SHARED_GROUP)
    return [...groups]
  }
  return [SHARED_GROUP]
}

// ── 快照（发现 + 索引合并 + 索引清理）──────────────────────────────────────

async function buildSnapshot(rulesRoot: string, stateDir: string): Promise<Snapshot> {
  const discovery = await discover(rulesRoot)
  let index = await readIndex(stateDir)
  // 索引有记录但文件已删 → 清理记录（磁盘与索引保持一致）。
  let dirty = false
  for (const id of Object.keys(index.rules)) {
    if (!discovery.entries.has(id)) {
      delete index.rules[id]
      dirty = true
    }
  }
  for (const group of Object.keys(index.groups)) {
    if (!discovery.groups.has(group)) {
      delete index.groups[group]
      dirty = true
    }
  }
  if (dirty) await writeIndex(stateDir, index)

  const rules: Rule[] = []
  const bodies = new Map<string, string>()
  const entries: Map<string, DiscoveredEntry> = new Map()
  for (const entry of discovery.entries.values()) {
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      rules.push(projectRule(entry, derived, index.rules[entry.id]))
      bodies.set(entry.id, doc.body)
      entries.set(entry.id, entry)
    } catch {
      /* 文件在扫描与读取间被删/损坏：跳过该规则 */
    }
  }
  for (const entry of discovery.shadowed) {
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      rules.push({ ...projectRule(entry, derived, undefined), shadowed: true })
      entries.set(entry.id, entry)
    } catch {
      /* 同上 */
    }
  }

  const groups: GroupRow[] = [...discovery.groups]
    .map((name) => {
      const gi = index.groups[name] || {}
      return {
        name,
        label: typeof gi.label === 'string' && gi.label !== '' ? gi.label : name,
        order: gi.order ?? DEFAULT_GROUP_ORDER,
        count: rules.filter((r) => r.group === name && !r.shadowed).length,
      }
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  return { rules, groups, warnings: discovery.warnings, truncated: discovery.truncated, entries, bodies }
}

// ── 创建服务 ───────────────────────────────────────────────────────────────

export function createRulesService(ctx: any, deps: RulesDeps): RulesService {
  // 仅测试注入绝对路径；生产按 $DSH_HOME 解析（与核心技能目录同源）。
  const rulesRoot = deps.rulesRoot && deps.rulesRoot.trim() !== '' ? resolve(deps.rulesRoot) : join(resolveDshHome(), 'rules')
  const stateDir = deps.stateDir && deps.stateDir.trim() !== '' ? resolve(deps.stateDir) : join(resolveDshHome(), 'tool-management')
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes! > 0 ? deps.maxBytes! : DEFAULT_MAX_BYTES

  let snapCache: { at: number; value: Snapshot } | null = null
  const snapshot = async (): Promise<Snapshot> => {
    if (snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.value
    const value = await buildSnapshot(rulesRoot, stateDir)
    snapCache = { at: Date.now(), value }
    return value
  }
  const invalidateSnapshot = (): void => {
    snapCache = null
  }

  const providerInvalidators = new Set<() => void>()
  const invalidateProviders = (): void => {
    for (const invalidate of providerInvalidators) {
      try { invalidate() } catch { /* 单个失效失败不影响其余 */ }
    }
  }

  // ── 写操作串行队列（避免并发覆盖同一索引/文件）──
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  // ── 定位 / 解析 id ──────────────────────────────────────────────────────

  /** id = "<group>/<name>"；group 可含 '/'（多层），根下规则允许 group 为空。 */
  function parseId(id: string): { group: string; name: string } | null {
    if (typeof id !== 'string' || id === '' || id.startsWith('/') || id.endsWith('/')) return null
    const idx = id.lastIndexOf('/')
    const group = idx >= 0 ? id.slice(0, idx) : ''
    const name = idx >= 0 ? id.slice(idx + 1) : id
    if (!name || !KEBAB_RE.test(name)) return null
    if (group && !isValidGroupPath(group)) return null
    return { group, name }
  }

  /** 磁盘定位（bundle 优先）。返回规则文件与条目路径。 */
  async function locateRule(group: string, name: string): Promise<DiscoveredEntry | null> {
    const bundleDir = join(rulesRoot, group, name)
    const bundleDoc = join(bundleDir, 'SKILL.md')
    try {
      const st = await lstat(bundleDoc)
      if (st.isFile() && !st.isSymbolicLink()) {
        return { id: group ? `${group}/${name}` : name, group, name, kind: 'bundle', docPath: bundleDoc, entryPath: bundleDir }
      }
    } catch { /* 非 bundle */ }
    const flatPath = join(rulesRoot, group, name + '.md')
    try {
      const st = await lstat(flatPath)
      if (st.isFile() && !st.isSymbolicLink()) {
        return { id: group ? `${group}/${name}` : name, group, name, kind: 'flat', docPath: flatPath, entryPath: flatPath }
      }
    } catch { /* 非 flat */ }
    return null
  }

  /** 写操作后构建单条投影（不依赖快照，避免全量重扫）。 */
  async function buildProjected(id: string): Promise<Rule | null> {
    const parts = parseId(id)
    if (!parts) return null
    const entry = await locateRule(parts.group, parts.name)
    if (!entry) return null
    try {
      const text = await readFile(entry.docPath, 'utf8')
      const doc = parseSkillDoc(text) as ParsedSkillDoc
      const derived = deriveFromDoc(entry, doc)
      const index = await readIndex(stateDir)
      return projectRule(entry, derived, index.rules[id])
    } catch {
      return null
    }
  }

  // ── 规则文件序列化 ──────────────────────────────────────────────────────

  /** 值含换行用 `|` 块（保留换行）；否则 `key: value` 原样（parseSkillDoc 按行贪婪解析）。 */
  function yamlField(key: string, value: string | boolean): string[] {
    if (typeof value === 'boolean') return [`${key}: ${value}`]
    const s = String(value)
    if (s.includes('\n')) {
      return [`${key}: |`, ...s.split('\n').map((line) => `  ${line}`)]
    }
    return [`${key}: ${s}`]
  }

  function serializeRuleFile(fields: Record<string, string | boolean>, body: string): string {
    const lines: string[] = ['---']
    for (const [key, value] of Object.entries(fields)) lines.push(...yamlField(key, value))
    lines.push('---', '')
    return lines.join('\n') + String(body ?? '')
  }

  /** update 时重建文件：保留 frontmatter 其余字段，仅更新 name/description。 */
  function serializeUpdatedFile(doc: ParsedSkillDoc, newName: string, description: string | undefined | null, body: string): string {
    const fields: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(doc.map)) {
      if (key === 'name' || key === 'description') continue
      fields[key] = String(value)
    }
    fields.name = newName
    if (description === undefined) {
      if (doc.map.description != null && String(doc.map.description).trim() !== '') fields.description = String(doc.map.description)
    } else if (description !== null) {
      fields.description = description
    }
    return serializeRuleFile(fields, body)
  }

  // ── 始终层（预算预检 + 输入）────────────────────────────────────────────

  async function alwaysRuleInputs(): Promise<AlwaysRuleInput[]> {
    const snap = await snapshot()
    const items: AlwaysRuleInput[] = []
    for (const rule of snap.rules) {
      if (!rule.always || !rule.enabled || rule.shadowed) continue
      const body = snap.bodies.get(rule.id)
      if (body === undefined) continue
      items.push({
        id: rule.id,
        group: rule.group,
        order: rule.order,
        name: rule.name,
        description: rule.description,
        body,
      })
    }
    return items.sort(compareAlways)
  }

  /** 预算预检：编译最终始终层集合，超过 maxBytes 拒绝（不写任何文件）。 */
  function checkBudget(items: AlwaysRuleInput[]): { ok: false; error: string; code: string } | null {
    const { bytes } = compileAlwaysProjection(items)
    if (bytes > maxBytes) {
      return fail('error.rules.budgetExceeded', `始终层超出预算（${bytes} 字节 > ${maxBytes} 字节）`)
    }
    return null
  }

  /** 写操作成功后：失效快照 + 通知 provider + 重投影始终层。 */
  const refresh = async (): Promise<void> => {
    invalidateSnapshot()
    invalidateProviders()
    try {
      const result = await writeAlwaysProjection(deps.getGlobalAgentsMdPath, await alwaysRuleInputs(), maxBytes)
      // 预算超限已由写操作预检拦截，此处失败仅是防御性兜底（保留旧 AGENTS.md）。
      void result
    } catch {
      /* 投影失败不阻塞写操作返回 */
    }
  }

  // ── ops：读 ─────────────────────────────────────────────────────────────

  async function rulesList(args: any): Promise<any> {
    const groupFilter = args && typeof args.group === 'string' && args.group !== '' ? args.group : undefined
    const snap = await snapshot()
    const rules = snap.rules
      .filter((r) => !groupFilter || r.group === groupFilter)
      .sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order || a.name.localeCompare(b.name))
    const groups = groupFilter ? snap.groups.filter((g) => g.name === groupFilter) : snap.groups
    return {
      ok: true,
      rules,
      // 对外契约（§7.1）用 key 标识分组；name 保留兼容内部引用。
      groups: groups.map((g) => ({ ...g, key: g.name })),
      stats: {
        total: rules.length,
        always: rules.filter((r) => r.always).length,
        enabled: rules.filter((r) => r.enabled).length,
      },
      ...(snap.warnings.length ? { warnings: snap.warnings } : {}),
    }
  }

  async function rulesRead(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const snap = await snapshot()
    const rule = snap.rules.find((r) => r.id === id && !r.shadowed)
    const entry = snap.entries.get(id)
    if (!rule || !entry) return fail('error.rules.notFound', `规则不存在：${id}`)
    let text = ''
    try {
      text = await readFile(entry.docPath, 'utf8')
    } catch {
      return fail('error.rules.notFound', `规则不存在：${id}`)
    }
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    return {
      ok: true,
      rule: {
        ...rule,
        body: doc.body,
        frontmatter: {
          name: doc.map.name != null ? String(doc.map.name) : undefined,
          description: doc.map.description != null ? String(doc.map.description) : undefined,
          whenToUse: doc.map.whenToUse != null ? String(doc.map.whenToUse) : undefined,
          always: doc.map.always != null ? String(doc.map.always) : undefined,
          globs: doc.map.globs != null ? String(doc.map.globs) : undefined,
          metadata: doc.map.metadata !== undefined ? doc.map.metadata : undefined,
        },
      },
    }
  }

  async function rulesBudget(): Promise<any> {
    const items = await alwaysRuleInputs()
    return {
      ok: true,
      usedBytes: compileAlwaysProjection(items).bytes,
      maxBytes,
      items: items.map((e) => ({ id: e.id, bytes: Buffer.byteLength(`## ${e.description || e.name}\n\n${String(e.body ?? '').trim()}\n`, 'utf8') })),
    }
  }

  /**
   * 规则体检 + 诊断汇总（Phase 3）：逐条规则检查 6 类异常，附始终层预算与场景统计。
   * 只读；结果只用于 UI 展示，不做任何写操作。
   */
  async function rulesDiagnose(): Promise<any> {
    const snap = await snapshot()
    const issues: Array<{ severity: 'error' | 'warning' | 'info'; code: string; ruleId?: string; message: string }> = []
    for (const rule of snap.rules) {
      if (rule.shadowed) {
        issues.push({ severity: 'warning', code: 'shadowed', ruleId: rule.id, message: `规则「${rule.id}」被同名 bundle 遮蔽，不会被加载。` })
      }
      if (String(rule.description || '').length > MAX_DESCRIPTION_LENGTH) {
        issues.push({ severity: 'error', code: 'descriptionTooLong', ruleId: rule.id, message: `规则「${rule.id}」描述超过 ${MAX_DESCRIPTION_LENGTH} 字符，会被 skill 校验丢弃。` })
      }
      if (rule.form === 'flat') {
        const fileBase = basename(rule.path)
        const base = fileBase.toLowerCase().endsWith('.md') ? fileBase.slice(0, -3) : fileBase
        if (base !== rule.name) {
          issues.push({ severity: 'error', code: 'nameMismatch', ruleId: rule.id, message: `规则「${rule.id}」文件名（${fileBase}）与 name（${rule.name}）不一致，无法按 name 定位。` })
        }
      }
      const body = snap.bodies.get(rule.id) || ''
      if (body.trim() === '') {
        issues.push({ severity: 'error', code: 'emptyBody', ruleId: rule.id, message: `规则「${rule.id}」正文为空。` })
      }
      if (rule.descriptionDerived && String(rule.description || '').length < 10) {
        issues.push({ severity: 'info', code: 'vagueDescription', ruleId: rule.id, message: `规则「${rule.id}」描述过于笼统（自动派生，不足 10 字符），建议补充。` })
      }
    }
    // frontmatter 非法：以 --- 开头但解析不出任何字段（残缺 frontmatter）。
    for (const entry of snap.entries.values()) {
      try {
        const text = await readFile(entry.docPath, 'utf8')
        const stripped = String(text || '').replace(/^\uFEFF/, '').trimStart()
        if (stripped.startsWith('---')) {
          const doc = parseSkillDoc(text) as ParsedSkillDoc
          if (Object.keys(doc.map || {}).length === 0) {
            issues.push({ severity: 'warning', code: 'badFrontmatter', ruleId: entry.id, message: `规则「${entry.id}」frontmatter 无法解析（以 --- 开头但无有效字段）。` })
          }
        }
      } catch { /* 读取失败由上面的 emptyBody 兜底 */ }
    }
    const budget = await rulesBudget()
    const scenes = await readScenes(stateDir)
    return {
      ok: true,
      issues,
      budget: { usedBytes: budget.usedBytes, maxBytes: budget.maxBytes, over: budget.maxBytes > 0 && budget.usedBytes > budget.maxBytes },
      counts: { rules: snap.rules.length, groups: snap.groups.length, scenes: Object.keys(scenes.presets || {}).length },
    }
  }

  // ── ops：写（串行队列内）───────────────────────────────────────────────

  async function rulesCreate(args: any): Promise<any> {
    const group = String((args && args.group) || '').trim()
    const name = String((args && args.name) || '').trim()
    const form = args && args.form === 'bundle' ? 'bundle' : 'flat'
    if (!isValidGroupPath(group)) return fail('error.rules.invalidGroup', `分组名非法：${group || '(空)'}（仅允许小写字母、数字、连字符，每段 ≤${MAX_GROUP_SEGMENT_LENGTH}）`)
    if (!KEBAB_RE.test(name)) return fail('error.rules.invalidName', `规则名必须为 kebab-case（小写字母/数字/连字符）：${name}`)
    // 目标已存在（bundle 或 flat 皆算）→ 拒绝，避免静默覆盖。
    const existing = await locateRule(group, name)
    if (existing) {
      return fail('error.rules.shadowed', `同名规则已存在（${existing.kind === 'bundle' ? 'bundle' : 'flat'}）：${group}/${name}`)
    }
    const body = String((args && args.body) ?? '')
    if (body.trim() === '') return fail('error.rules.bodyRequired', '规则正文不能为空')
    if (Buffer.byteLength(body, 'utf8') > MAX_RULE_BYTES) return fail('error.rules.tooLarge', `规则正文过大（超过 ${MAX_RULE_BYTES >> 10} KiB）`)
    let description: string | undefined
    const rawDescription = args && args.description != null ? String(args.description).trim() : ''
    if (rawDescription !== '') {
      if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
        return fail('error.rules.descriptionTooLong', `描述超过 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${rawDescription.length}）`)
      }
      description = rawDescription
    } else {
      const derived = deriveDescription(body)
      if (!derived) return fail('error.rules.descriptionRequired', '请提供规则描述（正文中也无可派生的标题或首行）')
      description = derived // 派生只进内存投影，不写回文件
    }
    const always = args && args.always === true
    if (always) {
      const items = await alwaysRuleInputs()
      items.push({ id: group + '/' + name, group, order: DEFAULT_ORDER, name, description, body })
      const blocked = checkBudget(items)
      if (blocked) return blocked
    }
    // 写文件（frontmatter 仅写用户显式提供的字段；always 以索引为准，不写回）
    const fields: Record<string, string | boolean> = { name }
    if (rawDescription !== '') fields.description = description!
    const text = serializeRuleFile(fields, body)
    if (form === 'bundle') {
      await mkdir(join(rulesRoot, group, name), { recursive: true })
      await writeFileAtomically(join(rulesRoot, group, name, 'SKILL.md'), text)
    } else {
      await mkdir(join(rulesRoot, group), { recursive: true })
      await writeFileAtomically(join(rulesRoot, group, name + '.md'), text)
    }
    // 更新索引（force 重读后合并，避免覆盖用户手工编辑）
    const index = await readIndex(stateDir)
    index.rules[`${group}/${name}`] = { order: DEFAULT_ORDER, always, enabled: true, updatedAt: new Date().toISOString() }
    if (!index.groups[group]) index.groups[group] = { order: DEFAULT_GROUP_ORDER, label: group }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(`${group}/${name}`) }
  }

  async function rulesUpdate(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    let text: string
    try {
      text = await readFile(located.docPath, 'utf8')
    } catch {
      return fail('error.rules.notFound', `规则不存在：${id}`)
    }
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    // flat 形态：frontmatter 声明名必须等于文件名（发现时可列出，更新时校验）。
    const currentName = doc.map.name != null && String(doc.map.name).trim() !== '' ? unquote(String(doc.map.name)).trim() : parts.name
    if (located.kind === 'flat' && currentName !== parts.name) {
      return fail('error.rules.invalidName', `flat 规则名与文件名不一致（frontmatter name: ${currentName}，文件名: ${parts.name}），请先修正规则文件`)
    }
    const newName = args && args.name != null ? String(args.name).trim() : currentName
    if (!KEBAB_RE.test(newName)) return fail('error.rules.invalidName', `规则名必须为 kebab-case：${newName}`)
    const newForm = args && args.form === 'bundle' ? 'bundle' : args && args.form === 'flat' ? 'flat' : located.kind
    const newBody = args && args.body != null ? String(args.body) : doc.body
    if (newBody.trim() === '') return fail('error.rules.bodyRequired', '规则正文不能为空')
    if (Buffer.byteLength(newBody, 'utf8') > MAX_RULE_BYTES) return fail('error.rules.tooLarge', `规则正文过大（超过 ${MAX_RULE_BYTES >> 10} KiB）`)
    // description：显式传 → 校验并写文件；传空串 → 删除字段并从正文派生；未传 → 保留现有（缺失则派生）。
    let description: string | undefined
    if (args && args.description != null) {
      const ds = String(args.description).trim()
      if (ds !== '') {
        if (ds.length > MAX_DESCRIPTION_LENGTH) {
          return fail('error.rules.descriptionTooLong', `描述超过 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${ds.length}）`)
        }
        description = ds
      } else {
        const derived = deriveDescription(newBody)
        if (!derived) return fail('error.rules.descriptionRequired', '请提供规则描述（正文中也无可派生的标题或首行）')
        description = derived // 派生不写回
      }
    } else {
      const existing = doc.map.description != null ? unquote(String(doc.map.description)).trim() : ''
      if (existing !== '') description = existing
      else description = deriveDescription(newBody) || undefined
    }
    // 预算预检：仅当该规则当前始终层生效（always && enabled）时，替换其片段重算。
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id]
    if (idxEntry && idxEntry.always && idxEntry.enabled !== false) {
      const items = (await alwaysRuleInputs()).filter((e) => e.id !== id)
      items.push({ id: `${parts.group}/${newName}`, group: parts.group, order: idxEntry.order ?? DEFAULT_ORDER, name: newName, description: description || '', body: newBody })
      const blocked = checkBudget(items)
      if (blocked) return blocked
    }
    // 形态转换 / 改名：先建新形态文件，再清理旧形态（确保任意失败点不产生半份规则）。
    // description 写回约定：显式传 → string/null（删除）；未传 → undefined（保留原字段）。
    const serialize = (): string => {
      let descArg: string | undefined | null
      if (args && args.description != null) descArg = String(args.description).trim() === '' ? null : description
      else descArg = undefined
      return serializeUpdatedFile(doc, newName, descArg, newBody)
    }
    if (located.kind === 'bundle' && newForm === 'flat') {
      await mkdir(join(rulesRoot, parts.group), { recursive: true })
      await writeFileAtomically(join(rulesRoot, parts.group, newName + '.md'), serialize())
      await rm(located.entryPath, { recursive: true, force: true })
    } else if (located.kind === 'flat' && newForm === 'bundle') {
      await mkdir(join(rulesRoot, parts.group, newName), { recursive: true })
      await writeFileAtomically(join(rulesRoot, parts.group, newName, 'SKILL.md'), serialize())
      await rm(join(rulesRoot, parts.group, parts.name + '.md'), { force: true })
    } else if (located.kind === 'flat' && newName !== parts.name) {
      // flat 改名 = 文件改名
      await writeFileAtomically(join(rulesRoot, parts.group, newName + '.md'), serialize())
      await rm(join(rulesRoot, parts.group, parts.name + '.md'), { force: true })
    } else {
      // bundle 不 rename 目录：只更新 frontmatter/正文
      await writeFileAtomically(located.docPath, serialize())
    }
    // 索引：改名则迁移记录（保留 order/tags/always/enabled 等），否则原地更新。
    const newId = `${parts.group}/${newName}`
    if (newId !== id && index.rules[id]) {
      index.rules[newId] = { ...index.rules[id], updatedAt: new Date().toISOString() }
      delete index.rules[id]
    } else {
      index.rules[id] = { ...(index.rules[id] || {}), updatedAt: new Date().toISOString() }
    }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(newId) }
  }

  async function rulesRemove(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    const trashId = Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
    const trashDir = join(stateDir, 'rules-trash', trashId)
    const manifest = { group: parts.group, name: parts.name, form: located.kind, deletedAt: new Date().toISOString() }
    await mkdir(trashDir, { recursive: true })
    if (located.kind === 'bundle') {
      const { cp } = await import('node:fs/promises')
      await cp(located.entryPath, join(trashDir, 'bundle'), { recursive: true })
      await rm(located.entryPath, { recursive: true, force: true })
    } else {
      await copyFile(located.docPath, join(trashDir, 'rule.md'))
      await rm(located.docPath, { force: true })
    }
    await writeFileAtomically(join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const index = await readIndex(stateDir)
    delete index.rules[id]
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, trashId }
  }

  async function rulesRestore(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    const trashDir = join(stateDir, 'rules-trash', trashId)
    let manifest: { group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string }
    try {
      manifest = JSON.parse(await readFile(join(trashDir, 'manifest.json'), 'utf8')) as typeof manifest
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.group !== 'string' || !KEBAB_RE.test(manifest.name)) {
      return fail('error.rules.notFound', `回收站条目损坏：${trashId}`)
    }
    // 恢复目标已存在（期间用户重建了同名规则）→ 拒绝，避免覆盖。
    const conflict = await locateRule(manifest.group, manifest.name)
    if (conflict) {
      return fail('error.rules.shadowed', `同名规则已存在：${manifest.group}/${manifest.name}，请先移除后再恢复`)
    }
    const form = manifest.form === 'bundle' ? 'bundle' : 'flat'
    if (form === 'bundle') {
      await mkdir(join(rulesRoot, manifest.group), { recursive: true })
      const { cp } = await import('node:fs/promises')
      await cp(join(trashDir, 'bundle'), join(rulesRoot, manifest.group, manifest.name), { recursive: true })
    } else {
      await mkdir(join(rulesRoot, manifest.group), { recursive: true })
      await copyFile(join(trashDir, 'rule.md'), join(rulesRoot, manifest.group, manifest.name + '.md'))
    }
    await rm(trashDir, { recursive: true, force: true })
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(manifest.group ? `${manifest.group}/${manifest.name}` : manifest.name) }
  }

  async function rulesToggle(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const enabled = args && args.enabled !== undefined ? args.enabled === true : (idxEntry.enabled ?? true)
    const always = args && args.always !== undefined ? args.always === true : (idxEntry.always ?? false)
    // 变更后进入始终层 → 预算预检。
    if (always && enabled && !(idxEntry.always && idxEntry.enabled !== false)) {
      const rule = await buildProjected(id)
      if (rule) {
        const located = await locateRule(parts.group, parts.name)
        const body = located ? await readFile(located.docPath, 'utf8').catch(() => '') : ''
        const doc = parseSkillDoc(body) as ParsedSkillDoc
        const items = (await alwaysRuleInputs()).filter((e) => e.id !== id)
        items.push({ id, group: rule.group, order: idxEntry.order ?? DEFAULT_ORDER, name: rule.name, description: rule.description, body: doc.body })
        const blocked = checkBudget(items)
        if (blocked) return blocked
      }
    }
    index.rules[id] = { ...idxEntry, enabled, always, updatedAt: new Date().toISOString() }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(id) }
  }

  async function rulesSetIndex(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const next: RuleIndexEntry = { ...idxEntry, updatedAt: new Date().toISOString() }
    if (args && args.order !== undefined) {
      const order = Number(args.order)
      if (!Number.isFinite(order) || order < 0) return fail('error.rules.invalidGroup', `非法排序值：${args.order}`)
      next.order = Math.floor(order)
    }
    if (args && args.tags !== undefined) {
      next.tags = Array.isArray(args.tags) ? args.tags.map((t: unknown) => String(t)) : []
    }
    if (args && args.pinned !== undefined) next.pinned = args.pinned === true
    if (args && args.note !== undefined) next.note = String(args.note)
    index.rules[id] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(id) }
  }

  // ── provider 投影 ────────────────────────────────────────────────────────

  /** 可见分组内 enabled 规则的 skill 目录条目投影（name/description 均取派生后值）。 */
  async function listProjected(preset?: string): Promise<Array<{ name: string; description: string }>> {
    const scenes = await readScenes(stateDir)
    const visible = new Set(visibleGroupsForPreset(preset, scenes))
    const snap = await snapshot()
    return snap.rules
      .filter((r) => !r.shadowed && r.enabled && visible.has(r.group))
      .sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order || a.name.localeCompare(b.name))
      .map((r) => ({ name: r.name, description: r.description }))
  }

  async function getProjected(candidate: any): Promise<any> {
    const name = candidate && candidate.name
    if (typeof name !== 'string') return undefined
    const snap = await snapshot()
    const rule = snap.rules.find((r) => !r.shadowed && r.enabled && r.name === name)
    if (!rule) return undefined
    const body = snap.bodies.get(rule.id)
    if (body === undefined) return undefined
    return { name: rule.name, description: rule.description, content: body.trim() }
  }

  // ── 组装 ─────────────────────────────────────────────────────────────────

  const registerProviders = (): (() => void) => {
    try {
      return createRuleProviderRegistrar(ctx, {
        invalidate: invalidateProviders,
        list: listProjected,
        get: getProjected,
      })
    } catch (e) {
      console.error('[dsh-plugin-tool-management] rules provider setup failed:', message(e))
      return () => {}
    }
  }

  /** 写操作：串行队列内执行，成功后触发 refresh（失效缓存 + 重投影始终层）。 */
  const runWrite = (task: () => Promise<any>) =>
    enqueueMutation(async () => {
      const result = await task()
      if (result && result.ok !== false) await refresh()
      return result
    })

  const ops: Record<string, (args: any) => Promise<any>> = {
    'rules-list': (args) => rulesList(args || {}),
    'rules-read': (args) => rulesRead(args || {}),
    'rules-budget': () => rulesBudget(),
    'rules-diagnose': () => rulesDiagnose(),
    'rules-create': (args) => runWrite(() => rulesCreate(args || {})),
    'rules-update': (args) => runWrite(() => rulesUpdate(args || {})),
    'rules-remove': (args) => runWrite(() => rulesRemove(args || {})),
    'rules-restore': (args) => runWrite(() => rulesRestore(args || {})),
    'rules-toggle': (args) => runWrite(() => rulesToggle(args || {})),
    'rules-set-index': (args) => runWrite(() => rulesSetIndex(args || {})),
  }

  const service: RulesService = {
    ops,
    registerProviders,
    refresh,
    _invalidate: invalidateProviders,
    _listProjected: listProjected,
    _getProjected: getProjected,
  }
  return service
}
