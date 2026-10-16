/**
 * dsh-governor-mode —— 浏览器半（v2 总督面板）。
 *
 * 总督模式是默认且唯一的工作模式，做四件事，全部走官方插槽与语义令牌：
 *  1. 侧栏工作区行点击（捕获阶段）无条件拦截 → 打开总督面板（行内交互控件放行）；
 *  2. 面板挂载三策略自适应：右侧栏 pane 注册 → 右侧栏内容槽遮蔽 → main 面板兜底，
 *     命中即停，策略名记到根节点 data 属性与 __internals 供实测定位；
 *  3. 四区内容同一套：roster（总督 + ≤8 手下 + 状态灯 + 直角连线 + 分支标签）、
 *     选择题卡（autoAnswer 开关）、git 区（同步灯 + 指令按钮）、输入井（目标下拉）；
 *  4. 数据走宿主半 /api/governor/*（相对路径 fetch，同源），roster/questions 2s、
 *     git-state 10s，页面不可见统一降到 15s；新建工作区 = 懒建总督 + 注入提示词。
 *
 * 颜色 / 圆角 / 阴影一律取 --dsw-* 语义令牌：不自造色值、不加大投影、不用发光。
 * 像素头像只出现在总督面板内，官方侧栏与品牌席位的原生头像/图标一个都不动。
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

    /** 主内容区：keyed 面板席位，`conversation` 是保留 key（策略三兜底）。 */
    var MAIN_SLOT = 'main'
    /** composer 工具行左侧：草稿搬运桥，渲染 null（发提示词失败时降级用）。 */
    var DRAFT_SLOT = 'conversation.input.left'
    /** 策略二候选：右侧栏内容槽名（是否存在待 Windows 实测，命中即停）。 */
    var RIGHT_SLOT_CANDIDATES = ['sidebar.right.pane', 'sidebar.right.pane.content']
    /** 本插件的面板 key。 */
    var PANEL_ID = 'governor'
    var STYLE_ID = 'dsh-governor-mode/css'
    var ROOT_ATTR = 'data-dsh-governor-mode'
    var MOUNT_ATTR = 'data-dsh-governor-mount'
    /** 一个总督最多带 8 个手下会话。 */
    var MAX_SUB = 8
    /** 宿主半控制平面前缀（相对路径 fetch 与宿主同源）。 */
    var API_PREFIX = '/api/governor'
    /** 轮询周期：roster/questions 与 git-state；页面不可见统一降频。 */
    var ROSTER_MS = 2000
    var GIT_MS = 10000
    var HIDDEN_MS = 15000
    /** 侧栏行点击放行白名单：行内交互控件与官方展开控件照旧。 */
    var PASS_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], [data-row-expander], [data-dsw-expander]'
    /** DSH 原生「新建会话」控件（侧栏图标按钮 / macOS 折叠态的窗口控件）。 */
    var NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"], button[aria-label="New session"]'
    /** 那个按钮在总督模式下的真实语义。 */
    var PANEL_LABEL = '新建工作面板'

    /* ====================================================================== */
    /* 插件内状态（当前工作区 + 待搬运草稿 + 挂载策略）                            */
    /* ====================================================================== */

    var listeners = new Set()
    var currentCtx = null
    var state = {
      workspaceId: null,
      draft: null,
      bubbleClosed: false,
    }
    /** 面板实际命中的挂载策略：'pane' / 'slot:<名>' / 'main'。 */
    var mountStrategy = null
    /** 最近一次渲染定位到的总督会话（拦截开面板与打开预览时用）。 */
    var latest = { workspaceId: null, governorId: null }
    /** 见过的工作区（差集检测「新工作区」用，内存态）。 */
    var knownWorkspaces = new Set()
    /** 本插件为其懒建总督会话的工作区（只有这些才自动注入提示词）。 */
    var ownedWorkspaces = new Set()
    /** 已成功注入总督提示词的工作区。 */
    var bootstrapped = new Set()
    /** startSession 在途的工作区（防重复建会话）。 */
    var creating = new Set()

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
      var layout = serviceOf(currentCtx, 'layout')
      if (layout == null || typeof layout.selectPanel !== 'function') return
      // 面板在 apply 里注册，切换时机早于注册会抛；这里只忽略这种时序噪声。
      try { layout.selectPanel(panelId) } catch (error) { void error }
    }

    /**
     * 读一个可能不存在的服务。Cordis 的 ctx 是 Proxy：对未注册/未注入的服务
     * 名做裸属性访问会直接抛 `cannot get property "x" without inject`，
     * 所以一律 ctx.get 优先、裸访问只作兜底并全程 try/catch。
     */
    function serviceOf(ctx, name) {
      if (ctx == null) return null
      try {
        if (typeof ctx.get === 'function') {
          var viaGet = ctx.get(name)
          if (viaGet != null) return viaGet
        }
      } catch (error) { void error }
      try {
        var direct = ctx[name]
        return direct == null ? null : direct
      } catch (error) { return null }
    }

    function sidebarRightOf(ctx) {
      return serviceOf(ctx, 'sidebarRight')
    }

    function openSession(sessionId) {
      var uiWorkspace = serviceOf(currentCtx, 'uiWorkspace')
      if (uiWorkspace == null || typeof uiWorkspace.openSession !== 'function') return
      try { uiWorkspace.openSession(sessionId) } catch (error) { void error }
    }

    function applyMarker() {
      var root = typeof document === 'undefined' ? null : document.documentElement
      if (root == null) return
      root.setAttribute(ROOT_ATTR, '')
      if (mountStrategy != null && typeof root.setAttribute === 'function') {
        root.setAttribute(MOUNT_ATTR, mountStrategy)
      }
    }

    /** 打开总督面板：按挂载策略走右侧栏或 main 面板。 */
    function openGovernorPanel() {
      var ctx = currentCtx
      if (ctx == null) return
      if (mountStrategy === 'main') {
        selectPanel(PANEL_ID)
        return
      }
      var layout = serviceOf(ctx, 'layout')
      if (layout != null && typeof layout.openRightbar === 'function') {
        try { layout.openRightbar() } catch (error) { void error }
      }
      if (mountStrategy === 'pane') switchGovernorPane(ctx)
      // 面板若同时挂在 main（历史注册），这里顺路选中；未挂时 selectPanel 静默。
      selectPanel(PANEL_ID)
    }

    /** pane 策略下切到 governor 页签：注册口未实测，多形状依次试。 */
    function switchGovernorPane(ctx) {
      var sr = sidebarRightOf(ctx)
      if (sr == null) return
      var sessionId = latest.governorId
      var attempts = [
        function () { return sr.openTab(sessionId, 'governor', {}) },
        function () { return sr.openTabIn(sessionId, 'governor', {}) },
        function () { return sr.openTabIn(sessionId, 'governor', { params: {} }) },
        function () { return sr.selectPane('governor') },
        function () { return sr.select('governor') },
      ]
      for (var i = 0; i < attempts.length; i += 1) {
        try { attempts[i](); return } catch (error) {
          console.debug('[governor-mode] switch pane attempt ' + i + ' failed:', error)
        }
      }
    }

    function setWorkspace(workspaceId) {
      state.workspaceId = workspaceId
      openGovernorPanel()
      emit()
    }

    /* ====================================================================== */
    /* 宿主半 API 客户端（相对路径 fetch，失败一律回 null 不炸轮询）               */
    /* ====================================================================== */

    function apiFetch(path, options) {
      var init = { headers: { accept: 'application/json' } }
      if (options != null) {
        if (options.method != null) init.method = options.method
        if (options.body != null) {
          init.headers['content-type'] = 'application/json'
          init.body = JSON.stringify(options.body)
        }
      }
      return fetch(API_PREFIX + path, init)
        .then(function (response) { return response.ok ? response.json() : null })
        .catch(function () { return null })
    }

    function apiGet(path) { return apiFetch(path) }

    function apiPost(path, body) { return apiFetch(path, { method: 'POST', body: body }) }

    function apiPut(path, body) { return apiFetch(path, { method: 'PUT', body: body }) }

    /* ====================================================================== */
    /* 像素头像：16×16 网格 = 像素相框 + 12×12 像素脸                            */
    /* 只用于总督面板；每个角色落到 SVG 时翻译成 --dsw-* 令牌或 currentColor       */
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
      /* ---- 总督面板（右侧栏窄面板与 main 兜底同一套） ---- */
      '.dsh-gov-page{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
      '  min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 16px 0}',
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
      '.dsh-gov-head .dsh-gov-add{padding:2px 9px;font-size:15px;line-height:1.1;font-weight:600}',

      '.dsh-gov-stage{position:relative;flex:1;min-height:96px;display:flex;flex-direction:column;padding:10px 16px 0}',
      '.dsh-gov-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
      '.dsh-gov-top{flex:none;display:flex;align-items:center;justify-content:center;padding:2px 0}',
      '.dsh-gov-grid{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;',
      '  justify-content:center;gap:18px;padding-bottom:10px;overflow:hidden}',
      '.dsh-gov-row{display:flex;gap:clamp(12px,3vw,40px)}',

      /* 节点：像素头像自绘，容器不加底色与投影，只留状态色 */
      '.dsh-gov-node{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;',
      '  border:0;background:transparent;padding:0;cursor:pointer;color:inherit}',
      '.dsh-gov-face{display:block;line-height:0;border-radius:0;background:transparent;',
      '  color:var(--dsw-alias-state-idle-primary);transition:color .15s ease,opacity .15s ease}',
      '.dsh-gov-face svg{display:block;width:100%;height:100%}',
      '.dsh-gov-face--gov{width:64px;height:64px}',
      '.dsh-gov-face--sub{width:48px;height:48px}',
      '.dsh-gov-node:hover .dsh-gov-face{opacity:.86}',
      '.dsh-gov-label{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '  font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-gov-branch{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '  font-size:10px;line-height:1;padding:2px 6px;border-radius:calc(var(--dsw-radius-sm,8px) - 4px);',
      '  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption);',
      '  box-shadow:var(--dsw-elevation-stroke)}',
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
      '.dsh-gov-bubble{position:absolute;right:16px;top:52px;width:min(288px,calc(100% - 32px));z-index:3;',
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

      /* 选择题卡区：头部 autoAnswer 开关常驻，卡列表滚动 */
      '.dsh-gov-cards-wrap{flex:none;display:flex;flex-direction:column;max-height:38vh;padding:6px 16px 0}',
      '.dsh-gov-cardsbar{flex:none;display:flex;align-items:center;gap:8px;padding:2px 0 6px}',
      '.dsh-gov-cardsbar .dsh-gov-sp{flex:1}',
      '.dsh-gov-cardsempty{font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.dsh-gov-toggle{border:0;cursor:pointer;font:inherit;font-size:11px;display:inline-flex;',
      '  align-items:center;gap:5px;padding:3px 8px;border-radius:var(--dsw-radius-sm,8px);',
      '  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);',
      '  box-shadow:var(--dsw-elevation-stroke);transition:color .15s ease,background .15s ease}',
      '.dsh-gov-toggle:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-toggle[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-gov-dot2{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l4)}',
      '.dsh-gov-toggle[aria-pressed="true"] .dsh-gov-dot2{background:var(--dsw-alias-state-business-primary)}',
      '.dsh-gov-cards{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;',
      '  padding-bottom:4px}',
      '.dsh-gov-card{border-radius:var(--dsw-radius-md,12px);padding:10px 12px;flex:none;',
      '  background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-stroke)}',
      '.dsh-gov-card-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
      '.dsh-gov-card-src{flex:1;font-size:11px;color:var(--dsw-alias-label-caption);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gov-card-q{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);margin-bottom:8px}',
      '.dsh-gov-opts{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsh-gov-opt{border:0;cursor:pointer;font:inherit;font-size:12px;padding:4px 10px;',
      '  border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);',
      '  color:var(--dsw-alias-label-secondary);box-shadow:var(--dsw-elevation-stroke);',
      '  transition:background .15s ease,color .15s ease}',
      '.dsh-gov-opt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',

      /* git 区：同步灯 + 状态文本 + 三指令按钮 */
      '.dsh-gov-git{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px 0;flex-wrap:wrap}',
      '.dsh-gov-lamp{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-border-l4)}',
      '.dsh-gov-lamp[data-lamp="synced"]{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-gov-lamp[data-lamp="dirty"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-gov-gittxt{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gov-gitbtns{display:flex;gap:6px;width:100%;padding-top:6px}',
      '.dsh-gov-gitbtn{flex:1;border:0;cursor:pointer;font:inherit;font-size:11px;padding:4px 6px;',
      '  border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);',
      '  color:var(--dsw-alias-label-secondary);box-shadow:var(--dsw-elevation-stroke);',
      '  transition:background .15s ease,color .15s ease}',
      '.dsh-gov-gitbtn:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dsh-gov-gitbtn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;background:var(--dsw-alias-bg-layer-1)}',

      /* 输入井：目标下拉 + 文本 + 发送 */
      '.dsh-gov-input{flex:none;padding:10px 16px 14px}',
      '.dsh-gov-well{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 8px;border:0;',
      '  border-radius:var(--dsw-radius-md,12px);',
      '  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));',
      '  box-shadow:var(--dsw-elevation-stroke)}',
      '.dsh-gov-well:focus-within{box-shadow:var(--dsw-elevation-stroke),0 0 0 var(--dsw-focus-ring-width,2px) ',
      '  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dsh-gov-target{flex:none;max-width:92px;border:0;font:inherit;font-size:12px;height:26px;',
      '  padding:0 4px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);',
      '  color:var(--dsw-alias-label-secondary);outline:none;text-overflow:ellipsis}',
      '.dsh-gov-well textarea{flex:1;min-width:0;min-height:22px;max-height:120px;resize:none;border:0;outline:none;',
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
    /* 数据读取与纯函数                                                          */
    /* ====================================================================== */

    /** 选择器保持稳定引用，避免每次渲染重新订阅。 */
    function pickItems(snapshot) { return snapshot == null ? null : snapshot.items }
    function pickById(snapshot) { return snapshot == null ? null : snapshot.byId }
    function pickWhole(snapshot) { return snapshot }

    /** 语义状态：warning > ongoing > done > idle（本地状态行版本，v1 沿用）。 */
    function stateOf(summary, status) {
      if (status != null && status.pendingInteraction != null) return 'warning'
      if (summary != null && summary.running === true) return 'ongoing'
      if (status != null && status.running === true) return 'ongoing'
      if (status != null && typeof status.state === 'string') return status.state
      if (summary != null && summary.completed === true) return 'done'
      return 'idle'
    }

    /** 融合宿主半 roster 行与本地状态行（API 优先，本地兜底）。 */
    function fusedState(summary, entry, local) {
      var pending = (entry != null && entry.pendingInteraction === true) ||
        (local != null && local.pendingInteraction === true)
      if (pending) return 'warning'
      var running = (entry != null && entry.running === true) ||
        (local != null && local.running === true) ||
        (summary != null && summary.running === true)
      if (running) return 'ongoing'
      if (local != null && typeof local.state === 'string') return local.state
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

    /** 轮询间隔：页面不可见时统一降到 HIDDEN_MS。 */
    function pollDelayMs(activeMs, hidden) {
      return hidden === true ? HIDDEN_MS : activeMs
    }

    /** 侧栏点击放行判定：白名单控件放行，其余行点击拦截。 */
    function shouldPass(target) {
      if (target == null || typeof target.closest !== 'function') return false
      try { return target.closest(PASS_SELECTOR) != null } catch (error) { return false }
    }

    /** 输入井目标列表：总督 + 各手下 + 全体（有手下才有全体）。 */
    function targetsOf(governorId, subs, titleOf) {
      var list = []
      if (governorId != null) list.push({ id: governorId, label: '总督' })
      var ids = Array.isArray(subs) ? subs : []
      for (var i = 0; i < ids.length; i += 1) {
        var title = typeof titleOf === 'function' ? titleOf(ids[i]) : ''
        list.push({ id: ids[i], label: title || '未命名会话' })
      }
      if (ids.length > 0) list.push({ id: '__all__', label: '全体' })
      return list
    }

    /** git-state 的 workers → 手下分支名：sub/<名> 的 <名> 对上会话标题即命中。 */
    function branchForSession(title, workers) {
      if (workers == null || typeof workers !== 'object') return null
      var keys = Object.keys(workers)
      for (var i = 0; i < keys.length; i += 1) {
        var match = /^sub\/(.+)$/.exec(keys[i])
        if (match == null) continue
        if (typeof title === 'string' && (title === match[1] || title.indexOf(match[1]) === 0)) return keys[i]
      }
      return null
    }

    /** git-state 里的预览地址：只认合法 http(s) 字符串。 */
    function previewUrlOf(state) {
      if (state == null || typeof state !== 'object') return null
      var url = state.previewUrl != null ? state.previewUrl : state.preview
      if (typeof url !== 'string') return null
      url = url.trim()
      return /^https?:\/\//.test(url) ? url : null
    }

    /** 差集：list 里 known 未见过的工作区。 */
    function diffNewWorkspaces(known, list) {
      var fresh = []
      if (Array.isArray(list) !== true) return fresh
      for (var i = 0; i < list.length; i += 1) {
        var id = list[i] != null ? list[i].workspaceId : null
        if (id == null || (known != null && known.has(id))) continue
        fresh.push(list[i])
      }
      return fresh
    }

    /* ====================================================================== */
    /* 新建工作区 = 新建总督（差集检测 + 懒建 + 提示词注入）                          */
    /* ====================================================================== */

    function lazyCreate(ws) {
      var wid = ws.workspaceId
      if (creating.has(wid)) return
      creating.add(wid)
      var ui = serviceOf(currentCtx, 'uiWorkspace')
      if (ui == null || typeof ui.startSession !== 'function') {
        creating.delete(wid)
        return
      }
      try { ui.startSession(wid) } catch (error) {
        creating.delete(wid)
        console.debug('[governor-mode] startSession failed:', error)
      }
    }

    /** 新建手下子会话：总督栏右侧加号是唯一入口。 */
    function addWorkerSession(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return
      var ui = serviceOf(currentCtx, 'uiWorkspace')
      if (ui == null || typeof ui.startSession !== 'function') return
      try { ui.startSession(workspaceId) } catch (error) {
        console.debug('[governor-mode] startSession failed:', error)
      }
    }

    function postBootstrap(sessionId, workspaceId, title, sessions) {
      return apiPost('/bootstrap', {
        session: sessionId,
        workspace: workspaceId,
        title: title,
        sessions: sessions,
      }).then(function (body) {
        return body != null && body.ok === true
      }).catch(function () { return false })
    }

    /** 本插件懒建的工作区会话就位后注入总督提示词（失败回滚，下轮重试）。 */
    function bootstrapWorkspace(ws) {
      var wid = ws.workspaceId
      var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
      bootstrapped.add(wid)
      creating.delete(wid)
      postBootstrap(ids[0], wid, ws.title || wid, ids.slice(1, 1 + MAX_SUB)).then(function (ok) {
        if (ok !== true) bootstrapped.delete(wid)
      })
    }

    /**
     * 差集驱动的工作区看护：新工作区（受 autostart）无会话则懒建总督；
     * 本插件懒建的工作区会话就位后注入总督提示词（用户既有会话不打扰）。
     */
    function ensureGovernor(list, autostart) {
      var fresh = diffNewWorkspaces(knownWorkspaces, list)
      for (var i = 0; i < fresh.length; i += 1) {
        var ws = fresh[i]
        knownWorkspaces.add(ws.workspaceId)
        var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
        if (ids.length === 0 && autostart !== false) {
          ownedWorkspaces.add(ws.workspaceId)
          lazyCreate(ws)
        }
      }
      if (Array.isArray(list) !== true) return
      for (var j = 0; j < list.length; j += 1) {
        var ws2 = list[j]
        if (ws2 == null || ws2.workspaceId == null) continue
        if (ownedWorkspaces.has(ws2.workspaceId) !== true) continue
        if (bootstrapped.has(ws2.workspaceId)) continue
        var ids2 = Array.isArray(ws2.sessionIds) ? ws2.sessionIds : []
        if (ids2.length === 0) continue
        bootstrapWorkspace(ws2)
      }
    }

    /**
     * 新建工作面板 = 官方目录选择器 + 官方工作区创建；新工作区由差集轮询自动补总督会话与
     * 提示词。用户取消选择、官方服务缺席都静默返回，失败只落 console.debug。
     */
    function createWorkspacePanel() {
      var ui = serviceOf(currentCtx, 'uiWorkspace')
      var workspaces = serviceOf(currentCtx, 'workspaces')
      if (ui == null || typeof ui.pickDirectory !== 'function') return
      if (workspaces == null || typeof workspaces.create !== 'function') return
      var picked
      try { picked = ui.pickDirectory() } catch (error) { return }
      if (picked == null || typeof picked.then !== 'function') return
      picked.then(function (dir) {
        var path = typeof dir === 'string' ? dir : dir != null ? dir.path : null
        if (typeof path !== 'string' || path === '') return null
        return workspaces.create({ path: path })
      }).then(function (workspace) {
        if (workspace == null || workspace.workspaceId == null) return
        setWorkspace(workspace.workspaceId)
      }).catch(function (error) {
        console.debug('[governor-mode] create workspace failed:', error)
      })
    }

    /* ====================================================================== */
    /* 轮询 hook                                                               */
    /* ====================================================================== */

    /** 周期跑 fn；document.hidden 时统一降到 HIDDEN_MS，卸载清干净。 */
    function usePoll(fn, activeMs) {
      var saved = react.useRef(fn)
      saved.current = fn
      react.useEffect(function () {
        var timer = 0
        var stopped = false
        function tick() {
          if (stopped) return
          try { saved.current() } catch (error) { void error }
          var hidden = typeof document !== 'undefined' && document.hidden === true
          timer = setTimeout(tick, pollDelayMs(activeMs, hidden))
        }
        timer = setTimeout(tick, activeMs)
        return function () {
          stopped = true
          clearTimeout(timer)
        }
      }, [activeMs])
    }

    /* ====================================================================== */
    /* 草稿搬运桥：发提示词失败时把文字交给目标会话的 composer（v1 手法）            */
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
    /* 发送通路：POST /prompt 优先，失败降级草稿搬运桥                              */
    /* ====================================================================== */

    function sendPrompt(sessionId, text) {
      return apiPost('/prompt', { session: sessionId, text: text })
        .then(function (body) { return body != null && body.ok === true })
        .catch(function () { return false })
    }

    /** 给会话发提示词；控制平面不通时降级为「打开会话 + 草稿搬运」。 */
    function deliver(sessionId, text) {
      sendPrompt(sessionId, text).then(function (ok) {
        if (ok === true) return
        state.draft = { sessionId: sessionId, text: text }
        openSession(sessionId)
      })
    }

    /* ====================================================================== */
    /* 预览：右侧栏切到内置浏览器页签（element-picker 记载的通路）                  */
    /* ====================================================================== */

    function openPreviewTab(url) {
      var ctx = currentCtx
      var sr = sidebarRightOf(ctx)
      if (sr == null) return
      var sessionId = latest.governorId
      var attempts = [
        function () { return sr.openTabIn(sessionId, 'browser', { params: { url: url } }) },
        function () { return sr.openTab(sessionId, 'browser', { url: url }) },
      ]
      for (var i = 0; i < attempts.length; i += 1) {
        try { attempts[i](); return } catch (error) {
          console.debug('[governor-mode] openTab attempt ' + i + ' failed:', error)
        }
      }
    }

    /* ====================================================================== */
    /* 总督面板（四区：roster / 选择题卡 / git / 输入井）                          */
    /* ====================================================================== */

    function GovernorPanel(props) {
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

      var wsId = workspace != null ? workspace.workspaceId : ''
      var sessionIds = workspace != null && Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      var governorId = sessionIds.length > 0 ? sessionIds[0] : null
      var subIds = sessionIds.slice(1, 1 + MAX_SUB)

      latest.workspaceId = wsId || null
      latest.governorId = governorId

      var stageRef = react.useRef(null)
      var wirePair = react.useState([])
      var wires = wirePair[0]
      var setWires = wirePair[1]

      var rosterPair = react.useState({})
      var rosterMap = rosterPair[0]
      var setRosterMap = rosterPair[1]
      var questionsPair = react.useState([])
      var questions = questionsPair[0]
      var setQuestions = questionsPair[1]
      var settingsPair = react.useState({ autoAnswer: false, autostart: true })
      var settings = settingsPair[0]
      var setSettings = settingsPair[1]
      var gitPair = react.useState(null)
      var gitState = gitPair[0]
      var setGitState = gitPair[1]
      var answeredPair = react.useState({})
      var answered = answeredPair[0]
      var setAnswered = answeredPair[1]
      var targetPair = react.useState('')
      var target = targetPair[0]
      var setTarget = targetPair[1]
      var draftPair = react.useState('')
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      var workers = gitState != null && gitState.available === true &&
        gitState.state != null && typeof gitState.state.workers === 'object'
        ? gitState.state.workers : null

      function entryOf(id) {
        return rosterMap != null && typeof rosterMap === 'object' ? rosterMap[id] : null
      }

      function titleOfId(id) {
        var entry = entryOf(id)
        var title = entry != null && typeof entry.title === 'string' && entry.title !== ''
          ? entry.title : titleOf(summaries[id])
        return title || '未命名会话'
      }

      function statusOf(id) {
        var local = statusMap != null && typeof statusMap.get === 'function' ? statusMap.get(id) : null
        return fusedState(summaries[id], entryOf(id), local)
      }

      function refreshCore() {
        ensureGovernor(list, settings.autostart)
        if (sessionIds.length === 0) return
        var sessions = sessionIds.join(',')
        Promise.all([
          apiGet('/roster?sessions=' + encodeURIComponent(sessions) + '&workspace=' + encodeURIComponent(wsId)),
          apiGet('/questions?sessions=' + encodeURIComponent(sessions)),
          apiGet('/settings?workspace=' + encodeURIComponent(wsId)),
        ]).then(function (answers) {
          var rosterBody = answers[0]
          var questionsBody = answers[1]
          var settingsBody = answers[2]
          if (rosterBody != null && rosterBody.ok === true && Array.isArray(rosterBody.sessions)) {
            var next = {}
            rosterBody.sessions.forEach(function (entry) {
              if (entry != null && entry.id != null) next[entry.id] = entry
            })
            if (JSON.stringify(next) !== JSON.stringify(rosterMap)) setRosterMap(next)
          }
          if (questionsBody != null && questionsBody.ok === true && Array.isArray(questionsBody.questions)) {
            if (JSON.stringify(questionsBody.questions) !== JSON.stringify(questions)) {
              setQuestions(questionsBody.questions)
            }
          }
          if (settingsBody != null && settingsBody.ok === true && settingsBody.settings != null) {
            var nextSettings = {
              autoAnswer: settingsBody.settings.autoAnswer === true,
              autostart: settingsBody.settings.autostart !== false,
            }
            if (JSON.stringify(nextSettings) !== JSON.stringify(settings)) setSettings(nextSettings)
          }
        }).catch(function () { void 0 })
      }

      function refreshGit() {
        if (governorId == null) {
          if (gitState !== null) setGitState(null)
          return
        }
        apiGet('/git-state?session=' + encodeURIComponent(governorId)).then(function (body) {
          var next = body != null && body.ok === true ? body : null
          if (JSON.stringify(next) !== JSON.stringify(gitState)) setGitState(next)
        }).catch(function () { void 0 })
      }

      usePoll(refreshCore, ROSTER_MS)
      usePoll(refreshGit, GIT_MS)
      var wsKey = sessionIds.join(',')
      react.useEffect(function () {
        refreshCore()
        refreshGit()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [wsId, wsKey])

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [subKey, wsId])

      /* ---- 选择题卡 ---- */

      function setAnsweredItem(key, value) {
        var next = {}
        for (var name in answered) next[name] = answered[name]
        if (value === true) next[key] = true
        else delete next[key]
        setAnswered(next)
      }

      function answerOne(question, label) {
        var key = String(question.session) + ':' + String(question.callId) + ':' + String(question.id)
        setAnsweredItem(key, true)
        apiPost('/answer', {
          session: question.session,
          choice: label,
          callId: question.callId,
        }).then(function (body) {
          if (body != null && body.ok === true) return
          setAnsweredItem(key, false)
        }).catch(function () { setAnsweredItem(key, false) })
      }

      function toggleAutoAnswer() {
        var next = {
          autoAnswer: settings.autoAnswer !== true,
          autostart: settings.autostart !== false,
        }
        apiPut('/settings', { workspace: wsId, settings: next }).then(function (body) {
          if (body != null && body.ok === true) setSettings(next)
        }).catch(function () { void 0 })
      }

      var visibleQuestions = []
      for (var qi = 0; qi < questions.length; qi += 1) {
        var q = questions[qi]
        if (q == null || typeof q !== 'object') continue
        var key = String(q.session) + ':' + String(q.callId) + ':' + String(q.id)
        if (answered[key] === true) continue
        visibleQuestions.push(q)
      }

      var cardsBar = react.createElement(
        'div',
        { className: 'dsh-gov-cardsbar' },
        react.createElement('button', {
          type: 'button',
          className: 'dsh-gov-toggle',
          'aria-pressed': settings.autoAnswer === true,
          title: '自动作答：开 = 总督按推理选最佳并说明理由，主观题仍问用户；关 = 全部汇报用户',
          onClick: toggleAutoAnswer,
        }, react.createElement('span', { className: 'dsh-gov-dot2' }), '自动作答'),
        react.createElement('span', { className: 'dsh-gov-sp' }),
        react.createElement(
          'span',
          { className: 'dsh-gov-cardsempty' },
          visibleQuestions.length === 0 ? '暂无待答' : visibleQuestions.length + ' 条待答',
        ),
      )

      var cards = visibleQuestions.map(function (question, index) {
        var options = Array.isArray(question.options) ? question.options : []
        return react.createElement(
          'div',
          { className: 'dsh-gov-card', key: 'q' + index },
          react.createElement(
            'div',
            { className: 'dsh-gov-card-head' },
            react.createElement('span', { className: 'dsh-gov-card-src' }, titleOfId(question.session)),
          ),
          react.createElement('div', { className: 'dsh-gov-card-q' }, question.question || '（未提供题面）'),
          react.createElement(
            'div',
            { className: 'dsh-gov-opts' },
            options.map(function (option, oi) {
              var label = option != null && typeof option.label === 'string' ? option.label : String(option)
              return react.createElement('button', {
                key: 'o' + oi,
                type: 'button',
                className: 'dsh-gov-opt',
                onClick: function () { answerOne(question, label) },
              }, label)
            }),
          ),
        )
      })

      var cardsWrap = react.createElement(
        'div',
        { className: 'dsh-gov-cards-wrap' },
        cardsBar,
        react.createElement('div', { className: 'dsh-gov-cards' }, cards),
      )

      /* ---- git 区 ---- */

      function commandGovernor(text) {
        if (governorId == null) return
        deliver(governorId, text)
      }

      var gitBody = gitState != null && gitState.ok === true ? gitState : null
      var gitSnapshot = gitBody != null && gitBody.available === true &&
        gitBody.state != null && typeof gitBody.state === 'object' ? gitBody.state : null
      var devSynced = gitSnapshot != null && gitSnapshot.devSynced === true
      var ahead = gitSnapshot != null && typeof gitSnapshot.ahead === 'number' ? gitSnapshot.ahead : null
      var behind = gitSnapshot != null && typeof gitSnapshot.behind === 'number' ? gitSnapshot.behind : null
      var lamp = gitSnapshot == null ? 'none' : (devSynced ? 'synced' : 'dirty')
      var gitText = gitSnapshot == null ? '待总督汇报'
        : devSynced ? 'dev 已同步'
          : 'dev 未同步' + (ahead != null ? ' ↑' + ahead : '') + (behind != null ? ' ↓' + behind : '')
      var previewUrl = previewUrlOf(gitSnapshot)

      var gitSection = react.createElement(
        'div',
        { className: 'dsh-gov-git' },
        react.createElement('span', { className: 'dsh-gov-lamp', 'data-lamp': lamp }),
        react.createElement('span', { className: 'dsh-gov-gittxt' }, gitText),
        react.createElement('span', { className: 'dsh-gov-sp' }),
        react.createElement(
          'div',
          { className: 'dsh-gov-gitbtns' },
          react.createElement('button', {
            type: 'button',
            className: 'dsh-gov-gitbtn',
            disabled: governorId == null,
            onClick: function () {
              commandGovernor('请把 dev 分支同步到 GitHub，完成后更新 .governor/state.json（devSynced/ahead/behind/updatedAt/workers）。')
            },
          }, '同步 GitHub'),
          react.createElement('button', {
            type: 'button',
            className: 'dsh-gov-gitbtn',
            disabled: governorId == null,
            onClick: function () {
              commandGovernor('请汇报：各手下当前进展、待决事项、dev 与 origin 的同步状态。')
            },
          }, '汇报'),
          react.createElement('button', {
            type: 'button',
            className: 'dsh-gov-gitbtn',
            disabled: previewUrl == null,
            title: previewUrl == null ? 'git-state 里没有可用的预览地址' : previewUrl,
            onClick: function () { openPreviewTab(previewUrl) },
          }, '预览'),
        ),
      )

      /* ---- roster 舞台 ---- */

      var rows = rowsOf(subIds.length)
      var cursor = 0
      var grid = rows.map(function (count, rowIndex) {
        var slice = subIds.slice(cursor, cursor + count)
        cursor += count
        return react.createElement(
          'div',
          { className: 'dsh-gov-row', key: 'row-' + rowIndex },
          slice.map(function (id) {
            var label = titleOfId(id)
            var branch = branchForSession(titleOfId(id), workers)
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
              branch == null ? null : react.createElement('span', { className: 'dsh-gov-branch' }, branch),
            )
          }),
        )
      })

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
        react.createElement('button', {
          type: 'button',
          className: 'dsh-gov-action dsh-gov-add',
          disabled: workspace == null || subIds.length >= MAX_SUB,
          title: '新建手下子会话',
          onClick: function () { if (workspace != null) addWorkerSession(workspace.workspaceId) },
        }, '+'),
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

      /* ---- 输入井 ---- */

      var targets = targetsOf(governorId, subIds, titleOfId)
      var activeTarget = target
      if (activeTarget === '' || targets.every(function (t) { return t.id !== activeTarget })) {
        activeTarget = targets.length > 0 ? targets[0].id : ''
      }

      function submit() {
        var text = draft.trim()
        if (text === '') return
        setDraft('')
        var id = activeTarget
        if (id === '' || id == null) {
          if (governorId != null) deliver(governorId, text)
          return
        }
        if (id === '__all__') {
          var ids = []
          if (governorId != null) ids.push(governorId)
          ids = ids.concat(subIds)
          if (ids.length === 0) return
          Promise.all(ids.map(function (sid) { return sendPrompt(sid, text) })).then(function (results) {
            var anyOk = results.some(function (r) { return r === true })
            if (anyOk === true || governorId == null) return
            state.draft = { sessionId: governorId, text: text }
            openSession(governorId)
          })
          return
        }
        deliver(id, text)
      }

      var input = react.createElement(
        'div',
        { className: 'dsh-gov-input' },
        react.createElement(
          'div',
          { className: 'dsh-gov-well' },
          targets.length > 0 ? react.createElement('select', {
            className: 'dsh-gov-target',
            value: activeTarget,
            'aria-label': '发送目标',
            onChange: function (event) { setTarget(event.target.value) },
          }, targets.map(function (t) {
            return react.createElement('option', { key: t.id, value: t.id }, t.label)
          })) : null,
          react.createElement('textarea', {
            rows: 1,
            value: draft,
            placeholder: governorId == null ? '先在这个工作区新建会话' : '发给…',
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
            'aria-label': '发送',
            onClick: submit,
          }, '↑'),
        ),
        react.createElement(
          'div',
          { className: 'dsh-gov-hint' },
          'Enter 发送 · 失败时落入目标输入框',
        ),
      )

      return react.createElement(
        'div',
        { className: 'dsh-gov-page' },
        head,
        stage,
        cardsWrap,
        gitSection,
        input,
      )
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
    /* 侧栏拦截：新建会话按钮 → 新建工作面板；点工作区行 → 打开总督面板（行内控件放行） */
    /* ====================================================================== */

    /** 命中 DSH 原生新建会话控件（侧栏图标按钮 / macOS 折叠态的窗口控件）。 */
    function isNewSessionControl(target) {
      if (target == null || typeof target.closest !== 'function') return false
      try { return target.closest(NEW_SESSION_SELECTOR) != null } catch (error) { return false }
    }

    /** 叶子节点文案替换：悬停提示里的「新建会话」→「新建工作面板」。 */
    function relabel(node) {
      if (node == null || node.nodeType !== 1) return
      if (node.children != null && node.children.length > 0) return
      if (node.textContent != null && node.textContent.trim() === '新建会话') node.textContent = PANEL_LABEL
    }

    function relabelNewSession(root) {
      if (root == null || typeof root.querySelectorAll !== 'function') return
      relabel(root)
      var hits = []
      try { hits = root.querySelectorAll('*') } catch (error) { return }
      for (var i = 0; i < hits.length; i += 1) relabel(hits[i])
    }

    /**
     * 悬停提示文案改写。sidebar 命名空间已被官方占用（ctx.locale.register 对同一命名空间
     * 的同一语言会抛错），只能改文案本身；aria-label 保持官方原样——拦截器靠它定位按钮。
     */
    function watchNewSessionLabel() {
      if (typeof MutationObserver !== 'function' || document.body == null) return function () {}
      relabelNewSession(document.body)
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var added = records[i].addedNodes
          for (var j = 0; j < added.length; j += 1) {
            var node = added[j]
            if (node == null || node.nodeType !== 1) continue
            if (node.textContent == null || node.textContent.indexOf('新建会话') === -1) continue
            relabelNewSession(node)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return function () { observer.disconnect() }
    }

    function installSidebarInterceptor() {
      function onClick(event) {
        var target = event.target
        if (target == null || typeof target !== 'object') return
        // DSH 原生「新建会话」＝总督模式下的「新建工作面板」：拦下来，改建一个工作区。
        if (isNewSessionControl(target) === true) {
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          createWorkspacePanel()
          return
        }
        // 行内动作（更多 / 官方展开控件 / 工作区行内的新建会话）照旧放行。
        if (shouldPass(target) === true) return
        if (typeof target.closest !== 'function') return
        var row = null
        try { row = target.closest('[data-row-key^="workspace:"]') } catch (error) { row = null }
        if (row == null) return
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        var key = row.getAttribute('data-row-key') || ''
        setWorkspace(key.slice('workspace:'.length))
      }
      document.addEventListener('click', onClick, true)
      var stopWatching = watchNewSessionLabel()
      return function () {
        document.removeEventListener('click', onClick, true)
        stopWatching()
      }
    }

    /* ====================================================================== */
    /* 挂载：三策略自适应（pane → 内容槽遮蔽 → main 兜底），命中即停              */
    /* ====================================================================== */

    function markStrategy(strategy) {
      mountStrategy = strategy
      applyMarker()
      console.debug('[governor-mode] panel mounted via', strategy)
    }

    function currentStrategy() { return mountStrategy }

    /** 策略二：keyed 内容槽遮蔽（priority -1；参数固化槽名，注入器延迟调用也安全）。 */
    function mountOnRightSlot(ctx, slotName) {
      return ctx.slots.inject(slotName, function () {
        return ctx.slots.register({ name: slotName, priority: -1 }, GovernorPanel)
      })
    }

    function mountPanel(ctx) {
      /* 策略一：右侧栏 pane 注册（排最前）。 */
      var sr = sidebarRightOf(ctx)
      if (sr != null) {
        var attempts = [
          function () { return sr.registerPane('governor', GovernorPanel) },
          function () { return sr.registerPane({ key: 'governor', component: GovernorPanel }) },
          function () { return sr.register({ key: 'governor', component: GovernorPanel }) },
          function () { return sr.register('governor', GovernorPanel) },
        ]
        for (var i = 0; i < attempts.length; i += 1) {
          try {
            var dispose = attempts[i]()
            markStrategy('pane')
            return typeof dispose === 'function' ? dispose : function () {}
          } catch (error) {
            console.debug('[governor-mode] pane attempt ' + i + ' failed:', error)
          }
        }
      }
      /* 策略二：右侧栏内容槽遮蔽，首个不抛错的候选即命中。 */
      for (var j = 0; j < RIGHT_SLOT_CANDIDATES.length; j += 1) {
        var slotName = RIGHT_SLOT_CANDIDATES[j]
        try {
          var disposeSlot = mountOnRightSlot(ctx, slotName)
          markStrategy('slot:' + slotName)
          return disposeSlot
        } catch (error) {
          console.debug('[governor-mode] slot ' + slotName + ' failed:', error)
        }
      }
      /* 策略三：main keyed 面板（v1 已验证的兜底形态）。 */
      var disposeMain = ctx.slots.inject(MAIN_SLOT, function () {
        return ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, GovernorPanel)
      })
      markStrategy('main')
      return disposeMain
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
          if (root != null) {
            root.removeAttribute(ROOT_ATTR)
            root.removeAttribute(MOUNT_ATTR)
          }
        }
      }, 'governor-mode: root marker')
      ctx.effect(function () { return installSidebarInterceptor() }, 'governor-mode: sidebar intercept')
      ctx.effect(function () {
        return mountPanel(ctx)
      }, 'governor-mode: governor panel')
      ctx.effect(function () {
        return ctx.slots.inject(DRAFT_SLOT, function () {
          return ctx.slots.register({ name: DRAFT_SLOT, id: 'governor-mode-bridge', order: 90 }, DraftBridge)
        })
      }, 'governor-mode: draft bridge')
    }

    exports.name = 'governor-mode'
    exports.apply = apply
    // 只声明 'slots'（同 element-picker）：layout/uiWorkspace 不是 Cordis 客户端
    // 服务名，声明即激活失败；对它们一律防御式访问，缺席时静默降级。
    exports.inject = ['slots']
    exports.__internals = {
      state, rowsOf, stateOf, fusedState, titleOf, hashId, faceCells, pixelAvatar,
      measureWires, STYLESHEET, shouldPass, pollDelayMs, targetsOf, branchForSession,
      previewUrlOf, diffNewWorkspaces, ensureGovernor, sendPrompt, deliver,
      currentStrategy, PASS_SELECTOR, MAX_SUB, NEW_SESSION_SELECTOR, isNewSessionControl,
      addWorkerSession, createWorkspacePanel,
    }
    return module.exports
  },
})
