// 官方补丁方言（`cordis.patch.yml`）的**只读复刻** —— 写入宿主配置前的最后一道校验。
//
// 为什么需要它：本插件 19 个调用面都在**文本级**改宿主的补丁文件（插块 / 删块 / 换行），
// 而官方解析这份文件用的是 js-yaml + 自定义 `!!js` 标签（`dsh-app-boot/lib/index.js:17-31`），
// 并且把「顶层必须是数组」「每项必须是映射」写成显式断言（同文件 `parsePatchList`，:1196-1200）。
// 解析失败 = DSH **下次启动直接起不来**（`CHANGELOG.md` 里记过这次事故）。三条写入路径
// （`profiles/<名>/cordis.patch.yml`、`~/.dsh/cordis.patch.yml`、bundle 的 `cordis.patch.yml`）
// 走的是同一份方言（前者 `loadOverlayPatches`、后者 `loadOptionalPatches` → `parsePatchList`；
// `userPatchesSchema === entryListSchema`，实测于 dsh-app-boot 0.1.5-rc.2）。
//
// 官方**没有**导出这份 schema（导出清单见同文件 :1575，无 `entryListSchema`），所以只能复刻。
// 复刻**必然会过期**（官方加方言 / 换 js-yaml 大版本），因此判定策略是**非对称**的：
//   · 改前能解析、改后被我们改成不能解析 → 是我们的改动弄坏了它 → 拒绝写入（原文件与备份不动）；
//   · 改前本来就解析不过 → 说明复刻过期，不是我们的错 → 照写 + 上报，绝不拦；
//   · 依赖（js-yaml）不在 → 跳过校验 + 上报。
// 一律拒绝会把「校验器过期」变成「MCP 写路径整体停摆」（含重启恢复写，见 request-gate.ts
// 里那处「恢复写失败会把服务器永久留在停用态」），那是拿能力换保守。
//
// `judgePatchText` / `decidePatchWrite` 是纯函数，契约测试直接钉上面几条分支；IO 只有
// `checkPatchWrite` 一处，它同时把结论记进运行时上报通道（兼容页据此出一行）与回执队列。

import { clearRuntimeNote, noteRuntime } from './runtime-notes.js'

/** 官方 `.js` 标签名（逐字取自 dsh-app-boot/lib/index.js:17）。 */
const JS_EXPR_TAG = 'tag:yaml.org,2002:js'

/** 官方 `isJsExpr`（cordis-plugin-loader/lib/index.js:302-304）的等价物。 */
const isJsExpr = (value: unknown): boolean => value instanceof Object && '__jsExpr' in value

/**
 * 本模块需要的 js-yaml 面（结构类型）。
 *
 * 只声明用到的那几项：`new Type(tag, options)`、`JSON_SCHEMA.extend(...)`、`load`。
 * 不 import 官方包、也不依赖 `@types/js-yaml` 在场 —— 运行时这份依赖可能压根没装上
 * （`sync-profile` 的镜像清单不含 `node_modules`，见 scripts/sync-profile.mjs:59），
 * 那时走「跳过校验 + 上报」，插件其余功能不受影响。
 */
export interface YamlDialectModule {
  Type: new (tag: string, options: {
    kind: string
    resolve: (data: unknown) => boolean
    construct: (data: unknown) => unknown
    predicate: (data: unknown) => boolean
    represent: (data: unknown) => unknown
  }) => unknown
  JSON_SCHEMA: { extend(definition: unknown): unknown }
  load(input: string, options: { schema: unknown }): unknown
}

export type PatchVerdict =
  /** 官方那份 schema + 两条断言都过。 */
  | { readonly status: 'ok' }
  /** 解析抛错，或顶层不是数组 / 有非映射项。 */
  | { readonly status: 'unparseable'; readonly detail: string }
  /** js-yaml 加载不到：校验没做成（既不是过也不是不过）。 */
  | { readonly status: 'no-dep'; readonly detail: string }

export type PatchGuardKind = 'no-dep' | 'replica-outdated'

/** 允许写入、但校验没做成时要说出去的事（兼容页一行 + 写入回执一条 warning）。 */
export interface PatchGuardReport {
  readonly kind: PatchGuardKind
  readonly detail: string
}

export interface PatchWriteDecision {
  /** false = 本次写入会把宿主配置写坏，调用方必须中止（原文件与备份保持原样）。 */
  readonly allow: boolean
  /** 允许写入但校验没做成时的上报内容；`null` = 校验结论是「过」。 */
  readonly report: PatchGuardReport | null
  /** allow=false 时给用户看的说明。 */
  readonly error?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 同一份 yaml 模块只 extend 一次（官方是在模块顶层 extend 一次的等价位）。
const schemas = new WeakMap<YamlDialectModule, unknown>()

function schemaOf(yaml: YamlDialectModule): unknown {
  const cached = schemas.get(yaml)
  if (cached !== undefined) return cached
  // 与官方逐字等价的选项对象（dsh-app-boot/lib/index.js:17-23）：load 只用到 resolve /
  // construct；predicate / represent 属于 dump 方向，复刻它们是让这份定义与官方对齐。
  const exprType = new yaml.Type(JS_EXPR_TAG, {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: unknown) => ({ __jsExpr: data }),
    predicate: isJsExpr,
    represent: (data: unknown) => (data as { __jsExpr?: unknown }).__jsExpr,
  })
  const schema = yaml.JSON_SCHEMA.extend(exprType)
  schemas.set(yaml, schema)
  return schema
}

/**
 * 判一份补丁文本官方解析得动吗（纯函数：不碰 IO、不记状态）。
 *
 * @param yaml - 注入的 yaml 模块（测试可传真模块；运行时是惰性 import 来的那份）。
 * @param content - 补丁文件全文。
 * @returns 判定结果；`unparseable` 的 detail 带官方会抛的那句错，直接可展示。
 */
export function judgePatchText(yaml: YamlDialectModule, content: string): PatchVerdict {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: schemaOf(yaml) })
  } catch (error) {
    return { status: 'unparseable', detail: messageOf(error) }
  }
  // 官方 parsePatchList 的两条显式断言：顶层数组（:1199）、每项是映射（:1200）。
  // 空文件（含只有空白的文件）在这里是 undefined → 判「解析不过」—— 与官方一致：
  // 文件**不存在**官方容忍（`ENOENT` → 没有这一层），文件**在但空**官方是抛错的。
  if (!Array.isArray(parsed)) {
    return { status: 'unparseable', detail: '顶层不是 YAML 数组（官方 parsePatchList 的显式断言）' }
  }
  const bad = parsed.findIndex((entry) => typeof entry !== 'object' || entry === null || Array.isArray(entry))
  if (bad >= 0) {
    return { status: 'unparseable', detail: `第 ${bad + 1} 项不是映射（官方 parsePatchList 的显式断言）` }
  }
  return { status: 'ok' }
}

/**
 * 非对称策略本体（纯函数）。三个分支就是本模块存在的理由，契约测试逐个钉住。
 *
 * @param before - 改前内容的判定；`null` 表示**没有可用基线**（文件不存在或读不到内容）。
 * @param after - 本次要写入内容的判定。
 * @returns 是否放行 + 要不要上报 + 拒绝时的说明。
 */
export function decidePatchWrite(before: PatchVerdict | null, after: PatchVerdict): PatchWriteDecision {
  if (after.status === 'ok') return { allow: true, report: null }
  if (after.status === 'no-dep') return { allow: true, report: { kind: 'no-dep', detail: after.detail } }
  // 改后解析不过：只有「本来就没有基线」或「改前是好的」才拦 —— 这两种都是我们引入的坏内容。
  if (before !== null && before.status === 'unparseable') {
    return {
      allow: true,
      report: {
        kind: 'replica-outdated',
        detail: `改前内容本来就解析不过（${before.detail}），本次写入按「复刻过期」放行`,
      },
    }
  }
  return {
    allow: false,
    report: null,
    error: `写入被拒绝：新内容不是合法的补丁列表（${after.detail}）。官方解析器会因此让 DSH 起不来，`
      + '已保留原文件与备份。',
  }
}

// ---------- 运行时依赖：惰性加载 + 结果缓存（`undefined` 未试过 / `null` 加载不到） ----------

let dialect: YamlDialectModule | null | undefined
let depError = ''

async function loadDialect(): Promise<YamlDialectModule | null> {
  if (dialect !== undefined) return dialect
  try {
    // 与宿主实装同一份 js-yaml（本机实测 4.3.2）。只在写补丁时加载：插件加载期不碰它，
    // 装不上也绝不因此让插件挂掉。
    dialect = (await import('js-yaml')) as unknown as YamlDialectModule
  } catch (error) {
    dialect = null
    depError = messageOf(error)
  }
  return dialect
}

// ---------- 状态：兼容页那一行（走运行时上报通道）+ 写入回执的 warning（消费式） ----------

/** 回执队列状态：`pendingWarnings` 只在「本次请求的写入没做成交验」时有货。 */
const pendingWarnings: string[] = []
// 正常情况下每请求都会被取空；上限只是防止某个不取回的调用路径把它撑大。
const WARN_QUEUE_MAX = 8

function record(report: PatchGuardReport | null): void {
  if (report === null) {
    clearRuntimeNote('patch-write-guard')
    return
  }
  noteRuntime({
    id: 'patch-write-guard',
    label: '补丁写入校验',
    kind: 'write',
    fallback: 'inform-only',
    detail: (report.kind === 'no-dep' ? '校验依赖不可用' : '复刻可能已过期')
      + `：${report.detail}（写入照常进行，仅少一道「把启动配置写坏」的拦截）`,
  })
  pendingWarnings.push(report.kind === 'no-dep'
    ? '补丁写入未做解析校验（依赖不可用）：' + report.detail
    : '补丁写入的解析校验放行（可能是复刻过期）：' + report.detail)
  if (pendingWarnings.length > WARN_QUEUE_MAX) pendingWarnings.splice(0, pendingWarnings.length - WARN_QUEUE_MAX)
}

/**
 * 写入前的完整判定（唯一一处 IO/依赖入口）。
 *
 * 判完把结论记进 note / 回执队列：兼容页据此出「补丁校验不可用」一行，写入回执据此带 warning。
 *
 * @param previous - 改前全文（`''` 视为没有基线：文件不存在，或读不到内容）。
 * @param next - 本次要写入的全文。
 * @returns 判定；`allow=false` 时调用方必须中止写入。
 */
export async function checkPatchWrite(previous: string, next: string): Promise<PatchWriteDecision> {
  const yaml = await loadDialect()
  if (yaml === null) {
    const decision: PatchWriteDecision = {
      allow: true,
      report: { kind: 'no-dep', detail: `无法加载 js-yaml：${depError}` },
    }
    record(decision.report)
    return decision
  }
  const before = previous === '' ? null : judgePatchText(yaml, previous)
  const after = judgePatchText(yaml, next)
  const decision = decidePatchWrite(before, after)
  record(decision.report)
  return decision
}

/** 写入回执取用：取走并清空本次累积的 warning（每次请求取一次）。 */
export function takePatchGuardWarnings(): string[] {
  return pendingWarnings.splice(0, pendingWarnings.length)
}
