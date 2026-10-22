// 用户级提示词那一槽的层级选择 —— 纯函数（含冻结快照层）。
//
// 顺序（上赢下）：本会话自定义正文 > 本会话引用的预设 > 场景绑定预设 >
// **本会话创建时的 AGENTS.md 快照** > 当前 ~/.dsh/AGENTS.md。
// 项目指令链不在这张表里：它永远拼在用户级之前，不受会话覆盖影响。
//
// 快照层的判据是"有没有这份快照"，不是"快照里有没有字"：创建时文件是空的，
// 这个会话就冻结在"没有全局提示词"—— 之后文件写进内容也不该追上来。
// 只有从来没有快照（捕获失败 / 老装配）才落到当前文件，那是退化路径。
//
// 单独抽出来是为了能钉住顺序本身：`resolvePrompt` 要读盘，层级写错时只有真机才看得出来。

import { clampPromptBaseline } from '../scope/scope-overrides.js'

/**
 * 本会话快照与当前 `~/.dsh/AGENTS.md` 是否**不同**（纯函数）。
 *
 * `baseline === undefined`（没捕获 / 捕获失败）→ false：这一层没有意见，官方照送。
 * `current === undefined`（这一轮读不到文件）→ false：宁可让官方照旧，也不能把两份都拦掉。
 * 当前文件按快照同一预算夹一遍再比 —— 超大文件不该被判成"每一轮都在变"。
 */
export function promptBaselineDiffers(baseline: string | undefined, current: string | undefined): boolean {
  if (baseline === undefined || current === undefined) return false
  return baseline !== clampPromptBaseline(current)
}

/** 五层各自的"这一层有没有东西可给"。 */
export interface PromptLayerAvailability {
  /** 本会话有自定义正文（非空）。 */
  sessionContent: boolean
  /** 本会话引用了一个预设（id 非空）。 */
  sessionPreset: boolean
  /** 生效场景绑了预设（且那份有正文）。 */
  scenePreset: boolean
  /**
   * 本会话有冻结快照（可能为空串）。
   *
   * 空串也是有效的一层：它把下面的当前文件挡住 —— 创建时没有 AGENTS.md 的会话
   * 不该因为后来全局应用了一份预设就突然多出提示词。
   */
  sessionBaseline: boolean
  /** 当前 `~/.dsh/AGENTS.md` 有正文。 */
  globalFile: boolean
}

/** 选中的那一层；`null` = 五层都没内容。 */
export type UserPromptLayer = 'session-content' | 'session-preset' | 'scene-preset' | 'session-baseline' | 'global-file' | null

/** 选用户级提示词取哪一层：会话覆盖 → 会话预设 → 冻结快照 → 全局文件。 */
export function chooseUserPromptLayer(availability: PromptLayerAvailability): UserPromptLayer {
  if (availability.sessionContent) return 'session-content'
  if (availability.sessionPreset) return 'session-preset'
  if (availability.scenePreset) return 'scene-preset'
  if (availability.sessionBaseline) return 'session-baseline'
  if (availability.globalFile) return 'global-file'
  return null
}
