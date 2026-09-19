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
import { IDENTITY_PACKAGES, VERIFIED_HOST_VERSION, EXPECTED_PEER_RANGE, CAPABILITY_STATIC } from '../lib/compat/probe.js'

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

/** The host installation the plugin is currently attached to. */
function findHost() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const candidates = [join(home, 'profiles', 'node_modules', '@deepseek-ai')]
  let dir = ROOT
  for (let i = 0; i < 4; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    candidates.push(join(dir, 'node_modules', '@deepseek-ai'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh', 'package.json'))) return candidate
  }
  return undefined
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

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: blockers.length === 0,
      host: installed.host,
      verifiedVersion: VERIFIED_HOST_VERSION,
      expectedPeerRange: EXPECTED_PEER_RANGE,
      packages: installed.rows,
      capabilities,
      jsonlLayout,
      blockers,
      warnings,
    }, null, 2))
    return blockers.length === 0 ? 0 : 1
  }

  console.log('dsh-plugin-tool-management — host compatibility doctor')
  console.log(`host packages   : ${installed.host ?? '(not found)'}`)
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
  console.log('official JSONL session layout (hard-coded by the history adapter):')
  {
    const mark = jsonlLayout.status === 'ok' ? 'ok  ' : jsonlLayout.status === 'drift' ? 'WARN' : 'n/a '
    console.log(`  [${mark}] ${JSONL_PACKAGE}`)
    console.log(`         ${jsonlLayout.detail}`)
    if (jsonlLayout.impact !== undefined) console.log(`         impact: ${jsonlLayout.impact}`)
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
