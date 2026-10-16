# OTE Work

**OTE Work** 是给 [DeepSeek Harness](https://harness.deepseek.com)（DSH）Web 外壳做的一套改装插件集：
把官方外壳重新上品牌、把输入框和侧栏补成想要的样子——而且**不改动 DSH 任何一个已发布的文件**。

每个插件只占用官方公开的席位（slot）、bundle 补丁或已鉴权的 `/api` 通道，所以移除配置后，
官方外观与行为会原样回来。这不是补丁包，也不是 DSH 的分支。

> 本仓库只包含插件源代码，**不包含 DeepSeek Harness 本体**：没有二进制、没有 `app.asar`、
> 没有 `@deepseek-ai/*` 包。DSH 是 DeepSeek 的产品，本项目与 DeepSeek 无隶属或背书关系。

![OTE Work 品牌皮肤](plugins/dsh-ote-brand/docs/brand-preview.png)

## 插件

| 插件 | 作用 |
| --- | --- |
| [`dsh-ote-brand`](plugins/dsh-ote-brand/README.md) | **品牌皮肤**：占用侧栏品牌席位与首屏 hero 品牌席位，替换官方鲸鱼标、字标与首屏标语，并隐藏「预览版」角标。以优先级 `-1` 遮蔽官方席位，官方品牌行未被禁用，删掉配置即完全还原。 |
| [`dsh-plus-menu`](plugins/dsh-plus-menu/README.md) | **输入框 `+` 菜单升级**：点加号是一个两级目录（技能 / MCP / 命令），可下钻、可在分类内过滤，**点开加号后直接打字就能搜**。 |
| [`dsh-token-hud`](plugins/dsh-token-hud/README.md) | **侧栏 token 计量卡片**：累计用量、今日用量与缓存命中率，从会话投影缓存聚合而来。 |
| [`dsh-session-bridge`](plugins/dsh-session-bridge/README.md) | **跨 Agent 会话桥**：把一个 DSH 会话经已鉴权的 `/api` 通道暴露给另一个 Agent（Codex、Trae…），提供发现文档、transcript、实时状态与一键复制的交接提示词。 |
| [`dsh-element-picker`](plugins/dsh-element-picker/README.md) | **元素引用**：在内置浏览器预览里点选 UI 元素，一条精确的源码引用就落到输入框里。 |
| [`dsh-governor-mode`](plugins/dsh-governor-mode/README.md) | **总督模式**：主区顶栏最左加「经典｜总督」开关；总督模式下点侧栏工作区行改为打开总督页（总督 + 最多 8 个子会话的像素头像 + 直角母线连线），全部沿用宿主 `--dsw-*` 语义令牌，官方组件零改动。 |
| `dsh-picker-probe` | **诊断台**：开发 `dsh-element-picker` 时用来经真实 webview 桥驱动 picker 的一次性诊断插件，保留仅供复现。 |

## 仓库结构

```
plugins/
├── dsh-ote-brand/        品牌皮肤（含生成用工具、字体与预览图）
├── dsh-plus-menu/        输入框 + 菜单
├── dsh-token-hud/        侧栏 token 计量
├── dsh-session-bridge/   跨 Agent 会话桥
├── dsh-element-picker/   预览内元素拾取
├── dsh-governor-mode/    总督模式（第二工作模式）
└── dsh-picker-probe/     拾取器的诊断台
```

每个插件目录都是一个可独立挂载的 DSH 插件包：`package.json` 声明包名，
`cordis.patch.yml` 描述要插进 profile 的那一行，`lib/` 是实际运行的代码，
`tests/` 是离线自测台。

## 安装

各插件的 README 有精确的挂载步骤与自测命令；通用流程是：

1. 把 `plugins/<name>` 放到 DSH 能解析的位置——常见做法是复制或 link 到 `$DSH_HOME/local-plugins/<name>`，
   并让 profile 的 `node_modules` 能解析到它。
2. 在 profile 的 `cordis.patch.yml` 里插一行，或用 `dsh plugin add` 走 bundle 通道
   （多数插件自带 `cordis.patch.yml`，**两者选一，不要同时做**）。
3. 浏览器半区（client bundle）是**启动时**校验并下发的，所以装完要**重启 DeepSeek Harness**。

自测（离线，不需要运行中的 DSH）：

```sh
node tests/run.mjs
```

需要 `sharp` / `fontkit` 的构建步骤只存在于 `dsh-ote-brand`，它会从 DSH 安装里自动定位这两个库。

---

## English

**OTE Work** is a customization set of plugins for the **DeepSeek Harness** (DSH) web
shell: it rebrands the shell and extends its composer and sidebar, **without
editing a single shipped DSH file**.

Each plugin only occupies interfaces DSH publishes — brand seats, bundle patches,
the authenticated `/api` channel — so removing its row restores the stock shell
exactly. This is not a patch set and not a DSH fork.

This repository contains **plugin source only**. It redistributes no part of
DeepSeek Harness: no binary, no `app.asar`, no `@deepseek-ai/*` package. DeepSeek
Harness is a product of DeepSeek; this project is not affiliated with, endorsed
by, or sponsored by DeepSeek. See [NOTICE](NOTICE) for third-party attribution.

Install: place `plugins/<name>` where your DSH profile can resolve it, insert the
row from its `cordis.patch.yml` (or add it through the bundle channel with
`dsh plugin add`), then **restart DeepSeek Harness** — client halves are verified
and served at startup.

## License

[MIT](LICENSE) © 2026 OTE Work. Third-party notices: [NOTICE](NOTICE).
