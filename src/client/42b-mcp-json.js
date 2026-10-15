    // ---------- MCP 导入 / 导出（0.15.0 A1；0.20.x 起收 dsh 补丁片段）------------------
    // 服务端 `mcpm-import` / `mcpm-export` 早就实现完整，缺的只是界面与**格式转换**。
    // 导入面（三条路）：
    //   · 社区流通的 `{"mcpServers": {...}}`
    //   · 服务端自己的 `{rows: [...]}` / 裸数组
    //   · **dsh 补丁片段**（用户 2026-10-15 指出这才是真实模板）：`- insert:` 块 +
    //     `name: '@deepseek-ai/dsh-mcp-client'` + `config:`，也就是 `cordis.patch.yml` 里
    //     本插件自己写出来的形状（生成侧见 src/mcp/patch-yaml.ts 的 buildInsertBlock）。
    // 且 `transport` 只要不是字面 `'stdio'` 就一律落 streamable-http、`serverName` 不合规矩
    // 就整条丢弃。这些判定必须在提交前做完并让用户看见，否则导入完只剩一串跳过原因。

    /** 本插件写入补丁时用的 loader 名（单一真相源在 src/host-names.ts 的 MCP_CLIENT_MODULE）。 */
    var MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

    function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

    /** 名字净化：非 `[A-Za-z0-9_-]` → `-`，去空壳横线，截到 32（与服务端那条正则同口径）。 */
    function sanitizeMcpServerName(raw) {
      var s = String(raw == null ? '' : raw).trim().replace(/[^A-Za-z0-9_-]/g, '-')
      s = s.replace(/^-+/, '').replace(/-+$/, '')
      return s.slice(0, 32)
    }
    /** 派生 id 与 `normalizeImportItem` 的算法一致 —— 预览里的重名判定按 id 比一次才不作弊。 */
    function mcpImportIdOf(serverName) {
      return 'mcp-' + String(serverName).toLowerCase().replace(/[^a-z0-9-]/g, '-')
    }
    /** 裸映射的识别：每个值都是「有 command 或有 url」的对象（`{servers:{…}}` 这类变体也走得通）。 */
    function looksLikeServerMap(obj) {
      var keys = Object.keys(obj)
      if (!keys.length) return false
      return keys.every(function (k) { var v = obj[k]; return isPlainObject(v) && (!!v.command || !!v.url) })
    }
    /**
     * 外层包装键：社区各家写法不一（`mcpServers` / `servers`），内容都是「名字 → 配置」。
     * 判据放宽到「至少有一个值是对象」：整块里混一条坏配置很常见，那要交给逐条判定去说，
     * 不能因为一条坏掉就把整份判成「认不出结构」。
     */
    function mcpServerMapOf(parsed) {
      var wrappers = ['mcpServers', 'servers', 'mcp']
      for (var i = 0; i < wrappers.length; i += 1) {
        var v = parsed[wrappers[i]]
        if (isPlainObject(v) && Object.keys(v).length && Object.keys(v).some(function (k) { return isPlainObject(v[k]) })) return v
      }
      return null
    }

    // ---------- dsh 补丁片段（YAML）解析 ----------------------------------------------
    // 客户端**不自己写 YAML 解析器**：要认的是宿主读的那份方言（`!!js` 表达式标签也算
    // 合法），而 `js-yaml` 本来就在本插件的依赖里、宿主读补丁用的也是它（见
    // src/compat/patch-dialect.ts 的说明）。惰性取、拿不到就如实回报 —— require 失败只让
    // YAML 这一条路不可用，JSON 那条路照旧，页面不会整片挂掉（顶层 require 会）。
    var mcpYamlState = { tried: false, mod: null, schema: null }
    function mcpYamlModule() {
      if (mcpYamlState.tried) return mcpYamlState.mod
      mcpYamlState.tried = true
      try {
        var y = require('js-yaml')
        if (y && typeof y.load === 'function' && typeof y.Type === 'function' && y.JSON_SCHEMA) mcpYamlState.mod = y
      } catch (e) { mcpYamlState.mod = null }
      return mcpYamlState.mod
    }
    /**
     * 宿主那份 schema：`JSON_SCHEMA` + `!!js` 表达式标签（定义与 dsh 官方逐字等价，
     * 见 src/compat/patch-dialect.ts 的 schemaOf）。**不 eval** —— 表达式在这里只当字符串
     * 收下（`{__jsExpr: …}`）：我们要的只是"解析得动"，值本身不由客户端解释。
     */
    function mcpYamlSchema(y) {
      if (mcpYamlState.schema) return mcpYamlState.schema
      try {
        var exprType = new y.Type('tag:yaml.org,2002:js', {
          kind: 'scalar',
          resolve: function (data) { return typeof data === 'string' },
          construct: function (data) { return { __jsExpr: data } },
          predicate: function (v) { return !!v && typeof v === 'object' && '__jsExpr' in v },
          represent: function (v) { return v.__jsExpr },
        })
        mcpYamlState.schema = y.JSON_SCHEMA.extend(exprType)
      } catch (e) { mcpYamlState.schema = null }
      return mcpYamlState.schema
    }
    /** 文本看着像不像 dsh 补丁片段（只用来在两条路都失败时挑一句对症的报错）。 */
    function looksLikePatchText(raw) {
      return String(raw).indexOf('- insert:') >= 0 || String(raw).indexOf(MCP_CLIENT_MODULE) >= 0
    }
    /** 补丁顶层项：`- insert:` 块。 */
    function isInsertBlock(item) { return isPlainObject(item) && Array.isArray(item.insert) }
    /**
     * 补丁顶层项：覆盖块（`- id: x` + `name: <模块名>` + `disabled:`）。
     * 行形状（社区 JSON / rows）带的是 serverName / command / url 而不是 `name`，别认错。
     */
    function isOverrideBlock(item) {
      if (!isPlainObject(item) || item.insert !== undefined) return false
      if (typeof item.name !== 'string' || !item.name) return false
      return item.serverName === undefined && item.command === undefined && item.url === undefined
    }
    /**
     * 补丁文档判据：顶层数组，每一项都是 insert 块或覆盖块，且**至少有一个 insert**。
     * （没有 insert 的普通数组交给下面「数组 = 行」那条路，别抢。）
     */
    function looksLikePatchDoc(doc) {
      if (!Array.isArray(doc) || !doc.length) return false
      var sawInsert = false
      for (var i = 0; i < doc.length; i += 1) {
        if (isInsertBlock(doc[i])) { sawInsert = true; continue }
        if (!isOverrideBlock(doc[i])) return false
      }
      return sawInsert
    }
    /**
     * 补丁文档 → 预览行。口径与宿主 `parseRows`（src/mcp/patch-yaml.ts）一致：
     *   · 只收 `name === MCP_CLIENT_MODULE` 的 insert 子条目（本插件只管 MCP，同一份文件里
     *     别的 loader 条目原样忽略）；
     *   · 顶层覆盖块按**文件顺序**改写同 id 的启停 —— 宿主那边"覆盖块写在 insert 之前是
     *     no-op（此刻还没入索引）"，所以这里也只对**已收集到**的行生效。
     * 每条拼成 `{serverName, ...config, id}` 交给 mcpRowFromConfig：判定、预览、提交与
     * JSON 那条路完全共用一套（重名/传输/致命项的处理因此不会两副口径）。
     */
    function patchDocToRows(doc) {
      var entries = []
      var byId = {}
      for (var i = 0; i < doc.length; i += 1) {
        var item = doc[i]
        if (isInsertBlock(item)) {
          for (var j = 0; j < item.insert.length; j += 1) {
            var child = item.insert[j]
            if (!isPlainObject(child) || child.name !== MCP_CLIENT_MODULE) continue
            var cfg = isPlainObject(child.config) ? child.config : {}
            var feed = Object.assign({}, cfg)
            if (child.id !== undefined) feed.id = String(child.id)
            // insert 子条目自己的 `disabled` 是 cordis 的启停位：本插件写的是**另起**一个
            // 覆盖块，但手写文件里两种都见过，等价看待。
            if (child.disabled !== undefined && feed.disabled === undefined) feed.disabled = child.disabled
            var name = cfg.serverName !== undefined && String(cfg.serverName).trim() ? String(cfg.serverName) : String(child.id == null ? '' : child.id)
            var entry = { row: mcpRowFromConfig(name, feed, entries.length) }
            entries.push(entry)
            if (child.id !== undefined) byId[String(child.id)] = entry
          }
          continue
        }
        if (isOverrideBlock(item) && item.id !== undefined && item.disabled !== undefined) {
          var target = byId[String(item.id)]
          // 启停要连 payload 一起改：预览读 row.disabled，提交发的是 row.payload。
          if (target) { target.row.disabled = item.disabled === true; target.row.payload.disabled = item.disabled === true }
        }
      }
      return entries.map(function (e) { return e.row })
    }

    var MCP_CFG_KEYS = ['command', 'args', 'url', 'env', 'headers', 'disabled', 'type', 'transport', 'serverName', 'id', 'level']

    /** 一条配置 → 预览行（含服务端会拒绝的形状问题）。不取词：问题以 code 回给界面翻译。 */
    function mcpRowFromConfig(name, cfg, index) {
      var c = isPlainObject(cfg) ? cfg : {}
      var notices = []
      var rawName = String(name == null ? '' : name)
      var serverName = sanitizeMcpServerName(rawName) || ('server-' + (index + 1))
      if (serverName !== rawName) notices.push({ code: 'renamed', params: { from: rawName || '-', to: serverName } })
      var ignored = Object.keys(c).filter(function (k) { return MCP_CFG_KEYS.indexOf(k) < 0 })
      if (ignored.length) notices.push({ code: 'ignoredFields', params: { keys: ignored.join('、') } })
      var command = String(c.command == null ? '' : c.command).trim()
      var url = String(c.url == null ? '' : c.url).trim()
      // 判传输方式看「有没有 command」而不是 `type` 写了什么：社区配置里 type 的取值太杂
      // （sse / http / streamableHttp…），而服务端只认 'stdio'，照抄会把 stdio 变成连不上的 http 条目。
      var transport = command ? 'stdio' : (url ? 'streamable-http' : '')
      var args = []
      if (Array.isArray(c.args)) args = c.args.map(String)
      else if (typeof c.args === 'string' && c.args.trim()) { args = c.args.trim().split(/\s+/); notices.push({ code: 'argsSplit' }) }
      else if (c.args != null && c.args !== '') notices.push({ code: 'argsIgnored' })
      var env = null, headers = null
      if (c.env != null && c.env !== '') { if (isPlainObject(c.env)) env = c.env; else notices.push({ code: 'kvIgnored', params: { key: 'env' } }) }
      if (c.headers != null && c.headers !== '') { if (isPlainObject(c.headers)) headers = c.headers; else notices.push({ code: 'kvIgnored', params: { key: 'headers' } }) }
      var fatal = !transport ? 'noEndpoint' : (transport === 'streamable-http' && !/^https?:\/\//.test(url) ? 'badUrl' : '')
      var payload = { serverName: serverName, transport: transport || 'streamable-http', level: c.level === 'global' ? 'global' : 'project', disabled: !!c.disabled }
      if (c.id && /^[A-Za-z0-9_.:@%+=/-]+$/.test(String(c.id))) payload.id = String(c.id)
      if (transport === 'stdio') { payload.command = command; payload.args = args; payload.env = env || {} }
      else { payload.url = url; if (headers) payload.headers = headers }
      return {
        key: '', serverName: serverName, originalName: rawName, transport: transport,
        command: command, args: args, url: url, disabled: !!c.disabled, fatal: fatal, notices: notices,
        secretCount: (env ? Object.keys(env).length : 0) + (headers ? Object.keys(headers).length : 0),
        payload: payload, id: payload.id || mcpImportIdOf(serverName),
      }
    }

    /**
     * 粘贴的任意 MCP 文本 → `{ok, rows}` 或 `{ok:false, code, error?}`。
     * 两条路：先按 JSON 试（`{mcpServers:{…}}` → `{rows:[…]}` → 裸数组 → 裸映射），
     * JSON 不成立时再按 **dsh 补丁片段** YAML 试。顺序不能反 —— 一份合法 JSON 必然也是
     * 合法 YAML，反之不成立，先解析 YAML 会把 `{"mcpServers": …}` 读成别的东西。
     */
    function convertMcpJsonToRows(text) {
      var raw = String(text == null ? '' : text).trim()
      var parsed = null
      var jsonOk = false
      var jsonError = null
      try { parsed = JSON.parse(raw); jsonOk = true } catch (e) { jsonError = e }
      if (!jsonOk) {
        var y = mcpYamlModule()
        if (!y) {
          // 缺依赖时说清是"读不了 YAML"，而不是抛一句 JSON 的语法错 —— 后者对着
          // `- insert:` 那种文本完全是误导。
          return { ok: false, code: looksLikePatchText(raw) ? 'yamlUnavailable' : 'parse', error: errMsg(jsonError) }
        }
        var doc
        try { doc = y.load(raw, { schema: mcpYamlSchema(y) }) } catch (e2) {
          return { ok: false, code: 'parse', error: errMsg(looksLikePatchText(raw) ? e2 : jsonError) }
        }
        if (looksLikePatchDoc(doc)) {
          var patchRows = patchDocToRows(doc)
          return patchRows.length ? { ok: true, rows: patchRows } : { ok: false, code: 'shape' }
        }
        // 不认成补丁文档就落到下面那几条 JSON 形状上再判一次：YAML 写出来的
        // `rows` 数组 / `mcpServers` 映射同样该收。
        parsed = doc
      }
      if (!isPlainObject(parsed) && !Array.isArray(parsed)) return { ok: false, code: 'shape' }
      var pairs = []
      var map = isPlainObject(parsed) ? mcpServerMapOf(parsed) : null
      if (map) {
        Object.keys(map).forEach(function (k) { pairs.push([k, map[k]]) })
      } else if (Array.isArray(parsed) || Array.isArray(parsed.rows)) {
        var list = Array.isArray(parsed) ? parsed : parsed.rows
        list.forEach(function (it, i) { pairs.push([it && it.serverName != null ? String(it.serverName) : String(i + 1), it]) })
      } else if (looksLikeServerMap(parsed)) {
        Object.keys(parsed).forEach(function (k) { pairs.push([k, parsed[k]]) })
      } else return { ok: false, code: 'shape' }
      var used = {}
      var rows = pairs.map(function (pair, i) {
        var row = mcpRowFromConfig(pair[0], pair[1], i)
        // 批次内重名：serverName 全局唯一，第二条起服务端必然「serverName 已存在」。
        // 与其让用户导入一半才发现，不如现在就改名并在预览里标出来。
        if (used[row.serverName]) {
          var n = 2, next = row.serverName
          while (n < 1000) {
            next = row.serverName.slice(0, Math.max(1, 30 - String(n).length)) + '-' + n
            if (!used[next]) break
            n += 1
          }
          row.notices.push({ code: 'dupInBatch', params: { from: row.serverName, to: next } })
          row.serverName = next
          row.payload.serverName = next
          delete row.payload.id
        }
        used[row.serverName] = true
        row.key = row.serverName + '#' + i
        row.id = row.payload.id || mcpImportIdOf(row.serverName)
        return row
      })
      return { ok: true, rows: rows }
    }

    /**
     * 导入框的「dsh 标准模板」。打开弹窗即预填这份，用户直接改；删空后 placeholder
     * 显示同一份（useState 初值与 placeholder 同源，两条路径永远是这一份）。
     *
     * 用**真实**的补丁格式而不是社区的 `{"mcpServers": …}`（用户 2026-10-15：贴出
     * `cordis.patch.yml` 里的真身，"默认模板不对"）：这正是 `buildInsertBlock`
     * （src/mcp/patch-yaml.ts）写进补丁的形状，也是宿主真正读的那份 —— 缩进、引号、
     * `config:` 的层级都按生成器逐字取。两条示例覆盖两种传输方式（stdio 看 command、
     * http 看 url；判传输不看 `transport` 字段，见 mcpRowFromConfig 注释），
     * serverName 带 example- 前缀就是让人一眼看出"这是模板，改我"。
     *
     * 顶层的 `# dsh-plugin-tool-management:server:<id>` 标记**不写进模板**：那是本插件
     * 自己落盘时加的，用户手写的片段不需要它（解析时按注释忽略）。
     */
    var MCP_IMPORT_TEMPLATE = [
      '- insert:',
      '    - id: mcp-example',
      "      name: '" + MCP_CLIENT_MODULE + "'",
      '      config:',
      '        serverName: "example"',
      '        transport: "stdio"',
      '        command: "npx"',
      '        args:',
      '          - "-y"',
      '          - "your-package"',
      '        env:',
      '          "API_KEY": ""',
      '- insert:',
      '    - id: mcp-example-remote',
      "      name: '" + MCP_CLIENT_MODULE + "'",
      '      config:',
      '        serverName: "example-remote"',
      '        transport: "streamable-http"',
      '        url: "https://your-server.com/mcp"',
    ].join('\n')

    function McpJsonImportModal(props) {
      var t = props.t
      // 打开即预填标准模板（用户 2026-10-15），删空后 placeholder 还是它 ——
      // 初值与 placeholder 同源（MCP_IMPORT_TEMPLATE），不会出现"打开是模板、
      // 删空变一句话"的两副面孔。
      var ts = react.useState(MCP_IMPORT_TEMPLATE); var text = ts[0], setText = ts[1]
      // 解析走防抖值：整份 JSON 在每次按键上都重解析没有意义。
      var dq = useDebouncedValue(text)
      var bs = react.useState(false); var busy = bs[0], setBusy = bs[1]
      var rs = react.useState(null); var result = rs[0], setResult = rs[1]
      var cs = react.useState('skip'); var conflict = cs[0], setConflict = cs[1]
      var os = react.useState({}); var off = os[0], setOff = os[1]
      var fileRef = react.useRef(null)
      var converted = react.useMemo(function () {
        return String(dq || '').trim() ? convertMcpJsonToRows(dq) : null
      }, [dq])
      var rows = converted && converted.ok ? converted.rows : []
      var chosen = rows.filter(function (r) { return !r.fatal && off[r.key] !== true })
      /** 与现有配置的重名判定：名字或 id 任一命中就算冲突（服务端两张表都查）。 */
      function conflictOf(row) {
        var names = props.existingNames || [], ids = props.existingIds || []
        var hit = names.indexOf(row.serverName) >= 0 || ids.indexOf(row.id) >= 0
        if (!hit) return ''
        return conflict === 'overwrite' ? 'overwrite' : 'skip'
      }
      function toggle(key) { var next = Object.assign({}, off); next[key] = !next[key]; setOff(next) }
      function onPickFile(files) {
        var f = files && files[0]
        if (!f) return
        f.text().then(function (s) { setText(String(s)) }).catch(function (e) { setResult({ ok: false, text: errMsg(e) }) })
      }
      function submit() {
        if (!chosen.length) { setResult({ ok: false, text: t('mcp.importJson.none') }); return }
        setBusy(true); setResult(null)
        var args = { json: JSON.stringify({ rows: chosen.map(function (r) { return r.payload }) }) }
        if (conflict === 'overwrite') args.conflict = 'overwrite'
        apiCall('mcpm-import', args).then(function (res) {
          setBusy(false)
          if (!res || !res.ok) { setResult({ ok: false, text: (res && res.error) || t('mcp.msg.failed') }); return }
          setResult({
            ok: true,
            text: t('mcp.importJson.result', {
              added: (res.added || []).length,
              overwritten: (res.overwritten || []).length,
              skipped: (res.skipped || []).length,
            }),
            skipped: res.skipped || [],
            warning: res.warning || '',
          })
          if (props.onDone) props.onDone(res)
        }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
      }

      var preview = !converted ? null
        : !converted.ok ? h('div', { className: 'dsm-feedback dsm-error', role: 'alert' },
            converted.code === 'yamlUnavailable' ? t('mcp.importJson.noYaml')
              : converted.code === 'parse' ? t('mcp.importJson.parseError', { error: converted.error }) : t('mcp.importJson.parseError.shape'))
        : !rows.length ? h('div', { className: 'dsm-empty' }, t('mcp.importJson.empty'))
        : h(react.Fragment, null,
            rows.length > 20 ? h('div', { className: 'dsm-help' }, t('mcp.importJson.bigBatch', { count: rows.length })) : null,
            // 预览表头整行删除（用户 2026-10-15）：「服务名与连接参数」「状态」两个
            // 表头 label 是给三列网格看的，删掉后每行自带 transport 标签与端点，
            // 信息不丢；勾选框随之改为随行内容垂直居中（.dsm-imp-row align-items:center）。
            h('div', { className: 'dsm-imp-list' }, rows.map(function (r) {
              var cf = conflictOf(r)
              var endpoint = r.transport === 'stdio' ? [r.command].concat(r.args).join(' ') : r.url
              return h('div', { key: r.key, className: 'dsm-imp-row' + (r.fatal ? ' dsm-imp-bad' : '') },
                h(RowCheck, { checked: !r.fatal && off[r.key] !== true, disabled: !!r.fatal, label: r.serverName, onChange: function () { toggle(r.key) } }),
                h('div', { className: 'dsm-imp-main' },
                  h('div', { className: 'dsm-imp-name' },
                    r.serverName,
                    r.transport ? h('span', { className: 'dsm-tag' }, r.transport) : null,
                    r.disabled ? h('span', { className: 'dsm-tag dsm-tag-off' }, t('mcp.importJson.disabled')) : null),
                  endpoint ? h('div', { className: 'dsm-imp-endpoint' }, endpoint) : null,
                  r.originalName && r.originalName !== r.serverName ? h('div', { className: 'dsm-imp-sub' }, t('mcp.importJson.original', { name: r.originalName })) : null,
                  r.fatal ? h('div', { className: 'dsm-imp-err' }, t('mcp.importJson.err.' + r.fatal)) : null,
                  r.notices.map(function (n) { return h('div', { key: n.code, className: 'dsm-imp-note' }, t('mcp.importJson.' + n.code, n.params || {})) })),
                h('div', { className: 'dsm-imp-meta' },
                  cf ? h('span', { className: 'dsm-tag' + (cf === 'skip' ? ' dsm-tag-off' : '') }, t('mcp.importJson.will.' + cf)) : null,
                  r.secretCount ? h('span', { className: 'dsm-tag' }, t('mcp.importJson.preview.secret', { count: r.secretCount })) : null))
            })),
            // 冲突处理上移到预览之前（见 dsm-imp-conflict），页脚只剩计数。
            h('div', { className: 'dsm-imp-foot' },
              h('span', { className: 'dsm-imp-count' }, t('mcp.importJson.chosen', { count: chosen.length }))))

      return h(Modal, { className: 'dsm-modal-lg', title: t('mcp.importJson.title'), closeLabel: t('btn.close'), onClose: props.onClose },
        h('div', { className: 'dsm-form' },
          h('p', { className: 'dsm-help' }, t('mcp.importJson.hint')),
          h('textarea', {
            className: 'dsm-control dsm-textarea-md', rows: 14, value: text, spellCheck: false,
            placeholder: MCP_IMPORT_TEMPLATE, onChange: function (e) { setText(e.target.value) },
          }),
          h('div', { className: 'dsm-upload-choices' },
            h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { if (fileRef.current) fileRef.current.click() } }, t('btn.file.pick')),
            h('span', { className: 'dsm-upload-divider' }, t('mcp.importJson.orPaste')),
            h('input', { ref: fileRef, type: 'file', accept: '.json', className: 'dsm-hidden-input', onChange: function (e) { onPickFile(e.target.files); e.target.value = '' } })),
          // 重名处理（用户 2026-10-15 两连）：从预览底部上移到预览之前 —— 埋在列表
          // 脚下的二选一，导入前根本看不见；radio 换成「提示词类型」同款分段控件 ——
          // 排他二选一的正解控件，恒有一颗按下，没有「都不选」这一态。
          rows.length ? h('div', { className: 'dsm-imp-conflict' },
            // 「重名时」文字 label 删除（用户 2026-10-15）：两颗互斥按钮自己说清
            // 「跳过 / 覆盖」，前置标签是废话；可访问性由 aria-label 承担。
            h('div', { className: 'dsm-form-seg', role: 'group', 'aria-label': t('mcp.importJson.conflict.label') },
              h('button', { key: 'skip', type: 'button', 'aria-pressed': conflict === 'skip' ? 'true' : 'false', onClick: function () { setConflict('skip') } }, t('mcp.importJson.conflict.skip')),
              h('button', { key: 'ov', type: 'button', 'aria-pressed': conflict === 'overwrite' ? 'true' : 'false', onClick: function () { setConflict('overwrite') } }, t('mcp.importJson.conflict.overwrite')))) : null,
          rows.some(function (r) { return r.secretCount > 0 }) ? h(Notice, { kind: 'warn', text: t('mcp.importJson.secretHint') }) : null,
          preview,
          result ? h('div', { className: 'dsm-feedback' + (result.ok ? (result.warning ? ' dsm-warning' : '') : ' dsm-error'), role: 'status' },
            h('div', null, result.text),
            result.skipped && result.skipped.length ? h('div', { className: 'dsm-imp-note' }, t('mcp.importJson.skipped', { items: result.skipped.map(function (s) { return s.id + '：' + s.reason }).join('；') })) : null,
            result.warning ? h('div', { className: 'dsm-imp-note' }, result.warning) : null) : null),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn', disabled: busy || !chosen.length, onClick: submit }, busy ? t('mcp.importJson.busy') : t('mcp.importJson.submit', { count: chosen.length }))))
    }

    function McpJsonExportModal(props) {
      var t = props.t
      var ls = react.useState(true); var loading = ls[0], setLoading = ls[1]
      var es = react.useState(null); var err = es[0], setError = es[1]
      var js = react.useState(''); var json = js[0], setJson = js[1]
      var ss = react.useState(null); var savedTo = ss[0], setSavedTo = ss[1]
      var cs = react.useState(false); var copied = cs[0], setCopied = cs[1]
      // 导出目录（用户 2026-10-12：「mcp 的导出缺少选择导出目录」）：此前这一档只能落到
      // `~/.dsh/tool-management/mcp-export.json`，界面没有任何可改的出口。初值取共享的
      // defaultIoDir()（20 片），与其余四个导出弹窗同一个默认目录。
      var ds = react.useState(defaultIoDir()); var dir = ds[0], setDir = ds[1]
      var bs = react.useState(false); var busy = bs[0], setBusy = bs[1]
      var ps = react.useState(false); var picking = ps[0], setPicking = ps[1]
      // 打开时**只取 JSON 做预览**（dryRun），不落盘 —— 落盘由用户点「导出到目录」触发。
      // 不开弹窗就写文件是副作用，其余四个导出弹窗都是"点了才写"。
      react.useEffect(function () {
        var alive = true
        apiCall('mcpm-export', { dryRun: true }).then(function (res) {
          if (!alive) return
          if (res && res.ok) { setJson(res.json || ''); setSavedTo(null) }
          else setError((res && res.error) || t('mcp.exportJson.failed'))
        }).catch(function (e) { if (alive) setError(errMsg(e)) }).then(function () { if (alive) setLoading(false) })
        return function () { alive = false }
      }, [])
      function doExport() {
        var target = String(dir || '').trim()
        if (!target) return
        setBusy(true); setError(null)
        apiCall('mcpm-export', { outDir: target }).then(function (res) {
          setBusy(false)
          if (!res || !res.ok) { setError((res && res.error) || t('mcp.exportJson.failed')); return }
          setJson(res.json || '')
          // 服务端写失败是 non-fatal（不抛），此时 savedTo 为 null —— 要如实说出来，
          // 否则界面会显示"已导出到 …"，而磁盘上什么都没有。
          if (res.savedTo) setSavedTo(res.savedTo)
          else setError(t('mcp.exportJson.writeFailed'))
        }).catch(function (e) { setBusy(false); setError(errMsg(e)) })
      }
      function copy() {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(json).then(function () {
              setCopied(true)
              setTimeout(function () { setCopied(false) }, 1500)
            })
          }
        } catch (e) { /* 剪贴板不可用就算了：下面的文本仍可手动选中复制 */ }
      }
      return h(Modal, { className: 'dsm-modal-lg', title: t('mcp.exportJson.title'), closeLabel: t('btn.close'), onClose: props.onClose },
        h('div', { className: 'dsm-form' },
          h(Notice, { kind: 'warn', text: t('mcp.exportJson.warn') }),
          h('div', { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, t('export.outDir')),
            h('div', { className: 'dsm-dir-row' },
              h('input', { className: 'dsm-control', value: dir, placeholder: defaultIoDir(), disabled: busy, onChange: function (e) { setDir(e.target.value) } }),
              h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { requestHostDirectory(setDir, function () { setPicking(true) }) } }, t('btn.openDir')))),
          loading ? h('div', { className: 'dsm-empty' }, t('mcp.exportJson.loading')) : null,
          err ? h('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, err) : null,
          !loading && json ? h(react.Fragment, null,
            h('pre', { className: 'dsm-code' }, json),
            savedTo ? h('div', { className: 'dsm-help' }, t('mcp.exportJson.savedTo', { path: savedTo })) : null,
          ) : null),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: loading || busy || !json || !String(dir || '').trim(), onClick: doExport }, busy ? t('mcp.exportJson.exporting') : t('mcp.exportJson.exportBtn')),
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: loading || !!err || !json, onClick: copy }, copied ? t('mcp.exportJson.copied') : t('mcp.exportJson.copy'))),
        picking ? h(DirPickerModal, { key: 'mcp-export-dir', title: t('export.pickDir'), initial: String(dir || ''), closeLabel: t('btn.close'), onClose: function () { setPicking(false) }, onPick: function (p) { setDir(p); setPicking(false) } }) : null)
    }
