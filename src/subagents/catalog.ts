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
import { catalogInjectedAt } from './service.js'
import { subagentDepthOf } from '../context-inject.js'
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
export const DEFAULT_CATALOG_MAX_ENTRIES = 50

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
 * ⚠️ 传进来的 `allowed` 必须**已经按当前会话的目录注入深度过滤过**（调用方
 * `createSubagentCatalog.text` 负责，用 `catalogInjectedAt`）。这里刻意不再过滤一遍：
 * 判据只该有一个来源，本函数只管排版。
 *
 * 返回 `''` 表示不注入 —— `renderPrompt` 会删除空段，所以不用人设的用户零 token 成本。
 * 名字按字典序排序：即使底层目录枚举顺序变化，段文本也保持逐字节稳定（前缀缓存契约）。
 *
 * 文案纪律（2026-09-16 用户裁定）：**只写模型能照做的事，不写实现说明**。原文两句里
 * 「该人设的完整提示词会成为子代理的系统提示词」「子代理在独立上下文中执行」都是宿主内部
 * 机制，模型无法据此行动；而委派的调用语义与成本（自包含任务、只回最终结果、会开新会话）
 * 已经写在 `subagent_manager_run` 的描述里 —— 常驻层再重复一遍等于同一件事付两次 token。
 *
 * 第三版（2026-09-17 用户指出"还是那句套话"）：**职责彻底切开** —— 本函数只排版清单
 * （`- **名字** — 描述`），"这是什么 + 该拿它做什么"整句交给注入通道的引导语。于是这里
 * 既没有标题也没有"可委派给下列子智能体"那句：一处内容只有一个出处。
 */
export function renderSubagentCatalog(
  allowed: readonly PersonaDoc[],
  maxEntries: number = DEFAULT_CATALOG_MAX_ENTRIES,
  maxDescription: number = DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH,
  listToolVisible: boolean = true,
): string {
  if (!allowed.length) return ''
  const sorted = [...allowed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shown = sorted.slice(0, Math.max(0, maxEntries))
  const lines = shown.map((p) => '- **' + p.name + '** — ' + (catalogDescription(p.description, maxDescription) || NO_DESCRIPTION))
  const hidden = sorted.length - shown.length
  // 只给清单。"这是什么"与"该拿它做什么"由注入通道的框架交代 —— 2026-09-18 起是
  // context-inject.ts 的 `DOMAIN_FRAME.subagents`（标题 + 加粗的动作句 + 工具名行）。
  // 这里原本还有 `## 子智能体` 标题与一句加粗的「可委派给下列子智能体（调 `subagent_manager_run`）。」
  // —— 加上引导语，同一件事说了三遍（用户 2026-09-17 指出）。正文从此只管排版。
  const out = [...lines]
  // 查询工具**只在真被 40 条上限截掉时**才出现：常态下不提，省常驻字符，也免得模型为了
  // 「确认一遍」去调它（用户裁定：没列出来的就是当前不想要的）。与 MCP 状态段的
  // `（另有 N 台未列出。）` 同一句式，但这里多给一个出口——不给人设就真的找不回来了。
  if (hidden > 0) {
    // 与技能目录同一条纪律：点名一个被关掉的工具只会让模型去猜名字。数量照报。
    out.push('', listToolVisible
      ? `（另有 ${hidden} 个未列出，用 \`subagent_manager_list\` 查。）`
      : `（另有 ${hidden} 个未列出。）`)
  }
  return out.join('\n')
}

export interface SubagentCatalogDeps {
  list(): Promise<PersonaDoc[]>
  sceneLists(): Promise<string[][]>
  /** `subagent_manager_list` 还在模型工具表里吗（截断提示里那句话的前提）。默认在。 */
  listToolVisible?: () => boolean
}

export interface SubagentCatalog {
  /**
   * 同步返回段文本（可能比磁盘状态滞后一个 TTL，见文件头 SWR 说明）。
   *
   * `agent` 决定**按深度过滤**：只列出目录**该注入到**该深度会话的人设（判据
   * `深度 < 该人设的 catalogDepth`）。不传 agent 时按深度 0 算（顶层），这是绝大多数
   * 调用点的情形。
   */
  text: (agent?: unknown) => string
  /**
   * 深度为 `depth` 的会话里，目录**有没有内容可注入**（至少一个当前可用人设的
   * `catalogDepth` 覆盖到该深度）？
   *
   * 同步、只读缓存 —— 域声明的 `applicableTo` 要求同步纯函数（注入通道每个 step 同步取文本）。
   * 与 `text()` 同源：都用 `catalogInjectedAt`，所以"目录里有内容"与"域该不该注入"不会分叉。
   */
  catalogVisibleAt: (depth: number) => boolean
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

  let allowed: PersonaDoc[] = []
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null
  // 渲染结果按**深度**缓存：过滤只依赖深度这一个整数，而实际出现的深度就 0/1/2 三档，
  // 于是"每个 step 同步渲染"退化成一次查表。重算成功时清空。
  const rendered = new Map<number, string>()

  const recompute = async (): Promise<void> => {
    try {
      allowed = (await filterBySceneBinding(await deps.list(), await deps.sceneLists())).allowed
      rendered.clear()
    } catch { /* 保留上一次的值；首次失败则维持 [] */ }
    loadedAt = now()
  }

  const revalidate = (): Promise<void> => {
    if (inflight) return inflight
    inflight = recompute().finally(() => { inflight = null })
    return inflight
  }

  return {
    text: (agent) => {
      if (now() - loadedAt > ttlMs) void revalidate()
      const depth = subagentDepthOf(agent)
      const cached = rendered.get(depth)
      if (cached !== undefined) return cached
      const out = renderSubagentCatalog(
        allowed.filter((p) => catalogInjectedAt(p, depth)),
        maxEntries,
        maxDescription,
        deps.listToolVisible ? deps.listToolVisible() : true,
      )
      rendered.set(depth, out)
      return out
    },
    catalogVisibleAt: (depth) => allowed.some((p) => catalogInjectedAt(p, depth)),
    refresh: () => {
      loadedAt = Number.NEGATIVE_INFINITY
      return revalidate()
    },
    warm: () => revalidate(),
  }
}
