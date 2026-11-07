// 目录上限的**出厂值** —— 单一真相。
//
// 为什么单独一个模块：这三个数原先各住在自己的目录模块里（技能的条数、MCP 的条数、子智能体的
// 条数与描述长度），而兼容页的输入框还要拿它们当 placeholder 灰显 —— 同一组数有了三份来源，
// 改一次默认值要改三四处，漏一处界面就显示陈旧值（技能条数 50→100 那次就手改了三处）。
//
// 无 import（叶子模块）：目录模块、设置侧车与界面都从这里取，避开任何循环依赖。
//
// 界面的取值路径：`inject-settings` op 的回包里带一份（见 settings-sidecars.ts），
// 客户端只作兜底 —— 拿不到时用自己那份字面量，宁可显示旧值也不显示空。
export const CATALOG_CAP_DEFAULTS = {
  /** 技能目录最多列几条。 */
  skills: 100,
  /** 技能目录单条描述的最大字符数。 */
  skillsDescription: 500,
  /** MCP 状态段最多列几台服务器。 */
  mcp: 50,
  /** 子智能体目录最多列几个人设。 */
  subagents: 50,
  /** 子智能体目录单条描述的最大字符数。 */
  subagentsDescription: 500,
} as const

/** 目录上限的键名（服务端与界面共用的字段名清单）。 */
export type CatalogCapKey = keyof typeof CATALOG_CAP_DEFAULTS
