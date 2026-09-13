# AGENTS.md

本项目是 DeepSeek Harness (DSH) 插件 `dsh-plugin-tool-management`，使用 SuperWork skill 套件（docs/ 中文文档约定）。开工前先读：

- `docs/文档导航.md` — 文档索引门面（所有产物的入口）
- `README.md`「开发」节 — 本项目自述的结构约定（宿主端 TS 对象插件 / 技能核心纯 JS / 浏览器端 client bundle；发布产物在 `lib/`）
- `docs/审查/2026-09-13-全项目对抗性审查.md` — 全项目双轴评审基线（改代码前先看已知问题清单，勿重复踩坑）

关键约定：

- 宿主端 `src/index.ts` 是 Cordis 对象插件（`{name, inject, apply}`），浏览器端 `src/client.js` 经 `scripts/sync-client.mjs` 逐字节复制到 `lib/`（不走 tsc，勿改该同步语义）。
- 五域（MCP / Skills / AGENTS.md / History / 场景记忆）的 op handler、鉴权白名单、持久化方式当前各域独立实现——改动时注意与既有域风格对齐，收敛重复是既定改进方向（见审查报告 Important #6/#7）。
- `src/history/workspace.js` / `projcache.js` 是对官方 DSH 服务的子类化替换，触达官方私有成员——升级官方包时按审查报告「升级韧性评估」三项逐一回归。
- 场景记忆：模块路径与 op 名保留 `rules-*` 内部协议，用户可见名称为「场景记忆」/`scene-memory/`（README 已声明，勿单方面改名）。
- 验证方式：本项目无测试套件，改动后跑真实行为（`npm run build` + 手动验收），并在对应文档登记验收项。

产物按类型落 `docs/<类型>/` 并在文档导航登记。无条件纪律：证据先于声称、合并前评审、产物落盘+登记、诚实边界+红队自查。
