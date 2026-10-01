// 人设的**运行侧**：官方 provider 包是否挂载、按需取用，以及在父 agent 上跑一次委派。
//
// 正文从 subagents/service.ts 的 createSubagentService 闭包里整段搬来，一字未改 ——
// 只把三个闭包作用域的名字改走 deps（moved-verify 按这一类容差机检，容差之外一字不同就报错）。
//
// 为什么是这一刀：`createRequire(import.meta.url)` 造出来的那个 `req` **留在 service.ts**
// 并由 deps 传进来 —— provider 包是按 service.js 自己的位置解析的，把造 req 的那行搬走
// 就等于换了解析基准。传引用才谈得上逐字不变。
// 运行侧不碰人设清单的那份缓存（`cache` / `enabledCache` 都在 service.ts 那一层），
// 所以它只需要 ctx / req / message 三件。

import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSegment } from '../paths.js'
import { resolveDshHome } from '../skills/core.js'
// 深度探针与注入通道共用一份实现（口径分叉就会出现"目录说不能、工具却能"的错配）。
// 方向是 service → context-inject，单向：context-inject 不 import 本模块。
import { subagentDepthOf } from '../context-inject.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'
import { expandUploads, planPersonaImport } from '../imports/upload.js'
import {
  catalogDepthOf,
  emptyResultNote,
  parsePersona,
  renderPersonaPrompt,
  RESULT_MAX,
  textOfBlocks,
} from './persona-parse.js'
import { decideToolFilter } from './tool-filter.js'
import { serializePersona, validPersonaName } from './persona-write.js'
import type { PersonaDoc, SubagentService, ToolFilter } from './persona-types.js'

// 拆出四层后 subagents/service.js 的公开面照旧（index.ts、ops/sessions.ts、scenes/candidates.ts、
// subagents/tools.ts 与契约测试都按这个路径引）。
export {
  catalogInjectedAt,
  catalogDepthOf,
  DEFAULT_PERSONA_CATALOG_DEPTH,
  emptyResultNote,
  neutralizePromptVariables,
  normalizeReasoningEffort,
  parsePersona,
  parsePresetToolRules,
  renderPersonaPrompt,
  REASONING_EFFORT_MAX_LENGTH,
  textOfBlocks,
  UNLIMITED_PERSONA_CATALOG_DEPTH,
} from './persona-parse.js'
export { presetRulesOf, serializePersona, validPersonaName } from './persona-write.js'
export { decideToolFilter } from './tool-filter.js'

export interface RunProviderDeps {
  /** 宿主上下文：委派要在父 agent 上开子 run。 */
  ctx: any
  /** `createRequire(import.meta.url)` 造出来的解析器 —— 基准必须是 service.js，所以由调用方传进来。 */
  req: NodeRequire
  message(e: unknown): string
}

export function createRunProvider(deps: RunProviderDeps): Record<string, any> {
  const PROVIDER_PACKAGES = {
    spawn: { pkg: '@deepseek-ai/dsh-subagent-spawn-in-process', label: 'spawn（新会话）' },
    fork: { pkg: '@deepseek-ai/dsh-subagent-fork-in-process', label: 'fork（继承本次会话）' },
  } as const
  type ProviderKind = keyof typeof PROVIDER_PACKAGES
  const providerMounts: Partial<Record<ProviderKind, { ok: true } | { ok: false; error: string }>> = {}
  function hasProvider(runtime: any, kind: ProviderKind): boolean {
    if (typeof runtime.list !== 'function') return false
    try {
      const names = runtime.list()
      return Array.isArray(names) && names.indexOf(kind) >= 0
    } catch { return false }
  }
  async function ensureProvider(kind: ProviderKind): Promise<any> {
    const runtime = deps.ctx.get?.('subagents')
    if (!runtime || typeof runtime.start !== 'function') {
      throw new Error('子代理服务未挂载（ctx.subagents 缺失；请确认 DSH 版本 ≥0.1.5-rc.2）')
    }
    if (hasProvider(runtime, kind)) return runtime
    // 宿主没有 list() 就探测不了：不重复挂载（避免同名 provider 二次注册），交给 start 报官方错误兜底。
    if (typeof runtime.list !== 'function') return runtime
    if (!providerMounts[kind]) {
      const { pkg, label } = PROVIDER_PACKAGES[kind]
      try {
        const mod = deps.req(pkg)
        if (!mod || typeof mod.apply !== 'function') throw new Error('模块未导出 apply(ctx, config)（版本不匹配？）')
        mod.apply(deps.ctx, { providerName: kind })
        providerMounts[kind] = { ok: true }
      } catch (e) {
        providerMounts[kind] = {
          ok: false,
          error: `${label} provider 不可用：宿主没有注册它，本插件挂载 ${pkg} 也失败（`
            + deps.message(e) + '）。请在宿主 profile 挂载该包（本插件已声明为可选 peerDependency），或安装后重启 DSH。',
        }
      }
    }
    const mount = providerMounts[kind]
    if (!mount || !mount.ok) throw new Error(mount ? mount.error : 'provider 挂载失败（未知原因）')
    if (!hasProvider(runtime, kind)) throw new Error(`${kind} provider 挂载后仍未出现在 ctx.subagents.list()（宿主版本不匹配？）`)
    return runtime
  }

  async function runOnce(parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string }> {
    // 这里**刻意没有**"预算用尽就拒绝"的前置检查（2026-09-17 用户实测后拆掉）。
    // 它此前基于一个错误假设：以为传 `maxDepth: 1` 会让子会话再委派必然失败。实际上官方
    // `dsh-tool-subagent` 的默认是 **3**、provider 只在**传了值**时才校验（`resolveChildDepth`），
    // 所以子代理本来就能继续嵌套。那个检查唯一的净效果是让**我们的**工具比官方严 ——
    // 同一个子会话里官方工具能委派、我们的被自己拦下 —— 而用户真想禁止嵌套也禁止不了。
    //
    // 通道选择（方案 C，2026-09-17）：`inherit` → 官方 fork provider（子会话被**本次会话已完成的
    // 对话**播种，`task` 只需写新增部分）；默认 → spawn（全新会话，任务必须自包含）。
    // 为什么必须有这一档：官方的 `subagent_fork` 靠"继承上下文"赢走过模型的选择 —— 本机实测
    // （session-ee722e23）上下文里明明有「先在这里选人设…用 subagent_manager_run 执行」与
    // `code-review` 人设，模型在**读进 README 之后**仍选了 `subagent_fork`：那能把已读内容带过去、
    // 不必复述。人设通道缺这一档时，"贴合人设的任务"会持续被官方工具抢走 —— 补齐能力比改文案
    // 更根本（模型选的是省力，不是没看见）。fork provider 的能力位（persona / toolFilter /
    // agentOptions）与 spawn 相同，所以请求体不用分叉。
    const kind: ProviderKind = inherit === true ? 'fork' : 'spawn'
    const runtime = await ensureProvider(kind)
    // 工具限制三态：对象 = 调用方已按当前预设决定；null = 调用方明确决定不加限制；
    // undefined = 调用方没决定（如别的入口直接调 runSerial）→ 回落人设里的旧格式全局名单。
    const legacyFilter: ToolFilter | null = (p.tools?.length || p.toolsDeny?.length)
      ? { ...(p.tools?.length ? { allow: p.tools } : {}), ...(p.toolsDeny?.length ? { deny: p.toolsDeny } : {}) }
      : null
    const resolved = toolFilter === undefined ? legacyFilter : toolFilter
    // 官方签名：start(name, request) —— name = ctx.subagents 上的 provider 注册名。
    const run = await runtime.start(kind, {
      label: p.name,
      parent: parentAgent,
      // 官方 SubagentStartRequest.signal 为必填：调用方缺省时给一个永不中止的信号，不传 undefined。
      signal: signal ?? new AbortController().signal,
      prompt: [{ type: 'text', text: task }],
      // 人设不是裸正文：宿主的 persona 槽位（section order 0）原本是部署级短前缀，
      // 框架该由填槽方承担。见 renderPersonaPrompt 的说明 —— 裸拼的后果是模型把它
      // 读成身份句的续写，而不是一个被指定的角色。
      persona: renderPersonaPrompt(p),
      // 工具白/黑名单 → 官方 ToolRestriction（`deny` 优先级高于 `allow`；未知名官方会直接拒绝启动，
      // 所以名单由 index.ts 按当前预设 + 当前真实存在的工具名算好再传进来，见 decideToolFilter）。
      ...(resolved === null ? {} : { toolFilter: resolved }),
      // **刻意不传 `maxDepth`**（2026-09-17 用户裁定，方案 A）：它是官方的**真·递归上限**
      // （`resolveChildDepth` 会抛 `SubagentDepthError`），而我们的 `catalogDepth` 只想决定
      // "目录出现在哪"。传了它会让我们的工具比官方严（1 vs 3），且会要求 provider 具备
      // `depthLimit` capability（不传就没这个依赖）。让 provider 用它自己的默认，与官方
      // 工具的能力保持一致。
      // provider 与 model 是模型路由的两半：DSH 的 resolveModel(provider, model) 不做
      // `provider/model` 字符串拆分，只改 model 会落在**主会话的 provider** 上——跨来源
      // 指定模型（如 sensenova 的 sensenova-6.8-flash-lite）必须两个键一起给。
      // 2026-09-23 加 `reasoningEffort`：条件是"三个键任一有值"—— 只设强度（不改模型）也得
      // 把这个对象发出去，否则那一格永远不生效。官方合并语义（`dsh-subagent/lib/index.js:471-483`）
      // 是"先继承主会话的三项、再用这里的覆盖"，所以只给 reasoningEffort 时 provider/model
      // 照旧继承；反过来，改了 provider/model 而没给 reasoningEffort 时，**继承来的那一档会被
      // 删掉**（回落到该模型自己的默认）—— 那不是 bug，是官方的显式语义。
      ...(p.provider || p.model || p.reasoningEffort
        ? {
            agentOptions: {
              ...(p.provider ? { provider: p.provider } : {}),
              ...(p.model ? { model: p.model } : {}),
              // 类型是官方的品牌串 `ReasoningEffortId`；我们的值本来就是 adapter 自己给的
              // opaque id（界面从 `resolveModelInfo` 的清单里选出来的），所以这里只做归一、
              // 不重新校验 —— 不支持的档位由官方在 provider I/O 之前拒。
              ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort as never } : {}),
            },
          }
        : {}),
    })
    try {
      const result = await run.result   // 官方契约：child 级失败不 reject（stopReason 体现）
      // 只取 `text` 块（见 textOfBlocks）。此前这里只判了 `typeof b.text === 'string'`，
      // 于是 `reasoning` 块被当成正文 —— 子代理返回的正文里混着它的思考（计数、自我校验），
      // 只有思考时整段返回思考。本机 298 条终局消息里 98.7% 命中。
      const text = textOfBlocks(result.output, 'text')
      // 官方 SubagentResult 的诊断字段是 `diagnostic`（旧代码读 .detail 恒空 → 失败时模型只见空输出）。
      const diagnostic = (result as any).diagnostic ? `\n\n[provider] ${String((result as any).diagnostic)}` : ''
      const stopReason = String((result as any).stopReason ?? 'completed')
      return {
        text: ((text || emptyResultNote(result.output, stopReason)) + diagnostic).slice(0, RESULT_MAX),
        runId: String(run.id ?? ''),
        stopReason,
      }
    } finally {
      await run.dispose().catch(() => {})   // 官方前台语义：collection 后即弃
    }
  }

  // v1 串行：同一时刻至多一个子代理运行（设计 §3.2）。
  let chain: Promise<unknown> = Promise.resolve()
  const runSerial = (parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean) => {
    const start = () => runOnce(parentAgent, p, task, signal, toolFilter, inherit)
    const queued = chain.then(start, start)
    chain = queued.catch(() => undefined)
    return queued
  }

  return { PROVIDER_PACKAGES, providerMounts, hasProvider, ensureProvider, runOnce, runSerial }
}
