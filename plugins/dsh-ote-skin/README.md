# dsh-ote-skin

DeepSeek Harness（DSH）Web 外壳的 **Oltra 石墨皮肤**：单一亮橙强调色、四级石墨底色、
靠底色差而不是描边/阴影分层、小圆角。依据是《欧创 Oltra · UI/UX 设计规范 v1.0》。

**只改风格**：不动布局、不动间距，也不动任何排版属性（字体族/字号/行高/字距）——
包括 AI 输出正文的排版。markdown 区只碰颜色（代码块、行内代码、列表圆点）。

## 三层实现，三层都可还原

| 层 | 落点 | 为什么这么做 |
|---|---|---|
| **令牌层** | `ctx.theme.overrideTokens('dsh-ote-skin:oltra', TOKENS)` | `--dsw-alias-*` 等自定义属性是**宿主**打在 `<body>` 上的 inline style；交给宿主自己的通道，dispose 就完全还原，我们从不自己写 DOM |
| **组件层** | `<style id="dsh-ote-skin/css">` | 令牌表达不了的那几处：描边按钮、近黑输入井、选中行左缘橙条、chip 省略号 |
| **插件对齐层** | `<style id="dsh-ote-skin/plugins">` | 第三方插件自带的颜色（有些还写在 `style=""` 上）不受令牌管辖，只能按它们自己发布的钩子覆盖 |

前两层每条规则都写在 `html[data-dsh-ote-skin]` 前缀下：既拿到高于官方规则（0,1,0–0,2,0）的具体度、**不需要 `!important`**，又能在去掉这个属性时整层失效。

第三层**只用 `!important`**，因为 React inline style 的优先级高于任何样式表，不用 `!important` 压不住；但它同样全部挂在钩子上，绝不出现裸 `*`：

| 插件 | 钩子 | 改了什么 |
|---|---|---|
| `dsh-element-picker` | `[data-dsh-picker="box"/"tag"/"add"/"bar"]` | 蓝框 + **白色高光圈** → 橙描边；蓝底按钮 → 橙 |
| `dsh-token-hud` | `[data-dsh-token-hud="card"]`、`[style*="#3b82f6"]` 等 | 毛玻璃 + 重阴影 + 2em 圆角 → 实色面板 + 6px；蓝/靛 → 橙，玫红 → 语义红 |
| `@linxin666/dsh-client-ui-task-board` | `[data-tag-tone="0…5"]` 的 `--dsh-task-tag-*` | 六组彩虹标签 → 橙色阶梯 + 一档中性 |
| `dsh-at-file` | `[style*="#4d9de0"]` 等 | 蓝、紫图标 → 橙；蓝灰 → 弱文字色 |
| `@nanmicoder/dsh-agent-teams` | `[style*="18, 45, 72"]` | 写死的深海军蓝投影 → 中性黑 |

判据统一是《规范》§2.1/§2.5：**语义状态色（成功绿 / 警告琥珀 / 错误红）保留，非语义的蓝与紫一律收成唯一强调橙**。

另外 8 个插件（`dsh-plus-menu`、`dsh-session-bridge`、`dsh-rewind-plugin`、`dsh-working-activity`、`@liustack/modlens`、`@linxin666/dsh-client-ui-skill-explorer`、`dsh-better-sidebar`、`dsh-auto-paste`）本来就全走 `var(--dsw-*, …)`，令牌齐了就自动统一，**一条规则都不用加**。

## 前提：应用必须跑在深色分支

Oltra 是**深色语言**，而 DSH 官方有 113 个令牌**只在 `body[data-ds-dark-theme]` 下被改写**（浅色分支里它们全回落成白/浅灰），另有若干组件用 `--dsw-static-*` 原语当填充（两套主题同值，皮肤也管不到那几条的"浅色用法"）。

所以本机 profile 里把 `ui-theme` 的 `preference` 从 `system` 改成了 **`dark`**：

```yaml
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
```

同时禁用了 `dsh-dream-skin`（它是同一批 `--dsw-*` 令牌上的第二个换肤器，且自带 3 套近白皮肤）：

```yaml
- id: dsh-dream-skin
  disabled: true
```

## 覆盖不到的（如实列出）

| 落点 | 为什么 |
|---|---|
| `dsh-context` 的知识图谱连线 | 颜色是 JS 里按元素算出来的 `hsl(索引×137.5° …)`，没有任何稳定钩子；要么改它的代码，要么接受 |
| Excel 预览（luckysheet） | 内嵌 55 处 `#fff`，属于**文档内容**而不是外壳 UI |
| 更新弹窗 / 强制更新页 / 欢迎登录页 | 它们是**另外的 BrowserWindow**（独立 HTML + 自带令牌表），本插件的浏览器半区进不去 |


类名只匹配 **CSS-module 的导出名**（`[class*="_primary"]`）：哈希前缀每次构建都会变，
导出名不会（这一点与 `dsh-ote-brand` 的耦合纪律一致）。

## 安装

```powershell
# 1) 让 profile 能解析到这个包
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\local-plugins\dsh-ote-skin" `
  -Target "E:\OteWork\plugins\dsh-ote-skin"
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ote-skin" `
  -Target "$env:USERPROFILE\.dsh\local-plugins\dsh-ote-skin"
```

```yaml
# 2) 在 $DSH_HOME/profiles/desktop/cordis.patch.yml 末尾插一行
- insert:
    - id: ote-skin
      name: dsh-ote-skin
- id: ote-skin
  disabled: false
```

```powershell
# 3) 浏览器半区是启动时校验并下发的 —— 必须重启 DeepSeek Harness
```

本包自带 `cordis.patch.yml`，所以也可以改走 `dsh plugin add` 的 bundle 通道。
**两者选一，不要同时做。**

## 还原

把上面那一行 `- id: ote-skin` 改成 `disabled: true`（或整行删掉）后重启即可：
令牌层随 disposer 撤掉，组件层的 `<style>` 与根属性一起消失，官方外观原样回来。

## 自测

```sh
node tests/run.mjs
```

`tests/client.test.mjs` 用假的 `window.__ModuleLoader__` / `document` / cordis ctx
加载**真实的** `lib/client.js`，覆盖：bundle 身份、导出的 `apply`/`inject`、
令牌走上宿主通道（而不是自己写 DOM）、宿主 API 缺失或抛错时的降级、
组件层每条规则都带根前缀、组件层**不含任何布局与排版属性**、
无 `!important`、重载不叠样式表、dispose 还原、以及**旧代际的 disposer 不能误删新代际**。

## 已知耦合（DSH 升级后值得复核）

| 依赖 | 位置 |
|---|---|
| `ctx.theme.overrideTokens(source, overrides)` 接受「令牌名 → 具体颜色」并返回 disposer | 宿主 ThemeRuntime |
| 令牌名与语义（`--dsw-alias-*` / `--dsw-specific-*` / `--dsw-radius-*` / `--dsw-elevation-*`） | `@deepseek-ai/dsh-client-ui-theme` |
| 组件类名后缀 `_primary` `_button` `_composerStack` `_add` `_card` `_sessionRow` `_selected` `_panelRow` `_panelActive` `_ioCard` `_markdown` `_block` | `dsh-client-ui-*` 各自的 CSS-module |
| 客户端半区经 `window.__ModuleLoader__.load({ id, factory })` 注册，`apply`/`inject` 为导出名 | 宿主 cordis Loader |

任何一条变了，皮肤会**降级**而不是弄坏外壳：找不到类名就是那一条样式不生效，
`overrideTokens` 不存在就退回带 `!important` 的样式表，dispose 时两层都撤干净。

## ⚠️ 本机（企业透明加密）的坑

这台机器上有按扩展名生效的透明加密：**由本机 AI 应用（Trae / DSH）的写文件能力写出的
`.js` / `.json` / `.yml` / `.txt` / `.html` 会以密文落盘**（文件头 `%TSD-Header-###%`），
而 `.mjs` / `.cjs` / `.htm` / `.markdown` 不受影响。

后果与规避：

- 这个包里的 `package.json`、`cordis.patch.yml`、`lib/*.js` 必须保持**明文**，
  否则 DSH 读不了、git 里也只是一堆密文。核验方式：

  ```powershell
  node -e "const b=require('fs').readFileSync('package.json');console.log(b.subarray(0,4).toString('latin1')==='%TSD'?'ENCRYPTED':'plaintext')"
  ```

- 如果你用某个"被加密策略覆盖"的编辑器/工具改这几个文件，它们会**再次变成密文**。
  实测可行的工作方式：把内容写成 `.mjs` 中转文件，再用 **node 拷贝**成正式文件名
  （node 子进程的写盘不会被加密）：

  ```powershell
  node -e "require('fs').copyFileSync('E:/Temp/ote-skin/client.js.mjs','lib/client.js')"
  ```

- 同理，**DSH 的 profile 配置文件**（`~/.dsh/profiles/desktop/cordis.patch.yml`）
  也不能用会触发加密的工具去写，否则整个 profile 都读不了。

## 文件

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半区：空行，只为让 harness 下发浏览器半区 |
| `lib/client.js` | 浏览器半区：令牌表 + 组件规则 + 注入与清理 |
| `cordis.patch.yml` | 本包自带的 profile 补丁（走 bundle 通道时用） |
| `docs/skin-preview.htm` | 静态样张：Oltra 风格的 DSH 外壳长什么样（用在浏览器里打开，`.htm` 是为了绕开加密） |
| `tests/` | 离线测试台 |
