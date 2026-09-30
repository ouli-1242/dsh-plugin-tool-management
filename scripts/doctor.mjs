#!/usr/bin/env node
/**
 * Compatibility doctor for dsh-plugin-tool-management.
 *
 * Answers, in one command, the questions that decide whether this plugin can
 * safely touch the running host's data:
 *
 *   1. Which DSH installation is this plugin actually running against, and
 *      which physical modules does it resolve for every `@deepseek-ai/*`
 *      package it imports?
 *   2. Is each of those the SAME module the host itself loads (identity, not
 *      version text)? Identity is what makes `instanceof`, `===` and symbol
 *      lookups work across the plugin/host boundary.
 *   3. Which host capabilities the plugin's adapters need are present, whether
 *      the host is byte-compatible with the release this plugin was written
 *      against, and what degrades if it is not.
 *
 * Read-only. It imports the host packages and inspects prototypes; it never
 * mutates host state and never opens the storage domain.
 *
 * Usage:
 *   node scripts/doctor.mjs           # human report, exit 1 on any blocker
 *   node scripts/doctor.mjs --json    # machine-readable report
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth: the runtime probe itself. A second hand-written
// capability list here would drift from what the plugin actually gates on, and
// the doctor would then certify a host the plugin refuses to use.
import { IDENTITY_PACKAGES, VERIFIED_HOST_VERSION, EXPECTED_PEER_RANGE, CAPABILITY_STATIC, hostRootCandidates } from '../lib/compat/probe.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const JSON_OUT = process.argv.includes('--json')
const require = createRequire(join(ROOT, 'package.json'))

/** Packages whose module identity must match the host's — the runtime list. */
const RUNTIME_PACKAGES = IDENTITY_PACKAGES

/**
 * Host-side presence of each capability the runtime probe gates on, read off the
 * official class prototypes. This is a *static* view (the runtime probe inspects
 * the live service instances and adds behaviour dry-runs); it exists so the CLI
 * can answer the question without a running host.
 *
 * The rows come from the runtime probe's own table — including the capability
 * ids that only make sense against a live host, which are reported as
 * `runtime-only` instead of disappearing from the report.
 */
const CAPABILITY_SOURCES = CAPABILITY_STATIC.map((spec) => ({
  id: spec.id,
  label: spec.label,
  kind: spec.kind,
  optional: spec.optional,
  pkg: spec.check?.pkg,
  target: spec.check?.target,
  members: spec.check?.members ?? [],
  runtimeOnly: spec.check === null,
}))

/**
 * The official JSONL layout the history adapter hard-codes
 * (`src/sessions/workspace.ts` → `jsonlSessionDirectory`).
 *
 * These are behaviour constants, not cosmetics: if any of them changes, the
 * adapter can no longer verify that a transcript directory belongs to the
 * session it is deleting, and deletion degrades to artifact-only — the parent
 * directory is retained — with nothing but a plugin-side log line to show for
 * it. That degradation is deliberately non-fatal (the artifact is still removed
 * and the removal is re-checked through `persistence.stat`), so a static look
 * at the installed host is the only way to learn about the drift before a user
 * finds orphaned directories on disk.
 *
 * Static and read-only on purpose: constructing the real persistence needs a
 * live storage domain, and this doctor must never open one.
 */
const JSONL_LAYOUT_MARKERS = [
  { needle: 'session-persistence-jsonl', why: "the adapter's backend-name gate" },
  { needle: '_no-cwd', why: 'the bucket used when the header has no cwd' },
  { needle: '251', why: 'the project-segment truncation length' },
  { needle: 'padStart(4', why: 'the ~XXXX UTF-16 escape encoding' },
]
const JSONL_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'

/**
 * 插件在运行时按**裸模块名** require 的宿主包（B3）：官方改名/删除其中一个，对应功能会
 * 静默降级（MCP 客户端、人设、AGENTS.md 注入、技能目录）。它们不在 peerDependencies 里
 * （不是硬依赖），所以也不在 IDENTITY_PACKAGES 里 —— 单独列出来，从**宿主**锚点解析，
 * 只报可见性（缺了不阻塞安装，但要看得见）。
 */
const BARE_HOST_MODULES = [
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-tool-skill',
]

/** 从宿主锚点解析这批裸模块名，逐条给状态（B3：宿主是否仍暴露）。 */
function inspectBareHostModules(hostDir) {
  if (hostDir === undefined) return { status: 'unknown', detail: 'host installation not found', rows: [] }
  const rows = BARE_HOST_MODULES.map((name) => {
    const entry = resolveFromHost(hostDir, name)
    return { package: name, resolved: entry ?? null }
  })
  const missing = rows.filter((row) => row.resolved === null)
  return {
    status: missing.length === 0 ? 'ok' : 'absent',
    detail: missing.length === 0
      ? `all ${rows.length} runtime-required host modules resolvable from the host`
      : `not resolvable from the host: ${missing.map((row) => row.package).join(', ')}`,
    rows,
  }
}

const MOUNT_HEARTBEAT_FILE = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'tool-management', 'mount.json')

/**
 * 插件的挂载心跳（B3）：apply 成功时由插件写 `hub/mount.json`。
 *
 * 为什么需要它：官方改名 `inject` 里的任何一个服务名时，插件**根本不会 apply**，而且 cordis
 * 对未解析的 inject 不抛错、不打日志（2026-09-20 实测）—— 那种情形下界面上连插件都不见了，
 * 没有任何信号。心跳是唯一的线索：**如果刚重启过 DSH 而这个时间没更新，就说明这一轮插件
 * 没挂上**，下面那份 inject 名单就是要核对的清单。
 *
 * 2026-09-30 审查 §5 F1：把「这一轮挂上没」从"要用户自己记得何时重启"升级成**可计算的结论** ——
 * 插件与宿主同进程，所以心跳里的 `pid` 就是宿主的进程号。于是：
 *   - pid 已不存在 → 那份心跳来自**已经结束**的进程（宿主自那以后重启过）；
 *   - pid 仍在    → 心跳来自**当前正在跑**的宿主，插件这一轮确实 apply 过。
 * 局限如实标注：进程号会被复用，且这里无法取到"该 pid 的启动时刻"（跨平台没有便宜的办法），
 * 所以 `pid 仍在` 只是一个**很强但不是证明**的证据 —— 刚重启过的机器请以 `hostStartedAt` 为准。
 */
function inspectMount() {
  let raw
  try {
    raw = readFileSync(MOUNT_HEARTBEAT_FILE, 'utf8')
  } catch (error) {
    return { status: 'never', detail: `no mount heartbeat at ${MOUNT_HEARTBEAT_FILE} (the plugin has never mounted on this machine)`, file: MOUNT_HEARTBEAT_FILE }
  }
  try {
    const parsed = JSON.parse(raw)
    const pid = Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : undefined
    const started = Number.isFinite(Number(parsed.hostStartedAt)) ? Number(parsed.hostStartedAt) : undefined
    const alive = pid === undefined ? undefined : pidAlive(pid)
    const verdict = alive === true
      ? '该心跳来自**当前仍在运行**的宿主进程：插件这一轮已挂载'
      : alive === false
        ? '写入该心跳的宿主进程**已经不在了**：宿主自那以后重启过（若你现在开着 DSH 而面板不见，说明这一轮插件没挂上）'
        : '心跳里没有进程号（旧版本写的），无法判断它是否来自当前这一轮宿主'
    const startedText = started === undefined ? '' : `，宿主进程启动于 ${new Date(started).toISOString()}`
    return {
      status: 'ok',
      at: parsed.at,
      iso: parsed.iso,
      version: parsed.version,
      injects: Array.isArray(parsed.injects) ? parsed.injects : [],
      pid,
      hostStartedAt: started,
      alive,
      file: MOUNT_HEARTBEAT_FILE,
      detail: `last mounted ${parsed.iso ?? '?'} (plugin ${parsed.version ?? '?'})${startedText}${pid === undefined ? '' : `, pid ${pid}`} — ${verdict}`,
    }
  } catch (error) {
    return { status: 'unreadable', detail: `mount heartbeat is not valid JSON: ${String(error)}`, file: MOUNT_HEARTBEAT_FILE }
  }
}

/**
 * 进程号是否仍然存活。`process.kill(pid, 0)` 只做存在性/权限检查、**不发信号**
 * （信号 0 是约定俗成的探测值）。EPERM 说明进程在但属于别的用户 → 仍算存活。
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return String(error && error.code) === 'EPERM'
  }
}

/**
 * Check the layout assumption against the host's own copy of the backend.
 * `n/a` means the host does not ship/use the JSONL backend, which is not a
 * fault: the adapter simply never claims directory ownership there.
 * @param hostDir - `.../node_modules/@deepseek-ai` of the host installation.
 */
function inspectJsonlLayout(hostDir) {
  if (hostDir === undefined) return { status: 'unknown', detail: 'host installation not found' }
  const entry = resolveFromHost(hostDir, JSONL_PACKAGE)
  if (entry === undefined) {
    return { status: 'n/a', detail: `${JSONL_PACKAGE} is not resolvable from the host (this host does not use the JSONL backend)` }
  }
  let source
  try {
    source = readFileSync(entry, 'utf8')
  } catch (error) {
    return { status: 'unknown', detail: `cannot read ${entry}: ${String(error)}` }
  }
  const missing = JSONL_LAYOUT_MARKERS.filter((marker) => !source.includes(marker.needle))
  if (missing.length === 0) return { status: 'ok', detail: `layout markers intact (${entry})` }
  return {
    status: 'drift',
    entry,
    detail: `layout markers missing: ${missing.map((marker) => `"${marker.needle}" (${marker.why})`).join('; ')}`,
    impact: 'session deletion can no longer claim the session directory: it deletes the transcript artifact only and leaves the directory behind',
  }
}

/** Version of a package root, read from its own manifest. */
function versionOf(entry) {
  try {
    const manifest = require.resolve(`${entry}/package.json`)
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    return undefined
  }
}

/**
 * The host installation the plugin is currently attached to.
 *
 * 候选序列直接取 `lib/compat/probe.js` 的 `hostRootCandidates()` —— 与运行时**同一份**
 * （2026-09-30 审查 §5 F10）。此前这里自己写了一份，而且少了桌面版（`resources/app.asar`）
 * 那一条：桌面宿主上会报 "host installation not found"，或拿 npx 缓存里**另一代宿主**当
 * 锚点比出假 SEPARATE COPY。那份逻辑运行时早就修过，doctor 没跟上。
 */
function findHost() {
  for (const candidate of hostRootCandidates()) {
    if (existsSync(join(candidate, 'dsh', 'package.json'))) return candidate
  }
  return undefined
}

/**
 * 找不到宿主时的提示。桌面版宿主**装不到 doctor 能看见的地方**（`process.resourcesPath`
 * 只有 electron 进程才有，而这个 CLI 是普通 node），所以这一句要把它说清 —— 否则用户看到
 * 的是一句无从下手的 "host installation not found"。
 */
function hostNotFoundHint() {
  return [
    'no DSH host installation found — 已按以下顺序找过：',
    '  ① 桌面版归档（仅 electron 进程可见，CLI 下查不到）',
    '  ② $DSH_HOME/profiles/node_modules/@deepseek-ai（或 ~/.dsh/...）',
    '  ③ 本插件自身位置逐级上溯的 node_modules/@deepseek-ai',
    '  ④ npx 缓存 <npm cache>/_npx/*/node_modules/@deepseek-ai',
    '若你用的是**桌面版 DSH**：这是预期结果（归档路径 CLI 读不到），请改在宿主内看「兼容」页的能力探测；',
    '若你用的是 `dsh web`：确认 DSH_HOME 指向正确的档案目录（当前 DSH_HOME=' + (process.env.DSH_HOME || '(未设置)') + '）。',
  ].join('\n')
}

/**
 * `~/.dsh/AGENTS.md` 的**增量刷新**契约（审查 §5 F3）—— 本插件"应用提示词预设"依赖它。
 *
 * 插件把预设正文写进全局 `AGENTS.md`，然后靠官方 `dsh-agent-instructions` **每一步**重新
 * 读盘（对比 stat 的 version 与内容 SHA-1）来决定要不要把新正文送进模型。所以官方一旦改成
 * 事件驱动、加 touchedPaths 白名单、或改 digest 口径，"应用预设"就会**静默失效**（旧正文
 * 继续注入），零报错。
 *
 * 这些 needle 是**drift canary，不是证明**：它们取自官方安装源码里承担该契约的几个标识符
 * （`lib/index.js` 实测存在）。官方把它们改名/拆函数，就是"该人工复核这一条契约"的信号；
 * 反过来，needle 还在也不等于语义没变。包解析不到时如实报 `n/a`（可选依赖）。
 */
const AGENTS_MD_REFRESH_MARKERS = [
  { needle: 'agentInstructionsHook', why: '每步重读全局 AGENTS.md 的钩子入口' },
  { needle: 'trimmedInstructionDigest', why: '内容同一性 = 去掉首尾空白后的 SHA-1' },
  { needle: 'instructionContentSha1', why: 'SHA-1 摘要口径' },
  { needle: 'sameInstructionChange', why: '按 {action, scope, path, digest} 判「有没有变化」' },
]
const AGENTS_MD_PACKAGE = '@deepseek-ai/dsh-agent-instructions'

/** 见 AGENTS_MD_REFRESH_MARKERS。只读：从宿主锚点解析官方源码并做字符串包含检查。 */
function inspectAgentsMdRefresh(hostDir) {
  if (hostDir === undefined) return { status: 'unknown', detail: 'host installation not found' }
  const entry = resolveFromHost(hostDir, AGENTS_MD_PACKAGE)
  if (entry === undefined) {
    return { status: 'n/a', detail: `${AGENTS_MD_PACKAGE} is not resolvable from the host (optional: 该宿主不注入工作区指令)` }
  }
  let source
  try {
    source = readFileSync(entry, 'utf8')
  } catch (error) {
    return { status: 'unknown', detail: `cannot read ${entry}: ${String(error)}` }
  }
  const missing = AGENTS_MD_REFRESH_MARKERS.filter((marker) => !source.includes(marker.needle))
  if (missing.length === 0) return { status: 'ok', detail: `refresh markers intact (${entry})` }
  return {
    status: 'drift',
    entry,
    detail: `refresh markers missing: ${missing.map((marker) => `"${marker.needle}" (${marker.why})`).join('; ')}`,
    impact: '「应用提示词预设」可能静默失效：写入全局 AGENTS.md 后官方不再每步重读，旧正文会继续注入模型上下文。请人工复核该包的指令刷新路径。',
  }
}

/**
 * 0.1.5 时代宿主在 `profiles/node_modules` 投影的 junction 树，0.1.7 起不再维护
 * （link-backend 已移除）。npx 升级会删掉旧缓存目录，树里的 junction 全部悬空。
 * 检测：目录在、`dsh/package.json` 却不可达 = 悬空。报告为警告（不影响判定，
 * 宿主已经从 npx 缓存锚点找到了），提示用户可手动删除。
 */
function inspectProfileLinkTree(home) {
  const tree = join(home || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'profiles', 'node_modules', '@deepseek-ai')
  if (!existsSync(tree)) return { status: 'absent' }
  if (existsSync(join(tree, 'dsh', 'package.json'))) return { status: 'ok' }
  return {
    status: 'dangling',
    detail: `${tree} 存在，但里面的 junction 已悬空（0.1.5 时代的投影，0.1.7 起宿主不再维护）`,
    impact: '宿主发现已改走 npx 缓存锚点，不影响插件运行；这棵树可以手动删除',
  }
}

/**
 * Resolve a package the way the HOST resolves it, by anchoring Node's
 * resolution at the host installation's own manifest rather than guessing a
 * path shape (`main`, `exports` and conditional entries all differ per package).
 * @param hostDir - `.../node_modules/@deepseek-ai` of the host installation.
 * @param name - package name to resolve.
 * @returns the resolved entry file, or undefined when the host cannot see it.
 */
function resolveFromHost(hostDir, name) {
  const anchors = [join(hostDir, 'dsh', 'package.json'), join(dirname(hostDir), 'package.json')]
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      return createRequire(anchor).resolve(name)
    } catch {
      /* try the next anchor */
    }
  }
  return undefined
}

function inspectPackages() {
  const host = findHost()
  const rows = []
  for (const name of RUNTIME_PACKAGES) {
    let pluginPath
    let pluginVersion
    try {
      pluginPath = require.resolve(name)
      pluginVersion = versionOf(name)
    } catch {
      rows.push({ package: name, resolved: null, hostVersion: undefined, sameFile: false, note: 'unresolvable' })
      continue
    }
    const hostPath = host === undefined ? undefined : resolveFromHost(host, name)
    if (hostPath === undefined) {
      // The host does not expose this package under its own installation
      // (optional peers such as a spawn provider): identity is not comparable
      // and therefore not a blocker.
      rows.push({ package: name, resolved: pluginPath, pluginVersion, hostVersion: undefined, sameFile: null, note: 'not shipped by this host — not comparable' })
      continue
    }
    const sameFile = resolve(hostPath) === resolve(pluginPath)
    rows.push({
      package: name,
      resolved: pluginPath,
      pluginVersion,
      hostVersion: versionOf(join(host, ...name.split('/'))),
      sameFile,
      note: sameFile ? 'same module as host' : 'SEPARATE COPY',
    })
  }
  return { host: host === undefined ? null : host, rows }
}

function inspectCapabilities() {
  const rows = []
  for (const capability of CAPABILITY_SOURCES) {
    // Instance-field shapes and behaviour dry-runs need a live host; saying so is
    // the point — silently omitting them used to hide the whole delete route.
    if (capability.runtimeOnly) {
      rows.push({ ...capability, status: 'runtime-only', detail: 'checkable only against a live host (instance fields / behaviour dry-run)' })
      continue
    }
    let mod
    try {
      mod = require(capability.pkg)
    } catch (error) {
      rows.push({ ...capability, status: 'missing', detail: `package unresolvable: ${String(error)}` })
      continue
    }
    const klass = mod[capability.target]
    if (typeof klass !== 'function') {
      rows.push({ ...capability, status: 'missing', detail: `${capability.target} export not found` })
      continue
    }
    const absent = capability.members.filter((member) => typeof klass.prototype?.[member] !== 'function')
    rows.push({
      ...capability,
      // An optional slot that is absent is the EXPECTED state on hosts whose
      // official API lacks it — it selects the adapter route, it is not a fault.
      status: absent.length === 0 ? 'ok' : capability.optional ? 'absent-optional' : 'missing',
      detail: absent.length === 0 ? 'present'
        : capability.optional ? `absent (optional native slot; adapter route is used): ${absent.join(', ')}`
        : `missing: ${absent.join(', ')}`,
    })
  }
  return rows
}

function main() {
  const installed = inspectPackages()
  const capabilities = inspectCapabilities()
  const jsonlLayout = inspectJsonlLayout(installed.host)
  const agentsMdRefresh = inspectAgentsMdRefresh(installed.host)
  const bareModules = inspectBareHostModules(installed.host)
  const mount = inspectMount()
  const linkTree = inspectProfileLinkTree()

  const blockers = []
  for (const row of installed.rows) {
    if (row.resolved === null) blockers.push(`${row.package}: cannot be resolved at all`)
    else if (row.sameFile === false) blockers.push(`${row.package}: the plugin loads a SEPARATE copy — run 'node scripts/host-deps.mjs --fix'`)
  }
  for (const row of capabilities) {
    if (row.status === 'missing') blockers.push(`${row.id}: ${row.detail}`)
  }
  // Layout drift is a warning, not a blocker: the delete path still removes the
  // artifact and re-checks the result, so the outcome is orphaned directories,
  // not data loss. It must still be loud — the runtime only logs it.
  const warnings = []
  if (jsonlLayout.status === 'drift') {
    warnings.push(`${JSONL_PACKAGE}: ${jsonlLayout.detail} — ${jsonlLayout.impact}`)
  }
  // 宿主不再暴露某个运行时裸模块：功能静默降级（不是安装阻塞项），但必须看得见（B3）。
  if (bareModules.status === 'absent') {
    warnings.push(`${bareModules.detail} — the matching feature degrades silently at runtime`)
  }
  // 宿主版本栅栏（B3）：实际版本高于验证过的版本时显式说明「差异未知、按实际探测走」。
  const hostVersion = versionOf('dsh')
  if (hostVersion !== undefined && hostVersion !== VERIFIED_HOST_VERSION) {
    warnings.push(`host DSH ${hostVersion} differs from the verified ${VERIFIED_HOST_VERSION} — capabilities below are probed against what is actually installed; treat the degraded list as authoritative`)
  }
  // 0.1.5 遗留的 junction 树悬空：不影响判定（宿主已从 npx 缓存找到），但要让用户看得见。
  if (linkTree.status === 'dangling') {
    warnings.push(`${linkTree.detail} — ${linkTree.impact}`)
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: blockers.length === 0,
      host: installed.host,
      verifiedVersion: VERIFIED_HOST_VERSION,
      expectedPeerRange: EXPECTED_PEER_RANGE,
      packages: installed.rows,
      capabilities,
      jsonlLayout,
      agentsMdRefresh,
      bareModules,
      mount,
      linkTree,
      blockers,
      warnings,
    }, null, 2))
    return blockers.length === 0 ? 0 : 1
  }

  console.log('dsh-plugin-tool-management — host compatibility doctor')
  if (installed.host === null) {
    console.log('host packages   : (not found)')
    for (const line of hostNotFoundHint().split('\n')) console.log(`                  ${line}`)
  } else {
    console.log(`host packages   : ${installed.host}`)
  }
  console.log(`verified against: DSH ${VERIFIED_HOST_VERSION} (peer range ${EXPECTED_PEER_RANGE})`)
  console.log('')
  console.log('module identity (plugin vs host):')
  for (const row of installed.rows) {
    const mark = row.sameFile ? 'ok  ' : row.resolved === null ? 'FAIL' : 'WARN'
    console.log(`  [${mark}] ${row.package.padEnd(46)} ${row.pluginVersion ?? '-'}${row.sameFile ? '' : `  <- ${row.note}`}`)
  }
  console.log('')
  console.log('host capabilities:')
  for (const row of capabilities) {
    const mark = row.status === 'ok' ? 'ok  '
      : row.status === 'runtime-only' ? 'n/a '
      : row.status === 'absent-optional' ? 'n/a ' : 'FAIL'
    console.log(`  [${mark}] ${row.id.padEnd(26)} ${row.kind.padEnd(5)} ${row.detail}`)
  }
  console.log('')
  console.log('runtime-required host modules (bare names the plugin resolves at runtime):')
  for (const row of bareModules.rows) {
    console.log(`  [${row.resolved === null ? 'WARN' : 'ok  '}] ${row.package.padEnd(46)} ${row.resolved ?? 'not resolvable from the host'}`)
  }
  console.log('')
  console.log('plugin mount heartbeat:')
  console.log(`  [${mount.status === 'ok' ? 'ok  ' : mount.status === 'never' ? 'n/a ' : 'WARN'}] ${MOUNT_HEARTBEAT_FILE}`)
  console.log(`         ${mount.detail}`)
  if (Array.isArray(mount.injects) && mount.injects.length !== 0) {
    console.log(`         declared inject services: ${mount.injects.join(', ')}`)
  }
  console.log('')
  console.log('official JSONL session layout (hard-coded by the history adapter):')
  {
    const mark = jsonlLayout.status === 'ok' ? 'ok  ' : jsonlLayout.status === 'drift' ? 'WARN' : 'n/a '
    console.log(`  [${mark}] ${JSONL_PACKAGE}`)
    console.log(`         ${jsonlLayout.detail}`)
    if (jsonlLayout.impact !== undefined) console.log(`         impact: ${jsonlLayout.impact}`)
  }
  console.log('')
  console.log('official AGENTS.md incremental-refresh contract ("apply preset" depends on it):')
  {
    const mark = agentsMdRefresh.status === 'ok' ? 'ok  ' : agentsMdRefresh.status === 'drift' ? 'WARN' : 'n/a '
    console.log(`  [${mark}] ${AGENTS_MD_PACKAGE}`)
    console.log(`         ${agentsMdRefresh.detail}`)
    if (agentsMdRefresh.impact !== undefined) console.log(`         impact: ${agentsMdRefresh.impact}`)
  }
  console.log('')
  console.log('0.1.5-era profile link projection tree ($DSH_HOME/profiles/node_modules):')
  {
    const mark = linkTree.status === 'ok' ? 'ok  ' : linkTree.status === 'dangling' ? 'WARN' : 'n/a '
    console.log(`  [${mark}] ${linkTree.status}`)
    if (linkTree.detail !== undefined) console.log(`         ${linkTree.detail}`)
    if (linkTree.impact !== undefined) console.log(`         ${linkTree.impact}`)
  }
  console.log('')
  if (warnings.length !== 0) {
    console.log(`${warnings.length} warning(s):`)
    for (const warning of warnings) console.log(`  - ${warning}`)
    console.log('')
  }
  if (blockers.length === 0) {
    console.log(warnings.length === 0
      ? 'OK — the plugin shares the host modules and every statically checkable capability is present.'
      : `OK with ${warnings.length} warning(s) above — no blockers, but the host has drifted from what an adapter assumes.`)
    return 0
  }
  console.log(`${blockers.length} blocker(s):`)
  for (const blocker of blockers) console.log(`  - ${blocker}`)
  return 1
}

process.exitCode = main()
