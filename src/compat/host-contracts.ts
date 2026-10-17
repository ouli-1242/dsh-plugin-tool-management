// 宿主**非 peer** 契约的共享清单：运行时探测（compat/probe.ts 的 runtime-only 上报）与
// `scripts/doctor.mjs` 都要读它们，所以只有这一份。
//
// 为什么单独一层：这些包**不在**本插件的 `peerDependencies` 里 —— 宿主不要求插件依赖它们，
// 但插件在运行时按**裸模块名**直接 require（MCP 客户端、人设、全局指令、技能目录）。它们有
// 两个共同点让它们必须被看见：
//   (1) 官方改名或撤掉其中一个，对应功能**静默降级**（不抛错，只是少一半）；
//   (2) 它们不参与模块身份比对（不是硬依赖），所以"两份不同拷贝"那一栏根本看不到它们。
//
// 此前这份清单只活在 doctor 里：命令行看得到，兼容页看不到。而兼容页正是用户升级 DSH 后
// 第一眼看的界面 —— 于是同一个"官方把某个包撤了"的事实，CLI 报得出来、界面报不出来。
// 提升到这里之后两边读同一份（doctor 从 lib/ import，不再自己维护一份）。

/**
 * 一条 canary：某个**标识符字符串**必须继续出现在官方包的入口里。
 *
 * 这不是"实现细节快照"，而是**契约标识**：官方把它改名/拆函数，就是"该人工复核这条契约"的
 * 信号。反过来 needle 还在也不等于语义没变 —— 所以写的是 `why`（这条 needle 守着什么），
 * 而不是"它证明了什么"。
 */
export interface HostContractMarker {
  /** 必须继续出现的标识符（取自官方安装源码）。 */
  readonly needle: string
  /** 这条 needle 守着的契约。 */
  readonly why: string
}

/** 一条"官方包 + 它守住的 canary"的契约。 */
export interface HostModuleContract {
  /** 官方包名（插件按裸名 require）。 */
  readonly package: string
  /** 失去这个包时受影响的功能（界面与 CLI 共用的一句说明）。 */
  readonly feature: string
  /** 包的入口必须继续携带的标识符（空数组 = 只要求包本身还解析得到）。 */
  readonly markers: readonly HostContractMarker[]
}

/**
 * `~/.dsh/AGENTS.md` 的**增量刷新**契约 —— 本插件"应用提示词预设"依赖它。
 *
 * 插件把预设正文写进全局 `AGENTS.md`，然后靠官方**每一步**重新读盘（对比 stat 的 version 与
 * 内容 SHA-1）决定要不要把新正文送进模型。官方一旦改成事件驱动、加 touchedPaths 白名单、或改
 * digest 口径，"应用预设"就会**静默失效**（旧正文继续注入），零报错。
 */
export const AGENTS_MD_REFRESH_PACKAGE = '@deepseek-ai/dsh-agent-instructions'
export const AGENTS_MD_REFRESH_MARKERS: readonly HostContractMarker[] = [
  { needle: 'agentInstructionsHook', why: '每步重读全局 AGENTS.md 的钩子入口' },
  { needle: 'trimmedInstructionDigest', why: '内容同一性 = 去掉首尾空白后的 SHA-1' },
  { needle: 'instructionContentSha1', why: 'SHA-1 摘要口径' },
  { needle: 'sameInstructionChange', why: '按 {action, scope, path, digest} 判「有没有变化」' },
]

/**
 * 运行时按**裸模块名** require 的宿主包，以及每个包守着的契约。
 *
 * 与 `AGENTS_MD_REFRESH_MARKERS` 的分工：那一份是"同一个包内的若干标识符"，这一份是
 * "若干不同的包各要求什么"。合起来才是"官方撤掉了什么"的完整清单。
 */
export const BARE_HOST_MODULE_CONTRACTS: readonly HostModuleContract[] = [
  {
    package: '@deepseek-ai/dsh-mcp-client',
    feature: 'MCP 客户端（MCP 服务器装配的宿主出口）',
    markers: [],
  },
  {
    package: '@deepseek-ai/dsh-persona',
    feature: '人设（子代理人格的读取与解析）',
    markers: [],
  },
  {
    package: AGENTS_MD_REFRESH_PACKAGE,
    feature: 'AGENTS.md 注入（应用提示词预设）',
    markers: AGENTS_MD_REFRESH_MARKERS,
  },
  {
    package: '@deepseek-ai/dsh-tool-skill',
    feature: '技能目录（官方技能挂载的宿主出口）',
    markers: [],
  },
]

/** doctor 的 CLI 用：裸模块名清单（顺序与上面一致）。 */
export const BARE_HOST_MODULE_NAMES: readonly string[] = BARE_HOST_MODULE_CONTRACTS.map((item) => item.package)

/**
 * 官方 JSONL 会话目录布局的 canary —— 历史适配器（`src/sessions/workspace.ts` →
 * `jsonlSessionDirectory`）硬编码了它。
 *
 * 这些是**行为常量**，不是装饰：任何一个变了，适配器就再也不能确认某个转写目录属于它正要删的
 * 那个会话，删除会退化成"只删工件、保留父目录"，而唯一征兆只是插件侧一行日志。那种退化被刻意
 * 做成非致命（工件仍然删掉，且删后经 `persistence.stat` 复核），所以对着一台没活着的宿主做静态
 * 检查，是用户在自己翻出孤儿目录之前唯一能知道漂移的办法。
 */
export const JSONL_LAYOUT_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
export const JSONL_LAYOUT_MARKERS: readonly HostContractMarker[] = [
  { needle: 'session-persistence-jsonl', why: '适配器的后端名门槛' },
  { needle: '_no-cwd', why: '会话头没有 cwd 时落进的桶' },
  { needle: '251', why: '项目段截断长度' },
  { needle: 'padStart(4', why: '~XXXX UTF-16 转义编码' },
]