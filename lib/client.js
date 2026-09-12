// dsh-plugin-tool-management — durable client half (web bundle, ModuleLoader CJS format).
// Registers the "MCP 管理" settings page. Talks to the host half through the
// exact-path HTTP route /dsh-plugin-tool-management/api (same origin) instead of the
// dynamic-only host.call channel.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tool-management',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS =
      '.dsm-summary.dsm-summary-4{grid-template-columns:repeat(4,minmax(0,1fr))}' +
      '@media(max-width:760px){.dsm-summary.dsm-summary-4{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
      '@container(max-width:520px){.dsm-summary.dsm-summary-4{grid-template-columns:1fr}}' +
      '.dsm-version{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;letter-spacing:.3px}' +
      '.dsm-failed{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:nowrap}' +
      '.dsm-row-hint{grid-column:1/-1;margin:-4px 0 9px;color:#d49245;font-size:11px;line-height:16px}' +
      '.dsm-tools{display:flex;flex-direction:column;gap:8px}' +
      '.dsm-tool{padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}' +
      '.dsm-tool-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;font-weight:600;word-break:break-all}' +
      '.dsm-tool-name-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.dsm-tool-off .dsm-tool-name,.dsm-tool-off .dsm-tool-desc{opacity:.45}' +
      '.dsm-tool-desc{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}' +
      '.dsm-tool-params{display:flex;flex-direction:column;gap:3px;margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l2)}' +
      '.dsm-tool-param{display:flex;gap:8px;font-size:11px;align-items:baseline}' +
      '.dsm-tool-param-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;min-width:80px;word-break:break-all}' +
      '.dsm-tool-param-type{color:var(--dsw-alias-label-tertiary);min-width:56px}' +
      '.dsm-tool-param-desc{flex:1;color:var(--dsw-alias-label-secondary);word-break:break-all}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-sm{min-height:88px}' +
      '.dsm-detail-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.dsm-note-user{color:var(--dsw-alias-label-tertiary)}' +
      `
.dsm-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:2px 0 36px;container-type:inline-size;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:inherit}.dsm-head{display:flex;flex-direction:column;align-items:stretch;gap:16px}.dsm-title-block{min-width:0}.dsm-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}.dsm-feedback-links{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.dsm-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap}.dsm-feedback-link{display:inline-flex;min-height:28px;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;text-decoration:none;white-space:nowrap}.dsm-feedback-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsm-feedback-link:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-feedback-link svg{flex:none}.dsm-desc{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}.dsm-actions{display:flex;flex-wrap:wrap;gap:8px;margin-left:0;flex:none}
.dsm-btn{box-sizing:border-box;display:inline-flex;min-height:34px;align-items:center;justify-content:center;padding:0 13px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:580;white-space:nowrap;cursor:pointer}.dsm-btn:hover:not(:disabled){filter:brightness(1.08)}.dsm-btn:disabled{opacity:.48;cursor:default}.dsm-btn-secondary,.dsm-btn-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.dsm-btn-quiet{min-height:28px;padding:0 9px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}.dsm-btn:focus-visible,.dsm-control:focus-visible,.dsm-select-trigger:focus-visible,.dsm-source-head:focus-visible,.dsm-switch:focus-visible,.dsm-upload-link:focus-visible,.dsm-file-remove:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
.dsm-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-secondary)}.dsm-stat:last-child{border-right:0}.dsm-stat strong{margin-right:5px;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680}.dsm-filters{display:flex;gap:9px}.dsm-search{flex:1}.dsm-source-filter{width:210px;flex:none}
.dsm-control,.dsm-select-trigger{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm-control::placeholder{color:var(--dsw-alias-label-tertiary)}textarea.dsm-control{min-height:160px;padding-top:9px;resize:vertical;line-height:20px}.dsm-select{position:relative}.dsm-select-trigger{display:flex;align-items:center;justify-content:space-between;text-align:left;cursor:pointer}.dsm-select-menu{position:absolute;z-index:40;top:calc(100% + 5px);right:0;left:0;display:flex;max-height:260px;padding:5px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2)}.dsm-option{padding:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.dsm-option:hover,.dsm-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sources{display:flex;flex-direction:column;gap:9px}.dsm-source{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-source-head{box-sizing:border-box;display:flex;width:100%;min-height:48px;align-items:center;padding:0 13px}.dsm-source-head-main{display:flex;min-width:0;min-height:48px;flex:1;align-items:center;gap:10px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsm-source-head:hover,.dsm-row:hover,.dsm-trash-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-source-title{font-size:14px;font-weight:650}.dsm-count{color:var(--dsw-alias-label-tertiary);font-size:12px}.dsm-path{min-width:0;margin-left:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm-source-actions{display:flex;align-items:center;gap:9px;margin-left:8px}.dsm-source-body{border-top:1px solid var(--dsw-alias-border-l1)}.dsm-source-note{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dsm-table-head,.dsm-row{display:grid;grid-template-columns:minmax(180px,1fr) 120px 90px max-content;align-items:center;column-gap:12px;padding:0 13px}.dsm-table-head{min-height:32px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-row{min-height:58px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-row:last-child{border-bottom:0}.dsm-main{min-width:0}.dsm-name{overflow:hidden;font-size:13px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.dsm-note{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.dsm-tag{display:inline-flex;min-height:19px;align-items:center;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}.dsm-tag-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.dsm-tag-off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.dsm-enabled{color:var(--dsw-alias-state-success-primary);font-size:12px;white-space:nowrap}.dsm-disabled{color:#d49245;font-size:12px;white-space:nowrap}.dsm-shadowed{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}.dsm-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}
.dsm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}.dsm-switch:after{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;content:"";transition:transform 160ms ease}.dsm-switch-on{background:var(--dsw-alias-state-success-primary)}.dsm-switch-on:after{transform:translateX(14px)}.dsm-switch:disabled{opacity:.45;cursor:default}.dsm-trash-row{display:flex;min-height:48px;align-items:center;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsm-trash-count{margin-left:auto;padding:2px 7px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}.dsm-empty{padding:25px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsm-feedback{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-warning{border-color:#d49245;color:#d49245}.dsm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.dsm-modal{box-sizing:border-box;display:flex;width:min(560px,100%)!important;max-height:min(760px,calc(100vh - 48px));min-width:0;flex-direction:column;gap:16px;padding:22px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.dsm-modal-wide{width:min(720px,100%)!important}.dsm-modal-import{width:min(480px,100%)!important;padding:24px}.dsm-modal-head{display:flex;align-items:flex-start;gap:12px}.dsm-modal-title{margin:0;flex:1;font-size:17px;line-height:24px;font-weight:670}.dsm-form,.dsm-field,.dsm-detail-section{display:flex;flex-direction:column}.dsm-form{gap:12px}.dsm-field{gap:6px}.dsm-label,.dsm-detail-title{font-size:12px}.dsm-label{color:var(--dsw-alias-label-secondary)}.dsm-detail-title{font-weight:650}.dsm-help{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.dsm-hidden-input{display:none}.dsm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color 180ms ease,background 180ms ease}.dsm-dropzone:hover,.dsm-dropzone-active{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsm-dropzone-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:620}.dsm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dsm-upload-choices{display:flex;align-items:center;gap:7px}.dsm-upload-link,.dsm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsm-upload-link{color:var(--dsw-alias-label-secondary)}.dsm-upload-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.dsm-upload-link:disabled{opacity:.45;cursor:default}.dsm-upload-divider{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-file{display:flex;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}.dsm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700}.dsm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dsm-file-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.dsm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary);font-size:18px}.dsm-upload-requirements{padding:1px 1px 0}.dsm-upload-requirements ul{display:flex;margin:7px 0 0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-detail-section{gap:7px}.dsm-detail-path,.dsm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-detail-path{padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-all}.dsm-code{max-height:280px;margin:0;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:pre-wrap}.dsm-diag{padding:8px 10px;border-left:2px solid #d49245;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-trash-item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-trash-item:last-child{border-bottom:0}.dsm-trash-main{min-width:0;flex:1}
.dsm-fm{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-fm-row{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr);gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}.dsm-fm-row:last-child{border-bottom:0}.dsm-fm-key{color:var(--dsw-alias-label-secondary);word-break:break-word}.dsm-fm-raw{margin-left:5px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}.dsm-fm-val{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap}
@container(max-width:780px){.dsm-table-head{display:none}.dsm-row{grid-template-columns:minmax(0,1fr) max-content;gap:8px;padding:11px 13px}.dsm-row>.dsm-tags,.dsm-row>.dsm-status{grid-column:1}.dsm-row-actions{grid-column:2;grid-row:1 / span 3}.dsm-path{display:none}}@media(max-width:760px){.dsm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.dsm-title-row{flex-wrap:wrap}}@container(max-width:520px){.dsm-head{flex-direction:column}.dsm-actions{width:100%;margin-left:0}.dsm-actions .dsm-btn{flex:1}.dsm-filters{flex-direction:column}.dsm-source-filter{width:100%}.dsm-summary{grid-template-columns:1fr}}
`

    function ensureCss() {
      if (typeof document === 'undefined') return
      const id = 'dsh-plugin-tool-management'
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = id
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // Optional access token for write ops (host config.token or
    // DSH_SKILL_MCP_MANAGER_TOKEN). Read once from localStorage — there is no
    // UI row for it — and sent as `x-dsh-token` on every request (the host
    // ignores it when unset).
    let TOKEN = ''
    try {
      // 读取新键；旧版（dsh-skill-mcp-manager-token）数据一次性迁移到新键。
      TOKEN = window.localStorage.getItem('dsh-plugin-tool-management-token')
        || window.localStorage.getItem('dsh-skill-mcp-manager-token') || ''
      if (TOKEN && !window.localStorage.getItem('dsh-plugin-tool-management-token')) {
        window.localStorage.setItem('dsh-plugin-tool-management-token', TOKEN)
      }
    } catch (e) { /* storage unavailable */ }

    function apiCall(op, args) {
      // `x-dsh-plugin` is the cross-site (CSRF) gate header the host half
      // requires on every request; a cross-origin page cannot attach it
      // without a CORS preflight that this route never answers.
      const headers = { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management' }
      if (TOKEN) headers['x-dsh-token'] = TOKEN
      return fetch('/dsh-plugin-tool-management/api', {
        method: 'POST',
        headers,
        body: JSON.stringify({ op, args: args || {} }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    }

    // Small version badge shown next to each settings-page title; reads the
    // package version from the host (plugin-version op) so it always matches
    // the installed release.
    function VersionBadge() {
      const [v, setV] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        apiCall('plugin-version', {}).then((r) => { if (alive && r && r.ok) setV(r.version) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return v ? React.createElement('span', { className: 'dsm-version' }, 'v' + v) : null
    }

    module.exports = {
      name: 'dsh-plugin-tool-management-client',
      inject: ['timer'],
      apply(ctx) {
        ensureCss()
        const slots = ctx.get('slots')
        if (slots === undefined) return

        const LEVEL_LABEL = { project: 'Profile 级', global: '全局', loader: '已加载' }
        const emptyForm = () => ({ serverName: '', transport: 'streamable-http', url: '', command: '', args: '', headers: '', env: '', level: 'project' })
        const kvToLines = (obj) => (obj ? Object.keys(obj).map((k) => k + '=' + obj[k]).join('\n') : '')
        const MCP_LEVEL_OPTIONS = [
          { value: '', label: '全部级别' },
          { value: 'project', label: 'Profile 级' },
          { value: 'global', label: '全局' },
          { value: 'loader', label: '已加载' },
        ]
        const MCP_TRANSPORT_OPTIONS = [
          { value: 'streamable-http', label: 'streamable-http' },
          { value: 'stdio', label: 'stdio' },
        ]
        const maskSecret = (value) => {
          const s = String(value == null ? '' : value)
          return s.length <= 4 ? '****' : s.slice(0, 4) + '****'
        }

        // 项目与问题反馈链接：MCP / Skills 两个设置页共用同一组地址。
        // 注意：引用了本作用域的 GithubMark16 / primitives，必须定义在 apply 里。
        function FeedbackLinks() {
          return React.createElement('div', { className: 'dsm-feedback-links' },
            React.createElement('a', { className: 'dsm-feedback-link', href: 'https://github.com/ouli-1242/dsh-plugin-tool-management', target: '_blank', rel: 'noreferrer', 'aria-label': 'GitHub' },
              React.createElement(GithubMark16, null), 'GitHub'),
            React.createElement('a', { className: 'dsm-feedback-link', href: 'https://github.com/ouli-1242/dsh-plugin-tool-management/issues', target: '_blank', rel: 'noreferrer', 'aria-label': '问题反馈' },
              React.createElement(primitives.IconListPenOutline16, null), '问题反馈'))
        }

        // MCP 服务页：与 Skills 页共用 dsm-* 设计语言（统计卡 / 筛选 / 分组卡片 / 模态框）。
        function MCPPage() {
          const [state, setState] = React.useState({ loading: true, error: null, rows: [], paths: null, errors: [], warnings: [] })
          const [msg, setMsg] = React.useState(null)
          const [busy, setBusy] = React.useState(null)
          const [query, setQuery] = React.useState('')
          const [levelFilter, setLevelFilter] = React.useState('')
          const [collapsed, setCollapsed] = React.useState({})
          const [formModal, setFormModal] = React.useState(null)
          const [detail, setDetail] = React.useState(null)
          const [confirmRow, setConfirmRow] = React.useState(null)
          const [restartInfo, setRestartInfo] = React.useState(null)
          const [reveal, setReveal] = React.useState(false)
          const [settings, setSettings] = React.useState(null)
          const [noteDraft, setNoteDraft] = React.useState('')
          const [, setTick] = React.useState(0)

          const refresh = (withReveal, onRows) => {
            const useReveal = withReveal === undefined ? reveal : withReveal === true
            // 明文视图走独立的 mcpm-reveal op（host 端受 token 保护），
            // mcpm-list 始终脱敏，无 token 也能渲染页面。
            apiCall(useReveal ? 'mcpm-reveal' : 'mcpm-list', {}).then((res) => {
              const rows = (res && res.rows) || []
              setState({
                loading: false,
                error: res && res.ok ? null : ((res && res.error) || '加载失败'),
                rows,
                paths: (res && res.paths) || null,
                errors: (res && res.errors) || [],
                warnings: (res && res.warnings) || [],
              })
              if (onRows) onRows(rows)
            }).catch((e) => setState({ loading: false, error: String((e && e.message) || e), rows: [], paths: null, errors: [], warnings: [] }))
          }
          // The polling tick must always call the newest refresh closure, while
          // the interval itself only changes when the saved settings change.
          const refreshRef = React.useRef(refresh)
          refreshRef.current = refresh

          React.useEffect(() => { refresh(false) }, [])
          React.useEffect(() => {
            apiCall('mcpm-settings', {}).then((res) => {
              if (res && res.ok && res.settings) setSettings(res.settings)
            }).catch(() => {})
          }, [])
          React.useEffect(() => ctx.interval(() => setTick((t) => t + 1), 1000), [])
          React.useEffect(() => {
            const ms = (settings && settings.pollIntervalMs) || 5000
            return ctx.interval(() => refreshRef.current(), ms)
          }, [settings])
          React.useEffect(() => {
            if (!msg) return undefined
            return ctx.timeout(() => setMsg(null), 4000)
          }, [msg])

          const run = (method, args, label, onOk) => {
            setMsg(null)
            setBusy(label)
            apiCall(method, args).then((res) => {
              if (res && res.ok) {
                setMsg(res.warning ? { kind: 'warn', text: '操作完成，但加载器有提示：' + res.warning } : { kind: 'ok', text: '操作成功' })
                refresh()
                if (onOk) onOk()
              } else setMsg({ kind: 'err', text: (res && res.error) || '操作失败' })
            }).catch((e) => setMsg({ kind: 'err', text: String((e && e.message) || e) })).then(() => { setBusy(null); setRestartInfo(null) })
          }

          const openAdd = () => setFormModal(Object.assign({ mode: 'add', id: null }, emptyForm()))
          const openEdit = (row) => setFormModal({
            mode: 'edit',
            id: row.id,
            serverName: row.serverName || '',
            transport: row.transport === 'stdio' ? 'stdio' : 'streamable-http',
            url: row.url || '',
            command: row.command || '',
            args: (row.args || []).join('\n'),
            headers: kvToLines(row.headers),
            env: kvToLines(row.env),
            level: row.level === 'global' ? 'global' : 'project',
          })
          const closeForm = () => setFormModal(null)
          const setFormField = (key) => (ev) => setFormModal(Object.assign({}, formModal, { [key]: ev.target.value }))
          const setFormValue = (key, value) => setFormModal(Object.assign({}, formModal, { [key]: value }))
          const submitForm = () => {
            const payload = Object.assign({}, formModal)
            if (payload.transport === 'stdio') { payload.url = ''; payload.headers = '' }
            else { payload.command = ''; payload.args = ''; payload.env = '' }
            const args = {
              serverName: payload.serverName,
              transport: payload.transport,
              level: payload.level,
              url: payload.url,
              command: payload.command,
              args: payload.args,
              headers: payload.headers,
              env: payload.env,
            }
            if (payload.mode === 'edit') args.id = payload.id
            run(payload.mode === 'edit' ? 'mcpm-edit' : 'mcpm-add', args, 'form', closeForm)
          }

          // Toggling updates only the clicked row (scroll position and expanded
          // groups survive); a failed write re-reads the server state instead.
          const toggleRow = (row) => {
            const nextDisabled = !row.disabled
            setMsg(null)
            setState((prev) => Object.assign({}, prev, {
              rows: (prev.rows || []).map((item) => (
                item.id === row.id && item.level === row.level
                  ? Object.assign({}, item, { disabled: nextDisabled })
                  : item
              )),
            }))
            setBusy(row.id + ':toggle')
            apiCall('mcpm-set-enabled', { id: row.id, level: row.level, enabled: row.disabled }).then((res) => {
              if (res && !res.ok) {
                setMsg({ kind: 'err', text: (res && res.error) || '操作失败' })
                refresh()
              } else if (res && res.warning) {
                setMsg({ kind: 'warn', text: '操作完成，但加载器有提示：' + res.warning })
              }
            }).catch((e) => {
              setMsg({ kind: 'err', text: String((e && e.message) || e) })
              refresh()
            }).then(() => setBusy(null))
          }
          const toggleReveal = () => {
            const next = !reveal
            setReveal(next)
            // Re-read the list and feed the fresh row back into the open dialog,
            // so the masking actually flips where the user is looking.
            refresh(next, (rows) => {
              if (!detail) return
              const fresh = rows.find((item) => item.id === detail.row.id && item.level === detail.row.level)
              if (fresh) setDetail(Object.assign({}, detail, { row: fresh }))
            })
          }
          const saveNote = () => {
            const row = detail && detail.row
            if (!row) return
            run('mcpm-note', { id: row.id, note: noteDraft }, 'note', () => {
              setDetail(Object.assign({}, detail, { row: Object.assign({}, row, { notes: noteDraft.trim() }) }))
            })
          }
          const restartRow = (row) => {
            setTick(0)
            setRestartInfo({ id: row.id, name: row.serverName, startedAt: Date.now() })
            run('mcpm-restart', { id: row.id, level: row.level }, row.id + ':restart')
          }
          const confirmRemove = () => {
            const row = confirmRow
            setConfirmRow(null)
            if (row) run('mcpm-remove', { id: row.id, level: row.level }, row.id + ':remove')
          }
          const openDetail = (row) => {
            setNoteDraft(row.notes || '')
            setDetail({ row, loading: true, error: null, tools: [] })
            apiCall('mcpm-tools', { serverName: row.serverName }).then((res) => {
              if (res && res.ok) setDetail({ row, loading: false, error: null, tools: res.tools || [] })
              else setDetail({ row, loading: false, error: (res && res.error) || '加载工具失败', tools: [] })
            }).catch((e) => setDetail({ row, loading: false, error: String((e && e.message) || e), tools: [] }))
          }

          const toggleTool = (row, tool) => {
            const nextEnabled = tool.enabled === false
            setMsg(null)
            setBusy('tool:' + tool.name)
            apiCall('mcpm-tool-enabled', { serverName: row.serverName, tool: tool.name, enabled: nextEnabled }).then((res) => {
              if (res && res.ok) {
                setDetail(Object.assign({}, detail, { tools: (detail.tools || []).map((item) => (item.name === tool.name ? Object.assign({}, item, { enabled: nextEnabled }) : item)) }))
                setMsg({ kind: 'ok', text: '已' + (nextEnabled ? '启用' : '停用') + '工具：' + tool.name })
              } else setMsg({ kind: 'err', text: (res && res.error) || '操作失败' })
            }).catch((e) => setMsg({ kind: 'err', text: String((e && e.message) || e) })).then(() => setBusy(null))
          }

          const rows = state.rows || []
          const normalizedQuery = query.trim().toLowerCase()
          // 「已加载」= 当前真正在运行的条目（loader 已启用且 active）。
          const isRunning = (row) => !!(row.live && row.live.enabled && row.live.phase === 'active')
          const matchesRow = (row) => {
            if (levelFilter === 'loader') { if (!isRunning(row)) return false }
            else if (levelFilter && row.level !== levelFilter) return false
            if (!normalizedQuery) return true
            return [row.serverName, row.id, row.url, row.command, row.transport].some((value) => String(value == null ? '' : value).toLowerCase().indexOf(normalizedQuery) >= 0)
          }
          const visibleRows = rows.filter(matchesRow)
          const summary = {
            total: rows.length,
            enabled: rows.filter((row) => !row.disabled).length,
            running: rows.filter((row) => row.live && row.live.enabled && row.live.phase === 'active').length,
            tools: rows.reduce((sum, row) => sum + (typeof row.toolCount === 'number' ? row.toolCount : 0), 0),
          }
          const profilePath = state.paths && state.paths.profile ? 'profile: ' + state.paths.profile : null
          const groups = levelFilter === 'loader'
            ? [{ key: 'live', title: '已加载', path: profilePath, match: isRunning }]
            : [
                { key: 'project', title: 'Profile 级', path: state.paths ? state.paths.project : null, match: (row) => row.level === 'project' },
                { key: 'global', title: '全局', path: state.paths ? state.paths.global : null, match: (row) => row.level === 'global' },
                { key: 'loader', title: '已加载', path: profilePath, match: (row) => row.level === 'loader' && isRunning(row) },
              ]

          const liveStatus = (row) => {
            if (!row.live) return { text: '未加载', cls: 'dsm-shadowed' }
            if (row.live.phase === 'failed') return { text: '启动失败', cls: 'dsm-failed' }
            if (!row.live.enabled) return { text: '未运行', cls: 'dsm-shadowed' }
            if (row.live.phase && row.live.phase !== 'active') return { text: '加载中', cls: 'dsm-shadowed' }
            if (typeof row.toolCount === 'number' && row.toolCount === 0) return { text: '无工具', cls: 'dsm-disabled' }
            return { text: '运行中', cls: 'dsm-enabled' }
          }
          const liveHint = (row) => {
            if (!row.live) return null
            if (row.live.phase === 'failed') return 'loader 启动失败：请检查 URL / 命令 / 凭证 / 网络，然后点「重启」重试'
            if (row.live.phase === 'active' && typeof row.toolCount === 'number' && row.toolCount === 0) return '已连接但未注册任何工具：服务端可能未就绪或工具列表为空'
            return null
          }

          const renderRow = (row) => {
            const status = liveStatus(row)
            const hint = liveHint(row)
            const editable = row.level !== 'loader'
            return React.createElement('div', { key: row.id, className: 'dsm-row' },
              React.createElement('div', { className: 'dsm-main' },
                React.createElement('div', { className: 'dsm-name' }, row.serverName),
                row.notes ? React.createElement('div', { className: 'dsm-note dsm-note-user', title: row.notes }, '备注：' + row.notes) : null),
              React.createElement('div', { className: 'dsm-tags' },
                (levelFilter === 'loader' && row.level && row.level !== 'loader') ? React.createElement('span', { className: 'dsm-tag' }, LEVEL_LABEL[row.level] || row.level) : null,
                (typeof row.toolCount === 'number' && row.toolCount > 0) ? React.createElement('span', { className: 'dsm-tag' }, row.toolCount + ' 个工具') : null,
                row.duplicate ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, '重复 id') : null),
              React.createElement('div', { className: 'dsm-status ' + status.cls }, status.text),
              React.createElement('div', { className: 'dsm-row-actions' },
                editable ? React.createElement(Switch, { on: !row.disabled, disabled: busy !== null, label: '启停服务 ' + row.serverName, onClick: () => toggleRow(row) }) : null,
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: () => openDetail(row) }, '详情'),
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: () => openEdit(row) }, '编辑') : null,
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: () => restartRow(row) }, '重启') : null,
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null, onClick: () => setConfirmRow(row) }, '删除') : null),
              hint ? React.createElement('div', { className: 'dsm-row-hint' }, '⚠ ' + hint) : null)
          }

          const renderGroup = (group) => {
            const groupRows = visibleRows.filter(group.match)
            if (groupRows.length === 0) return null
            const open = collapsed[group.key] !== true || !!normalizedQuery
            return React.createElement('section', { key: group.key, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: () => setCollapsed(Object.assign({}, collapsed, { [group.key]: !open })) },
                  React.createElement('span', { className: 'dsm-source-title' }, group.title),
                  React.createElement('span', { className: 'dsm-count' }, groupRows.length + ' 个服务'),
                  group.path ? React.createElement('span', { className: 'dsm-path', title: group.path }, group.path) : null)),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                React.createElement(React.Fragment, null,
                  React.createElement('div', { className: 'dsm-table-head' },
                    React.createElement('span', null, '服务名称与地址'),
                    React.createElement('span', null, '传输与工具'),
                    React.createElement('span', null, '运行状态'),
                    React.createElement('span', null, '')),
                  groupRows.map(renderRow))) : null)
          }

          const configRow = (label, value) => React.createElement('div', { className: 'dsm-fm-row', key: label },
            React.createElement('div', { className: 'dsm-fm-key' }, label),
            React.createElement('div', { className: 'dsm-fm-val' }, value))

          const toolListNode = detail && (detail.loading
            ? React.createElement('div', { className: 'dsm-help' }, '正在获取工具列表…')
            : detail.error
              ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, '加载工具失败：' + detail.error)
              : (detail.tools || []).length === 0
                ? React.createElement('div', { className: 'dsm-help' }, '该服务暂无已注册工具。')
                : React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-help' }, '停用的工具对模型不可见且不可调用，改动即时生效。'),
                    React.createElement('div', { className: 'dsm-tools' }, (detail.tools || []).map((tool) => React.createElement('div', { className: 'dsm-tool' + (tool.enabled === false ? ' dsm-tool-off' : ''), key: tool.name },
                      React.createElement('div', { className: 'dsm-tool-name-row' },
                        React.createElement('div', { className: 'dsm-tool-name' }, tool.name),
                        React.createElement(Switch, { on: tool.enabled !== false, disabled: busy !== null, label: '启停工具 ' + tool.name, onClick: () => toggleTool(detail.row, tool) })),
                      tool.description ? React.createElement('div', { className: 'dsm-tool-desc' }, tool.description) : null,
                      (tool.parameters && tool.parameters.length > 0) ? React.createElement('div', { className: 'dsm-tool-params' }, tool.parameters.map((param) => React.createElement('div', { className: 'dsm-tool-param', key: param.key },
                          React.createElement('span', { className: 'dsm-tool-param-key' }, param.key + (param.required ? ' *' : '')),
                          React.createElement('span', { className: 'dsm-tool-param-type' }, param.type || 'any'),
                          React.createElement('span', { className: 'dsm-tool-param-desc' }, param.description || '')))) : null)))))

          const anyGroupVisible = groups.some((group) => visibleRows.some(group.match))
          const groupsNode = (state.loading && rows.length === 0)
            ? React.createElement('div', { className: 'dsm-empty' }, '正在加载 MCP 服务…')
            : anyGroupVisible
              ? React.createElement('div', { className: 'dsm-sources' }, groups.map(renderGroup))
              : React.createElement('div', { className: 'dsm-empty' }, (normalizedQuery || levelFilter) ? '没有匹配的服务。' : '暂无 MCP 服务。点击「新增服务」添加。')

          const formModalNode = formModal && React.createElement(Modal, {
            key: 'mcp-form',
            title: formModal.mode === 'edit' ? '编辑 MCP 服务：' + formModal.id : '新增 MCP 服务',
            closeLabel: '关闭',
            onClose: closeForm,
          },
            React.createElement('div', { className: 'dsm-form' },
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, '服务名称 serverName'),
                React.createElement('input', { className: 'dsm-control', value: formModal.serverName, placeholder: 'e.g. github', onChange: setFormField('serverName') }),
                React.createElement('span', { className: 'dsm-help' }, '唯一标识，1-32 位 [A-Za-z0-9_-]；补丁中按该名称注册工具。')),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, '传输方式'),
                React.createElement(SourceSelect, { value: formModal.transport, options: MCP_TRANSPORT_OPTIONS, onChange: (value) => setFormValue('transport', value) })),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, '级别'),
                React.createElement(SourceSelect, {
                  value: formModal.level,
                  options: [
                    { value: 'project', label: 'Profile 级（本应用：' + (state.paths ? state.paths.project : 'profiles/*/cordis.patch.yml') + '）' },
                    { value: 'global', label: '全局（跨 Profile：' + (state.paths ? state.paths.global : '~/.dsh/cordis.patch.yml') + '）' },
                  ],
                  onChange: (value) => setFormValue('level', value),
                })),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, '服务 URL'),
                    React.createElement('input', { className: 'dsm-control', value: formModal.url, placeholder: 'https://host/mcp', onChange: setFormField('url') }),
                    React.createElement('span', { className: 'dsm-help' }, '需以 http(s):// 开头。'))
                : React.createElement(React.Fragment, null,
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, '启动命令'),
                      React.createElement('input', { className: 'dsm-control', value: formModal.command, placeholder: 'npx -y @modelcontextprotocol/server-github', onChange: setFormField('command') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, '参数（空格或换行分隔）'),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.args, placeholder: '-y\n@modelcontextprotocol/server-github', onChange: setFormField('args') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, '环境变量（每行 key=value）'),
                      React.createElement('span', { className: 'dsm-help' }, '路径按系统路径写法填（Windows 用 \\，macOS/Linux 用 /）。'),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.env, placeholder: 'GITHUB_TOKEN=xxx', onChange: setFormField('env') }))),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, '请求头（每行 key=value）'),
                    React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.headers, placeholder: 'Authorization=Bearer xxx', onChange: setFormField('headers') }))
                : null),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: closeForm }, '取消'),
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy === 'form' || !formModal.serverName.trim(), onClick: submitForm }, formModal.mode === 'edit' ? '保存' : '添加')))

          const detailStatus = detail ? liveStatus(detail.row) : null
          const detailHint = detail ? liveHint(detail.row) : null
          const detailNode = detail && React.createElement(Modal, {
            key: 'mcp-detail',
            wide: true,
            title: '服务详情：' + detail.row.serverName,
            closeLabel: '关闭',
            onClose: () => setDetail(null),
          },
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title dsm-detail-title-row' },
                '配置',
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: toggleReveal }, reveal ? '隐藏密钥' : '显示密钥')),
              React.createElement('div', { className: 'dsm-fm' },
                configRow('条目 ID', detail.row.id),
                configRow('级别', LEVEL_LABEL[detail.row.level] || detail.row.level),
                configRow('传输方式', detail.row.transport || '—'),
                detail.row.url ? configRow('服务 URL', detail.row.url) : null,
                detail.row.command ? configRow('启动命令', detail.row.command + ((detail.row.args && detail.row.args.length) ? ' ' + detail.row.args.join(' ') : '')) : null,
                (detail.row.headers && Object.keys(detail.row.headers).length > 0) ? configRow('请求头', Object.keys(detail.row.headers).map((k) => k + ': ' + maskSecret(detail.row.headers[k])).join('\n')) : null,
                (detail.row.env && Object.keys(detail.row.env).length > 0) ? configRow('环境变量', Object.keys(detail.row.env).map((k) => k + ' = ' + maskSecret(detail.row.env[k])).join('\n')) : null)),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, '运行状态'),
              React.createElement('div', { className: 'dsm-feedback' + (detailStatus.cls === 'dsm-failed' ? ' dsm-error' : detailStatus.cls === 'dsm-disabled' ? ' dsm-warning' : '') },
                detailStatus.text + '：' + (detailHint || '该服务已登记在 Loader 中。'))),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, '备注（仅本机可见，不会被配置更新覆盖）'),
              React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: noteDraft, placeholder: '例如：A 不可用时改用 B 兜底', onChange: (ev) => setNoteDraft(ev.target.value) }),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || noteDraft.trim() === String(detail.row.notes || ''), onClick: saveNote }, '保存备注'))),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, '工具（' + (detail.loading ? '…' : (detail.tools || []).length) + '）'),
              toolListNode))

          const confirmNode = confirmRow && React.createElement(Modal, {
            key: 'mcp-remove',
            title: '删除 MCP 服务',
            closeLabel: '关闭',
            onClose: () => setConfirmRow(null),
          },
            React.createElement('p', { className: 'dsm-desc' }, '确定要删除「' + confirmRow.serverName + '」吗？删除后该服务的配置将从补丁文件中移除，相关工具立即下线，此操作不可撤销。'),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: () => setConfirmRow(null) }, '取消'),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', onClick: confirmRemove }, '删除')))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, 'MCP'),
                  React.createElement(VersionBadge, null),
                  React.createElement(FeedbackLinks, null)),
                React.createElement('p', { className: 'dsm-desc' }, '统一管理本机的 MCP 服务与运行状态。')),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading, onClick: () => refresh() }, '刷新'),
                React.createElement('button', { type: 'button', className: 'dsm-btn', onClick: openAdd }, '新增服务'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading, onClick: () => run('mcpm-set-all', { enabled: true }, 'setall') }, '全部启用'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading, onClick: () => run('mcpm-set-all', { enabled: false }, 'setall') }, '全部停用'))),
            React.createElement('div', { className: 'dsm-summary dsm-summary-4' },
              [[summary.total, '个服务'], [summary.enabled, '个已启用'], [summary.running, '个运行中'], [summary.tools, '个工具']].map((item) =>
                React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1]))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', value: query, 'aria-label': '搜索服务', placeholder: '搜索服务名称、地址或命令', onChange: (ev) => setQuery(ev.target.value) }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { value: levelFilter, options: MCP_LEVEL_OPTIONS, onChange: setLevelFilter }))),
            restartInfo ? React.createElement('div', { className: 'dsm-feedback' }, '重启中… ' + restartInfo.name + '（已等待 ' + Math.max(0, Math.floor((Date.now() - restartInfo.startedAt) / 1000)) + ' 秒，完成后自动刷新）') : null,
            msg ? React.createElement('div', { className: 'dsm-feedback' + (msg.kind === 'err' ? ' dsm-error' : msg.kind === 'warn' ? ' dsm-warning' : ''), role: msg.kind === 'err' ? 'alert' : undefined }, msg.text) : null,
            state.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, state.error) : null,
            (state.errors && state.errors.length > 0) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'alert' }, '读取补丁告警：' + state.errors.join('；')) : null,
            (state.warnings && state.warnings.length > 0) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'alert' }, state.warnings.join('；')) : null,
            groupsNode,
            formModalNode,
            detailNode,
            confirmNode)
        }

        // 两个独立设置页：MCP 与 Skills，各自占一个侧栏项。
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsm-mcp', order: 16, label: 'MCP' },
          () => React.createElement(MCPPage)
        ))
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsm-skills', order: 17, label: 'Skills' },
          () => React.createElement(SkillManagerSection, { t: t })
        ))


        // ---------- Skills 页（移植自 dsh-skills-manager，Apache-2.0；类名前缀 dsm-） ----------
        var react = React // 上游组件使用小写 react，别名到本文件的 React
        // 上游 UI 依赖 @deepseek-ai/dsh-client-ui-primitives 的单个图标；
        // 这里用本地内联 SVG 替代，避免为客户端引入额外 peer 依赖。
        var primitives = { IconListPenOutline16: function () { return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' }, h('path', { fill: 'currentColor', d: 'M3 2h10v12H3zM5 5h6M5 8h6M5 11h4' })) } }
        var h = React.createElement

        // SKILL.md frontmatter 常见键 → 中文标签（未知键原样显示，已知键附原始键名提示）。
        var FRONTMATTER_LABELS = {
          name: '名称', description: '描述', 'when-to-use': '适用场景', 'user-invocable': '用户可调用',
          'disable-model-invocation': '禁止模型调用', 'allowed-tools': '允许的工具', license: '许可协议',
          version: '版本', author: '作者', category: '分类', tags: '标签', metadata: '附加信息', homepage: '主页',
        }
        function frontmatterValue(value) {
          if (Array.isArray(value)) return value.join('、')
          if (value === true) return '是'
          if (value === false) return '否'
          if (value === null || value === undefined) return ''
          if (typeof value === 'object') return JSON.stringify(value, null, 2)
          return String(value)
        }
        // 详情页把 frontmatter 渲染成中文键值表（原始 JSON 对使用者几乎不可读）。
        function renderFrontmatter(t, frontmatter) {
          var keys = frontmatter && typeof frontmatter === 'object' ? Object.keys(frontmatter) : []
          if (!keys.length) return h('div', { className: 'dsm-note' }, t('detail.noFrontmatter'))
          return h('div', { className: 'dsm-fm' }, keys.map(function (key) {
            var label = FRONTMATTER_LABELS[key] || key
            return h('div', { className: 'dsm-fm-row', key: key },
              h('div', { className: 'dsm-fm-key' }, label, label === key ? null : h('span', { className: 'dsm-fm-raw' }, key)),
              h('div', { className: 'dsm-fm-val' }, frontmatterValue(frontmatter[key])))
          }))
        }

        var DICT = {
      zh: {
        "title": "Skills", "desc": "统一加载和管理本机 Agent Skills。", "link.project": "GitHub", "link.feedback": "问题反馈",
        "btn.create": "创建技能", "btn.import": "导入", "btn.refresh": "刷新", "btn.cancel": "取消", "btn.close": "关闭", "btn.detail": "查看详情", "btn.trash": "移到回收站", "btn.restore": "恢复", "btn.delete.forever": "永久删除", "btn.file.pick": "选择文件", "btn.folder.pick": "选择文件夹", "btn.import.now": "安装", "btn.create.now": "创建技能", "btn.disable": "停用", "btn.enable": "启用", "btn.open.editor": "用系统编辑器打开",
        "btn.custom.add": "添加目录", "btn.custom.remove": "移除",
        "custom.add.title": "添加自定义技能目录", "custom.add.submit": "添加",
        "custom.add.path": "目录绝对路径", "custom.add.path.placeholder": "例如 D:\\skills\\my-skills 或 /home/me/skills",
        "custom.add.label": "显示名称（可选）", "custom.add.label.placeholder": "自定义目录",
        "custom.add.help": "以只读方式接入该目录：自动发现 SKILL.md 子目录与顶层 .md 单文件，可在来源卡片上启停整个目录或单个技能；与现有来源重叠的目录会被拒绝，目录与源文件都不会被修改。",
        "confirm.custom.remove.title": "移除自定义目录",
        "confirm.custom.remove.desc": "移除后该目录下的技能将不再出现在列表中（目录与技能文件本身不受影响，可随时重新添加）：{name}",
        "result.custom.added": "已添加自定义目录：{path}", "result.custom.removed": "已移除自定义目录",
        "status.enabled": "已启用", "status.disabled": "已停用", "status.invalid": "诊断异常", "status.shadowed": "被覆盖", "status.readonly": "源文件只读", "status.manageable": "可管理", "status.project": "项目级", "status.rank": "优先级 {rank}", "status.source.on": "已启用", "status.source.off": "已停用", "status.bundle": "目录技能", "status.single": "单文件",
        "summary.total.one": "{count} 个技能", "summary.total.other": "{count} 个技能", "summary.enabled.one": "{count} 个已启用", "summary.enabled.other": "{count} 个已启用", "summary.disabled.one": "{count} 个已停用", "summary.disabled.other": "{count} 个已停用", "summary.issues.one": "{count} 个诊断项", "summary.issues.other": "{count} 个诊断项", "summary.group.one": "{count} 个技能", "summary.group.other": "{count} 个技能", "table.skill": "技能名称与描述", "table.status": "调用状态",
        "filter.source": "来源", "filter.all": "全部来源", "filter.option": "{name}（{count}）", "search": "搜索", "search.placeholder": "搜索技能名称或描述", "search.clear": "清除搜索",
        "empty.search": "没有匹配的技能。", "empty.source": "该来源目录不存在或暂时没有技能。", "loading": "正在加载技能…", "note.missing": "未提供简介", "source.toggle": "启停来源", "skill.toggle": "启停技能",
        "source.external.note": "通过 Skills Manager 接入，启停不会改写源文件。", "source.dsh.note": "DSH 本地技能可创建、导入和移到回收站；启停只更新管理器状态。",
        "detail.title": "技能详情", "detail.body": "正文", "detail.frontmatter": "元数据", "detail.noFrontmatter": "该技能未提供元数据。", "detail.diagnostics": "诊断", "detail.path": "源文件", "detail.noIssues": "未发现诊断问题。",
        "create.title": "创建技能", "create.target": "创建位置", "create.name": "名称", "create.name.placeholder": "例如 code-review-helper", "create.description": "简介", "create.description.placeholder": "一句话说明什么时候使用", "create.body": "正文（Markdown）", "create.body.placeholder": "写下技能要遵循的指令、步骤和边界…", "create.chat.note": "对话中的 create_skill 仍创建用户级 DSH Skill；项目 Skill 可在这里选择活动项目后创建。",
        "import.title": "导入技能", "upload.drop.title": "拖拽技能到此处", "upload.drop.copy": "支持 .zip、技能文件夹或单个 SKILL.md", "upload.selected.one": "{count} 个文件 · {size}", "upload.selected.other": "{count} 个文件 · {size}", "upload.remove": "移除所选内容", "upload.requirements": "文件要求", "upload.requirement.skill": "压缩包或文件夹需包含 SKILL.md", "upload.requirement.frontmatter": "SKILL.md 需包含 YAML 格式的技能名称和描述", "upload.requirement.copy": "导入时复制完整内容，不修改原始来源", "upload.importing": "正在安装…", "status.selected": "已选择", "select.file.invalid": "请选择 .zip 或单个 SKILL.md。", "select.folder.invalid": "所选文件夹中没有找到 SKILL.md。", "error.browse.absolute": "目录路径必须是绝对路径：{path}", "error.browse.unreadable": "无法读取目录：{path}", "error.browse.notDirectory": "不是目录：{path}",
        "trash.title": "回收站", "trash.count.one": "{count} 个待处理技能", "trash.count.other": "{count} 个待处理技能", "trash.empty": "回收站为空。", "trash.deletedAt": "删除于 {time}", "trash.source": "来源：{source}",
        "confirm.trash.title": "移到回收站？", "confirm.trash.desc": "“{name}”将从当前技能来源移入回收站，之后可以恢复到原位置。", "confirm.delete.title": "永久删除？", "confirm.delete.desc": "“{name}”将从回收站永久删除，无法恢复。",
        "result.created": "已创建技能：{name}", "result.imported": "导入完成：{names}", "result.importPartial": "已导入：{imported}；已跳过同名技能：{skipped}", "result.importSkipped": "未导入任何技能；已跳过同名技能：{names}", "result.importEmpty": "未导入任何技能。", "result.importWarnings": "{result}；警告：{warnings}", "result.restored": "已恢复技能：{name}", "result.trashed": "已移到回收站：{name}", "result.deleted": "已永久删除：{name}", "result.updated": "状态已更新。", "result.opened": "已用系统默认程序打开：{path}", "error.action": "操作失败：{error}",
        "warning.scan.truncated": "技能目录较大或嵌套过深，部分技能未显示：{path}", "warning.state.invalid": "技能管理器状态文件不可读；所有技能已安全停用，修复文件前不会覆盖状态：{path}", "warning.backupUncleaned": "旧版本备份未清理：{path}（{error}）", "warning.project.unavailable": "无法从宿主读取活动工作区，项目技能未显示：{path}",
        "error.root.readonly": "该来源不允许{action}", "error.root.unknown": "未知技能来源：{root}", "error.root.unsafe": "项目技能目录不安全，拒绝写入：{path}", "error.skill.notFound": "技能不存在: {name}", "error.skill.noFrontmatter": "技能缺少完整 frontmatter，无法{action}: {name}", "error.skill.notLoadable": "技能结构不完整，无法{action}: {name}",
        "error.source.notFound": "路径不存在: {path}", "error.source.symlink": "不支持包含符号链接的 skill 来源: {path}", "error.source.unrecognized": "无法识别的 skill 来源: {path}", "error.source.tooDeep": "skill 来源目录层级超过 {depth} 层: {path}",
        "error.import.overlap": "导入来源不能与 DSH 技能目录相同、包含或位于其中", "error.import.emptySource": "目录下未找到任何 skill 条目: {path}", "error.import.invalidName": "无法生成合法 kebab-case 名称（原始名: {name}）", "error.import.duplicateName": "批量来源中存在多个同名技能: {name}", "error.import.failed": "导入失败", "error.import.rollbackFailed": "覆盖导入回滚失败，备份保留在: {path}（{error}）",
        "error.upload.path": "上传内容包含非法路径：{path}", "error.upload.encoding": "上传内容编码无效", "error.upload.empty": "上传内容为空", "error.upload.tooMany": "上传文件过多，最多 {limit} 个", "error.upload.tooLarge": "上传内容过大，限制为 {limit} 字节", "error.upload.archiveTooLarge": "ZIP 压缩包过大，限制为 {limit} 字节", "error.upload.duplicate": "上传内容包含重复路径：{path}", "error.upload.zipInvalid": "ZIP 压缩包无法解压",
        "error.trash.notFound": "回收站条目不存在: {id}", "error.trash.conflict": "无法恢复，同名技能已存在: {name}", "error.trash.invalid": "回收站条目路径非法: {id}", "error.trash.projectUnavailable": "原项目当前不在活动工作区中，无法恢复：{path}", "error.trash.rollbackFailed": "移入回收站回滚失败，未恢复内容保留在: {path}（{error}）",
        "error.state.invalid": "技能管理器状态文件不可读，已拒绝覆盖：{path}",
        "error.create.descriptionRequired": "技能简介不能为空", "error.create.bodyRequired": "技能正文不能为空", "error.create.tooLarge": "技能内容过长", "error.create.conflict": "同名技能已存在: {name}",
        "error.proto.forbidden": "禁止的修改请求（缺少客户端标记）", "error.proto.forbiddenHost": "禁止的请求来源（非法 Host）", "error.proto.contentType": "请求体必须是 application/json", "error.proto.method": "不支持的请求方法", "error.proto.unknownAction": "未知操作", "error.proto.bodyTooLarge": "请求体过大", "error.proto.invalidJson": "请求体不是合法 JSON", "error.proto.nonJson": "服务端返回非 JSON 响应（HTTP {status}）",
        "diagnostic.frontmatter.missing": "缺少完整 YAML frontmatter", "diagnostic.name.missing": "frontmatter 缺少 name", "diagnostic.name.invalid": "技能名称不是合法 kebab-case：{name}", "diagnostic.description.missing": "frontmatter 缺少 description", "diagnostic.invocation.invalid": "调用策略字段值无效", "diagnostic.shadowed": "被更高优先级来源 {root} 覆盖",
        "action.enable": "启用", "action.disable": "停用", "action.create": "创建", "action.delete": "删除", "action.restore": "恢复", "action.toggle": "启用或停用",
        "root.dsh": "DSH 技能", "root.agents": "公共 Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "项目 DSH", "root.projectAgents": "项目 Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor"
      },
      en: {
        "title": "Skills", "desc": "Load and manage Agent Skills on this computer in one place.", "link.project": "GitHub", "link.feedback": "Issues",
        "btn.create": "Create skill", "btn.import": "Import", "btn.refresh": "Refresh", "btn.cancel": "Cancel", "btn.close": "Close", "btn.detail": "View details", "btn.trash": "Move to trash", "btn.restore": "Restore", "btn.delete.forever": "Delete forever", "btn.file.pick": "Choose file", "btn.folder.pick": "Choose folder", "btn.import.now": "Install", "btn.create.now": "Create skill", "btn.disable": "Disable", "btn.enable": "Enable", "btn.open.editor": "Open in editor",
        "status.enabled": "Enabled", "status.disabled": "Disabled", "status.invalid": "Needs attention", "status.shadowed": "Shadowed", "status.readonly": "Source read-only", "status.manageable": "Manageable", "status.project": "Project scoped", "status.rank": "Rank {rank}", "status.source.on": "Enabled", "status.source.off": "Disabled", "status.bundle": "Bundle", "status.single": "Single file",
        "summary.total.one": "{count} skill", "summary.total.other": "{count} skills", "summary.enabled.one": "{count} enabled", "summary.enabled.other": "{count} enabled", "summary.disabled.one": "{count} disabled", "summary.disabled.other": "{count} disabled", "summary.issues.one": "{count} diagnostic", "summary.issues.other": "{count} diagnostics", "summary.group.one": "{count} skill", "summary.group.other": "{count} skills", "table.skill": "Skill name and description", "table.status": "Invocation status",
        "filter.source": "Source", "filter.all": "All sources", "filter.option": "{name} ({count})", "search": "Search", "search.placeholder": "Search skill names or descriptions", "search.clear": "Clear search",
        "empty.search": "No matching skills.", "empty.source": "This source does not exist or has no skills yet.", "loading": "Loading skills…", "note.missing": "No description provided", "source.toggle": "Toggle source", "skill.toggle": "Toggle skill",
        "source.external.note": "Managed through Skills Manager; toggles never rewrite source files.", "source.dsh.note": "Local DSH skills can be created, imported, and moved to trash; toggles update manager state only.",
        "detail.title": "Skill details", "detail.body": "Body", "detail.frontmatter": "Metadata", "detail.noFrontmatter": "This skill provides no metadata.", "detail.diagnostics": "Diagnostics", "detail.path": "Source file", "detail.noIssues": "No diagnostic issues found.",
        "create.title": "Create skill", "create.target": "Create in", "create.name": "Name", "create.name.placeholder": "e.g. code-review-helper", "create.description": "Description", "create.description.placeholder": "One sentence describing when to use it", "create.body": "Body (Markdown)", "create.body.placeholder": "Write the instructions, steps, and boundaries…", "create.chat.note": "The conversational create_skill tool still creates a user-level DSH Skill; choose an active project here for a project Skill.",
        "import.title": "Import skill", "upload.drop.title": "Drop a skill here", "upload.drop.copy": "Supports .zip, a skill folder, or one SKILL.md", "upload.selected.one": "{count} file · {size}", "upload.selected.other": "{count} files · {size}", "upload.remove": "Remove selection", "upload.requirements": "File requirements", "upload.requirement.skill": "Archives and folders must contain SKILL.md", "upload.requirement.frontmatter": "SKILL.md must include a YAML name and description", "upload.requirement.copy": "Import copies all content and never modifies the source", "upload.importing": "Installing…", "status.selected": "Selected", "select.file.invalid": "Choose a .zip archive or one SKILL.md.", "select.folder.invalid": "No SKILL.md was found in the selected folder.", "error.browse.absolute": "Folder path must be absolute: {path}", "error.browse.unreadable": "Could not read folder: {path}", "error.browse.notDirectory": "Not a folder: {path}",
        "trash.title": "Trash", "trash.count.one": "{count} skill pending", "trash.count.other": "{count} skills pending", "trash.empty": "Trash is empty.", "trash.deletedAt": "Deleted {time}", "trash.source": "Source: {source}",
        "confirm.trash.title": "Move to trash?", "confirm.trash.desc": "“{name}” will move out of its current skill source and can be restored to the same location later.", "confirm.delete.title": "Delete forever?", "confirm.delete.desc": "“{name}” will be permanently deleted from trash and cannot be recovered.",
        "result.created": "Created skill: {name}", "result.imported": "Import complete: {names}", "result.importPartial": "Imported: {imported}; skipped existing skills: {skipped}", "result.importSkipped": "No skills were imported; existing skills were skipped: {names}", "result.importEmpty": "No skills were imported.", "result.importWarnings": "{result}; warnings: {warnings}", "result.restored": "Restored skill: {name}", "result.trashed": "Moved to trash: {name}", "result.deleted": "Permanently deleted: {name}", "result.updated": "Status updated.", "error.action": "Action failed: {error}",
        "warning.scan.truncated": "Some skills were not shown because the directory is too large or deeply nested: {path}", "warning.state.invalid": "The manager state file could not be read; all skills are disabled and state writes are blocked until it is repaired: {path}", "warning.backupUncleaned": "Old version backup was not cleaned up: {path} ({error})", "warning.project.unavailable": "The active workspace could not be read from the host, so its project skills are hidden: {path}",
        "error.root.readonly": "This source does not allow {action}", "error.root.unknown": "Unknown skill source: {root}", "error.root.unsafe": "The project skill directory is unsafe, so the write was refused: {path}", "error.skill.notFound": "Skill not found: {name}", "error.skill.noFrontmatter": "Skill lacks complete frontmatter, cannot {action}: {name}", "error.skill.notLoadable": "Skill structure is incomplete, cannot {action}: {name}",
        "error.source.notFound": "Path does not exist: {path}", "error.source.symlink": "Skill sources containing symbolic links are not supported: {path}", "error.source.unrecognized": "Unrecognized skill source: {path}", "error.source.tooDeep": "Skill source directory depth exceeds {depth} levels: {path}",
        "error.import.overlap": "Import source cannot be the same as, contain, or be inside the DSH skills directory", "error.import.emptySource": "No skill entries found in the directory: {path}", "error.import.invalidName": "Cannot generate a valid kebab-case name (original: {name})", "error.import.duplicateName": "Batch source contains duplicate skill names: {name}", "error.import.failed": "Import failed", "error.import.rollbackFailed": "Overwrite import rollback failed; backups kept at: {path} ({error})",
        "error.upload.path": "Upload contains an invalid path: {path}", "error.upload.encoding": "Upload encoding is invalid", "error.upload.empty": "Upload is empty", "error.upload.tooMany": "Too many uploaded files; maximum {limit}", "error.upload.tooLarge": "Upload is too large; limit {limit} bytes", "error.upload.archiveTooLarge": "ZIP archive is too large; limit {limit} bytes", "error.upload.duplicate": "Upload contains a duplicate path: {path}", "error.upload.zipInvalid": "ZIP archive could not be extracted",
        "error.trash.notFound": "Trash item not found: {id}", "error.trash.conflict": "Cannot restore because a skill with the same name exists: {name}", "error.trash.invalid": "Invalid trash item path: {id}", "error.trash.projectUnavailable": "The original project is not an active workspace, so this skill cannot be restored: {path}", "error.trash.rollbackFailed": "Move-to-trash rollback failed; unrecovered content was kept at: {path} ({error})",
        "error.state.invalid": "The manager state file could not be read, so overwriting it was refused: {path}",
        "error.create.descriptionRequired": "Skill description is required", "error.create.bodyRequired": "Skill body is required", "error.create.tooLarge": "Skill content is too large", "error.create.conflict": "A skill with the same name already exists: {name}",
        "error.proto.forbidden": "Forbidden mutation request (missing client marker)", "error.proto.forbiddenHost": "Forbidden request origin (invalid host)", "error.proto.contentType": "Content type must be application/json", "error.proto.method": "Method not allowed", "error.proto.unknownAction": "Unknown action", "error.proto.bodyTooLarge": "Request body too large", "error.proto.invalidJson": "Invalid JSON request body", "error.proto.nonJson": "Server returned a non-JSON response (HTTP {status})",
        "diagnostic.frontmatter.missing": "Missing complete YAML frontmatter", "diagnostic.name.missing": "Frontmatter is missing name", "diagnostic.name.invalid": "Skill name is not valid kebab-case: {name}", "diagnostic.description.missing": "Frontmatter is missing description", "diagnostic.invocation.invalid": "Invocation policy value is invalid", "diagnostic.shadowed": "Shadowed by higher-priority source {root}",
        "action.enable": "enable", "action.disable": "disable", "action.create": "create", "action.delete": "delete", "action.restore": "restore", "action.toggle": "enabling or disabling",
        "root.dsh": "DSH skills", "root.agents": "Shared Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "Project DSH", "root.projectAgents": "Project Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor"
      }
    };


    function translateOrFallback(t, key, fallback, params) { var value = t(key, params); return typeof value === "string" && value !== key ? value : fallback; }
    function translateError(t, payload) {
      if (payload instanceof Error && !payload.code) return payload.message;
      if (payload && typeof payload === "object") {
        if (payload.code) { var params = Object.assign({}, payload.params || {}); if (params.action) params.action = translateOrFallback(t, "action." + params.action, params.action); var translated = t(payload.code, params); if (typeof translated === "string" && translated !== payload.code) return translated; }
        if (payload.error !== undefined) return translateError(t, payload.error); if (payload.message !== undefined) return String(payload.message);
      }
      return String(payload == null ? "" : payload);
    }
    function parseApiResponse(response) { return response.json().catch(function () { var error = new Error("non-json response"); error.code = "error.proto.nonJson"; error.params = { status: response.status }; throw error; }).then(function (payload) { if (!response.ok || payload.ok === false) throw payload; return payload.data; }); }
    var OP_BY_PATH = { "/state": "skill-state", "/enable": "skill-enable", "/disable": "skill-disable",
  "/source-enable": "skill-source-enable", "/source-disable": "skill-source-disable",
  "/delete": "skill-delete", "/trash-restore": "skill-trash-restore", "/trash-delete": "skill-trash-delete",
  "/detail": "skill-detail", "/create": "skill-create", "/import": "skill-import",
  "/upload": "skill-upload", "/browse": "skill-browse" };
function callApi(path, options) {
  var op = OP_BY_PATH[path];
  if (!op) return Promise.reject({ error: "unknown action: " + path });
  var args = {};
  if (options && typeof options.body === "string") { try { args = JSON.parse(options.body) || {}; } catch (e) { args = {}; } }
  return apiCall(op, args).then(function (payload) {
    if (!payload || payload.ok !== true) throw payload || { error: "request failed" };
    return payload.data;
  });
}
    function isSkillEnabled(skill) { if (skill.enabled !== undefined) return skill.enabled === true; return skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false; }
    function countKey(key, count) { return key + (Number(count) === 1 ? ".one" : ".other"); }
    function rootDisplayName(t, root) { var base = translateOrFallback(t, "root." + (root.localeKey || root.kind || root.key), root.label); return root.projectName ? base + " · " + root.projectName : base; }
    function summarizeImportResult(t, data) {
      var importedItems = data && data.imported || [];
      var imported = importedItems.map(function (item) { return item.name; });
      var skipped = (data && data.skipped || []).map(function (item) { return item.name; });
      var warnings = [];
      importedItems.forEach(function (item) {
        (item.warnings || []).forEach(function (warning) { warnings.push(translateError(t, warning)); });
      });
      var summary;
      if (imported.length && skipped.length) summary = { ok: true, warning: true, imported: true, text: t("result.importPartial", { imported: imported.join(", "), skipped: skipped.join(", ") }) };
      else if (imported.length) summary = { ok: true, warning: false, imported: true, text: t("result.imported", { names: imported.join(", ") }) };
      else if (skipped.length) summary = { ok: false, warning: true, imported: false, text: t("result.importSkipped", { names: skipped.join(", ") }) };
      else summary = { ok: false, warning: false, imported: false, text: t("result.importEmpty") };
      if (warnings.length) {
        summary.warning = true;
        summary.text = t("result.importWarnings", { result: summary.text, warnings: warnings.join("；") });
      }
      return summary;
    }
    function normalizeSkillQuery(query) { return String(query == null ? "" : query).trim().toLowerCase(); }
    function matchSkillQuery(skill, query) { var q = normalizeSkillQuery(query); if (!q) return true; return [skill.name, skill.declaredName, skill.description, skill.kind, skill.kindLabel, skill.statusLabel, skill.rootKey, skill.rootLabel].some(function (value) { return String(value == null ? "" : value).toLowerCase().includes(q); }); }
    function filterSkills(list, options) { var rootKey = options && options.rootKey != null ? options.rootKey : ""; return list.filter(function (skill) { return (!rootKey || skill.rootKey === rootKey) && matchSkillQuery(skill, options && options.query); }); }
    function visibleSkillRoots(roots) { return (roots || []).filter(function (root) { return root.scope !== "project" || (root.skills || []).length > 0; }); }
    var MAX_UPLOAD_ARCHIVE_BYTES = 32 << 20, MAX_UPLOAD_ENTRY_BYTES = 32 << 20, MAX_UPLOAD_TOTAL_BYTES = 64 << 20, MAX_UPLOAD_ENTRIES = 1000;
    function uploadFilePath(file) { return String(file && (file._dssmPath || file.webkitRelativePath || file.name) || "").replace(/\\/g, "/"); }
    function inspectUploadSelection(files) {
      var list = Array.prototype.slice.call(files || []); if (!list.length) return null;
      if (list.length > MAX_UPLOAD_ENTRIES) return { error: { code: "error.upload.tooMany", params: { limit: MAX_UPLOAD_ENTRIES } } };
      var relative = list.some(function (file) { return uploadFilePath(file).includes("/"); });
      if (relative) {
        if (!list.some(function (file) { return /(^|\/)skill\.md$/i.test(uploadFilePath(file)); })) return { error: { code: "select.folder.invalid" } };
        var oversized = list.find(function (file) { return Number(file.size || 0) > MAX_UPLOAD_ENTRY_BYTES; });
        if (oversized) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } };
        var total = list.reduce(function (sum, file) { return sum + Number(file.size || 0); }, 0);
        if (total > MAX_UPLOAD_TOTAL_BYTES) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_TOTAL_BYTES } } };
        return { kind: "folder", name: uploadFilePath(list[0]).split("/")[0], files: list, count: list.length, size: total };
      }
      if (list.length !== 1) return { error: { code: "select.file.invalid" } };
      var name = String(list[0].name || ""), lower = name.toLowerCase();
      var size = Number(list[0].size || 0);
      if (lower === "skill.md") return size > MAX_UPLOAD_ENTRY_BYTES ? { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } } : { kind: "skill", name: name, files: list, count: 1, size: size };
      if (lower.endsWith(".zip")) return size > MAX_UPLOAD_ARCHIVE_BYTES ? { error: { code: "error.upload.archiveTooLarge", params: { limit: MAX_UPLOAD_ARCHIVE_BYTES } } } : { kind: "zip", name: name, files: list, count: 1, size: size };
      return { error: { code: "select.file.invalid" } };
    }
    function bytesToBase64(buffer) { var bytes = new Uint8Array(buffer), binary = "", chunk = 0x8000; for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length))); return btoa(binary); }
    function buildUploadPayload(selection) { return Promise.all(selection.files.map(function (file) { return file.arrayBuffer().then(function (buffer) { return { path: uploadFilePath(file), data: bytesToBase64(buffer) }; }); })).then(function (entries) { return selection.kind === "zip" ? { name: selection.name, zip: entries[0].data } : { name: selection.name, entries: entries }; }); }
    function readDroppedEntry(entry, prefix, output) { if (entry.isFile) return new Promise(function (resolve, reject) { entry.file(function (file) { file._dssmPath = prefix + file.name; output.push(file); resolve(); }, reject); }); if (!entry.isDirectory) return Promise.resolve(); return new Promise(function (resolve, reject) { var reader = entry.createReader(), children = []; function next() { reader.readEntries(function (batch) { if (!batch.length) { Promise.all(children.map(function (child) { return readDroppedEntry(child, prefix + entry.name + "/", output); })).then(resolve, reject); return; } children = children.concat(batch); next(); }, reject); } next(); }); }
    function droppedFiles(dataTransfer) { var items = Array.prototype.slice.call(dataTransfer && dataTransfer.items || []), entries = items.map(function (item) { return item.webkitGetAsEntry && item.webkitGetAsEntry(); }).filter(Boolean); if (!entries.length) return Promise.resolve(Array.prototype.slice.call(dataTransfer && dataTransfer.files || [])); var files = []; return Promise.all(entries.map(function (entry) { return readDroppedEntry(entry, "", files); })).then(function () { return files; }); }
    function modalFocusable(modal) { return Array.prototype.slice.call(modal.querySelectorAll("button:not(:disabled), [href], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])") || []); }
    function trapModalFocus(modal, event) { if (event.key !== "Tab") return; var focusable = modalFocusable(modal); if (!focusable.length) return; var active = document.activeElement; if (!modal.contains(active) || (event.shiftKey ? active === focusable[0] : active === focusable[focusable.length - 1])) { event.preventDefault(); (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus(); } }
    function handleModalEscape(event, onClose) { if (event.key !== "Escape") return false; event.preventDefault(); event.stopPropagation(); if (event.nativeEvent && typeof event.nativeEvent.stopImmediatePropagation === "function") event.nativeEvent.stopImmediatePropagation(); onClose(); return true; }

    function SourceSelect(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], selected = props.options.find(function (o) { return o.value === props.value; }) || props.options[0], ref = react.useRef(null);
      react.useEffect(function () { if (!open) return undefined; function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); } document.addEventListener("pointerdown", close); return function () { document.removeEventListener("pointerdown", close); }; }, [open]);
      return h("div", { className: "dsm-select", ref: ref }, h("button", { type: "button", className: "dsm-select-trigger", "aria-haspopup": "listbox", "aria-expanded": open, onClick: function () { setOpen(!open); } }, h("span", null, selected.label)), open ? h("div", { className: "dsm-select-menu", role: "listbox" }, props.options.map(function (o) { return h("button", { key: o.value || "all", type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }
    function Switch(props) { return h("button", { type: "button", className: "dsm-switch" + (props.on ? " dsm-switch-on" : ""), role: "switch", "aria-checked": props.on, "aria-label": props.label, disabled: props.disabled, onClick: props.onClick }); }
    function GithubMark16() { return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, h("path", { fill: "currentColor", d: "M8 0a8 8 0 0 0-2.53 15.59c.4.074.547-.173.547-.385 0-.19-.007-.693-.01-1.36-2.226.484-2.695-1.073-2.695-1.073-.364-.924-.89-1.17-.89-1.17-.726-.496.055-.486.055-.486.803.056 1.225.824 1.225.824.714 1.223 1.872.87 2.328.665.072-.517.28-.87.508-1.07-1.777-.202-3.645-.888-3.645-3.956 0-.874.31-1.588.823-2.148-.083-.202-.357-1.017.078-2.12 0 0 .672-.215 2.2.82A7.65 7.65 0 0 1 8 4.8c.68.003 1.365.092 2.004.27 1.527-1.035 2.197-.82 2.197-.82.437 1.103.162 1.918.08 2.12.513.56.822 1.274.822 2.148 0 3.076-1.872 3.752-3.654 3.95.288.248.544.735.544 1.482 0 1.07-.01 1.932-.01 2.195 0 .214.144.463.55.384A8.001 8.001 0 0 0 8 0Z" })); }
    function Modal(props) { var ref = react.useRef(null); react.useEffect(function () { if (ref.current) ref.current.focus(); }, []); return h("div", { className: "dsm-mask", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose(); } }, h("div", { ref: ref, tabIndex: -1, className: "dsm-modal" + (props.wide ? " dsm-modal-wide" : "") + (props.className ? " " + props.className : ""), role: "dialog", "aria-modal": "true", onKeyDown: function (e) { if (!handleModalEscape(e, props.onClose)) trapModalFocus(e.currentTarget, e); } }, h("div", { className: "dsm-modal-head" }, h("h3", { className: "dsm-modal-title" }, props.title), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: props.onClose }, props.closeLabel)), props.children)); }

    function SkillManagerSection(props) {
      var t = props.t;
      var ss = react.useState({ loading: true, error: null, data: null }), snapshot = ss[0], setSnapshot = ss[1];
      var bs = react.useState(false), busy = bs[0], setBusy = bs[1];
      var qs = react.useState(""), query = qs[0], setQuery = qs[1];
      var fs = react.useState(""), source = fs[0], setSource = fs[1];
      var es = react.useState({}), expanded = es[0], setExpanded = es[1];
      var ms = react.useState(null), modal = ms[0], setModal = ms[1];
      var rs = react.useState(null), result = rs[0], setResult = rs[1];
      var fms = react.useState({ root: "dsh", name: "", description: "", body: "" }), form = fms[0], setForm = fms[1];
      var us = react.useState(null), upload = us[0], setUpload = us[1];
      var ds = react.useState(null), detail = ds[0], setDetail = ds[1];
      var cs = react.useState({ path: "", label: "" }), customForm = cs[0], setCustomForm = cs[1];
      var inflightRef = react.useRef(false);
      var importInputRef = react.useRef(null);
      var folderInputRef = react.useRef(null);
      var pickerOpenRef = react.useRef(false);
      function refresh(silent) { if (!silent) setSnapshot({ loading: true, error: null, data: snapshot.data }); return callApi("/state").then(function (data) { setSnapshot({ loading: false, error: null, data: data }); return data; }).catch(function (error) { setSnapshot({ loading: false, error: translateError(t, error), data: snapshot.data }); }); }
      react.useEffect(function () { refresh(false); }, []);
      function post(path, body, successKey, successParams) { if (inflightRef.current) return Promise.reject({ error: "operation already in progress" }); inflightRef.current = true; setBusy(true); setResult(null); return callApi(path, { body: JSON.stringify(body || {}) }).then(function (data) { setResult({ ok: true, text: successKey ? t(successKey, successParams || data || {}) : t("result.updated") }); return refresh(true).then(function () { return data; }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); throw error; }).finally(function () { inflightRef.current = false; setBusy(false); }); }
      function openDetail(root, skill) { setBusy(true); setDetail(null); setModal("detail"); callApi("/detail", { body: JSON.stringify({ root: root.key, name: skill.name }) }).then(setDetail).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); setModal(null); }).finally(function () { setBusy(false); }); }
      function openSource() { if (!detail || !detail.path) return; setBusy(true); setResult(null); apiCall("skill-open", { path: detail.path }).then(function (res) { if (res && res.ok) setResult({ ok: true, text: t("result.opened", { path: detail.path }) }); else setResult({ ok: false, text: t("error.action", { error: translateError(t, res) }) }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); }); }
      function updateForm(key, value) { setForm(Object.assign({}, form, { [key]: value })); }
      // 自定义技能目录：添加 / 移除（走 skill-custom-* ops，成功后静默刷新）。
      function submitCustomAdd() {
        var payload = { path: String(customForm.path || "").trim(), label: String(customForm.label || "").trim() };
        if (!payload.path) return;
        setBusy(true); setResult(null);
        apiCall("skill-custom-add", payload).then(function (res) {
          if (res && res.ok) { setResult({ ok: true, text: t("result.custom.added", { path: res.data && res.data.path || payload.path }) }); setCustomForm({ path: "", label: "" }); setModal(null); return refresh(true); }
          setResult({ ok: false, text: (res && res.error) || t("error.action", { error: "unknown" }) });
        }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      function submitCustomRemove(key, name) {
        setBusy(true); setResult(null);
        apiCall("skill-custom-remove", { key: key }).then(function (res) {
          if (res && res.ok) { setResult({ ok: true, text: t("result.custom.removed", { name: name }) }); setModal(null); return refresh(true); }
          setResult({ ok: false, text: (res && res.error) || t("error.action", { error: "unknown" }) });
        }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      function submitCreate() { post("/create", form, null).then(function (data) { setModal(null); setForm({ root: "dsh", name: "", description: "", body: "" }); setResult({ ok: true, text: t("result.created", { name: data.name }) }); }).catch(function () {}); }
      function selectUploadFiles(files) { pickerOpenRef.current = false; var selected = inspectUploadSelection(files); if (!selected) return; if (selected.error) { setUpload(null); setResult({ ok: false, text: translateError(t, selected.error) }); return; } setUpload(selected); setResult(null); }
      function openNativePicker(ref) { if (busy || pickerOpenRef.current || !ref.current) return; pickerOpenRef.current = true; ref.current.value = ""; function release() { setTimeout(function () { pickerOpenRef.current = false; }, 0); } window.addEventListener("focus", release, { once: true }); ref.current.click(); setTimeout(function () { pickerOpenRef.current = false; }, 30000); }
      function submitImport() { if (!upload) return; buildUploadPayload(upload).then(function (payload) { return post("/upload", payload, null); }).then(function (data) { var summary = summarizeImportResult(t, data); setResult({ ok: summary.ok, warning: summary.warning, text: summary.text }); if (summary.imported) { setModal(null); setUpload(null); } }).catch(function () {}); }
      var data = snapshot.data || { roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }, allRoots = data.roots || [], roots = visibleSkillRoots(allRoots), activeSource = roots.some(function (root) { return root.key === source; }) ? source : "";
      var createRoots = allRoots.filter(function (root) { return root.mutable === true; }), createOptions = createRoots.map(function (root) { return { value: root.key, label: rootDisplayName(t, root) }; }); if (!createOptions.length) createOptions.push({ value: "dsh", label: t("root.dsh") });
      function openCreate() { var selectedRoot = createRoots.some(function (root) { return root.key === activeSource; }) ? activeSource : "dsh"; setForm(Object.assign({}, form, { root: selectedRoot })); setModal("create"); }
      function trashRootLabel(item) { return item.root && item.root.scope === "project" ? t("root.projectDsh") + " · " + (item.root.projectName || item.root.projectRoot) : t("root.dsh"); }
      var options = [{ value: "", label: t("filter.all") }].concat(roots.map(function (root) { return { value: root.key, label: t("filter.option", { name: rootDisplayName(t, root), count: root.count == null ? root.skills.length : root.count }) }; }));

      function renderSkill(root, skill) {
        var enabled = isSkillEnabled(skill), key = skill.shadowedBy ? "status.shadowed" : skill.loadable === false ? "status.invalid" : enabled ? "status.enabled" : "status.disabled", cls = skill.shadowedBy ? "dsm-shadowed" : enabled ? "dsm-enabled" : "dsm-disabled";
        return h("div", { key: skill.name, className: "dsm-row" }, h("div", { className: "dsm-main" }, h("div", { className: "dsm-name" }, skill.declaredName || skill.name), h("div", { className: "dsm-note" }, skill.description || t("note.missing"))), h("div", { className: "dsm-tags" }, h("span", { className: "dsm-tag" }, rootDisplayName(t, root)), !root.mutable ? h("span", { className: "dsm-tag" }, t("status.readonly")) : null), h("div", { className: "dsm-status " + cls }, t(key)), h("div", { className: "dsm-row-actions" }, root.toggleable !== false ? h(Switch, { on: enabled, disabled: busy || root.enabled === false || !!skill.shadowedBy || skill.loadable === false, label: t("skill.toggle") + " " + skill.name, onClick: function () { post(enabled ? "/disable" : "/enable", { root: root.key, name: skill.name }); } }) : null, h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openDetail(root, skill); } }, t("btn.detail")), root.mutable ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { setModal({ type: "trash-confirm", root: root.key, name: skill.name }); } }, t("btn.trash")) : null));
      }
      function renderRoot(root) {
        if (activeSource && activeSource !== root.key) return null;
        var displayName = rootDisplayName(t, root), filtered = root.skills.filter(function (skill) { return matchSkillQuery(Object.assign({}, skill, { rootKey: root.key, rootLabel: displayName }), query); }); if (query && !filtered.length) return null; var open = !!expanded[root.key] || !!query;
        var rootCount = root.count == null ? root.skills.length : root.count;
        return h("section", { key: root.key, className: "dsm-source" }, h("div", { className: "dsm-source-head" }, h("button", { type: "button", className: "dsm-source-head-main", "aria-expanded": open, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: !open })); } }, h("span", { className: "dsm-source-title" }, displayName), h("span", { className: "dsm-count" }, t(countKey("summary.group", rootCount), { count: rootCount })), h("span", { className: "dsm-tag " + (root.scope === "project" ? "dsm-tag-on" : root.key === "dsh" ? "" : root.enabled ? "dsm-tag-on" : "dsm-tag-off") }, root.scope === "project" ? t("status.project") : root.key === "dsh" ? t("status.manageable") : t(root.enabled ? "status.source.on" : "status.source.off")), root.scope === "project" ? h("span", { className: "dsm-tag" }, t("status.rank", { rank: root.rank })) : null, h("span", { className: "dsm-path", title: root.path }, root.path)), root.scope !== "project" && root.key !== "dsh" && root.toggleable !== false ? h("span", { className: "dsm-source-actions" }, root.key.indexOf("custom-") === 0 ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "custom-remove-confirm", key: root.key, name: displayName }); } }, t("btn.custom.remove")) : null, h(Switch, { on: root.enabled, disabled: busy, label: t("source.toggle") + " " + displayName, onClick: function () { post(root.enabled ? "/source-disable" : "/source-enable", { root: root.key }); } })) : null), open ? h("div", { className: "dsm-source-body" }, filtered.length ? h(react.Fragment, null, h("div", { className: "dsm-table-head" }, h("span", null, t("table.skill")), h("span", null, t("filter.source")), h("span", null, t("table.status")), h("span", null, "")), filtered.map(function (skill) { return renderSkill(root, skill); })) : h("div", { className: "dsm-empty" }, query ? t("empty.search") : t("empty.source"))) : null);
      }

      var summary = data.summary || { total: 0, enabled: 0, disabled: 0, issues: 0 };
      var content = [h("style", { key: "css" }, CSS), h("div", { key: "head", className: "dsm-head" }, h("div", { className: "dsm-title-block" }, h("div", { className: "dsm-title-row" }, h("h2", { className: "dsm-title" }, t("title")), h(VersionBadge, null), h(FeedbackLinks, null)), h("p", { className: "dsm-desc" }, t("desc"))), h("div", { className: "dsm-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy || snapshot.loading, onClick: function () { refresh(false); } }, t("btn.refresh")), h("button", { type: "button", className: "dsm-btn", onClick: openCreate }, t("btn.create")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setResult(null); setUpload(null); setModal("import"); } }, t("btn.import")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setCustomForm({ path: "", label: "" }); setModal("custom-add"); } }, t("btn.custom.add")))), h("div", { key: "summary", className: "dsm-summary dsm-summary-4" }, [[summary.total, "summary.total"], [summary.enabled, "summary.enabled"], [summary.disabled, "summary.disabled"], [summary.issues || 0, "summary.issues"]].map(function (item) { return h("div", { key: item[1], className: "dsm-stat" }, h("strong", null, item[0]), t(countKey(item[1], item[0]), { count: item[0] }).replace(String(item[0]), "")); })), h("div", { key: "filters", className: "dsm-filters" }, h("input", { className: "dsm-control dsm-search", value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function (e) { setQuery(e.target.value); } }), h("div", { className: "dsm-source-filter" }, h(SourceSelect, { value: activeSource, options: options, onChange: setSource }))), result && modal !== "import" ? h("div", { key: "result", className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error") }, result.text) : null].concat((data.warnings || []).map(function (warning, index) { return h("div", { key: "warning-" + index, className: "dsm-feedback dsm-warning", role: "alert" }, translateError(t, warning)); }), [snapshot.error ? h("div", { key: "error", className: "dsm-feedback dsm-error" }, snapshot.error) : null, snapshot.loading && !snapshot.data ? h("div", { key: "loading", className: "dsm-empty" }, t("loading")) : h("div", { key: "sources", className: "dsm-sources" }, roots.map(renderRoot)), h("button", { key: "trash", type: "button", className: "dsm-trash-row", onClick: function () { setModal("trash"); } }, h("span", null, t("trash.title")), h("span", { className: "dsm-trash-count" }, (data.trash || []).length))]);

      if (modal === "create") content.push(h(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.target")), h(SourceSelect, { value: form.root, options: createOptions, onChange: function (value) { updateForm("root", value); } })), [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function (field) { return h("label", { key: field[0], className: "dsm-field" }, h("span", { className: "dsm-label" }, t(field[1])), h("input", { className: "dsm-control", value: form[field[0]], placeholder: t(field[2]), onChange: function (e) { updateForm(field[0], e.target.value); } })); }), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.body")), h("textarea", { className: "dsm-control", value: form.body, placeholder: t("create.body.placeholder"), onChange: function (e) { updateForm("body", e.target.value); } })), h("p", { className: "dsm-help" }, t("create.chat.note"))), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { className: "dsm-btn", disabled: busy || !form.name.trim() || !form.description.trim() || !form.body.trim(), onClick: submitCreate }, t("btn.create.now")))));
      if (modal === "import") content.push(h(Modal, { key: "import", className: "dsm-modal-import", title: t("import.title"), closeLabel: t("btn.close"), onClose: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); } },
        h("input", { ref: importInputRef, className: "dsm-hidden-input", type: "file", accept: ".zip,.md", onChange: function (event) { selectUploadFiles(event.target.files); event.target.value = ""; } }),
        h("input", { ref: folderInputRef, className: "dsm-hidden-input", type: "file", multiple: true, webkitdirectory: "", directory: "", onChange: function (event) { selectUploadFiles(event.target.files); event.target.value = ""; } }),
        h("div", { className: "dsm-dropzone", onDragOver: function (event) { event.preventDefault(); event.currentTarget.classList.add("dsm-dropzone-active"); }, onDragLeave: function (event) { event.currentTarget.classList.remove("dsm-dropzone-active"); }, onDrop: function (event) { event.preventDefault(); event.currentTarget.classList.remove("dsm-dropzone-active"); droppedFiles(event.dataTransfer).then(selectUploadFiles).catch(function (error) { setResult({ ok: false, text: translateError(t, error) }); }); } },
          h("span", { className: "dsm-dropzone-title" }, t("upload.drop.title")),
          h("span", { className: "dsm-dropzone-copy" }, t("upload.drop.copy")),
          h("div", { className: "dsm-upload-choices" }, h("button", { type: "button", className: "dsm-upload-link", disabled: busy, onClick: function (event) { event.stopPropagation(); openNativePicker(folderInputRef); } }, t("btn.folder.pick")), h("span", { className: "dsm-upload-divider" }, "/"), h("button", { type: "button", className: "dsm-upload-link", disabled: busy, onClick: function (event) { event.stopPropagation(); openNativePicker(importInputRef); } }, t("btn.file.pick")))
        ),
        upload ? h("div", { className: "dsm-file", title: upload.name }, h("span", { className: "dsm-file-kind", "aria-hidden": "true" }, upload.kind === "zip" ? "ZIP" : upload.kind === "folder" ? "DIR" : "MD"), h("span", { className: "dsm-file-name" }, upload.name), h("span", { className: "dsm-file-meta" }, t(countKey("upload.selected", upload.count), { count: upload.count, size: upload.size < 1024 ? upload.size + " B" : Math.ceil(upload.size / 1024) + " KB" })), h("button", { type: "button", className: "dsm-file-remove", "aria-label": t("upload.remove"), onClick: function () { setUpload(null); } }, "×")) : null,
        result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null,
        h("div", { className: "dsm-upload-requirements" }, h("div", { className: "dsm-label" }, t("upload.requirements")), h("ul", null, h("li", null, t("upload.requirement.skill")), h("li", null, t("upload.requirement.frontmatter")), h("li", null, t("upload.requirement.copy")))),
        h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); } }, t("btn.cancel")), h("button", { type: "button", className: "dsm-btn", disabled: busy || !upload, onClick: submitImport }, busy ? t("upload.importing") : t("btn.import.now")))
      ));      if (modal === "detail") content.push(h(Modal, { key: "detail", wide: true, title: t("detail.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, detail ? h(react.Fragment, null, h("div", { className: "dsm-detail-path" }, detail.path), h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openSource }, t("btn.open.editor"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.diagnostics")), detail.diagnostics.length ? detail.diagnostics.map(function (item, index) { return h("div", { key: index, className: "dsm-diag" }, t(item.code, item.params || {})); }) : h("div", { className: "dsm-note" }, t("detail.noIssues"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.frontmatter")), renderFrontmatter(t, detail.frontmatter)), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.body")), h("pre", { className: "dsm-code" }, detail.body || ""))) : h("div", { className: "dsm-empty" }, t("loading"))));
      if (modal === "trash") content.push(h(Modal, { key: "trash-modal", title: t("trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-count" }, t(countKey("trash.count", data.trash.length), { count: data.trash.length })), data.trash.length ? data.trash.map(function (item) { return h("div", { key: item.id, className: "dsm-trash-item" }, h("div", { className: "dsm-trash-main" }, h("div", { className: "dsm-name" }, item.name), h("div", { className: "dsm-note" }, t("trash.deletedAt", { time: new Date(item.deletedAt).toLocaleString() }) + " · " + t("trash.source", { source: trashRootLabel(item) }))), h("button", { className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/trash-restore", { id: item.id }, "result.restored", { name: item.name }); } }, t("btn.restore")), h("button", { className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "delete-confirm", id: item.id, name: item.name }); } }, t("btn.delete.forever"))); }) : h("div", { className: "dsm-empty" }, t("trash.empty"))));
      if (modal && modal.type === "trash-confirm") content.push(h(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.trash.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { className: "dsm-btn", disabled: busy, onClick: function () { post("/delete", { root: modal.root, name: modal.name }, "result.trashed", { name: modal.name }).then(function () { setModal(null); }).catch(function () {}); } }, t("btn.trash")))));
      if (modal && modal.type === "delete-confirm") content.push(h(Modal, { key: "delete-confirm", title: t("confirm.delete.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.delete.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal("trash"); } }, t("btn.cancel")), h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/trash-delete", { id: modal.id }, "result.deleted", { name: modal.name }).then(function () { setModal("trash"); }).catch(function () {}); } }, t("btn.delete.forever")))));
      if (modal === "custom-add") content.push(h(Modal, { key: "custom-add", title: t("custom.add.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.path")), h("input", { className: "dsm-control", value: customForm.path, placeholder: t("custom.add.path.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { path: e.target.value })); } })), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.label")), h("input", { className: "dsm-control", value: customForm.label, placeholder: t("custom.add.label.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { label: e.target.value })); } })), h("p", { className: "dsm-help" }, t("custom.add.help")), result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null), h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { type: "button", className: "dsm-btn", disabled: busy || !String(customForm.path || "").trim(), onClick: submitCustomAdd }, t("custom.add.submit")))));
      if (modal && modal.type === "custom-remove-confirm") content.push(h(Modal, { key: "custom-remove-confirm", title: t("confirm.custom.remove.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.custom.remove.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitCustomRemove(modal.key, modal.name); } }, t("btn.custom.remove")))));
      return h("section", { className: "dsm-section" }, content);
    }

        var NS = 'dsh-plugin-tool-management'
        var t = function (key, params) {
          var s = (DICT.zh && DICT.zh[key]) || key
          if (params) Object.keys(params).forEach(function (k) { s = String(s).replace("{" + k + "}", params[k]) })
          return s
        }
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, DICT)
            t = ctx.locale.bind(NS)
          }
        } catch (e) { /* locale 服务缺失时退回内置词典 */ }

        module.exports.DICT = DICT
      },
    }
    return module.exports
  }
})
