// 自主记忆每层条数上限的出厂值与夹取范围 —— 单一真相。
//
// 为什么单独一个叶子模块：默认值同时被配置归一化（config.ts）与门禁的兜底配额
// （gates.ts）读取；写在任一模块里都会让另一个反向依赖，且改默认值要改两处。
// 会话 / 场景两层仍走 gates.ts 的 `LAYER_QUOTA`（界面不暴露，不在这里配）。

/** 每层最多保留多少条活着的自主记忆（归档 / 已取代不占配额）。 */
export const NOTE_CAP_DEFAULTS = {
  global: 100,
  workspace: 200,
} as const

/** 允许配置的下限：至少留一条，0 会让这一层永远学不进来。 */
export const NOTE_CAP_MIN = 1
/** 上限：超过这个数，记忆列表本身已经不适合逐条管理；再大也只是把问题推迟。 */
export const NOTE_CAP_MAX = 1000
