// 规则/记忆域的模块级常量与无依赖小工具（2026-09-19 从 memories/service.ts 抽出）。
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
export const DEFAULT_MAX_BYTES = 1 << 17    // 场景记忆段预算上限（字节，=128 KiB）

// ── 保留场景名 ─────────────────────────────────────────────────────────────

/** 保留场景名：界面显示「全局」，恒定存在、不可删除，其记忆注入任何对话。 */
export const GLOBAL_SCENE = 'global'
/** 保留场景在界面上的显示名（磁盘上仍用 ASCII 目录/文件名）。 */
export const GLOBAL_SCENE_LABEL = '全局'
export const SHARED_GROUP = '_shared'       // 保留场景名：公共基线（历史语义，仍可使用）

// ── 段渲染 ─────────────────────────────────────────────────────────────────

export const TRUNCATION_MARKER = '<!-- truncated -->'
// 段尾清单：让模型知道自己漏了什么。去掉伞标题后这里也不再挂「场景记忆」前缀 ——
// 它紧跟在场景块之后，`参考信息` 与段首引导语同一说法。
export const DROPPED_HEADING = '## 未注入的参考信息（超出预算）'

/** 单行正文的最大长度：超过就退回「标题 + 正文块」，避免出现一条几千字符的列表行。 */
export const INLINE_BODY_MAX = 120
/** 附件行里最多列几个文件名；多的只报总数（路径已经给了，缺的名字模型自己列目录即可）。 */
export const ATTACHMENT_LIST_MAX = 10

/**
 * 段首的引导语：让模型知道下面是**用户为本机写的参考信息**，并且**以它为准**
 * —— 涉及本机的事一律照它办，确实无关时才放下。
 *
 * 写法（2026-09-16 用户裁定，基于真实注入结果的三次修正）：
 *   - **单行、加粗**，不再用括号分两行 —— 括号跨行在真实提示词里读起来像被截断，
 *     而加粗是 Markdown 里最省字符的强调手段（用户要求「加强模型对此的重视程度」）。
 *   - **提到段首、整段只出现一次**：原来它挂在每个场景的段头里，多场景时会重复注入。
 *   - **不点名任何工具**：模型从工具 schema 就知道 `scene_memory_manager_list` 存在，点名反而
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
export const SCENE_MEMORY_NOTE = '**用户为本机写的参考信息：「场景说明」是用户的约定，一律照办，覆盖你的默认做法；其余条目是记录，可能已过期 —— 与当前实际情况冲突时以你看到的为准，与用户当场说的冲突时以用户为准。无关时不必提及。以下就是全部信息。**'
/** 有未注入条目时的版本：去掉完整性声明（见上）。 */
export const SCENE_MEMORY_NOTE_PARTIAL = '**用户为本机写的参考信息：「场景说明」是用户的约定，一律照办，覆盖你的默认做法；其余条目是记录，可能已过期 —— 与当前实际情况冲突时以你看到的为准，与用户当场说的冲突时以用户为准。无关时不必提及。**'

// ── bundle 与索引 ──────────────────────────────────────────────────────────

// bundle 附件限制（body 走 HTTP JSON + base64，故比技能上传收紧一档）。
export const MAX_ATTACH_ENTRY_BYTES = 8 << 20 // 单个附件 8 MiB
export const MAX_ATTACH_TOTAL_BYTES = 16 << 20 // 单次总大小 16 MiB
export const MAX_ATTACH_ENTRIES = 32 // 单次最多 32 个
export const LEGACY_BUNDLE_DOC = 'SKILL.md' // 旧版 bundle 的正文文件名；仅在发现/附件排除时作只读兼容，新建一律用 bundleDocName()
/** bundle 的正文文件名 = `<记忆名>.md`（与目录名一致，不再是固定的 SKILL.md）。 */
export const bundleDocName = (name: string): string => `${name}.md`
export const INDEX_VERSION = 1

// ── 段名约束提示 ───────────────────────────────────────────────────────────

// 场景/子目录段名约束（§4 对照表 + §5.3）：任意 Unicode，但必须对文件系统安全。
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

// ── 与索引层共用的路径常量与无依赖小工具（2026-09-19 从 memories/service.ts 下沉）──
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

export const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 业务校验失败的统一返回形态（与 skills core 一致）。ops 分域后各域都要用，故放在这一层。 */
export const fail = (code: string, error: string, params?: Record<string, string | number>): { ok: false; error: string; code: string; params?: Record<string, string | number> } => (
  params ? { ok: false, error, code, params } : { ok: false, error, code }
)

/**
 * 记忆索引文件名 / 记忆回收站目录名（hub 根下）。
 * 域叫「记忆」（工具 `scene_memory_manager_*`、界面「记忆」页），所以按域命名 ——
 * 旧名 `rules-index.json` / `rules-trash/` 由 hub 的启动迁移搬过来（见 hub.ts）。
 */
export const MEMORIES_INDEX_FILE = 'memories-index.json'

/** 记忆回收站目录名（hub 根下）。ops 分域后 trash 域要用，故与索引文件名一起放在这一层。 */
export const MEMORIES_TRASH_DIR = 'memories-trash'
