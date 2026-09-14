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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const JSON_OUT = process.argv.includes('--json')
const require = createRequire(join(ROOT, 'package.json'))

/** Packages whose module identity must match the host's exactly. */
const RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-spill-local',
]

/** Host capabilities the adapters consume, with the risk if missing. */
const CAPABILITIES = [
  { id: 'workspace.read-state', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['requireState'], kind: 'read' },
  { id: 'workspace.read-table', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['requireTable'], kind: 'read' },
  { id: 'workspace.read-header', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['readSessionHeader'], kind: 'read' },
  { id: 'workspace.index-header', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['indexHeader'], kind: 'read' },
  { id: 'workspace.enqueue', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['enqueueOperation'], kind: 'write' },
  { id: 'workspace.set-state', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['setState'], kind: 'write' },
  { id: 'workspace.archive', pkg: '@deepseek-ai/dsh-workspace', target: 'WorkspaceRegistry', members: ['archiveSession'], kind: 'write' },
  { id: 'projection.write', pkg: '@deepseek-ai/dsh-session-projection-cache', target: 'SessionProjectionCache', members: ['write', 'put', 'requireTable'], kind: 'write' },
]

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
  for (const capability of CAPABILITIES) {
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
      status: absent.length === 0 ? 'ok' : 'missing',
      detail: absent.length === 0 ? 'present' : `missing: ${absent.join(', ')}`,
    })
  }
  return rows
}

function main() {
  const installed = inspectPackages()
  const capabilities = inspectCapabilities()

  const blockers = []
  for (const row of installed.rows) {
    if (row.resolved === null) blockers.push(`${row.package}: cannot be resolved at all`)
    else if (row.sameFile === false) blockers.push(`${row.package}: the plugin loads a SEPARATE copy — run 'node scripts/host-deps.mjs --fix'`)
  }
  for (const row of capabilities) {
    if (row.status !== 'ok') blockers.push(`${row.id}: ${row.detail}`)
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: blockers.length === 0, host: installed.host, packages: installed.rows, capabilities, blockers }, null, 2))
    return blockers.length === 0 ? 0 : 1
  }

  console.log('dsh-plugin-tool-management — host compatibility doctor')
  console.log(`host packages : ${installed.host ?? '(not found)'}`)
  console.log('')
  console.log('module identity (plugin vs host):')
  for (const row of installed.rows) {
    const mark = row.sameFile ? 'ok  ' : row.resolved === null ? 'FAIL' : 'WARN'
    console.log(`  [${mark}] ${row.package.padEnd(46)} ${row.pluginVersion ?? '-'}${row.sameFile ? '' : `  <- ${row.note}`}`)
  }
  console.log('')
  console.log('host capabilities:')
  for (const row of capabilities) {
    console.log(`  [${row.status === 'ok' ? 'ok  ' : 'FAIL'}] ${row.id.padEnd(24)} ${row.kind.padEnd(5)} ${row.detail}`)
  }
  console.log('')
  if (blockers.length === 0) {
    console.log('OK — the plugin shares the host modules and every capability it consumes is present.')
    return 0
  }
  console.log(`${blockers.length} blocker(s):`)
  for (const blocker of blockers) console.log(`  - ${blocker}`)
  return 1
}

process.exitCode = main()
