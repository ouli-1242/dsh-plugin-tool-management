// src/subagents/service.ts —— 轻量子智能体：人设发现（TTL 扫描）+ 官方 ctx.subagents.start 薄封装。
// 设计 §3：人设 = ~/.dsh/subagents/<name>.md（frontmatter 可选，缺省派生）；v1 串行运行；
// spawn provider 缺失时经 createRequire 挂载官方 dsh-subagent-spawn-in-process（宿主侧包）。
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '../skills/core.js'

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

  let spawnReady = false
  async function ensureSpawnProvider(): Promise<any> {
    const runtime = ctx.get?.('subagents')
    if (!runtime || typeof runtime.start !== 'function') {
      throw new Error('子代理服务未挂载（ctx.subagents 缺失；请确认 DSH 版本 ≥0.1.5-rc.2）')
    }
    if (!spawnReady) {
      try {
        const mod = req('@deepseek-ai/dsh-subagent-spawn-in-process')
        if (mod && typeof mod.apply === 'function') mod.apply(ctx, { providerName: 'spawn' })
      } catch { /* 宿主已自带或不可得 → start 报错兜底 */ }
      spawnReady = true
    }
    return runtime
  }

  async function runOnce(parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined): Promise<{ text: string; runId: string; stopReason: string }> {
    const runtime = await ensureSpawnProvider()
    // 官方签名：start(name, request) —— name = ctx.subagents 上的 provider 注册名。
    const run = await runtime.start('spawn', {
      provider: 'spawn',
      label: p.name,
      parent: parentAgent,
      signal: signal ?? undefined,
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
      const detail = (result as any).detail ? `\n\n[provider] ${String((result as any).detail)}` : ''
      return {
        text: ((text || '(子代理无输出)') + detail).slice(0, RESULT_MAX),
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
  }
  return { list, runSerial, ops }
}
