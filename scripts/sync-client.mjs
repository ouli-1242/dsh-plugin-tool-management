// Sync the browser half into the build output.
//
// 客户端源码拆在 src/client/*.js（按语义分片），交付时**拼回单文件** lib/client.js。
//
// 为什么必须拼：宿主的客户端契约是 `window.__ModuleLoader__.load({ id, factory })`
// 单文件注册，package.json 也只声明一个 `./client` 入口。本机 profile 里四个带 client
// 的插件（本插件 / dsh-better-sidebar / @anionex/dsh-turn-rewind / dshmarket）全是单文件，
// 所有 require 都是裸包名，**没有一处相对路径 require** —— 宿主加载器不在 node_modules
// 里，无法本地验证它支不支持相对解析，而「不改宿主机制」是硬约束。所以拆分只能发生在
// 构建期，交付物与拆分前逐字节一致。
//
// 分片之间不写 import/export：它们共享同一个 factory 作用域。拼接顺序即 SLICES 的顺序，
// 顺序错了会在求值时炸（const 的 TDZ / 未定义名），不会静默 —— 这是刻意保留的失败方式。
//
// src/client.js 已删除（它原本就是这 13 个分片的拼接结果），本脚本是 lib/client.js 唯一的
// 生成者。没有这一步 tsc 也不会写它（src/client.js 被 tsconfig.json 排除，是浏览器 JS
// 不是宿主 TS），于是改完源码却发着旧产物 —— 正是当初产生「开关没反应」（旧 lib/client.js
// 引用了已不存在的符号）的那个失效模式。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 拼接顺序 = 阅读顺序：头 → 样式 → 词典 → apply（页面按导航顺序）→ 收尾。 */
const SLICES = [
  '00-prelude.js',      // 文件头注释 + ModuleLoader 注册头 + React
  '10-css.js',          // CSS：设计变量与全部 dsm-* 规则
  '20-helpers.js',      // 核心 helper：异常文案 / 样式注入 / 令牌行 / 备份清理 / 通用小工具
  '30-dict.js',         // DICT：中英两份词典
  '40-apply-head.js',   // apply 开头：取词服务、slots 守卫、各页共享的 mt / opMsg
  '41-mcp.js',          // FeedbackLinks + MCPPage + PromptsPage + ToolsSection
  '42-shared-ui.js',    // 通用 helper 与弹窗：callApi / Modal / Trash / Import / Export / DirPicker
  '43-skills.js',       // SkillManagerSection + historyView
  '44-sessions.js',     // SessionsPage + 场景纯函数（sceneLabel / clipText / …）
  '45-scenes.js',       // ScenesPage
  '46-subagents.js',    // SubagentsPage + memoryView
  '47-memory.js',       // MemoryPage
  '90-apply-tail.js',   // apply 收尾（注册各页 + 导出 _pages）
]

const parts = SLICES.map((name) => readFileSync(join(root, 'src', 'client', name), 'utf8'))
// 分片末尾不带换行（切分时按行 join），所以片间必须补一个 —— 否则上一片末行与下一片首行
// 会粘成一行（实测症状是 `…字面量只留下面那一处。    const CSS =`，`node --check` 直接报语法错）。
const eol = parts[0].includes('\r\n') ? '\r\n' : '\n'
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), parts.join(eol))
console.log(`[dsh-plugin-tool-management] 拼接 ${SLICES.length} 个分片 -> lib/client.js`)
