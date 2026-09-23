// 规则/记忆域的**投影与渲染**纯函数（2026-09-19 从 memories/service.ts 抽出）。
//
// 界定：这里只放「给定索引 + 已发现的条目，算出界面/注入看到的那份结果」的函数 ——
// 不读索引文件、不改索引、不碰服务状态。快照构建（buildSnapshot）与 op 实现留在 service.ts。
//
// 为什么抽出来：service.ts 里这些函数夹在「索引读写」与「24 个 op」之间，而它们其实是
// 另一件事——把磁盘事实翻译成模型与用户看到的文本。分开之后改渲染不必在 op 之间穿行。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ATTACHMENT_LIST_MAX, bundleDocName, DEFAULT_GROUP_ORDER, DEFAULT_ORDER, GLOBAL_SCENE,
  GLOBAL_SCENE_LABEL, INLINE_BODY_MAX, LEGACY_BUNDLE_DOC, SHARED_GROUP,
} from './constants.js'
import type { RulesIndex, SceneMemoryFile } from './service.js'

// ── 索引归一化与场景解析 ───────────────────────────────────────────────────

/** 启用场景集合归一化：非数组 → null（= 全部启用）；数组 → 去重后的字符串数组。 */
export function normalizeActive(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
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

export function ensureSceneRecords(index: RulesIndex, probeScenes: string[]): boolean {
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
export function resolveActiveScenes(index: RulesIndex, knownScenes: string[]): { active: Set<string>; mode: 'all' | 'custom' } {
  const stored = normalizeActive(index.active)
  const mode: 'all' | 'custom' = stored === null ? 'all' : 'custom'
  const active = new Set<string>(stored === null ? knownScenes : stored)
  active.add(SHARED_GROUP)
  active.add(GLOBAL_SCENE)
  return { active, mode }
}

/** 当前启用的**非保留**场景（单选模型下至多一个；多个时按场景顺序取第一个）。 */
export function enabledSceneOf(index: RulesIndex): string | null {
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
export function collapseActiveForNewScene(index: RulesIndex): boolean {
  if (normalizeActive(index.active) !== null) return false
  const names = Object.keys(index.scenes || {}).filter((n) => n !== SHARED_GROUP && n !== GLOBAL_SCENE)
  const first = names.sort((a, b) => sceneOrderOf(index, a) - sceneOrderOf(index, b) || a.localeCompare(b))[0]
  index.active = first === undefined ? [] : [first]
  return true
}

/** 场景名 = 分组路径的第一段（`web/frontend` 属于场景 `web`）。 */
export function sceneOf(group: string): string {
  const idx = String(group || '').indexOf('/')
  return idx >= 0 ? group.slice(0, idx) : group
}

// ── 指纹 ───────────────────────────────────────────────────────────────────

/** 指纹里必须包含一切影响渲染的索引字段（active / enabled / order / groups.order / scenes.order / label / description）。 */
export function signatureOfIndex(index: RulesIndex): string {
  const active = normalizeActive(index.active)
  const rules = Object.keys(index.rules).sort().map((id) => {
    const e = index.rules[id]
    return `${id}\u0000${e.enabled === false ? '0' : '1'}\u0000${e.order ?? DEFAULT_ORDER}`
  })
  const groups = Object.keys(index.groups).sort().map((g) => `${g}\u0000${index.groups[g]?.order ?? DEFAULT_GROUP_ORDER}`)
  // 场景顺序决定段内场景的先后 → 必须进指纹，否则改顺序后段文本不会重算。
  // label 与 description 同理（`sceneLine` 把 label 与 description 都渲染进正文）——
  // 手改索引文件（带外变更）时只有指纹变化才会触发重算。
  const scenes = Object.keys(index.scenes || {}).sort().map((s) => {
    const e = index.scenes![s]
    return `${s}\u0000${e.order ?? (s === GLOBAL_SCENE ? 0 : DEFAULT_GROUP_ORDER)}\u0000${e.label ?? ''}\u0000${e.description ?? ''}`
  })
  return `A:${active === null ? '*' : active.join(',')}|R:${rules.join(';')}|G:${groups.join(';')}|S:${scenes.join(';')}`
}

// ── 场景排序与标题 ─────────────────────────────────────────────────────────

/** 场景排序键：索引 scenes.order 优先，回退到旧 groups.order，再回退默认值。 */
export function sceneOrderOf(index: RulesIndex, scene: string): number {
  if (scene === GLOBAL_SCENE) return 0
  const s = index.scenes?.[scene]?.order
  if (typeof s === 'number' && Number.isFinite(s)) return s
  return index.groups[scene]?.order ?? DEFAULT_GROUP_ORDER
}

/** 场景显示名：`global` → 「全局」（磁盘名保持 ASCII），其余用索引 label 或场景名。 */
export function sceneLabel(scene: string, index?: RulesIndex): string {
  if (scene === GLOBAL_SCENE) return index?.scenes?.[GLOBAL_SCENE]?.label || GLOBAL_SCENE_LABEL
  const label = index?.scenes?.[scene]?.label
  return label && label !== '' ? label : scene
}

/** 单个场景的标题：**场景在最顶层**（`##`，与「子智能体」「MCP 服务器」等段同级）。 */
export const sceneHeading = (scene: string): string => `## 场景：${sceneLabel(scene)}`

/**
 * 场景段（`scene-manager-catalog`）里的一行：`**「<场景名>」—— 用户描述：<场景说明>**`。
 *
 * 2026-09-23 用户裁定，替换了原来的两行式（`## 场景：X` + `**场景说明：X**`）。三条理由都是
 * 用户看到**实际注入**之后提的：
 *   - **场景名只出现一次**。上一版里它出现三次（框架线索"现在处在哪个场景"、引导语里的
 *     「代码」、标题里的 `## 场景：代码`），而说明行只是把同一件事换个标签再说一遍。
 *   - **场景说明是「标签」，不是「约定」**。它答的是"这个场景是干什么的"，用户的实例就是
 *     「写代码」「前端相关」。上一版把它写成"一律照办、覆盖你的默认做法"，等于要求模型
 *     "照办一个标签" —— 那正是它读不懂这一段的根源。授权语已删，说明只作注解跟在名字后面。
 *   - **没填说明就不带后缀**。上一版会补 `defaultSceneDescription` 的默认句，而
 *     "用户配置的上下文，当前启用"贴在名字后面，读起来像一句真的说明。
 *
 * `用户描述：` 这个前缀是同日追加的（用户：「防止模型误解这是场景名或者其它」）：破折号后面
 * 那截的形态本来有歧义 —— `**「代码」—— 写代码**` 读起来像"名字 —— 别名"，而它其实是
 * **用户写的一句说明**。加四个字把来源点明，模型就不会把它当成场景的另一个名字或某种标识符。
 * 前缀只在真有描述时出现（没填描述时整截不出现，不存在"用户描述："后面空着）。
 *
 * 为什么不再用 `##` 标题：这一段只讲"当前启用的是哪个 + 它是什么"，一行说完就够。
 * 场景**分组**标题仍在记忆段里用（`sceneHeading`），两段各自承担自己的职责。
 */
export const sceneLine = (scene: string, index?: RulesIndex): string => {
  const described = String(index?.scenes?.[scene]?.description ?? '').replaceAll(/\s+/g, ' ').trim()
  return `**「${sceneLabel(scene)}」${described === '' ? '' : `—— 用户描述：${described}`}**\n\n`
}

/** 场景渲染顺序：全局 `global` 最先（它的记忆对任何对话都成立，先讲总则），
 *  其次 `_shared`（历史保留名），其余按（索引 scenes.order, 场景名）。 */
export function compareSceneBuckets(a: string, b: string, index: RulesIndex): number {
  if (a === b) return 0
  if (a === GLOBAL_SCENE) return -1
  if (b === GLOBAL_SCENE) return 1
  if (a === SHARED_GROUP) return -1
  if (b === SHARED_GROUP) return 1
  const ao = sceneOrderOf(index, a)
  const bo = sceneOrderOf(index, b)
  return ao - bo || a.localeCompare(b)
}

// ── bundle 附件 ────────────────────────────────────────────────────────────

/**
 * bundle 记忆的附件名（**同步**版 —— 段渲染必须同步返回，`listAttachments` 是异步的）。
 * 口径与异步版一致：跳过正文本体（`<名>.md`，旧数据可能是 `SKILL.md`），只认普通文件。
 */
export function attachmentNamesSync(bundleDir: string, name: string): string[] {
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
export function attachmentSummarySync(bundleDir: string, name: string): { count: number; bytes: number; names: string[] } | null {
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
 *
 * 2026-09-23 精简（用户看到实际注入后要求）：去掉「未注入正文」这半句解释与「共 N 个」里的
 * 计数词 —— 目录 + 文件名已经把"内容不在这里、要读就照路径去读"说清楚了，而这两处纯修饰
 * 每轮都在付钱（实测两行 289 B ≈73 tok/轮，占记忆段的 23%）。总数只在**列不全**时才需要
 * （否则数一下文件名就知道有几个）。
 *
 * **路径必须绝对**：模型拿到它要去 `Read`，相对路径等于没给。所以前缀省不掉。
 */
export function attachmentLine(file: SceneMemoryFile): string {
  if (file.kind !== 'bundle') return ''
  const names = attachmentNamesSync(file.bundleDir, file.name)
  if (names.length === 0) return ''
  const shown = names.slice(0, ATTACHMENT_LIST_MAX)
  const more = names.length - shown.length
  return `附件：${file.bundleDir}（${shown.join('、')}${more > 0 ? ` 等 ${names.length} 个` : ''}）`
}

// ── 单条记忆的渲染 ─────────────────────────────────────────────────────────

/**
 * 多行正文的渲染形态：**围栏代码块**，整体缩进 2 格挂在条目下（2026-09-23 用户裁定）。
 *
 * 为什么不是"缩进 2 格就完事"（这是上一版的实现，被实测推翻）：markdown 里缩进 ≤3 格的 `#`
 * **仍然算标题**，所以正文里一句手写的 `# 代码/需求` 会渲染成 H1，**盖过容器自己的
 * `## 场景：X`** —— 用户看到的就是这个：内容看起来"逃出了条目"，与场景标题平级甚至更高。
 * 缩到 4 格能压住标题（块级标记都要求 ≤3 格缩进），但正文里的列表/引用只是被"压平"，
 * 视觉上仍与条目正文同级，达不到"明显从属"。
 *
 * 围栏块一次解决两件事（用户 2026-09-23 明确要这两条）：
 *   - **不能逃出**：块内一切都是字面量，正文的 `#` / `>` / `---` / ``` 再也无法参与外围结构；
 *   - **明显从属**：`<pre>` 的缩进在渲染视图里可见、复制出来也不丢，正文明确挂在条目下。
 *
 * 代价如实记：块内的行内 markdown（`**粗体**`、链接）按字面显示、不再被渲染。记忆正文的定位
 * 是"记录"（可能过期、以实际情况为准），按字面呈现比让它参与排版更贴合这个定位。
 *
 * 围栏用**反引号**且长度取"正文里最长反引号串 + 1"（最少 3 个）：正文自带 ``` 时不会把块
 * 提前闭合（闭合需要**至少**与开栏等长的反引号串）。
 */
export const bodyBlock = (text: string): string => {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const lines = text.split('\n').map((line) => (line === '' ? line : '  ' + line))
  return ['  ' + fence, ...lines, '  ' + fence].join('\n')
}

/** 括号注解用的显式描述：派生描述与正文重复、不进段（只存在于界面投影）；换行压成单行，避免把「一行一条」的列表项撑断。 */
export const explicitDescriptionOf = (f: SceneMemoryFile): string => (
  f.descriptionDerived || !f.description ? '' : String(f.description).replaceAll(/\s+/g, ' ').trim()
)

/**
 * 单条信息的渲染形态 —— **能一行就一行，但恒为列表项**。
 *
 *   单行且不长的正文 → `- **名称**（描述） — 正文`（与 MCP / 子智能体两个段的列表同形；无显式描述时括号不出现）
 *   多行或过长的正文 → `- **名称**（描述）` + 空行 + **围栏代码块里的正文**（挂在条目下；理由见 `bodyBlock`）
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
 * Markdown**（可能自带标题、代码块、嵌套列表），放进围栏块挂到条目下 —— 上一版让它以普通
 * 段落参与外围排版，结果正文里的 `#` 会盖过 `## 场景：X`（见 `bodyBlock` 的说明）。
 *
 * 返回值带 `inline`：调用方据此决定下一条记忆前要不要空行（单行条目连续排列，其余空行分隔）。
 */
export function memoryBlock(file: SceneMemoryFile): { text: string; inline: boolean } {
  const desc = explicitDescriptionOf(file)
  // 加粗的只有名称：`- **名称**（描述） — 正文`，与 MCP 段 `- **server**（N 个工具） — …` 同形。
  const title = `**${file.name}**` + (desc === '' ? '' : `（${desc}）`)
  const text = String(file.body ?? '').trim()
  const inline = text === '' || (!text.includes('\n') && text.length <= INLINE_BODY_MAX)
  const head = text === ''
    ? `- ${title}`
    : (inline ? `- ${title} — ${text}` : `- ${title}\n\n${bodyBlock(text)}`)
  const attach = attachmentLine(file)
  if (attach === '') return { text: `${head}\n`, inline }
  // 附件行恒为缩进子项：只用 `- ` 会被解析成与记忆**同级**的列表项（`- A` / `- 附件目录：A的` /
  // `- B` … 四条平级，归属读不出来）。单行条目紧跟其后保持列表连续；多行条目前面空一行，
  // 免得被读成用户正文自己的列表项。
  return { text: inline ? `${head}\n  - ${attach}\n` : `${head}\n\n  - ${attach}\n`, inline }
}
