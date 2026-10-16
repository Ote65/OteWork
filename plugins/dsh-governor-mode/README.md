# dsh-governor-mode

DSH 的默认且唯一工作模式（总督模式 v3）。**总督就是 DSH 官方实验层 Agent Teams 的 Team Lead**：手下（队友）由官方 `agentTeams` 服务创建与管理（上限 8 官方校验），派单走官方持久信箱（在跑的队友在最近步骤边界收消息、绝不打断——原生待发区），汇报走官方信箱 / 共享任务板。本插件在此之上补三样官方没有的东西：**一级栏总督入口与像素头像**、**官方右侧栏的「总督」标签页面板**（读官方花名册投影渲染）、**`/api/governor` 面板通路 + 总督行为提示词**。面板视觉照搬总督面板设计稿：工业哑光黑绿底 + 橘高亮、12×12 手绘像素人、直角连线与数据光流。

## 官方团队层怎么装上的

本包的 `cordis.patch.yml` 照 `@deepseek-ai/dsh-experimental-agent-team-profile` 官方层原样装配：插入 `agent-team`（服务，`maxMembers: 8`）、`tool-agent-team`（给 Agent 的 `spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent / team_task_*` 工具 + 协作纪律提示词）、`ui-agent-team`（官方会话头部「团队面板」弹层），并禁用被取代的官方 `tool-subagent*` 工具。四个包都随 DSH 本体发布（桌面 app.asar 与 CLI node_modules 均已内置实测）。移除本包 = 整套回到官方默认。

## 它做了什么

### 浏览器半（lib/client.js）

1. **一级栏工作区行 = 总督入口**：行的文件夹 SVG 换成总督像素头像、名称尾部挂总督徽记（`data-row-key^="workspace:"` 的行，`data-dsh-gov-row` 标记已装饰）；点击该行（捕获阶段）在右侧栏打开「总督」标签页，并按**映射状态三分支**解析总督会话：
   - **有映射** → 直接打开总督会话（绝不把子会话误当总督）；
   - **老工作区（有会话、无映射，总督模式启用前建的）** → **不建总督、不收编**——打开该工作区最近一个会话，面板显示「老工作区未启用总督」；
   - **零会话（新建工作区）** → 懒建总督会话（官方 Team Lead）。

   行内交互控件（button / a / input / select / textarea / label / `[role="button"]` / 展开 data 属性白名单）照旧放行。官方 renderer 把图标换回来时会被再装饰一遍（幂等，绝不堆叠）。
2. **原生「新建会话」按钮 = 新建工作面板**：DSH 侧栏那个 `aria-label="新建会话"` 的图标按钮被接管——点击改为走官方目录选择器 + 官方工作区创建（`uiWorkspace.pickDirectory()` → `workspaces.create({path})`），新建的工作区由差集轮询自动补总督会话与提示词。悬停提示里的「新建会话」文案改写为「新建工作面板」（`sidebar` 命名空间已被官方占用，`ctx.locale.register` 会抛错，所以只改文案；`aria-label` 保持原样，拦截器靠它定位）。注：快捷键（非点击）仍走官方行为。
3. **总督面板，四区内容同一套**：
   - **roster 区**：顶部固定总督节点——像素头像 76px、名称＝工作区名 +「总督」（点击打开总督会话）；手下节点 = **官方 Agent Teams 花名册**（`GET /team` 折叠总督会话的 `team/*` 事件），像素头像 56px、名字用官方队友名（worker-N），状态灯（idle / ongoing 呼吸 / done / warning，failed 阶段映射 warning）+ 直角母线连线 + 手下分支名小标签（取自 git-state 的 `sub/<名>`）；**新建队友的唯一入口是总督栏右侧的「＋」**（`POST /spawn` → 官方 `agentTeams.spawnTeammate`，上限 8 官方校验、满了置灰）；
   - **选择题卡区**：轮询待答问题（问题 + 选项 + 来源手下），点选即代答；头部是 autoAnswer 开关与 **reportMode 汇报模式开关**（即时汇报 / 静默简报，读写 `/settings`）；
   - **git 区**：dev 同步灯（`devSynced` 橘 / 未同步琥珀 + ahead/behind / 无快照灰）+ 三按钮「同步 GitHub」「汇报」「预览」（预览走导航控制器公开面 `openTab('browser', {params:{url}, revealIfOpened:true})`，git-state 里没有合法 http(s) 地址时置灰）；
   - **输入井**：目标下拉（总督 / 各队友官方名 / 全体）+ 文本 → `POST /api/governor/prompt {lead, target}`，宿主优先走**官方信箱 sendMessage**（在跑的队友排队送达不打断），官方通路缺席时退回 subagents.prompt，再不通降级为 v1 验证过的草稿搬运桥（打开目标会话 + `conversation.input.left` 把文字落进它的输入框）。
4. **新建工作区 = 新建总督；老工作区 = 不启用**：轮询 `useWorkspaces` 差集，新工作区无会话则 `uiWorkspace.startSession` 懒建总督会话，会话就位后 `POST /bootstrap` 注入总督提示词并写映射（受 `settings.autostart` 控制，默认开）。**用户既有的工作区不建总督也不注入**。映射（workspace → 总督会话 id）持久化在宿主 `~/.dsh/governor-binds.json`（`bindsPath` 配置可覆盖），浏览器半内存缓存优先；手下关系不在这里——官方花名册是唯一真源。
5. **轮询克制**：roster/questions/team 2s、git-state 10s，页面不可见统一降到 15s；**「总督」标签页不可见时完全不排期**（本地派生——工作区看护、行装饰、现场缓存——由常挂的看护组件照常跑），卸载清干净。

### 宿主半（lib/index.js，`/api/governor` 十二路由）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/roster?sessions=id1,id2&workspace=` | GET | 逐会话聚合 title/live/running/pendingInteraction/seq/cwd |
| `/transcript?session=&since=` | GET | 增量事件；`seq` 原样作下次 `since`（半开区间游标，单次上限 400 条置 `truncated`） |
| `/questions?sessions=` | GET | 扫 `pendingInteraction` 提取待答选择题；选项形状不认识返回空数组不崩 |
| `/prompt` | POST | `{lead, target, text}` 优先官方 `agentTeams.sendMessage`（原生待发区语义）；官方缺席退回 `{session, text}` → `subagents.prompt`（多形状探测，失败 501 附形状清单） |
| `/answer` | POST | `{session, choice, callId?}` → `userQuestions.answer`；choice 兼容 label / `{id, selected}` / `{answers:[…]}` |
| `/command` | POST | `{session, line}` → `commands.execute(agent, line, [], signal)` |
| `/settings` | GET/PUT | 内存态按 workspace 键；默认 `{autoAnswer:false, autostart:true, reportMode:'wake'}`；PUT 校验布尔与 wake/quiet |
| `/git-state?session=` | GET | 纯读会话 cwd 下 `.governor/state.json`，**绝不执行 git** |
| `/bootstrap` | POST | `{session, workspace, title}` 生成总督提示词并走 /prompt 同一通路 |
| `/bind?workspace=` | GET/POST | 读 / 写 workspace → 总督会话 id 的最小映射；先写内存 overlay 再尽力落盘 `~/.dsh/governor-binds.json`（失败静默） |
| `/team?session=` | GET | 折叠总督会话事件流里的官方 `team/member / team/task / team/message/*` 事件 → 花名册 + 任务板 + 信箱计数（只读投影，形状不认识的事件跳过不崩） |
| `/spawn` | POST | `{lead, name, description?, prompt?}` → 官方 `agentTeams.spawnTeammate`（上限 8 官方校验），prompt 自动附加队友纪律（git `sub/<名>` 分支 + 按 reportMode 的汇报方式）；服务缺席 501、总督 agent 不在场 409 |

路由挂 `connection.fetch.register`（多形状防御），URL 由 `authenticatedUrl` 折凭据；没有 connection 载体时惰性不注册。

### 总督提示词（lib/prompt.js）

`buildGovernorPrompt({baseUrl, workspaceId, workspaceTitle, sessions, settings})` 纯函数：身份声明（总督 = 官方 Team Lead）+ **官方团队工具手册**（spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent / team_task_*）+ 面板侧 curl 手册（transcript / questions / answer / command / settings / git-state）+ 游标契约 + 选择题规则（autoAnswer 开 = 总督按推理选最佳并说明理由，主观题仍问用户；关 = 全部汇报用户）+ git 纪律（release 仅用户 / dev 总督+用户 / 队友各在 `sub/<名>` 分支、收口后写 `.governor/state.json`、同步 GitHub 只归总督）+ 监控职责（验收看 diff 不听「做完了」）+ 汇报口径与四类风险 + **汇报模式（第十二节）**：`wake`＝队友完工 `send_message` 给 lead、总督被唤醒即时接手（官方纪律）；`quiet`＝队友只记任务板不发消息，用户问起时总督 `team_task_list` + 按需查 transcript 再汇报。两种模式都写明：队友 running 时派单由官方信箱在步骤边界排队（原生待发区），不许打断，只有用户明确要求停止时才用 interrupt_agent。

## 面板挂载：官方右侧栏的「总督」标签页

面板是**官方右侧栏的一个标签页**（与浏览器 / 文档 / 编辑器并列，顶部标签切换），走官方两阶段公开通路（与 shipped guide 标签同一条路）：

1. `sidebarRightTabs` 服务注册标签类型（id `dsh-governor`、kind `governor`、标题「总督」）；
2. body / title 分别注册进 keyed 槽 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（key = 类型 id）。

- 打开：一级栏点工作区行调公开面 `sidebarRight.openTab('governor', {revealIfOpened:true})`；服务一律防御式访问，缺席静默降级，绝不声明强制依赖。
- 标签体经 `useTabInfo().tab.visible` 感知可见性：标签不可见时面板只保留本地派生，不产生任何 `/api/governor` 请求。
- `shell.overlay`（root 作用域列表槽，官方弹窗 / toast 同住）只挂一个**渲染 null 的看护组件**：一级栏点行要的现场缓存（`latest.wsList` / `latest.wsSessions`）与新工作区的总督懒建由它常驻完成，与标签页开合无关。
- 挂载策略写在 `data-dsh-governor-mount`（现值恒为 `tab`），并打到 `console.debug('[governor-mode] panel mounted via tab')`；面板异常时开 DevTools 读这个属性回报。

> **历史**：v2 早期按「pane 注册 / 右侧内容槽遮蔽 / main keyed 面板」三策略猜测挂载，真机全部落空；中间版本走 `shell.overlay` 浮层抽屉；现版本走官方标签类型公开通路。v2 曾自造 bind/takeover/report 三件套模拟团队关系，v3 起全部删除——官方 Agent Teams 是手下关系的唯一真源，自造只剩 workspace→总督会话 id 的最小映射（`/bind`）。

## 像素头像

像素头像有**两处渲染点**：总督面板里的总督 / 手下节点（React 版 `pixelAvatar`），以及**一级栏工作区行的文件夹图标位**（DOM 版 `pixelAvatarElement`，官方 React 树里只能手工造节点）。每张脸是 12×12 字符网格逐格描 `rect` 出来的（`shapeRendering: crispEdges`）——总督固定为军官帽 + 橘徽章那一套，手下是设计稿的 16 套手绘像素人（耳机 / 毛线帽 / 圆眼镜 / 棒球帽 / 赛博面罩 / 爆炸头 / 发髻 …），按 `hashId(会话 id) % 16` 取，所以同一个会话每次都是同一张脸。

它**只碰一级栏工作区行这一处官方 DOM**：把行首的文件夹图标位换成本插件自造的像素头像 svg、在行名称尾部追加一个徽记 span（都是本插件自己的节点，官方 renderer 重渲染时再装饰一遍）。官方其余组件（品牌席位、会话列表、顶栏、右侧栏、官方插槽）一个字节都没改，也没有禁用任何官方插槽。

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

- **手下关系不造轮子**：官方 Agent Teams 已有花名册 / 信箱 / 任务板 / 上限校验，本插件只读它的投影、经它的服务派单；自造只剩「哪个会话是这个工作区的总督」一条映射。
- **视觉照搬用户给的总督面板设计稿**：面板底 `#101614`、卡片底 `#0b100e`、描边 `#1c2822 / #23342b`、正文 `#e2e8e5`、次级 `#9bb0a6`、弱化 `#7d8f87`，强调一律橘 `#ff5500` / 琥珀 `#ff7700`。这套色值**刻意不走 `--dsw-*` 令牌**（用户 2026-10-16 拍板破例），所以深浅色主题下外观恒定。
- 节点状态用**橘底边 + 呼吸光晕**表达：`ongoing` 底边橘 + `dsh-gov-breathe` 呼吸、`done` 底边橘 + 静态橘投影、`warning` 底边琥珀。
- 连线三段：静态母线 `#1b2822`；进行中叠一层 `feGaussianBlur` 辉光线 + 白色 `stroke-dasharray:6 14` 流动虚线（`dsh-gov-flow`）+ 一白一橘两个方块沿同一条路径反向 `animateMotion`。
- 尊重 `prefers-reduced-motion`：该模式下关掉呼吸与流动动画。
- 面板宽高全部自适应右侧栏容器（`width/height:100%` + `clamp()` 间距、`flex:1` 舞台），**不锁 16:9**。
- 设计稿底部的 1–8 数量圆点 / 自动模拟 / 洗牌 / standby 是纯 demo 控件，**没有移植**（保留会变成死按钮）；面板里保留的是真实功能区：选择题卡 / reportMode 开关 / git 三按钮 / 输入井。
- 头像尺寸取 12 的整数倍（总督 76 / 手下 56），像素整数倍放大不糊。

## 安装

包目录：`~/.dsh/local-plugins/dsh-governor-mode`，junction 到 profile：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-governor-mode" `
  -Target "$env:USERPROFILE\.dsh\local-plugins\dsh-governor-mode"
```

启用：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加一行（或由本包 `cordis.patch.yml` 走 bundle 通道——它同时装配官方 Agent Teams 层）：

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

离线自测，不需要运行中的 DSH：宿主十二路由（参数校验 / 501 降级 / 游标契约 / questions 提取 / settings 读写含 reportMode / bind 落盘回读 / team 事件折叠 / spawn 官方服务与队友纪律 / prompt 原生信箱优先与退回）、客户端（官方标签页两阶段注册 / 点行映射优先开总督 / 老工作区不建总督开最近会话 / 常挂看护的现场缓存与懒建 / 标签服务缺席静默降级 / 一级栏行装饰与点行开会话 / 拦截判定 / 排布与第二行父映射 / 状态映射含 failed→warning / 降频 / 懒建与 bootstrap 写映射 / 降级草稿桥 / 四区渲染含官方花名册与 ＋ 走 /spawn / 未启用空态 / 像素网格与设计稿配色光流）、提示词自包含性（官方团队工具面 + 双汇报模式纪律）。

## 还原

- 临时关掉：把上面 insert 块里的行加上 `disabled: true`，或直接删掉整个 insert 块。
- 彻底移除：删掉 junction 与包目录。侧栏、右侧栏、主区全部回到官方行为（官方团队层随本包的 bundle patch 一起消失，`tool-subagent*` 自动恢复）。

## 本机写入坑

本机 Trae/DSH 通过编辑器写入的 `.js` / `.json` / `.yml` / `.md` 会以密文落盘（文件头 `%TSD-Header-###%`），`.mjs` / `.cjs` / `.htm` / `.markdown` 不受影响；**连编辑器里的“编辑”写回也会加密**。所以改动本包时：

1. 用编辑器把新内容写成 `lib/client.mjs`（明文）；
2. 用 node 拷成正式文件名：

```powershell
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.dsh/local-plugins/dsh-governor-mode/';fs.copyFileSync(p+'lib/client.mjs',p+'lib/client.js')"
```

3. 校验明文与语法后删掉 `.mjs` 中转文件。

## 已知边界（v3，实测反馈会更新）

- **官方 Agent Teams 是 experimental 层**：随 DSH 本体发布（桌面 app.asar 与 CLI 均实测内置），但接口可能随官方版本变化；官方层若改名 / 挪位，本包的 bundle patch 与 /team 事件折叠要跟着对。
- **老工作区不收编**：官方队友必须是总督亲手 spawn 的直系子会话，「把已有会话挂名成手下」在官方模型里做不到——按用户拍板，老工作区直接不启用总督模式。
- **/team 读活会话**：花名册折叠自总督会话的事件流，会话不在内存（冷）时返回空；面板点开总督会话即恢复。官方 `sessionProjections` 的冷投影未接入（防御式留白）。
- **legacy `subagents.prompt` 真机签名未通**：实测五种调用形状全部 `invalid payload`（501 错误里带原文）——v3 起派单主通路是官方 `agentTeams.sendMessage`，legacy 只作兜底，最终兜底是草稿搬运桥。
- 两处签名未实测：`connection.fetch.register`（多形状防御）；「预览」按钮的导航控制器 `openTab('browser', …)`（缺席静默）。
- `authenticatedUrl` 折凭据失败时提示词里回退裸基址（总督会话的 curl 可能吃 401）。
- 工作区不是 git 仓库时 git 灯常灰，「同步 / 汇报」仍可用（指令文本发给总督，由它降级处理）。
- 手下分支小标签是启发式匹配（git-state `workers` 的 `sub/<名>` 对官方队友名），匹配不上不显示。
- 选择题卡作答是乐观更新：代答失败会还原卡片，以 2s 后的下一轮轮询为准。
- 队友上限 8 由官方校验：满员时面板「＋」置灰，总督 spawn 会收到官方 `TEAM_MEMBER_LIMIT` 报错。
