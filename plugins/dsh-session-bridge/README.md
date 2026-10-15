# dsh-session-bridge

把一个 DSH 会话**对外开放**，让别的 Agent（Codex、Trae、任何支持 MCP/HTTP 的东西）能发现并读取它 —— 会话的 **"..." 菜单**里多一行，选一下就在剪贴板放好一段**交接提示词**。

```
会话行  ⋯  ← 点开
├ 置顶            (pin,      100)
├ 重命名          (rename,   200)
├ 派生            (fork,     300)
├ (雷达) 暴露会话   (350)  ← 本插件
└ 归档            (archive,  400)
```

菜单行**只放短文字** ✓，说明放在**鼠标停留的提示**里 ✓：

| 状态 | 行内文字 | 鼠标停留的提示 |
|---|---|---|
| 待命 | `暴露会话` | 暴露此会话，并把交接提示词复制到剪贴板，供 Codex / Trae 等外部 Agent 读取。 |
| 进行中 | `正在暴露…` | 正在向 Host 注册这个会话的只读桥… |
| 成功 | `已复制` | 交接提示词已在剪贴板，粘贴给外部 Agent 即可。 |
| 失败 | `暴露失败` | 没能注册只读桥。检查 Host 侧 `/api` 通道与 `baseUrl` 配置后重试。 |

图标是**手绘的极简 SVG 雷达**（外圈 + 距离环 + 扫描线 + 一个光点），不是 emoji，`currentColor` 描边，跟随主题 ✓。

## 怎么用

1. 左侧会话栏，鼠标划过任意会话 → 点行尾的 **`⋯`**。
2. 选 **`暴露会话`**（左侧是雷达图标，悬停能看到完整说明）。
3. 该会话被暴露，**交接提示词自动进剪贴板**；那一行就地变成绿色 **`已复制`** ✓，约 0.7 秒后菜单自动关闭 ✓。
4. 把提示词粘给 Codex / Trae，它就能读到这个会话。

失败时（比如 `/api` 通道不通）那一行变橙色 **`暴露失败`**，**菜单不关** ✓ —— 直接再点一次即可 ✓。

## 交接提示词长什么样

```
【DSH 会话桥】有一个正在运行的 DeepSeek Harness 会话已对外开放（只读），你可以直接读取它。

发现文档：http://127.0.0.1:19387/api/session-bridge/info?bridge=aB3xK9
运行状态：http://127.0.0.1:19387/api/session-bridge/status?bridge=aB3xK9
会话记录：http://127.0.0.1:19387/api/session-bridge/transcript?bridge=aB3xK9&since=0

会话标题：欧创渲染内核
工作目录：E:\OltraZ1.1
会话 ID：session-4ece3e88-…
模型：deepseek/deepseek-v4.1-flash
已暴露：3 秒前 · 当前事件序号 seq=128

用法：GET 上面的地址即可。把上次拿到的 `seq` 作为 `since` 参数传入，可以只取增量。
注意：这是只读桥 —— 不能给它发提示词、不能执行命令、不能替它回答问题。
```

### 为什么是菜单行而不是 hover 图标

会话行末尾的 hover 条（`sidebar.workspaces.session.row.action`）官方只放了**归档**和**置顶** ✓ —— 那是高频、单图标、无文字的座位 ✓。暴露会话是**低频、需要说明**的操作 ✓，所以放在 `sidebar.workspaces.session.menu.item` ✓（官方 `pin/rename/fork/archive` 所在的二级菜单 ✓），有文字标签、有图标、有位置 ✓。

菜单行有一条别处没有的约定：**要自己关菜单** ✓ —— 通过注入的 `useMenuOpenState` 钩子 ✓（`hookContext: "MenuOpenState"` ✓）。本插件在确认后延迟 0.7 秒再关 ✓，这样用户能看见"已复制" ✓；失败时**不关** ✓。

## 接口

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/session-bridge/expose` | POST | `{ sessionId }` → 铸造（或复用）一个 bridge，返回发现文档 + 提示词 |
| `/api/session-bridge/info` | GET | `?bridge=` → 发现文档 |
| `/api/session-bridge/status` | GET | `?bridge=` → 是否存活、是否在跑、当前 seq |
| `/api/session-bridge/transcript` | GET | `?bridge=&since=` → 会话事件（增量） |
| `/api/session-bridge/revoke` | POST | `{ sessionId }` 或 `{ bridge }` → 撤销暴露 |

### 游标契约（重要）

`Session.snapshotEvents(fromSeq, toSeqExclusive)` 是**半开区间**，而 **`session.seq` 是"下一个偏移"**（不是最后一个事件的 seq）。所以：

> **把上一次响应里的 `seq` 原样作为下一次的 `since` 传回来。**

响应里的 `seq` 就是游标，不需要 +1、也不要去猜 ✓。

### transcript 返回什么

```json
{
  "bridge": "aB3xK9", "session": "session-…", "live": true,
  "from": 0, "seq": 128, "truncated": false,
  "events": [
    { "seq": 12, "time": 1791953444853, "type": "user/message",      "role": "user",        "text": "…" },
    { "seq": 14, "time": …,           "type": "assistant/message",   "role": "assistant",   "text": "…", "usage": {…} },
    { "seq": 15, "time": …,           "type": "tool/call",           "role": "tool-call",   "tool": "bash", "callId": "c1", "arguments": "…" },
    { "seq": 16, "time": …,           "type": "tool/result",         "role": "tool-result", "callId": "c1", "isError": false, "text": "…" },
    { "seq": 20, "time": …,           "type": "turn/end",            "turn": 1, "reason": "completed" }
  ]
}
```

一次最多 400 条事件（`truncated` 会置位 ✓）。

## 为什么这样设计

### 走已鉴权的 `/api` 通道

路由用 **`ctx.connection.fetch.register`** 注册 ✓ —— 和官方 `dsh-api-session-controller` 的 `/api/file` 同一条通道 ✓✓。这样：

- **不用自己造 token** ✓ —— 通道自带准入检查 ✓
- **不用碰 Electron 层** ✓
- 交接提示词里的 URL 用 **`ctx.connection.authenticatedUrl(base)`** 把凭据折进去 ✓，否则外部 Agent 拿到的是 401 ✓

### bridge id 而不是裸会话 id

URL 里带的是 6 字节随机 `bridge` ✓，不是 `session-…` ✓ —— 暴露出去的那个 URL **无法用来枚举或寻址别的会话** ✓。

### 只读

这一版**故意**不提供写入 ✓：不能发提示词、不能执行命令、不能替会话回答 `ask_user_question` ✓。那三个能力对应的 API 都已经存在（`subagents.prompt` / `commands.execute` / `userQuestions.answer`，都带 `@Remote` ✓），但一旦开放就等于把**完整的提示词注入 + 工具执行权**交出去 —— 那是另一个决定 ✓。

### 暴露是内存态

`exposures` 是一个 `Map` ✓，插件卸载即失效 ✓ —— 暴露是一次**活的授权**，不是持久状态 ✓。

## 配置

在 profile 的 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- id: session-bridge
  config:
    baseUrl: http://127.0.0.1:19387        # 外部 Agent 该用的基址
    sessionProjectionDir: ''                # 可选：会话投影缓存目录（只用来读标题）
```

`baseUrl` 默认 `http://127.0.0.1:19387`（DSH Web GUI 的环回端口）。

> **注意**：本插件**不导出 `Config`** ✓。Cordis 的 `resolveConfig` 要求 `Config` 是一个带 `validate` 的 schema（Zod 那种），给普通对象会直接让插件激活失败，而错误堆栈只指向 Cordis 内部、看不出是自己的问题 ✗。官方插件（如 `dsh-token-hud`）的做法就是**不导出 `Config`**，在 `apply(ctx, config = {})` 里防御性地读 ✓。

## 测试

```
node tests/run.mjs
```

28 项检查，覆盖：

- 5 条路由全部注册在 `/api/session-bridge` 前缀下；没有 `connection` 载体时**保持惰性**（不注册任何东西）
- expose 铸造 bridge id / 二次 expose 复用同一个 bridge / 缺 `sessionId` 返回 400
- info 返回发现文档（cwd、模型、seq、绝对 endpoint、`howToUse`）；未知 bridge 一律 404
- **transcript 的游标契约**：`since=0` 全量、`since=<上次的 seq>` 拿到 0 条、`since=5` 只拿新增；事件摘要覆盖 user/assistant/tool-call/tool-result/turn-end
- 事件摘要对**未知形状不崩**（`undefined`、未知 type、块数组、null）
- `usableBaseUrl`：折入凭据、去掉尾斜杠、抛异常时回退
- 交接提示词自包含（URL、cwd、模型、seq、增量说明、只读声明）
- 客户端：bundle 形态、注册进 `sidebar.workspaces.session.row.action`（`order 150`，在归档 100 与置顶 200 之间）、无会话时渲染 `null`、样式表注入与卸载
- 客户端：点击 → `POST /api/session-bridge/expose`（**相对路径** ✓）→ 剪贴板写入**原样**的 Host 提示词；`done` / `busy` / `failed` 三种状态；**双击不会重复暴露**（busy 守卫）；剪贴板被拒时走 `execCommand` 回退、仍失败才报错
