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
      '.dsm-summary.dsm-summary-3{grid-template-columns:repeat(3,minmax(0,1fr))}' +
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
      '.dsm-modal textarea.dsm-control.dsm-textarea-md{min-height:200px}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-lg{min-height:300px}' +
      '.dsm-detail-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.dsm-note-user{color:var(--dsw-alias-label-tertiary)}' +
      `
.dsm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}.dsm-tabs-end{display:flex;align-items:center;gap:4px;margin-left:auto}.dsm-tab{padding:8px 14px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.dsm-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-success-primary)}.dsm-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:2px 0 36px;container-type:inline-size;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:inherit}.dsm-head{display:flex;flex-direction:column;align-items:stretch;gap:16px}.dsm-title-block{min-width:0}.dsm-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}.dsm-feedback-links{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.dsm-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap}.dsm-feedback-link{display:inline-flex;min-height:28px;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;text-decoration:none;white-space:nowrap}.dsm-feedback-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsm-feedback-link:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-feedback-link svg{flex:none}.dsm-desc{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}.dsm-actions{display:flex;flex-wrap:wrap;gap:8px;margin-left:0;flex:none}
.dsm-btn{box-sizing:border-box;display:inline-flex;min-height:34px;align-items:center;justify-content:center;padding:0 13px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:580;white-space:nowrap;cursor:pointer}.dsm-btn:hover:not(:disabled){filter:brightness(1.08)}.dsm-btn:disabled{opacity:.48;cursor:default}.dsm-btn-secondary,.dsm-btn-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.dsm-btn-quiet{min-height:28px;padding:0 9px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}.dsm-btn:focus-visible,.dsm-control:focus-visible,.dsm-select-trigger:focus-visible,.dsm-source-head:focus-visible,.dsm-switch:focus-visible,.dsm-upload-link:focus-visible,.dsm-file-remove:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
.dsm-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-secondary)}.dsm-stat:last-child{border-right:0}.dsm-stat strong{margin-right:5px;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680}.dsm-filters{display:flex;gap:9px}.dsm-search{flex:1}.dsm-source-filter{width:210px;flex:none}
.dsm-control,.dsm-select-trigger{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm-control::placeholder{color:var(--dsw-alias-label-tertiary)}textarea.dsm-control{min-height:160px;padding-top:9px;resize:vertical;line-height:20px}.dsm-select{position:relative}.dsm-select-trigger{display:flex;align-items:center;justify-content:space-between;text-align:left;cursor:pointer}.dsm-select-menu{position:absolute;z-index:40;top:calc(100% + 5px);right:0;left:0;display:flex;max-height:260px;padding:5px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2)}.dsm-option{padding:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.dsm-option:hover,.dsm-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sources{display:flex;flex-direction:column;gap:9px}.dsm-source{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-source-head{box-sizing:border-box;display:flex;width:100%;min-height:48px;align-items:center;padding:0 13px}.dsm-source-head-main{display:flex;min-width:0;min-height:48px;flex:1;align-items:center;gap:10px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsm-source-head:hover,.dsm-row:hover,.dsm-trash-row:hover,.dsm-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-source-title{font-size:14px;font-weight:650}.dsm-count{color:var(--dsw-alias-label-tertiary);font-size:12px}.dsm-path{min-width:0;margin-left:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm-source-actions{display:flex;align-items:center;gap:9px;margin-left:8px}.dsm-source-body{border-top:1px solid var(--dsw-alias-border-l1)}.dsm-source-note{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dsm-table-head,.dsm-row{display:grid;grid-template-columns:minmax(180px,1fr) 120px 90px max-content;align-items:center;column-gap:12px;padding:0 13px}.dsm-table-head{min-height:32px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-row{min-height:58px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-row:last-child{border-bottom:0}.dsm-main{min-width:0}.dsm-name{overflow:hidden;font-size:13px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.dsm-note{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.dsm-tag{display:inline-flex;min-height:19px;align-items:center;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}.dsm-tag-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.dsm-tag-off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.dsm-enabled{color:var(--dsw-alias-state-success-primary);font-size:12px;white-space:nowrap}.dsm-disabled{color:#d49245;font-size:12px;white-space:nowrap}.dsm-shadowed{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}.dsm-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}
.dsm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}.dsm-switch:after{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;content:"";transition:transform 160ms ease}.dsm-switch-on{background:var(--dsw-alias-state-success-primary)}.dsm-switch-on:after{transform:translateX(14px)}.dsm-switch:disabled{opacity:.45;cursor:default}.dsm-trash-row{display:flex;min-height:48px;align-items:center;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsm-trash-count{margin-left:auto;padding:2px 7px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}.dsm-empty{padding:25px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsm-feedback{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-warning{border-color:#d49245;color:#d49245}.dsm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.dsm-modal{box-sizing:border-box;display:flex;width:min(560px,100%)!important;max-height:min(760px,calc(100vh - 48px));min-width:0;flex-direction:column;gap:16px;padding:22px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.dsm-modal-wide{width:min(720px,100%)!important}.dsm-modal-import{width:min(480px,100%)!important;padding:24px}.dsm-modal-head{display:flex;align-items:flex-start;gap:12px}.dsm-modal-title{margin:0;flex:1;font-size:17px;line-height:24px;font-weight:670}.dsm-form,.dsm-field,.dsm-detail-section{display:flex;flex-direction:column}.dsm-form{gap:12px}.dsm-field{gap:6px}.dsm-label,.dsm-detail-title{font-size:12px}.dsm-label{color:var(--dsw-alias-label-secondary)}.dsm-detail-title{font-weight:650}.dsm-help{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.dsm-hidden-input{display:none}.dsm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color 180ms ease,background 180ms ease;cursor:pointer}.dsm-dropzone:hover,.dsm-dropzone-active{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsm-dropzone-title{color:var(--dsw-alias-label-primary);font-size:18px;font-weight:700}.dsm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dsm-upload-choices{display:flex;align-items:center;gap:7px}.dsm-upload-link,.dsm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsm-upload-link{color:var(--dsw-alias-label-secondary)}.dsm-upload-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.dsm-upload-link:disabled{opacity:.45;cursor:default}.dsm-upload-divider{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-file{display:flex;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}.dsm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700}.dsm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dsm-file-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.dsm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary);font-size:18px}.dsm-upload-requirements{padding:1px 1px 0}.dsm-upload-requirements ul{display:flex;margin:7px 0 0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-detail-section{gap:7px}.dsm-detail-path,.dsm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-detail-path{padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-all}.dsm-code{max-height:280px;margin:0;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:pre-wrap}.dsm-diag{padding:8px 10px;border-left:2px solid #d49245;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-trash-item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-trash-item:last-child{border-bottom:0}.dsm-trash-main{min-width:0;flex:1}
.dsm-fm{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-fm-row{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr);gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}.dsm-fm-row:last-child{border-bottom:0}.dsm-fm-key{color:var(--dsw-alias-label-secondary);word-break:break-word}.dsm-fm-raw{margin-left:5px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}.dsm-fm-val{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap}
@container(max-width:780px){.dsm-table-head{display:none}.dsm-row{grid-template-columns:minmax(0,1fr) max-content;gap:8px;padding:11px 13px}.dsm-row>.dsm-tags,.dsm-row>.dsm-status{grid-column:1}.dsm-row-actions{grid-column:2;grid-row:1 / span 3}.dsm-path{display:none}}@media(max-width:760px){.dsm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.dsm-title-row{flex-wrap:wrap}}@container(max-width:520px){.dsm-head{flex-direction:column}.dsm-actions{width:100%;margin-left:0}.dsm-actions .dsm-btn{flex:1}.dsm-filters{flex-direction:column}.dsm-source-filter{width:100%}.dsm-summary{grid-template-columns:1fr}}
.dsm-hist-row{display:flex;align-items:center;gap:11px;padding:10px 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-hist-row:last-child{border-bottom:0}.dsm-hist-main{min-width:0;flex:1}.dsm-hist-title{overflow:hidden;font-size:13px;font-weight:580;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd-missing{color:var(--dsw-alias-state-error-primary)}.dsm-hist-actions{display:flex;gap:6px;flex:none}.dsm-hist-check,.dsm-hist-group-check{flex:none;width:15px;height:15px;margin:0 4px 0 0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}.dsm-hist-group-head{gap:10px}.dsm-hist-batch{display:flex;align-items:center;gap:8px;margin-left:2px;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l2)}.dsm-hist-batch-count{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsm-hist-batch-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none}.dsm-dir-row{display:flex;gap:8px}.dsm-dir-row .dsm-control{flex:1}.dsm-dir-list{display:flex;max-height:220px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-dir-item{display:flex;width:100%;align-items:center;padding:8px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.dsm-dir-item:last-child{border-bottom:0}.dsm-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-dir-item::before{content:"📁";margin-right:8px;font-size:12px}
.dsm-rule-shadowed .dsm-name,.dsm-rule-shadowed .dsm-note{color:var(--dsw-alias-state-error-primary)}.dsm-rule-shadow-hint{margin-top:3px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-invalid{border-color:var(--dsw-alias-state-error-primary)!important}.dsm-rule-hint{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-budget{display:flex;flex-direction:column;gap:6px}.dsm-budget-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.dsm-budget-meta strong{margin-right:0;font-size:13px;font-weight:680}.dsm-budget-over-text{color:var(--dsw-alias-state-error-primary);font-size:11px}.dsm-budget-bar{height:6px;overflow:hidden;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover)}.dsm-budget-fill{height:100%;border-radius:99px;background:var(--dsw-alias-state-success-primary);transition:width 160ms ease}.dsm-budget-fill.dsm-budget-over{background:var(--dsw-alias-state-error-primary)}.dsm-char-count{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-char-over{color:var(--dsw-alias-state-error-primary)}
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
.dsm-seg-foot{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsm-pick{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px}
.dsm-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-pick input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-pick-main{min-width:0;flex:1}
.dsm-pick-name{overflow:hidden;font-size:13px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-desc{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-meta{display:flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-pick-actions{display:flex;align-items:center;gap:6px;flex:none}
.dsm-pick-empty{padding:18px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.dsm-archive-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
/* 档案弹窗固定高度：加/删段、进出「选工具」子视图都不改变弹窗尺寸。 */
.dsm-modal-archive{height:min(620px,calc(100vh - 64px))}
.dsm-modal-archive .dsm-form{min-height:0;overflow:auto}
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

        // 顶部栏反馈入口：合并成一个「GitHub 和反馈」链接，指向仓库（issues 在那）。
        function FeedbackLinks() {
          return React.createElement('div', { className: 'dsm-feedback-links' },
            React.createElement('a', { className: 'dsm-feedback-link', href: 'https://github.com/ouli-1242/dsh-plugin-tool-management', target: '_blank', rel: 'noreferrer', 'aria-label': 'GitHub' },
              React.createElement(GithubMark16, null), 'GitHub'))
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
            if (row.live.phase === 'failed') return '启动失败，检查配置后点「重启」重试'
            if (row.live.phase === 'active' && typeof row.toolCount === 'number' && row.toolCount === 0) return '已连接但没有工具：服务端可能未就绪'
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
                    React.createElement('div', { className: 'dsm-help' }, '停用的工具对模型不可见，改动即时生效'),
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
              : React.createElement('div', { className: 'dsm-empty' }, (normalizedQuery || levelFilter) ? '没有匹配的服务。' : '暂无 MCP 服务，点「新增服务」添加')

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
                React.createElement('span', { className: 'dsm-help' }, '1-32 位 [A-Za-z0-9_-]，补丁里按此名注册')),
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
                    React.createElement('span', { className: 'dsm-help' }, '需以 http(s):// 开头'))
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
              React.createElement('div', { className: 'dsm-detail-title' }, '备注（仅本机可见）'),
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
            React.createElement('p', { className: 'dsm-desc' }, '确定要删除「' + confirmRow.serverName + '」？配置将从补丁文件移除、工具立即下线，不可撤销'),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: () => setConfirmRow(null) }, '取消'),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', onClick: confirmRemove }, '删除')))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, 'MCP'),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, '管理本机 MCP 服务：新增、启停、重启与工具级开关。')),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading, onClick: () => refresh() }, '刷新'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openAdd }, '新增服务'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading, onClick: () => run('mcpm-set-all', { enabled: true }, 'setall') }, '全部启用'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading, onClick: () => run('mcpm-set-all', { enabled: false }, 'setall') }, '全部停用'))),
            React.createElement('div', { className: 'dsm-summary dsm-summary-3' },
              [[summary.total, '个服务'], [summary.enabled, '个已启用'], [summary.tools, '个工具']].map((item) =>
                React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1]))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', value: query, 'aria-label': '搜索服务', placeholder: '搜索服务名称、地址或命令', onChange: (ev) => setQuery(ev.target.value) }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { value: levelFilter, options: MCP_LEVEL_OPTIONS, onChange: setLevelFilter }))),
            restartInfo ? React.createElement('div', { className: 'dsm-feedback' }, '重启中… ' + restartInfo.name + '（已等待 ' + Math.max(0, Math.floor((Date.now() - restartInfo.startedAt) / 1000)) + ' 秒，完成后自动刷新）') : null,
            React.createElement(Notice, { kind: msg && msg.kind, text: msg && msg.text }),
            React.createElement(Notice, { kind: 'err', text: state.error }),
            React.createElement(Notice, { kind: 'warn', text: (state.errors && state.errors.length > 0) ? '读取补丁告警：' + state.errors.join('；') : null }),
            React.createElement(Notice, { kind: 'warn', text: (state.warnings && state.warnings.length > 0) ? state.warnings.join('；') : null }),
            groupsNode,
            formModalNode,
            detailNode,
            confirmNode)
        }

        // ---------- AGENTS.md 预设页：多套全局指令基线，应用=写入 ~/.dsh/AGENTS.md ----------
        function AgentsMdPage() {
          var st = React.useState({ loading: true, error: null, presets: [], current: null })
          var state = st[0], setState = st[1]
          var busyState = React.useState(null), busy = busyState[0], setBusy = busyState[1]
          var em = React.useState(null), editModal = em[0], setEditModal = em[1]
          var cm = React.useState(null), createModal = cm[0], setCreateModal = cm[1]
          var ac = React.useState(null), applyConfirm = ac[0], setApplyConfirm = ac[1]
          var importInput = React.useRef(null)
          function doImport(file) {
            if (!file) return
            var reader = new FileReader()
            reader.onload = function () {
              var id = String(file.name).replace(/\.(md|markdown|txt)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imported'
              setBusy('import')
              apiCall('agentsmd-import', { id: id, content: String(reader.result) }).then(function (res) {
                setBusy(null)
                if (res && res.ok) refresh()
                else if (res) setState(function (s) { return Object.assign({}, s, { error: res.error }) })
              }).catch(function () { setBusy(null) })
            }
            reader.readAsText(file)
          }

          function refresh() {
            apiCall('agentsmd-list', {}).then(function (res) {
              setState(function (s) { return { loading: false, error: res && res.ok ? null : ((res && res.error) || '加载失败'), presets: (res && res.presets) || [], current: s.current } })
            }).catch(function (e) { setState({ loading: false, error: String((e && e.message) || e), presets: [], current: null }) })
            apiCall('agentsmd-get-current', {}).then(function (res) {
              if (res && res.ok) setState(function (s) { return Object.assign({}, s, { current: res }) })
            }).catch(function () {})
          }
          React.useEffect(function () { refresh() }, [])

          var cur = state.current
          var curLabel = cur && cur.exists ? (cur.presetId || '（已外部修改）') : '（未设置）'

          function openEdit(p) {
            apiCall('agentsmd-read', { id: p.id }).then(function (res) {
              if (res && res.ok) setEditModal({ id: p.id, content: res.content })
            }).catch(function () {})
          }
          function doApply(id) {
            setBusy('apply-' + id)
            apiCall('agentsmd-apply', { id: id }).then(function () { setBusy(null); setApplyConfirm(null); refresh() }).catch(function () { setBusy(null) })
          }
          function doRemove(p) {
            setBusy('rm-' + p.id)
            apiCall('agentsmd-remove', { id: p.id }).then(function () { setBusy(null); setApplyConfirm(null); refresh() }).catch(function () { setBusy(null) })
          }
          function doCreate(id, from) {
            setBusy('create')
            apiCall('agentsmd-create', { id: id, from: from || undefined }).then(function (res) {
              setBusy(null)
              if (res && res.ok) { setCreateModal(null); refresh() }
              else if (res) setCreateModal(Object.assign({}, createModal, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          function doUpdate() {
            setBusy('update')
            apiCall('agentsmd-update', { id: editModal.id, content: editModal.content }).then(function (res) {
              setBusy(null)
              if (res && res.ok) { setEditModal(null); refresh() }
            }).catch(function () { setBusy(null) })
          }

          var body = state.loading
            ? React.createElement('div', { className: 'dsm-empty' }, '加载中…')
            : state.error
              ? React.createElement(Notice, { kind: 'err', text: state.error })
              : !state.presets.length
                ? React.createElement('div', { className: 'dsm-empty' }, '暂无预设，点「新建预设」创建')
                : React.createElement('div', { className: 'dsm-sources' }, state.presets.map(function (p) {
                    return React.createElement('div', { key: p.id, className: 'dsm-source' },
                      React.createElement('div', { className: 'dsm-source-head' },
                        React.createElement('div', { className: 'dsm-source-head-main' },
                          React.createElement('span', { className: 'dsm-source-title' }, p.id),
                          p.active ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, '生效中') : null),
                        React.createElement('div', { className: 'dsm-source-actions' },
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { openEdit(p) } }, '编辑'),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: function () { setApplyConfirm({ id: p.id }) }, title: '应用后新会话生效，当前会话不变' }, p.active ? '重新应用' : '应用'),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null, onClick: function () { setApplyConfirm({ id: p.id, remove: true }) } }, '删除'))))
                  }))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.prompts')),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, '管理全局指令基线：应用后写入 ~/.dsh/AGENTS.md，新会话生效。')),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { setCreateModal({ id: '', from: '', error: null }) } }, '新建预设'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null, onClick: function () { if (importInput.current) importInput.current.click() } }, '导入'))),
            body,
            editModal ? React.createElement(Modal, { title: '编辑预设 · ' + editModal.id, closeLabel: '取消', onClose: function () { setEditModal(null) } },
              React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', value: editModal.content, onChange: function (e) { setEditModal(Object.assign({}, editModal, { content: e.target.value })) } }),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null, onClick: doUpdate }, '保存'))) : null,
            createModal ? React.createElement(Modal, { title: '新建预设', closeLabel: '取消', onClose: function () { setCreateModal(null) } },
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, 'id（小写字母/数字/连字符）'),
                React.createElement('input', { className: 'dsm-control', value: createModal.id, onChange: function (e) { setCreateModal(Object.assign({}, createModal, { id: e.target.value })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '从现有预设复制（可选，留空=空白模板）'),
                React.createElement('input', { className: 'dsm-control', value: createModal.from, onChange: function (e) { setCreateModal(Object.assign({}, createModal, { from: e.target.value })) } })),
              createModal && createModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, createModal.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null, onClick: function () { doCreate(createModal.id, createModal.from) } }, '创建'))) : null,
            applyConfirm ? React.createElement(Modal, { title: applyConfirm.remove ? ('删除预设 · ' + applyConfirm.id) : ('应用预设 · ' + applyConfirm.id), closeLabel: '取消', onClose: function () { setApplyConfirm(null) } },
              applyConfirm.remove
                ? React.createElement('p', { className: 'dsm-help' }, '删除预设 ' + applyConfirm.id + ' ？此操作不可恢复。')
                : React.createElement('div', null,
                    React.createElement('p', { className: 'dsm-help' }, '将把 ' + applyConfirm.id + ' 的内容写入 ~/.dsh/AGENTS.md。'),
                    React.createElement('div', { className: 'dsm-feedback dsm-warning' }, '新会话生效；当前内容已备份到 __last-applied__')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn ' + (applyConfirm.remove ? 'dsm-btn-danger' : ''), disabled: busy !== null, onClick: function () { if (applyConfirm.remove) doRemove({ id: applyConfirm.id }); else doApply(applyConfirm.id) } }, applyConfirm.remove ? '确认删除' : '确认应用'))) : null,
            React.createElement('input', { ref: importInput, type: 'file', accept: '.md,.markdown,.txt', className: 'dsm-hidden-input', onChange: function (e) { if (e.target.files && e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; } }))
        }

        // 「工具」设置页：一个侧栏项，内部 tab 切换 场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话。
        function ToolsSection() {
          var tabState = React.useState('scenes')
          var active = tabState[0], setActive = tabState[1]
          var page = active === 'scenes' ? React.createElement(ScenesPage)
            : active === 'mcp' ? React.createElement(MCPPage)
            : active === 'skills' ? React.createElement(SkillManagerSection, { t: t })
            : active === 'subagents' ? React.createElement(SubagentsPage)
            : active === 'prompts' ? React.createElement(AgentsMdPage)
            : active === 'memory' ? React.createElement(MemoryPage)
            : React.createElement(HistoryPage)
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-tabs' },
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'scenes' ? ' dsm-tab-active' : ''), onClick: function () { setActive('scenes') } }, t('tabs.scenes')),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'mcp' ? ' dsm-tab-active' : ''), onClick: function () { setActive('mcp') } }, 'MCP'),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'skills' ? ' dsm-tab-active' : ''), onClick: function () { setActive('skills') } }, t('tabs.skills')),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'subagents' ? ' dsm-tab-active' : ''), onClick: function () { setActive('subagents') } }, t('tabs.subagents')),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'prompts' ? ' dsm-tab-active' : ''), onClick: function () { setActive('prompts') } }, t('tabs.prompts')),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'memory' ? ' dsm-tab-active' : ''), onClick: function () { setActive('memory') } }, t('tabs.memory')),
              React.createElement('button', { type: 'button', className: 'dsm-tab' + (active === 'sessions' ? ' dsm-tab-active' : ''), onClick: function () { setActive('sessions') } }, t('tabs.sessions')),
              React.createElement('div', { className: 'dsm-tabs-end' }, React.createElement(FeedbackLinks, null))),
            page)
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsm-tools', order: 16, label: '工具' },
          () => React.createElement(ToolsSection)
        ))


        // ---------- Skills 页（移植自 dsh-skills-manager，Apache-2.0；类名前缀 dsm-） ----------
        var react = React // 上游组件使用小写 react，别名到本文件的 React
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
        "title": "技能", "desc": "管理本机技能：启停、导入、创建与回收站；同名技能可指定哪个版本生效。", "link.project": "GitHub", "link.feedback": "问题反馈",
        "btn.create": "创建技能", "btn.import": "导入", "btn.refresh": "刷新", "btn.cancel": "取消", "btn.close": "关闭", "btn.detail": "查看详情", "btn.trash": "移到回收站", "btn.restore": "恢复", "btn.delete.forever": "永久删除", "btn.file.pick": "选择文件", "btn.folder.pick": "选择文件夹", "btn.import.now": "安装", "btn.create.now": "创建技能", "btn.disable": "停用", "btn.enable": "启用", "btn.open.editor": "用系统编辑器打开", "btn.activate": "启用这个", "btn.activate.title": "把当前来源的版本设为同名技能的首选并启用（不改动任何源文件）", "btn.unprefer": "取消首选", "btn.unprefer.title": "取消同名首选，回到按来源优先级自动选择",
        "btn.custom.add": "添加目录", "btn.custom.remove": "移除", "btn.openDir": "选择",
        "custom.add.title": "添加自定义技能目录", "custom.add.submit": "添加",
        "custom.add.path": "目录绝对路径", "custom.add.path.placeholder": "例如 D:\\skills\\my-skills",
        "custom.add.openDir.title": "浏览并选择文件夹", "custom.add.picker.title": "选择文件夹",
        "custom.add.label": "显示名称（可选）", "custom.add.label.placeholder": "自定义目录",
        "custom.add.help": "只读接入该目录；目录与源文件都不会被修改",
        "confirm.custom.remove.title": "移除自定义目录",
        "confirm.custom.remove.desc": "移除后该目录的技能不再列出（文件不受影响）：{name}",
        "result.custom.added": "已添加自定义目录：{path}", "result.custom.removed": "已移除自定义目录",
        "status.enabled": "已启用", "status.disabled": "已停用", "status.invalid": "诊断异常", "status.shadowed": "被覆盖", "status.shadowed.hint": "同名技能「{name}」正在生效；点「启用这个」可改用当前来源的版本", "status.preferred": "同名首选", "status.readonly": "源文件只读", "status.manageable": "可管理", "status.project": "项目级", "status.rank": "优先级 {rank}", "status.source.on": "已启用", "status.source.off": "已停用", "status.bundle": "目录技能", "status.single": "单文件",
        "summary.total.one": "{count} 个技能", "summary.total.other": "{count} 个技能", "summary.enabled.one": "{count} 个已启用", "summary.enabled.other": "{count} 个已启用", "summary.disabled.one": "{count} 个已停用", "summary.disabled.other": "{count} 个已停用", "summary.issues.one": "{count} 个诊断项", "summary.issues.other": "{count} 个诊断项", "summary.group.one": "{count} 个技能", "summary.group.other": "{count} 个技能", "table.skill": "技能名称与描述", "table.status": "调用状态",
        "filter.source": "来源", "filter.all": "全部来源", "filter.option": "{name}（{count}）", "search": "搜索", "search.placeholder": "搜索技能名称或描述", "search.clear": "清除搜索",
        "empty.search": "没有匹配的技能", "empty.source": "该来源不存在或暂无技能", "loading": "正在加载技能…", "note.missing": "未提供简介", "source.toggle": "启停来源", "skill.toggle": "启停技能",
        "source.external.note": "只读接入，启停不改写源文件", "source.dsh.note": "可创建、导入、移到回收站；启停只改管理器状态",
        "detail.title": "技能详情", "detail.body": "正文", "detail.frontmatter": "元数据", "detail.noFrontmatter": "该技能未提供元数据。", "detail.diagnostics": "诊断", "detail.path": "源文件", "detail.noIssues": "未发现诊断问题。",
        "create.title": "创建技能", "create.target": "创建位置", "create.name": "名称", "create.name.placeholder": "例如 code-review-helper", "create.description": "简介", "create.description.placeholder": "一句话说明什么时候使用", "create.body": "正文（Markdown）", "create.body.placeholder": "写下技能要遵循的指令、步骤和边界…", "create.chat.note": "对话里 create_skill 建的是用户级技能",
        "import.title": "导入技能", "upload.drop.title": "点击或拖入此处", "upload.drop.copy": "支持 .zip、技能文件夹或单个 SKILL.md", "upload.selected.one": "{count} 个文件 · {size}", "upload.selected.other": "{count} 个文件 · {size}", "upload.remove": "移除所选内容", "upload.requirements": "文件要求", "upload.requirement.skill": "压缩包或文件夹需包含 SKILL.md", "upload.requirement.frontmatter": "SKILL.md 需包含 YAML 格式的技能名称和描述", "upload.requirement.copy": "导入时复制完整内容，不修改原始来源", "upload.importing": "正在安装…", "status.selected": "已选择", "select.file.invalid": "请选择 .zip 或单个 SKILL.md", "select.folder.invalid": "该文件夹里没有 SKILL.md", "error.browse.absolute": "目录路径必须是绝对路径：{path}", "error.browse.unreadable": "无法读取目录：{path}", "error.browse.notDirectory": "不是目录：{path}",
        "trash.title": "回收站", "trash.count.one": "{count} 个待处理技能", "trash.count.other": "{count} 个待处理技能", "trash.empty": "回收站为空", "trash.deletedAt": "删除于 {time}", "trash.source": "来源：{source}",
        "confirm.trash.title": "移到回收站？", "confirm.trash.desc": "「{name}」将移入回收站，可恢复", "confirm.delete.title": "永久删除？", "confirm.delete.desc": "「{name}」将永久删除，无法恢复",
        "result.created": "已创建技能：{name}", "result.imported": "导入完成：{names}", "result.importPartial": "已导入：{imported}；已跳过同名技能：{skipped}", "result.importSkipped": "未导入任何技能；已跳过同名技能：{names}", "result.importEmpty": "未导入任何技能。", "result.importWarnings": "{result}；警告：{warnings}", "result.restored": "已恢复技能：{name}", "result.trashed": "已移到回收站：{name}", "result.deleted": "已永久删除：{name}", "result.updated": "状态已更新。", "result.preferred": "已改为生效：{name}（{source}）", "result.unpreferred": "已取消同名首选：{name}", "result.opened": "已用系统默认程序打开：{path}", "error.action": "操作失败：{error}",
        "warning.scan.truncated": "技能目录较大或嵌套过深，部分技能未显示：{path}", "warning.state.invalid": "状态文件不可读，已安全停用所有技能：{path}", "warning.backupUncleaned": "旧版本备份未清理：{path}（{error}）", "warning.project.unavailable": "无法从宿主读取活动工作区，项目技能未显示：{path}",
        "error.root.readonly": "该来源不允许{action}", "error.root.disabled": "「{name}」这个来源已整体停用，请先在该来源行启用它", "error.root.unknown": "未知技能来源：{root}", "error.root.unsafe": "项目技能目录不安全，拒绝写入：{path}", "error.skill.notFound": "技能不存在: {name}", "error.skill.noFrontmatter": "缺少 frontmatter，无法{action}：{name}", "error.skill.notLoadable": "技能结构不完整，无法{action}: {name}",
        "error.source.notFound": "路径不存在: {path}", "error.source.symlink": "不支持符号链接来源：{path}", "error.source.unrecognized": "无法识别的 skill 来源: {path}", "error.source.tooDeep": "skill 来源目录层级超过 {depth} 层: {path}",
        "error.import.overlap": "该目录与 DSH 技能目录重叠", "error.import.emptySource": "目录下没有 skill 条目：{path}", "error.import.invalidName": "名称不合法：{name}", "error.import.duplicateName": "批量来源中存在多个同名技能: {name}", "error.import.failed": "导入失败", "error.import.rollbackFailed": "覆盖导入回滚失败，备份保留在: {path}（{error}）",
        "error.upload.path": "上传内容包含非法路径：{path}", "error.upload.encoding": "上传内容编码无效", "error.upload.empty": "上传内容为空", "error.upload.tooMany": "上传文件过多，最多 {limit} 个", "error.upload.tooLarge": "上传内容过大，限制为 {limit} 字节", "error.upload.archiveTooLarge": "ZIP 压缩包过大，限制为 {limit} 字节", "error.upload.duplicate": "上传内容包含重复路径：{path}", "error.upload.zipInvalid": "ZIP 压缩包无法解压",
        "error.trash.notFound": "回收站条目不存在: {id}", "error.trash.conflict": "无法恢复，同名技能已存在: {name}", "error.trash.invalid": "回收站条目路径非法: {id}", "error.trash.projectUnavailable": "原项目当前不在活动工作区中，无法恢复：{path}", "error.trash.rollbackFailed": "移入回收站回滚失败，未恢复内容保留在: {path}（{error}）",
        "error.state.invalid": "技能管理器状态文件不可读，已拒绝覆盖：{path}",
        "error.create.descriptionRequired": "技能简介不能为空", "error.create.bodyRequired": "技能正文不能为空", "error.create.tooLarge": "技能内容过长", "error.create.conflict": "同名技能已存在: {name}",
        "error.proto.forbidden": "禁止的修改请求（缺少客户端标记）", "error.proto.forbiddenHost": "禁止的请求来源（非法 Host）", "error.proto.contentType": "请求体必须是 application/json", "error.proto.method": "不支持的请求方法", "error.proto.unknownAction": "未知操作", "error.proto.bodyTooLarge": "请求体过大", "error.proto.invalidJson": "请求体不是合法 JSON", "error.proto.nonJson": "服务端返回非 JSON 响应（HTTP {status}）",
        "diagnostic.frontmatter.missing": "缺少完整 YAML frontmatter", "diagnostic.name.missing": "frontmatter 缺少 name", "diagnostic.name.invalid": "技能名需 kebab-case：{name}", "diagnostic.description.missing": "frontmatter 缺少 description", "diagnostic.invocation.invalid": "调用策略字段值无效", "diagnostic.shadowed": "被更高优先级来源 {root} 覆盖",
        "action.enable": "启用", "action.disable": "停用", "action.create": "创建", "action.delete": "删除", "action.restore": "恢复", "action.toggle": "启用或停用",
        "root.dsh": "DSH 技能", "root.agents": "公共 Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "项目 DSH", "root.projectAgents": "项目 Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor",
        "memory.title": "记忆",
        "tabs.scenes": "场景", "tabs.skills": "技能", "tabs.subagents": "子智能体", "tabs.prompts": "提示词", "tabs.memory": "记忆", "tabs.sessions": "会话",
        "scenes.title": "场景", "scenes.desc": "按场景搭配 MCP 工具、技能、子智能体与记忆；启用场景后记忆自动注入，档案可一键切入/退出。",
        "scenes.hasArchive": "档案", "scenes.mcp.hint": "添加「MCP 工具集」后，勾选要启用的服务器（含未运行的）；「选工具」可细化到具体工具。",
        "scenes.seg.selectAll": "全选", "scenes.seg.clear": "清空", "scenes.seg.checked": "{checked}/{total} 已勾选",
        "scenes.archive.sectionOff": "未定义",
        "scenes.archive.summary": "档案：MCP {mcp} 台 · 技能 {skills} 个 · 子智能体 {subagents} 个",
        "scenes.archive.note": "段未定义 = 不改动该域；段已定义但一项不勾 = 全部停用。",
        "scenes.mcp.noServers": "还没有可选的 MCP 服务器", "scenes.mcp.toolCount": "{count} 个工具", "scenes.skills.empty": "还没有可选的技能",
        "scenes.mcp.allTools": "全部工具", "scenes.mcp.pickedCount": "指定 {count} 个工具", "scenes.mcp.notRunning": "未运行", "scenes.mcp.pickTools": "选工具",
        "scenes.mcp.toolsOf": "工具明细", "scenes.mcp.back": "返回", "scenes.mcp.noTools": "该服务器当前没有可列出的工具（未运行或无工具）", "scenes.mcp.drillHint": "勾选 = 该场景下启用；不勾 = 停用。整台勾选时默认全部工具。",
        "scenes.skills.hint": "添加「技能集」后，勾选该场景下启用的技能。", "scenes.subagents.hint": "添加「子智能体绑定」后，勾选本场景可调用的人设。", "scenes.subagents.empty": "还没有人设——到「子智能体」页创建。",
        "memory.mode.current": "当前模式", "memory.mode.set": "设为当前模式", "memory.mode.exit": "退出模式",
        "memory.archive.edit": "档案", "memory.archive.title": "场景档案",
        "memory.archive.tools": "MCP 工具集", "memory.archive.skills": "技能集", "memory.archive.subagents": "子智能体绑定",
        "memory.archive.removeSection": "移除段", "memory.archive.save": "保存到场景",
        "memory.archive.addTools": "+ 添加 MCP 工具集", "memory.archive.addSkills": "+ 添加技能集", "memory.archive.addSubagents": "+ 添加子智能体绑定",
        "memory.archive.stale": "失效项（已不存在，已跳过）: {items}",
        "memory.result.archiveSaved": "已保存场景档案：{name}", "memory.result.modeSet": "已进入模式：{name}", "memory.result.modeExited": "已退出模式",
        "memory.desc": "管理场景记忆：启用场景里的记忆自动进入系统提示词；场景留空 = 全局注入。",
        "memory.btn.refresh": "刷新", "memory.btn.new": "新建记忆", "memory.btn.create": "创建", "memory.btn.save": "保存",
        "memory.btn.diagnose": "体检", "memory.btn.delete.confirm": "移入回收站",
        "memory.diagnose.title": "记忆体检", "memory.diagnose.summary": "{rules} 条记忆 · {scenes} 个场景 · {issues} 个问题", "memory.diagnose.clean": "未发现问题，一切正常。",
        "memory.diag.error": "错误", "memory.diag.warning": "警告", "memory.diag.info": "提示",
"memory.stat.total": "条记忆", "memory.stat.scenes": "个启用场景", "memory.stat.sceneCount": "个场景", "memory.status.sceneOff": "场景未启用", "memory.status.off": "本条已停用",
        "memory.budget.label": "注入预算", "memory.budget.bytes": "{used} / {max} 字节",
        "memory.budget.over": "已超限",
        "memory.budget.truncated": "超出预算，段尾已列出未注入的记忆",
        "memory.budget.dropped": "本次未注入：{names}",
        "memory.scene.enable": "启用", "memory.scene.enableAll": "全部启用", "memory.scene.off": "未启用", "memory.scene.shared": "常开", "memory.scene.global.tag": "任何对话都注入",
        "memory.scene.global": "全局", "memory.scene.count": "{count} 条记忆", "memory.scene.new": "新建记忆", "memory.scene.pick": "留空 = 全局（任何对话都注入）；也可选已有场景或直接输入新场景名", "memory.scene.browse": "选择已有",
        "memory.scene.empty": "该场景暂无记忆",
        "memory.search.placeholder": "搜索名称 / 描述 / 场景", "memory.filter.all": "全部场景",
        "memory.empty": "还没有记忆，点「新建记忆」", "memory.empty.search": "没有匹配的记忆",
        "memory.loading": "正在加载…",
        "memory.enable": "启用", "memory.edit": "编辑", "memory.delete": "删除",
        "memory.form.flat": "flat", "memory.form.bundle": "bundle", "memory.derived": "派生", "memory.fill.frontmatter": "补齐 frontmatter",
        "memory.shadowed.hint": "同名 bundle 存在，本条不加载",
        "memory.create.title": "新建记忆", "memory.edit.title": "编辑记忆", "memory.edit.group.lock": "编辑时场景不可修改",
        "memory.field.group": "场景", "memory.field.group.placeholder": "留空 = 全局，例如 办公 / 日常 / code-review", "memory.field.group.hint": "留空 = 全局（任何对话都注入）；也可填 ~/.dsh/scene-memory/ 下的目录名（中英文皆可）",
        "memory.field.name": "名称", "memory.field.name.placeholder": "例如 站会流程 / standup-notes", "memory.name.hint": "就是 .md 文件名；中文可以（如 站会流程）", "memory.name.invalid": "名称不合法（非空、≤64 字符、不含 / \\ < > : \" | ? *、不以 . 开头）",
        "memory.field.description": "描述", "memory.field.description.placeholder": "一句话说明用途（留空取正文首行）",
        "memory.field.body": "正文（Markdown）", "memory.field.body.placeholder": "写下要记住的约定、流程和边界…",
        "memory.field.form": "形态", "memory.field.attach": "附件",
        "memory.attach.add": "添加附件", "memory.attach.empty": "暂无附件", "memory.attach.pending": "待上传", "memory.attach.remove": "移除附件",
        "memory.attach.hint": "附件随记忆存放，不会进入提示词", "memory.attach.flat": "flat 是单文件，不能带附件", "memory.attach.tooLarge": "附件过大：{name}（上限 {limit} MB）",
        "memory.delete.title": "移入回收站？", "memory.delete.desc": "「{name}」将移入回收站，可恢复",
        "memory.result.created": "已创建记忆：{name}", "memory.result.updated": "已保存记忆：{name}", "memory.result.removed": "已移入回收站：{name}", "memory.result.toggled": "已更新记忆状态：{name}", "memory.result.active": "已更新启用场景",
        "memory.result.restored": "已恢复记忆：{name}", "memory.result.trashRemoved": "已永久删除：{name}",
        "memory.result.createdAttached": "已创建记忆：{name}（含 {count} 个附件）", "memory.result.updatedAttached": "已保存记忆：{name}（含 {count} 个附件）", "memory.result.attachFailed": "记忆已保存，但附件失败：{error}",
        "memory.trash.open": "回收站", "memory.trash.title": "记忆回收站", "memory.trash.empty": "回收站为空",
        "memory.trash.count": "{count} 条已删除的记忆", "memory.trash.deletedAt": "删除于 {time}",
        "memory.trash.restore": "恢复", "memory.trash.purge": "永久删除",
        "memory.trash.confirmTitle": "永久删除？", "memory.trash.confirmDesc": "「{name}」将永久删除，无法恢复",
        "memory.btn.newScene": "新建场景", "memory.btn.deleteScene": "删除场景",
        "memory.scene.createTitle": "新建场景", "memory.scene.createHelp": "建好后往里丢 .md 即可，每个文件就是一条记忆",
        "memory.deleteScene.title": "删除场景？", "memory.deleteScene.desc": "将删除空文件夹「{name}」（非空不能删）",
        "memory.result.sceneCreated": "已创建场景：{name}", "memory.result.sceneRemoved": "已删除场景：{name}",
        "memory.table.name": "记忆名称与描述", "memory.table.tags": "标记", "memory.table.status": "状态",
        "error.rules.invalidGroup": "场景/分组名不合法（非空、≤64 字符、不含路径分隔符与 < > : \" | ? *、不以 . 开头）", "error.rules.invalidName": "记忆名不合法（非空、≤64 字符、不含路径分隔符与 < > : \" | ? *、不以 . 开头）", "error.rules.descriptionRequired": "描述不能为空", "error.rules.descriptionTooLong": "描述过长（不能超过 500 字符）", "error.rules.bodyRequired": "正文不能为空", "error.rules.tooLarge": "规则内容过大", "error.rules.shadowed": "规则被同名 bundle 遮蔽，无法写入", "error.rules.notFound": "规则不存在", "error.rules.budgetExceeded": "场景记忆段超出预算", "error.rules.ioFailed": "文件操作失败", "error.rules.sceneNotEmpty": "场景不为空，无法删除", "error.rules.notBundle": "该记忆是 flat（单文件），不能带附件", "error.rules.noFiles": "没有选择附件", "error.rules.emptyFile": "附件内容为空", "error.rules.fileTooLarge": "附件过大（单个上限 {limit} MB）", "error.rules.tooManyFiles": "一次最多 {limit} 个附件", "error.rules.sceneInMode": "该场景正处在当前模式，请先退出模式再删除",
        "memory.archive.emptySection": "该段已定义但没有勾选任何条目 = 全部停用",
        "subagents.title": "子智能体", "subagents.desc": "管理人设文件（~/.dsh/subagents/*.md）：一个文件一个人设，正文即子代理的系统提示词。",
        "subagents.new": "新建人设", "subagents.empty": "还没有人设——点「新建人设」创建第一个。",
        "subagents.create": "新建人设", "subagents.edit": "编辑人设",
        "subagents.field.name": "人设名", "subagents.field.name.hint": "就是文件名（非空、≤64 字符、不含路径分隔符与 < > : | ? *、不以 . 开头）；创建后不可改名。",
        "subagents.field.description": "描述", "subagents.field.description.placeholder": "例如 擅长 Java 后端实现与重构；需要写或改 Java 代码时调用", "subagents.field.description.hint": "一句话即可：模型据此判断何时调用它。",
        "subagents.field.model": "模型", "subagents.field.model.placeholder": "留空继承主会话",
        "subagents.field.tools": "工具白名单", "subagents.field.tools.hint": "逗号分隔；留空 = 不限制（基础组合全集）。",
        "subagents.field.body": "人设提示词", "subagents.field.body.placeholder": "写下这个人设的身份、职责与工作方式…",
        "subagents.result.saved": "已保存人设：{name}", "subagents.result.deleted": "已删除人设：{name}",
        "subagents.delete.title": "删除人设？", "subagents.delete.desc": "将删除「{name}」的人设文件，不可恢复",
        "subagents.import": "导入", "subagents.import.title": "导入人设", "subagents.import.hint": "支持 .md 或 .zip（可多选、可拖入）：一个 .md = 一个人设，文件名即人设名；同名自动跳过。",
        "subagents.result.imported": "已导入 {count} 个人设：{names}",
        "memory.import": "导入记忆", "memory.import.title": "导入记忆", "memory.import.scene": "导入到场景",
        "memory.import.sceneHint": "留空 = 全局（任何对话都注入）；.zip 内带目录时以目录名当场景。",
        "memory.import.hint": "支持 .md 或 .zip（可多选、可拖入）：一个 .md = 一条记忆；zip 内 <场景>/<名>/SKILL.md 按 bundle 导入，同层文件作附件；同名自动跳过。",
        "memory.result.imported": "已导入 {count} 条记忆：{names}",
        "memory.scene.global.hint": "全局（不选场景 · 任何对话都注入）",
        "import.pick": "选择文件", "import.selected": "已选 {count} 个文件", "import.clear": "清空选择", "import.submit": "安装",
        "import.none": "没有导入任何文件（全部被跳过）", "import.skipped": "已跳过：{items}",
        "error.import.noFiles": "没有选择要导入的文件"
      },
      en: {
        "title": "Skills", "desc": "Manage skills on this machine: enable, import, create and trash; pick which copy of a shared name is active.", "link.project": "GitHub", "link.feedback": "Issues",
        "btn.create": "Create skill", "btn.import": "Import", "btn.refresh": "Refresh", "btn.cancel": "Cancel", "btn.close": "Close", "btn.detail": "View details", "btn.trash": "Move to trash", "btn.restore": "Restore", "btn.delete.forever": "Delete forever", "btn.file.pick": "Choose file", "btn.folder.pick": "Choose folder", "btn.import.now": "Install", "btn.create.now": "Create skill", "btn.disable": "Disable", "btn.enable": "Enable", "btn.open.editor": "Open in editor", "btn.activate": "Use this one", "btn.activate.title": "Make this source's copy the active one for this shared name and enable it (source files are never touched)", "btn.unprefer": "Auto again", "btn.unprefer.title": "Clear the manual choice and go back to automatic source priority",
        "btn.custom.add": "Add folder",
        "btn.custom.remove": "Remove",
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
        "status.enabled": "Enabled", "status.disabled": "Disabled", "status.invalid": "Needs attention", "status.shadowed": "Shadowed", "status.shadowed.hint": "The copy “{name}” is the active one; click “Use this one” to switch to this source instead", "status.preferred": "Manually chosen", "status.readonly": "Source read-only", "status.manageable": "Manageable", "status.project": "Project scoped", "status.rank": "Rank {rank}", "status.source.on": "Enabled", "status.source.off": "Disabled", "status.bundle": "Bundle", "status.single": "Single file",
        "summary.total.one": "{count} skill", "summary.total.other": "{count} skills", "summary.enabled.one": "{count} enabled", "summary.enabled.other": "{count} enabled", "summary.disabled.one": "{count} disabled", "summary.disabled.other": "{count} disabled", "summary.issues.one": "{count} diagnostic", "summary.issues.other": "{count} diagnostics", "summary.group.one": "{count} skill", "summary.group.other": "{count} skills", "table.skill": "Skill name and description", "table.status": "Invocation status",
        "filter.source": "Source", "filter.all": "All sources", "filter.option": "{name} ({count})", "search": "Search", "search.placeholder": "Search skill names or descriptions", "search.clear": "Clear search",
        "empty.search": "No matching skills", "empty.source": "This source is missing or has no skills", "loading": "Loading skills…", "note.missing": "No description provided", "source.toggle": "Toggle source", "skill.toggle": "Toggle skill",
        "source.external.note": "Read-only; toggles never rewrite source files", "source.dsh.note": "Create, import, trash; toggles only change manager state",
        "detail.title": "Skill details", "detail.body": "Body", "detail.frontmatter": "Metadata", "detail.noFrontmatter": "This skill provides no metadata.", "detail.diagnostics": "Diagnostics", "detail.path": "Source file", "detail.noIssues": "No diagnostic issues found.",
        "create.title": "Create skill", "create.target": "Create in", "create.name": "Name", "create.name.placeholder": "e.g. code-review-helper", "create.description": "Description", "create.description.placeholder": "One sentence describing when to use it", "create.body": "Body (Markdown)", "create.body.placeholder": "Write the instructions, steps, and boundaries…", "create.chat.note": "create_skill in chat creates user-level skills",
        "import.title": "Import skill", "upload.drop.title": "Click or drop here", "upload.drop.copy": "Supported: .zip, a skill folder, or one SKILL.md", "upload.selected.one": "{count} file · {size}", "upload.selected.other": "{count} files · {size}", "upload.remove": "Remove selection", "upload.requirements": "File requirements", "upload.requirement.skill": "Archives and folders must contain SKILL.md", "upload.requirement.frontmatter": "SKILL.md must include a YAML name and description", "upload.requirement.copy": "Import copies all content and never modifies the source", "upload.importing": "Installing…", "status.selected": "Selected", "select.file.invalid": "Choose a .zip archive or one SKILL.md.", "select.folder.invalid": "No SKILL.md was found in the selected folder.", "error.browse.absolute": "Folder path must be absolute: {path}", "error.browse.unreadable": "Could not read folder: {path}", "error.browse.notDirectory": "Not a folder: {path}",
        "trash.title": "Trash", "trash.count.one": "{count} skill pending", "trash.count.other": "{count} skills pending", "trash.empty": "Trash is empty", "trash.deletedAt": "Deleted {time}", "trash.source": "Source: {source}",
        "confirm.trash.title": "Move to trash?", "confirm.trash.desc": "“{name}” moves to trash and can be restored", "confirm.delete.title": "Delete forever?", "confirm.delete.desc": "“{name}” is deleted forever and cannot be recovered",
        "result.created": "Created skill: {name}", "result.imported": "Import complete: {names}", "result.importPartial": "Imported: {imported}; skipped existing skills: {skipped}", "result.importSkipped": "No skills were imported; existing skills were skipped: {names}", "result.importEmpty": "No skills were imported.", "result.importWarnings": "{result}; warnings: {warnings}", "result.restored": "Restored skill: {name}", "result.trashed": "Moved to trash: {name}", "result.deleted": "Permanently deleted: {name}", "result.updated": "Status updated.", "result.preferred": "Now active: {name} ({source})", "result.unpreferred": "Cleared the manual choice: {name}", "error.action": "Action failed: {error}",
        "warning.scan.truncated": "Some skills were not shown because the directory is too large or deeply nested: {path}", "warning.state.invalid": "The manager state file could not be read; all skills are disabled and state writes are blocked until it is repaired: {path}", "warning.backupUncleaned": "Old version backup was not cleaned up: {path} ({error})", "warning.project.unavailable": "The active workspace could not be read from the host, so its project skills are hidden: {path}",
        "error.root.readonly": "This source does not allow {action}", "error.root.disabled": "The “{name}” source is disabled as a whole — enable that source first", "error.root.unknown": "Unknown skill source: {root}", "error.root.unsafe": "The project skill directory is unsafe, so the write was refused: {path}", "error.skill.notFound": "Skill not found: {name}", "error.skill.noFrontmatter": "Skill lacks complete frontmatter, cannot {action}: {name}", "error.skill.notLoadable": "Skill structure is incomplete, cannot {action}: {name}",
        "error.source.notFound": "Path does not exist: {path}", "error.source.symlink": "Symlinked sources are not supported: {path}", "error.source.unrecognized": "Unrecognized skill source: {path}", "error.source.tooDeep": "Skill source directory depth exceeds {depth} levels: {path}",
        "error.import.overlap": "This folder overlaps the DSH skills folder", "error.import.emptySource": "No skill entries in this folder: {path}", "error.import.invalidName": "Invalid name: {name}", "error.import.duplicateName": "Batch source contains duplicate skill names: {name}", "error.import.failed": "Import failed", "error.import.rollbackFailed": "Overwrite import rollback failed; backups kept at: {path} ({error})",
        "error.upload.path": "Upload contains an invalid path: {path}", "error.upload.encoding": "Upload encoding is invalid", "error.upload.empty": "Upload is empty", "error.upload.tooMany": "Too many uploaded files; maximum {limit}", "error.upload.tooLarge": "Upload is too large; limit {limit} bytes", "error.upload.archiveTooLarge": "ZIP archive is too large; limit {limit} bytes", "error.upload.duplicate": "Upload contains a duplicate path: {path}", "error.upload.zipInvalid": "ZIP archive could not be extracted",
        "error.trash.notFound": "Trash item not found: {id}", "error.trash.conflict": "Cannot restore because a skill with the same name exists: {name}", "error.trash.invalid": "Invalid trash item path: {id}", "error.trash.projectUnavailable": "The original project is not an active workspace, so this skill cannot be restored: {path}", "error.trash.rollbackFailed": "Move-to-trash rollback failed; unrecovered content was kept at: {path} ({error})",
        "error.state.invalid": "The manager state file could not be read, so overwriting it was refused: {path}",
        "error.create.descriptionRequired": "Skill description is required", "error.create.bodyRequired": "Skill body is required", "error.create.tooLarge": "Skill content is too large", "error.create.conflict": "A skill with the same name already exists: {name}",
        "error.proto.forbidden": "Forbidden mutation request (missing client marker)", "error.proto.forbiddenHost": "Forbidden request origin (invalid host)", "error.proto.contentType": "Content type must be application/json", "error.proto.method": "Method not allowed", "error.proto.unknownAction": "Unknown action", "error.proto.bodyTooLarge": "Request body too large", "error.proto.invalidJson": "Invalid JSON request body", "error.proto.nonJson": "Server returned a non-JSON response (HTTP {status})",
        "diagnostic.frontmatter.missing": "Missing complete YAML frontmatter", "diagnostic.name.missing": "Frontmatter is missing name", "diagnostic.name.invalid": "Skill name must be kebab-case: {name}", "diagnostic.description.missing": "Frontmatter is missing description", "diagnostic.invocation.invalid": "Invocation policy value is invalid", "diagnostic.shadowed": "Shadowed by higher-priority source {root}",
        "action.enable": "enable", "action.disable": "disable", "action.create": "create", "action.delete": "delete", "action.restore": "restore", "action.toggle": "enabling or disabling",
        "root.dsh": "DSH skills", "root.agents": "Shared Agent", "root.ccswitch": "CC Switch", "root.projectDsh": "Project DSH", "root.projectAgents": "Project Agent", "root.codex": "Codex", "root.claude": "Claude", "root.gemini": "Gemini", "root.opencode": "OpenCode", "root.cursor": "Cursor",
        "memory.title": "Memories",
        "tabs.scenes": "Scenes", "tabs.skills": "Skills", "tabs.subagents": "Subagents", "tabs.prompts": "Prompts", "tabs.memory": "Memories", "tabs.sessions": "Sessions",
        "scenes.title": "Scenes", "scenes.desc": "Combine MCP tools, skills, subagents and memories per scene; enabling a scene injects its memories, and a profile can be entered or left in one click.",
        "scenes.hasArchive": "profile", "scenes.mcp.hint": "Add the MCP section first, then check the servers to enable (stopped ones included); use Pick tools to narrow to specific tools.",
        "scenes.seg.selectAll": "Select all", "scenes.seg.clear": "Clear", "scenes.seg.checked": "{checked}/{total} selected",
        "scenes.archive.sectionOff": "not defined",
        "scenes.archive.summary": "Profile: {mcp} MCP server(s) · {skills} skill(s) · {subagents} subagent(s)",
        "scenes.archive.note": "An undefined section leaves that domain untouched; a defined-but-empty section disables everything in it.",
        "scenes.mcp.noServers": "No MCP servers to pick from yet", "scenes.mcp.toolCount": "{count} tool(s)", "scenes.skills.empty": "No skills to pick from yet",
        "scenes.mcp.allTools": "all tools", "scenes.mcp.pickedCount": "{count} tools picked", "scenes.mcp.notRunning": "not running", "scenes.mcp.pickTools": "Pick tools",
        "scenes.mcp.toolsOf": "Tool details", "scenes.mcp.back": "Back", "scenes.mcp.noTools": "No tools listed for this server (not running or no tools)", "scenes.mcp.drillHint": "Checked = enabled in this scene; unchecked = disabled. A whole-server check defaults to all tools.",
        "scenes.skills.hint": "Add the skills section first, then check the skills enabled in this scene.", "scenes.subagents.hint": "Add the subagent section first, then check the personas callable in this scene.", "scenes.subagents.empty": "No personas yet — create one on the Subagents page.",
        "memory.mode.current": "Active mode", "memory.mode.set": "Set as active mode", "memory.mode.exit": "Exit mode",
        "memory.archive.edit": "Profile", "memory.archive.title": "Scene profile",
        "memory.archive.tools": "MCP tools", "memory.archive.skills": "Skills", "memory.archive.subagents": "Subagent binding",
        "memory.archive.addTools": "+ Tools", "memory.archive.addSkills": "+ Skills", "memory.archive.addSubagents": "+ Subagents",
        "memory.archive.removeSection": "Remove section", "memory.archive.save": "Save to scene",
        "memory.archive.emptySection": "Section defined with nothing checked = all disabled", "memory.archive.stale": "Stale entries (no longer exist, skipped): {items}",
        "memory.result.archiveSaved": "Scene profile saved: {name}", "memory.result.modeSet": "Entered mode: {name}", "memory.result.modeExited": "Exited mode",
        "memory.desc": "Manage scene memories: memories in enabled scenes are injected into the system prompt automatically, and a blank scene means global injection.",
        "memory.btn.refresh": "Refresh", "memory.btn.new": "New memory", "memory.btn.create": "Create", "memory.btn.save": "Save",
        "memory.btn.diagnose": "Check", "memory.btn.delete.confirm": "Move to trash",
        "memory.diagnose.title": "Memory checkup", "memory.diagnose.summary": "{rules} memories · {scenes} scenes · {issues} issues", "memory.diagnose.clean": "No issues found.",
        "memory.diag.error": "Error", "memory.diag.warning": "Warning", "memory.diag.info": "Info",
"memory.stat.total": "memories", "memory.stat.scenes": "enabled scenes", "memory.stat.sceneCount": "scenes", "memory.status.sceneOff": "scene off", "memory.status.off": "this memory is off",
        "memory.budget.label": "Injection budget", "memory.budget.bytes": "{used} / {max} bytes",
        "memory.budget.over": "Over budget",
        "memory.budget.truncated": "Over budget — the memories left out are listed at the end",
        "memory.budget.dropped": "Not injected this time: {names}",
        "memory.scene.enable": "Enabled", "memory.scene.enableAll": "Enable all", "memory.scene.off": "Off", "memory.scene.shared": "always on", "memory.scene.global.tag": "injected everywhere",
        "memory.scene.global": "Global", "memory.scene.count": "{count} memories", "memory.scene.new": "New memory", "memory.scene.pick": "Blank = global (injected into every conversation); or pick a scene / type a new one", "memory.scene.browse": "Pick existing",
        "memory.scene.empty": "No memories in this scene yet",
        "memory.search.placeholder": "Search name / description / scene", "memory.filter.all": "All scenes",
        "memory.empty": "No memories yet — click “New memory”", "memory.empty.search": "No matching memories",
        "memory.loading": "Loading…",
        "memory.enable": "Enabled", "memory.edit": "Edit", "memory.delete": "Delete",
        "memory.form.flat": "flat", "memory.form.bundle": "bundle", "memory.derived": "derived", "memory.fill.frontmatter": "Fill frontmatter",
        "memory.shadowed.hint": "A bundle with the same name exists, so this one is not loaded",
        "memory.create.title": "New memory", "memory.edit.title": "Edit memory", "memory.edit.group.lock": "The scene cannot be changed while editing",
        "memory.field.group": "Scene", "memory.field.group.placeholder": "blank = global, e.g. office / daily / code-review", "memory.field.group.hint": "Blank = global (injected into every conversation); otherwise a folder name under ~/.dsh/scene-memory/ (any Unicode)",
        "memory.field.name": "Name", "memory.field.name.placeholder": "e.g. 站会流程 / standup-notes", "memory.name.hint": "The .md file name — Chinese is fine (e.g. 站会流程)", "memory.name.invalid": "Invalid name (non-empty, ≤64 chars, no / \\ < > : \" | ? *, must not start with a dot)",
        "memory.field.description": "Description", "memory.field.description.placeholder": "One line on what it is for (blank = first body line)",
        "memory.field.body": "Body (Markdown)", "memory.field.body.placeholder": "Write down the conventions, steps, and boundaries to remember…",
        "memory.field.form": "Form", "memory.field.attach": "Attachments",
        "memory.attach.add": "Add files", "memory.attach.empty": "No attachments yet", "memory.attach.pending": "pending", "memory.attach.remove": "Remove attachment",
        "memory.attach.hint": "Stored with the memory; never injected into the prompt", "memory.attach.flat": "The flat form is a single file and cannot carry attachments", "memory.attach.tooLarge": "File too large: {name} (max {limit} MB)",
        "memory.delete.title": "Move to trash?", "memory.delete.desc": "“{name}” moves to trash and can be restored",
        "memory.result.created": "Created memory: {name}", "memory.result.updated": "Saved memory: {name}", "memory.result.removed": "Moved to trash: {name}", "memory.result.toggled": "Memory state updated: {name}", "memory.result.active": "Enabled scenes updated",
        "memory.result.restored": "Restored memory: {name}", "memory.result.trashRemoved": "Permanently deleted: {name}",
        "memory.result.createdAttached": "Created memory: {name} ({count} attachments)", "memory.result.updatedAttached": "Saved memory: {name} ({count} attachments)", "memory.result.attachFailed": "Memory saved, but attachments failed: {error}",
        "memory.trash.open": "Trash", "memory.trash.title": "Memory trash", "memory.trash.empty": "Trash is empty",
        "memory.trash.count": "{count} deleted memories", "memory.trash.deletedAt": "Deleted {time}",
        "memory.trash.restore": "Restore", "memory.trash.purge": "Delete forever",
        "memory.trash.confirmTitle": "Delete forever?", "memory.trash.confirmDesc": "“{name}” is deleted forever and cannot be recovered",
        "memory.btn.newScene": "New scene", "memory.btn.deleteScene": "Delete scene",
        "memory.scene.createTitle": "New scene", "memory.scene.createHelp": "Drop .md files in afterwards — each file is one memory",
        "memory.deleteScene.title": "Delete scene?", "memory.deleteScene.desc": "Deletes the empty folder “{name}”; non-empty scenes cannot be deleted",
        "memory.result.sceneCreated": "Scene created: {name}", "memory.result.sceneRemoved": "Scene deleted: {name}",
        "memory.table.name": "Memory name and description", "memory.table.tags": "Tags", "memory.table.status": "Status",
        "error.rules.invalidGroup": "Invalid scene/group name (non-empty, ≤64 chars, no path separators or < > : \" | ? *, must not start with a dot)", "error.rules.invalidName": "Invalid memory name (non-empty, ≤64 chars, no / \\ < > : \" | ? *, must not start with a dot)", "error.rules.descriptionRequired": "Description is required", "error.rules.descriptionTooLong": "Description is too long (max 500 chars)", "error.rules.bodyRequired": "Body is required", "error.rules.tooLarge": "Rule content is too large", "error.rules.shadowed": "Rule is shadowed by a bundle of the same name", "error.rules.notFound": "Rule not found", "error.rules.budgetExceeded": "Scene memory section exceeds its budget", "error.rules.ioFailed": "File operation failed", "error.rules.sceneNotEmpty": "Scene is not empty; cannot be deleted", "error.rules.notBundle": "This memory is flat (a single file) and cannot carry attachments", "error.rules.noFiles": "No files selected", "error.rules.emptyFile": "Empty file", "error.rules.fileTooLarge": "File too large (max {limit} MB each)", "error.rules.tooManyFiles": "At most {limit} files per upload", "error.rules.sceneInMode": "This scene is the active mode; exit the mode before deleting it",
        "subagents.title": "Subagents", "subagents.desc": "Manage persona files (~/.dsh/subagents/*.md): one file per persona, its body is the subagent's system prompt.",
        "subagents.new": "New persona", "subagents.empty": "No personas yet — click “New persona” to create the first one.",
        "subagents.create": "New persona", "subagents.edit": "Edit persona",
        "subagents.field.name": "Persona name", "subagents.field.name.hint": "The file name (non-empty, ≤64 chars, no path separators or < > : | ? *, must not start with a dot); it cannot be renamed later.",
        "subagents.field.description": "Description", "subagents.field.description.placeholder": "e.g. Senior Java engineer — use when writing or refactoring Java code", "subagents.field.description.hint": "One sentence is enough — the model routes on it.",
        "subagents.field.model": "Model", "subagents.field.model.placeholder": "Blank inherits the main session",
        "subagents.field.tools": "Tool allowlist", "subagents.field.tools.hint": "Comma separated; blank means no restriction (the base tool set).",
        "subagents.field.body": "Persona prompt", "subagents.field.body.placeholder": "Describe the persona's role, responsibilities, and working style…",
        "subagents.result.saved": "Persona saved: {name}", "subagents.result.deleted": "Persona deleted: {name}",
        "subagents.delete.title": "Delete persona?", "subagents.delete.desc": "Deletes the persona file “{name}”; this cannot be undone",
        "subagents.import": "Import", "subagents.import.title": "Import personas", "subagents.import.hint": "Accepts .md or .zip (multi-select or drag in): one .md = one persona, the file name is the persona name; existing names are skipped.",
        "subagents.result.imported": "Imported {count} persona(s): {names}",
        "memory.import": "Import memories", "memory.import.title": "Import memories", "memory.import.scene": "Import into scene",
        "memory.import.sceneHint": "Leave blank = global (injected into every conversation); directories inside a .zip become scenes.",
        "memory.import.hint": "Accepts .md or .zip (multi-select or drag in): one .md = one memory; <scene>/<name>/SKILL.md inside a zip imports as a bundle with sibling files as attachments; existing names are skipped.",
        "memory.result.imported": "Imported {count} memory/memories: {names}",
        "memory.scene.global.hint": "Global (no scene · injected into every conversation)",
        "import.pick": "Choose files", "import.selected": "{count} file(s) selected", "import.clear": "Clear", "import.submit": "Install",
        "import.none": "Nothing was imported (all skipped)", "import.skipped": "Skipped: {items}",
        "error.import.noFiles": "No files selected"
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
  "/prefer": "skill-prefer", "/unprefer": "skill-unprefer",
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
    function Switch(props) { return h("button", { type: "button", className: "dsm-switch" + (props.on ? " dsm-switch-on" : ""), role: "switch", "aria-checked": props.on, "aria-label": props.label, disabled: props.disabled, onClick: props.onClick }); }
    function GithubMark16() { return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, h("path", { fill: "currentColor", d: "M8 0a8 8 0 0 0-2.53 15.59c.4.074.547-.173.547-.385 0-.19-.007-.693-.01-1.36-2.226.484-2.695-1.073-2.695-1.073-.364-.924-.89-1.17-.89-1.17-.726-.496.055-.486.055-.486.803.056 1.225.824 1.225.824.714 1.223 1.872.87 2.328.665.072-.517.28-.87.508-1.07-1.777-.202-3.645-.888-3.645-3.956 0-.874.31-1.588.823-2.148-.083-.202-.357-1.017.078-2.12 0 0 .672-.215 2.2.82A7.65 7.65 0 0 1 8 4.8c.68.003 1.365.092 2.004.27 1.527-1.035 2.197-.82 2.197-.82.437 1.103.162 1.918.08 2.12.513.56.822 1.274.822 2.148 0 3.076-1.872 3.752-3.654 3.95.288.248.544.735.544 1.482 0 1.07-.01 1.932-.01 2.195 0 .214.144.463.55.384A8.001 8.001 0 0 0 8 0Z" })); }
    function Modal(props) { var ref = react.useRef(null); react.useEffect(function () { if (ref.current) ref.current.focus(); }, []); return h("div", { className: "dsm-mask", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose(); } }, h("div", { ref: ref, tabIndex: -1, className: "dsm-modal" + (props.wide ? " dsm-modal-wide" : "") + (props.className ? " " + props.className : ""), role: "dialog", "aria-modal": "true", onKeyDown: function (e) { if (!handleModalEscape(e, props.onClose)) trapModalFocus(e.currentTarget, e); } }, h("div", { className: "dsm-modal-head" }, h("h3", { className: "dsm-modal-title" }, props.title), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: props.onClose }, props.closeLabel)), props.children)); }
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
    // 通用导入弹窗（人设 / 记忆共用）：拖放或点选 .md / .zip → 已选计数 → 交由调用方走自己的写 op。
    // t 由调用方注入（各页的 t 是局部函数，不在模块作用域）；extra 用于注入「导入到场景」一类的额外字段。
    function ImportModal(props) {
      var st = react.useState([]); var files = st[0], setFiles = st[1]
      var ref = react.useRef(null)
      var t = props.t
      function add(list) {
        var picked = Array.prototype.slice.call(list || [])
        if (!picked.length) return
        Promise.all(picked.map(function (f) { return f.arrayBuffer().then(function (buf) { return { name: String(f.name || ""), data: bytesToBase64(buf) } }) }))
          .then(function (entries) { setFiles(function (prev) { return prev.concat(entries) }) })
          .catch(function () {})
      }
      return h(Modal, { className: "dsm-modal-import", title: props.title, closeLabel: t("btn.cancel"), onClose: props.onClose },
        h("div", { className: "dsm-form" },
          props.extra || null,
          h("div", {
            className: "dsm-dropzone",
            onClick: function () { if (ref.current) ref.current.click() },
            onDragOver: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.add("dsm-dropzone-active") },
            onDragLeave: function (e) { if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active") },
            onDrop: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active"); droppedFiles(e.dataTransfer).then(add) },
          },
            h("div", { className: "dsm-dropzone-title" }, t("import.pick")),
            h("div", { className: "dsm-dropzone-copy" }, props.hint),
            files.length ? h("div", { className: "dsm-help" }, t("import.selected", { count: files.length })) : null),
          h("input", { ref: ref, type: "file", multiple: true, accept: ".md,.zip", className: "dsm-hidden-input", onChange: function (e) { add(e.target.files); e.target.value = "" } })),
        h("div", { className: "dsm-modal-actions" },
          h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: props.busy, onClick: props.onClose }, t("btn.cancel")),
          files.length ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: props.busy, onClick: function () { setFiles([]) } }, t("import.clear")) : null,
          h("button", { type: "button", className: "dsm-btn dsm-btn-primary", disabled: props.busy || !files.length, onClick: function () { props.onSubmit(files) } }, props.busy ? t("upload.importing") : t("import.submit"))))
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
          else setSt({ loading: false, error: (res && res.error) || '无法读取目录', current: dir || '', parent: null, entries: [] })
        }).catch(function () {
          setSt({ loading: false, error: '无法读取目录', current: dir || '', parent: null, entries: [] })
        })
      }
      react.useEffect(function () { load(props.initial || '') }, [])
      function jump() { var v = String(text || '').trim(); if (v) load(v) }
      function goUp() { if (!st.parent) return; setText(st.parent); load(st.parent) }
      function enter(path) { setText(path); load(path) }
      function pick() { var target = String(st.current || '').trim() || String(text || '').trim(); if (target && props.onPick) props.onPick(target) }
      return h(Modal, { title: props.title || '选择文件夹', closeLabel: props.closeLabel || '关闭', onClose: props.onClose },
        h("div", { className: "dsm-form" },
          h("label", { className: "dsm-field" },
            h("span", { className: "dsm-label" }, '当前路径'),
            h("div", { className: "dsm-dir-row" },
              h("input", { className: "dsm-control", value: text, placeholder: '输入目录路径，回车跳转', onChange: function (e) { setText(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); jump(); } } }),
              h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !String(text || '').trim(), onClick: jump }, '跳转'))),
          st.error ? h("div", { className: "dsm-feedback dsm-error", role: "alert" }, st.error) : null,
          h("div", { className: "dsm-dir-list" },
            st.loading ? h("div", { className: "dsm-empty" }, '加载中…')
              : st.entries.length ? st.entries.map(function (e) { return h("button", { key: e.path, type: "button", className: "dsm-dir-item", title: e.path, onClick: function () { enter(e.path); } }, e.name); })
              : h("div", { className: "dsm-empty" }, '（当前目录没有子文件夹）')),
          h("div", { className: "dsm-modal-actions" },
            h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !st.parent, onClick: goUp }, '上级'),
            h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: props.onClose }, '取消'),
            h("button", { type: "button", className: "dsm-btn", disabled: st.loading || !(String(st.current || '').trim() || String(text || '').trim()), onClick: pick }, '选择此文件夹'))))
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
      function submitCreate() { post("/create", form, null).then(function (data) { setModal(null); setForm({ root: "dsh", name: "", description: "", body: "" }); setResult({ ok: true, text: t("result.created", { name: data.name }) }); }).catch(function () {}); }
      function selectUploadFiles(files) { pickerOpenRef.current = false; var selected = inspectUploadSelection(files); if (!selected) return; if (selected.error) { setUpload(null); setResult({ ok: false, text: translateError(t, selected.error) }); return; } setUpload(selected); setResult(null); }
      function openNativePicker(ref) { if (busy || pickerOpenRef.current || !ref.current) return; pickerOpenRef.current = true; ref.current.value = ""; function release() { setTimeout(function () { pickerOpenRef.current = false; }, 0); } window.addEventListener("focus", release, { once: true }); ref.current.click(); setTimeout(function () { pickerOpenRef.current = false; }, 30000); }
      function submitImport() { if (!upload) return; buildUploadPayload(upload).then(function (payload) { return post("/upload", payload, null); }).then(function (data) { var summary = summarizeImportResult(t, data); setResult({ ok: summary.ok, warning: summary.warning, text: summary.text }); if (summary.imported) { setModal(null); setUpload(null); } }).catch(function () {}); }
      var data = snapshot.data || { roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }, allRoots = data.roots || [], roots = visibleSkillRoots(allRoots), activeSource = roots.some(function (root) { return root.key === source; }) ? source : "";
      var createRoots = allRoots.filter(function (root) { return root.mutable === true; }), createOptions = createRoots.map(function (root) { return { value: root.key, label: rootDisplayName(t, root) }; }); if (!createOptions.length) createOptions.push({ value: "dsh", label: t("root.dsh") });
      function openCreate() { var selectedRoot = createRoots.some(function (root) { return root.key === activeSource; }) ? activeSource : "dsh"; setForm(Object.assign({}, form, { root: selectedRoot })); setModal("create"); }
      function trashRootLabel(item) { return item.root && item.root.scope === "project" ? t("root.projectDsh") + " · " + (item.root.projectName || item.root.projectRoot) : t("root.dsh"); }
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
        return h("div", { key: skill.name, className: "dsm-row" }, h("div", { className: "dsm-main" }, h("div", { className: "dsm-name" }, skill.declaredName || skill.name), h("div", { className: "dsm-note" }, skill.description || t("note.missing")), skill.shadowedBy ? h("div", { className: "dsm-rule-hint" }, t("status.shadowed.hint", { name: skill.shadowedBy.name })) : null), h("div", { className: "dsm-tags" }, h("span", { className: "dsm-tag" }, rootDisplayName(t, root)), skill.preferred === true ? h("span", { className: "dsm-tag dsm-tag-on" }, t("status.preferred")) : null, !root.mutable ? h("span", { className: "dsm-tag" }, t("status.readonly")) : null), h("div", { className: "dsm-status " + cls }, t(key)), h("div", { className: "dsm-row-actions" }, canToggle && skill.shadowedBy ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.activate.title"), onClick: function () { activateShadowed(root, skill); } }, t("btn.activate")) : null, canToggle && !skill.shadowedBy ? h(Switch, { on: enabled, disabled: busy || root.enabled === false, label: t("skill.toggle") + " " + skill.name, onClick: function () { post(enabled ? "/disable" : "/enable", { root: root.key, name: skill.name }); } }) : null, skill.preferred === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.unprefer.title"), onClick: function () { clearPreferred(root, skill); } }, t("btn.unprefer")) : null, h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openDetail(root, skill); } }, t("btn.detail")), root.mutable ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { setModal({ type: "trash-confirm", root: root.key, name: skill.name }); } }, t("btn.trash")) : null));
      }
      function renderRoot(root) {
        if (activeSource && activeSource !== root.key) return null;
        var displayName = rootDisplayName(t, root), filtered = root.skills.filter(function (skill) { return matchSkillQuery(Object.assign({}, skill, { rootKey: root.key, rootLabel: displayName }), query); }); if (query && !filtered.length) return null; var open = !!expanded[root.key] || !!query;
        var rootCount = root.count == null ? root.skills.length : root.count;
        return h("section", { key: root.key, className: "dsm-source" }, h("div", { className: "dsm-source-head" }, h("button", { type: "button", className: "dsm-source-head-main", "aria-expanded": open, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: !open })); } }, h("span", { className: "dsm-source-title" }, displayName), h("span", { className: "dsm-count" }, t(countKey("summary.group", rootCount), { count: rootCount })), h("span", { className: "dsm-tag " + (root.scope === "project" ? "dsm-tag-on" : root.key === "dsh" ? "" : root.enabled ? "dsm-tag-on" : "dsm-tag-off") }, root.scope === "project" ? t("status.project") : root.key === "dsh" ? t("status.manageable") : t(root.enabled ? "status.source.on" : "status.source.off")), root.scope === "project" ? h("span", { className: "dsm-tag" }, t("status.rank", { rank: root.rank })) : null, h("span", { className: "dsm-path", title: root.path }, root.path)), root.scope !== "project" && root.key !== "dsh" && root.toggleable !== false ? h("span", { className: "dsm-source-actions" }, root.key.indexOf("custom-") === 0 ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "custom-remove-confirm", key: root.key, name: displayName }); } }, t("btn.custom.remove")) : null, h(Switch, { on: root.enabled, disabled: busy, label: t("source.toggle") + " " + displayName, onClick: function () { post(root.enabled ? "/source-disable" : "/source-enable", { root: root.key }); } })) : null), open ? h("div", { className: "dsm-source-body" }, filtered.length ? h(react.Fragment, null, h("div", { className: "dsm-table-head" }, h("span", null, t("table.skill")), h("span", null, t("filter.source")), h("span", null, t("table.status")), h("span", null, "")), filtered.map(function (skill) { return renderSkill(root, skill); })) : h("div", { className: "dsm-empty" }, query ? t("empty.search") : t("empty.source"))) : null);
      }

      var summary = data.summary || { total: 0, enabled: 0, disabled: 0, issues: 0 };
      var content = [h("style", { key: "css" }, CSS), h("div", { key: "head", className: "dsm-head" }, h("div", { className: "dsm-title-block" }, h("div", { className: "dsm-title-row" }, h("h2", { className: "dsm-title" }, t("title")), h(VersionBadge, null)), h("p", { className: "dsm-desc" }, t("desc"))), h("div", { className: "dsm-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy || snapshot.loading, onClick: function () { refresh(false); } }, t("btn.refresh")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: openCreate }, t("btn.create")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setResult(null); setUpload(null); setModal("import"); } }, t("btn.import")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setCustomForm({ path: "", label: "" }); setModal("custom-add"); } }, t("btn.custom.add")))), h("div", { key: "summary", className: "dsm-summary dsm-summary-3" }, [[summary.total, "summary.total"], [summary.enabled, "summary.enabled"], [summary.disabled, "summary.disabled"]].map(function (item) { return h("div", { key: item[1], className: "dsm-stat" }, h("strong", null, item[0]), t(countKey(item[1], item[0]), { count: item[0] }).replace(String(item[0]), "")); })), h("div", { key: "filters", className: "dsm-filters" }, h("input", { className: "dsm-control dsm-search", value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function (e) { setQuery(e.target.value); } }), h("div", { className: "dsm-source-filter" }, h(SourceSelect, { value: activeSource, options: options, onChange: setSource }))), result && modal !== "import" ? h(Notice, { key: "result", kind: result.warning ? "warn" : result.ok ? "ok" : "err", text: result.text }) : null].concat((data.warnings || []).map(function (warning, index) { return h(Notice, { key: "warning-" + index, kind: "warn", text: translateError(t, warning) }); }), [snapshot.error ? h(Notice, { key: "error", kind: "err", text: snapshot.error }) : null, snapshot.loading && !snapshot.data ? h("div", { key: "loading", className: "dsm-empty" }, t("loading")) : h("div", { key: "sources", className: "dsm-sources" }, roots.map(renderRoot)), h("button", { key: "trash", type: "button", className: "dsm-trash-row", onClick: function () { setModal("trash"); } }, h("span", null, t("trash.title")), h("span", { className: "dsm-trash-count" }, (data.trash || []).length))]);

      if (modal === "create") content.push(h(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.target")), h(SourceSelect, { value: form.root, options: createOptions, onChange: function (value) { updateForm("root", value); } })), [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function (field) { return h("label", { key: field[0], className: "dsm-field" }, h("span", { className: "dsm-label" }, t(field[1])), h("input", { className: "dsm-control", value: form[field[0]], placeholder: t(field[2]), onChange: function (e) { updateForm(field[0], e.target.value); } })); }), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.body")), h("textarea", { className: "dsm-control", value: form.body, placeholder: t("create.body.placeholder"), onChange: function (e) { updateForm("body", e.target.value); } })), h("p", { className: "dsm-help" }, t("create.chat.note"))), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { className: "dsm-btn", disabled: busy || !form.name.trim() || !form.description.trim() || !form.body.trim(), onClick: submitCreate }, t("btn.create.now")))));
      if (modal === "import") content.push(h(Modal, { key: "import", className: "dsm-modal-import", title: t("import.title"), closeLabel: t("btn.close"), onClose: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); } },
        h("input", { ref: importInputRef, className: "dsm-hidden-input", type: "file", accept: ".zip,.md", onChange: function (event) { selectUploadFiles(event.target.files); event.target.value = ""; } }),
        h("input", { ref: folderInputRef, className: "dsm-hidden-input", type: "file", multiple: true, webkitdirectory: "", directory: "", onChange: function (event) { selectUploadFiles(event.target.files); event.target.value = ""; } }),
        h("div", { className: "dsm-dropzone", onClick: function () { openNativePicker(importInputRef); }, onDragOver: function (event) { event.preventDefault(); event.currentTarget.classList.add("dsm-dropzone-active"); }, onDragLeave: function (event) { event.currentTarget.classList.remove("dsm-dropzone-active"); }, onDrop: function (event) { event.preventDefault(); event.currentTarget.classList.remove("dsm-dropzone-active"); droppedFiles(event.dataTransfer).then(selectUploadFiles).catch(function (error) { setResult({ ok: false, text: translateError(t, error) }); }); } },
          h("span", { className: "dsm-dropzone-title" }, t("upload.drop.title")),
          h("span", { className: "dsm-dropzone-copy" }, t("upload.drop.copy"))),
        upload ? h("div", { className: "dsm-file", title: upload.name }, h("span", { className: "dsm-file-kind", "aria-hidden": "true" }, upload.kind === "zip" ? "ZIP" : upload.kind === "folder" ? "DIR" : "MD"), h("span", { className: "dsm-file-name" }, upload.name), h("span", { className: "dsm-file-meta" }, t(countKey("upload.selected", upload.count), { count: upload.count, size: upload.size < 1024 ? upload.size + " B" : Math.ceil(upload.size / 1024) + " KB" })), h("button", { type: "button", className: "dsm-file-remove", "aria-label": t("upload.remove"), onClick: function () { setUpload(null); } }, "×")) : null,
        result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null,
        h("div", { className: "dsm-upload-requirements" }, h("div", { className: "dsm-label" }, t("upload.requirements")), h("ul", null, h("li", null, t("upload.requirement.skill")), h("li", null, t("upload.requirement.frontmatter")), h("li", null, t("upload.requirement.copy")))),
        h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); } }, t("btn.cancel")), h("button", { type: "button", className: "dsm-btn", disabled: busy || !upload, onClick: submitImport }, busy ? t("upload.importing") : t("btn.import.now")))
      ));      if (modal === "detail") content.push(h(Modal, { key: "detail", wide: true, title: t("detail.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, detail ? h(react.Fragment, null, h("div", { className: "dsm-detail-path" }, detail.path), h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openSource }, t("btn.open.editor"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.diagnostics")), detail.diagnostics.length ? detail.diagnostics.map(function (item, index) { return h("div", { key: index, className: "dsm-diag" }, t(item.code, item.params || {})); }) : h("div", { className: "dsm-note" }, t("detail.noIssues"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.frontmatter")), renderFrontmatter(t, detail.frontmatter)), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.body")), h("pre", { className: "dsm-code" }, detail.body || ""))) : h("div", { className: "dsm-empty" }, t("loading"))));
      if (modal === "trash") content.push(h(Modal, { key: "trash-modal", title: t("trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-count" }, t(countKey("trash.count", data.trash.length), { count: data.trash.length })), data.trash.length ? data.trash.map(function (item) { return h("div", { key: item.id, className: "dsm-trash-item" }, h("div", { className: "dsm-trash-main" }, h("div", { className: "dsm-name" }, item.name), h("div", { className: "dsm-note" }, t("trash.deletedAt", { time: new Date(item.deletedAt).toLocaleString() }) + " · " + t("trash.source", { source: trashRootLabel(item) }))), h("button", { className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/trash-restore", { id: item.id }, "result.restored", { name: item.name }); } }, t("btn.restore")), h("button", { className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "delete-confirm", id: item.id, name: item.name }); } }, t("btn.delete.forever"))); }) : h("div", { className: "dsm-empty" }, t("trash.empty"))));
      if (modal && modal.type === "trash-confirm") content.push(h(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.trash.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { className: "dsm-btn", disabled: busy, onClick: function () { post("/delete", { root: modal.root, name: modal.name }, "result.trashed", { name: modal.name }).then(function () { setModal(null); }).catch(function () {}); } }, t("btn.trash")))));
      if (modal && modal.type === "delete-confirm") content.push(h(Modal, { key: "delete-confirm", title: t("confirm.delete.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.delete.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal("trash"); } }, t("btn.cancel")), h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/trash-delete", { id: modal.id }, "result.deleted", { name: modal.name }).then(function () { setModal("trash"); }).catch(function () {}); } }, t("btn.delete.forever")))));
      if (modal === "custom-add") content.push(h(Modal, { key: "custom-add", title: t("custom.add.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.path")), h("div", { className: "dsm-dir-row" }, h("input", { className: "dsm-control", value: customForm.path, placeholder: t("custom.add.path.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { path: e.target.value })); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openCustomDir, title: t("custom.add.openDir.title") }, t("btn.openDir")))), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.label")), h("input", { className: "dsm-control", value: customForm.label, placeholder: t("custom.add.label.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { label: e.target.value })); } })), h("p", { className: "dsm-help" }, t("custom.add.help")), result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null), customForm.picking ? h(DirPickerModal, { key: "custom-dir-picker", title: t("custom.add.picker.title"), initial: String(customForm.path || ""), closeLabel: t("btn.close"), onClose: function () { setCustomForm(Object.assign({}, customForm, { picking: false })); }, onPick: function (path) { setCustomForm(Object.assign({}, customForm, { path: path, picking: false })); } }) : null, h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal(null); } }, t("btn.cancel")), h("button", { type: "button", className: "dsm-btn", disabled: busy || !String(customForm.path || "").trim(), onClick: submitCustomAdd }, t("custom.add.submit")))));
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

        // ---------- History 页（归档会话管理：恢复 / 永久删除 / 保留期）----------
        // 折叠自 dsh-archive-manager 的归档会话设置页，但客户端经本插件 HTTP API
        // 驱动（history-list / -archive / -unarchive / -delete / -retention-*），不依赖
        // ui-workspace 客户端 store 或 typert remote——会话标题由 host 端 best-effort 读取。
        function HistoryPage() {
          var state = React.useState({ loading: true, items: [], workspaces: {}, retentionDays: 0, error: null })
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
          var importInputRef = React.useRef(null)
          // 导出对话弹窗：null = 关闭；{ busy, error, result, outDir, format, wsFilter, selectedIds } = 打开。
          var expState = React.useState(null)
          var exp = expState[0], setExp = expState[1]
          // 分组卡片折叠状态：key → true（收起）。默认全部展开。
          var collState = React.useState({})
          var collapsed = collState[0], setCollapsed = collState[1]

          function refresh() {
            apiCall('history-list', {}).then(function (r) {
              if (r && r.ok) {
                var items = r.items || []
                setData({ loading: false, items: items, workspaces: r.workspaces || {}, retentionDays: r.retentionDays || 0, error: null })
                // 裁剪选中集合：已被外部恢复/删除的会话不再计入。
                setSelected(function (prev) {
                  var has = new Set(items.map(function (it) { return it.sessionId }))
                  var next = new Set()
                  prev.forEach(function (id) { if (has.has(id)) next.add(id) })
                  return next
                })
              } else setData({ loading: false, items: [], workspaces: {}, retentionDays: 0, error: (r && r.error) || '加载失败' })
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

          // 按项目分组（host 提供 workspaces 时启用；否则扁平列表）。
          var grouped = !!(data.workspaces && Object.keys(data.workspaces).length)
          var visibleIds = filtered.map(function (it) { return it.sessionId })
          var groups = []
          if (grouped) {
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
              var title = wid ? ((wsRec && wsRec.title) || wid) : '未分组'
              items2.sort(function (a, b) { return ((b.archivedAt || b.createdAt) || 0) - ((a.archivedAt || a.createdAt) || 0) })
              var maxAt = 0
              items2.forEach(function (it) { var at = (it.archivedAt || it.createdAt) || 0; if (at > maxAt) maxAt = at })
              groups.push({ key: key, title: title, workspaceId: wid, path: wsRec && wsRec.path, items: items2, maxAt: maxAt })
            })
            // 组按组内最新时间戳降序；未分组固定最后。
            groups.sort(function (g1, g2) {
              if (g1.key === 'ungrouped') return 1
              if (g2.key === 'ungrouped') return -1
              return g2.maxAt - g1.maxAt
            })
          }

          // 「全选」状态：当前过滤结果是否全部选中（按钮文案切换为「取消全选」）。
          var allVisible = filtered.length > 0 && visibleIds.every(function (id) { return selected.has(id) })

          function doUnarchive(sessionId) {
            setBusy(true)
            apiCall('history-unarchive', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) refresh(); else setModal({ type: 'error', message: (r && r.error) || '恢复失败' })
            })
          }
          function doDelete(sessionId) {
            setBusy(true)
            apiCall('history-delete', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); refresh() } else setModal({ type: 'error', message: (r && r.error) || '删除失败' })
            })
          }
          function setRetention(days) {
            apiCall('history-retention-set', { retentionDays: days }).then(function (r) {
              if (r && r.ok) setData(Object.assign({}, data, { retentionDays: days }))
              else setModal({ type: 'error', message: (r && r.error) || '设置失败' })
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
                refresh()
              } else setModal({ type: 'error', message: (r && r.error) || '恢复失败' })
            })
          }
          function doDeleteBatch() {
            var ids = Array.from(selected)
            if (!ids.length) return
            setBusy(true)
            apiCall('history-delete-batch', { target: { scope: 'sessions', sessionIds: ids } }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); setSelected(new Set()); refresh() }
              else setModal({ type: 'error', message: (r && r.error) || '删除失败' })
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
                } else setImp(Object.assign({}, snap, { busy: false, error: (res && res.error) || '导入失败' }))
              }).catch(function () {
                setImp(Object.assign({}, snap, { busy: false, error: '导入失败' }))
              })
            }
            reader.readAsText(file)
          }
          function onImportDrop(e) {
            if (e && e.preventDefault) e.preventDefault()
            if (imp && imp.busy) return
            droppedFiles(e && e.dataTransfer).then(function (files) {
              if (files && files.length) doImportFile(files[0])
            }).catch(function () {})
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
                  error: (res && res.ok) ? prev.error : ((res && res.error) || '加载会话列表失败'),
                  items: (res && res.ok && Array.isArray(res.items)) ? res.items : prev.items,
                })
              })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { loading: false, error: '加载会话列表失败' }) : prev })
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
              else setExp(Object.assign({}, exp, { busy: false, error: (res && res.error) || '导出失败' }))
            }).catch(function () {
              setExp(Object.assign({}, exp, { busy: false, error: '导出失败' }))
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
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: (res && res.error) || '归档失败' }) : prev })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: '归档失败' }) : prev })
            })
          }

          var RETENTION_OPTS = [
            { value: 0, label: '永久保留' },
            { value: 7, label: '7 天' },
            { value: 30, label: '30 天' },
          ]
          var EXPORT_FORMAT_OPTS = [
            { value: 'markdown', label: 'Markdown' },
            { value: 'jsonl', label: 'JSONL' },
          ]
          var EXPORT_ARCH_OPTS = [
            { value: 'all', label: '全部会话' },
            { value: 'archived', label: '仅已归档' },
            { value: 'live', label: '仅未归档' },
            { value: 'missing', label: '仅目录丢失' },
          ]
          // 导出弹窗内的工作区筛选选项与候选会话（随弹窗状态/数据刷新重算）。
          var exportWsOptions = [{ value: '', label: '全部工作区' }]
          if (exp && data.workspaces) {
            Object.keys(data.workspaces).forEach(function (wid) {
              exportWsOptions.push({ value: 'ws:' + wid, label: (data.workspaces[wid].title || wid) })
            })
            exportWsOptions.push({ value: 'ungrouped', label: '未分组' })
          }
          var exportItems = []
          if (exp) {
            exportItems = (exp.items || []).filter(function (it) {
              if (exp.archFilter === 'archived' && !it.archived) return false
              if (exp.archFilter === 'live' && it.archived) return false
              if (exp.archFilter === 'missing' && !it.cwdMissing) return false
              if (!exp.wsFilter) return true
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
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { doUnarchive(it.sessionId) } }, '恢复'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'delete', sessionId: it.sessionId, title: it.title || ('Session ' + shortId(it.sessionId)) }) } }, '永久删除')))
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
            return React.createElement('div', { className: 'dsm-source', key: 'g:' + g.key },
              React.createElement('div', { className: 'dsm-source-head dsm-hist-group-head' },
                React.createElement('input', { type: 'checkbox', className: 'dsm-hist-group-check', checked: allChecked, onChange: function () { toggleGroup(groupIds) }, 'aria-label': '全选组 ' + g.title }),
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleGroupCollapse(g.key) } },
                  React.createElement('span', { className: 'dsm-source-title dsm-hist-group-title', title: g.title }, g.title),
                  React.createElement('span', { className: 'dsm-count' }, g.items.length + ' 个')),
                g.path ? React.createElement('span', { className: 'dsm-path', title: g.path }, g.path) : null),
              open ? React.createElement('div', { className: 'dsm-source-body' }, g.items.map(renderRow)) : null)
          }

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.sessions')),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, '管理已归档会话：可恢复或永久删除，超保留期自动清理。')),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !filtered.length, onClick: function () { toggleAllVisible(visibleIds) } }, allVisible ? '取消全选' : '全选'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openImportPicker }, '导入对话'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openExportPicker }, '导出对话'),
                selected.size > 0 ? React.createElement('div', { className: 'dsm-hist-batch' },
                  React.createElement('span', { className: 'dsm-hist-batch-count' }, '已选 ' + selected.size + ' 项'),
                  React.createElement('div', { className: 'dsm-hist-batch-actions' },
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { doUnarchiveBatch() } }, '恢复所选 (' + selected.size + ')'),
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'deleteBatch', count: selected.size }) } }, '删除所选 (' + selected.size + ')'))) : null)),
            React.createElement('div', { className: 'dsm-summary dsm-summary-3' },
              [[data.items.length, '个归档'], [grouped ? groups.length : '—', '个项目'], [selected.size, '个已选']].map(function (item) {
                return React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1])
              })),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: '搜索标题 / 会话 ID / 项目路径', value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, {
                  options: RETENTION_OPTS, value: data.retentionDays, onChange: function (v) { setRetention(Number(v)) },
                }))),
            data.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading ? React.createElement('div', { className: 'dsm-empty' }, '加载中…')
              : filtered.length === 0 ? React.createElement('div', { className: 'dsm-empty' }, query ? '无匹配的归档会话' : '暂无归档会话')
              : React.createElement('div', { className: 'dsm-sources' },
                grouped ? groups.map(renderGroup) : React.createElement('div', { className: 'dsm-source' }, filtered.map(renderRow))),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: '永久删除？', closeLabel: '取消', onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, '永久删除会话「' + modal.title + '」及其全部记录，不可恢复'),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, '取消'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDelete(modal.sessionId) } }, '确认删除'))) : null,
            modal && modal.type === 'deleteBatch' ? React.createElement(Modal, { key: 'delb', title: '永久删除？', closeLabel: '取消', onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, '永久删除所选 ' + modal.count + ' 个会话及其全部记录，不可恢复'),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, '取消'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDeleteBatch() } }, '确认删除'))) : null,
            imp ? React.createElement(Modal, { key: 'imp', className: 'dsm-modal-import', title: '导入对话', closeLabel: '关闭', onClose: function () { setImp(null) } },
              React.createElement('p', { className: 'dsm-help' }, '导入其他 Agent 的对话记录，生成可继续对话的新会话'),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '项目目录（可留空）'),
                React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: '绝对路径，可留空（会话归入未分组）', value: imp.cwd || '', onChange: function (e) { setImp(Object.assign({}, imp, { cwd: e.target.value })) } })),
              React.createElement('div', { className: 'dsm-dropzone', onDragOver: function (e) { if (e.preventDefault) e.preventDefault() }, onDrop: onImportDrop, onClick: function () { if (importInputRef.current) importInputRef.current.click() } },
                React.createElement('div', { className: 'dsm-dropzone-title' }, '选择或拖入对话文件'),
                React.createElement('div', { className: 'dsm-dropzone-copy' }, '.jsonl / .json / .md / .txt')),
              React.createElement('input', { type: 'file', ref: importInputRef, className: 'dsm-hidden-input', accept: '.jsonl,.json,.md,.markdown,.txt', onChange: function (e) { var f = e.target && e.target.files && e.target.files[0]; if (f) doImportFile(f) } }),
              imp.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(imp.error)) : null,
              imp.result ? React.createElement('div', { className: 'dsm-feedback' }, '已创建会话 ' + imp.result.sessionId + '（' + imp.result.count + ' 条消息），可在 DSH 会话列表中继续对话。') : null) : null,
            exp ? React.createElement(Modal, { key: 'exp', className: 'dsm-modal-import', title: '导出对话', closeLabel: '关闭', onClose: function () { setExp(null) } },
              React.createElement('p', { className: 'dsm-help' }, '导出选中会话为转录文件，可再次导入'),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '导出目录（绝对路径，自动创建）'),
                React.createElement('div', { className: 'dsm-dir-row' },
                  React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: 'D:\\backups\\dsh\\exports', value: exp.outDir || '', onChange: function (e) { setExp(Object.assign({}, exp, { outDir: e.target.value })) } }),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: exp.busy, onClick: openExportDir, title: '浏览并选择文件夹' }, '选择')),
                exp.pickingDir ? React.createElement(DirPickerModal, { key: 'exp-dir-picker', title: '选择导出目录', initial: String(exp.outDir || ''), closeLabel: '关闭', onClose: function () { setExp(Object.assign({}, exp, { pickingDir: false })) }, onPick: function (path) { setExp(Object.assign({}, exp, { outDir: path, pickingDir: false })) } }) : null),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '格式'),
                React.createElement(SourceSelect, { options: EXPORT_FORMAT_OPTS, value: exp.format, onChange: function (v) { setExp(Object.assign({}, exp, { format: v })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '会话范围'),
                React.createElement(SourceSelect, { options: EXPORT_ARCH_OPTS, value: exp.archFilter, onChange: function (v) { setExp(Object.assign({}, exp, { archFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, '工作区'),
                React.createElement(SourceSelect, { options: exportWsOptions, value: exp.wsFilter, onChange: function (v) { setExp(Object.assign({}, exp, { wsFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('div', { className: 'dsm-label' }, '会话（' + exportItems.length + ' 个）'),
                React.createElement('div', { className: 'dsm-source' },
                  exp.loading ? React.createElement('div', { className: 'dsm-empty' }, '加载会话列表…')
                    : exportItems.length ? exportItems.map(function (it) {
                        return React.createElement('label', { key: it.sessionId, className: 'dsm-hist-row' },
                          React.createElement('input', { type: 'checkbox', className: 'dsm-hist-check', checked: exp.selectedIds.has(it.sessionId), onChange: function () { toggleExportSelect(it.sessionId) } }),
                          React.createElement('div', { className: 'dsm-hist-main' },
                            React.createElement('div', { className: 'dsm-hist-title' }, it.title || ('Session ' + shortId(it.sessionId))),
                            it.cwd ? React.createElement('div', { className: 'dsm-hist-cwd' + (it.cwdMissing ? ' dsm-hist-cwd-missing' : ''), title: (it.cwdMissing ? '⚠ 工作区目录已不存在：' : '') + it.cwd }, (it.cwdMissing ? '⚠ ' : '') + it.cwd) : null),
                          React.createElement('div', { className: 'dsm-hist-actions' },
                            React.createElement('span', { className: 'dsm-tag' + (it.archived ? '' : ' dsm-tag-on') }, it.archived ? '已归档' : '未归档')))
                      }) : React.createElement('div', { className: 'dsm-empty' }, '没有符合条件的会话'))),
              exp.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(exp.error)) : null,
              exp.result ? React.createElement('div', { className: 'dsm-feedback' },
                exp.result.exported
                  ? ('已导出 ' + (exp.result.exported || []).length + ' 个会话到 ' + String(exp.outDir || '').trim()
                    + ((exp.result.skipped && exp.result.skipped.length) ? '；跳过 ' + exp.result.skipped.length + ' 个（' + exp.result.skipped.map(function (s) { return s.sessionId }).join('、') + '）' : ''))
                  : ('已归档 ' + exp.result.archived + ' 个会话到 History，可到 History 页继续管理')) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('span', { className: 'dsm-hist-batch-count' }, '已选 ' + exp.selectedIds.size + ' 个'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: exp.busy || !exp.selectedIds.size, onClick: doArchiveSelected, title: '把选中的会话收进 History，纳入保留期管理' }, '归档所选'),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: exp.busy || !exp.selectedIds.size || !String(exp.outDir || '').trim(), onClick: doExport }, exp.busy ? '处理中…' : '导出 ' + exp.selectedIds.size + ' 个会话'))) : null,
            modal && modal.type === 'error' ? React.createElement(Modal, { key: 'err', title: '操作失败', closeLabel: '关闭', onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, String(modal.message || '未知错误')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { setModal(null) } }, '关闭'))) : null)
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
        ]        // ---------- 场景记忆页（场景 = scene-memory/ 下的一级目录；内容自动生效）----------
        //
        // 变更单 01 之后 Rules 与 Scenes 合并为本页：**场景（一级目录）是分组维度，
        // 记忆（.md）是内容**；勾选启用后该目录树内所有 .md 正文自动进入系统提示词。
        // 原 Scenes 页的「agent preset ↔ 分组绑定」降级为页底的「高级」折叠区（可选）。
        // ---------- 场景页：场景清单 + 档案（MCP 工具集/技能集/子智能体绑定，三段自由搭配）+ 当前模式 ----------
        function ScenesPage() {
          var EMPTY_MODE = { scene: null, snapshot: null }
          var state = React.useState({ loading: true, error: null, scenes: [], activeMode: 'all', mode: EMPTY_MODE, archives: {} })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          var sfs = React.useState({ name: '', error: null })
          var sceneForm = sfs[0], setSceneForm = sfs[1]
          var dts = React.useState(null)
          var drillTools = dts[0], setDrillTools = dts[1]
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('scene-mode-get', {}).then(function (m) {
              if (m && m.ok) setData(function (prev) { return Object.assign({}, prev, { mode: m.mode || EMPTY_MODE, archives: m.archives || {} }) })
            }).catch(function () {})
            apiCall('rules-list', {}).then(function (r) {
              if (r && r.ok) setData(function (prev) { return Object.assign({}, prev, { loading: false, error: null, scenes: r.scenes || [], activeMode: r.activeMode === 'custom' ? 'custom' : 'all', stats: r.stats || prev.stats }) })
              else setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r) }) })
            }).catch(function (e) { setData(function (prev) { return Object.assign({}, prev, { loading: false, error: String((e && e.message) || e) }) }) })
          }
          React.useEffect(function () { refresh() }, [])
          function isValidSceneName(name) {
            return name.length > 0 && name.length <= 64 && !name.startsWith('.') && !/[\\/<>:"|?*]/.test(name)
          }
          // ── 场景启用开关（记忆注入；勾满全部 = 默认全部启用）──
          function setActiveScenes(names) {
            if (busy) return
            setBusy(true); setResult(null)
            var real = (data.scenes || []).filter(function (s) { return !s.shared }).map(function (s) { return s.name })
            var payload = real.length > 0 && real.every(function (n) { return names.indexOf(n) >= 0 }) ? { all: true } : { scenes: names }
            apiCall('rules-set-active', payload).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.active') }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function toggleScene(scene) {
            if (busy || scene.shared) return
            var names = (data.scenes || []).filter(function (s) { return s.active && !s.shared }).map(function (s) { return s.name })
            var i = names.indexOf(scene.name)
            if (i >= 0) names.splice(i, 1)
            else names.push(scene.name)
            setActiveScenes(names)
          }
          // ── 场景建 / 删 ──
          function openCreateScene() { setSceneForm({ name: '', error: null }); setModal({ type: 'scene-create' }) }
          function submitCreateScene() {
            var name = String(sceneForm.name || '').trim()
            if (!isValidSceneName(name)) { setSceneForm(Object.assign({}, sceneForm, { error: t('error.rules.invalidGroup') })); return }
            setBusy(true)
            apiCall('rules-create-scene', { name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setModal(null); setResult({ ok: true, text: t('memory.result.sceneCreated', { name: name }) }); refresh(true) }
              else setSceneForm(Object.assign({}, sceneForm, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setSceneForm(Object.assign({}, sceneForm, { error: String((e && e.message) || e) })) })
          }
          function submitDeleteScene(name) {
            setBusy(true)
            apiCall('rules-remove-scene', { name: name }).then(function (res) {
              setBusy(false); setModal(null)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.sceneRemoved', { name: name }) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
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
              setModal({ type: 'scene-archive', name: name, drill: null,
                sections: {
                  mcp: archive.mcp ? Object.assign({}, archive.mcp) : null,
                  skills: Array.isArray(archive.skills) ? archive.skills.slice() : null,
                  subagents: Array.isArray(archive.subagents) ? archive.subagents.slice() : null,
                },
                inventory: { mcpServers: inv.mcpServers || [], skills: inv.skills || [], subagents: inv.subagents || [], tools: inv.tools || [] } })
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
           * 「添加 MCP 工具集」的初值 = 当前运行时启用状态（设计 §2.4「预勾当前启用状态」）。
           * 勾选集语义是「勾 = 启用」，空段 = 全部停用，所以绝不能拿 {} 当默认值——
           * 否则用户点一下「添加」就把所有 MCP 服务器关掉。
           */
          function mcpPreset() {
            var preset = {}
            var states = modal.inventory.tools || []
            ;(modal.inventory.mcpServers || []).forEach(function (server) {
              if (server.allToolsDisabled) return                    // 整台已停用 → 不勾（等价）
              var prefix = server.name + '/'
              var list = states.filter(function (x) { return x.key.indexOf(prefix) === 0 })
              var enabled = list.filter(function (x) { return x.enabled !== false })
              if (!list.length || enabled.length === list.length) { preset[server.name] = '*'; return }
              if (!enabled.length) return                            // 全停用 → 不勾（等价）
              preset[server.name] = enabled.map(function (x) { return x.key.slice(prefix.length) })
            })
            return preset
          }
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
          /**
           * 段卡片：所有「勾选一组条目」的段共用同一排版（标题栏 + 固定高度滚动体 + 脚注），
           * 高度不随内容增减变化，弹窗不会因为加/删段或进出工具明细而跳动。
           */
          function seg(props) {
            return React.createElement('div', { className: 'dsm-seg' },
              React.createElement('div', { className: 'dsm-seg-head' },
                React.createElement('span', { className: 'dsm-seg-title' }, props.title),
                React.createElement('span', { className: 'dsm-seg-count' }, props.count),
                React.createElement('div', { className: 'dsm-seg-actions' }, props.actions)),
              props.body,
              props.foot || null)
          }
          /** 勾选行：复选框 + 名称/说明 + 右侧指标 + 可选行内动作。 */
          function pickRow(props) {
            return React.createElement('label', { key: props.key, className: 'dsm-pick' },
              React.createElement('input', { type: 'checkbox', checked: props.checked === true, disabled: busy, onChange: props.onChange }),
              React.createElement('span', { className: 'dsm-pick-main' },
                React.createElement('span', { className: 'dsm-pick-name' }, props.name),
                props.desc ? React.createElement('span', { className: 'dsm-pick-desc' }, props.desc) : null),
              props.meta ? React.createElement('span', { className: 'dsm-pick-meta' }, props.meta) : null,
              props.actions ? React.createElement('span', { className: 'dsm-pick-actions' }, props.actions) : null)
          }
          /** 段头公共动作：全选 / 清空 / 移除段（未定义时改为「添加」）。 */
          function segActions(defined, addLabel, onAdd, onRemove, onAll, onClear) {
            if (!defined) return [React.createElement('button', { key: 'add', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: onAdd }, addLabel)]
            return [
              React.createElement('button', { key: 'all', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: onAll }, t('scenes.seg.selectAll')),
              React.createElement('button', { key: 'clear', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: onClear }, t('scenes.seg.clear')),
              React.createElement('button', { key: 'rm', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: onRemove }, t('memory.archive.removeSection')),
            ]
          }
          /** 段脚注：段已定义但一项未勾 = 该域全部停用（必须显式提示，否则像没保存上）。 */
          function segFoot(defined, count) {
            if (!defined || count > 0) return null
            return React.createElement('div', { className: 'dsm-seg-foot' }, t('memory.archive.emptySection'))
          }
          function segList(nodes, emptyText) {
            if (!nodes.length) return React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, emptyText))
            return React.createElement('div', { className: 'dsm-seg-body' }, nodes)
          }
          /** 段 1：MCP 工具集（服务器级勾选 → 行内「选工具」进工具明细，明细留在同一段内）。 */
          function mcpSeg() {
            var sections = modalSections()
            var defined = !!sections.mcp
            var servers = modal.inventory.mcpServers || []
            if (modal.drill) {
              var spec = (sections.mcp || {})[modal.drill]
              var known = drillTools
              var checkedCount = spec === '*' ? (known || []).length : (Array.isArray(spec) ? spec.length : 0)
              return seg({
                title: t('scenes.mcp.toolsOf') + ' · ' + modal.drill,
                count: t('scenes.seg.checked', { checked: checkedCount, total: (known || []).length }),
                actions: [
                  React.createElement('button', { key: 'back', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { setModal(Object.assign({}, modal, { drill: null })) } }, t('scenes.mcp.back')),
                  React.createElement('button', { key: 'all', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || !known, onClick: function () { mcpDrillSpec('*') } }, t('scenes.seg.selectAll')),
                  React.createElement('button', { key: 'none', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { mcpDrillSpec([]) } }, t('scenes.seg.clear')),
                ],
                body: known === null
                  ? React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('memory.loading')))
                  : segList(known.map(function (item) {
                      var on = spec === '*' ? true : (Array.isArray(spec) && spec.indexOf(item.short) >= 0)
                      return pickRow({
                        key: item.key,
                        checked: on,
                        name: item.short,
                        onChange: function () { toggleDrillTool(modal.drill, item.short) },
                      })
                    }), t('scenes.mcp.noTools')),
                foot: React.createElement('div', { className: 'dsm-seg-foot' }, t('scenes.mcp.drillHint')),
              })
            }
            return seg({
              title: t('memory.archive.tools'),
              count: defined ? t('scenes.seg.checked', { checked: Object.keys(sections.mcp).length, total: servers.length }) : t('scenes.archive.sectionOff'),
              actions: segActions(defined, t('memory.archive.addTools'),
                function () { setSections(Object.assign({}, modalSections(), { mcp: mcpPreset() })) },
                function () { var s = Object.assign({}, modalSections()); delete s.mcp; setSections(s) },
                mcpSelectAll,
                function () { setSections(Object.assign({}, modalSections(), { mcp: {} })) }),
              body: defined
                ? segList(servers.map(function (server) {
                    var selected = sections.mcp[server.name] !== undefined
                    var spec2 = sections.mcp[server.name]
                    var specText = !selected ? '' : spec2 === '*' ? t('scenes.mcp.allTools') : t('scenes.mcp.pickedCount', { count: spec2.length })
                    return pickRow({
                      key: server.name,
                      checked: selected,
                      name: server.name,
                      desc: server.toolCount === null || server.toolCount === undefined ? null : (server.toolCount + ' 个工具'),
                      meta: [
                        server.live ? null : React.createElement('span', { key: 'nr', className: 'dsm-tag dsm-tag-off' }, t('scenes.mcp.notRunning')),
                        specText ? React.createElement('span', { key: 'spec' }, specText) : null,
                      ],
                      actions: selected ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function (e) { e.preventDefault(); e.stopPropagation(); openDrill(server.name) } }, t('scenes.mcp.pickTools')) : null,
                      onChange: function () { toggleMcpServer(server.name) },
                    })
                  }), t('scenes.mcp.noServers'))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mcp.hint'))),
              foot: segFoot(defined, defined ? Object.keys(sections.mcp).length : 0),
            })
          }
          /** 段 2：技能集。 */
          function skillsSeg() {
            var sections = modalSections()
            var defined = !!sections.skills
            var items = modal.inventory.skills || []
            return seg({
              title: t('memory.archive.skills'),
              count: defined ? t('scenes.seg.checked', { checked: sections.skills.length, total: items.length }) : t('scenes.archive.sectionOff'),
              actions: segActions(defined, t('memory.archive.addSkills'),
                function () { setSections(Object.assign({}, modalSections(), { skills: items.filter(function (x) { return x.enabled }).map(function (x) { return x.key }) })) },
                function () { var s = Object.assign({}, modalSections()); delete s.skills; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { skills: items.map(function (x) { return x.key }) })) },
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) }),
              body: defined
                ? segList(items.map(function (item) {
                    return pickRow({
                      key: item.key,
                      checked: sections.skills.indexOf(item.key) >= 0,
                      name: item.key,
                      meta: item.enabled === false ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.off')) : null,
                      onChange: function () {
                        var list = sections.skills.slice(); var i = list.indexOf(item.key)
                        if (i >= 0) list.splice(i, 1); else list.push(item.key)
                        setSections(Object.assign({}, modalSections(), { skills: list }))
                      },
                    })
                  }), t('scenes.skills.empty'))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.skills.hint'))),
              foot: segFoot(defined, defined ? sections.skills.length : 0),
            })
          }
          /** 段 3：子智能体绑定。 */
          function subagentsSeg() {
            var sections = modalSections()
            var defined = !!sections.subagents
            var items = modal.inventory.subagents || []
            return seg({
              title: t('memory.archive.subagents'),
              count: defined ? t('scenes.seg.checked', { checked: sections.subagents.length, total: items.length }) : t('scenes.archive.sectionOff'),
              actions: segActions(defined, t('memory.archive.addSubagents'),
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.subagents; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: items.map(function (x) { return x.name }) })) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) }),
              body: defined
                ? segList(items.map(function (item) {
                    return pickRow({
                      key: item.name,
                      checked: sections.subagents.indexOf(item.name) >= 0,
                      name: item.name,
                      desc: item.description || null,
                      onChange: function () {
                        var list = sections.subagents.slice(); var i = list.indexOf(item.name)
                        if (i >= 0) list.splice(i, 1); else list.push(item.name)
                        setSections(Object.assign({}, modalSections(), { subagents: list }))
                      },
                    })
                  }), t('scenes.subagents.empty'))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.subagents.hint'))),
              foot: segFoot(defined, defined ? sections.subagents.length : 0),
            })
          }
          /**
           * 档案编辑弹窗：顶部一行摘要（MCP/技能/子智能体各勾了多少）+ 三段 + 底部动作。
           * 结构固定 —— 加/删段、进出「选工具」明细都不会改变弹窗尺寸或元素顺序。
           */
          function archiveNode() {
            if (!modal || modal.type !== 'scene-archive') return null
            return React.createElement(Modal, { key: 'sarch', wide: true, className: 'dsm-modal-archive', title: t('memory.archive.title') + ' · ' + (modal.name === '' ? t('memory.scene.global') : modal.name), closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('div', { className: 'dsm-archive-meta' },
                  React.createElement('span', null, t('scenes.archive.summary', {
                    mcp: modal.sections.mcp ? Object.keys(modal.sections.mcp).length : 0,
                    skills: modal.sections.skills ? modal.sections.skills.length : 0,
                    subagents: modal.sections.subagents ? modal.sections.subagents.length : 0,
                  })),
                  React.createElement('span', { className: 'dsm-help' }, t('scenes.archive.note'))),
                mcpSeg(),
                skillsSeg(),
                subagentsSeg(),
                React.createElement('div', { className: 'dsm-modal-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-primary', disabled: busy, onClick: submitArchive }, t('memory.archive.save')))))
          }
          function openDrill(server) {
            setModal(Object.assign({}, modal, { drill: server }))
            setDrillTools(null)
            apiCall('mcpm-tools', { serverName: server }).then(function (res) {
              if (res && res.ok) setDrillTools((res.tools || []).map(function (x) { return { key: server + '/' + x.name, short: x.name, enabled: x.enabled !== false } }))
              else setDrillTools([])
            }).catch(function () { setDrillTools([]) })
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
            apiCall('scene-archive-save', { scene: modal.name, archive: (function () { var payload = {}; if (modal.sections.mcp) payload.mcp = modal.sections.mcp; if (modal.sections.skills) payload.skills = modal.sections.skills; if (modal.sections.subagents) payload.subagents = modal.sections.subagents; return payload })() }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                setResult({ ok: true, text: t('memory.result.archiveSaved', { name: modal.name }) + (res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : '') })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function enterMode(name) {
            setBusy(true)
            apiCall('scene-mode-set', { scene: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.modeSet', { name: name }) + (res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : '') }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function exitMode() {
            setBusy(true)
            apiCall('scene-mode-set', { scene: null }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.modeExited') }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          var modeScene = data.mode && data.mode.scene
          // 与 MCP / 技能页同构的三格统计（页面之间「头顶长什么样」保持一致）。
          var sceneStats = (function () {
            var own = (data.scenes || []).filter(function (s) { return s.shared !== true })
            return {
              total: own.length,
              active: own.filter(function (s) { return s.active === true }).length,
              archives: Object.keys(data.archives || {}).length,
            }
          })()
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('scenes.title')),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, t('scenes.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                modeScene ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.mode.current') + ': ' + modeScene) : null,
                modeScene ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: exitMode }, t('memory.mode.exit')) : null,
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }, t('memory.btn.refresh')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openCreateScene }, t('memory.btn.newScene')))),
            React.createElement('div', { key: 'stats', className: 'dsm-summary dsm-summary-3' },
              [[sceneStats.total, '个场景'], [sceneStats.active, '个已启用'], [sceneStats.archives, '个有档案']].map(function (item) {
                return React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1])
              })),
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            data.error ? React.createElement('div', { key: 'gerr', className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : React.createElement('div', { className: 'dsm-sources' }, (data.scenes || []).map(function (scene) {
                var name = scene.name
                var archive = data.archives[name]
                var hasModeSections = !!(archive && (archive.mcp || Array.isArray(archive.skills)))
                return React.createElement('div', { key: 's:' + name, className: 'dsm-source' },
                  React.createElement('div', { className: 'dsm-source-head' },
                    React.createElement('div', { className: 'dsm-source-head-main' },
                      React.createElement('span', { className: 'dsm-source-title' }, name === '' ? t('memory.scene.global') : name),
                      scene.shared ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                      modeScene === name ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.mode.current')) : null,
                      archive ? React.createElement('span', { className: 'dsm-tag' }, t('scenes.hasArchive')) : null,
                      scene.active === false ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.off')) : null),
                    React.createElement('div', { className: 'dsm-source-actions' },
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openArchive(name) } }, t('memory.archive.edit')),
                      hasModeSections && modeScene !== name ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { enterMode(name) } }, t('memory.mode.set')) : null,
                      !scene.shared && name !== '' ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'scene-delete', name: name }) } }, t('memory.btn.deleteScene')) : null,
                      scene.shared ? null : React.createElement(Switch, { on: scene.active === true, disabled: busy, label: t('memory.scene.enable') + ' ' + name, onClick: function () { toggleScene(scene) } }))))
              })),
            modal && modal.type === 'scene-create' ? React.createElement(Modal, { key: 'screate', title: t('memory.scene.createTitle'), closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.group')),
                  React.createElement('input', { className: 'dsm-control' + (sceneForm.error ? ' dsm-rule-invalid' : ''), value: sceneForm.name || '', placeholder: t('memory.field.group.placeholder'), onChange: function (e) { setSceneForm({ name: e.target.value, error: null }) } }),
                  React.createElement('p', { className: sceneForm.error ? 'dsm-rule-hint' : 'dsm-help' }, sceneForm.error || t('memory.field.group.hint'))),
                React.createElement('p', { className: 'dsm-help' }, t('memory.scene.createHelp'))),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || !String(sceneForm.name || '').trim(), onClick: submitCreateScene }, t('memory.btn.create')))) : null,
            modal && modal.type === 'scene-delete' ? React.createElement(Modal, { key: 'sdel', title: t('memory.deleteScene.title'), closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.deleteScene.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDeleteScene(modal.name) } }, t('memory.btn.deleteScene')))) : null,
            // 档案编辑器（见 archiveNode）：三段共用「段卡片 + 勾选行」排版。
            archiveNode(),
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
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('subagent-list', {}).then(function (r) {
              if (r && r.ok) setData({ loading: false, error: null, subagents: r.subagents || [] })
              else setData({ loading: false, error: translateError(t, r), subagents: [] })
            }).catch(function (e) { setData({ loading: false, error: String((e && e.message) || e), subagents: [] }) })
          }
          React.useEffect(function () { refresh() }, [])
          function openEditor(name) {
            if (!name) { setModal({ type: 'editor', mode: 'create', form: { name: '', description: '', model: '', tools: '', body: '', error: null } }); return }
            setBusy(true)
            apiCall('subagent-get', { name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                var p = res.persona || {}
                setModal({ type: 'editor', mode: 'edit', form: { name: p.name || name, description: p.description || '', model: p.model || '', tools: (p.tools || []).join(', '), body: p.body || '', error: null } })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function setForm(patch) { if (modal && modal.type === 'editor') setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, patch) })) }
          function submitEditor() {
            if (!modal || modal.type !== 'editor') return
            setBusy(true)
            var op = modal.mode === 'create' ? 'subagent-create' : 'subagent-update'
            apiCall(op, { name: modal.form.name, description: modal.form.description, model: modal.form.model, tools: modal.form.tools, body: modal.form.body }).then(function (res) {
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
                  React.createElement('h2', { className: 'dsm-title' }, t('subagents.title')),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, t('subagents.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }, t('memory.btn.refresh')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setResult(null); setModal({ type: 'import' }) } }, t('subagents.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { openEditor(null) } }, t('subagents.new')))),
            React.createElement(Notice, { kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            data.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(data.error)) : null,
            data.loading ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : data.subagents.length ? React.createElement('div', { className: 'dsm-sources' }, data.subagents.map(function (p) {
                return React.createElement('div', { key: p.name, className: 'dsm-source' },
                  React.createElement('div', { className: 'dsm-source-head' },
                    React.createElement('div', { className: 'dsm-source-head-main' },
                      React.createElement('span', { className: 'dsm-source-title' }, p.name),
                      React.createElement('span', { className: 'dsm-note' }, p.description || '')),
                    React.createElement('div', { className: 'dsm-source-actions' },
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openEditor(p.name) } }, t('memory.edit')),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'delete', name: p.name }) } }, t('memory.delete')))))
              })) : React.createElement('div', { className: 'dsm-empty' }, t('subagents.empty')),
            modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'sedit', wide: true, title: modal.mode === 'create' ? t('subagents.create') : t('subagents.edit') + ' · ' + modal.form.name, closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.name')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.name || '', disabled: modal.mode === 'edit', placeholder: 'code-review', onChange: function (e) { setForm({ name: e.target.value }) } }),
                  React.createElement('p', { className: 'dsm-help' }, t('subagents.field.name.hint'))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.description')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.description || '', placeholder: t('subagents.field.description.placeholder'), onChange: function (e) { setForm({ description: e.target.value }) } }),
                  React.createElement('p', { className: 'dsm-help' }, t('subagents.field.description.hint'))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.model')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.model || '', placeholder: t('subagents.field.model.placeholder'), onChange: function (e) { setForm({ model: e.target.value }) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.tools')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.tools || '', placeholder: 'read_file, glob', onChange: function (e) { setForm({ tools: e.target.value }) } }),
                  React.createElement('p', { className: 'dsm-help' }, t('subagents.field.tools.hint'))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: modal.form.body || '', placeholder: t('subagents.field.body.placeholder'), onChange: function (e) { setForm({ body: e.target.value }) } })),
                modal.form.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(modal.form.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-primary', disabled: busy || (modal.mode === 'create' && !String(modal.form.name || '').trim()) || !String(modal.form.body || '').trim(), onClick: submitEditor }, t('memory.btn.save')))) : null,
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'sdel2', title: t('subagents.delete.title'), closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('subagents.delete.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.name) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, { key: 'simp', t: t, title: t('subagents.import.title'), hint: t('subagents.import.hint'), busy: busy, onClose: function () { setModal(null) }, onSubmit: submitImport }) : null)
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
          // bundle 附件的隐藏文件选择器；上限与服务端 MAX_ATTACH_ENTRY_BYTES 对齐。
          var attachRef = React.useRef(null)
          var ATTACH_MAX_MB = 8
          var ATTACH_MAX_BYTES = ATTACH_MAX_MB << 20

          /** 场景名 = 分组路径的第一段（`web/frontend` 属于场景 `web`）。 */
          function sceneOf(group) {
            var s = String(group == null ? '' : group)
            var i = s.indexOf('/')
            return i >= 0 ? s.slice(0, i) : s
          }
          function sceneLabel(name) { return name === '' ? t('memory.scene.global') : name }
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
          function openEditor(rule) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-read', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok && res.rule) {
                var rd = res.rule
                setEditor({ mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [] })
                setModal({ type: 'editor' })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: String((e && e.message) || e) }) })
          }
          function closeEditor() { setModal(null) }
          // ── 导入记忆（.md / .zip；场景留空 = 全局：任何对话都注入）──
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

          // 场景 → 记忆：场景元数据来自 scenes（含空目录），记忆按一级目录归位；
          // 根层记忆（group 为空）归入「全局」桶，始终生效。
          var buckets = {}
          var order = []
          function ensureBucket(name, meta) {
            if (!buckets[name]) { buckets[name] = { name: name, meta: meta, rules: [] }; order.push(name) }
            else if (meta && !buckets[name].meta) buckets[name].meta = meta
            return buckets[name]
          }
          ;(data.scenes || []).forEach(function (s) { ensureBucket(s.name, s) })
          data.rules.forEach(function (r) {
            var b = ensureBucket(sceneOf(r.group), null)
            if (matchRule(r)) b.rules.push(r)
          })
          order.sort(function (a, b) {
            if (a === b) return 0
            if (a === '') return -1
            if (b === '') return 1
            var am = buckets[a].meta, bm = buckets[b].meta
            if (!!(am && am.shared) !== !!(bm && bm.shared)) return (am && am.shared) ? -1 : 1
            return String(a).localeCompare(String(b))
          })
          var sceneOptions = [{ value: '', label: t('memory.filter.all') }].concat(
            order.map(function (n) { return { value: n, label: sceneLabel(n) } }))
          // 全局（不选场景）排在最前：选中即清空场景 = 任何对话都注入。
          var sceneChoices = [{ value: '', label: t('memory.scene.global.hint') }].concat(
            order.filter(function (n) { return n !== '' }).map(function (n) { return { value: n, label: sceneLabel(n) } }))
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

          function renderRuleRow(r, sceneActive) {
            var shadowed = r.shadowed === true
            // shadowed = 存在同名 bundle，本条 flat 不会被加载；与文件名是否 kebab-case 无关——
            // 记忆名就是 .md 文件名，中文名同样可以在本页编辑 / 删除。
            var enabled = r.enabled !== false
            // 单条停用（索引层开关）优先于场景状态：原来只有 已启用/被覆盖/场景未启用 三个分支，
            // 单条停用的记忆会被误显示为「已启用」。
            var statusKey = shadowed ? 'status.shadowed' : !enabled ? 'memory.status.off' : sceneActive === false ? 'memory.status.sceneOff' : 'status.enabled'
            var statusCls = shadowed ? 'dsm-shadowed' : (!enabled || sceneActive === false) ? 'dsm-disabled' : 'dsm-enabled'
            return React.createElement('div', { key: r.id, className: 'dsm-row' },
              React.createElement('div', { className: 'dsm-main' },
                React.createElement('div', { className: 'dsm-name' }, r.name),
                React.createElement('div', { className: 'dsm-note' }, r.description || ''),
                shadowed ? React.createElement('div', { className: 'dsm-rule-shadow-hint' }, t('memory.shadowed.hint')) : null),
              React.createElement('div', { className: 'dsm-tags' },
                r.group && r.group.indexOf('/') >= 0 ? React.createElement('span', { className: 'dsm-tag' }, r.group) : null,
                r.form === 'bundle' ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.form.bundle')) : null,
                r.descriptionDerived ? React.createElement('span', { className: 'dsm-tag' }, t('memory.derived')) : null),
              React.createElement('div', { className: 'dsm-status ' + statusCls }, t(statusKey)),
              React.createElement('div', { className: 'dsm-row-actions' },
                React.createElement(Switch, { on: enabled, disabled: busy || shadowed, label: t('memory.enable') + ' ' + r.name, onClick: function () { toggleRule(r) } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || shadowed, onClick: function () { openEditor(r) } }, t('memory.edit')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || shadowed, onClick: function () { setModal({ type: 'delete', rule: r }) } }, t('memory.delete'))))
          }

          function renderSceneCard(name) {
            var bucket = buckets[name]
            var meta = bucket.meta || { name: name, count: 0, active: name === '', shared: false }
            var isShared = meta.shared === true
            var open = !collapsed['s:' + name]
            return React.createElement('div', { key: 's:' + name, className: 'dsm-source' + (meta.active === false ? ' dsm-rule-shadowed' : '') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleCollapse('s:' + name) } },
                  React.createElement('span', { className: 'dsm-source-title' }, sceneLabel(name)),
                  React.createElement('span', { className: 'dsm-count' }, t('memory.scene.count', { count: bucket.rules.length })),
                  isShared ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                  name === '' ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.global.tag')) : null,
                  meta.active === false ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.off')) : null),
                React.createElement('div', { className: 'dsm-source-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openCreate(name) } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                bucket.rules.length
                  ? React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-table-head' },
                      React.createElement('span', null, t('memory.table.name')),
                      React.createElement('span', null, t('memory.table.tags')),
                      React.createElement('span', null, t('memory.table.status')),
                      React.createElement('span', null, '')),
                    bucket.rules.map(function (r) { return renderRuleRow(r, meta.active !== false) }))
                  : React.createElement('div', { className: 'dsm-empty' }, t('memory.scene.empty'))) : null)
          }

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('memory.title')),
                  React.createElement(VersionBadge, null)),
                React.createElement('p', { className: 'dsm-desc' }, t('memory.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }, t('memory.btn.refresh')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openTrash }, t('memory.trash.open')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setResult(null); setImportScene(''); setModal({ type: 'import' }) } }, t('memory.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { openCreate(sceneFilter || '') } }, t('memory.btn.new')))),
            React.createElement('div', { className: 'dsm-summary dsm-summary-3' },
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
              : visibleBuckets.length ? React.createElement('div', { key: 'scenes', className: 'dsm-sources' }, visibleBuckets.map(renderSceneCard))
              : React.createElement('div', { key: 'empty', className: 'dsm-empty' }, q || sceneFilter ? t('memory.empty.search') : t('memory.empty')),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: t('memory.delete.title'), closeLabel: t('btn.cancel'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.delete.desc', { name: modal.rule.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.rule) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, {
              key: 'mimp', t: t, title: t('memory.import.title'), hint: t('memory.import.hint'), busy: busy,
              extra: React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.import.scene')),
                React.createElement('input', { className: 'dsm-control', value: importScene, placeholder: t('memory.scene.global.hint'), onChange: function (e) { setImportScene(e.target.value) } }),
                React.createElement('p', { className: 'dsm-help' }, t('memory.import.sceneHint'))),
              onClose: function () { setModal(null) },
              onSubmit: submitImport,
            }) : null,
            editor && modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'editor', className: 'dsm-modal-wide', title: editor.mode === 'create' ? t('memory.create.title') : t('memory.edit.title'), closeLabel: t('btn.cancel'), onClose: closeEditor },
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
                  ? React.createElement('p', { className: 'dsm-help' }, t('memory.scene.pick'))
                  : null,
                editorGroupInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('error.rules.invalidGroup')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (editorNameInvalid ? ' dsm-rule-invalid' : ''), value: editor.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { name: e.target.value })) } }),
                  React.createElement('p', { className: editorNameInvalid ? 'dsm-rule-hint' : 'dsm-help' }, editorNameInvalid ? t('memory.name.invalid') : t('memory.name.hint'))),
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
                    ? React.createElement('div', { className: 'dsm-field' },
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
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: closeEditor }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || editorNameInvalid || editorGroupInvalid || editorDescLen > 500 || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : submitUpdate }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
            // 场景建/删/档案弹窗已移至「场景」页（ScenesPage）。
            modal && modal.type === 'trash' ? React.createElement(Modal, { key: 'trash', wide: true, title: t('memory.trash.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              trash.loading ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
                : React.createElement(React.Fragment, null,
                  trash.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(trash.error)) : null,
                  trash.entries.length
                    ? React.createElement(React.Fragment, null,
                      React.createElement('div', { className: 'dsm-count' }, t('memory.trash.count', { count: trash.entries.length })),
                      trash.entries.map(function (entry) {
                        return React.createElement('div', { key: entry.trashId, className: 'dsm-trash-item' },
                          React.createElement('div', { className: 'dsm-trash-main' },
                            React.createElement('div', { className: 'dsm-name' }, entry.name),
                            React.createElement('div', { className: 'dsm-note' },
                              sceneLabel(entry.group) + ' · ' + t('memory.form.' + (entry.form === 'bundle' ? 'bundle' : 'flat')) + ' · ' + entry.bytes + ' B · '
                              + t('memory.trash.deletedAt', { time: entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : '' }))),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { submitRestore(entry) } }, t('memory.trash.restore')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'trash-delete', entry: entry }) } }, t('memory.trash.purge')))
                      }))
                    : React.createElement('div', { className: 'dsm-empty' }, t('memory.trash.empty')))) : null,
            modal && modal.type === 'trash-delete' ? React.createElement(Modal, { key: 'trash-delete', title: t('memory.trash.confirmTitle'), closeLabel: t('btn.cancel'), onClose: function () { setModal({ type: 'trash' }) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.trash.confirmDesc', { name: modal.entry.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal({ type: 'trash' }) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitTrashDelete(modal.entry) } }, t('memory.trash.purge')))) : null)
        }

        module.exports.DICT = DICT
        // Test-only export: page 组件 + i18n t，让 client 测试直接渲染 page（绕开
        // ToolsSection 的子组件嵌套——minimal React 不支持子组件 hook 隔离）。
        // 生产环境浏览器 React 会正确递归渲染 ToolsSection 内的 page。
        module.exports._pages = { MCPPage: MCPPage, SkillManagerSection: SkillManagerSection, AgentsMdPage: AgentsMdPage, HistoryPage: HistoryPage, ScenesPage: ScenesPage, SubagentsPage: SubagentsPage, MemoryPage: MemoryPage, t: t }
      },
    }
    return module.exports
  }
})
