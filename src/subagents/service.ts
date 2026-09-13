// src/subagents/service.ts —— 轻量子智能体：人设发现（TTL 扫描）+ 官方 ctx.subagents.start 薄封装。
// 设计 §3：人设 = ~/.dsh/subagents/<name>.md（frontmatter 可选，缺省派生）；v1 串行运行；
// spawn provider 缺失时经 createRequire 挂载官方 dsh-subagent-spawn-in-process（宿主侧包）。
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '../skills/core.js'
import { expandUploads, planPersonaImport } from '../imports/upload.js'

const message = (e: unknown): string => String((e && (e as Error).message) || e)

export interface PersonaDoc {
  name: string
  description: string
  model?: string
  tools?: string[]
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

/** 行式 frontmatter 解析：只认 description / model / tools 三个键（人设文件不需要完整 YAML）。 */
function parsePersona(raw: string, fallbackName: string): PersonaDoc {
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
  const tools = data.tools ? data.tools.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined
  const firstLine = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  return {
    name: fallbackName,
    description: data.description || firstLine,
    model: data.model || undefined,
    tools: tools && tools.length ? tools : undefined,
    body: body.trim(),
    path: '',
  }
}

const RESULT_MAX = 16 * 1024

export function createSubagentService(ctx: any, opts?: { subagentsDir?: string }): SubagentService {
  const dir = opts?.subagentsDir || join(resolveDshHome(), 'subagents')
  const req = createRequire(import.meta.url)

  let cache: { at: number; value: PersonaDoc[] } | null = null
  async function list(): Promise<PersonaDoc[]> {
    if (cache && Date.now() - cache.at < 1000) return cache.value
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
      ...(p.tools?.length ? { toolFilter: { allow: p.tools } } : {}),
      maxDepth: 1,
      ...(p.model ? { agentOptions: { model: p.model } } : {}),
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
        subagents: docs.map((p) => ({ name: p.name, description: p.description, model: p.model ?? null, tools: p.tools ?? null })),
      }
    },
    'subagent-get': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      const docs = await list()
      const p = docs.find((d) => d.name === name)
      if (!p) return { ok: false, error: `人设不存在: ${name}` }
      return { ok: true, persona: { name: p.name, description: p.description, model: p.model ?? '', tools: p.tools ?? [], body: p.body } }
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
function serializePersona(args: any): string {
  const description = String((args && args.description) || '').replace(/\r?\n/g, ' ').trim()
  const model = String((args && args.model) || '').trim()
  const tools = Array.isArray(args?.tools) ? args.tools.map((x: unknown) => String(x).trim()).filter(Boolean) : []
  const body = String((args && args.body) ?? '').trim()
  const lines = ['---']
  if (description) lines.push('description: ' + description)
  if (model) lines.push('model: ' + model)
  if (tools.length) lines.push('tools: ' + tools.join(', '))
  lines.push('---', '', body, '')
  return lines.join('\n')
}
