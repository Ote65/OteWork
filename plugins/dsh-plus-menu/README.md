# dsh-plus-menu

DeepSeek Harness Web 输入框的 `+` 菜单升级：点开加号是一个**单层平铺**——
命令直接置顶平铺（不折叠、不分组），技能与 MCP 是**默认收起的可折叠分区**，
点标题原地展开（grid 高度+透明度过渡动画），技能区顶部还有一条极简搜索框。
**点开加号后直接打字也能搜**，不用先打 `/`。

```
点加号（或只打一个 /）
┌──────────────────────────────┐
│ /compact      Compact the …  │  ← 命令：一级平铺，置顶
│ /plan         Toggle plan …  │
│ ▸ 技能                        │  ← 折叠标题，点击展开
│ ▸ MCP                        │
└──────────────────────────────┘
展开「技能」后                打 /je → 平铺搜索（有序子序列）
┌──────────────────────────────┐
│ ▾ 技能                        │
│ ┌ 搜索技能… ────────────────┐ │
│ │ jest        Jest testing  │ │
│ │ mermaid     Diagrams      │ │
└──────────────────────────────┘
```

## 它修的是什么

DSH 自带的加号按钮（`dsh-client-ui-conversation` 里的 `IconPlusOutlineMedium`）只做一件事：

```js
inputTriggers.toggleSource('command', { trigger: '/', query: '', … })
```

`toggleSource` 按**来源名精确匹配**，只播种那一个来源组（见 `dsh-client-ui-input-trigger`
的 `InputTriggerController.toggleSource`）。所以加号永远只显示 `command` 这一组——
技能是另一个来源（`ui-skill` 注册的名字叫 `skill`），无论装了多少技能都不会出现在加号里。
只有手打 `/` 才会走"全部来源"的路径。

## 它怎么修

不重画输入框，也不替换菜单，而是**就地装饰官方那两个 `/` 来源**：

- 包住 `command` 来源的 `candidates()`，按查询决定返回哪一级的行。
- 包住它的 `onPick()`：技能行返回字面量 `/名字␠`（与手打 `/名字` 完全同一条宿主加载路径），
  MCP 行返回该工具的准确 wire name，命令行原样交回官方处理。
- 把 `skill` 来源的**候选组静默掉**：本插件负责渲染全部技能行，官方再渲染一份就是重复。
  它的目录缓存、排序、子代理守卫、`/名字` 插入语义都还在——行就是从它那里取的。
- 把 `command` 来源的组标题关掉（否则技能列表上方会顶着一个写死的 "Commands"），
  改用行自带的 `section` 分区标题。
- 包住每个会话控制器的 `track()`，让**点开加号后直接打字就能搜索**（见下）。

键盘导航、鼠标点选、span CAS、插入、关闭——全部仍由官方管线负责。

**零 `require()`**：浏览器的模块表只播种了少量平台模块，本浏览器半区一个都不需要。

### 加号内搜索是怎么接上的

加号打开的是一个 **launcher**：它的 hit 是合成 span、草稿里没有 token。官方的
`track()` 在这种状态下打不出触发符时会**直接 return**——菜单保持打开但**不过滤**。
所以"点加号然后打字"原本什么都不会发生。

本插件包住控制器的 `track()`：先原样调用官方实现，**只在官方走那条提前 return 的分支时**
（判据是 `this.hit` 未被改动）补一步——把光标前的那个词合成成一次命中，
`query` 就是这个词、`span` 正好覆盖这个词，然后重新拉候选。

于是：点加号 → 打字 → 菜单实时过滤；清空 → 回到分类列表；
选中某项时替换掉的正好是你刚打的那串字，不会留下垃圾。

`sessionOf()` 是所有控制器访问的唯一入口（`ui-conversation` 的
`controller(actx)` 也走它），所以包住它就能挂到每个会话的控制器上。

## 查询语义

| 状态 | 菜单显示 |
|---|---|
| 点加号（空草稿） | 命令平铺置顶，技能与 MCP 为默认收起的折叠分区 |
| **点加号后直接打字** | **按刚打的词过滤整个菜单**（就是这套平铺搜索） |
| 只打 `/` | 同上 |
| `/skills/…` | 只列技能，按 token 之后的内容过滤（下钻层级保留，带「← 返回」） |
| `/mcp/…` | 只列 MCP 工具，**以服务器名作分区标题**（下钻层级保留） |
| `/commands/…` | 只列斜杠命令（下钻层级保留） |
| 其它任何文本（如 `/je`） | 三层一起搜：命中命令平铺在前，技能/MCP 仍按分区列出 |

技能搜索用的是官方 `ui-skill` 自带的 `rankByName`：**大小写不敏感的有序子序列**匹配，
前缀命中优先。所以 `/jst` 能找到 `jest`，`/mmd` 能找到 `mermaid`。

下钻会把命名空间 token 写进草稿（`/skills/`），这正是官方 `@` 目录下钻用的同一套契约：
token 在光标处保持"未闭合"，输入框的 update 监听重新 track 到它，菜单自动重开，
**不需要显式重开调用**。选中叶子节点时整个 token 被替换掉，所以命名空间不会残留到发出的消息里。

`/skills/je` 会被识别成**一个** token（右侧那个 `/` 因词边界规则被跳过），
所以下钻之后继续打字就是在分类内过滤——188 个技能靠这个才用得起来。

## 行为细节

| 场景 | 结果 |
|---|---|
| 点加号 | 命令平铺置顶 + 技能/MCP 折叠分区；技能数就是真实目录大小，**不截断** |
| 点折叠标题 | 原地展开/收起，grid 高度+透明度过渡动画；展开状态跨重渲染保持 |
| 技能区搜索框 | 只过滤技能区内不匹配的行（清空恢复），文本跨重渲染保持 |
| 点加号后打字 | 实时过滤整个菜单（见上） |
| 进入下钻层级后打字 | 在该分类内过滤 |
| 选技能 | 插入 `/名字␠`；宿主 pre-step 边界确定性地把技能正文注入该轮 |
| 选 MCP 工具 | 插入 `mcp__服务器__工具`（准确 wire name），模型据此调用 |
| 选命令 | 与改动前完全一致（交回官方 `onPick`） |
| 「← 返回」 | 仅下钻层级有：把 token 换回 `/`，回到平铺列表 |
| 内联下钻 | 光标前是文字时 `/` 会被词边界规则判死，所以自动补一个前导空格 |
| 未配置 MCP | 平铺视图不出现 MCP 分区；手动 `/mcp/` 进去有一行不可选的说明，告诉你去哪加配置 |
| 宿主 MCP 接口挂了 | MCP 分区整个消失（打不开的分类比没有分类更糟）；技能与命令照常 |

## 折叠分区是怎么实现的

行数据仍全部来自官方候选管线（过滤、排序、pick 语义不变）；折叠与搜索框是
**渲染后的 DOM 增强**：MutationObserver 盯住 `role="listbox"`，把「技能」「MCP」
两个分区标题变成可点击的折叠头（`data-pm-toggle`），其后的行移入
`grid-template-rows 1fr→0fr` 动画容器（`data-pm-group`），技能区顶部注入
`[data-pm-search]` 极简搜索框。折叠状态与搜索文本记在插件内存 Map 里，
宿主 React 重渲染后自动恢复；dispose 时解包还原、删表删框，一切交回原样。

## 安装

已装在本机 desktop profile（`~/.dsh/profiles/desktop`）：

```jsonc
// package.json
"dependencies": { "dsh-plus-menu": "link:C:/Users/<you>/.dsh/local-plugins/dsh-plus-menu" },
"dsh": { "profile": { "bundles": [ …, "dsh-plus-menu" ] } }
```

浏览器半区是启动时校验并下发的，所以**装完要重启 DeepSeek Harness**。

## 配置

分类顺序配置在 bundle 补丁里（**仅影响下钻层级与 MCP 说明的服务器清单顺序**；
平铺视图固定为 命令→技能→MCP，不再受它影响），
覆盖 profile 的 `cordis.patch.yml` 即可：

```yaml
- id: plus-menu
  config:
    sections: [mcp, skills, commands]   # 省略/写错的名字会被丢弃，缺失的分类补在末尾
```

## MCP 是怎么接上的

`@deepseek-ai/dsh-mcp-client` 是 DSH 自带的 MCP 桥，但**没有任何 bundle 挂它**——
不写行进去，MCP 就是完全不存在的。所以 profile 的 `cordis.patch.yml` 里加了：

```yaml
- insert:
    - id: mcp-everything
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: everything
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-everything"]
        failOnStartupError: false
```

之后模型就能调用 `mcp__everything__echo` 这类工具，加号的 MCP 分类也会列出来。

**注意 token 成本**：每个 MCP 工具的 schema 都会进入**每一次**请求。`everything`
有 13 个工具，换成真实服务器后建议删掉这一行。新增服务器只要照抄一条行，
`serverName` 唯一且匹配 `[A-Za-z0-9_-]{1,32}`。

## 技能目录

宿主按 `dsh-skill-filesystem` 的规则发现技能：`$DSH_HOME/skills` 下每个目录要有
`SKILL.md`，frontmatter 必须有合法的 `name`（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）和
`description`。本机 `~/.dsh/skills` 下 188 个目录**全部通过**。

## 自测

```sh
node tests/run.mjs          # 两个离线测试台，加载的是 lib/ 里真正的产物
node tests/probe-mcp.mjs    # 用真实 MCP 握手探一个 stdio 服务器（默认 everything）
```

`tests/client.test.mjs` 用一个假的 `window.__ModuleLoader__` 和假 cordis 上下文加载
`lib/client.js`，覆盖第一级分类行与计数、三个分类级的行与选路、下钻 token（含内联补空格）、
分类内过滤、自由文本搜索、**加号内打字搜索（含空词回退、内联位置、真实 token 不重复拉取）**、
宿主接口挂掉的降级、配置顺序、晚注册、以及 dispose 后还原官方钩子（含被静默的 skill 组）。
`tests/host.test.mjs` 挂载 `lib/index.js` 并像 webserver 那样打这个只读路由，
覆盖作用域读取、回退、配置归一化、方法守卫和注册表抛错。

## 兼容性依赖

本插件贴着官方实现，靠的是这几个**公开契约**；DSH 升级后值得复核：

| 依赖 | 位置 |
|---|---|
| 加号启动的来源名是 `command`、技能来源名是 `skill`，触发符都是 `/` | `ui-conversation` / `ui-commands` / `ui-skill` |
| 候选行支持 `section` 字段与 `drill` 标记；来源支持 `showGroupTitle: false` | `ui-input-trigger` 的 `MenuView` / `seedGroups` |
| `drill` 选中后插入的文本若留下未闭合 token，菜单会自动重开 | `ui-conversation` 的 `insertText`（`keepCompleting` 只是"契约乘客"） |
| `/` 的词边界规则：右侧 `/` 前是词字符时被跳过，所以 `/a/b` 是一个 token | `ui-input-trigger` 的 `detectTrigger` / `boundaryOk` |
| launcher 打开时，官方 `track()` 打不出触发符就提前 return 且不动 `this.hit` | `InputTriggerController.track` |
| 控制器的 `stopFetch` / `reduce` / `refreshHeaders` / `fetchCandidates` / `deps.roster` | `InputTriggerController` |
| `inputTriggers.sessionOf()` 是控制器访问的唯一入口；`registerSource()` 是唯一注册入口 | `ui-input-trigger` 的 `InputTriggerService` |
| `onPick` 返回 `{ text, continue }` 即插入文本 | `InputTriggerController.execute` |
| 宿主 `ctx.tools.schemas(agent)` 用 agent 作 scope key | `dsh-tools` / `dsh-tool-skill` |

任何一条变了，插件都会**降级**而不是弄坏菜单：找不到来源就不装饰，候选抛错就当空分区，
宿主接口失败就少一个分类，控制器接口变了就退回"加号不可搜索"的原状（`try/catch` 包着，
只打一条控制台日志），dispose 时把来源钩子、控制器 `track`、`sessionOf` 全部原样还原。

## 已知限制

- 下钻 token（`/skills/`）会短暂出现在草稿里；若此时按 Escape 再发送，草稿里就留着它。
  官方 `@` 目录下钻也是同样的取舍。
- 加号内搜索按**光标前那个词**过滤：词里有空格时只按最后一段搜（这正是 inline 命中该有的行为）。
- 技能名与宿主命令同名时，仍按官方规则解析成命令。
- 只处理 `/` 触发符下的 `command` / `skill` 两个来源；`@` 引用（文件、会话）不受影响。
