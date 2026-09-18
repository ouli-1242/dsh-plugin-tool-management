// dsh-plugin-tool-management — durable client half (web bundle, ModuleLoader CJS format).
// Registers the "MCP 管理" settings page. Talks to the host half through the
// exact-path HTTP route /dsh-plugin-tool-management/api (same origin) instead of the
// dynamic-only host.call channel.
//
// 取词三件套（design-plan D25）——改文案前先确认当前处落在哪一支：
//   * `t`   —— apply 开头「取词服务」段绑定的那份取词（导航标题等**注册期**取值也走它）；
//              页面组件则经 props 拿到同一份（`pages.t`）。
//   * `mt`  —— MCP 页专用包装（定义在 apply 内）：模块作用域的 `t` 会被宿主 locale 覆盖，
//              它每次取值都取最新的那个，所以 MCP 页一律用 `mt`。
//   * `translateOrFallback(t, key, fallback)` —— 动态键（宿主回传的错误码等）缺失时的兜底文案。
// 三者共用同一份 DICT：键必须在 zh / en 两侧都存在（`npm run check:i18n` 会拦）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tool-management',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS =
      '.dsm-stat-row{display:flex;min-width:0;align-items:center;gap:10px}.dsm-stat-row .dsm-summary{flex:1;min-width:0}' +
      '.dsm-version{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;letter-spacing:.3px;line-height:1}' +
      '.dsm-failed{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:nowrap}' +
      '.dsm-row-hint{grid-column:1/-1;margin:-4px 0 9px;color:#d49245;font-size:11px;line-height:16px}' +
      '.dsm-tools{display:flex;flex-direction:column;gap:8px}' +
      '.dsm-tool{padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}' +
      '.dsm-tool-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;font-weight:600;word-break:break-all}' +
      '.dsm-tool-name-row{display:flex;align-items:center;gap:8px}' +
      // 标签紧跟工具名（原来是 space-between，标签被推到中间、与名字隔着一大片空白）；
      // 开关单独用 margin-left:auto 顶到最右，标签不再受它的位置影响。
      '.dsm-tool-name-row .dsm-switch{margin-left:auto;flex:none}' +
      '.dsm-tool-off .dsm-tool-name,.dsm-tool-off .dsm-tool-desc{opacity:.45}' +
      '.dsm-tool-desc{min-width:0;flex:1;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}' +
      '.dsm-tool-params{display:flex;flex-direction:column;gap:3px;margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l2)}' +
      '.dsm-tool-param{display:flex;gap:8px;font-size:11px;align-items:baseline}' +
      '.dsm-tool-param-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;min-width:80px;word-break:break-all}' +
      '.dsm-tool-param-type{color:var(--dsw-alias-label-tertiary);min-width:56px}' +
      '.dsm-tool-param-desc{flex:1;color:var(--dsw-alias-label-secondary);word-break:break-all}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-sm{min-height:88px}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-md{min-height:200px}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-lg{min-height:300px}' +
      '.dsm-detail-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.dsm-note-user{color:var(--dsw-alias-label-tertiary)}' +
      `
.dsm-hint{display:flex;min-width:0;align-items:center;gap:5px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsm-hint-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-hint-mark{display:inline-flex;width:14px;height:14px;flex:none;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;font-size:9px;line-height:1;cursor:help}.dsm-pick-list{display:flex;max-height:240px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:4px}.dsm-tabs-end{display:flex;align-items:center;gap:4px;margin-left:auto}.dsm-tab{padding:8px 14px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.dsm-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-success-primary)}.dsm-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:2px 0 36px;container-type:inline-size;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:inherit}.dsm-head{display:flex;flex-direction:column;align-items:stretch;gap:16px}.dsm-title-block{min-width:0}.dsm-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}.dsm-feedback-links{display:flex;flex-direction:column;align-items:flex-end;gap:2px}.dsm-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap}.dsm-feedback-link{display:inline-flex;min-height:28px;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;text-decoration:none;white-space:nowrap}.dsm-feedback-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsm-feedback-link:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-feedback-link svg{flex:none}.dsm-desc{margin:12px 0 0;display:-webkit-box;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;-webkit-box-orient:vertical;-webkit-line-clamp:2}.dsm-actions{display:flex;flex-wrap:wrap;gap:7px;margin-left:0;flex:none}
/* 页头动作行：内边距收 2px。批量按钮要按「取消全选」定宽（见 .dsm-btn-bulk），
   收这一点正好把定宽多出来的宽度抵掉，整行仍在一行内。 */
.dsm-actions .dsm-btn{padding:0 11px}
/* 窄栏再收一档（容器 ≤600px）：技能页 7 颗按钮最挤，上一档（11px 内边距 + 13px 字号）整行要
   ~560px，窄栏装不下时最后一颗「全选」会被挤到第二行（用户 2026-09-18 截图实测）。
   这一档同时收内边距、间距并降一档字号（12px，与 .dsm-btn-quiet 同档）→ 整行降到 ~486px。
   宽栏不受影响。阈值取 600 而不是贴着 560：不同机器的字体度量略有出入，交界处两档都装得下，
   不会正好卡在边界上换行；再窄（< ~486px）仍按原来的方式折行，行内按钮由下面 ≤520px
   那一档均分整行。 */
@container(max-width:600px){.dsm-actions{gap:6px}.dsm-actions .dsm-btn{padding:0 8px;font-size:12px}}
/* 「全选 ↔ 取消全选」二合一：两种文案都进 DOM、叠在同一格里，隐身那份只负责占位 →
   按钮宽度恒等于较宽的那个文案，点击不再改行宽、也就不会把整行挤到第二行。
   不写死像素是有意的：中文「取消全选」与英文 Deselect all 宽度差很多，各自自适应。
   注意选择器要写两段类名：.dsm-btn 的 display:inline-flex 在本规则之后出现，
   同权重下会赢，两段类名才是不依赖书写顺序的写法（改 CSS 时别顺手简化成一段）。 */
.dsm-btn.dsm-btn-bulk{display:inline-grid;align-items:center;justify-items:center}
.dsm-btn.dsm-btn-bulk>.dsm-bulk-label,.dsm-btn.dsm-btn-bulk>.dsm-bulk-ghost{grid-area:1/1}
.dsm-btn.dsm-btn-bulk>.dsm-bulk-ghost{visibility:hidden}
/* 纯图标按钮（如目录卡片上的「移除来源」）：与 quiet 按钮同高、只占一个图标宽。
   同样要两段类名 —— .dsm-btn / .dsm-btn-quiet 的 padding 在本规则之后出现，同权重会赢。 */
.dsm-btn.dsm-btn-icon{width:28px;min-width:28px;padding:0}
/* 目录卡片右侧动作组：间距收窄一档，配合图标化后不再显挤。 */
/* 卡片头里的标签抬到 11px：左侧「N 个技能」是 12px，10px 的标签在这里显得忽大忽小。 */
.dsm-source-head .dsm-tag{font-size:11px;min-height:20px;padding:0 7px}
/* 「N 个附件」标签：和 tag 同形，但它是**能点的**（点了去编辑弹窗的附件区），
   所以要把 button 的默认外观抹掉，并给一个可点的悬停反馈 —— 光靠颜色区分不出"能不能点"。 */
button.dsm-tag{background:transparent;font:inherit;font-size:10px;cursor:pointer}
button.dsm-tag:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
button.dsm-tag:disabled{cursor:default;opacity:.6}
.dsm-tag-attach{display:inline-flex;align-items:center;gap:4px}
.dsm-tag-attach-empty{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l3)}
.dsm-btn{box-sizing:border-box;display:inline-flex;min-height:34px;align-items:center;justify-content:center;padding:0 13px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:580;white-space:nowrap;cursor:pointer}.dsm-btn:hover:not(:disabled){filter:brightness(1.08)}.dsm-btn:disabled{opacity:.48;cursor:default}.dsm-btn-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.dsm-btn-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);min-height:28px;padding:0 9px;font-size:12px}.dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}.dsm-btn-lock{border-color:#d49245;background:transparent;color:#d49245}.dsm-btn:focus-visible,.dsm-control:focus-visible,.dsm-select-trigger:focus-visible,.dsm-source-head:focus-visible,.dsm-switch:focus-visible,.dsm-upload-link:focus-visible,.dsm-file-remove:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
.dsm-summary{display:grid;grid-template-columns:repeat(var(--dsm-stat-cols,3),minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-secondary)}.dsm-stat:last-child{border-right:0}.dsm-stat strong,.dsm-stat-num{margin-right:5px;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680}.dsm-filters{display:flex;gap:9px}.dsm-search{flex:1}.dsm-source-filter{width:210px;flex:none}
.dsm-token-panel{display:flex;flex-direction:column;gap:8px}.dsm-token-row{display:flex;gap:8px;align-items:center;min-width:0}.dsm-token-row .dsm-control{flex:1;min-width:0}
.dsm-control,.dsm-select-trigger{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm-control::placeholder{color:var(--dsw-alias-label-tertiary)}textarea.dsm-control{min-height:160px;padding-top:9px;resize:vertical;line-height:20px}.dsm-select{position:relative}.dsm-select-trigger{display:flex;align-items:center;justify-content:space-between;text-align:left;cursor:pointer}.dsm-select-menu{position:absolute;z-index:40;top:calc(100% + 5px);right:0;left:0;display:flex;max-height:260px;padding:5px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2)}.dsm-option{padding:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.dsm-option:hover,.dsm-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sources{display:flex;flex-direction:column;gap:9px}.dsm-source{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-source-head{box-sizing:border-box;display:flex;width:100%;min-height:48px;align-items:center;padding:0 13px}.dsm-source-head-main{display:flex;min-width:0;min-height:48px;flex:1;align-items:center;gap:10px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsm-source-head:hover,.dsm-row:hover,.dsm-trash-row:hover,.dsm-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-source-title{font-size:14px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-count{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}.dsm-path{min-width:0;margin-left:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm-source-actions{display:flex;align-items:center;gap:6px;margin-left:8px}.dsm-source-body{border-top:1px solid var(--dsw-alias-border-l1)}.dsm-source-note{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dsm-table-head,.dsm-row{display:grid;grid-template-columns:minmax(180px,1fr) 120px 90px max-content;align-items:center;column-gap:12px;padding:0 13px}.dsm-table-head{min-height:32px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-row{min-height:58px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-row:last-child{border-bottom:0}.dsm-main{min-width:0}.dsm-name{overflow:hidden;font-size:13px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.dsm-note{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.dsm-tag{display:inline-flex;min-height:19px;align-items:center;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}.dsm-tag-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.dsm-tag-off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.dsm-enabled{color:var(--dsw-alias-state-success-primary);font-size:12px;white-space:nowrap}.dsm-disabled{color:#d49245;font-size:12px;white-space:nowrap}.dsm-shadowed{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}.dsm-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}
.dsm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}.dsm-switch:after{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;content:"";transition:transform 160ms ease}.dsm-switch-on{background:var(--dsw-alias-state-success-primary)}.dsm-switch-on:after{transform:translateX(14px)}.dsm-switch:disabled{opacity:.45;cursor:default}.dsm-trash-row{display:flex;min-height:48px;align-items:center;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsm-trash-count{margin-left:auto;padding:2px 7px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}.dsm-empty{padding:25px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsm-feedback{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-warning{border-color:#d49245;color:#d49245}.dsm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.dsm-modal{box-sizing:border-box;display:flex;width:min(560px,100%)!important;max-height:min(760px,calc(100vh - 48px));min-width:0;flex-direction:column;gap:16px;padding:22px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.dsm-modal-sm,.dsm-modal-import{width:min(480px,100%)!important}.dsm-modal-md{width:min(560px,100%)!important}.dsm-modal-lg,.dsm-modal-wide{width:min(720px,100%)!important}.dsm-modal-list{width:min(560px,100%)!important;height:min(640px,calc(100vh - 48px))!important;max-height:none!important;overflow:hidden}.dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:10px}.dsm-modal-list .dsm-modal-body{flex:1;overflow:auto;overscroll-behavior:contain}.dsm-modal-import{padding:24px}.dsm-modal-head{display:flex;align-items:flex-start;gap:12px}.dsm-modal-title{margin:0;flex:1;font-size:17px;line-height:24px;font-weight:670}.dsm-form,.dsm-field,.dsm-detail-section{display:flex;flex-direction:column}.dsm-form{gap:12px}.dsm-field{gap:6px}.dsm-label,.dsm-detail-title{font-size:12px}.dsm-label{color:var(--dsw-alias-label-secondary)}.dsm-detail-title{font-weight:650}.dsm-help{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsm-help-list{display:flex;margin:0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.dsm-hidden-input{display:none}.dsm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color 180ms ease,background 180ms ease;cursor:pointer}.dsm-dropzone:hover,.dsm-dropzone-active{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsm-dropzone-title{color:var(--dsw-alias-label-primary);font-size:18px;font-weight:700}.dsm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dsm-upload-choices{display:flex;align-items:center;gap:7px}.dsm-upload-link,.dsm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsm-upload-link{color:var(--dsw-alias-label-secondary)}.dsm-upload-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.dsm-upload-link:disabled{opacity:.45;cursor:default}.dsm-upload-divider{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-file{display:flex;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}.dsm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700}.dsm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dsm-file-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.dsm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary);font-size:18px}.dsm-upload-requirements{padding:1px 1px 0}.dsm-upload-requirements ul{display:flex;margin:7px 0 0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-detail-section{gap:7px}.dsm-detail-path,.dsm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-detail-path{padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-all}.dsm-code{max-height:280px;margin:0;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:pre-wrap}.dsm-diag{padding:8px 10px;border-left:2px solid #d49245;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-trash-group-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsm-modal-title-row{display:inline-flex;align-items:center;gap:9px;min-width:0}
.dsm-pill{display:inline-flex;min-height:20px;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap}
.dsm-pill-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-pill-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-pill-warn{border-color:#d49245;color:#d49245}
.dsm-pill-muted{color:var(--dsw-alias-label-tertiary)}
.dsm-tool-desc-wrap{display:flex;align-items:flex-end;gap:8px}
.dsm-tool-desc-clamp{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dsm-tool-desc-toggle{flex:none;margin-left:auto;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.dsm-tool-desc-toggle:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsm-trash-group{display:flex;flex-direction:column;overflow:hidden;margin-bottom:12px;border:1px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
/* 「这组动的是磁盘文件」用左侧色条区分：中性 = 文件不动；危险色 = 真的会删文件。 */
.dsm-trash-group-danger{border-left-color:var(--dsw-alias-state-error-primary)}
.dsm-trash-group-danger .dsm-trash-group-title{color:var(--dsw-alias-state-error-primary)}.dsm-trash-group:last-child{margin-bottom:0}.dsm-trash-group-head{position:sticky;top:0;z-index:1;display:flex;flex-direction:column;align-items:stretch;gap:2px;min-height:40px;justify-content:center;padding:8px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsm-trash-group-head-row{display:flex;min-width:0;align-items:center;gap:8px}.dsm-trash-group-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}.dsm-trash-group-body{padding:0 13px}
.dsm-trash-item{display:flex;align-items:center;gap:9px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsm-trash-item:last-child{border-bottom:0}
.dsm-trash-main{min-width:0;flex:1}
/* 回收站列表体：固定高度 + 上下滑动（记忆 / 技能 / 子智能体 / 场景 / 提示词 五处共用） */
.dsm-trash-box{max-height:min(46vh,340px);overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}

/* 滚动条：宿主默认是「悬停才出现」的浮层滚动条 —— 固定高度的列表弹窗里，用户看不出
   还能往下滚，等于下面的条目不存在。插件给自己的滚动容器画一条**常驻**细滚动条
   （颜色走宿主变量，深浅主题都成立；不碰宿主其它地方的滚动条）。 */
.dsm-modal-list .dsm-modal-body,.dsm-trash-box,.dsm-pick-list,.dsm-seg-body,.dsm-dir-list,.dsm-trash-pane-body{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar,.dsm-trash-box::-webkit-scrollbar,.dsm-pick-list::-webkit-scrollbar,.dsm-seg-body::-webkit-scrollbar,.dsm-dir-list::-webkit-scrollbar,.dsm-trash-pane-body::-webkit-scrollbar{display:block;width:9px;height:9px}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-track,.dsm-trash-box::-webkit-scrollbar-track,.dsm-pick-list::-webkit-scrollbar-track,.dsm-seg-body::-webkit-scrollbar-track,.dsm-dir-list::-webkit-scrollbar-track,.dsm-trash-pane-body::-webkit-scrollbar-track{background:var(--dsw-alias-bg-layer-1)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-thumb,.dsm-trash-box::-webkit-scrollbar-thumb,.dsm-pick-list::-webkit-scrollbar-thumb,.dsm-seg-body::-webkit-scrollbar-thumb,.dsm-dir-list::-webkit-scrollbar-thumb,.dsm-trash-pane-body::-webkit-scrollbar-thumb{border-radius:99px;background:var(--dsw-alias-border-l2)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-thumb:hover,.dsm-trash-box::-webkit-scrollbar-thumb:hover,.dsm-pick-list::-webkit-scrollbar-thumb:hover,.dsm-seg-body::-webkit-scrollbar-thumb:hover,.dsm-dir-list::-webkit-scrollbar-thumb:hover,.dsm-trash-pane-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-corner,.dsm-trash-box::-webkit-scrollbar-corner,.dsm-pick-list::-webkit-scrollbar-corner,.dsm-seg-body::-webkit-scrollbar-corner,.dsm-dir-list::-webkit-scrollbar-corner,.dsm-trash-pane-body::-webkit-scrollbar-corner{background:transparent}

/* 列表弹窗的 body 是纵向 flex：直接子项一旦被 flex 收缩，而子项自己又是 overflow:hidden
   （.dsm-trash-group 正是），超出的条目会被**直接裁掉** —— 看不见、也滚不到，表现就是
   「没有滚动条 + 内容缺一截」。列表项的尺寸一律由内容决定，滚动只交给 body 这一层。 */
.dsm-modal-list .dsm-modal-body>*{flex:none}
.dsm-fm{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-fm-row{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr);gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}.dsm-fm-row:last-child{border-bottom:0}.dsm-fm-key{color:var(--dsw-alias-label-secondary);word-break:break-word}.dsm-fm-raw{margin-left:5px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}.dsm-fm-val{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap}
@container(max-width:780px){.dsm-table-head{display:none}.dsm-row{grid-template-columns:minmax(0,1fr) max-content;gap:8px;padding:11px 13px}.dsm-row>.dsm-tags,.dsm-row>.dsm-status{grid-column:1}.dsm-row-actions{grid-column:2;grid-row:1 / span 3}.dsm-path{display:none}
/* 一个标签都没有的记忆（flat 且没有场景 / 派生标签）：那一行是空的，高度 0 却仍要付两个
   8px 的行间距 —— 于是「描述」和「已启用」之间凭空多出 16px（用户实测）。让它不占位，
   并把右侧动作组的跨度跟着收到两行。**只在这一档布局里做**：宽布局下标签是固定 120px 的
   一列，抽掉它后面几列会整体左移。 */
.dsm-row>.dsm-tags:empty{display:none}
.dsm-row>.dsm-tags:empty~.dsm-row-actions{grid-row:1 / span 2}}@media(max-width:760px){.dsm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.dsm-title-row{flex-wrap:wrap}}@container(max-width:520px){.dsm-head{flex-direction:column}.dsm-actions{width:100%;margin-left:0}.dsm-actions .dsm-btn{flex:1}.dsm-filters{flex-direction:column}.dsm-source-filter{width:100%}.dsm-summary{grid-template-columns:1fr}}
.dsm-hist-row{display:flex;align-items:center;gap:11px;padding:10px 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-hist-row:last-child{border-bottom:0}.dsm-hist-main{min-width:0;flex:1}.dsm-hist-title{overflow:hidden;font-size:13px;font-weight:580;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd-missing{color:var(--dsw-alias-state-error-primary)}.dsm-hist-actions{display:flex;gap:6px;flex:none}.dsm-hist-check,.dsm-hist-group-check{flex:none;width:15px;height:15px;margin:0 4px 0 0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}.dsm-hist-group-head{gap:10px}.dsm-hist-group-extra{display:flex;align-items:center;gap:8px;flex:none;margin-left:4px}.dsm-hist-group-extra .dsm-tag{flex:none}.dsm-hist-dir-missing{flex:none;color:var(--dsw-alias-state-error-primary);font-size:11px;white-space:nowrap}.dsm-hist-register-path{margin-top:-4px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,monospace);font-size:11px;word-break:break-all}.dsm-hist-batch{display:flex;align-items:center;gap:8px;margin-left:2px;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l2)}.dsm-hist-batch-count{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsm-hist-batch-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none}.dsm-dir-row{display:flex;gap:8px}.dsm-dir-row .dsm-control{flex:1}.dsm-dir-list{display:flex;max-height:220px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-dir-item{display:flex;width:100%;align-items:center;padding:8px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.dsm-dir-item:last-child{border-bottom:0}.dsm-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-dir-item::before{content:"📁";margin-right:8px;font-size:12px}
.dsm-rule-shadowed .dsm-name,.dsm-rule-shadowed .dsm-note{color:var(--dsw-alias-state-error-primary)}.dsm-rule-off .dsm-name,.dsm-rule-off .dsm-note{color:var(--dsw-alias-label-tertiary)}.dsm-rule-shadow-hint{margin-top:3px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-invalid{border-color:var(--dsw-alias-state-error-primary)!important}.dsm-rule-hint{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-budget{display:flex;flex-direction:column;gap:6px}.dsm-budget-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.dsm-budget-meta strong{margin-right:0;font-size:13px;font-weight:680}.dsm-budget-over-text{color:var(--dsw-alias-state-error-primary);font-size:11px}.dsm-budget-bar{height:6px;overflow:hidden;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover)}.dsm-budget-fill{height:100%;border-radius:99px;background:var(--dsw-alias-state-success-primary);transition:width 160ms ease}.dsm-budget-fill.dsm-budget-over{background:var(--dsw-alias-state-error-primary)}.dsm-char-count{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-char-over{color:var(--dsw-alias-state-error-primary)}
.dsm-combo-row{display:flex;gap:8px}.dsm-combo-row .dsm-control{flex:1}
.dsm-attach-list{display:flex;flex-direction:column;gap:6px}.dsm-attach-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsm-toast{position:fixed;right:22px;bottom:22px;z-index:1250;box-sizing:border-box;max-width:min(420px,calc(100vw - 44px));padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;animation:dsm-toast-in 160ms ease-out}@keyframes dsm-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.dsm-toast{animation:none}}
/* ── 勾选段（场景档案编辑器 / 任何「多选一组条目」的地方共用同一套排版）────────────
   .dsm-seg  一段（标题栏 + 固定高度滚动体 + 脚注）；高度固定，勾选内容增减不会让弹窗跳动。
   .dsm-pick 一行选项（复选框 + 名称/说明 + 右侧指标 + 可选行内动作）。 */
.dsm-seg{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsm-seg-head{display:flex;min-height:42px;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsm-seg-title{min-width:0;font-size:13px;font-weight:620;white-space:nowrap}
.dsm-seg-count{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-seg-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.dsm-seg-body{display:flex;height:216px;padding:6px;overflow:auto;flex-direction:column}
/* 滚动容器里的子项不许被压缩：否则内容一多，筛选框会被压到比 input 还矮、与下面的条目叠在一起。 */
.dsm-seg-body>*{flex:none}
.dsm-seg-foot{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsm-pick{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px}.dsm-mcp-edit-tools-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsm-mcp-edit-tools-actions{display:flex;align-items:center;gap:8px}.dsm-seg-empty-actions{display:flex;justify-content:center;padding:4px 0 12px}.dsm-seg-empty-error{padding:0 10px 10px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;text-align:center}
.dsm-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-pick input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
/* .dsm-pick-main 必须是**纵向 flex**：它原本只是个行内 span，名称与说明会在同一行里内联排布，
   而 text-overflow:ellipsis 对行内元素无效 → 长描述直接横向溢出段边框（实测溢出 353px）。
   改成列向 flex 后两行各自成为块级子项，各自单行省略。 */
.dsm-pick-main{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}
.dsm-pick-name{overflow:hidden;font-size:13px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-desc{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-meta{display:flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-pick-actions{display:flex;align-items:center;gap:6px;flex:none}
.dsm-pick-empty{padding:18px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.dsm-archive-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
/* 档案弹窗固定高度：加/删段、进出「选工具」子视图都不改变弹窗尺寸。 */
.dsm-modal-archive{height:min(720px,calc(100vh - 48px))}
.dsm-modal-archive .dsm-form{min-height:0;gap:10px;overflow:auto}
/* 段体高度：min-height 给下限、flex-shrink:0 保证下限优先（四项都在时也各占 300px），
   装不下由 .dsm-form 整体滚动。列表自身 overflow:auto，永远是它出滚动条。
   注意不要写成 flex:1 平分——那样四项分 720px 每段只剩约 155px，比原来的固定 216px 还矮。 */
.dsm-modal-archive .dsm-seg{min-height:300px;flex:0 0 auto}
.dsm-modal-archive .dsm-seg-body{height:auto;flex:1 1 auto}
/* ── 段内筛选（场景/记忆等条目多的选段用；条目少时不必显示）────────────────────
   .dsm-seg-filter 段体顶部的搜索行；.dsm-seg-cards 场景卡片列表（比纯勾选行信息量大）。 */
.dsm-seg-filter{display:flex;align-items:center;gap:8px;padding:6px 6px 8px}
.dsm-seg-filter .dsm-control{min-height:30px;font-size:12px}
.dsm-seg-group{display:flex;align-items:center;gap:8px;padding:7px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-seg-group-line{height:1px;flex:1;background:var(--dsw-alias-border-l1)}
.dsm-seg-sub{padding-left:22px}
.dsm-seg-more{padding:6px 8px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px}
/* ── 场景页（场景档案）────────────────────────────────────────────────────
   四类信息各占一行，互不挤：标题行（名字/别名/标签/开关）、描述行（单行省略）、动作行（主次按钮）。
   卡片上**不再出现数量**（记忆条数、已配 N 台 MCP…）：它们是上次「卡片显得杂乱」的直接来源，
   现在统一收进页首的「当前模式」条里，只有一处。 */
/* 当前模式条：只在进入模式后出现（没有条 = 自由模式，不需要常驻的解释文案）。 */
.dsm-mode-bar{display:flex;min-width:0;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-mode-bar .dsm-btn{margin-left:auto;flex:none}
.dsm-mode-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsm-mode-main{min-width:0;flex:1}
.dsm-mode-title{overflow:hidden;font-size:13px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}
.dsm-mode-sub{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}
.dsm-scenes{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.dsm-scene-tile{display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-scene-tile-mode{border-color:var(--dsw-alias-state-success-primary)}
.dsm-scene-tile-head{display:flex;min-width:0;align-items:center;gap:7px;padding:11px 12px 0}
.dsm-scene-tile-name{overflow:hidden;font-size:14px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.dsm-scene-tile-key{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}
.dsm-scene-tile-head .dsm-tag{flex:none}
.dsm-scene-tile-switch{margin-left:auto;flex:none}
.dsm-scene-tile-desc{overflow:hidden;margin:5px 0 0;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-scene-tile-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:11px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-scene-tile-links{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto}
@container(max-width:640px){.dsm-scenes{grid-template-columns:1fr}}
.dsm-tools-grid{display:flex;max-height:180px;padding:6px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsm-tools-grid>*{flex:none}
.dsm-tools-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dsm-chip{display:inline-flex;min-height:22px;align-items:center;gap:5px;padding:0 7px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsm-chip-deny{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-chip button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}
/* ── 高级选项折叠区（人设表单；默认收起，展开后才拉候选数据）────────────────── */
.dsm-adv{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.dsm-adv-head{display:flex;width:100%;min-height:40px;align-items:center;gap:8px;padding:0 11px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsm-adv-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-adv-caret{color:var(--dsw-alias-label-tertiary);font-size:10px}
.dsm-adv-body{display:flex;flex-direction:column;gap:12px;padding:11px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-adv-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
/* ── 工具限制四行（人设表单：一行一个 Agent 预设，白/黑名单互斥、默认折叠）──────── */
.dsm-modes{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dsm-mode-row{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsm-mode-row.dsm-mode-on{border-color:var(--dsw-alias-border-l3)}
.dsm-mode-head{display:flex;min-height:38px;align-items:center;gap:9px;padding:0 10px}
/* 行首是按钮：已配好的模式点它就展开/收起名单（右侧两个按钮只管启用/停用，两者别混）。 */
.dsm-mode-head-main{display:flex;min-width:0;flex:1;align-items:center;gap:9px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsm-mode-head-main:disabled{cursor:default}
.dsm-mode-head-main:not(:disabled):hover .dsm-mode-name{color:var(--dsw-alias-label-primary)}
.dsm-mode-caret{flex:none;width:10px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.dsm-mode-name{font-size:12px;font-weight:570;white-space:nowrap}
.dsm-mode-sum{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-mode-sum.dsm-mode-allow{color:var(--dsw-alias-state-success-primary)}
.dsm-mode-sum.dsm-mode-deny{color:#d49245}
.dsm-mode-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.dsm-mode-btn-allow{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-mode-btn-deny{border-color:#d49245;color:#d49245}
.dsm-mode-body{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-legacy{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
/* ── 兼容页（宿主能力体检）──────────────────────────────────────────────
   一块"体检报告"：先给结论卡，再给动作可用性、降级项、模块实体、阻塞项。
   状态色只用设计系统里已有的三档：成功 / 告警(#d49245) / 错误。 */
.dsm-compat{display:flex;flex-direction:column;gap:14px}
.dsm-compat-bar{display:flex;min-width:0;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-bar-warn{border-color:#d49245}
.dsm-compat-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsm-compat-dot-warn{background:#d49245}
.dsm-compat-bar strong{margin:0;font-size:13px;font-weight:650}
.dsm-compat-sum{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
/* 三个指标格：左对齐、等分，窄屏落成单列。 */
.dsm-compat-grid{display:grid;gap:10px;grid-template-columns:repeat(3,minmax(0,1fr))}
.dsm-compat-card{display:flex;min-width:0;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-card-bad{border-color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-compat-card-value{color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680;line-height:22px;word-break:break-all}
.dsm-compat-card-value-bad{color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-note{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-compat-section{display:flex;min-width:0;flex-direction:column;gap:7px}
.dsm-compat-section-head{display:flex;min-width:0;align-items:baseline;gap:8px}
.dsm-compat-section-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:650;white-space:nowrap;flex:none}
/* 说明文字：占满剩余宽度，放不下就换行（标题已 nowrap；此前用省略号截断，用户 2026-09-17
   指出"注入实况后面那句被截断了" —— 那行是状态信息，截断等于看不全）。 */
.dsm-compat-section-hint{min-width:0;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
/* 动作可用性：一行一个动作 + 路径标记，窄容器落成"名称在上、标记在下"。 */
.dsm-compat-mod-list{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-mod-row{display:flex;min-height:38px;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsm-compat-mod-row:last-child{border-bottom:0}
.dsm-compat-mod-list.dsm-compat-cards .dsm-compat-mod-row{display:grid;min-height:0;grid-template-columns:minmax(0,1fr) max-content;gap:4px 10px;padding:9px 12px}
.dsm-compat-mod-self{grid-column:1/-1}
.dsm-compat-mod{min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:17px;word-break:break-word}
.dsm-compat-mod-sep{color:var(--dsw-alias-label-tertiary)}
.dsm-compat-pill{display:inline-flex;min-height:20px;flex:none;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dsm-compat-pill-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-compat-pill-warn{border-color:#d49245;color:#d49245}
.dsm-compat-reach-marks{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;min-width:0}
.dsm-inject-settings{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
/* 注入域勾选：横排、窄容器自动换行；标签一律短名（记忆 / MCP / …），不截断也不竖排。 */
.dsm-inject-domains{display:flex;flex-wrap:wrap;gap:7px 18px;padding:0 2px}
.dsm-inject-domain{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsm-inject-domain input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
/* 注入实况（只读）：与「注入」设置同屏。行 = 域 + 体积 + 状态胶囊，点域名展开正文。 */
.dsm-inject-live-actions{display:flex;flex:none;align-items:center;gap:6px;margin-left:auto}
.dsm-inject-live-toggle{padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dsm-inject-live-toggle:hover{text-decoration:underline}
.dsm-inject-live-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
/* 没有正文可展开的行：用一个看不见的同字符占位，把展开箭头那一格宽度留出来，
   这样所有行的域名左缘才会在同一条竖线上（用户 2026-09-17 指出参差不齐）。
   占位与文字放在**同一个** flex 子项里（.dsm-inject-live-static），否则 name 格的
   gap:0 6px 会在它们之间再插一段间距，比可展开的行多出 6px。 */
.dsm-inject-live-mark-blank{visibility:hidden}
.dsm-inject-live-size{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
/* 实况面板的域名格里有多个行内元素（域名 / 体积 / 采纳统计），行内元素之间没有空白节点，
   不设间距就会挤成「场景和记忆· 3.2 KB」。
   刻意**不复用** .dsm-compat-name：那一类在另外五个面板里只放一个文本子节点，改成 flex 会让
   长标签变成不可收缩的 flex 项 → 窄容器下溢出而不是换行。所以只在实况面板这一处加 gap。 */
.dsm-inject-live-name{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px}
/* 采纳一行（注入 N 次 / 调用 M 次 / 采纳 K 次）：刻意用中性灰而不是琥珀 —— 胶囊的琥珀
   只表示"该投却没投"这一个故障；"投了但模型没伸手"是数据，不是故障，颜色留给数字说话。 */
.dsm-inject-live-adopt{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-reach-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dsm-reach-chip{display:inline-flex;min-height:22px;align-items:center;padding:0 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dsm-reach-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-reach-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-reach-unknown{color:var(--dsw-alias-label-tertiary)}
.dsm-compat-pill-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-compat-name{min-width:0;flex:1;font-size:12px;font-weight:560;word-break:break-word}
.dsm-compat-label{margin-right:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-compat-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsm-compat-list{margin:0;padding-left:16px}.dsm-compat-list li+li{margin-top:4px}
@container(max-width:640px){.dsm-compat-grid{grid-template-columns:1fr}}
html,body{scrollbar-gutter:stable}.dsm-settings-scroll-host{overflow-y:scroll!important;scrollbar-gutter:stable}.dsm-tabs-shell{position:sticky;top:0;z-index:6;display:flex;min-width:0;align-items:center;gap:6px;margin-bottom:14px;padding-top:2px;background:var(--dsw-alias-bg-layer-2)}.dsm-tabs{display:grid;min-width:0;flex:1;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:0;overflow:hidden;margin-bottom:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-tab{box-sizing:border-box;width:100%;min-width:0;padding-right:4px;padding-left:4px;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.dsm-feedback-link{width:30px;height:30px;box-sizing:border-box;padding:0;justify-content:center}.dsm-feedback-link svg{width:16px;height:16px}@container(max-width:620px){.dsm-tab{padding-right:2px;padding-left:2px;font-size:11px}}
/* 动作可用性表：表头列宽与 dsm-compat-mod-row 一致；窄容器下隐藏表头。 */
.dsm-compat-table-head{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-compat-cards .dsm-compat-table-head{display:none}
/* 导出弹窗（D14）：宽高都固定；只有「条目列表」这一层滚动，动作条常驻底部。 */
.dsm-export-modal .dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:14px;overflow:hidden}
.dsm-export-modal .dsm-export-form{display:flex;min-height:0;flex:1;flex-direction:column;gap:10px}
.dsm-export-modal .dsm-pick-list{flex:1;min-height:0;max-height:none;overflow:auto}
.dsm-export-modal .dsm-export-body{display:flex;min-height:0;flex:1;flex-direction:column;gap:6px}
.dsm-pick-group{display:flex;flex-direction:column}
.dsm-pick-group-head{box-sizing:border-box;display:flex;width:100%;min-width:0;align-items:center;gap:7px;padding:7px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;text-align:left;cursor:pointer}
.dsm-pick-group-head:hover{color:var(--dsw-alias-label-primary)}
.dsm-pick-caret{flex:0 0 auto;width:12px;color:var(--dsw-alias-label-tertiary)}
.dsm-pick-group-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-group-count{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-weight:500}
.dsm-pick-group .dsm-pick{margin-left:16px}
.dsm-pick-group .dsm-pick+.dsm-pick{margin-top:2px}

/* 技能回收站：上下两块各占一半（目录 / 技能），滚动条在每块列表区里面，大弹窗自己不滚。
   必须放在最后：盖过上面的 .dsm-modal-list .dsm-modal-body>*{flex:none}，
   否则外层不撑满、两块就各按内容长，50/50 失效。宽度沿用 .dsm-modal-list 的 560px。 */
.dsm-modal-trash-split .dsm-modal-body{overflow:hidden}
.dsm-modal-trash-split .dsm-trash-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:12px}
.dsm-modal-trash-split .dsm-trash-group{margin-bottom:0;min-height:0}
.dsm-modal-trash-split .dsm-trash-pane-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 13px}

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

    /**
     * 「两种状态文案 + 定宽」的按钮内容：两份文案都渲染、叠在同一格，隐身那份只负责占位
     * （配合 `.dsm-btn.dsm-btn-bulk` 的两段类名选择器）—— 按钮宽度恒等于较宽的那个文案，
     * 状态切换时按钮不跳宽、整行也不重排。「全选 ↔ 取消全选」与「刷新 ↔ 刷新中…」共用这一套。
     * 不写死像素宽度是有意的：中文「取消全选 / 刷新中…」与英文各自自适应，加语言不用改样式。
     */
    function fixedLabelPair(label, other) {
      return [
        React.createElement('span', { key: 'v', className: 'dsm-bulk-label' }, label),
        React.createElement('span', { key: 'g', className: 'dsm-bulk-ghost', 'aria-hidden': 'true' }, other),
      ]
    }

    /**
     * 垃圾桶图标：给「移除来源」这类破坏性操作做纯图标按钮用（按钮本身必须带 title /
     * aria-label —— 图标按钮没有可见文字，说明只能靠它们，别省）。
     */
    function TrashIcon(props) {
      var size = (props && props.size) || 14
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', { fill: 'currentColor', d: 'M6.5 1h3l.5 1h3v1.5H3V2h3zM4 5h8l-.6 9.2a1 1 0 0 1-1 .8H5.6a1 1 0 0 1-1-.8z' }))
    }

    /**
     * 回形针图标：bundle 记忆的「N 个附件」标签用（表示"随记忆一起存放的文件"）。
     * 只有一并带文字时才用它 —— 纯图标按钮的说明必须写在 title / aria-label 里。
     */
    function PaperclipIcon(props) {
      var size = (props && props.size) || 11
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', { d: 'M9.6 4.2 5.1 8.7a1.9 1.9 0 0 0 2.7 2.7l5-5a3.4 3.4 0 0 0-4.8-4.8L3 6.6a4.9 4.9 0 0 0 6.9 6.9l4.1-4.1' }))
    }

    /**
     * 刷新按钮（全站八处管理页共用：MCP / 技能 / 提示词 / 会话 / 场景 / 子智能体 / 记忆 / 兼容）。
     * 宽度同样按两种文案里更宽的那个固定（见 fixedLabelPair），所以点一下「刷新」不会因为
     * 文案变成「刷新中…」把整行挤走。
     *
     * @param tFn  取词函数 —— MCP 页传 `mt`（模块作用域的 t 会被宿主 locale 覆盖），其余页传各自的 t
     * @param busy 是否正在刷新：决定显示哪份文案（通常也同时决定 disabled）
     * @param args 透传给 <button> 的其余属性（className / disabled / onClick / title …）
     */
    function refreshButton(tFn, busy, args) {
      var idle = tFn('btn.refresh')
      var working = tFn('btn.refreshing')
      // 定宽靠 `.dsm-btn.dsm-btn-bulk`（两段类名，见 CSS 里的注释）—— 由这里统一补上，
      // 调用方只管自己的样式，不用记这个类。
      var cls = ((args && args.className) || 'dsm-btn dsm-btn-secondary') + ' dsm-btn-bulk'
      return React.createElement('button', Object.assign({ type: 'button' }, args, { className: cls }),
        fixedLabelPair(busy ? working : idle, busy ? idle : working))
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

    /**
     * 改令牌并落盘。明文机密 op（mcpm-reveal / mcpm-export）在宿主侧**必须**带对令牌，
     * 没配令牌时一律拒绝 —— 所以界面得有个地方让用户把令牌填进来，否则那功能永远打不开。
     * 令牌只存本机 localStorage，随请求以 x-dsh-token 发出。
     */
    function setAccessToken(value) {
      TOKEN = String(value || '').trim()
      try {
        if (TOKEN) window.localStorage.setItem('dsh-plugin-tool-management-token', TOKEN)
        else window.localStorage.removeItem('dsh-plugin-tool-management-token')
      } catch (e) { /* storage unavailable */ }
      return TOKEN
    }

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
    function VersionBadgeComponent() {
      const [v, setV] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        apiCall('plugin-version', {}).then((r) => { if (alive && r && r.ok) setV(r.version) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return v ? React.createElement('span', { className: 'dsm-version' }, 'v' + v) : null
    }

    // ── 兼容页（/compat-status 的只读投影）──────────────────────────────────────
    // 排布按"先看结论、再看明细"：结论条 → 指标卡 → 阻塞项 → 动作可用性 →
    // 降级能力 → 模块实体 → 命令行提示。回答的是"能不能安全动数据"。
    var OPERATION_LABELS = {
      list: 'compat.op.list', archive: 'compat.op.archive', unarchive: 'compat.op.unarchive',
      batch: 'compat.op.batch', delete: 'compat.op.delete',
    }
    /** 每个操作走哪条路线：仅当有"原生委托"能力可用时才算原生。 */
    function operationRoutes(data) {
      const findings = (data && data.findings) || []
      const byId = {}
      findings.forEach(function (f) { byId[f.id] = f })
      const ok = function (id) { return byId[id] === undefined || byId[id].state === 'ok' }
      const routes = {}
      routes.list = ok('workspace.read-state') && ok('workspace.read-table') && ok('workspace.index-shape') ? 'adapter' : 'none'
      routes.archive = ok('workspace.archive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.unarchive = ok('workspace.unarchive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.batch = ok('workspace.batch-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.delete = ok('workspace.delete-native') ? 'native'
        : (ok('workspace.enqueue') && ok('workspace.set-state') && ok('workspace.index-header')
          && ok('sessions.detach-live') && ok('sessions.cold-announce') && ok('projection.delete-native') ? 'adapter' : 'none')
      return routes
    }

    function CompatPage(props) {
      const t = props.t
      const [data, setData] = React.useState(null)
      const [presetReach, setPresetReach] = React.useState(null)
      // 注入设置（本插件五个注入域的开关；见 src/context-inject.ts）。它和可达性矩阵是一体两面：
      // 矩阵说"到不到得了"，这里决定"要不要"。读不到时这一节不显示。
      const [inject, setInject] = React.useState(null)
      // 注入实况（只读）：最近活跃会话里模型**真正看到**的五域文本 + 本次运行的投递统计。
      // 与「注入」设置是一体两面：设置说"要送什么"，这里说"实际送到了什么"。
      const [live, setLive] = React.useState(null)
      const [liveOpen, setLiveOpen] = React.useState('')
      const [liveCopied, setLiveCopied] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const apply = function (r, alive) {
        if (alive === false) return
        if (r && r.ok) { setData(r); setError(null) } else { setError((r && r.error) || 'unknown') }
        setBusy(false)
      }
      // 预设可达性是独立的一面镜子：它取不到只意味着这一节不显示，
      // 绝不让它的失败顶掉 compat-status 的结论。
      const applyReach = function (r, alive) {
        if (alive === false) return
        if (r && r.ok) setPresetReach(r)
      }
      const loadReach = function (alive) {
        apiCall('preset-reach', {})
          .then(function (r) { applyReach(r, alive) })
          .catch(function () { /* 未挂载预设服务 → 不渲染这一节 */ })
      }
      const loadInject = function (alive) {
        apiCall('inject-settings', {})
          .then(function (r) { if (alive !== false && r && r.ok && r.settings) setInject(r.settings) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      const loadLive = function (alive) {
        apiCall('injection-live', {})
          .then(function (r) { if (alive !== false && r && r.ok) setLive(r) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      React.useEffect(function () {
        let alive = true
        setBusy(true)
        apiCall('compat-status', { refresh: true })
          .then(function (r) { apply(r, alive) })
          .catch(function (e) { if (alive) { setError(String((e && e.message) || e)); setBusy(false) } })
        loadReach(alive)
        loadInject(alive)
        loadLive(alive)
        return function () { alive = false }
      }, [])
      const reload = function () {
        setBusy(true)
        apiCall('compat-status', { refresh: true })
          .then(function (r) { apply(r, true) })
          .catch(function (e) { setError(String((e && e.message) || e)); setBusy(false) })
        loadReach(true)
        loadInject(true)
        loadLive(true)
      }
      // 保存注入设置：先乐观更新界面（点一下就该有反馈），服务端返回值到达后以其为准；
      // 失败则重新拉一次。可达性矩阵跟着刷新 —— 芯片要反映新的开关状态。
      const saveInject = function (patch) {
        if (!inject) return
        const next = Object.assign({}, inject, patch)
        setInject(next)
        apiCall('inject-settings', Object.assign({ set: true }, next))
          .then(function (r) {
            if (r && r.ok && r.settings) setInject(r.settings)
            loadReach(true)
          })
          .catch(function () { loadInject(true); loadReach(true) })
      }

      const findings = (data && data.findings) || []
      const degraded = (data && data.degraded) || []
      const blockers = (data && data.blockers) || []
      const routes = operationRoutes(data)
      const sameAsHost = (data && data.sameAsHost) || {}
      const separateCopies = Object.keys(sameAsHost).filter(function (name) { return sameAsHost[name] === false })
      const healthy = degraded.length === 0 && blockers.length === 0 && separateCopies.length === 0
      // 可用 = 探测通过 + 宿主没有但插件自己顶上的（optional）。
      // 后者若不算进分子，本机这种"官方缺三个入口"的正常形态会显示成 12/15，
      // 让人以为三成能力坏了 —— 实际上它们全部可用。
      const usableCount = findings.filter(function (item) { return item.state === 'ok' || item.optional === true }).length
      // 真正拦路的只有"宿主有该服务但缺关键成员"（如 requireState 改名）与未解析的包。
      const blockedCount = degraded.length
        + Object.keys(sameAsHost).filter(function (name) { return sameAsHost[name] === false }).length
      const unavailableCount = Object.keys(OPERATION_LABELS).filter(function (op) { return routes[op] === 'none' }).length

      const routeClass = function (via) {
        return 'dsm-compat-pill' + (via === 'none' ? ' dsm-compat-pill-bad' : via === 'native' ? ' dsm-compat-pill-ok' : '')
      }
      const routeText = function (via) {
        return via === 'none' ? t('compat.op.unavailable') : via === 'native' ? t('compat.op.native') : t('compat.op.adapter')
      }
      const card = function (label, value, note, bad) {
        return React.createElement('div', { className: 'dsm-compat-card' + (bad ? ' dsm-compat-card-bad' : '') },
          React.createElement('span', { className: 'dsm-compat-card-label' }, label),
          React.createElement('strong', { className: 'dsm-compat-card-value' + (bad ? ' dsm-compat-card-value-bad' : '') }, value),
          note ? React.createElement('span', { className: 'dsm-compat-card-note' }, note) : null)
      }
      const section = function (title, hint, body) {
        return React.createElement('section', { className: 'dsm-compat-section' },
          React.createElement('div', { className: 'dsm-compat-section-head' },
            React.createElement('h3', { className: 'dsm-compat-section-title' }, title),
            hint ? React.createElement('span', { className: 'dsm-compat-section-hint' }, hint) : null),
          body)
      }

      const body = []
      // 块级子项统一在这里加 key：`body` 是数组，React 要求每个直接子项有稳定 key。
      const push = function (node) {
        body.push(React.cloneElement(node, { key: 'compat-' + String(body.length) }))
      }
      // 注入设置块（就放在刷新按钮下面）：本插件注入给模型哪些内容的开关。总开关只管
      // "极简这类预设下要不要破例"，五个域勾选在任何预设下都生效。
      //
      // 排版口径（用户裁定 2026-09-16）：勾选**横排**（短标签一行放得下，不再一人一行竖着排），
      // 文案只说到"有这个内容"为止 —— 用户是普通使用者，不解释 persona/载体/路径这些内部机制。
      if (inject) {
        const domains = (inject && inject.domains) || {}
        push(section(t('compat.inject'), t('compat.inject.hint'),
          React.createElement('div', { className: 'dsm-inject-settings' },
            React.createElement('label', { className: 'dsm-pick' },
              React.createElement('input', { type: 'checkbox', checked: inject.underSuppressingPresets === true, onChange: function () { saveInject({ underSuppressingPresets: inject.underSuppressingPresets !== true }) } }),
              React.createElement('span', { className: 'dsm-pick-main' },
                React.createElement('span', { className: 'dsm-pick-name' }, t('compat.inject.force')),
                React.createElement('span', { className: 'dsm-pick-desc' }, t('compat.inject.force.desc')))),
            React.createElement('div', { className: 'dsm-seg-group' },
              React.createElement('span', null, t('compat.inject.domains')),
              React.createElement('span', { className: 'dsm-seg-group-line' })),
            React.createElement('div', { className: 'dsm-inject-domains' },
              ['memory', 'mcp', 'skills', 'subagents', 'prompt'].map(function (key) {
                // 技能与提示词两域在标准类预设下由宿主送、本插件让位 —— 关掉它们时本插件会连
                // 宿主那条一起拦下（见 context-inject.ts 的 officialKindsToSuppress）。这里给
                // 那两项一句 title，免得用户以为"关了没用"。
                const carrier = key === 'skills' || key === 'prompt'
                return React.createElement('label', { className: 'dsm-inject-domain', key: 'domain-' + key, title: carrier ? t('compat.inject.domain.carrier.title') : undefined },
                  React.createElement('input', { type: 'checkbox', checked: domains[key] !== false, onChange: function () {
                    const nextDomains = Object.assign({}, domains)
                    nextDomains[key] = domains[key] === false
                    saveInject({ domains: nextDomains })
                  } }),
                  React.createElement('span', null, t('compat.inject.domain.' + key)))
              })))))
      }
      // 注入实况：紧挨「注入」设置块下方。数据来自 `injection-live`（宿主读最近活跃会话的
      // 可见表面），是"回放"不是"重算"—— 界面显示已注入而模型实际没收到时（场景接管、
      // 压制型预设、开关被关、压缩后还没补发），这里一眼可见。
      // 排版口径：与可达性矩阵同款（名称 + 状态胶囊），正文默认收起、点域名展开；
      // 体积与 ≈tokens 只做展示（token 是估算，标「≈」）。
      if (live) {
        const domainLabel = function (key) { return t('compat.inject.domain.' + key) }
        const fmtSize = function (bytes) {
          var v = Number(bytes) || 0
          if (v < 1024) return v + ' B'
          return (Math.round((v / 1024) * 10) / 10) + ' KB'
        }
        // 中英混合估算：ASCII 按 4 字符/词、非 ASCII 按 2 字符/词（只影响展示）。
        const estTokens = function (text) {
          var ascii = 0
          var wide = 0
          for (var i = 0; i < text.length; i += 1) { if (text.charCodeAt(i) < 128) ascii += 1; else wide += 1 }
          return Math.ceil(ascii / 4 + wide / 2)
        }
        // 状态 → 胶囊：绿 = 本插件注入且已在上下文；琥珀只留给"该投却没投"。
        // 官方载体（技能 / 提示词在标准类预设下由官方送）、已关闭、无内容一律灰的
        // —— 它们都不是问题，报成琥珀会把用户自己的选择读成故障（用户 2026-09-16 指出）。
        const stateOf = function (row) {
          if (row.state === 'in-context') return { cls: ' dsm-compat-pill-ok', text: t('compat.live.state.inContext'), title: '' }
          if (row.state === 'absent') return { cls: ' dsm-compat-pill-warn', text: t('compat.live.state.absent'), title: t('compat.live.state.absent.title') }
          if (row.state === 'official') return { cls: '', text: t('compat.live.state.official'), title: t('compat.live.state.official.title') }
          if (row.state === 'off') return { cls: '', text: t('compat.live.state.off'), title: '' }
          if (row.state === 'empty') return { cls: '', text: t('compat.live.state.empty'), title: '' }
          if (row.state === 'cleared') return { cls: '', text: t('compat.live.state.cleared'), title: '' }
          // 子会话不适用：与「已关闭 / 无内容」同档的灰 —— 它是设计选择，不是故障。
          if (row.state === 'child') return { cls: '', text: t('compat.live.state.child'), title: t('compat.live.state.child.title') }
          return { cls: '', text: t('compat.live.state.unknown'), title: '' }
        }
        // 采纳一行：注入 N 次 / 调用 M 次 / 其中"调用时正文就在眼前"K 次。
        // 只在真的投递过该域时出现 —— 从没投过的域摆一行 0 只是噪声。
        const adoptText = function (row) {
          const a = row.adoption || {}
          const injected = Number(a.injected) || 0
          if (injected === 0) return ''
          const used = Number(a.used) || 0
          if (used === 0) return t('compat.live.adopt.none', { injected: injected })
          return t('compat.live.adopt', { injected: injected, used: used, adopted: Number(a.adopted) || 0 })
        }
        // 有正文的域就是"模型看到的内容"：本插件注入的与官方注入的（技能 / 提示词）都算。
        const hasText = function (row) { return (row.state === 'in-context' || row.state === 'official') && row.text !== '' }
        const copyAll = function () {
          const parts = []
          ;(live.domains || []).forEach(function (row) {
            if (hasText(row)) parts.push('## ' + domainLabel(row.key) + '\n' + row.text)
          })
          const text = parts.join('\n\n')
          if (!text) return
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                setLiveCopied(true)
                setTimeout(function () { setLiveCopied(false) }, 1500)
              })
            }
          } catch (e) { /* 剪贴板不可用就算了：正文仍可手动选中复制 */ }
        }
        const delivered = live.delivered || {}
        const deliveredText = delivered.count > 0
          ? t('compat.live.delivered', { count: delivered.count, time: new Date(delivered.lastAt).toTimeString().slice(0, 5) })
          : t('compat.live.never')
        // 观测面：本进程到底看到过几次本插件的工具调用。必须显示 —— 采纳全是 0 时，
        // 要能分清"模型真的没用"（结论）和"遥测没接上"（故障）。
        const observedCalls = Number((live.observed || {}).toolCalls) || 0
        const observedText = observedCalls > 0
          ? t('compat.live.observe.some', { count: observedCalls })
          : t('compat.live.observe.none')
        const canCopy = (live.domains || []).some(hasText)
        push(React.createElement('section', { className: 'dsm-compat-section' },
          React.createElement('div', { className: 'dsm-compat-section-head' },
            React.createElement('h3', { className: 'dsm-compat-section-title' }, t('compat.live.title')),
            React.createElement('span', { className: 'dsm-compat-section-hint' }, t('compat.live.hint') + ' · ' + deliveredText + ' · ' + observedText),
            React.createElement('span', { className: 'dsm-inject-live-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !canCopy, onClick: copyAll },
                liveCopied ? t('compat.live.copied') : t('compat.live.copy')))),
          live.hasAgent === false
            ? React.createElement('div', { className: 'dsm-empty' }, t('compat.live.noAgent'))
            : React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              (live.domains || []).map(function (row) {
                const st = stateOf(row)
                const open = liveOpen === row.key
                const canOpen = hasText(row)
                const adopt = adoptText(row)
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: row.key },
                  // 域名 + 体积 + 采纳统计都在**同一格**里，不要拆成三个网格子项。
                  // 这行是两列网格（名字 minmax(0,1fr) | 状态胶囊 max-content），第一行只能放两个子项；
                  // 多塞一个会把胶囊挤到第二行，而第二行落在 1fr 那一列里 → 胶囊被拉成整行宽
                  // （用户 2026-09-17 看到"在上下文中跑到下面"就是这个）。采纳统计与体积同性质
                  // （都是关于这个域的统计），跟着名字走；右列只留状态，胶囊右缘才能跨行对齐。
                  React.createElement('span', { className: 'dsm-compat-name dsm-inject-live-name' },
                    // 展开箭头只有"有正文可看"的行才有。但**它占的位置必须给没正文的行留着** ——
                    // 否则那几行的域名会比别行左移一个字宽，整列名字就参差不齐（用户 2026-09-17 指出）。
                    // 用一个 `visibility:hidden` 的同字符占位，而不是给不可展开的行画一个点了没反应的
                    // 箭头：宽度逐像素一致，且不假装它可点。
                    canOpen
                      ? React.createElement('button', { type: 'button', className: 'dsm-inject-live-toggle', onClick: function () { setLiveOpen(open ? '' : row.key) } },
                        (open ? '▾ ' : '▸ ') + domainLabel(row.key))
                      : React.createElement('span', { className: 'dsm-inject-live-static' },
                        React.createElement('span', { className: 'dsm-inject-live-mark-blank', 'aria-hidden': 'true' }, '▸ '),
                        domainLabel(row.key)),
                    canOpen
                      ? React.createElement('span', { className: 'dsm-inject-live-size' }, '· ' + fmtSize(row.bytes) + ' · ' + t('compat.live.est', { count: estTokens(row.text) }))
                      : null,
                    // 分隔符「· 」**恒定带上**：体积那一段自带一个前导「· 」，采纳这段也得有，
                    // 否则拿不到体积（状态是"已关闭 / 未投递"）时会挤成「提示词注入 3 次」。
                    adopt ? React.createElement('span', { className: 'dsm-inject-live-adopt', title: t('compat.live.adopt.title') }, '· ' + adopt) : null),
                  React.createElement('span', { className: 'dsm-compat-pill' + st.cls, title: st.title || undefined }, st.text),
                  open && canOpen ? React.createElement('pre', { className: 'dsm-code dsm-compat-mod-self' }, row.text) : null)
              }))))
      }
      if (error) body.push(React.createElement('div', { className: 'dsm-feedback dsm-error' }, t('compat.failed') + ': ' + error))
      if (!busy && !data && !error) body.push(React.createElement('div', { className: 'dsm-empty' }, t('compat.empty')))

      if (data) {
        // 结论条：一句话说清"现在能不能安全动数据"。边框颜色只表达"有没有事"，
        // 与"官方少了几个入口"无关 —— 那些入口缺失时插件自己顶上，不算异常。
        // 这句在客户端按当前语言拼（服务端的 compat-status 只给结构化字段，
        // 它自带的 summary 是中文，直接渲染会让英文界面露出中文）。
        const findingsN = Array.isArray(data.findings) ? data.findings.length : 0
        const degradedN = Array.isArray(data.degraded) ? data.degraded.length : 0
        const summaryText = findingsN === 0
          ? (data.summary || '')
          : t(degradedN === 0 ? 'compat.summary.ok' : 'compat.summary.degraded')
            .replace('{version}', String((data.host && data.host.version) || '?'))
            .replace('{ok}', String(findingsN - degradedN))
            .replace('{total}', String(findingsN))
            .replace('{count}', String(degradedN))
        push(React.createElement('div', { className: 'dsm-compat-bar' + (blockedCount > 0 ? ' dsm-compat-bar-warn' : '') },
          React.createElement('span', { className: 'dsm-compat-dot' + (blockedCount > 0 ? ' dsm-compat-dot-warn' : '') }),
          React.createElement('strong', null, blockedCount > 0 ? t('compat.state.blocked') : t('compat.state.ok')),
          React.createElement('span', { className: 'dsm-compat-sum' }, summaryText)))

        // 指标卡：宿主 / 本插件适配版本 / 可用能力（含插件自补的 optional 槽位）。
        push(React.createElement('div', { className: 'dsm-compat-grid' },
          card(t('compat.host'), (data.host && data.host.version) || '?', t('compat.peer') + ' ≥ ' + (data.minHostVersion || '-'), false),
          card(t('compat.verified'), data.verifiedVersion || '?', t('compat.verified.note'), false),
          card(t('compat.caps'), String(usableCount) + '/' + String(findings.length),
            blockedCount > 0
              ? t('compat.caps.degraded').replace('{count}', String(blockedCount))
              : (usableCount === findings.length ? t('compat.caps.all') : t('compat.caps.substituted')),
            blockedCount > 0)))

        // 阻塞项放最前：这是唯一"必须动手"的东西。
        if (blockers.length) {
          push(section(t('compat.blockers'), null,
            React.createElement('div', { className: 'dsm-feedback dsm-error' },
              React.createElement('ul', { className: 'dsm-compat-list' },
                blockers.map(function (item, i) { return React.createElement('li', { key: i }, item) })))))
        }

        // 动作可用性：一行一个动作 + 路径标记（不可用的标红）。
        push(section(t('compat.ops'), t('compat.ops.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list' },
            React.createElement('div', { className: 'dsm-compat-table-head' },
              React.createElement('span', null, t('compat.op.name')),
              React.createElement('span', null, t('compat.op.state'))),
            Object.keys(OPERATION_LABELS).map(function (op) {
              const via = routes[op]
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: op },
                React.createElement('span', { className: 'dsm-compat-name' }, t(OPERATION_LABELS[op])),
                React.createElement('span', { className: routeClass(via) }, routeText(via)))
            }))))

        if (unavailableCount > 0) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.ops.disabled').replace('{count}', String(unavailableCount))))
        }

        // 真降级：名称 + 后果 + 原因。原因必须给全，否则用户只看到"不可用"。
        if (degraded.length) {
          push(section(t('compat.degraded'), t('compat.degraded.hint'),
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              degraded.map(function (item) {
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.id },
                  React.createElement('span', { className: 'dsm-compat-name' }, item.label),
                  React.createElement('span', { className: 'dsm-compat-pill dsm-compat-pill-warn' },
                    item.fallback === 'native-entry' ? t('compat.fallback.native') : t('compat.fallback.blocked')),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    item.detail))
              }))))
        }

        // 其它非 ok 项：`optional` 表示"宿主没有这个入口，插件自己顶上"——功能完好，
        // 既不算降级，也不能说按钮被禁用（那句只对真降级成立；早先把两者混在一起
        // 会让用户以为删除功能坏了，实际它照常可用）。
        const optionalAbsent = findings.filter(function (item) { return item.state !== 'ok' && item.optional === true })
        if (optionalAbsent.length) {
          push(section(t('compat.others'), t('compat.others.hint'),
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              optionalAbsent.map(function (item) {
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.id },
                  React.createElement('span', { className: 'dsm-compat-name' }, item.label),
                  React.createElement('span', { className: 'dsm-compat-pill' }, t('compat.fallback.substituted')),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    item.detail))
              }))))
        }

        // 模块实体：一行一个包，右侧是"同一份模块 / 两份拷贝"。
        push(section(t('compat.modules'), t('compat.modules.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list' },
            Object.keys(sameAsHost).map(function (name) {
              const same = sameAsHost[name]
              const cls = same === true ? 'dsm-compat-pill-ok' : same === false ? 'dsm-compat-pill-bad' : ''
              const text = same === true ? t('compat.module.same') : same === false ? t('compat.module.separate') : t('compat.module.unknown')
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: name },
                React.createElement('span', { className: 'dsm-compat-name dsm-compat-mod' }, name),
                React.createElement('span', { className: 'dsm-compat-pill ' + cls }, text))
            }))))

        push(React.createElement('p', { className: 'dsm-help' },
          t('compat.hint.doctor'),
          React.createElement('code', { className: 'dsm-compat-code' }, ' node scripts/doctor.mjs')))
      }

      // 预设注入边界：五类内容（记忆 / 全局提示词 / 技能 / MCP / 子智能体）在**每个 Agent
      // 预设**下到不到得了模型。回答的是"面板标着已注入，模型真的看得到吗"——本插件的
      // 注入由它自己在每步发出（极简这类预设下默认不发，可用上面的「注入」块强制），
      // 而全局提示词与技能目录还要看官方那两条行挂没挂（极简都没挂）。单独一块：取不到时
      // 这一节不显示，不影响上面的结论。
      //
      // 排版口径（用户裁定 2026-09-15）：每格一枚描边标签，**绿框=能用、红框=不能用、
      // 灰框=判断不了**；不再出现 ✓/✗ 符号，也不再有任何整行的解释文字 —— 预设损坏与
      // 解析失败缩成预设名旁边的小标签。MCP 与子智能体两列由宿主侧的 preset-reach 给出。
      if (presetReach && Array.isArray(presetReach.rows) && presetReach.rows.length) {
        push(section(t('compat.reach'), t('compat.reach.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
            presetReach.rows.map(function (row) {
              // ok → 绿框；absent / suppressed → 红框；其余（unknown，含宿主还没回传该字段）
              // 一律灰框，绝不把"读不到"画成"不能用"。
              const chip = function (label, state) {
                const kind = state === 'ok' ? 'ok' : (state === 'absent' || state === 'suppressed') ? 'bad' : 'unknown'
                return React.createElement('span', { className: 'dsm-reach-chip dsm-reach-' + kind, key: label }, label)
              }
              const tags = []
              if (row.suppressing) tags.push(React.createElement('span', { className: 'dsm-tag dsm-tag-off', key: 'suppressing' }, t('compat.reach.suppressing')))
              if (row.broken) tags.push(React.createElement('span', { className: 'dsm-tag dsm-tag-off', key: 'broken' }, t('compat.reach.broken')))
              else if (row.reason) tags.push(React.createElement('span', { className: 'dsm-tag', key: 'reason' }, t('compat.reach.whyUnknown')))
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: row.presetId },
                React.createElement('span', { className: 'dsm-compat-name dsm-reach-name' },
                  React.createElement('span', null, (row.name || row.presetId) + (row.isDefault ? ' · ' + t('compat.reach.default') : '')),
                  tags.length ? React.createElement('span', { className: 'dsm-tags' }, tags) : null),
                // 芯片顺序与「注入」块的勾选顺序一致（用户裁定 2026-09-16）：
                // 场景和记忆 → MCP → 技能 → 子智能体 → 提示词。
                React.createElement('span', { className: 'dsm-compat-reach-marks' },
                  chip(t('compat.reach.mark.memory'), row.memory),
                  chip(t('compat.reach.mark.mcp'), row.mcp),
                  chip(t('compat.reach.mark.skill'), row.skillCatalog),
                  chip(t('compat.reach.mark.subagent'), row.subagent),
                  chip(t('compat.reach.mark.agentsMd'), row.agentsMd)))
            }))))

        // 页脚用「标题 + 条目」清单，与导入弹窗的「文件要求」同款结构与样式（用户裁定
        // 2026-09-16 第二版：条目要短、不列路径与内部机制，使用者知道"有这回事"就够）。
        push(React.createElement('div', { className: 'dsm-upload-requirements' },
          React.createElement('div', { className: 'dsm-label' }, t('compat.reach.tools.title')),
          React.createElement('ul', null,
            [1, 2, 3].map(function (n) {
              return React.createElement('li', { key: n }, t('compat.reach.tools.' + n))
            }))))
      }

      return React.createElement('div', { className: 'dsm-compat' },
        React.createElement('div', { className: 'dsm-head' },
          React.createElement('div', { className: 'dsm-title-block' },
            React.createElement('div', { className: 'dsm-title-row' },
              React.createElement('h2', { className: 'dsm-title' }, t('compat.title'))),
            React.createElement('p', { className: 'dsm-desc' }, t('compat.desc')))),
        React.createElement('div', { className: 'dsm-actions' },
          refreshButton(t, busy, { className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: reload })),
        body)
    }

    // 曾经把导出写成 apply 方法体的最后两条语句（`module.exports.DICT = ...` /
    // `module.exports._pages = ...`），而 apply 开头是
    // `const slots = ctx.get('slots'); if (slots === undefined) return`。
    // 对象字面量在 factory 求值时就定了型，方法体里的追加却可能永远不执行——
    // 于是导出里查无 _pages。**任何导出都必须在 factory 作用域落地。**
    const _pages = {}
    // 中英两份词典。声明在 factory 作用域：apply 里的 ctx.locale 只是把它交给宿主，
    // 契约测试则直接从导出里读它（apply 提前返回也必须拿得到）。
    const DICT = {
      zh: {
        "title": "技能", "desc": "管理技能：启停、导入、创建、回收站。", "link.project": "GitHub", "link.feedback": "问题反馈",
        "btn.create": "新增技能", "btn.import": "导入技能", "btn.refresh": "刷新", "btn.refreshing": "刷新中…", "btn.cancel": "取消", "btn.close": "关闭", "export.hint": "导出为 zip，写入你指定的目录；只读源文件，不改动任何数据。", "export.outDir": "导出目录", "export.outDir.placeholder": "例如 D:////backup", "export.pickDir": "选择导出目录", "export.submit": "导出", "export.busy": "导出中…", "export.done": "已导出 {count} 个文件到 {path}", "scenes.lock.lock": "锁定", "scenes.lock.unlock": "解锁", "scenes.lock.tag": "已锁定", "scenes.lock.hint": "锁定后五个管理域（MCP / 技能 / 子智能体 / 记忆 / 提示词）整体只读；场景启停不受影响", "scenes.lock.blockedEdit": "场景已锁定：先解锁再修改", "scenes.lock.notActive": "场景未启动：先启动再锁定", "scenes.lock.blockedExit": "场景已锁定：先解锁再关闭", "lock.banner": "有场景处于锁定状态：MCP / 技能 / 子智能体 / 记忆 / 提示词已整体冻结，先到场景页解锁再修改。", "scene.switch.banner": "当前处于场景「{scene}」：这里的开关照常可用，改动会同步写进该场景的档案（改完立即生效、下次进这个场景照旧生效；退出场景仍按进场景前的状态还原）。", "scene.sync.failed": "注意：改动已生效，但没能同步写进场景档案（{error}）——本次进场景期间有效，重新进这个场景时会按旧档案应用。", "agm.apply.rebindScene": "场景「{scene}」接管中：应用这一份会把该场景改绑到它（同步写入场景档案）", "export.empty": "没有可导出的条目", "export.pickAll": "全选", "export.pickNone": "取消全选", "export.group.count": "{count} 项", "export.missing": "；跳过 {count} 项（文件不存在）：{names}", "export.skills": "导出技能", "export.subagents": "导出子智能体", "export.presets": "导出提示词", "export.memories": "导出记忆", "btn.detail": "查看详情", "btn.trash": "移到回收站", "btn.restore": "恢复", "btn.delete.forever": "永久删除", "btn.file.pick": "选择文件", "btn.folder.pick": "选择文件夹", "btn.create.now": "创建技能", "btn.disable": "停用", "btn.enable": "启用", "btn.open.editor": "用系统编辑器打开", "btn.activate": "启用这个", "btn.activate.title": "把当前来源的版本设为同名技能的首选并启用（不改动任何源文件）", "btn.unprefer": "取消首选", "btn.unprefer.title": "取消同名首选，回到按来源优先级自动选择",
        "btn.custom.add": "添加目录", "btn.custom.remove": "移除", "btn.openDir": "选择",
        "btn.source.remove": "移除来源", "btn.source.remove.title": "不再读取这个来源（源文件不动，之后可在回收站里恢复）", "btn.source.restore": "恢复", "btn.source.forget": "永久删除",
        "trash.section.dirs": "目录", "trash.section.skills": "技能", "trash.section.dirs.sub": "只是不再读取，磁盘文件一个字节都不动", "trash.section.dirs.empty": "没有被移除的来源", "trash.section.skills.sub": "文件真的被移走了：恢复能还原，永久删除会删掉文件", "trash.section.presets.sub": "预设目录已移走：恢复能还原，永久删除会删掉文件", "trash.section.scenes.sub": "场景记录、档案与它的记忆都在这里：恢复会整条放回", "trash.section.agents.sub": "人设文件已移走：恢复能还原，永久删除会删掉文件",
        "trash.dirs.count.one": "{count} 个待处理目录", "trash.dirs.count.other": "{count} 个待处理目录",
        "trash.row.summary": "技能 {skills} · 目录 {dirs}",
        "confirm.source.forget.title": "永久删除这条来源记录？", "confirm.source.forget.desc": "「{name}」将从插件里彻底删掉：来源列表里不再有它，「恢复读取」也找不回来（需要时只能重新添加这个目录）。",
        "confirm.source.forget.hint": "磁盘上的文件夹一个字节都不动：{path}。",
        "result.sourceForgotten": "已永久删除来源记录：{name}",
        "confirm.source.remove.title": "移除来源？", "confirm.source.remove.desc": "「{name}」将不再被读取：它下面的技能不再出现在本页，也不再参与同名优先级；已启用/停用的选择会保留。",
        "confirm.source.remove.hint": "不删除任何文件。移除后它出现在「回收站 → 目录」，在那里点「恢复读取」就能重新纳入（也可以永久删除这条记录）。",
        "result.sourceRemoved": "已移除来源：{name}（不再读取）", "result.sourceRestored": "已恢复读取：{name}",
        "custom.add.title": "添加自定义技能目录", "custom.add.submit": "添加",
        "custom.add.path": "目录绝对路径", "custom.add.path.placeholder": "例如 D:\\skills\\my-skills",
        "custom.add.openDir.title": "浏览并选择文件夹", "custom.add.picker.title": "选择文件夹",
        "custom.add.label": "显示名称（可选）", "custom.add.label.placeholder": "自定义目录",
        "custom.add.help": "只读接入该目录；目录与源文件都不会被修改",
        "confirm.custom.remove.title": "移除自定义目录",
        "confirm.custom.remove.desc": "移除后该目录的技能不再列出（文件不受影响）：{name}",
        "result.custom.added": "已添加自定义目录：{path}", "result.custom.removed": "已移除自定义目录：{name}",
        "status.enabled": "已启用", "status.disabled": "已停用", "status.invalid": "诊断异常", "status.shadowed": "被覆盖", "status.shadowed.hint": "同名技能「{name}」正在生效；点「启用这个」可改用当前来源的版本", "status.preferred": "同名首选", "status.readonly": "源文件只读", "status.notDeletable": "不可删除", "status.notDeletable.hint": "删除只对插件可管理的来源开放（DSH 技能 / 导入技能 / 项目级 .dsh/skills）；外部 Agent 与自定义目录只读，里面的技能不能删", "status.manageable": "可管理", "status.project": "项目级", "status.rank": "优先级 {rank}", "status.source.on": "已启用", "status.source.off": "已停用", "status.bundle": "目录技能", "status.single": "单文件",
        "summary.total.one": "{count} 个技能", "summary.total.other": "{count} 个技能", "summary.enabled.one": "{count} 个已启用", "summary.enabled.other": "{count} 个已启用", "summary.issues.one": "{count} 个诊断项", "summary.issues.other": "{count} 个诊断项", "summary.group.one": "{count} 个技能", "summary.group.other": "{count} 个技能", "table.skill": "技能名称与描述", "table.status": "调用状态",
        "filter.source": "来源", "filter.all": "全部来源", "filter.option": "{name}（{count}）", "search": "搜索", "search.placeholder": "搜索技能名称或描述", "search.clear": "清除搜索",
        "empty.search": "没有匹配的技能", "empty.source": "该来源不存在或暂无技能", "loading": "正在加载技能…", "note.missing": "未提供简介", "source.toggle": "启停来源", "skill.toggle": "启停技能",
        "source.external.note": "只读接入，启停不改写源文件", "source.dsh.note": "可创建、导入、移到回收站；默认来源必须读取，不能移除或停用",
        "detail.title": "技能详情", "detail.body": "正文", "detail.frontmatter": "元数据", "detail.noFrontmatter": "该技能未提供元数据。", "detail.diagnostics": "诊断", "detail.path": "源文件", "detail.noIssues": "未发现诊断问题。",
        "create.title": "创建技能", "create.target": "创建位置", "create.name": "名称", "create.name.placeholder": "例如 code-review-helper", "create.description": "简介", "create.description.placeholder": "一句话说明什么时候使用", "create.body": "正文（Markdown）", "create.body.placeholder": "写下技能要遵循的指令、步骤和边界…", "create.chat.note": "对话里 skill_manager_create 建的是用户级技能",
        "import.title": "导入技能", "upload.drop.title": "点击或拖入此处", "upload.drop.copy": "支持 .zip、技能文件夹或单个 SKILL.md", "upload.selected.one": "{count} 个文件 · {size}", "upload.selected.other": "{count} 个文件 · {size}", "upload.remove": "移除所选内容", "upload.requirements": "文件要求", "upload.requirement.skill": "压缩包或文件夹需包含 SKILL.md", "upload.requirement.frontmatter": "SKILL.md 需包含 YAML 格式的技能名称和描述", "upload.requirement.copy": "导入时复制完整内容，不修改原始来源", "upload.requirement.persona.1": "支持 .md / .zip（可多选、可拖入）", "upload.requirement.persona.2": "一个 .md = 一个人设，文件名即人设名", "upload.requirement.persona.3": "同名自动跳过，绝不覆盖原有文件", "upload.requirement.memory.1": "支持 .md / .zip（可多选、可拖入）", "upload.requirement.memory.2": "一个 .md = 一条记忆，文件名即记忆名", "upload.requirement.memory.3": "带 SKILL.md 的目录 = bundle 记忆（附件一起进来）", "upload.requirement.memory.4": "zip 里的目录名即场景；没有目录时用下面「导入到场景」的值（留空 = 全局）", "upload.requirement.prompt.1": "支持 .md（可多选、可拖入）", "upload.requirement.prompt.2": "一个 .md = 一份预设，文件名即 id（目录名）", "upload.requirement.prompt.3": "同名已存在则跳过，绝不覆盖", "upload.requirement.session.1": "支持 .jsonl / .json / .md / .txt（一次一个）", "upload.requirement.session.2": "Claude Code / Cursor / Codex 的转录文件，或任意文本", "upload.requirement.session.3": "项目目录可留空 = 归入未分组；留空不影响导入", "upload.importing": "正在导入…", "status.selected": "已选择", "select.file.invalid": "请选择 .zip 或单个 SKILL.md", "select.folder.invalid": "该文件夹里没有 SKILL.md", "error.browse.absolute": "目录路径必须是绝对路径：{path}", "error.browse.unreadable": "无法读取目录：{path}", "error.browse.notDirectory": "不是目录：{path}",
        // F-029：服务端错误码补词条（zh 逐字复现服务端文案，命中词条前后中文显示不变；EN 不再回退中文原文）。
        "error.custom.absolute": "目录路径必须是绝对路径: {path}", "error.custom.notDirectory": "不是目录: {path}", "error.custom.unreadable": "无法读取目录: {path}", "error.custom.overlap": "目录与已有技能来源重叠: {path} ↔ {other}", "error.custom.invalidKey": "非法的自定义来源 key: {key}", "error.custom.notFound": "自定义来源不存在: {key}",
        "error.secret.noToken": "明文查看与导出已被禁用：宿主未配置访问令牌。请在本插件配置里加 token（或设环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）后重启 DSH，再在界面上填入同一个令牌。", "error.secret.badToken": "访问令牌缺失或不正确：请在界面里填入与宿主配置相同的令牌（随请求以 x-dsh-token 发送）。",
        "dir.title": "选择文件夹", "dir.currentPath": "当前路径", "dir.pathPlaceholder": "输入目录路径，回车跳转", "dir.jump": "跳转", "dir.loading": "加载中…", "dir.empty": "（当前目录没有子文件夹）", "dir.up": "上级", "dir.pick": "选择此文件夹", "dir.error.unreadable": "无法读取目录",
        "fm.label.name": "名称", "fm.label.description": "描述", "fm.label.when-to-use": "适用场景", "fm.label.user-invocable": "用户可调用", "fm.label.disable-model-invocation": "禁止模型调用", "fm.label.allowed-tools": "允许的工具", "fm.label.license": "许可协议", "fm.label.version": "版本", "fm.label.author": "作者", "fm.label.category": "分类", "fm.label.tags": "标签", "fm.label.metadata": "附加信息", "fm.label.homepage": "主页", "fm.yes": "是", "fm.no": "否",
        // F-029 收尾：余下 7 码的服务端动态文案已改为 params 携带（zh 词条逐字复现原句）。
        // {action} 由 translateError 走 action.* 二次翻译；{reason}/{detail}/{refs}/{origin}
        // 是服务端动态中文尾巴，EN 界面显示英文框架 + 中文细节（比整句中文可读）。
        "error.rules.sceneNotFound": "场景不存在：{group}（请先在「场景」页创建该场景）",
        "error.rules.reservedScene": "「{name}」是保留场景，不可{action}{reason}",
        "error.rules.singleSceneOnly": "除「全局」外同时只能启用一个场景{detail}",
        "error.agentsMd.sceneRebindFailed": "无法把场景「{scene}」的提示词绑定改成「{target}」：{reason}",
        "error.agentsMd.referenced": "「{id}」仍被引用，不能删除：{refs}。先改掉引用（换绑提示词 / 退出场景 / 应用别的预设）再删除。",
        "error.source.reserved": "{origin}：不能停用或移除（里面的技能可以删除）",
        "action.rename": "改名", "action.lock": "锁定",
        "trash.title": "回收站", "trash.count.one": "{count} 个待处理技能", "trash.count.other": "{count} 个待处理技能", "trash.empty": "回收站为空", "trash.deletedAt": "删除于 {time}", "trash.source": "来源：{source}",
        "trash.btn.open": "回收站", "trash.items.count": "{count} 项", "trash.purge.confirm": "永久删除？",
        "trash.group.agents": "人设", "trash.group.scenes": "场景", "trash.group.presets": "提示词预设",
        "trash.restored": "已恢复「{name}」", "trash.purged": "已永久删除「{name}」", "trash.loadFailed": "读取回收站失败",
        "confirm.trash.title": "移到回收站？", "confirm.trash.desc": "「{name}」将移入回收站，可恢复", "confirm.delete.title": "永久删除？", "confirm.delete.desc": "「{name}」将永久删除，无法恢复",
        "result.created": "已创建技能：{name}", "result.imported": "导入完成：{names}", "result.importPartial": "已导入：{imported}；已跳过同名技能：{skipped}", "result.importSkipped": "未导入任何技能；已跳过同名技能：{names}", "result.importEmpty": "未导入任何技能。", "result.importWarnings": "{result}；警告：{warnings}", "result.restored": "已恢复技能：{name}", "result.trashed": "已移到回收站：{name}", "result.deleted": "已永久删除：{name}", "result.updated": "状态已更新。", "result.preferred": "已改为生效：{name}（{source}）", "result.unpreferred": "已取消同名首选：{name}", "result.opened": "已用系统默认程序打开：{path}", "error.action": "操作失败：{error}",
        "warning.scan.truncated": "技能目录较大或嵌套过深，部分技能未显示：{path}", "warning.state.invalid": "状态文件不可读，已安全停用所有技能：{path}", "warning.backupUncleaned": "旧版本备份未清理：{path}（{error}）", "warning.project.unavailable": "无法从宿主读取活动工作区，项目技能未显示：{path}",
        "error.root.readonly": "该来源不允许{action}", "error.root.disabled": "「{name}」这个来源已整体停用，请先在该来源行启用它", "error.root.unknown": "未知技能来源：{root}", "error.root.unsafe": "项目技能目录不安全，拒绝写入：{path}", "error.skill.notFound": "技能不存在: {name}", "error.skill.noFrontmatter": "缺少 frontmatter，无法{action}：{name}", "error.skill.notLoadable": "技能结构不完整，无法{action}: {name}", "error.skill.notDeletable": "该来源的技能不能删除（技能只能停用）：删除只在项目级来源（<项目>/.dsh/skills）提供",
        "error.source.notFound": "路径不存在: {path}", "error.source.symlink": "不支持符号链接来源：{path}", "error.source.unrecognized": "无法识别的 skill 来源: {path}", "error.source.tooDeep": "skill 来源目录层级超过 {depth} 层: {path}",
        "error.import.overlap": "该目录与 DSH 技能目录重叠", "error.import.emptySource": "目录下没有 skill 条目：{path}", "error.import.invalidName": "名称不合法：{name}", "error.import.duplicateName": "批量来源中存在多个同名技能: {name}", "error.import.failed": "导入失败", "error.import.rollbackFailed": "覆盖导入回滚失败，备份保留在: {path}（{error}）",
        "error.upload.path": "上传内容包含非法路径：{path}", "error.upload.encoding": "上传内容编码无效", "error.upload.empty": "上传内容为空", "error.upload.tooMany": "上传文件过多，最多 {limit} 个", "error.upload.tooLarge": "上传内容过大，限制为 {limit} 字节", "error.upload.archiveTooLarge": "ZIP 压缩包过大，限制为 {limit} 字节", "error.upload.duplicate": "上传内容包含重复路径：{path}", "error.upload.zipInvalid": "ZIP 压缩包无法解压",
        "error.trash.notFound": "回收站条目不存在: {id}", "error.trash.conflict": "无法恢复，同名技能已存在: {name}", "error.trash.invalid": "回收站条目路径非法: {id}", "error.trash.projectUnavailable": "原项目当前不在活动工作区中，无法恢复：{path}", "error.trash.rollbackFailed": "移入回收站回滚失败，未恢复内容保留在: {path}（{error}）",
        "error.state.invalid": "技能管理器状态文件不可读，已拒绝覆盖：{path}",
        "error.create.descriptionRequired": "技能简介不能为空", "error.create.bodyRequired": "技能正文不能为空", "error.create.tooLarge": "技能内容过长", "error.create.conflict": "同名技能已存在: {name}",
        "error.proto.forbidden": "禁止的修改请求（缺少客户端标记）", "error.proto.forbiddenHost": "禁止的请求来源（非法 Host）", "error.proto.contentType": "请求体必须是 application/json", "error.proto.method": "不支持的请求方法", "error.proto.unknownAction": "未知操作", "error.proto.bodyTooLarge": "请求体过大", "error.proto.invalidJson": "请求体不是合法 JSON", "error.proto.nonJson": "服务端返回非 JSON 响应（HTTP {status}）",
        "diagnostic.frontmatter.missing": "缺少完整 YAML frontmatter", "diagnostic.name.missing": "frontmatter 缺少 name", "diagnostic.name.invalid": "技能名需 kebab-case：{name}", "diagnostic.description.missing": "frontmatter 缺少 description", "diagnostic.invocation.invalid": "调用策略字段值无效", "diagnostic.shadowed": "被更高优先级来源 {root} 覆盖",
        "action.enable": "启用", "action.disable": "停用", "action.create": "创建", "action.delete": "删除", "action.restore": "恢复", "action.toggle": "启用或停用",
        "mcp.desc": "管理 MCP：新增、启停、重启，以及工具级开关。",
        "mcp.level.all": "全部级别", "mcp.level.project": "应用级", "mcp.level.global": "全局", "mcp.level.loader": "已加载",
        "mcp.stat.total": "个服务", "mcp.stat.enabled": "个已启用", "mcp.stat.tools": "个工具",
        "mcp.search": "搜索服务", "mcp.search.placeholder": "搜索服务名称、地址或命令",
        "mcp.btn.new": "新增 MCP", "mcp.btn.add": "添加", "mcp.btn.save": "保存", "mcp.btn.detail": "详情", "mcp.btn.edit": "编辑", "mcp.btn.restart": "重启", "mcp.btn.remove": "删除",
        "mcp.btn.enableAll": "全部启用", "mcp.btn.disableAll": "全部停用",
        "mcp.loading": "正在加载 MCP 服务…", "mcp.empty": "暂无 MCP，点「新增 MCP」添加", "mcp.empty.search": "没有匹配的服务。",
        "mcp.servers.count": "{count} 个服务", "mcp.tools.count": "{count} 个工具", "mcp.tools.countPartial": "{enabled}/{total} 个工具", "mcp.duplicate": "重复 id",
        "mcp.table.name": "服务名称与地址", "mcp.table.transport": "传输与工具", "mcp.table.status": "运行状态",
        "mcp.live.notLoaded": "未加载", "mcp.live.failed": "启动失败", "mcp.live.stopped": "未运行", "mcp.live.loading": "加载中", "mcp.live.noTools": "无可用工具", "mcp.live.running": "已运行",
        "mcp.live.failedHint": "启动失败，检查配置后点「重启」重试", "mcp.live.offlineHint": "未连上：一个工具都没注册，但上次连上时它有 {count} 个工具。检查网络、命令或凭据后点「重启」重试", "mcp.live.neverHint": "从未连上过：一个工具都没注册过。检查命令、参数或凭据后点「重启」重试", "mcp.live.allOffHint": "工具全部被停用：当前没有可调用的工具（取消停用即恢复）",
        "mcp.note.prefix": "备注：", "mcp.toggleServer": "启停服务", "mcp.toggleTool": "启停工具",
        "mcp.msg.ok": "操作成功", "mcp.msg.failed": "操作失败", "mcp.msg.loadFailed": "加载失败", "mcp.msg.warn": "操作完成，但加载器有提示：{warning}",
        "mcp.msg.toolOn": "已启用工具：{name}", "mcp.msg.toolOff": "已停用工具：{name}",
        "mcp.form.addTitle": "新增 MCP", "mcp.form.editTitle": "编辑 MCP 服务：",
        "mcp.field.serverName": "服务名称 serverName", "mcp.field.serverName.hint": "1-32 位 [A-Za-z0-9_-]，补丁里按此名注册",
        "mcp.field.transport": "传输方式", "mcp.field.level": "级别",
        "mcp.field.level.project": "应用级（仅当前应用：{path}）", "mcp.field.level.global": "全局（跨应用：{path}）",
        "mcp.field.url": "服务 URL", "mcp.field.url.hint": "需以 http(s):// 开头",
        "mcp.field.command": "启动命令", "mcp.field.args": "参数（空格或换行分隔）",
        "mcp.field.env": "环境变量（每行 key=value）", "mcp.field.env.hint": "路径按系统路径写法填（Windows 用 \\，macOS/Linux 用 /）。",
        "mcp.field.headers": "请求头（每行 key=value）",
        "mcp.detail.title": "服务详情：", "mcp.detail.config": "配置", "mcp.detail.showSecret": "显示密钥", "mcp.detail.hideSecret": "隐藏密钥",
        "mcp.token.label": "访问令牌", "mcp.token.placeholder": "与宿主配置的 token 相同", "mcp.token.save": "保存并重试",
        "mcp.token.hint": "明文密钥必须带对的访问令牌：宿主配置里设 token（或环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）并重启 DSH，这里填同一个值。",
        "mcp.btn.compact": "整理补丁", "mcp.btn.compact.title": "清掉补丁文件里已经不起作用的旧开关记录（每台服务的启用/停用状态不变）",
        "mcp.compact.title": "整理补丁文件", "mcp.compact.desc": "清掉同一服务反复启用/停用留下的失效开关记录。",
        "mcp.compact.confirm": "确认整理", "mcp.compact.done": "补丁文件已整理：清掉 {count} 条失效的旧开关记录，服务的启用/停用状态未变", "mcp.compact.clean": "补丁文件已经很干净，没有可清理的旧记录",
        "mcp.detail.entryId": "条目 ID", "mcp.detail.status": "运行状态", "mcp.detail.loader": "Loader 登记", "mcp.detail.loader.yes": "已登记", "mcp.detail.loader.no": "未登记",
        "mcp.tools.stale": "上次运行时", "mcp.tools.expand": "展开", "mcp.tools.collapse": "收起",
        "mcp.detail.note": "备注（随上下文注入发给模型；压制型预设下不注入时，用 mcp_manager_list 仍能读到）", "mcp.detail.note.placeholder": "例如：A 不可用时改用 B 兜底", "mcp.detail.note.save": "保存备注",
        "mcp.detail.tools": "工具（{count}）",
        "mcp.field.headersShort": "请求头", "mcp.field.envShort": "环境变量",
        "mcp.tools.loading": "正在获取工具列表…", "mcp.tools.loadFailed": "加载工具失败：", "mcp.tools.none": "该服务暂无已注册工具。",
        "mcp.tools.note": "停用的工具对模型不可见，改动即时生效",
        "mcp.remove.title": "删除 MCP 服务", "mcp.remove.desc": "确定要删除「{name}」？配置将从补丁文件移除、工具立即下线，不可撤销",
        "mcp.restarting": "重启中… {name}（已等待 {seconds} 秒，完成后自动刷新）", "mcp.err.warnings": "读取补丁告警：",
        "root.dsh": "DSH 技能", "root.hub": "导入技能", "root.agents": "公共 Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "项目 DSH", "root.projectAgents": "项目 Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor",
        "memory.title": "记忆",
        "tabs.scenes": "场景", "tabs.skills": "技能", "tabs.subagents": "子智能体", "tabs.prompts": "提示词", "tabs.memory": "记忆", "tabs.sessions": "会话", "tabs.compat": "兼容",
        "compat.title": "宿主兼容", "compat.desc": "本插件与 DSH 的对接体检（只读）。",
        "compat.state.ok": "一切正常", "compat.state.degraded": "有降级项", "compat.state.blocked": "有需要处理的问题",
        "compat.checking": "检查中…", "compat.recheck": "重新检查", "compat.empty": "尚未检查", "compat.failed": "检查失败",
        "compat.summary.ok": "宿主 {version} · 能力 {ok}/{total} · 全部可用", "compat.summary.degraded": "宿主 {version} · 能力 {ok}/{total} · 降级 {count} 项",
        "compat.host": "宿主版本", "compat.peer": "最低要求", "compat.verified": "插件适配版本", "compat.verified.note": "本插件按此版本验证",
        "compat.caps": "可用能力", "compat.caps.all": "全部通过", "compat.caps.degraded": "{count} 项不可用",
        "compat.caps.substituted": "缺口由插件自补",
        "compat.ops": "宿主动作可用性", "compat.ops.hint": "每个动作走哪条路径", "compat.ops.disabled": "有 {count} 个动作当前不可用（相关按钮已禁用并会说明原因）",
        "compat.op.name": "动作", "compat.op.state": "路径",
        "compat.op.list": "列出归档会话", "compat.op.archive": "归档会话", "compat.op.unarchive": "恢复会话",
        "compat.op.batch": "批量归档", "compat.op.delete": "永久删除",
        "compat.op.native": "宿主原生入口", "compat.op.adapter": "插件适配层", "compat.op.unavailable": "不可用（已禁用）",
        "compat.degraded": "已降级能力", "compat.degraded.hint": "缺什么 + 后果", "compat.reason": "原因：",
        "compat.others": "其它能力项", "compat.others.hint": "不算降级：宿主没有这些入口时，由插件自己顶上",
        "compat.fallback.substituted": "插件适配层（宿主无此入口）",
        "compat.fallback.native": "改走原生入口", "compat.fallback.blocked": "相关按钮已禁用",
        "compat.modules": "模块实体（插件 vs 宿主）", "compat.modules.hint": "同一份模块才谈得上适配", "compat.module.same": "同一份模块", "compat.module.separate": "两份拷贝（需修复）", "compat.module.unknown": "无法比较",
        "compat.blockers": "阻塞项（按此修复）",
        "compat.reach": "预设注入边界", "compat.reach.hint": "每个预设下这些内容到不到得了模型",
        "compat.reach.suppressing": "压制型",
        "compat.inject": "注入", "compat.inject.hint": "本插件注入给模型的内容（不变不重发）",
        "compat.inject.force": "极简模式也注入", "compat.inject.force.desc": "默认关（跟随预设）",
        "compat.inject.domains": "注入内容",
        "compat.inject.domain.memory": "场景和记忆", "compat.inject.domain.mcp": "MCP",
        "compat.inject.domain.subagents": "子智能体", "compat.inject.domain.prompt": "提示词",
        "compat.inject.domain.skills": "技能",
        "compat.inject.domain.carrier.title": "关掉后，系统自带的那份也会一并停掉",
        "compat.live.title": "注入实况", "compat.live.hint": "模型实际看到的内容（只读）",
        "compat.live.never": "本次运行未投递", "compat.live.delivered": "已投递 {count} 条 · 最近 {time}",
        "compat.live.copy": "复制全文", "compat.live.copied": "已复制", "compat.live.noAgent": "还没有会话：发一条消息后再来看",
        "compat.live.state.inContext": "已注入", "compat.live.state.absent": "未投递", "compat.live.state.cleared": "已清空",
        "compat.live.state.off": "已关闭", "compat.live.state.unknown": "没有会话",
        "compat.live.state.child": "不在本会话注入",
        "compat.live.state.child.title": "本会话的深度超过了人设的目录注入深度（catalogDepth），所以常驻目录不在这里注入。要让目录出现在子会话，把对应人设的「目录注入」调大（或选「不限制嵌套」）。注意：这不影响委派 —— 子代理始终可以继续委派。",
        "compat.live.adopt": "注入 {injected} 次 · 调用 {used} 次 · 采纳 {adopted} 次",
        "compat.live.adopt.none": "注入 {injected} 次 · 从未调用",
        "compat.live.adopt.title": "本进程运行以来的计数。采纳 = 调用发生时该域正文正在这个会话的上下文里；调用次数不区分成功失败",
        "compat.live.observe.some": "本进程观测到 {count} 次调用",
        "compat.live.observe.none": "本进程未观测到调用",
        "compat.live.state.official": "官方注入", "compat.live.state.official.title": "提示词与技能目录在标准类预设下由官方通道送达，本插件不重复注入（极简这类官方没挂的预设才由本插件兜底）",
        "compat.live.state.empty": "无内容", "compat.live.est": "≈{count} token",
        "compat.live.state.absent.title": "本插件负责这个域，但当前不在上下文里（可能刚被压缩，下一步会自动补发）",
        "compat.reach.mark.memory": "场景和记忆", "compat.reach.mark.agentsMd": "提示词", "compat.reach.mark.skill": "技能", "compat.reach.mark.mcp": "MCP", "compat.reach.mark.subagent": "子智能体",
        "compat.reach.default": "默认",
        "compat.reach.whyUnknown": "判断不了", "compat.reach.broken": "预设损坏",
        "compat.reach.tools.title": "工具能用 ≠ 模型知道",
        "compat.reach.tools.1": "工具由本插件注册，任何预设下都能调用；怎么送到模型由预设决定。",
        "compat.reach.tools.2": "场景和记忆 / MCP / 技能 / 子智能体 / 提示词 —— 由本插件按上面的「注入」块补齐。",
        "compat.reach.tools.3": "提示词与技能官方自己也会送；官方有的不重复送，官方缺的（如极简）由本插件补上。",
        "compat.hint.doctor": "命令行体检：",
        "scenes.title": "场景", "scenes.desc": "管理场景：预设 MCP、技能、子智能体与记忆的组合，一键切换。",
        "scenes.stat.total": "个场景", "scenes.stat.active": "个已启用", "scenes.stat.archives": "个有档案",
        "scenes.noDesc": "还没有描述",
        "scenes.mode.active": "当前模式：{name}", "scenes.mode.profile": "档案：{parts}", "scenes.mode.noProfile": "这个场景还没有档案",
        "scenes.empty": "还没有专门设置的场景；全局记忆不需要场景就能注入，需要切换 MCP / 技能 / 人设时再新建。",
        "scenes.field.desc.limit": "最多 {count} 字；超出部分在卡片上省略。",
        "scenes.profile.mcp": "MCP {count} 台", "scenes.profile.skills": "技能 {count} 个", "scenes.profile.subagents": "子智能体 {count} 个", "scenes.profile.memories": "记忆 {count} 条",
        "scenes.mcp.hint": "添加「MCP 工具集」后，勾选要启用的服务器（含未运行的）；「选工具」可细化到具体工具。没勾的、以及整段没建的，进场景时一律停用（含停掉正在运行的进程）。",
        "scenes.seg.checked": "{checked}/{total} 已勾选",
        "bulk.selectAll": "全选", "bulk.unselectAll": "取消全选",
        "bulk.head.title": "对当前筛选后可见、且可切换的技能批量启停（被同名覆盖的副本不算）",
        "source.bulk.title": "对这个目录下当前可见、且可切换的技能批量启停（被同名覆盖的副本不算）",
        "bulk.enabled": "已启用", "bulk.disabled": "已停用",
        "bulk.done.skills": "{action} {count} 个技能（失败 {failed}）", "bulk.done.memories": "{action} {count} 条记忆（失败 {failed}）", "memory.bulk.partial": "{action} {count} 条记忆后中止：{error}",
        "scenes.archive.sectionOff": "未定义 = 全部停用",
        "scenes.archive.summary": "档案：MCP {mcp} 台 · 技能 {skills} 个 · 子智能体 {subagents} 个",
        "scenes.archive.note": "勾 = 启用，未勾 = 停用；整段没建 = 全部停用。\nMCP 会真的启停服务器进程。\n退出场景按进场景前的状态还原。",
        "scenes.mcp.noServers": "还没有可选的 MCP 服务器", "scenes.mcp.toolCount": "{count} 个工具", "scenes.skills.empty": "还没有可选的技能",
        "scenes.mcp.allTools": "全部工具", "scenes.mcp.pickedCount": "指定 {count} 个工具", "scenes.mcp.notRunning": "未运行", "scenes.mcp.edit": "编辑", "scenes.mcp.done": "完成", "scenes.mcp.noteLabel": "场景备注", "scenes.mcp.notePlaceholder": "进入该场景时覆盖全局备注；退出后恢复", "scenes.mcp.hasNote": "有备注",
        "scenes.mcp.toolsOf": "选择工具", "scenes.mcp.probeTools": "启动服务器读取工具", "scenes.mcp.unknownCount": "工具数未知 · 点「编辑」读取", "scenes.mcp.noteHint": "此备注随场景保存；仅在该场景本段**勾选**了这台服务器时，进入场景才会覆盖「MCP」页与系统提示词里的备注，退出后自动恢复。", "scenes.mcp.noTools": "该服务器当前没有可列出的工具（从未运行过，或已配置的工具尚未被记录）", "scenes.mcp.drillHint": "勾选 = 该场景下启用；不勾 = 停用。「全选」= 全部工具（再点一次成「取消全选」= 全部停用）。",
        "scenes.skills.hint": "添加「技能集」后，勾选该场景下启用的技能。没勾的、以及整段没建的，进场景时一律停用（退出按进场景前的开关还原）。被同名技能覆盖的副本与结构不完整的技能不能勾——它们在这个场景里不可能生效。", "scenes.subagents.hint": "勾选本场景要打开的人设；没勾的、以及整段没建的，进场景时一律关闭（退出按进场景前的开关还原）。", "scenes.subagents.empty": "还没有人设——到「子智能体」页创建。",
        "scenes.skills.shadowed.hint": "被同名技能覆盖，在这个场景里不可能生效，因此不能勾选。要改用这一份，请到「技能」页点它的「启用这个」。",
        "scenes.skills.invalid.hint": "技能结构不完整（缺 frontmatter / 名字非法 / 描述为空），无法启停，因此不能勾选。",
        "scenes.filter.skills": "筛选技能/目录名称", "scenes.filter.subagents": "筛选人设（名称或描述）", "scenes.filter.servers": "筛选服务器",
       
        "scenes.mem.title": "记忆", "scenes.mem.search": "在本场景内筛选记忆（名称或描述）",
        "scenes.mem.noMatch": "没有匹配项", "scenes.mem.emptyScene": "该场景还没有记忆",
        "memory.mode.current": "当前模式", "memory.mode.exit": "退出模式",
        "memory.archive.edit": "档案", "memory.archive.title": "场景档案",
        "memory.archive.tools": "MCP 工具集", "memory.archive.skills": "技能集", "memory.archive.subagents": "子智能体绑定", "memory.archive.memories": "记忆", "memory.archive.applyFailed": "运行时未能应用：{reason}",
        "memory.archive.removeSection": "移除段", "memory.archive.save": "保存到场景",
        "memory.archive.addTools": "+ 添加 MCP 工具集", "memory.archive.addSkills": "+ 添加技能集", "memory.archive.addSubagents": "+ 添加子智能体绑定",
        "memory.archive.stale": "已跳过 {items}（已不存在，或被同名技能覆盖 / 结构不完整——本就不生效）",
        "memory.result.archiveSaved": "已保存场景档案：{name}", "memory.result.modeSet": "已进入模式：{name}", "memory.result.modeSwitched": "已切换 {mcp} 台服务器 / {skills} 个来源", "memory.result.modeExited": "已退出模式",
        "memory.desc": "管理记忆：启用的记忆进入系统提示词，可按场景分别启用。",
        "memory.btn.refresh": "刷新", "memory.btn.new": "新增记忆", "memory.btn.create": "创建", "memory.btn.save": "保存",
        "memory.btn.diagnose": "体检", "memory.btn.delete.confirm": "移入回收站",
        "memory.diagnose.title": "记忆体检", "memory.diagnose.summary": "{rules} 条记忆 · {scenes} 个场景 · {issues} 个问题", "memory.diagnose.clean": "未发现问题，一切正常。",
        "memory.diag.error": "错误", "memory.diag.warning": "警告", "memory.diag.info": "提示",
"memory.stat.total": "条记忆", "memory.stat.scenes": "个启用场景", "memory.stat.sceneCount": "个场景", "memory.status.sceneOff": "场景未启用", "memory.status.off": "本条已停用",
        "memory.budget.label": "注入预算", "memory.budget.bytes": "{used} / {max} 字节",
        "memory.budget.over": "已超限",
        "memory.budget.truncated": "超出预算，段尾已列出未注入的记忆",
        "memory.budget.dropped": "本次未注入：{names}",
        "memory.scene.enable": "启用", "memory.scene.enableAll": "全部启用", "memory.scene.off": "未启用", "memory.scene.shared": "常开", "memory.scene.global.tag": "常驻",
        "memory.scene.global": "全局", "memory.scene.count": "{count} 条记忆", "memory.scene.new": "新建记忆", "memory.scene.browse": "选择已有",
        "memory.scene.empty": "该场景暂无记忆",
        "memory.scene.orphan": "未归属场景", "memory.scene.orphan.tag": "不会注入", "memory.scene.orphan.hint": "这些记忆直接放在 memories/ 根层，没有归属场景，因此不会被注入上下文。请把它们移入某个场景目录（或放到 memories/global/ 作为「全局」记忆）。",
        "memory.scene.edit": "改描述", "memory.scene.editTitle": "修改场景", "memory.scene.editHelp": "名称就是它的记忆目录名；改名会连目录、档案与绑定一起改，记忆正文不动。",
        "memory.scene.field.name": "场景名", "memory.scene.field.name.placeholder": "例如 办公",
        "memory.scene.field.name.hint": "名称就是它的一级目录名，之后仍可修改。",
        "memory.scene.field.name.lock": "改名会一起改掉记忆目录、场景档案与启用集合；记忆正文不动。",
        "memory.scene.field.desc": "描述（可选）", "memory.scene.field.desc.placeholder": "一句话说明这个场景是干什么的",
        "memory.search.placeholder": "搜索名称 / 描述 / 场景", "memory.filter.all": "全部场景",
        "memory.empty": "还没有记忆，点「新建记忆」", "memory.empty.search": "没有匹配的记忆",
        "memory.loading": "正在加载…",
        "memory.enable": "启用", "memory.edit": "编辑", "memory.delete": "删除",
        "memory.form.flat": "flat", "memory.form.bundle": "bundle", "memory.derived": "派生", "memory.fill.frontmatter": "补齐 frontmatter",
        "memory.shadowed.hint": "同名 bundle 存在，本条不加载",
        "memory.create.title": "新建记忆", "memory.edit.title": "编辑记忆", "memory.edit.group.lock": "编辑时场景不可修改",
        "memory.field.group": "场景", "memory.field.group.placeholder": "例如 办公", "memory.field.group.hint": "留空 = 全局",
        "memory.field.name": "名称", "memory.field.name.placeholder": "例如 站会流程", "memory.name.invalid": "名称不合法（非空、≤64 字符、不含 / \\ < > : \" | ? *、不以 . 开头）",
        "memory.field.description": "描述", "memory.field.description.placeholder": "一句话说明用途（留空取正文首行）",
        "memory.field.body": "正文（Markdown）", "memory.field.body.placeholder": "写下要记住的约定、流程和边界…",
        "memory.field.form": "形态", "memory.field.attach": "附件",
        "memory.attach.add": "添加附件", "memory.attach.empty": "暂无附件", "memory.attach.pending": "待上传", "memory.attach.remove": "移除附件",
        "memory.attach.hint": "附件随记忆存放，不会进入提示词",
        "memory.attach.count.one": "{count} 个附件", "memory.attach.count.other": "{count} 个附件",
        "memory.attach.tip": "点击管理附件：{count} 个 · 共 {size} —— {names}",
        "memory.attach.tip.empty": "还没有附件——点击添加",
        "memory.attach.more": "，另 {count} 个", "memory.attach.sep": "、", "memory.attach.flat": "flat 是单文件，不能带附件", "memory.attach.tooLarge": "附件过大：{name}（上限 {limit} MB）",
        "memory.delete.title": "移入回收站？", "memory.delete.desc": "「{name}」将移入回收站，可恢复",
        "memory.result.created": "已创建记忆：{name}", "memory.result.updated": "已保存记忆：{name}", "memory.result.removed": "已移入回收站：{name}", "memory.result.toggled": "已更新记忆状态：{name}", "memory.result.active": "已更新启用场景",
        "memory.result.restored": "已恢复记忆：{name}", "memory.result.trashRemoved": "已永久删除：{name}",
        "memory.result.createdAttached": "已创建记忆：{name}（含 {count} 个附件）", "memory.result.updatedAttached": "已保存记忆：{name}（含 {count} 个附件）", "memory.result.attachFailed": "记忆已保存，但附件失败：{error}",
        "memory.trash.open": "回收站", "memory.trash.title": "记忆回收站", "memory.trash.empty": "回收站为空",
        "memory.trash.count": "{count} 条已删除的记忆", "memory.trash.deletedAt": "删除于 {time}",
        "memory.trash.restore": "恢复", "memory.trash.purge": "永久删除",
        "memory.trash.confirmTitle": "永久删除？", "memory.trash.confirmDesc": "「{name}」将永久删除，无法恢复",
        "memory.btn.newScene": "新增场景", "memory.btn.deleteScene": "删除场景", "memory.btn.saveScene": "保存修改",
        "memory.scene.createTitle": "新建场景",
        "memory.deleteScene.title": "删除场景？", "memory.deleteScene.desc": "把「{name}」连同它下面全部记忆（含未启用的）一起移入回收站，可在回收站整条恢复；正在使用的场景不能删。",
        "memory.result.sceneCreated": "已创建场景：{name}", "memory.result.sceneUpdated": "已保存场景：{name}", "memory.result.sceneRemoved": "已删除场景：{name}", "memory.result.sceneRemoved.withMemories": "已删除场景：{name}（连同 {count} 项记忆，可在回收站整条恢复）",
        "memory.table.name": "记忆名称与描述", "memory.table.tags": "标记", "memory.table.status": "状态",
        "error.rules.invalidArgs": "缺少参数：需要 all:true（回到全部启用）或 scenes:[...]（显式收窄）", "error.rules.invalidGroup": "场景/分组名不合法（非空、≤64 字符、不含路径分隔符与 < > : \" | ? *、不以 . 开头）", "error.rules.invalidName": "记忆名不合法（非空、≤64 字符、不含路径分隔符与 < > : \" | ? *、不以 . 开头）", "error.rules.descriptionRequired": "描述不能为空", "error.rules.descriptionTooLong": "描述过长（不能超过 500 字符）", "error.rules.bodyRequired": "正文不能为空", "error.rules.tooLarge": "规则内容过大", "error.rules.shadowed": "规则被同名 bundle 遮蔽，无法写入", "error.rules.exists": "同名记忆已存在，无法写入", "error.rules.notFound": "规则不存在", "error.rules.budgetExceeded": "场景记忆段超出预算", "error.rules.ioFailed": "文件操作失败", "error.rules.nameTaken": "目标名称已被占用", "error.rules.sceneNotEmpty": "场景不为空，无法删除", "error.rules.notBundle": "该记忆是 flat（单文件），不能带附件", "error.rules.noFiles": "没有选择附件", "error.rules.emptyFile": "附件内容为空", "error.rules.fileTooLarge": "附件过大（单个上限 {limit} MB）", "error.rules.tooManyFiles": "一次最多 {limit} 个附件", "error.rules.sceneInMode": "该场景正处在当前模式，请先退出模式再删除",
        "memory.archive.emptySection": "没有勾选任何条目 = 全部停用（整段没建也一样）", "memory.archive.emptySubagents": "没有勾选任何条目 = 本场景不启用任何人设（整段没建也一样）",
        "subagents.title": "子智能体", "subagents.stat.total": "个子智能体", "subagents.stat.limited": "个有工具限制", "subagents.desc": "管理子智能体：新建、导入人设，正文即子代理的系统提示词。",
        "prompts.desc": "管理提示词：预设全局指令基线，应用后写入 AGENTS.md，下一轮对话生效。",
        "sessions.desc": "管理已归档会话：可恢复或永久删除，超保留期自动清理。",
        "subagents.new": "新增子智能体", "subagents.empty": "还没有子智能体——点「新增子智能体」创建第一个。",
        "subagents.create": "新建人设", "subagents.edit": "编辑人设",
        "subagents.field.name": "人设名",
        "subagents.field.description": "描述", "subagents.field.description.placeholder": "例如 擅长 Java 后端实现与重构",
        "subagents.field.model": "模型", "subagents.field.model.placeholder": "自定义模型 id", "subagents.field.model.hint": "留空继承主会话", "subagents.field.provider": "模型来源", "subagents.field.provider.placeholder": "deepseek", "subagents.field.provider.hint": "「模型来源」与「模型」是一对：只填模型会落在主会话的来源上，跨来源会解析失败。",
        "subagents.field.catalogDepth": "目录注入", "subagents.field.catalogDepth.onlyTop": "只在顶层", "subagents.field.catalogDepth.toChild": "顶层和子会话", "subagents.field.catalogDepth.toGrand": "顶层和两层子会话", "subagents.field.catalogDepth.unlimited": "不限制嵌套", "subagents.field.catalogDepth.hint": "决定人设目录注入到哪几层会话。\n只影响目录注入，不影响委派 —— 子代理始终可以继续委派。\n子会话看不到目录时，可用 subagent_manager_list 查询。",
        "subagents.model.inherit": "继承主会话（不指定）", "subagents.model.customOption": "自定义 / 目录里没有…",
        "subagents.field.modes": "工具限制（按 Agent 预设）",
        "subagents.field.modes.hint": "只有当前模式那一行生效，其他模式用该模式的全部工具。",
        "subagents.mode.startAllow": "启动白名单", "subagents.mode.startDeny": "启动黑名单", "subagents.mode.stopAllow": "关闭白名单", "subagents.mode.stopDeny": "关闭黑名单",
        "subagents.mode.off": "未限制", "subagents.mode.empty": "已启动但没勾选（= 不限制）",
        "subagents.mode.allowOn": "白名单 {count} 个", "subagents.mode.denyOn": "黑名单 {count} 个",
        "subagents.mode.allowEmpty": "一个都没勾 = 不限制（该模式的全部工具都能用）",
        "subagents.mode.denyEmpty": "一个都没勾 = 不限制（该模式的全部工具都能用）",
        "subagents.mode.noTools": "读不到这个模式的工具清单",
        "subagents.mode.broken": "这个预设已损坏，读不到工具清单",
        "subagents.mode.toggleHint": "展开 / 收起这个模式的名单设置（右侧按钮负责启用 / 停用）",
        "subagents.mode.noPresets": "宿主没有回传 Agent 预设名单",
        "subagents.legacy.note": "这个文件里还有一份旧写法的工具限制（白名单 {allow} 个 / 黑名单 {deny} 个），它对所有模式都生效。",
        "subagents.legacy.convert": "转换到按模式设置",
        "subagents.legacy.hint": "转换会把旧名单搬进你选的模式；不点它，文件里的旧键原样保留（运行时照旧生效）。",
        "subagents.tools.filter": "筛选工具名", "subagents.tools.remove": "移除",
        "subagents.adv.title": "高级选项", "subagents.adv.inherit": "继承主会话", "subagents.adv.summary": "模型 {model} · 目录注入 {depth} · 模式限制 {modes} 项 · 旧格式 白名单 {allow} / 黑名单 {deny}", "subagents.adv.note": "白名单 = 子代理只能用勾选的工具。\n黑名单 = 除勾选的以外都能用。\nMCP 工具不在候选里：子代理始终能用当前在跑的 MCP。", "subagents.adv.loadFailed": "读取候选数据失败（模型目录 / 工具清单）；仍可手动填写。",
        "preset.name.standard": "标准模式", "preset.name.ptc": "PTC 模式", "preset.name.minimal": "极简模式", "preset.name.cordis": "创造模式",
        "preset.short.standard": "标准", "preset.short.ptc": "PTC", "preset.short.minimal": "极简", "preset.short.cordis": "创造",
        "subagents.field.body": "人设提示词", "subagents.field.body.placeholder": "写下这个人设的身份、职责与工作方式…",
        "subagents.field.output": "输出要求（硬性）", "subagents.field.output.placeholder": "每行一条硬要求，例如：每条问题一个块：[P0|P1|P2] 文件:行 — 问题 — 后果 — 修复方向",
        "subagents.field.output.hint": "子代理系统提示词里单独成节，写「产出必须长什么样」—— 只写可检验的要求。",
        "subagents.result.saved": "已保存人设：{name}", "subagents.result.deleted": "已删除人设：{name}",
        "subagents.delete.title": "删除人设？", "subagents.delete.desc": "将把「{name}」的人设文件移入回收站（子智能体页的「回收站」里可以恢复）。",
        "subagents.import": "导入子智能体", "subagents.import.title": "导入子智能体", "subagents.toggle": "启用子智能体", "subagents.disabled": "已停用", "subagents.disabled.hint": "停用后不注入上下文，subagent_manager_list / subagent_manager_run 也看不到；文件保留，随时可再打开。",
        "subagents.result.imported": "已导入 {count} 个人设：{names}",
        "memory.import": "导入记忆", "memory.import.title": "导入记忆", "memory.import.scene": "导入到场景",
        "memory.result.imported": "已导入 {count} 条记忆：{names}",
        "memory.import.scenesCreated": "为此新建了场景：{names}",
        "memory.scene.global.hint": "全局",
       "import.clear": "清空选择", "import.submit": "导入",
        "import.none": "没有导入任何文件（全部被跳过）", "import.skipped": "已跳过：{items}",
        "error.import.noFiles": "没有选择要导入的文件",
        "nav.title": "工具",
        "agm.stat.total": "个提示词", "agm.stat.active": "个生效中", "agm.loading": "加载中…", "agm.empty": "暂无提示词，点「新增提示词」创建", "agm.btn.delete.blocked.refs": "不能删除：{refs}。先改掉引用（换绑提示词 / 退出场景 / 应用别的预设）再删除。", "agm.ref.sep": "；", "agm.ref.scene": "场景「{scene}」绑定了它", "agm.ref.sceneActive": "场景「{scene}」（已启用）绑定了它", "agm.ref.file": "AGENTS.md 当前内容就是它", "agm.ref.restore": "退出场景后要恢复的全局提示词", "agm.sceneLock.notice": "场景「{scene}」接管中：当前生效的是它绑定的「{id}」。在这里应用别的预设 = 把该场景改绑到那一份（会同步写入场景档案）。", "agm.active": "生效中", "agm.active.hint.scene": "当前生效：场景「{scene}」绑定的提示词预设", "agm.active.hint.file": "当前生效：AGENTS.md 就是这一份", "agm.file.applied": "文件里是它", "agm.file.applied.hint": "AGENTS.md 当前内容是它；启用的场景绑了别的提示词，切换场景时已按场景把文件改成那一份", "agm.apply.hint": "应用后写入 AGENTS.md；宿主每轮重读该文件，下一轮对话生效", "agm.btn.reapply": "重新应用", "agm.btn.apply": "应用", "agm.applyModal.title": "应用预设", "agm.edit.title": "编辑预设", "agm.remove.title": "删除预设", "agm.btn.edit": "编辑", "agm.btn.delete": "删除", "agm.btn.new": "新增提示词", "agm.btn.import": "导入提示词", "agm.result.imported": "已导入 {count} 份预设：{names}", "agm.btn.save": "保存", "agm.btn.create": "创建", "agm.btn.confirmRemove": "确认删除", "agm.btn.confirmApply": "确认应用", "agm.field.id": "id（目录名）", "agm.field.id.hint": "中文、空格、点都可以；不能含斜杠、反斜杠与 : * ? < > 等符号；≤64 字符。改 id 等于目录改名。", "agm.field.id.placeholder": "例如：工作基线", "agm.field.content": "内容", "agm.field.content.placeholder": "直接写这份预设的正文（Markdown）；留空 = 用空白模板", "agm.field.copyFrom": "或从现有预设复制", "agm.field.copyFrom.none": "不复制（空白模板）", "agm.field.desc": "描述（只给使用者看）", "agm.field.desc.placeholder": "这份预设是干什么的、什么时候用它", "agm.result.renamed": "已保存，id 改为「{id}」", "agm.result.rebound": "（同步了 {count} 个场景的绑定）", "agm.remove.suffix": " ？此操作不可恢复。", "agm.apply.prefix": "将把 ", "agm.apply.suffix": " 的内容写入 ~/.dsh/AGENTS.md。", "agm.apply.note": "下一轮对话生效；当前内容已备份到 __last-applied__（保留最近 5 代）", "hist.err.load": "加载失败", "hist.err.unarchive": "恢复失败", "hist.err.delete": "删除失败", "hist.err.retention": "设置失败", "hist.err.import": "导入失败", "hist.err.sessions": "加载会话列表失败", "hist.err.export": "导出失败", "hist.err.archive": "归档失败", "hist.retention.forever": "永久保留", "hist.retention.days": "{count} 天", "hist.arch.all": "全部会话", "hist.arch.archived": "仅已归档", "hist.arch.live": "仅未归档", "hist.arch.missing": "仅目录丢失", "hist.ws.all": "全部工作区", "hist.ungrouped": "未分组", "hist.group.removed": "已移除", "hist.group.removed.hint": "该目录当前在 DSH 里没有工作区登记；分组按会话目录重建，重新登记后会自动并回同一组", "hist.group.dirMissing": "目录已不存在", "hist.group.dirMissing.hint": "工作区目录已从磁盘删除，无法重新登记；组内会话仍可恢复（归入未分组）或永久删除", "hist.btn.registerWs": "重新登记", "hist.btn.registerWs.hint": "重新登记这个目录，并把该目录下已有的会话挂回该组（只写工作区记账，不移动、不删除文件与会话）", "hist.register.title": "重新登记？", "hist.register.body": "将为「{title}」在 DSH 中重新创建一条工作区登记，并把该目录下已有的会话挂回这个工作区（恢复其分组）。只写工作区记账，不移动、不删除任何文件与会话。", "hist.register.confirm": "确认登记", "hist.register.done.title": "已重新登记", "hist.register.done.body": "工作区「{title}」已登记；该目录下的归档会话会在刷新后并入这一组。", "hist.register.done.attached": "已把该目录下 {count} 个已有会话挂回这个工作区。", "hist.register.done.skipped": "{count} 个会话未能挂回：{reason}", "hist.err.register": "登记失败", "scenes.field.prompt": "提示词预设", "scenes.agents.note.applied": "已把「{id}」写入 AGENTS.md", "scenes.agents.note.restored": "已恢复进场景前的 AGENTS.md", "scenes.agents.note.error": "AGENTS.md 未写入：{reason}", "scenes.field.prompt.hint": "启用场景即以它为全局基线。\n启用期间在提示词页「应用」别的预设 = 改绑到那一份（同步写进档案）。", "scenes.prompt.activeTag": "生效中", "scenes.prompt.noPresets": "还没有提示词预设；可先去「提示词」页新建一个。", "scenes.prompt.bound": "提示词：{id}", "scenes.prompt.live": "提示词生效中：{id}", "scenes.prompt.missing": "预设不存在：{id}", "scenes.prompt.tag.hint": "这个场景绑定的提示词预设", "scenes.prompt.mismatch.hint": "场景绑定的「{id}」与 AGENTS.md 当前内容不一致（可能被手动改过）；到提示词页对它点「重新应用」写回", "scenes.enable.blocked": "已启用场景「{name}」；先关掉它才能启用别的", "scenes.result.created.collapsed": "场景「{name}」已创建，默认不启动（原先的「全部启用」已收敛为单选）", "scenes.legacyAll": "检测到 {count} 个场景同时处于启用状态（历史「全部启用」遗留）；除「全局」外同时只能启用一个。", "scenes.legacyAll.fix": "收敛为单选", "agm.restore.tag": "退出场景后恢复它", "agm.restore.tag.hint": "它是进场景前的全局提示词，退出场景时会按它恢复——删了就没法恢复了", "agm.file.mismatch": "文件里不是它", "agm.file.mismatch.hint": "AGENTS.md 当前内容与这份预设不一致（可能被手动改过）；点「重新应用」把它写回", "hist.restore.note.registered": "已恢复 {count} 个会话；工作区「{title}」已重新登记，会话已挂回该组。", "hist.restore.note.attached": "已恢复 {count} 个会话，并挂回工作区「{title}」。", "hist.restore.note.skip": "{count} 个会话的工作区归属未能恢复：{reason}", "hist.purge.title": "永久删除？", "hist.purge.one": "永久删除会话「{title}」及其全部记录，不可恢复", "hist.purge.batch": "永久删除所选 {count} 个会话及其全部记录，不可恢复", "hist.btn.restore": "恢复", "hist.btn.purge": "永久删除", "hist.btn.confirmPurge": "确认删除", "hist.selectGroup": "全选组 {title}", "hist.group.count": "{count} 个", "hist.selectAll": "全选", "hist.deselectAll": "取消全选", "hist.btn.import": "导入会话", "hist.btn.export": "导出会话", "hist.selected": "已选 {count} 项", "hist.btn.restoreSelected": "恢复所选 ({count})", "hist.btn.deleteSelected": "删除所选 ({count})", "hist.stat.archived": "个归档", "hist.stat.projects": "个项目", "hist.stat.retention": "天保留", "hist.search.placeholder": "搜索标题 / 会话 ID / 项目路径", "hist.loading": "加载中…", "hist.empty.search": "无匹配的归档会话", "hist.empty.none": "暂无归档会话", "hist.import.cwd": "项目目录（可留空）", "hist.import.cwd.placeholder": "绝对路径，可留空（会话归入未分组）", "hist.import.drop": "选择或拖入对话文件", "hist.import.done": "已创建会话 {id}（{count} 条消息），可在 DSH 会话列表中继续对话。", "hist.export.hint": "导出选中会话为转录文件，可再次导入", "hist.export.dir": "导出目录（绝对路径，自动创建）", "hist.export.browse": "浏览并选择文件夹", "hist.btn.browse": "选择", "hist.export.pickDir": "选择导出目录", "hist.export.format": "格式", "hist.export.scope": "会话范围", "hist.export.workspace": "工作区", "hist.export.sessions": "会话（{count} 个）", "hist.export.loading": "加载会话列表…", "hist.cwd.missing": "⚠ 工作区目录已不存在：", "hist.tag.archived": "已归档", "hist.tag.live": "未归档", "hist.export.empty": "没有符合条件的会话", "hist.result.exported": "已导出 {count} 个会话到 {dir}", "hist.result.skipped": "；跳过 {count} 个（{ids}）", "hist.result.archived": "已归档 {count} 个会话到 History，可到 History 页继续管理", "hist.btn.archiveSelected": "归档所选", "hist.btn.archiveSelected.title": "把选中的会话收进 History，纳入保留期管理", "hist.export.busy": "处理中…", "hist.btn.exportSelected": "导出 {count} 个会话", "hist.error.title": "操作失败", "hist.error.unknown": "未知错误",
      },
      en: {
        "title": "Skills", "desc": "Manage skills: enable, import, create, trash.", "link.project": "GitHub", "link.feedback": "Issues",
        "btn.create": "New skill", "btn.import": "Import skills", "btn.refresh": "Refresh", "btn.refreshing": "Refreshing…", "btn.cancel": "Cancel", "btn.close": "Close", "export.hint": "Exports a zip into the directory you choose; source files are read-only and nothing is modified.", "export.outDir": "Output directory", "export.outDir.placeholder": "e.g. D:////backup", "export.pickDir": "Choose output directory", "export.submit": "Export", "export.busy": "Exporting…", "export.done": "Exported {count} file(s) to {path}", "scenes.lock.lock": "Lock", "scenes.lock.unlock": "Unlock", "scenes.lock.tag": "Locked", "scenes.lock.hint": "Locking makes all five domains (MCP / skills / subagents / memories / prompts) read-only; starting or stopping scenes still works", "scenes.lock.blockedEdit": "Scene is locked — unlock it to make changes", "scenes.lock.notActive": "Scene is not active — start it before locking", "scenes.lock.blockedExit": "Scene is locked — unlock it before turning it off", "lock.banner": "A scene is locked: MCP, skills, subagents, memories and prompts are frozen. Unlock it on the Scenes page to make changes.", "scene.switch.banner": "Scene “{scene}” is active: switches here work as usual and are written into that scene’s profile too (they take effect immediately and are kept for the next visit; leaving the scene still restores the state from before).", "scene.sync.failed": "Heads-up: the change took effect, but it could not be written into the scene profile ({error}) — it holds for this visit only; re-entering this scene will apply the older profile.", "agm.apply.rebindScene": "Scene “{scene}” is driving the baseline: applying this preset rebinds that scene to it (written into the scene profile as well)", "export.empty": "Nothing to export", "export.pickAll": "Select all", "export.pickNone": "Deselect all", "export.group.count": "{count}", "export.missing": "; skipped {count} (missing on disk): {names}", "export.skills": "Export skills", "export.subagents": "Export subagents", "export.presets": "Export prompts", "export.memories": "Export memories", "btn.detail": "View details", "btn.trash": "Move to trash", "btn.restore": "Restore", "btn.delete.forever": "Delete forever", "btn.file.pick": "Choose file", "btn.folder.pick": "Choose folder", "btn.create.now": "Create skill", "btn.disable": "Disable", "btn.enable": "Enable", "btn.open.editor": "Open in editor", "btn.activate": "Use this one", "btn.activate.title": "Make this source's copy the active one for this shared name and enable it (source files are never touched)", "btn.unprefer": "Auto again", "btn.unprefer.title": "Clear the manual choice and go back to automatic source priority",
        "btn.custom.add": "Add folder",
        "btn.custom.remove": "Remove",
        "btn.source.remove": "Remove source", "btn.source.remove.title": "Stop reading this source (files stay on disk; restore it later from the trash)", "btn.source.restore": "Restore", "btn.source.forget": "Delete forever",
        "trash.section.dirs": "Directories", "trash.section.skills": "Skills", "trash.section.dirs.sub": "No longer read — files on disk are untouched", "trash.section.dirs.empty": "No removed sources", "trash.section.skills.sub": "Files really were moved: restore brings them back, delete-forever removes them", "trash.section.presets.sub": "Preset folders were moved: restore brings them back, delete-forever removes them", "trash.section.scenes.sub": "Scene record, profile and its memories are all here: restore puts everything back", "trash.section.agents.sub": "Persona files were moved: restore brings them back, delete-forever removes them",
        "trash.dirs.count.one": "{count} directory pending", "trash.dirs.count.other": "{count} directories pending",
        "trash.row.summary": "{skills} skill(s) · {dirs} director(ies)",
        "confirm.source.forget.title": "Delete this source record for good?", "confirm.source.forget.desc": "“{name}” is removed from the plugin entirely: it disappears from the source list and “Read again” cannot bring it back (you would have to add the folder again).",
        "confirm.source.forget.hint": "Not a single byte is deleted on disk: {path}.",
        "result.sourceForgotten": "Source record deleted for good: {name}",
        "confirm.source.remove.title": "Remove this source?", "confirm.source.remove.desc": "“{name}” will no longer be read: its skills disappear from this page and stop taking part in name resolution; your enable/disable choices are kept.",
        "confirm.source.remove.hint": "No file is deleted. Once removed it shows up under Trash → Directories, where “Read again” brings it back (or you can delete the record for good).",
        "result.sourceRemoved": "Source removed: {name} (no longer read)", "result.sourceRestored": "Reading again: {name}",
        "btn.openDir": "Browse",
        "custom.add.title": "Add custom skill folder",
        "custom.add.submit": "Add",
        "custom.add.path": "Absolute folder path",
        "custom.add.path.placeholder": "e.g. D:\\skills\\my-skills",
        "custom.add.openDir.title": "Browse and pick a folder",
        "custom.add.picker.title": "Pick a folder",
        "custom.add.label": "Display name (optional)",
        "custom.add.label.placeholder": "Custom folder",
        "custom.add.help": "Read-only: neither the folder nor its files are modified",
        "confirm.custom.remove.title": "Remove custom folder?",
        "confirm.custom.remove.desc": "Its skills stop being listed (files are untouched): {name}",
        "result.custom.added": "Custom folder added: {path}",
        "result.custom.removed": "Custom folder removed: {name}",
        "result.opened": "Opened with the system default app: {path}",
        "status.enabled": "Enabled", "status.disabled": "Disabled", "status.invalid": "Needs attention", "status.shadowed": "Shadowed", "status.shadowed.hint": "The copy “{name}” is the active one; click “Use this one” to switch to this source instead", "status.preferred": "Manually chosen", "status.readonly": "Source read-only", "status.notDeletable": "Cannot delete", "status.notDeletable.hint": "Deleting is available for plugin-managed sources (DSH skills / Imported skills / project .dsh/skills); external agent and custom directories are read-only", "status.manageable": "Manageable", "status.project": "Project scoped", "status.rank": "Rank {rank}", "status.source.on": "Enabled", "status.source.off": "Disabled", "status.bundle": "Bundle", "status.single": "Single file",
        "summary.total.one": "{count} skill", "summary.total.other": "{count} skills", "summary.enabled.one": "{count} enabled", "summary.enabled.other": "{count} enabled", "summary.issues.one": "{count} diagnostic", "summary.issues.other": "{count} diagnostics", "summary.group.one": "{count} skill", "summary.group.other": "{count} skills", "table.skill": "Skill name and description", "table.status": "Invocation status",
        "filter.source": "Source", "filter.all": "All sources", "filter.option": "{name} ({count})", "search": "Search", "search.placeholder": "Search skill names or descriptions", "search.clear": "Clear search",
        "empty.search": "No matching skills", "empty.source": "This source is missing or has no skills", "loading": "Loading skills…", "note.missing": "No description provided", "source.toggle": "Toggle source", "skill.toggle": "Toggle skill",
        "source.external.note": "Read-only; toggles never rewrite source files", "source.dsh.note": "Create, import, trash; a default source, always read — it cannot be removed or toggled off",
        "detail.title": "Skill details", "detail.body": "Body", "detail.frontmatter": "Metadata", "detail.noFrontmatter": "This skill provides no metadata.", "detail.diagnostics": "Diagnostics", "detail.path": "Source file", "detail.noIssues": "No diagnostic issues found.",
        "create.title": "Create skill", "create.target": "Create in", "create.name": "Name", "create.name.placeholder": "e.g. code-review-helper", "create.description": "Description", "create.description.placeholder": "One sentence describing when to use it", "create.body": "Body (Markdown)", "create.body.placeholder": "Write the instructions, steps, and boundaries…", "create.chat.note": "skill_manager_create in chat creates user-level skills",
        "import.title": "Import skill", "upload.drop.title": "Click or drop here", "upload.drop.copy": "Supported: .zip, a skill folder, or one SKILL.md", "upload.selected.one": "{count} file · {size}", "upload.selected.other": "{count} files · {size}", "upload.remove": "Remove selection", "upload.requirements": "File requirements", "upload.requirement.skill": "Archives and folders must contain SKILL.md", "upload.requirement.frontmatter": "SKILL.md must include a YAML name and description", "upload.requirement.copy": "Import copies all content and never modifies the source", "upload.requirement.persona.1": "Accepts .md / .zip (multi-select or drag in)", "upload.requirement.persona.2": "One .md = one persona; the file name is the persona name", "upload.requirement.persona.3": "Same names are skipped, never overwritten", "upload.requirement.memory.1": "Accepts .md / .zip (multi-select or drag in)", "upload.requirement.memory.2": "One .md = one memory; the file name is the memory name", "upload.requirement.memory.3": "A folder with SKILL.md becomes a bundle memory (attachments included)", "upload.requirement.memory.4": "Folder names inside the zip are scenes; otherwise the scene field below applies (blank = global)", "upload.requirement.prompt.1": "Accepts .md (multi-select or drag in)", "upload.requirement.prompt.2": "One .md = one preset; the file name is the id", "upload.requirement.prompt.3": "A preset with the same name is skipped, never overwritten", "upload.requirement.session.1": "Accepts .jsonl / .json / .md / .txt (one file at a time)", "upload.requirement.session.2": "Transcripts from Claude Code / Cursor / Codex, or any plain text", "upload.requirement.session.3": "The project directory may be left blank (the session goes to Ungrouped)", "upload.importing": "Importing…", "status.selected": "Selected", "select.file.invalid": "Choose a .zip archive or one SKILL.md.", "select.folder.invalid": "No SKILL.md was found in the selected folder.", "error.browse.absolute": "Folder path must be absolute: {path}", "error.browse.unreadable": "Could not read folder: {path}", "error.browse.notDirectory": "Not a folder: {path}",
        "error.custom.absolute": "The folder path must be absolute: {path}", "error.custom.notDirectory": "Not a folder: {path}", "error.custom.unreadable": "Could not read the folder: {path}", "error.custom.overlap": "The folder overlaps an existing skill source: {path} ↔ {other}", "error.custom.invalidKey": "Invalid custom source key: {key}", "error.custom.notFound": "Custom source not found: {key}",
        "error.secret.noToken": "Plain-text reveal and export are disabled: the host has no access token configured. Add token to this plugin's configuration (or set the DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN environment variable), restart DSH, then enter the same token in the panel.", "error.secret.badToken": "The access token is missing or incorrect: enter the same token as the host configuration in the panel (sent as x-dsh-token with every request).",
        "dir.title": "Choose a folder", "dir.currentPath": "Current path", "dir.pathPlaceholder": "Type a folder path and press Enter to jump", "dir.jump": "Go", "dir.loading": "Loading…", "dir.empty": "(No subfolders in this folder)", "dir.up": "Up one level", "dir.pick": "Choose this folder", "dir.error.unreadable": "Could not read the folder",
        "fm.label.name": "Name", "fm.label.description": "Description", "fm.label.when-to-use": "When to use", "fm.label.user-invocable": "User invocable", "fm.label.disable-model-invocation": "Model invocation disabled", "fm.label.allowed-tools": "Allowed tools", "fm.label.license": "License", "fm.label.version": "Version", "fm.label.author": "Author", "fm.label.category": "Category", "fm.label.tags": "Tags", "fm.label.metadata": "Metadata", "fm.label.homepage": "Homepage", "fm.yes": "Yes", "fm.no": "No",
        "error.rules.sceneNotFound": "Scene not found: {group} (create it on the Scenes page first)",
        "error.rules.reservedScene": "「{name}」 is a reserved scene: {action} is not allowed{reason}",
        "error.rules.singleSceneOnly": "Only one scene besides 「global」 may be enabled at a time{detail}",
        "error.agentsMd.sceneRebindFailed": "Cannot change the prompt binding of scene 「{scene}」 to 「{target}」: {reason}",
        "error.agentsMd.referenced": "「{id}」 is still referenced and cannot be deleted: {refs}. Remove those references first (rebind the prompt / leave the scene / apply another preset).",
        "error.source.reserved": "{origin}: cannot be disabled or removed (the skills inside can still be deleted)",
        "action.rename": "rename", "action.lock": "locking",
        "trash.title": "Trash", "trash.count.one": "{count} skill pending", "trash.count.other": "{count} skills pending", "trash.empty": "Trash is empty", "trash.deletedAt": "Deleted {time}", "trash.source": "Source: {source}",
        "trash.btn.open": "Trash", "trash.items.count": "{count} item(s)", "trash.purge.confirm": "Delete forever?",
        "trash.group.agents": "Personas", "trash.group.scenes": "Scenes", "trash.group.presets": "Prompt presets",
        "trash.restored": "Restored “{name}”", "trash.purged": "Permanently deleted “{name}”", "trash.loadFailed": "Could not read the trash",
        "confirm.trash.title": "Move to trash?", "confirm.trash.desc": "“{name}” moves to trash and can be restored", "confirm.delete.title": "Delete forever?", "confirm.delete.desc": "“{name}” is deleted forever and cannot be recovered",
        "result.created": "Created skill: {name}", "result.imported": "Import complete: {names}", "result.importPartial": "Imported: {imported}; skipped existing skills: {skipped}", "result.importSkipped": "No skills were imported; existing skills were skipped: {names}", "result.importEmpty": "No skills were imported.", "result.importWarnings": "{result}; warnings: {warnings}", "result.restored": "Restored skill: {name}", "result.trashed": "Moved to trash: {name}", "result.deleted": "Permanently deleted: {name}", "result.updated": "Status updated.", "result.preferred": "Now active: {name} ({source})", "result.unpreferred": "Cleared the manual choice: {name}", "error.action": "Action failed: {error}",
        "warning.scan.truncated": "Some skills were not shown because the directory is too large or deeply nested: {path}", "warning.state.invalid": "The manager state file could not be read; all skills are disabled and state writes are blocked until it is repaired: {path}", "warning.backupUncleaned": "Old version backup was not cleaned up: {path} ({error})", "warning.project.unavailable": "The active workspace could not be read from the host, so its project skills are hidden: {path}",
        "error.root.readonly": "This source does not allow {action}", "error.root.disabled": "The “{name}” source is disabled as a whole — enable that source first", "error.root.unknown": "Unknown skill source: {root}", "error.root.unsafe": "The project skill directory is unsafe, so the write was refused: {path}", "error.skill.notFound": "Skill not found: {name}", "error.skill.noFrontmatter": "Skill lacks complete frontmatter, cannot {action}: {name}", "error.skill.notLoadable": "Skill structure is incomplete, cannot {action}: {name}", "error.skill.notDeletable": "Skills from this source cannot be deleted (disable them instead); deletion is available for project-level sources only (<project>/.dsh/skills)",
        "error.source.notFound": "Path does not exist: {path}", "error.source.symlink": "Symlinked sources are not supported: {path}", "error.source.unrecognized": "Unrecognized skill source: {path}", "error.source.tooDeep": "Skill source directory depth exceeds {depth} levels: {path}",
        "error.import.overlap": "This folder overlaps the DSH skills folder", "error.import.emptySource": "No skill entries in this folder: {path}", "error.import.invalidName": "Invalid name: {name}", "error.import.duplicateName": "Batch source contains duplicate skill names: {name}", "error.import.failed": "Import failed", "error.import.rollbackFailed": "Overwrite import rollback failed; backups kept at: {path} ({error})",
        "error.upload.path": "Upload contains an invalid path: {path}", "error.upload.encoding": "Upload encoding is invalid", "error.upload.empty": "Upload is empty", "error.upload.tooMany": "Too many uploaded files; maximum {limit}", "error.upload.tooLarge": "Upload is too large; limit {limit} bytes", "error.upload.archiveTooLarge": "ZIP archive is too large; limit {limit} bytes", "error.upload.duplicate": "Upload contains a duplicate path: {path}", "error.upload.zipInvalid": "ZIP archive could not be extracted",
        "error.trash.notFound": "Trash item not found: {id}", "error.trash.conflict": "Cannot restore because a skill with the same name exists: {name}", "error.trash.invalid": "Invalid trash item path: {id}", "error.trash.projectUnavailable": "The original project is not an active workspace, so this skill cannot be restored: {path}", "error.trash.rollbackFailed": "Move-to-trash rollback failed; unrecovered content was kept at: {path} ({error})",
        "error.state.invalid": "The manager state file could not be read, so overwriting it was refused: {path}",
        "error.create.descriptionRequired": "Skill description is required", "error.create.bodyRequired": "Skill body is required", "error.create.tooLarge": "Skill content is too large", "error.create.conflict": "A skill with the same name already exists: {name}",
        "error.proto.forbidden": "Forbidden mutation request (missing client marker)", "error.proto.forbiddenHost": "Forbidden request origin (invalid host)", "error.proto.contentType": "Content type must be application/json", "error.proto.method": "Method not allowed", "error.proto.unknownAction": "Unknown action", "error.proto.bodyTooLarge": "Request body too large", "error.proto.invalidJson": "Invalid JSON request body", "error.proto.nonJson": "Server returned a non-JSON response (HTTP {status})",
        "diagnostic.frontmatter.missing": "Missing complete YAML frontmatter", "diagnostic.name.missing": "Frontmatter is missing name", "diagnostic.name.invalid": "Skill name must be kebab-case: {name}", "diagnostic.description.missing": "Frontmatter is missing description", "diagnostic.invocation.invalid": "Invocation policy value is invalid", "diagnostic.shadowed": "Shadowed by higher-priority source {root}",
        "action.enable": "enable", "action.disable": "disable", "action.create": "create", "action.delete": "delete", "action.restore": "restore", "action.toggle": "enabling or disabling",
        "mcp.desc": "Manage MCP: add, enable/disable, restart, and per-tool switches.",
        "mcp.level.all": "All levels", "mcp.level.project": "Profile level", "mcp.level.global": "Global", "mcp.level.loader": "Loaded",
        "mcp.stat.total": "server(s)", "mcp.stat.enabled": "enabled", "mcp.stat.tools": "tool(s)",
        "mcp.search": "Search servers", "mcp.search.placeholder": "Search a server name, URL or command",
        "mcp.btn.new": "New MCP", "mcp.btn.add": "Add", "mcp.btn.save": "Save", "mcp.btn.detail": "Details", "mcp.btn.edit": "Edit", "mcp.btn.restart": "Restart", "mcp.btn.remove": "Delete",
        "mcp.btn.enableAll": "Enable all", "mcp.btn.disableAll": "Disable all",
        "mcp.loading": "Loading MCP servers…", "mcp.empty": "No MCP servers yet — click “New MCP”.", "mcp.empty.search": "No matching server.",
        "mcp.servers.count": "{count} server(s)", "mcp.tools.count": "{count} tool(s)", "mcp.tools.countPartial": "{enabled}/{total} tool(s)", "mcp.duplicate": "duplicate id",
        "mcp.table.name": "Server name and URL", "mcp.table.transport": "Transport and tools", "mcp.table.status": "Status",
        "mcp.live.notLoaded": "not loaded", "mcp.live.failed": "start failed", "mcp.live.stopped": "stopped", "mcp.live.loading": "loading", "mcp.live.noTools": "no usable tools", "mcp.live.running": "running",
        "mcp.live.failedHint": "Start failed — check the configuration and click “Restart” to retry", "mcp.live.offlineHint": "Not connected: no tools are registered, but it had {count} tools when it last connected. Check the network, command or credentials, then click “Restart”", "mcp.live.neverHint": "Never connected: no tools have ever been registered. Check the command, arguments or credentials, then click “Restart”", "mcp.live.allOffHint": "All tools are disabled: nothing is callable right now (re-enable them to restore)",
        "mcp.note.prefix": "Note: ", "mcp.toggleServer": "Toggle server", "mcp.toggleTool": "Toggle tool",
        "mcp.msg.ok": "Done", "mcp.msg.failed": "Operation failed", "mcp.msg.loadFailed": "Load failed", "mcp.msg.warn": "Done, but the loader reported: {warning}",
        "mcp.msg.toolOn": "Enabled tool: {name}", "mcp.msg.toolOff": "Disabled tool: {name}",
        "mcp.form.addTitle": "Add MCP server", "mcp.form.editTitle": "Edit MCP server: ",
        "mcp.field.serverName": "Server name (serverName)", "mcp.field.serverName.hint": "1-32 chars of [A-Za-z0-9_-]; the patch registers it under this name",
        "mcp.field.transport": "Transport", "mcp.field.level": "Level",
        "mcp.field.level.project": "Profile level (this app: {path})", "mcp.field.level.global": "Global (across profiles: {path})",
        "mcp.field.url": "Server URL", "mcp.field.url.hint": "Must start with http(s)://",
        "mcp.field.command": "Command", "mcp.field.args": "Arguments (space or newline separated)",
        "mcp.field.env": "Environment (one key=value per line)", "mcp.field.env.hint": "Use the platform's own path syntax (backslashes on Windows, / on macOS/Linux).",
        "mcp.field.headers": "Headers (one key=value per line)",
        "mcp.detail.title": "Server details: ", "mcp.detail.config": "Configuration", "mcp.detail.showSecret": "Reveal secrets", "mcp.detail.hideSecret": "Hide secrets",
        "mcp.token.label": "Access token", "mcp.token.placeholder": "Same value as the host token", "mcp.token.save": "Save and retry",
        "mcp.token.hint": "Plaintext secrets need the matching access token: set token in the host config (or the DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN env var), restart DSH, then enter the same value here.",
        "mcp.btn.compact": "Tidy patch", "mcp.btn.compact.title": "Clear the stale on/off records left in the patch file (each server's enabled/disabled state is unchanged)",
        "mcp.compact.title": "Tidy the patch file", "mcp.compact.desc": "Clears stale on/off records left behind by switching the same server on and off over time.",
        "mcp.compact.confirm": "Tidy now", "mcp.compact.done": "Patch file tidied: cleared {count} stale on/off record(s); no server changed state", "mcp.compact.clean": "The patch file is already clean — nothing stale to clear",
        "mcp.detail.entryId": "Entry id", "mcp.detail.status": "Status", "mcp.detail.loader": "Loader registration", "mcp.detail.loader.yes": "Registered", "mcp.detail.loader.no": "Not registered",
        "mcp.tools.stale": "from last run", "mcp.tools.expand": "Show more", "mcp.tools.collapse": "Show less",
        "mcp.detail.note": "Note (sent to the model with the injected runtime snapshot; when a suppressing preset keeps it out, mcp_manager_list still reads it back)", "mcp.detail.note.placeholder": "e.g. fall back to B when A is unavailable", "mcp.detail.note.save": "Save note",
        "mcp.detail.tools": "Tools ({count})",
        "mcp.field.headersShort": "Headers", "mcp.field.envShort": "Environment",
        "mcp.tools.loading": "Fetching the tool list…", "mcp.tools.loadFailed": "Could not load tools: ", "mcp.tools.none": "This server has no registered tools.",
        "mcp.tools.note": "Disabled tools are invisible to the model; changes take effect immediately",
        "mcp.remove.title": "Delete MCP server", "mcp.remove.desc": "Delete “{name}”? Its configuration is removed from the patch file and the tools go offline at once; this cannot be undone",
        "mcp.restarting": "Restarting… {name} (waited {seconds}s; the list refreshes when it finishes)", "mcp.err.warnings": "Patch warnings: ",
        "root.dsh": "DSH skills", "root.hub": "Imported skills", "root.agents": "Shared Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "Project DSH", "root.projectAgents": "Project Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor",
        "memory.title": "Memories",
        "tabs.scenes": "Scenes", "tabs.skills": "Skills", "tabs.subagents": "Subagents", "tabs.prompts": "Prompts", "tabs.memory": "Memories", "tabs.sessions": "Sessions", "tabs.compat": "Host",
        "compat.title": "Host compatibility", "compat.desc": "How this plugin attaches to DSH (read-only).",
        "compat.state.ok": "All good", "compat.state.degraded": "Degraded", "compat.state.blocked": "Needs attention",
        "compat.checking": "Checking…", "compat.recheck": "Check again", "compat.empty": "Not checked yet", "compat.failed": "Check failed",
        "compat.summary.ok": "host {version} · capabilities {ok}/{total} · all usable", "compat.summary.degraded": "host {version} · capabilities {ok}/{total} · {count} degraded",
        "compat.host": "Host version", "compat.peer": "Requires", "compat.verified": "Verified against", "compat.verified.note": "the release this plugin was tested with",
        "compat.caps": "Usable capabilities", "compat.caps.all": "all present", "compat.caps.degraded": "{count} unavailable",
        "compat.caps.substituted": "gaps covered by the plugin",
        "compat.ops": "Host action availability", "compat.ops.hint": "which route each action takes", "compat.ops.disabled": "{count} action(s) are unavailable right now (the affected buttons are disabled and explain why)",
        "compat.op.name": "Action", "compat.op.state": "Route",
        "compat.op.list": "List archived sessions", "compat.op.archive": "Archive session", "compat.op.unarchive": "Unarchive session",
        "compat.op.batch": "Batch archive", "compat.op.delete": "Delete permanently",
        "compat.op.native": "Host-native entry", "compat.op.adapter": "Plugin adapter", "compat.op.unavailable": "Unavailable (disabled)",
        "compat.degraded": "Degraded capabilities", "compat.degraded.hint": "what is missing + the consequence", "compat.reason": "Reason:",
        "compat.others": "Other capability slots", "compat.others.hint": "not degraded: the plugin supplies its own implementation when the host has no such entry",
        "compat.fallback.substituted": "Plugin adapter (no host entry)",
        "compat.fallback.native": "Falls back to native entry", "compat.fallback.blocked": "Affected buttons disabled",
        "compat.modules": "Module identity (plugin vs host)", "compat.modules.hint": "adapting only works on one shared module", "compat.module.same": "same module", "compat.module.separate": "separate copy (repair needed)", "compat.module.unknown": "not comparable",
        "compat.blockers": "Blockers (fix these)",
        "compat.reach": "Preset injection reach", "compat.reach.hint": "whether these contents reach the model under each preset",
        "compat.reach.suppressing": "suppressing",
        "compat.inject": "Injection", "compat.inject.hint": "what this plugin injects for the model (unchanged text is not resent)",
        "compat.inject.force": "Also inject in Minimal mode", "compat.inject.force.desc": "Off by default (follow the preset)",
        "compat.inject.domains": "What to inject",
        "compat.inject.domain.memory": "Scene + memory", "compat.inject.domain.mcp": "MCP",
        "compat.inject.domain.subagents": "Subagents", "compat.inject.domain.prompt": "Prompt",
        "compat.inject.domain.skills": "Skills",
        "compat.inject.domain.carrier.title": "Turning this off also stops the copy the system sends by itself",
        "compat.live.title": "Live injection", "compat.live.hint": "What the model actually sees (read-only)",
        "compat.live.never": "nothing delivered yet this run", "compat.live.delivered": "{count} delivered · last {time}",
        "compat.live.copy": "Copy all", "compat.live.copied": "Copied", "compat.live.noAgent": "No session yet — send a message first",
        "compat.live.state.inContext": "Injected", "compat.live.state.absent": "Not delivered", "compat.live.state.cleared": "Cleared",
        "compat.live.state.off": "Off", "compat.live.state.unknown": "No session",
        "compat.live.state.child": "Not injected here",
        "compat.live.state.child.title": "This session is deeper than the personas' catalog injection depth (catalogDepth), so the standing catalog is not injected here. To let the catalog reach subagent sessions, raise the persona's catalog injection depth (or pick “No nesting limit”). Note: this does not affect delegation — subagents can always delegate further.",
        "compat.live.adopt": "injected {injected} · called {used} · adopted {adopted}",
        "compat.live.adopt.none": "injected {injected} · never called",
        "compat.live.adopt.title": "Counts since this process started. Adopted = the domain text was in context when the call happened; calls are counted whether or not they succeeded",
        "compat.live.observe.some": "{count} tool calls observed this run",
        "compat.live.observe.none": "no tool calls observed yet this run",
        "compat.live.state.official": "Official", "compat.live.state.official.title": "The official carrier delivers these under standard presets; the plugin does not duplicate (it only fills in for Minimal-like presets)",
        "compat.live.state.empty": "Nothing to send", "compat.live.est": "≈{count} tokens",
        "compat.live.state.absent.title": "This plugin owns this domain but it is not in context right now (it may have just been compacted; the next step re-sends it)",
        "compat.reach.mark.memory": "Scene + memory", "compat.reach.mark.agentsMd": "Prompt", "compat.reach.mark.skill": "Skills", "compat.reach.mark.mcp": "MCP", "compat.reach.mark.subagent": "Subagents",
        "compat.reach.default": "default",
        "compat.reach.whyUnknown": "cannot tell", "compat.reach.broken": "preset broken",
        "compat.reach.tools.title": "Tools work ≠ the model knows",
        "compat.reach.tools.1": "The tools come from this plugin and are callable under any preset; how they reach the model is up to the preset.",
        "compat.reach.tools.2": "Scene + memory / MCP / skills / subagents / prompt — filled in by this plugin according to the Injection block above.",
        "compat.reach.tools.3": "The prompt and the skill catalog also come from the official rows; this plugin only fills in what they miss (e.g. under Minimal).",
        "compat.hint.doctor": "Command-line check:",
        "scenes.title": "Scenes", "scenes.desc": "Manage scenes: preset combinations of MCP, skills, subagents and memories, switch with one click.",
        "scenes.stat.total": "scene(s)", "scenes.stat.active": "enabled", "scenes.stat.archives": "with a profile",
        "scenes.noDesc": "No description yet",
        "scenes.mode.active": "Active mode: {name}", "scenes.mode.profile": "Profile: {parts}", "scenes.mode.noProfile": "This scene has no profile yet",
        "scenes.empty": "No dedicated scenes yet — global memories are injected without one; create a scene when you need to switch MCP servers, skills or personas.",
        "scenes.field.desc.limit": "Up to {count} characters; longer text is clipped on the card.",
        "scenes.profile.mcp": "{count} MCP", "scenes.profile.skills": "{count} skill(s)", "scenes.profile.subagents": "{count} subagent(s)", "scenes.profile.memories": "{count} memor(ies)",
        "scenes.mcp.hint": "Add the MCP section first, then check the servers to enable (stopped ones included); use Pick tools to narrow to specific tools. Unchecked servers — and scenes with no section at all — are turned off on entry, running processes included.",
        "scenes.seg.checked": "{checked}/{total} selected",
        "bulk.selectAll": "Select all", "bulk.unselectAll": "Deselect all",
        "bulk.head.title": "Enable or disable every skill that is visible after filtering and can be toggled (copies shadowed by a same-name skill are not counted)",
        "source.bulk.title": "Enable or disable every visible, toggleable skill in this directory (copies shadowed by a same-name skill are not counted)",
        "bulk.enabled": "Enabled", "bulk.disabled": "Disabled",
        "bulk.done.skills": "{action} {count} skill(s) (failed: {failed})", "bulk.done.memories": "{action} {count} memor(ies) (failed: {failed})", "memory.bulk.partial": "{action} {count} memor(ies), then aborted: {error}",
        "scenes.archive.sectionOff": "not defined = all off",
        "scenes.archive.summary": "Profile: {mcp} MCP server(s) · {skills} skill(s) · {subagents} subagent(s)",
        "scenes.archive.note": "Checked = enabled, unchecked = disabled; an undefined section means everything is off.\nMCP really starts/stops server processes.\nLeaving the scene restores the exact state from before.",
        "scenes.mcp.noServers": "No MCP servers to pick from yet", "scenes.mcp.toolCount": "{count} tool(s)", "scenes.skills.empty": "No skills to pick from yet",
        "scenes.mcp.allTools": "all tools", "scenes.mcp.pickedCount": "{count} tools picked", "scenes.mcp.notRunning": "not running", "scenes.mcp.edit": "Edit", "scenes.mcp.done": "Done", "scenes.mcp.noteLabel": "Scene note", "scenes.mcp.notePlaceholder": "Overrides the global note in this scene; restored on exit", "scenes.mcp.hasNote": "has note",
        "scenes.mcp.toolsOf": "Pick tools", "scenes.mcp.probeTools": "Start the server to load tools", "scenes.mcp.unknownCount": "unknown tool count — open Edit to load", "scenes.mcp.noteHint": "Saved with the scene. It overrides the note shown on the MCP page and in the system prompt only while this scene is entered — and only for servers checked in this section. Restored on exit.", "scenes.mcp.noTools": "No tools listed for this server (it has never run, or its tools were never recorded)", "scenes.mcp.drillHint": "Checked = enabled in this scene; unchecked = disabled. “Select all” = every tool (click again for “Deselect all” = none).",
        "scenes.skills.hint": "Add the skills section first, then check the skills enabled in this scene. Unchecked skills — and scenes with no section at all — are disabled on entry, and restored to their previous switch when you exit. Copies shadowed by a same-name skill and structurally broken skills cannot be checked — they can never take effect in this scene.",
        "scenes.skills.shadowed.hint": "Shadowed by a same-name skill, so it can never take effect in this scene and cannot be checked. To use this copy instead, click “Use this one” for it on the Skills page.",
        "scenes.skills.invalid.hint": "Incomplete skill (missing frontmatter / invalid name / empty description): it cannot be enabled or disabled, so it cannot be checked.", "scenes.subagents.hint": "Check the personas this scene should turn on; anything unchecked (or with no section at all) is turned off when you enter, and restored to its previous switch when you exit.", "scenes.subagents.empty": "No personas yet — create one on the Subagents page.",
        "scenes.filter.skills": "Filter skills / directories", "scenes.filter.subagents": "Filter personas (name or description)", "scenes.filter.servers": "Filter servers",
       
        "scenes.mem.title": "Memories", "scenes.mem.search": "Filter memories in this scene (name or description)",
        "scenes.mem.noMatch": "Nothing matches", "scenes.mem.emptyScene": "This scene has no memories yet",
        "memory.mode.current": "Active mode", "memory.mode.exit": "Exit mode",
        "memory.archive.edit": "Profile", "memory.archive.title": "Scene profile",
        "memory.archive.tools": "MCP tools", "memory.archive.skills": "Skills", "memory.archive.subagents": "Subagent binding", "memory.archive.memories": "Memories", "memory.archive.applyFailed": "Could not apply at runtime: {reason}",
        "memory.archive.addTools": "+ Tools", "memory.archive.addSkills": "+ Skills", "memory.archive.addSubagents": "+ Subagents",
        "memory.archive.removeSection": "Remove section", "memory.archive.save": "Save to scene",
        "memory.archive.emptySection": "Nothing checked = all disabled (a missing section means the same)", "memory.archive.emptySubagents": "Nothing checked = no personas enabled in this scene (a missing section means the same)", "memory.archive.stale": "Skipped {items} (missing, shadowed by a same-name skill, or structurally broken — it could never take effect)",
        "memory.result.archiveSaved": "Scene profile saved: {name}", "memory.result.modeSet": "Entered mode: {name}", "memory.result.modeSwitched": "{mcp} server(s) / {skills} source(s) switched", "memory.result.modeExited": "Exited mode",
        "memory.desc": "Manage memories: enabled memories enter the system prompt; enable them per scene.",
        "memory.btn.refresh": "Refresh", "memory.btn.new": "New memory", "memory.btn.create": "Create", "memory.btn.save": "Save",
        "memory.btn.diagnose": "Check", "memory.btn.delete.confirm": "Move to trash",
        "memory.diagnose.title": "Memory checkup", "memory.diagnose.summary": "{rules} memories · {scenes} scenes · {issues} issues", "memory.diagnose.clean": "No issues found.",
        "memory.diag.error": "Error", "memory.diag.warning": "Warning", "memory.diag.info": "Info",
"memory.stat.total": "memories", "memory.stat.scenes": "enabled scenes", "memory.stat.sceneCount": "scenes", "memory.status.sceneOff": "scene off", "memory.status.off": "this memory is off",
        "memory.budget.label": "Injection budget", "memory.budget.bytes": "{used} / {max} bytes",
        "memory.budget.over": "Over budget",
        "memory.budget.truncated": "Over budget — the memories left out are listed at the end",
        "memory.budget.dropped": "Not injected this time: {names}",
        "memory.scene.enable": "Enabled", "memory.scene.enableAll": "Enable all", "memory.scene.off": "Off", "memory.scene.shared": "always on", "memory.scene.global.tag": "always injected",
        "memory.scene.global": "Global", "memory.scene.count": "{count} memories", "memory.scene.new": "New memory", "memory.scene.browse": "Pick existing",
        "memory.scene.empty": "No memories in this scene yet",
        "memory.scene.orphan": "No scene", "memory.scene.orphan.tag": "never injected", "memory.scene.orphan.hint": "These memories sit directly in the memories/ root and belong to no scene, so they are never injected into the context. Move them into a scene directory (or into memories/global/ to make them “Global”).",
        "memory.scene.edit": "Edit", "memory.scene.editTitle": "Edit scene", "memory.scene.editHelp": "The name is its memory folder name; renaming moves the folder, profile and bindings along. Memory files stay untouched.",
        "memory.scene.field.name": "Scene name", "memory.scene.field.name.placeholder": "e.g. office",
        "memory.scene.field.name.hint": "The name is its top-level folder name; you can still change it later.",
        "memory.scene.field.name.lock": "Renaming moves its memory folder, scene profile and enable set along; memory files stay untouched.",
        "memory.scene.field.desc": "Description (optional)", "memory.scene.field.desc.placeholder": "One line on what this scene is for",
        "memory.search.placeholder": "Search name / description / scene", "memory.filter.all": "All scenes",
        "memory.empty": "No memories yet — click “New memory”", "memory.empty.search": "No matching memories",
        "memory.loading": "Loading…",
        "memory.enable": "Enabled", "memory.edit": "Edit", "memory.delete": "Delete",
        "memory.form.flat": "flat", "memory.form.bundle": "bundle", "memory.derived": "derived", "memory.fill.frontmatter": "Fill frontmatter",
        "memory.shadowed.hint": "A bundle with the same name exists, so this one is not loaded",
        "memory.create.title": "New memory", "memory.edit.title": "Edit memory", "memory.edit.group.lock": "The scene cannot be changed while editing",
        "memory.field.group": "Scene", "memory.field.group.placeholder": "e.g. office", "memory.field.group.hint": "Blank = global",
        "memory.field.name": "Name", "memory.field.name.placeholder": "e.g. 站会流程", "memory.name.invalid": "Invalid name (non-empty, ≤64 chars, no / \\ < > : \" | ? *, must not start with a dot)",
        "memory.field.description": "Description", "memory.field.description.placeholder": "One line on what it is for (blank = first body line)",
        "memory.field.body": "Body (Markdown)", "memory.field.body.placeholder": "Write down the conventions, steps, and boundaries to remember…",
        "memory.field.form": "Form", "memory.field.attach": "Attachments",
        "memory.attach.add": "Add files", "memory.attach.empty": "No attachments yet", "memory.attach.pending": "pending", "memory.attach.remove": "Remove attachment",
        "memory.attach.hint": "Stored with the memory; never injected into the prompt",
        "memory.attach.count.one": "{count} attachment", "memory.attach.count.other": "{count} attachments",
        "memory.attach.tip": "Click to manage attachments: {count} · {size} total — {names}",
        "memory.attach.tip.empty": "No files yet — click to add",
        "memory.attach.more": ", +{count} more", "memory.attach.sep": ", ", "memory.attach.flat": "The flat form is a single file and cannot carry attachments", "memory.attach.tooLarge": "File too large: {name} (max {limit} MB)",
        "memory.delete.title": "Move to trash?", "memory.delete.desc": "“{name}” moves to trash and can be restored",
        "memory.result.created": "Created memory: {name}", "memory.result.updated": "Saved memory: {name}", "memory.result.removed": "Moved to trash: {name}", "memory.result.toggled": "Memory state updated: {name}", "memory.result.active": "Enabled scenes updated",
        "memory.result.restored": "Restored memory: {name}", "memory.result.trashRemoved": "Permanently deleted: {name}",
        "memory.result.createdAttached": "Created memory: {name} ({count} attachments)", "memory.result.updatedAttached": "Saved memory: {name} ({count} attachments)", "memory.result.attachFailed": "Memory saved, but attachments failed: {error}",
        "memory.trash.open": "Trash", "memory.trash.title": "Memory trash", "memory.trash.empty": "Trash is empty",
        "memory.trash.count": "{count} deleted memories", "memory.trash.deletedAt": "Deleted {time}",
        "memory.trash.restore": "Restore", "memory.trash.purge": "Delete forever",
        "memory.trash.confirmTitle": "Delete forever?", "memory.trash.confirmDesc": "“{name}” is deleted forever and cannot be recovered",
        "memory.btn.newScene": "New scene", "memory.btn.deleteScene": "Delete scene", "memory.btn.saveScene": "Save changes",
        "memory.scene.createTitle": "New scene",
        "memory.deleteScene.title": "Delete scene?", "memory.deleteScene.desc": "Moves “{name}” and every memory under it (including disabled ones) to the trash, restorable as one entry; a scene in use cannot be deleted.",
        "memory.result.sceneCreated": "Scene created: {name}", "memory.result.sceneUpdated": "Scene saved: {name}", "memory.result.sceneRemoved": "Scene deleted: {name}", "memory.result.sceneRemoved.withMemories": "Scene deleted: {name} (with {count} memory file(s); restorable as one entry from the trash)",
        "memory.table.name": "Memory name and description", "memory.table.tags": "Tags", "memory.table.status": "Status",
        "error.rules.invalidArgs": "Missing arguments: pass all:true (enable everything) or scenes:[...] (explicit narrowing)", "error.rules.invalidGroup": "Invalid scene/group name (non-empty, ≤64 chars, no path separators or < > : \" | ? *, must not start with a dot)", "error.rules.invalidName": "Invalid memory name (non-empty, ≤64 chars, no / \\ < > : \" | ? *, must not start with a dot)", "error.rules.descriptionRequired": "Description is required", "error.rules.descriptionTooLong": "Description is too long (max 500 chars)", "error.rules.bodyRequired": "Body is required", "error.rules.tooLarge": "Rule content is too large", "error.rules.shadowed": "Rule is shadowed by a bundle of the same name", "error.rules.exists": "A memory with this name already exists", "error.rules.notFound": "Rule not found", "error.rules.budgetExceeded": "Scene memory section exceeds its budget", "error.rules.ioFailed": "File operation failed", "error.rules.nameTaken": "That name is already taken", "error.rules.sceneNotEmpty": "Scene is not empty; cannot be deleted", "error.rules.notBundle": "This memory is flat (a single file) and cannot carry attachments", "error.rules.noFiles": "No files selected", "error.rules.emptyFile": "Empty file", "error.rules.fileTooLarge": "File too large (max {limit} MB each)", "error.rules.tooManyFiles": "At most {limit} files per upload", "error.rules.sceneInMode": "This scene is the active mode; exit the mode before deleting it",
        "subagents.title": "Subagents", "subagents.stat.total": " subagents", "subagents.stat.limited": " tool-restricted", "subagents.desc": "Manage subagents: create and import personas; a persona's body is the subagent's system prompt.",
        "prompts.desc": "Manage prompts: preset the global instruction baseline; applying writes AGENTS.md and takes effect on the next turn.",
        "sessions.desc": "Manage archived sessions: restore or delete them permanently; expired ones are cleaned up automatically.",
        "subagents.new": "New subagent", "subagents.empty": "No subagents yet — click “New subagent” to create the first one.",
        "subagents.create": "New persona", "subagents.edit": "Edit persona",
        "subagents.field.name": "Persona name",
        "subagents.field.description": "Description", "subagents.field.description.placeholder": "e.g. Senior Java engineer",
        "subagents.field.model": "Model", "subagents.field.model.placeholder": "Custom model id", "subagents.field.model.hint": "Blank inherits the main session", "subagents.field.provider": "Model provider", "subagents.field.provider.placeholder": "deepseek", "subagents.field.provider.hint": "Provider and model are a pair: a model alone resolves against the main session's provider and fails across providers.",
        "subagents.field.catalogDepth": "Catalog injection", "subagents.field.catalogDepth.onlyTop": "Top level only", "subagents.field.catalogDepth.toChild": "Top level and subagents", "subagents.field.catalogDepth.toGrand": "Top level and two levels down", "subagents.field.catalogDepth.unlimited": "No nesting limit", "subagents.field.catalogDepth.hint": "Which levels of sessions get the persona catalog.\nIt affects the catalog only — subagents can always delegate further.\nWhen the catalog is not injected, subagent_manager_list still works.",
        "subagents.model.inherit": "Inherit the main session (unspecified)", "subagents.model.customOption": "Custom / not in the catalogue…",
        "subagents.field.modes": "Tool limits (per agent preset)",
        "subagents.field.modes.hint": "Only the row for the current preset applies; other presets keep their full tool set.",
        "subagents.mode.startAllow": "Enable allowlist", "subagents.mode.startDeny": "Enable denylist", "subagents.mode.stopAllow": "Disable allowlist", "subagents.mode.stopDeny": "Disable denylist",
        "subagents.mode.off": "no restriction", "subagents.mode.empty": "enabled with nothing picked (= no restriction)",
        "subagents.mode.allowOn": "allowlist {count}", "subagents.mode.denyOn": "denylist {count}",
        "subagents.mode.allowEmpty": "Nothing picked = no restriction (every tool of this preset stays available)",
        "subagents.mode.denyEmpty": "Nothing picked = no restriction (every tool of this preset stays available)",
        "subagents.mode.noTools": "Could not read this preset's tool list",
        "subagents.mode.broken": "This preset is broken; its tool list is unreadable",
        "subagents.mode.toggleHint": "Expand / collapse this preset's list settings (the buttons on the right enable / disable it)",
        "subagents.mode.noPresets": "The host returned no agent-preset roster",
        "subagents.legacy.note": "This file still carries the old-style tool limits (allowlist {allow} / denylist {deny}); they apply to every preset.",
        "subagents.legacy.convert": "Convert into a preset row",
        "subagents.legacy.hint": "Converting moves the old list into the preset you pick; until then the old keys stay untouched in the file (and keep working at run time).",
        "subagents.tools.filter": "Filter tool names", "subagents.tools.remove": "Remove",
        "subagents.adv.title": "Advanced options", "subagents.adv.inherit": "inherit", "subagents.adv.summary": "model {model} · catalog {depth} · preset limits {modes} · legacy allow {allow} / deny {deny}", "subagents.adv.note": "Allowlist = the subagent may only use the picked tools.\nDenylist = everything except the picked ones.\nMCP tools are not listed: a subagent always keeps the MCP servers currently running.", "subagents.adv.loadFailed": "Could not read the candidate data (model catalogue / tool list); you can still fill the fields by hand.",
        "preset.name.standard": "Standard mode", "preset.name.ptc": "PTC mode", "preset.name.minimal": "Minimal mode", "preset.name.cordis": "Creator mode",
        "preset.short.standard": "Standard", "preset.short.ptc": "PTC", "preset.short.minimal": "Minimal", "preset.short.cordis": "Creator",
        "subagents.field.body": "Persona prompt", "subagents.field.body.placeholder": "Describe the persona's role, responsibilities, and working style…",
        "subagents.field.output": "Output requirements (hard)", "subagents.field.output.placeholder": "One hard requirement per line, e.g. — one block per finding: [P0|P1|P2] file:line — problem — impact — fix",
        "subagents.field.output.hint": "Goes into the subagent's system prompt as its own section — say what the output must look like, and only write checkable requirements.",
        "subagents.result.saved": "Persona saved: {name}", "subagents.result.deleted": "Persona deleted: {name}",
        "subagents.delete.title": "Delete persona?", "subagents.delete.desc": "Moves the persona file “{name}” to the trash (restorable from the Trash button on the Subagents page).",
        "subagents.import": "Import subagents", "subagents.import.title": "Import subagents", "subagents.toggle": "Toggle subagent", "subagents.disabled": "Disabled", "subagents.disabled.hint": "Disabled personas are not injected into the context and hidden from subagent_manager_list / subagent_manager_run; the file is kept and can be re-enabled anytime.",
        "subagents.result.imported": "Imported {count} persona(s): {names}",
        "memory.import": "Import memories", "memory.import.title": "Import memories", "memory.import.scene": "Import into scene",
        "memory.result.imported": "Imported {count} memory/memories: {names}",
        "memory.import.scenesCreated": "Scenes created for them: {names}",
        "memory.scene.global.hint": "Global",
       "import.clear": "Clear", "import.submit": "Import",
        "import.none": "Nothing was imported (all skipped)", "import.skipped": "Skipped: {items}",
        "error.import.noFiles": "No files selected",
        "nav.title": "Tools",
        "agm.stat.total": " prompts", "agm.stat.active": " active", "agm.loading": "Loading…", "agm.empty": "No prompts yet — click “New prompt” to create one", "agm.btn.delete.blocked.refs": "Cannot delete: {refs}. Change those references first (rebind the prompt, leave the scene, or apply another preset).", "agm.ref.sep": "; ", "agm.ref.scene": "bound by scene “{scene}”", "agm.ref.sceneActive": "bound by scene “{scene}” (enabled)", "agm.ref.file": "this is what AGENTS.md currently holds", "agm.ref.restore": "the global prompt to restore after leaving the scene", "agm.sceneLock.notice": "Scene “{scene}” is driving the baseline: the prompt in effect is its bound “{id}”. Applying another preset here rebinds that scene to it (written into the scene profile as well).", "agm.active": "Active", "agm.active.hint.scene": "Currently active: the prompt preset bound to scene “{scene}”", "agm.active.hint.file": "Currently active: AGENTS.md is exactly this preset", "agm.file.applied": "In AGENTS.md", "agm.file.applied.hint": "AGENTS.md currently holds this one; the enabled scene binds a different preset, which now takes effect", "agm.apply.hint": "Writes AGENTS.md; the host re-reads that file every turn, so it takes effect on the next turn", "agm.btn.reapply": "Apply again", "agm.btn.apply": "Apply", "agm.applyModal.title": "Apply preset", "agm.edit.title": "Edit preset", "agm.remove.title": "Delete preset", "agm.btn.edit": "Edit", "agm.btn.delete": "Delete", "agm.btn.new": "New prompt", "agm.btn.import": "Import prompts", "agm.result.imported": "Imported {count} preset(s): {names}", "agm.btn.save": "Save", "agm.btn.create": "Create", "agm.btn.confirmRemove": "Delete", "agm.btn.confirmApply": "Apply", "agm.field.id": "id (directory name)", "agm.field.id.hint": "Letters, spaces and dots are fine; no slashes or : * ? < >; up to 64 chars. Changing it renames the directory.", "agm.field.id.placeholder": "e.g. work-baseline", "agm.field.content": "Content", "agm.field.content.placeholder": "Write the preset body (Markdown) here; leave blank to start from the empty template", "agm.field.copyFrom": "Or copy from an existing preset", "agm.field.copyFrom.none": "Do not copy (empty template)", "agm.field.desc": "Description (for humans only)", "agm.field.desc.placeholder": "What this preset is for and when to use it", "agm.result.renamed": "Saved; id is now “{id}”", "agm.result.rebound": " ({count} scene binding(s) updated)", "agm.remove.suffix": "? This cannot be undone.", "agm.apply.prefix": "Write the contents of ", "agm.apply.suffix": " into ~/.dsh/AGENTS.md.", "agm.apply.note": "Takes effect on the next turn; the current content is backed up to __last-applied__ (last 5 kept)", "hist.err.load": "Load failed", "hist.err.unarchive": "Restore failed", "hist.err.delete": "Delete failed", "hist.err.retention": "Update failed", "hist.err.import": "Import failed", "hist.err.sessions": "Failed to load sessions", "hist.err.export": "Export failed", "hist.err.archive": "Archive failed", "hist.retention.forever": "Keep forever", "hist.retention.days": "{count} days", "hist.arch.all": "All sessions", "hist.arch.archived": "Archived only", "hist.arch.live": "Not archived only", "hist.arch.missing": "Missing directory only", "hist.ws.all": "All workspaces", "hist.ungrouped": "Ungrouped", "hist.group.removed": "Removed", "hist.group.removed.hint": "This directory has no DSH workspace registration right now; the group is rebuilt from session directories and rejoins automatically once registered again", "hist.group.dirMissing": "Directory missing", "hist.group.dirMissing.hint": "The workspace directory was deleted from disk, so it cannot be registered again; sessions in this group can still be restored (they join Ungrouped) or deleted forever", "hist.btn.registerWs": "Register", "hist.btn.registerWs.hint": "Register this directory again and attach its existing sessions back to that group (workspace accounting only — no file or session is moved or deleted)", "hist.register.title": "Register again?", "hist.register.body": "A workspace registration will be created in DSH for “{title}”, and the sessions under this directory will be attached back to it (restoring their grouping). This writes workspace accounting only — no file or session is moved or deleted.", "hist.register.confirm": "Register", "hist.register.done.title": "Registered", "hist.register.done.body": "Workspace “{title}” is registered; archived sessions under this directory join that group after a refresh.", "hist.register.done.attached": "Attached {count} existing session(s) under this directory back to the workspace.", "hist.register.done.skipped": "{count} session(s) could not be attached: {reason}", "hist.err.register": "Registration failed", "scenes.field.prompt": "Prompt preset", "scenes.agents.note.applied": "wrote “{id}” into AGENTS.md", "scenes.agents.note.restored": "restored the AGENTS.md baseline from before the scene", "scenes.agents.note.error": "AGENTS.md was not written: {reason}", "scenes.field.prompt.hint": "While the scene is on, this preset is the global baseline.\nApplying another preset on the Prompts page rebinds the scene to it (written into the profile too).", "scenes.prompt.activeTag": "in effect", "scenes.prompt.noPresets": "No prompt presets yet — create one on the Prompts page.", "scenes.prompt.bound": "Prompt: {id}", "scenes.prompt.live": "Prompt active: {id}", "scenes.prompt.missing": "Preset missing: {id}", "scenes.prompt.tag.hint": "The prompt preset bound to this scene", "scenes.prompt.mismatch.hint": "The scene-bound “{id}” does not match the current contents of AGENTS.md (it may have been edited by hand); click “Apply again” for it on the Prompts page to write it back", "scenes.enable.blocked": "Scene “{name}” is already enabled; turn it off first", "scenes.result.created.collapsed": "Scene “{name}” created and left off (the legacy “all enabled” default collapsed to a single choice)", "scenes.legacyAll": "{count} scenes are enabled at once (a leftover of the legacy “all enabled” default); only one scene besides “Global” may be enabled.", "scenes.legacyAll.fix": "Collapse to one", "agm.restore.tag": "Restored after the scene", "agm.restore.tag.hint": "The global prompt from before the scene; leaving the scene restores it, so deleting it would lose that fallback", "agm.file.mismatch": "Not in AGENTS.md", "agm.file.mismatch.hint": "AGENTS.md does not currently match this preset (it may have been edited by hand); click “Apply again” to write it back", "hist.restore.note.registered": "Restored {count} session(s); workspace “{title}” was registered again and the sessions are back in that group.", "hist.restore.note.attached": "Restored {count} session(s) and attached them to workspace “{title}”.", "hist.restore.note.skip": "Workspace ownership could not be restored for {count} session(s): {reason}", "hist.purge.title": "Delete forever?", "hist.purge.one": "Delete “{title}” and all of its records forever — this cannot be undone", "hist.purge.batch": "Delete the {count} selected sessions and all of their records forever — this cannot be undone", "hist.btn.restore": "Restore", "hist.btn.purge": "Delete forever", "hist.btn.confirmPurge": "Delete", "hist.selectGroup": "Select group {title}", "hist.group.count": "{count}", "hist.selectAll": "Select all", "hist.deselectAll": "Deselect all", "hist.btn.import": "Import sessions", "hist.btn.export": "Export sessions", "hist.selected": "{count} selected", "hist.btn.restoreSelected": "Restore selected ({count})", "hist.btn.deleteSelected": "Delete selected ({count})", "hist.stat.archived": " archived", "hist.stat.projects": " projects", "hist.stat.retention": " days kept", "hist.search.placeholder": "Search title / session id / project path", "hist.loading": "Loading…", "hist.empty.search": "No matching archived sessions", "hist.empty.none": "No archived sessions yet", "hist.import.cwd": "Project directory (optional)", "hist.import.cwd.placeholder": "Absolute path, optional (the session goes to Ungrouped)", "hist.import.drop": "Choose or drop a conversation file", "hist.import.done": "Created session {id} ({count} messages); continue it from the DSH session list.", "hist.export.hint": "Export the selected sessions as transcript files that can be imported again", "hist.export.dir": "Export directory (absolute path, created automatically)", "hist.export.browse": "Browse and choose a folder", "hist.btn.browse": "Choose", "hist.export.pickDir": "Choose export directory", "hist.export.format": "Format", "hist.export.scope": "Session scope", "hist.export.workspace": "Workspace", "hist.export.sessions": "Sessions ({count})", "hist.export.loading": "Loading sessions…", "hist.cwd.missing": "⚠ The workspace directory no longer exists: ", "hist.tag.archived": "Archived", "hist.tag.live": "Not archived", "hist.export.empty": "No matching sessions", "hist.result.exported": "Exported {count} session(s) to {dir}", "hist.result.skipped": "; skipped {count} ({ids})", "hist.result.archived": "Archived {count} session(s) to History; manage them on the History page", "hist.btn.archiveSelected": "Archive selected", "hist.btn.archiveSelected.title": "Move the selected sessions into History so retention applies to them", "hist.export.busy": "Working…", "hist.btn.exportSelected": "Export {count} session(s)", "hist.error.title": "Operation failed", "hist.error.unknown": "Unknown error",
      }
    };

    module.exports = {
      name: 'dsh-plugin-tool-management-client',
      // 显式注入 locale：兄弟插件提供的服务不会可靠地通过未声明的 ctx.get() 暴露；
      // 不声明时本页会退回中文兜底，导致宿主已切到 English 但「工具」和七个页签仍是中文。
      inject: ['timer', 'locale'],
      // 词典也导出：让 Node 契约测试能断言「bundle 里每个 t('键') 在两份词典里都存在」。
      // 浏览器 UI 的交互验收仍要真浏览器；这一条挡的是「界面直接显示原始键名」这类缺陷。
      dict: DICT,
      // 页面组件（契约测试用）：由 apply 末尾填充。必须在 factory 作用域先落地——
      // 写在 apply 方法体里的导出会随 apply 提前返回而静默消失（见下方注释）。
      pages: _pages,
      apply(ctx) {
        ensureCss()
        // ---------- 取词服务（必须最先绑定）----------
        // 放在 apply 开头而不是页面组件附近：设置页的导航标题（slots.inject('settings.section')）
        // 是**注册期**取值，晚绑定会让它在英文界面下永远是中文。
        var NS = 'dsh-plugin-tool-management'
        // 注册期也要跟随宿主当前语言：如果 locale 服务尚未完成注入，读取 html[lang]
        // 作为兜底，不能无条件回退中文，否则设置侧栏会固定显示「工具」。
        var initialLocale = (typeof document !== 'undefined' && document.documentElement && /^en(?:-|$)/i.test(document.documentElement.lang || '')) ? 'en' : 'zh'
        var t = function (key, params) {
          var s = (DICT[initialLocale] && DICT[initialLocale][key]) || (DICT.en && DICT.en[key]) || key
          if (params) Object.keys(params).forEach(function (k) { s = String(s).replace("{" + k + "}", params[k]) })
          return s
        }
        try {
          // 取词服务走显式注入的 locale；直接访问未声明的 `ctx.locale` 会被 cordis
          // 上下文代理拒绝（cannot get property without inject）。同时保留 ctx.get 兼容
          // 不同宿主上下文；locale 注册失败不能让 t 静默退回中文。
          var locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) || ctx.locale
          if (locale && typeof locale.register === 'function') {
            try {
              locale.register(NS, DICT)
            } catch (e) {
              // apply 被重复调用时 register 会因「该 ns 已有该 locale」抛错；
              // 词典已在宿主手里，直接 bind 即可，绝不能因此退回内置兜底。
            }
            t = locale.bind(NS)
          }
        } catch (e) {
          try { console.warn('[dsh-plugin-tool-management] locale 服务不可用，界面将固定使用中文：', e) } catch (e2) { /* ignore */ }
        }

        const slots = ctx.get('slots')
        if (slots === undefined) return

        /** MCP 页的本地取词：模块作用域的 t 在 apply 里被 locale 覆盖，这里每次取值都用最新的那个。 */
        const mt = (key, params) => t(key, params)
        /** MCP 保存后统一的操作反馈：成功 / 成功但有 loader 告警 / 失败。 */
        const opMsg = (res) => (
          res && res.warning
            ? { kind: 'warn', text: mt('mcp.msg.warn', { warning: res.warning }) }
            : { kind: 'ok', text: mt('mcp.msg.ok') }
        )
        const emptyForm = () => ({ serverName: '', transport: 'streamable-http', url: '', command: '', args: '', headers: '', env: '', level: 'global' })
        const kvToLines = (obj) => (obj ? Object.keys(obj).map((k) => k + '=' + obj[k]).join('\n') : '')
        // 级别筛选选项：必须在**渲染时**取词。原来写成模块级常量，apply() 早于 locale
        // 注册，导致英文界面下这四项永远显示中文（且再也翻不过来）。
        const mcpLevelOptions = () => [
          { value: '', label: mt('mcp.level.all') },
          { value: 'global', label: mt('mcp.level.global') },
          { value: 'project', label: mt('mcp.level.project') },
          { value: 'loader', label: mt('mcp.level.loader') },
        ]
        const MCP_TRANSPORT_OPTIONS = [
          { value: 'streamable-http', label: 'streamable-http' },
          { value: 'stdio', label: 'stdio' },
        ]
        const maskSecret = (value) => {
          const s = String(value == null ? '' : value)
          return s.length <= 4 ? '****' : s.slice(0, 4) + '****'
        }

        // 顶部栏右端：GitHub 链接（issues 在仓库）+ 版本号（全界面唯一显示处）。
        function FeedbackLinks() {
          return React.createElement('div', { className: 'dsm-feedback-links' },
            React.createElement('a', { className: 'dsm-feedback-link', href: 'https://github.com/ouli-1242/dsh-plugin-tool-management', target: '_blank', rel: 'noreferrer', 'aria-label': t('link.project'), title: t('link.project') },
              React.createElement(GithubMark16, null)),
            React.createElement(VersionBadgeComponent, null))
        }

        // MCP 服务页：与 Skills 页共用 dsm-* 设计语言（统计卡 / 筛选 / 分组卡片 / 模态框）。
        function MCPPage() {
          const [state, setState] = React.useState({ loading: true, error: null, rows: [], paths: null, errors: [], warnings: [], revealError: null })
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
          const [tokenDraft, setTokenDraft] = React.useState('')
          const [compactConfirm, setCompactConfirm] = React.useState(false)
          const [, setTick] = React.useState(0)
          const flipRef = React.useRef(null)
          useFlipReorder(flipRef)

          const refresh = (withReveal, onRows, silent) => {
            const useReveal = withReveal === undefined ? reveal : withReveal === true
            // 手动刷新（含首次加载）先把按钮切到「刷新中…」并禁用 —— 点完毫无反馈等于没点。
            // 轮询不算（定时器传 silent=true）：它每几秒跑一次，切文案会让按钮一直闪。
            if (!silent) setState((prev) => Object.assign({}, prev, { loading: true }))
            // 明文视图走独立的 mcpm-reveal op（host 端要求带对的访问令牌），
            // mcpm-list 始终脱敏、无令牌也能渲染页面。
            const applyRows = (res, revealError) => {
              const rows = (res && res.rows) || []
              setState({
                loading: false,
                error: res && res.ok ? null : ((res && res.error) || mt('mcp.msg.loadFailed')),
                rows,
                paths: (res && res.paths) || null,
                errors: (res && res.errors) || [],
                warnings: (res && res.warnings) || [],
                revealError: revealError || null,
                locked: (res && res.anyLocked) === true,
                // 场景内开关由档案定义：页面上这些开关置灰，并说明去哪儿改。
                scene: (res && res.activeScene) || null,
              })
              if (onRows) onRows(rows)
            }
            apiCall(useReveal ? 'mcpm-reveal' : 'mcpm-list', {}).then((res) => {
              // 明文被拒（未配令牌 / 令牌不对）：退回脱敏列表，把原因与令牌入口单独显示。
              // 直接落进 state.error 会把整页变成错误态 —— "看不了明文"不等于"页面坏了"。
              if (useReveal && res && res.ok === false) {
                setReveal(false)
                return apiCall('mcpm-list', {}).then((masked) => applyRows(masked, { code: res.code, text: res.error }))
              }
              applyRows(res, null)
            }).catch((e) => setState({ loading: false, error: String((e && e.message) || e), rows: [], paths: null, errors: [], warnings: [], revealError: null, locked: false }))
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
            return ctx.interval(() => refreshRef.current(undefined, null, true), ms)
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
                // 场景内改开关：档案没跟上的话要说出来，别只报「成功」（详见 sceneSyncWarn）。
                const warn = sceneSyncWarn(mt, res)
                setMsg(warn ? { kind: 'warn', text: opMsg(res) + ' ' + warn } : opMsg(res))
                refresh()
                if (onOk) onOk()
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
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
                setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
                refresh()
              } else if (res && res.warning) {
                setMsg({ kind: 'warn', text: mt('mcp.msg.warn', { warning: res.warning }) })
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
          // 明文被拒后的令牌入口：填对令牌 → 存 localStorage（随每个请求以 x-dsh-token 发出）
          // → 重试明文。宿主没配令牌时这一步不会成功，面板里的提示写了该怎么配。
          const applyToken = () => {
            if (!setAccessToken(tokenDraft)) return
            setReveal(true)
            refresh(true, (rows) => {
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
          // 「整理补丁」：删掉多余的启停覆盖块（生效值不变，只删被盖住的块与纯 no-op）。
          // 成功文案带真实删除数量；一条都没删时如实说"已经是干净的"，而不是笼统的"成功"。
          const doCompact = () => {
            setCompactConfirm(false)
            setMsg(null)
            setBusy('compact')
            apiCall('mcpm-compact', {}).then((res) => {
              if (res && res.ok) {
                const n = Number(res.removed || 0)
                setMsg({ kind: 'ok', text: n > 0 ? mt('mcp.compact.done', { count: n }) : mt('mcp.compact.clean') })
                refresh()
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: String((e && e.message) || e) })).then(() => setBusy(null))
          }
          const openDetail = (row) => {
            setNoteDraft(row.notes || '')
            setDetail({ row, loading: true, error: null, tools: [] })
            apiCall('mcpm-tools', { serverName: row.serverName }).then((res) => {
              if (res && res.ok) setDetail({ row, loading: false, error: null, tools: res.tools || [] })
              else setDetail({ row, loading: false, error: (res && res.error) || mt('mcp.tools.loadFailed'), tools: [] })
            }).catch((e) => setDetail({ row, loading: false, error: String((e && e.message) || e), tools: [] }))
          }

          const toggleTool = (row, tool) => {
            const nextEnabled = tool.enabled === false
            setMsg(null)
            setBusy('tool:' + tool.name)
            apiCall('mcpm-tool-enabled', { serverName: row.serverName, tool: tool.name, enabled: nextEnabled }).then((res) => {
              if (res && res.ok) {
                setDetail(Object.assign({}, detail, { tools: (detail.tools || []).map((item) => (item.name === tool.name ? Object.assign({}, item, { enabled: nextEnabled }) : item)) }))
                setMsg({ kind: 'ok', text: mt(nextEnabled ? 'mcp.msg.toolOn' : 'mcp.msg.toolOff', { name: tool.name }) })
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: String((e && e.message) || e) })).then(() => setBusy(null))
          }

          const rows = state.rows || []
          // 工具数的三个口径（与 src/mcp/state-section.ts 同源，理由见那里的文件头）：
          //   liveToolCount        当前真实注册了几个工具（**不含**「已知工具」缓存）
          //   liveEnabledToolCount 其中未被停用表扣减的（真正能调到的）
          //   knownToolCount       缓存里的数量 —— >0 表示这台 server **曾经真的连上过**
          // 拆分的原因：缓存里的工具名在服务器已经连不上时依然存在，把它算进"当前工具数"
          // 会让一台挂掉的 server 显示成「已运行」并被注入上下文（2026-09-17 实测）。
          // 旧数据没有前两个字段时逐级退回，行为与拆分之前一致。
          const liveEnabledOf = (row) => {
            if (typeof row.liveEnabledToolCount === 'number') return row.liveEnabledToolCount
            return typeof row.enabledToolCount === 'number' ? row.enabledToolCount : (typeof row.toolCount === 'number' ? row.toolCount : 0)
          }
          const liveOf = (row) => typeof row.liveToolCount === 'number' ? row.liveToolCount : liveEnabledOf(row)
          const knownOf = (row) => typeof row.knownToolCount === 'number' ? row.knownToolCount : 0
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
          // 工具数两个口径：total = 当前真实注册数；enabled = 其中可用的（停用表扣减后，
          // 与详情页每行的开关一致）。两者不同时显示「可用/总数」，不让全部数量冒充可用数。
          // 只数真实注册的 —— 缓存里那些"上次见过"的名字不能计入页面总数，否则一台挂掉的
          // server 会让这里的数字虚高，与它自己那行的「无可用工具」自相矛盾。
          const toolTotals = rows.reduce((acc, row) => {
            const total = liveOf(row)
            acc.total += total
            acc.enabled += liveEnabledOf(row)
            return acc
          }, { total: 0, enabled: 0 })
          const summary = {
            total: rows.length,
            enabled: rows.filter((row) => !row.disabled).length,
            tools: toolTotals.enabled,
            toolsTotal: toolTotals.total,
          }
          const profilePath = state.paths && state.paths.profile ? 'profile: ' + state.paths.profile : null
          const groups = levelFilter === 'loader'
            ? [{ key: 'live', title: mt('mcp.level.loader'), path: profilePath, match: isRunning }]
            // 分组顺序（用户要求 2026-09-17）：全局在前、应用级在后 —— 全局那一层跨应用
            // 生效，是更"外面"的一层；此前应用级在前，与"局部覆盖全局"的读法相反。
            // 组内顺序直接用行的到达顺序：服务端 `mcpmList` 已按 全局 → 应用级 → loader、
            // 同级内按服务器名排好（同一个顺序也是场景档案勾选器与模型侧列表的顺序）。
            : [
                { key: 'global', title: mt('mcp.level.global'), path: state.paths ? state.paths.global : null, match: (row) => row.level === 'global' },
                { key: 'project', title: mt('mcp.level.project'), path: state.paths ? state.paths.project : null, match: (row) => row.level === 'project' },
                { key: 'loader', title: mt('mcp.level.loader'), path: profilePath, match: (row) => row.level === 'loader' && isRunning(row) },
              ]

          const liveStatus = (row) => {
            if (!row.live) return { text: mt('mcp.live.notLoaded'), cls: 'dsm-shadowed' }
            if (row.live.phase === 'failed') return { text: mt('mcp.live.failed'), cls: 'dsm-failed' }
            if (!row.live.enabled) return { text: mt('mcp.live.stopped'), cls: 'dsm-shadowed' }
            if (row.live.phase && row.live.phase !== 'active') return { text: mt('mcp.live.loading'), cls: 'dsm-shadowed' }
            // 判"有没有可用工具"只看**真实注册**的那个数（缓存不算）。
            if (liveEnabledOf(row) === 0) return { text: mt('mcp.live.noTools'), cls: 'dsm-disabled' }
            return { text: mt('mcp.live.running'), cls: 'dsm-enabled' }
          }
          const liveHint = (row) => {
            if (!row.live) return null
            if (row.live.phase === 'failed') return mt('mcp.live.failedHint')
            if (row.live.phase === 'active' && liveEnabledOf(row) === 0) {
              if (liveOf(row) === 0) {
                // 一个工具都没注册。曾经连上过 → 这是"断了"，给可行动的说明；
                // 从未连上过 → 说清"从来没成功过"，别让用户以为是刚坏的。
                return knownOf(row) > 0
                  ? mt('mcp.live.offlineHint', { count: knownOf(row) })
                  : mt('mcp.live.neverHint')
              }
              // 注册了但全被停用：这是用户自己的选择，不是故障。
              return mt('mcp.live.allOffHint')
            }
            return null
          }
          // 状态标签配色：绿=能用、红=坏了、橙=当前没有可用工具（未连上或工具全被停用）、灰=没在跑 / 还没定。
          const pillKind = (cls) => cls === 'dsm-enabled' ? 'ok' : cls === 'dsm-failed' ? 'bad' : cls === 'dsm-disabled' ? 'warn' : 'muted'

          // 工具数标签：有被停用的工具时给「可用/总数」（场景档案收窄与手动逐工具开关
          // 写的是同一张停用表），否则就是总数 —— 与详情页每个工具的开关状态一致。
          //
          // 只按**真实注册**的数来显示：一个都没注册时不给数字（那台 server 现在没有工具，
          // 摆一个"13 个工具"就是拿缓存冒充现状；它上次连上时有多少个，由下面那行提示说明）。
          const toolCountTag = (row) => {
            const total = liveOf(row)
            if (total <= 0) return null
            const enabled = liveEnabledOf(row)
            return enabled < total
              ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.countPartial', { enabled: enabled, total: total }))
              : React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.count', { count: total }))
          }

          const renderRow = (row) => {
            const status = liveStatus(row)
            const hint = liveHint(row)
            // 场景锁定期间整页只读（开关/编辑/删除一并消失，重启也归入冻结）。
            const editable = row.level !== 'loader' && state.locked !== true
            return React.createElement('div', { key: row.id, className: 'dsm-row', 'data-flip-key': String(row.level || '') + '/' + row.id, 'data-flip-on': row.disabled ? '0' : '1' },
              React.createElement('div', { className: 'dsm-main' },
                React.createElement('div', { className: 'dsm-name' }, row.serverName),
                row.notes ? React.createElement('div', { className: 'dsm-note dsm-note-user', title: row.notes }, mt('mcp.note.prefix') + row.notes) : null),
              React.createElement('div', { className: 'dsm-tags' },
                (levelFilter === 'loader' && row.level && row.level !== 'loader') ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.level.' + row.level)) : null,
                toolCountTag(row),
                row.duplicate ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, mt('mcp.duplicate')) : null),
              React.createElement('div', { className: 'dsm-status ' + status.cls }, status.text),
              React.createElement('div', { className: 'dsm-row-actions' },
                editable ? React.createElement(Switch, { on: !row.disabled, disabled: busy !== null || state.locked === true, label: mt('mcp.toggleServer') + ' ' + row.serverName, onClick: () => toggleRow(row) }) : null,
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: () => openDetail(row) }, mt('mcp.btn.detail')),
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: () => openEdit(row) }, mt('mcp.btn.edit')) : null,
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: () => restartRow(row) }, mt('mcp.btn.restart')) : null,
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null, onClick: () => setConfirmRow(row) }, mt('mcp.btn.remove')) : null),
              hint ? React.createElement('div', { className: 'dsm-row-hint' }, '⚠ ' + hint) : null)
          }

          const renderGroup = (group) => {
            // 启用的排在前面（用户要求）；两半各保持服务端原序 —— 停用后还能落回原位。
            const groupRows = enabledFirst(visibleRows.filter(group.match), (row) => !row.disabled)
            if (groupRows.length === 0) return null
            const open = collapsed[group.key] !== true || !!normalizedQuery
            return React.createElement('section', { key: group.key, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: () => setCollapsed(Object.assign({}, collapsed, { [group.key]: !open })) },
                  React.createElement('span', { className: 'dsm-source-title', title: group.title }, group.title),
                  React.createElement('span', { className: 'dsm-count' }, mt('mcp.servers.count', { count: groupRows.length })),
                  group.path ? React.createElement('span', { className: 'dsm-path', title: group.path }, group.path) : null)),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                React.createElement(React.Fragment, null,
                  React.createElement('div', { className: 'dsm-table-head' },
                    React.createElement('span', null, mt('mcp.table.name')),
                    React.createElement('span', null, mt('mcp.table.transport')),
                    React.createElement('span', null, mt('mcp.table.status')),
                    React.createElement('span', null, '')),
                  groupRows.map(renderRow))) : null)
          }

          const configRow = (label, value) => React.createElement('div', { className: 'dsm-fm-row', key: label },
            React.createElement('div', { className: 'dsm-fm-key' }, label),
            React.createElement('div', { className: 'dsm-fm-val' }, value))

          const toolListNode = detail && (detail.loading
            ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.loading'))
            : detail.error
              ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, mt('mcp.tools.loadFailed') + detail.error)
              : (detail.tools || []).length === 0
                ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.none'))
                : React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.note')),
                    React.createElement('div', { className: 'dsm-tools' }, (detail.tools || []).map((tool) => React.createElement('div', { className: 'dsm-tool' + (tool.enabled === false ? ' dsm-tool-off' : ''), key: tool.name },
                      React.createElement('div', { className: 'dsm-tool-name-row' },
                        React.createElement('div', { className: 'dsm-tool-name' }, tool.name),
                        // 描述来自「已知工具」缓存（服务器未运行）→ 标明是旧数据，不假装实时。
                        tool.stale ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.stale')) : null,
                        React.createElement(Switch, { on: tool.enabled !== false, disabled: busy !== null || state.locked === true, label: mt('mcp.toggleTool') + ' ' + tool.name, onClick: () => toggleTool(detail.row, tool) })),
                      tool.description ? React.createElement(ToolDesc, { text: tool.description, expandLabel: mt('mcp.tools.expand'), collapseLabel: mt('mcp.tools.collapse') }) : null,
                      (tool.parameters && tool.parameters.length > 0) ? React.createElement('div', { className: 'dsm-tool-params' }, tool.parameters.map((param) => React.createElement('div', { className: 'dsm-tool-param', key: param.key },
                          React.createElement('span', { className: 'dsm-tool-param-key' }, param.key + (param.required ? ' *' : '')),
                          React.createElement('span', { className: 'dsm-tool-param-type' }, param.type || 'any'),
                          React.createElement('span', { className: 'dsm-tool-param-desc' }, param.description || '')))) : null)))))

          const anyGroupVisible = groups.some((group) => visibleRows.some(group.match))
          const groupsNode = (state.loading && rows.length === 0)
            ? React.createElement('div', { className: 'dsm-empty' }, mt('mcp.loading'))
            : anyGroupVisible
              ? React.createElement('div', { className: 'dsm-sources', ref: flipRef }, groups.map(renderGroup))
              : React.createElement('div', { className: 'dsm-empty' }, (normalizedQuery || levelFilter) ? mt('mcp.empty.search') : mt('mcp.empty'))

          const formModalNode = formModal && React.createElement(Modal, {
            key: 'mcp-form',
            title: formModal.mode === 'edit' ? mt('mcp.form.editTitle') + formModal.id : mt('mcp.form.addTitle'),
            closeLabel: mt('btn.close'),
            onClose: closeForm,
          },
            React.createElement('div', { className: 'dsm-form' },
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.serverName')),
                React.createElement('input', { className: 'dsm-control', value: formModal.serverName, placeholder: 'e.g. github', onChange: setFormField('serverName') }),
                React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.serverName.hint'))),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.transport')),
                React.createElement(SourceSelect, { value: formModal.transport, options: MCP_TRANSPORT_OPTIONS, onChange: (value) => setFormValue('transport', value) })),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.level')),
                React.createElement(SourceSelect, {
                  value: formModal.level,
                  options: [
                    { value: 'global', label: mt('mcp.field.level.global', { path: state.paths ? state.paths.global : '~/.dsh/cordis.patch.yml' }) },
                    { value: 'project', label: mt('mcp.field.level.project', { path: state.paths ? state.paths.project : 'profiles/*/cordis.patch.yml' }) },
                  ],
                  onChange: (value) => setFormValue('level', value),
                })),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.url')),
                    React.createElement('input', { className: 'dsm-control', value: formModal.url, placeholder: 'https://host/mcp', onChange: setFormField('url') }),
                    React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.url.hint')))
                : React.createElement(React.Fragment, null,
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.command')),
                      React.createElement('input', { className: 'dsm-control', value: formModal.command, placeholder: 'npx -y @modelcontextprotocol/server-github', onChange: setFormField('command') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.args')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.args, placeholder: '-y\n@modelcontextprotocol/server-github', onChange: setFormField('args') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.env')),
                      React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.env.hint')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.env, placeholder: 'GITHUB_TOKEN=xxx', onChange: setFormField('env') }))),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.headers')),
                    React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.headers, placeholder: 'Authorization=Bearer xxx', onChange: setFormField('headers') }))
                : null),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy === 'form' || !formModal.serverName.trim(), onClick: submitForm }, formModal.mode === 'edit' ? mt('mcp.btn.save') : mt('mcp.btn.add'))))

          const detailStatus = detail ? liveStatus(detail.row) : null
          const detailHint = detail ? liveHint(detail.row) : null
          const detailNode = detail && React.createElement(Modal, {
            key: 'mcp-detail',
            wide: true,
            // 运行状态做成标题右侧的描边标签（用户裁定 2026-09-16）：状态是「一眼」信息，
            // 不该占一整块，也不该跟配置事实（是否登记在 Loader）用冒号拼成一句话。
            title: React.createElement('span', { className: 'dsm-modal-title-row' },
              mt('mcp.detail.title') + detail.row.serverName,
              React.createElement('span', { className: 'dsm-pill dsm-pill-' + pillKind(detailStatus.cls) }, detailStatus.text)),
            closeLabel: mt('btn.close'),
            onClose: () => setDetail(null),
          },
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title dsm-detail-title-row' },
                mt('mcp.detail.config'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: toggleReveal }, reveal ? mt('mcp.detail.hideSecret') : mt('mcp.detail.showSecret'))),
              React.createElement('div', { className: 'dsm-fm' },
                configRow(mt('mcp.detail.entryId'), detail.row.id),
                configRow(mt('mcp.field.level'), mt('mcp.level.' + detail.row.level)),
                configRow(mt('mcp.field.transport'), detail.row.transport || '—'),
                configRow(mt('mcp.detail.loader'), detail.row.live ? mt('mcp.detail.loader.yes') : mt('mcp.detail.loader.no')),
                detail.row.url ? configRow(mt('mcp.field.url'), detail.row.url) : null,
                detail.row.command ? configRow(mt('mcp.field.command'), detail.row.command + ((detail.row.args && detail.row.args.length) ? ' ' + detail.row.args.join(' ') : '')) : null,
                (detail.row.headers && Object.keys(detail.row.headers).length > 0) ? configRow(mt('mcp.field.headersShort'), Object.keys(detail.row.headers).map((k) => k + ': ' + maskSecret(detail.row.headers[k])).join('\n')) : null,
                (detail.row.env && Object.keys(detail.row.env).length > 0) ? configRow(mt('mcp.field.envShort'), Object.keys(detail.row.env).map((k) => k + ' = ' + maskSecret(detail.row.env[k])).join('\n')) : null)),
            // 运行状态一节只在**有可操作信息**时出现（启动失败 / 连上了但没工具）——
            // 状态本身已在标题标签里，再复述一遍就是噪音。
            detailHint ? React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.status')),
              React.createElement('div', { className: 'dsm-feedback' + (detailStatus.cls === 'dsm-failed' ? ' dsm-error' : ' dsm-warning') }, detailHint)) : null,
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.note')),
              React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: noteDraft, maxLength: 200, placeholder: mt('mcp.detail.note.placeholder'), onChange: (ev) => setNoteDraft(ev.target.value) }),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || noteDraft.trim() === String(detail.row.notes || ''), onClick: saveNote }, mt('mcp.detail.note.save')))),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.tools', { count: detail.loading ? '…' : (detail.tools || []).length })),
              toolListNode))

          const compactNode = compactConfirm && React.createElement(Modal, {
            key: 'mcp-compact',
            title: mt('mcp.compact.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setCompactConfirm(false),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.compact.desc')),
            // 底部不再放「关闭」：头部已有一个，同一个动作两个按钮是重复（用户 2026-09-18 指出）。
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null, onClick: doCompact }, mt('mcp.compact.confirm'))))

          const confirmNode = confirmRow && React.createElement(Modal, {
            key: 'mcp-remove',
            title: mt('mcp.remove.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setConfirmRow(null),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.remove.desc', { name: confirmRow.serverName })),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', onClick: confirmRemove }, mt('mcp.btn.remove'))))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, 'MCP')),
                React.createElement('p', { className: 'dsm-desc' }, mt('mcp.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(mt, busy !== null || state.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading, onClick: () => refresh() }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.locked === true, onClick: openAdd }, mt('mcp.btn.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-danger', disabled: busy !== null || state.loading || state.locked === true, title: mt('mcp.btn.compact.title'), onClick: () => setCompactConfirm(true) }, mt('mcp.btn.compact')),
                // 批量启停与页头其余动作同栏（用户 2026-09-17 裁定）。场景内**照常可用**：
                // 改动会同步写进当前场景的档案（宿主 syncSwitchToScene），只有场景锁定才冻结。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading || !summary.total, onClick: () => run('mcpm-set-all', { enabled: summary.enabled < summary.total }, 'setall') }, mt(summary.total > 0 && summary.enabled === summary.total ? 'mcp.btn.disableAll' : 'mcp.btn.enableAll')))),
            state.locked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('lock.banner')) : null,
            // 场景未锁定时开关照常可用：说清「改动会同步写进该场景的档案」，别让用户担心白改。
            state.scene ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('scene.switch.banner', { scene: state.scene })) : null,
            React.createElement('div', { className: 'dsm-stat-row' },
              React.createElement('div', { className: 'dsm-summary' },
                [['total', summary.total, mt('mcp.stat.total')], ['enabled', summary.enabled, mt('mcp.stat.enabled')], ['tools', summary.tools < summary.toolsTotal ? summary.tools + '/' + summary.toolsTotal : summary.tools, mt('mcp.stat.tools')]].map((item) =>
                  React.createElement('div', { key: item[0], className: 'dsm-stat' },
                    React.createElement('strong', null, item[1]), item[2])))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', value: query, 'aria-label': mt('mcp.search'), placeholder: mt('mcp.search.placeholder'), onChange: (ev) => setQuery(ev.target.value) }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { value: levelFilter, options: mcpLevelOptions(), onChange: setLevelFilter }))),
            restartInfo ? React.createElement('div', { className: 'dsm-feedback' }, mt('mcp.restarting', { name: restartInfo.name, seconds: Math.max(0, Math.floor((Date.now() - restartInfo.startedAt) / 1000)) })) : null,
            React.createElement(Notice, { kind: msg && msg.kind, text: msg && msg.text }),
            React.createElement(Notice, { kind: 'err', text: state.error }),
            React.createElement(Notice, { kind: 'warn', text: (state.errors && state.errors.length > 0) ? mt('mcp.err.warnings') + state.errors.join('；') : null }),
            React.createElement(Notice, { kind: 'warn', text: (state.warnings && state.warnings.length > 0) ? state.warnings.join('；') : null }),
            state.revealError ? React.createElement('div', { className: 'dsm-token-panel' },
              React.createElement(Notice, { kind: 'err', text: state.revealError.text }),
              // 令牌不对 → 给输入框；宿主根本没配令牌 → 输入框也没用，只给"该怎么配"的说明，
              // 免得摆一个按了必然失败的按钮。
              state.revealError.code === 'error.secret.badToken' ? React.createElement('div', { className: 'dsm-token-row' },
                React.createElement('input', {
                  className: 'dsm-control', type: 'password', value: tokenDraft,
                  placeholder: mt('mcp.token.placeholder'), 'aria-label': mt('mcp.token.label'),
                  onChange: (ev) => setTokenDraft(ev.target.value),
                }),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: !tokenDraft.trim(), onClick: applyToken }, mt('mcp.token.save'))) : null,
              React.createElement('p', { className: 'dsm-help' }, mt('mcp.token.hint'))) : null,
            groupsNode,
            formModalNode,
            detailNode,
            compactNode,
            confirmNode)
        }

        // ---------- AGENTS.md 预设页：多套全局指令基线，应用=写入 ~/.dsh/AGENTS.md ----------
        function AgentsMdPage() {
          // deny = 一次性「拒绝」说明（如：被引用的预设不能删）。它**不替换列表**——
          // 复用 error 会让整页列表消失，用户删不动之后连列表都看不到了。
          var st = React.useState({ loading: true, error: null, presets: [], current: null, deny: null })
          var state = st[0], setState = st[1]
          var busyState = React.useState(null), busy = busyState[0], setBusy = busyState[1]
          var em = React.useState(null), editModal = em[0], setEditModal = em[1]
          var cm = React.useState(null), createModal = cm[0], setCreateModal = cm[1]
          var ac = React.useState(null), applyConfirm = ac[0], setApplyConfirm = ac[1]
          // 回收站：null = 关闭；{loading, error, entries}
          var ts = React.useState(null), trash = ts[0], setTrash = ts[1]
          var tb = React.useState(false), trashBusy = tb[0], setTrashBusy = tb[1]
          // D14：导出弹窗（null = 关闭；{busy, result}）。
          var xo = React.useState(null), exportState = xo[0], setExportState = xo[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          /** 打开/刷新回收站（每次操作后重读，界面永远显示磁盘上的真实条目）。 */
          function loadTrash(keepOpen) {
            var next = Object.assign({ loading: true, error: null, entries: [] }, keepOpen ? trash || {} : {})
            setTrash(next)
            apiCall('agentsmd-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.trash || [] })
              else setTrash({ loading: false, error: (res && res.error) || t('trash.loadFailed'), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: String((e && e.message) || e), entries: [] }) })
          }
          function restorePreset(item) {
            setTrashBusy(true)
            apiCall('agentsmd-trash-restore', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setState(function (s) { return Object.assign({}, s, { notice: t('trash.restored', { name: item.name }) }) }); refresh(); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          function purgePreset(item) {
            setTrashBusy(true)
            apiCall('agentsmd-trash-delete', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setState(function (s) { return Object.assign({}, s, { notice: t('trash.purged', { name: item.name }) }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          // 导入：与技能页同一个 ImportModal（拖拽区 + 文件要求清单 + 结果反馈）。
          // 一次可选多份 .md，逐个读取正文导入；同名/失败逐条回报，不因一个失败中断其余的。
          var impOpenState = React.useState(false); var importOpen = impOpenState[0], setImportOpen = impOpenState[1]
          var impBusyState = React.useState(false); var importBusy = impBusyState[0], setImportBusy = impBusyState[1]
          var impResultState = React.useState(null); var importResult = impResultState[0], setImportResult = impResultState[1]
          function importIdOf(name) {
            return String(name || '').replace(/\.(md|markdown|txt)$/i, '').trim().replace(/[\\/<>:"|?*]+/g, '-') || 'imported'
          }
          function doImportFiles(files) {
            var list = Array.prototype.slice.call(files || [])
            if (!list.length) return
            setImportBusy(true); setImportResult(null)
            var done = [], failed = []
            var chain = Promise.resolve()
            list.forEach(function (file) {
              chain = chain.then(function () {
                return file.text().then(function (text) {
                  var id = importIdOf(file.name)
                  return apiCall('agentsmd-import', { id: id, content: String(text) }).then(function (res) {
                    if (res && res.ok) done.push(res.id || id)
                    else failed.push(String(file.name) + '（' + ((res && res.error) || '') + '）')
                  })
                })
              }).catch(function (e) { failed.push(String(file.name) + '（' + String((e && e.message) || e) + '）') })
            })
            chain.then(function () {
              setImportBusy(false)
              if (!done.length) setImportResult({ ok: false, text: failed.length ? t('import.skipped', { items: failed.join('、') }) : t('import.none') })
              else setImportResult({
                ok: true, warning: failed.length > 0,
                text: t('agm.result.imported', { count: done.length, names: done.join('、') }) + (failed.length ? t('import.skipped', { items: failed.join('、') }) : ''),
              })
              refresh()
            })
          }

          function refresh(silent) {
            // 手动刷新（含首次加载）要把按钮切到「刷新中…」——点完毫无反馈等于没点。
            // 页面内部那些「操作完顺手重读」的调用传 silent，免得按钮每次都闪一下。
            if (!silent) setState(function (s) { return Object.assign({}, s, { loading: true }) })
            apiCall('agentsmd-list', {}).then(function (res) {
              // 刷新即清掉上一次的「拒绝」说明（它解释的是那一次点击，不是常驻状态）。
              setState(function (s) { return { loading: false, error: res && res.ok ? null : ((res && res.error) || mt('mcp.msg.loadFailed')), presets: (res && res.presets) || [], current: s.current, scenePrompt: (res && res.scenePrompt) || null, anyLocked: (res && res.anyLocked) === true, deny: res && res.ok ? null : s.deny } })
            }).catch(function (e) { setState({ loading: false, error: String((e && e.message) || e), presets: [], current: null, scenePrompt: null, deny: null }) })
            apiCall('agentsmd-get-current', {}).then(function (res) {
              if (res && res.ok) setState(function (s) { return Object.assign({}, s, { current: res }) })
            }).catch(function () {})
          }
          React.useEffect(function () { refresh() }, [])

          var cur = state.current
          // 场景接管基线时（scenePrompt 指向某个启用场景的绑定），提示词页的「应用」只对
          // 场景绑定的那一份可用：应用别的预设会绕过场景绑定，造成「场景页显示 A、实际注入 B、
          // A 不能删而 B 能删」这类各说各话的状态（用户实测）。同一份 = 「重新应用」
          // （把被手改的 AGENTS.md 写回场景绑定的内容）→ 仍放行。
          var sceneDriver = state.scenePrompt && state.scenePrompt.scene && state.scenePrompt.presetId && state.scenePrompt.missing !== true ? state.scenePrompt : null
          var sceneDriverLabel = sceneDriver ? (sceneDriver.label || sceneDriver.scene) : ''
          /** 引用说明：判定在宿主（scene-prompt-sync），这里只负责把它说成人话。 */
          function refText(r) {
            if (r.kind === 'scene') return t(r.active ? 'agm.ref.sceneActive' : 'agm.ref.scene', { scene: r.label || r.scene })
            if (r.kind === 'restore') return t('agm.ref.restore')
            return t('agm.ref.file')
          }
          function refsOf(p) { return (p.refs || []).map(refText) }
          // 改名结果提示：短暂显示后自动消失（与场景页的结果条同一节奏）。
          React.useEffect(function () {
            if (!state.notice) return undefined
            var timer = setTimeout(function () { setState(function (s) { return Object.assign({}, s, { notice: null }) }) }, 4000)
            return function () { clearTimeout(timer) }
          }, [state.notice])

          function openEdit(p) {
            // id 可改：改名 = 目录改名，宿主会把场景绑定一起改名（见 rules-rebind-prompt）。
            apiCall('agentsmd-read', { id: p.id }).then(function (res) {
              if (res && res.ok) setEditModal({ id: p.id, nextId: p.id, content: res.content, description: p.description || '' })
            }).catch(function () {})
          }
          function doApply(id) {
            setBusy('apply-' + id)
            // 应用会写全局基线（接管期间还可能改绑场景），失败必须可见 —— 静默返回会让
            // 用户以为已写入（按钮恢复可点，文件却没变）。与 doRemove 同一套显示路径。
            apiCall('agentsmd-apply', { id: id }).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) setState(function (s) { return Object.assign({}, s, { error: res.error }) })
              else refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); setState(function (s) { return Object.assign({}, s, { error: String((e && e.message) || e) }) }) })
          }
          function doRemove(p) {
            setBusy('rm-' + p.id)
            // 宿主会拒绝删除「正在生效」的预设（按钮已禁用，这里兜住旧页面/竞态），
            // 因此必须把响应里的错误显示出来，不能静默什么都不发生。
            apiCall('agentsmd-remove', { id: p.id }).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) setState(function (s) { return Object.assign({}, s, { error: res.error }) })
              else refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); setState(function (s) { return Object.assign({}, s, { error: String((e && e.message) || e) }) }) })
          }
          function doCreate(id, from, content, description) {
            setBusy('create')
            // content 优先（用户直接写的内容）；留空才走 from 复制；都没有 = 宿主空模板。
            apiCall('agentsmd-create', {
              id: id,
              ...(content ? { content: content } : {}),
              ...(from ? { from: from } : {}),
              // 描述只给使用者看（存 meta.json，不进 AGENTS.md）。
              description: String(description == null ? '' : description),
            }).then(function (res) {
              setBusy(null)
              if (res && res.ok) { setCreateModal(null); refresh() }
              else if (res) setCreateModal(Object.assign({}, createModal, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          function doUpdate() {
            setBusy('update')
            apiCall('agentsmd-update', { id: editModal.id, nextId: String(editModal.nextId || editModal.id), content: editModal.content, description: String(editModal.description == null ? '' : editModal.description) }).then(function (res) {
              setBusy(null)
              if (res && res.ok) {
                setEditModal(null)
                if (res.renamedFrom) setState(function (s) { return Object.assign({}, s, { notice: t('agm.result.renamed', { id: res.id }) + (res.reboundScenes ? t('agm.result.rebound', { count: res.reboundScenes }) : '') }) })
                refresh()
              } else if (res) setEditModal(Object.assign({}, editModal, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          /** 「或从现有预设复制」：把选中预设的正文读进表单，之后仍可自由编辑。 */
          function loadFromPreset(target, id) {
            if (!id) { if (target === 'create') setCreateModal(Object.assign({}, createModal, { from: '' })); return }
            apiCall('agentsmd-read', { id: id }).then(function (res) {
              if (!res || !res.ok) return
              if (target === 'create') setCreateModal(Object.assign({}, createModal, { from: id, content: res.content }))
            }).catch(function () {})
          }

          // 只有「还没有任何内容」时才让加载占位顶掉列表：手动点刷新时列表不该凭空消失，
          // 反馈由刷新按钮自己的「刷新中…」承担（与记忆页 / 技能页同一口径）。
          var body = state.loading && !state.presets.length
            ? React.createElement('div', { className: 'dsm-empty' }, t('agm.loading'))
            : state.error
              ? React.createElement(Notice, { kind: 'err', text: state.error })
              : !state.presets.length
                ? React.createElement('div', { className: 'dsm-empty' }, t('agm.empty'))
                : React.createElement('div', { className: 'dsm-sources', ref: flipRef }, enabledFirst(state.presets, function (p) { return !!p.active; }).map(function (p) {
                    // 「生效中」= 当前真正在起作用的基线：启用的场景绑了它，就是它（用户裁定）；
                    // 否则看文件比对。p.fileApplied 单独留着，说明「AGENTS.md 里确实是它」。
                    var viaScene = p.activeVia === 'scene'
                    var refs = p.refs || []
                    var restoreRef = refs.some(function (r) { return r.kind === 'restore' })
                    var refTexts = refsOf(p)
                    // 场景绑的就是它，但 AGENTS.md 里的内容不是它（被手改过？）→ 说清楚，
                    // 并留「重新应用」这条路写回。
                    var fileMismatch = !!sceneDriver && sceneDriver.presetId === p.id && !p.fileApplied
                    // 场景接管的是**别的**预设时，应用这一份 = 把该场景改绑到它（用户裁定
                    // 2026-09-17：未锁定时切换要可用，并且同步写进场景档案），所以不再拦截；
                    // 只在 title 里把后果说出来，用户点了才知道会发生什么。
                    var applyRebinds = !!sceneDriver && sceneDriver.presetId !== p.id
                    return React.createElement('div', { key: p.id, className: 'dsm-source', 'data-flip-key': p.id, 'data-flip-on': p.active ? '1' : '0' },
                      React.createElement('div', { className: 'dsm-source-head' },
                        React.createElement('div', { className: 'dsm-source-head-main' },
                          React.createElement('span', { className: 'dsm-source-title', title: p.id }, p.id),
                          p.active ? React.createElement('span', { className: 'dsm-tag dsm-tag-on', title: viaScene ? t('agm.active.hint.scene', { scene: (state.scenePrompt && state.scenePrompt.label) || (state.scenePrompt && state.scenePrompt.scene) || '' }) : t('agm.active.hint.file') }, t('agm.active')) : null,
                          !p.active && p.fileApplied ? React.createElement('span', { className: 'dsm-tag', title: t('agm.file.applied.hint') }, t('agm.file.applied')) : null,
                          fileMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('agm.file.mismatch.hint') }, t('agm.file.mismatch')) : null,
                          // 场景绑定**不在这里标标签**（用户裁定）：多场景绑同一份时标签会把行挤爆；
                          // 谁在引用它，点「删除」时会逐条说出来（`agm.btn.delete.blocked.refs`）。
                          restoreRef ? React.createElement('span', { className: 'dsm-tag', title: t('agm.restore.tag.hint') }, t('agm.restore.tag')) : null),
                        React.createElement('div', { className: 'dsm-source-actions' },
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: state.anyLocked === true, onClick: function () { openEdit(p) } }, t('agm.btn.edit')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.anyLocked === true, onClick: function () { setApplyConfirm({ id: p.id }) }, title: applyRebinds ? t('agm.apply.rebindScene', { scene: sceneDriverLabel }) : t('agm.apply.hint') }, p.fileApplied ? t('agm.btn.reapply') : t('agm.btn.apply')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null || state.anyLocked === true, title: refTexts.length > 0 ? t('agm.btn.delete.blocked.refs', { refs: refTexts.join(t('agm.ref.sep')) }) : t('scenes.lock.blockedEdit'), onClick: function () {
                            // 被引用的预设**点得动但删不掉**：当面说出「谁在用」，而不是让用户对着
                            // 禁用按钮猜（disabled 的按钮连 title 都不弹）。宿主侧同样拒绝，这里只是先说。
                            if (refTexts.length > 0) { setState(function (s) { return Object.assign({}, s, { deny: t('agm.btn.delete.blocked.refs', { refs: refTexts.join(t('agm.ref.sep')) }) }) }); return }
                            setApplyConfirm({ id: p.id, remove: true })
                          } }, t('agm.btn.delete')))), p.description ? React.createElement("div", { key: "desc", className: "dsm-source-note", title: p.description }, p.description) : null)
                  }))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.prompts'))),
                React.createElement('p', { className: 'dsm-desc' }, t('prompts.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, state.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: state.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.anyLocked === true, onClick: function () { setCreateModal({ id: '', from: '', content: '', description: '', error: null }) } }, t('agm.btn.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.anyLocked === true, onClick: function () { setImportResult(null); setImportOpen(true) } }, t('agm.btn.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || !state.presets.length, onClick: function () { setExportState({ busy: false, result: null }) } }, t('export.presets')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            state.anyLocked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 场景接管时把「为什么应用按钮点不动」直接写出来，而不是让用户对着置灰的按钮猜。
            sceneDriver ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('agm.sceneLock.notice', { scene: sceneDriverLabel, id: sceneDriver.presetId })) : null,
            // 一次性拒绝说明（被引用的预设删不掉）：不替换列表，只加一条横幅。
            state.deny ? React.createElement(Notice, { kind: 'warn', text: state.deny }) : null,
            React.createElement('div', { className: 'dsm-summary', style: { '--dsm-stat-cols': '2' } },
              [['total', state.presets.length, t('agm.stat.total')], ['active', state.presets.filter(function (p) { return p.active }).length, t('agm.stat.active')]].map(function (item) {
                return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                  React.createElement('strong', null, item[1]), item[2])
              })),
            body,
            state.notice ? React.createElement(Notice, { kind: 'ok', text: state.notice }) : null,
            exportState ? React.createElement(ExportModal, {
              key: 'export', t: t, title: t('export.presets'),
              items: state.presets.map(function (p) { return { key: p.id, name: p.id, desc: p.description || '' } }),
              busy: exportState.busy, result: exportState.result,
              onClose: function () { setExportState(null) },
              onSubmit: function (names, outDir) {
                setExportState({ busy: true, result: null });
                apiCall('bundle-export', { kind: 'presets', names: names, outDir: outDir }).then(function (res) {
                  if (res && res.ok) setExportState({ busy: false, result: { ok: true, text: exportResultText(t, res) } });
                  else setExportState({ busy: false, result: { ok: false, text: translateError(t, res) } });
                }).catch(function (e) { setExportState({ busy: false, result: { ok: false, text: String((e && e.message) || e) } }) });
              },
            }) : null,
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              groupTitle: t('trash.group.presets'),
              groupSub: t('trash.section.presets.sub'),
              locked: state.anyLocked === true,
              entries: trash.entries,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restorePreset,
              onPurge: purgePreset,
            }) : null,
            // 编辑：id 与内容都可改（改 id = 目录改名，场景绑定由宿主一起改名）。
            editModal ? React.createElement(Modal, { title: t('agm.edit.title') + ' · ' + editModal.id, closeLabel: t('btn.close'), onClose: function () { setEditModal(null) } },
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.id')),
                React.createElement('input', { className: 'dsm-control', value: editModal.nextId || '', onChange: function (e) { setEditModal(Object.assign({}, editModal, { nextId: e.target.value, error: null })) } }),
                React.createElement('p', { className: 'dsm-help' }, t('agm.field.id.hint'))),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.desc')),
                React.createElement('input', { className: 'dsm-control', placeholder: t('agm.field.desc.placeholder'), value: editModal.description || '', onChange: function (e) { setEditModal(Object.assign({}, editModal, { description: e.target.value })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', value: editModal.content, onChange: function (e) { setEditModal(Object.assign({}, editModal, { content: e.target.value })) } })),
              editModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, editModal.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || !String(editModal.nextId || '').trim(), onClick: doUpdate }, t('agm.btn.save')))) : null,
            // 新建：id + **正文文本框**（用户直接写内容）；「从现有预设复制」是可选下拉，
            // 选中后把那份正文填进文本框，仍可继续改——不再是容易被当成搜索框的文本输入。
            createModal ? React.createElement(Modal, { title: t('agm.btn.new'), closeLabel: t('btn.close'), onClose: function () { setCreateModal(null) } },
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.id')),
                React.createElement('input', { className: 'dsm-control', placeholder: t('agm.field.id.placeholder'), value: createModal.id, onChange: function (e) { setCreateModal(Object.assign({}, createModal, { id: e.target.value, error: null })) } }),
                React.createElement('p', { className: 'dsm-help' }, t('agm.field.id.hint'))),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.desc')),
                React.createElement('input', { className: 'dsm-control', placeholder: t('agm.field.desc.placeholder'), value: createModal.description || '', onChange: function (e) { setCreateModal(Object.assign({}, createModal, { description: e.target.value })) } })),
              (state.presets || []).length ? React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.copyFrom')),
                React.createElement(SourceSelect, {
                  options: [{ value: '', label: t('agm.field.copyFrom.none') }].concat((state.presets || []).map(function (p) { return { value: p.id, label: p.id } })),
                  value: createModal.from || '',
                  onChange: function (v) { loadFromPreset('create', v) },
                })) : null,
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', placeholder: t('agm.field.content.placeholder'), value: createModal.content || '', onChange: function (e) { setCreateModal(Object.assign({}, createModal, { content: e.target.value })) } })),
              createModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, createModal.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || !String(createModal.id || '').trim(), onClick: function () { doCreate(createModal.id, createModal.from, createModal.content, createModal.description) } }, t('agm.btn.create')))) : null,
            applyConfirm ? React.createElement(Modal, { title: applyConfirm.remove ? (t('agm.remove.title') + ' · ' + applyConfirm.id) : (t('agm.applyModal.title') + ' · ' + applyConfirm.id), closeLabel: t('btn.close'), onClose: function () { setApplyConfirm(null) } },
              applyConfirm.remove
                ? React.createElement('p', { className: 'dsm-help' }, t('agm.remove.title') + ' ' + applyConfirm.id + t('agm.remove.suffix'))
                : React.createElement('div', null,
                    React.createElement('p', { className: 'dsm-help' }, t('agm.apply.prefix') + applyConfirm.id + t('agm.apply.suffix')),
                    React.createElement('div', { className: 'dsm-feedback dsm-warning' }, t('agm.apply.note'))),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn ' + (applyConfirm.remove ? 'dsm-btn-danger' : ''), disabled: busy !== null, onClick: function () { if (applyConfirm.remove) doRemove({ id: applyConfirm.id }); else doApply(applyConfirm.id) } }, applyConfirm.remove ? t('agm.btn.confirmRemove') : t('agm.btn.confirmApply')))) : null,
            importOpen ? React.createElement(ImportModal, {
              key: 'imp', t: t, title: t('agm.btn.import'), accept: '.md',
              busy: importBusy, result: importResult,
              requirements: [t('upload.requirement.prompt.1'), t('upload.requirement.prompt.2'), t('upload.requirement.prompt.3')],
              onClose: function () { setImportOpen(false); setImportResult(null) },
              onSubmit: function (entries, files) { doImportFiles(files) },
            }) : null)
        }

        // 「工具」设置页：一个侧栏项，内部 tab 切换 场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话。
        function ToolsSection() {
          var tabState = React.useState('scenes')
          var active = tabState[0], setActive = tabState[1]
          var sectionRef = React.useRef(null)
          React.useEffect(function () {
            // 设置宿主的真正滚动容器，而不是 body：不同页签内容高度不同，
            // 让滚动条按需出现会改变 options 宽度，页签/GitHub 随之左右跳动。
            //
            // ⚠️ 必须**向上查找**而不是固定跳两级：`.dsm-tabs-shell` 的 position:sticky
            // 依赖祖先链上没有被 overflow 裁剪的层，宿主 DOM 结构一变，「上两级」就可能
            // 指到非滚动容器（sticky 随之失效，页签被内容滚走）。
            var section = sectionRef.current
            if (!section) return undefined
            var host = null
            var node = section.parentElement
            while (node && node !== document.body) {
              var oy = window.getComputedStyle(node).overflowY
              if (oy === 'auto' || oy === 'scroll') { host = node; break }
              node = node.parentElement
            }
            // 找不到（宿主换了实现）→ 退回原来的「上两级」，保持兼容。
            if (!host) host = section.parentElement && section.parentElement.parentElement
            if (!host) return undefined
            host.classList.add('dsm-settings-scroll-host')
            return function () { host.classList.remove('dsm-settings-scroll-host') }
          }, [])
          var page = active === 'scenes' ? React.createElement(ScenesPage)
            : active === 'mcp' ? React.createElement(MCPPage)
            : active === 'skills' ? React.createElement(SkillManagerSection, { t: t })
            : active === 'subagents' ? React.createElement(SubagentsPage)
            : active === 'prompts' ? React.createElement(AgentsMdPage)
            : active === 'memory' ? React.createElement(MemoryPage)
            : active === 'compat' ? React.createElement(CompatPage, { t: t })
            : React.createElement(HistoryPage)
          return React.createElement('section', { ref: sectionRef, className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-tabs-shell' },
              React.createElement('div', { className: 'dsm-tabs' },
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'scenes' ? ' dsm-tab-active' : ''), onClick: function () { setActive('scenes') }, title: t('tabs.scenes') }, t('tabs.scenes')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'mcp' ? ' dsm-tab-active' : ''), onClick: function () { setActive('mcp') }, title: 'MCP' }, 'MCP'),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'skills' ? ' dsm-tab-active' : ''), onClick: function () { setActive('skills') }, title: t('tabs.skills') }, t('tabs.skills')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'subagents' ? ' dsm-tab-active' : ''), onClick: function () { setActive('subagents') }, title: t('tabs.subagents') }, t('tabs.subagents')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'prompts' ? ' dsm-tab-active' : ''), onClick: function () { setActive('prompts') }, title: t('tabs.prompts') }, t('tabs.prompts')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'memory' ? ' dsm-tab-active' : ''), onClick: function () { setActive('memory') }, title: t('tabs.memory') }, t('tabs.memory')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'sessions' ? ' dsm-tab-active' : ''), onClick: function () { setActive('sessions') }, title: t('tabs.sessions') }, t('tabs.sessions')),
                React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'compat' ? ' dsm-tab-active' : ''), onClick: function () { setActive('compat') }, title: t('tabs.compat') }, t('tabs.compat'))),
              React.createElement(FeedbackLinks, null)),
            page)
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsm-tools', order: 16, label: function () { return t('nav.title') }, locale: NS },
          () => React.createElement(ToolsSection)
        ))


        // ---------- Skills 页（移植自 dsh-skills-manager，Apache-2.0；类名前缀 dsm-） ----------
        var react = React // 上游组件使用小写 react，别名到本文件的 React
        var h = React.createElement

        // SKILL.md frontmatter 已知键的标签走 DICT（fm.label.*，未知键原样显示并附原始键名提示）。
        function frontmatterValue(t, value) {
          if (Array.isArray(value)) return value.join('、')
          if (value === true) return t('fm.yes')
          if (value === false) return t('fm.no')
          if (value === null || value === undefined) return ''
          if (typeof value === 'object') return JSON.stringify(value, null, 2)
          return String(value)
        }
        // 详情页把 frontmatter 渲染成键值表（原始 JSON 对使用者几乎不可读）。
        function renderFrontmatter(t, frontmatter) {
          var keys = frontmatter && typeof frontmatter === 'object' ? Object.keys(frontmatter) : []
          if (!keys.length) return h('div', { className: 'dsm-note' }, t('detail.noFrontmatter'))
          return h('div', { className: 'dsm-fm' }, keys.map(function (key) {
            var label = translateOrFallback(t, 'fm.label.' + key, key)
            return h('div', { className: 'dsm-fm-row', key: key },
              h('div', { className: 'dsm-fm-key' }, label, label === key ? null : h('span', { className: 'dsm-fm-raw' }, key)),
              h('div', { className: 'dsm-fm-val' }, frontmatterValue(t, frontmatter[key])))
          }))
        }



    function translateOrFallback(t, key, fallback, params) { var value = t(key, params); return typeof value === "string" && value !== key ? value : fallback; }
    /**
     * 字段下的多行说明 → 条目清单（与导入弹窗的「文件要求」同款样式，见 dsm-help-list）。
     * 词典值按 `\n` 分段，一段一条：一整句话里塞三件事时，条目比句子好扫。
     * 只有一件事实的说明不要用它 —— 一条的清单比一句话更难读。
     */
    function helpBullets(t, key) {
      return React.createElement('ul', { className: 'dsm-help-list' }, String(t(key)).split('\n').map(function (line, i) {
        return React.createElement('li', { key: i }, line)
      }))
    }
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
  "/prefer": "skill-prefer", "/unprefer": "skill-unprefer",
  "/source-enable": "skill-source-enable", "/source-disable": "skill-source-disable",
  // 「移除来源 / 恢复读取」两个按钮曾经打的是这两个路径，但映射表里没有它们 ——
  // callApi 直接 reject("unknown action")，弹窗又 catch 掉了，按钮点下去毫无反应。
  "/source-remove": "skill-source-remove", "/source-restore": "skill-source-restore",
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
    // 场景内改开关时宿主会顺手把改动同步写进当前场景档案；同步没跟上（写盘失败 /
    // 场景已被删）时它会挂一个 `sceneSyncError`。这里必须把它带出去 —— 否则页面只会
    // 显示「已更新」，而运行时与档案已经对不上了（v0.9.1 之前正是静默的，用户只能靠肉眼
    // 去档案里比对才发现）。
    if (payload.sceneSyncError) {
      return Object.assign({}, (payload.data && typeof payload.data === "object") ? payload.data : {}, { sceneSyncError: payload.sceneSyncError });
    }
    return payload.data;
  });
}
/**
 * 「改动已生效，但没能同步写进场景档案」的提示文案（没有就返回空串）。
 *
 * 入参可以是原始响应信封，也可以是上面 callApi 贴过字段的 data —— 两种都认。
 */
function sceneSyncWarn(t, res) {
  var err = res && res.sceneSyncError;
  return err ? t("scene.sync.failed", { error: String(err) }) : "";
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
    // 技能页主列表：去掉没有技能的项目级空壳，以及**已被移除**的来源（它们单独一组显示，
    // 在那里可以「恢复读取」）。项目根与已移除根都不参与「全部来源」筛选。
    function visibleSkillRoots(roots) { return (roots || []).filter(function (root) { if (root.removed === true) return false; return root.scope !== "project" || (root.skills || []).length > 0; }); }
    /** 已移除的来源（不在主列表里，但要让用户看得到并恢复）。 */
    function removedSkillRoots(roots) { return (roots || []).filter(function (root) { return root.removed === true; }); }
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

    /**
     * 「启用的排在前面」——on/off 两半各自保持宿主原序（稳定分区，不是排序）。
     * 不用 sort：用户要求「停用后落回原来的位置」，sort 会打乱半区内的相对次序。
     * 返回新数组：入参多是 React state 里的数组，就地改会让列表在别处一起变。
     */
    function enabledFirst(items, isOn) {
      var on = [], off = [];
      (items || []).forEach(function (item) { (isOn(item) ? on : off).push(item); });
      return on.concat(off);
    }

    /** 换位过渡时长（毫秒）。与 .dsm-switch:after 的 160ms 同档，观感一致。 */
    var FLIP_MS = 180;

    /**
     * 列表换位的 FLIP 动画：开关一变、行挪了位，就让它滑过去而不是瞬移。
     * 只在「同一批元素、且启停状态确实变了」的那一帧播放：
     *   搜索 / 筛选 / 展开收起 / 列表加载 → key 有增删 → 只记录不播；
     *   MCP 的轮询与计时器只重渲染同一份列表 → 没有启停变化 → 不播。
     * 用 useLayoutEffect：反向位移必须写在浏览器绘制之前，否则会先闪一帧新布局。
     * 量 offsetTop/offsetLeft（布局坐标）而不是 getBoundingClientRect：
     *   自身动画中的 transform 与页面滚动都不会污染基线；多列网格（场景页）的横向位移也覆盖。
     * 前提：同一容器里的行共用同一个 offsetParent（这些行到卡片链上没有定位元素）。
     * ref 为空（没渲染 / 测试里的假 dispatcher）时静默跳过。
     */
    function useFlipReorder(ref) {
      var prevRef = React.useRef(null);
      // 万一宿主换了个没有 useLayoutEffect 的 React：退到 useEffect（会先闪一帧，但别崩）。
      var useIso = React.useLayoutEffect || React.useEffect;
      useIso(function () {
        var host = ref.current;
        if (!host || typeof host.querySelectorAll !== 'function') return;
        var nodes = Array.prototype.slice.call(host.querySelectorAll('[data-flip-key]'));
        var next = new Map();
        nodes.forEach(function (node) {
          if (!node.offsetWidth && !node.offsetHeight) return; // 没布局（隐藏 / 收起）→ 不可比
          next.set(node.getAttribute('data-flip-key'), {
            left: node.offsetLeft, top: node.offsetTop,
            on: node.getAttribute('data-flip-on'),
          });
        });
        var prev = prevRef.current;
        prevRef.current = { host: host, map: next };
        // 首帧、容器换过（列表卸载重建）、key 有增删、有重复 key → 只记录不播。
        if (!prev || prev.host !== host || next.size === 0
          || next.size !== nodes.length || next.size !== prev.map.size) return;
        var changed = false, sameKeys = true;
        next.forEach(function (item, key) {
          var before = prev.map.get(key);
          if (!before) { sameKeys = false; return; }
          if (before.on !== item.on) changed = true;
        });
        if (!sameKeys || !changed) return;
        if (typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        nodes.forEach(function (node) {
          var key = node.getAttribute('data-flip-key'), before = prev.map.get(key);
          if (!before) return;
          var item = next.get(key), dx = before.left - item.left, dy = before.top - item.top;
          if (!dx && !dy) return; // 本来就没挪窝
          // 上一次没播完就再来一次：只在这时要还原（否则轮询会把动画截断成瞬移）。
          if (node.__dsmFlip) { clearTimeout(node.__dsmFlip); node.__dsmFlip = 0; }
          node.style.transition = 'none'; // 先瞬移回原位，否则浏览器把新位置当动画起点
          node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          void node.offsetWidth;          // 结算样式，让上面两句真的落到起点上
          node.style.transition = 'transform ' + FLIP_MS + 'ms ease';
          node.style.transform = '';
          // 收尾清掉内联样式：留着 transform 会改变包含块、且动画后仍叠在相邻行之上。
          node.__dsmFlip = setTimeout(function () {
            node.__dsmFlip = 0;
            node.style.transition = '';
            node.style.transform = '';
          }, FLIP_MS + 40);
        });
      });
    }

    function SourceSelect(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], selected = props.options.find(function (o) { return o.value === props.value; }) || props.options[0], ref = react.useRef(null);
      react.useEffect(function () { if (!open) return undefined; function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); } document.addEventListener("pointerdown", close); return function () { document.removeEventListener("pointerdown", close); }; }, [open]);
      return h("div", { className: "dsm-select", ref: ref }, h("button", { type: "button", className: "dsm-select-trigger", "aria-haspopup": "listbox", "aria-expanded": open, onClick: function () { setOpen(!open); } }, h("span", null, selected.label)), open ? h("div", { className: "dsm-select-menu", role: "listbox" }, props.options.map(function (o) { return h("button", { key: o.value || "all", type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }
    // 场景输入（combobox）：既能从已有场景里挑，也能直接手输一个新场景名——
    // 宿主 rules-create 用 mkdir(recursive) 落盘，所以「自定义场景」无需先建目录。
    function SceneCombo(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], ref = react.useRef(null);
      react.useEffect(function () { if (!open) return undefined; function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); } document.addEventListener("pointerdown", close); return function () { document.removeEventListener("pointerdown", close); }; }, [open]);
      var options = props.options || [];
      return h("div", { className: "dsm-select", ref: ref },
        h("div", { className: "dsm-combo-row" },
          h("input", { className: "dsm-control" + (props.invalid ? " dsm-rule-invalid" : ""), type: "text", value: props.value || "", placeholder: props.placeholder, "aria-label": props.label, onChange: function (e) { props.onChange(e.target.value); } }),
          h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", "aria-haspopup": "listbox", "aria-expanded": open, disabled: props.disabled || !options.length, onClick: function () { setOpen(!open); } }, props.browseLabel)),
        open && options.length ? h("div", { className: "dsm-select-menu", role: "listbox" }, options.map(function (o) { return h("button", { key: o.value, type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }
    function Switch(props) { return h("button", { type: "button", className: "dsm-switch" + (props.on ? " dsm-switch-on" : ""), role: "switch", "aria-checked": props.on, "aria-label": props.label, title: props.title, disabled: props.disabled, onClick: props.onClick }); }
    function GithubMark16() { return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, h("path", { fill: "currentColor", d: "M8 0a8 8 0 0 0-2.53 15.59c.4.074.547-.173.547-.385 0-.19-.007-.693-.01-1.36-2.226.484-2.695-1.073-2.695-1.073-.364-.924-.89-1.17-.89-1.17-.726-.496.055-.486.055-.486.803.056 1.225.824 1.225.824.714 1.223 1.872.87 2.328.665.072-.517.28-.87.508-1.07-1.777-.202-3.645-.888-3.645-3.956 0-.874.31-1.588.823-2.148-.083-.202-.357-1.017.078-2.12 0 0 .672-.215 2.2.82A7.65 7.65 0 0 1 8 4.8c.68.003 1.365.092 2.004.27 1.527-1.035 2.197-.82 2.197-.82.437 1.103.162 1.918.08 2.12.513.56.822 1.274.822 2.148 0 3.076-1.872 3.752-3.654 3.95.288.248.544.735.544 1.482 0 1.07-.01 1.932-.01 2.195 0 .214.144.463.55.384A8.001 8.001 0 0 0 8 0Z" })); }
    /**
     * 弹窗原语。`list: true` 时走「列表类」三段式：固定头 / 滚动体 / 固定底，
     * 配 `.dsm-modal-list`（宽高都固定），滚动只发生在 body 这一层 —— 条目数变化时
     * 弹窗不跳、也不会出现嵌套滚动条。普通表单/确认类**不传 list**，结构保持原样。
     */
    /**
     * 工具描述：超过两行才默认只显示两行，点「展开」看全文。
     *
     * 为什么需要：MCP 工具描述动辄几百字（官方 server 的说明普遍很长），全展开会把详情弹窗
     * 撑成一面墙，用户反而找不到工具名。截断 + 展开把「扫一遍有哪些工具」和「细读某一个」
     * 分成两步。纯 CSS 行数裁剪（`-webkit-line-clamp`），不做字符截断 —— 展开时给的是原文，
     * 所以宿主的 `toolDescriptionMaxLength` 设置不影响这里（默认 0 = 不截断）。
     *
     * 按钮只按**真实溢出**显示：短的（哪怕字数不少、两行放得下）不给按钮 —— 字符数阈值
     * 会造出「点了没任何变化」的死按钮。收起态才量（展开后不裁剪，scrollHeight 不再代表
     * 被裁掉的高度）；没有 DOM（测试里的假 dispatcher）时 ref 为空，静默跳过。
     */
    function ToolDesc(props) {
      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var overState = react.useState(false)
      var overflow = overState[0]
      var setOverflow = overState[1]
      var ref = react.useRef(null)
      var text = String(props.text || '')
      react.useEffect(function () {
        if (open) return
        var el = ref.current
        if (!el || typeof el.scrollHeight !== "number" || typeof el.clientHeight !== "number") return
        setOverflow(el.scrollHeight > el.clientHeight + 1)
      }, [text, open])
      return h("div", { className: "dsm-tool-desc-wrap" },
        h("div", { ref: ref, className: "dsm-tool-desc" + (open ? "" : " dsm-tool-desc-clamp") }, text),
        overflow ? h("button", {
          type: "button",
          className: "dsm-tool-desc-toggle",
          onClick: function () { setOpen(!open) },
        }, open ? props.collapseLabel : props.expandLabel) : null)
    }

    function Modal(props) { var ref = react.useRef(null); react.useEffect(function () { if (ref.current) ref.current.focus(); }, []); var body = props.list ? h("div", { className: "dsm-modal-body" }, props.children) : props.children; return h("div", { className: "dsm-mask", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose(); } }, h("div", { ref: ref, tabIndex: -1, className: "dsm-modal" + (props.wide ? " dsm-modal-wide" : "") + (props.className ? " " + props.className : ""), role: "dialog", "aria-modal": "true", onKeyDown: function (e) { if (!handleModalEscape(e, props.onClose)) trapModalFocus(e.currentTarget, e); } }, h("div", { className: "dsm-modal-head" }, h("h3", { className: "dsm-modal-title" }, props.title), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: props.onClose }, props.closeLabel)), body)); }
    /**
     * 全插件唯一的「操作结果」呈现方式：成功 = 右下角浮层（固定定位，不改变页面高度），
     * 警告 / 错误 = 文档流内横幅（需要用户处理，常驻到下一次操作）。所有页面共用，
     * 避免同一件事在不同页看起来不一样、也让成功反馈不再把下方内容顶来顶去。
     */
    function Notice(props) {
      var text = props && props.text
      if (!text) return null
      if (props.kind === "ok") return h("div", { className: "dsm-toast", role: "status", "aria-live": "polite" }, text)
      return h("div", { className: "dsm-feedback" + (props.kind === "warn" ? " dsm-warning" : " dsm-error"), role: "alert" }, text)
    }
    /* ── 勾选列表原语（场景档案编辑器 / 人设工具选择器 / 任何「多选一组条目」的地方共用）────
       原先这套排版只在 ScenesPage 内部，人设的工具选择器要么复制一份、要么写成裸 input；
       现在提到模块作用域，页面之间才可能真正长得一样。 */
    /** 段卡片：标题栏 + 固定高度滚动体 + 脚注（高度不随内容增减变化，弹窗不跳）。 */
    function seg(props) {
      return h('div', { className: 'dsm-seg' },
        h('div', { className: 'dsm-seg-head' },
          h('span', { className: 'dsm-seg-title' }, props.title),
          h('span', { className: 'dsm-seg-count' }, props.count),
          h('div', { className: 'dsm-seg-actions' }, props.actions)),
        props.body,
        props.foot || null)
    }
    /**
     * 通用回收站弹窗：一行一个条目（名字 + 删除时间），右侧「恢复 / 永久删除」。
     *
     * 子智能体 / 场景 / 提示词预设三处共用；永久删除就在本弹窗里就地二次确认，
     * 不再叠一层弹窗。恢复失败的原因显示在弹窗顶部 —— 不静默（同名已存在时必须说清）。
     */
    function TrashModal(props) {
      const t = props.t
      const c = React.useState(null)
      const confirmId = c[0], setConfirmId = c[1]
      const entries = props.entries || []
      const row = function (item) {
        const confirming = confirmId === item.id
        const actions = confirming
          ? [
              React.createElement('span', { className: 'dsm-note', key: 'ask' }, t('trash.purge.confirm')),
              React.createElement('button', { key: 'yes', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy, onClick: function () { setConfirmId(null); props.onPurge(item) } }, t('btn.delete.forever')),
              React.createElement('button', { key: 'no', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy, onClick: function () { setConfirmId(null) } }, t('btn.cancel')),
            ]
          : [
              React.createElement('button', { key: 'restore', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy || props.locked === true, onClick: function () { props.onRestore(item) } }, t('btn.restore')),
              React.createElement('button', { key: 'purge', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy || props.locked === true, onClick: function () { setConfirmId(item.id) } }, t('btn.delete.forever')),
            ]
        return React.createElement('div', { className: 'dsm-trash-item', key: item.id },
          React.createElement('div', { className: 'dsm-trash-main' },
            React.createElement('div', { className: 'dsm-name' }, item.name),
            React.createElement('div', { className: 'dsm-note' }, t('trash.deletedAt', {
              time: item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '—',
            }))),
          actions)
      }
      const body = props.loading
        ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
        : entries.length === 0
          ? React.createElement('div', { className: 'dsm-empty' }, t('trash.empty'))
          : entries.map(row)
      // 列表类弹窗：宽高都固定（`.dsm-modal-list`），滚动只发生在 Modal 的 body 这一层 ——
      // 条目数变化时弹窗不跳，也不会出现「弹窗滚 + 组内滚」的嵌套滚动条。
      return React.createElement(Modal, {
        key: 'trash-modal',
        title: props.title,
        closeLabel: t('btn.close'),
        list: true,
        className: 'dsm-modal-list',
        onClose: props.onClose,
      },
        props.error ? React.createElement(Notice, { kind: 'err', text: props.error }) : null,
        React.createElement('div', { className: 'dsm-trash-group' },
          React.createElement('div', { className: 'dsm-trash-group-head' },
            React.createElement('div', { className: 'dsm-trash-group-head-row' },
              React.createElement('span', { className: 'dsm-trash-group-title' }, props.groupTitle),
              React.createElement('span', { className: 'dsm-count' }, t('trash.items.count', { count: entries.length }))),
            // 后果说明进组头（sticky 跟着滚）：这组删的是记录还是文件，一眼可辨。
            props.groupSub ? React.createElement('p', { className: 'dsm-trash-group-sub' }, props.groupSub) : null),
          React.createElement('div', { className: 'dsm-trash-group-body' }, body)))
    }

    /** 勾选行：复选框 + 名称/说明 + 右侧指标 + 可选行内动作。 */
    function pickRow(props) {
      return h('label', { key: props.key, className: 'dsm-pick' },
        h('input', { type: 'checkbox', checked: props.checked === true, disabled: props.disabled === true, onChange: props.onChange }),
        h('span', { className: 'dsm-pick-main' },
          h('span', { className: 'dsm-pick-name' }, props.name),
          // 行内传进来的 desc 可能已被调用方截断，全文走 descTitle（悬浮可见）。
          props.desc ? h('span', { className: 'dsm-pick-desc', title: props.descTitle || undefined }, props.desc) : null),
        props.meta ? h('span', { className: 'dsm-pick-meta' }, props.meta) : null,
        props.actions ? h('span', { className: 'dsm-pick-actions' }, props.actions) : null)
    }
    /** 段体顶部的筛选行（条目多的段用；勾选状态不受筛选影响）。 */
    function segFilter(value, onChange, placeholder) {
      return h('div', { className: 'dsm-seg-filter' },
        h('input', { className: 'dsm-control', value: value || '', placeholder: placeholder, onChange: function (e) { onChange(e.target.value) } }))
    }
    /** 分组小标题（长列表里给用户地标，避免「一屏看不出层次」）。 */
    function segGroup(label) {
      return h('div', { className: 'dsm-seg-group' },
        h('span', null, label),
        h('span', { className: 'dsm-seg-group-line' }))
    }
    /**
     * 「全选 ↔ 取消全选」二合一按钮的标签对 —— fixedLabelPair 的语义化别名（同一套定宽机制）。
     *
     * 两种文案宽度不同（中文「全选」2 字 vs「取消全选」4 字；英文 Select all vs
     * Deselect all 差得更多），只渲染当前那一份的话，按钮宽度会随点击变来变去 ——
     * 用户实测「点了『全选』变成『取消全选』，整颗按钮换到第二行」。
     */
    function bulkPair(label, other) {
      return fixedLabelPair(label, other)
    }
    /** 段头公共动作：全选 / 清空 / 移除段（未定义时改为「添加」）。 */
    /**
     * 段头动作。**批量动作合二为一**（D11）：同一时刻只有一个方向是合理的 ——
     * 还有没勾的 → 「全选」；全勾了 → 「全不选」。并列两个必然有一个是废话。
     * 未定义的可选段只给「添加」；「移除段」不属于全选族，保留。
     */
    function segActions(props) {
      if (!props.defined) return [h('button', { key: 'add', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy, onClick: props.onAdd }, props.addLabel)]
      var out = [h('button', { key: 'all', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: props.busy, onClick: props.allChecked ? props.onClear : props.onAll }, bulkPair(props.allChecked ? props.clearLabel : props.selectAllLabel, props.allChecked ? props.selectAllLabel : props.clearLabel))]
      // 常驻段（记忆，P5 单一真相源）没有「段定义」可移除 → 不传 onRemove 即不渲染。
      if (props.onRemove) out.push(h('button', { key: 'rm', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy, onClick: props.onRemove }, props.removeLabel))
      return out
    }
    /** 段脚注：段已定义但一项未勾 = 该域全部停用（必须显式提示，否则像没保存上）。 */
    function segFoot(defined, count, emptyLabel) {
      if (!defined || count > 0) return null
      return h('div', { className: 'dsm-seg-foot' }, emptyLabel)
    }
    /** 固定高度滚动体内的条目列表（空态居中提示）。 */
    function segList(nodes, emptyText) {
      if (!nodes.length) return h('div', { className: 'dsm-seg-body' }, h('div', { className: 'dsm-pick-empty' }, emptyText))
      return h('div', { className: 'dsm-seg-body' }, nodes)
    }

    // 通用导入弹窗（人设 / 记忆共用）：拖放或点选 .md / .zip → 已选计数 → 交由调用方走自己的写 op。
    // t 由调用方注入（各页的 t 是局部函数，不在模块作用域）；extra 用于注入「导入到场景」一类的额外字段。
    function ImportModal(props) {
      // 同时持有原始 File[] 与 base64 entries：前者给需要 `_dssmPath`（拖拽保留相对路径）
      // 或自己做校验的调用方（技能页），后者给只关心 `{name, data}` 的调用方。
      var st = react.useState([]); var picked = st[0], setPicked = st[1]
      var es = react.useState([]); var entries = es[0], setEntries = es[1]
      var ref = react.useRef(null)
      var t = props.t
      function add(list) {
        var next = Array.prototype.slice.call(list || [])
        if (!next.length) return
        Promise.all(next.map(function (f) { return f.arrayBuffer().then(function (buf) { return { name: uploadFilePath(f), data: bytesToBase64(buf) } }) }))
          .then(function (added) {
            setPicked(function (prev) { return prev.concat(next) })
            setEntries(function (prev) { return prev.concat(added) })
          })
          .catch(function () {})
      }
      function dropAt(index) {
        setPicked(function (prev) { return prev.filter(function (_, j) { return j !== index }) })
        setEntries(function (prev) { return prev.filter(function (_, j) { return j !== index }) })
      }
      return h(Modal, { className: "dsm-modal-sm", title: props.title, closeLabel: t("btn.close"), onClose: props.onClose },
        h("div", { className: "dsm-form" },
          props.extra || null,
          h("div", {
            className: "dsm-dropzone",
            onClick: function () { if (ref.current) ref.current.click() },
            onDragOver: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.add("dsm-dropzone-active") },
            onDragLeave: function (e) { if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active") },
            onDrop: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active"); droppedFiles(e.dataTransfer).then(add) },
          },
            h("span", { className: "dsm-dropzone-title" }, t("upload.drop.title")),
            h("span", { className: "dsm-dropzone-copy" }, props.hint || t("upload.drop.copy"))),
          h("input", { ref: ref, type: "file", multiple: true, accept: props.accept || ".md,.zip", className: "dsm-hidden-input", onChange: function (e) { add(e.target.files); e.target.value = "" } }),
          // 已选文件：一行一个（名字 + 大小 + 移除），与技能页同一形态。
          picked.length ? h("div", null, picked.map(function (f, i) {
            return h("div", { key: i, className: "dsm-file", title: f.name },
              h("span", { className: "dsm-file-kind", "aria-hidden": "true" }, "FILE"),
              h("span", { className: "dsm-file-name" }, f.name),
              h("span", { className: "dsm-file-meta" }, fmtBytes(f.size)),
              h("button", { type: "button", className: "dsm-file-remove", disabled: props.busy, "aria-label": t("upload.remove") + " " + f.name, onClick: function () { dropAt(i) } }, "×"))
          })) : null,
          props.result ? h("div", { className: "dsm-feedback" + (props.result.warning ? " dsm-warning" : props.result.ok ? "" : " dsm-error"), role: "alert" }, props.result.text) : null,
          // 文件要求清单（可选）：调用方按页传，结构上限制「这页需要什么格式」的表达。
          props.requirements && props.requirements.length ? h("div", { className: "dsm-upload-requirements" },
            h("div", { className: "dsm-label" }, t("upload.requirements")),
            h("ul", null, props.requirements.map(function (r, i) { return h("li", { key: i }, r) }))) : null),
        h("div", { className: "dsm-modal-actions" },
          picked.length ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: props.busy, onClick: function () { setPicked([]); setEntries([]) } }, t("import.clear")) : null,
          h("button", { type: "button", className: "dsm-btn", disabled: props.busy || !picked.length, onClick: function () { props.onSubmit(entries, picked) } }, props.busy ? t("upload.importing") : t("import.submit"))))
    }

    /**
     * 通用导出弹窗（D14）：选中项 + 目标目录 → 调 `bundle-export` 打包成 zip。
     * 技能 / 子智能体 / 提示词 / 记忆四页共用，避免各写一份。
     * 只读源文件、只往用户指定目录写 zip，不改动任何插件数据。
     */
    function ExportModal(props) {
      var t = props.t
      var ds = react.useState(props.outDir || ''); var outDir = ds[0], setOutDir = ds[1]
      var ps = react.useState(false); var picking = ps[0], setPicking = ps[1]
      var items = props.items || []
      // 默认**不勾选**：导出是"把东西拿出去"，一键全选最容易让人把不该带走的也带走。
      var ss = react.useState([]); var picked = ss[0], setPicked = ss[1]
      var cs = react.useState({}); var collapsed = cs[0], setCollapsed = cs[1]
      function toggle(key) {
        setPicked(function (prev) { return prev.indexOf(key) >= 0 ? prev.filter(function (k) { return k !== key }) : prev.concat([key]) })
      }
      /** 分组：`it.group` 为空 = 不分组（组头不渲染）。组内、组间都保持传入顺序。 */
      var groups = [], byGroup = {}
      items.forEach(function (it) {
        var g = String(it.group == null ? '' : it.group)
        if (!byGroup[g]) { byGroup[g] = []; groups.push({ name: g, rows: byGroup[g] }) }
        byGroup[g].push(it)
      })
      var allKeys = items.map(function (i) { return i.key })
      var allPicked = allKeys.length > 0 && picked.length === allKeys.length
      return h(Modal, { className: 'dsm-modal-list dsm-export-modal', list: true, title: props.title, closeLabel: t('btn.close'), onClose: props.onClose },
        h('div', { className: 'dsm-form dsm-export-form' },
          h('p', { className: 'dsm-help' }, t('export.hint')),
          h('div', { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, t('export.outDir')),
            h('div', { className: 'dsm-dir-row' },
              h('input', { className: 'dsm-control', type: 'text', value: outDir, placeholder: t('export.outDir.placeholder'), onChange: function (e) { setOutDir(e.target.value) } }),
              h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: props.busy, onClick: function () { setPicking(true) } }, t('btn.openDir')))),
          // 条目列表：始终渲染（哪怕只有一条）—— 默认不勾选意味着「不列出来就没得勾」。
          items.length ? h('div', { className: 'dsm-pick-list' }, groups.map(function (g) {
            var open = collapsed[g.name] !== true
            return h('div', { key: 'g:' + g.name, className: 'dsm-pick-group' },
              g.name ? h('button', {
                type: 'button', className: 'dsm-pick-group-head', 'aria-expanded': open ? 'true' : 'false',
                onClick: function () { setCollapsed(function (prev) { var next = Object.assign({}, prev); next[g.name] = open; return next }) },
              },
                h('span', { className: 'dsm-pick-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                h('span', { className: 'dsm-pick-group-name', title: g.name }, g.name),
                h('span', { className: 'dsm-pick-group-count' }, t('export.group.count', { count: g.rows.length }))) : null,
              open ? g.rows.map(function (it) {
                return pickRow({ key: it.key, checked: picked.indexOf(it.key) >= 0, name: it.name, desc: it.desc, descTitle: it.descTitle || it.desc, onChange: function () { toggle(it.key) } })
              }) : null)
          })) : h('div', { className: 'dsm-pick-empty' }, t('export.empty')),
          props.result ? h('div', { className: 'dsm-feedback' + (props.result.ok ? '' : ' dsm-error'), role: 'alert' }, props.result.text) : null),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: props.busy || !items.length, onClick: function () { setPicked(allPicked ? [] : allKeys.slice()) } }, bulkPair(allPicked ? t('export.pickNone') : t('export.pickAll'), allPicked ? t('export.pickAll') : t('export.pickNone'))),
          h('button', { type: 'button', className: 'dsm-btn', disabled: props.busy || !picked.length || !outDir.trim(), onClick: function () { props.onSubmit(picked, outDir.trim()) } }, props.busy ? t('export.busy') : t('export.submit'))),
        picking ? h(DirPickerModal, { key: 'dir', title: t('export.pickDir'), initial: outDir, closeLabel: t('btn.close'), onClose: function () { setPicking(false) }, onPick: function (p) { setOutDir(p); setPicking(false) } }) : null)
    }

    /**
     * 导出结果文案（四个导出页共用）：成功条数 + 被跳过的项。
     *
     * 服务端把读不到的项记进 `missing` 而不是整体失败（部分成功也有价值），但**必须说出来**
     * —— 只报「已导出 N 个文件」会把静默丢项显示成完全成功（bundle 型路径曾经就是这样丢的）。
     */
    function exportResultText(t, res) {
      var text = t('export.done', { count: res.written, path: res.zipPath })
      var skipped = (res && res.missing) || []
      if (skipped.length) text += t('export.missing', { count: skipped.length, names: skipped.join(', ') })
      return text
    }

    // 目录选择器：经 host 的 dir-list 逐级浏览目录树，选中后把绝对路径回填给调用方。
    // 标准浏览器不暴露所选文件夹的绝对路径（File.path 仅 Electron 可用），故不走
    // webkitdirectory，改由宿主端列目录 + 前端目录树完成「选择文件夹」。
    function DirPickerModal(props) {
      var stState = react.useState({ loading: true, error: null, current: '', parent: null, entries: [] })
      var st = stState[0], setSt = stState[1]
      var txState = react.useState(props.initial || '')
      var text = txState[0], setText = txState[1]
      function load(dir) {
        setSt({ loading: true, error: null, current: dir || '', parent: null, entries: [] })
        apiCall('dir-list', { dir: dir || '' }).then(function (res) {
          if (res && res.ok) setSt({ loading: false, error: null, current: res.current || '', parent: res.parent || null, entries: res.entries || [] })
          else setSt({ loading: false, error: (res && res.error) || t('dir.error.unreadable'), current: dir || '', parent: null, entries: [] })
        }).catch(function () {
          setSt({ loading: false, error: t('dir.error.unreadable'), current: dir || '', parent: null, entries: [] })
        })
      }
      react.useEffect(function () { load(props.initial || '') }, [])
      function jump() { var v = String(text || '').trim(); if (v) load(v) }
      function goUp() { if (!st.parent) return; setText(st.parent); load(st.parent) }
      function enter(path) { setText(path); load(path) }
      function pick() { var target = String(st.current || '').trim() || String(text || '').trim(); if (target && props.onPick) props.onPick(target) }
      return h(Modal, { title: props.title || t('dir.title'), closeLabel: props.closeLabel || t('btn.close'), onClose: props.onClose },
        h("div", { className: "dsm-form" },
          h("label", { className: "dsm-field" },
            h("span", { className: "dsm-label" }, t('dir.currentPath')),
            h("div", { className: "dsm-dir-row" },
              h("input", { className: "dsm-control", value: text, placeholder: t('dir.pathPlaceholder'), onChange: function (e) { setText(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); jump(); } } }),
              h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !String(text || '').trim(), onClick: jump }, t('dir.jump')))),
          st.error ? h("div", { className: "dsm-feedback dsm-error", role: "alert" }, st.error) : null,
          h("div", { className: "dsm-dir-list" },
            st.loading ? h("div", { className: "dsm-empty" }, t('dir.loading'))
              : st.entries.length ? st.entries.map(function (e) { return h("button", { key: e.path, type: "button", className: "dsm-dir-item", title: e.path, onClick: function () { enter(e.path); } }, e.name); })
              : h("div", { className: "dsm-empty" }, t('dir.empty'))),
          h("div", { className: "dsm-modal-actions" },
            h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !st.parent, onClick: goUp }, t('dir.up')),
            h("button", { type: "button", className: "dsm-btn", disabled: st.loading || !(String(st.current || '').trim() || String(text || '').trim()), onClick: pick }, t('dir.pick')))))
    }

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
      var pickerOpenRef = react.useRef(false);
      var flipRef = react.useRef(null);
      useFlipReorder(flipRef);
      function refresh(silent) { if (!silent) setSnapshot({ loading: true, error: null, data: snapshot.data }); return callApi("/state").then(function (data) { setSnapshot({ loading: false, error: null, data: data }); return data; }).catch(function (error) { setSnapshot({ loading: false, error: translateError(t, error), data: snapshot.data }); }); }
      react.useEffect(function () { refresh(false); }, []);
      function post(path, body, successKey, successParams) { if (inflightRef.current) return Promise.reject({ error: "operation already in progress" }); inflightRef.current = true; setBusy(true); setResult(null); return callApi(path, { body: JSON.stringify(body || {}) }).then(function (data) { var warn = sceneSyncWarn(t, data); setResult({ ok: !warn, warning: !!warn, text: (successKey ? t(successKey, successParams || data || {}) : t("result.updated")) + (warn ? " " + warn : "") }); return refresh(true).then(function () { return data; }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); throw error; }).finally(function () { inflightRef.current = false; setBusy(false); }); }
      function openDetail(root, skill) { setBusy(true); setDetail(null); setModal("detail"); callApi("/detail", { body: JSON.stringify({ root: root.key, name: skill.name }) }).then(setDetail).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); setModal(null); }).finally(function () { setBusy(false); }); }
      function openSource() { if (!detail || !detail.path) return; setBusy(true); setResult(null); apiCall("skill-open", { path: detail.path }).then(function (res) { if (res && res.ok) setResult({ ok: true, text: t("result.opened", { path: detail.path }) }); else setResult({ ok: false, text: t("error.action", { error: translateError(t, res) }) }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); }); }
      function updateForm(key, value) { setForm(Object.assign({}, form, { [key]: value })); }
      // 自定义技能目录：添加 / 移除（走 skill-custom-* ops，成功后静默刷新）。
      function openCustomDir() {
        if (busy) return;
        setCustomForm(Object.assign({}, customForm, { picking: true }));
      }
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
      // 回收站「目录」的永久删除：把这条来源记录从插件里删掉（磁盘上的文件夹与文件不动，
      // 这也正是「移除来源」与「永久删除」的区别）。与「自定义目录」的移除是同一个 op ——
      // 只有自定义来源有记录可删，按约定发现的外部来源（agents/codex/claude）删不掉，
      // 所以界面上只对 root.custom === true 的行给这个按钮。
      function submitSourceForget(key, name) {
        setBusy(true); setResult(null);
        apiCall("skill-custom-remove", { key: key }).then(function (res) {
          setModal("trash");
          if (res && res.ok) { setResult({ ok: true, text: t("result.sourceForgotten", { name: name }) }); return refresh(true); }
          setResult({ ok: false, text: t("error.action", { error: translateError(t, res) }) });
        }).catch(function (error) { setModal("trash"); setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      function submitCreate() { post("/create", form, null).then(function (data) { setModal(null); setForm({ root: "dsh", name: "", description: "", body: "" }); setResult({ ok: true, text: t("result.created", { name: data.name }) }); }).catch(function () {}); }
      function selectUploadFiles(files) { pickerOpenRef.current = false; var selected = inspectUploadSelection(files); if (!selected) return; if (selected.error) { setUpload(null); setResult({ ok: false, text: translateError(t, selected.error) }); return; } setUpload(selected); setResult(null); }
      /** D14：导出条目 = 按**来源文件夹**分组，组内列出该文件夹里的全部技能（含同名被遮蔽的）。 */
      function exportItems() {
        var out = [];
        for (var i = 0; i < allRoots.length; i++) {
          var root = allRoots[i], list = root.skills || [];
          var group = rootDisplayName(t, root);
          for (var j = 0; j < list.length; j++) {
            var sk = list[j];
            // key 用**条目名**（文件 / 目录名），不是 frontmatter 里的展示名：服务端按它定位源文件，
            // 用 declaredName 会在「文件名 ≠ 声明名」时找不到文件（静默丢项）。
            var nm = String(sk.name || "");
            if (!nm) continue;
            out.push({ key: String(root.key) + "/" + nm, name: String(sk.declaredName || nm), desc: sk.description || "", group: group });
          }
        }
        return out;
      }
      function doExport(names, outDir) {
        setBusy(true); setResult(null);
        apiCall("bundle-export", { kind: "skills", names: names, outDir: outDir }).then(function (res) {
          setBusy(false);
          if (res && res.ok) setResult({ ok: true, text: exportResultText(t, res) });
          else setResult({ ok: false, text: translateError(t, res) });
        }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }); });
      }
      function submitImport(selection) { var sel = selection || upload; if (!sel) return; buildUploadPayload(sel).then(function (payload) { return post("/upload", payload, null); }).then(function (data) { var summary = summarizeImportResult(t, data); setResult({ ok: summary.ok, warning: summary.warning, text: summary.text }); if (summary.imported) { setModal(null); setUpload(null); } }).catch(function () {}); }
      var anyLocked = !!(snapshot.data && snapshot.data.anyLocked === true);
      // 场景内开关由档案定义：技能开关 / 来源开关 / 首选都置灰（用户裁定）。
      var sceneName = (snapshot.data && snapshot.data.activeScene) || null;
      var data = snapshot.data || { roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }, allRoots = data.roots || [], roots = visibleSkillRoots(allRoots), removedRoots = removedSkillRoots(allRoots), activeSource = roots.some(function (root) { return root.key === source; }) ? source : "";
      var createRoots = allRoots.filter(function (root) { return root.mutable === true; }), createOptions = createRoots.map(function (root) { return { value: root.key, label: rootDisplayName(t, root) }; }); if (!createOptions.length) createOptions.push({ value: "hub", label: t("root.hub") });
      // 新建技能的默认落点：hub（`tool-management/skills/`）。
      // 用户在技能页筛选了某个来源时，优先用那个来源；两者都不可用时退回 dsh。
      function defaultCreateRoot() {
        if (createRoots.some(function (root) { return root.key === activeSource; })) return activeSource;
        if (createRoots.some(function (root) { return root.key === "hub"; })) return "hub";
        return "dsh";
      }
      function openCreate() { setForm(Object.assign({}, form, { root: defaultCreateRoot() })); setModal("create"); }
      // 项目作用域的来源不一定带 projectName / projectRoot（hub「导入技能」就没有），
      // 旧实现直接拼字符串会把字面量 "undefined" 显示到回收站里。
      function trashRootLabel(item) {
        var root = (item && item.root) || {};
        // 用户级可写来源不止 dsh（hub 也能删，而且是「导入技能」页删除的主战场）：
        // 走和来源卡片同一套显示名解析，别把 hub 的条目显示成「DSH 技能」。
        if (root.scope !== "project") return rootDisplayName(t, root) || t("root.dsh");
        var owner = root.projectName || root.projectRoot || "";
        if (!owner) {
          var byKey = root.localeKey || root.key;
          owner = (byKey ? translateOrFallback(t, "root." + byKey, "") : "") || root.label || "";
        }
        return owner ? t("root.projectDsh") + " · " + owner : t("root.projectDsh");
      }
      var options = [{ value: "", label: t("filter.all") }].concat(roots.map(function (root) { return { value: root.key, label: t("filter.option", { name: rootDisplayName(t, root), count: root.count == null ? root.skills.length : root.count }) }; }));

      // 同名技能：默认按来源优先级取一个生效，其余显示为「被覆盖」。
      // 「启用这个」= 把这个来源设为同名首选 + 启用它（只写本地策略，不动任何源文件）。
      function activateShadowed(root, skill) {
        // 来源整体停用时，切首选 + 单点启用都不会真的生效：先如实说明，别给「已改为生效」的假回执。
        if (root.enabled === false) {
          setResult({ ok: false, text: t("error.root.disabled", { name: rootDisplayName(t, root) }) });
          return;
        }
        post("/prefer", { root: root.key, name: skill.name }, null)
          .then(function () { return post("/enable", { root: root.key, name: skill.name }, null); })
          .then(function () { setResult({ ok: true, text: t("result.preferred", { name: skill.declaredName || skill.name, source: rootDisplayName(t, root) }) }); })
          .catch(function () {});
      }
      function clearPreferred(root, skill) {
        post("/unprefer", { root: root.key, name: skill.name }, null)
          .then(function () { setResult({ ok: true, text: t("result.unpreferred", { name: skill.declaredName || skill.name }) }); })
          .catch(function () {});
      }
      function renderSkill(root, skill) {
        var enabled = isSkillEnabled(skill), key = skill.shadowedBy ? "status.shadowed" : skill.loadable === false ? "status.invalid" : enabled ? "status.enabled" : "status.disabled", cls = skill.shadowedBy ? "dsm-shadowed" : enabled ? "dsm-enabled" : "dsm-disabled";
        var canToggle = root.toggleable !== false && skill.loadable !== false;
        return h("div", { key: skill.name, className: "dsm-row", "data-flip-key": root.key + "/" + skill.name, "data-flip-on": enabled ? "1" : "0" }, h("div", { className: "dsm-main" }, h("div", { className: "dsm-name" }, skill.declaredName || skill.name), h("div", { className: "dsm-note" }, skill.description || t("note.missing")), skill.shadowedBy ? h("div", { className: "dsm-rule-hint" }, t("status.shadowed.hint", { name: skill.shadowedBy.name })) : null), h("div", { className: "dsm-tags" }, h("span", { className: "dsm-tag" }, rootDisplayName(t, root)), skill.preferred === true ? h("span", { className: "dsm-tag dsm-tag-on" }, t("status.preferred")) : null, !root.mutable ? h("span", { className: "dsm-tag" }, t("status.readonly")) : null, root.mutable && !root.deletable ? h("span", { className: "dsm-tag", title: t("status.notDeletable.hint") }, t("status.notDeletable")) : null), h("div", { className: "dsm-status " + cls }, t(key)), h("div", { className: "dsm-row-actions" }, canToggle && skill.shadowedBy ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.activate.title"), onClick: function () { activateShadowed(root, skill); } }, t("btn.activate")) : null, canToggle && !skill.shadowedBy ? h(Switch, { on: enabled, disabled: busy || root.enabled === false || anyLocked, label: t("skill.toggle") + " " + skill.name, onClick: function () { post(enabled ? "/disable" : "/enable", { root: root.key, name: skill.name }); } }) : null, skill.preferred === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.unprefer.title"), onClick: function () { clearPreferred(root, skill); } }, t("btn.unprefer")) : null, h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openDetail(root, skill); } }, t("btn.detail")), root.deletable === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { setModal({ type: "trash-confirm", root: root.key, name: skill.name }); } }, t("btn.trash")) : null));
      }
      function renderRoot(root) {
        if (activeSource && activeSource !== root.key) return null;
        var displayName = rootDisplayName(t, root), filtered = root.skills.filter(function (skill) { return matchSkillQuery(Object.assign({}, skill, { rootKey: root.key, rootLabel: displayName }), query); }); if (query && !filtered.length) return null; var open = !!expanded[root.key] || !!query;
        var rootCount = root.count == null ? root.skills.length : root.count;
        return h("section", { key: root.key, className: "dsm-source" }, h("div", { className: "dsm-source-head" }, h("button", { type: "button", className: "dsm-source-head-main", "aria-expanded": open, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: !open })); } }, h("span", { className: "dsm-source-title", title: displayName }, displayName), h("span", { className: "dsm-count" }, t(countKey("summary.group", rootCount), { count: rootCount })), h("span", { className: "dsm-tag " + (root.scope === "project" ? "dsm-tag-on" : root.defaultSource === true ? "" : root.enabled ? "dsm-tag-on" : "dsm-tag-off") }, root.scope === "project" ? t("status.project") : root.defaultSource === true ? t("status.manageable") : t(root.enabled ? "status.source.on" : "status.source.off")), root.scope === "project" ? h("span", { className: "dsm-tag" }, t("status.rank", { rank: root.rank })) : null, h("span", { className: "dsm-path", title: root.path }, root.path)), (function () {
          // 目录级「全选 / 取消全选」（用户裁定 2026-09-17）：只作用于**这个目录下当前
          // 可见且可切换**的技能 —— 与页头那颗同一套目标集逻辑（bulkTargets 传 rootKey），
          // 同名技能只算生效的那一个（被覆盖的副本跳过）。
          // 默认来源（可管理 / DSH 技能）没有来源开关，这颗按钮就独占右侧位置。
          var bulk = bulkState(root.key);
          var showSwitch = root.scope !== "project" && root.defaultSource !== true && root.toggleable !== false;
          var acts = [];
          // 点这颗按钮**顺带把卡片展开**（用户裁定 2026-09-17）：批量开关的结果就在下面这几行里，
          // 卡片收着的话点完只剩按钮文案从「全选」变成「取消全选」，到底改了哪几个技能看不见。
          // 只展开、不收起 —— 两个方向（全选 / 取消全选）都要能看见结果，收起是点卡片头的事。
          if (bulk.targets.length) acts.push(h("button", { key: "all", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-bulk", disabled: busy || anyLocked, title: t("source.bulk.title"), onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: true })); submitBulk(bulk.targets, !bulk.on); } }, bulkPair(bulk.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulk.on ? t("bulk.selectAll") : t("bulk.unselectAll"))));
          if (showSwitch) {
            // 「移除来源」只留图标（用户裁定 2026-09-17）：它是低频的破坏性操作，却和「全选」
            // 并列、还带红框描边 —— 于是整行的视觉重心落在它身上，四字宽度也占地方。
            // 图标按钮必须自带 title + aria-label（没有可见文字）；点击照旧弹确认弹窗，
            // 那里仍是带文字的红色「移除来源」，破坏性操作的说明没有丢。
            if (root.removable === true) acts.push(h("button", { key: "rm", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger dsm-btn-icon", disabled: busy, title: t("btn.source.remove.title"), "aria-label": t("btn.source.remove.title"), onClick: function () { setModal({ type: "source-remove-confirm", key: root.key, name: displayName }); } }, h(TrashIcon, { size: 14 })));
            // 开关来源时**顺带把卡片展开**（用户裁定 2026-09-17），与旁边那颗「全选」同口径：
            // 启停的结果就是下面这些技能行（开启 = 整目录可用了，关闭 = 逐行变停用），卡片收着
            // 的话点完只剩标签从「已停用」变「已启用」，目录里到底有什么、哪些真的可用了看不见。
            // 只展开、不收起 —— 两个方向都要能看见结果，收起仍然是点卡片头那一行的事。
            acts.push(h(Switch, { key: "sw", on: root.enabled, disabled: busy || anyLocked, label: t("source.toggle") + " " + displayName, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: true })); post(root.enabled ? "/source-disable" : "/source-enable", { root: root.key }); } }));
          }
          return acts.length ? h("span", { className: "dsm-source-actions" }, acts) : null;
        })()), open ? h("div", { className: "dsm-source-body" }, filtered.length ? h(react.Fragment, null, h("div", { className: "dsm-table-head" }, h("span", null, t("table.skill")), h("span", null, t("filter.source")), h("span", null, t("table.status")), h("span", null, "")), enabledFirst(filtered, function (skill) { return isSkillEnabled(skill); }).map(function (skill) { return renderSkill(root, skill); })) : h("div", { className: "dsm-empty" }, query ? t("empty.search") : t("empty.source"))) : null);
      }

      var summary = data.summary || { total: 0, enabled: 0, disabled: 0, issues: 0 };
      /**
       * 批量启停的目标集 = 当前**可见**（搜索 + 来源筛选命中）且**可切换**的技能。
       * 条件与单条 Switch 逐字一致（来源可切换、来源没被停用、技能可加载、不是被覆盖的副本），
       * 否则会出现「全选说 12 个、实际只改了 9 个」的假回执。
       *
       * 不传 rootKey → 页头那颗按钮的作用集（全部可见来源）；传 rootKey → 某个目录卡片上
       * 那颗按钮的作用集（只看这一个目录）。同名技能只算**生效的那一个**（被覆盖的副本
       * `shadowedBy` 跳过）——这正是「全选后同名技能只有被启用的那个被勾」的由来。
       */
      function bulkTargets(rootKey) {
        var out = [];
        for (var i = 0; i < roots.length; i++) {
          var root = roots[i];
          if (rootKey && root.key !== rootKey) continue;
          if (activeSource && activeSource !== root.key) continue;
          if (root.toggleable === false || root.enabled === false) continue;
          var list = root.skills || [];
          var rootLabel = rootDisplayName(t, root);
          for (var j = 0; j < list.length; j++) {
            var sk = list[j];
            if (sk.loadable === false || sk.shadowedBy) continue;
            if (!matchSkillQuery(Object.assign({}, sk, { rootKey: root.key, rootLabel: rootLabel }), query)) continue;
            out.push({ root: root.key, name: sk.name, on: isSkillEnabled(sk) });
          }
        }
        return out;
      }
      /** 一组批量目标 + 是否已全开（二合一按钮的两个入参）。 */
      function bulkState(rootKey) {
        var targets = bulkTargets(rootKey);
        return { targets: targets, on: targets.length > 0 && targets.every(function (x) { return x.on; }) };
      }
      /** 批量启停：主要看「当前是不是全开」，是就发停用，否则发启用（二合一按钮的语义）。 */
      function submitBulk(items, enabled) {
        if (!items || !items.length) return;
        setBusy(true); setResult(null);
        apiCall("skill-set-all", {
          items: items.map(function (x) { return { root: x.root, name: x.name }; }),
          enabled: enabled,
        }).then(function (res) {
          if (res && res.ok) {
            var payload = (res && res.data) || {};
            var failed = (payload.failed || []).length;
            // 场景内批量开关同样会同步写档案；没跟上就说出来（详见 sceneSyncWarn）。
            var syncWarn = sceneSyncWarn(t, res);
            setResult({
              ok: failed === 0 && !syncWarn,
              warning: failed > 0 || !!syncWarn,
              text: t("bulk.done.skills", {
                action: t(enabled ? "bulk.enabled" : "bulk.disabled"),
                count: payload.changed == null ? items.length : payload.changed,
                failed: failed,
              }) + (syncWarn ? " " + syncWarn : ""),
            });
            refresh(true);
          } else setResult({ ok: false, text: translateError(t, res) });
        }).catch(function (e) { setResult({ ok: false, text: String((e && e.message) || e) }); }).finally(function () { setBusy(false); });
      }
      var bulkAll = bulkState();
      var content = [h("style", { key: "css" }, CSS), h("div", { key: "head", className: "dsm-head" }, h("div", { className: "dsm-title-block" }, h("div", { className: "dsm-title-row" }, h("h2", { className: "dsm-title" }, t("title"))), h("p", { className: "dsm-desc" }, t("desc"))), h("div", { className: "dsm-actions" }, refreshButton(t, busy || snapshot.loading, { className: "dsm-btn dsm-btn-secondary", disabled: busy || snapshot.loading, onClick: function () { refresh(false); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: anyLocked, onClick: openCreate }, t("btn.create")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: anyLocked, onClick: function () { setResult(null); setUpload(null); setModal("import"); } }, t("btn.import")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setModal("export"); } }, t("export.skills")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setCustomForm({ path: "", label: "" }); setModal("custom-add"); } }, t("btn.custom.add")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal("trash"); } }, t("trash.btn.open")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary dsm-btn-bulk", disabled: busy || anyLocked || !bulkAll.targets.length, title: t("bulk.head.title"), onClick: function () { submitBulk(bulkAll.targets, !bulkAll.on) } }, bulkPair(bulkAll.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulkAll.on ? t("bulk.selectAll") : t("bulk.unselectAll"))))), anyLocked ? h("div", { key: "lockbanner", className: "dsm-feedback dsm-warning", role: "status" }, t("lock.banner")) : null,
      sceneName ? h("div", { key: "scenebanner", className: "dsm-feedback dsm-warning", role: "status" }, t("scene.switch.banner", { scene: sceneName })) : null,
      h("div", { key: "summary", className: "dsm-summary" }, [[summary.total, "summary.total"], [summary.enabled, "summary.enabled"], [summary.issues, "summary.issues"]].map(function (item) { return h("div", { key: item[1], className: "dsm-stat" }, h("strong", null, item[0]), t(countKey(item[1], item[0]), { count: item[0] }).replace(String(item[0]), "")); })), h("div", { key: "filters", className: "dsm-filters" }, h("input", { className: "dsm-control dsm-search", value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function (e) { setQuery(e.target.value); } }), h("div", { className: "dsm-source-filter" }, h(SourceSelect, { value: activeSource, options: options, onChange: setSource }))), result && modal !== "import" ? h(Notice, { key: "result", kind: result.warning ? "warn" : result.ok ? "ok" : "err", text: result.text }) : null].concat((data.warnings || []).map(function (warning, index) { return h(Notice, { key: "warning-" + index, kind: "warn", text: translateError(t, warning) }); }), [snapshot.error ? h(Notice, { key: "error", kind: "err", text: snapshot.error }) : null, snapshot.loading && !snapshot.data ? h("div", { key: "loading", className: "dsm-empty" }, t("loading")) : h("div", { key: "sources", className: "dsm-sources", ref: flipRef }, roots.map(renderRoot))]);

      if (modal === "create") content.push(h(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.target")), h(SourceSelect, { value: form.root, options: createOptions, onChange: function (value) { updateForm("root", value); } })), [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function (field) { return h("label", { key: field[0], className: "dsm-field" }, h("span", { className: "dsm-label" }, t(field[1])), h("input", { className: "dsm-control", value: form[field[0]], placeholder: t(field[2]), onChange: function (e) { updateForm(field[0], e.target.value); } })); }), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.body")), h("textarea", { className: "dsm-control", value: form.body, placeholder: t("create.body.placeholder"), onChange: function (e) { updateForm("body", e.target.value); } })), h("p", { className: "dsm-help" }, t("create.chat.note"))), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy || !form.name.trim() || !form.description.trim() || !form.body.trim(), onClick: submitCreate }, t("btn.create.now")))));
      // D13：导入弹窗统一用共享 ImportModal（能力取三者并集：拖拽区 + 已选文件行 +
      // 文件要求清单 + 结果反馈）。技能页只保留自己的校验与提交逻辑。
      if (modal === "import") content.push(h(ImportModal, {
        key: "import", t: t, title: t("import.title"), accept: ".zip,.md",
        busy: busy, result: result,
        requirements: [t("upload.requirement.skill"), t("upload.requirement.frontmatter"), t("upload.requirement.copy")],
        onClose: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); },
        onSubmit: function (entries, files) {
          var selected = inspectUploadSelection(files);
          if (!selected) return;
          if (selected.error) { setResult({ ok: false, text: translateError(t, selected.error) }); return; }
          setUpload(selected);
          submitImport(selected);
        },
      }));
      if (modal === "detail") content.push(h(Modal, { key: "detail", wide: true, title: t("detail.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, detail ? h(react.Fragment, null, h("div", { className: "dsm-detail-path" }, detail.path), h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openSource }, t("btn.open.editor"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.diagnostics")), detail.diagnostics.length ? detail.diagnostics.map(function (item, index) { return h("div", { key: index, className: "dsm-diag" }, t(item.code, item.params || {})); }) : h("div", { className: "dsm-note" }, t("detail.noIssues"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.frontmatter")), renderFrontmatter(t, detail.frontmatter)), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.body")), h("pre", { className: "dsm-code" }, detail.body || ""))) : h("div", { className: "dsm-empty" }, t("loading"))));
      if (modal === "export") content.push(h(ExportModal, {
        key: "export", t: t, title: t("export.skills"),
        items: exportItems(), busy: busy, result: result,
        onClose: function () { setResult(null); setModal(null); },
        onSubmit: doExport,
      }));
      // 回收站分两部分：**目录**（被「移除来源」的目录，插件不再读取）与**技能**（移入
      // 回收站的技能）。两部分都给了「恢复」，永久删除在两边都指向"记录/文件真的没了"：
      // 目录那边只删插件里的来源记录（磁盘上的文件夹一个字节都不动），技能那边才删文件。
            if (modal === "trash") {
        // 技能回收站里是**两类后果不同**的东西，弹窗里上下两块（用户要求「弹窗里嵌两个小弹窗」）：
        //   上「不再读取的来源」——插件只是不再扫它，磁盘一个字节都不动（中性色，恢复读取 / 删除记录）；
        //   下「回收站里的技能」——文件真的被移走了，永久删除会真删；两块的「永久删除」按钮都是红色。
        // 两块各自滚动，**大弹窗自己不滚**；两块一直在（空的那块显示自己的空态），别让人以为它没了。
        // 卡片结构复用共享回收站的 .dsm-trash-group（组头 + 计数 + 后果说明 + 行列表），观感与其它页一致。
        var skillTrashRows = data.trash || []
        var removedSourceRows = removedRoots || []
        function trashPane(key, title, count, note, danger, rows, emptyText) {
          return h("div", { key: key, className: "dsm-trash-group" + (danger ? " dsm-trash-group-danger" : "") },
            h("div", { className: "dsm-trash-group-head" },
              h("div", { className: "dsm-trash-group-head-row" },
                h("span", { className: "dsm-trash-group-title" }, title),
                h("span", { className: "dsm-count" }, count)),
              h("p", { className: "dsm-trash-group-sub" }, note)),
            h("div", { className: "dsm-trash-pane-body" }, rows.length ? rows : h("div", { className: "dsm-empty" }, emptyText)))
        }
        content.push(h(Modal, { key: "trash-modal", title: t("trash.title"), closeLabel: t("btn.close"), list: true, className: "dsm-modal-list dsm-modal-trash-split", onClose: function () { setModal(null); } },
          h("div", { className: "dsm-trash-split" },
            trashPane("pane-dirs", t("trash.section.dirs"), t(countKey("trash.dirs.count", removedSourceRows.length), { count: removedSourceRows.length }), t("trash.section.dirs.sub"), false,
              removedSourceRows.map(function (root) {
                var name = rootDisplayName(t, root)
                return h("div", { key: root.key, className: "dsm-trash-item" },
                  h("div", { className: "dsm-trash-main" },
                    h("div", { className: "dsm-name" }, name),
                    h("div", { className: "dsm-note", title: root.path }, root.path)),
                  h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/source-restore", { root: root.key }, "result.sourceRestored", { name: name }); } }, t("btn.source.restore")),
                  root.custom === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "source-forget-confirm", key: root.key, name: name, path: root.path }); } }, t("btn.source.forget")) : null)
              }),
              t("trash.section.dirs.empty")),
            trashPane("pane-skills", t("trash.section.skills"), t(countKey("trash.count", skillTrashRows.length), { count: skillTrashRows.length }), t("trash.section.skills.sub"), false,
              skillTrashRows.map(function (item) {
                return h("div", { key: item.id, className: "dsm-trash-item" },
                  h("div", { className: "dsm-trash-main" },
                    h("div", { className: "dsm-name" }, item.name),
                    h("div", { className: "dsm-note" }, t("trash.deletedAt", { time: new Date(item.deletedAt).toLocaleString() }))),
                  h("button", { className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/trash-restore", { id: item.id }, "result.restored", { name: item.name }); } }, t("btn.restore")),
                  h("button", { className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "delete-confirm", id: item.id, name: item.name }); } }, t("btn.delete.forever")))
              }),
              t("trash.empty")))))
      }
      if (modal && modal.type === "source-forget-confirm") content.push(h(Modal, { key: "source-forget-confirm", title: t("confirm.source.forget.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.source.forget.desc", { name: modal.name })), h("p", { className: "dsm-help" }, t("confirm.source.forget.hint", { path: modal.path })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitSourceForget(modal.key, modal.name); } }, t("btn.delete.forever")))));
      if (modal && modal.type === "trash-confirm") content.push(h(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.trash.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy, onClick: function () { post("/delete", { root: modal.root, name: modal.name }, "result.trashed", { name: modal.name }).then(function () { setModal(null); }).catch(function () {}); } }, t("btn.trash")))));
      if (modal && modal.type === "delete-confirm") content.push(h(Modal, { key: "delete-confirm", title: t("confirm.delete.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.delete.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/trash-delete", { id: modal.id }, "result.deleted", { name: modal.name }).then(function () { setModal("trash"); }).catch(function () {}); } }, t("btn.delete.forever")))));
      if (modal === "custom-add") content.push(h(Modal, { key: "custom-add", title: t("custom.add.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.path")), h("div", { className: "dsm-dir-row" }, h("input", { className: "dsm-control", value: customForm.path, placeholder: t("custom.add.path.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { path: e.target.value })); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openCustomDir, title: t("custom.add.openDir.title") }, t("btn.openDir")))), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.label")), h("input", { className: "dsm-control", value: customForm.label, placeholder: t("custom.add.label.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { label: e.target.value })); } })), h("p", { className: "dsm-help" }, t("custom.add.help")), result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null), customForm.picking ? h(DirPickerModal, { key: "custom-dir-picker", title: t("custom.add.picker.title"), initial: String(customForm.path || ""), closeLabel: t("btn.close"), onClose: function () { setCustomForm(Object.assign({}, customForm, { picking: false })); }, onPick: function (path) { setCustomForm(Object.assign({}, customForm, { path: path, picking: false })); } }) : null, h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn", disabled: busy || !String(customForm.path || "").trim(), onClick: submitCustomAdd }, t("custom.add.submit")))));
      if (modal && modal.type === "source-remove-confirm") content.push(h(Modal, { key: "source-remove-confirm", title: t("confirm.source.remove.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.source.remove.desc", { name: modal.name })), h("p", { className: "dsm-help" }, t("confirm.source.remove.hint")), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/source-remove", { root: modal.key }, "result.sourceRemoved", { name: modal.name }).then(function () { setModal(null); }).catch(function () {}); } }, t("btn.source.remove")))));
      if (modal && modal.type === "custom-remove-confirm") content.push(h(Modal, { key: "custom-remove-confirm", title: t("confirm.custom.remove.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.custom.remove.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitCustomRemove(modal.key, modal.name); } }, t("btn.custom.remove")))));
      return h("section", { className: "dsm-section" }, content);
    }

        // NS / t 与 locale 绑定已提到 apply 开头（见上方「取词服务」段）：
        // 设置页的导航标题是**注册期**取值，晚绑定会让它在英文界面下永远是中文。
        // ---------- History 页（归档会话管理：恢复 / 永久删除 / 保留期）----------
        // 折叠自 dsh-archive-manager 的归档会话设置页，但客户端经本插件 HTTP API
        // 驱动（history-list / -archive / -unarchive / -delete / -retention-*），不依赖
        // ui-workspace 客户端 store 或 typert remote——会话标题由 host 端 best-effort 读取。
        function HistoryPage() {
          var state = React.useState({ loading: true, items: [], workspaces: {}, groups: [], retentionDays: 0, error: null })
          var data = state[0], setData = state[1]
          var modalState = React.useState(null)
          var modal = modalState[0], setModal = modalState[1]
          var searchState = React.useState('')
          var query = searchState[0], setQuery = searchState[1]
          var busyState = React.useState(false)
          var busy = busyState[0], setBusy = busyState[1]
          // 多选集合：勾选的 sessionId。最小 React 支持函数式初值（Set 惰性创建）。
          var selState = React.useState(function () { return new Set() })
          var selected = selState[0], setSelected = selState[1]
          // 导入对话弹窗：null = 关闭；{ busy, error, result, cwd } = 打开。
          var impState = React.useState(null)
          var imp = impState[0], setImp = impState[1]
          // 导出对话弹窗：null = 关闭；{ busy, error, result, outDir, format, wsFilter, selectedIds } = 打开。
          var expState = React.useState(null)
          var exp = expState[0], setExp = expState[1]
          // 分组卡片折叠状态：key → true（收起）。默认全部展开。
          var collState = React.useState({})
          var collapsed = collState[0], setCollapsed = collState[1]
          // 操作结果提示（成功/警告一句话），与 MCP 等页共用 Notice 组件。
          var noticeState = React.useState(null)
          var notice = noticeState[0], setNotice = noticeState[1]

          function refresh(silent) {
            // 手动刷新（含首次加载）要把按钮切到「刷新中…」——点完毫无反馈等于没点。
            // 页面内部那些「操作完顺手重读」的调用传 silent，免得按钮每次都闪一下。
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('history-list', {}).then(function (r) {
              if (r && r.ok) {
                var items = r.items || []
                setData({ loading: false, items: items, workspaces: r.workspaces || {}, groups: r.groups || [], retentionDays: r.retentionDays || 0, error: null })
                // 裁剪选中集合：已被外部恢复/删除的会话不再计入。
                setSelected(function (prev) {
                  var has = new Set(items.map(function (it) { return it.sessionId }))
                  var next = new Set()
                  prev.forEach(function (id) { if (has.has(id)) next.add(id) })
                  return next
                })
              } else setData({ loading: false, items: [], workspaces: {}, groups: [], retentionDays: 0, error: (r && r.error) || t('hist.err.load') })
            }).catch(function (e) {
              // 请求被拒 / 网络异常：必须把 loading 收回来，否则按钮会永远停在「刷新中…」
              // 且一直禁用（这一支原来根本没有 —— 失败时页面停在旧数据上，什么都没有说）。
              setData(function (prev) { return Object.assign({}, prev, { loading: false, error: String((e && e.message) || e) }) })
            })
          }
          React.useEffect(function () { refresh() }, [])

          function shortId(id) { var s = String(id || ''); return s.length > 12 ? s.slice(0, 8) + '…' + s.slice(-4) : s }

          var filtered = data.items
          if (query) {
            var q = query.toLowerCase()
            filtered = data.items.filter(function (it) {
              return (it.title && it.title.toLowerCase().indexOf(q) >= 0)
                || (it.sessionId && it.sessionId.toLowerCase().indexOf(q) >= 0)
                || (it.cwd && it.cwd.toLowerCase().indexOf(q) >= 0)
            })
          }

          // 按项目分组：宿主回传 groups（活登记 + 按会话目录重建的分组）时用组 id 归并；
          // 旧宿主只回 workspaces 时退回原来的扁平/工作区分组逻辑。
          var groupMeta = new Map()
          ;(data.groups || []).forEach(function (g) { if (g && g.id) groupMeta.set(g.id, g) })
          var grouped = groupMeta.size > 0
          var visibleIds = filtered.map(function (it) { return it.sessionId })
          var groups = []
          if (grouped) {
            var byKey = new Map()
            filtered.forEach(function (it) {
              var key = it.groupId || 'ungrouped'
              if (!byKey.has(key)) byKey.set(key, [])
              byKey.get(key).push(it)
            })
            byKey.forEach(function (items2, key) {
              var meta = groupMeta.get(key)
              var wid = key.indexOf('ws:') === 0 ? key.slice(3) : null
              var wsRec = wid ? data.workspaces[wid] : null
              var title = (meta && meta.title) || (wid ? ((wsRec && wsRec.title) || wid) : t('hist.ungrouped'))
              items2.sort(function (a, b) { return ((b.archivedAt || b.createdAt) || 0) - ((a.archivedAt || a.createdAt) || 0) })
              var maxAt = 0
              items2.forEach(function (it) { var at = (it.archivedAt || it.createdAt) || 0; if (at > maxAt) maxAt = at })
              groups.push({
                key: key, title: title, workspaceId: wid,
                path: (meta && meta.path) || (wsRec && wsRec.path),
                kind: meta ? meta.kind : null,
                registered: !!(meta && meta.registered),
                canRegister: !!(meta && meta.canRegister),
                dirMissing: !!(meta && meta.dirMissing),
                ungrouped: key === 'ungrouped',
                items: items2, maxAt: maxAt,
              })
            })
            // 组按组内最新时间戳降序；未分组固定最后。
            groups.sort(function (g1, g2) {
              if (g1.ungrouped) return 1
              if (g2.ungrouped) return -1
              return g2.maxAt - g1.maxAt
            })
          } else if (data.workspaces && Object.keys(data.workspaces).length) {
            grouped = true
            var byWs = new Map()
            filtered.forEach(function (it) {
              var wid = data.workspaces[it.workspaceId] ? it.workspaceId : null
              var key = wid ? ('ws:' + wid) : 'ungrouped'
              if (!byWs.has(key)) byWs.set(key, [])
              byWs.get(key).push(it)
            })
            byWs.forEach(function (items2, key) {
              var wid = key === 'ungrouped' ? null : key.slice(3)
              var wsRec = wid ? data.workspaces[wid] : null
              var title = wid ? ((wsRec && wsRec.title) || wid) : t('hist.ungrouped')
              items2.sort(function (a, b) { return ((b.archivedAt || b.createdAt) || 0) - ((a.archivedAt || a.createdAt) || 0) })
              var maxAt = 0
              items2.forEach(function (it) { var at = (it.archivedAt || it.createdAt) || 0; if (at > maxAt) maxAt = at })
              groups.push({ key: key, title: title, workspaceId: wid, path: wsRec && wsRec.path, kind: null, registered: false, canRegister: false, dirMissing: false, ungrouped: key === 'ungrouped', items: items2, maxAt: maxAt })
            })
            // 组按组内最新时间戳降序；未分组固定最后。
            groups.sort(function (g1, g2) {
              if (g1.ungrouped) return 1
              if (g2.ungrouped) return -1
              return g2.maxAt - g1.maxAt
            })
          } else {
            grouped = false
          }

          // 「全选」状态：当前过滤结果是否全部选中（按钮文案切换为「取消全选」）。
          var allVisible = filtered.length > 0 && visibleIds.every(function (id) { return selected.has(id) })

          function doUnarchive(sessionId) {
            setBusy(true)
            apiCall('history-unarchive', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setNotice(restoreNotice(r, 1)); refresh() } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.unarchive') })
            })
          }
          /**
           * 恢复归档的归属结果 → 一句话结论。宿主恢复只移出归档集合；登记被删过的情况下
           * 插件会顺带把工作区重新登记并把会话挂回（`ensureWorkspaceAccounting`），
           * 这属于写宿主状态，必须如实告诉用户；没有变化时返回 null（不打扰）。
           */
          function restoreNotice(res, count) {
            var ws = res && res.workspace
            if (!ws) return null
            var attached = (ws.attached || []).length
            var createdList = (ws.registered || []).filter(function (item) { return item.created })
            var skipped = ws.skipped || []
            var title = (ws.registered && ws.registered[0] && ws.registered[0].title) || ''
            if (skipped.length) {
              return { kind: 'warn', text: t('hist.restore.note.skip', { count: skipped.length, reason: String(skipped[0].reason || '') }) }
            }
            if (attached && createdList.length) {
              return { kind: 'ok', text: t('hist.restore.note.registered', { count: attached, title: (createdList[0] && createdList[0].title) || title }) }
            }
            if (attached) return { kind: 'ok', text: t('hist.restore.note.attached', { count: attached, title: title }) }
            return null
          }
          function doDelete(sessionId) {
            setBusy(true)
            apiCall('history-delete', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); refresh() } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.delete') })
            })
          }
          function setRetention(days) {
            apiCall('history-retention-set', { retentionDays: days }).then(function (r) {
              if (r && r.ok) setData(Object.assign({}, data, { retentionDays: days }))
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.retention') })
            })
          }

          // ---------- 多选 / 批量交互 ----------
          function toggleSelect(id) {
            setSelected(function (prev) {
              var next = new Set(prev)
              if (next.has(id)) next.delete(id); else next.add(id)
              return next
            })
          }
          function toggleGroup(ids) {
            setSelected(function (prev) {
              var next = new Set(prev)
              var all = ids.every(function (id) { return next.has(id) })
              ids.forEach(function (id) { if (all) next.delete(id); else next.add(id) })
              return next
            })
          }
          function toggleAllVisible(ids) {
            if (!ids.length) return
            setSelected(function (prev) {
              var next = new Set(prev)
              var all = ids.every(function (id) { return next.has(id) })
              ids.forEach(function (id) { if (all) next.delete(id); else next.add(id) })
              return next
            })
          }
          function doUnarchiveBatch() {
            var ids = Array.from(selected)
            if (!ids.length) return
            setBusy(true)
            apiCall('history-unarchive-batch', { target: { scope: 'sessions', sessionIds: ids } }).then(function (r) {
              setBusy(false)
              if (r && r.ok) {
                var gone = new Set(r.unarchivedSessionIds || [])
                setSelected(function (prev) { var next = new Set(prev); gone.forEach(function (id) { next.delete(id) }); return next })
                setNotice(restoreNotice(r, gone.size))
                refresh()
              } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.unarchive') })
            })
          }
          function doDeleteBatch() {
            var ids = Array.from(selected)
            if (!ids.length) return
            setBusy(true)
            apiCall('history-delete-batch', { target: { scope: 'sessions', sessionIds: ids } }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); setSelected(new Set()); refresh() }
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.delete') })
            })
          }
          // 重新登记工作区：写宿主状态（新增一条登记），因此只走确认弹窗，不静默执行。
          function doRegisterWorkspace(path) {
            if (busy) return
            setBusy(true)
            apiCall('history-workspace-register', { path: path }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal({ type: 'registered', workspace: r.workspace || {} }); refresh() }
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.register') })
            })
          }

          // ---------- 导入对话（从其他 Agent）----------
          function doImportFile(file) {
            if (!file || !imp) return
            var reader = new FileReader()
            reader.onload = function () {
              var snap = imp
              setImp(Object.assign({}, imp, { busy: true, error: null, result: null }))
              apiCall('history-import', {
                fileName: String(file.name || 'transcript.txt'),
                content: String(reader.result || ''),
                cwd: String(snap.cwd || '').trim(),
              }).then(function (res) {
                if (res && res.ok) {
                  setImp(Object.assign({}, snap, { busy: false, result: res }))
                  refresh()
                } else setImp(Object.assign({}, snap, { busy: false, error: (res && res.error) || t('hist.err.import') }))
              }).catch(function () {
                setImp(Object.assign({}, snap, { busy: false, error: t('hist.err.import') }))
              })
            }
            reader.readAsText(file)
          }
          function openImportPicker() {
            setImp({ busy: false, error: null, result: null, cwd: '' })
          }
          // ---------- 导出对话：弹窗内选范围/工作区 → 勾选会话 → 写入指定目录 ----------
          function openExportPicker() {
            setExp({ busy: false, error: null, result: null, outDir: '', format: 'markdown', wsFilter: '', archFilter: 'all', items: [], loading: true, selectedIds: new Set() })
            // 拉取全部持久化会话（含未归档/冷会话），供选择导出。
            apiCall('history-sessions', {}).then(function (res) {
              setExp(function (prev) {
                if (!prev) return prev
                return Object.assign({}, prev, {
                  loading: false,
                  error: (res && res.ok) ? prev.error : ((res && res.error) || t('hist.err.sessions')),
                  items: (res && res.ok && Array.isArray(res.items)) ? res.items : prev.items,
                })
              })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { loading: false, error: t('hist.err.sessions') }) : prev })
            })
            // 拉取默认导出目录（桌面），仅当用户尚未输入时填充。
            apiCall('history-export-defaults', {}).then(function (res) {
              setExp(function (prev) {
                if (!prev || prev.outDir) return prev
                if (res && res.ok && typeof res.defaultDir === 'string' && res.defaultDir) {
                  return Object.assign({}, prev, { outDir: res.defaultDir })
                }
                return prev
              })
            }).catch(function () {})
          }
          // 弹出目录选择器：选中后把导出目录回填到输入框。
          function openExportDir() {
            if (exp.busy) return
            setExp(Object.assign({}, exp, { pickingDir: true }))
          }
          function toggleExportSelect(id) {
            setExp(function (prev) {
              var next = new Set(prev.selectedIds)
              if (next.has(id)) next.delete(id); else next.add(id)
              return Object.assign({}, prev, { selectedIds: next })
            })
          }
          function doExport() {
            var ids = Array.from(exp.selectedIds)
            if (!ids.length || !String(exp.outDir || '').trim()) return
            setExp(Object.assign({}, exp, { busy: true, error: null, result: null }))
            apiCall('history-export', { sessionIds: ids, format: exp.format, outDir: String(exp.outDir).trim() }).then(function (res) {
              if (res && res.ok) setExp(Object.assign({}, exp, { busy: false, result: res }))
              else setExp(Object.assign({}, exp, { busy: false, error: (res && res.error) || t('hist.err.export') }))
            }).catch(function () {
              setExp(Object.assign({}, exp, { busy: false, error: t('hist.err.export') }))
            })
          }
          // 把选中的会话批量归档到 History（纳入保留期管理），随后刷新列表与页面。
          function doArchiveSelected() {
            var ids = Array.from(exp.selectedIds)
            if (!ids.length || exp.busy) return
            setExp(Object.assign({}, exp, { busy: true, error: null, result: null }))
            apiCall('history-archive-batch', { sessionIds: ids }).then(function (res) {
              if (res && res.ok) {
                refresh()
                return apiCall('history-sessions', {}).then(function (r2) {
                  setExp(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, {
                      busy: false,
                      selectedIds: new Set(),
                      result: { archived: (res.archived || []).length },
                      items: (r2 && r2.ok && Array.isArray(r2.items)) ? r2.items : prev.items,
                    })
                  })
                })
              }
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: (res && res.error) || t('hist.err.archive') }) : prev })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: t('hist.err.archive') }) : prev })
            })
          }

          var RETENTION_OPTS = [
            { value: 0, label: t('hist.retention.forever') },
            { value: 7, label: t('hist.retention.days', { count: 7 }) },
            { value: 30, label: t('hist.retention.days', { count: 30 }) },
          ]
          var EXPORT_FORMAT_OPTS = [
            { value: 'markdown', label: 'Markdown' },
            { value: 'jsonl', label: 'JSONL' },
          ]
          var EXPORT_ARCH_OPTS = [
            { value: 'all', label: t('hist.arch.all') },
            { value: 'archived', label: t('hist.arch.archived') },
            { value: 'live', label: t('hist.arch.live') },
            { value: 'missing', label: t('hist.arch.missing') },
          ]
          // 导出弹窗内的工作区筛选选项与候选会话（随弹窗状态/数据刷新重算）。
          // 组 id 与列表页同源（活登记 + 按会话目录重建的分组）。
          var exportWsOptions = [{ value: '', label: t('hist.ws.all') }]
          if (exp && data.groups && data.groups.length) {
            data.groups.forEach(function (g) { exportWsOptions.push({ value: g.id, label: g.title }) })
            exportWsOptions.push({ value: 'ungrouped', label: t('hist.ungrouped') })
          } else if (exp && data.workspaces) {
            Object.keys(data.workspaces).forEach(function (wid) {
              exportWsOptions.push({ value: 'ws:' + wid, label: (data.workspaces[wid].title || wid) })
            })
            exportWsOptions.push({ value: 'ungrouped', label: t('hist.ungrouped') })
          }
          var exportItems = []
          if (exp) {
            var useGroups = !!(data.groups && data.groups.length)
            exportItems = (exp.items || []).filter(function (it) {
              if (exp.archFilter === 'archived' && !it.archived) return false
              if (exp.archFilter === 'live' && it.archived) return false
              if (exp.archFilter === 'missing' && !it.cwdMissing) return false
              if (!exp.wsFilter) return true
              if (useGroups) {
                if (exp.wsFilter === 'ungrouped') return !it.groupId
                return it.groupId === exp.wsFilter
              }
              if (exp.wsFilter === 'ungrouped') return !it.workspaceId || !data.workspaces[it.workspaceId]
              var wid = exp.wsFilter.slice(3)
              return it.workspaceId === wid && !!data.workspaces[wid]
            })
          }

          function renderRow(it) {
            return React.createElement('div', { className: 'dsm-hist-row', key: it.sessionId },
              React.createElement('input', { type: 'checkbox', className: 'dsm-hist-check', checked: selected.has(it.sessionId), onChange: function () { toggleSelect(it.sessionId) } }),
              React.createElement('div', { className: 'dsm-hist-main' },
                React.createElement('div', { className: 'dsm-hist-title' }, it.title || ('Session ' + shortId(it.sessionId))),
                it.cwd ? React.createElement('div', { className: 'dsm-hist-cwd', title: it.cwd }, it.cwd) : null),
              React.createElement('div', { className: 'dsm-hist-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { doUnarchive(it.sessionId) } }, t('hist.btn.restore')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'delete', sessionId: it.sessionId, title: it.title || ('Session ' + shortId(it.sessionId)) }) } }, t('hist.btn.purge'))))
          }

          // 分组卡片：dsm-source 卡片 + 可折叠表头（与 MCP / Skills 页一致的源卡片语言）。
          function toggleGroupCollapse(key) {
            setCollapsed(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = !next[key]
              return next
            })
          }
          function renderGroup(g) {
            var groupIds = g.items.map(function (it) { return it.sessionId })
            var allChecked = groupIds.length > 0 && groupIds.every(function (id) { return selected.has(id) })
            var open = !collapsed[g.key]
            // 重建组（宿主里没有对应登记）：标出「曾登记、已被移除」或「从未登记」，目录仍在则给一键重新登记。
            var detached = g.kind === 'detached'
            return React.createElement('div', { className: 'dsm-source', key: 'g:' + g.key },
              React.createElement('div', { className: 'dsm-source-head dsm-hist-group-head' },
                React.createElement('input', { type: 'checkbox', className: 'dsm-hist-group-check', checked: allChecked, onChange: function () { toggleGroup(groupIds) }, 'aria-label': t('hist.selectGroup', { title: g.title }) }),
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleGroupCollapse(g.key) } },
                  React.createElement('span', { className: 'dsm-source-title dsm-hist-group-title', title: g.title }, g.title),
                  React.createElement('span', { className: 'dsm-count' }, t('hist.group.count', { count: g.items.length }))),
                detached ? React.createElement('div', { className: 'dsm-hist-group-extra' },
                  React.createElement('span', { className: 'dsm-tag', title: t('hist.group.removed.hint') },
                    t('hist.group.removed')),
                  g.canRegister ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, title: t('hist.btn.registerWs.hint'), onClick: function () { setModal({ type: 'register', path: g.path, title: g.title }) } }, t('hist.btn.registerWs')) : null,
                  g.dirMissing ? React.createElement('span', { className: 'dsm-hist-dir-missing', title: t('hist.group.dirMissing.hint') }, '⚠ ' + t('hist.group.dirMissing')) : null) : null,
                g.path ? React.createElement('span', { className: 'dsm-path', title: g.path }, g.path) : null),
              open ? React.createElement('div', { className: 'dsm-source-body' }, g.items.map(renderRow)) : null)
          }

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.sessions'))),
                React.createElement('p', { className: 'dsm-desc' }, t('sessions.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openImportPicker }, t('hist.btn.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openExportPicker }, t('hist.btn.export')),
                // 「全选 / 取消全选」紧挨导出（用户 2026-09-17 裁定）：它是列表级动作，
                // 与其余页头动作同栏，不再和统计数字挤在一行。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: !filtered.length, onClick: function () { toggleAllVisible(visibleIds) } }, bulkPair(allVisible ? t('hist.deselectAll') : t('hist.selectAll'), allVisible ? t('hist.selectAll') : t('hist.deselectAll'))),
                selected.size > 0 ? React.createElement('div', { className: 'dsm-hist-batch' },
                  React.createElement('span', { className: 'dsm-hist-batch-count' }, t('hist.selected', { count: selected.size })),
                  React.createElement('div', { className: 'dsm-hist-batch-actions' },
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { doUnarchiveBatch() } }, t('hist.btn.restoreSelected', { count: selected.size })),
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'deleteBatch', count: selected.size }) } }, t('hist.btn.deleteSelected', { count: selected.size })))) : null)),
            React.createElement('div', { className: 'dsm-stat-row' },
              React.createElement('div', { className: 'dsm-summary' },
                [['archived', data.items.length, t('hist.stat.archived')], ['projects', grouped ? groups.length : '—', t('hist.stat.projects')], ['retention', data.retentionDays ? String(data.retentionDays) : '∞', t('hist.stat.retention')]].map(function (item) {
                  return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                    React.createElement('strong', null, item[1]), item[2])
                }))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: t('hist.search.placeholder'), value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, {
                  options: RETENTION_OPTS, value: data.retentionDays, onChange: function (v) { setRetention(Number(v)) },
                }))),
            data.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            notice ? React.createElement(Notice, { kind: notice.kind, text: notice.text }) : null,
            data.loading && !data.items.length ? React.createElement('div', { className: 'dsm-empty' }, t('hist.loading'))
              : filtered.length === 0 ? React.createElement('div', { className: 'dsm-empty' }, query ? t('hist.empty.search') : t('hist.empty.none'))
              : React.createElement('div', { className: 'dsm-sources' },
                grouped ? groups.map(renderGroup) : React.createElement('div', { className: 'dsm-source' }, filtered.map(renderRow))),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: t('hist.purge.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.purge.one', { title: modal.title })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDelete(modal.sessionId) } }, t('hist.btn.confirmPurge')))) : null,
            modal && modal.type === 'deleteBatch' ? React.createElement(Modal, { key: 'delb', title: t('hist.purge.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.purge.batch', { count: modal.count })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDeleteBatch() } }, t('hist.btn.confirmPurge')))) : null,
            modal && modal.type === 'register' ? React.createElement(Modal, { key: 'reg', title: t('hist.register.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.register.body', { title: modal.title })),
              React.createElement('p', { className: 'dsm-help dsm-hist-register-path' }, String(modal.path || '')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: function () { doRegisterWorkspace(modal.path) } }, t('hist.register.confirm')))) : null,
            modal && modal.type === 'registered' ? React.createElement(Modal, { key: 'regdone', title: t('hist.register.done.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.register.done.body', { title: (modal.workspace && modal.workspace.title) || '' })),
              (modal.workspace && modal.workspace.attached && modal.workspace.attached.length)
                ? React.createElement('p', { className: 'dsm-help' }, t('hist.register.done.attached', { count: modal.workspace.attached.length }))
                : null,
              (modal.workspace && modal.workspace.attachSkipped && modal.workspace.attachSkipped.length)
                ? React.createElement('p', { className: 'dsm-help dsm-warning' }, t('hist.register.done.skipped', { count: modal.workspace.attachSkipped.length, reason: String(modal.workspace.attachSkipped[0].reason || '') }))
                : null) : null,
            // D13：会话页也改用共享 ImportModal（能力取三者并集）。差异只在 extra 区
            // （项目目录）与提交回调：选完文件直接导入，没有二次确认。
            imp ? React.createElement(ImportModal, {
              key: 'imp',
              t: t,
              title: t('hist.btn.import'),
              accept: '.jsonl,.json,.md,.markdown,.txt',
              busy: imp.busy === true,
              requirements: [t('upload.requirement.session.1'), t('upload.requirement.session.2'), t('upload.requirement.session.3')],
              result: imp.error ? { ok: false, text: String(imp.error) } : (imp.result ? { ok: true, text: t('hist.import.done', { id: imp.result.sessionId, count: imp.result.count }) } : null),
              extra: React.createElement('div', null,
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('label', { className: 'dsm-label' }, t('hist.import.cwd')),
                  React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: t('hist.import.cwd.placeholder'), value: imp.cwd || '', onChange: function (e) { setImp(Object.assign({}, imp, { cwd: e.target.value })) } }))),
              onClose: function () { setImp(null) },
              onSubmit: function (entries, files) { doImportFile(files[0]) },
            }) : null,
            exp ? React.createElement(Modal, { key: 'exp', className: 'dsm-modal-list dsm-export-modal', list: true, title: t('hist.btn.export'), closeLabel: t('btn.close'), onClose: function () { setExp(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.export.hint')),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.dir')),
                React.createElement('div', { className: 'dsm-dir-row' },
                  React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: 'D:\\backups\\dsh\\exports', value: exp.outDir || '', onChange: function (e) { setExp(Object.assign({}, exp, { outDir: e.target.value })) } }),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: exp.busy, onClick: openExportDir, title: t('hist.export.browse') }, t('hist.btn.browse'))),
                exp.pickingDir ? React.createElement(DirPickerModal, { key: 'exp-dir-picker', title: t('hist.export.pickDir'), initial: String(exp.outDir || ''), closeLabel: t('btn.close'), onClose: function () { setExp(Object.assign({}, exp, { pickingDir: false })) }, onPick: function (path) { setExp(Object.assign({}, exp, { outDir: path, pickingDir: false })) } }) : null),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.format')),
                React.createElement(SourceSelect, { options: EXPORT_FORMAT_OPTS, value: exp.format, onChange: function (v) { setExp(Object.assign({}, exp, { format: v })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.scope')),
                React.createElement(SourceSelect, { options: EXPORT_ARCH_OPTS, value: exp.archFilter, onChange: function (v) { setExp(Object.assign({}, exp, { archFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.workspace')),
                React.createElement(SourceSelect, { options: exportWsOptions, value: exp.wsFilter, onChange: function (v) { setExp(Object.assign({}, exp, { wsFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field dsm-export-body' },
                React.createElement('div', { className: 'dsm-label' }, t('hist.export.sessions', { count: exportItems.length })),
                React.createElement('div', { className: 'dsm-source dsm-pick-list' },
                  exp.loading ? React.createElement('div', { className: 'dsm-empty' }, t('hist.export.loading'))
                    : exportItems.length ? (function () {
                        // 按**工作区目录**分组：不同文件夹的会话分开列，组头可折叠。
                        var groups = [], byCwd = {}
                        exportItems.forEach(function (it) {
                          var ck = String(it.cwd || '')
                          if (!byCwd[ck]) { byCwd[ck] = []; groups.push({ cwd: ck, rows: byCwd[ck] }) }
                          byCwd[ck].push(it)
                        })
                        return groups.map(function (g) {
                          var key = 'exp:' + g.cwd
                          var open = collapsed[key] !== true
                          return React.createElement('div', { key: key, className: 'dsm-pick-group' },
                            React.createElement('button', { type: 'button', className: 'dsm-pick-group-head', 'aria-expanded': open ? 'true' : 'false', onClick: function () { toggleGroupCollapse(key) } },
                              React.createElement('span', { className: 'dsm-pick-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                              React.createElement('span', { className: 'dsm-pick-group-name', title: g.cwd || t('hist.ungrouped') }, g.cwd || t('hist.ungrouped')),
                              React.createElement('span', { className: 'dsm-pick-group-count' }, t('export.group.count', { count: g.rows.length }))),
                            open ? g.rows.map(function (it) {
                              return React.createElement('label', { key: it.sessionId, className: 'dsm-hist-row' },
                                React.createElement('input', { type: 'checkbox', className: 'dsm-hist-check', checked: exp.selectedIds.has(it.sessionId), onChange: function () { toggleExportSelect(it.sessionId) } }),
                                React.createElement('div', { className: 'dsm-hist-main' },
                                  React.createElement('div', { className: 'dsm-hist-title' }, it.title || ('Session ' + shortId(it.sessionId))),
                                  it.cwdMissing ? React.createElement('div', { className: 'dsm-hist-cwd dsm-hist-cwd-missing', title: t('hist.cwd.missing') + it.cwd }, '⚠ ' + it.cwd) : null),
                                React.createElement('div', { className: 'dsm-hist-actions' },
                                  React.createElement('span', { className: 'dsm-tag' + (it.archived ? '' : ' dsm-tag-on') }, it.archived ? t('hist.tag.archived') : t('hist.tag.live'))))
                            }) : null)
                        })
                      })() : React.createElement('div', { className: 'dsm-empty' }, t('hist.export.empty')))),
              exp.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(exp.error)) : null,
              exp.result ? React.createElement('div', { className: 'dsm-feedback' },
                exp.result.exported
                  ? (t('hist.result.exported', { count: (exp.result.exported || []).length, dir: String(exp.outDir || '').trim() })
                    + ((exp.result.skipped && exp.result.skipped.length) ? t('hist.result.skipped', { count: exp.result.skipped.length, ids: exp.result.skipped.map(function (s) { return s.sessionId }).join('、') }) : ''))
                  : (t('hist.result.archived', { count: exp.result.archived }))) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('span', { className: 'dsm-hist-batch-count' }, t('hist.selected', { count: exp.selectedIds.size })),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: exp.busy || !exp.selectedIds.size, onClick: doArchiveSelected, title: t('hist.btn.archiveSelected.title') }, t('hist.btn.archiveSelected')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: exp.busy || !exp.selectedIds.size || !String(exp.outDir || '').trim(), onClick: doExport }, exp.busy ? t('hist.export.busy') : t('hist.btn.exportSelected', { count: exp.selectedIds.size })))) : null,
            modal && modal.type === 'error' ? React.createElement(Modal, { key: 'err', title: t('hist.error.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, String(modal.message || t('hist.error.unknown')))) : null)
        }

        // ---------- Rules 页（v0.3 规则层：场景 = 一级目录，勾选即自动生效）----------
        // 场景/分组名校验：与宿主 src/rules/service.ts 的 isValidGroupSegment 保持一致。
        // 变更单 01 放宽为**任意 Unicode**（`办公` / `日常` 必须通过），只保留文件系统安全约束。
        var SCENE_RESERVED_RE = /[<>:"|?*\\/]/
        function isValidSceneSegment(segment) {
          var s = String(segment == null ? '' : segment)
          if (s === '' || s === '.' || s === '..') return false
          if (s.length > 64) return false
          if (s.charAt(0) === '.') return false
          if (SCENE_RESERVED_RE.test(s)) return false
          if (s !== s.trim()) return false
          if (/[.\s]$/.test(s)) return false
          return true
        }
        function isValidScenePath(group) {
          var s = String(group == null ? '' : group)
          if (s === '' || s.charAt(0) === '/' || s.charAt(s.length - 1) === '/') return false
          return s.split('/').every(isValidSceneSegment)
        }
        var RULE_FORM_OPTIONS = [
          { value: 'flat', label: 'flat' },
          { value: 'bundle', label: 'bundle' },
        ]        /**
     * 场景显示名：宿主给出的 `label` 优先（保留场景 `global` 的 label 是「全局」，由宿主决定），
     * 界面不再自己拼中文；没有元数据的游离桶（`''`）用专门的说明文案。
     *
     * 定义在模块作用域、把 `scenes` 作为**参数**传入：它原本是 MemoryPage 内部的闭包，
     * 而 ScenesPage 也调用它——两个页面是各自独立的函数作用域，闭包不可能共享。
     * 那正是「工具」页整页白屏的原因（ScenesPage 渲染卡片时 ReferenceError: sceneLabel
     * is not defined，被 shell 的 slot 边界吞成一条日志，面板什么都不画）。
     */
    function sceneLabel(scenes, name) {
      if (name === '') return t('memory.scene.orphan')
      // 两个保留场景的名字由宿主回传（label 恒为中文「全局」/「常开」），必须先按名字取词条：
      // 放在 `row.label` 之后就会被中文 label 抢先，英文界面下这两个名字一直是中文。
      if (name === 'global') return t('memory.scene.global')
      if (name === '_shared') return t('memory.scene.shared')
      var row = (scenes || []).filter(function (s) { return s.name === name })[0]
      if (row && row.label) return row.label
      return name
    }

    /**
     * 场景描述在卡片上最多显示多少个字。
     *
     * 描述是自由文本，卡片只留一行：不裁的话一个长描述会把卡片撑成纵向（整页高度失控），
     * 保留场景「全局」尤其明显——它的名字只有两个字，剩下的宽度全被描述占满。
     * 上限同时写在新建/编辑表单的 `maxLength` 上（见场景表单），显示层再裁一次兜住历史数据。
     */
    var SCENE_DESC_MAX = 60
    /** 记忆描述在勾选行里最多显示多少个字：记忆正文可能很长，行内只留一行，超长截断（全文进 title）。 */
    var MEM_DESC_MAX = 80
    /** 压平空白并裁到 max 个字符（含省略号）；返回空串 = 没有描述。 */
    function clipText(value, max) {
      var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
      if (s.length <= max) return s
      return s.slice(0, max - 1) + '…'
    }
    /**
     * 记忆归属的场景名 = 分组路径的第一段（`办公/流程/站会` → `办公`）。
     *
     * 与宿主的 `sceneOf()`、渲染路径里的 `ref.scene` 逐字一致（`src/rules/service.ts:763`、
     * `scene` 由一级目录写入 `probe.refs`）。界面若按完整 group 比对，多级分组的记忆会整个看不见。
     */
    function sceneOfGroup(group) {
      var s = String(group == null ? '' : group)
      var i = s.indexOf('/')
      return i >= 0 ? s.slice(0, i) : s
    }
    /** 某个场景的记忆（按名称排序）。**只含该场景自己的**——跨场景勾选在宿主侧是不生效的，见下。 */
    function sceneMemoriesOf(memories, scene) {
      var list = Array.isArray(memories) ? memories : []
      return list
        .filter(function (m) { return m && sceneOfGroup(m.scene) === scene })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)) })
    }
    /**
     * 「添加记忆段」的默认勾选：**只勾被编辑场景里已启用的那几条**，其余一律不勾。
     *
     * 记忆段的语义是「勾 = 该场景的记忆是否注入」，所以默认值取「用户已经让这个场景生效的那几条」——
     * 既不改变现状，也不会把没打算注入的记忆塞进档案。启用状态来自 `rules-list`（记忆 id 就是
     * 规则 id），因此纯客户端可算，不需要宿主配合。
     */
    function memDefaultPickIds(memories, rules, scene) {
      var enabled = {}
      var rows = Array.isArray(rules) ? rules : []
      rows.forEach(function (r) {
        if (!r || r.shadowed === true || r.enabled === false) return
        enabled[String(r.id)] = true
      })
      return sceneMemoriesOf(memories, scene)
        .filter(function (m) { return enabled[String(m && m.id)] === true })
        .map(function (m) { return String(m.id) })
    }
    /** 场景页卡片上的描述行：**只有描述**，数量（记忆条数 / 已配 N 台 MCP…）不进卡片。 */
    function sceneTileDesc(scene) {
      return clipText(scene && scene.description, SCENE_DESC_MAX)
    }

    // ---------- 场景记忆页（场景 = scene-memory/ 下的一级目录；内容自动生效）----------
        //
        // 变更单 01 之后 Rules 与 Scenes 合并为本页：**场景（一级目录）是分组维度，
        // 记忆（.md）是内容**；勾选启用后该目录树内所有 .md 正文自动进入系统提示词。
        // 原 Scenes 页的「agent preset ↔ 分组绑定」降级为页底的「高级」折叠区（可选）。
        // ---------- 场景页：场景清单 + 档案（MCP 工具集/技能集/子智能体绑定，三段自由搭配）+ 当前模式 ----------
        function ScenesPage() {
          var EMPTY_MODE = { scene: null, snapshot: null }
          var state = React.useState({ loading: true, error: null, scenes: [], rules: [], activeMode: 'all', mode: EMPTY_MODE, archives: {} })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          var sfs = React.useState({ name: '', error: null })
          var sceneForm = sfs[0], setSceneForm = sfs[1]
          var pos = React.useState([])
          var presetOptions = pos[0], setPresetOptions = pos[1]
          var dts = React.useState(null)
          var drillTools = dts[0], setDrillTools = dts[1]
          // 场景回收站（记录 + 档案）：null = 关闭；{loading, error, entries}
          var sts = React.useState(null)
          var trash = sts[0], setTrash = sts[1]
          var stb = React.useState(false)
          var trashBusy = stb[0], setTrashBusy = stb[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          function loadTrash(keepOpen) {
            setTrash(Object.assign({ loading: true, error: null, entries: [] }, keepOpen ? trash || {} : {}))
            apiCall('scene-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.trash || [] })
              else setTrash({ loading: false, error: (res && res.error) || t('trash.loadFailed'), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: String((e && e.message) || e), entries: [] }) })
          }
          function restoreScene(item) {
            setTrashBusy(true)
            apiCall('scene-trash-restore', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.restored', { name: item.name }) }); refresh(true); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          function purgeScene(item) {
            setTrashBusy(true)
            apiCall('scene-trash-delete', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.purged', { name: item.name }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('scene-mode-get', {}).then(function (m) {
              if (m && m.ok) setData(function (prev) { return Object.assign({}, prev, { mode: m.mode || EMPTY_MODE, archives: m.archives || {} }) })
            }).catch(function () {})
            apiCall('rules-list', {}).then(function (r) {
              // rules 也留下来：档案弹窗「记忆」段的默认勾选要用每条记忆的启用状态
              //（scene-inventory 的 memories 里没有 enabled，客户端自己算，省一次宿主改动）。
              if (r && r.ok) setData(function (prev) { return Object.assign({}, prev, { loading: false, error: null, scenes: r.scenes || [], rules: r.rules || [], activeMode: r.activeMode === 'custom' ? 'custom' : 'all', activeScene: r.activeScene || null, scenePrompt: r.scenePrompt || null, stats: r.stats || prev.stats }) })
              else setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r) }) })
            }).catch(function (e) { setData(function (prev) { return Object.assign({}, prev, { loading: false, error: String((e && e.message) || e) }) }) })
          }
          React.useEffect(function () { refresh() }, [])
          function isValidSceneName(name) {
            return name.length > 0 && name.length <= 64 && !name.startsWith('.') && !/[\\/<>:"|?*]/.test(name)
          }
          /**
           * 切场景的结果提示：宿主会把场景绑定的提示词**写进 `~/.dsh/AGENTS.md`**，
           * 因此必须如实说清写没写、写的是哪份、或者为什么没写成。
           */
          function agentsMdNote(res) {
            var sync = res && res.agentsMd
            if (!sync) return ''
            if (sync.error) return ' · ' + t('scenes.agents.note.error', { reason: String(sync.error) })
            if (sync.applied) return ' · ' + t('scenes.agents.note.applied', { id: String(sync.applied) })
            if (sync.restored) return ' · ' + t('scenes.agents.note.restored')
            return ''
          }
          // ── 场景启用：**除「全局」外同时只能启用一个**（用户裁定）──
          // 空数组 = 全部关闭（只留恒常的 `_shared` 与 `global`）；服务端也会拒绝多个。
          function setActiveScenes(names) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-set-active', { scenes: names }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: !(res.agentsMd && res.agentsMd.error), text: t('memory.result.active') + agentsMdNote(res) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          /**
           * 场景开关（P6）：**唯一入口**。
           *
           * 开 = 进入该场景：应用档案（MCP/技能双向切换）+ 启用场景（提示词绑定生效 + 记忆范围收窄）；
           * 关 = 回到全局默认：恢复档案快照 + 取消场景启用。
           *
           * ⚠️ 核心约束：`mode.scene` 与 `active` **必须恒等**。此前开关只写 `active`、
           * 「切入此模式」按钮只写 `mode.scene`，两者互不知情 —— 于是「拨开关不应用档案」与
           * 「顶部横幅永远不显示」同时发生。现在两条路径都走 enterMode / exitMode。
           */
          function toggleScene(scene) {
            if (busy || scene.shared || scene.global) return
            if (scene.active === true) exitMode()
            else enterMode(scene.name)
          }
          /** 场景锁定（v0.8）：锁上后五个管理域整体只读（场景页 + 各功能页）；启停不受影响。 */
          function toggleSceneLock(scene) {
            if (busy || scene.shared || scene.global) return
            setBusy(true)
            apiCall('rules-scene-lock', { scene: scene.name, locked: scene.locked !== true }).then(function (res) {
              setBusy(false)
              if (res && res.ok) refresh(true)
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          /**
           * 提示词预设候选（打开表单时拉一次；失败就只留「不绑定」）。
           * 顺带回传**当前生效的预设 id**：场景表单默认就选它（用户裁定「默认就是当前启动的」），
           * 用户仍可改成别的或选「不绑定」。
           */
          function loadPresetOptions(onLoaded) {
            apiCall('agentsmd-list', {}).then(function (res) {
              var list = (res && res.presets) || []
              // 不再提供「不绑定」：候选就是预设本身，默认选中当前生效的那份。
              var opts = []
              list.forEach(function (p) { opts.push({ value: p.id, label: p.active ? (p.id + ' · ' + t('scenes.prompt.activeTag')) : p.id }) })
              setPresetOptions(opts)
              var activeId = ''
              for (var i = 0; i < list.length; i += 1) { if (list[i].active) { activeId = list[i].id; break } }
              if (typeof onLoaded === 'function') onLoaded(activeId)
            }).catch(function () {})
          }
          /** 表单里没显式选过时，把「提示词」默认填成当前生效的那份（不覆盖已有选择）。 */
          function defaultPromptToActive(activeId) {
            if (!activeId) return
            setSceneForm(function (f) { return (f && String(f.prompt || '') !== '') ? f : Object.assign({}, f, { prompt: activeId }) })
          }
          // ── 场景建 / 改描述 / 改绑定的提示词 / 删 ──
          function openCreateScene() { setSceneForm({ name: '', description: '', prompt: '', error: null }); setModal({ type: 'scene-create' }); loadPresetOptions(defaultPromptToActive) }
          function openEditScene(scene) {
            setSceneForm({ name: scene.name, description: scene.description || '', prompt: scene.prompt || '', error: null })
            setModal({ type: 'scene-edit', name: scene.name })
            // 该场景还没绑定时，默认选中当前生效的那份（用户裁定「默认就是当前启动的」）。
            if (!scene.prompt) loadPresetOptions(defaultPromptToActive)
            else loadPresetOptions()
          }
          /** 新建与编辑共用一个表单：字段相同，只是分别走 rules-create-scene / rules-update-scene。 */
          function submitSceneForm() {
            var isEdit = modal && modal.type === 'scene-edit'
            var name = String(sceneForm.name || '').trim()
            if (!isValidSceneName(name)) { setSceneForm(Object.assign({}, sceneForm, { error: t('error.rules.invalidGroup') })); return }
            var description = String(sceneForm.description || '').trim()
            var prompt = String(sceneForm.prompt || '').trim()
            // 编辑时表单里的 name 可能改过：改名走 nextName，服务端按 modal.name（原名）定位、改完再落新名。
            var originalName = isEdit ? String((modal && modal.name) || name) : name
            setBusy(true)
            var payload = isEdit
              ? { name: originalName, nextName: name, description: description, prompt: prompt }
              : { name: name, description: description, prompt: prompt }
            apiCall(isEdit ? 'rules-update-scene' : 'rules-create-scene', payload).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                // 新建时若把历史默认（全部启用）收敛成单选，如实说一句，别让用户以为场景"自己开了"。
                setResult({ ok: true, text: res.collapsedActive ? t('scenes.result.created.collapsed', { name: name }) : t(isEdit ? 'memory.result.sceneUpdated' : 'memory.result.sceneCreated', { name: name }) })
                refresh(true)
              } else setSceneForm(Object.assign({}, sceneForm, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setSceneForm(Object.assign({}, sceneForm, { error: String((e && e.message) || e) })) })
          }
          function submitDeleteScene(name) {
            setBusy(true)
            apiCall('rules-remove-scene', { name: name }).then(function (res) {
              setBusy(false); setModal(null)
              if (res && res.ok) {
                var moved = Number((res && res.movedFiles) || 0)
                // 如实说清「一起删了多少条记忆」：删除场景现在会带走它下面的全部记忆。
                setResult({
                  ok: true,
                  text: moved > 0
                    ? t('memory.result.sceneRemoved.withMemories', { name: name, count: moved })
                    : t('memory.result.sceneRemoved', { name: name }),
                })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          // ── 档案（mcp 两级 / skills / subagents 三段自由搭配）──
          function openArchive(name) {
            setBusy(true)
            Promise.all([apiCall('scene-mode-get', {}), apiCall('scene-inventory', {})]).then(function (rs) {
              setBusy(false)
              var modeRes = rs[0], inv = rs[1]
              if (!(inv && inv.ok)) { setResult({ ok: false, text: translateError(t, inv) }); return }
              var archives = (modeRes && modeRes.ok ? modeRes.archives : null) || data.archives || {}
              var archive = archives[name] || {}
              setModal({ type: 'scene-archive', name: name, drill: null, memQuery: '', skillQuery: '', subQuery: '', mcpQuery: '',
                sections: {
                  mcp: archive.mcp ? Object.assign({}, archive.mcp) : null,
                  mcpNotes: archive.mcpNotes && Object.keys(archive.mcpNotes).length ? Object.assign({}, archive.mcpNotes) : null,
                  skills: Array.isArray(archive.skills) ? archive.skills.slice() : null,
                  subagents: Array.isArray(archive.subagents) ? archive.subagents.slice() : null,
                  memories: Array.isArray(archive.memories) ? archive.memories.slice() : null,
                },
                inventory: {
                  mcpServers: inv.mcpServers || [], skills: inv.skills || [], subagents: inv.subagents || [], tools: inv.tools || [],
                  // 模式名与顺序（标准 → PTC → 极简 → 创造 → 自建）：人设行的限制摘要按这个顺序排。
                  presets: inv.presets || [],
                  // 记忆段的数据源（宿主 scene-inventory 回传；老宿主缺失时退化为空列表而不是崩）。
                  // 只留扁平 memories——记忆段现在按「记忆所属场景」自己筛，不再需要场景清单。
                  memories: inv.memories || [],
                } })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function modalSections() { return modal && modal.type === 'scene-archive' ? modal.sections : null }
          function setSections(sections) { if (modal && modal.type === 'scene-archive') setModal(Object.assign({}, modal, { sections: sections })) }
          function toggleMcpServer(server) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            if (mcp[server] !== undefined) delete mcp[server]
            else mcp[server] = '*'
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          /**
           * 场景级 MCP 备注（v0.8.1）：该场景进入时覆盖全局备注、退出恢复。
           * 空值 = 删除该服务器的场景备注；mcpNotes 全空 → null（等同未定义，保存时不上报）。
           */
          function setMcpNote(server, value) {
            var sections = modalSections(); if (!sections) return
            var notes = Object.assign({}, sections.mcpNotes || {})
            var v = String(value == null ? '' : value).trim()
            if (v) notes[server] = v
            else delete notes[server]
            setSections(Object.assign({}, sections, { mcpNotes: Object.keys(notes).length ? notes : null }))
          }
          /**
           * 新加段一律**默认不勾选**（用户明确要求：MCP 工具集 / 技能集 / 子智能体绑定都不预勾）。
           *
           * 取 2026-09-13 前的「预勾当前运行时状态」是错的方向：用户点「添加」只是想开始配，
           * 不是想把自己现有的启用状态抄进档案。代价要讲清楚——勾选集语义是「勾 = 启用」，
           * 空段 = 全部停用（未定义段也是同一个意思，见 archive-engine 的四域同口径），
           * 所以「添加 MCP 工具集」当下就等价于「该场景下全部 MCP 停用」，
           * 段脚注（`memory.archive.emptySection`）与弹窗顶部说明会同时把这句话显示出来。
           */
          function emptyMcpPreset() { return {} }
          /** 全选：列出全部服务器（含未运行的）并各勾「全部工具」。 */
          function mcpSelectAll() {
            var all = {}
            ;(modal.inventory.mcpServers || []).forEach(function (server) { all[server.name] = '*' })
            setSections(Object.assign({}, modalSections(), { mcp: all }))
          }
          function mcpDrillSpec(value) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            mcp[modal.drill] = value
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          /** 档案各段共用的段头动作（包装共享的 segActions，把 busy / 文案在这里补上）。 */
          function archiveSegActions(defined, addLabel, onAdd, onRemove, onAll, onClear, allChecked) {
            return segActions({
              defined: defined, busy: busy, addLabel: addLabel,
              selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'), removeLabel: t('memory.archive.removeSection'),
              onAdd: onAdd, onRemove: onRemove, onAll: onAll, onClear: onClear, allChecked: allChecked,
            })
          }
          /**
           * 段脚注：段已定义但一项未勾必须显式提示，否则像「没保存上」。
           * 各域的后果不同（MCP/技能/记忆 = 全部停用；子智能体 = 不限制），所以文案由调用方给。
           */
          function archiveSegFoot(defined, count, emptyLabel) {
            return segFoot(defined, count, emptyLabel || t('memory.archive.emptySection'))
          }

          // ── 段 4：记忆（P5：单一真相源 = `rules[*].enabled`）────────────────────
          // 这个段**没有自己的「段定义」概念**：勾选状态**就是**记忆自身的 `enabled`，
          // 与记忆页同一个写入口（`rules-toggle`）。于是「记忆页开了 → 档案页显示开启」
          // 天然成立，不存在两套状态、也不需要双向同步代码。
          //
          // 勾选**立即提交**（不等「保存到场景」）：它是全局状态，不属于场景档案。
          //
          // **只列被编辑场景自己的记忆**：保留场景 `global` 恒定注入（任何对话都生效），
          // 不需要在这里配置，列出来只会让人以为「不勾就不注入」。
          function sceneMemories(sceneName) {
            return sceneMemoriesOf(modal.inventory.memories, sceneName)
          }
          /** 「全选 / 全不选」作用的 id 集合 = 本场景的全部记忆。 */
          function allMemoryIds() {
            return sceneMemories(modal.name).map(function (m) { return String(m.id) })
          }
          /** 记忆是否开启 —— 直接读 `rules[*].enabled`（单一真相源）。 */
          function memoryEnabled(id) {
            var rule = (data.rules || []).find(function (r) { return r.id === id })
            return !!(rule && rule.enabled !== false)
          }
          function toggleMemory(id) {
            var next = !memoryEnabled(id)
            setBusy(true)
            apiCall('rules-toggle', { id: id, enabled: next }).then(function (res) {
              setBusy(false)
              if (res && res.ok) refresh(true)
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          /** 全选 / 全不选：批量写 `enabled`（顺序提交，失败即停并如实报错）。 */
          function setAllMemories(on) {
            var ids = allMemoryIds()
            if (!ids.length) return
            setBusy(true)
            Promise.all(ids.map(function (id) { return apiCall('rules-toggle', { id: id, enabled: on }) }))
              .then(function () { setBusy(false); refresh(true) })
              .catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function memoriesSeg() {
            var own = sceneMemories(modal.name)
            var q = String(modal.memQuery || '').trim().toLowerCase()
            var items = q ? own.filter(function (m) {
              return String(m.name).toLowerCase().indexOf(q) >= 0
                || String(m.description || '').toLowerCase().indexOf(q) >= 0
            }) : own
            var enabledCount = own.filter(function (m) { return memoryEnabled(String(m.id)) }).length
            return seg({
              title: t('memory.archive.memories'),
              count: t('scenes.seg.checked', { checked: enabledCount, total: own.length }),
              actions: segActions({
                defined: true, busy: busy,
                selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'),
                onAll: function () { setAllMemories(true) },
                onClear: function () { setAllMemories(false) },
                allChecked: own.length > 0 && enabledCount === own.length,
              }),
              body: React.createElement('div', { className: 'dsm-seg-body' },
                segFilter(modal.memQuery, function (v) { setModal(Object.assign({}, modal, { memQuery: v })) }, t('scenes.mem.search')),
                items.length
                  ? React.createElement('div', null, items.map(function (m) {
                      return pickRow({
                        disabled: busy,
                        key: m.id,
                        checked: memoryEnabled(String(m.id)),
                        name: m.name,
                        // 记忆描述是自由正文的首行，可能很长：截断到 MEM_DESC_MAX，全文放 title。
                        // CSS 侧还有单行省略兜底（超长不再横向溢出段边框）。
                        desc: m.description ? clipText(m.description, MEM_DESC_MAX) : null,
                        descTitle: m.description || null,
                        onChange: function () { toggleMemory(String(m.id)) },
                      })
                    }))
                  : React.createElement('div', { className: 'dsm-pick-empty' }, q ? t('scenes.mem.noMatch') : t('scenes.mem.emptyScene'))),
            })
          }
          /** 段 1：MCP 工具集（服务器级勾选 → 行内「编辑」打开固定尺寸弹窗：备注 + 工具勾选）。 */
          function mcpSeg() {
            var sections = modalSections()
            var defined = !!sections.mcp
            var servers = modal.inventory.mcpServers || []
            return seg({
              title: t('memory.archive.tools'),
              count: defined ? t('scenes.seg.checked', { checked: Object.keys(sections.mcp).length, total: servers.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addTools'),
                function () { setSections(Object.assign({}, modalSections(), { mcp: emptyMcpPreset() })) },
                function () { var s = Object.assign({}, modalSections()); delete s.mcp; setSections(s) },
                mcpSelectAll,
                function () { setSections(Object.assign({}, modalSections(), { mcp: {} })) },
                // 「全选」按钮的全选态：档案里勾了全部服务器（含没在过滤结果里的）。
                defined && servers.length > 0 && servers.every(function (x) { return sections.mcp[x.name] !== undefined })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.mcpQuery, function (v) { setModal(Object.assign({}, modal, { mcpQuery: v })) }, t('scenes.filter.servers')),
                    (function () {
                      var q = String(modal.mcpQuery || '').trim().toLowerCase()
                      var shown = q ? servers.filter(function (s) { return String(s.name).toLowerCase().indexOf(q) >= 0 }) : servers
                      if (!shown.length) return React.createElement('div', { className: 'dsm-pick-empty' }, q ? t('scenes.mem.noMatch') : t('scenes.mcp.noServers'))
                      return React.createElement('div', null, shown.map(function (server) {
                        var selected = sections.mcp[server.name] !== undefined
                        var spec2 = sections.mcp[server.name]
                        var specText = !selected ? '' : spec2 === '*' ? t('scenes.mcp.allTools') : t('scenes.mcp.pickedCount', { count: spec2.length })
                        var hasNote = Boolean((sections.mcpNotes || {})[server.name])
                        // 工具数未知（从未运行过且无记录）：显示引导而不是误导性的 0。
                        var desc = server.toolCount === null || server.toolCount === undefined
                          ? (server.live || server.serverDisabled ? null : t('scenes.mcp.unknownCount'))
                          : t('scenes.mcp.toolCount', { count: server.toolCount })
                        return pickRow({
                          disabled: busy,
                          key: server.name,
                          checked: selected,
                          name: server.name,
                          desc: desc,
                          meta: [
                            server.live ? null : React.createElement('span', { key: 'nr', className: 'dsm-tag dsm-tag-off' }, t('scenes.mcp.notRunning')),
                            specText ? React.createElement('span', { key: 'spec' }, specText) : null,
                            hasNote ? React.createElement('span', { key: 'note', className: 'dsm-tag' }, t('scenes.mcp.hasNote')) : null,
                          ],
                          actions: selected ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function (e) { e.preventDefault(); e.stopPropagation(); openDrill(server.name) } }, t('scenes.mcp.edit')) : null,
                          onChange: function () { toggleMcpServer(server.name) },
                        })
                      }))
                    })())
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mcp.hint'))),
              foot: archiveSegFoot(defined, defined ? Object.keys(sections.mcp).length : 0),
            })
          }
          /**
           * 服务器编辑弹窗（v0.8.1 重做）：固定尺寸的次级弹窗，第一栏是场景备注输入框，
           * 第二栏是工具勾选列表 —— 「选工具」并入这里，行内不再塞备注输入框。
           */
          function mcpEditNode() {
            var sections = modalSections(); if (!sections) return null
            var server = modal.drill
            var spec = (sections.mcp || {})[server]
            var noteVal = (sections.mcpNotes || {})[server] || ''
            var known = drillTools
            var checkedCount = spec === '*' ? (known || []).length : (Array.isArray(spec) ? spec.length : 0)
            // 工具级的「全选 / 取消全选」也是二合一：全勾了就该给「取消全选」，
            // 并列两个按钮必然有一个是废话（与段头同一口径）。
            var allToolsChecked = checkedCount > 0 && (known || []).length > 0 && checkedCount === (known || []).length
            return React.createElement('div', { className: 'dsm-mask', key: 'mcp-edit' },
              React.createElement('div', { className: 'dsm-modal' },
                React.createElement('div', { className: 'dsm-modal-head' },
                  React.createElement('h3', { className: 'dsm-modal-title' }, t('scenes.mcp.edit') + ' · ' + server + '（' + t('scenes.seg.checked', { checked: checkedCount, total: (known || []).length }) + '）'),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { setModal(Object.assign({}, modal, { drill: null })) } }, t('scenes.mcp.done'))),
                React.createElement('div', { className: 'dsm-modal-body' },
                  React.createElement('div', { className: 'dsm-field' },
                    React.createElement('label', { className: 'dsm-label' }, t('scenes.mcp.noteLabel')),
                    React.createElement('input', { className: 'dsm-control', type: 'text', value: noteVal, maxLength: 200, placeholder: t('scenes.mcp.notePlaceholder'), onChange: function (e) { setMcpNote(server, e.target.value) } }),
                    React.createElement('p', { className: 'dsm-help' }, t('scenes.mcp.noteHint'))),
                  React.createElement('div', { className: 'dsm-field' },
                    React.createElement('div', { className: 'dsm-mcp-edit-tools-head' },
                      React.createElement('label', { className: 'dsm-label' }, t('scenes.mcp.toolsOf')),
                      React.createElement('div', { className: 'dsm-mcp-edit-tools-actions' },
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || !known, onClick: function () { mcpDrillSpec(allToolsChecked ? [] : '*') } }, bulkPair(allToolsChecked ? t('bulk.unselectAll') : t('bulk.selectAll'), allToolsChecked ? t('bulk.selectAll') : t('bulk.unselectAll'))))),
                    known === null
                      ? React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('memory.loading')))
                      : (known || []).length
                        ? segList((known || []).map(function (item) {
                            var on = spec === '*' ? true : (Array.isArray(spec) && spec.indexOf(item.short) >= 0)
                            return pickRow({
                              disabled: busy,
                              key: item.key,
                              checked: on,
                              name: item.short,
                              onChange: function () { toggleDrillTool(server, item.short) },
                            })
                          }), t('scenes.mcp.noTools'))
                        : React.createElement('div', { className: 'dsm-seg-body' },
                            React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mcp.noTools')),
                            modal.drillError ? React.createElement('div', { className: 'dsm-seg-empty-error' }, modal.drillError) : null,
                            React.createElement('div', { className: 'dsm-seg-empty-actions' },
                              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: drillTools === null, onClick: probeMcpTools }, t('scenes.mcp.probeTools')))),
                    React.createElement('div', { className: 'dsm-seg-foot' }, t('scenes.mcp.drillHint'))))))
          }
          /** 段 2：技能集。 */
          /**
           * 技能行的人类可读展示：技能名 + 来源名。
           *
           * 勾选集里存的仍是 `key`（`<来源 key>/<技能名>`）——它才是身份的载体；但**显示**
           * 必须用技能名与来源名：自定义目录的来源 key 是 `custom-<hash>`，直接显示 key 会
           * 让导入的技能在场景里变成一串哈希（用户 2026-09-15 报的）。
           * 老宿主没回传 name/root* 时退回按 key 拆，至少不再显示整串哈希前缀之外的路径。
           */
          function skillDisplay(item) {
            var key = String((item && item.key) || '')
            var slash = key.indexOf('/')
            var keyName = slash >= 0 ? key.slice(slash + 1) : key
            var keyRoot = slash >= 0 ? key.slice(0, slash) : ''
            var root = {
              key: String((item && item.rootKey) || keyRoot),
              label: String((item && item.rootLabel) || keyRoot),
              localeKey: item && item.rootLocaleKey,
              kind: item && item.rootKind,
            }
            return {
              name: String((item && item.name) || keyName || key),
              source: root.key ? rootDisplayName(t, root) : '',
              key: key,
            }
          }
          function skillsSeg() {
            var sections = modalSections()
            var defined = !!sections.skills
            var allItems = modal.inventory.skills || []
            /**
             * 可勾选集：**被同名技能覆盖的副本**与**结构不完整的技能**都不算。
             * 它们勾了也不生效（运行时那一步本来就跳过），后端保存时还会按同一口径当失效项丢掉
             * —— 留着只会造成「档案说开着、技能页说没启动」（用户实测：启动一个目录后档案里
             * 多出被覆盖的那个技能）。计数、「全选」、行内开关全部按这一份来。
             */
            var pickable = function (x) { return !x.shadowed && x.loadable !== false }
            var pickableItems = allItems.filter(pickable)
            var items = (function () {
              var q = String(modal.skillQuery || '').trim().toLowerCase()
              if (!q) return allItems
              // 搜索同时匹配技能名与来源名（用户按"来源"找技能是常见动作）。
              return allItems.filter(function (x) {
                var d = skillDisplay(x)
                return (d.name + ' ' + d.source + ' ' + d.key).toLowerCase().indexOf(q) >= 0
              })
            })()
            var pickedCount = pickableItems.filter(function (x) { return sections.skills && sections.skills.indexOf(x.key) >= 0 }).length
            return seg({
              title: t('memory.archive.skills'),
              count: defined ? t('scenes.seg.checked', { checked: pickedCount, total: pickableItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSkills'),
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.skills; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { skills: pickableItems.map(function (x) { return x.key }) })) },
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                defined && pickableItems.length > 0 && pickableItems.every(function (x) { return sections.skills.indexOf(x.key) >= 0 })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.skillQuery, function (v) { setModal(Object.assign({}, modal, { skillQuery: v })) }, t('scenes.filter.skills')),
                    items.length
                      ? React.createElement('div', null, items.map(function (item) {
                          var d = skillDisplay(item)
                          var offered = pickable(item)
                          return pickRow({
                            disabled: busy || !offered,
                            key: item.key,
                            checked: offered && sections.skills.indexOf(item.key) >= 0,
                            name: d.name,
                            desc: d.source || null,
                            descTitle: d.key,
                            meta: item.shadowed
                              ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.skills.shadowed.hint') }, t('status.shadowed'))
                              : (item.loadable === false
                                ? React.createElement('span', { className: 'dsm-tag', title: t('scenes.skills.invalid.hint') }, t('status.invalid'))
                                : (item.enabled === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null)),
                            onChange: function () {
                              var list = sections.skills.slice(); var i = list.indexOf(item.key)
                              if (i >= 0) list.splice(i, 1); else list.push(item.key)
                              setSections(Object.assign({}, modalSections(), { skills: list }))
                            },
                          })
                        }))
                      : React.createElement('div', { className: 'dsm-pick-empty' }, modal.skillQuery ? t('scenes.mem.noMatch') : t('scenes.skills.empty')))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.skills.hint'))),
              foot: archiveSegFoot(defined, defined ? pickedCount : 0),
            })
          }
          /** 段 3：子智能体绑定。 */
          /** 模式名（官方四个走词典，自建预设用它自己的名字，不翻译）。 */
          function scenePresetLabel(id, short) {
            var presets = (modal.inventory && modal.inventory.presets) || []
            var hit = presets.filter(function (p) { return p.id === id })[0]
            var shipped = { minimal: 1, standard: 1, ptc: 1, cordis: 1 }
            if (shipped[id] === 1 && (!hit || String(hit.trust || 'system') !== 'user')) {
              return t((short ? 'preset.short.' : 'preset.name.') + id)
            }
            return hit ? String(hit.name || id) : id
          }
          /**
           * 人设的按模式工具限制摘要（「标准 白3 · PTC 黑2」）。场景本身不引入"模式"这个
           * 维度 —— 会话跑在哪个模式是建会话时定的，场景改不了；这里只如实显示配了什么。
           */
          function personaRuleSummary(p) {
            var rules = (p && p.toolsByPreset) || {}
            var order = ((modal.inventory && modal.inventory.presets) || []).map(function (x) { return x.id })
            // 按 roster 顺序排（标准 → PTC → 极简 → 创造 → 自建），文件里的书写顺序不参与展示。
            var ids = Object.keys(rules).sort(function (a, b) {
              var ia = order.indexOf(a), ib = order.indexOf(b)
              return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
            })
            if (!ids.length) return null
            return ids.map(function (id) {
              var rule = rules[id] || {}
              var count = (rule.names || []).length
              return scenePresetLabel(id, true) + ' ' + t(rule.mode === 'deny' ? 'subagents.mode.denyOn' : 'subagents.mode.allowOn', { count: count })
            }).join(' · ')
          }
          function subagentsSeg() {
            var sections = modalSections()
            var defined = !!sections.subagents
            var allItems = modal.inventory.subagents || []
            var items = (function () {
              var q = String(modal.subQuery || '').trim().toLowerCase()
              return q ? allItems.filter(function (x) {
                return String(x.name).toLowerCase().indexOf(q) >= 0 || String(x.description || '').toLowerCase().indexOf(q) >= 0
              }) : allItems
            })()
            return seg({
              title: t('memory.archive.subagents'),
              count: defined ? t('scenes.seg.checked', { checked: sections.subagents.length, total: allItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSubagents'),
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.subagents; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: allItems.map(function (x) { return x.name }) })) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                defined && allItems.length > 0 && allItems.every(function (x) { return sections.subagents.indexOf(x.name) >= 0 })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.subQuery, function (v) { setModal(Object.assign({}, modal, { subQuery: v })) }, t('scenes.filter.subagents')),
                    items.length
                      ? React.createElement('div', null, items.map(function (item) {
                          return pickRow({
                disabled: busy,
                            key: item.name,
                            checked: sections.subagents.indexOf(item.name) >= 0,
                            name: item.name,
                            desc: item.description || null,
                            // 按模式配的工具限制摘要（没配就不显示）：场景改不了会话的模式，
                            // 但要让用户看得见"这条人设在某些模式下是被限工具的"。
                            meta: personaRuleSummary(item),
                            onChange: function () {
                              var list = sections.subagents.slice(); var i = list.indexOf(item.name)
                              if (i >= 0) list.splice(i, 1); else list.push(item.name)
                              setSections(Object.assign({}, modalSections(), { subagents: list }))
                            },
                          })
                        }))
                      : React.createElement('div', { className: 'dsm-pick-empty' }, modal.subQuery ? t('scenes.mem.noMatch') : t('scenes.subagents.empty')))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.subagents.hint'))),
              foot: archiveSegFoot(defined, defined ? sections.subagents.length : 0, t('memory.archive.emptySubagents')),
            })
          }
          /**
           * 档案编辑弹窗：顶部一行摘要（MCP/技能/子智能体/记忆各勾了多少）+ 四段 + 底部动作。
           * 结构固定 —— 加/删段、进出「选工具」/「选记忆」明细都不会改变弹窗尺寸或元素顺序。
           */
          function archiveNode() {
            if (!modal || modal.type !== 'scene-archive') return null
            var main = React.createElement(Modal, { key: 'sarch', wide: true, className: 'dsm-modal-archive', title: t('memory.archive.title') + ' · ' + (modal.name === '' ? t('memory.scene.global') : modal.name), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('div', { className: 'dsm-archive-meta' },
                  React.createElement('span', null, t('scenes.archive.summary', {
                    mcp: modal.sections.mcp ? Object.keys(modal.sections.mcp).length : 0,
                    skills: modal.sections.skills ? modal.sections.skills.length : 0,
                    subagents: modal.sections.subagents ? modal.sections.subagents.length : 0,
                  }))),
                // 三行条目塞不进单行元信息条：清单放到条外自成一行。
                helpBullets(t, 'scenes.archive.note'),
                mcpSeg(),
                skillsSeg(),
                subagentsSeg(),
                memoriesSeg(),
                React.createElement('div', { className: 'dsm-modal-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-primary', disabled: busy, onClick: submitArchive }, t('memory.archive.save')))))
            // MCP 服务器编辑弹窗渲染在外层：不能放进列表 Modal 的滚动容器里（会被裁掉）。
            var edit = modal.drill ? mcpEditNode() : null
            return edit ? React.createElement(React.Fragment, { key: 'sarch-wrap' }, main, edit) : main
          }
          function openDrill(server) {
            setModal(Object.assign({}, modal, { drill: server, drillError: null }))
            setDrillTools(null)
            apiCall('mcpm-tools', { serverName: server }).then(function (res) {
              if (res && res.ok) setDrillTools((res.tools || []).map(function (x) { return { key: server + '/' + x.name, short: x.name, enabled: x.enabled !== false } }))
              else setDrillTools([])
            }).catch(function () { setDrillTools([]) })
          }
          /** 从未运行过的服务器：临时启动枚举工具（后端会轮询并在完成后恢复原启停状态）。 */
          function probeMcpTools() {
            var server = modal.drill
            setDrillTools(null)
            apiCall('mcpm-tools-refresh', { serverName: server }).then(function (res) {
              if (res && res.ok) setDrillTools((res.tools || []).map(function (x) { return { key: server + '/' + x.name, short: x.name, enabled: x.enabled !== false } }))
              else { setDrillTools([]); setModal(Object.assign({}, modal, { drillError: res && res.error ? String(res.error) : '' })) }
            }).catch(function (e) { setDrillTools([]); setModal(Object.assign({}, modal, { drillError: String((e && e.message) || e) })) })
          }
          function toggleDrillTool(server, short) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            var cur = mcp[server] === '*' ? (drillTools || []).filter(function (t) { return t.enabled }).map(function (t) { return t.short }) : (mcp[server] || []).slice()
            var i = cur.indexOf(short)
            if (i >= 0) cur.splice(i, 1); else cur.push(short)
            mcp[server] = cur
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          function submitArchive() {
            if (!modalSections()) return
            setBusy(true)
            // P5：档案里**不再写 memories 段** —— 记忆的开关是 `rules[*].enabled` 单一真相源，
            // 在段里勾选时已经即时提交了，这里没有「待保存」的记忆状态。
            apiCall('scene-archive-save', { scene: modal.name, archive: (function () { var payload = {}; if (modal.sections.mcp) payload.mcp = modal.sections.mcp; if (modal.sections.mcpNotes) payload.mcpNotes = modal.sections.mcpNotes; if (modal.sections.skills) payload.skills = modal.sections.skills; if (modal.sections.subagents) payload.subagents = modal.sections.subagents; return payload })() }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                // 当前模式的档案保存后**就地生效**；运行时没应用成功要如实说（别假装生效了）。
                var applyNote = res.applyError ? ' · ' + t('memory.archive.applyFailed', { reason: res.applyError }) : ''
                setResult({ ok: !res.applyError, text: t('memory.result.archiveSaved', { name: modal.name }) + (res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : '') + applyNote })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          // 「进入某个场景」= 应用它的档案 + 启用它（单选），于是它的记忆与绑定的提示词
          // 一起生效——用户裁定：「进入其中一个场景，提示词就启动成场景的设置的」。
          function enterMode(name) {
            setBusy(true)
            apiCall('scene-mode-set', { scene: name }).then(function (res) {
              if (!res || !res.ok) { setBusy(false); setResult({ ok: false, text: translateError(t, res) }); return }
              apiCall('rules-set-active', { scenes: [name] }).then(function (act) {
                setBusy(false)
                var staleNote = res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : ''
                // 如实报「上层切了几台服务器 / 几个来源」——否则用户不知道勾选到底生效没有。
                var switchNote = res.switched && (res.switched.mcpServers || res.switched.skillSources)
                  ? ' · ' + t('memory.result.modeSwitched', { mcp: res.switched.mcpServers, skills: res.switched.skillSources })
                  : ''
                if (act && act.ok) setResult({ ok: true, text: t('memory.result.modeSet', { name: name }) + switchNote + staleNote })
                else setResult({ ok: false, text: t('memory.result.modeSet', { name: name }) + switchNote + staleNote + ' · ' + translateError(t, act) })
                refresh(true)
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          /**
           * 退出模式（P6）：与开关**同一条路径** —— 恢复档案 + 取消场景启用，两者一起写。
           * 顶部横幅的「退出模式」按钮和卡片开关点它，效果完全一致（用户裁定：「是真的退出了」）。
           */
          function exitMode() {
            setBusy(true)
            apiCall('scene-mode-set', { scene: null }).then(function (res) {
              if (!res || !res.ok) { setBusy(false); setResult({ ok: false, text: translateError(t, res) }); return }
              // 档案已恢复 → 同步取消场景启用，保证 mode.scene 与 active 恒等。
              apiCall('rules-set-active', { scenes: [] }).then(function (act) {
                setBusy(false)
                if (act && act.ok) setResult({ ok: true, text: t('memory.result.modeExited') })
                else setResult({ ok: false, text: t('memory.result.modeExited') + ' · ' + translateError(t, act) })
                refresh(true)
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          var modeScene = data.mode && data.mode.scene
          // 历史「全部启用」遗留检测：单选模型下同时启用多个场景是歧义状态（见下方收敛条）。
          var legacyAllScenes = (data.scenes || []).filter(function (s) { return s.active === true && !s.shared && !s.global })
          /**
           * 场景页只列**可切换的预设场景**：保留场景 `global`（「全局」）不在这里出现。
           *
           * 用户裁定：「全局记忆都不用设置场景就能注入上下文，如果我需要设置 skills、mcp，我直接去具体页
           * 设置就好了，所以说场景不需要展示全局，不需要设置全局，只有有特定需求才需要设置专门的场景。」
           * —— 全局不是预设而是恒定基线，列成卡片只会让人以为它可启停/可切换；它的记忆在「记忆」页照常
           * 管理，档案弹窗「记忆」段与各种场景选择器也照常保留全局（否则全局记忆在界面上就没有落点了）。
           * 过滤只做在这一页：宿主回传的 `scenes` 仍含全局，记忆页与选择器都依赖它。
           */
          var presetScenes = (data.scenes || []).filter(function (s) { return s.global !== true })
          // 与 MCP / 技能页同构的三格统计（页面之间「头顶长什么样」保持一致）——同样只数可见的预设场景。
          var sceneStats = (function () {
            var own = presetScenes
            return {
              total: own.length,
              active: own.filter(function (s) { return s.active === true }).length,
              archives: own.filter(function (s) { return !!data.archives[s.name] }).length,
            }
          })()
          /**
           * 档案里已配的东西，一行摘要（没绑的域不出现）。
           *
           * 它只出现在页首的「当前模式」条上：卡片上不再挂任何数量——那正是「卡片又乱又挤」
           * 的来源。全页只有这一处回答「当前生效的配置是什么」。
           */
          function archiveSummary(archive) {
            if (!archive) return ''
            var parts = []
            if (archive.mcp) parts.push(t('scenes.profile.mcp', { count: Object.keys(archive.mcp).length }))
            if (Array.isArray(archive.skills)) parts.push(t('scenes.profile.skills', { count: archive.skills.length }))
            if (Array.isArray(archive.subagents)) parts.push(t('scenes.profile.subagents', { count: archive.subagents.length }))
            // P5：记忆**不再是档案的一部分**（开关是 `rules[*].enabled` 单一真相源），
            // 所以这里不再统计 memories —— 否则会显示一个已经不存在的段的数量。
            return parts.join(' · ')
          }
          // 当前模式场景被锁 → 「退出模式」按钮与开关一起禁用（服务端守卫兜底）。
          var modeSceneLocked = !!(modeScene && (data.scenes || []).some(function (s) { return s.name === modeScene && s.locked === true }))
          var modeSummary = modeScene ? archiveSummary(data.archives[modeScene]) : ''
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('scenes.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('scenes.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openCreateScene }, t('memory.btn.newScene')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            React.createElement('div', { key: 'stats', className: 'dsm-summary' },
              [[sceneStats.total, t('scenes.stat.total')], [sceneStats.active, t('scenes.stat.active')], [sceneStats.archives, t('scenes.stat.archives')]].map(function (item) {
                return React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1])
              })),
            // 当前模式条：**只在真的进入了模式时才出现**。
            // 以前没有模式时也常驻一条「自由模式 + 一句解释」，用户反馈「这个是干什么的，感觉没什么用」——
            // 静态解释占一整条，而「没有条 = 没有模式」本来就不言自明。现在它只承载有状态的信息：
            // 哪个场景是当前模式、它包含什么档案、怎么退出。
            modeScene ? React.createElement('div', { key: 'mode', className: 'dsm-mode-bar' },
              React.createElement('span', { className: 'dsm-mode-dot' }),
              React.createElement('div', { className: 'dsm-mode-main' },
                React.createElement('div', { className: 'dsm-mode-title' },
                  t('scenes.mode.active', { name: sceneLabel(data.scenes, modeScene) || modeScene })),
                React.createElement('div', { className: 'dsm-mode-sub' },
                  modeSummary ? t('scenes.mode.profile', { parts: modeSummary }) : t('scenes.mode.noProfile'))),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || modeSceneLocked, title: modeSceneLocked ? t('scenes.lock.blockedExit') : '', onClick: exitMode }, t('memory.mode.exit'))) : null,
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            // 历史「全部启用」（active=null）遗留：单选模型下多名场景同时在场是歧义状态。
            // 不静默改写（那会改变注入范围），而是给一个显式收敛按钮，并说清点下去会发生什么。
            legacyAllScenes.length > 1 ? React.createElement('div', { key: 'legacyall', className: 'dsm-feedback dsm-warning' },
              React.createElement('span', null, t('scenes.legacyAll', { count: legacyAllScenes.length })),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { enterMode(legacyAllScenes[0].name) } }, t('scenes.legacyAll.fix'))) : null,
            data.error ? React.createElement('div', { key: 'gerr', className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading && !presetScenes.length ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : presetScenes.length ? React.createElement('div', { key: 'scenes', className: 'dsm-scenes', ref: flipRef }, enabledFirst(presetScenes, function (scene) { return scene.active === true; }).map(function (scene) {
                var name = scene.name
                var label = sceneLabel(data.scenes, name) || name
                var archive = data.archives[name]
                // 全局已被上面的 presetScenes 过滤掉，这里只会遇到可切换的预设；
                // 历史保留场景 `_shared`（「常开」）仍然恒定注入，所以不给开关也不给删除。
                var locked = scene.shared === true
                var sceneLocked = scene.locked === true
                // 档案里有任何一段才值得「切入此模式」——空档案切进去等于什么都没变。
                var desc = sceneTileDesc(scene)
                // 单选：别的场景已启用时，这个开关置灰（点也没用，服务端只接受一个）。
                var blockedByOther = scene.active !== true && scene.selectable === false
                // 绑定的提示词预设：生效中 / 已启用但预设不见了 / 绑了但没启用，三种如实分开。
                var boundPrompt = scene.prompt || ''
                var promptLive = !!(boundPrompt && data.scenePrompt && data.scenePrompt.scene === name)
                var promptMissing = promptLive && data.scenePrompt.missing === true
                // 生效中但 AGENTS.md 里不是它（被手动改过？）——「显示必须等于实际注入」，
                // 不一致就如实标出来，别让用户以为文件里就是它。
                var promptMismatch = promptLive && !promptMissing && data.scenePrompt.duplicate !== true
                return React.createElement('article', { key: 's:' + name, className: 'dsm-scene-tile' + (modeScene === name ? ' dsm-scene-tile-mode' : ''), 'data-flip-key': 's:' + name, 'data-flip-on': scene.active === true ? '1' : '0' },
                  React.createElement('div', { className: 'dsm-scene-tile-head' },
                    React.createElement('span', { className: 'dsm-scene-tile-name', title: label }, label),
                    // 显示名与磁盘目录名不同时才标出真名，方便对文件核对。
                    name === label ? null : React.createElement('span', { className: 'dsm-scene-tile-key' }, name),
                    locked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                    modeScene === name ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.mode.current')) : null,
                    sceneLocked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('scenes.lock.tag')) : null,
                    !locked && scene.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null,
                    boundPrompt ? React.createElement('span', {
                      className: 'dsm-tag' + (promptMissing ? ' dsm-tag-off' : promptLive ? ' dsm-tag-on' : ''),
                      title: promptMismatch ? t('scenes.prompt.mismatch.hint', { id: boundPrompt }) : t('scenes.prompt.tag.hint'),
                    }, promptMissing
                      ? t('scenes.prompt.missing', { id: boundPrompt })
                      : promptLive ? t('scenes.prompt.live', { id: boundPrompt }) : t('scenes.prompt.bound', { id: boundPrompt })) : null,
                    promptMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.prompt.mismatch.hint', { id: boundPrompt }) }, t('agm.file.mismatch')) : null,
                    locked ? null : React.createElement('span', {
                      className: 'dsm-scene-tile-switch',
                      title: blockedByOther ? t('scenes.enable.blocked', { name: sceneLabel(data.scenes, data.activeScene) || data.activeScene || '' }) : (sceneLocked && scene.active === true ? t('scenes.lock.blockedExit') : ''),
                    }, React.createElement(Switch, { on: scene.active === true, disabled: busy || blockedByOther || (sceneLocked && scene.active === true), label: t('memory.scene.enable') + ' ' + name, onClick: function () { toggleScene(scene) } })),
                    locked ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-lock', disabled: busy || scene.active !== true, title: scene.active !== true ? t('scenes.lock.notActive') : t('scenes.lock.hint'), onClick: function () { toggleSceneLock(scene) } }, sceneLocked ? t('scenes.lock.unlock') : t('scenes.lock.lock'))),
                  // 描述行**只有描述**（数量都收进上面的模式条了）；全文放 title，卡片本身永远一行。
                  React.createElement('p', { className: 'dsm-scene-tile-desc', title: desc || '' }, desc || t('scenes.noDesc')),
                  // P6：「切入此模式」按钮已删除 —— 右上角开关就是唯一入口（开 = 进入，关 = 回全局默认）。
                  React.createElement('div', { className: 'dsm-scene-tile-foot' },
                    React.createElement('div', { className: 'dsm-scene-tile-links' },
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : '', onClick: function () { openArchive(name) } }, t('memory.archive.edit')),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openEditScene(scene) } }, t('memory.scene.edit')),
                      locked ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : '', onClick: function () { setModal({ type: 'scene-delete', name: name }) } }, t('memory.btn.deleteScene')))))
              })) : React.createElement('div', { key: 'empty', className: 'dsm-empty' }, t('scenes.empty')),
            modal && (modal.type === 'scene-create' || modal.type === 'scene-edit') ? React.createElement(Modal, { key: 'screate', title: modal.type === 'scene-create' ? t('memory.scene.createTitle') : t('memory.scene.editTitle'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.name')),
                  React.createElement('input', {
                    className: 'dsm-control' + (sceneForm.error ? ' dsm-rule-invalid' : ''),
                    value: sceneForm.name || '',
                    placeholder: t('memory.scene.field.name.placeholder'),
                    onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { name: e.target.value, error: null })) },
                  }),
                  React.createElement('p', { className: sceneForm.error ? 'dsm-rule-hint' : 'dsm-help' }, sceneForm.error || (modal.type === 'scene-create' ? t('memory.scene.field.name.hint') : t('memory.scene.field.name.lock')))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('div', { className: 'dsm-budget-meta' },
                    React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.desc')),
                    // 与描述行一一对应的字数上限：卡片只显示一行，超长的描述会把卡片撑成纵向。
                    React.createElement('span', { className: 'dsm-char-count' }, String(String(sceneForm.description || '').length) + '/' + SCENE_DESC_MAX)),
                  React.createElement('input', {
                    className: 'dsm-control',
                    value: sceneForm.description || '',
                    maxLength: SCENE_DESC_MAX,
                    placeholder: t('memory.scene.field.desc.placeholder'),
                    onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { description: e.target.value, error: null })) },
                  }),
                  React.createElement('p', { className: 'dsm-help' }, t('scenes.field.desc.limit', { count: SCENE_DESC_MAX }))),
                // 提示词预设：一个场景**只能绑一个**（单值字段天然单选）；「不绑定」= 解绑。
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('scenes.field.prompt')),
                  presetOptions.length > 0
                    ? React.createElement(SourceSelect, { options: presetOptions, value: sceneForm.prompt || '', onChange: function (v) { setSceneForm(Object.assign({}, sceneForm, { prompt: v })) } })
                    : React.createElement('p', { className: 'dsm-help' }, t('scenes.prompt.noPresets')),
                  helpBullets(t, 'scenes.field.prompt.hint')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || !String(sceneForm.name || '').trim(), onClick: submitSceneForm }, t(modal.type === 'scene-create' ? 'memory.btn.create' : 'memory.btn.saveScene'))))) : null,
            modal && modal.type === 'scene-delete' ? React.createElement(Modal, { key: 'sdel', title: t('memory.deleteScene.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.deleteScene.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDeleteScene(modal.name) } }, t('memory.btn.deleteScene')))) : null,
            // 档案编辑器（见 archiveNode）：三段共用「段卡片 + 勾选行」排版。
            archiveNode(),
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              groupTitle: t('trash.group.scenes'),
              groupSub: t('trash.section.scenes.sub'),
              entries: trash.entries,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restoreScene,
              onPurge: purgeScene,
            }) : null,
          )
        }
        // ---------- 子智能体页：人设文件（~/.dsh/subagents/*.md）管理 ----------
        function SubagentsPage() {
          var state = React.useState({ loading: true, error: null, subagents: [] })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          // 场景锁定（v0.8）：任一场景锁定 = 五个域整体冻结；本页全部写控件禁用。
          var anyLocked = data.anyLocked === true
          // 场景内开关由档案定义：人设开关置灰（要改就去场景页的档案编辑器里改）。
          var sceneName = data.activeScene || null
          // 回收站：删除人设 = 移入回收站（宿主侧 subagent-delete），这里列出/恢复/永久删除。
          var ts = React.useState(null)
          var trash = ts[0], setTrash = ts[1]
          var tb = React.useState(false)
          var trashBusy = tb[0], setTrashBusy = tb[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          function loadTrash(keepOpen) {
            setTrash(Object.assign({ loading: true, error: null, entries: [] }, keepOpen ? trash || {} : {}))
            apiCall('subagent-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.trash || [] })
              else setTrash({ loading: false, error: (res && res.error) || t('trash.loadFailed'), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: String((e && e.message) || e), entries: [] }) })
          }
          function restorePersona(item) {
            setTrashBusy(true)
            apiCall('subagent-trash-restore', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.restored', { name: item.name }) }); refresh(true); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          function purgePersona(item) {
            setTrashBusy(true)
            apiCall('subagent-trash-delete', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.purged', { name: item.name }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: String((e && e.message) || e) }) }) })
          }
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('subagent-list', {}).then(function (r) {
              if (r && r.ok) setData({ loading: false, error: null, subagents: r.subagents || [], anyLocked: r.anyLocked === true })
              else setData({ loading: false, error: translateError(t, r), subagents: [] })
            }).catch(function (e) { setData({ loading: false, error: String((e && e.message) || e), subagents: [] }) })
          }
          React.useEffect(function () { refresh() }, [])
          /**
           * 子智能体开关（与记忆页同一套交互）：停用 = 不注入目录段、subagent_manager_list/run
           * 不可见；人设文件不动。开关联动全局状态，立即提交。
           */
          function togglePersona(p) {
            var next = !(p.enabled !== false)
            setBusy(true)
            apiCall('subagent-toggle', { name: p.name, enabled: next }).then(function (r) {
              setBusy(false)
              if (r && r.ok) {
                // 场景内改开关：人设改了、档案没跟上时说清楚（详见 sceneSyncWarn）。
                var warn = sceneSyncWarn(t, r)
                setResult(warn ? { ok: false, warning: true, text: warn } : null)
                refresh(true)
              } else if (r) setResult({ ok: false, text: translateError(t, r) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          /**
           * 人设表单的候选数据（模型目录 / 全体预设工具并集）只在**首次展开高级选项**时拉取：
           * 宿主枚举预设需要为尚未挂载的预设建立 standing mount，不该在打开弹窗时就付这个代价。
           */
          var cands = React.useState({ loaded: false, loading: false, error: null, models: [], tools: [], presets: [] })
          var cand = cands[0], setCand = cands[1]
          function loadCandidates() {
            if (cand.loaded || cand.loading) return
            setCand(Object.assign({}, cand, { loading: true, error: null }))
            Promise.all([apiCall('model-candidates', {}), apiCall('preset-tools', {})]).then(function (rs) {
              var mres = rs[0], tres = rs[1]
              var failed = (!mres || mres.ok === false) && (!tres || tres.ok === false)
              setCand({
                loaded: true, loading: false,
                error: failed ? t('subagents.adv.loadFailed') : null,
                models: (mres && mres.models) || [],
                tools: (tres && tres.tools) || [],
                // presets 必须原样带过来：四行模式的名字、顺序、每行的工具清单全靠它，
                // 早先这里只留 models/tools，于是分组标题退回裸 id（中文界面里显示英文）。
                presets: (tres && tres.presets) || [],
              })
            }).catch(function (e) {
              setCand({ loaded: true, loading: false, error: String((e && e.message) || e), models: [], tools: [], presets: [] })
            })
          }
          /** 高级选项：默认收起；已经在用模型/工具限制的人设自动展开（否则用户看不见自己配了什么）。 */
          /** 「不限制嵌套」的取值（与 src/subagents/service.ts 的 UNLIMITED_PERSONA_CATALOG_DEPTH 同值）。 */
          var CATALOG_DEPTH_UNLIMITED = 99
          /** 目录注入深度的选项文案：下拉与折叠摘要共用一处，免得两处说法分叉。 */
          function catalogDepthLabel(n) {
            if (n === 1) return t('subagents.field.catalogDepth.onlyTop')
            if (n === 2) return t('subagents.field.catalogDepth.toChild')
            if (n >= CATALOG_DEPTH_UNLIMITED) return t('subagents.field.catalogDepth.unlimited')
            return t('subagents.field.catalogDepth.toGrand')
          }
          function initialAdvanced(p) {
            var modes = p && p.toolsByPreset ? Object.keys(p.toolsByPreset).length : 0
            // 目录注入深度不是默认值（1）时也算"配过"：它决定常驻目录出现在哪些会话，
            // 藏起来会让"为什么子会话看不到目录"变得无从查起。
            var budget = !!(p && typeof p.catalogDepth === 'number' && p.catalogDepth !== 1)
            return !!(budget || (p && (p.model || p.provider)) || (p && ((p.tools || []).length || (p.toolsDeny || []).length || modes)))
          }
          /** 编辑态里按模式分组的名单（深拷贝：取消编辑不留痕）。 */
          function cloneRules(source) {
            var out = {}
            Object.keys(source || {}).forEach(function (id) {
              var rule = source[id] || {}
              out[id] = { mode: rule.mode === 'deny' ? 'deny' : 'allow', names: (rule.names || []).slice() }
            })
            return out
          }
          function openEditor(name) {
            if (!name) {
              setModal({ type: 'editor', mode: 'create', advanced: false, openMode: null, stoppedRules: {}, modeQuery: '', legacyTarget: '', form: { name: '', description: '', provider: '', model: '', catalogDepth: 1, tools: [], toolsDeny: [], toolsByPreset: {}, body: '', output: '', error: null } })
              return
            }
            setBusy(true)
            apiCall('subagent-get', { name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                var p = res.persona || {}
                var advanced = initialAdvanced(p)
                setModal({ type: 'editor', mode: 'edit', originalName: String(p.name || name), advanced: advanced, openMode: null, stoppedRules: {}, modeQuery: '', legacyTarget: '', form: {
                  name: p.name || name, description: p.description || '', provider: p.provider || '', model: p.model || '',
                  // 服务端回的是**生效值**（没写就是默认 1），所以这里不必再兜默认。
                  catalogDepth: typeof p.catalogDepth === 'number' ? p.catalogDepth : 1,
                  tools: (p.tools || []).slice(), toolsDeny: (p.toolsDeny || []).slice(),
                  toolsByPreset: cloneRules(p.toolsByPreset), body: p.body || '', output: p.output || '', error: null,
                } })
                // 已配过限制的人设**一打开就是展开的**（initialAdvanced）→ 候选数据必须在这里也拉，
                // 否则四行模式先亮"宿主没有回传预设名单"，非得点两次「高级选项」才补上（用户实测）。
                if (advanced) loadCandidates()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function setForm(patch) { if (modal && modal.type === 'editor') setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, patch) })) }
          /** 列表里增删一项（勾选语义：存在 = 勾上）。 */
          function toggled(list, name) {
            var next = (list || []).slice()
            var i = next.indexOf(name)
            if (i >= 0) next.splice(i, 1); else next.push(name)
            return next
          }
          /**
           * 模型下拉的当前值。
           * 宿主目录里有这对 (provider, model) → 用它；只有 model 没有 provider（跨来源手工填的）
           * 或目录里没有 → 走「自定义」，同时把输入框露出来，避免把用户已配好的值悄悄改掉。
           */
          function modelSelectValue() {
            if (!modal || modal.type !== 'editor') return ''
            var f = modal.form
            if (!f.model) return ''
            var hit = (cand.models || []).filter(function (m) { return m.provider === f.provider && m.id === f.model })[0]
            return hit ? (f.provider + '\u0000' + f.model) : '__custom__'
          }
          /**
           * 官方四个预设的中英名走插件词典（官方 preset.yml 里只有中文名，直接用会让英文界面
           * 露出中文）；**自建预设用它自己的名字，不翻译** —— 与官方 display 规则一致。
           * 四个预设 id → 词典键的映射只认官方发布的这四个 id。
           */
          var SHIPPED_PRESET_IDS = { minimal: 1, standard: 1, ptc: 1, cordis: 1 }
          function presetLabel(p) {
            if (!p) return ''
            var id = String(p.id || '')
            if (SHIPPED_PRESET_IDS[id] === 1 && String(p.trust || 'system') !== 'user') return t('preset.name.' + id)
            return String(p.name || id)
          }
          /** 该模式下可勾选的工具名；`null` = 宿主没给出该模式的清单（读不到，不能假装是空）。 */
          function modeTools(id) {
            var hit = (cand.presets || []).filter(function (p) { return p.id === id })[0]
            return hit && Array.isArray(hit.tools) ? hit.tools : null
          }
          function modeRule(id) { return (modal.form.toolsByPreset || {})[id] }
          function setModeRule(id, rule) {
            var next = Object.assign({}, modal.form.toolsByPreset || {})
            if (rule) next[id] = rule; else delete next[id]
            setModal(Object.assign({}, modal, {
              form: Object.assign({}, modal.form, { toolsByPreset: next }),
              openMode: modal.openMode === id && !rule ? null : modal.openMode,
            }))
          }
          /** 模式行上的一句话状态：未开启 / 白名单 N 个 / 黑名单 N 个 / 已开启但没勾（= 不限制）。 */
          function modeSummary(id) {
            var rule = modeRule(id)
            if (!rule) return { text: t('subagents.mode.off'), cls: 'dsm-mode-off' }
            var n = (rule.names || []).length
            if (!n) return { text: t('subagents.mode.empty'), cls: 'dsm-mode-off' }
            return {
              text: t(rule.mode === 'deny' ? 'subagents.mode.denyOn' : 'subagents.mode.allowOn', { count: n }),
              cls: rule.mode === 'deny' ? 'dsm-mode-deny' : 'dsm-mode-allow',
            }
          }
          /**
           * 启动某一侧名单：生效 + 就地展开。同一模式内白/黑互斥 —— 启动一侧就把模式切过去，
           * **已勾选的名字保留**（只换语义），这样"改成黑名单"不用从头再勾一遍。
           */
          function startMode(id, mode) {
            // 刚被「关闭」掉的名字记在 stoppedRules 里：重新启用时带回，免得"关一下再开"把
            // 已勾好的名单清空（用户实测踩到：以为「关闭白名单」是收起设置，再启用就空了）。
            var prev = modeRule(id) || (modal.stoppedRules || {})[id]
            var names = prev && Array.isArray(prev.names) ? prev.names.slice() : []
            setModal(Object.assign({}, modal, {
              openMode: id, modeQuery: '',
              form: Object.assign({}, modal.form, {
                toolsByPreset: Object.assign({}, modal.form.toolsByPreset || {}, { [id]: { mode: mode, names: names } }),
              }),
            }))
          }
          function stopMode(id) {
            var prev = modeRule(id)
            var stopped = Object.assign({}, modal.stoppedRules || {})
            if (prev) stopped[id] = { mode: prev.mode, names: (prev.names || []).slice() }
            var next = Object.assign({}, modal.form.toolsByPreset || {})
            delete next[id]
            setModal(Object.assign({}, modal, {
              stoppedRules: stopped,
              openMode: modal.openMode === id ? null : modal.openMode,
              form: Object.assign({}, modal.form, { toolsByPreset: next }),
            }))
          }
          function toggleModeTool(id, name) {
            var rule = modeRule(id)
            if (!rule) return
            setModeRule(id, { mode: rule.mode, names: toggled(rule.names || [], name) })
          }
          /**
           * 展开后的勾选区：只列**该模式自己的**工具。这样勾出来的名字天然都属于这个预设，
           * 不会出现"在标准模式勾了只属于 PTC 的工具 → 换模式跑就启动失败"。
           * MCP 工具不在这里（用户裁定）：子代理照旧能用当前在跑的 MCP，那份名单在运行时并入。
           */
          function modeEditor(p) {
            var id = p.id
            var rule = modeRule(id)
            if (!rule) return null
            var all = modeTools(id)
            if (all === null || all.length === 0) {
              return React.createElement('div', { className: 'dsm-mode-body' },
                React.createElement('div', { className: 'dsm-pick-empty' }, p.broken ? t('subagents.mode.broken') : t('subagents.mode.noTools')))
            }
            var q = String(modal.modeQuery || '').trim().toLowerCase()
            var list = q ? all.filter(function (n) { return n.toLowerCase().indexOf(q) >= 0 }) : all
            var picked = rule.names || []
            // 与其余「全选」同一口径：全勾了就只给「取消全选」（二合一，不并列）。
            var allPickedAll = all.length > 0 && all.every(function (n) { return picked.indexOf(n) >= 0 })
            return React.createElement('div', { className: 'dsm-mode-body' },
              picked.length
                ? React.createElement('div', { className: 'dsm-tools-chips' }, picked.map(function (name) {
                    return React.createElement('span', { key: 'c:' + name, className: 'dsm-chip' + (rule.mode === 'deny' ? ' dsm-chip-deny' : '') },
                      name,
                      React.createElement('button', { type: 'button', title: t('subagents.tools.remove'), onClick: function () { toggleModeTool(id, name) } }, '×'))
                  }))
                : React.createElement('span', { className: 'dsm-adv-note' }, t(rule.mode === 'deny' ? 'subagents.mode.denyEmpty' : 'subagents.mode.allowEmpty')),
              React.createElement('div', { className: 'dsm-combo-row' },
                React.createElement('input', {
                  className: 'dsm-control',
                  value: modal.modeQuery || '',
                  placeholder: t('subagents.tools.filter'),
                  onChange: function (e) { setModal(Object.assign({}, modal, { modeQuery: e.target.value })) },
                }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy, onClick: function () { setModeRule(id, { mode: rule.mode, names: allPickedAll ? [] : all.slice() }) } }, bulkPair(allPickedAll ? t('bulk.unselectAll') : t('bulk.selectAll'), allPickedAll ? t('bulk.selectAll') : t('bulk.unselectAll')))),
              list.length
                ? React.createElement('div', { className: 'dsm-tools-grid' }, list.map(function (name) {
                    return pickRow({ key: 'm:' + id + ':' + name, disabled: busy, checked: picked.indexOf(name) >= 0, name: name, onChange: function () { toggleModeTool(id, name) } })
                  }))
                : React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mem.noMatch')))
          }
          /**
           * 工具限制的两段说明：先「哪一行生效」，再白/黑名单语义。
           * 两段是同一件事的两半，紧贴成一块 —— 分开渲染时中间隔着 12px 空行（用户 2026-09-18 指出）；
           * 后一段按条目清单渲染（一条一行，见 helpBullets）。
           */
          function modeNotes() {
            return React.createElement('div', null,
              React.createElement('p', { className: 'dsm-help' }, t('subagents.field.modes.hint')),
              helpBullets(t, 'subagents.adv.note'))
          }
          /**
           * 一行一个 Agent 预设（roster 顺序：标准 / PTC / 极简 / 创造 / 自建预设）。
           * 默认全部折叠、全部未启动；右侧两个按钮「启动 白名单」「启动 黑名单」互斥。
           */
          function modeRows() {
            var presets = (cand.presets || []).slice()
            if (!presets.length) {
              return React.createElement('div', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('subagents.field.modes')),
                React.createElement('div', { className: 'dsm-pick-empty' }, cand.loading ? t('memory.loading') : t('subagents.mode.noPresets')),
                modeNotes())
            }
            return React.createElement('div', { className: 'dsm-field' },
              React.createElement('span', { className: 'dsm-label' }, t('subagents.field.modes')),
              React.createElement('div', { className: 'dsm-modes' }, presets.map(function (p) {
                var id = p.id
                var rule = modeRule(id)
                var summary = modeSummary(id)
                var startButton = function (mode, isDeny) {
                  var active = !!rule && rule.mode === mode
                  return React.createElement('button', {
                    key: mode,
                    type: 'button',
                    className: 'dsm-btn dsm-btn-quiet' + (active ? (mode === 'deny' ? ' dsm-mode-btn-deny' : ' dsm-mode-btn-allow') : ''),
                    disabled: busy,
                    onClick: function () { if (active) stopMode(id); else startMode(id, mode) },
                  }, t(active
                    ? (isDeny ? 'subagents.mode.stopDeny' : 'subagents.mode.stopAllow')
                    : (isDeny ? 'subagents.mode.startDeny' : 'subagents.mode.startAllow')))
                }
                var open = modal.openMode === id
                return React.createElement('div', { className: 'dsm-mode-row' + (rule ? ' dsm-mode-on' : ''), key: id },
                  React.createElement('div', { className: 'dsm-mode-head' },
                    // 行首按钮 = 展开 / 收起名单（用户实测：已配好的模式只有「关闭白名单」可点，
                    // 点下去是把模式停掉、名单设置再也进不去 —— 查看/编辑与启用/停用必须分开）。
                    React.createElement('button', {
                      type: 'button',
                      className: 'dsm-mode-head-main',
                      disabled: !rule,
                      title: rule ? t('subagents.mode.toggleHint') : '',
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: function () {
                        setModal(Object.assign({}, modal, { openMode: open ? null : id, modeQuery: '' }))
                      },
                    },
                      React.createElement('span', { className: 'dsm-mode-caret', 'aria-hidden': 'true' }, rule ? (open ? '▾' : '▸') : ''),
                      React.createElement('span', { className: 'dsm-mode-name' }, presetLabel(p)),
                      p.broken ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('compat.reach.broken')) : null,
                      React.createElement('span', { className: 'dsm-mode-sum ' + summary.cls }, summary.text)),
                    React.createElement('span', { className: 'dsm-mode-actions' },
                      startButton('allow', false),
                      startButton('deny', true))),
                  open ? modeEditor(p) : null)
              })),
              modeNotes())
          }
          /**
           * 旧格式（全局 `tools:` / `toolsDeny:`）的只读小结 + 转换入口。
           * 旧键对所有模式生效，运行时仍然照旧执行；**不点转换就不动文件里的旧键**。
           */
          function legacyNotice() {
            var allow = modal.form.tools || []
            var deny = modal.form.toolsDeny || []
            if (!allow.length && !deny.length) return null
            var presets = cand.presets || []
            var target = modal.legacyTarget || (presets[0] ? presets[0].id : '')
            return React.createElement('div', { className: 'dsm-legacy' },
              React.createElement('span', { className: 'dsm-adv-note' }, t('subagents.legacy.note', { allow: allow.length, deny: deny.length })),
              React.createElement('div', { className: 'dsm-combo-row' },
                React.createElement('div', { className: 'dsm-select' },
                  React.createElement('select', {
                    className: 'dsm-control',
                    value: target,
                    disabled: busy || !presets.length,
                    onChange: function (e) { setModal(Object.assign({}, modal, { legacyTarget: e.target.value })) },
                  }, presets.map(function (p) { return React.createElement('option', { key: p.id, value: p.id }, presetLabel(p)) }))),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || !target || !presets.length, onClick: function () {
                  var rule = { mode: allow.length ? 'allow' : 'deny', names: (allow.length ? allow : deny).slice() }
                  setModal(Object.assign({}, modal, {
                    openMode: target,
                    modeQuery: '',
                    legacyTarget: target,
                    form: Object.assign({}, modal.form, {
                      tools: [], toolsDeny: [],
                      toolsByPreset: Object.assign({}, modal.form.toolsByPreset || {}, { [target]: rule }),
                    }),
                  }))
                } }, t('subagents.legacy.convert'))),
              React.createElement('p', { className: 'dsm-help' }, t('subagents.legacy.hint')))
          }
          function toggleAdvanced() {
            if (!modal || modal.type !== 'editor') return
            var next = !modal.advanced
            setModal(Object.assign({}, modal, { advanced: next }))
            if (next) loadCandidates()
          }
          function submitEditor() {
            if (!modal || modal.type !== 'editor') return
            setBusy(true)
            var op = modal.mode === 'create' ? 'subagent-create' : 'subagent-update'
            // 编辑时名字可改：nextName 只在真的改过时才传（服务端按原名定位文件）。
            var renamed = modal.mode === 'edit' && modal.originalName && modal.originalName !== modal.form.name
            apiCall(op, {
              name: renamed ? String(modal.originalName) : modal.form.name,
              ...(renamed ? { nextName: String(modal.form.name || '').trim() } : {}),
              description: modal.form.description,
              provider: modal.form.provider, model: modal.form.model,
              catalogDepth: modal.form.catalogDepth,
              // 旧格式的全局名单原样回写（旧键不点转换就不动），新模式名单另存一块。
              tools: modal.form.tools || [], toolsDeny: modal.form.toolsDeny || [],
              toolsByPreset: modal.form.toolsByPreset || {},
              body: modal.form.body,
              output: modal.form.output || '',
            }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setModal(null); setResult({ ok: true, text: t('subagents.result.saved', { name: modal.form.name }) }); refresh(true) }
              else setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, { error: translateError(t, res) }) }))
            }).catch(function (e) { setBusy(false); setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, { error: String((e && e.message) || e) }) })) })
          }
          function submitDelete(name) {
            setBusy(true)
            apiCall('subagent-delete', { name: name }).then(function (res) {
              setBusy(false); setModal(null)
              if (res && res.ok) { setResult({ ok: true, text: t('subagents.result.deleted', { name: name }) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          // ── 导入人设（.md / .zip，多选或拖入；同名跳过并报告）──
          function submitImport(files) {
            if (!files || !files.length) return
            setBusy(true)
            apiCall('subagent-import', { files: files }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                var names = res.imported || [], skipped = res.skipped || []
                var text = names.length ? t('subagents.result.imported', { count: names.length, names: names.join('、') }) : t('import.none')
                if (skipped.length) text += ' · ' + t('import.skipped', { items: skipped.map(function (s) { return s.name + '（' + s.reason + '）' }).join('；') })
                setResult({ ok: true, text: text }); refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('subagents.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('subagents.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { openEditor(null) } }, t('subagents.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { setResult(null); setModal({ type: 'import' }) } }, t('subagents.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || !data.subagents.length, onClick: function () { setResult(null); setModal({ type: 'export' }) } }, t('export.subagents')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            anyLocked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            sceneName ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scene.switch.banner', { scene: sceneName })) : null,
            React.createElement('div', { className: 'dsm-summary', style: { '--dsm-stat-cols': '2' } },
              [['total', data.subagents.length, t('subagents.stat.total')],
                ['limited', data.subagents.filter(function (p) { return (p.tools && p.tools.length) || (p.toolsDeny && p.toolsDeny.length) || (p.toolsByPreset && Object.keys(p.toolsByPreset).length) }).length, t('subagents.stat.limited')]].map(function (item) {
                return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                  React.createElement('strong', null, item[1]), item[2])
              })),
            React.createElement(Notice, { kind: result && result.warning ? 'warn' : result && result.ok ? 'ok' : 'err', text: result && result.text }),
            data.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading && !data.subagents.length ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : data.subagents.length ? React.createElement('div', { className: 'dsm-sources', ref: flipRef }, enabledFirst(data.subagents, function (p) { return p.enabled !== false; }).map(function (p) {
                return React.createElement('div', { key: p.name, className: 'dsm-source', 'data-flip-key': p.name, 'data-flip-on': p.enabled !== false ? '1' : '0' },
                  React.createElement('div', { className: 'dsm-source-head' },
                    React.createElement('div', { className: 'dsm-source-head-main' },
                      React.createElement('span', { className: 'dsm-source-title', title: p.name }, p.name),
                      React.createElement('span', { className: 'dsm-note' }, p.description || ''),
                      p.enabled === false ? React.createElement('span', { className: 'dsm-tag', title: t('subagents.disabled.hint') }, t('subagents.disabled')) : null),
                    React.createElement('div', { className: 'dsm-source-actions' },
                      React.createElement(Switch, { on: p.enabled !== false, disabled: busy || anyLocked, label: t('subagents.toggle') + ' ' + p.name, onClick: function () { togglePersona(p) } }),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || anyLocked, onClick: function () { openEditor(p.name) } }, t('memory.edit')),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || anyLocked, onClick: function () { setModal({ type: 'delete', name: p.name }) } }, t('memory.delete')))))
              })) : React.createElement('div', { className: 'dsm-empty' }, t('subagents.empty')),
            modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'sedit', wide: true, title: modal.mode === 'create' ? t('subagents.create') : t('subagents.edit') + ' · ' + modal.form.name, closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.name')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.name || '', placeholder: 'code-review', onChange: function (e) { setForm({ name: e.target.value }) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.description')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.description || '', placeholder: t('subagents.field.description.placeholder'), onChange: function (e) { setForm({ description: e.target.value }) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: modal.form.body || '', placeholder: t('subagents.field.body.placeholder'), onChange: function (e) { setForm({ body: e.target.value }) } })),
                // 输出要求（frontmatter `output:`，一条一行）：单独成节写进子代理的系统提示词。
                // 与正文分开是有意的 —— 正文是"这个角色是什么"（散文），这里放"产出必须长什么样"
                // （可检验的硬要求）。混在一起时散文会把硬要求稀释成风格提示（用户实测）。
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.output')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: modal.form.output || '', placeholder: t('subagents.field.output.placeholder'), onChange: function (e) { setForm({ output: e.target.value }) } }),
                  React.createElement('p', { className: 'dsm-help' }, t('subagents.field.output.hint'))),
                // ── 高级选项（默认收起）──
                // 模型 / 工具限制是「少数人才改」的字段，但一旦改错代价高（跨来源模型、工具名打错
                // 会让子代理直接启动失败）。所以：收起来但**有值就自动展开**，并把候选做成选择器。
                React.createElement('div', { className: 'dsm-adv' },
                  React.createElement('button', { type: 'button', className: 'dsm-adv-head', 'aria-expanded': modal.advanced === true, onClick: toggleAdvanced },
                    React.createElement('span', { className: 'dsm-adv-caret' }, modal.advanced ? '▼' : '▶'),
                    React.createElement('span', null, t('subagents.adv.title')),
                    React.createElement('span', { className: 'dsm-adv-note' },
                      modal.advanced ? '' : t('subagents.adv.summary', {
                        model: modal.form.model ? (modal.form.provider ? modal.form.provider + '/' + modal.form.model : modal.form.model) : t('subagents.adv.inherit'),
                        depth: catalogDepthLabel(typeof modal.form.catalogDepth === 'number' ? modal.form.catalogDepth : 1),
                        modes: Object.keys(modal.form.toolsByPreset || {}).length,
                        allow: (modal.form.tools || []).length,
                        deny: (modal.form.toolsDeny || []).length,
                      }))),
                  modal.advanced ? React.createElement('div', { className: 'dsm-adv-body' },
                    // 模型：宿主 LLM 目录里的 (provider, model) 对 + 自定义兜底。
                    React.createElement('div', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.model')),
                      React.createElement('div', { className: 'dsm-combo-row' },
                        React.createElement('div', { className: 'dsm-select' },
                          React.createElement('select', {
                            className: 'dsm-control',
                            value: modelSelectValue(),
                            disabled: busy || cand.loading,
                            onChange: function (e) {
                              var v = e.target.value
                              if (v === '') setForm({ provider: '', model: '' })
                              else if (v !== '__custom__') {
                                var parts = v.split('\u0000')
                                setForm({ provider: parts[0], model: parts[1] })
                              } else setForm({ model: modal.form.model || '' })
                            },
                          },
                            React.createElement('option', { value: '' }, t('subagents.model.inherit')),
                            (cand.models || []).map(function (m) {
                              return React.createElement('option', { key: m.provider + '/' + m.id, value: m.provider + '\u0000' + m.id }, m.provider + ' · ' + m.name)
                            }),
                            React.createElement('option', { value: '__custom__' }, t('subagents.model.customOption')))),
                        modelSelectValue() === '__custom__'
                          ? React.createElement('input', { className: 'dsm-control', value: modal.form.model || '', placeholder: t('subagents.field.model.placeholder'), onChange: function (e) { setForm({ model: e.target.value }) } })
                          : null),
                      React.createElement('p', { className: 'dsm-help' }, cand.loading ? t('memory.loading') : t('subagents.field.model.hint'))),
                    // provider 独立成一项：跨来源模型（如 sensenova）需要 provider+model 两个键同时给。
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.provider')),
                      React.createElement('input', { className: 'dsm-control', value: modal.form.provider || '', placeholder: t('subagents.field.provider.placeholder'), onChange: function (e) { setForm({ provider: e.target.value }) } }),
                      React.createElement('p', { className: 'dsm-help' }, t('subagents.field.provider.hint'))),
                    // 目录注入深度：人设目录注入到哪些会话（默认 1 = 只在顶层）。用下拉而不是数字
                    // 输入：只有 1/2/3 三个有意义的档，手写数字写错要到注入时才暴露。
                    //
                    // ⚠️ 它**不是**递归上限。2026-09-17 用户实测后改名（原名 maxDepth /「委派预算」）：
                    // 官方 `dsh-tool-subagent` 默认 `maxDepth: 3`，子代理本来就能继续嵌套，本插件
                    // 也不再向官方传 maxDepth。这个字段只决定常驻目录出现在哪些深度的会话里。
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.catalogDepth')),
                      React.createElement('div', { className: 'dsm-select' },
                        React.createElement('select', {
                          className: 'dsm-control',
                          value: String(typeof modal.form.catalogDepth === 'number' ? modal.form.catalogDepth : 1),
                          disabled: busy,
                          onChange: function (e) { setForm({ catalogDepth: Number(e.target.value) }) },
                        }, [1, 2, 3, CATALOG_DEPTH_UNLIMITED].map(function (n) {
                          // 选项文字不带序号：前面再加一个「2 ·」是同一件事说两遍（用户 2026-09-17
                          // 指出）。下拉的 value 仍是数字，存的还是 catalogDepth 本身。
                          return React.createElement('option', { key: n, value: String(n) }, catalogDepthLabel(n))
                        }))),
                      helpBullets(t, 'subagents.field.catalogDepth.hint')),
                    // 工具限制：按 Agent 预设一行一个模式（默认全折叠、全部未启动，白/黑互斥）。
                    // 旧格式的全局名单（老文件 / 别处导入）在这里只读呈现，点「转换」才搬进某个模式。
                    legacyNotice(),
                    modeRows(),
                    cand.error ? React.createElement('div', { className: 'dsm-feedback dsm-warning' }, String(cand.error)) : null)
                    : null),
                modal.form.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(modal.form.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-primary', disabled: busy || (modal.mode === 'create' && !String(modal.form.name || '').trim()) || !String(modal.form.body || '').trim(), onClick: submitEditor }, t('memory.btn.save')))) : null,
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'sdel2', title: t('subagents.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('subagents.delete.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.name) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, { key: 'simp', t: t, title: t('subagents.import.title'), busy: busy, requirements: [t('upload.requirement.persona.1'), t('upload.requirement.persona.2'), t('upload.requirement.persona.3')], onClose: function () { setModal(null) }, onSubmit: submitImport }) : null,
            modal && modal.type === 'export' ? React.createElement(ExportModal, {
              key: 'export', t: t, title: t('export.subagents'),
              items: data.subagents.map(function (p) { return { key: p.name, name: p.name, desc: p.description || '' } }),
              busy: busy, result: result,
              onClose: function () { setResult(null); setModal(null) },
              onSubmit: function (names, outDir) {
                setBusy(true); setResult(null);
                apiCall('bundle-export', { kind: 'subagents', names: names, outDir: outDir }).then(function (res) {
                  setBusy(false);
                  if (res && res.ok) setResult({ ok: true, text: exportResultText(t, res) });
                  else setResult({ ok: false, text: translateError(t, res) });
                }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) });
              },
            }) : null,
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              groupTitle: t('trash.group.agents'),
              groupSub: t('trash.section.agents.sub'),
              locked: anyLocked,
              entries: trash.entries,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restorePersona,
              onPurge: purgePersona,
            }) : null)
        }

        function MemoryPage() {
          var EMPTY_STATS = { total: 0, enabled: 0, scenes: 0 }
          var EMPTY_MEMORY = { usedBytes: 0, maxBytes: 0, truncated: false }
          var state = React.useState({
            loading: true, error: null,
            rules: [], scenes: [], activeMode: 'all',
            sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS,
          })
          var data = state[0], setData = state[1]
          var qs = React.useState('')
          // 场景锁定（v0.8）：任一场景锁定 = 五个域整体冻结；本页全部写控件禁用。
          var anyLocked = data.anyLocked === true
          var query = qs[0], setQuery = qs[1]
          var sfs = React.useState('')
          var sceneFilter = sfs[0], setSceneFilter = sfs[1]
          var cs = React.useState({})
          var collapsed = cs[0], setCollapsed = cs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var es = React.useState(null)
          var editor = es[0], setEditor = es[1]
          var imps = React.useState('')
          var importScene = imps[0], setImportScene = imps[1]
          // 新建场景弹窗与场景建/删已移至「场景」页（ScenesPage）。
          // 记忆回收站：列表在打开弹窗时按需拉取（rules-trash-list）。
          var trs = React.useState({ loading: false, error: null, entries: [] })
          var trash = trs[0], setTrash = trs[1]
          // D14：导出弹窗的状态（busy + 结果）。刻意不复用本页的 `result`：
          // 那个是页面级回执（会自动消失），导出结果只该出现在弹窗里。
          var exs = React.useState(null)
          var exportState = exs[0], setExportState = exs[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          // bundle 附件的隐藏文件选择器；上限与服务端 MAX_ATTACH_ENTRY_BYTES 对齐。
          var attachRef = React.useRef(null)
          var ATTACH_MAX_MB = 8
          var ATTACH_MAX_BYTES = ATTACH_MAX_MB << 20
          // 从「N 个附件」标签进来的那一次，要把附件区滚进视野（否则那颗标签就只是块装饰：
          // 打开弹窗后还得自己往下找）。用回调 ref 会随每次 render 重跑 → 一打字就把页面拽回去，
          // 所以走 effect + 一次性标志，滚完立刻把标志清掉。
          var attachFieldRef = React.useRef(null)
          React.useEffect(function () {
            if (!editor || editor.focusAttach !== true) return
            var node = attachFieldRef.current
            if (node && typeof node.scrollIntoView === 'function') {
              try { node.scrollIntoView({ block: 'center' }) } catch (e) { /* 滚不动不影响使用 */ }
            }
            setEditor(function (prev) { return prev && prev.focusAttach ? Object.assign({}, prev, { focusAttach: false }) : prev })
          }, [editor])

          /** 场景名 = 分组路径的第一段（`web/frontend` 属于场景 `web`）。 */
          function sceneOf(group) {
            var s = String(group == null ? '' : group)
            var i = s.indexOf('/')
            return i >= 0 ? s.slice(0, i) : s
          }
          function toggleCollapse(key) {
            setCollapsed(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = !next[key]
              return next
            })
          }

          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('rules-list', {}).then(function (r) {
              if (r && r.ok) {
                // 合并式更新：只覆盖本页由 rules-list 驱动的字段，其余 state 键保持不变。
                setData(function (prev) { return Object.assign({}, prev, {
                  loading: false, error: null,
                  rules: r.rules || [], scenes: r.scenes || [],
                  activeMode: r.activeMode === 'custom' ? 'custom' : 'all',
                  sceneMemory: r.sceneMemory || EMPTY_MEMORY,
                  stats: r.stats || EMPTY_STATS,
                  paths: r.paths || null,
                }) })
              } else {
                setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r), rules: [], scenes: [], activeMode: 'all', sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS }) })
              }
            }).catch(function (e) {
              setData(function (prev) { return Object.assign({}, prev, { loading: false, error: String((e && e.message) || e), rules: [], scenes: [], activeMode: 'all', sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS }) })
            })
          }
          React.useEffect(function () { refresh() }, [])

          // 成功提示自动消失（2.6s）：浮层只是「刚做完什么」的短暂回执，不该长期占屏。
          // 错误（ok === false）不自动清理，一直留到下一次操作把它替换掉。
          React.useEffect(function () {
            if (!result || result.ok !== true) return undefined
            var timer = setTimeout(function () { setResult(null) }, 2600)
            return function () { clearTimeout(timer) }
          }, [result])

          // ── 启用场景开关已移至「场景」页（ScenesPage）──

          // ── 记忆 CRUD ──
          function openCreate(sceneName) {
            setEditor({ mode: 'create', id: '', group: sceneName || '', name: '', description: '', body: '', form: 'flat', path: '', error: null, files: [], attachments: [] })
            setModal({ type: 'editor' })
          }
          function openEditor(rule, focusAttach) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-read', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok && res.rule) {
                var rd = res.rule
                setEditor({ mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], focusAttach: focusAttach === true })
                setModal({ type: 'editor' })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function closeEditor() { setModal(null) }
          // ── 导入记忆（.md / .zip；场景留空 = 保留场景「全局」）──
          function submitImport(files) {
            if (!files || !files.length) return
            setBusy(true)
            apiCall('rules-import', { scene: importScene, files: files }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                var names = res.imported || [], skipped = res.skipped || []
                var text = names.length ? t('memory.result.imported', { count: names.length, names: names.join('、') }) : t('import.none')
                if (skipped.length) text += ' · ' + t('import.skipped', { items: skipped.map(function (s) { return s.name + '（' + s.reason + '）' }).join('；') })
                // 导入会为引用的目录名补出场景记录（宿主回传 scenes）——必须告诉用户，
                // 否则「我的场景列表怎么多了一个」就是静默造数据。
                if (res.scenes && res.scenes.length) text += ' · ' + t('memory.import.scenesCreated', { names: res.scenes.join('、') })
                setResult({ ok: true, text: text }); refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }

          // ── bundle 附件（只有 bundle 有目录可放；flat 是单文件）──
          function fmtBytes(n) {
            var v = Number(n) || 0
            if (v < 1024) return v + ' B'
            if (v < 1024 * 1024) return Math.ceil(v / 1024) + ' KB'
            return (Math.round((v / (1024 * 1024)) * 10) / 10) + ' MB'
          }
          function pickAttach() { if (attachRef.current) attachRef.current.click() }
          function onAttachPicked(ev) {
            var picked = Array.prototype.slice.call((ev.target && ev.target.files) || [])
            if (ev.target) ev.target.value = '' // 允许连续选中同一个文件
            if (!picked.length) return
            Promise.all(picked.map(function (f) {
              return f.arrayBuffer().then(function (buf) {
                return { name: String(f.name || ''), size: buf.byteLength, data: bytesToBase64(buf) }
              })
            })).then(function (entries) {
              var tooBig = entries.filter(function (e) { return e.size > ATTACH_MAX_BYTES })
              var keep = entries.filter(function (e) { return e.size <= ATTACH_MAX_BYTES })
              setEditor(function (prev) {
                var next = Object.assign({}, prev, { files: (prev.files || []).concat(keep) })
                // 超限的当场拦下（服务端还会再拦一次），其余照常加入
                if (tooBig.length) next.error = t('memory.attach.tooLarge', { name: tooBig[0].name, limit: ATTACH_MAX_MB })
                return next
              })
            }).catch(function (e) { setEditor(function (prev) { return Object.assign({}, prev, { error: String((e && e.message) || e) }) }) })
          }
          function dropPending(index) {
            setEditor(function (prev) {
              var next = (prev.files || []).slice()
              next.splice(index, 1)
              return Object.assign({}, prev, { files: next })
            })
          }
          function removeAttachment(name) {
            if (busy || !editor) return
            setBusy(true)
            apiCall('rules-detach', { id: editor.id, name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) setEditor(function (prev) { return Object.assign({}, prev, { attachments: res.attachments || [] }) })
              else setEditor(function (prev) { return Object.assign({}, prev, { error: translateError(t, res) }) })
            }).catch(function (e) { setBusy(false); setEditor(function (prev) { return Object.assign({}, prev, { error: String((e && e.message) || e) }) }) })
          }
          /** 附件与记忆本体分两步：先存记忆，再传附件；附件失败只如实报错，不回滚已保存的记忆。 */
          function flushAttachments(id, files) {
            if (!files || !files.length) return Promise.resolve({ ok: true, empty: true })
            return apiCall('rules-attach', { id: id, files: files.map(function (f) { return { path: f.name, data: f.data } }) })
          }

          // （场景档案与当前模式的功能已移至 ScenesPage——「场景」页）

          // （场景建/删也已移至 ScenesPage；场景启停开关同）
          // ── 记忆回收站（rules-remove 移入 / rules-restore 恢复 / rules-trash-remove 永久删除）──
          // 此前删除后只能看到一句"回收站 ID"，界面上无法恢复；这里把入口补齐。
          function loadTrash() {
            setTrash({ loading: true, error: null, entries: [] })
            apiCall('rules-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.entries || [] })
              else setTrash({ loading: false, error: translateError(t, res), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: String((e && e.message) || e), entries: [] }) })
          }
          function openTrash() { setModal({ type: 'trash' }); loadTrash() }
          function submitRestore(entry) {
            if (busy) return
            setBusy(true)
            apiCall('rules-restore', { trashId: entry.trashId }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                setResult({ ok: true, text: t('memory.result.restored', { name: entry.name }) })
                refresh(true)
              } else setTrash(Object.assign({}, trash, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setTrash(Object.assign({}, trash, { error: String((e && e.message) || e) })) })
          }
          function submitTrashDelete(entry) {
            if (busy) return
            setBusy(true)
            apiCall('rules-trash-remove', { trashId: entry.trashId }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setResult({ ok: true, text: t('memory.result.trashRemoved', { name: entry.name }) })
                setModal({ type: 'trash' })
                loadTrash()
              } else setTrash(Object.assign({}, trash, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setTrash(Object.assign({}, trash, { error: String((e && e.message) || e) })) })
          }
          // ── 单条记忆启停（索引层开关，不改文件；停用的记忆仍留在磁盘上）──
          function toggleRule(rule) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-toggle', { id: rule.id, enabled: rule.enabled === false }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.toggled', { name: rule.name }) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }

          /**
           * 批量写 `rules[*].enabled`（记忆页页头、每个场景卡片共用的「全选 / 取消全选」）。
           *
           * 顺序提交而不是 Promise.all：宿主侧每次 toggle 都要重写索引文件，并发提交只是排队，
           * 徒增失败时的书写顺序；串行还能「失败即停」并如实报出中止位置。
           */
          function setMemories(ids, on) {
            var list = (ids || []).filter(function (id) { return !!id })
            if (!list.length) return
            setBusy(true); setResult(null)
            var done = 0
            var failed = null
            var chain = Promise.resolve()
            list.forEach(function (id) {
              chain = chain.then(function () {
                if (failed) return null
                return apiCall('rules-toggle', { id: id, enabled: on }).then(function (res) {
                  if (res && res.ok) done += 1
                  else failed = translateError(t, res)
                }).catch(function (e) { failed = String((e && e.message) || e) })
              })
            })
            chain.then(function () {
              setBusy(false)
              var action = t(on ? 'bulk.enabled' : 'bulk.disabled')
              setResult(failed
                ? { ok: false, text: t('memory.bulk.partial', { action: action, count: done, error: failed }) }
                : { ok: true, text: t('bulk.done.memories', { action: action, count: done, failed: 0 }) })
              refresh(true)
            })
          }
          /** 可批量切换的记忆 = 非被同名 bundle 覆盖的（与行内 Switch 同一条件）。 */
          function toggleableIds(rules) {
            return (rules || []).filter(function (r) { return r.shadowed !== true }).map(function (r) { return String(r.id) })
          }
          /** 传进来的一组记忆是否全部开着（决定二合一按钮显示哪一个文案）。 */
          function allMemoriesOn(rules) {
            var rows = (rules || []).filter(function (r) { return r.shadowed !== true })
            return rows.length > 0 && rows.every(function (r) { return r.enabled !== false })
          }

          /** 记忆存好后统一收尾：上传附件 → 关弹窗 → 报结果（附件失败不回滚记忆）。 */
          function finishEditor(id, name, pending, successKey, attachedKey) {
            return flushAttachments(id, pending).then(function (att) {
              setBusy(false)
              setModal(null); setEditor(null)
              if (att && att.ok === false) setResult({ ok: false, text: t('memory.result.attachFailed', { error: translateError(t, att) }) })
              else if (pending.length) setResult({ ok: true, text: t(attachedKey, { name: name, count: pending.length }) })
              else setResult({ ok: true, text: t(successKey, { name: name }) })
              refresh(true)
            })
          }
          function submitCreate() {
            var payload = {
              group: String(editor.group || '').trim(),
              name: String(editor.name || '').trim(),
              description: String(editor.description || '').trim(),
              body: editor.body || '',
              form: editor.form || 'flat',
            }
            var pending = editor.files || []
            setBusy(true)
            apiCall('rules-create', payload).then(function (res) {
              if (!res || !res.ok) {
                setBusy(false)
                setEditor(Object.assign({}, editor, { error: translateError(t, res) }))
                return null
              }
              var id = (res.rule && res.rule.id) || (payload.group ? payload.group + '/' + payload.name : payload.name)
              var name = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(id, name, pending, 'memory.result.created', 'memory.result.createdAttached')
            }).catch(function (e) { setBusy(false); setEditor(Object.assign({}, editor, { error: String((e && e.message) || e) })) })
          }
          function submitUpdate() {
            var payload = {
              id: editor.id,
              name: String(editor.name || '').trim(),
              description: String(editor.description || '').trim(),
              body: editor.body || '',
              form: editor.form || 'flat',
            }
            var pending = editor.files || []
            setBusy(true)
            apiCall('rules-update', payload).then(function (res) {
              if (!res || !res.ok) {
                setBusy(false)
                setEditor(Object.assign({}, editor, { error: translateError(t, res) }))
                return null
              }
              var name = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(editor.id, name, pending, 'memory.result.updated', 'memory.result.updatedAttached')
            }).catch(function (e) { setBusy(false); setEditor(Object.assign({}, editor, { error: String((e && e.message) || e) })) })
          }
          function submitDelete(rule) {
            setBusy(true)
            apiCall('rules-remove', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                setResult({ ok: true, text: t('memory.result.removed', { name: rule.name, trashId: res.trashId != null ? res.trashId : '' }) })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }

          // ── 渲染 ──
          var stats = data.stats || EMPTY_STATS
          // 注入预算：宿主 rules-list 一直在返回 sceneMemory，但此前从未渲染 ——
          // 于是"超出预算、部分记忆没进提示词"对用户完全不可见。
          var memInfo = data.sceneMemory || EMPTY_MEMORY
          var memMax = Number(memInfo.maxBytes) || 0
          var memUsed = Number(memInfo.usedBytes) || 0
          var budgetOver = memMax > 0 && memUsed > memMax
          var budgetPct = memMax > 0 ? Math.min(100, Math.round((memUsed / memMax) * 100)) : 0
          var droppedNames = (memInfo.dropped || []).map(function (d) { return (d.scene ? d.scene + '/' : '') + d.name })
          var q = String(query || '').toLowerCase()
          function matchRule(r) {
            if (sceneFilter !== '' && sceneOf(r.group) !== sceneFilter) return false
            if (!q) return true
            return (r.name || '').toLowerCase().indexOf(q) >= 0
              || (r.description || '').toLowerCase().indexOf(q) >= 0
              || (r.group || '').toLowerCase().indexOf(q) >= 0
          }

          // 场景 → 记忆：场景元数据来自宿主 scenes（含**空场景**与保留场景 global），
          // 记忆按一级目录归位。没有归属场景的记忆（直接放在 memories/ 根层）也单独列出来，
          // 并在体检里报 noScene —— 不能让它既不在列表里、也不在提示词里。
          var buckets = {}
          var order = []
          function ensureBucket(name, meta) {
            if (!buckets[name]) { buckets[name] = { name: name, meta: meta, rules: [] }; order.push(name) }
            else if (meta && !buckets[name].meta) buckets[name].meta = meta
            return buckets[name]
          }
          ;(data.scenes || []).forEach(function (s) { ensureBucket(s.name, s) })
          data.rules.forEach(function (r) {
            var g = String(r.group == null ? '' : r.group)
            var b = ensureBucket(g === '' ? '' : sceneOf(g), null)
            if (matchRule(r)) b.rules.push(r)
          })
          order.sort(function (a, b) {
            if (a === b) return 0
            var am = buckets[a].meta, bm = buckets[b].meta
            // 宿主给的 order（保留场景 global = 0，恒在最前）；无元数据的游离桶排最后。
            var ao = am && typeof am.order === 'number' ? am.order : 1e9
            var bo = bm && typeof bm.order === 'number' ? bm.order : 1e9
            if (ao !== bo) return ao - bo
            if (a === '') return 1
            if (b === '') return -1
            return String(a).localeCompare(String(b))
          })
          var sceneOptions = [{ value: '', label: t('memory.filter.all') }].concat(
            order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } }))
          // 场景选择：保留场景「全局」排最前（它是真实场景，不是「留空」）；
          // 游离桶只在真的存在游离记忆时才出现。
          var sceneChoices = order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } })
          // 名称 = .md 文件名（单个路径段，不是路径）：用 segment 校验器，与宿主逐字对齐。
          // 中文等任意 Unicode 都合法（`站会流程` → `站会流程.md`）。
          // 未输入时不标红/不报「不合法」——一打开弹窗就飘红会让人以为中文名被拒；
          // 空值改由提交按钮的 disabled 兜住（见下方 disabled 表达式）。
          var editorNameInvalid = editor ? String(editor.name || '').trim() !== '' && !isValidSceneSegment(String(editor.name || '').trim()) : false
          var editorGroupInvalid = editor && editor.mode === 'create' ? String(editor.group || '').trim() !== '' && !isValidScenePath(String(editor.group || '').trim()) : false
          var editorDescLen = editor ? String(editor.description || '').length : 0
          // 空场景（含刚「新建场景」建好的空目录）必须列出来：否则它在页面上直接消失，
          // 卡片上的「新建记忆」入口也就点不到（只能靠顶部按钮再手填场景名）。
          // 只在搜索 / 场景筛选生效时按命中收敛，避免空卡片噪音。
          var filtering = q !== '' || sceneFilter !== ''
          var visibleBuckets = order.filter(function (n) {
            if (sceneFilter !== '' && n !== sceneFilter) return false
            if (!filtering) return true
            return buckets[n].rules.length > 0 || sceneFilter === n
          })
          var hasAnyRule = data.rules.length > 0
          /** 页头「全选 / 取消全选」的作用集 = 当前筛选后可见的、可切换的记忆。 */
          var bulkRules = []
          visibleBuckets.forEach(function (n) { bulkRules = bulkRules.concat(buckets[n].rules) })
          var bulkIds = toggleableIds(bulkRules)
          var bulkAllOn = allMemoriesOn(bulkRules)

          /**
           * bundle 记忆的「N 个附件」标签（用户裁定 2026-09-17）。
           *
           * 形态归「bundle」那颗标签，**内容归这一颗** —— 两者语义不同，挤进一个框里中文下会到 7 个字。
           * 数量是宿主在 rules-list 里补的（`r.attach`，口径与注入给模型的附件清单逐字一致）。
           * 0 个附件也显示（灰色），这样"哪些 bundle 是空壳"一眼可见；两种状态都能点，
           * 点了直接开编辑弹窗并**滚到附件区**（不然这颗标签就只是块装饰）。
           * `r.attach` 缺失 = 宿主没读到这个目录（索引残留）→ 什么都不显示，不谎报 0。
           */
          function attachTag(r, shadowed) {
            if (r.form !== 'bundle' || !r.attach) return null
            var n = r.attach.count
            var names = r.attach.names || []
            var extra = n > names.length ? t('memory.attach.more', { count: n - names.length }) : ''
            var title = n === 0
              ? t('memory.attach.tip.empty')
              : t('memory.attach.tip', { count: n, size: fmtBytes(r.attach.bytes), names: names.join(t('memory.attach.sep')) + extra })
            return React.createElement('button', {
              type: 'button',
              className: 'dsm-tag dsm-tag-attach' + (n === 0 ? ' dsm-tag-attach-empty' : ''),
              disabled: busy || shadowed || anyLocked,
              title: title,
              'aria-label': title,
              onClick: function () { openEditor(r, true) },
            }, React.createElement(PaperclipIcon, { size: 11 }), t(countKey('memory.attach.count', n), { count: n }))
          }

          function renderRuleRow(r, sceneActive) {
            var shadowed = r.shadowed === true
            // shadowed = 存在同名 bundle，本条 flat 不会被加载；与文件名是否 kebab-case 无关——
            // 记忆名就是 .md 文件名，中文名同样可以在本页编辑 / 删除。
            var enabled = r.enabled !== false
            // 单条停用（索引层开关）优先于场景状态：原来只有 已启用/被覆盖/场景未启用 三个分支，
            // 单条停用的记忆会被误显示为「已启用」。
            var statusKey = shadowed ? 'status.shadowed' : !enabled ? 'memory.status.off' : sceneActive === false ? 'memory.status.sceneOff' : 'status.enabled'
            var statusCls = shadowed ? 'dsm-shadowed' : (!enabled || sceneActive === false) ? 'dsm-disabled' : 'dsm-enabled'
            return React.createElement('div', { key: r.id, className: 'dsm-row', 'data-flip-key': r.id, 'data-flip-on': enabled ? '1' : '0' },
              React.createElement('div', { className: 'dsm-main' },
                React.createElement('div', { className: 'dsm-name' }, r.name),
                React.createElement('div', { className: 'dsm-note' }, r.description || ''),
                shadowed ? React.createElement('div', { className: 'dsm-rule-shadow-hint' }, t('memory.shadowed.hint')) : null),
              React.createElement('div', { className: 'dsm-tags' },
                r.group && r.group.indexOf('/') >= 0 ? React.createElement('span', { className: 'dsm-tag' }, r.group) : null,
                r.form === 'bundle' ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.form.bundle')) : null,
                attachTag(r, shadowed),
                r.descriptionDerived ? React.createElement('span', { className: 'dsm-tag' }, t('memory.derived')) : null),
              React.createElement('div', { className: 'dsm-status ' + statusCls }, t(statusKey)),
              React.createElement('div', { className: 'dsm-row-actions' },
                React.createElement(Switch, { on: enabled, disabled: busy || shadowed || anyLocked, label: t('memory.enable') + ' ' + r.name, onClick: function () { toggleRule(r) } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || shadowed || anyLocked, onClick: function () { openEditor(r) } }, t('memory.edit')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || shadowed || anyLocked, onClick: function () { setModal({ type: 'delete', rule: r }) } }, t('memory.delete'))))
          }

          function renderSceneCard(name) {
            var bucket = buckets[name]
            var meta = bucket.meta || { name: name, count: 0, active: true, shared: false, label: null }
            var isShared = meta.shared === true
            var isGlobal = meta.global === true || name === 'global'
            var isOrphan = name === '' && !bucket.meta
            var open = !collapsed['s:' + name]
            // 两种「不进上下文」要分开：游离记忆（没有归属场景）是**真问题**，用错误色；
            // 场景只是没启用是**正常状态**（同时只有一个场景在用），整块灰色置灰即可 ——
            // 此前两者共用一个红类，关着的场景一片红，读起来像出了错。
            return React.createElement('div', { key: 's:' + name, className: 'dsm-source' + (isOrphan ? ' dsm-rule-shadowed' : meta.active === false ? ' dsm-rule-off' : '') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleCollapse('s:' + name) } },
                  React.createElement('span', { className: 'dsm-source-title', title: sceneLabel(data.scenes, name) }, sceneLabel(data.scenes, name)),
                  React.createElement('span', { className: 'dsm-count' }, t('memory.scene.count', { count: bucket.rules.length })),
                  isShared ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                  isGlobal ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.global.tag')) : null,
                  isOrphan ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.orphan.tag')) : null,
                  meta.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null,
                  isOrphan ? null : React.createElement('span', { className: 'dsm-note' }, meta.description || '')),
                React.createElement('div', { className: 'dsm-source-actions' },
                  // 每个场景一张卡：卡内的「全选 / 取消全选」只作用于**这张卡里的**记忆
                  // —— 用户说的「记忆的不同场景都缺少全选清空」。
                  isOrphan || !bucket.rules.length ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || anyLocked || !toggleableIds(bucket.rules).length, onClick: function () { setMemories(toggleableIds(bucket.rules), !allMemoriesOn(bucket.rules)) } }, bulkPair(allMemoriesOn(bucket.rules) ? t('bulk.unselectAll') : t('bulk.selectAll'), allMemoriesOn(bucket.rules) ? t('bulk.selectAll') : t('bulk.unselectAll'))),
                  isOrphan ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openCreate(name) } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                isOrphan ? React.createElement('div', { className: 'dsm-source-note' }, t('memory.scene.orphan.hint')) : null,
                bucket.rules.length
                  ? React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-table-head' },
                      React.createElement('span', null, t('memory.table.name')),
                      React.createElement('span', null, t('memory.table.tags')),
                      React.createElement('span', null, t('memory.table.status')),
                      React.createElement('span', null, '')),
                    enabledFirst(bucket.rules, function (r) { return r.enabled !== false; }).map(function (r) { return renderRuleRow(r, meta.active !== false) }))
                  : React.createElement('div', { className: 'dsm-empty' }, t('memory.scene.empty'))) : null)
          }

          // D14 导出：可导出的记忆 = 索引里的规则，排除被同名 bundle 遮蔽的 flat
          // （它们不会被加载，导出去只会让人以为能用）。key 用**记忆 id**：
          // 服务端按 id 在索引里查真实文件路径（bundle 型必须这么做，见 planMemoryExport）。
          var exportableRules = (data.rules || []).filter(function (r) { return r.shadowed !== true })
          /** 导出条目：按**场景**分组（记忆页的分组维度就是场景），组内给出名称 + 描述。 */
          function memoryExportItems() {
            var sceneMeta = {}
            ;(data.scenes || []).forEach(function (s) { sceneMeta[s.name] = s })
            return exportableRules.map(function (r) {
              var scene = sceneOf(r.group)
              var meta = sceneMeta[scene]
              var label = (meta && (meta.label || meta.name)) || scene || t('memory.scene.orphan')
              return { key: r.id, name: r.name, desc: r.description || '', group: label }
            })
          }
          function submitExport(names, outDir) {
            setExportState({ busy: true, result: null })
            apiCall('bundle-export', { kind: 'memories', names: names, outDir: outDir }).then(function (res) {
              if (res && res.ok) setExportState({ busy: false, result: { ok: true, text: exportResultText(t, res) } })
              else setExportState({ busy: false, result: { ok: false, text: translateError(t, res) } })
            }).catch(function (e) { setExportState({ busy: false, result: { ok: false, text: String((e && e.message) || e) } }) })
          }

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('memory.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('memory.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { openCreate(sceneFilter || '') } }, t('memory.btn.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { setResult(null); setImportScene(''); setModal({ type: 'import' }) } }, t('memory.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || !exportableRules.length, onClick: function () { setResult(null); setExportState({ busy: false, result: null }) } }, t('export.memories')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openTrash }, t('memory.trash.open')),
                // 列表级动作与页头其余动作同栏（用户 2026-09-17 裁定）：作用集 = 当前筛选后的可见记忆。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: busy || anyLocked || !bulkIds.length, onClick: function () { setMemories(bulkIds, !bulkAllOn) } }, bulkPair(bulkAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), bulkAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))))),
            React.createElement('div', { className: 'dsm-summary' },
              React.createElement('div', { key: 'total', className: 'dsm-stat' }, React.createElement('strong', null, stats.total || 0), t('memory.stat.total')),
              React.createElement('div', { key: 'scenes', className: 'dsm-stat' }, React.createElement('strong', null, (data.scenes || []).length), t('memory.stat.sceneCount')),
              React.createElement('div', { key: 'active', className: 'dsm-stat' }, React.createElement('strong', null, stats.scenes || 0), t('memory.stat.scenes'))),
            memMax > 0 ? React.createElement('div', { className: 'dsm-rule-budget' },
              React.createElement('div', { className: 'dsm-budget-meta' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.budget.label')),
                React.createElement('span', { className: budgetOver ? 'dsm-budget-over-text' : 'dsm-char-count' },
                  t('memory.budget.bytes', { used: memUsed, max: memMax }) + (budgetOver ? ' · ' + t('memory.budget.over') : ''))),
              React.createElement('div', { className: 'dsm-budget-bar', role: 'progressbar', 'aria-valuenow': budgetPct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('memory.budget.label') },
                React.createElement('div', { className: 'dsm-budget-fill' + (budgetOver ? ' dsm-budget-over' : ''), style: { width: budgetPct + '%' } })),
              memInfo.truncated ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.budget.truncated')) : null,
              droppedNames.length ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.budget.dropped', { names: droppedNames.join('、') })) : null) : null,
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: t('memory.search.placeholder'), value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { options: sceneOptions, value: sceneFilter, onChange: setSceneFilter }))),
            // 成功 / 失败统一走 Notice（成功浮层 2.6 秒自动消失，见上方 result 清理 effect；
            // 错误留在文档流里不自动消失——错误需要一直看得见）。
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            data.error ? React.createElement('div', { key: 'error', className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading && !hasAnyRule ? React.createElement('div', { key: 'loading', className: 'dsm-empty' }, t('memory.loading'))
              : visibleBuckets.length ? React.createElement('div', { key: 'scenes', className: 'dsm-sources', ref: flipRef }, visibleBuckets.map(renderSceneCard))
              : React.createElement('div', { key: 'empty', className: 'dsm-empty' }, q || sceneFilter ? t('memory.empty.search') : t('memory.empty')),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: t('memory.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.delete.desc', { name: modal.rule.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.rule) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, {
              key: 'mimp', t: t, title: t('memory.import.title'), busy: busy,
              requirements: [t('upload.requirement.memory.1'), t('upload.requirement.memory.2'), t('upload.requirement.memory.3'), t('upload.requirement.memory.4')],
              extra: React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.import.scene')),
                React.createElement('input', { className: 'dsm-control', value: importScene, placeholder: t('memory.scene.global.hint'), onChange: function (e) { setImportScene(e.target.value) } })),
              onClose: function () { setModal(null) },
              onSubmit: submitImport,
            }) : null,
            exportState ? React.createElement(ExportModal, {
              key: 'mexport', t: t, title: t('export.memories'),
              items: memoryExportItems(),
              busy: exportState.busy, result: exportState.result,
              onClose: function () { setExportState(null) },
              onSubmit: submitExport,
            }) : null,
            editor && modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'editor', className: 'dsm-modal-wide', title: editor.mode === 'create' ? t('memory.create.title') : t('memory.edit.title'), closeLabel: t('btn.close'), onClose: closeEditor },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.group')),
                  editor.mode === 'create'
                    ? React.createElement(SceneCombo, {
                      options: sceneChoices,
                      value: editor.group || '',
                      placeholder: t('memory.field.group.placeholder'),
                      browseLabel: t('memory.scene.browse'),
                      label: t('memory.field.group'),
                      disabled: busy,
                      invalid: editorGroupInvalid,
                      onChange: function (v) { setEditor(Object.assign({}, editor, { group: v })) },
                    })
                    : React.createElement('input', { className: 'dsm-control', value: editor.group || '', disabled: true, onChange: function () {} }),
                editor.mode === 'create'
                  ? React.createElement('p', { className: 'dsm-help' }, t('memory.field.group.hint'))
                  : null,
                editorGroupInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('error.rules.invalidGroup')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (editorNameInvalid ? ' dsm-rule-invalid' : ''), value: editor.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { name: e.target.value })) } }),
                  editorNameInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.name.invalid')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.description')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: editor.description || '', placeholder: t('memory.field.description.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { description: e.target.value })) } }),
                  React.createElement('div', { className: 'dsm-char-count' + (editorDescLen > 500 ? ' dsm-char-over' : '') }, editorDescLen + ' / 500')),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: editor.body || '', placeholder: t('memory.field.body.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { body: e.target.value })) } })),
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.form')),
                  React.createElement(SourceSelect, { options: RULE_FORM_OPTIONS, value: editor.form || 'flat', onChange: function (v) { setEditor(Object.assign({}, editor, { form: v })) } }),
                  editor.form === 'bundle'
                    ? React.createElement('div', { className: 'dsm-field', ref: attachFieldRef },
                      React.createElement('span', { className: 'dsm-label' }, t('memory.field.attach')),
                      React.createElement('input', { ref: attachRef, type: 'file', multiple: true, className: 'dsm-hidden-input', onChange: onAttachPicked }),
                      (editor.attachments || []).length || (editor.files || []).length
                        ? React.createElement('div', { className: 'dsm-attach-list' },
                          (editor.attachments || []).map(function (a) {
                            return React.createElement('div', { key: 'a:' + a.name, className: 'dsm-file', title: a.name },
                              React.createElement('span', { className: 'dsm-file-kind', 'aria-hidden': 'true' }, 'FILE'),
                              React.createElement('span', { className: 'dsm-file-name' }, a.name),
                              React.createElement('span', { className: 'dsm-file-meta' }, fmtBytes(a.size)),
                              React.createElement('button', { type: 'button', className: 'dsm-file-remove', disabled: busy, 'aria-label': t('memory.attach.remove') + ' ' + a.name, onClick: function () { removeAttachment(a.name) } }, '×'))
                          }),
                          (editor.files || []).map(function (f, i) {
                            return React.createElement('div', { key: 'p:' + i + ':' + f.name, className: 'dsm-file', title: f.name },
                              React.createElement('span', { className: 'dsm-file-kind', 'aria-hidden': 'true' }, 'NEW'),
                              React.createElement('span', { className: 'dsm-file-name' }, f.name),
                              React.createElement('span', { className: 'dsm-file-meta' }, fmtBytes(f.size) + ' · ' + t('memory.attach.pending')),
                              React.createElement('button', { type: 'button', className: 'dsm-file-remove', disabled: busy, 'aria-label': t('memory.attach.remove') + ' ' + f.name, onClick: function () { dropPending(i) } }, '×'))
                          }))
                        : React.createElement('p', { className: 'dsm-help' }, t('memory.attach.empty')),
                      React.createElement('div', { className: 'dsm-attach-actions' },
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: pickAttach }, t('memory.attach.add')),
                        React.createElement('span', { className: 'dsm-help' }, t('memory.attach.hint'))))
                    : React.createElement('p', { className: 'dsm-help' }, t('memory.attach.flat'))),
                editor.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(editor.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || editorNameInvalid || editorGroupInvalid || editorDescLen > 500 || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : submitUpdate }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
            // 场景建/删/档案弹窗已移至「场景」页（ScenesPage）。
            modal && modal.type === 'trash' ? React.createElement(Modal, { key: 'trash', wide: true, title: t('memory.trash.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              trash.loading ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
                : React.createElement(React.Fragment, null,
                  trash.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(trash.error)) : null,
                  trash.entries.length
                    ? React.createElement(React.Fragment, null,
                      React.createElement('div', { className: 'dsm-count' }, t('memory.trash.count', { count: trash.entries.length })),
                      React.createElement('div', { className: 'dsm-trash-box' }, trash.entries.map(function (entry) {
                        return React.createElement('div', { key: entry.trashId, className: 'dsm-trash-item' },
                          React.createElement('div', { className: 'dsm-trash-main' },
                            React.createElement('div', { className: 'dsm-name' }, entry.name),
                            React.createElement('div', { className: 'dsm-note' },
                              sceneLabel(data.scenes, entry.group) + ' · ' + t('memory.form.' + (entry.form === 'bundle' ? 'bundle' : 'flat')) + ' · ' + entry.bytes + ' B · '
                              + t('memory.trash.deletedAt', { time: entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : '' }))),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { submitRestore(entry) } }, t('memory.trash.restore')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'trash-delete', entry: entry }) } }, t('memory.trash.purge')))
                      })))
                    : React.createElement('div', { className: 'dsm-empty' }, t('memory.trash.empty')))) : null,
            modal && modal.type === 'trash-delete' ? React.createElement(Modal, { key: 'trash-delete', title: t('memory.trash.confirmTitle'), closeLabel: t('btn.close'), onClose: function () { setModal({ type: 'trash' }) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.trash.confirmDesc', { name: modal.entry.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitTrashDelete(modal.entry) } }, t('memory.trash.purge')))) : null)
        }

        // 页面组件填进 factory 作用域那个占位对象（导出对象求值时已指向它）。
        // 不要改回 `module.exports.X = ...`：apply 可能在本函数开头提前返回。
        _pages.MCPPage = MCPPage
        _pages.SkillManagerSection = SkillManagerSection
        _pages.AgentsMdPage = AgentsMdPage
        _pages.HistoryPage = HistoryPage
        _pages.ScenesPage = ScenesPage
        _pages.SubagentsPage = SubagentsPage
        _pages.MemoryPage = MemoryPage
        _pages.CompatPage = CompatPage
        // 标题旁的版本徽标也导出：其他页面（提示词页）在用它，测试与排版预览需要能单独渲染。
        _pages.VersionBadge = VersionBadgeComponent
        _pages.t = t
        // 纯函数（无状态、可单测）：卡片描述行、场景归属判定、记忆段默认勾选都靠它们，
        // 契约是「描述超长必裁」「记忆段的勾选只认本场景自己的记忆」。测试直接调这几个函数。
        _pages.sceneTileDesc = sceneTileDesc
        _pages.clipText = clipText
        _pages.sceneOfGroup = sceneOfGroup
        _pages.sceneMemoriesOf = sceneMemoriesOf
        _pages.memDefaultPickIds = memDefaultPickIds
        // 常量用函数包一层：测试会把 _pages 的每个值当组件渲染一遍，数字会被 React 当成非法元素类型报警告。
        _pages.sceneDescMax = function () { return SCENE_DESC_MAX }
        _pages.memDescMax = function () { return MEM_DESC_MAX }
      },
    }
    return module.exports
  }
})


