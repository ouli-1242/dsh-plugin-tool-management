# dsh-plugin-tool-management · 回收站 UI 与白屏修复（2026-10-13 晚）

基线：官方 0.19.1（本机改动版版本号已改为 0.20.1，仅本地，不发布）

## 怎么发给作者（沿用上次那套）
1. 仓库：https://github.com/ouli-1242/dsh-plugin-tool-management （公开，Issue/PR 均开放）
2. 方式二选一：
   - 提 Issue：标题「若干回收站 UI 改进 + 打开回收站必现白屏的 bug 修复（基于 0.19.1，附 diff）」
     正文用 README-给作者.md；diff 用 chunk-*.diff 内容或 gist 链接
   - 走 PR：先在 0.20.0 上重放对应块（作者 #9 回复里挑仍缺的项），再 push 到自己的 fork
3. 本次与上次「清理/发送」的关系：本目录是新增材料，上一目录 dsh-tm-patches-20261013 原样保留

## 本次五块
- chunk-5 purgePersonaMany 作用域修复（开回收站必白屏）—— 优先发
- chunk-1 回收站弹窗高度自适应（含分栏空态居中）
- chunk-3 空态图标统一为 0.20.0 的 EmptyState.boxIcon
- chunk-4 场景/子智能体回收站改用记忆回收站同款弹窗
- full-0191-official-vs-ours.diff 完整差异（仅 255 行）

## 大改动（另计）
- 场景「新增/编辑」与档案、改描述合并为单弹窗（紧凑布局）：如需 PR 可在 0.20.0 上重做
