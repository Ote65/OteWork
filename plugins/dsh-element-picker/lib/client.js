/**
 * dsh-element-picker — browser half.
 *
 * Two surfaces, both in the built-in browser rather than the composer:
 *
 *  1. A **toggle in the browser tab's title chip** (the browser's top row). The
 *     right Sidebar's tab title is a keyed Slot, and its occupant receives both
 *     `sessionId` and `inputActions` — so the control can live in the browser
 *     chrome and still insert into the right composer. The shipped browser title
 *     is re-rendered alongside it (globe + live page title).
 *  2. An **overlay injected into the preview**: hovering outlines the element,
 *     shows its tag, and offers a “添加到对话” button — the Trae-style gesture.
 *
 * Picking stays armed after each insert so several elements can be added in a
 * row; Esc or the toggle ends the mode.
 *
 * ## Reaching into the preview
 *
 * Desktop renders a `<webview>` (`data-sidebar-browser-frame="webview"`, a
 * sandboxed `partition`) and the app enables `webviewTag`, so the embedder can
 * call `webview.executeJavaScript(...)`. The web-hosted build falls back to
 * `<iframe>`, where cross-origin content is unreadable by design, and the mode
 * reports that instead of failing silently.
 *
 * ## Staying in the right session
 *
 * Other sessions' right bars stay mounted, so the preview is resolved inside
 * `[data-sidebar-right-session="<this session>"]` only.
 *
 * @module dsh-element-picker/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-element-picker',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var reactDom = require('react-dom')

    /* Only seeded modules are required (`react`, `react-dom`).
     * `@deepseek-ai/dsh-client-ui-primitives` is seeded too, but requiring it
     * from a plugin bundle fails, so the glyphs are drawn inline. */

    /** The keyed seat: the browser tab's title chip. */
    var TITLE_SLOT = 'sidebar.right.pane.tab.title'

    /** The browser type's key, i.e. its registration id. */
    var BROWSER_KEY = '@deepseek-ai/dsh-client-ui-sidebar-browser'

    /** The injected picker's element attribute, used to find the live preview. */
    var FRAME_ATTR = 'data-sidebar-browser-frame'

    /** How long one pick may stay armed before giving up. */
    var PICK_TIMEOUT_MS = 600000

    /** Strings for the two locales the harness ships. */
    var DICTIONARIES = {
      zh: {
        label: '引用',
        title: '开启选择元素模式',
        hint: '点击预览中的元素',
        add: '添加到对话',
        cancel: '取消',
        noPreview: '本会话没有可见的预览',
        noBridge: '当前预览不支持元素引用',
        failed: '引用失败',
        conflict: '草稿已变更，请重试',
        esc: 'Esc',
      },
      en: {
        label: 'Pick',
        title: 'Enable element selection',
        hint: 'Click an element in the preview',
        add: 'Add to chat',
        cancel: 'Cancel',
        noPreview: 'No visible preview in this session',
        noBridge: 'This preview does not support element references',
        failed: 'Reference failed',
        conflict: 'Draft changed, please retry',
        esc: 'Esc',
      },
    }

    /* ====================================================================== */
    /* The script injected into the preview                                    */
    /* ====================================================================== */

    /**
     * Self-contained picker: a highlight box, a tag badge and an “add to chat”
     * button, all following the hovered element. Resolves with a descriptor when
     * the button (or the element) is clicked, and `null` on Escape.
     *
     * Everything is `pointer-events: none` except the button, so the overlay
     * never steals a click from the previewed app.
     *
     * Written without template literals or `${` on purpose: the whole thing is a
     * string evaluated in the guest.
     */
    var PICKER_SOURCE = `(function () {
  var KEY = '__dshElementPicker';
  var previous = window[KEY];
  if (previous && typeof previous.cancel === 'function') { try { previous.cancel(); } catch (error) {} }

  return new Promise(function (resolve) {
    var doc = document;
    var done = false;
    var target = null;
    var ADD_LABEL = ADD_LABEL_TEXT;

    function escapeHtml(value) {
      return String(value).replace(/[&<>"]/g, function (character) {
        return character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&quot;';
      });
    }

    var style = doc.createElement('style');
    style.setAttribute('data-dsh-picker', 'style');
    style.textContent = [
      '[data-dsh-picker="box"]{position:fixed;pointer-events:none;z-index:2147483646;',
      'border:1.5px solid #4176e6;border-radius:3px;',
      'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(65,118,230,.22);',
      'transition:left .04s linear,top .04s linear,width .04s linear,height .04s linear}',
      '[data-dsh-picker="bar"]{position:fixed;pointer-events:none;z-index:2147483647;',
      'display:flex;align-items:center;gap:0;',
      'font:500 11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'border-radius:6px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.28)}',
      '[data-dsh-picker="tag"]{padding:3px 7px;background:rgba(15,17,21,.94);color:#7aaaff;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(46vw,340px)}',
      '[data-dsh-picker="add"]{pointer-events:auto;border:0;cursor:pointer;',
      'padding:3px 9px;background:#4176e6;color:#fff;font:inherit;white-space:nowrap}',
      '[data-dsh-picker="add"]:hover{background:#3a69cf}',
    ].join('');
    (doc.head || doc.documentElement).appendChild(style);

    var box = doc.createElement('div');
    box.setAttribute('data-dsh-picker', 'box');
    var bar = doc.createElement('div');
    bar.setAttribute('data-dsh-picker', 'bar');
    var tag = doc.createElement('span');
    tag.setAttribute('data-dsh-picker', 'tag');
    var add = doc.createElement('button');
    add.setAttribute('data-dsh-picker', 'add');
    add.type = 'button';
    add.textContent = ADD_LABEL;
    bar.appendChild(tag);
    bar.appendChild(add);
    doc.documentElement.appendChild(box);
    doc.documentElement.appendChild(bar);

    /** This instance's own registration, so cleanup never unregisters a newer one. */
    var registration = { cancel: function () { finish(null); } };

    function cleanup() {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove, true);
      add.removeEventListener('click', onAdd, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      if (style.parentNode) style.parentNode.removeChild(style);
      if (window[KEY] === registration) {
        try { delete window[KEY]; } catch (error) { window[KEY] = undefined; }
      }
    }

    function finish(value) {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    }

    /** Prefer an id, then a short, stable class path. */
    function buildSelector(element) {
      var parts = [];
      var node = element;
      while (node && node.nodeType === 1 && parts.length < 4) {
        var part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift('#' + node.id);
          break;
        }
        var names = [];
        for (var index = 0; index < node.classList.length && names.length < 2; index++) {
          var name = node.classList[index];
          /* Skip hashed CSS-module / CSS-in-JS noise: "_a1b2c3_x", "css-1x2y3z". */
          if (/^_?[A-Za-z]+[_-][A-Za-z0-9_-]{5,}$/.test(name) || /^(css|sc|jsx)-[A-Za-z0-9]{5,}$/.test(name)) continue;
          names.push(name);
        }
        if (names.length > 0) part += '.' + names.join('.');
        var parent = node.parentElement;
        if (parent) {
          var same = [];
          for (var child = 0; child < parent.children.length; child++) {
            if (parent.children[child].tagName === node.tagName) same.push(parent.children[child]);
          }
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    /** Accessibility and identity attributes worth handing to an Agent. */
    function readAttrs(element) {
      var names = ['role', 'aria-label', 'alt', 'title', 'placeholder', 'name', 'type', 'href', 'src', 'data-testid'];
      var out = {};
      for (var index = 0; index < names.length; index++) {
        var value = element.getAttribute(names[index]);
        if (value !== null && value !== '') out[names[index]] = String(value).slice(0, 120);
      }
      return out;
    }

    /** Nearest React component name plus its call-site source location. */
    function reactInfo(element) {
      var node = element;
      while (node) {
        var keys = Object.keys(node);
        for (var index = 0; index < keys.length; index++) {
          var key = keys[index];
          if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue;
          var fiber = node[key];
          while (fiber) {
            var type = fiber.type;
            var name = null;
            if (typeof type === 'function') name = type.displayName || type.name || null;
            else if (type && typeof type === 'object') {
              var inner = type.render;
              name = type.displayName || (typeof inner === 'function' ? inner.displayName || inner.name : null) || null;
            }
            if (name && /^[A-Z]/.test(name)) {
              var source = fiber._debugSource || null;
              var file = source && source.fileName ? String(source.fileName) : null;
              var line = source && source.lineNumber ? source.lineNumber : null;
              var column = source && source.columnNumber ? source.columnNumber : null;
              /* React 19 removed _debugSource; the JSX call site now lives in
               * _debugStack (an Error captured at element creation). Take the
               * first frame that is not inside React or node_modules. */
              if (file === null && fiber._debugStack && fiber._debugStack.stack) {
                var frames = String(fiber._debugStack.stack).split('\\n');
                for (var f = 0; f < frames.length; f++) {
                  var hit = /(https?:\\/\\/[^\\s)]+|[A-Za-z]:[^\\s):]+|\\/[^\\s):]+):(\\d+):(\\d+)/.exec(frames[f]);
                  if (hit === null) continue;
                  if (hit[1].indexOf('node_modules') !== -1) continue;
                  if (/[\\\\/]react(-dom)?[\\\\/]/.test(hit[1])) continue;
                  file = hit[1];
                  line = Number(hit[2]);
                  column = Number(hit[3]);
                  break;
                }
              }
              return { component: name, file: file, line: line, column: column };
            }
            fiber = fiber.return;
          }
        }
        node = node.parentElement;
      }
      return null;
    }

    function describe(element) {
      var rect = element.getBoundingClientRect();
      var styles = window.getComputedStyle(element);
      var text = (element.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        url: String(location.href),
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: Array.prototype.slice.call(element.classList, 0, 6),
        selector: buildSelector(element),
        text: text === '' ? null : text.slice(0, 120),
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        attrs: readAttrs(element),
        react: reactInfo(element),
        styles: {
          display: styles.display,
          position: styles.position,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          color: styles.color,
          background: styles.backgroundColor,
          padding: styles.padding,
          borderRadius: styles.borderRadius,
        },
      };
    }

    function paint(element) {
      var rect = element.getBoundingClientRect();
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';

      var label = element.tagName.toLowerCase();
      if (element.id) label += '#' + element.id;
      for (var index = 0; index < element.classList.length && index < 2; index++) {
        label += '.' + element.classList[index];
      }
      tag.innerHTML = escapeHtml(label);

      var above = rect.top - 24;
      if (above < 4) above = Math.min(window.innerHeight - 24, rect.bottom + 5);
      bar.style.top = Math.max(4, above) + 'px';
      bar.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 260)) + 'px';
    }

    function onMove(event) {
      var element = doc.elementFromPoint(event.clientX, event.clientY);
      if (element === null || element === box || element === bar) return;
      target = element;
      paint(element);
    }

    function onAdd(event) {
      event.preventDefault();
      event.stopPropagation();
      if (target === null || target === undefined) return;
      finish(describe(target));
    }

    function onClick(event) {
      event.preventDefault();
      event.stopPropagation();
      var element = target;
      if (element === null || element === undefined) element = doc.elementFromPoint(event.clientX, event.clientY);
      if (element === null || element === undefined || element === box || element === bar) { finish(null); return; }
      finish(describe(element));
    }

    function onKey(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    }

    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove, true);
    add.addEventListener('click', onAdd, true);

    window[KEY] = registration;
  });
})()`

    /* ====================================================================== */
    /* Helpers                                                                 */
    /* ====================================================================== */

    /**
     * Pick the dictionary for the active document language.
     * @returns one of `DICTIONARIES`.
     */
    function dictionary() {
      var lang = ''
      if (typeof document !== 'undefined' && document.documentElement !== undefined && document.documentElement !== null) {
        lang = String(document.documentElement.lang || '')
      }
      return lang.toLowerCase().indexOf('zh') === 0 ? DICTIONARIES.zh : DICTIONARIES.en
    }

    /**
     * Build a translator: the slot's own `t` when the shell supplies one, the
     * built-in dictionary otherwise.
     * @param props - the component props.
     * @returns `(key) => string`.
     */
    function translator(props) {
      var supplied = props === undefined || props === null ? undefined : props.t
      var dict = dictionary()
      var local = function (key) {
        return dict[key] === undefined ? key : dict[key]
      }
      if (typeof supplied !== 'function') return local
      return function (key) {
        var value = supplied(key)
        return typeof value === 'string' && value !== '' && value !== key ? value : local(key)
      }
    }

    /**
     * Escape a value for use inside an attribute selector.
     * @param value - the raw value.
     * @returns the escaped value.
     */
    function escapeSelectorValue(value) {
      if (typeof CSS !== 'undefined' && CSS !== null && typeof CSS.escape === 'function') return CSS.escape(value)
      return String(value).replace(/["\\]/g, '\\$&')
    }

    /**
     * Is this element actually shown? `checkVisibility` covers the case where a
     * closed dock is kept mounted but `visibility: hidden` with a real box.
     * @param element - the candidate.
     * @returns whether it is visible.
     */
    function isVisible(element) {
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) === true
      }
      var rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    /**
     * The preview guest belonging to ONE session.
     *
     * The right bar marks its owner with `data-sidebar-right-session`, and other
     * sessions' bars stay mounted, so scanning the whole document can pick up a
     * preview that belongs to a session the user is not looking at.
     *
     * @param sessionId - the session whose preview to use, or undefined to accept any.
     * @returns the webview element, or null when this session has no visible preview.
     */
    function activePreview(sessionId) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      var scope = document
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
        scope = document.querySelector('[data-sidebar-right-session="' + escapeSelectorValue(sessionId) + '"]')
        if (scope === null) return null
      }
      var frames = scope.querySelectorAll('[' + FRAME_ATTR + '="webview"]')
      for (var index = frames.length - 1; index >= 0; index--) {
        var frame = frames[index]
        if (frame.isConnected !== true) continue
        if (typeof frame.getBoundingClientRect !== 'function') continue
        if (frame.closest('[hidden], [aria-hidden="true"]') !== null) continue
        var owner = scope === document ? frame.closest('[data-sidebar-right-session]') : scope
        if (owner !== null && owner.hasAttribute('data-sidebar-right-open') !== true) {
          if (frame.closest('[data-dockkit-float]') === null) continue
        }
        if (isVisible(frame) === false) continue
        return frame
      }
      return null
    }

    /**
     * Inject the picker into this session's preview and await the click.
     * @param sessionId - the session whose preview to pick from.
     * @param addLabel - the label on the overlay's add button.
     * @param timeoutMs - how long to wait for a click.
     * @returns the descriptor, or null when the user cancelled.
     */
    function pick(sessionId, addLabel, timeoutMs) {
      var frame = activePreview(sessionId)
      if (frame === null) return Promise.reject(new Error('no-preview'))
      if (typeof frame.executeJavaScript !== 'function') return Promise.reject(new Error('no-bridge'))

      var timer = null
      var timeout = new Promise(function (_resolve, reject) {
        timer = setTimeout(function () { reject(new Error('timeout')) }, timeoutMs)
      })
      var script = PICKER_SOURCE.replace('ADD_LABEL_TEXT', JSON.stringify(addLabel))

      return Promise.race([frame.executeJavaScript(script, true), timeout])
        .then(function (result) {
          if (timer !== null) clearTimeout(timer)
          return result === undefined ? null : result
        })
        .catch(function (error) {
          if (timer !== null) clearTimeout(timer)
          cancelPick(sessionId)
          throw error
        })
    }

    /**
     * Cancel an in-flight pick inside this session's preview. Never throws: a
     * guest that has gone away rejects asynchronously.
     * @param sessionId - the session whose preview to cancel in.
     */
    function cancelPick(sessionId) {
      var frame = activePreview(sessionId)
      if (frame === null || typeof frame.executeJavaScript !== 'function') return
      try {
        var result = frame.executeJavaScript('window.__dshElementPicker && window.__dshElementPicker.cancel()', true)
        if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
          result.catch(function () { /* nothing to cancel */ })
        }
      } catch (ignored) { /* nothing to cancel */ }
    }

    /**
     * The composer text for one picked element.
     * @param info - the descriptor from the guest.
     * @returns the text to insert.
     */
    function formatReference(info) {
      var head = info.tag
      if (info.id) head += '#' + info.id
      if (Array.isArray(info.classes) && info.classes.length > 0) head += '.' + info.classes.slice(0, 2).join('.')
      var text = info.text ? ' "' + info.text + '"' : ''
      var lines = ['[UI元素] ' + head + text]

      if (info.react && info.react.component) {
        // Trim a leading origin so the path is workspace-relative-ish.
        var where = info.react.file === null || info.react.file === undefined
          ? ''
          : String(info.react.file).replace(/^[a-z]+:\/\/[^/]*\//i, '')
        if (where !== '' && info.react.line) where += ':' + info.react.line
        lines.push('组件 ' + info.react.component + (where === '' ? '' : ' · ' + where))
      } else if (info.box) {
        lines.push('尺寸 ' + info.box.width + '×' + info.box.height + ' @ (' + info.box.x + ',' + info.box.y + ')')
      }

      if (info.selector) lines.push('选择器 ' + info.selector)
      return lines.join('\n')
    }

    /* ====================================================================== */
    /* Styles                                                                  */
    /* ====================================================================== */

    var STYLE_ID = 'dsh-element-picker-style'

    var STYLESHEET = [
      /* The shipped globe + title, so the tab label survives the takeover. */
      '.dsh-ep-title{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-ep-titleText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      /* The toolbar toggle: matches the browser's own icon buttons, which are
       * icon-only and square. */
      '.dsh-ep-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;',
      'color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font:inherit;cursor:pointer;',
      'transition:background .12s ease,color .12s ease}',
      '.dsh-ep-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-ep-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}',
      '.dsh-ep-btn[data-armed="true"]{background:var(--dsw-alias-state-business-tertiary,rgba(65,118,230,.16));color:var(--dsw-alias-link,#4176e6)}',
      /* Armed: a small text pill beside the glyph, since a 24px square has no
       * room for a label. */
      '.dsh-ep-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;flex:none;',
      'border-radius:999px;background:var(--dsw-alias-state-business-tertiary,rgba(65,118,230,.16));',
      'color:var(--dsw-alias-link,#4176e6);font:inherit;font-size:11px;line-height:1;white-space:nowrap}',
      '.dsh-ep-dot{width:5px;height:5px;border-radius:50%;background:currentColor;animation:dsh-ep-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsh-ep-pulse{0%,100%{opacity:.3}50%{opacity:1}}',
      '.dsh-ep-notice{display:inline-flex;align-items:center;height:24px;padding:0 8px;flex:none;',
      'border-radius:999px;background:var(--dsw-alias-state-warn-tertiary,rgba(217,132,59,.14));',
      'color:var(--dsw-alias-state-warn-label,#d9843b);font:inherit;font-size:11px;line-height:1;white-space:nowrap}',
    ].join('')

    /**
     * Make sure this plugin's stylesheet is in the document.
     *
     * Called both on activation and from the shared watcher: a reload can install
     * a sheet before the previous activation's disposer runs, and the shell can
     * mount late, so presence is re-asserted rather than assumed.
     *
     * @returns the disposer for the sheet it installed.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === undefined || document.head === null) return function () {}
      var existing = typeof document.getElementById === 'function' ? document.getElementById(STYLE_ID) : null
      if (existing !== null && existing !== undefined) return function () {}
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLESHEET
      document.head.appendChild(style)
      return function () {
        if (style.parentNode !== undefined && style.parentNode !== null) style.parentNode.removeChild(style)
      }
    }

    /** Mounted controls that want their toolbar re-resolved. */
    var watchers = []

    /** The one shared timer, so N tabs do not mean N intervals. */
    var watcherTimer = null

    /**
     * Keep the stylesheet present and let each mounted control re-resolve its
     * toolbar. A browser tab's chrome can appear after its title chip, and a
     * recompose can drop the sheet, so both are re-checked cheaply.
     */
    function ensureWatcher() {
      if (watcherTimer !== null) return
      if (typeof setInterval !== 'function') return
      watcherTimer = setInterval(function () {
        installStyles()
        for (var index = 0; index < watchers.length; index++) {
          try { watchers[index]() } catch (error) { /* one dead control must not stop the rest */ }
        }
      }, 1000)
    }

    /**
     * Subscribe a mounted control to the shared watcher.
     * @param callback - invoked about once a second.
     * @returns the unsubscribe function.
     */
    function watch(callback) {
      watchers.push(callback)
      ensureWatcher()
      return function () {
        var at = watchers.indexOf(callback)
        if (at >= 0) watchers.splice(at, 1)
      }
    }

    /* ====================================================================== */
    /* The control, inside the browser tab's title chip                        */
    /* ====================================================================== */

    /** A minimal crosshair glyph: outline rides `currentColor`. */
    function TargetIcon(size) {
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        react.createElement('circle', { cx: 8, cy: 8, r: 3.25 }),
        react.createElement('path', { d: 'M8 1.25v3M8 11.75v3M1.25 8h3M11.75 8h3' }),
      )
    }

    /** A minimal globe glyph, matching the shipped tab-title icon's shape. */
    function GlobeIcon(size) {
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          'aria-hidden': 'true',
        },
        react.createElement('circle', { cx: 8, cy: 8, r: 6 }),
        react.createElement('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 6 }),
        react.createElement('path', { d: 'M2.2 6h11.6M2.2 10h11.6' }),
      )
    }

    /** The tab body carries this attribute, keyed by the tab id. */
    var TAB_BODY_ATTR = 'data-sidebar-right-tab'

    /**
     * The browser's own toolbar element for one tab.
     *
     * `dsh-client-ui-sidebar-browser` renders its chrome as a plain `<form>`
     * with no Slot, so the only way in is to render into it. It is a flex row
     * whose address box is `flex: 1`, so an extra child makes room for itself.
     *
     * @param tabId - the browser tab's id.
     * @returns the toolbar form, or null before the tab body is mounted.
     */
    function toolbarFor(tabId) {
      if (typeof document === 'undefined' || tabId === undefined || tabId === null) return null
      var body = document.querySelector('[' + TAB_BODY_ATTR + '="' + escapeSelectorValue(tabId) + '"]')
      if (body === null) return null
      return body.querySelector('form')
    }

    /**
     * The built-in browser tab's title chip, plus the element-selection toggle.
     *
     * The chip keeps the shipped title (so taking the keyed seat over does not
     * blank the tab label), and the toggle is portalled into the browser's own
     * toolbar — the top-right corner, beside its navigation controls.
     *
     * @param props - slot props; carries `useTabInfo`, `sessionId`, `inputActions`.
     * @returns a React element.
     */
    function BrowserTitleToggle(props) {
      var t = translator(props)
      var actions = props === undefined || props === null ? undefined : props.inputActions
      var sessionId = props === undefined || props === null ? undefined : props.sessionId
      var useTabInfo = props === undefined || props === null ? undefined : props.useTabInfo

      var phasePair = react.useState('idle')
      var phase = phasePair[0]
      var setPhase = phasePair[1]
      var noticePair = react.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var livePair = react.useState(null)
      var liveTitle = livePair[0]
      var setLiveTitle = livePair[1]
      var toolbarPair = react.useState(null)
      var toolbar = toolbarPair[0]
      var setToolbar = toolbarPair[1]
      var run = react.useRef(0)

      var tab = typeof useTabInfo === 'function' ? useTabInfo().tab : undefined
      var tabId = tab === undefined || tab === null ? undefined : tab.id

      // The browser's chrome can appear after its title chip, and a recompose can
      // drop the stylesheet, so both are re-checked by the shared watcher.
      react.useEffect(function () {
        if (tabId === undefined) return undefined
        var sync = function () {
          installStyles()
          var found = toolbarFor(tabId)
          if (found !== null) setToolbar(found)
        }
        sync()
        return watch(sync)
      }, [tabId])

      // The shipped title reads the browser store; re-derive it from the guest so
      // replacing the occupant does not freeze the tab's label.
      react.useEffect(function () {
        var frame = activePreview(sessionId)
        if (frame === null || typeof frame.addEventListener !== 'function') return undefined
        var update = function () {
          try { setLiveTitle(frame.getTitle()) } catch (error) { /* the guest may be gone */ }
        }
        update()
        frame.addEventListener('page-title-updated', update)
        return function () { frame.removeEventListener('page-title-updated', update) }
      }, [sessionId, phase])

      react.useEffect(function () {
        if (notice === null) return undefined
        var timer = setTimeout(function () { setNotice(null) }, 4000)
        return function () { clearTimeout(timer) }
      }, [notice])

      /** Pick repeatedly until the mode is turned off or the user cancels. */
      function loop(generation) {
        if (actions === undefined || typeof actions.captureInsertion !== 'function') {
          setNotice(t('failed'))
          setPhase('idle')
          return
        }
        pick(sessionId, t('add'), PICK_TIMEOUT_MS)
          .then(function (info) {
            if (run.current !== generation) return
            if (info === null || info === undefined) { setPhase('idle'); return }
            var span = actions.captureInsertion()
            if (actions.insertText(formatReference(info), span) === false) {
              setNotice(t('conflict'))
              setPhase('idle')
              return
            }
            // A short gap keeps a guest that resolves instantly from hot-looping.
            setTimeout(function () {
              if (run.current === generation) loop(generation)
            }, 60)
          })
          .catch(function (error) {
            if (run.current !== generation) return
            setPhase('idle')
            var message = error === undefined || error === null ? '' : String(error.message || error)
            if (message === 'no-preview') setNotice(t('noPreview'))
            else if (message === 'no-bridge') setNotice(t('noBridge'))
            else if (message !== 'timeout') setNotice(t('failed'))
          })
      }

      function toggle() {
        if (phase === 'armed') {
          run.current += 1
          setPhase('idle')
          cancelPick(sessionId)
          return
        }
        run.current += 1
        setPhase('armed')
        loop(run.current)
      }

      var title = liveTitle !== null && liveTitle !== undefined && liveTitle !== '' ? liveTitle : (tab === undefined ? '' : tab.title)

      var control = react.createElement(
        react.Fragment,
        null,
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-ep-btn',
            'data-armed': phase === 'armed' ? 'true' : 'false',
            title: t('title'),
            'aria-label': t('title'),
            'aria-pressed': phase === 'armed',
            onClick: toggle,
          },
          TargetIcon(15),
        ),
        phase === 'armed'
          ? react.createElement(
            'span',
            { className: 'dsh-ep-pill' },
            react.createElement('span', { className: 'dsh-ep-dot', 'aria-hidden': 'true' }),
            t('hint'),
            react.createElement('span', { className: 'dsh-ep-key' }, t('esc')),
          )
          : null,
        notice === null ? null : react.createElement('span', { className: 'dsh-ep-notice', role: 'status' }, notice),
      )

      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          'span',
          { className: 'dsh-ep-title' },
          GlobeIcon(14),
          react.createElement('span', { className: 'dsh-ep-titleText' }, title),
        ),
        toolbar === null ? null : reactDom.createPortal(control, toolbar),
      )
    }

    /* ====================================================================== */
    /* Registration                                                            */
    /* ====================================================================== */

    /**
     * Register the control into the built-in browser tab's title chip.
     * @param ctx - the client plugin context.
     */
    /**
     * Register the control into the built-in browser tab's title chip.
     *
     * A keyed Slot refuses a second entry for a taken key at the same priority,
     * so shadowing the shipped browser title requires a lower priority number
     * (the lowest renders).
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'element-picker: styles')
      ctx.effect(() => ensureWatcher(), 'element-picker: watcher')
      ctx.effect(
        () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register(
          { name: TITLE_SLOT, key: BROWSER_KEY, priority: -1 },
          BrowserTitleToggle,
        )),
        'element-picker: browser title control',
      )
    }

    exports.name = 'element-picker'
    exports.apply = apply
    exports.inject = ['slots']
    exports.__internals = { formatReference, activePreview, dictionary, translator, PICKER_SOURCE, isVisible, toolbarFor, installStyles }
    return module.exports
  },
})
