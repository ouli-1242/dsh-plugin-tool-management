// src/subagents/catalog.ts —— 子智能体人设目录（注入通道的数据源，见 src/context-inject.ts）。
//
// 为什么需要它：人设（persona）是**本插件自造的概念**，宿主没有对应物，所以宿主
// 不会替你把它塞进上下文。结果是模型**完全不知道**存在哪些人设，只能靠用户
// 口头提醒，`subagent_manager_run` 基本不会被触发 —— 功能形同虚设。
//
// 官方的对照做法：`@deepseek-ai/dsh-tool-subagent` 在 `backgroundEnabled && continuable`
// 时会注册 `systemPrompt.section({ name: 'tool:' + toolName, order: getSectionOrder('TOOL_SUBAGENT'), … })`
// 讲「怎么用委派工具」。所以「往上下文里塞委派说明」是官方做法，不是设计禁忌。
//（本插件走的是同一族里更强的那条：每步注入一条消息，预设的 persona complete 也压不掉。）
//
// 注入内容：**只有名字 + 描述，正文绝不注入**。
//   人设正文（body）只在 `subagent_manager_run` 真正委派时作为 persona 传给子代理 —— 那是
//   **子会话**的系统提示词，不是父会话的上下文。这两件事必须分开，否则人设越多父会话越重。
//   这与官方技能目录同构（`dsh-tool-skill` 也只列 name + description，并明写
//   "This catalog contains summaries only; do not infer or follow a skill's instructions
//   until it has been loaded."）—— 先给摘要建立「存在感」，正文等真正调用时再进。
//
// 同步性：`text()` 必须同步返回（注入通道每个 step 同步取文本），而人设清单是异步读盘 →
// 用 stale-while-revalidate：`text()` 同步返回缓存值并在超龄时后台重算，
// `refresh()` 供写操作后立即重算。
import type { PersonaDoc } from './service.js'
import { filterBySceneBinding } from './tools.js'

/**
 * 描述截断长度 —— 照抄官方技能目录的默认值
 * （`dsh-tool-skill` 的 `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500`）。
 *
 * 照抄的理由：截断风格与模型**已经见过的**技能目录一致，不用让它适应两套习惯；
 * 而且这是官方旋钮的默认值，不是本插件拍脑袋定的数。日后 token 成本成为问题时，
 * 官方对应的旋钮是 `catalogDescriptionMaxLength`。
 */
export const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** 段里最多列几个人设；超出部分只报数量，让模型自己去调 subagent_manager_list。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 40

/** 无描述时的占位，与 `subagent_manager_list` 工具的输出保持同一口径。 */
const NO_DESCRIPTION = '(无描述)'

/**
 * 描述归一化 + 截断 —— 逐字对齐官方 `dsh-tool-skill` 的实现：
 * 先把所有空白折叠成单空格，再按长度截断并补省略号。保证「一人设一行」。
 */
export function catalogDescription(value: unknown, maxLength: number): string {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * 渲染人设目录段（纯函数，便于单独推理）。
 *
 * 返回 `''` 表示不注入 —— `renderPrompt` 会删除空段，所以不用人设的用户零 token 成本。
 * 名字按字典序排序：即使底层目录枚举顺序变化，段文本也保持逐字节稳定（前缀缓存契约）。
 *
 * 文案纪律（2026-09-16 用户裁定）：**只写模型能照做的事，不写实现说明**。原文两句里
 * 「该人设的完整提示词会成为子代理的系统提示词」「子代理在独立上下文中执行」都是宿主内部
 * 机制，模型无法据此行动；而委派的调用语义与成本（自包含任务、只回最终结果、会开新会话）
 * 已经写在 `subagent_manager_run` 的描述里 —— 常驻层再重复一遍等于同一件事付两次 token。
 * 第二版（用户指出"太冗余"）：引导语压成**半行** —— 只留「怎么用」，"下面是名字与摘要"这类
 * 自明的话删掉；域是什么由消息引导语与轨迹行名交代，细节由 `subagent_manager_list` 承担。
 */
export function renderSubagentCatalog(
  allowed: readonly PersonaDoc[],
  maxEntries: number = DEFAULT_CATALOG_MAX_ENTRIES,
  maxDescription: number = DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH,
): string {
  if (!allowed.length) return ''
  const sorted = [...allowed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shown = sorted.slice(0, Math.max(0, maxEntries))
  const lines = shown.map((p) => '- **' + p.name + '** — ' + (catalogDescription(p.description, maxDescription) || NO_DESCRIPTION))
  const hidden = sorted.length - shown.length
  const out = [
    '## 子智能体',
    '',
    '**可委派给下列子智能体（调 `subagent_manager_run`）。**',
    '',
    ...lines,
  ]
  // 查询工具**只在真被 40 条上限截掉时**才出现：常态下不提，省常驻字符，也免得模型为了
  // 「确认一遍」去调它（用户裁定：没列出来的就是当前不想要的）。与 MCP 状态段的
  // `（另有 N 台未列出。）` 同一句式，但这里多给一个出口——不给人设就真的找不回来了。
  if (hidden > 0) out.push('', `（另有 ${hidden} 个未列出，用 \`subagent_manager_list\` 查。）`)
  return out.join('\n')
}

export interface SubagentCatalogDeps {
  list(): Promise<PersonaDoc[]>
  sceneLists(): Promise<string[][]>
}

export interface SubagentCatalog {
  /** 同步返回段文本（可能比磁盘状态滞后一个 TTL，见文件头 SWR 说明）。 */
  text: () => string
  /** 立即重算（写操作后调用）。 */
  refresh: () => Promise<void>
  /** 预热：插件加载时调一次，避免首个请求落到空值。 */
  warm: () => Promise<void>
}

export interface SubagentCatalogOptions {
  maxEntries?: number
  maxDescription?: number
  /** 缓存新鲜度；与 rules 的 SNAPSHOT_TTL_MS 同量级。 */
  ttlMs?: number
  /** 供测试注入时钟。 */
  now?: () => number
}

/**
 * 创建 SWR 人设目录。
 *
 * ⚠️ 计算失败（读盘异常等）时**保留上一次的值**，不把段清空 —— 否则一次瞬时 IO 抖动
 * 会让模型突然「忘记」有哪些人设。
 */
export function createSubagentCatalog(
  deps: SubagentCatalogDeps,
  opts: SubagentCatalogOptions = {},
): SubagentCatalog {
  const maxEntries = opts.maxEntries ?? DEFAULT_CATALOG_MAX_ENTRIES
  const maxDescription = opts.maxDescription ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  const ttlMs = opts.ttlMs ?? 1000
  const now = opts.now ?? (() => Date.now())

  let value = ''
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null

  const recompute = async (): Promise<void> => {
    try {
      const { allowed } = await filterBySceneBinding(await deps.list(), await deps.sceneLists())
      value = renderSubagentCatalog(allowed, maxEntries, maxDescription)
    } catch { /* 保留上一次的值；首次失败则维持 '' */ }
    loadedAt = now()
  }

  const revalidate = (): Promise<void> => {
    if (inflight) return inflight
    inflight = recompute().finally(() => { inflight = null })
    return inflight
  }

  return {
    text: () => {
      if (now() - loadedAt > ttlMs) void revalidate()
      return value
    },
    refresh: () => {
      loadedAt = Number.NEGATIVE_INFINITY
      return revalidate()
    },
    warm: () => revalidate(),
  }
}
