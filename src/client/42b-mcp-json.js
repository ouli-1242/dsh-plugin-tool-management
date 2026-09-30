    // ---------- MCP JSON 导入 / 导出（0.15.0 A1）------------------------------------
    // 服务端 `mcpm-import` / `mcpm-export` 早就实现完整，缺的只是界面与**格式转换**：
    // 社区流通的块是 `{"mcpServers": {...}}`，而服务端只认数组或 `{rows:[...]}`，
    // 且 `transport` 只要不是字面 `'stdio'` 就一律落 streamable-http、`serverName` 不合规矩
    // 就整条丢弃。这些判定必须在提交前做完并让用户看见，否则导入完只剩一串跳过原因。

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
     * 粘贴的任意 MCP JSON → `{ok, rows}` 或 `{ok:false, code}`。
     * 识别顺序：`{mcpServers:{…}}` → `{rows:[…]}` → 裸数组 → 裸映射。
     */
    function convertMcpJsonToRows(text) {
      var parsed
      try { parsed = JSON.parse(String(text == null ? '' : text).trim()) } catch (e) { return { ok: false, code: 'parse', error: errMsg(e) } }
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

    function McpJsonImportModal(props) {
      var t = props.t
      var ts = react.useState(''); var text = ts[0], setText = ts[1]
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
            converted.code === 'parse' ? t('mcp.importJson.parseError', { error: converted.error }) : t('mcp.importJson.parseError.shape'))
        : !rows.length ? h('div', { className: 'dsm-empty' }, t('mcp.importJson.empty'))
        : h(react.Fragment, null,
            rows.length > 20 ? h('div', { className: 'dsm-help' }, t('mcp.importJson.bigBatch', { count: rows.length })) : null,
            h('div', { className: 'dsm-imp-head' },
              h('span', null, ''),
              h('span', null, t('mcp.importJson.preview.name')),
              h('span', null, t('mcp.importJson.preview.state'))),
            h('div', { className: 'dsm-imp-list' }, rows.map(function (r) {
              var cf = conflictOf(r)
              var endpoint = r.transport === 'stdio' ? [r.command].concat(r.args).join(' ') : r.url
              return h('div', { key: r.key, className: 'dsm-imp-row' + (r.fatal ? ' dsm-imp-bad' : '') },
                h('input', { type: 'checkbox', checked: !r.fatal && off[r.key] !== true, disabled: !!r.fatal, onChange: function () { toggle(r.key) } }),
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
            h('div', { className: 'dsm-imp-foot' },
              h('label', { className: 'dsm-imp-radio' },
                h('input', { type: 'radio', name: 'dsm-imp-conflict', checked: conflict === 'skip', onChange: function () { setConflict('skip') } }),
                t('mcp.importJson.conflict.skip')),
              h('label', { className: 'dsm-imp-radio' },
                h('input', { type: 'radio', name: 'dsm-imp-conflict', checked: conflict === 'overwrite', onChange: function () { setConflict('overwrite') } }),
                t('mcp.importJson.conflict.overwrite')),
              h('span', { className: 'dsm-imp-count' }, t('mcp.importJson.chosen', { count: chosen.length }))))

      return h(Modal, { className: 'dsm-modal-lg', title: t('mcp.importJson.title'), closeLabel: t('btn.close'), onClose: props.onClose },
        h('div', { className: 'dsm-form' },
          h('p', { className: 'dsm-desc' }, t('mcp.importJson.hint')),
          h('textarea', {
            className: 'dsm-control dsm-textarea-md', rows: 8, value: text, spellCheck: false,
            placeholder: t('mcp.importJson.placeholder'), onChange: function (e) { setText(e.target.value) },
          }),
          h('div', { className: 'dsm-upload-choices' },
            h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { if (fileRef.current) fileRef.current.click() } }, t('btn.file.pick')),
            h('span', { className: 'dsm-upload-divider' }, t('mcp.importJson.orPaste')),
            h('input', { ref: fileRef, type: 'file', accept: '.json', className: 'dsm-hidden-input', onChange: function (e) { onPickFile(e.target.files); e.target.value = '' } })),
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
      // 每次开弹窗现取：列表可能刚被改过，导出的是「此刻的配置」。
      react.useEffect(function () {
        var alive = true
        apiCall('mcpm-export', {}).then(function (res) {
          if (!alive) return
          if (res && res.ok) { setJson(res.json || ''); setSavedTo(res.savedTo || null) }
          else setError((res && res.error) || t('mcp.exportJson.failed'))
        }).catch(function (e) { if (alive) setError(errMsg(e)) }).then(function () { if (alive) setLoading(false) })
        return function () { alive = false }
      }, [])
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
          loading ? h('div', { className: 'dsm-empty' }, t('mcp.exportJson.loading')) : null,
          err ? h('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, err) : null,
          !loading && !err ? h(react.Fragment, null,
            h('pre', { className: 'dsm-code' }, json),
            h('div', { className: 'dsm-help' }, savedTo ? t('mcp.exportJson.savedTo', { path: savedTo }) : t('mcp.exportJson.savedTo.none')),
          ) : null),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: loading || !!err || !json, onClick: copy }, copied ? t('mcp.exportJson.copied') : t('mcp.exportJson.copy'))))
    }
