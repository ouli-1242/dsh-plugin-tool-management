    const CSS =
      ':root{--dsm-warn:#d49245;--dsm-warn-bg:rgba(212,146,69,.12)}' +
      '.dsm-stat-row{display:flex;min-width:0;align-items:center;gap:10px}.dsm-stat-row .dsm-summary{flex:1;min-width:0}' +
      '.dsm-version{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;letter-spacing:.3px;line-height:1}' +
      '.dsm-row-hint{grid-column:1/-1;margin:-4px 0 9px;color:var(--dsm-warn);font-size:11px;line-height:16px}' +
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
/* 按钮的"档位"里包含尺寸，别把它当纯修饰色：.dsm-btn 实心 34px（本屏主操作）/
   .dsm-btn-secondary 描边 34px（常规动作）/ .dsm-btn-quiet 描边 28px（次要动作）；
   .dsm-btn-danger / -lock / -picked 只换颜色（背景一律置透明），与档位正交 ——
   写 dsm-btn dsm-btn-danger 就是"34px 的破坏性"，叠 quiet 就是"28px 的破坏性"。
   铁律：**同一行 / 同一组按钮必须同高** —— 行里有实心或常规动作就整行 34px（弹窗脚、
   页头动作条），整行都是行内小动作才整行 28px（列表行、回收站行、分段组）。
   （CSS 注释里别写反引号：这段整体在 JS 模板字符串里，反引号会把字符串截断。） */
.dsm-btn{box-sizing:border-box;display:inline-flex;min-height:34px;align-items:center;justify-content:center;padding:0 13px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:580;white-space:nowrap;cursor:pointer}.dsm-btn:hover:not(:disabled){filter:brightness(1.08)}.dsm-btn:disabled{opacity:.48;cursor:default}.dsm-btn-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.dsm-btn-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);min-height:28px;padding:0 9px;font-size:12px}.dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}.dsm-btn-lock{border-color:var(--dsm-warn);background:transparent;color:var(--dsm-warn)}.dsm-btn:focus-visible,.dsm-control:focus-visible,.dsm-select-trigger:focus-visible,.dsm-source-head:focus-visible,.dsm-switch:focus-visible,.dsm-upload-link:focus-visible,.dsm-file-remove:focus-visible,.dsm-dropzone:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
.dsm-summary{display:grid;grid-template-columns:repeat(var(--dsm-stat-cols,3),minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-secondary)}.dsm-stat:last-child{border-right:0}.dsm-stat strong,.dsm-stat-num{margin-right:5px;color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680}.dsm-filters{display:flex;gap:9px}.dsm-search{flex:1}.dsm-source-filter{width:210px;flex:none}
.dsm-control,.dsm-select-trigger{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm-control::placeholder{color:var(--dsw-alias-label-tertiary)}textarea.dsm-control{min-height:160px;padding-top:9px;resize:vertical;line-height:20px}.dsm-select{position:relative}.dsm-select-trigger{display:flex;align-items:center;justify-content:space-between;text-align:left;cursor:pointer}.dsm-select-menu{position:absolute;z-index:40;top:calc(100% + 5px);right:0;left:0;display:flex;max-height:260px;padding:5px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2)}.dsm-option{padding:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.dsm-option:hover,.dsm-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sources{display:flex;flex-direction:column;gap:9px}.dsm-source{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.dsm-source-head{box-sizing:border-box;display:flex;width:100%;min-height:48px;align-items:center;padding:0 13px}.dsm-source-head-main{display:flex;min-width:0;min-height:48px;flex:1;align-items:center;gap:10px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsm-source-head:hover,.dsm-row:hover,.dsm-trash-row:hover,.dsm-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-source-title{font-size:14px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-count{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}.dsm-path{min-width:0;margin-left:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm-source-actions{display:flex;align-items:center;gap:6px;margin-left:8px}.dsm-source-body{border-top:1px solid var(--dsw-alias-border-l1)}.dsm-source-note{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
/* ── 子智能体行：人设名与描述分行（用户 2026-09-22 报）──────────────────────────
   原来名字与描述同在 .dsm-source-head-main 那一条**横向** flex 里、各自单行省略，
   右侧还压着开关和两颗按钮 —— 名字被挤到只剩几个字符（截图里显示成 "co..."）。
   改成纵向两行：**名字独占一行、仍单行省略**（全名靠 title），描述另起一行、单行省略。
   只作用于本页：.dsm-source-head-main 还被技能 / 记忆 / MCP / 会话四页的分组头共用，
   那些行没有描述，不动。同权重靠书写顺序取胜，所以必须排在上面那条 .dsm-source 规则之后。 */
/* 提示词页的两张分组卡片：条目本身仍是 .dsm-source 卡，直接套进组卡的卡片体里就成了
   "卡中卡"（一层边框套一层边框）。这里把它们压平成带分隔线的行 —— 与技能 / MCP 那两页
   的卡片体同一个观感（用户 2026-10-01 裁定：做成技能那样可以折叠的样式）。 */
.dsm-source-body .dsm-sources{gap:0}
.dsm-source-body .dsm-source{border:0;border-radius:0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsm-source-body .dsm-source:last-child{border-bottom:0}
.dsm-persona-main{box-sizing:border-box;min-height:48px;padding:6px 0;flex-direction:column;align-items:flex-start;justify-content:center;gap:0}
.dsm-persona-name-row{display:flex;width:100%;min-width:0;align-items:center;gap:7px}
.dsm-persona-name-row .dsm-tag{flex:none}
.dsm-persona-desc{width:100%;margin-top:1px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-table-head,.dsm-row{display:grid;grid-template-columns:minmax(180px,1fr) 120px max-content;align-items:center;column-gap:12px;padding:0 13px}.dsm-table-head{min-height:32px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-row{min-height:58px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-row:last-child{border-bottom:0}.dsm-main{min-width:0}.dsm-name{overflow:hidden;font-size:13px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.dsm-name-row{display:flex;width:100%;min-width:0;align-items:center;gap:6px}.dsm-name-row .dsm-name{min-width:0}.dsm-name-row .dsm-tag{flex:none}
/* 行首挂了圆点的列（MCP）：点占 8px + 6px 间距 = 14px 的槽。名字与描述、表头一起让出这一槽，
   点再负边距挂回槽的左沿 —— 否则名字比下面的描述和表头右移 14px，看着就是没对齐（2026-09-29 用户反馈）。 */
.dsm-dot-indent{padding-left:14px}
.dsm-dot-indent .dsm-name-row{margin-left:-14px}
/* MCP 行的两行预算（用户裁定 2026-09-29）：名字一行、备注与标签一行 —— 标签不再单独占一行，
   带不带备注行高都一样；那一列空出来后，行网格从三列收到两列（表头同步）。 */
.dsm-row-compact{grid-template-columns:minmax(180px,1fr) max-content}
.dsm-meta-row{display:flex;min-width:0;align-items:center;gap:5px;margin-top:2px}.dsm-meta-row:empty{display:none}
.dsm-meta-row .dsm-note{min-width:0;margin-top:0}
.dsm-meta-row .dsm-tag{flex:none}.dsm-note{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.dsm-tag{display:inline-flex;min-height:19px;align-items:center;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap}.dsm-tag-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.dsm-tag-off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.dsm-tag-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}.dsm-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}
.dsm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}.dsm-switch:after{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;content:"";transition:transform 160ms ease}.dsm-switch-on{background:var(--dsw-alias-state-success-primary)}.dsm-switch-on:after{transform:translateX(14px)}.dsm-switch:disabled{opacity:.45;cursor:default}.dsm-trash-row{display:flex;min-height:48px;align-items:center;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsm-trash-count{margin-left:auto;padding:2px 7px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}.dsm-empty{padding:25px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsm-feedback{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-undo{display:flex;align-items:center;gap:10px}.dsm-undo-text{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsm-undo-close{padding:0;border:0;background:transparent;font:inherit;font-size:18px;cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary)}.dsm-undo-close:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-undo.dsm-warning{background:var(--dsm-warn-bg)}.dsm-undo.dsm-warning .dsm-undo-text{font-weight:570}.dsm-undo.dsm-warning .dsm-undo-close{color:var(--dsm-warn)}.dsm-warning{border-color:var(--dsm-warn);color:var(--dsm-warn)}.dsm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.dsm-modal{box-sizing:border-box;display:flex;width:min(560px,100%)!important;max-height:min(760px,calc(100vh - 48px));min-width:0;flex-direction:column;gap:16px;padding:22px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.dsm-modal-sm,.dsm-modal-import{width:min(480px,100%)!important}.dsm-modal-md{width:min(560px,100%)!important}.dsm-modal-lg,.dsm-modal-wide{width:min(720px,100%)!important}.dsm-modal-list{width:min(560px,100%)!important;height:min(640px,calc(100vh - 48px))!important;max-height:none!important;overflow:hidden}.dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:10px}.dsm-modal-list .dsm-modal-body{flex:1;overflow:auto;overscroll-behavior:contain}.dsm-modal-import{padding:24px}.dsm-modal-head{display:flex;align-items:flex-start;gap:12px}
/* 头部这一层包住「标题行 + 令牌提示」：提示挂在头部里面（而不是 head 与 body 之间）是为了
   让 body 的子节点位置稳定 —— 位置一变 React 会把 body 整棵重挂（输入框失焦、下拉归零）。 */
.dsm-modal-head-wrap{display:flex;flex-direction:column;gap:12px}.dsm-modal-title{margin:0;flex:1;font-size:17px;line-height:24px;font-weight:670}.dsm-form,.dsm-field,.dsm-detail-section{display:flex;flex-direction:column}.dsm-form{gap:12px}.dsm-field{gap:6px}.dsm-label,.dsm-detail-title{font-size:12px}.dsm-label{color:var(--dsw-alias-label-secondary)}.dsm-detail-title{font-weight:650}.dsm-help{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsm-help-list{display:flex;margin:0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
/* 两动作性质不同的弹窗底部（目前只有「进入场景」的预览卡）：左边「不再显示」、右边「确认进入」。
   都靠右排会读成"两选一"，而它们不是同一层意思（一个是不想被拦，一个是要这么做）。 */
.dsm-modal-actions-split{justify-content:space-between}.dsm-hidden-input{display:none}.dsm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color 180ms ease,background 180ms ease;cursor:pointer;font:inherit;text-align:center}.dsm-dropzone:hover,.dsm-dropzone-active{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsm-dropzone-title{color:var(--dsw-alias-label-primary);font-size:18px;font-weight:700}.dsm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dsm-upload-choices{display:flex;align-items:center;gap:7px}.dsm-upload-link,.dsm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsm-upload-link{color:var(--dsw-alias-label-secondary)}.dsm-upload-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.dsm-upload-link:disabled{opacity:.45;cursor:default}.dsm-upload-divider{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-file{display:flex;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}.dsm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700}.dsm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dsm-file-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.dsm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary);font-size:18px}.dsm-upload-requirements{padding:1px 1px 0}.dsm-upload-requirements ul{display:flex;margin:7px 0 0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.dsm-detail-section{gap:7px}.dsm-detail-path,.dsm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-detail-path{padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-all}.dsm-code{max-height:280px;margin:0;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:pre-wrap}.dsm-diag{padding:8px 10px;border-left:2px solid var(--dsm-warn);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-trash-group-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsm-modal-title-row{display:inline-flex;align-items:center;gap:9px;min-width:0}
.dsm-pill{display:inline-flex;min-height:20px;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap}
.dsm-pill-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-pill-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-pill-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
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
@container(max-width:780px){.dsm-table-head{display:none}.dsm-row{grid-template-columns:minmax(0,1fr) max-content;gap:8px;padding:11px 13px}
/* MCP 行在这一档只有两行内容，58px 的下限是三行时代留下的：加上自带的一截空白，行高 80px
   太空（2026-09-29 用户反馈）。下限收到 46px（两行内容 42.7px 装得下，单行也仍撑到同一高度），
   行高 68px —— 上下各留 11px 内边距，不挤。技能 / 记忆两页仍是 58px 下限，未动。 */
.dsm-row.dsm-row-compact{min-height:46px}
/* 动作组别跨到第 2、3 行：那一格是空的，行距却照算（两行 16px 凭空多出来）。MCP 行在这
   一档只有「主列 + 动作组」两项，跨一行就够。 */
.dsm-row.dsm-row-compact .dsm-row-actions{grid-row:1}
.dsm-row>.dsm-tags{grid-column:1}.dsm-row-actions{grid-column:2;grid-row:1 / span 3}.dsm-path{display:none}
/* 一个标签都没有的记忆（flat 且没有场景 / 派生标签）：那一行是空的，高度 0 却仍要付两个
   8px 的行间距 —— 于是「描述」和「已启用」之间凭空多出 16px（用户实测）。让它不占位，
   并把右侧动作组的跨度跟着收到两行。**只在这一档布局里做**：宽布局下标签是固定 120px 的
   一列，抽掉它后面几列会整体左移。 */
.dsm-row>.dsm-tags:empty{display:none}
.dsm-row>.dsm-tags:empty~.dsm-row-actions{grid-row:1 / span 2}}@media(max-width:760px){.dsm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.dsm-title-row{flex-wrap:wrap}}@container(max-width:520px){.dsm-head{flex-direction:column}.dsm-actions{width:100%;margin-left:0}.dsm-actions .dsm-btn{flex:1}.dsm-filters{flex-direction:column}.dsm-source-filter{width:100%}.dsm-summary{grid-template-columns:1fr}}
.dsm-hist-row{display:flex;align-items:center;gap:11px;padding:10px 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-hist-row:last-child{border-bottom:0}.dsm-hist-main{min-width:0;flex:1}.dsm-hist-title{overflow:hidden;font-size:13px;font-weight:580;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd{overflow:hidden;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-hist-cwd-missing{color:var(--dsw-alias-state-error-primary)}.dsm-hist-actions{display:flex;gap:6px;flex:none}.dsm-hist-check,.dsm-hist-group-check{flex:none;width:15px;height:15px;margin:0 4px 0 0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}.dsm-hist-group-head{gap:10px}.dsm-hist-group-extra{display:flex;align-items:center;gap:8px;flex:none;margin-left:4px}.dsm-hist-group-extra .dsm-tag{flex:none}.dsm-hist-dir-missing{flex:none;color:var(--dsw-alias-state-error-primary);font-size:11px;white-space:nowrap}.dsm-hist-register-path{margin-top:-4px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,monospace);font-size:11px;word-break:break-all}.dsm-hist-batch{display:flex;align-items:center;gap:8px;margin-left:2px;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l2)}.dsm-hist-batch-count{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsm-hist-batch-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none}.dsm-dir-row{display:flex;gap:8px}.dsm-dir-row .dsm-control{flex:1}.dsm-dir-list{display:flex;max-height:220px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsm-dir-item{display:flex;width:100%;align-items:center;padding:8px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.dsm-dir-item:last-child{border-bottom:0}.dsm-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-dir-item::before{content:"📁";margin-right:8px;font-size:12px}
.dsm-rule-shadowed .dsm-name,.dsm-rule-shadowed .dsm-note{color:var(--dsw-alias-state-error-primary)}.dsm-rule-off .dsm-name,.dsm-rule-off .dsm-note{color:var(--dsw-alias-label-tertiary)}.dsm-rule-shadow-hint{margin-top:3px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-invalid{border-color:var(--dsw-alias-state-error-primary)!important}.dsm-rule-hint{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px}.dsm-rule-budget{display:flex;flex-direction:column;gap:6px}.dsm-budget-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.dsm-budget-meta strong{margin-right:0;font-size:13px;font-weight:680}.dsm-budget-over-text{color:var(--dsw-alias-state-error-primary);font-size:11px}.dsm-budget-bar{height:6px;overflow:hidden;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover)}.dsm-budget-fill{height:100%;border-radius:99px;background:var(--dsw-alias-state-success-primary);transition:width 160ms ease}.dsm-budget-fill.dsm-budget-over{background:var(--dsw-alias-state-error-primary)}.dsm-char-count{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsm-char-over{color:var(--dsw-alias-state-error-primary)}.dsm-field-row{display:flex;gap:12px;align-items:flex-start}.dsm-field-row>.dsm-field{flex:1;min-width:0}
.dsm-combo-row{display:flex;gap:8px}.dsm-combo-row .dsm-control{flex:1}
.dsm-attach-list{display:flex;flex-direction:column;gap:6px}.dsm-attach-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsm-toast{position:fixed;right:22px;bottom:22px;z-index:1250;box-sizing:border-box;max-width:min(420px,calc(100vw - 44px));padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;animation:dsm-toast-in 160ms ease-out}@keyframes dsm-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}/* 动效降级：系统开了「减少动态效果」就一律关掉。新增 transition / animation 时记得同步加到这里，
   否则那一个动效就是唯一不尊重用户设置的部分（FLIP 在 JS 侧另判，见 useFlip）。 */
@media(prefers-reduced-motion:reduce){.dsm-toast{animation:none}.dsm-switch:after{transition:none}.dsm-dropzone{transition:none}.dsm-budget-fill{transition:none}}
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
/* 条目本来就少的那一段（场景表单里的快捷提示词）：跟着内容长，超过 6 行才内滚。
   固定 216px 的段体放在一张按内容高的表单弹窗里，就是"一个勾 + 一片空白"（用户实测）。 */
.dsm-seg-fit{height:auto;max-height:172px}
/* 表单分段标题：把一长串字段切成「基本信息 / 场景绑定」这类模块，右侧一道发丝线跟着撑满。 */
.dsm-form-section{display:flex;align-items:center;gap:10px;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:620;letter-spacing:.02em}
.dsm-form-section::after{content:"";height:1px;flex:1;background:var(--dsw-alias-border-l1)}
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
/* 档案弹窗固定高度：加/删段、进出「选工具」子视图都不改变弹窗尺寸。
   2026-09-28 用户裁定改 **2×2 网格**：四段同屏，段体超出各自段内滚 —— 原来四段竖排
   （min-height 300px × 4 ≈ 1200px），720px 的框装不下，只能整体滚动逐段看。两列后
   每行分到剩余高度的一半，段体滚动区与旧竖排的 216px 相当；段头/工具栏钉在段顶。
   （旧注释「不要 flex:1 平分」说的是单列布局 —— 网格两列四段，平分反而刚好。） */
.dsm-modal-archive{width:min(1080px,100%)!important;height:min(880px,calc(100vh - 48px));max-height:none;overflow:hidden}
.dsm-modal-archive .dsm-form{min-height:0;gap:10px;overflow:hidden}
.dsm-archive-grid{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:10px}
.dsm-archive-grid .dsm-seg{min-height:0}
.dsm-modal-archive .dsm-seg-body{height:auto;flex:1 1 auto;min-height:0}
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
.dsm-adv-caret{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}
/* 「高级选项」永不折行：它在收起时与两行摘要并排，被挤成两字一行就不再像个标题了。 */
.dsm-adv-title{flex:none;white-space:nowrap}
/* 折叠摘要最多两行（第一行模型 / 思考强度 / 允许追问，第二行工具限制；没有值的那一行不出现），
   靠 align-items:center 与标题垂直居中。 */
.dsm-adv-sum{display:flex;min-width:0;flex-direction:column;gap:1px}
.dsm-adv-body{display:flex;flex-direction:column;gap:16px;padding:11px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 分组（0.19.0 重排）：组标题 + 一条横贯的细线，组间距靠 .dsm-adv-body 的 16px。
   重排前是五组平铺、只靠 12px gap 分隔，视觉上连成一片 —— 分组是这次清理的主手段。 */
.dsm-adv-group{display:flex;flex-direction:column;gap:10px}
.dsm-adv-group-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:570}
.dsm-adv-group-head::after{content:'';height:1px;flex:1;background:var(--dsw-alias-border-l1)}
/* 半宽字段：与 .dsm-field-row 的列宽同源（calc(50% - 6px) = 12px gap 的一半），
   所以单独一个半宽字段和并排两个的列边界对齐。 */
.dsm-adv-half{width:calc(50% - 6px)}
/* 下拉在 .dsm-combo-row 里必须自己撑满整格。缺这条时 .dsm-select 是 flex:0 1 auto、宽度
   由**选项文字**撑出：收窄来源后标签变短（去掉了「来源 · 」前缀、候选只剩几条），下拉当场
   跟着缩 —— 用户 2026-10-07 截图「模型来源选择后，模型框变短了」。实测（headless Chrome，
   字段宽 251）：标签带前缀 251 / 去前缀 251 / 只剩 id 162 / 只有一个模型 135，加了这条全部 251。
   min-width:0 是配套的：flex 项默认 min-width:auto = min-content，不放宽就压不到整格以下。 */
.dsm-combo-row .dsm-select{flex:1;min-width:0}
.dsm-adv-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
/* ── 工具限制四行（人设表单：一行一个 Agent 预设，白/黑名单互斥、默认折叠）──────── */
/* 无 margin-top：这个名单原先紧跟在自己的字段 label 后面，靠 6px 拉开；0.19.0 重排后
   label 撤掉、由分组头承担，间距交给 .dsm-adv-group 的 gap。 */
.dsm-modes{display:flex;flex-direction:column;gap:6px}
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
.dsm-mode-sum.dsm-mode-deny{color:var(--dsm-warn)}
.dsm-mode-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.dsm-mode-btn-allow{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-mode-btn-deny{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-mode-body{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-legacy{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
/* ── 兼容页（宿主能力体检）──────────────────────────────────────────────
   一块"体检报告"：先给结论卡，再给动作可用性、降级项、模块实体、阻塞项。
   状态色只用设计系统里已有的三档：成功 / 告警（--dsm-warn）/ 错误。 */
   /* 注意：整段 CSS 是一个模板字符串，注释里**不能出现反引号** —— 它会提前闭合模板，
      整个 bundle 直接语法错误（客户端白屏）。 */
.dsm-compat{display:flex;flex-direction:column;gap:10px}
.dsm-compat-bar{display:flex;min-width:0;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-bar-warn{border-color:var(--dsm-warn)}
.dsm-compat-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsm-compat-dot-warn{background:var(--dsm-warn)}
.dsm-compat-bar strong{margin:0;font-size:13px;font-weight:650}
.dsm-compat-sum{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
/* 三个指标格：左对齐、等分，窄屏落成单列。 */
.dsm-compat-grid{display:grid;gap:10px;grid-template-columns:repeat(3,minmax(0,1fr))}
.dsm-compat-card{display:flex;min-width:0;flex-direction:column;gap:3px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-card-bad{border-color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-compat-card-value{color:var(--dsw-alias-label-primary);font-size:17px;font-weight:680;line-height:22px;word-break:break-all}
.dsm-compat-card-value-bad{color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-note{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-compat-section{display:flex;min-width:0;flex-direction:column;gap:7px}
/* 「可操作的设置块」的**内容**加一圈边框（访问令牌 / 注入实况）。两种东西没有它时整页
   就是一长条同质的文字，用户找不到"我该动哪儿"。边框只包内容：小标题留在框外、底色跟
   页面一致（用户裁定 2026-09-19：「小标题不用在框里」「背景不用设置深灰色，和大背景一样
   就行」—— 上一版标题进框、框内再铺一层深灰底，整页多出一串"盒子里的盒子"）。
   取值与「注入」那一块（.dsm-inject-settings）一致，三块看起来才是同一类东西。 */
.dsm-compat-box{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
/* 域列表（注入实况）自己就带边框与底色，放进带边框的框里时去掉 —— 否则框里套框、
   两层同色，看起来只是多了一圈多余的线（行与行之间本来就有细分隔线）。 */
.dsm-compat-box .dsm-compat-mod-list{border:0;border-radius:0;background:transparent}
/* 访问令牌（兼容页）2026-09-19 第三次重构：按作用域拆两个分区 ——
   ① 访问令牌 = 状态行 + 控件槽（本机、临时）；② 令牌管理 = 静态四行清单（配置、持久），
   所有写配置的表单开在弹窗里，页面上没有任何会展开收起的东西。 */
/* 状态区的实况行与解锁错误共用：错误顶替实况（红色），行高不变。 */
.dsm-token-stat-err{color:var(--dsw-alias-state-error-primary)}
/* 控件槽（仅「待解锁」态渲染）：输入框 + 解锁。浅描边 + 左侧警示竖线（不用警示底色：
   与「待重启」横幅同用 warn 色，两个大色块叠一张卡只会互相稀释）。已解锁后这一槽
   不渲染 —— 状态行的绿胶囊就是唯一标识，不再重复。 */
.dsm-token-unlock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsm-warn);border-radius:8px}
.dsm-token-unlock .dsm-control{flex:1 1 190px;min-width:0}
/* 管理清单的行：名字 · 一句说明 · 按钮，三列同形同位 —— 行不随状态增删。 */
.dsm-token-rows{display:flex;flex-direction:column;gap:8px}
.dsm-token-mrow{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;gap:2px 10px;align-items:center}
.dsm-token-mrow-name{color:var(--dsw-alias-label-primary);font-size:12px;white-space:nowrap}
.dsm-token-mrow-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
/* 行按钮统一宽度（fixedLabelPair 负责文案翻转不挤宽），四行按钮的右缘对齐成一列；
   min-width 按"四个汉字 + 内边距"留足余量，不让文案贴边截断。 */
.dsm-token-mrow .dsm-btn{min-width:92px}
/* 弹窗里的表单：密码框**各占一行**（圆点看不出填的是哪格，竖排靠顺序就够）。 */
.dsm-token-form{display:flex;flex-direction:column;gap:8px}
/* 横排 .dsm-control 的 flex-basis 在竖排里会被当成高度（每格被撑成 190px 高），
   这里按回 auto、宽度交给 width:100%。 */
.dsm-token-form .dsm-control{flex:0 0 auto;width:100%}
/* 弹窗内部的错误行：跟框走（错误永远不出现在弹窗外面），贴紧上方的控件。 */
.dsm-token-ferr{margin:0}
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
.dsm-compat-pill-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-compat-reach-marks{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;min-width:0}
.dsm-inject-settings{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
/* 注入域勾选：横排、窄容器自动换行；标签一律短名（记忆 / MCP / …），不截断也不竖排。 */
.dsm-inject-domains{display:flex;flex-wrap:wrap;gap:7px 18px;padding:0 2px}
.dsm-inject-domain{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsm-inject-domain input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
/* 模型工具表：与「注入」同屏的第二种开关。**一行一个工具、四列固定宽度**（勾选框 / 名字 /
   ≈tok / 一句话介绍）—— 列宽不固定就竖着扫不出任何一列（用户 2026-09-23 指出挤成一排很难看）。
   名字用等宽、数字用 tabular-nums 右对齐；介绍超长省略，完整那句在悬停里。
   出厂默认关着哪几条**不在行上标**（用户 2026-09-23 要求去掉「默认关」小标）：合计下面那句
   "其中 ≈X 是出厂默认关掉的 N 条"是唯一的出处，加上悬停那一行会说"出厂默认就是关着的"。 */
.dsm-tooltable{display:flex;flex-direction:column;gap:10px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
/* 保存往返期间：整块不吃点击、略灰 —— 这一块刻意没有乐观更新（见 saveToolTable 注释）。 */
.dsm-tooltable-busy{pointer-events:none;opacity:.55}
.dsm-tooltable-summary{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
/* 「保存方案 / 恢复方案」钉在合计那一行的最右（用户 2026-09-23 指定位置）。
   按钮压到与 18px 行高齐平：宿主默认的 .dsm-btn 比这行字高，直接放会把整行顶开。 */
.dsm-tooltable-preset-actions{display:flex;flex:none;align-items:center;gap:6px;margin-left:auto}
.dsm-tooltable-preset-actions .dsm-btn{padding:0 9px;font-size:11px;line-height:22px}
/* 方案清单（恢复弹窗）：一行一份，名字吃剩余宽度，数字与两颗按钮靠右。 */
.dsm-preset-list{display:flex;flex-direction:column;gap:6px}
.dsm-preset-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.dsm-preset-name{min-width:0;overflow:hidden;flex:1;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.dsm-preset-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-preset-row .dsm-btn{padding:0 9px;font-size:11px;line-height:22px}
.dsm-preset-tag{margin-left:6px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400}
/* 合计的第二句：把"省下的"拆出出厂默认那一截。比第一句弱一档，它是解释不是结论。 */
.dsm-tooltable-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dsm-tooltable-group{display:flex;flex-direction:column;gap:3px}
.dsm-tooltable-ghead{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}
.dsm-tooltable-ghead input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-tooltable-gname{font-weight:600}
.dsm-tooltable-gcount{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-tooltable-tools{display:flex;flex-direction:column;padding-left:22px}
.dsm-tooltable-tool{display:grid;grid-template-columns:15px 186px 48px minmax(0,1fr);align-items:center;gap:0 8px;padding:2px 4px;border-radius:5px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer}
.dsm-tooltable-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-tooltable-tool input[type=checkbox]{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-tooltable-name{overflow:hidden;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.dsm-tooltable-tok{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-tooltable-about{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
   不设间距就会挤成「场景· 3.2 KB」。
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
/* 新增提示词弹窗定高（用户 2026-09-30）：切「全局 / 快捷」时「从现有预设复制」那一行会出现/
   消失，让整颗框跟着长缩。高的一屏为准，多出来的高度给正文文本框吃掉；窗口太矮时弹窗自己滚。 */
.dsm-modal-fixed{height:min(760px,calc(100vh - 48px));max-height:none}
.dsm-modal-fixed .dsm-field-grow{min-height:0;flex:1}
.dsm-modal-fixed .dsm-field-grow textarea{flex:1}
/* 导出弹窗（D14）：宽高都固定；只有「条目列表」这一层滚动，动作条常驻底部。 */
.dsm-export-modal .dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:14px;overflow:hidden}
.dsm-export-modal .dsm-export-form{display:flex;min-height:0;flex:1;flex-direction:column;gap:10px}
.dsm-export-modal .dsm-pick-list{flex:1;min-height:0;max-height:none;overflow:auto}
.dsm-export-modal .dsm-export-body{display:flex;min-height:0;flex:1;flex-direction:column;gap:6px}
/* 会话导出弹窗（0.18.5）：字段压成三行之后，560×640 里会话列表只剩几行（用户反馈）。
   处方照 .dsm-modal-archive / .dsm-modal-fixed：固定高、只有列表内滚。宽度取 720 —— 与
   .dsm-modal-lg / .dsm-modal-wide 同一档，两列字段各约 340px 刚好放得下（880 试过，标题行
   右边空成一片，用户说太宽）。高度取 760 而不是视口百分比 —— 760 既是 .dsm-modal 自己的
   max-height 也是 .dsm-modal-fixed 那个数，窗口矮时 calc(100vh - 48px) 照常接管。
   写成两段类名（.dsm-modal.dsm-modal-export-lg）是为了**不靠书写顺序**压过 .dsm-modal-list
   的 !important（.dsm-modal-lg 排在 .dsm-modal-list 前面，直接借用会被它盖掉）。只加在这一颗
   弹窗上：.dsm-modal-list 还被四个页面的导出弹窗和回收站共用，动它就是它们一起变大。 */
.dsm-modal.dsm-modal-export-lg{width:min(720px,100%)!important;height:min(760px,calc(100vh - 48px))!important;max-height:none!important}
.dsm-pick-group{display:flex;flex-direction:column}
.dsm-pick-group-head{box-sizing:border-box;display:flex;width:100%;min-width:0;align-items:center;gap:7px;padding:7px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;text-align:left;cursor:pointer}
.dsm-pick-group-head:hover{color:var(--dsw-alias-label-primary)}
.dsm-pick-caret{flex:0 0 auto;width:12px;color:var(--dsw-alias-label-tertiary)}
.dsm-pick-group-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-group-count{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-weight:500}
.dsm-pick-group .dsm-pick{margin-left:16px}
.dsm-pick-group .dsm-pick+.dsm-pick{margin-top:2px}

/* 回收站比其它列表弹窗高一档（用户 2026-10-10：「回收站高度加长」）：640 → 760。
   .dsm-modal-list 那个 640 是给「导出会话」那类"看一眼就走"的列表定的；回收站是"翻找 + 勾选 +
   批量删"，本机实测提示词回收站 35 条、技能 7 条 —— 640 时一屏只看得见 8 条。
   760 不是新拍的数：它既是 .dsm-modal 自己的 max-height，也是 .dsm-modal-fixed（新增提示词）
   那个数，本插件"最高的普通弹窗"一直就是它。上一版试过 880，用户 2026-10-10 反馈
   「回收站高度不要超过下面一层的高度」—— 回收站是叠在宿主的设置弹窗上弹出来的，宿主那颗比
   880 矮，880 会从它上面探出去；760 稳稳落在它里面。
   视口那一项取 100vh - 112px 而不是 -48px：宿主设置弹窗自己就留了上下各约 48px 的边，
   窗口矮的时候跟着它一起缩，才不会又探出去。
   分栏那两块是「1fr 1fr」吃掉剩余高度，所以弹窗一长高，「目录」和「技能」两块跟着一起长
   （用户同一条要求：「技能的回收站内部的目录和技能也能加高」）。
   写成两段类名（.dsm-modal.dsm-modal-trash）是为了**不靠书写顺序**压过 .dsm-modal-list 的
   !important（与 .dsm-modal-export-lg 同一手法）。加在回收站那几颗弹窗上 —— 共享 TrashModal
   （提示词 / 场景 / 子智能体 / MCP）与技能页自己那颗：.dsm-modal-list 还被四个页面的导出弹窗
   共用，动它就是它们一起变大。 */
.dsm-modal.dsm-modal-trash{height:min(760px,calc(100vh - 112px))!important;max-height:none!important}

/* 回收站分栏：上下两块各占一半（技能页是 目录 / 技能，提示词页是 提示词预设 / 快捷提示词），
   滚动条在每块列表区里面，大弹窗自己不滚。
   必须放在最后：盖过上面的 .dsm-modal-list .dsm-modal-body>*{flex:none}，
   否则外层不撑满、两块就各按内容长，50/50 失效。宽度沿用 .dsm-modal-list 的 560px。 */
.dsm-modal-trash-split .dsm-modal-body{overflow:hidden}
.dsm-modal-trash-split .dsm-trash-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:12px}
.dsm-modal-trash-split .dsm-trash-group{margin-bottom:0;min-height:0}
.dsm-modal-trash-split .dsm-trash-pane-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 13px}

/* 访问令牌（兼容页）：状态胶囊 + 一句实况 + 主行动区 + 折叠管理区。胶囊用 .dsm-pill 的
   既有语义色（绿=就绪、告警=要注意、灰=没配），不新增颜色。 */
.dsm-token-block{display:flex;flex-direction:column;gap:9px}
/* 提示行右侧挂按钮（令牌没过的提醒）：文案占满剩余宽度，按钮不换行、不压缩。 */
.dsm-feedback-row{display:flex;align-items:center;gap:10px}
.dsm-feedback-row .dsm-feedback-text{flex:1;min-width:0}
.dsm-feedback-row .dsm-btn{flex:none}
/* 弹窗正文里的说明段：.dsm-desc 是**页面描述**用的（2 行裁剪，见文件头部），照搬进弹窗会
   把说明截断（「清理旧备份」此前就被截到「而它们常常挤…」）。这里只声明"不裁剪"。 */
.dsm-desc-plain{display:block;margin:0;overflow:visible;-webkit-line-clamp:none;font-size:12px;line-height:19px}
/* 分段选择器的选中态（备份保留份数）：四个按钮都是 .dsm-btn-quiet（深灰字、透明底），
   选中与否只差一点文字色，几乎看不出来；用既有语义色（绿=已选）表达，
   与 .dsm-pill-ok / .dsm-tab-active 同色。 */
.dsm-btn-picked{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
/* 令牌未验证时的页面级横幅（见 40-apply-head.js 的 syncTokenBanner）。
   它是**唯一**能说清"为什么发不出消息"的东西：宿主侧拒绝那一轮（agent/pre-step → reject）
   在界面上没有任何呈现，而且会丢掉那条消息。位置固定在顶部居中、pointer-events:none ——
   它只负责说明，不该挡住任何可点的东西。
   层级 999：高于普通页面内容，低于插件自己的弹窗（.dsm-mask 1100）与宿主的设置窗口 ——
   之前 2147483000 会把宿主设置窗口的标题区都盖住（用户实测）；锁态的解释在设置窗口里
   由兼容页与面板内提示兜底，横幅还带关闭键（见下），挡路时可手动关掉。 */
.dsm-token-banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999;display:flex;align-items:flex-start;gap:10px;max-width:min(620px,92vw);padding:9px 13px;border:1px solid var(--dsm-warn);border-radius:10px;background:var(--dsm-warn-bg);color:var(--dsm-warn);font-size:12.5px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none;backdrop-filter:blur(6px)}
.dsm-token-banner-text{flex:1;min-width:0}
/* 关闭键：横幅整体 pointer-events:none，唯独它可点。关掉后本次锁态期间不再出现
   （解锁后再锁会重置，见 syncTokenBanner）。 */
.dsm-token-banner-close{pointer-events:auto;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:20px;cursor:pointer;opacity:.7}
.dsm-token-banner-close:hover{opacity:1}

/* 全局轻提示（斜杠命令的执行反馈）。位置在右下角：对话页的输入框居底居中，顶部那条又是
   令牌横幅，两处都会被挡。z-index 比横幅低一档 —— 令牌没过时那句解释比"改成功了"更要紧。 */
.dsm-toast{position:fixed;right:18px;bottom:18px;z-index:998;max-width:min(420px,80vw);padding:9px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-text-primary);font-size:12.5px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none;backdrop-filter:blur(6px)}
.dsm-toast-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-toast-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-toast-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}

/* MCP JSON 导入预览（0.15.0 A1）：勾选 | 主体 | 状态三列。非法行只把「问题」那一行标红，
   名字净化 / 字段忽略这类是配置事实，走中性灰 —— 黄色在这里留给不了任何东西（琥珀语义）。 */
.dsm-imp-head,.dsm-imp-row{display:grid;grid-template-columns:15px minmax(0,1fr) auto;align-items:start;gap:10px}
.dsm-imp-head{padding:0 2px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-imp-list{display:flex;flex-direction:column;gap:6px;max-height:320px;padding:1px 2px 0 0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-imp-row{padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.dsm-imp-row.dsm-imp-bad{border-color:var(--dsw-alias-state-error-primary)}
.dsm-imp-row input[type=checkbox]{width:14px;height:14px;margin:2px 0 0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-imp-row input[type=checkbox]:disabled{cursor:not-allowed}
.dsm-imp-main{display:flex;min-width:0;flex-direction:column;gap:3px}
.dsm-imp-name{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dsm-imp-endpoint{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all}
.dsm-imp-sub,.dsm-imp-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsm-imp-err{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dsm-imp-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.dsm-imp-foot{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.dsm-imp-radio{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dsm-imp-radio input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-imp-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}

/* 体检状态点（0.15.0 B1）与行内检查项。点只有 8px，靠 title 说清含义；
   检查结果单独一行一行列在行尾，不复用 .dsm-row-hint（那一套固定带 ⚠ 前缀、且语义是"运行状态"）。 */
.dsm-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:99px;background:var(--dsw-alias-border-l3)}
.dsm-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dsm-dot-warn{background:var(--dsm-warn)}
.dsm-dot-busy{background:var(--dsw-alias-label-tertiary);animation:dsm-dot-pulse 1s ease-in-out infinite}
@keyframes dsm-dot-pulse{0%,100%{opacity:.25}50%{opacity:1}}
.dsm-inspect{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.dsm-inspect-line{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dsm-inspect-warn{color:var(--dsm-warn)}
.dsm-inspect-ok{color:var(--dsw-alias-state-success-primary)}

/* 「最近改动」流水（0.15.0 B2）：时间列固定窄栏，改动列吃剩余宽度，来源徽章贴在行尾。 */
.dsm-audit{display:flex;flex-direction:column;gap:6px}
.dsm-audit-bar{display:flex;align-items:center;gap:8px}
.dsm-audit-filter{flex:none;width:auto;min-width:130px;font-size:12px}
.dsm-audit-list{display:flex;flex-direction:column;max-height:300px;overflow:auto;padding-right:2px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-audit-head{grid-template-columns:92px minmax(0,1fr)}
.dsm-audit-row{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:baseline;gap:10px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsm-audit-row:last-child{border-bottom:0}
.dsm-audit-time{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;white-space:nowrap}
.dsm-audit-main{display:flex;align-items:baseline;flex-wrap:wrap;gap:3px 8px;min-width:0}
.dsm-audit-item{color:var(--dsw-alias-label-secondary)}
.dsm-audit-target{color:var(--dsw-alias-label-primary);font-weight:580}
.dsm-audit-more{color:var(--dsw-alias-label-tertiary);font-size:11px}

/* 整机迁移（0.15.0 C2）：路径 + 动作按钮同一行，勾选清单横向铺开（一域一个标签）。 */
.dsm-snap{display:flex;flex-direction:column;gap:8px}
.dsm-snap-row{display:flex;gap:8px}
.dsm-snap-row .dsm-control{flex:1;min-width:0}
.dsm-snap-picks,.dsm-kind-picks{display:flex;flex-wrap:wrap;gap:6px 14px}
.dsm-snap-pick,.dsm-kind-pick{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dsm-snap-pick input,.dsm-kind-pick input{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-snap-preview{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
/* 兼容页三块弹窗：**开合不改尺寸**（列表长短、预览有没有读回来都不该让框跳）。
   「最近改动」（唯一 fixed 弹窗）的滚动层**只给列表**：正文是纯 flex 容器不滚动，
   提示语、筛选栏（选择框 / 按钮）固定不动，列表吃剩余高度自己滚，表头在列表内
   sticky 钉顶 —— 此前是整个正文滚 + sticky 钉筛选栏，提示语会跟着滚出视野
   （2026-09-28 用户反馈）。表单类与条数固定的弹窗仍是正文自适应、无此规则。 */
.dsm-compat-dialog{height:min(620px,calc(100vh - 64px));max-height:none;overflow:hidden}
.dsm-compat-dialog .dsm-modal-body{min-height:0;flex:1;overflow:hidden}
.dsm-compat-dialog .dsm-audit{flex:1;min-height:0}
.dsm-compat-dialog .dsm-audit-list{max-height:none;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.dsm-compat-dialog .dsm-audit-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2)}
.dsm-snap-browse{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsm-snap-browse .dsm-dir-list{max-height:170px}
.dsm-snap-browse-foot{display:flex;align-items:center;gap:8px}
.dsm-snap-browse-foot .dsm-help{min-width:0;flex:1;overflow-wrap:anywhere}

/* 回收站保留期 + 批量删除（0.19.1）。
   工具栏排在条目上方（Modal 的 body 在滚动，工具条跟着滚走的话，条目一多就够不着
   那一颗「永久删除 (N)」—— 而那正是条目多的时候才需要的按钮）。
   保留期与批量条**同一行**（用户 2026-10-10：「这应该是同一行，现在两行浪费空间」）：
   工具栏是行向 flex，保留期那一组不参与收缩，批量条那一组吃掉剩余宽度并把两颗按钮顶到最右。
   真放不下时**整组折到下一行** —— 比把「已选 N 项」或说明挤成省略号好：那等于把信息删掉。 */
.dsm-trash-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsm-trash-toolbar .dsm-trash-retention{flex:0 0 auto}
.dsm-trash-toolbar .dsm-trash-bulk{flex:1 1 auto;min-width:0;flex-wrap:nowrap}
/* 「已选 N 项」既要撑开（把两颗按钮顶到最右）又不能被压缩：flex:1 0 auto 正是这个意思。 */
.dsm-trash-toolbar .dsm-trash-bulk .dsm-note{flex:1 0 auto}
.dsm-trash-toolbar .dsm-trash-bulk>button{flex:0 0 auto}
/* 二次确认恒占整行：它是一句问句 + 两颗键，挤在保留期旁边既难看也读不清。 */
.dsm-trash-toolbar .dsm-trash-bulk-confirm{flex:1 1 100%;flex-wrap:wrap}
.dsm-trash-retention{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.dsm-trash-retention .dsm-label{flex:none;font-weight:580}
/* .dsm-control 是 width:100% 的表单控件；塞进这一行要退回内容宽度，否则它会把整行撑满、
   把右边的说明挤到下一行。（这段样式整体在模板字符串里，注释里不能出现反引号。） */
.dsm-trash-retention .dsm-control{width:auto;min-width:112px;flex:none}
/* 保留期这一行**恒为一行**（用户 2026-10-10：「保留期一行就够了」）。
   所以说明必须短（trash.retention.hint = 「超期自动删除」），全文走 title 悬停；
   nowrap + 省略号只是兜底：万一窄到放不下，宁可截掉尾部也不折行把下拉框顶上去。 */
.dsm-trash-hint{min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 出错时反过来：允许换行、不截断 —— 失败原因截成半句等于没说。 */
.dsm-trash-retention-err{flex:1 1 auto;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary)}
.dsm-trash-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* 「已选 N 项」占满左侧剩余空间 → 把「全选」与唯一的「永久删除」一起顶到最右。 */
.dsm-trash-bulk .dsm-note{min-width:0;flex:1}
.dsm-trash-bulk-confirm{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}
.dsm-trash-bulk-confirm .dsm-note{font-weight:570;color:var(--dsw-alias-state-error-primary);white-space:normal}
/* 技能回收站：两个 pane **各有一套**「全选 + 永久删除」（用户 2026-10-10：「全选要拆成两部分」）。
   上面删的是一条记账、下面删的是真文件，合成一颗键就成了「勾了两条、不知道该删哪个」。
   批量条挂在 pane 里、在列表区之上，不跟着列表滚（列表滚走了也要够得着）。 */
.dsm-trash-pane-batch{flex:none;padding:7px 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsm-trash-notice{flex:none}
.dsm-trash-pick{display:inline-flex;flex:none;align-items:center;padding:4px 1px;cursor:pointer}
.dsm-trash-pick input{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-error-primary)}
.dsm-trash-pick input:disabled{cursor:default}
/* 勾选过的那条给一层底色：勾了十几条之后要一眼看出勾的是哪几条。 */
.dsm-trash-item-picked{background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}

`