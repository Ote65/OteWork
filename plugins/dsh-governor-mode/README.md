# dsh-governor-mode

DSH 的默认且唯一工作模式（总督模式 v2）。总督面板挂在右侧边栏（与内置浏览器 / 文档预览并列、自适应栏宽，不锁比例），宿主半提供 `/api/governor` 控制平面，总督会话用 bash curl 驱动整个工作区。面板视觉照搬总督面板设计稿：工业哑光黑绿底 + 橘高亮、12×12 手绘像素人、直角连线与数据光流。

## 它做了什么

### 浏览器半（lib/client.js）

1. **侧栏拦截（无条件）**：工作区行的点击（捕获阶段，`[data-row-key^="workspace:"]`）改为打开总督面板，**不展开**会话列表；行内交互控件（button / a / input / select / textarea / label / `[role="button"]` / 展开 data 属性白名单）照旧放行。
2. **原生「新建会话」按钮 = 新建工作面板**：DSH 侧栏那个 `aria-label="新建会话"` 的图标按钮被接管——点击改为走官方目录选择器 + 官方工作区创建（`uiWorkspace.pickDirectory()` → `workspaces.create({path})`），新建的工作区由差集轮询自动补总督会话与提示词。悬停提示里的「新建会话」文案改写为「新建工作面板」（`sidebar` 命名空间已被官方占用，`ctx.locale.register` 会抛错，所以只改文案；`aria-label` 保持原样，拦截器靠它定位）。注：快捷键（非点击）仍走官方行为。
3. **总督面板，四区内容同一套**：
   - **roster 区**：总督像素头像 76px（点击打开总督会话）+ ≤8 个手下像素头像 56px（1/2/3/4 居中、5→3+2、6→3+3、7→4+3、8→4+4 排布）+ 状态灯（idle / ongoing 呼吸 / done / warning）+ 直角母线连线（第一行从总督底部走总线再横折入节点，第二行从父节点底边垂直下连，进行中那条叠辉光 + 虚线流动 + 双向数据包）+ 手下分支名小标签（取自 git-state 的 `sub/<名>`）；**新增手下子会话的唯一入口是总督栏右侧的「＋」**（`uiWorkspace.startSession(workspaceId)`，满 8 个置灰）；
   - **选择题卡区**：轮询待答问题（问题 + 选项 + 来源手下），点选即代答；头部是 autoAnswer 开关（读写 `/settings`）；
   - **git 区**：dev 同步灯（`devSynced` 橘 / 未同步琥珀 + ahead/behind / 无快照灰）+ 三按钮「同步 GitHub」「汇报」「预览」（预览走 `ctx.sidebarRight.openTabIn(sessionId, 'browser', {params:{url}})`，git-state 里没有合法 http(s) 地址时置灰）；
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

## 像素头像

像素头像是**总督面板专属**的视觉语言：只在面板里的总督 / 手下节点上渲染。每张脸是 12×12 字符网格逐格描 `rect` 出来的（`shapeRendering: crispEdges`）——总督固定为军官帽 + 橘徽章那一套，手下是设计稿的 16 套手绘像素人（耳机 / 毛线帽 / 圆眼镜 / 棒球帽 / 赛博面罩 / 爆炸头 / 发髻 …），按 `hashId(会话 id) % 16` 取，所以同一个会话每次都是同一张脸。

它**不碰任何官方原生头像与图标**：侧栏、品牌席位、会话列表、顶栏等官方组件一个字节都没改，官方插槽也没有被禁用。

调色板就是设计稿那 8 个色（写在 `PIXEL_PALETTE`，不再走宿主令牌）：

| 键 | 色值 | 用途 |
| --- | --- | --- |
| `B` | `#090e0c` | 帽檐 / 轮廓（最深） |
| `D` | `#1b2622` | 阴影 / 衣着 |
| `G` | `#2f423a` | 中间灰绿 |
| `S` | `#dce4e0` | 面部 / 高光 |
| `O` | `#ff5500` | 橘（徽章、帽带） |
| `Y` | `#ff7700` | 琥珀（次要高光） |
| `W` | `#ffffff` | 纯白（眼白 / 数据包） |

## 设计纪律（为什么长这样）

- **视觉照搬用户给的总督面板设计稿**：面板底 `#101614`、卡片底 `#0b100e`、描边 `#1c2822 / #23342b`、正文 `#e2e8e5`、次级 `#9bb0a6`、弱化 `#7d8f87`，强调一律橘 `#ff5500` / 琥珀 `#ff7700`。这套色值**刻意不走 `--dsw-*` 令牌**（用户 2026-10-16 拍板破例），所以深浅色主题下外观恒定。
- 节点状态用**橘底边 + 呼吸光晕**表达：`ongoing` 底边橘 + `dsh-gov-breathe` 呼吸、`done` 底边橘 + 静态橘投影、`warning` 底边琥珀。
- 连线三段：静态母线 `#1b2822`；进行中叠一层 `feGaussianBlur` 辉光线 + 白色 `stroke-dasharray:6 14` 流动虚线（`dsh-gov-flow`）+ 一白一橘两个方块沿同一条路径反向 `animateMotion`。
- 尊重 `prefers-reduced-motion`：该模式下关掉呼吸与流动动画。
- 面板宽高全部自适应右侧栏容器（`width/height:100%` + `clamp()` 间距、`flex:1` 舞台），**不锁 16:9**。
- 设计稿底部的 1–8 数量圆点 / 自动模拟 / 洗牌 / standby 是纯 demo 控件，**没有移植**（保留会变成死按钮）；面板里保留的是真实功能区：选择题卡 / git 三按钮 / 输入井。
- 头像尺寸取 12 的整数倍（总督 76 / 手下 56），像素整数倍放大不糊。

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

离线自测，不需要运行中的 DSH：宿主九路由（参数校验 / 501 降级 / 游标契约 / questions 提取 / settings 读写）、客户端（挂载三策略 / 拦截判定 / 排布与第二行父映射 / 状态映射 / 降频 / 懒建与 bootstrap / 降级草稿桥 / 四区渲染 / 像素网格与设计稿配色光流）、提示词自包含性。

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
- 手下上限 8：达到上限后总督栏的「＋」置灰。
