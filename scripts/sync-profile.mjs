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
 *   npm run sync:profile              # every profile on this machine that has it installed
 *   node scripts/sync-profile.mjs myprofile
 *
 * The target is `$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-tool-management`
 * ($DSH_HOME defaults to ~/.dsh). With no argument, EVERY profile holding this
 * plugin is synced — and that is not a nicety. On 2026-10-01 a fix was built and
 * verified twice while the desktop app kept running the old code, because this
 * script defaulted to `web` and the machine also had `profiles/desktop` (installed
 * from the same checkout, frozen at the previous day's build). "The build passed"
 * was true of a copy of the plugin nobody was running. A profile that is not
 * installed is still not an error: it just means this machine takes the plugin
 * from npm instead of from a checkout.
 * Files already shared by inode are left alone; locked files are reported
 * instead of throwing (a running DSH holds its `lib/` open).
 *
 * A THIRD hazard showed up on 2026-10-10, and it is not about staleness but about
 * DIRECTION: a hardlink is two-way. The profile's `README.md` *is* the checkout's
 * `README.md`, so an editor holding the profile path and saving it rewrites the
 * repository — the build looked healthy, "the file did not change", and the badges
 * plus all eight screenshots had quietly been replaced by a stale buffer.
 *
 * The rule is therefore: **link only what the build rewrites in place** (`lib/`),
 * and **copy everything else**. A stale copy is cosmetic; a stale link is data
 * loss. See `LINKED` / `COPIED` below.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 用**硬链接**镜像的条目：构建产物。
 *
 * 判据只有一条 —— **`npm run build` 会不会原地重写它？** 会，才值得链接。
 * 链接的意义是「profile 那份就是仓库这份」：`tsc` / `sync-client` 原地截断重写后，profile
 * 不写一个字就跟上了，DSH 运行时占着的句柄也不会让同步失败 —— 这就是本脚本存在的理由。
 * 目前只有 `lib/`。
 */
const LINKED = ['lib']

/**
 * 用**复制**镜像的条目：文档与静态清单（= 发布面 `package.json#files` 减去 `lib`）。
 *
 * 这里绝不能用链接。链接是双向的：编辑器打开 profile 里的 `README.md` 一保存，写穿的是
 * 仓库这份 —— 2026-10-10 就这么丢过一次改动（界面上「改了没生效」，实际是 profile 里那份
 * 旧缓冲把仓库文件覆盖回去了，连徽章和 8 张截图一起带走）。复制最坏只是快照过期（重跑一次
 * 本命令即可），链接会直接改掉 checkout。
 *
 * 加新条目时先问：**构建会不会原地重写它？** 不会 → 放这里。
 */
const COPIED = ['docs', 'locale', 'cordis.patch.yml', 'README.md', 'README_EN.md', 'CHANGELOG.md', 'LICENSE', 'screenshots.json', 'package.json']

/**
 * 不进 profile 的 `docs/` 子目录：演示视频约 97MB，且不在发布面里
 * （`package.json#files` 只有 `docs/images` 与 `docs/UPDATE.md`）。镜像时跳过源里的它，
 * 目标里的旧副本会被底部的「清理陈旧文件」一并删掉。
 */
const DOC_MIRROR_SKIP = new Set(['videos'])

const PLUGIN_DIR = 'dsh-plugin-tool-management'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const targetOf = (profile) => join(home, 'profiles', profile, 'node_modules', PLUGIN_DIR)

/** 这台机器上装了本插件的所有 profile（显式传参时只同步那一个）。 */
function installedProfiles() {
  const root = join(home, 'profiles')
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { /* 没有 profiles 目录 = 一台都不装 */ }
  return names.map(targetOf).filter(existsSync)
}

const targets = process.argv[2] ? [targetOf(process.argv[2])] : installedProfiles()
if (!targets.length) {
  console.log(`[sync-profile] 没有 profile 装着本插件（${join(home, 'profiles', '*', 'node_modules', PLUGIN_DIR)}），跳过`)
  process.exit(0)
}

let stats = null
let failures = null
const rel = (path) => path.slice(stats.target.length + 1)

/**
 * Mirror one file.
 *
 * `link = true`（构建产物）：优先硬链接 —— profile 那份与仓库同一 inode，`tsc` 原地重写后
 * 不必往 profile 写一个字，DSH 占着的句柄也就不会让同步失败。链接建不起来（跨卷 EXDEV、
 * 文件系统不支持）时退回复制，计数进 `fallback`，summary 会提示。
 *
 * `link = false`（文档 / 静态清单）：**只复制**。链接是双向的 —— 编辑器打开 profile 里那份
 * 一保存，写穿的是仓库这份。复制最坏只是过期，链接会直接改掉 checkout。
 */
function mirrorFile(from, to, link) {
  const src = statSync(from)
  const dst = statSync(to, { throwIfNoEntry: false })
  const exists = dst !== undefined && dst.isFile()
  // 目标与源同一个 inode = 两边根本是同一个文件（旧脚本建的那种链接）。
  const sameFile = exists && src.ino !== 0 && src.ino === dst.ino && src.dev === dst.dev

  if (link) {
    if (sameFile) {
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
      return
    } catch {
      // 跨卷 / 不支持硬链接 → 落到下面的复制
    }
  } else if (exists && dst.nlink <= 1 && src.size === dst.size && readFileSync(from).equals(readFileSync(to))) {
    // 复制模式：内容一致、**且这一份独占 inode** → 不用动。
    // `nlink <= 1` 这一条不能省：目标若还与别处共享 inode，就地复制会写穿那份。
    stats.same += 1
    return
  }

  try {
    // 复制模式必须让目标独占自己的 inode：共享 inode 时先 unlink 再写，否则 copyFileSync
    // 会原地写穿，连带改掉另一个链接（旧脚本留下的硬链接、或两个 profile 互链）。
    // 独占 inode 的就地覆盖更温和，不打断正打开它的进程。
    if (!link && dst !== undefined && (dst.nlink > 1 || !dst.isFile())) {
      rmSync(to, { force: true, recursive: dst.isDirectory() })
    }
    copyFileSync(from, to)
    if (link) stats.fallback += 1
    else stats.copied += 1
  } catch (error) {
    failures.push(`${rel(to)}: ${String((error && error.message) || error)}`)
  }
}

/**
 * Mirror one source tree into the target: copy what exists, drop what does not.
 * @param {string} from source directory
 * @param {string} to target directory
 * @param {boolean} link whether files are build artifacts (hardlink) or copied
 * @param {Set<string>} [skipNames] names to leave out; their target copies get pruned
 */
function mirror(from, to, link, skipNames) {
  mkdirSync(to, { recursive: true })
  const entries = readdirSync(from, { withFileTypes: true }).filter((entry) => !(skipNames && skipNames.has(entry.name)))
  const names = new Set(entries.map((entry) => entry.name))

  // 只改大小写的重命名（`docs/update.md` → `docs/UPDATE.md`）必须先删旧名，否则下面两步
  // 会互相抵消：复制时目标路径在大小写不敏感的文件系统（Windows / 默认 macOS）上**就是**
  // 那个旧文件，copyFileSync 原地写穿、磁盘上的名字仍是 `update.md`；紧接着清理时 readdir
  // 报出的还是 `update.md`，不在 `names` 里 → 被当成陈旧文件删掉。一次构建的净效果是文件
  // **消失**（2026-10-22 改 `docs/UPDATE.md` 时实测：`1 个复制 · 清掉 1 个陈旧文件`，目录空）。
  // 大小写敏感的文件系统上这段什么也不做（本来就该由下面的清理删掉），所以不需要探测文件系统。
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    if (names.has(entry.name)) continue
    const lower = entry.name.toLowerCase()
    if (!entries.some((src) => src.name !== entry.name && src.name.toLowerCase() === lower)) continue
    try {
      rmSync(join(to, entry.name), { recursive: entry.isDirectory(), force: true })
      stats.pruned += 1
    } catch (error) {
      failures.push(`${rel(join(to, entry.name))}: ${String((error && error.message) || error)}`)
    }
  }

  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      mirror(src, dst, link, skipNames)
      continue
    }
    mirrorFile(src, dst, link)
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

/** 把一个 profile 镜像成当前交付物，返回这一份的失败清单。 */
function syncTo(target) {
  stats = { target, copied: 0, linked: 0, fallback: 0, same: 0, pruned: 0 }
  failures = []
  for (const [entries, link] of [[LINKED, true], [COPIED, false]]) {
    for (const entry of entries) {
      if (!existsSync(entry)) continue
      if (statSync(entry).isDirectory()) mirror(entry, join(target, entry), link, entry === 'docs' ? DOC_MIRROR_SKIP : undefined)
      else mirrorFile(entry, join(target, entry), link)
    }
  }
  const parts = [`${stats.same} 个已一致`, `${stats.linked} 个硬链接`, `${stats.copied} 个复制`]
  if (stats.pruned) parts.push(`清掉 ${stats.pruned} 个陈旧文件`)
  console.log(`[sync-profile] ${target}\n  ${parts.join(' · ')}`)
  if (stats.fallback) {
    console.warn(`[sync-profile] 有 ${stats.fallback} 个构建产物只能复制（跨卷或不支持硬链接）：`
      + '它们不会跟着 `npm run build` 原地更新，改完源码要重跑一次本命令。')
  }
  return failures.slice()
}

const found = targets.filter(existsSync)
const skipped = targets.filter((target) => !existsSync(target))
const allFailures = []
for (const target of found) allFailures.push(...syncTo(target))
if (skipped.length) console.log(`[sync-profile] 未安装到这些 profile，跳过：${skipped.join('、')}`)
if (allFailures.length) {
  console.error(`[sync-profile] ${allFailures.length} 项失败（DSH 正在运行会锁住 lib/：关掉它再跑一次）:\n  ` + allFailures.join('\n  '))
  process.exit(1)
}
