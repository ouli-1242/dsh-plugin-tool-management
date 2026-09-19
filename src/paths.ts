// dsh-plugin-tool-management —— 路径段与根内约束的**唯一口径**。
//
// 为什么单独抽一个模块：名字校验此前散在五处（rules / subagents / imports / skills /
// preset-id），每处各写一套，口径不一 —— 有的漏 Windows 保留设备名（`CON` / `NUL`），
// 有的漏 `\0` 与控制字符。于是「同一个名字在 A 域能建、在 B 域不能建」，而漏掉的那两样
// 恰好都是**文件系统层面**的问题：Windows 上以设备名创建目录会失败，NUL 会把路径截断。
//
// 职责边界（写清楚是为了不再长出第六份实现）：
//   - 只判「这个字符串能不能安全地当一个路径段」，不管业务语义（是否保留字、是否重名、
//     是否是 kebab-case）——那些留在各域；
//   - 长度上限由调用方给（人设名 64、技能名 128…），因为那是各域自己的策略，不是安全边界。

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 段名默认长度上限（字符）。 */
export const SEGMENT_MAX_LENGTH = 128

/** Windows 保留设备名：不区分大小写，带扩展名同样非法（`con.md` 也不行）。 */
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** 路径分隔符：出现即意味着「不止一段」。 */
const SEPARATOR_RE = /[\\/]/

/** Windows 保留字符。 */
const RESERVED_CHAR_RE = /[<>:"|?*]/

/** 控制字符（含 NUL、换行、制表）：目录名与日志会不可读，NUL 还会截断路径。 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

/** 段名不合法的原因。各域可据此给出自己的中文文案，而谓词只有一份。 */
export type SegmentProblem =
  | 'empty'
  | 'too-long'
  | 'dot'
  | 'hidden'
  | 'separator'
  | 'reserved-char'
  | 'control-char'
  | 'device-name'
  | 'padding'
  | 'trailing-dot-or-space'

/**
 * 判断一个名字能否作为**单个**路径段。
 * @param name - 待判定的名字；非字符串按不合法处理。
 * @param maxLength - 该域自己的长度上限。
 * @returns 不合法的原因；`null` 表示合法。
 */
export function segmentProblem(name: unknown, maxLength: number = SEGMENT_MAX_LENGTH): SegmentProblem | null {
  if (typeof name !== 'string' || name === '') return 'empty'
  if (name.length > maxLength) return 'too-long'
  if (name === '.' || name === '..') return 'dot'
  if (name.startsWith('.')) return 'hidden'
  if (SEPARATOR_RE.test(name)) return 'separator'
  if (RESERVED_CHAR_RE.test(name)) return 'reserved-char'
  if (CONTROL_CHAR_RE.test(name)) return 'control-char'
  if (WINDOWS_DEVICE_NAME_RE.test(name)) return 'device-name'
  // 首尾空白：Windows 会静默裁剪，导致磁盘上的名字与界面显示的名字不一致。
  if (name !== name.trim()) return 'padding'
  // 末尾的点同理（`foo.` 在 Windows 上落地成 `foo`）。
  if (/[.\s]$/.test(name)) return 'trailing-dot-or-space'
  return null
}

/** 便捷判定：能安全当路径段即为真。 */
export function isValidSegment(name: unknown, maxLength: number = SEGMENT_MAX_LENGTH): boolean {
  return segmentProblem(name, maxLength) === null
}

/**
 * `child` 是否就是 `parent` 本身或位于其下（纯字符串口径，不做 realpath）。
 * 两侧先 `resolve`，因此 `a/../b` 这类写法不会误判成越界或反之。
 * 跨盘符时 `relative` 会返回绝对路径，所以那种情况判为「不在其下」。
 */
export function isSameOrDescendant(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** `candidate` 是否落在 `root` 内（含根本身）。 */
export function isInsideRoot(root: string, candidate: string): boolean {
  return isSameOrDescendant(root, candidate)
}

/**
 * 解析路径的真实落点，**末级允许不存在**：逐级向上找到最近既存祖先做 realpath，
 * 再把尚未存在的部分接回去。
 *
 * 为什么需要它而不是 `lstat`：`lstat` 只看末级。中间目录若是符号链接，
 * `<root>/办公/x.md` 拼出来看着在根内，实际会写到链接指向的地方 ——
 * 只有把中间段也解析成真实路径才拦得住。
 */
export async function realPathOf(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(await realpath(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * 路径经 realpath 解析后是否仍在根内（含根本身）。
 * 供「写入 / 删除之前」的根内断言使用，是 `isInsideRoot` 的防符号链接版本。
 */
export async function isInsideRootResolved(root: string, candidate: string): Promise<boolean> {
  const [rootReal, candidateReal] = await Promise.all([realPathOf(root), realPathOf(candidate)])
  return isSameOrDescendant(rootReal, candidateReal)
}
