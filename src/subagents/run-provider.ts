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
import { randomUUID } from 'node:crypto'
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
import { childPresetDefinition } from './child-preset.js'
import { serializePersona, validPersonaName } from './persona-write.js'
import type { PersonaDoc, SubagentService, ToolFilter } from './persona-types.js'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

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
    spawn: { pkg: '@deepseek-ai/dsh-subagent-spawn-in-process', label: 'spawn (fresh session)' },
    fork: { pkg: '@deepseek-ai/dsh-subagent-fork-in-process', label: 'fork (inherits this session)' },
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
    if (!runtime || typeof runtime.startActivation !== 'function') {
      throw new Error('the subagent service is not mounted or lacks startActivation (ctx.subagents is missing; check that DSH is >= 0.2.1-rc.2)')
    }
    if (hasProvider(runtime, kind)) return runtime
    // 宿主没有 list() 就探测不了：不重复挂载（避免同名 provider 二次注册），交给 start 报官方错误兜底。
    if (typeof runtime.list !== 'function') return runtime
    if (!providerMounts[kind]) {
      const { pkg, label } = PROVIDER_PACKAGES[kind]
      try {
        const mod = deps.req(pkg)
        if (!mod || typeof mod.apply !== 'function') throw new Error('the module does not export apply(ctx, config) (version mismatch?)')
        mod.apply(deps.ctx, { providerName: kind })
        providerMounts[kind] = { ok: true }
      } catch (e) {
        providerMounts[kind] = {
          ok: false,
          error: `the ${label} provider is unavailable: the host did not register it and mounting ${pkg} from this plugin failed too (`
            + deps.message(e) + '). Mount that package in the host profile (this plugin declares it as an optional peerDependency), or install it and restart DSH.',
        }
      }
    }
    const mount = providerMounts[kind]
    if (!mount || !mount.ok) throw new Error(mount ? mount.error : 'provider mount failed (unknown reason)')
    if (!hasProvider(runtime, kind)) throw new Error(`the ${kind} provider still does not appear in ctx.subagents.list() after mounting (host version mismatch?)`)
    return runtime
  }

  /**
   * Install the persona's optional tool mask on one exact child scope. The
   * official request no longer accepts toolFilter, so this is the only place
   * the mask can be applied without widening the child's inherited tools.
   *
   * Must run inside `agent/created` for that exact child (0.2.1)：the official
   * factory awaits every serial `agent/created` listener **before** it releases
   * the queued first prompt (`dsh-agent/lib/types/index.js:334` → `announce`),
   * so a restriction installed here is already in force at the child's first
   * tool call. Installing after `startActivation()` resolves would race: the
   * first turn could already have run with the inherited tools.
   */
  function restrictChildTools(childAgent: any, filter: ToolFilter): () => void {
    const tools = childAgent?.ctx?.get?.('tools')
    if (!tools || typeof tools.restrict !== 'function') {
      throw new Error('the subagent tool scope lacks tools.restrict(); cannot apply a tool restriction')
    }
    const dispose = tools.restrict(filter)
    return typeof dispose === 'function' ? dispose : () => undefined
  }

  /**
   * 临时子预设的引用计数表：同一份定义（父预设 + 人设）只注册一次。
   *
   * 三件事逼着它存在（0.2.1）：
   *   ① 复用 —— 同一个 (父预设, 人设) 反复委派时重复 `register()` 会因官方
   *      `Duplicate agent preset` 直接失败；
   *   ② 失败路径释放 —— 启动失败还留着定义，会在宿主 registry 里堆一份永久的插件树，
   *      还会出现在 `agentPresets.list()` 的名单里；
   *   ③ 追问子代理**不能**在启动后立刻注销 —— 冷恢复按 `agent-preset/selected` 投影找预设
   *      （`dsh-subagent/lib/index.js` → `NOT_RESUMABLE`），提前注销会让后续追问失败。
   * 引用归零才真正注销；插件卸载时统一释放（见 installChildPresetCleanup）。
   */
  const presetLeases = new Map<string, { refs: number }>()
  /** 已注册的临时预设 → 官方返回的注销函数。 */
  const presetUnregisters = new Map<string, () => Promise<void>>()

  /**
   * 取（必要时注册）一份临时子预设的引用；返回的 release 由调用方在 finally 里调。
   */
  async function acquireChildPreset(definition: PresetDefinition): Promise<() => Promise<void>> {
    const id = definition.id
    const existing = presetLeases.get(id)
    if (existing !== undefined) {
      existing.refs += 1
      return async () => {
        const lease = presetLeases.get(id)
        if (lease === undefined || lease !== existing) return
        lease.refs -= 1
        if (lease.refs > 0) return
        presetLeases.delete(id)
        const unregister = presetUnregisters.get(id)
        if (unregister === undefined) return
        presetUnregisters.delete(id)
        await unregister().catch(() => undefined)
      }
    }
    const roster = deps.ctx.get?.('agentPresets')
    if (!roster || typeof roster.register !== 'function') {
      throw new Error('the agentPresets service is unavailable: cannot register the subagent persona preset')
    }
    let unregister: () => Promise<void>
    try {
      unregister = await roster.register(definition)
    } catch (error) {
      throw new Error(`failed to register the subagent persona preset: ${deps.message(error)}`)
    }
    presetLeases.set(id, { refs: 1 })
    presetUnregisters.set(id, unregister)
    return async () => {
      const lease = presetLeases.get(id)
      if (lease === undefined) return
      lease.refs -= 1
      if (lease.refs > 0) return
      presetLeases.delete(id)
      presetUnregisters.delete(id)
      // 释放失败只影响清理，绝不让它盖住主路径的错误（调用方一律 catch 掉）。
      await unregister().catch(() => undefined)
    }
  }

  /** 插件卸载（HMR / 停用 / 更新）时释放全部临时预设。 */
  function installChildPresetCleanup(): void {
    if (typeof deps.ctx?.effect !== 'function') return
    try {
      deps.ctx.effect(() => () => {
        presetLeases.clear()
        const unregisters = [...presetUnregisters.values()]
        presetUnregisters.clear()
        // 串行释放：官方 unregister 会 retire 一代并等它被收集，并发会互相踩代数。
        let chain: Promise<void> = Promise.resolve()
        for (const unregister of unregisters) {
          chain = chain.then(() => Promise.resolve(unregister()).catch(() => undefined))
        }
        void chain
      }, 'dsh-plugin-tool-management: child preset cleanup')
    } catch { /* effect 不可用 → 只影响清理，不影响本次委派 */ }
  }
  installChildPresetCleanup()
  async function runOnce(parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string; continuable?: true }> {
    // 这里**刻意没有**"预算用尽就拒绝"的前置检查：宿主统一决定委派深度
    // （当前默认 maxDepth=1），本工具不传 maxDepth，也不自行判断能否继续委派。
    //
    // 通道选择（方案 C，2026-09-17）：`inherit` → 官方 fork provider（子会话被**本次会话已完成的
    // 对话**播种，`task` 只需写新增部分）；默认 → spawn（全新会话，任务必须自包含）。
    // 为什么必须有这一档：官方的 `subagent_fork` 靠"继承上下文"赢走过模型的选择 —— 本机实测
    // （session-ee722e23）上下文里明明有「先在这里选人设…用 subagent_manager_run 执行」与
    // `code-review` 人设，模型在**读进 README 之后**仍选了 `subagent_fork`：那能把已读内容带过去、
    // 不必复述。人设通道缺这一档时，"贴合人设的任务"会持续被官方工具抢走 —— 补齐能力比改文案
    // 更根本（模型选的是省力，不是没看见）。
    const kind: ProviderKind = inherit === true ? 'fork' : 'spawn'
    const runtime = await ensureProvider(kind)
    // 工具限制三态：对象 = 调用方已按当前预设决定；null = 调用方明确决定不加限制；
    // undefined = 调用方没决定（如别的入口直接调 runSerial）→ 回落人设里的旧格式全局名单。
    const legacyFilter: ToolFilter | null = (p.tools?.length || p.toolsDeny?.length)
      ? { ...(p.tools?.length ? { allow: p.tools } : {}), ...(p.toolsDeny?.length ? { deny: p.toolsDeny } : {}) }
      : null
    const resolved = toolFilter === undefined ? legacyFilter : toolFilter
    // provider 与 model 是模型路由的两半：DSH 的 resolveModel(provider, model) 不做
    // `provider/model` 字符串拆分，只改 model 会落在**主会话的 provider** 上——跨来源
    // 指定模型（如 sensenova 的 sensenova-6.8-flash-lite）必须两个键一起给。
    // 2026-09-23 加 `reasoningEffort`：条件是"三个键任一有值"—— 只设强度（不改模型）也得
    // 把这个对象发出去，否则那一格永远不生效。官方合并语义（`dsh-subagent/lib/index.js:471-483`）
    // 是"先继承主会话的三项、再用这里的覆盖"，所以只给 reasoningEffort 时 provider/model
    // 照旧继承；反过来，改了 provider/model 而没给 reasoningEffort 时，**继承来的那一档会被
    // 删掉**（回落到该模型自己的默认）—— 那不是 bug，是官方的显式语义。
    // 两条通道（一次性 / 可继续）共用这一段，所以提出来只写一次。
    const routeOptions = (p.provider || p.model || p.reasoningEffort)
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
      : {}

    // 0.2.1 起 persona/toolFilter 不再属于 SubagentStartRequest。fork 明确不支持独立
    // Agent Preset，因此带工具限制的 fork 必须在启动前报错，不能静默放宽权限。
    if (kind === 'fork' && resolved !== null) {
      throw new Error(
        'fork does not support its own tool restriction: remove the tools/toolsDeny/toolsByPreset restriction this persona carries in this preset, '
        + 'then use inherit=true; if the tool restriction is required, switch back to the default spawn (inherit=false).',
      )
    }

    let releasePreset: (() => Promise<void>) | undefined
    let agentPreset: string | undefined
    if (kind === 'spawn') {
      const definition = await childPresetDefinition(parentAgent, p)
      releasePreset = await acquireChildPreset(definition)
      agentPreset = definition.id
    }

    const childFilter = kind === 'spawn' ? resolved : null

    // 带工具限制的 spawn：`childId` 由我们预留，并在父 scope 的 `agent/created` 上按
    // **精确 id** 施加限制。
    //
    // 为什么必须这么做（0.2.1 的启动顺序）：官方本地激活的首条 prompt 在 `startLocal()`
    // 里就入 inbox（`dsh-subagent/lib/index.js` 的 `submitMaterialized`），而 announce 是
    // **串行 `agent/created` 监听全部完成后才放行收件箱**（`dsh-agent/lib/types/index.js`
    // 的 `announce` → `await this.ctx.serial(entry.carrier, 'agent/created', …)`）。
    // 所以在这里施加 = 首轮工具调用之前已生效；等 `startActivation()` 返回再
    // `restrict()` 就慢了一步 —— 首轮看到的还是继承来的工具集，人设的工具限制形同虚设。
    //
    // 监听器里取不到 child 或没有 `restrict()` 时**明确抛错**：监听器抛出会让官方把这次
    // 创建判失败并回滚（fail-closed），绝不静默放宽。
    // `childFilter` 只在 !== null 时进入下面的分支，但 TS 的收窄在这里失效（闭包捕获 +
    // 外层 `const childId` 的推导），所以显式把非空那份收窄出来。
    const childFilterValue: ToolFilter | null = childFilter
    const childId = childFilterValue === null ? undefined : 'tool-management-child-' + randomUUID()
    let stopWatching: (() => void) | undefined
    let restrictionFailure: Error | undefined
    if (childId !== undefined) {
      const parentCtx = parentAgent?.ctx
      if (typeof parentCtx?.on !== 'function') {
        await releasePreset?.().catch(() => undefined)
        throw new Error('the parent agent scope is unavailable: cannot apply the tool restriction before the subagent is created')
      }
      const onCreated = (payload: any): void => {
        const agent = payload && payload.agent
        if (!agent || String(agent.id) !== String(childId)) return
        try {
          restrictChildTools(agent, childFilterValue as ToolFilter)
        } catch (error) {
          restrictionFailure = error instanceof Error ? error : new Error(String(error))
          throw restrictionFailure
        }
      }
      // `ctx.on` 没返回 disposer（老宿主 / 异常）→ 用恒空函数兜底：监听会随父 scope
      // 生命周期结束，调用侧只需保证自己调 `stopWatching()` 时不再抛。
      const stop = (parentCtx.on as (event: string, cb: (payload: any) => void) => (() => void) | void)('agent/created', onCreated)
      stopWatching = typeof stop === 'function' ? stop : () => undefined
    }

    const startSignal = signal ?? new AbortController().signal
    let activation: any
    try {
      activation = await runtime.startActivation({
        provider: kind,
        label: p.name,
        ...(childId === undefined ? {} : { childId }),
        request: {
          parent: parentAgent,
          prompt: [{ type: 'text', text: kind === 'fork' ? renderPersonaPrompt(p) + '\n\n' + task : task }],
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...routeOptions,
        },
        signal: startSignal,
        delivery: p.continuable === true ? 'parent' : 'caller',
      })
    } catch (error) {
      try { stopWatching?.() } catch { /* ignore */ }
      await releasePreset?.().catch(() => undefined)
      // 失败可能就是我们自己的监听器抛的（fail-closed 那条）：那句话更接近根因，
      // 别让官方的通用报错把它盖掉。
      if (restrictionFailure === undefined) throw error
      throw new Error(`failed to apply the subagent tool restriction: ${restrictionFailure.message}`, { cause: error })
    }

    // 创建窗口结束，监听器摘掉（它只服务这一个 child id）。
    try { stopWatching?.() } catch { /* ignore */ }
    if (restrictionFailure !== undefined) {
      // 监听器抛了但激活仍然建立（理论竞态）：撤掉这次激活，绝不让一个限制没生效的
      // 子代理继续跑。
      await activation.dispose().catch(() => undefined)
      await releasePreset?.().catch(() => undefined)
      throw new Error(`failed to apply the subagent tool restriction: ${restrictionFailure.message}`)
    }
    if (p.continuable === true) {
      return { text: '', runId: String(activation.childId ?? ''), stopReason: 'started', continuable: true }
    }

    try {
      const result = await activation.result   // 官方契约：child 级失败不 reject（stopReason 体现）
      // 只取 `text` 块（见 textOfBlocks）。此前这里只判了 `typeof b.text === 'string'`，
      // 于是 `reasoning` 块被当成正文 —— 子代理返回的正文里混着它的思考（计数、自我校验），
      // 只有思考时整段返回思考。本机 298 条终局消息里 98.7% 命中。
      const text = textOfBlocks(result.output, 'text')
      // 官方 SubagentResult 的诊断字段是 `diagnostic`（旧代码读 .detail 恒空 → 失败时模型只见空输出）。
      const diagnostic = (result as any).diagnostic ? `\n\n[provider] ${String((result as any).diagnostic)}` : ''
      const stopReason = String((result as any).stopReason ?? 'completed')
      return {
        text: ((text || emptyResultNote(result.output, stopReason)) + diagnostic).slice(0, RESULT_MAX),
        runId: String(activation.childId ?? ''),
        stopReason,
      }
    } finally {
      await activation.dispose().catch(() => {})   // 官方前台语义：collection 后即弃
      // 一次性子代理走完即弃：这一轮没人再需要这份预设定义。释放失败只影响清理，
      // 所以 catch 掉 —— 它绝不能盖住上面已经算出 / 抛出的结果。
      await releasePreset?.().catch(() => undefined)
    }
  }

  // v1 串行：同一时刻至多一次**启动**在途（设计 §3.2）。
  // ⚠️ 0.19.0 起这条不再等于"至多一个子代理在跑"：允许追问（`continuable`）的子代理在
  // `startActivation()` 返回后仍在后台运行，而这里只串行化"启动"这一步。这是官方通道的
  // 固有语义（后台子级本来就允许并存），不是本插件放宽了限制。
  // `continuable: true` 的返回值是 `{ text: '', stopReason: 'started' }` —— 产出不在这里，
  // 而由官方的结算通知在子代理结束时送到父代理（见 persona-types.ts 的 continuable 注释）。
  let chain: Promise<unknown> = Promise.resolve()
  const runSerial = (parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean) => {
    const start = () => runOnce(parentAgent, p, task, signal, toolFilter, inherit)
    const queued = chain.then(start, start)
    chain = queued.catch(() => undefined)
    return queued
  }

  return { PROVIDER_PACKAGES, providerMounts, hasProvider, ensureProvider, runOnce, runSerial }
}
