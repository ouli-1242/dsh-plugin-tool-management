// `noUncheckedIndexedAccess` 的门禁检查（开发期自检，不随包发布）。
//
// 直接跑 `tsc --noUncheckedIndexedAccess` 会把全项目的错误一起打出来并以非零退出，
// 于是分不清「目标清单已清零」和「清单外还有几百条」。这里只对 TARGET 里的文件计错，
// 清单外的错误只报数量 —— 这个脚本因此可以当门禁用，而全量收敛仍能分批推进。
//
// 与 tsconfig.strict.json 的分工：那个文件只负责把选项打开（含独立的 buildinfo，
// 不与 `npm run build` 争用缓存），这个文件负责判"算不算过"。
//
// 用法：node scripts/check-strict.mjs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 已收敛的目标文件（相对仓库根，正斜杠）。扩列只改这里。 */
const TARGET = [
  'src/memories/discovery.ts',
  'src/mcp/patch-yaml.ts',
  'src/skills/frontmatter.ts',
  'src/skills/readonly-discovery.ts',
]

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

/** `src/a.ts(1,2): error TS1234: ...` → { file, code }；其余行（含续行）返回 null。 */
function parseErrorLine(line) {
  const m = /^(.+?)\((\d+),(\d+)\): error TS(\d+):/.exec(line)
  if (!m) return null
  return { file: m[1].replace(/\\/g, '/'), code: m[4] }
}

if (!existsSync(tsc)) {
  console.error('找不到 tsc：' + tsc + '（先跑 npm install）')
  process.exit(1)
}

// 目标文件被改名或删除时必须报错：否则清单里留着旧路径，门禁会永远"通过"。
const missing = TARGET.filter((file) => !existsSync(join(root, file)))
if (missing.length) {
  console.error('TARGET 里的文件不存在（改名或删除后请同步本脚本）：')
  for (const file of missing) console.error('  ' + file)
  process.exit(1)
}

const run = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.strict.json'), '--noEmit'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1 << 26,
})
if (run.error) {
  console.error('tsc 启动失败：' + run.error.message)
  process.exit(1)
}

const out = String(run.stdout || '') + String(run.stderr || '')
const errors = out.split(/\r?\n/).map(parseErrorLine).filter((e) => e !== null)

// 退出码非零却一条错误都解析不出来 = 配置错误或编译崩溃（不是"有类型错误"）。
if (run.status !== 0 && errors.length === 0) {
  console.error('tsc 以 ' + run.status + ' 退出，但没有解析出任何类型错误：')
  console.error(out.trim() || '（无输出）')
  process.exit(1)
}

const wanted = new Set(TARGET)
const hits = errors.filter((e) => wanted.has(e.file))
const others = errors.length - hits.length

if (hits.length) {
  console.error('目标清单内仍有 ' + hits.length + ' 处 noUncheckedIndexedAccess 错误：')
  for (const e of hits) console.error('  ' + e.file + '  TS' + e.code)
  console.error('\n清单外另有 ' + others + ' 处（暂容忍）。')
  process.exit(1)
}

console.log('目标清单内 0 处（' + TARGET.length + ' 个文件）；清单外 ' + others + ' 处暂容忍。')
