#!/usr/bin/env node
/**
 * Sync the build into the profile's installed copy of this plugin.
 *
 * WHY THIS EXISTS
 * ---------------
 * A profile that added this checkout with a `file:` spec holds a HARDLINKED
 * copy: existing files share their inode with the checkout (so `npm run build`
 * updates them in place), but a file the build ADDS never appears there, and a
 * file the build REMOVES stays behind. The host then dies at boot with
 *
 *   Cannot find module '...\node_modules\dsh-plugin-tool-management\lib\context-inject.js'
 *
 * The first time that happened (2026-09-16, new module `context-inject.ts`) the
 * app would not start at all. This script makes the installed copy a mirror of
 * the publish surface, so adding/removing a source file stays a one-command
 * operation.
 *
 * The THIRD time (2026-09-18, new module `paths.ts`) it happened again, and the
 * lesson was that a separate command is a command people forget. Worse, the
 * symptom hides: every EXISTING file is hardlinked and therefore current, so the
 * install looks perfectly healthy right up to the moment the host is restarted.
 * So this script is now the last step of `npm run build` itself — "the build
 * passed" and "the profile is installable" are one sentence again.
 *
 * The SECOND time (2026-09-17) was a different half of the same coin, and it is
 * why this script now LINKS instead of copies: `context-inject.js` was created
 * by the 2026-09-16 run as a plain copy, so it had its own inode — and every
 * later `npm run build` updated only the checkout. The profile ended up with a
 * NEW `lib/subagents/tools.js` (hardlinked → build updated it in place) sitting
 * next to an OLD `lib/context-inject.js` (copy → frozen at 2026-09-16), and the
 * host died at boot with
 *
 *   SyntaxError: The requested module '../context-inject.js' does not provide
 *   an export named 'isSubagentSession'
 *
 * A copy is a snapshot; a link is the same file. Linking makes the sentence
 * above ("so `npm run build` updates them in place") true for EVERY file, not
 * only the ones npm happened to link. tsc writes through the inode (truncate +
 * write, no unlink), so the link survives rebuilds — which is exactly why the
 * hardlinked half stayed current while the copied half did not.
 *
 * Usage:
 *   npm run build                     # runs this automatically, as the last step
 *   npm run sync:profile              # profile "web" (default)
 *   node scripts/sync-profile.mjs myprofile
 *
 * The target is `$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-tool-management`
 * ($DSH_HOME defaults to ~/.dsh). A missing target is not an error: it just
 * means this machine installs the plugin from npm instead of a checkout.
 * Files already shared by inode are left alone; locked files are reported
 * instead of throwing (a running DSH holds its `lib/` open).
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Publish surface (package.json `files`) plus the loader patch every install needs. */
const ENTRIES = ['lib', 'docs', 'cordis.patch.yml', 'README.md', 'README_EN.md', 'CHANGELOG.md', 'LICENSE', 'screenshots.json', 'package.json']

const PLUGIN_DIR = 'dsh-plugin-tool-management'
const profile = process.argv[2] || 'web'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const target = join(home, 'profiles', profile, 'node_modules', PLUGIN_DIR)

if (!existsSync(target)) {
  console.log(`[sync-profile] 未安装到 profile "${profile}"，跳过：${target}`)
  process.exit(0)
}

const stats = { copied: 0, linked: 0, same: 0, pruned: 0 }
const failures = []
const rel = (path) => path.slice(target.length + 1)

/**
 * Mirror one file, preferring a HARDLINK over a copy (see the header: a copy is
 * a snapshot that `npm run build` can never reach again).
 *
 * Falls back to a copy when linking is impossible — a different volume (EXDEV)
 * or a filesystem without hard links. A copy that can go stale still beats a
 * missing file; the counter in the summary says which happened.
 */
function mirrorFile(from, to) {
  const src = statSync(from)
  const dst = statSync(to, { throwIfNoEntry: false })
  if (dst !== undefined && dst.isFile() && src.ino !== 0 && src.ino === dst.ino && src.dev === dst.dev) {
    stats.same += 1
    return
  }
  try {
    // linkSync refuses an existing destination, so drop the stale file (or the
    // copy whose inode we want to replace) first. The target is a mirror:
    // nothing there is worth keeping.
    if (dst !== undefined) rmSync(to, { force: true, recursive: dst.isDirectory() })
    linkSync(from, to)
    stats.linked += 1
  } catch {
    try {
      copyFileSync(from, to)
      stats.copied += 1
    } catch (error) {
      failures.push(`${rel(to)}: ${String((error && error.message) || error)}`)
    }
  }
}

/** Mirror one source tree into the target: copy what exists, drop what does not. */
function mirror(from, to) {
  mkdirSync(to, { recursive: true })
  const names = new Set()
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    names.add(entry.name)
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      mirror(src, dst)
      continue
    }
    mirrorFile(src, dst)
  }
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    if (names.has(entry.name)) continue
    try {
      rmSync(join(to, entry.name), { recursive: entry.isDirectory(), force: true })
      stats.pruned += 1
    } catch (error) {
      failures.push(`${rel(join(to, entry.name))}: ${String((error && error.message) || error)}`)
    }
  }
}

for (const entry of ENTRIES) {
  if (!existsSync(entry)) continue
  if (statSync(entry).isDirectory()) mirror(entry, join(target, entry))
  else mirrorFile(entry, join(target, entry))
}

const parts = [`${stats.same} 个已是同一份`, `${stats.linked} 个已建立硬链接`]
if (stats.copied) parts.push(`${stats.copied} 个只能复制`)
if (stats.pruned) parts.push(`清掉 ${stats.pruned} 个陈旧文件`)
console.log(`[sync-profile] ${target}\n  ${parts.join(' · ')}`)
if (stats.copied) {
  console.warn(`[sync-profile] 有 ${stats.copied} 个文件是复制过去的（跨卷或不支持硬链接）：`
    + '它们不会跟着 `npm run build` 更新，改完源码要重跑一次本命令。')
}
if (failures.length) {
  console.error(`[sync-profile] ${failures.length} 项失败（DSH 正在运行会锁住 lib/：关掉它再跑一次）:\n  ` + failures.join('\n  '))
  process.exit(1)
}
