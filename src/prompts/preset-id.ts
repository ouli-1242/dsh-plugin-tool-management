// dsh-plugin-tool-management —— 提示词预设 id 的唯一口径。
//
// 用户裁定（2026-09-15）：「id 应该什么都能写」——不再限定小写字母/数字/连字符，
// 中文、空格、下划线、点都可以。id 同时也是**磁盘目录名**，所以只保留两类硬约束：
//   ① 文件系统安全：交由 `../paths.js` 的共享谓词判定（不含路径分隔符与 Windows 非法字符、
//      不以点开头/结尾、不是 `.` / `..`、不是 Windows 保留设备名、不含控制字符）；
//   ② 一个保留字：`__last-applied__`（apply 的备份槽，不是用户预设）。
// 这套口径由提示词服务（prompts/ 目录）与场景绑定（`scenes[].prompt`）共用，避免两处漂移。
// 约定镜像 @deepseek-ai/dsh-agent-presets 的「id 即目录名」，但放宽了字符集。

import { segmentProblem, type SegmentProblem } from '../paths.js'

/** id 长度上限（字符数；目录名过长在 Windows 上还受 MAX_PATH 约束）。 */
export const PRESET_ID_MAX = 64

/** apply 的备份槽：不是用户预设，任何入口都不得当作预设 id。 */
export const LAST_APPLIED_PRESET_ID = '__last-applied__'

/** 把共享谓词给的原因翻成这个域自己的文案：规则只有一份，消息留在这里。 */
function presetIdProblemText(problem: SegmentProblem, id: string): string {
  switch (problem) {
    case 'empty': return 'id 不能为空'
    case 'too-long': return `id 过长（≤${PRESET_ID_MAX} 字符，当前 ${id.length}）`
    case 'dot': return 'id 不能是「.」或「..」'
    case 'hidden': return 'id 不能以「.」开头'
    case 'separator': return 'id 不能含路径分隔符（/ 或 \\）'
    case 'reserved-char': return 'id 不能含 < > : " | ? * 这些字符'
    case 'control-char': return 'id 不能含控制字符'
    case 'device-name': return `「${id}」是 Windows 保留设备名`
    case 'padding': return 'id 不能含首尾空白'
    case 'trailing-dot-or-space': return 'id 不能以点或空格结尾（Windows 会静默去掉）'
  }
}

/**
 * 校验并归一化一个预设 id。
 * @param raw - 用户输入或来自索引的原始值。
 * @returns `{ ok: true, id }`（已 trim）或 `{ ok: false, error }`（给人看的中文原因）。
 */
export function normalizePresetId(raw: unknown): { ok: true; id: string } | { ok: false; error: string } {
  const id = String(raw ?? '').trim()
  if (id === LAST_APPLIED_PRESET_ID) return { ok: false, error: `「${LAST_APPLIED_PRESET_ID}」是「应用」的备份槽，不能用作预设 id` }
  // 文件系统安全那一组交给共享谓词（`../paths.js`）—— 此前这里与 rules / subagents /
  // imports / skills 各写一套，五份实现迟早会漂。长度上限仍是本域自己的策略。
  const problem = segmentProblem(id, PRESET_ID_MAX)
  if (problem !== null) return { ok: false, error: presetIdProblemText(problem, id) }
  return { ok: true, id }
}

/** 便捷判定（索引解析等只关心"能不能用"的地方）。 */
export function isValidPresetId(raw: unknown): boolean {
  return normalizePresetId(raw).ok
}
