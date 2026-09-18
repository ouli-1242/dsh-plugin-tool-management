// dsh-plugin-tool-management —— 规则/记忆（Rules v0.3，见 CHANGE-REQUEST-01）服务层。
//
// 记忆 = $DSH_HOME/tool-management/memories/<场景>/<name>.md（flat）或 <场景>/<name>/<name>.md（bundle）。
// 历史遗留的 bundle 正文文件名 `SKILL.md` 仍被识别（只读兼容），但新建/更新一律写 `<name>.md`。
// **场景是显式记录**：$DSH_HOME/tool-management/scenes/<场景>.json（见 SceneRecord），
// 不再是「memories/ 下恰好有这个名字的目录」这种隐式约定——空场景因此可以存在，
// 且场景可以有描述。目录名即场景名（任意 Unicode，见 isValidGroupSegment）。
// 保留场景 `global`（界面显示「全局」）：其记忆注入任何对话；它恒定存在、不可删除。
// 勾选启用后，该目录树内所有 .md 的正文自动进入模型的上下文（index.ts 注册的注入通道，
// 每步一条消息；见 src/context-inject.ts），模型无需做任何动作 —— 这就是"不用每次都要解释"。
//
// 单投影（原 ADR-4 的"双投影"已被本变更单修订）：
//   - 活动场景记忆 → 上下文注入（自动在场，会话级恒定 → 前缀稳定、缓存可命中；
//     文本没变时不重发 —— 2026-09-16 从 systemPrompt 段改道，理由见 context-inject.ts 文件头）
//   - `_shared/` 承担"恒常"语义（所有场景共用）；原 per-rule `always` 标志已移除
//   - 不再写 ~/.dsh/AGENTS.md（原始终层投影下线）
//
// 状态分层（两份文件各司其职，互不写回）：
//   - 规则文件：正文真源。frontmatter 可声明 name/description/whenToUse/globs/metadata。
//   - memories-index.json：启停/排序/标签/启用场景集合等**索引为准**字段（不写回记忆文件）。
//
// 发现必须自实现（不复用 readonly-discovery）：可写来源只扫一层会压扁子目录场景，
// 而规则的目录树天然是多层的；且 readonly-discovery 的 flat 只认顶层。
//
// 缓存红线（§5.2）：段内容只由「启用场景 + 文件内容」决定，禁止时间戳/计数/相对时间；
// 场景组合或记忆文件不变 ⇒ 逐字节稳定 ⇒ 前缀缓存命中。切换场景/编辑记忆只变化一次。
//
// 错误约定：业务校验失败返回 { ok:false, error: 中文, code, params? }（与 skills core 一致）；
// ops 成功返回扁平 { ok:true, ... }，不套 { ok:true, data }。

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseSkillDoc, renameWithRetry, resolveDshHome, unquote } from '../skills/core.js'
import { expandUploads, planMemoryImport } from '../imports/upload.js'
import { normalizePresetId } from '../agents-md/preset-id.js'
import { normalizeArchive, type ModeState, type SceneArchive } from './archive.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'

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
// 段尾清单：让模型知道自己漏了什么。去掉伞标题后这里也不再挂「场景记忆」前缀 ——
// 它紧跟在场景块之后，`参考信息` 与段首引导语同一说法。
const DROPPED_HEADING = '## 未注入的参考信息（超出预算）'
// bundle 附件限制（body 走 HTTP JSON + base64，故比技能上传收紧一档）。
const MAX_ATTACH_ENTRY_BYTES = 8 << 20 // 单个附件 8 MiB
const MAX_ATTACH_TOTAL_BYTES = 16 << 20 // 单次总大小 16 MiB
const MAX_ATTACH_ENTRIES = 32 // 单次最多 32 个
const LEGACY_BUNDLE_DOC = 'SKILL.md' // 旧版 bundle 的正文文件名；仅在发现/附件排除时作只读兼容，新建一律用 bundleDocName()
/** bundle 的正文文件名 = `<记忆名>.md`（与目录名一致，不再是固定的 SKILL.md）。 */
const bundleDocName = (name: string): string => `${name}.md`
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
 *   - `..`（即 tool-management 根）侧车：memories-index.json / skills-state.json / trash/
 *
 * 历史位置 `$DSH_HOME/scene-memory/` 由 `relocateLegacyLayout()` 在首次读写前搬入。
 */
export const HUB_DIR = 'tool-management'
export const SCENES_DIR = 'scenes'
export const MEMORIES_DIR = 'memories'
/**
 * 记忆索引文件名 / 记忆回收站目录名（hub 根下）。
 * 域叫「记忆」（工具 `memory_manager_*`、界面「记忆」页），所以按域命名 ——
 * 旧名 `rules-index.json` / `rules-trash/` 由 hub 的启动迁移搬过来（见 hub.ts）。
 */
export const MEMORIES_INDEX_FILE = 'memories-index.json'
export const MEMORIES_TRASH_DIR = 'memories-trash'
/** 提示词预设库目录名（hub 根下；域 = 提示词，工具 `prompt_manager_*`）。 */
export const PRESETS_DIR = 'prompts'

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
  /** 规则文件绝对路径（flat= .md；bundle= <名>.md，旧数据可能是 SKILL.md）。 */
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
  /**
   * bundle 记忆的附件摘要。**只在 `rules-list` 的返回里**补上（发现阶段不扫附件目录）；
   * flat 记忆没有这个字段。目录读不到时也不会有（界面据此不显示附件标签，而不是谎报 0）。
   */
  attach?: { count: number; bytes: number; names: string[] }
}

/**
 * 记忆导出的落盘映射（`bundle-export` 的 `kind: 'memories'` 用，见 design-plan D14）。
 *
 * 记忆有两种形态（见文件头）：flat = `<场景>/<name>.md`，bundle = `<场景>/<name>/<name>.md`；
 * 而且**场景名本身可含 `/`**（多段场景名，见 `isValidGroupPath`）。所以「按 id 的最后一个
 * `/` 切出场景与名字、再拼 `.md`」是错的：bundle 会被读成 `<场景>/<name>.md` → 读不到 →
 * 该项目静默丢失（只在 `missing` 里留个名，界面按「导出成功」显示）。
 *
 * 这里一律按索引里那条规则自己的 `path` 与 `form` 决定；bundle 只交出目录，由调用方
 * 把目录内的文件全部打包（与技能分支同口径）。索引里没有、或已被同名 bundle 遮蔽的 id
 * 进 `missing`——遮蔽的 flat 不会被加载，导出去只会让人以为它能用。
 *
 * 纯函数（不碰磁盘），可直接断言。
 */
export function planMemoryExport(
  names: unknown,
  rules: unknown,
): { entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }>; missing: string[] } {
  type Row = { id?: unknown; form?: unknown; path?: unknown; shadowed?: unknown }
  const list = Array.isArray(names) ? names.map((n) => String(n).trim()).filter(Boolean) : []
  const byId = new Map<string, Row>()
  for (const row of (Array.isArray(rules) ? rules : []) as Row[]) {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (id !== '') byId.set(id, row)
  }
  const entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }> = []
  const missing: string[] = []
  for (const id of list) {
    const row = byId.get(id)
    const abs = row && typeof row.path === 'string' ? row.path : ''
    if (!row || abs === '' || row.shadowed === true) {
      missing.push(id)
      continue
    }
    entries.push(row.form === 'bundle'
      ? { id, zip: id, abs: dirname(abs), kind: 'dir' }
      : { id, zip: `${id}.md`, abs, kind: 'file' })
  }
  return { entries, missing }
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

/** 当前生效的场景提示词投影（供注入兜底与只读状态展示）。 */
export interface ScenePromptProjection {
  /** 提供这段提示词的场景；`null` = 没有任何场景绑定提示词。 */
  scene: string | null
  /** 绑定的预设 id；`null` = 未绑定。 */
  presetId: string | null
  /** 预设正文（逐字节原样；段为空时宿主会删除该段）。 */
  text: string
  /** 绑定了预设但文件不存在/为空（UI 要如实标出来，别让用户以为注入了）。 */
  missing: boolean
  /**
   * 绑定的预设与**当前 `~/.dsh/AGENTS.md` 内容一致** → 不重复注入（否则同一份正文会出现两遍）。
   * 此时这份预设本来就是生效中的基线，用户看不出差别；界面据此显示「生效中」。
   */
  duplicate?: boolean
}

export interface RulesService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /** 场景记忆段文本（注入通道同步取用；见 src/context-inject.ts）。 */
  memoryText: () => string
  /**
   * 全局提示词正文（注入兜底用；官方 agent-instructions 行没挂时才被取用）：
   * 场景期间 = 当前场景绑定的提示词，否则 = `~/.dsh/AGENTS.md` 正文。
   */
  promptText: () => string
  /**
   * `promptText()` 的来源文件（同步；注入通道用作 instructions 形态的 `changes`，
   * 界面据此显示文件清单与「已载入/已更新」）。`[]` = 本次没有提示词正文。
   */
  promptFiles: () => Array<{ path: string; digest: string }>
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
  /**
   * 绑定的提示词预设 id（`tool-management/prompts/<id>/AGENTS.md`）。
   * 启用该场景时，宿主把这份正文写进 `~/.dsh/AGENTS.md`（scene-prompt-sync.ts，与「提示词」页
   * 的「应用」同一条路，关掉场景恢复进场景前的基线）；预设挂不到官方 agent-instructions 行时
   * （极简），注入通道再拿这份正文兜底（`promptText()` → src/context-inject.ts）。
   * 一个场景至多绑定一个（单值字段即天然单选）；未启用/未绑定 → 不注入。
   */
  prompt?: string
  order?: number
  /** ISO 时间戳；只要**创建**时间，不参与提示词段（段必须逐字节稳定）。 */
  createdAt?: string
}

/** 索引里的场景镜像条目。 */
interface SceneIndexEntry {
  label?: string
  description?: string
  prompt?: string
  order?: number
  createdAt?: string
  /**
   * 场景锁定（v0.8）：锁定后五个管理域（MCP/技能/子智能体/记忆/提示词）整体只读 ——
   * 场景页的档案编辑与功能页的启停/编辑都被拒（index.ts 的 handlers 守卫 +
   * 界面按钮禁用）；场景自身的启停（进/退模式）不受影响。任意一个场景锁定即全局冻结。
   */
  locked?: boolean
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

/** 同步扫描得到的单条场景记忆（供注入文本渲染）。 */
interface SceneMemoryFile {
  id: string
  /** 一级目录名；`''` = 规则根目录下的全局记忆，`_shared` = 公共基线。 */
  scene: string
  name: string
  description: string
  descriptionDerived: boolean
  order: number
  body: string
  /** `bundle` = 目录形态（正文是 `<名>.md`，同目录其余文件是附件）；`flat` = 单个 .md。 */
  kind: 'flat' | 'bundle'
  /** bundle 的目录（flat 为 `''`）：只用来把**路径**告诉模型，附件正文一律不注入。 */
  bundleDir: string
}

/** 段渲染的候选块：一个「场景标题 + 一条记忆正文」的可选单元。 */
interface SceneBlockCandidate {
  /** 全局确定性序号（候选顺序 = 场景顺序 → 场景内 order/名称）。 */
  seq: number
  scene: string
  header: string
  block: string
  /** 单行压缩形态（`- **名称** — 正文`）：连续两条可直接相邻，其余情况前空一行。 */
  inline: boolean
  item: { id: string; scene: string; name: string; bytes: number }
}

// ── 文件工具 ───────────────────────────────────────────────────────────────

/**
 * 同目录临时文件 + rename 原子写（临时名 `.xxx.dsh-rules-<uuid>.tmp`）。
 * rename 走 `renameWithRetry`：Windows 上杀软/索引器会短暂占住目标文件报
 * EPERM/EACCES/EBUSY（用户实测：进入/退出模式时 memories-index.json 被 rename 撞上，
 * 运行时已切换但状态落盘失败，界面开关停在旧状态、还得再点一次）。这种占用是
 * 瞬时的，重试几轮就能过去；全失败才清理临时文件并把错误抛出。
 */
async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, 'utf8')
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 二进制版原子写（附件用）：临时文件 + rename（同样带瞬时占用重试），失败清理临时文件。 */
async function writeFileAtomicBinary(path: string, data: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.dsh-rules-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data)
    await renameWithRetry(temp, path)
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
 * 目录语义：目录含 `<目录名>.md` → 它是 bundle 规则（叶子，不再深入），其「父路径」
 * 是场景、目录名是规则名；找不到时再退回认旧文件名 `SKILL.md`（只读兼容，不再新建）；
 * 都没有则它是场景/子分类，继续遍历其下 .md（flat，任意层级）
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

    // bundle 检查：当前目录含 `<目录名>.md`（或旧版 `SKILL.md`）→ 它是规则叶子，父路径为场景。
    //
    // **根下的一级目录恒为场景**（`parentGroup === ''` 时不做 bundle 判断）——与
    // `probeSceneFilesSync`（注入段）同口径。场景 `1` 里一条叫 `1` 的记忆（`memories/1/1.md`）
    // 与「根层的 bundle `1`」在磁盘上同形，认成后者会把整个场景目录吃成叶子：同场景其余
    // 记忆全从列表消失、多出一条「未归属场景」的同名记忆，新建记忆还会被误报「同名 bundle
    // 遮蔽」（2026-09-16 用户实测）。根层因此没有 bundle，只有 legacy 裸 .md（见 rulesCheck 的 noScene）。
    if (current.group !== '') {
      const sepIdx = current.group.lastIndexOf('/')
      const parentGroup = sepIdx >= 0 ? current.group.slice(0, sepIdx) : ''
      const name = sepIdx >= 0 ? current.group.slice(sepIdx + 1) : current.group
      let docPath = ''
      if (parentGroup !== '') {
        for (const candidate of [bundleDocName(name), LEGACY_BUNDLE_DOC]) {
          const p = join(current.path, candidate)
          try {
            const st = await lstat(p)
            if (st.isFile() && !st.isSymbolicLink()) { docPath = p; break }
          } catch { /* 该候选名不存在 → 试下一个 */ }
        }
      }
      if (docPath !== '') {
        const id = parentGroup ? `${parentGroup}/${name}` : name
        addEntry({ id, group: parentGroup, name, kind: 'bundle', docPath, entryPath: current.path })
        continue
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
  if (typeof obj.prompt === 'string') {
    const prompt = normalizeScenePromptId(obj.prompt)
    if (prompt) out.prompt = prompt
  }
  if (typeof obj.order === 'number' && Number.isFinite(obj.order)) out.order = obj.order
  if (typeof obj.createdAt === 'string' && obj.createdAt !== '') out.createdAt = obj.createdAt
  // 场景锁定（v0.8）：读盘必须原样保留 —— 这里曾只重建已知字段，锁了也会被剥成未锁。
  if (obj.locked === true) out.locked = true
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

export function parseModeState(raw: unknown): ModeState {
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
  // v2 快照的**服务器级 / 来源级**名单、v0.8 的子智能体名单、v0.9.1 的人设全量映射
  // 必须原样透传 —— 这里曾把它们剥掉，结果退出模式时两张恢复名单全是空的：服务器级 MCP 与
  // 技能来源永远不回滚（用户报的「MCP 不复原」「技能目录不回退」），只有工具级 / 技能级能还原。
  const mcpServers = (Array.isArray(snapshotRaw.mcpServers) ? snapshotRaw.mcpServers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ id: String(x.id || ''), level: String(x.level || ''), disabled: x.disabled === true }))
    .filter((x) => x.id !== '' && (x.level === 'global' || x.level === 'project'))
  const skillSources = (Array.isArray(snapshotRaw.skillSources) ? snapshotRaw.skillSources : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ root: String(x.root || ''), enabled: x.enabled === true }))
    .filter((x) => x.root !== '')
  const subagents = (Array.isArray(snapshotRaw.subagents) ? snapshotRaw.subagents : []).map((x) => String(x)).filter(Boolean)
  // 同 subagents 一组：进入时被档案**关掉**的人设（退出要重新打开）。漏掉它 = 用户实测的
  // 「进场景关掉了，退出却没开回来」——快照落盘后读回来就只剩「被启用」那一半名单。
  const subagentsOn = (Array.isArray(snapshotRaw.subagentsOn) ? snapshotRaw.subagentsOn : []).map((x) => String(x)).filter(Boolean)
  // v0.9.1 的人设**全量**开关映射（名字 → 进场景时是否开着）：同样必须原样透传 ——
  // 剥掉它，退出模式就只能退回上面两个部分名单，「场景里手动开过的人设」不再被还原。
  const subagentsAll = toFlagMap(snapshotRaw.subagentsAll)
  // v0.8.1 的场景备注恢复名单：**必须原样透传**——这里漏掉它，退出模式时备注永不回退
  //（与历史上 mcpServers / skillSources 被剥掉是同一类 bug）。
  const mcpNotes = (Array.isArray(snapshotRaw.mcpNotes) ? snapshotRaw.mcpNotes : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ id: String(x.id || ''), note: typeof x.note === 'string' ? x.note : null }))
    .filter((x) => x.id !== '')
  return {
    scene,
    snapshot: scene
      ? {
          mcp,
          skills: toFlagMap(snapshotRaw.skills),
          ...(mcpServers.length ? { mcpServers } : {}),
          ...(skillSources.length ? { skillSources } : {}),
          ...(subagents.length ? { subagents } : {}),
          ...(subagentsOn.length ? { subagentsOn } : {}),
          ...(Object.keys(subagentsAll).length ? { subagentsAll } : {}),
          ...(mcpNotes.length ? { mcpNotes } : {}),
        }
      : null,
  }
}

/** 解析 memories-index.json 原文；任何异常/版本不符 → 默认索引（容忍缺失，§9.3）。 */
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
    return parseIndex(await readFile(join(stateDir, MEMORIES_INDEX_FILE), 'utf8'))
  } catch {
    return defaultIndex()
  }
}

/** 同步读索引：注入文本的渲染路径不能 await（见文件内「两相扫描」注释）。 */
function readIndexSync(stateDir: string): RulesIndex {
  const raw = readFileIfExistsSync(join(stateDir, MEMORIES_INDEX_FILE))
  if (raw === null) return defaultIndex()
  try {
    return parseIndex(raw)
  } catch {
    return defaultIndex()
  }
}

async function writeIndex(stateDir: string, index: RulesIndex): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFileAtomically(join(stateDir, MEMORIES_INDEX_FILE), JSON.stringify(index, null, 2))
}

// ── 场景记录（索引内，`memories-index.json` 的 scenes 切片）+ 旧布局迁移 ────────

/** 索引条目 → 场景记录（供 UI 直接渲染）。 */
function sceneRecordOf(name: string, entry: SceneIndexEntry | undefined): SceneRecord {
  const e = entry || {}
  return {
    name,
    ...(name === GLOBAL_SCENE ? { label: e.label || GLOBAL_SCENE_LABEL } : (e.label ? { label: e.label } : {})),
    ...(e.description ? { description: e.description } : {}),
    ...(e.prompt ? { prompt: e.prompt } : {}),
    order: e.order ?? (name === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
  }
}

/** 提示词预设 id 的口径与 agents-md 服务**同源**（用户裁定：id 什么都能写）。 */

/** 校验场景要绑定的提示词预设 id；返回 `''` 表示解绑，`null` 表示非法。 */
function normalizeScenePromptId(value: unknown): string | null {
  const id = String(value ?? '').trim()
  if (id === '') return ''
  const result = normalizePresetId(id)
  return result.ok ? result.id : null
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
 * 活动场景解析（用户裁定 2026-09-15：**除「全局」外同时只能启用一个场景**）：
 *   - `index.active` 为数组（新写入的唯一形态）→ 至多一个非保留场景启用；
 *   - `index.active` 缺失 / null → 历史默认（"全部场景启用"）；**不再产生**新值，
 *     新建场景时会被收敛成显式数组（见 `collapseActiveForNewScene`），
 *     因此"新建即启用"不会发生；存量数据仍按老语义读，避免升级后注入范围突变。
 *   - `_shared` 恒常启用（公共基线），不受开关影响
 *   - 保留场景 `global` 恒常启用：它的记忆对任何对话都成立
 * 缺失 memories-index.json 一律按默认值运行，不抛错（§9.3）。
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

/** 当前启用的**非保留**场景（单选模型下至多一个；多个时按场景顺序取第一个）。 */
function enabledSceneOf(index: RulesIndex): string | null {
  const names = Object.keys(index.scenes || {})
  const { active } = resolveActiveScenes(index, names)
  const enabled = names
    .filter((n) => n !== SHARED_GROUP && n !== GLOBAL_SCENE && active.has(n))
    .sort((a, b) => sceneOrderOf(index, a) - sceneOrderOf(index, b) || a.localeCompare(b))
  return enabled[0] ?? null
}

/**
 * 新建场景前把历史默认（`active = null` = 全部启用）收敛成显式数组，保证
 * **新场景默认不启动**、且收敛后仍满足"至多一个非保留场景启用"：
 *   - 已存在其它非保留场景 → 取顺序第一个作为启用场景（其余收敛掉，返回 `collapsed: true`）
 *   - 不存在 → 空数组（什么都不启用）
 * @returns 是否发生了收敛（供 UI 如实提示）。
 */
function collapseActiveForNewScene(index: RulesIndex): boolean {
  if (normalizeActive(index.active) !== null) return false
  const names = Object.keys(index.scenes || {}).filter((n) => n !== SHARED_GROUP && n !== GLOBAL_SCENE)
  const first = names.sort((a, b) => sceneOrderOf(index, a) - sceneOrderOf(index, b) || a.localeCompare(b))[0]
  index.active = first === undefined ? [] : [first]
  return true
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
// 硬约束 1（§5.1）：注入通道每个 step 都要求**同步**取一次文本（`text: () => string`，
// 见 src/context-inject.ts），返回 Promise 会让这一步的注入直接失败（异常被吞）。
//
// 缓存策略（§5.4 S3）：文本出口必须同步返回 string，但不希望每个模型步骤都
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
// 扫描（供注入通道），两者对"什么是规则"的定义保持一致：
//   目录含 `<目录名>.md`（或旧版 `SKILL.md`）→ bundle 规则（叶子）；否则继续下钻；只认 .md；跳过隐藏项；
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
        let docPath = ''
        for (const candidate of [bundleDocName(item.name), LEGACY_BUNDLE_DOC]) {
          const p = join(child, candidate)
          if (fileStampSync(p) !== 'missing') { docPath = p; break }
        }
        // 指纹带上**目录本身**的 mtime：附件只在段里以「路径 + 文件名」出现，
        // 增删附件不改正文文件，只靠它的话指纹不变、段不会重算，列表就会停在旧值。
        if (docPath !== '') {
          const stamp = `${fileStampSync(docPath)}:${fileStampSync(child)}`
          // bundle 规则（叶子）：父路径为场景，目录名为记忆名。
          const id = scene ? `${scene}/${relChild}` : relChild
          if (index.rules[id]?.enabled === false) continue // 单条停用 → 不进入段
          add({ id, scene, name: item.name, kind: 'bundle', path: docPath, order: index.rules[id]?.order ?? DEFAULT_ORDER, stamp })
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

/** 指纹里必须包含一切影响渲染的索引字段（active / enabled / order / groups.order / scenes.order / label / description）。 */
function signatureOfIndex(index: RulesIndex): string {
  const active = normalizeActive(index.active)
  const rules = Object.keys(index.rules).sort().map((id) => {
    const e = index.rules[id]
    return `${id}\u0000${e.enabled === false ? '0' : '1'}\u0000${e.order ?? DEFAULT_ORDER}`
  })
  const groups = Object.keys(index.groups).sort().map((g) => `${g}\u0000${index.groups[g]?.order ?? DEFAULT_GROUP_ORDER}`)
  // 场景顺序决定段内场景的先后 → 必须进指纹，否则改顺序后段文本不会重算。
  // label 与 description 同理（sceneHeader 的「场景说明」一行直接渲染 description）——
  // 手改索引文件（带外变更）时只有指纹变化才会触发重算。
  const scenes = Object.keys(index.scenes || {}).sort().map((s) => {
    const e = index.scenes![s]
    return `${s}\u0000${e.order ?? (s === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER)}\u0000${e.label ?? ''}\u0000${e.description ?? ''}`
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
      kind: ref.kind,
      // bundle 的正文是 `<目录>/<名>.md`，附件是**同目录**的其余文件。
      bundleDir: ref.kind === 'bundle' ? dirname(ref.path) : '',
    })
  }

  const { active } = resolveActiveScenes(index, probe.scenes)
  const buckets = new Map<string, SceneMemoryFile[]>()
  for (const file of files) {
    // 保留场景 global 恒定生效（「全局」= 任何对话都注入）；其余由 index.active 决定。
    if (file.scene !== GLOBAL_SCENE && !active.has(file.scene)) continue
    // ⚠️ 这里**不再**看场景档案的 memories 段：记忆的开关是**单一真相源** `rules[*].enabled`
    // （见下方 enabled 判定）。档案弹窗里的记忆勾选就是同一个值，所以两边天然一致，
    // 不存在「记忆页开了、档案页还显示未开」的两套状态。
    const list = buckets.get(file.scene)
    if (list) list.push(file)
    else buckets.set(file.scene, [file])
  }

  // ── 候选块（确定性顺序：场景 → 场景内 order/名称）────────────────────────
  const candidates: SceneBlockCandidate[] = []
  let seq = 0
  for (const scene of [...buckets.keys()].sort((a, b) => compareSceneBuckets(a, b, index))) {
    const sceneFiles = (buckets.get(scene) || []).slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const header = sceneHeader(scene, index)
    for (const file of sceneFiles) {
      const { text: block, inline } = memoryBlock(file)
      candidates.push({
        seq: seq++,
        scene,
        header,
        block,
        inline,
        item: { id: file.id, scene: file.scene, name: file.name, bytes: byteLen(block) },
      })
    }
  }
  if (candidates.length === 0) {
    return { text: '', bytes: 0, truncated: probe.truncated, maxBytes, scenes: [], items: [], dropped: [] }
  }

  /**
   * 选中块 → 段正文（同一场景的 `## 场景：x` 只在首次出现时发出）。
   * `dropped` 决定引导语用哪一版：真有条目没注入时不再声称「以下就是全部信息」。
   */
  const renderBody = (selected: SceneBlockCandidate[], dropped: boolean): string => {
    if (selected.length === 0) return ''
    const note = dropped ? SCENE_MEMORY_NOTE_PARTIAL : SCENE_MEMORY_NOTE
    const chunks: string[] = []
    let current: string | null = null
    let buf = ''
    // 上一条是不是「单行条目」。连续两条单行条目紧挨着（列表的自然形态），
    // 其余情况都要空一行 —— 多行正文（含其缩进挂载的附件行）与下一条之间没有空行的话，
    // 读起来会连成一片、看不出条目边界。
    let prevInline = false
    for (const c of selected) {
      if (c.scene !== current) {
        if (buf !== '') chunks.push(buf)
        current = c.scene
        // 引导语跟着**场景块**走（场景说明之后、条目之前）：它管的就是下面这些条目，
        // 放最顶层会飘在场景之外（用户实测反馈「怎么跑到最顶层了」）。场景数有上限
        // （`global`/`_shared` 恒常启用 + 至多一个启用场景），最多出现 3 次，代价可接受。
        buf = `${c.header}${note}\n\n`
        prevInline = false
      }
      const inline = c.inline
      if (!(inline && prevInline) && !buf.endsWith('\n\n')) buf += '\n'
      prevInline = inline
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
  // 场景标题与引导语也是开销，按「每个首次出现的场景」计进预算 —— 否则它们会挤掉
  // 本该放得下的记忆（引导语的字节见 SCENE_NOTE_BYTES）。
  let used = 0
  const noteBytes = sceneNoteBytes()
  for (const c of candidates) {
    const headerCost = takenScenes.has(c.scene) ? 0 : byteLen(c.header) + noteBytes
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
  let body = renderBody(selected, probe.truncated || missed.length > 0)
  let tail = renderTail(missed, maxBytes - byteLen(body), probe.truncated || missed.length > 0)
  while (byteLen(body) + byteLen(tail) > maxBytes && selected.length > 0) {
    missed.push(selected.pop() as SceneBlockCandidate)
    missed.sort((a, b) => a.seq - b.seq)
    body = renderBody(selected, true)
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

/** 单个场景的标题：**场景在最顶层**（`##`，与「子智能体」「MCP 服务器」等段同级）。 */
const sceneHeading = (scene: string): string => `## 场景：${sceneLabel(scene)}`

/**
 * 没填描述时的默认「场景说明」（用户裁定 2026-09-16：全局桶一直没有描述，读起来像缺了一块，
 * 统一成"每个场景块都有场景说明"）。
 *
 * 默认句同时承担"这个场景是什么"的答疑（此前只有光秃秃的 `## 场景：X`，模型读不懂 —— 用户实测）：
 * 两个恒常桶说明生效范围，用户场景说明它是当前启用的那份配置。
 */
const defaultSceneDescription = (scene: string): string => (
  scene === GLOBAL_SCENE ? '全局记忆，任何对话都生效'
    : scene === SHARED_GROUP ? '共享记忆，任何对话都生效'
      : '用户配置的上下文，当前启用'
)

/**
 * 单个场景的段头：场景标题 + **恒有**的 `场景说明：<描述>`。
 *
 * 场景描述（界面「描述（可选）」，≤60 字符）**此前从未注入过** —— 它正是「这个场景是
 * 干什么的」的答案，属于模型做判断需要的上下文，而不是只给人看的元数据；界面上的文案
 * 也从没把它标成「只给使用者看」（对比 AGENTS.md 预设的描述，那里是明确标注的）。
 * 描述为空时给 `defaultSceneDescription` 的默认句（用户裁定：全局桶没描述时读起来像
 * 缺了一块，统一成每个场景块都有说明）。
 */
function sceneHeader(scene: string, index?: RulesIndex): string {
  const head = sceneHeading(scene)
  const described = String(index?.scenes?.[scene]?.description ?? '').replaceAll(/\s+/g, ' ').trim()
  const description = described === '' ? defaultSceneDescription(scene) : described
  // 加粗（用户裁定 2026-09-16）：与引导语同款强调，别让"场景说明"读起来像可忽略的普通正文。
  return `${head}\n\n**场景说明：${description}**\n\n`
}

/**
 * 段首的引导语：让模型知道下面是**用户为本机写的参考信息**，并且**以它为准**
 * —— 涉及本机的事一律照它办，确实无关时才放下。
 *
 * 写法（2026-09-16 用户裁定，基于真实注入结果的三次修正）：
 *   - **单行、加粗**，不再用括号分两行 —— 括号跨行在真实提示词里读起来像被截断，
 *     而加粗是 Markdown 里最省字符的强调手段（用户要求「加强模型对此的重视程度」）。
 *   - **提到段首、整段只出现一次**：原来它挂在每个场景的段头里，多场景时会重复注入。
 *   - **不点名任何工具**：模型从工具 schema 就知道 `memory_manager_list` 存在，点名反而
 *     像在提示它去调；用户裁定「没启用的信息就是不想在当前用」，所以工具指引整句删除。
 *     真正防探测的是**完整性声明**（「以下就是全部信息」），那半句必须留。
 *   - **完整性声明按截断状态自适应**：真有条目因预算没注入时，段尾会有未注入清单，
 *     此时不能再声称「全部」，否则和清单自相矛盾 —— 也正因为那时确实有东西没给到，
 *     模型去查工具是**合理**的，不该再拦。
 *
 * 用词：不用「常驻」「注入」这类内部行话（模型没有先验）；用户裁定用「信息」而不是
 * 「记忆」——「记忆」在系统提示词里指代不明，而这段的实质就是用户写的参考信息。
 *
 * 2026-09-17 重写（用户：「当前模式会不重视这些提示词」）。上一版的三个毛病都在**授权**
 * 上，而不在措辞好不好看上：
 *   1. 「与当前任务相关时直接采用」——**没有给"相关"的判据**。最省力的解读永远是"无关"，
 *      因为判成无关不需要任何工作；
 *   2. 通篇没有优先级规则。与本机实际情况冲突时，模型会默默按自己的默认假设走，
 *      而用户完全不知道发生了什么；
 *   3. 「无关时忽略」——「忽略」是这句话里**最后一个动词**，也是记得最牢的那个。它把
 *      一个免打扰出口写成了对内容的态度许可。
 * 现在：给出**判据**（凡涉及本机路径 / 配置 / 工具 / 习惯）、给出**裁决规则**、把出口降级为
 * 「不必提及」（关于**要不要声明**，不是关于**要不要采用**）。出口保留是必要的 —— 去掉它
 * 会让模型对无关条目强行攀附，那是另一种失真。
 *
 * 2026-09-17 第二版：**按条目类型分级授权**（用户采纳的四条里的第 1、4 条）。Claude Code
 * 把两类内容分进两个系统、用**相反**的授权：用户指令（`claudemd.ts:89`）是
 * "These instructions OVERRIDE any default behavior and you MUST follow them exactly as
 * written"，而记忆（`memdir/memoryTypes.ts:202`）是
 * "If a recalled memory conflicts with current information, trust what you observe now"
 * —— 书里（ch11:25）说记忆是 "working notes, not gospel"。上一版把两类塞进一句授权，
 * 对**场景说明**（用户写的约定）是对的，对**记忆条目**（可能是几个月前记下的事实）是错的。
 * 好在这两类在渲染时就分处不同位置：场景说明在 `sceneHeader` 的 `**场景说明：…**` 里，
 * 记忆条目在 `memoryBlock` 里 —— 所以一句话就能分级，不必改数据结构。
 *
 * 冲突阶梯（第 4 条）来自 Codex `base_instructions/default.md:22-27` 与 Claude Code 的
 * `caller override > agent definition > parent model > default`：把"谁高于谁"写明，
 * 模型才不会在「用户当场说的 ≠ 本机记录」时悬空。写明它还有一个反直觉的好处 ——
 * 它让授权更可信：这说明本条不是要让记忆压过用户，只是要压过模型的默认假设。
 */
const SCENE_MEMORY_NOTE = '**用户为本机写的参考信息：「场景说明」是用户的约定，一律照办，覆盖你的默认做法；其余条目是记录，可能已过期 —— 与当前实际情况冲突时以你看到的为准，与用户当场说的冲突时以用户为准。无关时不必提及。以下就是全部信息。**'
/** 有未注入条目时的版本：去掉完整性声明（见上）。 */
const SCENE_MEMORY_NOTE_PARTIAL = '**用户为本机写的参考信息：「场景说明」是用户的约定，一律照办，覆盖你的默认做法；其余条目是记录，可能已过期 —— 与当前实际情况冲突时以你看到的为准，与用户当场说的冲突时以用户为准。无关时不必提及。**'

/**
 * 段首固定块。以 `\n` 结尾，与场景块 join 后自然空一行。
 * 预算按**较长**的那版算（见 renderSceneMemory），保守一点只会浪费几个字节。
 */
/**
 * 引导语所占的字节（含它后面的一个空行）。跟着场景块走，所以按**每个场景**计入段头开销；
 * 用较长的那版（带完整性声明）算，保守一点只会浪费几个字节。
 *
 * 注意：模块级不能直接算 —— `byteLen` 是后面才声明的 const，模块初始化期取它会 TDZ 报错。
 */
const sceneNoteBytes = (): number => byteLen(`${SCENE_MEMORY_NOTE}\n\n`)

/** 单行正文的最大长度：超过就退回「标题 + 正文块」，避免出现一条几千字符的列表行。 */
const INLINE_BODY_MAX = 120
/** 附件行里最多列几个文件名；多的只报总数（路径已经给了，缺的名字模型自己列目录即可）。 */
const ATTACHMENT_LIST_MAX = 10

/**
 * bundle 记忆的附件名（**同步**版 —— 段渲染必须同步返回，`listAttachments` 是异步的）。
 * 口径与异步版一致：跳过正文本体（`<名>.md`，旧数据可能是 `SKILL.md`），只认普通文件。
 */
function attachmentNamesSync(bundleDir: string, name: string): string[] {
  try {
    const docNames = new Set([bundleDocName(name), LEGACY_BUNDLE_DOC])
    return readdirSync(bundleDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !docNames.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * bundle 记忆的附件**摘要**（列表页用）：数量 / 总体积 / 前几个文件名。
 *
 * 口径与 `attachmentNamesSync`（也就是注入给模型的那份清单）逐字一致：跳过正文本体，
 * 只认普通文件 —— 所以页面上的数字与模型实际看到的一致，不会出现「界面说 3 个、模型只见 2 个」。
 * `names` 截到 ATTACHMENT_LIST_MAX：tooltip 列不下更多，要全看到编辑弹窗里去看。
 *
 * 目录读不到（索引残留了已消失的条目）→ 返回 null，让界面**什么都不显示**，
 * 而不是谎报「0 个附件」。
 */
function attachmentSummarySync(bundleDir: string, name: string): { count: number; bytes: number; names: string[] } | null {
  let names: string[]
  try {
    const docNames = new Set([bundleDocName(name), LEGACY_BUNDLE_DOC])
    names = readdirSync(bundleDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !docNames.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return null
  }
  let bytes = 0
  for (const entry of names) {
    try { bytes += statSync(join(bundleDir, entry)).size } catch { /* 读不到的条目不计体积 */ }
  }
  return { count: names.length, bytes, names: names.slice(0, ATTACHMENT_LIST_MAX) }
}

/**
 * 附件行（只有 bundle 记忆才有）：**给目录与文件名，不给内容**。
 * 附件可能是图片、二进制、大 md —— 全文注入又贵又会把段预算吃光；给路径，模型需要时自己读。
 */
function attachmentLine(file: SceneMemoryFile): string {
  if (file.kind !== 'bundle') return ''
  const names = attachmentNamesSync(file.bundleDir, file.name)
  if (names.length === 0) return ''
  const shown = names.slice(0, ATTACHMENT_LIST_MAX)
  const more = names.length - shown.length
  return `附件目录：${file.bundleDir}（未注入正文，共 ${names.length} 个：${shown.join('、')}${more > 0 ? `，另 ${more} 个` : ''}）`
}

/**
 * 单条信息的渲染形态 —— **能一行就一行，但恒为列表项**。
 *
 *   单行且不长的正文 → `- **名称**（描述） — 正文`（与 MCP / 子智能体两个段的列表同形；无显式描述时括号不出现）
 *   多行或过长的正文 → `- **名称**（描述）` + 空行 + 缩进 2 格的正文（挂在条目下）
 *
 * 名称恒为标题：它就是这条记忆的身份（工具 id `<场景>/<名称>`、bundle 目录/文件名都以它为准），
 * 用户说「记忆里的 X」、模型再调 `memory_manager_*` 时都对得上号；显式描述是括号注解，不抢标题。
 *
 * 为什么全都做成列表项：早先多行正文走 `### 名称` 标题块，附件行只能退化成与记忆**同级**的
 * `- 附件目录：…`（没有父列表项可挂）—— 既可能被读成一条独立记忆，某些渲染器里还会把下一个
 * `###` 标题吞进列表（与上一条粘连）。统一成「一条记忆 = 一个列表项、正文与附件都缩进挂在
 * 条目下」后，两种记忆外观完全一致，归属也不再靠位置猜测。
 *
 * 为什么要分两种：用户常有十几条「一句话事实」（「提交格式：PDF」），每条都占标题 + 空行 +
 * 正文三行，整段会散成一长串标题；压成一行后十条信息就是十行。多行正文是**用户写的完整
 * Markdown**（可能自带标题、代码块、嵌套列表），整体缩进 2 格挂到条目下，结构原样保留。
 *
 * 返回值带 `inline`：调用方据此决定下一条记忆前要不要空行（单行条目连续排列，其余空行分隔）。
 */
function memoryBlock(file: SceneMemoryFile): { text: string; inline: boolean } {
  const desc = explicitDescriptionOf(file)
  // 加粗的只有名称：`- **名称**（描述） — 正文`，与 MCP 段 `- **server**（N 个工具） — …` 同形。
  const title = `**${file.name}**` + (desc === '' ? '' : `（${desc}）`)
  const text = String(file.body ?? '').trim()
  const inline = text === '' || (!text.includes('\n') && text.length <= INLINE_BODY_MAX)
  const head = text === ''
    ? `- ${title}`
    : (inline ? `- ${title} — ${text}` : `- ${title}\n\n${indentBody(text)}`)
  const attach = attachmentLine(file)
  if (attach === '') return { text: `${head}\n`, inline }
  // 附件行恒为缩进子项：只用 `- ` 会被解析成与记忆**同级**的列表项（`- A` / `- 附件目录：A的` /
  // `- B` … 四条平级，归属读不出来）。单行条目紧跟其后保持列表连续；多行条目前面空一行，
  // 免得被读成用户正文自己的列表项。
  return { text: inline ? `${head}\n  - ${attach}\n` : `${head}\n\n  - ${attach}\n`, inline }
}

/** 多行正文整体缩进 2 格（列在条目内容列上），空行保持空行、不加尾随空白。 */
const indentBody = (text: string): string => text
  .split('\n')
  .map((line) => (line === '' ? line : '  ' + line))
  .join('\n')

/** 括号注解用的显式描述：派生描述与正文重复、不进段（只存在于界面投影）；换行压成单行，避免把「一行一条」的列表项撑断。 */
const explicitDescriptionOf = (f: SceneMemoryFile): string => (
  f.descriptionDerived || !f.description ? '' : String(f.description).replaceAll(/\s+/g, ' ').trim()
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

  // ── 场景提示词（绑定预设正文；读盘、只读；写文件由 scene-prompt-sync.ts 负责）──
  //
  // 语义（用户裁定 2026-09-15）：
  //   - 场景可绑定**一个**提示词预设（`scenes[].prompt` → `prompts/<id>/AGENTS.md`）；
  //   - 除保留场景 `global` 外**同时只能启用一个场景**，所以同一时刻至多一份提示词在场；
  //   - 没有启用其它场景时才轮到 `global` 自己的绑定（它恒常生效，覆盖"永远在场的提示词"）；
  //   - 预设文件不存在 / 未绑定 → 返回 `''`（renderPrompt 会删掉空段，不产生空标题）。
  //
  // 为什么不用 fs.watch 也不用每请求读盘：段契约要求**同步返回**且逐字节稳定，
  // 因此按 `mtimeMs + size` 做一次 stat 缓存 —— 命中时零读盘，外部编辑器改了预设
  // 也会在下一个请求自动刷新（与记忆段的"两相扫描"同一哲学）。
  const promptFileCache = new Map<string, { key: string; text: string }>()

  /** 读一个预设正文（同步、带 stat 指纹缓存）；不存在返回 `''`。 */
  function readPresetTextSync(id: string): string {
    const file = join(stateDir, PRESETS_DIR, id, 'AGENTS.md')
    let key: string
    try {
      const st = statSync(file)
      if (!st.isFile()) return ''
      key = `${st.mtimeMs}:${st.size}`
    } catch {
      promptFileCache.delete(id)
      return ''
    }
    const cached = promptFileCache.get(id)
    if (cached && cached.key === key) return cached.text
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return '' }
    promptFileCache.set(id, { key, text })
    return text
  }

  /** 预设文件是否存在（同步；绑定前校验用，避免悬空绑定）。 */
  function presetExistsSync(id: string): boolean {
    try {
      return statSync(join(stateDir, PRESETS_DIR, id, 'AGENTS.md')).isFile()
    } catch {
      return false
    }
  }

  /**
   * 读当前 `~/.dsh/AGENTS.md`（同步、带 stat 指纹缓存）。
   * 用途只有一个：**去重**——绑定的预设与文件内容逐字节相同时不再注入第二遍正文。
   */
  let globalAgentsCache: { key: string; text: string } | null = null
  function readGlobalAgentsMdSync(): string {
    const file = join(resolveDshHome(), 'AGENTS.md')
    let key: string
    try {
      const st = statSync(file)
      if (!st.isFile()) return ''
      key = `${st.mtimeMs}:${st.size}`
    } catch {
      globalAgentsCache = null
      return ''
    }
    if (globalAgentsCache && globalAgentsCache.key === key) return globalAgentsCache.text
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return '' }
    globalAgentsCache = { key, text }
    return text
  }

  /**
   * 当前生效的场景提示词：启用场景的绑定优先，其次 `global` 的绑定；都没有 → `null`。
   * 「绑了但预设为空/已删」按没绑处理（不注入空段），继续找下一个。
   */
  function resolveScenePreset(): { scene: string; presetId: string; text: string } | null {
    const index = readIndexSync(stateDir)
    const names = Object.keys(index.scenes || {})
    const { active } = resolveActiveScenes(index, names)
    // 单选：取唯一一个非保留启用场景（resolveActiveScenes 已保证 ≤1，这里仍做确定性排序兜底）。
    const enabled = names
      .filter((n) => n !== SHARED_GROUP && n !== GLOBAL_SCENE && active.has(n))
      .sort((a, b) => sceneOrderOf(index, a) - sceneOrderOf(index, b) || a.localeCompare(b))
    for (const scene of enabled) {
      const id = index.scenes?.[scene]?.prompt
      if (!id) continue
      const text = readPresetTextSync(id)
      // 绑了但预设为空/已删 → 继续找下一个（不注入空段）。
      if (text.trim() === '') continue
      return { scene, presetId: id, text }
    }
    const globalId = index.scenes?.[GLOBAL_SCENE]?.prompt
    if (globalId) {
      const text = readPresetTextSync(globalId)
      if (text.trim() !== '') return { scene: GLOBAL_SCENE, presetId: globalId, text }
    }
    return null
  }

  /**
   * 当前生效的场景提示词（只读投影，界面用）：绑定内容与 `~/.dsh/AGENTS.md` 相同时标记
   * `duplicate` 且返回空段 —— 那份正文已经在基线里了，界面据此显示「生效中」。
   * （注入侧不看这个字段：预设挂不到 AGENTS.md 通道时照样要注入，见 `promptText`。）
   */
  function scenePrompt(): ScenePromptProjection {
    const found = resolveScenePreset()
    if (!found) return { scene: null, presetId: null, text: '', missing: false }
    const globalText = readGlobalAgentsMdSync().trim()
    if (globalText !== '' && found.text.trim() === globalText) {
      return { scene: found.scene, presetId: found.presetId, text: '', missing: false, duplicate: true }
    }
    return { scene: found.scene, presetId: found.presetId, text: found.text, missing: false }
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

  /**
   * 磁盘定位（bundle 优先）。返回规则文件与条目路径。
   * 根层（`group === ''`）**没有 bundle**：一级目录恒为场景（见 discover 的注释），
   * 否则 `memories/1/1.md`（场景 1 的 flat 记忆 1）会被这里读成根层 bundle「1」，
   * 与列表/注入两端不一致（编辑、删除都会落到错误的文件上）。
   */
  async function locateRule(group: string, name: string): Promise<DiscoveredEntry | null> {
    if (group !== '') {
      const bundleDir = join(rulesRoot, group, name)
      for (const candidate of [bundleDocName(name), LEGACY_BUNDLE_DOC]) {
        const bundleDoc = join(bundleDir, candidate)
        try {
          const st = await lstat(bundleDoc)
          if (st.isFile() && !st.isSymbolicLink()) {
            return { id: group ? `${group}/${name}` : name, group, name, kind: 'bundle', docPath: bundleDoc, entryPath: bundleDir }
          }
        } catch { /* 该候选名不存在 → 试下一个 */ }
      }
    }
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

  /**
   * 值含换行用 `|` 块（保留换行）；否则 `key: value` 原样（parseSkillDoc 按行贪婪解析）。
   * 例外：多行值里有去空白后恰为 `---` 的行时改用 JSON 引号标量 —— 块标量把内容行缩进
   * 两格也躲不开 parseSkillDoc 的 frontmatter 结束扫描（`trim() === '---'`），描述会被
   * 截断、残片混进正文；引号形式是单物理行，扫描无从误判，decodeYamlScalar 无损还原
   * （skills 写侧的引号标量正是靠这一点免疫同一断裂）。
   */
  function yamlField(key: string, value: string | boolean): string[] {
    if (typeof value === 'boolean') return [`${key}: ${value}`]
    const s = String(value)
    if (s.includes('\n')) {
      if (s.split('\n').some((line) => line.trim() === '---')) return [`${key}: ${JSON.stringify(s)}`]
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
    const enabledScene = enabledSceneOf(index)
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
        prompt: index.scenes?.[name]?.prompt || '',
        // 单选模型下"能不能点开"：已被别的场景占用时，这个开关要置灰。
        selectable: name !== SHARED_GROUP && name !== GLOBAL_SCENE && (enabledScene === null || enabledScene === name),
        locked: index.scenes?.[name]?.locked === true,
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
      // bundle 记忆附带附件摘要（用户裁定 2026-09-17）：界面要显示「几个附件」。
      // 每条 bundle 一次 readdirSync + 每个附件一次 statSync —— bundle 记忆通常只有几条，
      // 这个开销可以忽略；flat 没有目录，直接原样返回（不加字段 = 界面不显示附件标签）。
      .map((r) => {
        if (r.form !== 'bundle') return r
        const attach = attachmentSummarySync(dirname(r.path), r.name)
        return attach ? { ...r, attach } : r
      })
    const groups = groupFilter ? snap.groups.filter((g) => g.name === groupFilter) : snap.groups
    const scenes = sceneRows(snap, index)
    // 场景锁定状态（v0.8）：任意一个场景锁定 = 五个管理域整体冻结。界面据此禁用各页的写控件。
    const anyLocked = Object.values(index.scenes || {}).some((s) => s.locked === true)
    const projection = sceneMemory()
    const promptProjection = scenePrompt()
    return {
      ok: true,
      rules,
      // 对外契约（§7.1）用 key 标识分组；name 保留兼容内部引用。
      groups: groups.map((g) => ({ ...g, key: g.name })),
      // 场景 = 显式记录（含保留场景 global 与尚无记忆的空场景）；active = 是否参与注入。
      scenes,
      // 任一场景被锁定 = 五个管理域整体冻结（客户端据此禁用写控件；服务端 handlers 另有守卫）。
      anyLocked,
      activeMode: normalizeActive(index.active) === null ? 'all' : 'custom',
      // 单选模型：当前启用的那个场景（null = 只留 `_shared` 与 `global`）。
      activeScene: enabledSceneOf(index),
      sceneMemory: { usedBytes: projection.bytes, maxBytes: projection.maxBytes, truncated: projection.truncated, dropped: projection.dropped },
      // 当前生效的场景提示词（绑定的预设正文；与 ~/.dsh/AGENTS.md 一致时不重复注入）。
      // `label` 是给用户指路用的显示名（「去场景设置里改『全局』的绑定」）——`global`
      // 这类磁盘名直接甩给用户看没有意义。
      scenePrompt: {
        scene: promptProjection.scene,
        label: promptProjection.scene ? sceneLabel(promptProjection.scene, index) : null,
        presetId: promptProjection.presetId,
        missing: promptProjection.missing,
        duplicate: promptProjection.duplicate === true,
        bytes: Buffer.byteLength(promptProjection.text, 'utf8'),
      },
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
        attachments: entry.kind === 'bundle' ? await listAttachments(entry.entryPath, entry.name) : [],
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
      return fail('error.rules.sceneNotFound', `场景不存在：${targetGroup}（请先在「场景」页创建该场景）`, { group: targetGroup })
    }
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `记忆名非法：${name}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含 / \\ < > : " | ? *、不以 . 开头）`)
    // 目标已存在（bundle 或 flat 皆算）→ 拒绝，避免静默覆盖。
    // 用 exists 而不是 shadowed：后者说的是「同名 bundle 把 flat 遮蔽了」，用户看到
    // 「被同名 bundle 遮蔽」会去找一个并不存在的 bundle（2026-09-16 实测）。
    const existing = await locateRule(group, name)
    if (existing) {
      return fail('error.rules.exists', `同名记忆已存在（${existing.kind === 'bundle' ? 'bundle' : 'flat'}）：${existing.id}`)
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
      await writeFileAtomically(join(rulesRoot, targetGroup, name, bundleDocName(name)), text)
    } else {
      await mkdir(join(rulesRoot, targetGroup), { recursive: true })
      await writeFileAtomically(join(rulesRoot, targetGroup, name + '.md'), text)
    }
    // 更新索引（force 重读后合并，避免覆盖用户手工编辑）。
    // id 恒为 `<场景>/<名>`（与 parseId 同构）；场景记录此时必然已存在。
    const createdId = `${targetGroup}/${name}`
    const index = indexForScene
    // P5：新建记忆默认**不开启** —— 记忆的开关是单一真相源（`enabled`），
    // 用户裁定「创建的记忆默认不开启，在记忆页开启后对应的场景档案也要显示开启」。
    index.rules[createdId] = { order: DEFAULT_ORDER, enabled: false, updatedAt: new Date().toISOString() }
    if (!index.groups[targetGroup]) index.groups[targetGroup] = { order: DEFAULT_GROUP_ORDER, label: targetGroup }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
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
          // 与 rules-create 同落点：bundle = <场景>/<名>/ 目录，正文 <名>.md，附件平铺同层。
          const bundleDir = join(rulesRoot, item.group, item.name)
          await mkdir(bundleDir, { recursive: true })
          await writeFileAtomically(join(bundleDir, bundleDocName(item.name)), item.text)
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
      // P5：导入的记忆同样默认**不开启**（与 rules-create 同一口径）；已存在的条目保留原开关。
      index.rules[id] = { ...(entry || {}), order: entry?.order ?? DEFAULT_ORDER, enabled: entry?.enabled ?? false, updatedAt: new Date().toISOString() }
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
    // 形态转换 / 改名：先建新形态文件，再把旧形态复制进回收站、最后删原件
    // （确保任意失败点不产生半份规则；旧形态随时可恢复，README「删除都进回收站」无例外）。
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
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
      await rm(located.entryPath, { recursive: true, force: true })
    } else if (located.kind === 'flat' && newForm === 'bundle') {
      await mkdir(join(rulesRoot, parts.group, newName), { recursive: true })
      await writeFileAtomically(join(rulesRoot, parts.group, newName, bundleDocName(newName)), serialize())
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
      await rm(join(rulesRoot, parts.group, parts.name + '.md'), { force: true })
    } else if (located.kind === 'flat' && newName !== parts.name) {
      // flat 改名 = 文件改名
      await writeFileAtomically(join(rulesRoot, parts.group, newName + '.md'), serialize())
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
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
    return { ok: true, rule: await buildProjected(newId) }
  }

  /**
   * 把条目原件复制进 memories 回收站并写 manifest，返回 trashId。只复制、不删除：
   * 原件的 rm 由调用方在复制成功后执行 —— 先有副本才允许删，rm 永远不会销毁唯一数据。
   * manifest 先于原件删除落盘：中途崩溃最坏留下「原件还在 + 一份完整回收站副本」，
   * 不会出现「有文件没清单」的损坏条目。
   */
  async function copyIntoMemoriesTrash(located: DiscoveredEntry, group: string, name: string): Promise<string> {
    const trashId = Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
    const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    const manifest = { group, name, form: located.kind, deletedAt: new Date().toISOString() }
    await mkdir(trashDir, { recursive: true })
    if (located.kind === 'bundle') {
      const { cp } = await import('node:fs/promises')
      await cp(located.entryPath, join(trashDir, 'bundle'), { recursive: true })
    } else {
      await copyFile(located.docPath, join(trashDir, 'rule.md'))
    }
    await writeFileAtomically(join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return trashId
  }

  async function rulesRemove(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    const trashId = await copyIntoMemoriesTrash(located, parts.group, parts.name)
    if (located.kind === 'bundle') await rm(located.entryPath, { recursive: true, force: true })
    else await rm(located.docPath, { force: true })
    const index = await readIndex(stateDir)
    delete index.rules[id]
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, trashId }
  }

  async function rulesRestore(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
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
      return fail('error.rules.exists', `同名记忆已存在：${conflict.id}，请先移除后再恢复`)
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
    return { ok: true, rule: await buildProjected(manifest.group ? `${manifest.group}/${manifest.name}` : manifest.name) }
  }

  /** trashId 只由本插件生成（时间戳 base36 + uuid 前 8 位）：严格白名单，杜绝路径穿越。 */
  function isValidTrashId(trashId: string): boolean {
    return /^[a-z0-9]+-[a-z0-9]{1,32}$/i.test(trashId)
  }

  /**
   * 记忆回收站列表（只读）：`<stateDir>/memories-trash/<trashId>/`（`rulesRemove` 移入，
   * `rulesRestore` 恢复）。损坏或内容缺失的条目跳过，不让一个坏条目挡住整份列表。
   */
  async function rulesTrashList(): Promise<any> {
    const root = join(stateDir, MEMORIES_TRASH_DIR)
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
          const bundleDoc = form === 'bundle'
            ? join(dir, 'bundle', bundleDocName(manifest.name))
            : join(dir, 'rule.md')
          bytes = (await stat(bundleDoc)).size
        } catch {
          // 兼容旧回收站条目（正文仍叫 SKILL.md）；仍读不到就按 0 计，恢复时由 rulesRestore 兜底报错。
          if (form === 'bundle') {
            try { bytes = (await stat(join(dir, 'bundle', LEGACY_BUNDLE_DOC))).size } catch { /* 内容缺失 */ }
          }
        }
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
    const dir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory()) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }

  /** bundle 目录下的附件（顶层普通文件，排除正文 `<名>.md`，兼容旧数据 `SKILL.md`）；不存在/不可读返回空数组。 */
  async function listAttachments(bundleDir: string, name: string): Promise<Array<{ name: string; size: number }>> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(bundleDir, { withFileTypes: true })
    } catch {
      return []
    }
    const docNames = new Set([bundleDocName(name), LEGACY_BUNDLE_DOC])
    const out: Array<{ name: string; size: number }> = []
    for (const entry of entries) {
      if (docNames.has(entry.name)) continue
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
    const docNames = new Set([bundleDocName(located.name), LEGACY_BUNDLE_DOC])
    for (const file of files) {
      const name = String((file && (file.path || file.name)) || '')
      if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
      if (docNames.has(name)) return fail('error.rules.invalidName', `附件名不能与正文文件同名：${name}`)
      const data = Buffer.from(String((file && file.data) || ''), 'base64')
      if (data.length === 0) return fail('error.rules.emptyFile', `附件内容为空：${name}`)
      if (data.length > MAX_ATTACH_ENTRY_BYTES) return fail('error.rules.fileTooLarge', `附件过大：${name}（单个上限 ${MAX_ATTACH_ENTRY_BYTES >> 20} MiB）`, { limit: MAX_ATTACH_ENTRY_BYTES >> 20 })
      total += data.length
      if (total > MAX_ATTACH_TOTAL_BYTES) return fail('error.rules.tooLarge', `附件总大小超过 ${MAX_ATTACH_TOTAL_BYTES >> 20} MiB`, { limit: MAX_ATTACH_TOTAL_BYTES >> 20 })
      pending.push({ name, data })
    }
    for (const file of pending) await writeFileAtomicBinary(join(located.entryPath, file.name), file.data)
    return { ok: true, attachments: await listAttachments(located.entryPath, located.name) }
  }

  /** 删除 bundle 记忆的一个附件；正文 `<名>.md`（或旧数据 `SKILL.md`）不可删。 */
  async function rulesDetach(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    if (located.kind !== 'bundle') return fail('error.rules.notBundle', `「${parts.name}」是 flat（单文件），没有附件`)
    const name = String((args && args.name) || '')
    if (!isValidGroupSegment(name) || name === bundleDocName(located.name) || name === LEGACY_BUNDLE_DOC) {
      return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
    }
    const target = join(located.entryPath, name)
    try {
      const st = await lstat(target)
      if (!st.isFile() || st.isSymbolicLink()) return fail('error.rules.notFound', `附件不存在：${name}`)
    } catch {
      return fail('error.rules.notFound', `附件不存在：${name}`)
    }
    await rm(target, { force: true })
    return { ok: true, attachments: await listAttachments(located.entryPath, located.name) }
  }

  async function rulesToggle(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    // `enabled` 必须显式给。缺省时旧实现回落到"沿用当前值"，却照样刷新
    // updatedAt 并返回 ok:true —— 调用方按 toggle（翻转）理解时会以为自己改了
    // 状态，实际什么都没改（界面不受影响：它一直显式传值）。与 rulesSetActive
    // 同一条口径：参数缺失就明确拒绝，不猜。
    if (typeof (args && args.enabled) !== 'boolean') {
      return fail('error.rules.invalidArgs', '缺少参数：enabled 必须是布尔值（toggle 只按传入值写入，不做"翻转"推断）')
    }
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const enabled = args.enabled === true
    index.rules[id] = { ...idxEntry, enabled, updatedAt: new Date().toISOString() }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(id) }
  }

  /**
   * 设置"启用场景"（全局持久化，切换后**下一个请求即生效**，§4 对照表）。
   *   - `args.scenes` 数组 → 启用集合；**至多一个非保留场景**（用户裁定：除「全局」外
   *     同时只能启用一个），`[]` = 全部关闭（只留恒常的 `_shared` 与 `global`）
   *   - `args.all === true` → 旧的"全部启用"形态，与新模型冲突，明确拒绝（不猜）
   * 场景名按放宽后的规则校验；不存在的场景名也允许保存（目录随后创建即可生效）。
   */
  async function rulesSetActive(args: any): Promise<any> {
    // 参数必须显式二选一。旧实现把「没传参数」「传了未知参数名」都落进 else 分支、
    // 用空数组覆盖 active，于是 `rules-set-active {}` 会静默把模式切成 custom 且零激活场景
    // （用户以为自己只是"没改动"，实际已经改了注入范围）。这里显式拒绝。
    const hasAll = !!(args && args.all === true)
    const hasScenes = Array.isArray(args && args.scenes)
    if (!hasAll && !hasScenes) {
      return fail('error.rules.invalidArgs', '缺少参数：需要 scenes:[...]（启用集合，至多一个场景）')
    }
    if (hasAll) {
      return fail('error.rules.singleSceneOnly', '除「全局」外同时只能启用一个场景：不支持"全部启用"，请改用 scenes:[<场景名>] 或 scenes:[]（全部关闭）', { detail: '：不支持"全部启用"，请改用 scenes:[<场景名>] 或 scenes:[]（全部关闭）' })
    }
    const index = await readIndex(stateDir)
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
    if (names.length > 1) {
      return fail('error.rules.singleSceneOnly', `除「全局」外同时只能启用一个场景（收到 ${names.length} 个：${names.join('、')}）`, { detail: `（收到 ${names.length} 个：${names.join('、')}）` })
    }
    index.active = names
    await writeIndex(stateDir, index)
    invalidateSnapshot()
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
    const prompt = args && args.prompt !== undefined ? normalizeScenePromptId(args.prompt) : undefined
    if (prompt === null) {
      return fail('error.rules.invalidGroup', `提示词预设 id 非法：${String(args.prompt)}（仅小写字母/数字/连字符，且不能是备份槽）`)
    }
    await ensureLayout()
    try {
      await mkdir(join(rulesRoot, name), { recursive: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `创建场景目录失败：${message(e)}`)
    }
    const index = await readIndex(stateDir)
    // **新场景默认不启动**：先把历史默认（active=null=全部启用）收敛成显式集合，
    // 新建的这个自然不在其中；收敛后仍是"至多一个场景启用"。
    const collapsed = collapseActiveForNewScene(index)
    if (!index.scenes) index.scenes = {}
    const prev = index.scenes[name] || {}
    const next: SceneIndexEntry = {
      ...prev,
      ...(label !== '' && name !== GLOBAL_SCENE ? { label } : {}),
      ...(description !== '' ? { description } : {}),
      ...(prompt !== undefined && prompt !== '' ? { prompt } : {}),
      order: prev.order ?? DEFAULT_GROUP_ORDER,
      createdAt: prev.createdAt ?? new Date().toISOString(),
    }
    if (name === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[name] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, scene: sceneRecordOf(name, next), ...(collapsed ? { collapsedActive: true } : {}) }
  }

  /**
   * 更新场景记录（描述 / 显示名 / 顺序 / 绑定的提示词预设），**可选改名**（nextName）。
   *
   * 场景名就是它的一级目录名（`memories/<场景>/…`），所以改名不是改一个字段：
   *   ① 目录 `memories/<旧>` → `memories/<新>`；
   *   ② 索引里的四处引用一起改：`scenes` 记录、`archives` 档案、`active` 启用集合、`mode.scene`。
   * 记忆正文一个字节都不动（只是换了所在目录名）。
   *
   * 拒绝的三种情况：保留场景 `global` / `_shared`；目标名已被占用（目录或记录）；
   * 该场景正在当前模式里——模式快照是按场景名算的，改了名与快照就对不上（同删除的处理）。
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
    if (args && args.prompt !== undefined) {
      const prompt = normalizeScenePromptId(args.prompt)
      if (prompt === null) {
        return fail('error.rules.invalidGroup', `提示词预设 id 非法：${String(args.prompt)}（仅小写字母/数字/连字符，且不能是备份槽）`)
      }
      // 绑定前校验预设确实存在：宁可现在拒绝，也不要留一个永远注入不出东西的悬空绑定。
      if (prompt !== '' && !presetExistsSync(prompt)) {
        return fail('error.rules.notFound', `提示词预设不存在：${prompt}`)
      }
      if (prompt === '') delete next.prompt
      else next.prompt = prompt
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
    // ── 改名（可选）：目录 + 索引里的四处引用一起动 ──
    let finalName = name
    const nextRaw = args && args.nextName !== undefined ? String(args.nextName).trim() : ''
    if (nextRaw !== '' && nextRaw !== name) {
      if (!isValidGroupSegment(nextRaw)) {
        return fail('error.rules.invalidGroup', `新场景名非法：${nextRaw}（非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）`)
      }
      if (name === GLOBAL_SCENE) return fail('error.rules.reservedScene', '「全局」是保留场景，不可改名', { name: GLOBAL_SCENE, action: 'rename', reason: '' })
      if (name === SHARED_GROUP || nextRaw === SHARED_GROUP) return fail('error.rules.invalidGroup', '_shared 是保留场景名，不可改名')
      if ((index.scenes && index.scenes[nextRaw]) || (await pathExists(join(rulesRoot, nextRaw)))) {
        return fail('error.rules.nameTaken', `目标场景名已被占用：${nextRaw}`)
      }
      if (index.mode && index.mode.scene === name) {
        return fail('error.rules.sceneInMode', `场景「${name}」正处在当前模式，请先退出模式再改名`)
      }
      const fromDir = join(rulesRoot, name)
      const toDir = join(rulesRoot, nextRaw)
      let movedDir = false
      if (await pathExists(fromDir)) {
        try {
          await rename(fromDir, toDir)
          movedDir = true
        } catch (e) {
          return fail('error.rules.ioFailed', `场景目录改名失败：${message(e)}`)
        }
      }
      // 目录已经搬过去了：索引这一步失败就必须把目录搬回来，否则目录名与索引各说各话。
      try {
        const scenes = index.scenes || {}
        if (scenes[name]) {
          scenes[nextRaw] = scenes[name]
          delete scenes[name]
        } else {
          scenes[nextRaw] = { order: DEFAULT_GROUP_ORDER, createdAt: new Date().toISOString() }
        }
        index.scenes = scenes
        if (index.archives && index.archives[name]) {
          index.archives[nextRaw] = index.archives[name]
          delete index.archives[name]
        }
        const act = normalizeActive(index.active)
        if (act !== null && act.indexOf(name) >= 0) index.active = act.map((n) => (n === name ? nextRaw : n))
        if (index.mode && index.mode.scene === name) index.mode = { ...index.mode, scene: nextRaw }
      } catch (e) {
        if (movedDir) {
          try { await rename(toDir, fromDir) } catch { /* 回滚失败：错误信息里如实带上原因 */ }
        }
        return fail('error.rules.ioFailed', `场景改名后索引更新失败：${message(e)}`)
      }
      finalName = nextRaw
    }

    if (finalName === GLOBAL_SCENE) next.label = GLOBAL_SCENE_LABEL
    index.scenes[finalName] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return {
      ok: true,
      ...(finalName === name ? {} : { renamedFrom: name }),
      scene: sceneRecordOf(finalName, next),
    }
  }

  /**
   * 场景锁定（v0.8）：锁定后五个管理域（MCP/技能/子智能体/记忆/提示词）整体只读 ——
   * 场景页的档案编辑与功能页的启停/编辑都被拒（index.ts 的 handlers 守卫 + 界面禁用），
   * 场景自身的启停（进/退模式）不受影响。`locked` 必须显式给布尔值（与 rules-toggle 同一口径）。
   * 保留场景 `global` 不在场景页出现，不可锁。
   */
  async function rulesSceneLock(args: any): Promise<any> {
    const name = String((args && args.scene) || '').trim()
    if (!isValidGroupPath(name)) return fail('error.rules.invalidGroup', `场景名非法：${name || '(空)'}`)
    if (name === GLOBAL_SCENE || name === SHARED_GROUP) return fail('error.rules.reservedScene', '「全局 / _shared」是保留场景，不可锁定', { name: '全局 / _shared', action: 'lock', reason: '' })
    if (typeof (args && args.locked) !== 'boolean') {
      return fail('error.rules.invalidArgs', '缺少参数：locked 必须是布尔值（只按传入值写入，不做"翻转"推断）')
    }
    const index = await readIndex(stateDir)
    if (!index.scenes || !index.scenes[name]) return fail('error.rules.notFound', `场景不存在：${name}`)
    // 未启动的场景不能上锁（用户裁定）：锁定的意义是冻结**运行中**场景的配置。
    // 解锁随时允许 —— 否则退出模式后，被锁的场景就没人能解了。
    if (args.locked === true && (!index.mode || index.mode.scene !== name)) {
      return fail('error.rules.sceneNotActive', `场景「${name}」未启动：先启动再锁定`)
    }
    index.scenes[name] = { ...index.scenes[name], locked: args.locked === true }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, scene: name, locked: args.locked === true }
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
    if (name === GLOBAL_SCENE) return fail('error.rules.reservedScene', `「全局」是保留场景，不可删除（它的记忆对任何对话都生效）`, { name: GLOBAL_SCENE, action: 'delete', reason: '（它的记忆对任何对话都生效）' })
    const index = await readIndex(stateDir)
    // 场景不存在（既无记录也无目录）→ 明确报错，而不是假装删成功。
    if (!index.scenes?.[name] && !(await pathExists(join(rulesRoot, name)))) {
      return fail('error.rules.notFound', `场景不存在：${name}`)
    }
    // 当前模式场景不可删：快照只在引擎里可退（rules service 反向注入会成环），
    // 直接删除会让运行时启停永久停在档案态且无恢复路径 → 给出可逆出路（先退出模式）。
    if (index.mode?.scene === name) {
      return fail('error.rules.sceneInMode', `场景「${name}」正处在当前模式，请先退出模式再删除`)
    }
    // 删除场景 = **连它下面的全部记忆一起去掉**（用户裁定）：不管有没有启用、是不是子目录、
    // 是不是 bundle 附件，统统收走。
    // 但一律**先移入回收站**（与场景记录、档案装在同一条条目里），所以「删错了」还能整条恢复：
    // 记忆文件按原来的相对路径放回，场景记录与档案也一起回来。
    const sceneDir = join(rulesRoot, name)
    const moves: Array<{ from: string; dest: string }> = []
    const collect = async (abs: string, rel: string): Promise<void> => {
      let items: import('node:fs').Dirent[] = []
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch {
        return   // 目录不存在（只有记录的场景）或读不了 → 当作没有文件
      }
      for (const item of items) {
        const childAbs = join(abs, item.name)
        const childRel = rel === '' ? item.name : `${rel}/${item.name}`
        if (item.isDirectory()) await collect(childAbs, childRel)
        else moves.push({ from: childAbs, dest: childRel })
      }
    }
    await collect(sceneDir, '')
    const trashed = await moveToTrash('scenes', name, moves, {
      record: (index.scenes && index.scenes[name]) || null,
      archive: (index.archives && index.archives[name]) || null,
      memories: moves.map((m) => m.dest),
    })
    if (trashed.ok === false) {
      return fail('error.rules.ioFailed', `移入回收站失败：${trashed.error}`)
    }
    try {
      // 文件已搬空，剩下的只是空子目录；recursive + force 一并清掉。
      await rm(sceneDir, { recursive: true, force: true })
    } catch (e) {
      // 目录没清掉就把记忆放回去：宁可整个操作失败，也不要「文件在回收站、场景还留在列表里」。
      for (const move of moves) {
        try { await moveOutOfTrash('scenes', trashed.id, move.dest, move.from) } catch { /* 尽力而为 */ }
      }
      try { await purgeTrashEntry('scenes', trashed.id) } catch { /* 同上 */ }
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
    return { ok: true, name, trashId: trashed.id, movedFiles: moves.length }
  }

  /** 场景回收站列表（只读）：`<hub>/trash/scenes-trash/<id>/manifest.json`。 */
  async function sceneTrashList(): Promise<any> {
    return { ok: true, trash: await listTrashEntries('scenes') }
  }

  /**
   * 从回收站恢复一个场景：重建记忆目录 + 写回记录与档案。
   * 同名场景已存在时**拒绝**（绝不覆盖既有场景）。
   */
  async function sceneTrashRestore(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const entry = await readTrashEntry('scenes', id)
    if (!entry) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    const name = String(entry.name || '').trim()
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidGroup', `回收站里的场景名非法：${name || '(空)'}`)
    const index = await readIndex(stateDir)
    if (index.scenes?.[name]) return fail('error.rules.invalidGroup', `无法恢复，同名场景已存在：${name}`)
    const dir = join(rulesRoot, name)
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { entries = [] }
    if (entries.filter((n) => !n.startsWith('.')).length > 0) {
      return fail('error.rules.sceneNotEmpty', `无法恢复，记忆目录「${name}」里已有内容，请先处理`)
    }
    const data = (entry.data || {}) as { record?: unknown; archive?: unknown; memories?: unknown }
    try {
      await mkdir(dir, { recursive: true })
    } catch (e) {
      return fail('error.rules.ioFailed', `重建场景目录失败：${message(e)}`)
    }
    // 删除场景时一起收进回收站的记忆文件：按原来的相对路径放回（目录已确认是空的，不会覆盖）。
    const files = Array.isArray(entry.files) ? entry.files : []
    const restored: string[] = []
    for (const rel of files) {
      try {
        await moveOutOfTrash('scenes', id, String(rel), join(dir, String(rel)))
        restored.push(String(rel))
      } catch (e) {
        return fail('error.rules.ioFailed', `恢复记忆文件失败（已放回 ${restored.length}/${files.length}）：${message(e)}`)
      }
    }
    if (data.record && typeof data.record === 'object') index.scenes = { ...(index.scenes || {}), [name]: data.record as SceneIndexEntry }
    if (data.archive && typeof data.archive === 'object') index.archives = { ...(index.archives || {}), [name]: data.archive as SceneArchive }
    await writeIndex(stateDir, index)
    await purgeTrashEntry('scenes', id)
    invalidateSnapshot()
    return { ok: true, name, restoredFiles: restored.length }
  }

  /** 永久删除一条场景回收站条目。 */
  async function sceneTrashDelete(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    const gone = await purgeTrashEntry('scenes', id)
    if (!gone) return fail('error.rules.notFound', `回收站条目不存在：${id}`)
    return { ok: true, id }
  }

  /**
   * 提示词预设改名后**同步场景绑定**：把所有 `scenes[].prompt === from` 改成 `to`。
   * 由 AGENTS.md 预设库的改名路径调用——绑定存在 `memories-index.json` 里，预设库
   * 自己看不到它，不叫这一声改名就会留下悬空绑定（场景卡片显示「预设不存在」）。
   * @returns 改了几个场景。
   */
  async function rulesRebindPrompt(args: any): Promise<any> {
    const from = String((args && args.from) || '').trim()
    const to = String((args && args.to) || '').trim()
    if (!from || !to) return fail('error.rules.invalidArgs', '需要 from 与 to 两个预设 id')
    const index = await readIndex(stateDir)
    const scenes = index.scenes || {}
    let changed = 0
    for (const [name, entry] of Object.entries(scenes)) {
      if (entry && entry.prompt === from) { scenes[name] = { ...entry, prompt: to }; changed++ }
    }
    if (changed) {
      index.scenes = scenes
      await writeIndex(stateDir, index)
      invalidateSnapshot()
    }
    return { ok: true, from, to, changed }
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
    return { ok: true, rule: await buildProjected(id) }
  }

  // ── 组装 ─────────────────────────────────────────────────────────────────

  // 注入文本出口（2026-09-16 第四版）。
  //
  // 历史：本服务先后把场景记忆做成"系统提示词段"（会被 persona complete 压掉）与
  // "写 AGENTS.md 文件"（预设不挂 dsh-agent-instructions 时到不了模型）。现在两条都交给
  // 注入通道（src/context-inject.ts）：每个 step 前把文本并进一条注入消息，任何预设都到得了。
  // 这里只留**同步取文本**的两个出口，注册/生命周期由 index.ts 的注入器统一管。
  //
  //   - `memoryText`：场景记忆段（记忆正文；`''` = 没有可注入的内容）。
  //   - `promptText`：全局提示词正文 = 场景期间用场景提示词、平时用 AGENTS.md 正文。
  //     **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
  //     （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
  const memoryText = (): string => sceneMemory().text
  /**
   * `~/.dsh/AGENTS.md` 正文的上限，与官方那一行的 `maxBytes` 同量级（64 KiB）：超大文件按字节
   * 截断并留一行标记，免得一份手写的巨型基线把上下文撑爆。
   */
  const AGENTS_MD_MAX_BYTES = 65536
  /**
   * DSH home 的**展示形态**，规则与官方 `dsh-home-paths` 的 `dshHomeDisplay()` 一致
   * （`dsh-home-paths/lib/index.js:93`）：默认位置显示 `~/.dsh`，被 `DSH_HOME` 指到别处时
   * 才显示 `$DSH_HOME`。只在给**界面**看的字符串里用 —— 读盘一律用真实路径。
   */
  const dshHomeDisplay = (): string => {
    const home = resolveDshHome()
    return resolve(home) === resolve(join(homedir(), '.dsh')) ? '~/.dsh' : '$DSH_HOME'
  }
  /**
   * 当前生效的提示词：**来源文件 + 正文**，一次解析、两处出口共用（模型侧 `promptText`、
   * 界面清单 `promptFiles`）。`null` = 现在没有提示词。
   *
   * 为什么合并成一处：两条出口必须给出**同一个**结论（文件是哪个、正文取哪份），分开写两份
   * 同样的分支判断迟早分叉 —— 分叉的后果就是界面标错文件、或模型看到与文件不符的正文。
   * 合并前那里已经有一处小分叉：场景预设在场但正文为空时，文本退回 AGENTS.md、清单却仍报
   * 预设路径。现在两边同源，这类角落不可能再各说各话。
   *
   * `digest` 照抄官方 `instructionContentSha1`（`dsh-agent-instructions/lib/index.js:90`，
   * sha1 hex）：算的是**文件内容**（AGENTS.md 取截断前的原文），是"文件这一版"的身份，
   * 不是"这次注入了什么"；界面只拿它当悬停提示，不参与任何判定。
   *
   * `text` 是**模型侧**正文，开头一行 `来源：<展示路径>` —— 照抄官方 agent-instructions 的
   * 写法（`Instructions from: <path>`，`render.js` 的 `sectionText`）。模型据此知道这些规则
   * 写在哪个文件里：用户说"把这条记下来"时它知道该改哪份文件，而不是只能凭印象回答。
   */
  const resolvePrompt = (): { path: string; digest: string; text: string } | null => {
    // 场景提示词与 AGENTS.md 正文在用户眼里就是同一件事（"全局提示词"）：场景期间前者取代后者，
    // 与官方语义一致（进场景改写文件、退出恢复）。所以一个域、一份文本，取到非空的场景提示词就用它。
    const scene = resolveScenePreset()
    if (scene && scene.text.trim() !== '') {
      const path = `${dshHomeDisplay()}/${HUB_DIR}/${PRESETS_DIR}/${scene.presetId}/AGENTS.md`
      return {
        path,
        digest: createHash('sha1').update(scene.text).digest('hex'),
        text: `来源：${path}\n\n${scene.text}`,
      }
    }
    const raw = readGlobalAgentsMdSync()
    if (raw.trim() === '') return null
    const path = `${dshHomeDisplay()}/AGENTS.md`
    const body = Buffer.byteLength(raw, 'utf8') <= AGENTS_MD_MAX_BYTES
      ? raw
      : Buffer.from(raw, 'utf8').subarray(0, AGENTS_MD_MAX_BYTES).toString('utf8') +
        `\n\n（…文件超过 ${Math.floor(AGENTS_MD_MAX_BYTES / 1024)} KiB，已截断。）`
    return { path, digest: createHash('sha1').update(raw).digest('hex'), text: `来源：${path}\n\n${body}` }
  }
  /**
   * 模型侧的提示词正文（`''` = 没有可注入的内容）。
   *
   * **不判"与文件重复"** —— 预设挂了官方 agent-instructions 时那份正文已经由文件送达
   * （注入侧会跳过整个域），没挂时（极简）才需要注入兜底；判定在注入器的 `selectInjections` 里。
   */
  const promptText = (): string => resolvePrompt()?.text ?? ''
  /**
   * `promptText()` 的**来源文件**（同步）：注入通道把它当作 instructions 形态的
   * `changes` 交给界面（文件清单 + 已载入/已更新），见 context-inject.ts 的 `files`。
   * 与文本同源（都走 `resolvePrompt`），所以两边不会分叉；`[]` = 无正文。
   *
   * 路径用**展示形态**（见 `dshHomeDisplay`）：界面里官方 agent-instructions 那条行写的是
   * `~/.dsh/AGENTS.md`，我们写绝对路径的话，同一个界面上会出现两种风格。
   */
  const promptFiles = (): Array<{ path: string; digest: string }> => {
    const resolved = resolvePrompt()
    return resolved === null ? [] : [{ path: resolved.path, digest: resolved.digest }]
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
    'rules-set-index', 'rules-set-active', 'rules-create-scene', 'rules-update-scene', 'rules-remove-scene', 'rules-rebind-prompt',
    'rules-scene-lock',
    'rules-attach', 'rules-detach', 'rules-trash-remove',
    // 场景回收站（与记忆回收站 rules-trash-* 分开：那套管记忆正文，这套管场景记录与档案）
    'scene-trash-restore', 'scene-trash-delete',
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
    'rules-scene-lock': (args) => runWrite(() => rulesSceneLock(args || {})),
    'rules-remove-scene': (args) => runWrite(() => rulesRemoveScene(args || {})),
    'scene-trash-list': () => sceneTrashList(),
    'scene-trash-restore': (args) => runWrite(() => sceneTrashRestore(args || {})),
    'scene-trash-delete': (args) => runWrite(() => sceneTrashDelete(args || {})),
    'rules-rebind-prompt': (args) => runWrite(() => rulesRebindPrompt(args || {})),
  }

  const service: RulesService = {
    ops,
    writeOps,
    memoryText,
    promptText,
    promptFiles,
    refresh,
    patchIndex,
    readArchiveSlice,
  }
  return service
}
