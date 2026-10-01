// 访问令牌的宿主侧配置读写：定位本插件 loader 行所在的补丁文件、按形状分类，改
// `config.token` 与 `tokenDisabled` 那两行（兼容页「设置 / 关闭 / 打开 / 清除」四个动作）。
//
// 正文从 index.ts 的 apply 闭包里整段搬来，一字未改（只去一层缩进，并把八个 apply 作用域
// 名字改成走 deps —— moved-verify 按这三类容差机检，容差之外任何一字不同都会报错）。
//
// 为什么这一段单独成层：它是唯一会**改写宿主启动配置**的那只手，凭证口径（哪几个方向必须
// 当面再输一次当前令牌、哪几个可以认请求头里那份）全在下面 tokenConfigure 的注释里。
// HTTP 路由是它唯一的调用方，而且刻意不放进 handlers 表 —— 模型不该有能力关掉访问令牌。
import { applyLoaderToken, applyLoaderTokenDisabled, buildLoaderOverrideEntry, readLoaderToken, scanLoaderRows } from './mcp/loader-token.js'

export interface TokenConfigDeps {
  /** apply 的路径发现（缓存住的那份）：只用得到三个补丁文件路径。 */
  ensurePaths(): Promise<any>
  readPatch(abs: string): Promise<string>
  writePatch(abs: string, content: string): Promise<void>
  /** apply 的串行写锁：令牌改写与其余写操作共用同一条队列。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  message(e: unknown): string
  /** 生效令牌（功能关掉即空串）：`pendingRestart` 比的是它。 */
  TOKEN: string
  /** 配置里的**存量**令牌：四个方向的凭证判据都以它为基准。 */
  CONFIG_TOKEN: string
  tokenMatches(presented: string): boolean
}

export interface TokenConfig {
  tokenConfigState(): Promise<{ found: boolean; configHasToken: boolean; configDisabled: boolean; pendingRestart: boolean }>
  tokenConfigure(args: any, presented: boolean): Promise<any>
}

export function createTokenConfig(deps: TokenConfigDeps): TokenConfig {
  // ---------- 访问令牌：宿主侧配置的读写（兼容页就地开关） ----------
  // 用户裁定 2026-09-18：① 没配令牌时能在面板里"设置"；② 已配时，填对令牌就能"关闭"；
  // ③ 填过的令牌只在本次进程内有效，重启要重填。③在客户端实现（见 client.js 的 bootId 绑定），
  // ①②在这里 —— 它们要改的是**插件自己那条 loader 行**的 config.token。

  /** 某份补丁文件里本插件 loader 行的令牌配置。 */
  interface LoaderTokenInfo { token: string; disabled: boolean }

  /**
   * 找到本插件 loader 行所在的补丁文件，并**按形状分类**。
   *
   * 冲突只认 **insert** 条目：同 id 的两条 insert 才会重复挂载、让 DSH 起不来（与
   * duplicateGuard 同一口径）。顶层**覆盖条目**（`- id:` 在第 0 列）是官方支持的改法，
   * 与 insert 并存是正常形状 —— 把它也算成"第二份补丁"会让 0.1.7 bundle 挂载下的令牌
   * 操作被全量拒绝（2026-09-30 审查 P2-12）。
   *
   * `files` 的**顺序即写点优先级**：覆盖条目在前。理由：官方 `applyEntryPatches` 在所有
   * bundle 层**之后**应用覆盖条目、且是整体替换那条 loader 的 `config` —— 所以两种形状
   * 并存时，令牌写进 insert 行会被覆盖条目盖掉（改了不生效，两边还都看不出分歧）。
   */
  async function loaderTokenFiles(): Promise<{ files: string[]; insertFiles: string[]; infoOf: Map<string, LoaderTokenInfo>; bundleBase: boolean }> {
    const p = await deps.ensurePaths()
    const insertFiles: string[] = []
    const overrideFiles: string[] = []
    const infoOf = new Map<string, LoaderTokenInfo>()
    for (const abs of [p.projectPatch, p.globalPatch]) {
      let content = ''
      try { content = await deps.readPatch(abs) } catch { continue }
      const rows = scanLoaderRows(content)
      if (!rows.insert.length && !rows.override.length) continue
      const read = readLoaderToken(content)
      if (!read.found) continue
      infoOf.set(abs, { token: read.token, disabled: read.disabled })
      if (rows.insert.length) insertFiles.push(abs)
      else overrideFiles.push(abs)
    }
    // 0.1.7 bundle 挂载：loader 条目由插件包内的 cordis.patch.yml（bundle 层）提供，两份
    // 补丁里都没有可就地改写的行。bundleBase 只回答「覆盖目标存在吗」—— 写点是 profile
    // 补丁里的覆盖条目（见 tokenConfigure），bundle 文件本身永不落密钥。
    let bundleBase = false
    try {
      bundleBase = readLoaderToken(await deps.readPatch(p.bundlePatch)).found
    } catch { bundleBase = false }
    return { files: [...overrideFiles, ...insertFiles], insertFiles, infoOf, bundleBase }
  }

  /**
   * 配置**文件里**写了令牌，但当前进程还没生效（或反过来）—— 也就是"改了配置还没重启"。
   * 界面据此把"重启后生效"说成事实而不是猜测。
   *
   * 局限（写下来免得当成 bug）：读不到环境变量，所以靠 `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN`
   * 提供令牌时（文件里没有 token），这里会报"待重启"。那是保守方向 —— 环境变量改动同样要重启。
   */
  async function tokenConfigState(): Promise<{ found: boolean; configHasToken: boolean; configDisabled: boolean; pendingRestart: boolean }> {
    try {
      const { files, infoOf } = await loaderTokenFiles()
      if (files.length !== 1) return { found: false, configHasToken: false, configDisabled: false, pendingRestart: false }
      const info = infoOf.get(files[0]) || { token: '', disabled: false }
      const configHasToken = info.token !== ''
      // 「文件里配的」与「当前进程在用的」是否一致 —— 比的是**生效**状态（有位子但关了 = 没生效）。
      const fileEffective = configHasToken && !info.disabled
      return { found: true, configHasToken, configDisabled: info.disabled, pendingRestart: fileEffective !== (deps.TOKEN !== '') }
    } catch { return { found: false, configHasToken: false, configDisabled: false, pendingRestart: false } }
  }

  /**
   * 改宿主侧的令牌配置：`set` 写入 / 换掉令牌、`off` 关掉令牌功能、`on` 重新打开、
   * `clear` 把令牌从配置里删掉（回到"还没有令牌"那一态）。
   *
   * 关键设计（用户裁定 2026-09-19）：
   *   - **`off` 不再删除 `token`**，只写一行 `tokenDisabled: true` —— 原令牌保留，随时能开回来，
   *     不需要重新输一遍（此前的实现把配置删了，用户想再开就得重新想一遍令牌）。
   *   - **`clear` 才是"删掉"**（用户 2026-09-19 问"令牌没有彻底清除按钮"）：删 `config.token`
   *     与 `tokenDisabled` 两行，回到从未设置过的样子 —— 写操作不再要凭证、明文密钥随之
   *     不可见。它是不可逆的那一端（配置里没有副本了），所以与 `off` 共用同一条凭证口径。
   *   - **`off` / `clear` 只认"当场再输一次"的令牌**（`value` 对得上才算）：请求头里那份已验过
   *     的凭证不算数 —— 解锁之后顺手一点就能把防护关掉 / 把令牌删掉，等于没把守（用户裁定
   *     2026-09-19：「就算输入过了令牌，关闭保护也应该再次输入令牌才能关闭」）。界面据此就地在
   *     「保护开关」/「宿主配置」里展开一个确认框。
   *   - **`set` 与 `off` / `clear` 同一条口径**：宿主已有令牌时，改令牌也必须当场再输一次当前
   *     令牌（走 `current` 字段 —— `token` 里是新令牌，证明不了知道旧值；凭证是旧值这件事不能
   *     靠请求头里那份"本次启动已解锁"顶替）。界面据此在「宿主配置」表单里多摆一栏「当前令牌」，
   *     并且不再要求用户先解锁再改。
   *   - **`on` 仍接受请求头里的凭证**（`presented`），或输入框里那个值本身就是当前令牌。
   *     两个方向都必须验 —— 否则"能打开 GUI 就能关掉保护"，令牌等于白配（要求 9）。
   *   - `set`：宿主**还没配**令牌时允许（首次设置 —— 否则这个功能永远打不开），那一态没有
   *     "当前令牌"可证明，所以 `current` 不作要求。
   *
   * 不放进 handlers：这样它既不在 HTTP 的普通 op 面上，也**不会**被任何模型工具间接调用 ——
   * 模型不该有能力关掉访问令牌。
   */
  async function tokenConfigure(args: any, presented: boolean): Promise<any> {
    const raw = String((args && args.mode) || '')
    const mode: 'set' | 'off' | 'on' | 'clear' = raw === 'off' ? 'off' : raw === 'on' ? 'on' : raw === 'clear' ? 'clear' : 'set'
    const value = String((args && args.token) || '').trim()
    const currentRaw = String((args && args.current) || '').trim()
    // 关闭 / 重新打开时，用户填进输入框的那个值**就是**当前令牌，可以直接当凭证 ——
    // 省掉"先保存再操作"两步。`set` 不行：那个值是新令牌，不能拿它证明自己知道旧值，
    // 所以它的凭证单独走 `current`。
    const proofByValue = mode !== 'set' && value !== '' && deps.CONFIG_TOKEN !== '' && deps.tokenMatches(value)
    const proofByCurrent = mode === 'set' && currentRaw !== '' && deps.CONFIG_TOKEN !== '' && deps.tokenMatches(currentRaw)
    // 关闭保护 / 删除令牌 / 修改令牌都是"改凭证 / 减防护"的方向：**不认**请求头里已经验过的
    // 那份凭证，必须当面再输一次当前令牌（用户裁定 2026-09-19 —— 先判「关闭」，随后同一口径
    // 推到「修改」，再推到「删除」）。开启保护仍接受请求头里的凭证。
    if (mode === 'off' && deps.CONFIG_TOKEN !== '' && !proofByValue) {
      return { ok: false, code: 'error.secret.badToken', error: '关闭保护要再输一次当前令牌。' }
    }
    if (mode === 'clear' && deps.CONFIG_TOKEN !== '' && !proofByValue) {
      return { ok: false, code: 'error.secret.badToken', error: '删除令牌要再输一次当前令牌。' }
    }
    if (mode === 'set' && deps.CONFIG_TOKEN !== '' && !proofByCurrent) {
      return { ok: false, code: 'error.secret.badToken', error: '修改令牌要先填一次当前令牌。' }
    }
    if (deps.CONFIG_TOKEN !== '' && !presented && !proofByValue && !proofByCurrent) {
      return { ok: false, code: 'error.secret.badToken', error: '要改动访问令牌，请先在「本次启动」里填入当前令牌并解锁。' }
    }
    if ((mode === 'off' || mode === 'clear') && deps.CONFIG_TOKEN === '') {
      return { ok: true, changed: false, note: '宿主侧本来就没有配置令牌。', restartRequired: false }
    }
    if (mode === 'on' && deps.CONFIG_TOKEN === '') {
      return { ok: false, error: '配置里没有令牌：请先用「设置令牌」写入一个，再打开令牌保护。' }
    }
    if (mode === 'set') {
      if (!value) return { ok: false, error: '请先填入要设置的令牌' }
      // 换行会写坏 YAML 标量、NUL 会截断路径 —— 这两类直接拒绝比转义更清楚。
      if (/[\r\n\u0000]/.test(value)) return { ok: false, error: '令牌不能包含换行或控制字符' }
      if (value === deps.CONFIG_TOKEN) return { ok: true, changed: false, note: '和当前令牌相同，未改动。', restartRequired: false }
    }
    const p = await deps.ensurePaths()
    const { files, insertFiles, bundleBase } = await loaderTokenFiles()
    if (!files.length && !(mode === 'set' && bundleBase)) {
      return { ok: false, error: '没找到本插件的 loader 行，也无法确认 bundle 层的挂载条目，无法自动改写配置：请在 profile 的 cordis.patch.yml 里手动加一条覆盖条目（- id: dsh-plugin-tool-management → config: → token: "…"），或改用环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN。' }
    }
    // 只有**两条 insert 条目**才是"重复挂载、DSH 起不来"（审查 P2-12：覆盖条目与 insert
    // 并存是 0.1.7 的正常形状，把它也算进来会让令牌操作被全量拒绝）。
    if (insertFiles.length > 1) {
      return { ok: false, error: '本插件的 loader 行作为 insert 条目同时出现在两份补丁文件里（重复挂载会导致 DSH 无法启动）：请先清掉重复那条，再回来设置令牌。' }
    }
    // 覆盖条目多于一份则写点不唯一：官方按文件顺序 last-wins，我们无法确定该改哪一份 ——
    // 与其赌一份，不如让用户先合并。
    if (files.length > 1) {
      return { ok: false, error: '本插件的 loader 行在多处出现且都不是唯一的 insert 条目（多半是多条覆盖条目）：无法确定该改哪一处，请先手工合并成一条再设置令牌。' }
    }
    if (!files.length) {
      // 0.1.7 bundle 挂载：两份补丁里都没有本插件的 loader 行（条目由 bundle 层提供，那份
      // 文件是仓库镜像、不能落密钥）—— 令牌写进 **profile 补丁的覆盖条目**：宿主在所有
      // bundle 层之后应用它，整体替换那条 loader 的 config（bundle 条目没有 config，替换
      // 零丢失）；同 id 的 insert 条目才会重复挂载导致启动失败，覆盖条目是官方支持的改法。
      // `off` / `clear` / `on` 走不到这里：有 site 时就地改写，没 site 且有令牌 = 令牌来自
      // 环境变量，那两条路在前面已按各自口径返回。
      return deps.withWriteLock(async () => {
        let content = ''
        try { content = await deps.readPatch(p.projectPatch) } catch (e) { return { ok: false, error: '读取补丁失败: ' + deps.message(e) } }
        const next = content === '' ? buildLoaderOverrideEntry(value) + '\n' : (content.endsWith('\n') ? content : content + '\n') + '\n' + buildLoaderOverrideEntry(value)
        try {
          await deps.writePatch(p.projectPatch, next)
        } catch (e) {
          return { ok: false, error: '写入补丁失败: ' + deps.message(e) }
        }
        return { ok: true, changed: true, mode, restartRequired: true, path: p.projectPatch }
      })
    }
    const abs = files[0]
    return deps.withWriteLock(async () => {
      let content = ''
      try { content = await deps.readPatch(abs) } catch (e) { return { ok: false, error: '读取补丁失败: ' + deps.message(e) } }
      // 两步改写共用一份内容：先写令牌（set 写值 / clear 删掉），再写开关（set 与 clear 顺带
      // 把"已关闭"那行清掉 —— 换了个新令牌却还留着"已关闭"、或者令牌都没了还写着"已关闭"，
      // 都是说不通的）。
      let changed = false
      // `refused`：loader 行里的 config 形状是插件读不了的（flow style / 重复键）。此时
      // 改写会插入第二个 `config:`，而官方 js-yaml 对重复映射键是 throw —— 后果是 DSH 下次
      // 起不来。所以拒绝并说明，而不是"尽力写一下"。
      if (mode === 'set' || mode === 'clear') {
        const wrote = applyLoaderToken(content, mode === 'clear' ? null : value)
        if (!wrote.found) return { ok: false, error: '没找到本插件的 loader 行：' + abs }
        if (wrote.refused) return { ok: false, error: wrote.refused }
        content = wrote.content
        changed = changed || wrote.changed
      }
      const flag = mode === 'off' ? true : mode === 'clear' ? null : false
      const toggled = applyLoaderTokenDisabled(content, flag)
      if (!toggled.found) return { ok: false, error: '没找到本插件的 loader 行：' + abs }
      if (toggled.refused) return { ok: false, error: toggled.refused }
      content = toggled.content
      changed = changed || toggled.changed
      if (changed) {
        try {
          await deps.writePatch(abs, content)
        } catch (e) {
          return { ok: false, error: '写入补丁失败: ' + deps.message(e) }
        }
      }
      // 改配置**需要重启 DSH 才生效**：当前进程的 TOKEN 是 apply 时读进来的常量。
      // 所以这里如实回 restartRequired，界面据此说清"现在还没生效"，而不是让用户以为失败了。
      return { ok: true, changed, mode, restartRequired: changed, path: abs }
    })
  }

  return { tokenConfigState, tokenConfigure }
}
