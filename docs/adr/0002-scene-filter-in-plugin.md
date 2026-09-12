# ADR-2：场景与规则的绑定由插件运行时决定

- 状态：已采纳（v0.2）
- 日期：2026-09-12

## 背景

"场景"（scene）需要把某套规则可见集合绑定到某个 agent preset。实现途径有两种：改写 preset 的 `agent.cordis.yml`（在会话创建时固化），或由插件在运行时读取会话的 preset 并按绑定过滤。

## 决策

**插件运行时决定**：读 `session.header.agentPreset`（per-agent provider 的 `agent/created` 钩子），结合 `scenes.json` 的"preset → 分组集合"绑定，动态投影该 agent 可见的规则。**绝不编辑 `agent.cordis.yml`**。

## 理由

- preset 是随包交付的只读资源；编辑它会被升级覆盖、且破坏"随包不可改"的语义。
- 绑定关系是用户数据（`scenes.json` 侧车），与 preset 文件解耦，升级插件不丢绑定。
- 会话创建时 preset 固定不可改，但规则的启停/绑定是活的——运行时过滤让绑定变更即时生效（新会话）。

## 后果

- 每个 agent 需要独立注册 skill provider（照抄 `src/skills/service.ts` 的 per-agent 安装/卸载形态）。
- 需要从 host 读到 preset 的 roster（spike S1：扫 `$DSH_HOME/.agent-presets/`）。
