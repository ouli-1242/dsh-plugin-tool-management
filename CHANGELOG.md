# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- Quick overview → [update.md](docs/update.md)
- User guide → [README](README.md) / [README_EN](README_EN.md)
- Engineering details (root-cause analysis, test data, design decisions) live in git history, not here.

---

## [0.7.0] - 2026-09-15

### Added

- 回收站扩到子智能体 / 场景 / 提示词预设三处：删除都进回收站，可恢复或永久删除（恢复绝不覆盖）。
- 子智能体工具限制改为按 Agent 预设：每个预设一份白/黑名单（互相排斥），运行期按当前预设生效。
- 兼容页「预设注入边界」改版：五列标签（记忆 / 提示词 / 技能 / MCP / 子智能体），绿/红/灰框一眼看出哪个域被预设关掉。

### Security

- 明文密钥改为一律要令牌：「显示密钥」与配置导出没配 `token` 时一律拒绝，不再只靠宿主栅栏。

### Changed

- 已移除的来源并入回收站（分目录/技能两部分，目录支持永久删除）。
- 五处回收站排版统一（固定高度容器、行内边距收紧）。
- MCP「整理补丁」重新上线：删多余启停覆盖块（生效状态不变），界面只留一个按钮。

### Fixed

- 技能页「移除来源 / 恢复读取」死按钮：补客户端 op 映射 + 补进 writeOps 门禁清单。
- `rules-toggle` 不传 `enabled` 时静默 no-op 却返回成功：改为缺参明确拒绝、不写盘。
- 场景档案「技能集」把来源 key 当技能名显示：改为技能名与来源名分开回传，不再显示 `custom-<hash>`。

---

## [0.6.0] - 2026-09-14

### Added

- 「工具 → 兼容」页（第 8 个页签，只读）：宿主版本、能力可用数、每个动作走原生/适配/不可用、降级项与原因。
- `node scripts/doctor.mjs`：命令行版兼容体检。
- `node scripts/host-deps.mjs --fix/--restore`：把插件依赖 junction 到宿主安装。
- 归档分组可重建：工作区登记被删后按会话目录自动重建，可一键重新登记。
- 恢复归档顺带挂回工作区归属（此前会掉进「未分组」）。
- 场景可绑定提示词预设；切换场景直接改写 `~/.dsh/AGENTS.md`（关掉自动恢复基线）。
- 提示词预设库：新建即可写正文、编辑可改 id（= 目录改名，场景绑定自动跟着改）。
- 正在生效的提示词预设不能删除。
- 场景启用改单选（同时只启用一个，新场景默认不启动）。

### Changed

- 兼容判定换底座：源码文本比对 → 模块实体 + 能力探测；拒绝永远在写入之前。
- 技能来源权限语义修正：默认来源必须读取但技能可删；外部目录可停用/移除但技能只读。
- 用户数据搬出插件目录（归档账本等移入 hub）。
- 归档服务改为独立门面：`cordis.patch.yml` 只插入本插件。
- 弹窗按钮统一（取消/关闭只在右上角）。
- 面板语言跟随宿主；会话页与 AGENTS.md 页接入中英词典。
- AGENTS.md 应用保留 5 代备份。
- 提示词预设 id 口径放宽（中文、空格等可用）。
- `history-retention-set` 拒绝小数；`rules-set-active` 必须显式传参；`mcpm-set-enabled` 停用幂等。
- 写操作门禁：先过宿主栅栏，`token` 作为脚本/局域网逃生门。

### Security

- `mcpm-reveal` / `mcpm-export` 额外要求带 `Origin` 头。
- `history-workspace-register` 补入 WRITE_OPS（此前漏了 token 门禁）。

### Fixed

- 进出场景模式会静默改写技能策略（数据污染）：快照只取生效项，已处于目标状态的不再写。
- 导入技能删进回收站拿不回来：按作用域分岔，用户级来源按 key 重新解析路径。
- 技能回收站显示字面量 `undefined`。
- 面板不随宿主语言切换、两页硬编码中文、词条键写错导致界面露原始键名。
- `subagent_run` 确认门早于参数校验：人设不存在时不再先弹卡。
- 删除链路前置实现检查：在任何破坏性步骤之前校验所需方法。
- 英文界面下兼容页结论条仍是中文：改为客户端按当前语言拼。
- 两处过时文案（AGENTS.md 应用说明、创建技能确认卡落点）。

---

## [0.5.1] - 2026-09-13

### Added

- 场景档案弹窗新加段默认一项都不勾：记忆段只预勾本场景已启用的，其余三段是空集。

### Changed

- 档案弹窗「记忆」段只列被编辑场景自己的记忆。
- 场景页排版重做：卡片只留名字+描述+动作，数量收进页首「当前模式」条。
- 保留场景「全局」不再出现在场景页与档案弹窗。

---

## [0.5.0] - 2026-09-13

### Added

- 插件自有技能来源「导入技能」（新建/导入落点，优先级高于 `~/.dsh/skills/`）。
- 「移除来源」= 连目录都不再扫描（文件零改动，可恢复）。
- 场景档案编辑器新增第 4 段「记忆」。
- 人设模型与工具限制收进「高级选项」折叠区。

### Changed

- **破坏性**：插件产生的文件全部收进 `~/.dsh/tool-management/`（旧位置自动搬入）。
- 场景升级为显式记录（带描述与顺序）；空场景合法；根层裸 `.md` 不再注入。
- 斜杠命令全部下线。

### Fixed

- 工具页整页白屏（`sceneLabel` 闭包作用域错）。
- 导出静默丢失（导出写在 `apply` 体内）。
- Skills 页被锁死（状态文件缺键被判非法 → 改为缺键自愈）。

---

## [0.2.0] - 2026-09-12

### Added

- 五个域合并进一个「工具」设置面板：MCP / Skills / AGENTS.md 预设 / History。
- MCP：工具级独立启停、重启只重连不改启停、密钥默认打码、改写补丁前自动 `.bak`（保留 5 份）。
- Skills：接入 `~/.agents` / `~/.codex` / `~/.claude` 与自定义目录；创建 / ZIP 导入 / 回收站；目录后台监听自动刷新。
- AGENTS.md 预设库：多套全局基线，一键应用。
- History：归档会话按项目分组、批量恢复 / 删除、保留期清理；从 Claude Code / Cursor / Codex / 任意文本导入；导出 Markdown / JSONL。

> No separate records exist for 0.1.1 / 0.1.2 / 0.1.3 (git tags only); their differences are not documented here.
