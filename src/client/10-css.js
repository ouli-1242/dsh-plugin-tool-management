    const CSS =
      ':root{--dsm-warn:#d49245;--dsm-warn-bg:rgba(212,146,69,.12);--dsm-radius-s:4px;--dsm-radius-m:8px;--dsm-radius-l:12px}' +
      '.dsm-stat-row{display:flex;min-width:0;align-items:center;gap:8px}' +
      '.dsm-version{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;letter-spacing:.3px;line-height:1}' +
      '.dsm-row-hint{grid-column:1/-1;margin:-4px 0 8px;color:var(--dsm-warn);font-size:12px;line-height:16px}' +
      '.dsm-tools{display:flex;flex-direction:column;gap:8px}' +
      '.dsm-tool{padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}' +
      '.dsm-tool-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;font-weight:400;word-break:break-all}' +
      '.dsm-tool-name-row{display:flex;align-items:center;gap:8px}' +
      // 标签紧跟工具名（原来是 space-between，标签被推到中间、与名字隔着一大片空白）；
      // 开关单独用 margin-left:auto 顶到最右，标签不再受它的位置影响。
      '.dsm-tool-name-row .dsm-switch{margin-left:auto;flex:none}' +
      '.dsm-tool-off .dsm-tool-name,.dsm-tool-off .dsm-tool-desc{opacity:.45}' +
      '.dsm-tool-desc{min-width:0;flex:1;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}' +
      '.dsm-tool-params{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}' +
      '.dsm-tool-param{display:flex;gap:8px;font-size:12px;align-items:baseline}' +
      '.dsm-tool-param-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:400;min-width:80px;word-break:break-all}' +
      '.dsm-tool-param-type{color:var(--dsw-alias-label-tertiary);min-width:56px}' +
      '.dsm-tool-param-desc{flex:1;color:var(--dsw-alias-label-secondary);word-break:break-all}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-sm{min-height:88px}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-md{min-height:200px}' +
      '.dsm-modal textarea.dsm-control.dsm-textarea-lg{min-height:300px}' +
      /* 新建/编辑人设弹窗（dsm-modal-compact，2026-10-10）：两块 textarea-md 的 200px 下限把
         「保存」挤出 760 顶格的一屏（内容约 810px）。压到 150 —— 下限只决定初始高度，框照常
         能拖高；权重 4 类 + 1 元素，压过上面那条 200px，不靠 !important。 */
      '.dsm-modal.dsm-modal-compact textarea.dsm-control.dsm-textarea-md{min-height:150px}' +
      '.dsm-detail-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      /* 标题行右侧的动作组：两个及以上按钮必须包一层 —— space-between 直接摊三个子元素时，
         中间那个会被顶到整行正中（用户 2026-10-15：「重启怎么在中间」）。标题在左、动作组
         在右，组内间距 8px 与行间隙一致。 */
      '.dsm-detail-title-acts{display:flex;align-items:center;gap:8px}' +
      `
.dsm-pick-list{display:flex;max-height:240px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);padding:4px}.dsm-tab{padding:8px 14px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.dsm-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-success-primary)}.dsm-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:4px 0 24px;container-type:inline-size;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-family:inherit}.dsm-head{display:flex;flex-direction:column;align-items:stretch;gap:16px}.dsm-feedback-links{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.dsm-title{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-.2px;white-space:nowrap}.dsm-feedback-link{display:inline-flex;min-height:30px;align-items:center;gap:4px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:400;line-height:18px;text-decoration:none;white-space:nowrap}.dsm-feedback-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsm-feedback-link:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-feedback-link svg{flex:none}.dsm-desc{margin:12px 0 0;display:-webkit-box;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px;-webkit-box-orient:vertical;-webkit-line-clamp:2}.dsm-actions{display:flex;flex-wrap:wrap;gap:8px;margin-left:0;flex:none}
/* 页头动作行：内边距收 2px。批量按钮要按「取消全选」定宽（见 .dsm-btn-bulk），
   收这一点正好把定宽多出来的宽度抵掉，整行仍在一行内。 */
.dsm-actions .dsm-btn{padding:0 12px}
/* 页头动作行里的 quiet 键**与同排的 secondary 同档**（30px / 13px / 600）。
   quiet 自带 24px / 12px / 400（§6「弱化视觉权重」），可它的**颜色**与 secondary 逐条相同
   （同边框色、同透明底、同字色），所以在这一排里"弱化"从来没生效过 —— 唯一的差别只剩字号
   与字重，摆在一起就是两套字：MCP 页的「全部检查 / 整理补丁 / 全部启用」、兼容页的
   「最近改动 / 整机迁移 / 注入实况 / 清理旧备份」都比紧挨着的「导入 / 导出」小一号细一档
   （用户 2026-10-12：「和其他字体样式不统一」）。
   ⚠️ 这条必须写在下面那条 @container 之前：窄栏（≤600px）要整排一起降到 12px，
   同权重（两个类名）靠书写顺序取胜，写在后面会把那一档挡掉。 */
.dsm-actions .dsm-btn-quiet{min-height:30px;font-size:13px;font-weight:600}
/* 窄栏再收一档（容器 ≤600px）：技能页 7 颗按钮最挤，上一档（11px 内边距 + 13px 字号）整行要
   ~560px，窄栏装不下时最后一颗「全选」会被挤到第二行（用户 2026-09-18 截图实测）。
   这一档同时收内边距、间距并降一档字号（12px，与 .dsm-btn-quiet 同档）→ 整行降到 ~486px。
   宽栏不受影响。阈值取 600 而不是贴着 560：不同机器的字体度量略有出入，交界处两档都装得下，
   不会正好卡在边界上换行；再窄（< ~486px）仍按原来的方式折行，行内按钮由下面 ≤520px
   那一档均分整行。 */
@container(max-width:600px){.dsm-actions{gap:4px}.dsm-actions .dsm-btn{padding:0 8px;font-size:12px}}
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
.dsm-btn.dsm-btn-icon{width:24px;min-width:24px;min-height:24px;padding:0}
/* 目录卡片右侧动作组：间距收窄一档，配合图标化后不再显挤。 */
/* 卡片头里的标签抬到 11px：左侧「N 个技能」是 12px，10px 的标签在这里显得忽大忽小。 */
.dsm-source-head .dsm-tag{font-size:12px;min-height:20px;padding:0 8px}
/* 「N 个附件」标签：和 tag 同形，但它是**能点的**（点了去编辑弹窗的附件区），
   所以要把 button 的默认外观抹掉，并给一个可点的悬停反馈 —— 光靠颜色区分不出"能不能点"。 */
button.dsm-tag{background:transparent;font:inherit;font-size:12px;cursor:pointer}
button.dsm-tag:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
button.dsm-tag:disabled{cursor:default;opacity:.6}
.dsm-tag-attach{display:inline-flex;align-items:center;gap:4px}
.dsm-tag-attach-empty{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l3)}
/* 名称旁的体积标签（记忆行，2026-10-12）：形态直接借 .dsm-tag（边框 + 圆角 + 12px），
   只补等宽数字 —— 否则同一列里 145 B / 1.2 KB / 980 B 的宽度会随字宽跳动，
   整列名称的右缘跟着抖。它是纯量值、不可点，所以用 span 而不是 button。 */
.dsm-tag-size{font-variant-numeric:tabular-nums}
/* 按钮的"档位"里包含尺寸，别把它当纯修饰色（REDESIGN §5，2026-10-11 切片五定稿）：
   .dsm-btn 实心 30px（本屏主操作）/ .dsm-btn-secondary 描边 30px（常规动作）/
   .dsm-btn-quiet 描边 24px（次要动作；叠 -danger 即 quiet-danger）。
   quiet 原先无边框（靠字色弱化）：列表行与页头里认不出哪些是可点的（用户 2026-10-12），
   现在与 secondary 同一条 l2 描边，弱化只靠尺寸与字重 —— 字色试过降到 tertiary，用户
   2026-10-12 否掉：可点的按钮不该看着像说明文字。分段组内的按钮另有
   .dsm-form-seg button 把描边按回 0（那一组靠底色表达选中）。
   .dsm-btn-danger 裸写 = 确认弹窗的主操作（§6.1：全站唯一红色实底）；叠 quiet =
   列表行的 quiet-danger（透明底 + error 字色 + **error 描边**）。-lock = quiet 的告警色态（特例登记 §9）。
   两条 2026-10-12 定下的口径：
   · 红底那颗**深浅两套都用白字**（写死 #fff）。先前跟着主题走（深色=白、浅色=黑），
     浅色主题里黑字压在红底上认不出（用户原话「无论是浅色还是深色统一字体为白色」）。
     也别用 label-primary-foreground —— 那是"浅底深字"的反色对，深色主题里它是近黑。
   · 透明底那颗的描边走 error 色，不跟其他 quiet 按钮的 l2：删除键要和同一行的
     「编辑 / 详情」在**边框层面**就分得开，只靠字色不够（用户 2026-10-12「这种删除键应该是红色边框」）。
   铁律：**同一行 / 同一组按钮必须同高** —— 行里有实心或常规动作就整行 30px（弹窗脚、
   页头动作条），整行都是行内小动作才整行 24px（列表行、回收站行、分段组）。
   （CSS 注释里别写反引号：这段整体在 JS 模板字符串里，反引号会把字符串截断。） */
.dsm-btn{box-sizing:border-box;display:inline-flex;min-height:30px;align-items:center;justify-content:center;padding:0 12px;border:1px solid transparent;border-radius:var(--dsm-radius-m);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer}.dsm-btn:hover:not(:disabled){opacity:.9}.dsm-btn:disabled{opacity:.48;cursor:default}.dsm-btn-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.dsm-btn-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);min-height:24px;padding:0 8px;font-size:12px;font-weight:400}.dsm-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}.dsm-btn-lock{background:transparent;color:var(--dsm-warn)}.dsm-btn:focus-visible,.dsm-select-trigger:focus-visible,.dsm-source-head:focus-visible,.dsm-switch:focus-visible,.dsm-file-remove:focus-visible,.dsm-dropzone:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
/* 列表工具条的一行：搜索占满剩余、筛选下拉定宽靠右。
   下拉宽度 210 → 150（用户 2026-10-12：「全部级别缩短，当前太长了，多的内容交给输入框」；
   技能「全部来源」、记忆「全部场景」、会话保留期同一条口径）。触发器内的文本本来就带
   省略号（.dsm-select-trigger > span），收窄只会截长短选项名，不会把行撑破；
   省下的 60px 全部归搜索框（它 flex:1）。 */
.dsm-filters{display:flex;gap:8px}.dsm-search{flex:1}.dsm-source-filter{width:150px;flex:none}
.dsm-control,.dsm-select-trigger{box-sizing:border-box;width:100%;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm-control::placeholder{color:var(--dsw-alias-label-tertiary)}textarea.dsm-control{min-height:160px;padding-top:8px;resize:vertical;line-height:20px}.dsm-select{position:relative}.dsm-select-trigger{display:flex;align-items:center;justify-content:space-between;text-align:left;cursor:pointer}.dsm-select-menu{z-index:40;display:flex;max-height:260px;padding:4px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2)}.dsm-option{padding:8px;border:0;border-radius:var(--dsm-radius-s);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}.dsm-option:hover,.dsm-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-sources{display:flex;flex-direction:column;gap:8px}.dsm-source{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}.dsm-source-head{box-sizing:border-box;display:flex;width:100%;min-height:48px;align-items:center;padding:0 12px}.dsm-source-head-main{display:flex;min-width:0;min-height:48px;flex:1;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsm-source-head:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-source-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsm-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;flex:none}.dsm-path{min-width:0;margin-left:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm-source-actions{display:flex;align-items:center;gap:4px;margin-left:8px}.dsm-source-body{border-top:1px solid var(--dsw-alias-border-l1)}.dsm-source-note{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
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
.dsm-note{overflow:hidden;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}.dsm-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.dsm-tag{display:inline-flex;min-height:20px;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsm-tag-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.dsm-tag-off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.dsm-tag-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-switch{position:relative;width:32px;height:18px;flex:none;padding:0;border:0;border-radius:99px;background:var(--dsw-alias-border-l3);cursor:pointer}.dsm-switch:after{position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;content:"";transition:transform 160ms ease}.dsm-switch-on{background:var(--dsw-alias-state-success-primary)}.dsm-switch-on:after{transform:translateX(14px)}.dsm-switch:disabled{opacity:.45;cursor:default}.dsm-trash-count{margin-left:auto;padding:4px 8px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}.dsm-empty{padding:24px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsm-feedback{padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);color:var(--dsw-alias-label-secondary);font-size:12px}.dsm-undo{display:flex;align-items:center;gap:8px}.dsm-undo-text{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsm-undo-close{padding:0;border:0;background:transparent;font:inherit;font-size:13px;cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary)}.dsm-undo-close:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}.dsm-undo.dsm-warning{background:var(--dsm-warn-bg)}.dsm-undo.dsm-warning .dsm-undo-text{font-weight:400}.dsm-undo.dsm-warning .dsm-undo-close{color:var(--dsm-warn)}.dsm-warning{border-color:var(--dsm-warn);color:var(--dsm-warn)}.dsm-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.dsm-modal{box-sizing:border-box;display:flex;width:min(560px,100%)!important;max-height:min(760px,calc(100vh - 48px));min-width:0;flex-direction:column;gap:16px;padding:20px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-l);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.dsm-modal-sm{width:min(480px,100%)!important}.dsm-modal-lg,.dsm-modal-wide{width:min(720px,100%)!important}.dsm-modal-list{width:min(560px,100%)!important;height:min(640px,calc(100vh - 48px))!important;max-height:none!important;overflow:hidden}.dsm-modal-list.dsm-modal-editor{width:min(720px,100%)!important}.dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:8px}.dsm-modal-list .dsm-modal-body{flex:1;overflow:auto;overscroll-behavior:contain}.dsm-modal-head{display:flex;align-items:flex-start;gap:12px}
/* 头部这一层包住「标题行 + 令牌提示」：提示挂在头部里面（而不是 head 与 body 之间）是为了
   让 body 的子节点位置稳定 —— 位置一变 React 会把 body 整棵重挂（输入框失焦、下拉归零）。 */
.dsm-modal-head-wrap{display:flex;flex-direction:column;gap:12px}.dsm-modal-title{margin:0;flex:1;font-size:15px;line-height:24px;font-weight:600}.dsm-form,.dsm-field,.dsm-detail-section{display:flex;flex-direction:column}.dsm-form{gap:12px}.dsm-field{gap:6px}.dsm-label,.dsm-detail-title{font-size:12px}.dsm-label{color:var(--dsw-alias-label-secondary)}.dsm-detail-title{font-weight:400}.dsm-help{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dsm-help-list{display:flex;margin:0;padding-left:16px;flex-direction:column;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}.dsm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
/* 两动作性质不同的弹窗底部（目前只有「进入场景」的预览卡）：左边「不再显示」、右边「确认进入」。
   都靠右排会读成"两选一"，而它们不是同一层意思（一个是不想被拦，一个是要这么做）。 */
.dsm-modal-actions-split{justify-content:space-between}.dsm-hidden-input{display:none}.dsm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color 180ms ease,background 180ms ease;cursor:pointer;font:inherit;text-align:center}.dsm-dropzone:hover,.dsm-dropzone-active{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsm-dropzone-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}.dsm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dsm-upload-choices{display:flex;align-items:center;gap:8px}.dsm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsm-upload-divider{color:var(--dsw-alias-label-tertiary);font-size:12px}.dsm-file{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}.dsm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:var(--dsm-radius-s);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}.dsm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dsm-file-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.dsm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary);font-size:13px}.dsm-upload-requirements{padding:4px 4px 0;font-size:12px;line-height:17px}
/* 条目清单必须自己声明字号：裸 ul/li 会从宿主那里继承 16px 近白正文（兼容页「工具能用 ≠
   模型知道」三条），比同页的说明文字大两号。口径照 .dsm-help-list。 */
.dsm-upload-requirements ul{display:flex;margin:4px 0 0;padding-left:16px;flex-direction:column;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsm-upload-req{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}.dsm-detail-section{gap:8px}.dsm-detail-path,.dsm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-detail-path{padding:8px 8px;border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);word-break:break-all}
/* 技能详情的「路径 + 编辑器查看」同一行（用户 2026-10-12）：路径条 flex:1 吃掉剩余宽度，
   按钮 flex:none 固定不动。按钮那颗 .dsm-btn 自带 white-space:nowrap，长路径自己折行。 */
.dsm-detail-path-row{display:flex;min-width:0;align-items:center;gap:8px}
.dsm-detail-path-row>.dsm-detail-path{flex:1;min-width:0}
.dsm-detail-path-row>.dsm-btn{flex:none}.dsm-code{max-height:280px;margin:0;padding:12px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:pre-wrap}.dsm-diag{padding:8px 8px;border-left:2px solid var(--dsm-warn);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-modal-title-row{display:inline-flex;align-items:center;gap:8px;min-width:0}
.dsm-pill{display:inline-flex;min-height:20px;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:99px;font-size:12px;font-weight:400;white-space:nowrap}
.dsm-pill-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-pill-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
/* 「启动中」的胶囊此前**没有对应配色**（只有 ok / warn / muted 三档），详情页标题那颗
   「加载中」于是落在 .dsm-pill 的无色默认上 —— 与"没在跑"看着一样。与状态点同一支绿，
   压一点亮度表示还没到位。 */
.dsm-pill-busy{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);opacity:.78}
.dsm-pill-muted{color:var(--dsw-alias-label-tertiary)}
.dsm-tool-desc-wrap{display:flex;align-items:flex-end;gap:8px}
.dsm-tool-desc-clamp{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dsm-tool-desc-toggle{flex:none;margin-left:auto;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsm-tool-desc-toggle:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
/* （旧的 .dsm-trash-group / .dsm-trash-item / .dsm-trash-box 一族已随回收站双栏改版删除；
   行选择列表的样式在文件尾段，见「弹窗层（REDESIGN §4）」一节。） */

/* 滚动条：宿主默认是「悬停才出现」的浮层滚动条 —— 固定高度的列表弹窗里，用户看不出
   还能往下滚，等于下面的条目不存在。插件给自己的滚动容器画一条**常驻**细滚动条
   （颜色走宿主变量，深浅主题都成立；不碰宿主其它地方的滚动条）。 */
.dsm-modal-list .dsm-modal-body,.dsm-pick-list,.dsm-seg-body,.dsm-dir-list{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar,.dsm-pick-list::-webkit-scrollbar,.dsm-seg-body::-webkit-scrollbar,.dsm-dir-list::-webkit-scrollbar{display:block;width:9px;height:9px}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-track,.dsm-pick-list::-webkit-scrollbar-track,.dsm-seg-body::-webkit-scrollbar-track,.dsm-dir-list::-webkit-scrollbar-track{background:var(--dsw-alias-bg-layer-1)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-thumb,.dsm-pick-list::-webkit-scrollbar-thumb,.dsm-seg-body::-webkit-scrollbar-thumb,.dsm-dir-list::-webkit-scrollbar-thumb{border-radius:99px;background:var(--dsw-alias-border-l2)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-thumb:hover,.dsm-pick-list::-webkit-scrollbar-thumb:hover,.dsm-seg-body::-webkit-scrollbar-thumb:hover,.dsm-dir-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}
.dsm-modal-list .dsm-modal-body::-webkit-scrollbar-corner,.dsm-pick-list::-webkit-scrollbar-corner,.dsm-seg-body::-webkit-scrollbar-corner,.dsm-dir-list::-webkit-scrollbar-corner{background:transparent}

/* 列表弹窗的 body 是纵向 flex：直接子项一旦被 flex 收缩，而子项自己又是 overflow:hidden
   （.dsm-trash-group 正是），超出的条目会被**直接裁掉** —— 看不见、也滚不到，表现就是
   「没有滚动条 + 内容缺一截」。列表项的尺寸一律由内容决定，滚动只交给 body 这一层。 */
.dsm-modal-list .dsm-modal-body>*{flex:none}
.dsm-fm{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}.dsm-fm-row{display:grid;grid-template-columns:minmax(96px,150px) minmax(0,1fr);gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}.dsm-fm-row:last-child{border-bottom:0}.dsm-fm-key{color:var(--dsw-alias-label-secondary);word-break:break-word}.dsm-fm-raw{margin-left:4px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.dsm-fm-val{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap}
@container(max-width:780px){
.dsm-path{display:none}
}@container(max-width:520px){.dsm-head{flex-direction:column}.dsm-actions{width:100%;margin-left:0}.dsm-actions .dsm-btn{flex:1}.dsm-filters{flex-direction:column}.dsm-source-filter{width:100%}}
.dsm-hist-group-head{gap:8px}.dsm-hist-group-extra{display:flex;align-items:center;gap:8px;flex:none;margin-left:4px}.dsm-hist-group-extra .dsm-tag{flex:none}.dsm-hist-dir-missing{flex:none;padding:1px 6px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsm-radius-s);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;white-space:nowrap;cursor:default;user-select:none}.dsm-hist-register-path{margin-top:-4px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,monospace);font-size:11px;word-break:break-all}/* （.dsm-hist-batch / .dsm-hist-batch-actions 已随批量动作移进列表工具条删除；
   .dsm-hist-batch-count 仍用于导出弹窗里的「已选 N 项」计数。） */
.dsm-hist-batch-count{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}.dsm-dir-row{display:flex;gap:8px}.dsm-dir-row .dsm-control{flex:1}.dsm-dir-list{display:flex;max-height:220px;flex-direction:column;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}.dsm-dir-item{display:flex;width:100%;align-items:center;padding:8px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.dsm-dir-item:last-child{border-bottom:0}.dsm-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm-dir-item::before{content:"📁";margin-right:8px;font-size:12px}
.dsm-rule-shadowed .dsm-note{color:var(--dsw-alias-state-error-primary)}.dsm-rule-off .dsm-note{color:var(--dsw-alias-label-tertiary)}.dsm-rule-shadow-hint{margin-top:4px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px}.dsm-rule-invalid{border-color:var(--dsw-alias-state-error-primary)!important}.dsm-rule-hint{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px}/* （.dsm-rule-budget 与 .dsm-budget-bar / -fill / -over-text 都已随记忆页预算条的两次搬家
   删除：2026-10-11 并进列表工具条、2026-10-12 再搬进页头统计格 —— 统计格只报字节数 +
   超限转色，不再画进度条。保留 .dsm-budget-meta，它服务的是各表单的「标签 + 字数计数」行。） */.dsm-budget-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.dsm-budget-meta strong{margin-right:0;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}.dsm-char-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}.dsm-char-over{color:var(--dsw-alias-state-error-primary)}.dsm-field-row{display:flex;gap:12px;align-items:flex-start}.dsm-field-row>.dsm-field{flex:1;min-width:0}
.dsm-combo-row{display:flex;gap:8px}.dsm-combo-row .dsm-control{flex:1}
.dsm-attach-list{display:flex;flex-direction:column;gap:4px}
/* 技能创建弹窗的附件区（2026-10-16）：清单封顶滚动，行收紧一档 —— 附件多的时候
   弹窗不该被顶到比正文还高，而 .dsm-file 原档的 8px 内边距是给导入拖拽区用的。 */
.dsm-attach-actions{display:inline-flex;align-items:center;gap:6px}
.dsm-attach-cap{max-height:126px;overflow:auto;padding-right:2px}
.dsm-attach-cap .dsm-file{gap:6px;padding:5px 8px}
.dsm-toast{position:fixed;right:22px;bottom:22px;z-index:1250;box-sizing:border-box;max-width:min(420px,calc(100vw - 44px));padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;animation:dsm-toast-in 160ms ease-out}@keyframes dsm-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}/* 动效降级：系统开了「减少动态效果」就一律关掉。新增 transition / animation 时记得同步加到这里，
   否则那一个动效就是唯一不尊重用户设置的部分。（列表换位的 FLIP 曾在 JS 侧另判，随动画一起删除。） */
@media(prefers-reduced-motion:reduce){.dsm-toast{animation:none}.dsm-switch:after{transition:none}.dsm-dropzone{transition:none}}
/* ── 勾选段（场景档案编辑器 / 任何「多选一组条目」的地方共用同一套排版）────────────
   .dsm-seg  一段（标题栏 + 固定高度滚动体 + 脚注）；高度固定，勾选内容增减不会让弹窗跳动。
   .dsm-pick 一行选项（复选框 + 名称/说明 + 右侧指标 + 可选行内动作）。 */
.dsm-seg{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-seg-head{display:flex;min-height:42px;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsm-seg-title{min-width:0;font-size:13px;font-weight:600;white-space:nowrap}
.dsm-seg-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-seg-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.dsm-seg-body{display:flex;height:216px;padding:4px;overflow:auto;flex-direction:column}
/* 滚动容器里的子项不许被压缩：否则内容一多，筛选框会被压到比 input 还矮、与下面的条目叠在一起。 */
.dsm-seg-body>*{flex:none}
/* 条目本来就少的那一段（场景表单里的快捷提示词）：跟着内容长，超过 6 行才内滚。
   固定 216px 的段体放在一张按内容高的表单弹窗里，就是"一个勾 + 一片空白"（用户实测）。 */
.dsm-seg-fit{height:auto;max-height:172px}
/* 表单分段标题：把一长串字段切成「基本信息 / 场景绑定」这类模块，右侧一道发丝线跟着撑满。 */
.dsm-form-section{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;letter-spacing:.02em}
.dsm-form-section::after{content:"";height:1px;flex:1;background:var(--dsw-alias-border-l1)}
.dsm-seg-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dsm-mcp-edit-tools-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsm-mcp-edit-tools-actions{display:flex;align-items:center;gap:8px}.dsm-seg-empty-actions{display:flex;justify-content:center;padding:4px 0 12px}.dsm-seg-empty-error{padding:0 8px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;text-align:center}
.dsm-pick-empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
/* （旧的 .dsm-modal-archive 定高弹窗与 .dsm-archive-grid 已随「场景编辑器」融合删除；
   四组行选择的新样式在文件尾段 .dsm-editor-* 一节。） */
/* ── 段内筛选（场景/记忆等条目多的选段用；条目少时不必显示）────────────────────
   .dsm-seg-filter 段体顶部的搜索行；.dsm-seg-cards 场景卡片列表（比纯勾选行信息量大）。 */
.dsm-seg-filter{display:flex;align-items:center;gap:8px;padding:4px 4px 8px}
.dsm-seg-filter .dsm-control{min-height:30px;font-size:12px}
.dsm-seg-group{display:flex;align-items:center;gap:8px;padding:8px 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-seg-group-line{height:1px;flex:1;background:var(--dsw-alias-border-l1)}
/* ── 场景页（场景档案）────────────────────────────────────────────────────
   四类信息各占一行，互不挤：标题行（名字/别名/标签/开关）、描述行（单行省略）、动作行（主次按钮）。
   卡片上**不再出现数量**（记忆条数、已配 N 台 MCP…）：它们是上次「卡片显得杂乱」的直接来源，
   现在统一收进页首的「当前模式」条里，只有一处。 */
/* 当前模式条：只在进入模式后出现（没有条 = 自由模式，不需要常驻的解释文案）。 */
.dsm-mode-bar{display:flex;min-width:0;align-items:center;gap:8px;padding:12px 12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-mode-bar .dsm-btn{margin-left:auto;flex:none}
.dsm-mode-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsm-mode-main{min-width:0;flex:1}
.dsm-mode-title{overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsm-mode-sub{overflow:hidden;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;text-overflow:ellipsis;white-space:nowrap}
.dsm-scenes{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
.dsm-scene-tile{display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-scene-tile-mode{border-color:var(--dsw-alias-state-success-primary)}
.dsm-scene-tile-head{display:flex;min-width:0;align-items:center;gap:8px;padding:12px 12px 0}
.dsm-scene-tile-name{overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsm-scene-tile-key{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsm-scene-tile-head .dsm-tag{flex:none}
.dsm-scene-tile-switch{margin-left:auto;flex:none}
.dsm-scene-tile-desc{overflow:hidden;margin:4px 0 0;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-scene-tile-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-scene-tile-links{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-left:auto}
@container(max-width:640px){.dsm-scenes{grid-template-columns:1fr}}
.dsm-tools-grid{display:flex;max-height:180px;padding:4px;overflow:auto;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-tools-grid>*{flex:none}
.dsm-tools-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dsm-chip{display:inline-flex;min-height:24px;align-items:center;gap:4px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-chip-deny{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-chip button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}
/* ── 高级选项折叠区（人设表单；默认收起，展开后才拉候选数据）────────────────── */
.dsm-adv{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-adv-head{display:flex;width:100%;min-height:40px;align-items:center;gap:8px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsm-adv-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-adv-caret{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
/* 「高级选项」永不折行：它在收起时与两行摘要并排，被挤成两字一行就不再像个标题了。 */
.dsm-adv-title{flex:none;white-space:nowrap}
/* 折叠摘要最多两行（第一行模型 / 思考强度 / 允许追问，第二行工具限制；没有值的那一行不出现），
   靠 align-items:center 与标题垂直居中。 */
.dsm-adv-sum{display:flex;min-width:0;flex-direction:column;gap:4px}
.dsm-adv-body{display:flex;flex-direction:column;gap:16px;padding:12px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 分组（0.19.0 重排）：组标题 + 一条横贯的细线，组间距靠 .dsm-adv-body 的 16px。
   重排前是五组平铺、只靠 12px gap 分隔，视觉上连成一片 —— 分组是这次清理的主手段。 */
.dsm-adv-group{display:flex;flex-direction:column;gap:8px}
.dsm-adv-group-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:400}
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
.dsm-adv-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
/* ── 工具限制四行（人设表单：一行一个 Agent 预设，白/黑名单互斥、默认折叠）──────── */
/* 无 margin-top：这个名单原先紧跟在自己的字段 label 后面，靠 6px 拉开；0.19.0 重排后
   label 撤掉、由分组头承担，间距交给 .dsm-adv-group 的 gap。 */
.dsm-modes{display:flex;flex-direction:column;gap:4px}
.dsm-mode-row{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-mode-row.dsm-mode-on{border-color:var(--dsw-alias-border-l3)}
.dsm-mode-head{display:flex;min-height:38px;align-items:center;gap:8px;padding:0 8px}
/* 行首是按钮：已配好的模式点它就展开/收起名单（右侧两个按钮只管启用/停用，两者别混）。 */
.dsm-mode-head-main{display:flex;min-width:0;flex:1;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsm-mode-head-main:disabled{cursor:default}
.dsm-mode-head-main:not(:disabled):hover .dsm-mode-name{color:var(--dsw-alias-label-primary)}
.dsm-mode-caret{flex:none;width:10px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsm-mode-name{font-size:12px;font-weight:400;white-space:nowrap}
.dsm-mode-sum{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-mode-sum.dsm-mode-allow{color:var(--dsw-alias-state-success-primary)}
.dsm-mode-sum.dsm-mode-deny{color:var(--dsm-warn)}
.dsm-mode-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.dsm-mode-btn-allow{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-mode-btn-deny{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-mode-body{display:flex;flex-direction:column;gap:8px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-legacy{display:flex;flex-direction:column;gap:4px;padding:8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
/* ── 兼容页（宿主能力体检）──────────────────────────────────────────────
   一块"体检报告"：先给结论卡，再给动作可用性、降级项、模块实体、阻塞项。
   状态色只用设计系统里已有的三档：成功 / 告警（--dsm-warn）/ 错误。 */
   /* 注意：整段 CSS 是一个模板字符串，注释里**不能出现反引号** —— 它会提前闭合模板，
      整个 bundle 直接语法错误（客户端白屏）。 */
/* 兼容页根容器直接复用 .dsm-section（宽度上限、内边距、12px 块间距一起继承）——
   原先这里另写一份 gap:8px，页与页的节奏就分了两套（用户 2026-10-12 指出间隔没跟上）。 */
.dsm-compat-bar{display:flex;min-width:0;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-bar-warn{border-color:var(--dsm-warn)}
.dsm-compat-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsm-compat-dot-warn{background:var(--dsm-warn)}
.dsm-compat-bar strong{margin:0;font-size:13px;font-weight:600}
.dsm-compat-sum{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
/* 三个指标格：左对齐、等分，窄屏落成单列。 */
.dsm-compat-grid{display:grid;gap:8px;grid-template-columns:repeat(3,minmax(0,1fr))}
.dsm-compat-card{display:flex;min-width:0;flex-direction:column;gap:4px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-card-bad{border-color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-label{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-compat-card-value{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;line-height:22px;word-break:break-all}
.dsm-compat-card-value-bad{color:var(--dsw-alias-state-error-primary)}
.dsm-compat-card-note{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-compat-section{display:flex;min-width:0;flex-direction:column;gap:8px}
/* 「可操作的设置块」的**内容**加一圈边框（访问令牌 / 注入实况）。两种东西没有它时整页
   就是一长条同质的文字，用户找不到"我该动哪儿"。边框只包内容：小标题留在框外、底色跟
   页面一致（用户裁定 2026-09-19：「小标题不用在框里」「背景不用设置深灰色，和大背景一样
   就行」—— 上一版标题进框、框内再铺一层深灰底，整页多出一串"盒子里的盒子"）。
   取值与「注入」那一块（.dsm-inject-settings）一致，三块看起来才是同一类东西。 */
.dsm-compat-box{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
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
.dsm-token-unlock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsm-warn);border-radius:var(--dsm-radius-m)}
.dsm-token-unlock .dsm-control{flex:1 1 190px;min-width:0}
/* 管理清单的行：名字 · 一句说明 · 按钮，三列同形同位 —— 行不随状态增删。 */
.dsm-token-rows{display:flex;flex-direction:column;gap:8px}
/* 行按钮统一宽度（fixedLabelPair 负责文案翻转不挤宽），四行按钮的右缘对齐成一列；
   min-width 按"四个汉字 + 内边距"留足余量，不让文案贴边截断。 */
/* 弹窗里的表单：密码框**各占一行**（圆点看不出填的是哪格，竖排靠顺序就够）。 */
.dsm-token-form{display:flex;flex-direction:column;gap:8px}
/* 横排 .dsm-control 的 flex-basis 在竖排里会被当成高度（每格被撑成 190px 高），
   这里按回 auto、宽度交给 width:100%。 */
.dsm-token-form .dsm-control{flex:0 0 auto;width:100%}
/* 弹窗内部的错误行：跟框走（错误永远不出现在弹窗外面），贴紧上方的控件。 */
.dsm-token-ferr{margin:0}
.dsm-compat-section-head{display:flex;min-width:0;align-items:baseline;gap:8px}
.dsm-compat-section-title{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;white-space:nowrap;flex:none}
/* 说明文字：占满剩余宽度，放不下就换行（标题已 nowrap；此前用省略号截断，用户 2026-09-17
   指出"注入实况后面那句被截断了" —— 那行是状态信息，截断等于看不全）。 */
.dsm-compat-section-hint{min-width:0;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}
/* 动作可用性：一行一个动作 + 路径标记，窄容器落成"名称在上、标记在下"。 */
.dsm-compat-mod-list{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-compat-mod-row{display:flex;min-height:38px;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsm-compat-mod-row:last-child{border-bottom:0}
.dsm-compat-mod-list.dsm-compat-cards .dsm-compat-mod-row{display:grid;min-height:0;grid-template-columns:minmax(0,1fr) max-content;gap:4px 10px;padding:8px 12px}
.dsm-compat-mod-self{grid-column:1/-1}
.dsm-compat-mod{min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:17px;word-break:break-word}
.dsm-compat-pill{display:inline-flex;min-height:20px;flex:none;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:99px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dsm-compat-pill-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-compat-pill-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-compat-reach-marks{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;min-width:0}
.dsm-inject-settings{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
/* 注入域开关：六域**一行**等分（用户 2026-10-12：「分六行很占用空间，能不能一行显示，
   而且还能美观、简洁、高级」）。
   做法：把「名字」本身做成控件（chip），而不是"名字 + 一颗 32px 开关"并排 —— 后者六份要
   ~630px，一行塞不下只能缩字号。
   ⚠️ 宽度写法是 flex:1 1 0 + min-width:max-content，**不是** flex:1 1 84px：
   后者允许 flex 把 chip 压到比文字还窄，于是「全局提示词」被截成「全局提…」（用户
   2026-10-12 报「有的显示不全」）。min-width:max-content 把每颗的下限钉在"文字完整放得下"，
   行放得开就等分填满，放不开就按 flex-wrap 折成两行 —— 任何宽度下都不会截字。
   开/关不只靠颜色：chip 里有一颗 6px 圆点，开 = 成功色实心、关 = 当前字色半透明，
   色盲或低对比屏上也能分辨；再加 role=switch + aria-checked 供读屏。 */
.dsm-inject-domains{display:flex;flex-wrap:wrap;gap:6px}
.dsm-inject-chip{box-sizing:border-box;display:inline-flex;flex:1 1 0;min-width:max-content;min-height:32px;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsm-inject-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-inject-chip:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
.dsm-inject-chip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4}
.dsm-inject-chip-name{flex:none}
/* 开：成功色描边 + 主字色 + 实心点。底色不动 —— 六块都涂色会把「注入内容」这一块压得
   比上面的总开关还重，与它「细项」的层级不符。 */
.dsm-inject-chip-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dsm-inject-chip-on .dsm-inject-chip-dot{background:var(--dsw-alias-state-success-primary);opacity:1}
/* 模型工具表：与「注入」同屏的第二种开关。**一行一个工具、四列固定宽度**（勾选框 / 名字 /
   ≈tok / 一句话介绍）—— 列宽不固定就竖着扫不出任何一列（用户 2026-09-23 指出挤成一排很难看）。
   名字用等宽、数字用 tabular-nums 右对齐；介绍超长省略，完整那句在悬停里。
   出厂默认关着哪几条**不在行上标**（用户 2026-09-23 要求去掉「默认关」小标），
   出处只剩悬停那一行（compat.tools.defaultOffTitle）—— 合计下面原来还有第二句
   "其中 ≈X 是出厂默认关掉的 N 条"，2026-10-12 随说明行一起删了（见 compat 页那一处注释）。 */
.dsm-tooltable{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
/* 保存往返期间：整块不吃点击、略灰 —— 这一块刻意没有乐观更新（见 saveToolTable 注释）。 */
.dsm-tooltable-busy{pointer-events:none;opacity:.55}
.dsm-tooltable-summary{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
/* 「保存方案 / 恢复方案」钉在合计那一行的最右（用户 2026-09-23 指定位置）。
   按钮压到与 18px 行高齐平：宿主默认的 .dsm-btn 比这行字高，直接放会把整行顶开。 */
.dsm-tooltable-preset-actions{display:flex;flex:none;align-items:center;gap:4px;margin-left:auto}
.dsm-tooltable-preset-actions .dsm-btn{min-height:24px;padding:0 8px;font-size:12px;line-height:18px}
/* 方案清单（恢复弹窗）：一行一份，名字吃剩余宽度，数字与两颗按钮靠右。 */
.dsm-preset-list{display:flex;flex-direction:column;gap:4px}
.dsm-preset-row{display:flex;align-items:center;gap:8px;padding:8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-preset-name{min-width:0;overflow:hidden;flex:1;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.dsm-preset-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-preset-row .dsm-btn{min-height:24px;padding:0 8px;font-size:12px;line-height:18px}
.dsm-preset-tag{margin-left:4px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.dsm-tooltable-group{display:flex;flex-direction:column;gap:4px}
.dsm-tooltable-ghead{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}
.dsm-tooltable-ghead input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-tooltable-gname{font-weight:400}
.dsm-tooltable-gcount{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsm-tooltable-tools{display:flex;flex-direction:column;padding-left:20px}
.dsm-tooltable-tool{display:grid;grid-template-columns:15px 186px 48px minmax(0,1fr);align-items:center;gap:0 8px;padding:4px 4px;border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.dsm-tooltable-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-tooltable-tool input[type=checkbox]{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-tooltable-name{overflow:hidden;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.dsm-tooltable-tok{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-tooltable-about{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 注入实况（只读）：与「注入」设置同屏。行 = 域 + 体积 + 状态胶囊，点域名展开正文。 */
.dsm-inject-live-actions{display:flex;flex:none;align-items:center;gap:4px;margin-left:auto}
.dsm-inject-live-toggle{padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dsm-inject-live-toggle:hover{text-decoration:underline}
.dsm-inject-live-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}
/* 没有正文可展开的行：用一个看不见的同字符占位，把展开箭头那一格宽度留出来，
   这样所有行的域名左缘才会在同一条竖线上（用户 2026-09-17 指出参差不齐）。
   占位与文字放在**同一个** flex 子项里（.dsm-inject-live-static），否则 name 格的
   gap:0 4px 会在它们之间再插一段间距，比可展开的行多出 6px。 */
.dsm-inject-live-mark-blank{visibility:hidden}
.dsm-inject-live-size{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* 实况面板的域名格里有多个行内元素（域名 / 体积 / 采纳统计），行内元素之间没有空白节点，
   不设间距就会挤成「场景· 3.2 KB」。
   刻意**不复用** .dsm-compat-name：那一类在另外五个面板里只放一个文本子节点，改成 flex 会让
   长标签变成不可收缩的 flex 项 → 窄容器下溢出而不是换行。所以只在实况面板这一处加 gap。 */
.dsm-inject-live-name{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 4px}
/* 采纳一行（注入 N 次 / 调用 M 次 / 采纳 K 次）：刻意用中性灰而不是琥珀 —— 胶囊的琥珀
   只表示"该投却没投"这一个故障；"投了但模型没伸手"是数据，不是故障，颜色留给数字说话。 */
.dsm-inject-live-adopt{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dsm-reach-name{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.dsm-reach-chip{display:inline-flex;min-height:24px;align-items:center;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dsm-reach-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-reach-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-reach-unknown{color:var(--dsw-alias-label-tertiary)}
.dsm-compat-pill-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsm-compat-name{min-width:0;flex:1;font-size:12px;font-weight:400;word-break:break-word}
.dsm-compat-label{margin-right:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dsm-compat-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsm-compat-list{margin:0;padding-left:16px}.dsm-compat-list li+li{margin-top:4px}
@container(max-width:640px){.dsm-compat-grid{grid-template-columns:1fr}}
html,body{scrollbar-gutter:stable}.dsm-settings-scroll-host{overflow-y:scroll!important;scrollbar-gutter:stable}.dsm-tabs-shell{position:sticky;top:0;z-index:6;display:flex;min-width:0;align-items:center;gap:4px;margin-bottom:0;padding-top:2px;background:var(--dsw-alias-bg-layer-2)}.dsm-tabs{display:grid;min-width:0;flex:1;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:0;overflow:hidden;margin-bottom:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-tab{box-sizing:border-box;width:100%;min-width:0;padding-right:4px;padding-left:4px;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.dsm-feedback-link{width:30px;height:30px;box-sizing:border-box;padding:0;justify-content:center}.dsm-feedback-link svg{width:16px;height:16px}@container(max-width:620px){.dsm-tab{padding-right:4px;padding-left:4px;font-size:12px}}
/* 动作可用性表：表头列宽与 dsm-compat-mod-row 一致；窄容器下隐藏表头。 */
.dsm-compat-table-head{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:8px;padding:4px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-compat-cards .dsm-compat-table-head{display:none}
/* 导出弹窗（D14）：宽高都固定；只有「条目列表」这一层滚动，动作条常驻底部。 */
.dsm-export-modal .dsm-modal-body{display:flex;min-height:0;flex-direction:column;gap:12px;overflow:hidden}
.dsm-export-modal .dsm-export-form{display:flex;min-height:0;flex:1;flex-direction:column;gap:8px}
.dsm-export-modal .dsm-pick-list{flex:1;min-height:0;max-height:none;overflow:auto}
.dsm-export-modal .dsm-export-body{display:flex;min-height:0;flex:1;flex-direction:column;gap:4px}
/* （.dsm-modal.dsm-modal-export-lg 的 760 定高已拆：列表弹窗统一走尾段的
   .dsm-modal-list 新档 —— 宽 720、高度自适应（min 480 / max 720），§4.2。） */
.dsm-pick-group{display:flex;flex-direction:column}
.dsm-pick-group-head{box-sizing:border-box;display:flex;width:100%;min-width:0;align-items:center;gap:8px;padding:8px 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;text-align:left;cursor:pointer}
.dsm-pick-group-head:hover{color:var(--dsw-alias-label-primary)}
.dsm-pick-caret{flex:0 0 auto;width:12px;color:var(--dsw-alias-label-tertiary)}
.dsm-pick-group-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-pick-group-count{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}

/* （.dsm-modal.dsm-modal-trash 的 760 定高与 .dsm-modal-trash-split 上下分栏已拆：
   回收站样式在尾段 .dsm-trash-pane 一节（2026-10-12 起「一页一个」，双栏也删了）；
   高度与其他弹窗一样走 min(内容, min(720px, 100vh - 96px))。） */

/* 访问令牌（兼容页）：状态胶囊 + 一句实况 + 主行动区 + 折叠管理区。胶囊用 .dsm-pill 的
   既有语义色（绿=就绪、告警=要注意、灰=没配），不新增颜色。 */
.dsm-token-block{display:flex;flex-direction:column;gap:8px}
/* 提示行右侧挂按钮（令牌没过的提醒）：文案占满剩余宽度，按钮不换行、不压缩。 */
.dsm-feedback-row{display:flex;align-items:center;gap:8px}
.dsm-feedback-row .dsm-feedback-text{flex:1;min-width:0}
.dsm-feedback-row .dsm-btn{flex:none}
/* 弹窗正文里的说明段：.dsm-desc 是**页面描述**用的（2 行裁剪，见文件头部），照搬进弹窗会
   把说明截断（「清理旧备份」此前就被截到「而它们常常挤…」）。这里只声明"不裁剪"。 */
.dsm-desc-plain{display:block;margin:0;overflow:visible;-webkit-line-clamp:none;font-size:12px;line-height:19px}
/* 分段选择器的选中态（备份保留份数）：四个按钮都是 .dsm-btn-quiet（深灰字、透明底），
   选中与否只差一点文字色，几乎看不出来；用既有语义色（绿=已选）表达，
   与 .dsm-pill-ok / .dsm-tab-active 同色。 */
/* 令牌未验证时的页面级横幅（见 40-apply-head.js 的 syncTokenBanner）。
   它是**唯一**能说清"为什么发不出消息"的东西：宿主侧拒绝那一轮（agent/pre-step → reject）
   在界面上没有任何呈现，而且会丢掉那条消息。位置固定在顶部居中、pointer-events:none ——
   它只负责说明，不该挡住任何可点的东西。
   层级 999：高于普通页面内容，低于插件自己的弹窗（.dsm-mask 1100）与宿主的设置窗口 ——
   之前 2147483000 会把宿主设置窗口的标题区都盖住（用户实测）；锁态的解释在设置窗口里
   由兼容页与面板内提示兜底，横幅还带关闭键（见下），挡路时可手动关掉。 */
.dsm-token-banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999;display:flex;align-items:flex-start;gap:8px;max-width:min(620px,92vw);padding:8px 12px;border:1px solid var(--dsm-warn);border-radius:var(--dsm-radius-m);background:var(--dsm-warn-bg);color:var(--dsm-warn);font-size:13px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none;backdrop-filter:blur(6px)}
.dsm-token-banner-text{flex:1;min-width:0}
/* ⚠️ 横幅压在**窗口顶部**（top:12px），而宿主把标题栏那一横条做成了窗口拖拽区
   （-webkit-app-region:drag）。拖拽区是按布局矩形算的、与谁画在上面无关，于是
   横幅里这两颗键的上半截落在拖拽区里 —— 按下去是"拖窗口"，只有露在拖拽区之外的下半截
   才真的点到按钮（用户 2026-10-12 实测："这个按钮只能点击下半部分"）。
   按钮自己声明 no-drag，就把这块矩形从拖拽区里挖出来。键必须逐颗写：横幅其余部分是
   pointer-events:none，只在键上声明才不会把整条横幅变成"拖不动窗口"的洞。 */
/* 关闭键：横幅整体 pointer-events:none，唯独它可点。关掉后本次锁态期间不再出现
   （解锁后再锁会重置，见 syncTokenBanner）。 */
.dsm-token-banner-close{pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsm-radius-s);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;cursor:pointer;opacity:.7}
.dsm-token-banner-close:hover{opacity:1}
/* 「前往」键。用户 2026-10-12 给了两个要求，合起来就是这一条：
   ① 形态照「填写令牌」那颗旧按钮（用户贴的样图）：**填充底 + 1px 同族亮边 + 同族字**，
      圆角小、无阴影。样图那三层是中性色族（#3b3b3d 底 / #505052 边 / #e5e5e7 字），
      换成横幅自己的琥珀色族 —— 底 rgba(212,146,69,.22)、边与字都用 --dsm-warn，
      这就是"黄底黄字"。底必须比横幅背景（--dsm-warn-bg = 同色 .12）更重，否则按钮
      在横幅里没有边界；文字仍用满饱和的琥珀，压在 .22 的琥珀底上对比度足够。
   ② 尺寸照样图：77×30 CSS px（样图 116×45 设备像素 ÷ 1.5 缩放）→ font-size 13px、
      line-height 20px、padding 4px 12px、1px 边 = 30px 高。此前 12px/3px 偏矮。
   同样要自己拿回 pointer-events 与 no-drag（见上）；垂直居中（横幅是 flex-start，
   两行正文时按钮不该顶在第一行）。 */
.dsm-token-banner-go{pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;flex:none;align-self:center;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-s);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.dsm-token-banner-go:hover{background:rgba(255,255,255,.08)}
.dsm-token-banner-go:active{background:rgba(255,255,255,.14)}
.dsm-token-banner-go:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px}

/* 全局轻提示（斜杠命令的执行反馈）。位置在右下角：对话页的输入框居底居中，顶部那条又是
   令牌横幅，两处都会被挡。z-index 比横幅低一档 —— 令牌没过时那句解释比"改成功了"更要紧。 */
.dsm-toast{position:fixed;right:18px;bottom:18px;z-index:998;max-width:min(420px,80vw);padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-text-primary);font-size:13px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.16);pointer-events:none;backdrop-filter:blur(6px)}
.dsm-toast-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsm-toast-warn{border-color:var(--dsm-warn);color:var(--dsm-warn)}
.dsm-toast-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}

/* MCP JSON 导入预览（0.15.0 A1）：勾选 | 主体 | 状态三列；表头 label 已删
   （用户 2026-10-15），勾选框随行内容垂直居中。非法行只把「问题」那一行标红，
   名字净化 / 字段忽略这类是配置事实，走中性灰 —— 黄色在这里留给不了任何东西（琥珀语义）。 */
.dsm-imp-row{display:grid;grid-template-columns:15px minmax(0,1fr) auto;align-items:center;gap:8px}
.dsm-imp-list{display:flex;flex-direction:column;gap:4px;max-height:320px;padding:4px 4px 0 0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-imp-row{padding:8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.dsm-imp-row.dsm-imp-bad{border-color:var(--dsw-alias-state-error-primary)}
.dsm-imp-row input[type=checkbox]{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-success-primary)}
.dsm-imp-row input[type=checkbox]:disabled{cursor:not-allowed}
.dsm-imp-main{display:flex;min-width:0;flex-direction:column;gap:4px}
.dsm-imp-name{display:flex;align-items:center;flex-wrap:wrap;gap:4px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dsm-imp-endpoint{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all}
.dsm-imp-sub,.dsm-imp-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dsm-imp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}
.dsm-imp-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.dsm-imp-foot{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
/* 导入弹窗重名处理行（用户 2026-10-15 两连）：从预览底部上移到预览之前，导入前
   就看得见；排他二选一用「提示词类型」同款分段控件（dsm-form-seg，aria-pressed
   表选中），「重名时」文字 label 删除（同类第三例：设置页表头 label 也删）。 */
.dsm-imp-conflict{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
.dsm-imp-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}

/* 体检状态点（0.15.0 B1）与行内检查项。点只有 8px，靠 title 说清含义；
   检查结果单独一行一行列在行尾，不复用 .dsm-row-hint（那一套固定带 ⚠ 前缀、且语义是"运行状态"）。 */
.dsm-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l3)}
.dsm-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dsm-dot-warn{background:var(--dsm-warn)}
/* 启动进行中的呼吸点（2026-10-15 用户要求加回：服务启动要数秒，原来只有一个静态灰点，
   "正在启动"只能靠 title 说出来。2026-10-12 曾以"闪动的点只有体检用"为由删过一次，
   这次是 MCP 启动相位自己要 —— 全页只有 phase 非 active 时用它，不会到处闪）。
   配色改绿（用户 2026-10-15）：business 橙在 dsh 的语义里是"占用中/要处理"，而启动中既不是
   警告也不是故障，跑起来之后它就变成同一支绿 —— 呼吸与常亮因此是同一个颜色的两种节律。 */
.dsm-dot-busy{background:var(--dsw-alias-state-success-primary);animation:dsm-dot-pulse 1.1s ease-in-out infinite}
/* 呼吸的最低亮度从 .3 提到 .65，且改成**长一圈**而不是缩一点（用户 2026-10-15：灯在闪，
   可颜色看着不绿，分不清是不是启动中）。6px 的点压到三成透明度就只剩一层灰；"变亮 + 长大"
   与跑起来那颗常亮的绿一眼可分。 */
@keyframes dsm-dot-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.65;transform:scale(1.35)}}
/* （.dsm-inspect / -line / -warn 三条已随 MCP 体检功能一起删除，2026-10-12。） */

/* 「最近改动」流水（0.15.0 B2）：时间列固定窄栏，改动列吃剩余宽度，来源徽章贴在行尾。 */
.dsm-audit{display:flex;flex-direction:column;gap:4px}
.dsm-audit-bar{display:flex;align-items:center;gap:8px}
.dsm-audit-filter{flex:none;width:auto;min-width:130px;font-size:12px}
.dsm-audit-list{display:flex;flex-direction:column;max-height:300px;overflow:auto;padding-right:4px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-audit-head{grid-template-columns:92px minmax(0,1fr)}
.dsm-audit-row{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:baseline;gap:8px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsm-audit-row:last-child{border-bottom:0}
.dsm-audit-time{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-audit-main{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;min-width:0}
.dsm-audit-item{color:var(--dsw-alias-label-secondary)}
.dsm-audit-target{color:var(--dsw-alias-label-primary);font-weight:400}
.dsm-audit-more{color:var(--dsw-alias-label-tertiary);font-size:12px}

/* 整机迁移（0.15.0 C2）：路径 + 动作按钮同一行，勾选清单横向铺开（一域一个标签）。 */
.dsm-snap{display:flex;flex-direction:column;gap:8px}
.dsm-snap-row{display:flex;gap:8px}
.dsm-snap-row .dsm-control{flex:1;min-width:0}
.dsm-snap-preview{display:flex;flex-direction:column;gap:4px;padding:8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
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
.dsm-snap-browse{display:flex;flex-direction:column;gap:4px;margin-top:4px;padding:8px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-snap-browse .dsm-dir-list{max-height:170px}
.dsm-snap-browse-foot{display:flex;align-items:center;gap:8px}
.dsm-snap-browse-foot .dsm-help{min-width:0;flex:1;overflow-wrap:anywhere}

/* 回收站保留期 + 批量删除（0.19.1）。保留期选择器（.dsm-trash-retention）现在挂在
   双栏回收站右栏的置顶行（见尾段 .dsm-trash-hub）；旧的全局工具栏（.dsm-trash-toolbar）
   已随双栏改版删除。 */
.dsm-trash-retention{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.dsm-trash-retention .dsm-label{flex:none;font-weight:400}
/* 保留期下拉的槽：定宽 150px，与列表工具条那几个筛选下拉同宽（.dsm-source-filter）。
   原先是原生 <select class="dsm-control">（width:100%），要靠退回内容宽度才不被撑满；
   2026-10-12 换成自绘 SourceSelect，宽度改由这个槽定，语义更直白。 */
.dsm-trash-retention-select{width:150px;flex:none}
/* 保留期这一行**恒为一行**（用户 2026-10-10：「保留期一行就够了」）。
   所以说明必须短（trash.retention.hint = 「超期自动删除」），全文走 title 悬停；
   nowrap + 省略号只是兜底：万一窄到放不下，宁可截掉尾部也不折行把下拉框顶上去。 */
.dsm-trash-hint{min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 出错时反过来：允许换行、不截断 —— 失败原因截成半句等于没说。 */
.dsm-trash-retention-err{flex:1 1 auto;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary)}
.dsm-trash-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* 「已选 N 项」占满左侧剩余空间 → 把「全选」与唯一的「永久删除」一起顶到最右。 */
.dsm-trash-bulk .dsm-note{min-width:0;flex:1}
.dsm-trash-bulk-confirm{padding:4px 8px;border-radius:var(--dsm-radius-m);background:var(--dsw-alias-interactive-bg-hover)}
.dsm-trash-bulk-confirm .dsm-note{font-weight:400;color:var(--dsw-alias-state-error-primary);white-space:normal}
.dsm-trash-notice{flex:none}
/* （旧的原生勾选 .dsm-trash-pick / .dsm-trash-item-picked 已删除：回收站行改用尾段的
   行选择组件 .dsm-rowselect（REDESIGN §5.1），批量条移到每一组自己的组头下。） */
/* 视觉层收拢（基于 #6，作者 wake1999）：放在模板末尾，同权重后者胜真正成立。
   相比原 PR：修掉 content: ; 与半径变量下划线/连字符错位两颗雷（半径、发丝线直接
   用字面量）；去掉 main 里不存在的标记（mainpage / market / segmented /
   detail-head / composer-chips，属于 #7）与半残的 tabs / switch 组。 */
.dsm-pick input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer}
.dsm-tooltable-ghead input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer}
.dsm-imp-row input[type=checkbox]{width:14px;height:14px;margin:0;cursor:pointer}
.dsm-select-menu button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px;}
.dsm-btn-lock:hover:not(:disabled){background: var(--dsw-alias-interactive-bg-hover);}
.dsm-btn-quiet:hover:not(:disabled){background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);}
/* quiet + danger 必须**自己把描边写回来**：单类的 .dsm-btn-danger（实心红底那颗）在
   .dsm-btn-quiet 之后声明、同权重，它的 border-color:transparent 会盖掉 quiet 的描边 ——
   于是所有行内「删除」都成了没框的红字（用户 2026-10-12「很多删除按键缺少边框」）。
   这里只补 background / color 是不够的，border-color 是第三条得一起说的属性。
   描边颜色用 error 而不是其他 quiet 按钮的 l2：删除键要跟同行动作在边框层面就分开。 */
.dsm-btn-quiet.dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsm-btn-quiet.dsm-btn-danger:hover:not(:disabled){background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary);}
/* 锁定键：文字是 warn 色，边框必须同色 —— 否则「琥珀字 + 灰框」看着像两颗按钮拼的
   （用户 2026-10-12「锁定的边框应该是字体一样」）。 */
.dsm-btn-quiet.dsm-btn-lock{border-color:var(--dsm-warn);background:transparent;color:var(--dsm-warn)}
.dsm-bulk-ghost{border: 0; background: none; padding: 0 2px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer;}
.dsm-file-remove:hover{background: var(--dsw-alias-interactive-bg-hover-danger);}
.dsm-select-trigger > span{min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
.dsm-select-trigger::after{content:""; flex: none; box-sizing: border-box; width: 7px; height: 7px; margin-top: -3px; border-right: 1.5px solid var(--dsw-alias-label-tertiary); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary); transform: rotate(45deg);}
.dsm-select-trigger:empty::before{color: var(--dsw-alias-label-dimmed);}
/* 下拉触发器与上面的输入框是同一类控件，聚焦色跟着走同一档（原先是 business 蓝，
   与输入框并排时一个蓝一个白，2026-10-16 随输入框一起改）。 */
.dsm-select-trigger:focus-visible{outline: none; border-color: var(--dsw-static-neutral-bluish-400);}
.dsm-select-trigger:disabled{color: var(--dsw-alias-label-tertiary); cursor: default;}
/* 输入框（input / textarea / 原生 select）聚焦：只提亮描边、不画彩色焦点环，口径照宿主
   「通用设置 → 外观」那三张卡（dsh-client-ui-theme 的 .v01cdW_themeCube / .v01cdW_selected：
   静止 .5px solid border-l4，选中态把 border-color 提到 --dsw-static-neutral-bluish-400）。
   截图取色实测过：静止边 #565658（= l4 的 20% 白压在 #2c2c2e 上）、亮边 #adb2b8 —— 后者就是
   用户说的「白色边框」。**别拿 border-l4 当焦点色**：它正是静止态那一档，改了等于没改
   （2026-10-16 第一版就钉在这上面，用户回「变成直接没有了」）。
   neutral-bluish-400 是 static 令牌、深浅两主题同值，白底上也仍然看得见。
   ⚠️ 必须写在下面 aria-invalid 那条**之前**：两者特异性同为 0-2-0，只靠书写顺序分胜负，
   顺序反了校验失败的输入框聚焦时会变回白边、红边被吃掉。 */
.dsm-control:focus-visible{outline:none;border-color:var(--dsw-static-neutral-bluish-400)}
.dsm-control[aria-invalid= true ]{border-color: var(--dsw-alias-state-error-primary);}
/* 这一条**不能再写 background**：它与第 99 行的 .dsm-option:hover 特异性打平
   （都是一个类名 + 一个属性/伪类 = 0-2-0），同权重只靠书写顺序分胜负。这里一旦写了
   background，就会把 hover 高亮整条压掉、只剩 aria-selected 那一项有底 ——
   表现就是「下拉菜单鼠标移上去没反应，看不出停在哪一条」
   （用户 2026-10-12：新建子智能体高级选项那几个选择框）。
   选项的默认透明底由 99 行的 .dsm-option 给：两条渲染路径（20-helpers 的 SourceSelect
   与 42-shared-ui 的 SceneCombo）都同时挂了这个类，不会漏。 */
.dsm-select-menu [role= option ]{min-height: 30px; padding: 4px 8px; border: 0; border-radius: var(--dsm-radius-m); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left;}
.dsm-select-menu [aria-selected= true ]{background: var(--dsw-alias-interactive-bg-hover);}
.dsm-modal-head-wrap .dsm-modal-title{margin: 0; font-size: 15px; font-weight: 600; line-height: 24px; color: var(--dsw-alias-label-primary);}
.dsm-dir-item + .dsm-dir-item{border-top: 0.5px solid var(--dsw-alias-border-l2);}
button.dsm-chip:hover{background: var(--dsw-alias-interactive-bg-hover);}
.dsm-feedback.dsm-ok{color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);}
.dsm-feedback.dsm-warning{color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);}
.dsm-feedback.dsm-error{padding: 8px 12px; border-radius: var(--dsm-radius-m);}
.dsm-tab:hover{color: var(--dsw-alias-label-primary);}
.dsm-tab[aria-selected= true ]{color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-label-primary); font-weight: 400;}
.dsm-modal-actions .dsm-btn{min-height: 30px; padding: 0 12px; font-size: 13px; line-height: 20px; border-radius: var(--dsm-radius-m);}
.dsm-seg-filter .dsm-btn{min-height: 30px; padding: 0 12px; font-size: 13px; line-height: 20px;}
.dsm-actions .dsm-bulk-ghost{min-height: 24px; display: inline-flex; align-items: center;}
.dsm-btn.dsm-btn-bulk > .dsm-bulk-ghost{line-height: 18px;}
.dsm-btn.dsm-btn-icon > svg{width: 14px; height: 14px; flex: none;}
.dsm-btn.dsm-btn-icon.dsm-btn-lock{border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);}
.dsm-btn.dsm-btn-icon.dsm-btn-lock:hover:not(:disabled){color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger);}
.dsm-btn.dsm-btn-icon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px;}
.dsm-preset-row > [role= switch ]{margin-right: 4px;}
/* ⚠️ 不写 overscroll-behavior:contain（2026-10-12 与场景编辑器组体同批修）：代码块是
   overflow:auto，内容不到 340px 时它不是「没在滚」而是「滚不动」——contain 会把滚轮链
   锁死在它这一层，鼠标停在短代码块上时外层弹窗就滚不动了。 */
.dsm-detail-section .dsm-code{max-height: 340px; overflow: auto;}
.dsm-modal .dsm-field + .dsm-field{border-top: 0;}
.dsm-modal .dsm-form{gap: 16px;}
.dsm-modal .dsm-field{gap: 8px;}
.dsm-modal .dsm-label{color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 20px;}
.dsm-modal .dsm-help{margin-top:-2px; font-size: 12px; line-height: 18px;}
      [class*="dsm-"] input[type="checkbox"],[class*="dsm-"] input[type="radio"]{accent-color:var(--dsw-alias-state-success-primary)}


/* 记忆「形态」二选一：分段按钮（flat / bundle 互斥）。两个值摊开、点击即切，不依赖下拉 ——
   下拉在弹窗底部会被滚动容器裁掉（用户 2026-10-10 截图）。 */
.dsm-form-seg{display:inline-flex;gap:2px;padding:3px;border:0;border-radius:var(--dsm-radius-m);background:var(--dsw-alias-interactive-bg-hover)}
/* 字段内的分段控件收回内容宽度（用户 2026-10-15：提示词类型 / 形态两条被
   .dsm-field 的 align-items:stretch 拉满整行，过长）。flex 子项会被块状化，
   inline-flex 在列向导里挡不住 stretch —— 显式 align-self + fit-content 才保险。 */
.dsm-field>.dsm-form-seg{align-self:flex-start;width:fit-content}
.dsm-form-seg button{min-height:24px;padding:0 12px;border:0;border-radius:var(--dsm-radius-s);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.dsm-form-seg button:hover{color:var(--dsw-alias-label-primary)}
.dsm-form-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
/* （.dsm-select-up 这条已删：菜单 2026-10-12 改成 position:fixed，上下方向与坐标
   全部由 SourceSelect 内联算 —— 原来的 .dsm-select-up 上弹规则已被内联 style 覆盖。） */

/* ══ 弹窗层（REDESIGN §4，2026-10-11 切片二）════════════════════════════════
   三档宽度 S=440 / M=560 / L=720（§4.1）；高度一律 min(内容, min(720px, 100vh - 96px))，
   禁止写死 height（§4.2）。
   这里全部用两段类名压过头部历史区的同名单类规则（同权重靠书写顺序不可靠，!important
   只在头部历史区已经用了 !important 的属性上沿用）。 */
/* 高度由内容决定：M 档原先钉了 min-height:320、S 档钉了 200 —— 内容短的弹窗（进入场景的
   提醒卡、整机迁移、删除确认）就在按钮下面留一片空，用户 2026-10-12 两次指为"下面的空白"。
   只有**内部自带滚动区**的那两档还留地板（.dsm-modal-list / .dsm-compat-dialog）：
   那种弹窗的滚动区要靠定高才量得出高度，内容矮时也得把列表区撑出来。 */
.dsm-modal{max-height:min(720px,calc(100vh - 96px))}
/* 列表弹窗的 body 自己就是滚动容器（overflow:auto/hidden），而焦点环画在控件边框外 4px
   （outline 2px + offset 2px）—— 贴边那一圈会被这个容器裁掉，用户 2026-10-12 报的
   「焦点框没显示完全」就是左右两侧少了一截。留 4px 内边距，正好是环需要的量。 */
.dsm-modal-list .dsm-modal-body{padding:4px}
.dsm-modal.dsm-modal-sm{width:min(440px,100%)!important}
/* JSON 导入（42b）与各列表弹窗是「带列表」档：L=720（REDESIGN §6.1 弹窗档位总表）。
   这里原先钉了 min-height:480 —— 内容短的（整机迁移、令牌块）就在下面留一片空，
   高度改由内容决定；带滚动列表的弹窗另有 .dsm-modal-list。 */
.dsm-modal.dsm-modal-lg,.dsm-modal.dsm-modal-wide{width:min(720px,100%)!important}
/* 回收站「详情」（只读预览）单开一档（用户 2026-10-12 两轮定尺寸：先「能不能大点」，
   回头又「是不是又太大了」）。S 档 440 是给"一两行确认"的，而这里装的是**代码正文**：
   宽度直接决定一行折几次（.dsm-code 是 white-space:pre-wrap，窄一档就多折一行）。
   宽度取 720 —— 与列表弹窗 L 档齐平，**不再另造更宽的一档**：上一轮放到 880，
   用户回头看觉得太满，本轮回撤到全站已有的标准值，而不是新拍一个 800。
   高度用 §4.2 的基础帽（.dsm-modal 已给 min(720px, 100vh - 96px)），这里不重复声明。
   来源记录（meta）那一档**不挂 fill**：那张字段表只有三行，定高会在下面留一片空
   （2026-10-12 已经为"按钮下面那片空白"改过一次，不能又走回去）。 */
.dsm-modal.dsm-modal-preview{width:min(720px,100%)!important}
/* 负载文件那一档再往上走一步：定高 + 内层滚动 —— 它是"内部自带滚动区"的那类
   （同 .dsm-modal-list / .dsm-compat-dialog，§4.2 的"禁止写死 height"只约束内容决定高度的弹窗）。
   只有一个文件时（:only-child）让文件卡**吃掉整个剩余高度**、代码区在卡内滚，
   而不是像原先那样挤在 .dsm-preview-file>.dsm-code 的 240px 固定帽下面 ——
   一份 README 原先只能看到十来行，其余全靠那条小滚动条。多文件时不抢高度：
   每张卡按内容排，滚动交给 .dsm-preview-files（本来就是 flex:1 + overflow:auto）。 */
.dsm-modal.dsm-modal-preview-fill{width:min(720px,100%)!important;height:min(720px,calc(100vh - 96px))!important;max-height:none!important;overflow:hidden}
.dsm-modal-preview-fill>.dsm-preview{flex:1;min-height:0}
.dsm-modal-preview-fill .dsm-preview-files>.dsm-preview-file:only-child{flex:1;min-height:0}
.dsm-modal-preview-fill .dsm-preview-files>.dsm-preview-file:only-child>.dsm-code{flex:1;min-height:160px;max-height:none}
/* 场景编辑器是**XL 档**（用户 2026-10-12 三轮加宽：融合后顶部多了三处绑定，
   四组 2×2 挤在一起）：四组的清单是这个弹窗的主体，宽度直接决定每格能摆下
   "名字 + 描述 + 动作"还是只摆得下名字。高度上限按视口给到 100vh - 48（遮罩本身留 24px），
   §4.2 的 720 帽对这个弹窗太紧，登记为特例；屏幕不够高时仍然自适应缩，不会顶出视口。
   2026-10-12 用户「新建场景加高加宽」：1000×960 → 1200×1080（四组那一档同步加高，
   见 .dsm-editor-grid 的 grid-auto-rows —— 只抬帽不改内容的话弹窗高度由内容决定，等于没加）。
   ⚠️ 必须三段类名：上面 .dsm-modal.dsm-modal-list 那条也是 720，而且带 !important。
   宽度 2026-10-15 第二轮改成 min(1200px, 88vw)（用户：小窗下宽度也要减一点）：原先的 100%
   只扣掉遮罩那 24px，1000px 宽的窗口里弹窗 952 —— 左右各只剩 24px，看着就是"顶满"。
   代价：顶部五格的 flex-basis 合计 901px，容器窄过它时按既有兜底退回两行（.dsm-editor-basics
   的 flex-wrap），所以这一档让出的宽度会让五格变两行、而不是把下拉压扁。 */
.dsm-modal.dsm-modal-list.dsm-modal-editor{width:min(1200px,88vw)!important;max-height:min(1080px,calc(100vh - 48px))!important}
/* 新增 / 编辑 MCP 的表单弹窗（用户 2026-10-15：两种传输方式弹窗大小不一样）。
   stdio 是「启动命令 + 参数 + 环境变量」三格，streamable-http 只有「服务 URL + 请求头」两格 ——
   高度交给内容决定时，切一下传输方式弹窗就跳一次，而 stdio 那一档自然高 782，正好顶破 720 的帽、
   默认带滚动条。这一档给确定高度（与新建记忆切「形态」同一手感：格子跟着长，弹窗不跳也不滚），
   多出来的空间由带 textarea 的那几格吸收（.dsm-field-fill，见 41 片）。
   ⚠️ 这里不写 min-height:0 —— 屏幕不够高时宁可整窗滚动，也不要让格子被压到内容之下、
   textarea 溢出到下一格上面（实测 760 视口下会切掉两格）。
   820 → 770（用户 2026-10-16：「MCP 弹窗各减少一点」）：省下的 50 里，24 来自把这一档的字段间距
   收回 12（stdio 七格六个间距），其余是给两端各留一点余量；stdio 自然高随之降到 ~758，
   仍然不滚 —— 减高度不能减出滚动条，那是用户同一批里刚抱怨过的。 */
.dsm-modal.dsm-modal-mcp-form{height:min(770px,calc(100vh - 48px));max-height:none}
.dsm-modal-mcp-form .dsm-form{flex:1;gap:12px}
.dsm-modal-mcp-form .dsm-field-fill{flex:1 1 auto}
.dsm-modal-mcp-form .dsm-field-fill>textarea{flex:1;min-height:88px}
/* 新增 / 编辑提示词、新建 / 编辑子智能体（用户 2026-10-15：「默认就会有滑动条」）：
   正文是 dsm-textarea-lg 与两块 dsm-textarea-md，内容排开比 720 的帽更高 —— 帽抬到 920，
   让这两类表单按自己的内容站满；屏幕不够高时仍按视口缩，不会顶出窗口。 */
.dsm-modal.dsm-modal-form-tall{max-height:min(920px,calc(100vh - 48px))}
/* 列表弹窗（导出 / 回收站）：高度自适应——内容矮时缩到 min-height，超高时帽在 720、
   只让 body 内滚（头/底恒定）。旧的 640/760 定高全部由此替代。 */
.dsm-modal.dsm-modal-list{width:min(720px,100%)!important;height:auto!important;max-height:min(720px,calc(100vh - 96px))!important;min-height:480px}
/* 快捷提示词勾选弹窗（场景编辑器里「选择」开出来的那颗）：不吃上面那条 480 地板。
   地板是给「滚动区要靠定高才量得出高度」的列表弹窗留的；这一颗的清单是 .dsm-pick-list
   （自带 max-height），内容本来就短 —— 撑着 480 会在按钮下面空出一大片
   （用户 2026-10-12 报「弹窗下面太多空白」）。高度照 §4.2 由内容决定。 */
.dsm-modal.dsm-modal-list.dsm-quickpick{min-height:0}
/* 回收站同样不吃 480 地板：它的高度由 .dsm-trash-pane-scroll 那一条滚动区撑出来，
   内容短时（技能页常见的「1 个技能 + 2 个来源」）撑着 480 会在最后一行下面留一大块空白
   （用户 2026-10-12：「回收站弹窗完善」）。 */
.dsm-modal.dsm-modal-list.dsm-modal-trash{min-height:0}
/* 分栏档（技能页 / 提示词页各两组）反过来**必须有确定高度**：两块要"平分"，靠的就是
   flex:1 1 0 在确定的剩余空间里各分一半；弹窗要是 height:auto，两块只会各自缩到内容
   高度，一多一少根本不平（用户 2026-10-12：「两部分应该平分回收站的弹窗」）。
   所以这一档给回定高（就是 .dsm-modal-list 最初那档 640），单组的三档仍按内容自适应。 */
.dsm-modal.dsm-modal-list.dsm-modal-trash.dsm-modal-trash-split{height:min(640px,calc(100vh - 96px))!important}
/* 兼容页「最近改动」那颗定高弹窗（height 620）同样拆掉：高度自适应 + 内部滚动结构不变。 */
.dsm-modal.dsm-compat-dialog{height:auto;max-height:min(720px,calc(100vh - 96px));min-height:320px}
/* 头部右上角 X 图标钮（§4.3）：替换「关闭」文字钮，aria-label 仍取「关闭」文案。 */
.dsm-modal-close{flex:none;display:inline-flex;width:30px;height:30px;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsm-radius-m);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsm-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-modal-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
/* footer 规范（§4.3）：右对齐 [取消][主操作]（.dsm-modal-actions 已是 flex-end）。
   （.dsm-modal-danger-left「危险操作钮靠左」已随场景编辑页那颗「删除场景」一起删除 ——
   它此前是这颗键唯一的落点，用户 2026-10-12 裁定编辑页不再承担删除。） */

/* ── EmptyState（§4.4，全站复用）：16px 线性图标 + 一句话，高度 clamp 120~160 ── */
.dsm-empty-state{box-sizing:border-box;display:flex;min-height:120px;max-height:160px;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px;color:var(--dsw-alias-label-tertiary)}
.dsm-empty-state-icon{display:inline-flex}
.dsm-empty-state-text{margin:0;font-size:12px;line-height:18px;text-align:center;overflow-wrap:anywhere}

/* ── 行选择 RowSelect（§5.1）：整行可点 + 14px 自绘框（radius-s），选中主色实底白勾 ──
   行本体带 role=checkbox + aria-checked，Space/Enter 切换；框是纯视觉（aria-hidden）。 */
.dsm-rowselect{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsm-radius-s);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsm-rowselect:hover,.dsm-rowselect-on{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-rowselect:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsm-rowselect-disabled{cursor:default;opacity:.5}
.dsm-rowselect-disabled:hover{background:transparent}
.dsm-rowselect-box{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-s);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary-foreground)}
.dsm-rowselect-on .dsm-rowselect-box{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}
.dsm-rowselect-main{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
.dsm-rowselect-name{overflow:hidden;font-size:13px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-rowselect-desc{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.dsm-rowselect-meta{display:flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dsm-rowselect-actions{display:flex;align-items:center;gap:4px;flex:none}

/* ── 回收站（2026-10-12 起「一页一个」）：保留期置顶 + 分组列表 + 每组一条批量条 ──
   左栏那根六类导航已删除（连同 .dsm-trash-hub 这一层包装）：一页只看得到自己那几组，
   不需要在六个回收站之间跳。 */
.dsm-modal.dsm-modal-trash .dsm-modal-body{overflow:hidden}
/* ⚠️ 通用规则「列表弹窗 body 的直接子项一律 flex:none」在这里必须抢回来：回收站要的是
   **撑满 + 内部滚动**，不抢的话 hub/pane 只有内容那么高，超出 body 的条目被 overflow:hidden
   直接裁掉 —— 看不见也滚不到（正是上面那条注释警告过的那种形状，只是滚动层换了位置）。 */
.dsm-modal-list .dsm-modal-body>.dsm-trash-pane{flex:1 1 auto;min-height:0}
.dsm-trash-pane{display:flex;min-width:0;flex-direction:column;gap:8px}
.dsm-trash-pane-top{flex:none}
.dsm-trash-pane-scroll{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;overflow:auto;overscroll-behavior:contain;padding-bottom:4px}
.dsm-trash-pane-group{display:flex;flex-direction:column;gap:8px}
.dsm-trash-pane-group-head{display:flex;min-height:30px;align-items:center;gap:8px}
.dsm-trash-pane-group-title{min-width:0;font-size:13px;font-weight:600;white-space:nowrap}
.dsm-trash-list{display:flex;flex-direction:column;gap:4px}
/* 分栏回收站的两块：上下平分（flex:1 1 0）+ 各自一圈边框隔开（用户 2026-10-12：
   「两部分应该平分回收站的弹窗，两部分应该有边框进行隔离区分」）。
   底色用 layer-1 —— 它是弹窗（layer-2）里的"下沉面"，行卡片（layer-2）落上去才浮得起来；
   此前行卡片与弹窗同色，只靠一圈边框区分，两块并排时几乎看不出"这是两组"。
   overflow:hidden 把滚动关在每块内部（外面那层 .dsm-trash-split 不滚）。 */
.dsm-trash-split{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}
.dsm-trash-split-pane{flex:1 1 0;min-height:0;display:flex;flex-direction:column;gap:8px;padding:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-trash-split-pane>.dsm-trash-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.dsm-trash-split-pane>.dsm-empty-state,.dsm-trash-split-pane>.dsm-empty{flex:1;min-height:0}
.dsm-trash-split-pane>.dsm-empty{display:flex;align-items:center;justify-content:center}
/* 回收站的行**自己是一张卡**（border-l2 + radius-m + bg-layer-2）—— 与 MCP / 技能 / 记忆
   这些页面的列表行同款（.dsm-source）。裸 RowSelect 只有 hover 底色，落在回收站那块空底上
   像悬着：用户 2026-10-12 报「没有像其他页面的列表边框，看起来很杂乱、空，像悬浮一样」。
   ⚠️ 下面两条 hover / 选中 / 禁用态必须跟着写：上面那条两分类名与 .dsm-rowselect:hover
   同权重，只靠书写顺序取胜，会把 hover 底色一并盖掉。 */
.dsm-trash-list>.dsm-rowselect{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-trash-list>.dsm-rowselect:hover,.dsm-trash-list>.dsm-rowselect.dsm-rowselect-on{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-trash-list>.dsm-rowselect.dsm-rowselect-disabled:hover{background:var(--dsw-alias-bg-layer-2)}

/* ── 回收站「详情」（只读预览）───────────────────────────────────────────────
   用户 2026-10-12：「回收站的每条信息应该增加一个详情按键，点开就能看这个信息是什么样子，
   不能更改内容，没有保存按键」。整块自上而下三样：说明条（恒高）/ 可滚的内容区 / 「关闭」。
   内容区里一份文件一张卡（相对路径 + 大小在头，正文在下面），正文直接复用 .dsm-code
   —— 它已经是「等宽 + 280 上限 + 自己滚」的那一份，不再造第二种代码块画法。
   二进制 / 截断两种真实情况各有一条脚注（.dsm-preview-flag），如实标出来。 */
.dsm-preview{display:flex;min-width:0;min-height:0;flex-direction:column;gap:8px}
.dsm-preview-note{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsm-preview-files{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:auto;overscroll-behavior:contain}
.dsm-preview-file{display:flex;min-width:0;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsm-preview-file-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsm-preview-path{flex:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsm-preview-size{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.dsm-preview-file>.dsm-code{max-height:240px;border:0;border-radius:0}
.dsm-preview-flag{padding:4px 10px;border-top:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}

/* ── 场景编辑器（§6.2，新建/编辑/档案三弹窗融合）：XL=880 列表壳 + 四组 2×2 ──
   组容器用 bg-layer-1 底色圆角块分层、不画边框（深度靠表面层次，§13.1）。 */
.dsm-editor-name{display:flex;box-sizing:border-box;width:100%;min-height:30px;align-items:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.dsm-editor-summary{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;font-variant-numeric:tabular-nums}
/* 顶部**一行摆五格**（名称｜描述｜全局提示词｜快捷提示词｜工具表方案）：原先两行，
   第二行整行 56px + 12px 间距 —— 用户 2026-10-12「图2五部分还能压缩高度吗」。并到一行之后
   这一档省下来的高度全部让给四组（四组是恒定尺寸，见下面 grid-auto-rows）。
   2026-10-12 三轮配比（用户「场景名缩短、描述加长、其他三个也缩短、工具表方案并进这一行」
   →「描述继续加长，全局/快捷/工具表再缩短」→「场景名再缩短一点，加给描述」）：**五格 grow
   一律 1**，宽度只由 flex-basis 决定（grow 不等时基准与余量按不同比例分，配比会变得算不清）。
   1200 档实测约 场景名 145 / 描述 477 / 其余三格各 164（basis 之和 869 不变，只是把 38px
   从名称挪给描述 —— 总和不变 ⇒ 余量分配不变 ⇒ 渲染宽度就是各减 / 加 38，不是按比例缩）。
   用 flex-basis 而不是写死像素：屏幕窄时 flex-wrap 让它退回两行，不会把下拉压到看不清。 */
.dsm-editor-basics{flex-wrap:wrap}
.dsm-editor-basics>.dsm-field{flex:1 1 115px;min-width:0}
.dsm-editor-basics>.dsm-field:first-child{flex:1 1 96px}
.dsm-editor-basics>.dsm-field:nth-child(2){flex:1 1 428px}
/* 字段标签行：标题在左、行内动作在右（「快捷提示词」那格的「选择」入口）。
   align-items:center 而不是 baseline —— 右边是按钮，不是文字。 */
.dsm-label-row{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:8px}
/* 五格的标签行高度**一律钉在 18px**（含描述那格的字数计数），且行内按钮压到同一高度 ——
   格高必须只由标签决定、与按钮无关。用户 2026-10-12 报「换成自定义弹窗会跳动，因为
   快捷提示词和旁边没对齐」：.dsm-btn-quiet 的 min-height 是 24，比 12px 标签的行盒高，
   「选择」一出现就把这一格的标签行顶高 4px，下面的下拉被推下去，与其余四格错开。 */
.dsm-editor-basics .dsm-label,.dsm-editor-basics .dsm-char-count{line-height:18px}
.dsm-label-row .dsm-btn{min-height:18px;padding:0 6px;font-size:12px;line-height:16px}
/* 四组的高度：原先恒定 300px（大窗下没问题），小窗下弹窗整个顶出视口 —— 用户 2026-10-15
   「新建场景在小窗口模式下占大量面积，能不能等比例缩小，但有最小值」。
   现在按视口缩：除四组之外的固定开销实测 218px（标题行 + 顶部五格 + 动作行 + 内边距与间距），
   连同 12px 行间距一起从每半个视口里扣掉，就是每行能给到的高度；上限仍是 300（大屏一字不改）。
   扣掉的 360 比"刚好填满"（286）再多让出 74px —— 用户 2026-10-15 第二轮：小窗下填满整屏
   还是太大，弹窗该有自己的边距，不是贴满视口才算用得上空间。下限 150：再矮清单就只剩两三行。
   组内 .dsm-editor-group-body 本来就是 min-height:0 + 内滚，所以行矮下去不会把内容挤出去。 */
.dsm-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;grid-auto-rows:clamp(150px,calc((100vh - 360px) / 2),300px)}
/* 分组卡片补一圈 1px 描边（用户 2026-10-12：「浅色模式下四个功能集没有分块，全是白的」）。
   原设计是 §13.1 的"深度靠表面层次、不画边框"：卡片 bg-layer-1 比弹窗 bg-layer-2 高一档。
   但这条只在深色主题成立 —— 浅色下 layer-1 与 layer-2 都是白，卡片整块融进弹窗，
   四组 2×2 直接变成一片没有边界的白。诊断依据：弹窗内其他块（.dsm-control 五个输入框、
   .dsm-list 列表卡、.dsm-select-menu 下拉）全是"底色 + border-l2"双保险，只有这四组没描边。
   补上描边而不是继续调底色层级：layer 的具体灰度只有宿主自己知道，赌某一档在白底下
   能不能分辨是不可靠的；border-l2 在两个主题下都有定义（弹窗本身就靠它勾边）。
   深色下这条线极暗、与卡片底色接近，观感几乎无感；浅色下它就是唯一的分块依据。 */
.dsm-editor-group{display:flex;min-width:0;min-height:0;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-1)}
.dsm-editor-group-head{display:flex;min-height:24px;align-items:center;gap:8px}
.dsm-editor-group-title{min-width:0;overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsm-editor-group-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-editor-group-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}
/* 组体**撑满固定格子**（不再有 max-height）：四组的尺寸一律由 grid 那一行 300px 定，
   建没建段、勾了几条都不改变块大小 —— 用户 2026-10-12「这几个集应该固定大小，
   而不是一会大一会小」。条目超出就在组内滚（常驻细滚动条，见下面的共用规则）。
   ⚠️ 这里**不能**写 overscroll-behavior:contain（2026-10-12 修）：组体是 overflow:auto，
   即使没有可滚内容也仍然是一个 scroll container，contain 会把滚轮链锁死在这一层 ——
   鼠标停在四组上时滚轮完全没反应，只有指到弹窗右侧那条细滚动条上才滚得动
   （用户报「鼠标放在四个工具集或者滑动条外面会没办法上下滑动」）。
   不写（= auto）：组内先滚，滚到头再把余量交给弹窗外层 —— 嵌套滚动的正常行为。 */
.dsm-editor-group-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:auto}
.dsm-editor-group-body>*{flex:none}
/* 空态那一行在固定格子里居中：不然它顶在组头下面，下半截全是空的，看着像没渲染完。 */
.dsm-editor-group-body>.dsm-pick-empty{box-sizing:border-box;display:flex;flex:1;align-items:center;justify-content:center}

/* 新滚动容器共用一条常驻细滚动条（与头部历史区 .dsm-trash-box 等同一套观感）。 */
.dsm-trash-pane-scroll,.dsm-trash-split-pane>.dsm-trash-list,.dsm-editor-group-body{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsm-trash-pane-scroll::-webkit-scrollbar,.dsm-trash-split-pane>.dsm-trash-list::-webkit-scrollbar,.dsm-editor-group-body::-webkit-scrollbar{display:block;width:9px;height:9px}
.dsm-trash-pane-scroll::-webkit-scrollbar-track,.dsm-trash-split-pane>.dsm-trash-list::-webkit-scrollbar-track,.dsm-editor-group-body::-webkit-scrollbar-track{background:var(--dsw-alias-bg-layer-1)}
.dsm-trash-pane-scroll::-webkit-scrollbar-thumb,.dsm-trash-split-pane>.dsm-trash-list::-webkit-scrollbar-thumb,.dsm-editor-group-body::-webkit-scrollbar-thumb{border-radius:99px;background:var(--dsw-alias-border-l2)}
.dsm-trash-pane-scroll::-webkit-scrollbar-thumb:hover,.dsm-trash-split-pane>.dsm-trash-list::-webkit-scrollbar-thumb:hover,.dsm-editor-group-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}

/* ══ 页头（REDESIGN §3，2026-10-11 切片三）══════════════════════════
   三行：标题 + 描述 / 统计框 / 动作区。
   统计框在切片三被拆成标题行内联的一串数字，三个数字与一句长描述挤在同一行，
   描述只剩几个字（用户 2026-10-12 裁定恢复成框）；动作区曾与标题同排，同样把
   描述压成省略号（2026-10-11 退回单独一行）—— 描述才是页头要说的话。 */
.dsm-head{gap:12px}
.dsm-head-main{display:flex;min-width:0;align-items:baseline;gap:12px}
.dsm-head-desc{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
/* 统计框：一个描边容器内 N 格等分（各页 2-3 条），格间 1px 分隔线，数字与量词同排。 */
.dsm-head-stats{display:flex;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-head-stat{display:flex;flex:1;min-width:0;align-items:baseline;gap:4px;padding:6px 12px;border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden}
.dsm-head-stat:last-child{border-right:0}
/* 统计格里的标签（2026-10-12 改成标签在前、值在后）：深灰 12px，可收缩截断；
   值（.dsm-head-num）恒不收缩 —— 宁可截标签也不能截数字。 */
.dsm-head-stat-label{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap}
/* 统计格的「超限」态（记忆页把注入预算搬进第三格）：数字与标签一起转错误色。
   不复用别处的超限类 —— 它们各有各的落点与附带样式，统计格要的是整格同转。 */
.dsm-head-stat.dsm-stat-over,.dsm-head-stat.dsm-stat-over .dsm-head-num{color:var(--dsw-alias-state-error-primary)}
/* 统计格的「值」：与标签同式（2026-10-12 用户裁定，两步）—— 先定「数字不再放大加粗、
   与汉字同式」，再定「同式就同深灰，不用弱灰」：深灰 12px、正常字重，字号行高随
   .dsm-head-stat 继承，与 .dsm-head-stat-label 视觉一致。只保留两条差异：
   flex:none（值恒不收缩，见上）与 tabular-nums（等宽数字，"315/131072 B"
   这类混排读数才对得齐）。 */
.dsm-head-num{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 页头动作行里的 quiet 按钮：与同排的实底/描边按钮**同高**（30px，铁律「同一组按钮
   必须同高」），只弱化视觉（无底无框、次级字色），不缩小 —— 24px 的 quiet 是列表行
   与弹窗内小件的档位，混排会让页头一行高矮不齐。 */
.dsm-actions .dsm-btn-quiet{min-height:30px;padding:0 12px;font-size:13px;line-height:20px}
/* 状态点 6px（§3.4）：行状态点与体检点同一规格；颜色语义照旧走 .dsm-dot-*。 */
.dsm-dot{width:6px;height:6px}
/* 列表工具条（§3.3）：搜索 / 筛选与批量动作同层；批量动作靠右成组，
   「出现选中时才有的批量按钮」也落在这组里，不再回页头。
   记忆页的「全选」与预算都已上移页头（2026-10-12）；会话页那两颗
   「恢复所选 / 删除所选」同日也上移到页头「全选」旁边 —— 全站已无使用者，
   机制先留着（Toolbar 的 batch 槽与这个外壳类都还在，哪个页面要用直接传）。 */
.dsm-toolbar-batch{display:flex;flex:none;align-items:center;gap:8px}
/* 窄栏回归纵向堆叠：上一段把 .dsm-head 改成了一行，这里在容器 ≤520px 档把它改回来
   （与头部历史区那条 @container 同阈值；本条写在后面，同权重后写覆盖前写）。 */
/* 窄栏 600px 档的压缩要能管住 quiet 按钮：上面那条 .dsm-actions .dsm-btn-quiet 同权重
   且写在历史区之后，会把压缩盖掉 —— 在这里按同档补一份（后写覆盖前写）。 */
@container(max-width:600px){.dsm-actions .dsm-btn-quiet{padding:0 8px;font-size:12px}}
@container(max-width:520px){.dsm-head-main{flex-direction:column;align-items:stretch;gap:2px}}

/* ══ 列表行（REDESIGN §3.4，2026-10-11 切片四）══════════════════════════
   48px 两行制：行1 状态点 + 名称(13/600) + 至多 1 个「需要处理」tag；行2 元信息(12 弱色)。
   去卡片：行不再各自描边成卡 —— 容器（.dsm-list 或分组卡 .dsm-source）包住整份列表，
   行间用 1px 分隔线；次级动作常驻 quiet 24px 右对齐，删除类 quiet-danger（§3.4）。 */
.dsm-list{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsm-radius-m);background:var(--dsw-alias-bg-layer-2)}
.dsm-listrow{box-sizing:border-box;display:flex;min-height:48px;align-items:center;gap:8px;padding:4px 12px}
.dsm-listrow + .dsm-listrow{border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-listrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 状态点单独一列：名称与元信息从同一竖线起步。点挂在名字前面会造出「名称比描述
   右移一格」的错位（.dsm-dot-indent 当初修的就是它），拎出主列后两行天然对齐；
   min-width 6px 让带 tag 的行（点槽留空）与带点的行左缘也齐平。 */
.dsm-listrow-dots{display:flex;min-width:6px;flex:none;align-items:center;justify-content:center;gap:4px;align-self:stretch}
.dsm-listrow-main{display:flex;min-width:0;flex:1;flex-direction:column;justify-content:center;gap:4px}
.dsm-listrow-name-row{display:flex;min-width:0;align-items:center;gap:6px}
.dsm-listrow-name{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.dsm-listrow-name-row .dsm-tag{flex:none}
/* 行2 元信息：12px 弱色单行省略；数字（工具数 / 体积 / 时间）tabular-nums（§13.4）。 */
.dsm-listrow-meta{display:flex;min-width:0;align-items:baseline;gap:4px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsm-listrow-meta:empty{display:none}
.dsm-listrow-meta-desc{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsm-listrow-meta-info{flex:none;color:var(--dsw-alias-label-tertiary)}
/* 技术值（路径 / id）排印（§2.3）：与普通文案在字形上区分，不靠颜色。 */
.dsm-listrow-meta .dsm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dsm-listrow-side{display:flex;flex:none;align-items:center;gap:8px}
.dsm-listrow-actions{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:4px}
/* 行2 之下的追加内容（体检结果 / ⚠ 提示 / 被覆盖说明）原本按表格网格留白，
   两行制里由主列 gap 接管，各自的 margin-top 归零。 */
.dsm-listrow .dsm-row-hint,.dsm-listrow .dsm-rule-hint,.dsm-listrow .dsm-rule-shadow-hint{margin-top:0}
.dsm-listrow .dsm-row-hint{margin:0}
/* 分组卡上的行状态着色随行类名改版补一份（原选择器钉在 .dsm-name / .dsm-note 上）。 */
.dsm-rule-shadowed .dsm-listrow-name,.dsm-rule-shadowed .dsm-listrow-meta{color:var(--dsw-alias-state-error-primary)}
.dsm-rule-off .dsm-listrow-name,.dsm-rule-off .dsm-listrow-meta{color:var(--dsw-alias-label-tertiary)}
/* 技能页来源组头吸顶（切片三移交）：滚动长列表时组名 + 计数 + 组内全选留在视野内。
   overflow:clip 与 hidden 视觉相同但**不产生滚动容器** —— sticky 才能对页面滚动条生效
   （hidden 会把 sticky 关进卡片自己的滚动口，等于失效）；:has 限定到带 pin 头的卡片，
   其余卡片一字不动。top 对齐页签条（sticky top:0）下缘：2px 上内边距 + 34px 页签 +
   1px 分隔线；页签条 z-index 6，组头 5，吸住时从其下方滑过。宿主换滚动结构时 sticky
   只是不触发（组头留在原位），不会错位。 */
.dsm-source:has(> .dsm-source-head-pin){overflow:clip}
.dsm-source-head-pin{position:sticky;z-index:5;top:37px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsm-source:has(> .dsm-source-head-pin) > .dsm-source-body{border-top:0}
/* ── 切片五·控件层（REDESIGN §5，2026-10-11）────────────────────────────────── */
/* 设置行 SettingsRow（§5.2/§13.2，macOS 设置窗模式）：label 左对齐、控件右对齐，
   行间分隔线分节；desc 跟在名字下一行，行随内容长高。用于兼容页令牌块 / 注入设置 /
   子智能体表单开关行。 */
.dsm-setrow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;padding:4px 0}
.dsm-setrow+.dsm-setrow{border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-setrow-label{display:flex;min-width:0;flex-direction:column;gap:1px}
/* 名字行：名字与状态标签（tag）同一行，垂直居中（用户裁定 2026-10-15：兼容页斜杠行的
   「已生效 / 未生效」从开关旁挪到名字右边 —— 状态跟着名字读；标签是 pill，flex 居中
   才与 13px 的名字真正上下对齐，基线对齐会偏上一截）。 */
.dsm-setrow-nameline{display:flex;min-width:0;align-items:center;gap:6px}
.dsm-setrow-nameline>.dsm-setrow-name{min-width:0}
.dsm-setrow-name{overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.dsm-setrow-desc{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.dsm-setrow-control{display:flex;flex:none;align-items:center;gap:8px}
.dsm-setrow .dsm-btn{min-width:92px}
/* RowCheck：框本身是控制件（button）—— 去按钮默认内边距、给禁用态；选中态与
   RowSelect 的选中框同款主色实底（原规则钉在 .dsm-rowselect-on 父级上，独立框用这
   条直接落在框上）。 */
button.dsm-rowselect-box{padding:0;cursor:pointer;font:inherit}
button.dsm-rowselect-box:disabled{cursor:default;opacity:.45}
.dsm-rowselect-box-on{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}
/* 次级按钮 hover（§5 按钮表：hover = interactive-bg-hover）。 */
.dsm-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
/* 图标箭头（CaretIcon）：替代 ▾/▸ 文字字形后统一 12px 方格（原规则按文字宽度写的
   10px/12px 会被 svg 的属性宽度顶掉，这里统一钉住）。 */
.dsm-mode-caret,.dsm-pick-caret{width:12px;height:12px;flex:none;color:var(--dsw-alias-label-tertiary)}
/* 快照导入预览：行选择纵向堆叠（原为横向勾选 chips，切片五换 RowSelect）。 */
.dsm-snap-picks{display:flex;flex-direction:column;gap:2px}
`