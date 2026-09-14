// Contract tests for src/compat/preset-reach.ts (built to lib/compat/preset-reach.js).
//
// This matrix answers a question that used to be answered with a lie: whether
// the prompt sections this plugin registers actually reach the model under the
// preset a session runs. The fixtures below are SHIPPED compositions, quoted
// verbatim from `@deepseek-ai/dsh-agent-presets` — a hand-written lookalike
// would let the parser rot against the real dialect, which is the one thing
// this probe must survive. When the package is resolvable the whole shipped
// roster is read off disk and asserted too.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import {
  readCompositionFacts,
  deriveReach,
  assessPresetReach,
  reachNoticeFor,
  reachNoticeForAgent,
} from '../lib/compat/preset-reach.js'

/**
 * `minimal` — the suppressing shape.
 *
 * Also carries the two `disabled` dialects the presence check must tell
 * apart: a literal `true` in the group, and a platform `!!js` gate on a
 * nested row.
 */
const MINIMAL = [
  '# The `minimal` agent preset: a fixed-prompt, single-tool coding-agent composition.',
  '',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: You are a helpful software engineer assistant.',
  '    complete: true',
  '    includeRuntimeContext: false',
  '',
  '- id: persistent-shell',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    terminals: true',
  '  config:',
  '    - id: pty',
  "      name: '@deepseek-ai/dsh-terminal'",
  '',
  '    - id: terminal-bash',
  "      name: '@deepseek-ai/dsh-terminal-bash'",
  "      disabled: !!js process.platform === 'win32'",
].join('\n')

/**
 * `standard` — the full shape, with a nested group and a multi-line scalar
 * (`prefix: >-`) that must not be mistaken for row content.
 */
const STANDARD = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '  config:',
  '    maxBytes: 65536',
  '',
  '- id: skill-filesystem',
  "  name: '@deepseek-ai/dsh-skill-filesystem'",
  '',
  '- id: tool-skill',
  "  name: '@deepseek-ai/dsh-tool-skill'",
  '',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: spawn',
  '',
  '    - id: tool-workflow',
  "      name: '@deepseek-ai/dsh-tool-workflow'",
  '      disabled: true',
].join('\n')

test('minimal composition: complete persona suppresses prompt injection', () => {
  const facts = readCompositionFacts(MINIMAL)
  assert.equal(facts.personaComplete, true)
  assert.equal(facts.personaMounted, true)
  assert.equal(facts.agentInstructions, 'absent')
  assert.equal(facts.toolSkill, 'absent')
  assert.equal(facts.parseFailure, undefined)

  const reach = deriveReach(facts)
  assert.equal(reach.memory, 'suppressed')
  assert.equal(reach.agentsMd, 'suppressed')
  assert.equal(reach.skillCatalog, 'absent')
})

test('standard composition: nothing suppressed, every carrier mounted', () => {
  const facts = readCompositionFacts(STANDARD)
  assert.equal(facts.personaComplete, false)
  assert.equal(facts.personaMounted, true)
  assert.equal(facts.agentInstructions, 'mounted')
  assert.equal(facts.toolSkill, 'mounted')

  const reach = deriveReach(facts)
  assert.equal(reach.memory, 'ok')
  assert.equal(reach.agentsMd, 'ok')
  assert.equal(reach.skillCatalog, 'ok')
})

test('a multi-line scalar cannot fake a complete flag', () => {
  // The `>-` block above carries prose; only a whole-line `complete:` counts,
  // so prose that merely mentions it must not flip the answer.
  const prose = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: >-',
    '      Set complete: true only when you want a fixed prompt.',
  ].join('\n')
  assert.equal(readCompositionFacts(prose).personaComplete, false)
})

test('disabled dialects: true is absent, !!js stays conditional', () => {
  const literal = [
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '  disabled: true',
  ].join('\n')
  assert.equal(readCompositionFacts(literal).toolSkill, 'absent')
  assert.equal(deriveReach(readCompositionFacts(literal)).skillCatalog, 'absent')

  const gated = [
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    "  disabled: !!js process.platform === 'win32'",
  ].join('\n')
  assert.equal(readCompositionFacts(gated).toolSkill, 'conditional')
  // A gate nobody can evaluate outside a mount must not be reported as fine.
  assert.equal(deriveReach(readCompositionFacts(gated)).skillCatalog, 'unknown')
})

test('a nested row is parsed on its own, not folded into its group', () => {
  // `@deepseek-ai/dsh-tool-skill` sits inside a cordis:group here; the group
  // header is a different module and must not shadow the nested row.
  const nested = [
    '- id: tools',
    '  name: cordis:group',
    '  group: true',
    '  config:',
    '    - id: tool-skill',
    "      name: '@deepseek-ai/dsh-tool-skill'",
  ].join('\n')
  assert.equal(readCompositionFacts(nested).toolSkill, 'mounted')

  const disabledNested = [
    '- id: tools',
    '  name: cordis:group',
    '  group: true',
    '  config:',
    '    - id: tool-skill',
    "      name: '@deepseek-ai/dsh-tool-skill'",
    '      disabled: true',
  ].join('\n')
  assert.equal(readCompositionFacts(disabledNested).toolSkill, 'absent')
})

test('a disabled persona row does not suppress anything', () => {
  const text = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  disabled: true',
    '  config:',
    '    prefix: unused',
    '    complete: true',
  ].join('\n')
  const facts = readCompositionFacts(text)
  assert.equal(facts.personaMounted, false)
  assert.equal(facts.personaComplete, false)
  assert.equal(deriveReach(facts).memory, 'ok')
})

test('unreadable input degrades to unknown, never to "fine"', () => {
  const empty = readCompositionFacts('')
  assert.equal(empty.personaComplete, 'unknown')
  assert.ok(empty.parseFailure)
  const reach = deriveReach(empty)
  assert.equal(reach.memory, 'unknown')
  assert.equal(reach.agentsMd, 'unknown')
})

test('assessPresetReach builds the matrix and is read-only', async () => {
  const calls = []
  const roster = {
    defaultId: 'standard',
    list: async () => {
      calls.push('list')
      return [
        { id: 'standard', name: '标准模式', trust: 'system' },
        { id: 'minimal', name: '极简', trust: 'system' },
      ]
    },
    read: async (id) => {
      calls.push('read:' + id)
      return id === 'minimal' ? MINIMAL : STANDARD
    },
    // Present so that a caller reaching for a MOUNT would be caught: building
    // the matrix must never compose a preset just to describe it.
    mount: () => { throw new Error('mount() must not be called by the probe') },
    composeFrom: () => { throw new Error('composeFrom() must not be called by the probe') },
    recompose: () => { throw new Error('recompose() must not be called by the probe') },
  }

  const report = await assessPresetReach(roster)
  assert.equal(report.blockers.length, 0)
  assert.equal(report.defaultId, 'standard')
  assert.deepEqual(calls, ['list', 'read:standard', 'read:minimal'])

  const byId = new Map(report.rows.map((row) => [row.presetId, row]))
  assert.equal(byId.get('standard').isDefault, true)
  assert.equal(byId.get('standard').memory, 'ok')
  assert.equal(byId.get('standard').skillCatalog, 'ok')
  assert.equal(byId.get('minimal').isDefault, false)
  assert.equal(byId.get('minimal').memory, 'suppressed')
  assert.equal(byId.get('minimal').agentsMd, 'suppressed')
  assert.equal(byId.get('minimal').name, '极简')
})

test('a preset whose composition cannot be read names its own reason', async () => {
  const roster = {
    defaultId: 'good',
    list: async () => [{ id: 'good' }, { id: 'ghost' }],
    read: async (id) => {
      if (id === 'ghost') throw new Error('ENOENT')
      return STANDARD
    },
  }
  const report = await assessPresetReach(roster)
  const ghost = report.rows.find((row) => row.presetId === 'ghost')
  // One unreadable preset must not take the report down with it.
  assert.equal(report.rows.length, 2)
  assert.equal(ghost.memory, 'unknown')
  assert.match(ghost.reason, /ENOENT/)
})

test('a missing roster is a blocker, not a throw', async () => {
  const report = await assessPresetReach(undefined)
  assert.deepEqual(report.rows, [])
  assert.equal(report.blockers.length, 1)
  assert.equal(report.defaultId, null)

  const listless = await assessPresetReach({ read: async () => STANDARD })
  assert.equal(listless.blockers.length, 1)
})

test('the model notice states the boundary and stays silent when nothing is wrong', () => {
  const suppressed = reachNoticeFor('minimal', readCompositionFacts(MINIMAL))
  assert.match(suppressed, /minimal/)
  assert.match(suppressed, /complete/)
  // The load-bearing sentence: the model must not assume it has the bodies.
  assert.match(suppressed, /rule_manager_read/)

  assert.equal(reachNoticeFor('standard', readCompositionFacts(STANDARD)), '')

  // AGENTS.md can be missing on its own, with the persona fine.
  const noInstructions = reachNoticeFor('custom', readCompositionFacts([
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: hi',
  ].join('\n')))
  assert.match(noInstructions, /AGENTS\.md/)
})

test('reachNoticeForAgent resolves the preset off the live scope', async () => {
  const roster = {
    read: async (id) => (id === 'minimal' ? MINIMAL : STANDARD),
    composedPreset: () => 'minimal',
  }
  const notice = await reachNoticeForAgent(roster, { scope: 'agent-ctx' })
  assert.match(notice, /minimal/)

  // Every failure path is silent: a boundary notice must never turn a
  // successful read into an error.
  assert.equal(await reachNoticeForAgent(roster, undefined), '')
  assert.equal(await reachNoticeForAgent(undefined, {}), '')
  assert.equal(await reachNoticeForAgent({ composedPreset: () => undefined }, {}), '')
  assert.equal(await reachNoticeForAgent({
    composedPreset: () => { throw new Error('no scope') },
    read: async () => MINIMAL,
  }, {}), '')
  assert.equal(await reachNoticeForAgent({
    composedPreset: () => 'minimal',
    read: async () => { throw new Error('gone') },
  }, {}), '')
})

/**
 * Locate the shipped preset roster.
 *
 * This plugin does not declare `@deepseek-ai/dsh-agent-presets` (it must run
 * on hosts without it), so the package is usually only present in the HOST
 * installation. `@deepseek-ai/dsh-workspace` IS a shared dependency and is
 * junctioned to the host, so its `@deepseek-ai` directory is the host's —
 * the same anchor `compat/probe.ts` uses to decide module identity.
 */
function resolvePresetsDir() {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
  } catch { /* not resolvable as a dependency — fall through to the host */ }
  try {
    let dir = dirname(require.resolve('@deepseek-ai/dsh-workspace/package.json'))
    for (let i = 0; i < 4; i += 1) {
      if (dir.endsWith(join('node_modules', '@deepseek-ai'))) {
        return join(dir, 'dsh-agent-presets', 'presets')
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* no anchor either — skip below */ }
  return null
}

test('the shipped roster answers as measured on the real host', (t) => {
  // Reads the installed package when it is resolvable, so the parser is pinned
  // against the real dialect rather than only against the fixtures above.
  const presetsDir = resolvePresetsDir()
  if (presetsDir === null || !existsSync(presetsDir)) {
    t.skip('@deepseek-ai/dsh-agent-presets not resolvable from this checkout')
    return
  }

  const factsFor = (id) => readCompositionFacts(
    readFileSync(join(presetsDir, id, 'agent.cordis.yml'), 'utf8'),
  )

  // Measured 2026-09-14 against the shipped presets.
  const minimal = factsFor('minimal')
  assert.equal(minimal.personaComplete, true, 'minimal suppresses prompt sections')
  assert.equal(minimal.toolSkill, 'absent', 'minimal mounts no skill catalog')

  for (const id of ['standard', 'ptc', 'cordis']) {
    const facts = factsFor(id)
    assert.equal(facts.personaComplete, false, `${id} keeps other prompt sections`)
    assert.equal(facts.toolSkill, 'mounted', `${id} exposes the skill catalog`)
    assert.equal(facts.agentInstructions, 'mounted', `${id} carries AGENTS.md`)
    assert.equal(deriveReach(facts).memory, 'ok')
  }
})
