// 补丁文件「启停覆盖块」收敛的回归测试（src/mcp/override-blocks.ts）。
//
// 为什么值得单独测：这段逻辑会改写 `~/.dsh/cordis.patch.yml` —— 写坏了 DSH 直接起不来，
// 而"删掉多余的覆盖块"这件事**只允许在不改变生效状态的前提下发生**。所以这里的断言不是
// 文案/结构快照，而是一条不变量：
//
//   按计划删完以后，每个 id 的生效启停状态必须与删之前**逐个相同**。
//
// 生效状态的读取（`effectiveStates`）在测试里**独立实现**（不调被测模块）：两边共用一份
// 实现的话，"删错了"会跟着一起错，测了等于没测。
//
// 最后一条用例直接对**本机真实的补丁文件**跑（存在才跑）：它带着用户实际踩到的形状 ——
// 25 条 id 行、context7 一个 id 7 个块，其中大量块还没有标记注释（老 dsh-mcp-manager 写的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { analyzeOverrideBlocks, planOverrideCompaction, scanOverrideBlocks } from '../lib/mcp/override-blocks.js'

/** 测试自己读补丁文件：按顶层 `- ` 块切，insert 子条目给基准，顶层 disabled 覆盖基准。 */
function effectiveStates(content) {
  const lines = content.split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    if (/^- /.test(line)) { current = [line]; blocks.push(current) }
    else if (current) current.push(line)
  }
  const state = new Map()
  for (const block of blocks) {
    const text = block.join('\n')
    if (/^- insert:/.test(block[0])) {
      // 子条目以 4 空格缩进；config 的键在 8 空格。这里只需要"条目自带的 disabled"。
      const children = text.split(/\n(?=    - )/).slice(1)
      for (const child of children) {
        const idm = child.match(/^\s*- id:\s*(\S+)\s*$/m)
        if (!idm) continue
        const flag = child.match(/^\s+disabled:\s*(true|false)\s*$/m)
        state.set(idm[1], flag ? flag[1] === 'true' : false)
      }
      continue
    }
    const idm = text.match(/^- id:\s*(\S+)\s*$/m)
    if (!idm) continue
    const flag = text.match(/^\s{2}disabled:\s*(true|false)\s*$/m)
    if (flag) state.set(idm[1], flag[1] === 'true')
  }
  return state
}

/** 独立实现的行删除（被测模块只给行区间，不碰文件）。 */
function applyRanges(content, ranges) {
  const lines = content.split(/\r?\n/)
  const drop = new Set()
  for (const [start, end] of ranges) for (let i = start; i < end; i++) drop.add(i)
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

/** insert 行 + 覆盖块的基准行（给收敛计划用）。 */
function baseRowsOf(content) {
  const rows = []
  for (const id of effectiveStates(content).keys()) rows.push({ id, disabled: false })
  return rows
}

/** 数一下收敛后每个 id 还剩几个顶层覆盖块。 */
function overrideCountsAfter(content, ranges) {
  const counts = new Map()
  for (const block of scanOverrideBlocks(applyRanges(content, ranges))) {
    counts.set(block.id, (counts.get(block.id) || 0) + 1)
  }
  return counts
}

const insert = (id, extra = '') => [
  '- insert:',
  `    - id: ${id}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  `        serverName: ${id}`,
  "        transport: 'stdio'",
  extra,
].filter(Boolean).join('\n')

const override = (id, disabled, marker = false) => [
  marker ? `# dsh-plugin-tool-management:${disabled ? 'disable' : 'enable'}:${id}` : null,
  `- id: ${id}`,
  "  name: '@deepseek-ai/dsh-mcp-client'",
  `  disabled: ${disabled}`,
].filter(Boolean).join('\n')

test('收敛计划：删掉多余的覆盖块后，每个 id 的生效状态逐个不变', () => {
  const content = [
    insert('mcp-a'),
    insert('mcp-b'),
    override('mcp-a', true),               // 被后面的 false 盖住 → 删
    override('mcp-a', false, true),        // decider，值 == insert 基准(false) → 删
    override('mcp-b', true, true),         // decider，值 != 基准(false) → 留
    '',
  ].join('\n')

  const before = effectiveStates(content)
  assert.deepEqual([...before.entries()].sort(), [['mcp-a', false], ['mcp-b', true]], '前置：样本本身的状态要读对')

  const plan = planOverrideCompaction(content, baseRowsOf(content))
  assert.equal(plan.ids['mcp-a'].total, 2, 'mcp-a 有 2 个覆盖块')
  assert.equal(plan.ids['mcp-a'].dropped, 2, 'mcp-a 两个块都是多余的（一个被盖住、一个是 no-op）')
  assert.equal(plan.ids['mcp-b'].dropped, 0, 'mcp-b 的那条决定了生效值，不能删')

  const after = effectiveStates(applyRanges(content, plan.ranges))
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), '删完生效状态必须逐个相同')
  assert.equal(overrideCountsAfter(content, plan.ranges).get('mcp-a'), undefined, 'mcp-a 的覆盖块应被收干净')
  assert.equal(overrideCountsAfter(content, plan.ranges).get('mcp-b'), 1, 'mcp-b 保留唯一那条')
})

test('收敛计划：基准未知（insert 行在别处 / 补丁之外）时绝不删 decider', () => {
  // 只有覆盖块、没有 insert 行：删掉这条 disabled:false 可能把 profile 原生定义的
  // 条目翻回它自己的状态 —— 所以基准未知时只删被 decider 盖住的块。
  const lone = [override('mcp-c', false), ''].join('\n')
  const plan = planOverrideCompaction(lone, [])
  assert.equal(plan.ids['mcp-c'].dropped, 0, '基准未知时 decider 必须保留')
  assert.deepEqual(plan.ranges, [])

  // 同一个 id 的 insert 行在**另一份**补丁文件里：基准由调用方喂进来即可收敛。
  const cross = [override('mcp-d', true), override('mcp-d', false), ''].join('\n')
  const crossPlan = planOverrideCompaction(cross, [{ id: 'mcp-d', disabled: false }])
  assert.equal(crossPlan.ids['mcp-d'].dropped, 2, '基准已知时两条都可删（一条被盖住、一条 no-op）')
  const crossAfter = applyRanges(cross, crossPlan.ranges)
  assert.equal(scanOverrideBlocks(crossAfter).length, 0, '两条覆盖块都该没了')
  assert.equal(/disabled:/.test(crossAfter), false, '剩下的状态由那份文件的 insert 行（基准 false）决定，不再需要覆盖块')
})

test('收敛计划：不碰带配置的覆盖块、也不碰 decider 之后不声明 disabled 的块', () => {
  const configOverride = [
    '- id: mcp-e',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    "    serverName: 'mcp-e'",
    "    transport: 'stdio'",
    '  disabled: true',
  ].join('\n')
  const tail = [
    '- id: mcp-e',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    "    toolCallTimeoutMs: 30000",
  ].join('\n')
  const content = [insert('mcp-e'), configOverride, override('mcp-e', true, true), tail, ''].join('\n')

  const plan = planOverrideCompaction(content, baseRowsOf(content))
  assert.equal(plan.ids['mcp-e'].total, 3, '三个覆盖块都要被看见（含带 config 的两条）')
  // decider 是最后那条声明了 disabled 的纯块（`disabled: true` ≠ 基准 false），所以
  // 它必须留；带 config 的两条按规则也一律留。这里真正的断言是"够保守"。
  assert.equal(plan.ids['mcp-e'].dropped, 0, '没有可删的块时就不许删')
  const after = applyRanges(content, plan.ranges)
  assert.equal(after, content, '没有可删的块时文件应当逐字节不变')
  assert.match(after, /toolCallTimeoutMs: 30000/, 'decider 之后不声明 disabled 的块必须留着')
  assert.match(after, /serverName: 'mcp-e'/, '带 config 的覆盖块必须留着')
  assert.deepEqual(effectiveStates(after).get('mcp-e'), effectiveStates(content).get('mcp-e'))
})

test('块扫描：删块时带走它自己的标记注释，但不碰下一个块的注释', () => {
  const content = [
    insert('mcp-f'),
    override('mcp-f', true, true),    // 被 decider 盖住的纯块（删），它自己的标记注释也要走
    override('mcp-f', false, true),   // decider（留），它的标记注释必须留
    '',
  ].join('\n')
  // 基准给成 disabled:true，decider(false) 就与基准不同 → 必须保留。
  const plan = planOverrideCompaction(content, [{ id: 'mcp-f', disabled: true }])
  assert.equal(plan.ids['mcp-f'].dropped, 1)
  const after = applyRanges(content, plan.ranges)
  assert.equal(/# dsh-plugin-tool-management:disable:mcp-f/.test(after), false, '被删块的标记注释要一起删')
  assert.equal((after.match(/# dsh-plugin-tool-management:enable:mcp-f/g) || []).length, 1, '保留块的标记注释不能被牵连')
  assert.equal(scanOverrideBlocks(after).length, 1)
  assert.deepEqual(effectiveStates(after).get('mcp-f'), false, '保留 decider 后生效值不变')
})

test('统计口径：多余的块数 == 收敛计划要删的块数（界面数字与实际动作同源）', () => {
  const content = [
    insert('mcp-g'),
    override('mcp-g', true, true),
    override('mcp-g', true),
    override('mcp-g', true, true),
    '',
  ].join('\n')
  const rows = baseRowsOf(content)
  const stats = analyzeOverrideBlocks(content, rows)
  const plan = planOverrideCompaction(content, rows)
  assert.equal(stats['mcp-g'].total, 3)
  assert.equal(stats['mcp-g'].dropped, plan.ids['mcp-g'].dropped, '界面数字必须等于收敛计划真正删掉的块数')
  assert.equal(plan.ranges.length, stats['mcp-g'].dropped, '一个块一个行区间')
})

test('真实补丁文件：本机 ~/.dsh/cordis.patch.yml 收敛后生效状态不变，且块数收敛', (t) => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'cordis.patch.yml')
  if (!existsSync(file)) {
    t.skip(`没有 ${file}（非本机环境），跳过真实文件用例`)
    return
  }
  const content = readFileSync(file, 'utf8')
  const rows = baseRowsOf(content)
  const before = effectiveStates(content)
  const plan = planOverrideCompaction(content, rows)
  const after = effectiveStates(applyRanges(content, plan.ranges))

  assert.ok(before.size > 0, `${file} 里应当能读出条目状态（样本没生效就说明解析跑偏了）`)
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(),
    '对真实文件收敛后，每个 id 的生效状态必须逐个相同')

  const afterCounts = overrideCountsAfter(content, plan.ranges)
  for (const [id, n] of afterCounts) {
    assert.ok(n <= 1, `${id} 收敛后仍剩 ${n} 个覆盖块（同一 id 最多留一条）`)
  }
  const dropped = Object.values(plan.ids).reduce((n, s) => n + s.dropped, 0)
  const totalBlocks = scanOverrideBlocks(content).length
  assert.ok(dropped <= totalBlocks, '删掉的块数不可能超过总块数')
  assert.equal(totalBlocks - dropped, [...afterCounts.values()].reduce((n, c) => n + c, 0), '剩下的块数必须对得上')
  // 收敛后文件仍是顶层 YAML 数组（补丁文件的最低合法性要求）。
  assert.match(applyRanges(content, plan.ranges), /^- /m, '收敛后文件必须仍有顶层条目')
})
