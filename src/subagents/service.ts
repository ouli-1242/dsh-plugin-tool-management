// src/subagents/service.ts —— 轻量子智能体：人设发现（TTL 扫描）+ 官方 ctx.subagents.start 薄封装。
// 设计 §3：人设 = $DSH_HOME/tool-management/agents/<name>.md（frontmatter 可选，缺省派生）；v1 串行运行；
// spawn provider 缺失时经 createRequire 挂载官方 dsh-subagent-spawn-in-process（宿主侧包）。
//
// v0.4 目录变更：人设由 `$DSH_HOME/subagents/` 搬到 `$DSH_HOME/tool-management/agents/`
// （插件产生的文件统一收在 tool-management/ 下）。旧目录在首次扫描时搬入，见 relocateLegacyPersonas。
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '../skills/core.js'
import { expandUploads, planPersonaImport } from '../imports/upload.js'

const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 人设默认目录：`$DSH_HOME/tool-management/agents/`。 */
export function defaultPersonasDir(): string {
  return join(resolveDshHome(), 'tool-management', 'agents')
}

/**
 * 旧目录 `$DSH_HOME/subagents/` → `tool-management/agents/` 一次性搬移（幂等）。
 * 只在目标不存在同名文件时搬（绝不覆盖）；源目录保留空壳。每个进程只跑一次。
 */
let personasRelocated = false
async function relocateLegacyPersonas(dir: string): Promise<void> {
  if (personasRelocated) return
  personasRelocated = true
  const legacy = join(resolveDshHome(), 'subagents')
  if (legacy === dir) return
  let names: string[]
  try {
    names = (await readdir(legacy)).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return
  }
  if (!names.length) return
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  for (const name of names) {
    const from = join(legacy, name)
    const to = join(dir, name)
    try {
      const exists = await stat(to).then(() => true).catch(() => false)
      if (exists) continue
      await rename(from, to)
    } catch {
      /* 单项失败（被占用等）不阻断其余；保留源文件，下次启动再试 */
    }
  }
}

export interface PersonaDoc {
  name: string
  description: string
  /** 模型路由的 provider 半边（与 model 配对；缺省 = 继承主会话）。 */
  provider?: string
  model?: string
  /** 工具白名单：只保留列出的工具（与 toolsDeny 组合，deny 优先）。 */
  tools?: string[]
  /** 工具黑名单：从子代理可见集合里移除（优先级高于白名单）。 */
  toolsDeny?: string[]
  body: string
  path: string
}

export interface SubagentService {
  list(): Promise<PersonaDoc[]>
  /** 场景绑定校验 + 串行运行一个子代理（结果文本截断 ≤16 KiB）。 */
  runSerial(parentAgent: any, persona: PersonaDoc, task: string, signal: AbortSignal | undefined): Promise<{ text: string; runId: string; stopReason: string }>
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生）。 */
  writeOps: ReadonlySet<string>
}

/** 行式 frontmatter 解析：只认 description / provider / model / tools / toolsDeny 五个键。 */
export function parsePersona(raw: string, fallbackName: string): PersonaDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const data: Record<string, string> = {}
  let body = raw
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (kv) data[kv[1].toLowerCase()] = kv[2].trim()
    }
    body = raw.slice(m[0].length)
  }
  const listOf = (value: string | undefined): string[] | undefined => {
    if (!value) return undefined
    const list = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const tools = listOf(data.tools)
  // 兼容两种写法：`toolsdeny: a, b`（线上格式）与 `toolsDeny: a, b`（键名统一小写后同形）。
  const toolsDeny = listOf(data.toolsdeny)
  const firstLine = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  return {
    name: fallbackName,
    description: data.description || firstLine,
    provider: data.provider || undefined,
    model: data.model || undefined,
    tools,
    toolsDeny,
    body: body.trim(),
    path: '',
  }
}

const RESULT_MAX = 16 * 1024

export function createSubagentService(ctx: any, opts?: { subagentsDir?: string }): SubagentService {
  const dir = opts?.subagentsDir || defaultPersonasDir()
  const req = createRequire(import.meta.url)

  let cache: { at: number; value: PersonaDoc[] } | null = null
  async function list(): Promise<PersonaDoc[]> {
    if (cache && Date.now() - cache.at < 1000) return cache.value
    // 旧目录搬家放在首次扫描前（幂等；失败不阻断，旧目录仍会被下面的读取兜底看到）。
    await relocateLegacyPersonas(dir).catch(() => undefined)
    const docs: PersonaDoc[] = []
    try {
      const entries = await readdir(dir)
      for (const fileName of entries.filter((e) => e.endsWith('.md')).sort()) {
        const raw = await readFile(join(dir, fileName), 'utf8').catch(() => '')
        if (!raw.trim()) continue
        docs.push({ ...parsePersona(raw, fileName.slice(0, -3)), path: join(dir, fileName) })
      }
    } catch { /* 目录缺失 = 无人设 */ }
    cache = { at: Date.now(), value: docs }
    return docs
  }

  // spawn provider 在场性（设计 §3.2，落地方式见 cordis.patch.yml 的取舍注释）：
  // 官方通道探测（ctx.subagents.list()）→ 缺失才挂载 → 失败把原因原样带出（不吞、不谎报）。
  // 不是一次性静默标记：每次调用都先探测，宿主后来注册了 provider 也能立刻跟上。
  let spawnMount: { ok: true } | { ok: false; error: string } | null = null
  function hasSpawnProvider(runtime: any): boolean {
    if (typeof runtime.list !== 'function') return false
    try {
      const names = runtime.list()
      return Array.isArray(names) && names.indexOf('spawn') >= 0
    } catch { return false }
  }
  async function ensureSpawnProvider(): Promise<any> {
    const runtime = ctx.get?.('subagents')
    if (!runtime || typeof runtime.start !== 'function') {
      throw new Error('子代理服务未挂载（ctx.subagents 缺失；请确认 DSH 版本 ≥0.1.5-rc.2）')
    }
    if (hasSpawnProvider(runtime)) return runtime
    // 宿主没有 list() 就探测不了：不重复挂载（避免同名 provider 二次注册），交给 start 报官方错误兜底。
    if (typeof runtime.list !== 'function') return runtime
    if (!spawnMount) {
      try {
        const mod = req('@deepseek-ai/dsh-subagent-spawn-in-process')
        if (!mod || typeof mod.apply !== 'function') throw new Error('模块未导出 apply(ctx, config)（版本不匹配？）')
        mod.apply(ctx, { providerName: 'spawn' })
        spawnMount = { ok: true }
      } catch (e) {
        spawnMount = {
          ok: false,
          error: 'spawn provider 不可用：宿主没有注册它，本插件挂载 @deepseek-ai/dsh-subagent-spawn-in-process 也失败（'
            + message(e) + '）。请在宿主 profile 挂载该包（本插件已声明为可选 peerDependency），或安装后重启 DSH。',
        }
      }
    }
    if (!spawnMount.ok) throw new Error(spawnMount.error)
    if (!hasSpawnProvider(runtime)) throw new Error('spawn provider 挂载后仍未出现在 ctx.subagents.list()（宿主版本不匹配？）')
    return runtime
  }

  async function runOnce(parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined): Promise<{ text: string; runId: string; stopReason: string }> {
    const runtime = await ensureSpawnProvider()
    // 官方签名：start(name, request) —— name = ctx.subagents 上的 provider 注册名。
    const run = await runtime.start('spawn', {
      label: p.name,
      parent: parentAgent,
      // 官方 SubagentStartRequest.signal 为必填：调用方缺省时给一个永不中止的信号，不传 undefined。
      signal: signal ?? new AbortController().signal,
      prompt: [{ type: 'text', text: task }],
      persona: p.body,
      // 工具白/黑名单 → 官方 ToolRestriction（`deny` 优先级高于 `allow`；未知名官方会直接拒绝启动，
      // 所以选择器给的是「全体预设工具并集」，见 index.ts presetToolCandidates）。
      ...((p.tools?.length || p.toolsDeny?.length)
        ? { toolFilter: { ...(p.tools?.length ? { allow: p.tools } : {}), ...(p.toolsDeny?.length ? { deny: p.toolsDeny } : {}) } }
        : {}),
      maxDepth: 1,
      // provider 与 model 是模型路由的两半：DSH 的 resolveModel(provider, model) 不做
      // `provider/model` 字符串拆分，只改 model 会落在**主会话的 provider** 上——跨来源
      // 指定模型（如 sensenova 的 sensenova-6.8-flash-lite）必须两个键一起给。
      ...(p.provider || p.model
        ? { agentOptions: { ...(p.provider ? { provider: p.provider } : {}), ...(p.model ? { model: p.model } : {}) } }
        : {}),
    })
    try {
      const result = await run.result   // 官方契约：child 级失败不 reject（stopReason 体现）
      const text = (result.output ?? [])
        .map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
        .join('').trim()
      // 官方 SubagentResult 的诊断字段是 `diagnostic`（旧代码读 .detail 恒空 → 失败时模型只见空输出）。
      const diagnostic = (result as any).diagnostic ? `\n\n[provider] ${String((result as any).diagnostic)}` : ''
      return {
        text: ((text || '(子代理无输出)') + diagnostic).slice(0, RESULT_MAX),
        runId: String(run.id ?? ''),
        stopReason: String((result as any).stopReason ?? 'completed'),
      }
    } finally {
      await run.dispose().catch(() => {})   // 官方前台语义：collection 后即弃
    }
  }

  // v1 串行：同一时刻至多一个子代理运行（设计 §3.2）。
  let chain: Promise<unknown> = Promise.resolve()
  const runSerial = (parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined) => {
    const queued = chain.then(() => runOnce(parentAgent, p, task, signal), () => runOnce(parentAgent, p, task, signal))
    chain = queued.catch(() => undefined)
    return queued
  }

  const ops = {
    'subagent-list': async () => {
      const docs = await list()
      return {
        ok: true,
        subagents: docs.map((p) => ({ name: p.name, description: p.description, provider: p.provider ?? null, model: p.model ?? null, tools: p.tools ?? null, toolsDeny: p.toolsDeny ?? null })),
      }
    },
    'subagent-get': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      const docs = await list()
      const p = docs.find((d) => d.name === name)
      if (!p) return { ok: false, error: `人设不存在: ${name}` }
      return { ok: true, persona: { name: p.name, description: p.description, provider: p.provider ?? '', model: p.model ?? '', tools: p.tools ?? [], toolsDeny: p.toolsDeny ?? [], body: p.body } }
    },
    'subagent-create': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (exists) return { ok: false, error: `人设已存在: ${name}` }
      await writeFile(target, serializePersona(args), 'utf8')
      cache = null
      return { ok: true, name }
    },
    'subagent-update': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (!exists) return { ok: false, error: `人设不存在: ${name}` }
      await writeFile(target, serializePersona(args), 'utf8')
      cache = null
      return { ok: true, name }
    },
    'subagent-delete': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      await rm(join(dir, name + '.md')).catch(() => {})
      cache = null
      return { ok: true, name }
    },
    /**
     * 导入人设（.md / .zip）：一个 .md 一个人设，文件名（去扩展名）= 人设名；
     * zip 内任意层级的 .md 都按文件名导入（目录层级忽略）。同名**跳过并报告**，不覆盖既有文件。
     * 部分成功：单条失败只记 skipped。
     */
    'subagent-import': async (args: any) => {
      const files = args && args.files
      if (!Array.isArray(files) || !files.length) return { ok: false, error: '没有选择要导入的文件' }
      const { entries, problems } = expandUploads(files)
      const planned = planPersonaImport(entries)
      const skipped: Array<{ name: string; reason: string }> = [...problems, ...planned.problems]
      const imported: string[] = []
      for (const target of planned.targets) {
        if (!validPersonaName(target.name)) { skipped.push({ name: target.name, reason: '人设名不合法（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' }); continue }
        const text = Buffer.from(target.bytes).toString('utf8').replace(/^\uFEFF/, '')
        if (!text.trim()) { skipped.push({ name: target.name, reason: '内容为空，已跳过' }); continue }
        const targetPath = join(dir, target.name + '.md')
        const exists = await readFile(targetPath, 'utf8').then(() => true).catch(() => false)
        if (exists) { skipped.push({ name: target.name, reason: '同名已存在（已跳过）' }); continue }
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(targetPath, text, 'utf8')
        } catch (e) {
          skipped.push({ name: target.name, reason: '写入失败：' + message(e) })
          continue
        }
        imported.push(target.name)
      }
      if (imported.length) cache = null
      return { ok: true, imported, skipped }
    },
  }
  return { list, runSerial, ops, writeOps: new Set(['subagent-create', 'subagent-update', 'subagent-delete', 'subagent-import']) }
}

function validPersonaName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !name.startsWith('.') && !/[\\/<>:"|?*]/.test(name)
}

/** 人设文件序列化：frontmatter 只写用户填过的键；正文 = 人设提示词。 */
export function serializePersona(args: any): string {
  const description = String((args && args.description) || '').replace(/\r?\n/g, ' ').trim()
  const provider = String((args && args.provider) || '').trim()
  const model = String((args && args.model) || '').trim()
  const toList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x: unknown) => String(x).trim()).filter(Boolean) : [])
  const tools = toList(args?.tools)
  // 黑名单字段兼容两种入参名：toolsDeny（UI/camel）与 tools_deny（snake）。
  const toolsDeny = toList(args?.toolsDeny ?? args?.tools_deny)
  const body = String((args && args.body) ?? '').trim()
  const lines = ['---']
  if (description) lines.push('description: ' + description)
  if (provider) lines.push('provider: ' + provider)
  if (model) lines.push('model: ' + model)
  if (tools.length) lines.push('tools: ' + tools.join(', '))
  if (toolsDeny.length) lines.push('toolsDeny: ' + toolsDeny.join(', '))
  lines.push('---', '', body, '')
  return lines.join('\n')
}
