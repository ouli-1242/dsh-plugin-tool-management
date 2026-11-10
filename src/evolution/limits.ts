// 自主记忆学习频率的出厂值与夹取范围 —— 单一真相。
//
// 为什么单独一个叶子模块：默认值同时被配置归一化（config.ts）与门禁（gates.ts）读取；
// 写在任一模块里都会让另一个反向依赖，且改默认值要改两处。
//
// 条数本身没有总上限：记忆多了只影响注入预算，不拒绝写入。这里限制的是**产生速度** ——
// 每层在窗口内最多新增多少条，防止 agent 在一轮里刷屏。合并 / 更新已有条目不占名额。
// 窗口长度与条数都由用户配置；全局 / 工作区共用同一份设置，但各自独立计数。

/** 出厂频率：每 10 分钟最多新增 5 条。 */
export const NOTE_RATE_DEFAULTS = {
  minutes: 10,
  notes: 5,
} as const

/** 窗口下限：1 分钟。0 会让窗口永远为空，频率门形同虚设。 */
export const NOTE_RATE_MINUTES_MIN = 1
/** 窗口上限：一天。再长就不像「频率」而像总配额了。 */
export const NOTE_RATE_MINUTES_MAX = 24 * 60

/** 条数下限：至少允许 1 条，0 会让这一层永远学不进来。 */
export const NOTE_RATE_NOTES_MIN = 1
/** 条数上限：一个窗口 100 条已经远超正常对话节奏，再大等于关掉频率门。 */
export const NOTE_RATE_NOTES_MAX = 100
