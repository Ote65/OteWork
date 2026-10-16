/**
 * dsh-governor-mode —— 浏览器半。
 *
 * 只做三件事，全部走官方插槽与语义令牌，不改动任何官方组件：
 *  1. 主区顶栏最左挂「经典｜总督」模式开关（conversation.header.leading）；
 *  2. 总督模式下拦截侧栏工作区行的点击（捕获阶段），改为打开「总督页」而不是展开；
 *  3. 总督页：总督头像 + ≤8 个子会话头像 + 直角母线连线 + 完成气泡 + 输入井（main keyed slot）。
 *
 * 颜色 / 圆角 / 阴影一律取 --dsw-* 语义令牌：不自造色值、不加大投影、不用发光。
 * 像素头像只出现在总督页（本插件自己的页面）内，官方侧栏与品牌席位的原生头像/图标一个都不动。
 *
 * @module dsh-governor-mode/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-governor-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    /** 顶栏最左：无会话时也存在，是唯一空置的顶栏左侧席位。 */
    var HEADER_SLOT = 'conversation.header.leading'
    /** 主内容区：keyed 面板席位，`conversation` 是保留 key。 */
    var MAIN_SLOT = 'main'
    /** composer 工具行左侧：只用来做草稿搬运，渲染 null。 */
    var DRAFT_SLOT = 'conversation.input.left'
    /** 本插件在 main 里的面板 key。 */
    var PANEL_ID = 'governor'
    var STYLE_ID = 'dsh-governor-mode/css'
    var ROOT_ATTR = 'data-dsh-governor-mode'
    /** 一个总督最多带 8 个子会话。 */
    var MAX_SUB = 8

    /* ====================================================================== */
    /* 插件内状态（模式 + 当前工作区 + 待搬运草稿）                              */
    /* ====================================================================== */

    var listeners = new Set()
    var currentCtx = null
    var state = {
      mode: 'classic',
      workspaceId: null,
      draft: null,
      bubbleClosed: false,
    }

    function emit() {
      listeners.forEach(function (fn) {
        try { fn() } catch (error) { void error }
      })
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }

    /** 订阅插件状态：emit 时用版本号强制重渲染。 */
    function useGov() {
      var pair = react.useState(0)
      var bump = pair[1]
      react.useEffect(function () {
        return subscribe(function () { bump(function (n) { return n + 1 }) })
      }, [bump])
      return state
    }

    function selectPanel(panelId) {
      var layout = currentCtx && currentCtx.layout
      if (layout == null || typeof layout.selectPanel !== 'function') return
      // 面板在 apply 里注册，切换时机早于注册会抛；这里只忽略这种时序噪声。
      try { layout.selectPanel(panelId) } catch (error) { void error }
    }

    function setMode(mode) {
      if (state.mode === mode) return
      state.mode = mode
      state.bubbleClosed = false
      applyMarker()
      selectPanel(mode === 'governor' ? PANEL_ID : null)
      emit()
    }

    function setWorkspace(workspaceId) {
      state.workspaceId = workspaceId
      selectPanel(PANEL_ID)
      emit()
    }

    function openSession(sessionId) {
      var uiWorkspace = currentCtx && currentCtx.uiWorkspace
      if (uiWorkspace == null || typeof uiWorkspace.openSession !== 'function') return
      try { uiWorkspace.openSession(sessionId) } catch (error) { void error }
    }

    function applyMarker() {
      var root = typeof document === 'undefined' ? null : document.documentElement
      if (root == null) return
      if (state.mode === 'governor') root.setAttribute(ROOT_ATTR, '')
      else root.removeAttribute(ROOT_ATTR)
    }

    /* ====================================================================== */
    /* 像素头像：16×16 网格 = 像素相框 + 12×12 像素脸                            */
    /* 只用于总督页；每个角色落到 SVG 时翻译成 --dsw-* 令牌或 currentColor       */
    /* ====================================================================== */

    var PX = {
      ring: 'var(--dsw-alias-border-l3)',
      ringIn: 'var(--dsw-alias-border-l4)',
      socket: 'var(--dsw-alias-bg-base)',
      headHi: 'var(--dsw-alias-bg-layer-2)',
      headLo: 'var(--dsw-alias-bg-layer-1)',
      edge: 'var(--dsw-alias-border-l3)',
      eye: 'var(--dsw-alias-label-primary)',
      /** 天线 / 视窗 / 脸颊灯：跟随节点的语义状态色（由 CSS 的 color 决定）。 */
      accent: 'currentColor',
    }

    /** 会话 id → 稳定种子：同一个会话每次都长同一张脸。 */
    function hashId(id) {
      var text = String(id == null ? '' : id)
      var hash = 2166136261
      for (var i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = (hash * 16777619) >>> 0
      }
      return hash % 100000
    }

    function seededRand(seed) {
      var value = (seed * 9301 + 49297) % 233280
      if (value === 0) value = 7
      return function () {
        value = (value * 9301 + 49297) % 233280
        return value / 233280
      }
    }

    /** 12×12 像素脸：返回角色网格（null = 空）。 */
    function faceCells(kind, seed) {
      var grid = []
      var y
      var x
      for (y = 0; y < 12; y += 1) {
        var row = []
        for (x = 0; x < 12; x += 1) row.push(null)
        grid.push(row)
      }
      function put(px, py, role) {
        if (px >= 0 && px < 12 && py >= 0 && py < 12) grid[py][px] = role
      }
      function rect(rx, ry, w, h, role) {
        for (var j = ry; j < ry + h; j += 1) for (var i = rx; i < rx + w; i += 1) put(i, j, role)
      }
      var rand = seededRand(seed + 1)

      /* 头：上半受光 + 四边描边 + 侧螺栓 */
      rect(2, 2, 8, 9, 'headLo')
      rect(2, 2, 8, 5, 'headHi')
      rect(2, 2, 8, 1, 'edge')
      rect(2, 10, 8, 1, 'edge')
      rect(2, 2, 1, 9, 'edge')
      rect(9, 2, 1, 9, 'edge')
      rect(1, 5, 1, 2, 'edge')
      rect(10, 5, 1, 2, 'edge')

      if (kind === 'gov') {
        /* 总督：双刺天线 + 压眉视窗 + 抿嘴 */
        put(4, 0, 'accent')
        put(7, 0, 'accent')
        rect(4, 1, 4, 1, 'edge')
        rect(3, 5, 2, 1, 'edge')
        rect(7, 5, 2, 1, 'edge')
        rect(3, 6, 6, 1, 'edge')
        put(4, 6, 'accent')
        put(7, 6, 'accent')
        rect(4, 8, 4, 1, 'edge')
      } else {
        var eyes = Math.floor(rand() * 4)
        var mouth = Math.floor(rand() * 4)
        if (rand() < 0.7) {
          rect(5, 1, 2, 1, 'edge')
          rect(5, 0, 2, 1, 'accent')
        }
        if (eyes === 0) {
          put(4, 6, 'eye')
          put(7, 6, 'eye')
        } else if (eyes === 1) {
          rect(4, 5, 1, 2, 'eye')
          rect(7, 5, 1, 2, 'eye')
        } else if (eyes === 2) {
          rect(3, 6, 6, 1, 'edge')
          put(4, 6, 'accent')
          put(7, 6, 'accent')
        } else {
          rect(4, 6, 4, 1, 'eye')
          put(5, 6, 'edge')
        }
        if (mouth === 1) rect(4, 8, 4, 1, 'edge')
        else if (mouth === 2) {
          rect(4, 8, 4, 1, 'edge')
          put(5, 8, 'eye')
          put(7, 8, 'eye')
        } else if (mouth === 3) rect(5, 8, 2, 1, 'accent')
        if (rand() < 0.35) put(3, 8, 'accent')
      }
      return grid
    }

    /** 相框：2 单位厚 + 四角 1 单位像素阶梯（外框 0..15，脸占 2..13）。 */
    function isPixelFrame(x, y) {
      return ((y === 0 || y === 15) && x >= 2 && x <= 13) ||
        ((y === 1 || y === 14) && x >= 1 && x <= 14) ||
        ((x === 0 || x === 15) && y >= 2 && y <= 13) ||
        ((x === 1 || x === 14) && y >= 1 && y <= 14)
    }

    function pixelAvatar(kind, seed) {
      var cells = []
      var x
      var y
      cells.push(react.createElement('rect', {
        key: 'bg', x: 0, y: 0, width: 16, height: 16, fill: PX.socket,
      }))
      /* 相框：上/左受光，下/右压暗 */
      for (y = 0; y < 16; y += 1) {
        for (x = 0; x < 16; x += 1) {
          if (!isPixelFrame(x, y)) continue
          var dark = y >= 14 || x >= 15
          cells.push(react.createElement('rect', {
            key: 'f' + x + '-' + y,
            x: x, y: y, width: 1, height: 1,
            fill: dark ? PX.ringIn : PX.ring,
          }))
        }
      }
      /* 凹口：上沿与左沿留一道浅线，下沿与右沿压到最暗 */
      for (x = 2; x <= 13; x += 1) {
        cells.push(react.createElement('rect', { key: 'ru' + x, x: x, y: 2, width: 1, height: 1, fill: PX.ringIn }))
        cells.push(react.createElement('rect', { key: 'rd' + x, x: x, y: 13, width: 1, height: 1, fill: PX.socket }))
      }
      for (y = 3; y <= 12; y += 1) {
        cells.push(react.createElement('rect', { key: 'rl' + y, x: 2, y: y, width: 1, height: 1, fill: PX.ringIn }))
        cells.push(react.createElement('rect', { key: 'rr' + y, x: 13, y: y, width: 1, height: 1, fill: PX.socket }))
      }
      /* 脸：偏移 2 单位落进凹口 */
      var grid = faceCells(kind, seed)
      grid.forEach(function (row, gy) {
        row.forEach(function (role, gx) {
          if (role == null) return
          cells.push(react.createElement('rect', {
            key: 'p' + gx + '-' + gy,
            x: gx + 2, y: gy + 2, width: 1, height: 1,
            fill: PX[role],
          }))
        })
      })
      return react.createElement('svg', {
        viewBox: '0 0 16 16',
        shapeRendering: 'crispEdges',
        width: '100%',
        height: '100%',
        'aria-hidden': 'true',
        focusable: 'false',
      }, cells)
    }

    /* ====================================================================== */
    /* 样式：只用 --dsw-* 语义令牌                                             */
    /* ====================================================================== */

    var STYLESHEET = [
      /* ---- 模式开关（两种模式都要可见，因此不加 marker 前缀） ---- */
      '.dsh-gov-switch{display:inline-flex;align-items:center;gap:2px;padding:2px;',
      '  border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);',
      '  box-shadow:var(--dsw-elevation-stroke)}',
      '.dsh-gov-switch>button{border:0;background:transparent;cursor:pointer;',
      '  color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1;',
      '  padding:5px 12px;border-radius:calc(var(--dsw-radius-sm,8px) - 2px);',
      '  transition:color .15s ease,background .15s ease}',
      '.dsh-gov-switch>button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-gov-switch>button[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}',

      /* ---- 总督页 ---- */
      '.dsh-gov-page{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
      '  min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px 0}',
      '.dsh-gov-title{font-size:var(--dsh-content-font-size,14px);font-weight:500;color:var(--dsw-alias-label-primary);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gov-count{flex:none;font-size:12px;color:var(--dsw-alias-label-caption)}',
      '.dsh-gov-head .dsh-gov-sp{flex:1}',
      '.dsh-gov-action{border:0;cursor:pointer;font:inherit;font-size:12px;padding:5px 10px;',
      '  border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);',
      '  color:var(--dsw-alias-label-secondary);box-shadow:var(--dsw-elevation-stroke);',
      '  transition:background .15s ease,color .15s ease}',
      '.dsh-gov-action:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-action:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;background:var(--dsw-alias-bg-layer-1)}',

      '.dsh-gov-stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;padding:10px 20px 0}',
      '.dsh-gov-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
      '.dsh-gov-top{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}',
      '.dsh-gov-grid{flex:3;min-height:0;display:flex;flex-direction:column;align-items:center;',
      '  justify-content:center;gap:26px;padding-bottom:14px}',
      '.dsh-gov-row{display:flex;gap:clamp(20px,4vw,48px)}',

      /* 节点：像素头像自绘，容器不加底色与投影，只留状态色 */
      '.dsh-gov-node{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;',
      '  border:0;background:transparent;padding:0;cursor:pointer;color:inherit}',
      '.dsh-gov-face{display:block;line-height:0;border-radius:0;background:transparent;',
      '  color:var(--dsw-alias-state-idle-primary);transition:color .15s ease,opacity .15s ease}',
      '.dsh-gov-face svg{display:block;width:100%;height:100%}',
      '.dsh-gov-face--gov{width:64px;height:64px}',
      '.dsh-gov-face--sub{width:48px;height:48px}',
      '.dsh-gov-node:hover .dsh-gov-face{opacity:.86}',
      '.dsh-gov-face--add{display:grid;place-items:center;width:48px;height:48px;font-size:20px;',
      '  border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);',
      '  color:var(--dsw-alias-label-caption);box-shadow:var(--dsw-elevation-stroke)}',
      '.dsh-gov-label{max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '  font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      /* 状态只用语义状态色驱动头像内的强调像素；进行中用呼吸，不加发光 */
      '.dsh-gov-node[data-state="ongoing"] .dsh-gov-face{color:var(--dsw-alias-state-business-primary);',
      '  animation:dsh-gov-breathe 1.6s ease-in-out infinite}',
      '.dsh-gov-node[data-state="done"] .dsh-gov-face{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-gov-node[data-state="warning"] .dsh-gov-face{color:var(--dsw-alias-state-warn-primary)}',
      '@keyframes dsh-gov-breathe{50%{opacity:.7}}',
      '.dsh-gov-empty{color:var(--dsw-alias-label-caption);font-size:12px}',

      /* 连线：一条横母线 + 每节点一条竖支线 */
      '.dsh-gov-wire{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.5}',
      '.dsh-gov-wire[data-state="ongoing"]{stroke:var(--dsw-alias-state-business-primary);',
      '  stroke-dasharray:4 10;animation:dsh-gov-flow 1s linear infinite}',
      '.dsh-gov-wire[data-state="done"]{stroke:var(--dsw-alias-state-success-primary)}',
      '.dsh-gov-tap{fill:var(--dsw-alias-border-l4)}',
      '@keyframes dsh-gov-flow{to{stroke-dashoffset:-14}}',

      /* 完成气泡：宿主菜单材质（含背板模糊与 0.5px 发丝描边） */
      '.dsh-gov-bubble{position:absolute;right:20px;top:56px;width:288px;z-index:3;',
      '  border:0;border-radius:var(--dsw-radius-md,12px);padding:12px 14px;',
      '  background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));',
      '  backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent)}',
      '.dsh-gov-bubble-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
      '.dsh-gov-bubble-title{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gov-bubble-close{border:0;background:transparent;cursor:pointer;padding:0 2px;',
      '  color:var(--dsw-alias-label-caption);font:inherit;font-size:14px;line-height:1}',
      '.dsh-gov-bubble-close:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-bubble-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-bottom:8px}',
      '.dsh-gov-bubble-open{border:0;background:transparent;cursor:pointer;padding:0;font:inherit;',
      '  font-size:12px;color:var(--dsw-alias-link)}',
      '.dsh-gov-bubble-open:hover{text-decoration:underline}',

      /* 输入井 */
      '.dsh-gov-input{flex:none;padding:10px 20px 16px}',
      '.dsh-gov-well{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 14px;border:0;',
      '  border-radius:var(--dsw-radius-md,12px);',
      '  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));',
      '  box-shadow:var(--dsw-elevation-stroke)}',
      '.dsh-gov-well:focus-within{box-shadow:var(--dsw-elevation-stroke),0 0 0 var(--dsw-focus-ring-width,2px) ',
      '  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dsh-gov-well textarea{flex:1;min-height:22px;max-height:120px;resize:none;border:0;outline:none;',
      '  background:transparent;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.5;',
      '  color:var(--dsw-alias-label-primary);padding:3px 0}',
      '.dsh-gov-well textarea::placeholder{color:var(--dsw-alias-label-caption)}',
      '.dsh-gov-send{flex:none;border:0;cursor:pointer;width:30px;height:30px;display:grid;place-items:center;',
      '  border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-primary-fill);',
      '  color:var(--dsw-alias-label-primary-inverted)}',
      '.dsh-gov-send:disabled{cursor:default;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-dimmed)}',
      '.dsh-gov-hint{display:flex;gap:6px;align-items:center;margin-top:6px;font-size:11px;',
      '  color:var(--dsw-alias-label-caption)}',

      '@media (prefers-reduced-motion:reduce){',
      '  .dsh-gov-node[data-state="ongoing"] .dsh-gov-face{animation:none}',
      '  .dsh-gov-wire[data-state="ongoing"]{animation:none}}',
    ].join('\n')

    function installStyles() {
      if (typeof document === 'undefined' || document.head == null) return function () {}
      var existing = document.getElementById(STYLE_ID)
      if (existing != null) return function () {}
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.dataset.plugin = 'dsh-governor-mode'
      tag.textContent = STYLESHEET
      document.head.appendChild(tag)
      return function () { if (tag.parentNode != null) tag.parentNode.removeChild(tag) }
    }

    /* ====================================================================== */
    /* 数据读取                                                                */
    /* ====================================================================== */

    /** 选择器保持稳定引用，避免每次渲染重新订阅。 */
    function pickItems(snapshot) { return snapshot == null ? null : snapshot.items }
    function pickById(snapshot) { return snapshot == null ? null : snapshot.byId }
    function pickWhole(snapshot) { return snapshot }

    /** 语义状态：warning > ongoing > done > idle。 */
    function stateOf(summary, status) {
      if (status != null && status.pendingInteraction != null) return 'warning'
      if (summary != null && summary.running === true) return 'ongoing'
      if (status != null && status.running === true) return 'ongoing'
      if (status != null && typeof status.state === 'string') return status.state
      if (summary != null && summary.completed === true) return 'done'
      return 'idle'
    }

    function titleOf(summary) {
      if (summary == null) return ''
      return summary.title || summary.displayTitle || ''
    }

    /** 居中排列：≤4 一行；5→3+2；6→3+3；7→4+3；8→4+4。 */
    function rowsOf(count) {
      if (count <= 0) return []
      if (count <= 4) return [count]
      var top = Math.ceil(count / 2)
      return [top, count - top]
    }

    /* ====================================================================== */
    /* 模式开关                                                                */
    /* ====================================================================== */

    var MODES = [['classic', '经典'], ['governor', '总督']]

    function ModeSwitch() {
      var view = useGov()
      return react.createElement(
        'div',
        { className: 'dsh-gov-switch', role: 'group', 'aria-label': '工作模式' },
        MODES.map(function (entry) {
          return react.createElement('button', {
            key: entry[0],
            type: 'button',
            'aria-pressed': view.mode === entry[0],
            title: entry[0] === 'governor' ? '总督模式' : '经典模式',
            onClick: function () { setMode(entry[0]) },
          }, entry[1])
        }),
      )
    }

    /* ====================================================================== */
    /* 草稿搬运桥：把总督页输入的文字交给总督会话的 composer                      */
    /* ====================================================================== */

    function DraftBridge(props) {
      var sessionId = props.sessionId
      var inputActions = props.inputActions
      react.useEffect(function () {
        var pending = state.draft
        if (pending == null || pending.sessionId !== sessionId) return
        state.draft = null
        if (inputActions != null && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(pending.text)
        }
      }, [sessionId, inputActions])
      return null
    }

    /* ====================================================================== */
    /* 总督页                                                                  */
    /* ====================================================================== */

    function GovernorPage(props) {
      var view = useGov()
      var items = props.useWorkspaces ? props.useWorkspaces(pickItems) : null
      var byId = props.useSessions ? props.useSessions(pickById) : null
      var statusMap = props.useSessionStatus ? props.useSessionStatus(pickWhole) : null

      var list = Array.isArray(items) ? items : []
      var summaries = byId != null && typeof byId === 'object' ? byId : {}

      var workspace = null
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].workspaceId === view.workspaceId) { workspace = list[i]; break }
      }
      if (workspace == null) workspace = list.length > 0 ? list[0] : null

      var sessionIds = workspace != null && Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      var governorId = sessionIds.length > 0 ? sessionIds[0] : null
      var subIds = sessionIds.slice(1, 1 + MAX_SUB)

      var stageRef = react.useRef(null)
      var wirePair = react.useState([])
      var wires = wirePair[0]
      var setWires = wirePair[1]
      var draftPair = react.useState('')
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      var subKey = subIds.join(',')
      react.useEffect(function () {
        var frame = 0
        function measure() {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          frame = window.requestAnimationFrame(function () { setWires(measureWires(stageRef.current)) })
        }
        measure()
        window.addEventListener('resize', measure)
        return function () {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', measure)
        }
      }, [subKey, view.workspaceId, view.mode])

      function statusOf(id) {
        var row = statusMap != null && typeof statusMap.get === 'function' ? statusMap.get(id) : null
        return stateOf(summaries[id], row)
      }

      function submit() {
        var text = draft.trim()
        if (text === '' || governorId == null) return
        state.draft = { sessionId: governorId, text: text }
        setDraft('')
        openSession(governorId)
      }

      var rows = rowsOf(subIds.length)
      var cursor = 0
      var grid = rows.map(function (count, rowIndex) {
        var slice = subIds.slice(cursor, cursor + count)
        cursor += count
        return react.createElement(
          'div',
          { className: 'dsh-gov-row', key: 'row-' + rowIndex },
          slice.map(function (id) {
            var summary = summaries[id]
            var label = titleOf(summary) || '未命名会话'
            return react.createElement(
              'button',
              {
                key: id,
                type: 'button',
                className: 'dsh-gov-node',
                'data-gov-node': 'sub',
                'data-state': statusOf(id),
                title: label,
                onClick: function () { openSession(id) },
              },
              react.createElement('span', { className: 'dsh-gov-face dsh-gov-face--sub' }, pixelAvatar('sub', hashId(id))),
              react.createElement('span', { className: 'dsh-gov-label' }, label),
            )
          }),
        )
      })

      if (subIds.length < MAX_SUB) {
        var addRow = react.createElement(
          'div',
          { className: 'dsh-gov-row', key: 'row-add' },
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-gov-node',
              'data-gov-node': 'add',
              title: '新建子会话',
              onClick: function () {
                var uiWorkspace = currentCtx && currentCtx.uiWorkspace
                if (uiWorkspace != null && typeof uiWorkspace.startSession === 'function' && workspace != null) {
                  try { uiWorkspace.startSession(workspace.workspaceId) } catch (error) { void error }
                }
              },
            },
            react.createElement('span', { className: 'dsh-gov-face dsh-gov-face--add' }, '+'),
            react.createElement('span', { className: 'dsh-gov-label' }, '新建子会话'),
          ),
        )
        if (grid.length === 0) grid = [addRow]
        else grid[grid.length - 1] = react.createElement(
          react.Fragment,
          { key: 'row-last' },
          grid[grid.length - 1],
          addRow,
        )
      }

      var governorSummary = governorId == null ? null : summaries[governorId]
      var governorState = governorId == null ? 'idle' : statusOf(governorId)
      var showBubble = governorId != null && governorState === 'done' && view.bubbleClosed !== true

      var head = react.createElement(
        'div',
        { className: 'dsh-gov-head' },
        react.createElement('span', { className: 'dsh-gov-title' }, workspace == null ? '总督模式' : workspace.title || '未命名工作区'),
        react.createElement('span', { className: 'dsh-gov-count' }, subIds.length + ' / ' + MAX_SUB),
        react.createElement('span', { className: 'dsh-gov-sp' }),
        react.createElement('button', {
          type: 'button',
          className: 'dsh-gov-action',
          disabled: governorId == null,
          onClick: function () { if (governorId != null) openSession(governorId) },
        }, '总督会话'),
      )

      var stage = react.createElement(
        'div',
        { className: 'dsh-gov-stage', ref: stageRef },
        react.createElement(
          'svg',
          { className: 'dsh-gov-wires', 'aria-hidden': 'true' },
          wires.map(function (wire, index) {
            return react.createElement('path', {
              key: 'w' + index,
              className: 'dsh-gov-wire',
              'data-state': wire.state,
              d: wire.d,
            })
          }),
          wires.map(function (wire, index) {
            return wire.tap == null ? null : react.createElement('rect', {
              key: 't' + index,
              className: 'dsh-gov-tap',
              x: wire.tap.x - 2,
              y: wire.tap.y - 2,
              width: 4,
              height: 4,
            })
          }),
        ),
        react.createElement(
          'div',
          { className: 'dsh-gov-top' },
          governorId == null
            ? react.createElement('span', { className: 'dsh-gov-empty' }, '这个工作区还没有会话')
            : react.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-gov-node',
                'data-gov-node': 'gov',
                'data-state': governorState,
                title: '打开总督会话',
                onClick: function () { openSession(governorId) },
              },
              react.createElement(
                'span',
                { className: 'dsh-gov-face dsh-gov-face--gov' },
                pixelAvatar('gov', hashId(workspace == null ? 'governor' : workspace.workspaceId)),
              ),
              react.createElement('span', { className: 'dsh-gov-label' }, titleOf(governorSummary) || '总督'),
            ),
        ),
        react.createElement('div', { className: 'dsh-gov-grid' }, grid),
        showBubble
          ? react.createElement(
            'div',
            { className: 'dsh-gov-bubble', 'data-menu-material': '' },
            react.createElement(
              'div',
              { className: 'dsh-gov-bubble-head' },
              react.createElement('span', { className: 'dsh-gov-bubble-title' }, '总督会话已完成'),
              react.createElement('button', {
                type: 'button',
                className: 'dsh-gov-bubble-close',
                onClick: function () { state.bubbleClosed = true; emit() },
              }, '×'),
            ),
            react.createElement(
              'div',
              { className: 'dsh-gov-bubble-body' },
              titleOf(governorSummary) || '本轮任务已结束',
            ),
            react.createElement('button', {
              type: 'button',
              className: 'dsh-gov-bubble-open',
              onClick: function () { openSession(governorId) },
            }, '查看全部 →'),
          )
          : null,
      )

      var input = react.createElement(
        'div',
        { className: 'dsh-gov-input' },
        react.createElement(
          'div',
          { className: 'dsh-gov-well' },
          react.createElement('textarea', {
            rows: 1,
            value: draft,
            placeholder: governorId == null ? '先在这个工作区新建会话' : '发给总督…',
            disabled: governorId == null,
            onChange: function (event) { setDraft(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && event.shiftKey !== true) {
                event.preventDefault()
                submit()
              }
            },
          }),
          react.createElement('button', {
            type: 'button',
            className: 'dsh-gov-send',
            disabled: governorId == null || draft.trim() === '',
            'aria-label': '发送给总督',
            onClick: submit,
          }, '↑'),
        ),
        react.createElement(
          'div',
          { className: 'dsh-gov-hint' },
          '发送后会打开总督会话，文字落在它的输入框里',
        ),
      )

      return react.createElement('div', { className: 'dsh-gov-page' }, head, stage, input)
    }

    /* ====================================================================== */
    /* 连线：由总督底竖直向下 → 唯一一条横母线 → 每个节点各一条竖支线            */
    /* ====================================================================== */

    function measureWires(stage) {
      if (stage == null) return []
      var stageBox = stage.getBoundingClientRect()
      if (stageBox.width === 0 || stageBox.height === 0) return []
      var governor = stage.querySelector('[data-gov-node="gov"] .dsh-gov-face')
      if (governor == null) return []
      var governorBox = governor.getBoundingClientRect()
      var gx = governorBox.left + governorBox.width / 2 - stageBox.left
      var gy = governorBox.bottom - stageBox.top

      var nodes = []
      var faces = stage.querySelectorAll('[data-gov-node="sub"] .dsh-gov-face')
      for (var i = 0; i < faces.length; i += 1) {
        var box = faces[i].getBoundingClientRect()
        var owner = faces[i].closest('[data-gov-node="sub"]')
        nodes.push({
          x: box.left + box.width / 2 - stageBox.left,
          y: box.top - stageBox.top,
          state: owner == null ? 'idle' : owner.getAttribute('data-state') || 'idle',
        })
      }
      if (nodes.length === 0) return []

      var firstY = nodes[0].y
      for (var j = 1; j < nodes.length; j += 1) if (nodes[j].y < firstY) firstY = nodes[j].y
      var busY = gy + Math.max(16, (firstY - gy) * 0.55)

      var left = gx
      var right = gx
      for (var k = 0; k < nodes.length; k += 1) {
        if (nodes[k].x < left) left = nodes[k].x
        if (nodes[k].x > right) right = nodes[k].x
      }

      var wires = [{
        state: 'idle',
        d: 'M' + gx + ' ' + gy + ' V' + busY + ' M' + left + ' ' + busY + ' H' + right,
      }]
      for (var m = 0; m < nodes.length; m += 1) {
        wires.push({
          state: nodes[m].state,
          d: 'M' + nodes[m].x + ' ' + busY + ' V' + nodes[m].y,
          tap: { x: nodes[m].x, y: busY },
        })
      }
      return wires
    }

    /* ====================================================================== */
    /* 侧栏拦截：总督模式下点工作区行 → 打开总督页，而不是展开                    */
    /* ====================================================================== */

    function installSidebarInterceptor() {
      function onClick(event) {
        if (state.mode !== 'governor') return
        var target = event.target
        if (target == null || typeof target.closest !== 'function') return
        // 行内动作（新建会话 / 更多菜单）照旧放行。
        if (target.closest('button') != null) return
        var row = target.closest('[data-row-key^="workspace:"]')
        if (row == null) return
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        var key = row.getAttribute('data-row-key') || ''
        setWorkspace(key.slice('workspace:'.length))
      }
      document.addEventListener('click', onClick, true)
      return function () { document.removeEventListener('click', onClick, true) }
    }

    /* ====================================================================== */
    /* 注册                                                                    */
    /* ====================================================================== */

    function apply(ctx) {
      currentCtx = ctx
      ctx.effect(function () { return installStyles() }, 'governor-mode: styles')
      ctx.effect(function () {
        applyMarker()
        return function () {
          var root = typeof document === 'undefined' ? null : document.documentElement
          if (root != null) root.removeAttribute(ROOT_ATTR)
        }
      }, 'governor-mode: root marker')
      ctx.effect(function () { return installSidebarInterceptor() }, 'governor-mode: sidebar intercept')
      ctx.effect(function () {
        return ctx.slots.inject(HEADER_SLOT, function () {
          return ctx.slots.register({ name: HEADER_SLOT }, ModeSwitch)
        })
      }, 'governor-mode: mode switch')
      ctx.effect(function () {
        return ctx.slots.inject(MAIN_SLOT, function () {
          return ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, GovernorPage)
        })
      }, 'governor-mode: governor panel')
      ctx.effect(function () {
        return ctx.slots.inject(DRAFT_SLOT, function () {
          return ctx.slots.register({ name: DRAFT_SLOT, id: 'governor-mode-bridge', order: 90 }, DraftBridge)
        })
      }, 'governor-mode: draft bridge')
    }

    exports.name = 'governor-mode'
    exports.apply = apply
    exports.inject = ['slots', 'layout', 'uiWorkspace']
    exports.__internals = {
      state, rowsOf, stateOf, titleOf, hashId, faceCells, pixelAvatar, measureWires, STYLESHEET,
    }
    return module.exports
  },
})
