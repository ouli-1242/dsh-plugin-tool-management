// dsh-plugin-tool-management —— AGENTS.md 预设库 + 切换 服务层。
//
// DSH 全局指令基线只有一个文件 ~/.dsh/AGENTS.md（USER_GLOBAL_FILE 固定），
// 没有内置的「多份全局 AGENTS.md 切换」机制。本服务在 hub 内维护一个
// 预设库（每套一个子目录 + AGENTS.md），「应用」= 把选中预设内容写入
// ~/.dsh/AGENTS.md，下一轮对话生效（宿主每个 agent/pre-step 都会 stat 并重读该文件）。
//
// id 即目录名：字符集口径见 `./preset-id.ts`（用户裁定「什么都能写」，只留
// 文件系统安全约束）；`__last-applied__` 是备份槽，不算用户预设。
// 「当前生效」（`active`）靠比对 ~/.dsh/AGENTS.md 的 sha256 与各预设 sha256 推断 ——
// 用户手改全局文件也能如实反映。但那只能回答「内容一不一样」，回答不了「这份文件是
// 从哪个预设来的」：手改一次之后 `active` 全为 false，模型侧列表就只剩空（或被迫
// 全列，白烧上下文）。所以另记一份 `__applied__.json`（只记「最近一次应用的是谁」），
// 两个事实分开报：`active` = 内容逐字节相同；`lastApplied` = 最近一次应用写入的是它。
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isValidPresetId, LAST_APPLIED_PRESET_ID, normalizePresetId } from './preset-id.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry, type TrashEntry } from '../hub.js'

const FILENAME = 'AGENTS.md'
/** 描述侧车：与 AGENTS.md 同目录，避免描述的文字被当成提示词正文注入。 */
const META_FILE = 'meta.json'
/**
 * 预设描述的字数上限。界面上那两枚输入框（提示词页的新建 / 编辑弹窗）用同一个数当
 * `maxLength` 与字数计数的分母，客户端镜像在 `42-shared-ui.js` 的 `PRESET_DESC_MAX`
 * —— 改这里要一起改它。
 *
 * 为什么需要它（0.14.0）：描述此前是"只给使用者看"的，一个字都不进模型上下文，所以没有
 * 上限也说得过去。现在 `prompt_manager_list` 会把它打给模型（否则模型无法在预设之间做
 * 选择），它就成了**常驻成本**，必须有个预算。300 与 MCP 备注同数（那一条也是"给模型看的
 * 一句用户提示"），但那是两个各自独立的预算，别当成同一个常量共用。
 */
export const DEFAULT_PRESET_DESC_MAX_LENGTH = 300

/**
 * 压成一行并按上限截断。与 `normalizeMcpNote`（`../mcp/state-section.ts`）同形：两处都是
 * "给模型看的一句用户文字"，口径必须一致，否则同一句在界面、段、工具里会是三个样子。
 */
export function normalizePresetDescription(value: unknown, maxLength = DEFAULT_PRESET_DESC_MAX_LENGTH): string {
  const flat = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 3)}...`
}
const LAST_APPLIED_ID = LAST_APPLIED_PRESET_ID
/**
 * 「最近一次应用」的记录侧车。是**文件**不是目录，所以 `list()` / `ensureInit()` 的
 * `isDirectory()` 过滤天然把它排除在预设之外。
 */
const APPLIED_FILE = '__applied__.json'
/** 新建预设的初始正文（空模板）；用户也可以直接粘贴自己的内容。 */
const BLANK_TEMPLATE = '# AGENTS.md\n\n（DSH 全局指令基线预设，待编辑）\n'
/** 全局 AGENTS.md 的备份代际上限：与 mcpm patch 的 KEEP_PATCH_BACKUPS 同纪律。 */
const KEEP_GLOBAL_BACKUPS = 5

export interface PromptsDeps {
  /** 预设库根目录（已解析的绝对路径）。 */
  presetsDir: string
  /** 解析当前 DSH 全局 AGENTS.md 的绝对路径（~/.dsh/AGENTS.md）。 */
  getGlobalAgentsMdPath: () => Promise<string>
}

export interface PromptPresetRow {
  id: string
  /** 内容逐字节等于当前 ~/.dsh/AGENTS.md（真·生效）。 */
  active: boolean
  /**
   * 最近一次「应用」写入的是这个预设 —— 但全局文件之后可能被手改过（此时 `active` 为 false）。
   * 有它，模型侧列表在手改之后仍能给出「这份文件从哪来」，而不必退化成全列。
   */
  lastApplied?: boolean
  /**
   * 一句话说明。存 `<id>/meta.json`，**绝不写进 AGENTS.md**（正文会被原样注入）。
   *
   * 0.14.0 起**模型也看得到**：`prompt_manager_list` 会把它打出来（否则模型无法在预设之间
   * 做选择）。原先这里写的是「只给使用者看」，那句话从这一刻起不成立了 —— 所以它同时有了
   * 字数上限（见 `DEFAULT_PRESET_DESC_MAX_LENGTH`）。
   */
  description?: string
}

export interface PromptsService {
  list(): Promise<{ ok: true; presets: PromptPresetRow[] } | { ok: false; error: string }>
  read(id: string): Promise<{ ok: true; content: string } | { ok: false; error: string }>
  create(id: string, options?: { from?: string; content?: string; description?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /**
   * 保存预设：正文必写；`nextId` 与 `id` 不同时**改名（= 目录改名）**。
   * `description` 省略 = 不动描述（区分「清空」与「不改」，见 writeDescription）。
   * @returns 改名时带回 `renamedFrom`，调用方据此把场景绑定一起改名。
   */
  update(id: string, content: string, nextId?: string, description?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }>
  apply(id: string): Promise<{ ok: true; id: string; backedUp: boolean } | { ok: false; error: string }>
  /** 按原文写回全局基线（备份纪律同 apply）；用于场景关闭时恢复进场景前的内容。 */
  restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }>
  getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; exists: boolean } | { ok: false; error: string }>
  remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /** 回收站：列出 / 恢复 / 永久删除（删除预设 = 把整个预设目录移入回收站）。 */
  trashList(): Promise<{ ok: true; trash: TrashEntry[] }>
  trashRestore(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  trashDelete(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  importPreset(id: string, content: string, description?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}

export function createPromptsService(_ctx: unknown, deps: PromptsDeps): PromptsService {
  const message = (e: unknown): string => String((e && (e as Error).message) || e)

  /** 校验 id 并返回错误文本（合法时返回 `null`）。 */
  const idError = (raw: unknown): string | null => {
    const result = normalizePresetId(raw)
    return result.ok ? null : result.error
  }

  async function sha256OfFile(abs: string): Promise<string | null> {
    try {
      const buf = await readFile(abs, 'utf8')
      return createHash('sha256').update(buf).digest('hex')
    } catch {
      return null
    }
  }

  // ── 描述（给人看，也进模型清单）────────────────────────────────────────────
  // 存在预设目录的 `meta.json` 里，**不写进 AGENTS.md**：那个文件的正文会被原样注入
  // 系统提示词，把「这份预设是干什么的」写进去等于凭空给模型加了一段说明。
  // 0.14.0 起另有一条通道会把它带给模型 —— `prompt_manager_list` 的清单行（模型要在预设
  // 之间做选择，而 id 本身不说明用途），所以它有了 `DEFAULT_PRESET_DESC_MAX_LENGTH` 这条预算。
  // 读写都 best-effort：描述坏掉/写不进去不该让「保存预设」失败（正文才是本体）。

  async function readDescription(id: string): Promise<string> {
    try {
      const raw = await readFile(join(deps.presetsDir, id, META_FILE), 'utf8')
      const parsed = JSON.parse(raw) as { description?: unknown }
      return typeof parsed.description === 'string' ? parsed.description : ''
    } catch {
      return ''
    }
  }

  /**
   * 写描述。`undefined` = 不动（老调用方 / 只想改正文时不该顺手把描述抹掉），
   * 空串 = 明确清空（连文件一起删，避免留一个空壳 meta.json）。
   */
  async function writeDescription(id: string, description: string | undefined): Promise<void> {
    if (description === undefined) return
    const text = String(description).trim()
    const file = join(deps.presetsDir, id, META_FILE)
    try {
      if (text === '') { await rm(file, { force: true }); return }
      await writeFile(file, JSON.stringify({ description: text }, null, 2) + '\n', 'utf8')
    } catch { /* 描述写不进去不该让保存失败 */ }
  }

  // 幂等初始化：仅当库完全无预设且全局 AGENTS.md 存在时，拷贝全局为 default
  // 预设（首次运行引导）。用户已 create/apply 过任何预设则不插手，避免把
  // 当前生效内容误存成 default 与真正生效的预设冲突。
  async function ensureInit(): Promise<void> {
    const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()])
    let existing: import('node:fs').Dirent[] = []
    try { existing = await readdir(presetsDir, { withFileTypes: true }) } catch { /* 库不存在 */ }
    const hasPreset = existing.some((e) => e.isDirectory() && isValidPresetId(e.name) && e.name !== LAST_APPLIED_ID)
    if (hasPreset) return
    let globalContent: string
    try { globalContent = await readFile(globalPath, 'utf8') } catch { return }
    try {
      await mkdir(presetsDir, { recursive: true })
      const defaultDir = join(presetsDir, 'default')
      await mkdir(defaultDir, { recursive: true })
      await writeFile(join(defaultDir, FILENAME), globalContent, 'utf8')
    } catch { /* best effort */ }
  }

  async function list(): Promise<{ ok: true; presets: PromptPresetRow[] } | { ok: false; error: string }> {
    try {
      await ensureInit()
      const [presetsDir, globalPath] = await Promise.all([deps.presetsDir, deps.getGlobalAgentsMdPath()])
      let entries: import('node:fs').Dirent[] = []
      try {
        entries = await readdir(presetsDir, { withFileTypes: true })
      } catch {
        // 库目录不存在视作空（首次运行尚未创建）
      }
      const globalHash = await sha256OfFile(globalPath)
      const appliedId = await readAppliedId()
      const ids = entries
        .filter((e) => e.isDirectory() && isValidPresetId(e.name) && e.name !== LAST_APPLIED_ID)
        .map((e) => e.name)
      const presets = await Promise.all(
        ids.map(async (id) => {
          const contentHash = await sha256OfFile(join(presetsDir, id, FILENAME))
          return {
            id,
            active: globalHash !== null && contentHash !== null && globalHash === contentHash,
            ...(appliedId === id ? { lastApplied: true } : {}),
            description: await readDescription(id),
          }
        }),
      )
      presets.sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, presets }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  async function read(id: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    try {
      const content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8')
      return { ok: true, content }
    } catch {
      return { ok: false, error: '预设不存在：' + safeId }
    }
  }

  /** 新建预设：`content` 优先（用户在新建弹窗里直接写的内容），否则用 `from` 复制，否则空模板。 */
  async function create(id: string, options?: { from?: string; content?: string; description?: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir); return { ok: false, error: 'id 已存在：' + safeId } } catch { /* 不存在，继续 */ }
    const explicit = options && typeof options.content === 'string' ? options.content : undefined
    let content: string
    if (explicit !== undefined) {
      content = explicit
    } else {
      const srcId = String(options && options.from ? options.from : '').trim()
      if (srcId) {
        const badFrom = idError(srcId)
        if (badFrom) return { ok: false, error: '非法来源 id：' + badFrom }
        try { content = await readFile(join(deps.presetsDir, srcId, FILENAME), 'utf8') }
        catch { return { ok: false, error: '来源预设不存在：' + srcId } }
      } else {
        content = BLANK_TEMPLATE
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, FILENAME), content, 'utf8')
    await writeDescription(safeId, options?.description)
    return { ok: true, id: safeId }
  }

  /**
   * 保存预设：正文写入 + 可选**改名**（目录改名，内容随目录一起走）。
   * 改名冲突（目标已存在）直接拒绝，不合并、不覆盖。
   */
  async function update(id: string, content: string, nextId?: string, description?: string): Promise<{ ok: true; id: string; renamedFrom?: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir) } catch { return { ok: false, error: '预设不存在：' + safeId } }
    let targetId = safeId
    if (nextId !== undefined && String(nextId).trim() !== safeId) {
      const badNext = idError(nextId)
      if (badNext) return { ok: false, error: '非法新 id：' + badNext }
      targetId = String(nextId).trim()
      const nextDir = join(deps.presetsDir, targetId)
      try { await stat(nextDir); return { ok: false, error: '新 id 已存在：' + targetId } } catch { /* 可用 */ }
      try { await rename(dir, nextDir) } catch (e) { return { ok: false, error: '改名失败：' + message(e) } }
    }
    await writeFile(join(deps.presetsDir, targetId, FILENAME), String(content ?? ''), 'utf8')
    await writeDescription(targetId, description)
    if (targetId !== safeId && await readAppliedId() === safeId) {
      // 改名的正好是「最近一次应用」的那个预设：记录跟着改，否则它指向一个不存在的 id，
      // 手改过全局文件的用户就再也看不到「这份文件从哪来」。
      await writeAppliedId(targetId)
    }
    return { ok: true, id: targetId, ...(targetId === safeId ? {} : { renamedFrom: safeId }) }
  }

  /**
   * 覆盖写全局 `~/.dsh/AGENTS.md` 前的备份（多代 + `__last-applied__` 维护）。
   * **必须留多代**：只有单个 `__last-applied__` 槽位时，连续写两次就会把用户原始手写内容
   * 永久覆盖掉（第一次备份原始内容 → 第二次备份第一个预设），而「应用」只是点两下按钮。
   * @returns 是否真的备份了（当前文件存在才备份）。
   */
  async function backupGlobal(current: string | null): Promise<boolean> {
    if (current === null) return false
    const backupDir = join(deps.presetsDir, LAST_APPLIED_ID)
    await mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(backupDir, `${FILENAME}.bak-${stamp}`), current, 'utf8')
    await writeFile(join(backupDir, FILENAME), current, 'utf8')
    try {
      const gens = (await readdir(backupDir)).filter((n) => n.startsWith(FILENAME + '.bak-')).sort()
      for (const stale of gens.slice(0, Math.max(0, gens.length - KEEP_GLOBAL_BACKUPS))) {
        await rm(join(backupDir, stale), { force: true })
      }
    } catch { /* 轮转失败不影响本次写入 */ }
    return true
  }

  async function readGlobal(): Promise<string | null> {
    try { return await readFile(await deps.getGlobalAgentsMdPath(), 'utf8') } catch { return null }
  }

  /** 「最近一次应用」的预设 id；无记录 / 记录不可读 / id 已不合法 → `null`（一律不猜）。 */
  async function readAppliedId(): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(join(deps.presetsDir, APPLIED_FILE), 'utf8'))
      const id = raw && typeof raw.id === 'string' ? raw.id : null
      return id !== null && isValidPresetId(id) && id !== LAST_APPLIED_ID ? id : null
    } catch { return null }
  }

  /** 记下本次应用。**best-effort**：记录失败绝不能影响「应用」本身。 */
  async function writeAppliedId(id: string | null): Promise<void> {
    try {
      await mkdir(deps.presetsDir, { recursive: true })
      await writeFile(
        join(deps.presetsDir, APPLIED_FILE),
        JSON.stringify({ id, at: new Date().toISOString() }, null, 2) + '\n',
        'utf8',
      )
    } catch { /* ignore */ }
  }

  async function apply(id: string): Promise<{ ok: true; id: string; backedUp: boolean } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    let content: string
    try { content = await readFile(join(deps.presetsDir, safeId, FILENAME), 'utf8') }
    catch { return { ok: false, error: '预设不存在：' + safeId } }
    const prev = await readGlobal()
    const backedUp = await backupGlobal(prev)
    await writeFile(await deps.getGlobalAgentsMdPath(), content, 'utf8')
    await writeAppliedId(safeId)
    return { ok: true, id: safeId, backedUp }
  }

  /**
   * 按**原文**写回全局基线（不经过任何预设）。
   * 用途：场景切换的「关掉场景 → 恢复进场景之前的基线」——那份内容可能是用户手写的，
   * 不一定对应任何预设。备份纪律与 `apply` 完全相同。
   */
  async function restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }> {
    const text = String(content ?? '')
    const prev = await readGlobal()
    const backedUp = await backupGlobal(prev)
    try {
      await writeFile(await deps.getGlobalAgentsMdPath(), text, 'utf8')
    } catch (e) {
      return { ok: false, error: '写入全局 AGENTS.md 失败：' + message(e) }
    }
    // 基线内容可能来自用户手写（场景退出恢复）→ 不绑定任何预设。
    await writeAppliedId(null)
    return { ok: true, backedUp }
  }

  async function getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; exists: boolean } | { ok: false; error: string }> {
    try {
      await ensureInit()
      const [globalPath, presetsDir] = await Promise.all([deps.getGlobalAgentsMdPath(), deps.presetsDir])
      let content: string
      try { content = await readFile(globalPath, 'utf8') }
      catch { return { ok: true, content: '', presetId: null, exists: false } }
      const globalHash = createHash('sha256').update(content).digest('hex')
      let presetId: string | null = null
      let entries: import('node:fs').Dirent[] = []
      try { entries = await readdir(presetsDir, { withFileTypes: true }) } catch { /* 库不存在 */ }
      for (const e of entries) {
        if (!e.isDirectory() || !isValidPresetId(e.name) || e.name === LAST_APPLIED_ID) continue
        let c: string
        try { c = await readFile(join(presetsDir, e.name, FILENAME), 'utf8') } catch { continue }
        if (createHash('sha256').update(c).digest('hex') === globalHash) { presetId = e.name; break }
      }
      return { ok: true, content, presetId, exists: true }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  /**
   * 删除预设 = **移入回收站**（整个 `prompts/<id>/` 目录搬走）。
   * 备份槽 `__last-applied__` 不可删；正在生效的预设由调用方先拦（见 index.ts）。
   */
  async function remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const safeId = String(id ?? '').trim()
    if (safeId === LAST_APPLIED_ID) return { ok: false, error: '备份槽不可删除' }
    const bad = idError(safeId)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir) } catch { return { ok: false, error: '预设不存在：' + safeId } }
    const moved = await moveToTrash('prompts', safeId, [{ from: dir, dest: 'preset' }])
    if (moved.ok === false) return { ok: false, error: '移入回收站失败：' + moved.error }
    return { ok: true, id: safeId }
  }

  async function trashList(): Promise<{ ok: true; trash: TrashEntry[] }> {
    return { ok: true, trash: await listTrashEntries('prompts') }
  }

  /** 从回收站恢复预设：同 id 已存在时**拒绝**（绝不覆盖）。 */
  async function trashRestore(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const entry = await readTrashEntry('prompts', String(id ?? '').trim())
    if (!entry) return { ok: false, error: '回收站条目不存在：' + String(id ?? '').trim() }
    const bad = idError(entry.name)
    if (bad) return { ok: false, error: '回收站里的 id 不合法：' + bad }
    const target = join(deps.presetsDir, entry.name)
    try { await stat(target); return { ok: false, error: '无法恢复，同 id 预设已存在：' + entry.name } } catch { /* 可用 */ }
    try {
      await mkdir(deps.presetsDir, { recursive: true })
      await moveOutOfTrash('prompts', entry.id, 'preset', target)
    } catch (e) {
      return { ok: false, error: '恢复失败：' + message(e) }
    }
    await purgeTrashEntry('prompts', entry.id)
    return { ok: true, id: entry.name }
  }

  async function trashDelete(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const clean = String(id ?? '').trim()
    const gone = await purgeTrashEntry('prompts', clean)
    if (!gone) return { ok: false, error: '回收站条目不存在：' + clean }
    return { ok: true, id: clean }
  }

  // 从外部文本内容（如导入的 .md 文件）建预设：id 校验 + 重复检查 + 写 AGENTS.md。
  async function importPreset(id: string, content: string, description?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const bad = idError(id)
    if (bad) return { ok: false, error: '非法 id：' + bad }
    const safeId = String(id ?? '').trim()
    const dir = join(deps.presetsDir, safeId)
    try { await stat(dir); return { ok: false, error: 'id 已存在：' + safeId } } catch { /* 不存在，继续 */ }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, FILENAME), String(content ?? ''), 'utf8')
    await writeDescription(safeId, description)
    return { ok: true, id: safeId }
  }

  return { list, read, create, update, apply, restore, getCurrent, remove, trashList, trashRestore, trashDelete, importPreset }
}
