#!/usr/bin/env node
/**
 * 兼容矩阵生成器 —— 把「这台机器上装着的每一份 DSH 宿主 × 本插件的每项能力」摊成一张表，
 * 输出 `docs/COMPATIBILITY.md`。
 *
 * 为什么不是 doctor 的另一个开关
 * -----------------------------
 * `scripts/doctor.mjs` 回答的是**一台机器此刻**的问题：「我这份插件和它挂着的那个宿主对不对得上」。
 * 它只看得见一个宿主（第一个候选），也只给一份结论。而用户真正的疑问往往跨版本：
 * 「我要不要把宿主升到 0.2.1？」「0.2.0 上删除还能用吗？」「升级后哪几个功能会掉？」
 * —— 这些问题的答案不在单份报告里，而在**多份宿主并排**的差异里。
 *
 * 所以本脚本做三件 doctor 不做的事：
 *   ① 枚举**所有**能发现的宿主安装（桌面版归档 / $DSH_HOME 投影树 / 插件锚点上溯 / npx 缓存），
 *      逐个解析版本，而不是取第一个就收工；
 *   ② 每个宿主单独一个子进程去探测。两代 DSH 的框架包（cordis 及其服务）在同一个进程里各加载
 *      一次是**已知有风险**的：符号表、服务名注册、单例都可能互相污染，而污染的结果是"静默
 *      给出错误答案"——正是这张表最不能有的东西。子进程把每个宿主隔在自己的进程里，代价是
 *      多几次 fork，换来的是每一格都真的量的是那个宿主；
 *   ③ 把能力表按**版本维度**铺开，标出「已验证 / 未实测 / 不可用」，让差异一眼可见。
 *
 * 安全边界
 * --------
 * - 全程只读宿主安装目录（读 manifest、require 官方包、看原型上的成员），不写任何宿主文件；
 * - `DSH_HOME` 在进程启动的最早一刻就被换成 `mkdtemp` 出来的临时目录，子进程继承同一个值。
 *   于是即便将来某个被 require 的模块在顶层顺手写了个侧车，也只会落在临时目录里，**真实
 *   `~/.dsh` 一个字节都不会动**；临时目录在退出时（含异常路径）删除；
 * - 唯一被写的文件是 `docs/COMPATIBILITY.md`（本仓库内），`--dry-run` 时连它也不写。
 *
 * 失败口径
 * --------
 * 找不到任何宿主 → 打印为什么找不到、**不覆盖**已有文档、退出码 1。本脚本不接进 `build`、
 * 不接进 `prepublishOnly`：它是一份环境报告，不是构建门禁，环境不全时不该拦住发版。
 *
 * 用法：
 *   node scripts/compat-matrix.mjs             # 生成 docs/COMPATIBILITY.md
 *   node scripts/compat-matrix.mjs --dry-run   # 只打印，不写文件
 *   node scripts/compat-matrix.mjs --probe <宿主@deepseek-ai 目录> --out <文件>   # 内部：单宿主探测
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF = fileURLToPath(import.meta.url)
const OUT_FILE = join(ROOT, 'docs', 'COMPATIBILITY.md')
const DRY_RUN = process.argv.includes('--dry-run')

/** 单元格里非「存在」的那几态。`present` 由 {@link cellOf} 按版本另行判定。 */
const CELL = {
  'runtime-only': '—',
  unknown: '未实测',
}

/**
 * 能力状态 → 表格单元格。
 *
 * `present` 要按**两个**维度分：宿主是不是验证基准、以及宿主在不在适配范围内。
 * 后一个维度 2026-10-22 才加上：范围收窄到一代之后，「成员齐备但这一代不适配」会真实出现，
 * 那时写「未实测」是错的 —— 它读起来像"应该能用，只是没测过"，而事实是插件**不声明支持**。
 */
function cellOf(state, isVerified, inRange) {
  if (state === 'missing') return '不可用'
  if (state === 'present') {
    if (!inRange) return '未适配'
    return isVerified ? '已验证' : '未实测'
  }
  return CELL[state] ?? '未实测'
}

// ─────────────────────────────────────────────────────────────────────────────
// 子进程侧：只探测**一个**宿主，结果写文件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从宿主自己的锚点解析包名。
 *
 * 两个锚点、按序试：`<root>/dsh/package.json` 是宿主应用本体，`<root>/../package.json` 是
 * `node_modules/package.json`（可能不存在）。官方包里有些是宿主装、插件不依赖的
 * （`dsh-client-connection` 就是），所以只能从宿主侧解析 —— 从插件侧解析只会得到一律
 * "解析不到"，那不是关于这个宿主的结论。
 */
function resolveFromHost(anchors, name) {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(name)
    } catch { /* 换下一个锚点 */ }
  }
  return undefined
}

/** 按宿主锚点加载一个官方包。返回 `{ mod }` 或 `{ error }`，绝不抛。 */
function loadFromHost(anchors, name) {
  const entry = resolveFromHost(anchors, name)
  if (entry === undefined) return { error: `宿主安装里解析不到 ${name}` }
  try {
    return { mod: createRequire(entry)(name) }
  } catch (error) {
    return { error: `加载 ${name} 失败：${String(error && error.message ? error.message : error)}` }
  }
}

/** 一个能力在这个宿主上的静态状态。 */
function inspectCapability(row, anchors) {
  if (row.check === null) {
    // 实例字段（Map/Set 形状）与行为试跑只能对活着的宿主查。说"不猜"比猜一个"存在"有用。
    return { id: row.id, state: 'runtime-only', detail: '只能对活的宿主判定（实例字段 / 行为试跑）' }
  }
  const loaded = loadFromHost(anchors, row.check.pkg)
  if (loaded.error !== undefined) return { id: row.id, state: 'unknown', detail: loaded.error }
  const klass = loaded.mod[row.check.target]
  if (typeof klass !== 'function') {
    return { id: row.id, state: 'missing', detail: `${row.check.pkg} 里没有 ${row.check.target} 这个导出` }
  }
  const absent = row.check.members.filter((member) => typeof klass.prototype?.[member] !== 'function')
  if (absent.length === 0) return { id: row.id, state: 'present', detail: '成员齐备' }
  return { id: row.id, state: 'missing', detail: `缺少 ${absent.join(', ')}` }
}

/**
 * 操作路由的静态判定。
 *
 * 口径与运行时 `routeFor` 一致：一条路由只在**它需要的每一项都齐备**时才成立，绝不从"部分
 * 可用"悄悄滑到另一条。三态：
 *   - `ok`      → 该路由全部要求静态齐备；
 *   - `refuted` → 至少一项静态缺失，这条路走不通；
 *   - `unknown` → 有要求只能在活宿主上判定，静态视图不下结论。
 *
 * 顺序照抄运行时：先 native，再 adapter。
 */
function routeOf(route, states) {
  const judge = (ids) => {
    if (ids.length === 0) return 'absent'
    const seen = ids.map((id) => states.get(id) ?? 'unknown')
    if (seen.every((state) => state === 'present')) return 'ok'
    if (seen.some((state) => state === 'missing')) return 'refuted'
    return 'unknown'
  }
  const native = judge(route.native)
  if (native === 'ok') return { via: 'native', state: 'ok' }
  const adapter = judge(route.adapter)
  if (adapter === 'ok') return { via: 'adapter', state: 'ok' }
  if (adapter === 'refuted') {
    return { via: 'none', state: 'refuted', detail: '适配器路由的必要成员在宿主上缺失' }
  }
  return { via: 'none', state: 'unknown', detail: '有路由要求只能在活宿主上判定' }
}

/**
 * 单个宿主的探测。结果写进 `--out` 指定的文件（父进程读）。
 *
 * 走文件而不是 stdout：官方包在 require 时可能往 stdout 打警告，混进 JSON 就是解析失败，
 * 而"解析失败"在这里会被误读成"这个宿主探测不了"。文件没有这个歧义。
 */
async function probeMain(hostRoot, outFile) {
  const { CAPABILITY_STATIC, OPERATION_ROUTES, VERIFIED_HOST_VERSION, EXPECTED_PEER_RANGE } = await import('../lib/compat/probe.js')
  const manifest = join(hostRoot, 'dsh', 'package.json')
  const anchors = [manifest, join(dirname(hostRoot), 'package.json')].filter((path) => existsSync(path))
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version
  const rows = CAPABILITY_STATIC.map((row) => inspectCapability(row, anchors))
  const states = new Map(rows.map((row) => [row.id, row.state]))
  const routes = Object.entries(OPERATION_ROUTES).map(([operation, route]) => ({
    operation,
    ...routeOf(route, states),
  }))
  writeFileSync(outFile, JSON.stringify({
    root: hostRoot,
    version,
    // 安装期门槛用的是 npm 的默认 semver 语义（不带 includePrerelease）：本插件的范围把每一代
    // rc 元组逐段枚举了，所以默认语义就是安装期真正会发生的判定，这里不能另立一套。
    inRange: semver.satisfies(version, EXPECTED_PEER_RANGE),
    verified: version === VERIFIED_HOST_VERSION,
    rows,
    routes,
  }, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// 父进程侧：枚举宿主 → 逐个 fork → 渲染
// ─────────────────────────────────────────────────────────────────────────────

/** 宿主安装的形态，给人看的。 */
function installForm(hostRoot) {
  const normalized = hostRoot.replace(/\\/g, '/')
  if (/\.asar(\/|$)/i.test(normalized)) return '桌面版归档'
  if (normalized.includes('/_npx/')) return 'npx 缓存'
  if (normalized.includes('/profiles/node_modules/')) return '$DSH_HOME 投影树'
  return '本地安装'
}

/** 真实路径；取不到就退回原串（junction / 权限问题时不要因此漏掉一个宿主）。 */
function realOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 枚举所有候选宿主，去重后只留"看起来像一份安装"的（有 `dsh/package.json`）。
 *
 * 候选序列本身来自 `lib/compat/probe.js` 的 `hostRootCandidates()` —— 全仓"宿主在哪"的唯一
 * 口径。这里额外补一条**真实** `$DSH_HOME/profiles/node_modules/@deepseek-ai`：父进程已经把
 * `DSH_HOME` 换成了临时目录，那个候选会指向临时目录里不存在的位置，而 0.1.5 时代留下的投影树
 * 是只读探测、值得出现在表里。
 */
async function findHosts(realHome) {
  const probe = await import('../lib/compat/probe.js')
  const candidates = [...probe.hostRootCandidates(), join(realHome, 'profiles', 'node_modules', '@deepseek-ai')]
  const seen = new Set()
  const hosts = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    if (!existsSync(join(candidate, 'dsh', 'package.json'))) continue
    const key = realOrSelf(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    hosts.push({ root: candidate, key })
  }
  return hosts
}

/** 按「验证基准优先、其余按版本新→旧」排。第一行永远是基准那一版。 */
function sortHosts(hosts, verifiedVersion) {
  return [...hosts].sort((left, right) => {
    const leftVerified = left.version === verifiedVersion
    const rightVerified = right.version === verifiedVersion
    if (leftVerified !== rightVerified) return leftVerified ? -1 : 1
    const byVersion = semver.rcompare(semver.valid(left.version) ?? '0.0.0', semver.valid(right.version) ?? '0.0.0')
    if (byVersion !== 0) return byVersion
    return left.root.localeCompare(right.root)
  })
}

/** 一张表的一行：`| a | b | c |`。 */
function row(cells) {
  return `| ${cells.join(' | ')} |`
}

function render({ pluginVersion, generatedAt, verifiedVersion, peerRange, hosts, meta, operations }) {
  const lines = []
  const push = (line = '') => lines.push(line)

  push('# 兼容矩阵')
  push()
  push('> 本文件由 `node scripts/compat-matrix.mjs` 生成，请勿手工编辑。')
  push('>')
  push(`> 插件 ${pluginVersion} · 生成于 ${generatedAt} · 验证基准 DSH \`${verifiedVersion}\` · 安装期适配范围 \`${peerRange}\``)
  push()
  push('这张表回答一个问题：**同一个插件，装在不同版本的 DSH 宿主上，哪些能力还在、哪些已经对不上。**')
  push('它只做静态判定（读宿主安装里的官方包，看原型上的成员在不在），不启动宿主、不碰会话数据。')
  push()
  push('## 怎么读')
  push()
  push('- **已验证** —— 该宿主版本正是本插件适配器最后验证的那一版，且这项能力在它的官方实现里存在。')
  push('- **未实测** —— 这项能力在这个宿主上存在，这个宿主也在适配范围内，但它不是验证基准。')
  push('  存在不等于行为一致：差一个 rc 也可能改了语义。以插件「兼容」页对**活宿主**的探测为准。')
  push('- **未适配** —— 这项能力在这个宿主上存在，但这个宿主版本**不在**本插件的适配范围内。')
  push('  插件不声明支持它；装也装不上（peer 校验会拦）。要跑这一代宿主，请装对应版本的插件。')
  push('- **不可用** —— 该宿主的官方实现里没有这项成员。依赖它的功能会被拒绝（写入类）或降级（读取类），')
  push('  而不是带着未知实现去改数据。')
  push('- **—** —— 这项能力只能在**活的宿主**上判定（实例字段的形状、行为试跑），静态视图不猜。')
  push('- **待确认** —— 用在「操作」表里：静态能查的要求全部齐备，但还有要求只能在活宿主上判定。')
  push('  这不是「不确定能不能用」，是「静态视图只能确认到这里」。')
  push()
  push('标了「可选」的能力缺失是**预期状态**：宿主的官方 API 本来就没有这个入口，插件会走适配器路径，')
  push('功能不受影响。所以「宿主」表的**缺失**列把可选项也数了进去（那是事实），而**结论**列只把')
  push('必需项的缺失当成问题。')
  push()
  push('## 宿主')
  push()
  push(row(['DSH 版本', '安装形态', '安装位置', '在适配范围内', '静态可查', '缺失', '结论']))
  push(row(['---', '---', '---', '---', '---', '---', '---']))
  for (const host of hosts) {
    const checkable = host.rows.filter((item) => item.state !== 'runtime-only' && item.state !== 'unknown')
    const present = checkable.filter((item) => item.state === 'present')
    const missing = host.rows.filter((item) => item.state === 'missing')
    // 可选项缺失是宿主的正常形态（插件走适配器），不能算成"这个宿主有问题" —— 结论列只认必需项。
    const missingRequired = missing.filter((item) => meta[item.id]?.optional !== true)
    const optionalMissing = missing.length - missingRequired.length
    const tail = optionalMissing === 0 ? '' : `（另 ${optionalMissing} 项可选原生入口不存在，走适配器）`
    const verdict = !host.inRange
      ? `**超出适配范围**（本插件只适配 \`${verifiedVersion}\`）`
      : missingRequired.length > 0
        ? `部分能力不可用（必需 ${missingRequired.length} 项）`
        : host.verified
          ? `与本插件适配基准一致${tail}`
          : `成员齐备，行为未实测${tail}`
    push(row([
      `\`${host.version}\`${host.verified ? '（基准）' : ''}`,
      installForm(host.root),
      `\`${host.root}\``,
      host.inRange ? '是' : '**否**',
      `${present.length}/${checkable.length}`,
      missing.length === 0 ? '0' : String(missing.length),
      verdict,
    ]))
  }
  push()

  push('## 能力')
  push()
  push(row(['能力', '类型', '可选', ...hosts.map((host) => `\`${host.version}\``)]))
  push(row(['---', '---', '---', ...hosts.map(() => '---')]))
  // 行顺序取第一个宿主的能力表 —— 所有宿主用的是同一份 CAPABILITY_STATIC，顺序天然一致。
  const capabilityIds = hosts[0].rows.map((item) => item.id)
  for (const id of capabilityIds) {
    const cells = hosts.map((host) => {
      const found = host.rows.find((item) => item.id === id)
      return found === undefined ? '未实测' : cellOf(found.state, host.verified, host.inRange)
    })
    const info = meta[id] ?? { kind: '', optional: false }
    push(row([`\`${id}\``, info.kind, info.optional ? '可选' : '', ...cells]))
  }
  push()

  push('## 操作')
  push()
  push('一项操作可用，意味着它需要的**每一项**能力都齐备 —— 插件不会从「部分可用」悄悄滑进另一条路由。')
  push('「原生」是宿主自己的入口；「适配器」是插件在宿主公开成员上拼出来的等价路径。')
  push()
  push(row(['操作', ...hosts.map((host) => `\`${host.version}\``)]))
  push(row(['---', ...hosts.map(() => '---')]))
  const operationNames = hosts[0].routes.map((item) => item.operation)
  for (const operation of operationNames) {
    const cells = hosts.map((host) => {
      const found = host.routes.find((item) => item.operation === operation)
      if (found === undefined) return '待确认'
      if (found.state === 'refuted') return '不可用'
      if (found.state === 'unknown') return '待确认'
      return found.via === 'native' ? '可用（原生）' : '可用（适配器）'
    })
    push(row([operation, ...cells]))
  }
  push()
  // 「待确认」不能只丢一个词：把卡在哪几项上摊出来，否则读者只能去翻源码。
  const pendingNotes = []
  for (const operation of operationNames) {
    const route = operations[operation]
    const ids = [...new Set([...route.native, ...route.adapter])]
    const pending = ids.filter((id) => (hosts[0].rows.find((item) => item.id === id)?.state ?? 'unknown') === 'runtime-only')
    if (pending.length > 0) pendingNotes.push(`${operation} 卡在 ${pending.map((id) => `\`${id}\``).join('、')}`)
  }
  if (pendingNotes.length > 0) {
    push(`「待确认」的来由：${pendingNotes.join('；')}。这几项读的是活实例上的字段与行为，静态视图看不到。`)
    push()
  }

  push('## 复现')
  push()
  push('```bash')
  push('node scripts/compat-matrix.mjs             # 重新生成本文件')
  push('node scripts/compat-matrix.mjs --dry-run   # 只打印到终端，不写文件')
  push('node scripts/doctor.mjs                    # 只看当前这台机器的宿主（含活宿主探测）')
  push('```')
  push()
  push('本脚本在 `mkdtemp` 出来的临时 `DSH_HOME` 下运行，每个宿主单独一个子进程，')
  push('只读宿主安装目录，**不读写真实的 `~/.dsh`**。找不到任何宿主时它会原样保留本文件并退出 1 ——')
  push('一份过期的表比没有表更糟。')
  push()
  return lines.join('\n')
}

async function main() {
  // ── 安全边界：先把 DSH_HOME 换掉，再做任何 import / 探测 ──────────────────
  // 真实值先记下来（枚举候选时要用），然后立刻指向临时目录。此后进程内任何按 DSH_HOME
  // 拼路径的写入都落不到真实档案上；子进程继承同一个 env。
  const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-compat-matrix-'))
  process.env.DSH_HOME = sandbox

  try {
    const probe = await import('../lib/compat/probe.js')
    const { VERIFIED_HOST_VERSION, EXPECTED_PEER_RANGE } = probe
    const pluginVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

    const discovered = await findHosts(realHome)
    if (discovered.length === 0) {
      console.error('没有找到任何 DSH 宿主安装 —— 本文件未改动。')
      console.error('已按以下顺序找过：')
      console.error('  ① 桌面版归档（仅 electron 进程可见，命令行下查不到）')
      console.error(`  ② $DSH_HOME/profiles/node_modules/@deepseek-ai（当前 DSH_HOME='${realHome}'）`)
      console.error('  ③ 本插件自身位置逐级上溯的 node_modules/@deepseek-ai')
      console.error('  ④ npx 缓存 <npm cache>/_npx/*/node_modules/@deepseek-ai')
      console.error('')
      console.error('若你用的是桌面版 DSH：这是预期结果，请改在宿主内看「兼容」页的能力探测。')
      process.exitCode = 1
      return
    }

    // ── 逐个宿主 fork 一个干净的进程 ────────────────────────────────────────
    const hosts = []
    for (const [index, host] of discovered.entries()) {
      const outFile = join(sandbox, `probe-${index}.json`)
      const child = spawnSync(process.execPath, [SELF, '--probe', host.root, '--out', outFile], {
        // 子进程只读宿主安装、只写临时目录；stdio 收进管道，别让官方包的启动日志刷屏。
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      })
      if (!existsSync(outFile)) {
        console.error(`跳过 ${host.root}：探测没有产出结果（退出码 ${child.status ?? '?'}）`)
        if (child.stderr) console.error(child.stderr.trim().split('\n').slice(-5).join('\n'))
        continue
      }
      hosts.push(JSON.parse(readFileSync(outFile, 'utf8')))
    }

    if (hosts.length === 0) {
      console.error('所有宿主探测都失败了 —— 本文件未改动。')
      process.exitCode = 1
      return
    }

    const sorted = sortHosts(hosts, VERIFIED_HOST_VERSION)
    // 能力表里「类型 / 可选」这两列的数据源：CAPABILITY_STATIC 本身（子进程只回状态，不回元信息）。
    const meta = Object.fromEntries(probe.CAPABILITY_STATIC.map((item) => [item.id, { kind: item.kind, optional: item.optional === true }]))

    const markdown = render({
      pluginVersion,
      generatedAt: new Date().toISOString().slice(0, 10),
      verifiedVersion: VERIFIED_HOST_VERSION,
      peerRange: EXPECTED_PEER_RANGE,
      hosts: sorted,
      meta,
      operations: probe.OPERATION_ROUTES,
    })

    if (DRY_RUN) {
      process.stdout.write(markdown)
      return
    }
    writeFileSync(OUT_FILE, markdown)

    // ── 终端摘要：让人不用打开文件也知道结论 ────────────────────────────────
    console.log(`dsh-plugin-tool-management ${pluginVersion} — 兼容矩阵`)
    console.log(`验证基准 DSH ${VERIFIED_HOST_VERSION} · 发现 ${sorted.length} 个宿主 · 已写入 ${OUT_FILE}`)
    for (const host of sorted) {
      const missing = host.rows.filter((item) => item.state === 'missing')
      // 与文档同一口径：可选项缺失是宿主正常形态，不该在终端刷成警告。
      const required = missing.filter((item) => meta[item.id]?.optional !== true)
      const optional = missing.length - required.length
      const mark = !host.inRange ? 'SKIP' : required.length === 0 ? 'ok  ' : 'WARN'
      const tail = optional === 0 ? '' : `（另 ${optional} 项可选原生入口不存在）`
      const range = host.inRange ? '' : ' · **超出适配范围**'
      console.log(`  [${mark}] ${host.version.padEnd(12)} ${installForm(host.root)} · 必需缺失 ${required.length} 项${tail}${range}`)
      console.log(`         ${host.root}`)
      for (const item of required) console.log(`         - ${item.id}: ${item.detail}`)
    }
  } finally {
    // 临时 DSH_HOME 一定删掉：它里面可能有官方模块顺手写下的东西，留着没有意义。
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口分流
// ─────────────────────────────────────────────────────────────────────────────

const probeIndex = process.argv.indexOf('--probe')
if (probeIndex !== -1) {
  const hostRoot = process.argv[probeIndex + 1]
  const outIndex = process.argv.indexOf('--out')
  const outFile = outIndex === -1 ? undefined : process.argv[outIndex + 1]
  if (hostRoot === undefined || outFile === undefined) {
    console.error('用法：node scripts/compat-matrix.mjs --probe <宿主@deepseek-ai 目录> --out <文件>')
    process.exitCode = 2
  } else {
    await probeMain(hostRoot, outFile)
  }
} else {
  await main()
}
