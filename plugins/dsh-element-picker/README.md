# dsh-element-picker

**元素引用**：在内置浏览器预览里点一下 UI 组件，精确的源码引用就落进输入框 —— Agent 直接知道改哪个文件、哪一行，不用靠截图猜。

```
[UI元素] button#submit.primary "提交订单"
组件 CheckoutButton · src/components/Checkout.tsx:42
选择器 #app > form > button#submit
```

## 内置浏览器在哪

DeepSeek Harness 自带浏览器，在 **右侧栏**：

| 包 | 作用 |
|---|---|
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | **"Sandboxed Web browser tabs for the right Sidebar"** —— 多标签网页浏览 |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | Office / Markdown / 代码 / 图片 / PDF / **HTML** 预览 |

桌面端它渲染的是一个 **`<webview>` 标签**（`data-sidebar-browser-frame="webview"`，独立的沙箱 `partition`）；Web 端降级成 `<iframe>`。桌面端的 Electron 主进程启用了 `webviewTag`，所以宿主页面可以调用 `webview.executeJavaScript(...)` —— 这就是本插件能读进预览内容的原因。

## 怎么用

1. 在右侧栏打开内置浏览器，指向你的开发服务器（例如 `http://localhost:5173`）。
2. 点**浏览器标签标题**里的 **`◎ 引用`** 控件 —— 悬停提示 **"开启选择元素模式"**。
3. 鼠标在预览里移动 —— 元素被蓝色描边框住，上方浮出 `span` 标签和 **「添加到对话」** 按钮。
4. 点 **「添加到对话」**（或直接点元素）—— 引用插到光标处，**模式保持开启**，可以连着加好几个。
5. 再点一次 `◎ 引用`，或按 **Esc**，退出模式。

## 控件为什么在浏览器标签标题里，而不是地址栏

想放到地址栏那排的右端，但**那条工具栏没有任何插槽** —— 它是 `dsh-client-ui-sidebar-browser` 里硬编码的 `<form>`（返回 / 前进 / 刷新 / 地址框 / 外部打开 / 沙箱开关），而且 `addressBox` 是 `flex: 1`，右端**没有空隙**可以叠加。

可用的座位是 **`sidebar.right.pane.tab.title`**（keyed，session 作用域）—— 浏览器标签的标题块就在浏览器顶部，而且它的 standardProps **同时带 `sessionId` 和 `inputActions`**，所以控件放在浏览器里也能往正确的 composer 插入。

### keyed 插槽不是"注册即替换"

踩了一个大坑：**同 key 同优先级会直接抛错**，不是替换：

```
keyed slot "sidebar.right.pane.tab.title" already has an entry for key
"@deepseek-ai/dsh-client-ui-sidebar-browser" at priority 0 (registered by mf)
— register at a different priority to shadow it (lowest renders)
```

要遮蔽官方占位者，必须给一个**不同的优先级**（**数字越小越优先**）：

```js
ctx.slots.register({ name: SLOT, key: BROWSER_ID, priority: -1 }, Component)
```

这个错误会**抛在 `apply` 里**，Cordis 随即销毁整个 scope —— 症状是**样式表被回滚、控件完全不渲染**，而且日志里什么都看不到。定位它花了几轮：在 `apply` 的关键节点埋 `fetch` 上报，才看到最后一个诊断点从未到达。

因为接管了标题座位，官方标题要**自己重画**（地球图标 + 标题），并从 guest 读**实时页面标题**（`frame.getTitle()` + `page-title-updated` 事件），否则标签名会停在打开时的 hostname。

## 预览必须绑在自己的会话里

这一条踩过坑：**别的会话的右栏是留在 DOM 里的**（浏览器标签 `keepMounted`），所以"取最后一个可见的 `<webview>`"会抓到**另一个会话的预览**。

正确的做法是照抄 shell 自己的 `visibleSidebarPane` 判定 —— 右栏的宿主元素带 `data-sidebar-right-session="<sessionId>"`：

```js
const scope = document.querySelector(`[data-sidebar-right-session="${sessionId}"]`)
// 再要求：不在 [hidden] / [aria-hidden="true"] 里、
//        宿主带 data-sidebar-right-open（面板收起时 dock 只是 visibility:hidden，rect 仍非零）、
//        checkVisibility() 为真
```

本插件的座位是 **session 作用域**的，`props.sessionId` 就是引用所属的会话 —— 拾取用它、插入也用它。**本会话没有可见预览时直接提示，绝不静默去用别人的。**

实测 DOM 里同时挂着 6 个会话的右栏，其中两个各带 16 个和 2 个 webview。

## React 版本决定源码位置从哪来

| React | 位置来源 |
|---|---|
| 18 | `fiber._debugSource` → `{fileName, lineNumber, columnNumber}` |
| **19** | **`_debugSource` 已被移除**；改从 `fiber._debugStack.stack` 里取 JSX 调用点 |

React 19 的 fiber 调试字段实测为 `_debugInfo / _debugOwner / _debugStack / _debugTask / _debugNeedsRemount / _debugHookTypes` —— **没有 `_debugSource`**。而 `_debugStack` 是个 Error，栈里就有调用点：

```
Error: react-stack-top-frame
    at exports.jsxDEV (…/react_jsx-dev-runtime.js:197:25)
    at App (http://127.0.0.1:5273/src/App.jsx:93:33)      ← 取这一帧
    at Object.react_stack_bottom_frame (…/react-dom_client.js:14142:12)
```

本插件先试 `_debugSource`，没有再解析 `_debugStack`，并**跳过 `node_modules` 与 React 自身的帧**。

**语义要说清楚**：拿到的是**组件被创建/使用的位置**，不是组件定义体所在行。例如 `<StatCard/>` 在 `App.jsx` 里被渲染，报告的就是 `App.jsx:110`；`<StatusBadge/>` 在 `DataTable.jsx` 里被渲染，报告 `DataTable.jsx:93`。对 Agent 来说这更直接 —— "谁渲染了这个组件" 正是要改的地方。

实测（真实 React 19 + Vite dev server，在内置浏览器里）：

| 元素 | 组件 | 源码位置 |
|---|---|---|
| 导出报告 按钮 | `App` | `src/main.jsx:7:116` |
| 1,284,930 统计值 | `StatCard` | `src/App.jsx:110:53` |
| 成功 徽章 | `StatusBadge` | `src/components/DataTable.jsx:93:65` |
| ◎概览 导航项 | `SideNav` | `src/App.jsx:66:31` |
| 开关 | `ToggleRow` | `src/components/Preferences.jsx:77:22` |
| Console 品牌字 | `TopBar` | `src/App.jsx:60:30` |

## 交互与视觉

刻意做到最小：

| 状态 | 外观 |
|---|---|
| 待命 | 一个 28px 的准星图标按钮，无边框无背景，`label-tertiary` 色，hover 才出现浅背景 |
| 已激活 | 按钮转为品牌蓝底；工具栏展开一行提示，带一个**呼吸的 6px 圆点**、`Esc` 键帽和「取消」文字链接 |
| 提示 | 一行橙色文字（4 秒自动消失），不弹窗、不遮挡 |

预览里的覆盖层：

- **1.5px 品牌蓝描边** + 内外两层极淡光晕 —— 在任何底色上都看得清
- 标签是深色圆角小胶囊，11px 等宽字体，标签名用蓝色，后跟截断的元素文字
- 元素顶部空间不够时标签自动翻到下方，左右也会夹在视口内
- **全部 `pointer-events: none`** —— 覆盖层绝不抢预览应用的点击

## 引用里有什么

| 行 | 内容 | 为什么 |
|---|---|---|
| 1 | `<tag#id.class> "可见文字"` | 人一眼能确认点对了 |
| 2 | React 组件名 + `文件:行` | **Agent 直接定位源码**（开发构建才有行号） |
| 3 | CSS 选择器路径 | 元素没有 React 信息时的兜底 |

选择器生成会**跳过哈希类名**（CSS Modules 的 `_a1b2c3_x`、CSS-in-JS 的 `css-1x2y3z`），只留语义类名，最多 4 层，同层有多个同标签兄弟时补 `:nth-of-type()`。

第 2 行的文件路径会**去掉 origin**（`http://localhost:5173/src/...` → `src/...`），这样 Agent 能直接在工作区里打开。

拿不到 React 信息时（生产构建），第 2 行降级为 `尺寸 120×36 @ (320,180)`。

## 实现要点

### 怎么读进预览

```js
const frame = document.querySelector('[data-sidebar-browser-frame="webview"]')  // 取可见的那个
const info = await frame.executeJavaScript(PICKER_SOURCE, true)                  // 注入并等待点击
```

注入的脚本是**自包含**的：自己建覆盖层、自己监听 `mousemove` / `click` / `keydown`，点击时 resolve 出描述对象，Esc 时 resolve `null`，并清理自己创建的所有节点。它通过 `element.__reactFiber$…` 向上找最近的组件名，再读 `fiber._debugSource` 拿 `文件:行:列`。

### 怎么落进输入框

输入框是 ui-conversation 拥有的 **Lexical** contenteditable，它的 `InputActions` 面通过插槽 props 交给我：

```js
const span = inputActions.captureInsertion()   // { start, end, draftRev } —— 在光标处
inputActions.insertText(text, span)            // false = 草稿已被改动
```

**顺序很关键**：span 在**用户按下按钮的那一刻**捕获，在**点击元素之后**才用它插入。中间隔着几秒，用户完全可能改了草稿 —— `draftRev` 就是防这个的。插入返回 `false` 时提示「草稿已变更，请重试」，而不是把文本塞到错位置。

这和官方语音输入插件（`dsh-experimental-client-ui-voice-input`）用的是同一个模式：`captureInsertion()` 在开始时、`insertText()` 在结束时。

### 插槽

占用 `conversation.input.activity` —— 官方声明为 **"Compact action after the model selector; it can expand across the toolbar"** 的座位。它是 `single` 型且**原本空置**，所以**没有替换任何官方控件**。展开行为通过 `onActiveChange(true/false)` 通知工具栏。

## 限制

| 情况 | 行为 |
|---|---|
| **Web 端（`<iframe>`）** | 跨域内容**读不到**（官方注释：*"the view reports loads without reading cross-origin content"*）。点按钮会提示「当前预览不支持元素引用」，不会静默失败 |
| **生产构建** | 没有 `_debugSource`，第 2 行降级为元素尺寸 |
| **无可见预览** | 提示「未找到内置浏览器预览」 |
| **预览是跨域页面** | `executeJavaScript` 在 guest 里照常执行，不受同源策略限制（这是 webview 与 iframe 的关键区别） |
| **元素在 iframe 里** | 只描述最外层 iframe 元素本身，不穿透嵌套 |

## 测试

```
node tests/run.mjs
```

26 项检查，覆盖：

- bundle 形态、只 require `react`、Cordis 导出面、插槽注册、样式表注入与卸载
- **样式表归属**：重载时新实例接管样式表，旧实例的清理函数不会把它剥掉
- 三种 UI 状态的渲染（待命 / 已激活 / 提示），以及 `onActiveChange` 的上报；待命态是**带文字的控件**
- **span 捕获顺序**：断言 `capture → pick → insert` 的调用次序，且插入用的是**捕获时的 span**（不是重新读的）
- 引用文本的三行结构：元素头、组件+`文件:行`（origin 已裁剪）、选择器
- 无 React 信息时降级为尺寸
- **四条错误路径各自的通知**：草稿冲突 / 本会话无预览 / 不支持 bridge / 注入被拒
- **会话作用域三条**：只用自己的预览、面板收起时不算、没有右栏时报无预览
- 隐藏的 frame 与已分离的 frame 都会被跳过
- 取消时向 guest 发出 `__dshElementPicker.cancel()`
- 注入脚本的自包含性：`pointer-events:none`、Esc 取消、`preventDefault`、读 React fiber、读 `_debugSource`、无模板插值

### 在真实内置浏览器里验证过

用一个临时探针插件（`ctx.layout.openRightbar` + `ctx.sidebarRight.openTabIn(sessionId,'browser',{params:{url}})`）打开右侧栏内置浏览器，通过真实 `<webview>` bridge 注入**从本插件 bundle 读出的** picker 源码，模拟悬停+点击：

- guest 是 `@deepseek-ai/dsh-desktop/0.2.0-rc.2 Chrome/152.0.7977.54 Electron/44.0.0` 的沙箱 partition
- `executeJavaScript` 可用且**会 await promise**
- 6 个元素全部拿到 组件名 + 源码位置，每次拾取后 **0 残留节点**
- 对照页面自测 **31/31 断言通过**（含点击被吞掉、覆盖层 `pointer-events:none`、Esc 返回 null、重入取消）

## 设计取舍

- **不做截图**。截图对 Agent 的价值远低于「组件名 + 文件:行」。
- **不做常驻面板**。只在需要时展开，不占用工具栏宽度。
- **不弹窗**。所有反馈都是一行文字，自动消失。
- **不抢点击**。覆盖层全程 `pointer-events: none`；真正消费点击的是注入脚本的捕获阶段监听。
- **控件带文字**。一开始做成 28px 纯图标，在工具栏里太不显眼，也和旁边带文字的控件不统一；现在是 `◎ 引用` 的 chip。
- 宿主半区**完全为空** —— 它存在只是为了让 harness 把这个包的 `dsh.client` bundle 送进启动图。
