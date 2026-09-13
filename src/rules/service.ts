// dsh-plugin-tool-management —— 规则/记忆（Rules v0.3，见 CHANGE-REQUEST-01）服务层。
//
// 记忆 = $DSH_HOME/tool-management/memories/<场景>/<name>.md（flat）或 <场景>/<name>/SKILL.md（bundle）。
// **场景是显式记录**：$DSH_HOME/tool-management/scenes/<场景>.json（见 SceneRecord），
// 不再是「memories/ 下恰好有这个名字的目录」这种隐式约定——空场景因此可以存在，
// 且场景可以有描述。目录名即场景名（任意 Unicode，见 isValidGroupSegment）。
// 保留场景 `global`（界面显示「全局」）：其记忆注入任何对话；它恒定存在、不可删除。
// 勾选启用后，该目录树内所有 .md 的正文自动进入系统提示词（provider.ts 注册的
// per-agent systemPrompt 段），模型无需做任何动作 —— 这就是"不用每次都要解释"。
//
// 单投影（原 ADR-4 的"双投影"已被本变更单修订）：
//   - 活动场景记忆 → systemPrompt 段（自动在场，会话级恒定 → 前缀稳定、缓存可命中）
//   - `_shared/` 承担"恒常"语义（所有场景共用）；原 per-rule `always` 标志已移除
//   - 不再写 ~/.dsh/AGENTS.md（原始终层投影下线）
//
// 状态分层（两份文件各司其职，互不写回）：
//   - 规则文件：正文真源。frontmatter 可声明 name/description/whenToUse/globs/metadata。
//   - rules-index.json：启停/排序/标签/启用场景集合等**索引为准**字段（不写回记忆文件）。
//
// 发现必须自实现（不复用 readonly-discovery）：可写来源只扫一层会压扁子目录场景，
// 而规则的目录树天然是多层的；且 readonly-discovery 的 flat 只认顶层。
//
// 缓存红线（§5.2）：段内容只由「启用场景 + 文件内容」决定，禁止时间戳/计数/相对时间；
// 场景组合或记忆文件不变 ⇒ 逐字节稳定 ⇒ 前缀缓存命中。切换场景/编辑记忆只变化一次。
//
// 错误约定：业务校验失败返回 { ok:false, error: 中文, code, params? }（与 skills core 一致）；
// ops 成功返回扁平 { ok:true, ... }，不套 { ok:true, data }。

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseSkillDoc, resolveDshHome, unquote } from '../skills/core.js'
import { expandUploads, planMemoryImport } from '../imports/upload.js'
import { createRuleProviderRegistrar } from './provider.js'
import { normalizeArchive, type ModeState, type SceneArchive } from './archive.js'

// ── 常量 ───────────────────────────────────────────────────────────────────

const MAX_SOURCE_DEPTH = 64          // 与 core.js 一致
const MAX_DIRECTORIES = 2000         // 目录预算
const MAX_ENTRIES = 20000            // 条目预算
const MAX_GROUP_SEGMENT_LENGTH = 64  // 场景/子目录段名长度上限
const MAX_DESCRIPTION_LENGTH = 500   // 派生/显式描述上限（派生超长截断，显式超长拒绝）
const MAX_RULE_BYTES = 1 << 18       // 正文上限 256 KiB
const DEFAULT_ORDER = 1000           // 默认投影 order（索引无记录时）
const DEFAULT_GROUP_ORDER = 1000     // 新场景默认 order
const SNAPSHOT_TTL_MS = 1000         // 读路径短 TTL 缓存，吸收 UI 密集轮询
const DEFAULT_MAX_BYTES = 65536      // 场景记忆段预算上限（字节）
const TRUNCATION_MARKER = '<!-- truncated -->'
const DROPPED_HEADING = '## 场景记忆：未注入（超出预算）' // 段尾清单：让模型知道自己漏了什么
// bundle 附件限制（body 走 HTTP JSON + base64，故比技能上传收紧一档）。
const MAX_ATTACH_ENTRY_BYTES = 8 << 20 // 单个附件 8 MiB
const MAX_ATTACH_TOTAL_BYTES = 16 << 20 // 单次总大小 16 MiB
const MAX_ATTACH_ENTRIES = 32 // 单次最多 32 个
const BUNDLE_DOC = 'SKILL.md' // bundle 的正文文件（附件列表里排除）
const SHARED_GROUP = '_shared'       // 保留场景名：公共基线（历史语义，仍可使用）
const INDEX_VERSION = 1

// 场景/子目录段名约束（§4 对照表 + §5.3）：任意 Unicode，但必须对文件系统安全。
//   - 非空、长度 ≤64、不等于 `.` / `..`、不以 `.` 开头（隐藏目录语义冲突）
//   - 不含路径分隔符 `/` `\`，不含 Windows 保留字符 `< > : " | ? *`
//   - 首尾无空白、末尾不是 `.` 或空格（Windows 会静默裁剪，导致路径与显示名不一致）
const WINDOWS_RESERVED_RE = /[<>:"|?*\\/]/

/** 单个路径段（场景名或子目录名）是否合法。放宽后 `办公` / `日常` 均通过。 */
export function isValidGroupSegment(segment: string): boolean {
  if (typeof segment !== 'string') return false
  if (segment === '' || segment === '.' || segment === '..') return false
  if (segment.length > MAX_GROUP_SEGMENT_LENGTH) return false
  if (segment.startsWith('.')) return false
  if (WINDOWS_RESERVED_RE.test(segment)) return false
  if (segment !== segment.trim()) return false
  if (/[.\s]$/.test(segment)) return false
  return true
}

/** group/场景路径可多层（a/b/c），每段必须合法；_shared 作为保留场景名放行。 */
export function isValidGroupPath(group: string): boolean {
  if (typeof group !== 'string' || group === '' || group.startsWith('/') || group.endsWith('/')) return false
  return group.split('/').every(isValidGroupSegment)
}

const message = (e: unknown): string => String((e && (e as Error).message) || e)
const fail = (code: string, error: string, params?: Record<string, string | number>): { ok: false; error: string; code: string; params?: Record<string, string | number> } => (
  params ? { ok: false, error, code, params } : { ok: false, error, code }
)
const identity = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * 场景/记忆根目录名（$DSH_HOME 下），集中在 `tool-management/` 一个目录内：
 *   - `scenes/<场景>.json`   场景记录（名称/描述/顺序）
 *   - `memories/<场景>/…`    记忆正文真源
 *   - `..`（即 tool-management 根）侧车：rules-index.json / config.json / trash/
 *
 * 历史位置 `$DSH_HOME/scene-memory/` 由 `relocateLegacyLayout()` 在首次读写前搬入。
 */
export const HUB_DIR = 'tool-management'
export const SCENES_DIR = 'scenes'
export const MEMORIES_DIR = 'memories'

/** 保留场景名：界面显示「全局」，恒定存在、不可删除，其记忆注入任何对话。 */
export const GLOBAL_SCENE = 'global'
/** 保留场景在界面上的显示名（磁盘上仍用 ASCII 目录/文件名）。 */
export const GLOBAL_SCENE_LABEL = '全局'

// ── 对外接口 ───────────────────────────────────────────────────────────────

export interface RulesDeps {
  /** 记忆根目录（绝对路径；空串/未提供时按 $DSH_HOME/tool-management/memories 解析）。 */
  rulesRoot: string
  /** 侧车目录（索引/回收站；空串/未提供时按 $DSH_HOME/tool-management 解析）。 */
  stateDir: string
  /** 场景记录目录（绝对路径；空串/未提供时按 <stateDir>/scenes 解析）。 */
  scenesDir?: string
  /** 场景记忆段预算上限（字节），默认 65536。 */
  maxBytes?: number
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

/** 场景 = 记忆的一级归属；`global` 为保留的「全局」场景。 */
export interface SceneRow {
  name: string
  label: string
  order: number
  /** 该场景目录树内的记忆条数（不含被遮蔽条目）。 */
  count: number
  /** 是否参与系统提示词注入（`_shared` 与 `global` 恒为 true）。 */
  active: boolean
  /** `_shared`：公共基线，UI 上锁定为常开。 */
  shared: boolean
  /** 保留场景 `global`（界面「全局」）：不可删除、不可停用。 */
  global: boolean
  /** 场景描述（用户在「新建/编辑场景」里填的一句话）。 */
  description: string
}

/** 场景记忆段的一次渲染结果（纯函数产物，确定性：无时间戳/计数）。 */
export interface SceneMemoryProjection {
  text: string
  bytes: number
  truncated: boolean
  maxBytes: number
  /** 参与渲染的场景（确定性顺序，含 `_shared` 与全局 `''`）。 */
  scenes: string[]
  items: Array<{ id: string; scene: string; name: string; bytes: number }>
  /** 因超出预算**未**注入的记忆（确定性顺序；段尾也会列出它们，模型与用户都能看见）。 */
  dropped: Array<{ id: string; scene: string; name: string; bytes: number }>
}

export interface RulesService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /** 注册全局 + agent-scope 的 systemPrompt 段；返回清理函数（配合 ctx.effect）。 */
  registerProviders: () => () => void
  /** 失效快照与场景记忆缓存（写操作后调用）。 */
  refresh: () => Promise<void>
  /** 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内执行，非公开 op，无门禁面）。 */
  patchIndex: (patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null }) => Promise<void>
  /** 场景档案引擎专用：读 mode/archives/active 切片。 */
  readArchiveSlice: () => Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }>
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
  /** memories/ 下的一级目录（= 场景名，含保留场景 global；不含只有记录没有目录的场景）。 */
  scenes: string[]
  warnings: string[]
  truncated: boolean
  entries: Map<string, DiscoveredEntry>
  bodies: Map<string, string>
}

interface RulesIndex {
  version: 1
  rules: Record<string, RuleIndexEntry>
  groups: Record<string, GroupIndexEntry>
  /** 场景记录（`scenes/<名>.json` 的镜像，索引为准）：名称 → 描述/顺序/创建时间。 */
  scenes?: Record<string, SceneIndexEntry>
  /** 启用场景集合；`null` / 缺失 = 全部场景启用（默认，保证"丢进去就有用"）。 */
  active?: string[] | null
  /** 场景档案（设计 §2.1）：每场景可选的 tools/skills/subagents 勾选集，键存在性独立于集合空否。 */
  archives?: Record<string, SceneArchive>
  /** 当前模式（设计 §2.2）：至多一个场景的档案生效；snapshot = 进入时的运行时启停，退出恢复。 */
  mode?: ModeState
}

/** 一条场景记录（`scenes/<名>.json` 的真源，索引里存镜像）。 */
export interface SceneRecord {
  /** 场景名（= 目录/文件名；`global` 为保留场景）。 */
  name: string
  /** 界面显示名；缺省用 name（保留场景显示「全局」）。 */
  label?: string
  /** 一句话说明这个场景是干什么的（界面卡片副标题）。 */
  description?: string
  order?: number
  /** ISO 时间戳；只要**创建**时间，不参与提示词段（段必须逐字节稳定）。 */
  createdAt?: string
}

/** 索引里的场景镜像条目。 */
interface SceneIndexEntry {
  label?: string
  description?: string
  order?: number
  createdAt?: string
}

interface RuleIndexEntry {
  order?: number
  tags?: string[]
  pinned?: boolean
  enabled?: boolean
  note?: string
  updatedAt?: string
}

interface GroupIndexEntry {
  order?: number
  label?: string
}

/** 同步扫描得到的单条场景记忆（供 systemPrompt 段渲染）。 */
interface SceneMemoryFile {
  id: string
  /** 一级目录名；`''` = 规则根目录下的全局记忆，`_shared` = 公共基线。 */
  scene: string
  name: string
  description: string
  descriptionDerived: boolean
  order: number
  body: string
}

/** 段渲染的候选块：一个「场景标题 + 一条记忆正文」的可选单元。 */
interface SceneBlockCandidate {
  /** 全局确定性序号（候选顺序 = 场景顺序 → 场景内 order/名称）。 */
  seq: number
  scene: string
  header: string
  block: string
  item: { id: string; scene: string; name: string; bytes: number }
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

/** 二进制版原子写（附件用）：临时文件 + rename，失败清理临时文件。 */
async function writeFileAtomicBinary(path: string, data: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

// ── 递归发现 ───────────────────────────────────────────────────────────────

/**
 * BFS 发现（realpath 防环、深度/目录/条目预算），与 readonly-discovery 同构，
 * 但规则的场景是**多层相对路径**（readonly-discovery 的 group 恒为第一层）。
 *
 * 目录语义：目录含 SKILL.md → 它是 bundle 规则（叶子，不再深入），其「父路径」
 * 是场景、目录名是规则名；否则它是场景/子分类，继续遍历其下 .md（flat，任意层级）
 * 与子目录。同名 flat 与 bundle 冲突时 bundle 优先，flat 记入 shadowed。
 */
async function discover(rulesRoot: string): Promise<{ entries: Map<string, DiscoveredEntry>; shadowed: DiscoveredEntry[]; groups: Set<string>; scenes: string[]; warnings: string[]; truncated: boolean }> {
  const entries = new Map<string, DiscoveredEntry>()
  const shadowed: DiscoveredEntry[] = []
  const groups = new Set<string>()
  const scenes: string[] = []
  const warnings: string[] = []
  const rootPath = resolve(rulesRoot)
  try {
    const st = await lstat(rootPath)
    if (!st.isDirectory() || st.isSymbolicLink()) return { entries, shadowed, groups, scenes, warnings, truncated: false }
  } catch {
    return { entries, shadowed, groups, scenes, warnings, truncated: false }
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

    // bundle 检查：当前目录（非根）含 SKILL.md → 它是规则叶子，父路径为场景。
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
        /* 无 SKILL.md → 作为场景/子分类继续 */
      }
    }
    if (current.group !== '') {
      groups.add(current.group)
      // 一级目录 = 场景名（多段场景名用 '/' 连接，见 isValidGroupPath）。
      if (current.depth === 1) scenes.push(current.group)
    }

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
            warnings.push(`跳过非法目录名（含路径分隔符 / Windows 保留字符 / 首尾空白或点，或超过 ${MAX_GROUP_SEGMENT_LENGTH} 字符）：${current.group ? current.group + '/' : ''}${item.name}`)
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
  return { entries, shadowed, groups, scenes, warnings, truncated }
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
  const metadata = doc.map.metadata !== undefined ? doc.map.metadata : undefined
  return { name, description, descriptionDerived, whenToUse, globs, metadata }
}

/** 合并索引字段（enabled/order 等以索引为准；无记录走默认投影）。 */
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

const defaultIndex = (): RulesIndex => ({ version: INDEX_VERSION, rules: {}, groups: {}, scenes: {}, active: null, archives: {}, mode: { scene: null, snapshot: null } })

/** 场景镜像条目归一化：只保留已知字段，非法值丢弃（容忍脏数据）。 */
function parseSceneEntry(raw: unknown): SceneIndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const out: SceneIndexEntry = {}
  if (typeof obj.label === 'string' && obj.label.trim() !== '') out.label = obj.label
  if (typeof obj.description === 'string' && obj.description !== '') out.description = obj.description
  if (typeof obj.order === 'number' && Number.isFinite(obj.order)) out.order = obj.order
  if (typeof obj.createdAt === 'string' && obj.createdAt !== '') out.createdAt = obj.createdAt
  return out
}

function parseScenes(raw: unknown): Record<string, SceneIndexEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SceneIndexEntry> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidGroupPath(name)) continue
    const entry = parseSceneEntry(value)
    if (entry) out[name] = entry
  }
  return out
}

/** 档案切片归一化：未知形态 → 空对象（容忍脏数据，与 §9.3 同哲学）。 */
function parseArchives(raw: unknown): Record<string, SceneArchive> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SceneArchive> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const archive = normalizeArchive(value)
    if (Object.keys(archive).length) out[name] = archive
  }
  return out
}

function parseModeState(raw: unknown): ModeState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const scene = typeof obj.scene === 'string' && obj.scene.trim() !== '' ? obj.scene : null
  const snapshotRaw = (obj.snapshot && typeof obj.snapshot === 'object' ? obj.snapshot : {}) as Record<string, unknown>
  const toFlagMap = (v: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (typeof b === 'boolean') out[k] = b
    }
    return out
  }
  // v2 快照：mcp = 停用表原文（serverName → ['*'] / 工具名）；skills = 启停布尔表。
  const mcp: Record<string, string[]> = {}
  const mcpRaw = snapshotRaw.mcp
  if (mcpRaw && typeof mcpRaw === 'object' && !Array.isArray(mcpRaw)) {
    for (const [server, list] of Object.entries(mcpRaw as Record<string, unknown>)) {
      if (Array.isArray(list)) mcp[server] = list.map((x) => String(x))
    }
  } else if (snapshotRaw.tools && typeof snapshotRaw.tools === 'object' && !Array.isArray(snapshotRaw.tools)) {
    // v1 快照兼容（升级前数据）：tools = 布尔启停表（key = `<server>/<tool>`，false = 停用）
    // → 折算成 v2 的停用名单；否则退出模式会把「快照启停」错误还原成「全部启用」。
    for (const [key, on] of Object.entries(snapshotRaw.tools as Record<string, unknown>)) {
      if (on !== false) continue
      const i = key.indexOf('/')
      if (i <= 0 || i === key.length - 1) continue
      const server = key.slice(0, i)
      const tool = key.slice(i + 1)
      const list = mcp[server] || (mcp[server] = [])
      if (list.indexOf(tool) < 0) list.push(tool)
    }
  }
  return {
    scene,
    snapshot: scene ? { mcp, skills: toFlagMap(snapshotRaw.skills) } : null,
  }
}

/** 解析 rules-index.json 原文；任何异常/版本不符 → 默认索引（容忍缺失，§9.3）。 */
function parseIndex(raw: string): RulesIndex {
  const parsed = JSON.parse(raw) as Partial<RulesIndex>
  if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.rules !== 'object' || parsed.rules === null) throw new Error('bad index')
  return {
    version: INDEX_VERSION,
    rules: (parsed.rules || {}) as Record<string, RuleIndexEntry>,
    groups: (parsed.groups || {}) as Record<string, GroupIndexEntry>,
    scenes: parseScenes((parsed as Record<string, unknown>).scenes),
    active: normalizeActive(parsed.active),
    archives: parseArchives((parsed as Record<string, unknown>).archives),
    mode: parseModeState((parsed as Record<string, unknown>).mode),
  }
}

async function readIndex(stateDir: string): Promise<RulesIndex> {
  try {
    return parseIndex(await readFile(join(stateDir, 'rules-index.json'), 'utf8'))
  } catch {
    return defaultIndex()
  }
}

/** 同步读索引：systemPrompt 段的渲染路径不能 await（见文件内「两相扫描」注释）。 */
function readIndexSync(stateDir: string): RulesIndex {
  const raw = readFileIfExistsSync(join(stateDir, 'rules-index.json'))
  if (raw === null) return defaultIndex()
  try {
    return parseIndex(raw)
  } catch {
    return defaultIndex()
  }
}

async function writeIndex(stateDir: string, index: RulesIndex): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFileAtomically(join(stateDir, 'rules-index.json'), JSON.stringify(index, null, 2))
}

// ── 场景记录（索引内，`rules-index.json` 的 scenes 切片）+ 旧布局迁移 ────────

/** 索引条目 → 场景记录（供 UI 直接渲染）。 */
function sceneRecordOf(name: string, entry: SceneIndexEntry | undefined): SceneRecord {
  const e = entry || {}
  return {
    name,
    ...(name === GLOBAL_SCENE ? { label: e.label || GLOBAL_SCENE_LABEL } : (e.label ? { label: e.label } : {})),
    ...(e.description ? { description: e.description } : {}),
    order: e.order ?? (name === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
  }
}

/** 路径是否存在（不跟随符号链接；用于迁移前置判断）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** 把旧布局搬进 `tool-management/`（每个进程只尝试一次，幂等）。
 *
 *   旧：$DSH_HOME/scene-memory/<root>.md        → memories/global/<root>.md
 *       $DSH_HOME/scene-memory/<scene>/…        → memories/<scene>/…
 *       （场景记录由索引镜像补齐，见 ensureSceneRecords）
 *   更旧：$DSH_HOME/rules/…（v0.3 之前）同样按上面两条处理。
 *
 * 搬移用 `rename`（同卷零拷贝）；跨卷（EXDEV）退化为 `cp` + `rm`。
 * 源目录**保留**（内容已搬走，留空壳不影响正确性，也方便用户核对）。
 * 目标已存在同名项 → 保留目标、跳过该项（绝不覆盖新数据）。
 */
async function relocateLegacyLayout(memoriesRoot: string): Promise<void> {
  const home = resolveDshHome()
  const legacyRoots = [join(home, 'scene-memory'), join(home, 'rules')]
  for (const legacyRoot of legacyRoots) {
    if (!(await pathExists(legacyRoot))) continue
    if (identity(resolve(legacyRoot)) === identity(resolve(memoriesRoot))) continue // 自定义 roots 落在旧路径 → 不自我搬移
    let items: import('node:fs').Dirent[]
    try {
      items = await readdir(legacyRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const src = join(legacyRoot, item.name)
      // 根层 .md = 旧的「全局」桶 → 搬进 `global/`，文件名保留（否则多套一层目录）。
      // 其余条目（场景目录）整体搬进 memories/，目录名保留。
      const isRootMd = item.isFile() && item.name.toLowerCase().endsWith('.md')
      const destDir = isRootMd ? join(memoriesRoot, GLOBAL_SCENE) : memoriesRoot
      const dest = join(destDir, item.name)
      try {
        if (await pathExists(dest)) continue
        await mkdir(destDir, { recursive: true })
        try {
          await rename(src, dest)
        } catch {
          // 跨设备/被占用 → 复制后删源；复制失败则保留源文件（宁可重复，不可丢失）。
          await cp(src, dest, { recursive: true })
          await rm(src, { recursive: true, force: true })
        }
      } catch {
        /* 单项失败不阻断其余项（如文件被外部程序锁住，下次启动再试） */
      }
    }
  }
}

/** 确保保留场景 `global` 的记录存在；旧数据里的场景名补一条记录。 */
function ensureSceneRecords(index: RulesIndex, probeScenes: string[]): boolean {
  if (!index.scenes) index.scenes = {}
  let dirty = false
  if (!index.scenes[GLOBAL_SCENE]) {
    index.scenes[GLOBAL_SCENE] = { label: GLOBAL_SCENE_LABEL, order: 0 }
    dirty = true
  }
  // 有目录但没记录（旧布局搬进来的、或用户手工建的目录）→ 补记录，label 用目录名。
  for (const name of probeScenes) {
    if (index.scenes[name]) continue
    index.scenes[name] = { order: DEFAULT_GROUP_ORDER }
    dirty = true
  }
  return dirty
}

/** 启用场景集合归一化：非数组 → null（= 全部启用）；数组 → 去重后的字符串数组。 */
function normalizeActive(raw: unknown): string[] | null {  if (!Array.isArray(raw)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 活动场景解析（§4 对照表）：
 *   - `index.active` 缺失 / null → **全部场景启用**（默认；保证"丢进去就有用"）
 *   - `index.active` 为数组 → 只有列出的场景启用（显式收窄）
 *   - `_shared` 恒常启用（公共基线），不受开关影响
 *   - 保留场景 `global` 恒常启用：它的记忆对任何对话都成立
 * 缺失 rules-index.json 一律按默认值运行（"全部场景启用"），不抛错（§9.3）。
 * 场景生效与否只由 index.active 决定（场景档案/模式也写这一份）。
 */
function resolveActiveScenes(index: RulesIndex, knownScenes: string[]): { active: Set<string>; mode: 'all' | 'custom' } {
  const stored = normalizeActive(index.active)
  const mode: 'all' | 'custom' = stored === null ? 'all' : 'custom'
  const active = new Set<string>(stored === null ? knownScenes : stored)
  active.add(SHARED_GROUP)
  active.add(GLOBAL_SCENE)
  return { active, mode }
}

/** 场景名 = 分组路径的第一段（`web/frontend` 属于场景 `web`）。 */
function sceneOf(group: string): string {
  const idx = String(group || '').indexOf('/')
  return idx >= 0 ? group.slice(0, idx) : group
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
  // 场景记录：保留场景 global 恒存在；有目录没记录的补一条。
  // 注意**不反向清理**——删掉 memories/<场景>/ 目录不应删掉场景记录，
  // 否则“先建场景、后加记忆”的用法会在加记忆前把场景弄丢。
  if (ensureSceneRecords(index, discovery.scenes)) dirty = true
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

  return { rules, groups, scenes: discovery.scenes, warnings: discovery.warnings, truncated: discovery.truncated, entries, bodies }
}

// ── 场景记忆段：两相扫描（廉价指纹 → 按需读正文）──────────────────────────
//
// 硬约束 1（§5.1）：`systemPrompt.section({ text })` 的 provider 在**每次装配**时
// 同步求值（`text: string | ((context) => string)`），返回 Promise 会破坏 renderPrompt。
//
// 缓存策略（§5.4 S3）：段 provider 必须同步返回 string，但不希望每个模型步骤都
// 读一遍所有记忆正文。因此拆成两相：
//   ① `probeSceneFilesSync()`：只走目录树 + `statSync`（**不读正文**），产出候选文件
//      与**指纹**（`id|mtime|size` + 影响渲染的索引字段）。
//   ② 指纹变化时才 `renderSceneMemory()`：读正文、派生、排序、拼接。
//
// 为什么不用「内存缓存 + 目录监听（方案 a）」：fs.watch 在 Windows 上不可靠（本仓库
// 技能侧不得不把 watcher 放进 worker 线程才不被卡死），而 watcher 静默失效的后果是
// **永久返回过期内容**——正是本次变更单要根治的"静默失效"形态。指纹探测每次装配只做
// 一次 stat 遍历（个人记忆树是亚毫秒级），换来"永远最新且永不静默失效"，优先于"零 IO"。
//
// 与 discover() 的关系：discover 是异步全量快照（供 CRUD/列表/体检），这里是同步轻量
// 扫描（供提示词段），两者对"什么是规则"的定义保持一致：
//   目录含 SKILL.md → bundle 规则（叶子）；否则继续下钻；只认 .md；跳过隐藏项；
//   同名 flat 与 bundle 冲突时 bundle 优先。

function readFileIfExistsSync(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 第一相产物：一条候选记忆的**位置与指纹**（无正文）。 */
interface SceneFileRef {
  id: string
  scene: string
  name: string
  kind: 'flat' | 'bundle'
  path: string
  order: number
  /** 指纹片段：mtime + size，文件内容一变即变。 */
  stamp: string
}

function fileStampSync(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 第一相：走目录树 + stat，不读正文。
 *   `<场景>/...` → 场景记忆（一级目录名即场景名，含保留场景 `global`）；
 *   是否生效由 index.active 决定，`global` 恒定生效（见 renderSceneMemory）。
 * 根层的裸 .md **不再是记忆**（旧的「全局」桶已迁入 `global/`，见 relocateLegacyLayout），
 * 因此这里不再扫描根层文件——把文件丢在 memories/ 根下不会静默生效，也不会被投影。
 * `signature` 不变 ⇒ 上次渲染结果可原样复用（零正文 IO、零重排）。
 */
function probeSceneFilesSync(
  rulesRoot: string,
  index: RulesIndex,
): { refs: SceneFileRef[]; scenes: string[]; truncated: boolean; signature: string } {
  const byId = new Map<string, SceneFileRef>()
  const scenes: string[] = []
  let truncated = false
  const budget = { dirs: 0, items: 0 }

  let rootEntries: import('node:fs').Dirent[]
  try {
    rootEntries = readdirSync(rulesRoot, { withFileTypes: true })
  } catch {
    // 目录不存在/不可读 → 空段（不报错）。签名含固定前缀，便于与"空树"区分。
    return { refs: [], scenes: [], truncated: false, signature: `∅|${signatureOfIndex(index)}` }
  }

  const add = (ref: SceneFileRef): void => {
    const existing = byId.get(ref.id)
    // bundle 优先于 flat（与 discover 的同名遮蔽规则一致）。
    if (!existing || (ref.kind === 'bundle' && existing.kind === 'flat')) byId.set(ref.id, ref)
  }

  /** 收集单个目录树内的记忆（scene = 场景名）。 */
  const walk = (scene: string, dir: string, rel: string, depth: number): void => {
    if (depth > MAX_SOURCE_DEPTH || budget.dirs >= MAX_DIRECTORIES || budget.items >= MAX_ENTRIES) {
      truncated = true
      return
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    budget.dirs++
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of entries) {
      if (budget.items >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (item.name.startsWith('.')) continue // 隐藏项跳过
      const child = join(dir, item.name)
      const relChild = rel ? `${rel}/${item.name}` : item.name

      if (item.isSymbolicLink()) continue // 同步扫描不跟随符号链接（防环）
      if (item.isDirectory()) {
        budget.items++
        const skillDoc = join(child, 'SKILL.md')
        const stamp = fileStampSync(skillDoc)
        if (stamp !== 'missing') {
          // bundle 规则（叶子）：父路径为场景，目录名为记忆名。
          const id = scene ? `${scene}/${relChild}` : relChild
          if (index.rules[id]?.enabled === false) continue // 单条停用 → 不进入段
          add({ id, scene, name: item.name, kind: 'bundle', path: skillDoc, order: index.rules[id]?.order ?? DEFAULT_ORDER, stamp })
          continue
        }
        walk(scene, child, relChild, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      if (!item.name.toLowerCase().endsWith('.md')) continue // 只认 .md
      budget.items++
      const id = scene ? `${scene}/${relChild.slice(0, -3)}` : relChild.slice(0, -3)
      if (index.rules[id]?.enabled === false) continue
      add({
        id,
        scene,
        name: item.name.slice(0, -3),
        kind: 'flat',
        path: child,
        order: index.rules[id]?.order ?? DEFAULT_ORDER,
        stamp: fileStampSync(child),
      })
    }
  }

  // 一级目录 = 场景（根层的裸 .md 不再是记忆，故此处不处理文件）。
  for (const item of [...rootEntries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.')) continue
    if (item.isSymbolicLink()) continue
    if (!item.isDirectory()) continue
    if (!isValidGroupSegment(item.name)) continue // 非法目录名 → 不作为场景
    scenes.push(item.name)
  }

  // ② 场景目录树
  for (const scene of scenes) walk(scene, join(rulesRoot, scene), '', 1)

  const refs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const signature = [
    signatureOfIndex(index),
    truncated ? 'T' : '-',
    scenes.join('\u0001'),
    ...refs.map((r) => `${r.id}\u0000${r.kind}\u0000${r.order}\u0000${r.stamp}`),
  ].join('\u0002')
  return { refs, scenes, truncated, signature }
}

/** 指纹里必须包含一切影响渲染的索引字段（active / enabled / order / groups.order / scenes.order）。 */
function signatureOfIndex(index: RulesIndex): string {
  const active = normalizeActive(index.active)
  const rules = Object.keys(index.rules).sort().map((id) => {
    const e = index.rules[id]
    return `${id}\u0000${e.enabled === false ? '0' : '1'}\u0000${e.order ?? DEFAULT_ORDER}`
  })
  const groups = Object.keys(index.groups).sort().map((g) => `${g}\u0000${index.groups[g]?.order ?? DEFAULT_GROUP_ORDER}`)
  // 场景顺序决定段内场景的先后 → 必须进指纹，否则改顺序后段文本不会重算。
  const scenes = Object.keys(index.scenes || {}).sort().map((s) => {
    const e = index.scenes![s]
    return `${s}\u0000${e.order ?? (s === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER)}\u0000${e.label ?? ''}`
  })
  return `A:${active === null ? '*' : active.join(',')}|R:${rules.join(';')}|G:${groups.join(';')}|S:${scenes.join(';')}`
}

/**
 * 第二相：读正文 + 派生 + 确定性拼接。仅在指纹变化时调用。
 */
function renderSceneMemory(
  probe: { refs: SceneFileRef[]; scenes: string[]; truncated: boolean },
  index: RulesIndex,
  maxBytes: number,
): SceneMemoryProjection {
  const files: SceneMemoryFile[] = []
  for (const ref of probe.refs) {
    const text = readFileIfExistsSync(ref.path)
    if (text === null) continue // 探测与读取之间被删：跳过（下次指纹变化会再校正）
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    const derived = deriveFromDoc(
      { id: ref.id, group: ref.scene, name: ref.name, kind: ref.kind, docPath: ref.path, entryPath: ref.path },
      doc,
    )
    files.push({
      id: ref.id,
      scene: ref.scene,
      name: derived.name,
      description: derived.description,
      descriptionDerived: derived.descriptionDerived,
      order: ref.order,
      body: doc.body,
    })
  }

  const { active } = resolveActiveScenes(index, probe.scenes)
  const buckets = new Map<string, SceneMemoryFile[]>()
  for (const file of files) {
    // 保留场景 global 恒定生效（「全局」= 任何对话都注入）；其余由 index.active 决定。
    if (file.scene !== GLOBAL_SCENE && !active.has(file.scene)) continue
    const list = buckets.get(file.scene)
    if (list) list.push(file)
    else buckets.set(file.scene, [file])
  }

  // ── 候选块（确定性顺序：场景 → 场景内 order/名称）────────────────────────
  const candidates: SceneBlockCandidate[] = []
  let seq = 0
  for (const scene of [...buckets.keys()].sort((a, b) => compareSceneBuckets(a, b, index))) {
    const sceneFiles = (buckets.get(scene) || []).slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const header = `${sceneHeading(scene)}\n\n`
    for (const file of sceneFiles) {
      const block = `### ${ruleHeading(file)}\n\n${String(file.body ?? '').trim()}\n`
      candidates.push({
        seq: seq++,
        scene,
        header,
        block,
        item: { id: file.id, scene: file.scene, name: file.name, bytes: byteLen(block) },
      })
    }
  }
  if (candidates.length === 0) {
    return { text: '', bytes: 0, truncated: probe.truncated, maxBytes, scenes: [], items: [], dropped: [] }
  }

  /** 选中块 → 段正文（同一场景的 `## 场景记忆：x` 只在首次出现时发出一次）。 */
  const renderBody = (selected: SceneBlockCandidate[]): string => {
    const chunks: string[] = []
    let current: string | null = null
    let buf = ''
    for (const c of selected) {
      if (c.scene !== current) {
        if (buf !== '') chunks.push(buf)
        current = c.scene
        buf = c.header
      }
      buf += c.block
    }
    if (buf !== '') chunks.push(buf)
    return chunks.join('\n')
  }

  const sceneLabelOf = (scene: string): string => sceneLabel(scene)

  /** 未注入清单 + 截断标记，在 `space` 字节内尽量列全（放不下的折叠为一行计数）。 */
  const renderTail = (missed: SceneBlockCandidate[], space: number, wasTruncated: boolean): string => {
    if (!wasTruncated) return '' // 没截断就不该出现标记
    const marker = `\n${TRUNCATION_MARKER}\n`
    if (missed.length === 0) return byteLen(marker) <= space ? marker : ''
    const head = `\n${DROPPED_HEADING}\n\n`
    const lines: string[] = []
    let used = byteLen(head) + byteLen(marker)
    for (const c of missed) {
      const line = `- ${sceneLabelOf(c.scene)}/${c.item.name}（${c.item.bytes} B）\n`
      if (used + byteLen(line) > space) break
      lines.push(line)
      used += byteLen(line)
    }
    if (lines.length === 0) return byteLen(marker) <= space ? marker : ''
    const rest = missed.length - lines.length
    const fold = `- …（其余 ${rest} 条未列出）\n`
    const tail = `${head}${lines.join('')}${rest > 0 && used + byteLen(fold) <= space ? fold : ''}${marker}`
    return tail
  }

  // ── ① 贪心：放得下就放，越界**跳过**（而不是整体停止）──────────────────
  // 原来一旦某块越界就 stopped，于是一条超长记忆会把它后面的所有小记忆一起饿死。
  const markerReserve = byteLen(`\n${TRUNCATION_MARKER}\n`)
  const selected: SceneBlockCandidate[] = []
  const missed: SceneBlockCandidate[] = []
  const takenScenes = new Set<string>()
  let used = 0
  for (const c of candidates) {
    const headerCost = takenScenes.has(c.scene) ? 0 : byteLen(c.header)
    if (used + headerCost + c.item.bytes + markerReserve > maxBytes) {
      missed.push(c)
      continue
    }
    selected.push(c)
    takenScenes.add(c.scene)
    used += headerCost + c.item.bytes
  }
  missed.sort((a, b) => a.seq - b.seq)

  // ── ② 尾注自身也占字节：放不下就把已入选的块从后往前退回，直到回到预算内 ──
  let body = renderBody(selected)
  let tail = renderTail(missed, maxBytes - byteLen(body), probe.truncated || missed.length > 0)
  while (byteLen(body) + byteLen(tail) > maxBytes && selected.length > 0) {
    missed.push(selected.pop() as SceneBlockCandidate)
    missed.sort((a, b) => a.seq - b.seq)
    body = renderBody(selected)
    tail = renderTail(missed, maxBytes - byteLen(body), true)
  }

  let text = `${body}${tail}`.replace(/^\n+/, '')
  // ③ 兜底：预算小到连标记都放不下时也宁可超出几个字节——"有记忆没注入"这件事
  // 绝不能静默消失（原来单条超预算会让整段变成空串，模型端完全无痕）。
  if (text === '' && (missed.length > 0 || probe.truncated)) text = `${TRUNCATION_MARKER}\n`

  const scenes: string[] = []
  for (const c of selected) if (!scenes.includes(c.scene)) scenes.push(c.scene)
  return {
    text,
    bytes: byteLen(text),
    truncated: probe.truncated || missed.length > 0,
    maxBytes,
    scenes,
    items: selected.map((c) => c.item),
    dropped: missed.map((c) => c.item),
  }
}

/** 场景渲染顺序：全局 `global` 最先（它的记忆对任何对话都成立，先讲总则），
 *  其次 `_shared`（历史保留名），其余按（索引 scenes.order, 场景名）。 */
function compareSceneBuckets(a: string, b: string, index: RulesIndex): number {
  if (a === b) return 0
  if (a === GLOBAL_SCENE) return -1
  if (b === GLOBAL_SCENE) return 1
  if (a === SHARED_GROUP) return -1
  if (b === SHARED_GROUP) return 1
  const ao = sceneOrderOf(index, a)
  const bo = sceneOrderOf(index, b)
  return ao - bo || a.localeCompare(b)
}

/** 场景排序键：索引 scenes.order 优先，回退到旧 groups.order，再回退默认值。 */
function sceneOrderOf(index: RulesIndex, scene: string): number {
  if (scene === GLOBAL_SCENE) return 0
  const s = index.scenes?.[scene]?.order
  if (typeof s === 'number' && Number.isFinite(s)) return s
  return index.groups[scene]?.order ?? DEFAULT_GROUP_ORDER
}

/** 场景显示名：`global` → 「全局」（磁盘名保持 ASCII），其余用索引 label 或场景名。 */
function sceneLabel(scene: string, index?: RulesIndex): string {
  if (scene === GLOBAL_SCENE) return index?.scenes?.[GLOBAL_SCENE]?.label || GLOBAL_SCENE_LABEL
  const label = index?.scenes?.[scene]?.label
  return label && label !== '' ? label : scene
}

/** 场景标题：`''` → 全局；其余用目录名（可追溯）。 */
const sceneHeading = (scene: string): string => `## 场景记忆：${sceneLabel(scene)}`

/** 单条记忆的标题：显式 description 优先；派生描述与正文重复，改用文件名。 */
const ruleHeading = (f: SceneMemoryFile): string => (
  f.descriptionDerived || !f.description ? f.name : f.description
)

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

// ── 创建服务 ───────────────────────────────────────────────────────────────

export function createRulesService(ctx: any, deps: RulesDeps): RulesService {
  // 仅测试注入绝对路径；生产按 $DSH_HOME 解析（与核心技能目录同源）。
  // v0.4：全部落到 $DSH_HOME/tool-management/ 一个目录内（memories/ + scenes/ + 侧车），
  // 旧的 $DSH_HOME/scene-memory 与更旧的 $DSH_HOME/rules 由 relocateLegacyLayout() 搬入。
  const stateDir = deps.stateDir && deps.stateDir.trim() !== '' ? resolve(deps.stateDir) : join(resolveDshHome(), HUB_DIR)
  const rulesRoot = deps.rulesRoot && deps.rulesRoot.trim() !== '' ? resolve(deps.rulesRoot) : join(stateDir, MEMORIES_DIR)
  const scenesRoot = deps.scenesDir && deps.scenesDir.trim() !== '' ? resolve(deps.scenesDir) : join(stateDir, SCENES_DIR)
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes! > 0 ? deps.maxBytes! : DEFAULT_MAX_BYTES

  // 旧布局迁移：每个进程只跑一次。放在目录解析之后、任何首次读盘之前。
  let legacyRelocated = false
  const ensureLayout = async (): Promise<void> => {
    if (legacyRelocated) return
    legacyRelocated = true
    try {
      await relocateLegacyLayout(rulesRoot)
    } catch {
      /* 迁移失败不阻断服务：旧目录原样留着，用户可手工搬 */
    }
    try {
      await mkdir(join(rulesRoot, GLOBAL_SCENE), { recursive: true })
      await mkdir(scenesRoot, { recursive: true })
    } catch {
      /* 目录建不出来时后面的 op 会各自报错，这里不提前抛 */
    }
  }

  let snapCache: { at: number; value: Snapshot } | null = null
  const snapshot = async (): Promise<Snapshot> => {
    if (snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.value
    await ensureLayout()
    const value = await buildSnapshot(rulesRoot, stateDir)
    snapCache = { at: Date.now(), value }
    return value
  }
  const invalidateSnapshot = (): void => {
    snapCache = null
  }

  // ── 场景记忆段（两相扫描 + 指纹缓存）──────────────────────────────────────
  //
  // 段文本 = 活动场景（`_shared` ∪ index.active，缺失时全部）下所有 .md 正文，
  // 按「场景顺序 → 记忆名」确定性拼接；超预算按同一顺序确定性截断并追加固定标记。
  // 禁止时间戳/计数：否则每请求都变，前缀缓存永远不命中（§5.2）。
  //
  // 每次装配：只做「读索引 + stat 遍历」的廉价探测；指纹不变直接返回上次结果，
  // 指纹一变（切场景 / 改文件 / 外部编辑器改文件 / 改 enabled）才重读正文并重排。
  // 见文件顶部「两相扫描」注释里为什么不选 fs.watch 方案。

  let sceneCache: { signature: string; value: SceneMemoryProjection } | null = null

  function sceneMemory(): SceneMemoryProjection {
    const index = readIndexSync(stateDir)
    const probe = probeSceneFilesSync(rulesRoot, index)
    if (sceneCache && sceneCache.signature === probe.signature) return sceneCache.value
    const value = renderSceneMemory(probe, index, maxBytes)
    sceneCache = { signature: probe.signature, value }
    return value
  }

  const providerInvalidators = new Set<() => void>()
  /** 通知已注册的 provider 提示词已变化（best-effort）。 */
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
    if (!name || !isValidGroupSegment(name)) return null
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

  /**
   * 写操作成功后：失效快照 + 丢弃场景记忆段缓存 + 通知 provider。
   * 指纹本身已能发现变化，这里显式丢弃是为了让写操作返回后**必然**是新鲜结果。
   * 不再写 ~/.dsh/AGENTS.md（原始终层投影已下线，见变更单 §4/§10）：
   * 公共基线改由 `_shared/` 场景承担，统一走 systemPrompt 段。
   */
  const refresh = async (): Promise<void> => {
    invalidateSnapshot()
    sceneCache = null
    invalidateProviders()
  }

  /** 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内，保持与其余索引写串行）。 */
  const patchIndex = (patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null }): Promise<void> =>
    enqueueMutation(async () => {
      const index = await readIndex(stateDir)
      if (patch.mode !== undefined) index.mode = patch.mode
      if (patch.archives !== undefined) index.archives = patch.archives
      // active 复用「记忆启用集」语义（null = 全部启用）；进入模式时引擎收窄为 [S]。
      if (patch.active !== undefined) index.active = patch.active
      await writeIndex(stateDir, index)
      await refresh()
    })

  /** 场景档案引擎专用：读 mode/archives/active 切片（容忍缺失，缺省 = 无档案 + 自由模式 + 全部启用）。 */
  const readArchiveSlice = async (): Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }> => {
    const index = await readIndex(stateDir)
    return { mode: index.mode ?? { scene: null, snapshot: null }, archives: index.archives ?? {}, active: normalizeActive(index.active) }
  }

  // ── 场景行（UI 用：启用/停用开关）──────────────────────────────────────

  /** 场景行：**以索引的场景记录为准**（空场景也在列表里），记忆条数由快照统计。 */
  function sceneRows(snap: Snapshot, index: RulesIndex): SceneRow[] {
    const names = new Set<string>([GLOBAL_SCENE, ...Object.keys(index.scenes || {}), ...snap.scenes])
    const counts = new Map<string, number>()
    for (const rule of snap.rules) {
      if (rule.shadowed) continue
      const scene = sceneOf(rule.group)
      if (scene === '') continue // 无场景归属的记忆（旧根层遗留）不归属任何场景
      counts.set(scene, (counts.get(scene) || 0) + 1)
    }
    const known = [...names]
    const { active } = resolveActiveScenes(index, known)
    return known
      .map((name) => ({
        name,
        label: sceneLabel(name, index),
        order: sceneOrderOf(index, name),
        count: counts.get(name) || 0,
        active: active.has(name),
        shared: name === SHARED_GROUP,
        global: name === GLOBAL_SCENE,
        description: index.scenes?.[name]?.description || '',
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  // ── ops：读 ─────────────────────────────────────────────────────────────

  async function rulesList(args: any): Promise<any> {
    const groupFilter = args && typeof args.group === 'string' && args.group !== '' ? args.group : undefined
    const snap = await snapshot()
    const index = await readIndex(stateDir)
    const rules = snap.rules
      .filter((r) => !groupFilter || r.group === groupFilter)
      .sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order || a.name.localeCompare(b.name))
    const groups = groupFilter ? snap.groups.filter((g) => g.name === groupFilter) : snap.groups
    const scenes = sceneRows(snap, index)
    const projection = sceneMemory()
    return {
      ok: true,
      rules,
      // 对外契约（§7.1）用 key 标识分组；name 保留兼容内部引用。
      groups: groups.map((g) => ({ ...g, key: g.name })),
      // 场景 = 显式记录（含保留场景 global 与尚无记忆的空场景）；active = 是否参与注入。
      scenes,
      activeMode: normalizeActive(index.active) === null ? 'all' : 'custom',
      sceneMemory: { usedBytes: projection.bytes, maxBytes: projection.maxBytes, truncated: projection.truncated, dropped: projection.dropped },
      // 路径供 UI 显示「文件在哪」；不再让界面硬编码 ~/.dsh/scene-memory。
      paths: { memories: rulesRoot, scenes: scenesRoot, hub: stateDir },
      stats: {
        total: rules.length,
        enabled: rules.filter((r) => r.enabled).length,
        scenes: scenes.filter((s) => s.active).length,
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
        attachments: entry.kind === 'bundle' ? await listAttachments(entry.entryPath) : [],
        frontmatter: {
          name: doc.map.name != null ? String(doc.map.name) : undefined,
          description: doc.map.description != null ? String(doc.map.description) : undefined,
          whenToUse: doc.map.whenToUse != null ? String(doc.map.whenToUse) : undefined,
          globs: doc.map.globs != null ? String(doc.map.globs) : undefined,
          metadata: doc.map.metadata !== undefined ? doc.map.metadata : undefined,
        },
      },
    }
  }

  /**
   * 场景记忆段预算视图。段落由「活动场景 + 文件内容」决定，超限时**不拒绝写入**，
   * 而是按确定性顺序截断（§4 对照表）——这里只报告事实，供 UI 显著告警。
   */
  async function rulesBudget(): Promise<any> {
    const projection = sceneMemory()
    return {
      ok: true,
      usedBytes: projection.bytes,
      maxBytes: projection.maxBytes,
      truncated: projection.truncated,
      scenes: projection.scenes,
      items: projection.items,
    }
  }

  /**
   * 规则体检 + 诊断汇总（Phase 3）：逐条规则检查 6 类异常，附场景记忆段预算与场景统计。
   * 只读；结果只用于 UI 展示，不做任何写操作。
   */
  async function rulesDiagnose(): Promise<any> {
    const snap = await snapshot()
    const index = await readIndex(stateDir)
    const scenes = sceneRows(snap, index)
    const issues: Array<{ severity: 'error' | 'warning' | 'info'; code: string; ruleId?: string; message: string }> = []
    for (const rule of snap.rules) {
      if (rule.shadowed) {
        issues.push({ severity: 'warning', code: 'shadowed', ruleId: rule.id, message: `规则「${rule.id}」被同名 bundle 遮蔽，不会被加载。` })
      }
      if (String(rule.description || '').length > MAX_DESCRIPTION_LENGTH) {
        issues.push({ severity: 'error', code: 'descriptionTooLong', ruleId: rule.id, message: `规则「${rule.id}」描述超过 ${MAX_DESCRIPTION_LENGTH} 字符，会被列表与检索截断。` })
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
      // 记忆所在场景未启用 → 不会自动生效（不是错误，但值得提示，避免"改了没效果"）。
      const scene = sceneOf(rule.group)
      if (scene === '') {
        // v0.4：记忆必须归属某个场景（留空 = 保留场景 `global`）。归不到场景的记忆
        // 不会被投影，也不会出现在场景卡片里 —— 必须显式报出来，不能静默。
        if (!rule.shadowed) {
          issues.push({ severity: 'warning', code: 'noScene', ruleId: rule.id, message: `规则「${rule.id}」没有归属场景（文件直接放在 memories/ 根层），不会被注入。请移入某个场景目录，或放到 memories/${GLOBAL_SCENE}/ 作为「全局」记忆。` })
        }
      } else if (!rule.shadowed) {
        const row = scenes.find((s) => s.name === scene)
        if (row && !row.active) {
          issues.push({ severity: 'info', code: 'sceneDisabled', ruleId: rule.id, message: `规则「${rule.id}」所属场景「${scene}」未启用，当前不会进入系统提示词。` })
        } else if (!row) {
          issues.push({ severity: 'warning', code: 'sceneUnknown', ruleId: rule.id, message: `规则「${rule.id}」的场景「${scene}」没有对应记录（可能被手工创建）——请到「场景」页补一条场景描述。` })
        }
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
    const projection = sceneMemory()
    if (projection.truncated) {
      issues.push({
        severity: 'warning',
        code: 'sceneMemoryTruncated',
        message: `场景记忆段超出预算（${projection.bytes} 字节 > ${projection.maxBytes} 字节），已按确定性顺序截断并追加 ${TRUNCATION_MARKER}；请精简记忆或只保留 _shared。`,
      })
    }
    return {
      ok: true,
      issues,
      budget: { usedBytes: projection.bytes, maxBytes: projection.maxBytes, over: projection.truncated },
      counts: { rules: snap.rules.length, groups: snap.groups.length, scenes: scenes.length },
    }
  }

  // ── ops：写（串行队列内）───────────────────────────────────────────────

  async function rulesCreate(args: any): Promise<any> {
    const group = String((args && args.group) || '').trim()
    const name = String((args && args.name) || '').trim()
    const form = args && args.form === 'bundle' ? 'bundle' : 'flat'
    // 场景必填：留空落到保留场景 `global`（界面「全局」，任何对话都注入）。
    // 场景必须是**已存在**的记录——写成不存在的名字会静默造出一个没有描述的场景，
    // 所以这里显式引导用户先去「场景」页创建（错误码可被 UI 翻译）。
    if (group !== '' && !isValidGroupPath(group)) return fail('error.rules.invalidGroup', `场景名非法：${group}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头、首尾无空白）`)
    const targetGroup = group === '' ? GLOBAL_SCENE : group
    const indexForScene = await readIndex(stateDir)
    // 保留场景 global 恒存在（不用先建）；其余场景必须已存在——见上方注释。
    if (targetGroup !== GLOBAL_SCENE && !indexForScene.scenes?.[targetGroup] && !(await pathExists(join(rulesRoot, targetGroup)))) {
      return fail('error.rules.sceneNotFound', `场景不存在：${targetGroup}（请先在「场景」页创建该场景）`)
    }
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `记忆名非法：${name}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含 / \\ < > : " | ? *、不以 . 开头）`)
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
    // 写文件（frontmatter 仅写用户显式提供的字段）。是否生效由"场景是否启用"决定，
    // 超预算只在渲染时确定性截断 + 告警，不再拒绝写入（§4 对照表）。
    const fields: Record<string, string | boolean> = { name }
    if (rawDescription !== '') fields.description = description!
    const text = serializeRuleFile(fields, body)
    if (form === 'bundle') {
      await mkdir(join(rulesRoot, targetGroup, name), { recursive: true })
      await writeFileAtomically(join(rulesRoot, targetGroup, name, 'SKILL.md'), text)
    } else {
      await mkdir(join(rulesRoot, targetGroup), { recursive: true })
      await writeFileAtomically(join(rulesRoot, targetGroup, name + '.md'), text)
    }
    // 更新索引（force 重读后合并，避免覆盖用户手工编辑）。
    // id 恒为 `<场景>/<名>`（与 parseId 同构）；场景记录此时必然已存在。
    const createdId = `${targetGroup}/${name}`
    const index = indexForScene
    index.rules[createdId] = { order: DEFAULT_ORDER, enabled: true, updatedAt: new Date().toISOString() }
    if (!index.groups[targetGroup]) index.groups[targetGroup] = { order: DEFAULT_GROUP_ORDER, label: targetGroup }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(createdId) }
  }

  /**
   * 导入记忆（.md / .zip）：文件即真源——把 .md 原文落进 `<场景>/<名>.md`，场景为空 = 全局根层
   * zip 内带目录 → 目录路径当场景；裸 .md → 落到 `args.scene`（留空 = 保留场景 `global`）。
   * 引用到的场景不存在时**自动补一条场景记录**（导入是批量动作，要求用户先逐个建场景不现实）；
   * 这不算静默造场景——被补的场景会在 `scenes` 结果里回传，UI 会提示。
   * 重名一律**跳过并报告**（与技能导入同策略），绝不覆盖用户既有文件。
   * 部分成功：单条失败只记 skipped，不影响同批其余条目。
   */
  async function rulesImport(args: any): Promise<any> {
    const scene = String((args && args.scene) || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
    if (scene !== '' && !isValidGroupPath(scene)) {
      return fail('error.rules.invalidGroup', `场景名非法：${scene}（留空 = 全局；否则非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头、首尾无空白）`)
    }
    const defaultScene = scene === '' ? GLOBAL_SCENE : scene
    const files = args && args.files
    if (!Array.isArray(files) || !files.length) return fail('error.import.noFiles', '没有选择要导入的文件')
    const { entries, problems } = expandUploads(files)
    const planned = planMemoryImport(entries, defaultScene)
    const skipped: Array<{ name: string; reason: string }> = [...problems, ...planned.problems]
    const imported: string[] = []
    const accepted: Array<{ group: string; name: string; text: string; kind: 'flat' | 'bundle'; attachments: Array<{ name: string; data: Buffer }> }> = []
    for (const target of planned.targets) {
      if (target.group !== '' && !isValidGroupPath(target.group)) { skipped.push({ name: target.name, reason: '场景名非法，已跳过' }); continue }
      if (!isValidGroupSegment(target.name)) { skipped.push({ name: target.name, reason: '记忆名不合法，已跳过' }); continue }
      const text = Buffer.from(target.bytes).toString('utf8').replace(/^\uFEFF/, '')
      if (text.trim() === '') { skipped.push({ name: target.name, reason: '内容为空，已跳过' }); continue }
      if (Buffer.byteLength(text, 'utf8') > MAX_RULE_BYTES) {
        skipped.push({ name: target.name, reason: `正文超过 ${MAX_RULE_BYTES >> 10} KiB，已跳过` })
        continue
      }
      // bundle 附件复检（规划层已过滤，这里按 rules-attach 同口径再拦一次，防绕过规划层的调用方）。
      const rawAttachments = target.kind === 'bundle' ? target.attachments || [] : []
      const checkedAttachments: Array<{ name: string; data: Buffer }> = []
      let attachTotal = 0
      for (const att of rawAttachments) {
        if (!isValidGroupSegment(att.name)) { skipped.push({ name: `${target.name}/${att.name}`, reason: '附件名不合法，已跳过' }); continue }
        const data = Buffer.from(att.bytes)
        if (!data.length) { skipped.push({ name: `${target.name}/${att.name}`, reason: '附件内容为空，已跳过' }); continue }
        if (data.length > MAX_ATTACH_ENTRY_BYTES) { skipped.push({ name: `${target.name}/${att.name}`, reason: `附件过大（单个上限 ${MAX_ATTACH_ENTRY_BYTES >> 20} MiB），已跳过` }); continue }
        attachTotal += data.length
        if (attachTotal > MAX_ATTACH_TOTAL_BYTES) { skipped.push({ name: `${target.name}/${att.name}`, reason: `附件合计超过 ${MAX_ATTACH_TOTAL_BYTES >> 20} MiB，已跳过` }); continue }
        checkedAttachments.push({ name: att.name, data })
      }
      const existing = await locateRule(target.group, target.name)
      if (existing) {
        skipped.push({ name: target.group ? `${target.group}/${target.name}` : target.name, reason: '同名已存在（已跳过）' })
        continue
      }
      accepted.push({ group: target.group, name: target.name, text, kind: target.kind, attachments: checkedAttachments })
    }
    if (!accepted.length) return { ok: true, imported, skipped, scenes: [] }
    const index = await readIndex(stateDir)
    if (!index.scenes) index.scenes = {}
    const createdScenes: string[] = []
    for (const item of accepted) {
      const id = `${item.group}/${item.name}`
      try {
        if (item.kind === 'bundle') {
          // 与 rules-create 同落点：bundle = <场景>/<名>/ 目录，正文 SKILL.md，附件平铺同层。
          const bundleDir = join(rulesRoot, item.group, item.name)
          await mkdir(bundleDir, { recursive: true })
          await writeFileAtomically(join(bundleDir, 'SKILL.md'), item.text)
          for (const att of item.attachments) await writeFileAtomicBinary(join(bundleDir, att.name), att.data)
        } else {
          await mkdir(join(rulesRoot, item.group), { recursive: true })
          await writeFileAtomically(join(rulesRoot, item.group, item.name + '.md'), item.text)
        }
      } catch (e) {
        skipped.push({ name: id, reason: '写入失败：' + message(e) })
        continue
      }
      // 索引记录：与 rules-create 同口径（order/enabled/updatedAt + 场景分组），用户既有设置不覆盖。
      const entry = index.rules[id]
      index.rules[id] = { ...(entry || {}), order: entry?.order ?? DEFAULT_ORDER, enabled: entry?.enabled ?? true, updatedAt: new Date().toISOString() }
      if (!index.groups[item.group]) index.groups[item.group] = { order: DEFAULT_GROUP_ORDER, label: item.group }
      // 场景记录补齐（导入进来的目录名此前可能没有记录）。
      if (!index.scenes[item.group]) {
        index.scenes[item.group] = item.group === GLOBAL_SCENE
          ? { label: GLOBAL_SCENE_LABEL, order: 0 }
          : { order: DEFAULT_GROUP_ORDER, createdAt: new Date().toISOString() }
        createdScenes.push(item.group)
      }
      imported.push(id)
    }
    if (imported.length) await writeIndex(stateDir, index)
    return { ok: true, imported, skipped, scenes: createdScenes }
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
    if (!isValidGroupSegment(newName)) return fail('error.rules.invalidName', `记忆名非法：${newName}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含 / \\ < > : " | ? *、不以 . 开头）`)
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
    // 索引：改名则迁移记录（保留 order/tags/enabled 等），否则原地更新。
    const index = await readIndex(stateDir)
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
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const trashDir = join(stateDir, 'rules-trash', trashId)
    let manifest: { group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string }
    try {
      manifest = JSON.parse(await readFile(join(trashDir, 'manifest.json'), 'utf8')) as typeof manifest
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.group !== 'string' || !isValidGroupSegment(manifest.name)) {
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

  /** trashId 只由本插件生成（时间戳 base36 + uuid 前 8 位）：严格白名单，杜绝路径穿越。 */
  function isValidTrashId(trashId: string): boolean {
    return /^[a-z0-9]+-[a-z0-9]{1,32}$/i.test(trashId)
  }

  /**
   * 记忆回收站列表（只读）：`<stateDir>/rules-trash/<trashId>/`（`rulesRemove` 移入，
   * `rulesRestore` 恢复）。损坏或内容缺失的条目跳过，不让一个坏条目挡住整份列表。
   */
  async function rulesTrashList(): Promise<any> {
    const root = join(stateDir, 'rules-trash')
    let ids: string[] = []
    try {
      ids = await readdir(root)
    } catch {
      return { ok: true, entries: [] } // 目录不存在 = 回收站为空
    }
    const entries: Array<{ trashId: string; group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string; bytes: number }> = []
    for (const trashId of ids) {
      if (!isValidTrashId(trashId)) continue
      const dir = join(root, trashId)
      try {
        const st = await lstat(dir)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
        if (!manifest || typeof manifest.name !== 'string' || !isValidGroupSegment(manifest.name)) continue
        const group = typeof manifest.group === 'string' ? manifest.group : ''
        if (group !== '' && !isValidGroupPath(group)) continue
        const form: 'flat' | 'bundle' = manifest.form === 'bundle' ? 'bundle' : 'flat'
        let bytes = 0
        try {
          bytes = (await stat(form === 'bundle' ? join(dir, 'bundle', 'SKILL.md') : join(dir, 'rule.md'))).size
        } catch { /* 内容缺失：仍列出，恢复时由 rulesRestore 兜底报错 */ }
        entries.push({ trashId, group, name: manifest.name, form, deletedAt: String(manifest.deletedAt || ''), bytes })
      } catch { /* 损坏条目跳过 */ }
    }
    entries.sort((a, b) => (a.deletedAt === b.deletedAt ? b.trashId.localeCompare(a.trashId) : b.deletedAt.localeCompare(a.deletedAt)))
    return { ok: true, entries }
  }

  /** 永久删除回收站条目（不可恢复）。 */
  async function rulesTrashRemove(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const dir = join(stateDir, 'rules-trash', trashId)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory()) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }

  /** bundle 目录下的附件（顶层普通文件，排除正文 SKILL.md）；不存在/不可读返回空数组。 */
  async function listAttachments(bundleDir: string): Promise<Array<{ name: string; size: number }>> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(bundleDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: Array<{ name: string; size: number }> = []
    for (const entry of entries) {
      if (entry.name === BUNDLE_DOC) continue
      if (!entry.isFile()) continue // 子目录 / 符号链接不列出（detach 也只动普通文件）
      try {
        out.push({ name: entry.name, size: (await stat(join(bundleDir, entry.name))).size })
      } catch { /* 读不到的条目跳过 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /**
   * 往 bundle 记忆里写附件。flat 形态没有目录，直接拒绝。
   * 先整体校验、再逐个落盘：避免写到一半才因为第 N 个文件非法而留下半份附件。
   * 同名附件覆盖（这是用户对自己文件的显式上传动作）。
   */
  async function rulesAttach(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    if (located.kind !== 'bundle') return fail('error.rules.notBundle', `「${parts.name}」是 flat（单文件），不能带附件`)
    const files: any[] = Array.isArray(args && args.files) ? args.files : []
    if (files.length === 0) return fail('error.rules.noFiles', '没有选择附件')
    if (files.length > MAX_ATTACH_ENTRIES) return fail('error.rules.tooManyFiles', `一次最多 ${MAX_ATTACH_ENTRIES} 个附件`, { limit: MAX_ATTACH_ENTRIES })
    const pending: Array<{ name: string; data: Buffer }> = []
    let total = 0
    for (const file of files) {
      const name = String((file && (file.path || file.name)) || '')
      if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
      const data = Buffer.from(String((file && file.data) || ''), 'base64')
      if (data.length === 0) return fail('error.rules.emptyFile', `附件内容为空：${name}`)
      if (data.length > MAX_ATTACH_ENTRY_BYTES) return fail('error.rules.fileTooLarge', `附件过大：${name}（单个上限 ${MAX_ATTACH_ENTRY_BYTES >> 20} MiB）`, { limit: MAX_ATTACH_ENTRY_BYTES >> 20 })
      total += data.length
      if (total > MAX_ATTACH_TOTAL_BYTES) return fail('error.rules.tooLarge', `附件总大小超过 ${MAX_ATTACH_TOTAL_BYTES >> 20} MiB`, { limit: MAX_ATTACH_TOTAL_BYTES >> 20 })
      pending.push({ name, data })
    }
    for (const file of pending) await writeFileAtomicBinary(join(located.entryPath, file.name), file.data)
    return { ok: true, attachments: await listAttachments(located.entryPath) }
  }

  /** 删除 bundle 记忆的一个附件；正文 SKILL.md 不可删。 */
  async function rulesDetach(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    if (located.kind !== 'bundle') return fail('error.rules.notBundle', `「${parts.name}」是 flat（单文件），没有附件`)
    const name = String((args && args.name) || '')
    if (!isValidGroupSegment(name) || name === BUNDLE_DOC) return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
    const target = join(located.entryPath, name)
    try {
      const st = await lstat(target)
      if (!st.isFile() || st.isSymbolicLink()) return fail('error.rules.notFound', `附件不存在：${name}`)
    } catch {
      return fail('error.rules.notFound', `附件不存在：${name}`)
    }
    await rm(target, { force: true })
    return { ok: true, attachments: await listAttachments(located.entryPath) }
  }

  async function rulesToggle(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const enabled = args && args.enabled !== undefined ? args.enabled === true : (idxEntry.enabled ?? true)
    index.rules[id] = { ...idxEntry, enabled, updatedAt: new Date().toISOString() }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, rule: await buildProjected(id) }
  }

  /**
   * 设置"启用场景"集合（全局持久化，切换后**下一个请求即生效**，§4 对照表）。
   *   - `args.all === true` → 清空显式集合，回到"全部启用"默认（新建场景自动生效）
   *   - `args.scenes` 数组 → 显式收窄（`_shared` 恒常，无需列出）
   * 场景名按放宽后的规则校验；不存在的场景名也允许保存（目录随后创建即可生效）。
   */
  async function rulesSetActive(args: any): Promise<any> {
    const index = await readIndex(stateDir)
    if (args && args.all === true) {
      index.active = null
    } else {
      const raw = Array.isArray(args && args.scenes) ? args.scenes : []
      const names: string[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        const name = String(item == null ? '' : item).trim()
        // 恒常启用的保留场景不入显式集合：`_shared`（公共基线）与 `global`（「全局」）。
        if (name === '' || name === SHARED_GROUP || name === GLOBAL_SCENE) continue
        if (!isValidGroupPath(name)) {
          return fail('error.rules.invalidGroup', `场景名非法：${name}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）`)
        }
        if (seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
      index.active = names
    }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    const snap = await snapshot()
    return {
      ok: true,
      activeMode: index.active === null ? 'all' : 'custom',
      scenes: sceneRows(snap, index),
    }
  }

  /**
   * 新建场景：写一条场景记录（索引 scenes 切片）+ 建空目录 `memories/<场景>/`。
   * 场景是**显式实体**——空场景（还没有记忆）也是合法场景，会出现在场景列表里。
   * 场景名是**单个路径段**（不允许 `a/b`）：界面把场景当一级列表展示，
   * 允许多段只会让「记忆的场景」与「目录层级」两套语义互相打架。
   * 幂等：已存在则更新描述/标签，不报错。`_shared` 与 `global` 是保留名。
   */
  async function rulesCreateScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupSegment(name)) {
      return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）`)
    }
    if (name === SHARED_GROUP) return fail('error.rules.invalidGroup', `_shared 是保留场景名，无需创建`)
    const label = args && args.label !== undefined ? String(args.label).trim() : ''
    const description = args && args.description !== undefined ? String(args.description).trim() : ''
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return fail('error.rules.descriptionTooLong', `场景描述过长（≤${MAX_DESCRIPTION_LENGTH} 字符）`)
    }
    await ensureLayout()
    try {
      await mkdir(join(rulesRoot, name), { recursive: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `创建场景目录失败：${message(e)}`)
    }
    const index = await readIndex(stateDir)
    if (!index.scenes) index.scenes = {}
    const prev = index.scenes[name] || {}
    const next: SceneIndexEntry = {
      ...prev,
      ...(label !== '' && name !== GLOBAL_SCENE ? { label } : {}),
      ...(description !== '' ? { description } : {}),
      order: prev.order ?? DEFAULT_GROUP_ORDER,
      createdAt: prev.createdAt ?? new Date().toISOString(),
    }
    if (name === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[name] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, scene: sceneRecordOf(name, next) }
  }

  /**
   * 更新场景记录（描述 / 显示名 / 顺序）。记忆文件不动。
   * 这是「场景有描述」的写入口——旧版场景只有目录名，没有可编辑元数据。
   */
  async function rulesUpdateScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    const index = await readIndex(stateDir)
    if (!index.scenes) index.scenes = {}
    const prev = index.scenes[name]
    if (!prev && name !== GLOBAL_SCENE) return fail('error.rules.notFound', `场景不存在：${name}`)
    const next: SceneIndexEntry = { ...(prev || {}) }
    if (args && args.description !== undefined) {
      const description = String(args.description).trim()
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return fail('error.rules.descriptionTooLong', `场景描述过长（≤${MAX_DESCRIPTION_LENGTH} 字符）`)
      }
      if (description === '') delete next.description
      else next.description = description
    }
    if (args && args.label !== undefined && name !== GLOBAL_SCENE) {
      const label = String(args.label).trim()
      if (label === '') delete next.label
      else next.label = label
    }
    if (args && args.order !== undefined) {
      const order = Number(args.order)
      if (!Number.isFinite(order) || order < 0) return fail('error.rules.invalidGroup', `非法排序值：${args.order}`)
      next.order = Math.floor(order)
    }
    if (name === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[name] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, scene: sceneRecordOf(name, next) }
  }

  /**
   * 删除场景：**仅空目录可删**（避免一次操作带走整组记忆）。
   * 同时删掉场景记录、把它从 `active` 集合里摘掉、清掉它的档案，避免悬空引用。
   * 保留场景 `global` 不可删除；场景名口径与创建一致（单个路径段）。
   */
  async function rulesRemoveScene(args: any): Promise<any> {
    const name = String((args && args.name) || '').trim()
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    if (name === SHARED_GROUP) return fail('error.rules.invalidGroup', `_shared 是保留场景名，不可删除`)
    if (name === GLOBAL_SCENE) return fail('error.rules.reservedScene', `「全局」是保留场景，不可删除（它的记忆对任何对话都生效）`)
    const index = await readIndex(stateDir)
    // 场景不存在（既无记录也无目录）→ 明确报错，而不是假装删成功。
    if (!index.scenes?.[name] && !(await pathExists(join(rulesRoot, name)))) {
      return fail('error.rules.notFound', `场景不存在：${name}`)
    }
    let entries: string[] = []
    try {
      entries = await readdir(join(rulesRoot, name))
    } catch {
      entries = []   // 目录本来就不存在（只有记录）→ 仍允许删记录
    }
    if (entries.filter((n) => !n.startsWith('.')).length > 0) {
      return fail('error.rules.sceneNotEmpty', `场景「${name}」里还有 ${entries.length} 项，请先删除其中的记忆`)
    }
    // 当前模式场景不可删：快照只在引擎里可退（rules service 反向注入会成环），
    // 直接删除会让运行时启停永久停在档案态且无恢复路径 → 给出可逆出路（先退出模式）。
    if (index.mode?.scene === name) {
      return fail('error.rules.sceneInMode', `场景「${name}」正处在当前模式，请先退出模式再删除`)
    }
    try {
      // fs.rm 删目录必须 recursive（即使已确认它是空的），否则报 EISDIR。
      await rm(join(rulesRoot, name), { recursive: true, force: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `删除场景目录失败：${message(e)}`)
    }
    // 索引清理一次读-改-写：记录 + 启用集合悬空引用 + 该场景档案（否则 archives 留孤儿条目）。
    let dirty = false
    if (index.scenes && index.scenes[name]) {
      delete index.scenes[name]
      dirty = true
    }
    if (Array.isArray(index.active) && index.active.indexOf(name) >= 0) {
      index.active = index.active.filter((s) => s !== name)
      dirty = true
    }
    if (index.archives && index.archives[name]) {
      delete index.archives[name]
      dirty = true
    }
    if (dirty) await writeIndex(stateDir, index)
    invalidateSnapshot()
    invalidateProviders()
    return { ok: true, name }
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

  // ── 组装 ─────────────────────────────────────────────────────────────────

  const registerProviders = (): (() => void) => {
    try {
      const registrar = createRuleProviderRegistrar(ctx, {
        renderActiveScenes: () => sceneMemory().text,
      })
      providerInvalidators.add(registrar.invalidate)
      return () => {
        providerInvalidators.delete(registrar.invalidate)
        registrar.dispose()
      }
    } catch (e) {
      console.error('[dsh-plugin-tool-management] rules provider setup failed:', message(e))
      return () => {}
    }
  }

  /** 写操作：串行队列内执行，成功后触发 refresh（失效缓存，下一请求即生效）。 */
  const runWrite = (task: () => Promise<any>) =>
    enqueueMutation(async () => {
      const result = await task()
      if (result && result.ok !== false) await refresh()
      return result
    })

  // 写操作清单：与下方 ops 表同文件同源维护（含此前漂移漏掉的
  // rules-attach / rules-detach / rules-trash-remove）；HTTP 端门禁由
  // index.ts 从本集合派生，勿在宿主端另抄一份。
  const writeOps: ReadonlySet<string> = new Set([
    'rules-create', 'rules-update', 'rules-remove', 'rules-restore', 'rules-toggle', 'rules-import',
    'rules-set-index', 'rules-set-active', 'rules-create-scene', 'rules-update-scene', 'rules-remove-scene',
    'rules-attach', 'rules-detach', 'rules-trash-remove',
  ])

  const ops: Record<string, (args: any) => Promise<any>> = {
    'rules-list': (args) => rulesList(args || {}),
    'rules-read': (args) => rulesRead(args || {}),
    'rules-budget': () => rulesBudget(),
    'rules-diagnose': () => rulesDiagnose(),
    'rules-create': (args) => runWrite(() => rulesCreate(args || {})),
    'rules-import': (args) => runWrite(() => rulesImport(args || {})),
    'rules-update': (args) => runWrite(() => rulesUpdate(args || {})),
    'rules-remove': (args) => runWrite(() => rulesRemove(args || {})),
    'rules-restore': (args) => runWrite(() => rulesRestore(args || {})),
    'rules-trash-list': () => rulesTrashList(),
    'rules-trash-remove': (args) => runWrite(() => rulesTrashRemove(args || {})),
    'rules-attach': (args) => runWrite(() => rulesAttach(args || {})),
    'rules-detach': (args) => runWrite(() => rulesDetach(args || {})),
    'rules-toggle': (args) => runWrite(() => rulesToggle(args || {})),
    'rules-set-index': (args) => runWrite(() => rulesSetIndex(args || {})),
    'rules-set-active': (args) => runWrite(() => rulesSetActive(args || {})),
    'rules-create-scene': (args) => runWrite(() => rulesCreateScene(args || {})),
    'rules-update-scene': (args) => runWrite(() => rulesUpdateScene(args || {})),
    'rules-remove-scene': (args) => runWrite(() => rulesRemoveScene(args || {})),
  }

  const service: RulesService = {
    ops,
    writeOps,
    registerProviders,
    refresh,
    patchIndex,
    readArchiveSlice,
  }
  return service
}
