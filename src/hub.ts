// dsh-plugin-tool-management —— 统一数据目录（v0.4「一个 hub」）。
//
// 用户在 2026-09-13 提出：插件产生的文件夹/文件全部收在 `$DSH_HOME/tool-management/`
// 一个目录里，方便统一备份与查看。此前它们散在四处：
//
//   $DSH_HOME/scene-memory/                记忆真源            → tool-management/memories/
//   $DSH_HOME/tool-management/             侧车（索引/回收站）  → 就地（hub 根）
//   $DSH_HOME/subagents/                   人设                → tool-management/agents/
//   <插件目录>/data/agents-md-presets/     AGENTS.md 预设库     → tool-management/agents-md/
//
// 最终布局：
//
//   ~/.dsh/tool-management/
//   ├─ memories/<场景>/<名>.md | <场景>/<名>/SKILL.md   记忆正文（真源）
//   ├─ agents/<人设>.md                                  子智能体人设
//   ├─ agents-md/<预设 id>/AGENTS.md                     全局指令基线预设库
//   ├─ skills/                                           插件新建的技能（可写根）
//   ├─ trash/rules-trash/<id>/                           记忆回收站
//   ├─ rules-index.json                                  启停/顺序/场景记录/档案/模式
//   └─ config.json                                       插件设置
//
// 搬运纪律（三条，全部为了「不丢数据」）：
//   1. **只搬不删**——源目录里的文件被 `rename` 走后，空壳目录保留；
//      搬不动的（被占用、跨卷失败）留在原地，下次启动再试。
//   2. **绝不覆盖**——目标已存在同名项时跳过该项，保留目标。
//   3. **每进程一次**——迁移是启动期的一次性动作，失败也不阻断服务（旧目录仍可读）。

import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from './skills/core.js'

/** hub 根目录名（`$DSH_HOME` 下）。 */
export const HUB_DIR = 'tool-management'

/** hub 根绝对路径。 */
export function hubRoot(): string {
  return join(resolveDshHome(), HUB_DIR)
}

/** hub 下的子目录绝对路径。 */
export function hubPath(...segments: string[]): string {
  return join(hubRoot(), ...segments)
}

/** 路径是否存在（不跟随符号链接）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 把一个目录里的**顶层条目**搬到另一个目录（幂等、只搬不删、绝不覆盖）。
 * @param from 源目录（不存在则直接返回 0）
 * @param to 目标目录（自动创建）
 * @param filter 可选的条目过滤（默认全部非隐藏项）
 * @returns 实际搬移的条目数
 */
export async function relocateEntries(
  from: string,
  to: string,
  filter?: (name: string) => boolean,
): Promise<number> {
  if (from === to) return 0
  let names: string[]
  try {
    names = await readdir(from)
  } catch {
    return 0
  }
  await mkdir(to, { recursive: true }).catch(() => undefined)
  let moved = 0
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (filter && !filter(name)) continue
    const src = join(from, name)
    const dest = join(to, name)
    try {
      if (await pathExists(dest)) continue // 绝不覆盖
      try {
        await rename(src, dest)
      } catch {
        // 跨卷 / 目标被占用 → 复制后删源；复制失败则原样留在旧目录（下次再试）。
        await cp(src, dest, { recursive: true })
        await rm(src, { recursive: true, force: true })
      }
      moved++
    } catch {
      /* 单项失败不阻断其余项 */
    }
  }
  return moved
}
