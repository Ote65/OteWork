# dsh-governor-mode

DSH 的默认且唯一工作模式（总督模式 v2）。总督面板挂在右侧（与内置浏览器 / 文档预览并列），宿主半提供 `/api/governor` 控制平面，总督会话用 bash curl 驱动整个工作区。全部沿用宿主自己的设计体系，不引入任何自造配色与皮肤。

## 它做了什么

### 浏览器半（lib/client.js）

1. **侧栏拦截（无条件）**：工作区行的点击（捕获阶段，`[data-row-key^="workspace:"]`）改为打开总督面板，**不展开**会话列表；行内交互控件（button / a / input / select / textarea / label / `[role="button"]` / 展开 data 属性白名单）照旧放行。
2. **原生「新建会话」按钮 = 新建工作面板**：DSH 侧栏那个 `aria-label="新建会话"` 的图标按钮被接管——点击改为走官方目录选择器 + 官方工作区创建（`uiWorkspace.pickDirectory()` → `workspaces.create({path})`），新建的工作区由差集轮询自动补总督会话与提示词。悬停提示里的「新建会话」文案改写为「新建工作面板」（`sidebar` 命名空间已被官方占用，`ctx.locale.register` 会抛错，所以只改文案；`aria-label` 保持原样，拦截器靠它定位）。注：快捷键（非点击）仍走官方行为。
3. **总督面板，四区内容同一套**：
   - **roster 区**：总督头像 64px（点击打开总督会话）+ ≤8 个手下头像 48px（1/2/3/4 居中、5→3+2、6→3+3、7→4+3、8→4+4 排布）+ 状态灯（idle / ongoing 呼吸 / done / warning）+ 直角母线连线 + 手下分支名小标签（取自 git-state 的 `sub/<名>`）；**新增手下子会话的唯一入口是总督栏右侧的「＋」**（`uiWorkspace.startSession(workspaceId)`，满 8 个置灰）；
   - **选择题卡区**：轮询待答问题（问题 + 选项 + 来源手下），点选即代答；头部是 autoAnswer 开关（读写 `/settings`）；
   - **git 区**：dev 同步灯（`devSynced` 绿 / 否则橙 + ahead/behind / 无快照灰）+ 三按钮「同步 GitHub」「汇报」「预览」（预览走 `ctx.sidebarRight.openTabIn(sessionId, 'browser', {params:{url}})`，git-state 里没有合法 http(s) 地址时置灰）；
   - **输入井**：目标下拉（总督 / 各手下 / 全体）+ 文本 → `POST /api/governor/prompt`；发不出去时降级为 v1 验证过的草稿搬运桥（打开目标会话 + `conversation.input.left` 把文字落进它的输入框）。
4. **新建工作区 = 新建总督**：轮询 `useWorkspaces` 差集，新工作区无会话则 `uiWorkspace.startSession` 懒建总督会话，会话就位后 `POST /bootstrap` 注入总督提示词（受 `settings.autostart` 控制，默认开）。**用户既有的工作区（已有会话）不打扰**——不建会话也不注入提示词。
5. **轮询克制**：roster/questions 2s、git-state 10s，页面不可见统一降到 15s，卸载清干净。

### 宿主半（lib/index.js，`/api/governor` 九路由）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/roster?sessions=id1,id2&workspace=` | GET | 逐会话聚合 title/live/running/pendingInteraction/seq/cwd |
| `/transcript?session=&since=` | GET | 增量事件；`seq` 原样作下次 `since`（半开区间游标，单次上限 400 条置 `truncated`） |
| `/questions?sessions=` | GET | 扫 `pendingInteraction` 提取待答选择题；选项形状不认识返回空数组不崩 |
| `/prompt` | POST | `{session, text}` → `subagents.prompt`（签名未实测，五种调用形状依次探测，失败 501 附形状清单） |
| `/answer` | POST | `{session, choice, callId?}` → `userQuestions.answer`；choice 兼容 label / `{id, selected}` / `{answers:[…]}` |
| `/command` | POST | `{session, line}` → `commands.execute(agent, line, [], signal)` |
| `/settings` | GET/PUT | 内存态按 workspace 键；默认 `{autoAnswer:false, autostart:true}`；PUT 校验布尔 |
| `/git-state?session=` | GET | 纯读会话 cwd 下 `.governor/state.json`，**绝不执行 git** |
| `/bootstrap` | POST | `{session, workspace, title, sessions}` 生成总督提示词并走 /prompt 同一通路 |

路由挂 `connection.fetch.register`（多形状防御），URL 由 `authenticatedUrl` 折凭据；没有 connection 载体时惰性不注册。

### 总督提示词（lib/prompt.js）

`buildGovernorPrompt({baseUrl, workspaceId, workspaceTitle, sessions, settings})` 纯函数（实测渲染 5032 字符）：身份声明 + 九路由 curl 手册 + 游标契约 + 选择题规则（autoAnswer 开 = 总督按推理选最佳并说明理由，主观题仍问用户；关 = 全部汇报用户）+ git 纪律（release 仅用户 / dev 总督+用户 / 手下各在 `sub/<名>` 分支、收口后写 `.governor/state.json`、同步 GitHub 只归总督）+ 监控职责（验收看 diff 不听「做完了」）+ 汇报口径与四类风险。

## 面板挂载：三策略自适应

右侧栏 pane 注册机制未在 DSH 里实测探明（计划书 Step 1 留给 Windows 机），所以面板挂载按序尝试、**命中即停**：

1. `ctx.sidebarRight` 的 pane 注册能力（`registerPane('governor', …)` 等四种调用形状），排面板组最前；
2. keyed slot 遮蔽右侧栏内容槽（候选 `sidebar.right.pane` / `sidebar.right.pane.content`，priority -1）；
3. 兜底沿用 v1 已验证的 `main` keyed 面板（key `governor`）。

命中的策略名写在根节点 `data-dsh-governor-mount` 属性上，也会打到 `console.debug('[governor-mode] panel mounted via …'`。

> **实测结论（待 Windows 验证后补）**：装好插件后开 DevTools 看 `document.documentElement.getAttribute('data-dsh-governor-mount')`——值为 `pane` / `slot:…` / `main`，即实际命中的策略；若面板不可见但值为 `slot:…`，说明候选槽名不存在（策略二静默挂上了但宿主不渲染），回报后调整候选表或直接走 main 兜底。

## 像素头像的边界

像素头像是**总督面板专属**的视觉语言：只在面板里的总督 / 手下节点上渲染，由 16×16 像素网格（像素相框 + 12×12 像素脸）程序化生成，种子取自会话 id，所以同一个会话每次都是同一张脸。

它**不碰任何官方原生头像与图标**：侧栏、品牌席位、会话列表、顶栏等官方组件一个字节都没改，官方插槽也没有被禁用。

像素里的每个色块都翻译成宿主令牌，因此深浅色主题都会跟着走：

| 部位 | 令牌 |
| --- | --- |
| 相框（受光 / 压暗） | `--dsw-alias-border-l3` / `--dsw-alias-border-l4` |
| 凹口底 | `--dsw-alias-bg-base` |
| 面部（上 / 下） | `--dsw-alias-bg-layer-2` / `--dsw-alias-bg-layer-1` |
| 轮廓线 | `--dsw-alias-border-l3` |
| 眼睛 | `--dsw-alias-label-primary` |
| 天线 / 视窗 / 颊灯 | `currentColor` → 由节点状态决定 `--dsw-alias-state-{idle,ongoing,done,warn}-primary` |

## 设计纪律（为什么长这样）

- 颜色一律取 `--dsw-*` 语义令牌（`bg-layer-1/2/3` 分层的阶差、`label-*` 四级文字、`border-l1~l4`、`elevation-*`），**没有自造色值**（测试断言 STYLESHEET 不含 hex / rgb 字面量）。
- 不加大投影、不加发光；「进行中」用 `--dsw-alias-state-business-primary` + 透明度呼吸表达。
- 面板与气泡沿用宿主材质（`--dsw-specific-menu` + `backdrop-filter: var(--dsw-menu-backdrop-filter)` + `data-menu-material`）。
- 头像尺寸取 16 的整数倍（总督 64 / 手下 48），像素整数倍放大不糊。

## 安装

包目录：`~/.dsh/local-plugins/dsh-governor-mode`，junction 到 profile：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-governor-mode" `
  -Target "$env:USERPROFILE\.dsh\local-plugins\dsh-governor-mode"
```

启用：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加一行（或由本包 `cordis.patch.yml` 走 bundle 通道）：

```yaml
- insert:
    - id: governor-mode
      name: dsh-governor-mode
```

改完**必须重启 DeepSeek Harness**：浏览器半是启动时校验并下发的。

## 自测

```sh
node tests/run.mjs
```

离线自测，不需要运行中的 DSH：宿主九路由（参数校验 / 501 降级 / 游标契约 / questions 提取 / settings 读写）、客户端（挂载三策略 / 拦截判定 / 排布 / 状态映射 / 降频 / 懒建与 bootstrap / 降级草稿桥 / 四区渲染）、提示词自包含性。

## 还原

- 临时关掉：把上面 insert 块里的行加上 `disabled: true`，或直接删掉整个 insert 块。
- 彻底移除：删掉 junction 与包目录。侧栏、右侧栏、主区全部回到官方行为（本插件不禁用任何官方插槽）。

## 本机写入坑

本机 Trae/DSH 通过编辑器写入的 `.js` / `.json` / `.yml` / `.md` 会以密文落盘（文件头 `%TSD-Header-###%`），`.mjs` / `.cjs` / `.htm` / `.markdown` 不受影响；**连编辑器里的“编辑”写回也会加密**。所以改动本包时：

1. 用编辑器把新内容写成 `lib/client.mjs`（明文）；
2. 用 node 拷成正式文件名：

```powershell
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.dsh/local-plugins/dsh-governor-mode/';fs.copyFileSync(p+'lib/client.mjs',p+'lib/client.js')"
```

3. 校验明文与语法后删掉 `.mjs` 中转文件。

## 已知边界（v2，实测反馈会更新）

- **三处签名未实测**：`subagents.prompt`（/prompt 的 501 错误信息里带可见方法名清单）、`connection.fetch.register`、右侧栏 pane 注册。全部做了多形状防御，首个 Windows 实测优先看这三处。
- `authenticatedUrl` 折凭据失败时提示词里回退裸基址（总督会话的 curl 可能吃 401）。
- 工作区不是 git 仓库时 git 灯常灰，「同步 / 汇报」仍可用（指令文本发给总督，由它降级处理）。
- 手下分支小标签是启发式匹配（git-state `workers` 的 `sub/<名>` 对会话标题），匹配不上不显示。
- 「预览」按钮只在 git-state 快照里出现 `previewUrl` / `preview`（合法 http(s)）字段时可用——总督提示词的 state.json schema 未约定该字段，需要时在提示词里补约定。
- 选择题卡作答是乐观更新：代答失败会还原卡片，以 2s 后的下一轮轮询为准。
- 手下上限 8：达到上限后不再显示「新建手下」。
