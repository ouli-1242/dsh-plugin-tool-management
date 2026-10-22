// 规则/记忆域的模块级常量与无依赖小工具（从 memories/service.ts 抽出）。
//
// 为什么单独一个文件：service.ts 里这些常量夹在类型与函数之间，而投影函数（projection.ts）、
// 索引 IO（index-io.ts）、发现与快照（snapshot.ts）与 service 本体都要用同一份 `global` /
// 预算上限 / 引导语 / 路径段校验。留在 service.ts 会让它们反过来 import service.ts —— 那是
// 运行时循环依赖。抽到这个无依赖的一层，几边都 import 它即可。
//
// 这里只放**不依赖本域状态**的东西：常量、纯字符串函数、字节计算。

// ── 预算与默认 ─────────────────────────────────────────────────────────────

import { isValidSegment } from '../paths.js'

export const MAX_SOURCE_DEPTH = 64          // 与 core.js 一致
export const MAX_DIRECTORIES = 2000         // 目录预算
export const MAX_ENTRIES = 20000            // 条目预算
export const MAX_GROUP_SEGMENT_LENGTH = 64  // 场景/子目录段名长度上限
export const MAX_DESCRIPTION_LENGTH = 500   // 派生/显式描述上限（派生超长截断，显式超长拒绝）
export const MAX_RULE_BYTES = 1 << 18       // 正文上限 256 KiB
export const DEFAULT_ORDER = 1000           // 默认投影 order（索引无记录时）
export const DEFAULT_GROUP_ORDER = 1000     // 新场景默认 order
export const SNAPSHOT_TTL_MS = 1000         // 读路径短 TTL 缓存，吸收 UI 密集轮询
export const DEFAULT_MAX_BYTES = 1 << 17    // 记忆段预算上限（字节，=128 KiB）
/**
 * 场景段（`scene-manager-catalog`）的预算上限（字节，= 4 KiB）。
 *
 * 比记忆段小两个数量级是**有意的**：场景段只列"启用的**非保留**场景 + 场景说明"，而场景是
 * **单选**的 —— 除保留场景（`global` / `_shared`，恒常生效、不列）外至多一个启用，正常不到
 * 1 KiB；一个具体场景都没启用时整段不注入（默认状态不占上下文）。给它一个大预算等于给一份
 * 永远用不到的保险；真有场景描述被写爆的那天，截断标记会说清（`renderSceneCatalog`）。
 */
export const SCENE_CATALOG_MAX_BYTES = 1 << 12

// ── 保留场景名 ─────────────────────────────────────────────────────────────

/** 保留场景名：界面显示「全局」，恒定存在、不可删除，其记忆注入任何对话。 */
export const GLOBAL_SCENE = 'global'
/** 保留场景在界面上的显示名（磁盘上仍用 ASCII 目录/文件名）。 */
export const GLOBAL_SCENE_LABEL = '全局'
export const SHARED_GROUP = '_shared'       // 保留场景名：公共基线（历史语义，仍可使用）

// ── 段渲染 ─────────────────────────────────────────────────────────────────

/**
 * 截断标记：**给模型看的一句英文**。
 *
 * 不能写成 HTML 注释（`<!-- truncated -->`）：对人眼不可见，但模型读的是**原始 markdown** ——
 * 它看到的是一串 `<!-- truncated -->`，既不知道这是什么，也不知道该拿它怎么办。注入正文里
 * 没有"注释"这个概念，凡是进上下文的东西都该是给模型的一句话。
 *
 * 这句话说清两件事：有内容没进来（`Truncated`）、进来的是少于全部的（`not shown`）。
 * 具体漏了哪些由段尾的 `## Not injected` 清单回答，标记只在清单本身也放不下时才独自出现。
 */
export const TRUNCATION_MARKER = '(Truncated: some entries are not shown.)'
// 段尾清单：让模型知道自己漏了什么。不挂「场景记忆」前缀 —— 它紧跟在场景块之后，
// 与段首引导语同一说法，两者都是英文（见 SCENE_MEMORY_NOTE）。
// 每行只有 `场景/名称`，不带 `(N B)`：字节数对人有用、对模型零动作价值
//（它不能凭"这条 800 B"决定读不读）。
/** 超预算时替换掉被丢段落的标题（英文，因为它会进模型上下文，与其余注入文案同语言）。 */
export const DROPPED_HEADING = '## Not injected (over the size limit)'

/** 单行正文的最大长度：超过就退回「标题 + 正文块」，避免出现一条几千字符的列表行。 */
export const INLINE_BODY_MAX = 120
/** 附件行里最多列几个文件名；多的只报总数（路径已经给了，缺的名字模型自己列目录即可）。 */
export const ATTACHMENT_LIST_MAX = 10

/**
 * 记忆段（`memory-manager-catalog`）的授权语：条目是**记录**，权威等级低于"用户当场说的"。
 *
 * 一句话承担四件事，缺一条都会失真：
 *
 *   ① **范围**：「当前场景对应的记忆」。条目按 `## Scene: X` 分组，这句解释分组的来由；
 *      写成「本机记录」反而说不清下面为什么只列一部分。
 *   ② **冲突裁决**：与观察到的实际情况、或与用户本轮对话冲突时，以后两者为准。权威等级
 *      必须写明 —— 记忆可能是几个月前记下的事实，不能让它压过眼前的事实。
 *   ③ **提及纪律**：`bring them up only when relevant`。刻意用正向表述：否定式
 *      （`do not bring them up unless relevant`）读起来像"对内容的态度许可"，模型会把它
 *      当成"不重要就可以忽略"，而这里要说的是"可以提，只是别主动提"。
 *   ④ **完整性声明**：`this is the complete set`。这是本段唯一的**防探测**手段 —— 没有它，
 *      模型在清单里找不到某件事时会去调 `memory_manager_list` 找更多。真发生截断时改用
 *      `SCENE_MEMORY_NOTE_PARTIAL`：否则段首声称"全部"、段尾 `## Not injected` 又列出没
 *      进来的条目，每一条注入都在说谎。
 *
 * 形式：单行、加粗，放在**板块层**（第一个场景块之前），整段只出现一次 —— 挂在每个场景的
 * 段头里会在多场景时重复注入。加粗是 markdown 里最省字符的强调手段。
 *
 * **不点名任何工具**：模型从工具 schema 就知道 `memory_manager_list` 存在，点名反而像在
 * 提示它去调。用户写的内容（记忆正文、场景名与说明）一律原样注入，一个字符都不动。
 */
export const SCENE_MEMORY_NOTE = '**Memories for the current scene; where they conflict with what you observe or with what the user says in this conversation, trust that instead; bring them up only when relevant; this is the complete set:**'

/**
 * 同一条授权语，**去掉完整性声明**的版本 —— 只在真发生截断时用。
 *
 * 截断时若仍声称"这就是全部"，段尾的 `## Not injected` 紧接着就列出没进来的条目，模型按
 * 段首那句判断"没有别的记忆了" —— 正好是完整性声明本来要防的那个误判。`rulesMaxBytes` 是
 * 公开旋钮（`index.ts` 的 config），预算配小时这个矛盾就是**每一条注入都在说谎**。
 *
 * 预算按全量版预留（`sceneNoteBytes`），截断态这句更短，所以分叉不会挤掉任何条目。
 */
export const SCENE_MEMORY_NOTE_PARTIAL = '**Memories for the current scene; where they conflict with what you observe or with what the user says in this conversation, trust that instead; bring them up only when relevant:**'

// ── bundle 与索引 ──────────────────────────────────────────────────────────

// bundle 附件限制（body 走 HTTP JSON + base64，故比技能上传收紧一档）。
export const MAX_ATTACH_ENTRY_BYTES = 8 << 20 // 单个附件 8 MiB
export const MAX_ATTACH_TOTAL_BYTES = 16 << 20 // 单次总大小 16 MiB
export const MAX_ATTACH_ENTRIES = 32 // 单次最多 32 个
export const LEGACY_BUNDLE_DOC = 'SKILL.md' // 旧版 bundle 的正文文件名；仅在发现/附件排除时作只读兼容，新建一律用 bundleDocName()
/** bundle 的正文文件名 = `<记忆名>.md`（与目录名一致，不再是固定的 SKILL.md）。 */
export const bundleDocName = (name: string): string => `${name}.md`
/** 索引文件的格式版本；读到更高版本说明是更新的插件写的，本进程按不可信处理。 */
export const INDEX_VERSION = 1

// ── 段名约束提示 ───────────────────────────────────────────────────────────

// 场景/子目录段名约束：任意 Unicode，但必须对文件系统安全。
// 谓词收敛到 `../paths.ts` —— 此前这里与 subagents / imports / skills 各写一套，
// 口径不一（这里漏了 Windows 保留设备名与控制字符，而那两样恰好是创建即失败/路径被截断）。
/**
 * 段名非法时的统一说明。与 `paths.ts` 的谓词保持同步 —— 此前六处报错文案各写一份，
 * 谓词收紧后它们会集体变成过时描述（用户按提示改了还是被拒）。
 */
export const SEGMENT_RULE_HINT = `非空、≤${MAX_GROUP_SEGMENT_LENGTH} 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头、首尾无空白、不是 Windows 保留设备名（CON/NUL 等）、不含控制字符`

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** UTF-8 字节长度（预算按字节算，不能按 UTF-16 码元）。 */
export const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

// ── 与索引层共用的路径常量与无依赖小工具（从 memories/service.ts 下沉）──
// 放在这里而非 service.ts：index-io / snapshot 都要用，留在 service.ts 会让它们反向引值，
// 形成运行时循环依赖。

/** 单个路径段（场景名或子目录名）是否合法。放宽后 `办公` / `日常` 均通过。 */
export function isValidGroupSegment(segment: string): boolean {
  return isValidSegment(segment, MAX_GROUP_SEGMENT_LENGTH)
}

/** group/场景路径可多层（a/b/c），每段必须合法；_shared 作为保留场景名放行。 */
export function isValidGroupPath(group: string): boolean {
  if (typeof group !== 'string' || group === '' || group.startsWith('/') || group.endsWith('/')) return false
  return group.split('/').every(isValidGroupSegment)
}

/** 把任意抛出物压成一句人话 —— 错误回执里到处要用，别各写一遍 `e.message || e`。 */
export const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 业务校验失败的统一返回形态（与 skills core 一致）。ops 分域后各域都要用，故放在这一层。 */
export const fail = (code: string, error: string, params?: Record<string, string | number>): { ok: false; error: string; code: string; params?: Record<string, string | number> } => (
  params ? { ok: false, error, code, params } : { ok: false, error, code }
)

/**
 * 记忆索引文件名 / 记忆回收站目录名（hub 根下）。
 * 域叫「记忆」（工具 `memory_manager_*`、界面「记忆」页），所以按域命名 ——
 * 旧名 `rules-index.json` / `rules-trash/` 由 hub 的启动迁移搬过来（见 hub.ts）。
 */
export const MEMORIES_INDEX_FILE = 'memories-index.json'

/**
 * 记忆回收站目录（**hub 内相对路径**，故带 `trash/` 段）。
 *
 * `memories-trash/`，独立于 `trash/` —— 界面上六类早就统一成一个「回收站」了，落点却分两处，
 * 按 `trash/` 写备份 / 迁移脚本会漏掉这一类（条目数最多的那类）。
 * 老位置由 hub 的启动迁移搬过来（见 `hub.ts` 的 `HUB_RENAMES`），只搬不删。
 */
export const MEMORIES_TRASH_DIR = 'trash/memories-trash'
