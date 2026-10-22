// 给「按人设隔离的子组合」用的 Agent Preset 辅助。
//
// 官方从 `SubagentStartRequest` 里拿掉了 persona / toolFilter，而 spawn 出来的子会话仍可以
// 选一份独立预设。所以这里复制父会话声明的那份预设、替换其中的人设行，为子会话注册一个
// 短命的预设 id。克隆体由官方 registry 挂载 —— 官方包里一个字节都不改。

import { createHash } from 'node:crypto'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { renderPersonaPrompt } from './persona-parse.js'
import type { PersonaDoc } from './persona-types.js'

const CHILD_PRESET_PREFIX = 'tool-management-child-'
const JS_EXPR_TAG = 'tag:yaml.org,2002:js'

const jsExprType = new Type(JS_EXPR_TAG, {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  represent: (data: object) => (data as { __jsExpr: string }).__jsExpr,
})
const entryListSchema = JSON_SCHEMA.extend(jsExprType)

/** `!!js` 标量（官方 `entryListSchema` 的 `JsExpr`）：克隆时只带 `__jsExpr` 一个键。 */
function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && '__jsExpr' in value
}

interface PresetRoster {
  composedPreset?: (agentCtx: unknown) => string | undefined
  readDocument?: (id: string) => Promise<{ content?: unknown } | null | undefined>
  register?: (definition: PresetDefinition) => Promise<() => Promise<void>>
}

function presetRosterOf(ctx: any): PresetRoster | undefined {
  try {
    return ctx?.get?.('agentPresets') as PresetRoster | undefined
  } catch {
    return undefined
  }
}

function cloneEntry(value: unknown): unknown {
  if (isJsExpr(value)) return { __jsExpr: (value as { __jsExpr: string }).__jsExpr }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneEntry)
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) copy[key] = cloneEntry(item)
  return copy
}

function isPersonaOrPresetSwitch(row: Record<string, unknown>): boolean {
  if (row.name === '@deepseek-ai/dsh-persona') return true
  // 自定义预设行会替换整个组合；复制它等于悄悄改掉父会话，而不只是覆盖人设。
  return row.name === '@deepseek-ai/dsh-agent-preset'
}

function removePersonaRows(rows: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const value of rows) {
    // 不是对象的行：官方 entry list 不接受它，说明这份组合已不是本插件读懂的形状。
    // 静默原样保留会把"人设"语义悄悄换掉（克隆出来的预设带着看不懂的行），所以明确报错。
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('the parent agent preset composition contains a non-object plugin row; cannot clone it safely')
    }
    const row = value as Record<string, unknown>
    if (isPersonaOrPresetSwitch(row)) continue
    if (row.group === true) {
      const config = Array.isArray(row.config) ? removePersonaRows(row.config) : row.config
      kept.push(cloneEntry({ ...row, config }))
    } else {
      kept.push(cloneEntry(row))
    }
  }
  return kept
}

/** 读父预设声明的那几行，拼出一份子预设定义。 */
export async function childPresetDefinition(parentAgent: any, persona: PersonaDoc): Promise<PresetDefinition> {
  const parentCtx = parentAgent?.ctx
  const roster = presetRosterOf(parentCtx)
  if (!roster || typeof roster.composedPreset !== 'function' || typeof roster.readDocument !== 'function' || typeof roster.register !== 'function') {
    throw new Error(
      'this host lacks the agent-preset read/register API, so no standalone persona can be created for the subagent; upgrade to DSH >= 0.2.1 and enable the agentPresets service',
    )
  }
  const parentPresetId = String(roster.composedPreset(parentCtx) ?? '')
  if (!parentPresetId) throw new Error('this parent session has no agent preset bound; cannot safely create a subagent with a persona')

  const document = await roster.readDocument(parentPresetId)
  if (!document || typeof document.content !== 'string') {
    throw new Error(`failed to read the parent agent preset "${parentPresetId}": readDocument returned no composition YAML`)
  }
  let parsed: unknown
  try {
    parsed = load(document.content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`failed to parse the parent agent preset "${parentPresetId}": ${String((error as Error)?.message ?? error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`the composition of the parent agent preset "${parentPresetId}" is not a list of plugin rows; cannot clone it`)
  }

  const plugins = removePersonaRows(parsed)
  plugins.unshift({
    id: 'tool-management-child-persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: renderPersonaPrompt(persona) },
  })

  // hash 必须覆盖**父预设的组合正文**：同一个 id 的内容可以被 profile 补丁改写，只按
  // id + 人设定哈希会让改过的内容继续复用旧定义（冷恢复/追问时加载的是上一次构建的插件树）。
  const hash = createHash('sha256')
    .update(parentPresetId)
    .update('\0')
    .update(document.content)
    .update('\0')
    .update(persona.name)
    .update('\0')
    .update(renderPersonaPrompt(persona))
    .digest('hex')
    .slice(0, 16)
  return {
    id: CHILD_PRESET_PREFIX + hash,
    name: `persona:${persona.name}`,
    description: `Ephemeral child preset cloned from ${parentPresetId}`,
    plugins: plugins as PresetDefinition['plugins'],
  }
}
