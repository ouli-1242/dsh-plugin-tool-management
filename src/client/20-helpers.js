
    /** 统一的异常文案：Error 取 message，其余（字符串/对象/null）原样 String。此前 63 处各写一遍。 */
    function errMsg(e) { return e && e.message ? String(e.message) : String(e) }

    /**
     * 导入 / 导出的默认目录。**它不是常量，也不该由客户端猜**。
     *
     * 用户 2026-10-12 问：「这个路径是每个人的机器都不同吗，如果是其他用户呢，如果是 Linux
     * 或者 mac 系统呢」—— 是的，全都不一样：Windows 是 `C:\Users\<用户名>\Desktop`，
     * macOS 是 `/Users/<用户名>/Desktop`，Linux 常见 `/home/<用户名>/Desktop` 且**桌面目录
     * 未必存在**。上一版把某一台机器上的 `C:\Users\ouli\Desktop` 写死在这里，等于给所有其他
     * 用户、所有非 Windows 系统填了一个**不存在的路径** —— 导出会直接失败在 mkdir 上。
     *
     * 所以初值由**宿主**给（`history-export-defaults`：桌面存在就用桌面，否则退回主目录，
     * 两处都用 `os.homedir()`，天然跟着"跑宿主的那台机器 + 那个用户"走），客户端只在本地
     * 缓存一份，供各处输入框的初值与占位符同步取用。
     *
     * **一处缓存、多处引用**：整机迁移导出目录、快照位置、会话导出目录、MCP JSON 导出目录、
     * 技能自定义来源目录 —— 五个入口都取这一份。它同时充当**占位符**（输入框空着时显示的那串
     * 灰字）：这是路径不是文案，所以不走 i18n 词典 —— 中英两侧显示同一串字符本来就是对的。
     *
     * 缓存没到之前是空串：宁可空着让人自己填 / 点「选择」，也不要写死一个别人机器上
     * 不存在的路径。`loadDefaultIoDir` 在 apply 启动时跑一次，用户真正打开这些弹窗时
     * 早就到位了（兼容页那两处另有一次回填兜底，见 22 片）。
     */
    var ioDefaultDir = ''
    /** 当前缓存的默认目录（没取到就是空串）。 */
    function defaultIoDir() { return ioDefaultDir }
    /** 取一次默认目录并缓存；失败 / 宿主没给就保持原样（不覆盖已有值）。 */
    function loadDefaultIoDir() {
      return apiCall('history-export-defaults', {}).then(function (r) {
        if (r && r.ok && typeof r.defaultDir === 'string' && r.defaultDir) ioDefaultDir = r.defaultDir
        return ioDefaultDir
      }).catch(function () { return ioDefaultDir })
    }

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
     * 宿主官方目录选择通道（`uiWorkspace.pickDirectory()`）的槽位。
     *
     * 实现由 apply 注入（那里才有 ctx），放在**模块作用域**是因为兼容页在 apply 之外 ——
     * 引用 apply 内的声明就是渲染期 ReferenceError（与 PageHead / ModalCloseButton 同一条
     * 边界）。宿主侧的契约：服务是 `ctx.directoryPicker` 的 Remote 面，后端分两种 ——
     * `native` 在宿主机上开一次系统文件夹框并回绝对路径；`browse` 只给列目录原语
     * （宿主没绑回环 / 没有可见桌面时，远端浏览器根本没有系统框可开），没有 pick 可调。
     */
    /** @type {null | (() => Promise<string|null>)} */
    var hostPickDirectory = null
    function setHostPickDirectory(fn) { hostPickDirectory = typeof fn === 'function' ? fn : null }
    /**
     * 「选择目录 / 浏览」的唯一入口：能开系统框就开系统框，开不了才回到调用方自备的
     * 应用内目录列表（`DirPickerModal`）。
     *
     * 三种不弹错的情况：服务缺席、后端是 browse（调用抛错）→ 走 `onFallback`；
     * 用户在系统框里按了取消（回 null）→ 什么都不做 —— 接着再弹一层应用内列表，
     * 比直接失败更烦。
     */
    function requestHostDirectory(onPath, onFallback) {
      if (!hostPickDirectory) { if (onFallback) onFallback(); return }
      Promise.resolve().then(hostPickDirectory).then(function (path) {
        if (path) onPath(String(path))
      }).catch(function () { if (onFallback) onFallback() })
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

    // `react` / `h` 别名（2026-10-11 切片五从 42 片上移）：工厂作用域声明对 apply 内外
    // 都可见 —— 42 片与各页照常用，兼容页与新落在本片的共用控件（RowCheck /
    // SettingsRow / Switch / SourceSelect）也用同一套。`var` 在 factory 作用域提升，
    // 42 片原文引用处不用改一个字。
    var react = React
    var h = React.createElement

    /**
     * 展开箭头（REDESIGN §12.5 caret）：替代散落的 ▾ / ▸ 文字字形 —— 文字箭头随字体走，
     * 基线与粗细都不齐；图标 12px 线性 1.5，与全站图标同规格。收起朝右、展开朝下。
     */
    function CaretIcon(props) {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false', className: props && props.className },
        h('path', { d: props && props.open ? 'M4 6L8 10L12 6' : 'M6 4L10 8L6 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    }

    /**
     * 行选择的自绘框（REDESIGN §5.1）：14px 框（radius-s），选中 = 主色实底 + 白勾
     * （1.5 线性）。RowSelect（42 片）是「整行」版；本组件只渲染**框本身**，给「行主
     * 点击另有归属、勾选挂在行首」的场景用（会话列表行首、组头全选、兼容页工具表 /
     * JSON 导入预览行）。框是 `role="checkbox"` 的 button —— 键盘 Space/Enter 原生可发，
     * 读屏读名字（label 必填）。点框 `stopPropagation`：外层行自己的点击（如打开会话）
     * 不该被勾选连带触发。
     * props：checked / disabled / label（aria-label 与 title 同源）/ onChange。
     */
    function RowCheck(props) {
      var toggle = function () { if (props.disabled !== true && props.onChange) props.onChange() }
      return h('button', {
        type: 'button',
        className: 'dsm-rowselect-box' + (props.checked ? ' dsm-rowselect-box-on' : ''),
        role: 'checkbox', 'aria-checked': props.checked === true,
        disabled: props.disabled === true,
        'aria-label': props.label, title: props.label,
        onClick: function (e) { e.stopPropagation(); toggle() },
      },
        props.checked ? h('svg', { viewBox: '0 0 12 12', width: 10, height: 10, focusable: 'false', 'aria-hidden': 'true' },
          h('path', { d: 'M2.5 6.5L5 9L9.5 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) : null)
    }

    /**
     * 设置行（REDESIGN §5.2/§13.2，macOS 设置窗模式）：label 左对齐、控件右对齐、
     * 行间分隔线分节（`.dsm-setrow + .dsm-setrow`）。label 可带一句 desc（12 弱色，
     * 跟在名字下一行 —— 行随内容长高）；descTitle 给截断的 desc 悬浮全文。
     * 用于兼容页令牌块 / 注入设置 / 子智能体表单开关行这一类「名字 + 一个控件」的行。
     * props：name / desc / descTitle / control（右侧控件，通常是 Switch）/ title。
     */
    function SettingsRow(props) {
      return h('div', { className: 'dsm-setrow', title: props.title || undefined },
        h('div', { className: 'dsm-setrow-label' },
          h('span', { className: 'dsm-setrow-name' }, props.name),
          props.desc ? h('span', { className: 'dsm-setrow-desc', title: props.descTitle || undefined }, props.desc) : null),
        h('div', { className: 'dsm-setrow-control' }, props.control || null))
    }

    /**
     * 开关（REDESIGN §5.2）：32×18，on = success 色，`role="switch"`。
     * 2026-10-11 切片五从 42 片上移：兼容页的原生勾选框（斜杠入口 / 注入域 / 快照）
     * 要换成开关，而兼容页在 apply 之外看不到 42 片的声明。
     */
    function Switch(props) { return h('button', { type: 'button', className: 'dsm-switch' + (props.on ? ' dsm-switch-on' : ''), role: 'switch', 'aria-checked': props.on, 'aria-label': props.label, title: props.title, disabled: props.disabled, onClick: props.onClick }); }

    /**
     * 下拉菜单的高度上限，**必须与 CSS 里 .dsm-select-menu 的 max-height 一致** ——
     * SourceSelect 用它算「下方装不装得下」，算错了就会把菜单翻到装不下的一侧（见该函数内注释）。
     */
    var MENU_MAX_H = 260

    /**
     * 下拉 SourceSelect（REDESIGN §5.2）：自绘 listbox —— 触发器 h30、菜单 radius-m
     * 描边、空间不足自动上弹（量触发器到视口 / 滚动容器底边的距离）。八页与兼容页
     * 的下拉只此一种；原生 `<select>` 一律收编到此（切片五）。
     * 2026-10-11 切片五从 42 片上移（兼容页审计筛选要用），并补两件事：
     *   · `disabled` —— busy / loading 时触发器禁用且不弹菜单（原实现没有这一态，
     *     各页只能整块不渲染或换原生件）；
     *   · 选项级 `title` —— 子智能体思考强度等选项的悬停说明跟着走（原 `<option title>`）。
     * 2026-10-12 菜单改 `position:fixed`（定位/高度全部内联算）：absolute 会被弹窗的
     * `overflow:hidden` 裁掉，回收站保留期那种"短正文 + 菜单在最顶上"的场合会被裁得只剩
     * 几个像素（用户报「点击一闪而过」）。fixed 以视口为参照，不受任何祖先裁剪。
     * props：options [{value,label,title?}] / value / onChange / disabled? / ariaLabel? / className?。
     */
    function SourceSelect(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], selected = props.options.find(function (o) { return o.value === props.value; }) || props.options[0] || { label: '' }, ref = react.useRef(null);
      // 菜单的定位与高度，**视口坐标**（`{left,width,top,bottom,maxHeight}`，top/bottom 二选一）。
      // null = 还没量过（只在打开的那一帧出现，见下面的兜底样式）。
      var posState = react.useState(null), pos = posState[0], setPos = posState[1];
      /**
       * 量一次触发器的位置，算出菜单该放哪儿、能有多高。
       *
       * 为什么用 `position:fixed` 而不是原来的 `position:absolute`（2026-10-12 用户报
       * 「子智能体的回收站保留期点击一闪而过，没办法持久展示」）：回收站弹窗的
       * `.dsm-modal-body` 是 `overflow:hidden`（它要让内层 `.dsm-trash-pane-scroll` 独占滚动），
       * 而保留期选择器在**弹窗正文最顶上**、下面留给菜单的空间由列表长度决定 —— 列表短时
       * 整个菜单都被裁掉，只剩几个像素，看起来就是"点一下闪一下"。fixed 定位以视口为参照，
       * 不被任何祖先的 overflow 裁剪（本插件没有任何祖先带 transform/filter，所以成立；
       * `.dsm-toast` / `.dsm-token-banner` 早就在用 fixed，同一条前提），于是可用空间
       * 直接按**视口**算，不再受那个短容器限制。
       *
       * 上下方向仍按"下方装不下且上方更宽裕才上翻"判；高度夹到那一侧的可用空间（内联
       * max-height），夹住之后菜单自己滚 —— 而不是溢出后被裁。
       */
      function measure() {
        var el = ref.current;
        if (!el) return;
        var box = el.getBoundingClientRect();
        var need = Math.min(props.options.length * 34 + 14, MENU_MAX_H);
        var gap = 4;
        var below = window.innerHeight - box.bottom - gap - 8;
        var above = box.top - gap - 8;
        var nextUp = below < need && above > below;
        var next = {
          left: box.left, width: box.width, up: nextUp,
          top: nextUp ? null : box.bottom + gap,
          bottom: nextUp ? window.innerHeight - box.top + gap : null,
          maxHeight: Math.max(96, Math.min(need, nextUp ? above : below)),
        };
        // 位置没变就别换新对象（滚动时每次都换会让整个菜单重渲染一遍）。
        setPos(function (prev) {
          return prev && prev.left === next.left && prev.width === next.width && prev.top === next.top && prev.bottom === next.bottom && prev.maxHeight === next.maxHeight ? prev : next;
        });
      }
      react.useEffect(function () { if (!open) return undefined;
        measure();
        function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); }
        document.addEventListener("pointerdown", close);
        // 打开期间窗口一动（滚 / 缩放）就重新量 —— fixed 菜单不会跟着触发器走。
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return function () {
          document.removeEventListener("pointerdown", close);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        }; }, [open]);
      var menuStyle = pos
        ? {
          position: "fixed", left: pos.left + "px", right: "auto", width: pos.width + "px",
          top: pos.top === null ? "auto" : pos.top + "px",
          bottom: pos.bottom === null ? "auto" : pos.bottom + "px",
          maxHeight: pos.maxHeight + "px",
        }
        // 还没量到（打开的那一帧）先挪到屏幕外，免得在 0,0 闪一下。
        : { position: "fixed", left: "-9999px", top: "-9999px", maxHeight: MENU_MAX_H + "px" };
      return h("div", { className: "dsm-select" + (props.className ? " " + props.className : ""), ref: ref },
        h("button", { type: "button", className: "dsm-select-trigger", "aria-haspopup": "listbox", "aria-expanded": open, "aria-label": props.ariaLabel || undefined, disabled: props.disabled === true, onClick: function () { if (props.disabled === true) return; if (!open) measure(); setOpen(!open); } }, h("span", null, selected.label)),
        open ? h("div", { className: "dsm-select-menu", role: "listbox", style: menuStyle }, props.options.map(function (o) { return h("button", { key: o.value || "all", type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, title: o.title || undefined, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }

    /**
     * 行选择 RowSelect（REDESIGN §5.1，替换原生勾选框）：整行可点切换、行首 14px 自绘框
     * （radius-s，1px 边框 l2），选中 = 主色实底 + 白勾（1.5 线性）；选中行 hover 底色常驻。
     * 键盘：行可聚焦（Space/Enter 切换）。role="checkbox" + aria-checked 挂在**行**上 ——
     * 行才是可点目标；14px 的框是纯视觉（aria-hidden），给它挂 role 只会造出第二个
     * 不可聚焦的 checkbox。动作槽里的按钮自己 stopPropagation，点动作不翻勾。
     * props：checked / disabled / name / desc / descTitle / meta / actions / onChange / key。
     * 2026-10-11 切片五从 42 片上移：快照导入预览（兼容页）也要用行选择。
     */
    function RowSelect(props) {
      var disabled = props.disabled === true
      var toggle = function () { if (!disabled && props.onChange) props.onChange() }
      return h('div', {
        className: 'dsm-rowselect' + (props.checked ? ' dsm-rowselect-on' : '') + (disabled ? ' dsm-rowselect-disabled' : ''),
        role: 'checkbox', 'aria-checked': props.checked === true, 'aria-disabled': disabled || undefined,
        tabIndex: disabled ? -1 : 0,
        onClick: toggle,
        onKeyDown: function (e) {
          if (disabled) return
          if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') { e.preventDefault(); toggle() }
        },
      },
        h('span', { className: 'dsm-rowselect-box', 'aria-hidden': 'true' },
          props.checked ? h('svg', { viewBox: '0 0 12 12', width: 10, height: 10, focusable: 'false' },
            h('path', { d: 'M2.5 6.5L5 9L9.5 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) : null),
        h('span', { className: 'dsm-rowselect-main' },
          h('span', { className: 'dsm-rowselect-name' }, props.name),
          props.desc ? h('span', { className: 'dsm-rowselect-desc', title: props.descTitle || undefined }, props.desc) : null),
        props.meta ? h('span', { className: 'dsm-rowselect-meta' }, props.meta) : null,
        props.actions ? h('span', { className: 'dsm-rowselect-actions', onClick: function (e) { e.stopPropagation() }, onKeyDown: function (e) { e.stopPropagation() } }, props.actions) : null)
    }

    /**
     * 页头（REDESIGN §3.1 + §3.2.6，2026-10-11 切片三）：三行 ——
     *   行1  标题(18/600) + 描述(12 弱色，单行截断，全文进 title)
     *   行2  动作区（左对齐）
     *   行3  统计框（一个描边容器内三格，数字 15/600 + 量词 12）
     *
     * 统计框在切片三曾被拆成「标题行内联一串」：三个数字与一句长描述挤在同一行，
     * 描述只剩几个字（用户 2026-10-12 裁定恢复成框）。动作区同理不挤第一行 ——
     * 三颗按钮并到标题右侧会把描述压成省略号。统计框在动作区之下：读数贴着它描述的
     * 那张列表，按钮贴着页头（用户 2026-10-12 定的顺序）。没有统计的页（兼容）不出第三行。
     *
     * props：`title`（页名）/ `desc`（完整描述，进 title）/ `stats`（[数字, 量词] 二元组数组，
     * 量词沿用各页既有 stat 键）/ `actions`（动作按钮数组，顺序由调用方按 §3.2 排）。
     * 2026-10-11 切片五从 42 片上移：兼容页（apply 之外）的单行页头也要用它 ——
     * apply 侧声明对 factory 作用域不可见，放那边就是渲染期 ReferenceError、白屏
     * （与下方弹窗键盘行为、ModalCloseButton 同一条边界；切片三落错了地方）。
     */
    function PageHead(props) {
      var stats = props.stats || []
      var desc = props.desc || ''
      return h('div', { className: 'dsm-head' },
        h('div', { className: 'dsm-head-main' },
          h('h2', { className: 'dsm-title' }, props.title),
          desc ? h('span', { className: 'dsm-head-desc', title: desc }, desc) : null),
        (props.actions && props.actions.length) ? h('div', { className: 'dsm-actions' }, props.actions) : null,
        // 统计格是 `[值, 标签, 附加类名?]` 三元组：第三位可选（记忆页的注入预算超限要转错误色，
        // 见 .dsm-head-stat.dsm-stat-over）。不给就是原样的两元组。
        // **标签在前、值在后**（2026-10-12）：指标从"N 个服务"改成"服务 0/7"这种比例口径后，
        // 值在前会被读成"0/7 个服务"（像是分数的量词），标签在前才读得通。
        // 标签可收缩（长标签先截断），值恒不收缩 —— 数字被截比标签被截严重得多。
        stats.length ? h('div', { className: 'dsm-head-stats' }, stats.map(function (s, i) {
          return h('div', { key: i, className: 'dsm-head-stat' + (s[2] ? ' ' + s[2] : '') },
            h('span', { className: 'dsm-head-stat-label' }, s[1]),
            h('b', { className: 'dsm-head-num' }, s[0]))
        })) : null)
    }

    /* ── 弹窗键盘行为（Modal 与兼容页的手工弹窗共用）──────────────────────────────
       放在**模块作用域**而不是 `apply` 里：兼容页（CompatPage）在 apply 之外，它的
       「清理旧备份」弹窗不能引用 apply 内的任何东西（引用了就是渲染期 ReferenceError、
       整个设置面板白屏，2026-09-19 真踩过）。这三个函数只吃参数与 document，没有闭包
       依赖，挪出来对 `Modal` 毫无影响。 */
    function modalFocusable(modal) { return Array.prototype.slice.call(modal.querySelectorAll("button:not(:disabled), [href], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])") || []); }
    function trapModalFocus(modal, event) { if (event.key !== "Tab") return; var focusable = modalFocusable(modal); if (!focusable.length) return; var active = document.activeElement; if (!modal.contains(active) || (event.shiftKey ? active === focusable[0] : active === focusable[focusable.length - 1])) { event.preventDefault(); (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus(); } }
    function handleModalEscape(event, onClose) { if (event.key !== "Escape") return false; event.preventDefault(); event.stopPropagation(); if (event.nativeEvent && typeof event.nativeEvent.stopImmediatePropagation === "function") event.nativeEvent.stopImmediatePropagation(); onClose(); return true; }

    /**
     * 弹窗右上角的 X 图标钮（REDESIGN §4.3，全站唯一一种头部）。
     * 落在 **factory 作用域**（本片）而不是 42 片的共享组件区：兼容页（22 片，apply 之外）
     * 的四枚手工弹窗也用它 —— apply 作用域的声明对 factory 作用域不可见，放那边就是
     * 渲染期 ReferenceError（与上面两个键盘 helper 同一条边界，2026-10-11 切片四修正：
     * 切片二把它落在了 42 片，兼容页一开弹窗就会炸）。
     * 读屏读不到字形，aria-label / title 都取调用方传进来的「关闭」文案（Modal.closeLabel）。
     * 16px 线性、1.5 粗细、currentColor（§12.5 close 图标）。
     */
    function ModalCloseButton(props) {
      return React.createElement('button', { type: 'button', className: 'dsm-modal-close', 'aria-label': props.label, title: props.label, onClick: props.onClick },
        React.createElement('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: 'false' },
          React.createElement('path', { d: 'M4 4L12 12M12 4L4 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' })))
    }

    // ── 访问令牌（用户裁定 2026-09-18）────────────────────────────────────────────
    // 三条要求：① 宿主没配时能在面板里设置；② 已配时，填对令牌就能关掉整个令牌功能；
    // ③ **填一次只管本次进程** —— DSH 退出再启动就要重填。
    //
    // ③ 靠"和宿主本次启动的标识绑定"实现：宿主在 `token-status` 里回 `bootId`（pid + 进程
    // 启动时刻，同一进程内恒定），这里把填过的令牌连同当时的 bootId 一起存；启动引导时
    // 读到的 bootId 变了，就把存的那份**丢掉并要求重填**。
    //
    // 为什么不用 sessionStorage：它的生命周期跟**浏览器标签页**走，而要求是跟**DSH 进程**走 ——
    // 同一个标签页里重启 DSH 会错误地免填，关掉标签页重开又会在同一次运行里错误地要求重填。
    //
    // legacy 键（'dsh-plugin-tool-management-token' / 'dsh-skill-mcp-manager-token'）里存的是
    // 裸令牌、没有 bootId，无法判断它属于哪次启动 —— 按"过期"处理并删除。这正是 ③ 要的语义：
    // 升级后第一次启动需要重填一次，此后每次启动都要重填。
    const TOKEN_RECORD_KEY = 'dsh-plugin-tool-management-token-record'
    const LEGACY_TOKEN_KEYS = ['dsh-plugin-tool-management-token', 'dsh-skill-mcp-manager-token']
    let TOKEN = ''
    /** 引导（读 bootId、决定要不要恢复已填的令牌）只做一次。 */
    let tokenBootstrap = null

    function readStoredToken() {
      try {
        const raw = window.localStorage.getItem(TOKEN_RECORD_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.token !== 'string' || typeof parsed.bootId !== 'string') return null
        return parsed
      } catch (e) { return null }
    }

    function writeStoredToken(bootId, token) {
      try {
        if (token && bootId) window.localStorage.setItem(TOKEN_RECORD_KEY, JSON.stringify({ bootId, token }))
        else window.localStorage.removeItem(TOKEN_RECORD_KEY)
        for (const legacy of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(legacy)
      } catch (e) { /* storage unavailable */ }
    }

    // 跨标签页联动（storage 事件只在**其它**标签页触发，正好）：A 标签页「清除令牌」之后，
    // B 标签页内存里那串还揣着 —— 它的轮询请求会一直带着旧令牌的请求头，把宿主侧刚用
    // token-unaccept 重新挂上的闩又置回去。所以记录一被删，本页内存令牌立即作废；
    // 这页的输入框锁要等下一次 token-status 判定才会跟上，期间宿主侧门禁兜底。
    try {
      window.addEventListener('storage', function (ev) {
        if (ev.key !== TOKEN_RECORD_KEY || !TOKEN) return
        if (readStoredToken() === null) { TOKEN = ''; clearTokenGate() }
      })
    } catch (e) { /* storage 不可用（极端环境）→ 只是少了跨标签联动 */ }

    /** 当前进程的标识；引导之前是空串（此时不会拿它去匹配任何东西）。 */
    let BOOT_ID = ''

    function setAccessToken(value, bootId) {
      TOKEN = String(value || '').trim()
      writeStoredToken(bootId === undefined ? BOOT_ID : bootId, TOKEN)
      // 用户刚提交了令牌（或清掉）→ 把"令牌没过"的提示收起来。填错了的话，下一次被拒
      // 会立刻重新出现 —— 提示的存续规则是"用户动作能改它，别的都不能"。
      clearTokenGate()
      return TOKEN
    }

    // ── 令牌没填 ⇒ 锁住输入框（用户裁定 2026-09-19）───────────────────────────
    // 口径：本次进程里令牌**在生效**（`active`）且本机这串**没验过**（`!accepted`）。
    // 关掉保护时 `active` 为 false ⇒ 不锁 —— 与写门禁同一口径（见 request-gate.ts）。
    //
    // 为什么这件事得由客户端做：对话走 DSH 自己的 agent / session 通路，而插件的令牌门禁
    // 挂在 `/dsh-plugin-tool-management/api` 上 —— 两条路互不相干，令牌配了、没填，对话
    // 照样通、各域注入照样进上下文。宿主在客户端留了官方口子：`ctx.conversation.blocks`
    // （ComposerBlocks 的注释原文是 "the one way another plugin stops a session's input"），
    // 挂上去的 `reason` 直接当输入框占位文案。
    //
    // 状态放 factory 作用域而不是 apply 里：兼容页的 `applyTokenState` 也要能更新它 ——
    // 用户填对令牌之后锁必须立刻解除，而那条路径在 CompatPage 组件里。
    let tokenLocked = false
    let tokenLockListener = null
    /**
     * 设定锁态。值没变就不通知 —— `token-status` 会被反复拉取（进兼容页、每次提交令牌），
     * 重复通知等于反复给输入框挂/撤锁。
     * @param locked 是否应当锁住输入框。
     */
    function setTokenLock(locked) {
      const next = locked === true
      if (next === tokenLocked) return
      tokenLocked = next
      if (tokenLockListener) { try { tokenLockListener(next) } catch (e) { /* 界面接线失败不影响判定本身 */ } }
    }
    /**
     * 注册锁态监听（apply 侧挂一次）。
     *
     * 注册时**立刻回调一次当前值**：apply 先注册、`token-status` 后回来，但顺序反过来时
     * （apply 重跑）也得把当前锁态补上。只留一个槽位：apply 可能被重跑，数组会积压监听。
     * @param fn 收到锁态的回调。
     */
    function onTokenLockChange(fn) {
      tokenLockListener = fn
      try { fn(tokenLocked) } catch (e) { /* 同上 */ }
    }
    /**
     * 一份 `token-status` 回包 → 两件界面状态（"去填令牌"那句提示 + 输入框锁态）。
     *
     * **口径只有这一处**：兼容页的 `applyTokenState` 与横幅的填写弹窗都调它。两边各自抄一份
     * 判据的话，同一个响应会判出不同结论 —— 而这两个结论都直接决定"用户能不能发消息"，
     * 分歧的表现是"弹窗说对了、输入框还锁着"这类看不出所以然的故障。
     *
     * 两条规则（与 2026-09-19 的裁定同源，注释随判据一起搬过来）：
     *   ① 收掉那句"去填令牌"：宿主认可了本机这串 ⇒ 用户已经填对了；或者当前进程里令牌
     *      **没在生效**（关掉了 / 从来没配）⇒ 那句话已无处可填，留着就是在说一件不存在的事。
     *   ② 锁态 = 在生效且本机这串没验过。与写门禁同一口径（见 request-gate.ts）。
     * @param r `token-status` 的回包；非 ok 一律不动（读不到 ≠ 解锁）。
     */
    function applyTokenStatusSideEffects(r) {
      if (!r || !r.ok) return
      if (r.accepted === true || r.active !== true) clearTokenGate()
      setTokenLock(r.active === true && r.accepted !== true)
    }

    /**
     * 启动引导：问一次宿主本次的 bootId，据此决定"已填的令牌还算不算数"。
     * 必须**先于**任何带令牌的请求完成 —— 否则会把上一次启动的令牌当成本次的发出去，
     * 那等于每次启动都不用重填（与要求 ③ 相反）。所以 apiCall 会等它。
     */
    function ensureTokenBootstrapped() {
      if (tokenBootstrap) return tokenBootstrap
      tokenBootstrap = (function () {
        const stored = readStoredToken()
        // 旧键一律清掉：没有 bootId 就无从判断归属，留着只会让"重启要重填"失效。
        try { for (const legacy of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(legacy) } catch (e) { /* ignore */ }
        return apiCall('token-status', {}, true).then(function (r) {
          BOOT_ID = (r && r.ok && r.bootId) ? String(r.bootId) : ''
          if (stored && BOOT_ID && stored.bootId === BOOT_ID) TOKEN = stored.token
          else if (stored) { TOKEN = ''; writeStoredToken('', '') }
        }).catch(function () { TOKEN = '' })
      })()
      return tokenBootstrap
    }

    /**
     * 发一个请求。
     *
     * @param op   宿主 op 名。
     * @param args 参数。
     * @param skipBootstrap 仅供引导自身使用（引导要发的正是 token-status，等自己会死锁）。
     */
    function apiCall(op, args, skipBootstrap) {
      const send = function () {
        // `x-dsh-plugin` is the cross-site (CSRF) gate header the host half
        // requires on every request; a cross-origin page cannot attach it
        // without a CORS preflight that this route never answers.
        const headers = { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management' }
        if (TOKEN) headers['x-dsh-token'] = TOKEN
        return fetch('/dsh-plugin-tool-management/api', {
          method: 'POST',
          headers,
          body: JSON.stringify({ op, args: args || {} }),
        }).then((r) => r.json()).then((payload) => {
          // 令牌没过 → 记到那份与页面/弹窗无关的状态里。**在这里记**（而不是各页面各记一遍）
          // 是唯一能保证"无论哪个入口、无论弹窗盖没盖住页面，提示都出得来"的做法：
          // 每个调用点都记 = 必然有地方漏（2026-09-19 实测漏了十来个弹窗）。
          if (payload && payload.ok === false && isTokenGateText(payload.error)) publishTokenGate(payload.error)
          return payload
        }).catch((e) => ({ ok: false, error: errMsg(e) }))
      }
      return skipBootstrap ? send() : ensureTokenBootstrapped().then(send)
    }

    // ── 「令牌没过」的识别与跳转（用户裁定 2026-09-18）─────────────────────────
    // 要求：这类提醒**文案只有一套**，且每个提醒右侧都要有一个直接跳到填令牌处的按钮。
    //
    // 文案同源已经做到了（宿主侧只有 http-fence.ts 里那两句，界面词典与它们逐字相同），
    // 所以这里按**文本相等**识别是可靠的 —— 而不是去猜关键词（"缺少/未配置"这类词一旦
    // 出现在别的提示里就会误挂按钮）。
    // 列表里同时保留历史文案：宿主没重启时旧句子还会出现，那时按钮也该出来。
    // 例外是「被套进 `error.action` 模板」的形态 —— 见下面的 unwrapActionText。
    //
    // ⚠️ 惰性求值不是多余的：`DICT` 声明在本文件靠后的位置，在模块求值阶段读它会命中
    // const 的 TDZ 而直接抛错（整个客户端加载失败）。只在真要判定时取一次即可。
    let tokenGateTexts = null
    function tokenGateTextsOf() {
      if (tokenGateTexts) return tokenGateTexts
      const out = []
      for (const locale of ['zh', 'en']) {
        const dict = DICT[locale] || {}
        for (const key of ['error.token.required', 'error.secret.noToken', 'error.secret.badToken']) {
          if (dict[key]) out.push(dict[key])
        }
      }
      tokenGateTexts = out.concat([
        // 宿主上两版说过的话：宿主没重启时它还在发这些句子，那时提示与按钮同样必须出来
        // （否则「令牌没过」会被当成一条普通错误，没有跳转按钮 —— 而这正是本次要修的毛病）。
        '缺少或错误的访问令牌（x-dsh-token）：请到「工具 → 兼容」页的「访问令牌」填写与宿主配置相同的值。',
        '宿主未配置访问令牌，明文查看已关闭：请到「工具 → 兼容」页的「访问令牌」填写（还没设置就点「设为宿主密钥」写入配置，重启 DSH 后生效）。',
        // 更早的版本：
        '缺少或错误的访问令牌（x-dsh-token）',
        '缺少或错误的访问令牌（x-dsh-token）：请在「工具 → 兼容」页的「访问令牌」里填入与宿主配置相同的值',
        '访问令牌缺失或不正确：请在界面里填入与宿主配置相同的令牌（随请求以 x-dsh-token 发出）。',
        '明文查看与导出已被禁用：宿主未配置访问令牌。请在本插件配置里加 token（或设环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）后重启 DSH，再在界面上填入同一个令牌。',
      ])
      return tokenGateTexts
    }

    /**
     * `error.action` 的模板拆解（"操作失败：{error}" / "Action failed: {error}"）。
     *
     * 很多调用点会把宿主原话套进这个模板再显示 —— 套上之后就**不再与宿主那句逐字相等**，
     * 按文本相等识别会失效，用户看到提示却少一颗「填写令牌」按钮，而且少了之后完全查不出
     * 原因（表现为"有的页面有按钮、有的没有"）。识别前先把这层壳剥掉。
     */
    let tokenActionWrap = null
    function tokenActionWrapOf() {
      if (tokenActionWrap) return tokenActionWrap
      const out = []
      for (const locale of ['zh', 'en']) {
        const tpl = (DICT[locale] || {})['error.action']
        if (typeof tpl !== 'string') continue
        const at = tpl.indexOf('{error}')
        if (at < 0) continue
        out.push({ prefix: tpl.slice(0, at), suffix: tpl.slice(at + '{error}'.length) })
      }
      tokenActionWrap = out
      return tokenActionWrap
    }

    /** 剥掉 `error.action` 的壳；没套壳就原样返回。 */
    function unwrapActionText(text) {
      for (const wrap of tokenActionWrapOf()) {
        if (!wrap.prefix || !text.startsWith(wrap.prefix)) continue
        const rest = text.slice(wrap.prefix.length)
        if (wrap.suffix) { if (rest.endsWith(wrap.suffix)) return rest.slice(0, rest.length - wrap.suffix.length) }
        else return rest
      }
      return text
    }

    /**
     * 「这句话是不是令牌没过」（含被 `error.action` 套过壳的形态）。
     */
    function isTokenGateText(text) {
      const text2 = String(text == null ? '' : text).trim()
      if (text2 === '') return false
      const known = tokenGateTextsOf()
      if (known.indexOf(text2) >= 0) return true
      const inner = unwrapActionText(text2)
      return inner !== text2 && known.indexOf(inner) >= 0
    }

    // ── 令牌提示的**存放位置**：一份与页面/弹窗无关的状态 ─────────────────────────
    //
    // 为什么需要它（用户实测 2026-09-19）：
    //   · 「新增 MCP」弹窗里提交被令牌挡下 —— 错误落进页面级提示条，而它**在弹窗背后**，
    //     被遮罩压暗，用户看到的是"弹窗里什么提示都没有"。
    //   · 「新建场景」弹窗里的错误是弹窗自己渲染的，但那条**没有跳转按钮**。
    //   同一个错误在十来个弹窗里各走各的路，就必然有地方漏。
    //
    // 现在的规则只有一条：**令牌提示同时只渲染一份** ——
    //   · 有弹窗打开 → 由 `Modal` 在弹窗内渲染（它是全插件弹窗的唯一出口）；
    //   · 没有弹窗 → 由页面级提示条渲染（`Notice`）。
    // `apiCall` 见到门禁拒绝就往这里写；用户提交了令牌（`setAccessToken`）就清掉。
    let gateText = null
    let gateModalDepth = 0
    const gateSubs = new Set()
    function gateSnapshot() { return { text: gateText, modalDepth: gateModalDepth } }
    function emitGate() { for (const fn of Array.from(gateSubs)) fn() }
    /** 宿主拒绝了这次请求，且原因是令牌没过 → 记下来（任意弹窗之上都会显示）。 */
    function publishTokenGate(text) {
      if (gateText === text) return
      gateText = text
      emitGate()
    }
    /** 用户提交了令牌（或已确认宿主认可这串）→ 收掉。下一次再被拒会重新出现。 */
    function clearTokenGate() {
      if (gateText === null) return
      gateText = null
      emitGate()
    }
    /** 订阅这份状态（`Modal` 与 `Notice` 共用，保证两边永远看到同一份）。 */
    function useGateSnapshot() {
      const st = React.useState(gateSnapshot)
      React.useEffect(function () {
        const fn = function () { st[1](gateSnapshot()) }
        gateSubs.add(fn)
        fn()
        return function () { gateSubs.delete(fn) }
      }, [])
      return st[0]
    }

    // 跳到「填令牌」的地方。用注册表而不是直接引用页面组件：页签状态在 ToolsSection 里，
    // 而这个模块在它外面 —— 跨作用域直接引用会 ReferenceError（CompatPage 引用 apply 内的
    // Notice 就是这么白屏的）。这条约束**现在没有测试护栏**：原 `test/client-scope.test.mjs`
    // 已于 2026-09-19 随三份界面测试一并移除（`test/_archive/` 目录并未落盘，别当它还守着）。
    let navigateToTab = null
    const tokenFocusListeners = []
    let tokenFocusPending = false
    /** CompatPage 订阅：被要求"填写令牌"时把光标放进输入框。 */
    function onTokenFocus(fn) {
      tokenFocusListeners.push(fn)
      return function () {
        const i = tokenFocusListeners.indexOf(fn)
        if (i >= 0) tokenFocusListeners.splice(i, 1)
      }
    }
    /**
     * 「填写令牌」——**只在设置面板内部有效**。
     *
     * `navigateToTab` 由 ToolsSection 在挂载时登记，所以这一句成立的前提是"我们那一节已经在
     * 树上"。三个调用点（令牌提示条、兼容页两处）都长在设置面板里，前提自然满足。
     *
     * 对话页顶部那条横幅**不走这里**：它出现时设置面板可能根本没开，而宿主没有公开的
     * 「打开设置」服务（查过 `@deepseek-ai/dsh-settings` 与同生态插件：只有 SettingsForms
     * 这类数据服务；`dsh-better-sidebar` 也只能在对话框挂载**之后**靠 DOM 认领自己那一行）。
     * 2026-10-12 试过"点宿主设置导航行 + 寄存页签"那条路，能通但脆；用户随后提出更简单的
     * 方案 —— 横幅那颗键直接开一个**自包含的填写弹窗**（见 TokenUnlockDialog），
     * 于是这一整套跳页依赖连同 `pendingTab` / `setTokenPanelText` 全部删掉了。
     */
    function openTokenPanel() {
      if (navigateToTab) navigateToTab('compat')
      // 两种情况都要管：兼容页已经挂着（订阅者立即聚焦），或者刚被切过去（挂载时消费这个标记）。
      tokenFocusPending = true
      for (const fn of tokenFocusListeners.slice()) {
        try { fn() } catch (e) { /* 单个订阅者出错不影响其它 */ }
      }
    }
    /** 兼容页「功能总览」的行内跳转：跳到该功能所在的页签（注册表在 ToolsSection 里，见上）。 */
    function jumpToTab(tab) {
      try { if (navigateToTab) navigateToTab(tab) } catch (e) { /* 跳转失败不影响本页 */ }
    }
    function consumeTokenFocus() {
      const pending = tokenFocusPending
      tokenFocusPending = false
      return pending
    }

    /**
     * 斜杠命令两段的挂载实况（由 48-slash.js 在注册时写入，兼容页那两枚标签读它）。
     * **按段记**：两段各自是一个源，各自挂没挂上可以不同（只注册了一个、或第二个源重名）。
     *
     * 为什么声明放在这里而不是 48 片：消费它的 CompatPage 在 20 片，比 48 片**早** —— 同一个
     * factory 作用域里函数声明提升没问题，但 `checkJs` 对这条跨片的反向引用会报 TS2304
     * （`npm run typecheck:client` 实测）。共享状态放在两个使用方的**共同上游**这一档。
     *
     * 服务端**不知道**挂没挂上（那是浏览器那半的事），所以这一句只能由客户端说；feature-overview
     * 那一行报的是开关状态，两者不是一回事，别拿一个冒充另一个（见 ops/compat.ts 同一处注释）。
     */
    let slashMountStates = { tools: 'pending', quickPrompts: 'pending' }
    function slashMountStateOf(key) { return slashMountStates[key] || 'pending' }
    /** 传 key 只改那一段；不传是"两段一起"（都关掉了、或整批注册失败）。 */
    function setSlashMount(state, key) {
      if (key) slashMountStates[key] = state
      else slashMountStates = { tools: state, quickPrompts: state }
    }

    /**
     * 一条全局轻提示（body 级，与页面/弹窗无关）。
     *
     * 为什么不是 `Notice`：`Notice` 长在页签里，而斜杠命令是在**对话页**按下的 —— 那时设置页
     * 根本没挂载，面板内的提示条无处可渲染。它与「令牌没填」那条横幅同源同位（40-apply-head.js
     * 的 body 级 append），差别只是这条会自动收。
     *
     * 同时只留一条：后发的直接覆写前一条（连点两下开关不该叠出两层提示）。
     */
    let toastEl = null
    let toastText = null
    let toastTimer = null
    function showPluginToast(text, kind) {
      try {
        if (typeof document === 'undefined' || !document.body) return
        const tone = kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'ok'
        if (!toastEl) {
          toastEl = document.createElement('div')
          toastEl.setAttribute('role', 'status')
          toastText = document.createElement('span')
          toastEl.appendChild(toastText)
          document.body.appendChild(toastEl)
        }
        toastText.textContent = String(text == null ? '' : text)
        toastEl.className = 'dsm-toast dsm-toast-' + tone
        toastEl.style.display = ''
        if (toastTimer) clearTimeout(toastTimer)
        // 报错那条留久一点：它常常是"得去设置页填令牌"这类要照着做的话。
        toastTimer = setTimeout(function () {
          if (toastEl) toastEl.style.display = 'none'
          toastTimer = null
        }, tone === 'err' ? 9000 : 4000)
      } catch (e) { /* DOM 不可用 → 只是少一条反馈，不影响已经生效的改动 */ }
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
