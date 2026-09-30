// 人设文件的写侧：名字合法性、字符串数组规范化、frontmatter 序列化。
//
// 从 subagents/service.ts 整段搬来，一行未改。只写用户填过的键这条纪律留在函数自己的
// 注释里；名字谓词仍收敛到 ../paths.ts，这里不另写一份。
import { isValidSegment } from '../paths.js'
import { DEFAULT_PERSONA_CATALOG_DEPTH, normalizeReasoningEffort } from './persona-parse.js'
import type { PresetToolRule } from './persona-types.js'

/** 人设名长度上限（字符）。 */
export const PERSONA_NAME_MAX = 64

/**
 * 人设名合法性：谓词收敛到 `../paths.ts`（此前这里与 rules / imports / skills 各写一套，
 * 缺了 Windows 保留设备名与控制字符检查 —— 设备名在 Windows 上创建即失败）。
 * 注意：**不挡花括号**，手写 frontmatter 仍造得出 `{{…}}` 名字，渲染侧照旧做中和
 * （见 renderPersonaPrompt）。
 */
export function validPersonaName(name: string): boolean {
  return isValidSegment(name, PERSONA_NAME_MAX)
}

/** 字符串数组规范化（非数组/空项都丢掉）。 */
export function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x: unknown) => String(x).trim()).filter(Boolean) : []
}

/** 人设文件序列化：frontmatter 只写用户填过的键；正文 = 人设提示词。 */
export function serializePersona(args: any): string {
  const description = String((args && args.description) || '').replace(/\r?\n/g, ' ').trim()
  const provider = String((args && args.provider) || '').trim()
  const model = String((args && args.model) || '').trim()
  // 思考强度：空值**不落盘**（与 `catalogDepth` 默认值同规矩）—— 免得每个新建的人设都多一行
  // 说明"它和默认一样"，也保证老的人设文件回写后逐字节不变。
  const reasoningEffort = normalizeReasoningEffort(args?.reasoningEffort)
  const tools = toStringList(args?.tools)
  // 黑名单字段兼容两种入参名：toolsDeny（UI/camel）与 tools_deny（snake）。
  const toolsDeny = toStringList(args?.toolsDeny ?? args?.tools_deny)
  const byPreset = presetRulesOf(args?.toolsByPreset)
  // 目录注入深度：只在显式给了合法值时写入。默认（1）**不落盘** —— 免得每个新建的人设都
  // 多一行说明"它和默认一样"，也保证老的人设文件回写后逐字节不变。
  // 入参名兼容三种：catalogDepth（新）、maxDepth / max_depth（0.9.5 定稿前的旧名）。
  const catalogDepthRaw = args?.catalogDepth ?? args?.catalog_depth ?? args?.maxDepth ?? args?.max_depth
  const catalogDepth = catalogDepthRaw === undefined || catalogDepthRaw === null || String(catalogDepthRaw).trim() === ''
    ? undefined
    : Number(String(catalogDepthRaw).trim())
  const hasCatalogDepth = catalogDepth !== undefined && Number.isSafeInteger(catalogDepth) && catalogDepth >= 0 && catalogDepth !== DEFAULT_PERSONA_CATALOG_DEPTH
  const body = String((args && args.body) ?? '').trim()
  // `output` 可传字符串（按行拆）或数组（界面直接给数组）：一条要求写成一行重复键。
  const outputLines = (Array.isArray(args?.output) ? args.output.map((v: unknown) => String(v)) : String(args?.output ?? '').split(/\r?\n/))
    .map((line: string) => line.trim())
    .filter((line: string) => line !== '')
  const lines = ['---']
  if (description) lines.push('description: ' + description)
  if (provider) lines.push('provider: ' + provider)
  if (model) lines.push('model: ' + model)
  if (reasoningEffort) lines.push('reasoningEffort: ' + reasoningEffort)
  if (hasCatalogDepth) lines.push('catalogDepth: ' + String(catalogDepth))
  for (const line of outputLines) lines.push('output: ' + line)
  if (tools.length) lines.push('tools: ' + tools.join(', '))
  if (toolsDeny.length) lines.push('toolsDeny: ' + toolsDeny.join(', '))
  if (byPreset.length) {
    lines.push('toolsByPreset:')
    for (const [id, rule] of byPreset) lines.push('  ' + id + ': ' + rule.mode + ': ' + rule.names.join(', '))
  }
  lines.push('---', '', body, '')
  return lines.join('\n')
}
/**
 * 规范化前端传来的 `toolsByPreset`：丢掉空名单（空 = 不限制 = 不落盘），
 * 模式 id 只收形状合法的（预设 id 允许字母数字点横线）。
 */
export function presetRulesOf(value: unknown): Array<[string, PresetToolRule]> {
  if (value === null || typeof value !== 'object') return []
  const out: Array<[string, PresetToolRule]> = []
  for (const [rawId, rawRule] of Object.entries(value as Record<string, unknown>)) {
    const id = String(rawId).trim()
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) continue
    if (rawRule === null || typeof rawRule !== 'object') continue
    const rec = rawRule as { mode?: unknown; names?: unknown }
    const names = toStringList(rec.names)
    if (!names.length) continue
    out.push([id, { mode: String(rec.mode) === 'deny' ? 'deny' : 'allow', names }])
  }
  return out
}