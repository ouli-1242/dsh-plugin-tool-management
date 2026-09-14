#!/usr/bin/env node
/**
 * Host dependency alignment for dsh-plugin-tool-management.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin resolves `@deepseek-ai/*` from ITS OWN node_modules whenever a
 * copy happens to be there, because Node resolves bare specifiers from the
 * importing file's realpath. The host (DSH) resolves the same names from its
 * own installation. Two physical copies of the same package mean:
 *
 *   - `instanceof`, `===` and symbol identity do NOT cross the boundary;
 *   - `Function.prototype.toString()` equality only holds while both copies are
 *     byte-identical, i.e. only while the host and the plugin happen to be at
 *     the same release.
 *
 * A real DSH upgrade replaces the host copy and leaves the plugin's copy
 * behind. Everything that reasons about the host implementation then describes
 * a module the host is no longer running.
 *
 * THE FIX
 * -------
 * Make the plugin resolve the same physical package the host runs. For every
 * `@deepseek-ai/*` package that exists on BOTH sides, replace the local copy
 * with a directory junction into the host installation. Packages that exist
 * only locally are reported loudly (that is a version skew, not a fixable
 * state) and are never touched.
 *
 * This script is dry-run by default. Pass --fix to apply. Every replaced
 * package is moved to `.host-deps-backup/` first, and --restore puts them
 * back, so the operation is reversible.
 *
 * Usage:
 *   node scripts/host-deps.mjs            # report only (exit 1 when drift)
 *   node scripts/host-deps.mjs --fix      # align (junction + backup)
 *   node scripts/host-deps.mjs --restore  # put the originals back
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCAL_DIR = join(ROOT, 'node_modules', '@deepseek-ai')
const BACKUP_DIR = join(ROOT, '.host-deps-backup')
const args = new Set(process.argv.slice(2))
const FIX = args.has('--fix')
const RESTORE = args.has('--restore')

/** Recursively hash a package directory by relative path + file bytes. */
function hashTree(dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        hash.update(`D:${relative(dir, full)}\n`)
        walk(full)
      } else if (entry.isFile()) {
        hash.update(`F:${relative(dir, full)}\n`)
        hash.update(readFileSync(full))
      } else {
        // A nested link/junction: record the target, never follow it.
        hash.update(`L:${relative(dir, full)}->${readlinkSync(full)}\n`)
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

/** Package name + version of one package root, or undefined. */
function pkgMeta(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    return { name: parsed.name, version: parsed.version }
  } catch {
    return undefined
  }
}

/**
 * Candidate `node_modules` roots that hold the HOST's `@deepseek-ai` packages,
 * most authoritative first:
 *   1. the profile fallback directory the running DSH maintains
 *      ($DSH_HOME/profiles/node_modules) — its entries are junctions into the
 *      installation that is actually running;
 *   2. a sibling installation reachable from this checkout (dev layouts).
 */
function hostCandidates() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const candidates = [join(home, 'profiles', 'node_modules', '@deepseek-ai')]
  // Dev layout: <somewhere>/node_modules/@deepseek-ai/dsh-plugin-* beside us.
  let dir = ROOT
  for (let i = 0; i < 4; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    candidates.push(join(dir, 'node_modules', '@deepseek-ai'))
  }
  return candidates
}

/** Pick the first candidate that looks like an installation (has @deepseek-ai/dsh). */
function findHost() {
  for (const candidate of hostCandidates()) {
    if (!existsSync(candidate)) continue
    const dsh = pkgMeta(join(candidate, 'dsh'))
    if (dsh !== undefined) return { dir: candidate, via: candidate, dshVersion: dsh.version }
  }
  return undefined
}

function listPackages(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Apply, report or restore one alignment plan. */
function main() {
  if (!existsSync(LOCAL_DIR)) {
    console.log('[host-deps] no local node_modules/@deepseek-ai — nothing to align')
    return 0
  }

  if (RESTORE) {
    if (!existsSync(BACKUP_DIR)) {
      console.log('[host-deps] no .host-deps-backup — nothing to restore')
      return 0
    }
    let restored = 0
    for (const name of listPackages(BACKUP_DIR)) {
      const from = join(BACKUP_DIR, name)
      const to = join(LOCAL_DIR, name)
      if (isLink(to)) rmdirSync(to)
      else if (existsSync(to)) throw new Error(`[host-deps] refusing to overwrite real directory ${to}`)
      renameSync(from, to)
      restored += 1
      console.log(`[host-deps] restored ${name}`)
    }
    try { rmdirSync(BACKUP_DIR) } catch { /* keep the empty dir when non-empty */ }
    console.log(`[host-deps] restored ${restored} package(s); re-run without --restore to re-align`)
    return 0
  }

  const host = findHost()
  if (host === undefined) {
    console.log('[host-deps] host installation not found — cannot align (run from a DSH profile or set DSH_HOME)')
    return 1
  }
  console.log(`[host-deps] host packages : ${host.dir}`)
  console.log(`[host-deps] host dsh     : ${host.dshVersion}`)
  console.log(`[host-deps] local tree   : ${LOCAL_DIR}`)

  const planned = []
  const skew = []
  for (const name of listPackages(LOCAL_DIR)) {
    const local = join(LOCAL_DIR, name)
    const remote = join(host.dir, name)
    if (!existsSync(remote)) { skew.push(name); continue }
    const localMeta = isLink(local) ? undefined : pkgMeta(local)
    const remoteMeta = pkgMeta(remote)
    const linkedTo = isLink(local) ? resolve(dirname(local), readlinkSync(local)) : undefined
    if (linkedTo !== undefined && resolve(linkedTo) === resolve(remote)) continue // already aligned
    const identical = localMeta !== undefined && remoteMeta !== undefined
      && localMeta.version === remoteMeta.version
      && hashTree(local) === hashTree(remote)
    planned.push({ name, local, remote, identical, localVersion: localMeta?.version ?? '(link)', hostVersion: remoteMeta?.version ?? '(?)' })
  }

  // A package that exists locally but not on the host is version skew: the
  // plugin expects something the running host does not ship. Never relink it.
  if (skew.length > 0) {
    console.log('')
    console.log('[host-deps] SKEW — present locally, absent on the host (left untouched):')
    for (const name of skew) console.log(`  - ${name}`)
  }

  const drift = planned.filter((entry) => !entry.identical)
  const same = planned.filter((entry) => entry.identical)

  console.log('')
  console.log(`[host-deps] aligned already : ${listPackages(LOCAL_DIR).length - planned.length - skew.length}`)
  console.log(`[host-deps] same content    : ${same.length}`)
  console.log(`[host-deps] DRIFTED         : ${drift.length}`)
  for (const entry of drift) {
    console.log(`  - ${entry.name}: local ${entry.localVersion} vs host ${entry.hostVersion}`)
  }

  if (!FIX) {
    if (planned.length === 0 && skew.length === 0) {
      console.log('[host-deps] OK — every @deepseek-ai package resolves to the host installation')
      return 0
    }
    console.log('')
    console.log('[host-deps] dry run. Re-run with --fix to junction these packages into the host installation.')
    return drift.length > 0 || skew.length > 0 ? 1 : 0
  }

  mkdirSync(BACKUP_DIR, { recursive: true })
  let aligned = 0
  for (const entry of planned) {
    const backup = join(BACKUP_DIR, entry.name)
    if (existsSync(backup)) throw new Error(`[host-deps] backup already holds ${entry.name}; run --restore first`)
    renameSync(entry.local, backup)
    let made = false
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', entry.local, entry.remote], { stdio: 'ignore' })
      } else {
        symlinkSync(entry.remote, entry.local, 'dir')
      }
      made = true
    } finally {
      if (!made) renameSync(backup, entry.local)
    }
    aligned += 1
    console.log(`[host-deps] aligned ${entry.name} -> ${entry.remote}${entry.identical ? '' : ' (was drifted)'}`)
  }
  console.log('')
  console.log(`[host-deps] aligned ${aligned} package(s). Backups: ${BACKUP_DIR}`)
  console.log('[host-deps] verify with: node scripts/doctor.mjs')
  return skew.length > 0 ? 1 : 0
}

process.exitCode = main()
