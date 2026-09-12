# ADR-4：双投影（dual projection）

- 状态：已采纳（v0.2）
- 日期：2026-09-12

## 背景

技能是"按需加载"（模型需主动调用 `skill` 工具，只有 `name` + `description` 常驻目录），而 AGENTS.md 是"始终在场"。仅靠 skill 形态无法表达"必须始终遵守"的硬约束；仅靠 AGENTS.md 会把所有规则挤进字节预算。

## 决策

**双投影**：`~/.dsh/rules/` 是唯一真源，投影出两个产物——

| 投影 | 输入 | 输出 | 生效时机 |
|---|---|---|---|
| 按需层 | 可见分组内 `enabled:true` 的规则 | 该 agent 的 skill 目录条目 | 下一次请求（目录变更追加完整替换） |
| 始终层 | 所有分组中 `always:true` 且 `enabled:true` 的规则 | 拼接后的 Markdown 写入 `~/.dsh/AGENTS.md` | 新会话（当前会话不变） |

## 理由

- 硬约束（`always:true`）进 AGENTS.md，首请求即在场、会话内稳定——不会"看起来生效了其实没有"。
- 其余规则保持按需层，不挤占 AGENTS.md 字节预算（默认 `maxBytes` 65536，超限拒绝写入）。
- `always` / `enabled` 以侧车索引为准，不写回规则文件，避免污染用户源文件。

## 后果

- 始终层拼接必须确定性排序（按 group → order → name），禁止时间戳/计数，保证缓存前缀稳定。
- 修改 `always` 开关 = 改写 AGENTS.md（会触发新会话重编译），需在 UI 提示缓存影响。
