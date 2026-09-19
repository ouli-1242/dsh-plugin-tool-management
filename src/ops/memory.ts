// 规则/记忆域的**记忆正文 ops**（2026-09-19 从 memories/service.ts 的 createMemoriesService 闭包抽出）。
//
// 列出 / 读取 / 预算 / 体检 / 新建 / 导入 / 更新 / 开关 / 索引调整 / 附件增删 —— 记忆正文这条主线。
// 与回收站、场景两个域互不调用；共享的读模型与写管道经 MemoriesOpsCtx 显式传入。
//
// ops 表里的包装（enqueueMutation / runWrite）**留在 service.ts**：本文件只导出裸 op，
// 包装归属集中在一处，改门禁时一眼看全。

import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseSkillDoc, unquote } from '../skills/core.js'
import { expandUploads, planMemoryImport } from '../imports/upload.js'
import { MAX_DESCRIPTION_LENGTH, MAX_RULE_BYTES, DEFAULT_ORDER, DEFAULT_GROUP_ORDER, GLOBAL_SCENE, GLOBAL_SCENE_LABEL, TRUNCATION_MARKER, MAX_ATTACH_ENTRY_BYTES, MAX_ATTACH_TOTAL_BYTES, MAX_ATTACH_ENTRIES, LEGACY_BUNDLE_DOC, bundleDocName, SEGMENT_RULE_HINT, isValidGroupSegment, isValidGroupPath, message, fail } from '../memories/constants.js'
import { normalizeActive, enabledSceneOf, sceneOf, sceneLabel, attachmentSummarySync } from '../memories/projection.js'
import { writeFileAtomically, writeFileAtomicBinary, readIndex, writeIndex, pathExists } from '../memories/index-io.js'
import type { RuleIndexEntry } from '../memories/index-io.js'
import { deriveDescription } from '../memories/snapshot.js'
import type { ParsedSkillDoc } from '../memories/snapshot.js'
import type { MemoriesOpsCtx } from './ctx.js'

/** 组装本域 op。rc 由 createMemoriesService 组装，契约见 ./ctx.ts。 */
export function buildMemoryOps(rc: MemoriesOpsCtx) {
  const { buildProjected, copyIntoMemoriesTrash, invalidateSnapshot, listAttachments, locateRule, maxBytes, parseId, refuseOutsideRoot, memoriesRoot, sceneMemory, scenePrompt, sceneRows, scenesRoot, serializeRuleFile, serializeUpdatedFile, snapshot, stateDir } = rc

  async function rulesList(args: any): Promise<any> {
    const groupFilter = args && typeof args.group === 'string' && args.group !== '' ? args.group : undefined
    const snap = await snapshot()
    // 索引直接用快照里那份：以前这里再 `readIndex(stateDir)` 一次 —— 同一次调用把
    // memories-index.json 读两遍，且可能出现「规则来自 t0、锁定/场景来自 t1」的混合态。
    // 新鲜度不变：插件自身的写路径走 `runWrite → refresh()` 全量失效，TTL 只对外部改文件生效。
    const index = snap.index
    const rules = snap.rules
      .filter((r) => !groupFilter || r.group === groupFilter)
      .sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order || a.name.localeCompare(b.name))
      // bundle 记忆附带附件摘要（用户裁定 2026-09-17）：界面要显示「几个附件」。
      // 代价是**同步**系统调用（其余读路径都是 await）：每条 bundle 一次 `readdirSync`
      // + 每个附件一次 `statSync`，总量 = bundle 条数 × 平均附件数，随内容线性增长。
      // 「可以忽略」这个判断只成立于 bundle 少、附件也少的时候 —— 列表是界面轮询的热路径
      // （默认 5 秒一次，见 SETTINGS_DEFAULTS.pollIntervalMs），到几百条就该换成缓存或异步。
      // flat 没有目录，原样返回（不加字段 = 界面不显示附件标签）。
      .map((r) => {
        if (r.form !== 'bundle') return r
        const attach = attachmentSummarySync(dirname(r.path), r.name)
        return attach ? { ...r, attach } : r
      })
    const groups = groupFilter ? snap.groups.filter((g) => g.name === groupFilter) : snap.groups
    const scenes = sceneRows(snap, index)
    // 场景锁定状态（v0.8）：任意一个场景锁定 = 五个管理域整体冻结。界面据此禁用各页的写控件。
    const anyLocked = Object.values(index.scenes || {}).some((s) => s.locked === true)
    const projection = sceneMemory()
    const promptProjection = scenePrompt()
    return {
      ok: true,
      rules,
      // 对外契约（§7.1）用 key 标识分组；name 保留兼容内部引用。
      groups: groups.map((g) => ({ ...g, key: g.name })),
      // 场景 = 显式记录（含保留场景 global 与尚无记忆的空场景）；active = 是否参与注入。
      scenes,
      // 任一场景被锁定 = 五个管理域整体冻结（客户端据此禁用写控件；服务端 handlers 另有守卫）。
      anyLocked,
      activeMode: normalizeActive(index.active) === null ? 'all' : 'custom',
      // 单选模型：当前启用的那个场景（null = 只留 `_shared` 与 `global`）。
      activeScene: enabledSceneOf(index),
      sceneMemory: { usedBytes: projection.bytes, maxBytes: projection.maxBytes, truncated: projection.truncated, dropped: projection.dropped },
      // 当前生效的场景提示词（绑定的预设正文；与 ~/.dsh/AGENTS.md 一致时不重复注入）。
      // `label` 是给用户指路用的显示名（「去场景设置里改『全局』的绑定」）——`global`
      // 这类磁盘名直接甩给用户看没有意义。
      scenePrompt: {
        scene: promptProjection.scene,
        label: promptProjection.scene ? sceneLabel(promptProjection.scene, index) : null,
        presetId: promptProjection.presetId,
        missing: promptProjection.missing,
        duplicate: promptProjection.duplicate === true,
        bytes: Buffer.byteLength(promptProjection.text, 'utf8'),
      },
      // 路径供 UI 显示「文件在哪」；不再让界面硬编码 ~/.dsh/scene-memory。
      paths: { memories: memoriesRoot, scenes: scenesRoot, hub: stateDir },
      stats: {
        total: rules.length,
        enabled: rules.filter((r) => r.enabled).length,
        scenes: scenes.filter((s) => s.active).length,
      },
      ...(snap.warnings.length ? { warnings: snap.warnings } : {}),
    }
  }

  async function rulesRead(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const snap = await snapshot()
    const rule = snap.rules.find((r) => r.id === id && !r.shadowed)
    const entry = snap.entries.get(id)
    if (!rule || !entry) return fail('error.rules.notFound', `规则不存在：${id}`)
    let text = ''
    try {
      text = await readFile(entry.docPath, 'utf8')
    } catch {
      return fail('error.rules.notFound', `规则不存在：${id}`)
    }
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    return {
      ok: true,
      rule: {
        ...rule,
        body: doc.body,
        attachments: entry.kind === 'bundle' ? await listAttachments(entry.entryPath, entry.name) : [],
        frontmatter: {
          name: doc.map.name != null ? String(doc.map.name) : undefined,
          description: doc.map.description != null ? String(doc.map.description) : undefined,
          whenToUse: doc.map.whenToUse != null ? String(doc.map.whenToUse) : undefined,
          globs: doc.map.globs != null ? String(doc.map.globs) : undefined,
          metadata: doc.map.metadata !== undefined ? doc.map.metadata : undefined,
        },
      },
    }
  }

  /**
   * 场景记忆段预算视图。段落由「活动场景 + 文件内容」决定，超限时**不拒绝写入**，
   * 而是按确定性顺序截断（§4 对照表）——这里只报告事实，供 UI 显著告警。
   */
  async function rulesBudget(): Promise<any> {
    const projection = sceneMemory()
    return {
      ok: true,
      usedBytes: projection.bytes,
      maxBytes: projection.maxBytes,
      truncated: projection.truncated,
      scenes: projection.scenes,
      items: projection.items,
    }
  }

  /**
   * 规则体检 + 诊断汇总（Phase 3）：逐条规则检查 6 类异常，附场景记忆段预算与场景统计。
   * 自身不做写操作，但 snapshot() 会顺带清理索引里的悬空记录（整份覆盖写），
   * 所以 op 表把它也放进写队列 —— 见 op 表上方的说明。
   */
  async function rulesDiagnose(): Promise<any> {
    const snap = await snapshot()
    // 这里**故意**直读磁盘（而不是用 `snap.index`）：体检工具的语义是「盘上现在是什么样」，
    // 用户刚手改过索引就跑一次诊断时，值得多花一次读盘换取所见即所得。
    const index = await readIndex(stateDir)
    const scenes = sceneRows(snap, index)
    const issues: Array<{ severity: 'error' | 'warning' | 'info'; code: string; ruleId?: string; message: string }> = []
    for (const rule of snap.rules) {
      if (rule.shadowed) {
        issues.push({ severity: 'warning', code: 'shadowed', ruleId: rule.id, message: `规则「${rule.id}」被同名 bundle 遮蔽，不会被加载。` })
      }
      if (String(rule.description || '').length > MAX_DESCRIPTION_LENGTH) {
        issues.push({ severity: 'error', code: 'descriptionTooLong', ruleId: rule.id, message: `规则「${rule.id}」描述超过 ${MAX_DESCRIPTION_LENGTH} 字符，会被列表与检索截断。` })
      }
      if (rule.form === 'flat') {
        const fileBase = basename(rule.path)
        const base = fileBase.toLowerCase().endsWith('.md') ? fileBase.slice(0, -3) : fileBase
        if (base !== rule.name) {
          issues.push({ severity: 'error', code: 'nameMismatch', ruleId: rule.id, message: `规则「${rule.id}」文件名（${fileBase}）与 name（${rule.name}）不一致，无法按 name 定位。` })
        }
      }
      const body = snap.bodies.get(rule.id) || ''
      if (body.trim() === '') {
        issues.push({ severity: 'error', code: 'emptyBody', ruleId: rule.id, message: `规则「${rule.id}」正文为空。` })
      }
      if (rule.descriptionDerived && String(rule.description || '').length < 10) {
        issues.push({ severity: 'info', code: 'vagueDescription', ruleId: rule.id, message: `规则「${rule.id}」描述过于笼统（自动派生，不足 10 字符），建议补充。` })
      }
      // 记忆所在场景未启用 → 不会自动生效（不是错误，但值得提示，避免"改了没效果"）。
      const scene = sceneOf(rule.group)
      if (scene === '') {
        // v0.4：记忆必须归属某个场景（留空 = 保留场景 `global`）。归不到场景的记忆
        // 不会被投影，也不会出现在场景卡片里 —— 必须显式报出来，不能静默。
        if (!rule.shadowed) {
          issues.push({ severity: 'warning', code: 'noScene', ruleId: rule.id, message: `规则「${rule.id}」没有归属场景（文件直接放在 memories/ 根层），不会被注入。请移入某个场景目录，或放到 memories/${GLOBAL_SCENE}/ 作为「全局」记忆。` })
        }
      } else if (!rule.shadowed) {
        const row = scenes.find((s) => s.name === scene)
        if (row && !row.active) {
          issues.push({ severity: 'info', code: 'sceneDisabled', ruleId: rule.id, message: `规则「${rule.id}」所属场景「${scene}」未启用，当前不会进入系统提示词。` })
        } else if (!row) {
          issues.push({ severity: 'warning', code: 'sceneUnknown', ruleId: rule.id, message: `规则「${rule.id}」的场景「${scene}」没有对应记录（可能被手工创建）——请到「场景」页补一条场景描述。` })
        }
      }
    }
    // frontmatter 非法：以 --- 开头但解析不出任何字段（残缺 frontmatter）。
    for (const entry of snap.entries.values()) {
      try {
        const text = await readFile(entry.docPath, 'utf8')
        const stripped = String(text || '').replace(/^\uFEFF/, '').trimStart()
        if (stripped.startsWith('---')) {
          const doc = parseSkillDoc(text) as ParsedSkillDoc
          if (Object.keys(doc.map || {}).length === 0) {
            issues.push({ severity: 'warning', code: 'badFrontmatter', ruleId: entry.id, message: `规则「${entry.id}」frontmatter 无法解析（以 --- 开头但无有效字段）。` })
          }
        }
      } catch { /* 读不到正文的条目根本不进 snap.entries —— 它在 buildSnapshot 的 warnings 里 */ }
    }
    const projection = sceneMemory()
    if (projection.truncated) {
      issues.push({
        severity: 'warning',
        code: 'sceneMemoryTruncated',
        message: `场景记忆段超出预算（${projection.bytes} 字节 > ${projection.maxBytes} 字节），已按确定性顺序截断并追加 ${TRUNCATION_MARKER}；请精简记忆或只保留 _shared。`,
      })
    }
    return {
      ok: true,
      issues,
      budget: { usedBytes: projection.bytes, maxBytes: projection.maxBytes, over: projection.truncated },
      counts: { rules: snap.rules.length, groups: snap.groups.length, scenes: scenes.length },
    }
  }

  // ── ops：写（串行队列内）───────────────────────────────────────────────

  async function rulesCreate(args: any): Promise<any> {
    const group = String((args && args.group) || '').trim()
    const name = String((args && args.name) || '').trim()
    const form = args && args.form === 'bundle' ? 'bundle' : 'flat'
    // 场景必填：留空落到保留场景 `global`（界面「全局」，任何对话都注入）。
    // 场景必须是**已存在**的记录——写成不存在的名字会静默造出一个没有描述的场景，
    // 所以这里显式引导用户先去「场景」页创建（错误码可被 UI 翻译）。
    if (group !== '' && !isValidGroupPath(group)) return fail('error.rules.invalidGroup', `场景名非法：${group}（${SEGMENT_RULE_HINT}）`)
    const targetGroup = group === '' ? GLOBAL_SCENE : group
    const indexForScene = await readIndex(stateDir)
    // 保留场景 global 恒存在（不用先建）；其余场景必须已存在——见上方注释。
    if (targetGroup !== GLOBAL_SCENE && !indexForScene.scenes?.[targetGroup] && !(await pathExists(join(memoriesRoot, targetGroup)))) {
      return fail('error.rules.sceneNotFound', `场景不存在：${targetGroup}（请先在「场景」页创建该场景）`, { group: targetGroup })
    }
    if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `记忆名非法：${name}（${SEGMENT_RULE_HINT}）`)
    // 目标已存在（bundle 或 flat 皆算）→ 拒绝，避免静默覆盖。
    // 用 exists 而不是 shadowed：后者说的是「同名 bundle 把 flat 遮蔽了」，用户看到
    // 「被同名 bundle 遮蔽」会去找一个并不存在的 bundle（2026-09-16 实测）。
    const existing = await locateRule(group, name)
    if (existing) {
      return fail('error.rules.exists', `同名记忆已存在（${existing.kind === 'bundle' ? 'bundle' : 'flat'}）：${existing.id}`)
    }
    // 落点必须在根内（realpath 口径）：`targetGroup` 的某一级可能是指向根外的目录链接。
    const denied = await refuseOutsideRoot(join(memoriesRoot, targetGroup, name))
    if (denied) return denied
    const body = String((args && args.body) ?? '')
    if (body.trim() === '') return fail('error.rules.bodyRequired', '规则正文不能为空')
    if (Buffer.byteLength(body, 'utf8') > MAX_RULE_BYTES) return fail('error.rules.tooLarge', `规则正文过大（超过 ${MAX_RULE_BYTES >> 10} KiB）`)
    let description: string | undefined
    const rawDescription = args && args.description != null ? String(args.description).trim() : ''
    if (rawDescription !== '') {
      if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
        return fail('error.rules.descriptionTooLong', `描述超过 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${rawDescription.length}）`)
      }
      description = rawDescription
    } else {
      const derived = deriveDescription(body)
      if (!derived) return fail('error.rules.descriptionRequired', '请提供规则描述（正文中也无可派生的标题或首行）')
      description = derived // 派生只进内存投影，不写回文件
    }
    // 正文序列化（frontmatter 仅写用户显式提供的字段）。是否生效由"场景是否启用"决定，
    // 超预算只在渲染时确定性截断 + 告警，不再拒绝写入（§4 对照表）。
    const fields: Record<string, string | boolean> = { name }
    if (rawDescription !== '') fields.description = description!
    const text = serializeRuleFile(fields, body)
    // 更新索引（force 重读后合并，避免覆盖用户手工编辑）。
    // id 恒为 `<场景>/<名>`（与 parseId 同构）；场景记录此时必然已存在。
    const createdId = `${targetGroup}/${name}`
    const index = indexForScene
    // P5：新建记忆默认**不开启** —— 记忆的开关是单一真相源（`enabled`），
    // 用户裁定「创建的记忆默认不开启，在记忆页开启后对应的场景档案也要显示开启」。
    index.rules[createdId] = { order: DEFAULT_ORDER, enabled: false, updatedAt: new Date().toISOString() }
    if (!index.groups[targetGroup]) index.groups[targetGroup] = { order: DEFAULT_GROUP_ORDER, label: targetGroup }
    // **先落索引、再落文件**，顺序不能反。索引条目指向一个尚不存在的文件是无害的：列表与投影
    // 都以「发现到的文件」为准，找不到就跳过，buildSnapshot 的清理还会顺手把这条记录删掉。
    // 反过来（先文件后索引）一旦进程死在中间，留下的文件没有索引条目，就会落到 projectRule
    // 的 `enabled ?? true` 默认值上 —— 用户没开过的记忆被当成启用并注入模型上下文，且无提示。
    await writeIndex(stateDir, index)
    try {
      if (form === 'bundle') {
        await mkdir(join(memoriesRoot, targetGroup, name), { recursive: true })
        await writeFileAtomically(join(memoriesRoot, targetGroup, name, bundleDocName(name)), text)
      } else {
        await mkdir(join(memoriesRoot, targetGroup), { recursive: true })
        await writeFileAtomically(join(memoriesRoot, targetGroup, name + '.md'), text)
      }
    } catch (e) {
      // 文件没落成 → 撤回刚写的索引条目，别留下一条指向不存在文件的幽灵记录。
      delete index.rules[createdId]
      try { await writeIndex(stateDir, index) } catch { /* 撤回失败不掩盖原始错误 */ }
      throw e
    }
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(createdId) }
  }

  /**
   * 导入记忆（.md / .zip）：文件即真源——把 .md 原文落进 `<场景>/<名>.md`，场景为空 = 全局根层
   * zip 内带目录 → 目录路径当场景；裸 .md → 落到 `args.scene`（留空 = 保留场景 `global`）。
   * 引用到的场景不存在时**自动补一条场景记录**（导入是批量动作，要求用户先逐个建场景不现实）；
   * 这不算静默造场景——被补的场景会在 `scenes` 结果里回传，UI 会提示。
   * 重名一律**跳过并报告**（与技能导入同策略），绝不覆盖用户既有文件。
   * 部分成功：单条失败只记 skipped，不影响同批其余条目。
   */
  async function rulesImport(args: any): Promise<any> {
    const scene = String((args && args.scene) || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
    if (scene !== '' && !isValidGroupPath(scene)) {
      return fail('error.rules.invalidGroup', `场景名非法：${scene}（留空 = 全局；否则${SEGMENT_RULE_HINT}）`)
    }
    const defaultScene = scene === '' ? GLOBAL_SCENE : scene
    const files = args && args.files
    if (!Array.isArray(files) || !files.length) return fail('error.import.noFiles', '没有选择要导入的文件')
    const { entries, problems } = expandUploads(files)
    const planned = planMemoryImport(entries, defaultScene)
    const skipped: Array<{ name: string; reason: string }> = [...problems, ...planned.problems]
    const imported: string[] = []
    const accepted: Array<{ group: string; name: string; text: string; kind: 'flat' | 'bundle'; attachments: Array<{ name: string; data: Buffer }> }> = []
    for (const target of planned.targets) {
      if (target.group !== '' && !isValidGroupPath(target.group)) { skipped.push({ name: target.name, reason: '场景名非法，已跳过' }); continue }
      if (!isValidGroupSegment(target.name)) { skipped.push({ name: target.name, reason: '记忆名不合法，已跳过' }); continue }
      const text = Buffer.from(target.bytes).toString('utf8').replace(/^\uFEFF/, '')
      if (text.trim() === '') { skipped.push({ name: target.name, reason: '内容为空，已跳过' }); continue }
      if (Buffer.byteLength(text, 'utf8') > MAX_RULE_BYTES) {
        skipped.push({ name: target.name, reason: `正文超过 ${MAX_RULE_BYTES >> 10} KiB，已跳过` })
        continue
      }
      // bundle 附件复检（规划层已过滤，这里按 rules-attach 同口径再拦一次，防绕过规划层的调用方）。
      const rawAttachments = target.kind === 'bundle' ? target.attachments || [] : []
      const checkedAttachments: Array<{ name: string; data: Buffer }> = []
      // 同名检查必须与 rules-attach 同口径：写入顺序是「正文先、附件后」，附件名撞上正文本体
      // 会把刚写好的正文覆盖掉（用户数据静默丢失）。此前这里漏了这道，注释却写着「同口径」。
      const docNames = new Set([bundleDocName(target.name), LEGACY_BUNDLE_DOC])
      let attachTotal = 0
      for (const att of rawAttachments) {
        if (!isValidGroupSegment(att.name)) { skipped.push({ name: `${target.name}/${att.name}`, reason: '附件名不合法，已跳过' }); continue }
        if (docNames.has(att.name)) { skipped.push({ name: `${target.name}/${att.name}`, reason: '附件名不能与正文文件同名，已跳过' }); continue }
        const data = Buffer.from(att.bytes)
        if (!data.length) { skipped.push({ name: `${target.name}/${att.name}`, reason: '附件内容为空，已跳过' }); continue }
        if (data.length > MAX_ATTACH_ENTRY_BYTES) { skipped.push({ name: `${target.name}/${att.name}`, reason: `附件过大（单个上限 ${MAX_ATTACH_ENTRY_BYTES >> 20} MiB），已跳过` }); continue }
        attachTotal += data.length
        if (attachTotal > MAX_ATTACH_TOTAL_BYTES) { skipped.push({ name: `${target.name}/${att.name}`, reason: `附件合计超过 ${MAX_ATTACH_TOTAL_BYTES >> 20} MiB，已跳过` }); continue }
        checkedAttachments.push({ name: att.name, data })
      }
      const existing = await locateRule(target.group, target.name)
      if (existing) {
        skipped.push({ name: target.group ? `${target.group}/${target.name}` : target.name, reason: '同名已存在（已跳过）' })
        continue
      }
      accepted.push({ group: target.group, name: target.name, text, kind: target.kind, attachments: checkedAttachments })
    }
    // 落点必须在根内（realpath 口径）：场景目录可能是指向根外的链接。逐条判定、失败的进 skipped
    // —— 导入是批量操作，不该因为一条越界就把其余条目一起丢掉。
    for (let i = accepted.length - 1; i >= 0; i--) {
      const denied = await refuseOutsideRoot(join(memoriesRoot, accepted[i].group, accepted[i].name))
      if (!denied) continue
      skipped.push({ name: `${accepted[i].group}/${accepted[i].name}`, reason: denied.error })
      accepted.splice(i, 1)
    }
    if (!accepted.length) return { ok: true, imported, skipped, scenes: [] }
    const index = await readIndex(stateDir)
    if (!index.scenes) index.scenes = {}
    const createdScenes: string[] = []
    // 场景记录在本趟新增的那些：只有对应的记忆真的落成，才算「新建了场景」报给界面。
    const scenesAddedHere = new Set<string>()

    // 第一趟：索引条目全部写好（含场景分组与场景记录）。
    // **先索引后文件**，顺序不能反 —— 先文件后索引时，进程死在中间会留下没有索引条目的文件，
    // 它们会落到 projectRule 的 `enabled ?? true` 默认值上，被当成启用并注入模型上下文
    // （与 rules-create 同一处说明）。反过来留下的索引条目指向不存在的文件是无害的：
    // 列表与投影都以发现到的文件为准，buildSnapshot 的清理还会把这类记录删掉。
    for (const item of accepted) {
      const id = `${item.group}/${item.name}`
      // 索引记录：与 rules-create 同口径（order/enabled/updatedAt + 场景分组），用户既有设置不覆盖。
      const entry = index.rules[id]
      // P5：导入的记忆同样默认**不开启**（与 rules-create 同一口径）；已存在的条目保留原开关。
      index.rules[id] = { ...(entry || {}), order: entry?.order ?? DEFAULT_ORDER, enabled: entry?.enabled ?? false, updatedAt: new Date().toISOString() }
      if (!index.groups[item.group]) index.groups[item.group] = { order: DEFAULT_GROUP_ORDER, label: item.group }
      // 场景记录补齐（导入进来的目录名此前可能没有记录）。
      if (!index.scenes[item.group]) {
        index.scenes[item.group] = item.group === GLOBAL_SCENE
          ? { label: GLOBAL_SCENE_LABEL, order: 0 }
          : { order: DEFAULT_GROUP_ORDER, createdAt: new Date().toISOString() }
        scenesAddedHere.add(item.group)
      }
      imported.push(id)
    }
    await writeIndex(stateDir, index)

    // 第二趟：落文件。失败项从索引里撤回，否则会留下指向不存在文件的幽灵条目。
    let rolledBack = false
    for (const item of accepted) {
      const id = `${item.group}/${item.name}`
      try {
        if (item.kind === 'bundle') {
          // 与 rules-create 同落点：bundle = <场景>/<名>/ 目录，正文 <名>.md，附件平铺同层。
          const bundleDir = join(memoriesRoot, item.group, item.name)
          await mkdir(bundleDir, { recursive: true })
          await writeFileAtomically(join(bundleDir, bundleDocName(item.name)), item.text)
          for (const att of item.attachments) await writeFileAtomicBinary(join(bundleDir, att.name), att.data)
        } else {
          await mkdir(join(memoriesRoot, item.group), { recursive: true })
          await writeFileAtomically(join(memoriesRoot, item.group, item.name + '.md'), item.text)
        }
      } catch (e) {
        skipped.push({ name: id, reason: '写入失败：' + message(e) })
        delete index.rules[id]
        const at = imported.indexOf(id)
        if (at >= 0) imported.splice(at, 1)
        rolledBack = true
        continue
      }
      if (scenesAddedHere.has(item.group) && createdScenes.indexOf(item.group) < 0) createdScenes.push(item.group)
    }
    if (rolledBack) await writeIndex(stateDir, index)
    return { ok: true, imported, skipped, scenes: createdScenes }
  }

  async function rulesUpdate(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    let text: string
    try {
      text = await readFile(located.docPath, 'utf8')
    } catch {
      return fail('error.rules.notFound', `规则不存在：${id}`)
    }
    const doc = parseSkillDoc(text) as ParsedSkillDoc
    // flat 形态：frontmatter 声明名必须等于文件名（发现时可列出，更新时校验）。
    const currentName = doc.map.name != null && String(doc.map.name).trim() !== '' ? unquote(String(doc.map.name)).trim() : parts.name
    if (located.kind === 'flat' && currentName !== parts.name) {
      return fail('error.rules.invalidName', `flat 规则名与文件名不一致（frontmatter name: ${currentName}，文件名: ${parts.name}），请先修正规则文件`)
    }
    const newName = args && args.name != null ? String(args.name).trim() : currentName
    if (!isValidGroupSegment(newName)) return fail('error.rules.invalidName', `记忆名非法：${newName}（${SEGMENT_RULE_HINT}）`)
    const newForm = args && args.form === 'bundle' ? 'bundle' : args && args.form === 'flat' ? 'flat' : located.kind
    const newBody = args && args.body != null ? String(args.body) : doc.body
    if (newBody.trim() === '') return fail('error.rules.bodyRequired', '规则正文不能为空')
    if (Buffer.byteLength(newBody, 'utf8') > MAX_RULE_BYTES) return fail('error.rules.tooLarge', `规则正文过大（超过 ${MAX_RULE_BYTES >> 10} KiB）`)
    // description：显式传 → 校验并写文件；传空串 → 删除字段并从正文派生；未传 → 保留现有（缺失则派生）。
    let description: string | undefined
    if (args && args.description != null) {
      const ds = String(args.description).trim()
      if (ds !== '') {
        if (ds.length > MAX_DESCRIPTION_LENGTH) {
          return fail('error.rules.descriptionTooLong', `描述超过 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${ds.length}）`)
        }
        description = ds
      } else {
        const derived = deriveDescription(newBody)
        if (!derived) return fail('error.rules.descriptionRequired', '请提供规则描述（正文中也无可派生的标题或首行）')
        description = derived // 派生不写回
      }
    } else {
      const existing = doc.map.description != null ? unquote(String(doc.map.description)).trim() : ''
      if (existing !== '') description = existing
      else description = deriveDescription(newBody) || undefined
    }
    // 形态转换 / 改名：先建新形态文件，再把旧形态复制进回收站、最后删原件
    // （确保任意失败点不产生半份规则；旧形态随时可恢复，README「删除都进回收站」无例外）。
    // description 写回约定：显式传 → string/null（删除）；未传 → undefined（保留原字段）。
    const serialize = (): string => {
      let descArg: string | undefined | null
      if (args && args.description != null) descArg = String(args.description).trim() === '' ? null : description
      else descArg = undefined
      return serializeUpdatedFile(doc, newName, descArg, newBody)
    }
    // 所有写入 / 删除分支的落点都在 `<root>/<group>` 之下：先确认这个目录（经 realpath）仍在根内。
    const denied = await refuseOutsideRoot(join(memoriesRoot, parts.group))
    if (denied) return denied
    if (located.kind === 'bundle' && newForm === 'flat') {
      await mkdir(join(memoriesRoot, parts.group), { recursive: true })
      await writeFileAtomically(join(memoriesRoot, parts.group, newName + '.md'), serialize())
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
      await rm(located.entryPath, { recursive: true, force: true })
    } else if (located.kind === 'flat' && newForm === 'bundle') {
      await mkdir(join(memoriesRoot, parts.group, newName), { recursive: true })
      await writeFileAtomically(join(memoriesRoot, parts.group, newName, bundleDocName(newName)), serialize())
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
      await rm(join(memoriesRoot, parts.group, parts.name + '.md'), { force: true })
    } else if (located.kind === 'flat' && newName !== parts.name) {
      // flat 改名 = 文件改名
      await writeFileAtomically(join(memoriesRoot, parts.group, newName + '.md'), serialize())
      await copyIntoMemoriesTrash(located, parts.group, parts.name)
      await rm(join(memoriesRoot, parts.group, parts.name + '.md'), { force: true })
    } else {
      // bundle 不 rename 目录：只更新 frontmatter/正文
      await writeFileAtomically(located.docPath, serialize())
    }
    // 索引：改名则迁移记录（保留 order/tags/enabled 等），否则原地更新。
    const index = await readIndex(stateDir)
    const newId = `${parts.group}/${newName}`
    if (newId !== id && index.rules[id]) {
      index.rules[newId] = { ...index.rules[id], updatedAt: new Date().toISOString() }
      delete index.rules[id]
    } else {
      index.rules[id] = { ...(index.rules[id] || {}), updatedAt: new Date().toISOString() }
    }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(newId) }
  }

  async function rulesToggle(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    // `enabled` 必须显式给。缺省时旧实现回落到"沿用当前值"，却照样刷新
    // updatedAt 并返回 ok:true —— 调用方按 toggle（翻转）理解时会以为自己改了
    // 状态，实际什么都没改（界面不受影响：它一直显式传值）。与 rulesSetActive
    // 同一条口径：参数缺失就明确拒绝，不猜。
    if (typeof (args && args.enabled) !== 'boolean') {
      return fail('error.rules.invalidArgs', '缺少参数：enabled 必须是布尔值（toggle 只按传入值写入，不做"翻转"推断）')
    }
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const enabled = args.enabled === true
    index.rules[id] = { ...idxEntry, enabled, updatedAt: new Date().toISOString() }
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(id) }
  }

  async function rulesSetIndex(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const index = await readIndex(stateDir)
    const idxEntry = index.rules[id] || {}
    const next: RuleIndexEntry = { ...idxEntry, updatedAt: new Date().toISOString() }
    if (args && args.order !== undefined) {
      const order = Number(args.order)
      if (!Number.isFinite(order) || order < 0) return fail('error.rules.invalidGroup', `非法排序值：${args.order}`)
      next.order = Math.floor(order)
    }
    if (args && args.tags !== undefined) {
      next.tags = Array.isArray(args.tags) ? args.tags.map((t: unknown) => String(t)) : []
    }
    if (args && args.pinned !== undefined) next.pinned = args.pinned === true
    if (args && args.note !== undefined) next.note = String(args.note)
    index.rules[id] = next
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(id) }
  }

  // ── 组装 ─────────────────────────────────────────────────────────────────

  /**
   * 往 bundle 记忆里写附件。flat 形态没有目录，直接拒绝。
   * 先整体校验、再逐个落盘：避免写到一半才因为第 N 个文件非法而留下半份附件。
   * 同名附件覆盖（这是用户对自己文件的显式上传动作）。
   */
  async function rulesAttach(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    if (located.kind !== 'bundle') return fail('error.rules.notBundle', `「${parts.name}」是 flat（单文件），不能带附件`)
    const files: any[] = Array.isArray(args && args.files) ? args.files : []
    if (files.length === 0) return fail('error.rules.noFiles', '没有选择附件')
    if (files.length > MAX_ATTACH_ENTRIES) return fail('error.rules.tooManyFiles', `一次最多 ${MAX_ATTACH_ENTRIES} 个附件`, { limit: MAX_ATTACH_ENTRIES })
    const pending: Array<{ name: string; data: Buffer }> = []
    let total = 0
    const docNames = new Set([bundleDocName(located.name), LEGACY_BUNDLE_DOC])
    for (const file of files) {
      const name = String((file && (file.path || file.name)) || '')
      if (!isValidGroupSegment(name)) return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
      if (docNames.has(name)) return fail('error.rules.invalidName', `附件名不能与正文文件同名：${name}`)
      const data = Buffer.from(String((file && file.data) || ''), 'base64')
      if (data.length === 0) return fail('error.rules.emptyFile', `附件内容为空：${name}`)
      if (data.length > MAX_ATTACH_ENTRY_BYTES) return fail('error.rules.fileTooLarge', `附件过大：${name}（单个上限 ${MAX_ATTACH_ENTRY_BYTES >> 20} MiB）`, { limit: MAX_ATTACH_ENTRY_BYTES >> 20 })
      total += data.length
      if (total > MAX_ATTACH_TOTAL_BYTES) return fail('error.rules.tooLarge', `附件总大小超过 ${MAX_ATTACH_TOTAL_BYTES >> 20} MiB`, { limit: MAX_ATTACH_TOTAL_BYTES >> 20 })
      pending.push({ name, data })
    }
    for (const file of pending) await writeFileAtomicBinary(join(located.entryPath, file.name), file.data)
    return { ok: true, attachments: await listAttachments(located.entryPath, located.name) }
  }

  /** 删除 bundle 记忆的一个附件；正文 `<名>.md`（或旧数据 `SKILL.md`）不可删。 */
  async function rulesDetach(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    if (located.kind !== 'bundle') return fail('error.rules.notBundle', `「${parts.name}」是 flat（单文件），没有附件`)
    const name = String((args && args.name) || '')
    if (!isValidGroupSegment(name) || name === bundleDocName(located.name) || name === LEGACY_BUNDLE_DOC) {
      return fail('error.rules.invalidName', `附件名非法：${name || '(空)'}`)
    }
    const target = join(located.entryPath, name)
    // 附件落点同样要在根内（realpath 口径）。
    const denied = await refuseOutsideRoot(target)
    if (denied) return denied
    try {
      const st = await lstat(target)
      if (!st.isFile() || st.isSymbolicLink()) return fail('error.rules.notFound', `附件不存在：${name}`)
    } catch {
      return fail('error.rules.notFound', `附件不存在：${name}`)
    }
    await rm(target, { force: true })
    return { ok: true, attachments: await listAttachments(located.entryPath, located.name) }
  }

  return { rulesList, rulesRead, rulesBudget, rulesDiagnose, rulesCreate, rulesImport, rulesUpdate, rulesToggle, rulesSetIndex, rulesAttach, rulesDetach }
}
