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
// 全局 AGENTS.md 的落盘走**原子写**（temp + rename，见 `memories/index-io.ts`）。
// 为什么非它不可（2026-09-30 审查 P2-2）：这个文件是宿主**每个 agent/pre-step 都会 stat 并
// 重读**的，裸 `writeFile` 在中断/断电时会留下**半截内容** —— 而半截的提示词会原样进模型
// 上下文（截断点还可能在代码块中间）。原子写保证读到的是「要么旧、要么新」的完整内容。
import { writeFileAtomically } from '../memories/index-io.js'

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
/**
 * 「应用前 AGENTS.md 根本不存在」这个**事实**的标记文件，与备份内容同放在 `__last-applied__/`。
 *
 * 为什么需要它（0.19.1 修，用户 2026-10-10 反馈「全局提示词取消应用，AGENTS.md 还是存在」）：
 * `backupGlobal()` 原先在 `current === null` 时直接 `return false` —— **一个字节都不写**。
 * 于是"应用前没有这个文件"在磁盘上没留下任何痕迹，`unapply()` 便永远读不到备份、恒判
 * `noBackup`，取消应用**永久关不掉**；而界面给出的出路「删除这份预设」根本不成立
 * （`remove()` 只把预设目录移进回收站，不碰 AGENTS.md）。出路不成立 = 死路。
 *
 * 有了它，「取消应用」才是「应用」的**真逆操作**：
 *   应用前有文件 → 写回那份内容；应用前没文件 → 把文件删掉。
 * 与内容槽 `AGENTS.md` **同时只应有一个**：两个都在时 `unapplyState()` 优先判 `'restore'`，
 * 就会把一份不相干的内容写进用户的文件。
 *
 * **但"只能有一个"不等于"每次写都刷掉另一个"**（0.19.1 再修，见 `backupGlobal` 的注释）：
 * 这两个槽位合起来记的是**链起点**，链走到中途（应用 a 之后又应用 b）不许动它 ——
 * 原先 `backupGlobal` 每写一笔都顺手 `rm` 掉另一个槽，于是「应用 a → 应用 b」这一步就把
 * "起点不存在"永久抹掉了，取消应用再也回不到"没有文件"。
 * 放在 `__last-applied__/` 里是安全的 —— 该目录已被 `list()` 按 `LAST_APPLIED_ID` 排除，
 * 放什么进去都不会被当成预设。
 */
const ABSENT_FILE = 'absent.json'
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
  /**
   * 「取消应用」—— 把全局基线恢复成**链起点**（这一串应用/取消往复开始之前的状态）：
   *   - 起点 AGENTS.md 有内容 → 把 `__last-applied__/AGENTS.md` 写回它（`removed` 不出现）；
   *   - 起点 AGENTS.md **不存在** → 把文件删掉（`removed: true`），回到"没有全局提示词文件"。
   * 连续应用过 A、B 时是**一步回到起点**，不是只退一步（见 `backupGlobal` 的注释）。
   *
   * 没有链起点时**拒绝**（`noBackup`），不猜「起点是什么」—— 「播种出来的 default 恰好等于
   * AGENTS.md」这种状态从来没有发生过「应用」动作，也就没有起点可回。
   */
  unapply(): Promise<{ ok: true; backedUp: boolean; removed?: boolean } | { ok: false; error: string; noBackup?: boolean }>
  /** 按原文写回全局基线（备份纪律同 apply）；用于场景关闭时恢复进场景前的内容。写回即链结束。 */
  restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }>
  getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; lastApplied: string | null; exists: boolean; unapplyAvailable: boolean; unapplyRemoves: boolean } | { ok: false; error: string }>
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

  // 幂等初始化：**只在库目录本身不存在时**把全局 AGENTS.md 拷成 default
  // 预设（首次运行引导）。
  //
  // 判据为什么是「目录在不在」而不是「目录里有没有预设」（0.19.1 修）：后者把
  // 「用户把预设删光了」误判成「首次运行的空库」，于是 list() / getCurrent() 每次都重新
  // 播种 —— 用户删掉最后一个预设、刷新列表，同名 default 又回来了（内容 = 当前
  // AGENTS.md，所以 md5 相同），删除看起来「不持久」。库目录一旦存在就说明这个库已经
  // 被初始化过；空目录是用户的决定，不是我们的空库。
  //
  // 只在**目录不存在**时播种还有一层必要：库目录由 create / apply / 备份 / 应用记录
  // 各自按需创建，所以「已存在」这个信号在任何一次真实使用之后都成立；反过来，
  // 全新安装时没有任何一处会先建出这个目录（hub 布局迁移只搬已存在的东西），
  // 首次运行引导因此仍然会发生。
  async function ensureInit(): Promise<void> {
    try {
      await stat(deps.presetsDir)
      return // 库目录已存在（哪怕空）→ 不插手
    } catch { /* 库目录不存在 → 真·首次运行，继续播种 */ }
    let globalContent: string
    try { globalContent = await readFile(await deps.getGlobalAgentsMdPath(), 'utf8') } catch { return }
    try {
      const defaultDir = join(deps.presetsDir, 'default')
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
   * 覆盖写全局 `~/.dsh/AGENTS.md` 前的备份。
   *
   * **两个槽位（内容槽 `AGENTS.md` / `ABSENT_FILE`）合起来记的是「链起点」** —— 即
   * "连续应用/取消往复"这一整串动作**开始之前**的文件状态。所以**只在链起点写一次**：
   * 一旦记下，后面每一笔写入都原样保留它，直到链结束（取消应用 / 写回基线）才清掉。
   *
   * 为什么不是"每笔覆盖"（0.19.1 修，用户 2026-10-10 报：「原本没有 AGENTS.md，新建 a、b
   * 两份提示词，启动 a，再启动 b；不启动 a 也不启动 b，`~/.dsh/AGENTS.md` 没有消失」）：
   *   ① 起点      文件不存在   槽位=空
   *   ② 应用 a    文件="# a"   槽位=absent（"应用前不存在"）
   *   ③ 应用 b    文件="# b"   槽位=**被刷成 "# a"** ← 每笔覆盖把"起点不存在"永久抹掉了
   *   ④ 取消应用  文件="# a"   槽位="# a"        ← 回不到"没有文件"，两颗开关还互相点亮
   * ⑤ 此后无论点多少次，文件只在 "# a" / "# b" 之间来回，**永远回不到起点**。
   *
   * 与场景基线同一条口径：`scene-prompt-sync` 的 `writeBaseline` 也是「已有快照就不覆盖」
   * （连续切场景时基线始终是"进场景之前"那一份）。
   *
   * **多代 `.bak-<stamp>` 快照照旧每笔都写**：它记的不是链起点，而是"每一笔被覆盖前的内容"
   * （审计 / 抢救用），两者互不干扰 —— 链起点保证"退得回起点"，多代快照保证"中途每一份都还
   * 在磁盘上"。**必须留多代**：只有单个槽位时，连续写两次就会把用户原始手写内容永久覆盖掉，
   * 而「应用」只是点两下按钮。
   *
   * @returns 是否真的备份了内容（`current` 非空才为 `true`）。文件不存在时返回 `false`，但
   *   **不再是"什么都不做"** —— 见 `ABSENT_FILE` 的注释：那个"不存在"本身就是链起点状态。
   */
  async function backupGlobal(current: string | null): Promise<boolean> {
    const backupDir = join(deps.presetsDir, LAST_APPLIED_ID)
    await mkdir(backupDir, { recursive: true })
    // 还没有链起点 → 现在记下它；记过就绝不再动（这正是 bug 的修法）。
    if (await unapplyState() === null) {
      if (current === null) {
        // 链起点 = "文件不存在"。写不进去不该让「应用」失败 —— 代价只是取消应用退回"关不掉"。
        try {
          await writeFile(join(backupDir, ABSENT_FILE), JSON.stringify({ at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
        } catch { /* 见上 */ }
      } else {
        await writeFile(join(backupDir, FILENAME), current, 'utf8')
      }
    }
    if (current === null) return false
    // 审计快照：每一笔被覆盖前的内容都留一代（链起点不受它影响）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(backupDir, `${FILENAME}.bak-${stamp}`), current, 'utf8')
    try {
      const gens = (await readdir(backupDir)).filter((n) => n.startsWith(FILENAME + '.bak-')).sort()
      for (const stale of gens.slice(0, Math.max(0, gens.length - KEEP_GLOBAL_BACKUPS))) {
        await rm(join(backupDir, stale), { force: true })
      }
    } catch { /* 轮转失败不影响本次写入 */ }
    return true
  }

  /**
   * 链结束（取消应用 / 写回基线）时清掉链起点 —— 下一笔「应用」重新开一条链。
   * 与场景退出后 `writeBaseline({presetId: null, content: null})` 把快照清空是同一个口径。
   */
  async function clearChainStart(): Promise<void> {
    const dir = join(deps.presetsDir, LAST_APPLIED_ID)
    await rm(join(dir, FILENAME), { force: true })
    await rm(join(dir, ABSENT_FILE), { force: true })
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
    await writeFileAtomically(await deps.getGlobalAgentsMdPath(), content)
    await writeAppliedId(safeId)
    return { ok: true, id: safeId, backedUp }
  }

  /**
   * 按**原文**写回全局基线（不经过任何预设）。
   * 用途：① 场景切换的「关掉场景 → 恢复进场景之前的基线」——那份内容可能是用户手写的，
   * 不一定对应任何预设；② 「取消应用」的 `'restore'` 分支。
   * 备份纪律与 `apply` 完全相同；写回即**链结束**，链起点一并清掉（见 `clearChainStart`）。
   */
  async function restore(content: string): Promise<{ ok: true; backedUp: boolean } | { ok: false; error: string }> {
    const text = String(content ?? '')
    const prev = await readGlobal()
    const backedUp = await backupGlobal(prev)
    try {
      await writeFileAtomically(await deps.getGlobalAgentsMdPath(), text)
    } catch (e) {
      return { ok: false, error: '写入全局 AGENTS.md 失败：' + message(e) }
    }
    // 基线内容可能来自用户手写（场景退出恢复）→ 不绑定任何预设。
    await writeAppliedId(null)
    await clearChainStart()
    return { ok: true, backedUp }
  }

  /**
   * 「链起点是什么状态」—— 界面据此决定「取消应用」可不可点、点下去会发生什么。
   *   `'restore'` → 起点有一份内容，取消应用 = 把它写回去；
   *   `'remove'`  → 起点 AGENTS.md 根本不存在，取消应用 = 删掉文件；
   *   `null`      → 没有链起点（从没「应用」过，或链已结束），关不掉。
   *
   * 两个槽位同时存在只可能是手改磁盘造成的（`backupGlobal` 记链起点时只会写其中一个），
   * 那种情况优先 `'restore'`：**写回内容比删文件保守**，猜错时用户丢的是"文件里的旧内容"
   * 而不是整个文件。
   */
  async function unapplyState(): Promise<'restore' | 'remove' | null> {
    const dir = join(deps.presetsDir, LAST_APPLIED_ID)
    try { if ((await stat(join(dir, FILENAME))).isFile()) return 'restore' } catch { /* 没有内容槽 */ }
    try { if ((await stat(join(dir, ABSENT_FILE))).isFile()) return 'remove' } catch { /* 没有"不存在"标记 */ }
    return null
  }

  /**
   * 「取消应用」= **回到链起点**：把这一串应用/取消往复开始之前的文件状态恢复出来。
   *
   * 语义边界（写清楚是因为它决定了开关什么时候可关）：
   *   - 恢复的是**链起点**，不是"上一步"。连续应用过 A、B 时，取消应用直接回到"应用 A 之前"
   *     —— 文件不存在就删掉文件、有一份手写内容就写回那份内容（0.19.1 修，见 `backupGlobal`）。
   *     想从 B 切回 A 就点 A 的开关，效果等价，不必先退回 A 再取消。
   *   - **没有链起点就拒绝**（`noBackup`）。没有链起点只有一种成因：AGENTS.md 的当前内容不是
   *     由「应用」写进去的（首次打开提示词页时播种出来的 `default` 就是这样，它内容与 AGENTS.md
   *     相同、显示「生效中」，却从未发生过写入）。此时"起点"无从谈起，写空文件等于抹掉用户的
   *     全局指令 —— 所以宁可拒绝，让界面去说清「要让它不再生效，请删除这份预设或应用别的预设」。
   *
   * `'restore'` 分支复用 `restore()`：备份纪律与「应用」完全一致。`'remove'` 分支（起点文件
   * 不存在）先 `backupGlobal(prev)` 把当前内容存进多代快照，所以删掉的内容仍然拿得回来
   * （`__last-applied__/AGENTS.md.bak-*`），可撤销性与另一支对称。
   * 两支结束都清链起点（`'restore'` 在 `restore()` 里清）—— 链到此为止。
   */
  async function unapply(): Promise<{ ok: true; backedUp: boolean; removed?: boolean } | { ok: false; error: string; noBackup?: boolean }> {
    const mode = await unapplyState()
    if (mode === null) {
      return {
        ok: false,
        noBackup: true,
        error: '没有可恢复的「链起点」：__last-applied__ 里既没有备份内容，也没有「起点不存在」的标记（AGENTS.md 当前内容不是由「应用」写进去的）。',
      }
    }
    if (mode === 'remove') {
      const prev = await readGlobal()
      const backedUp = await backupGlobal(prev)
      try {
        await rm(await deps.getGlobalAgentsMdPath(), { force: true })
      } catch (e) {
        return { ok: false, error: '删除全局 AGENTS.md 失败：' + message(e) }
      }
      await writeAppliedId(null)
      await clearChainStart()
      return { ok: true, backedUp, removed: true }
    }
    let content: string
    try {
      content = await readFile(join(deps.presetsDir, LAST_APPLIED_ID, FILENAME), 'utf8')
    } catch {
      // `unapplyState()` 刚判过它存在，这里读不到只能是并发下被清掉（或权限问题）。
      return {
        ok: false,
        noBackup: true,
        error: '没有可恢复的「链起点内容」：__last-applied__ 里没有备份（AGENTS.md 当前内容不是由「应用」写进去的）。',
      }
    }
    return restore(content)
  }

  async function getCurrent(): Promise<{ ok: true; content: string; presetId: string | null; lastApplied: string | null; exists: boolean; unapplyAvailable: boolean; unapplyRemoves: boolean } | { ok: false; error: string }> {
    try {
      await ensureInit()
      const [globalPath, presetsDir] = await Promise.all([deps.getGlobalAgentsMdPath(), deps.presetsDir])
      // `lastApplied` 与 `presetId` 是**两个不同的事实**，删除保护要的是前者：
      //   `presetId`   = 内容逐字节相同（谁的内容此刻躺在文件里）
      //   `lastApplied`= 最近一次「应用」写进去的是谁（用户**主动做过这个选择**）
      // 两者在"首次打开提示词页时自动播种出来的 default"上分道扬镳：它内容与 AGENTS.md
      // 相同（presetId 命中），却从未发生过写入（lastApplied 为 null）。那份副本删掉完全
      // 合理 —— 拦它反而会变成死路（取消应用也关不掉）。见 `ops/prompts.ts` 的删除保护。
      const lastApplied = await readAppliedId()
      // 与内容一起报「链起点是什么状态」—— 界面用它决定那颗「生效中」的开关点下去是
      // 「取消应用」还是「说明为什么关不掉」，以及取消应用的确认弹窗要说"写回内容"还是
      // **"删掉文件"**（后者是不可逆感很强的动作，必须提前说清，不能点下去才知道）。
      const unapplyMode = await unapplyState()
      const unapplyAvailable = unapplyMode !== null
      const unapplyRemoves = unapplyMode === 'remove'
      let content: string
      try { content = await readFile(globalPath, 'utf8') }
      catch { return { ok: true, content: '', presetId: null, lastApplied, exists: false, unapplyAvailable, unapplyRemoves } }
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
      return { ok: true, content, presetId, lastApplied, exists: true, unapplyAvailable, unapplyRemoves }
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
    // 删掉的正是「最近一次应用」的那一份 → 记录跟着清掉。与 `update()` 改名时跟着改记录对称。
    // 不清的后果：之后再新建一个同 id 的预设，界面会凭这条陈旧记录错误地标上「最近一次应用」
    // （`list()` 只做 `appliedId === id` 的比对，认不出「这是另一个预设」）。
    if (await readAppliedId() === safeId) await writeAppliedId(null)
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

  return { list, read, create, update, apply, unapply, restore, getCurrent, remove, trashList, trashRestore, trashDelete, importPreset }
}
