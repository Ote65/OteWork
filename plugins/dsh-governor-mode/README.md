# dsh-governor-mode

DSH 的第二种工作模式（总督模式）。全部沿用宿主自己的设计体系，不引入任何自造配色与皮肤。

## 它做了什么

1. **模式开关**：挂在 `conversation.header.leading`（主区顶栏最左，无会话时也存在），「经典｜总督」两态。
2. **总督模式下的侧栏**：捕获阶段拦截工作区行的点击（`[data-row-key^="workspace:"]`），改为打开总督页，**不展开**会话列表；行内的「新建会话 / 更多」按钮照旧放行。退出总督模式即完全恢复官方行为。
3. **总督页**：`main` keyed 面板（key `governor`）——
   - 上方一个总督头像（= 该工作区的第一个会话）；
   - 下方最多 8 个子会话头像（= 其余会话），按 1/2/3/4 居中、5→3+2、6→3+3、7→4+3、8→4+4 排布；
   - 头像之间一条横母线 + 每个节点一条竖支线（直角），线色随会话状态变化；
   - 点头像打开对应会话；右侧完成气泡；底部输入井。

## 像素头像的边界

像素头像是**总督页专属**的视觉语言：只在 `main` 面板里的总督 / 子会话节点上渲染，由 16×16 像素网格（像素相框 + 12×12 像素脸）程序化生成，种子取自会话 id，所以同一个会话每次都是同一张脸。

它**不碰任何官方原生头像与图标**：侧栏、品牌席位、会话列表、顶栏等官方组件一个字节都没改，官方插槽也没有被遮蔽。

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

- 颜色一律取 `--dsw-*` 语义令牌（`bg-layer-1/2/3` 分层的阶差、`label-*` 四级文字、`border-l1~l4`、`elevation-*`），**没有自造色值**。
- 不加大投影、不加发光；「进行中」用 `--dsw-alias-state-business-primary` + 透明度呼吸表达。
- 面板与气泡沿用宿主材质（`--dsw-specific-menu` + `backdrop-filter: var(--dsw-menu-backdrop-filter)` + `data-menu-material`）。
- 头像尺寸取 16 的整数倍（总督 64 / 子会话 48），像素整数倍放大不糊。

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

## 还原

- 临时关掉：把上面 insert 块里的行加上 `disabled: true`，或直接删掉整个 insert 块。
- 彻底移除：删掉 junction 与包目录。

## 本机写入坑

本机 Trae/DSH 通过编辑器写入的 `.js` / `.json` / `.yml` / `.md` 会以密文落盘（文件头 `%TSD-Header-###%`），`.mjs` / `.cjs` / `.htm` / `.markdown` 不受影响；**连编辑器里的“编辑”写回也会加密**。所以改动本包时：

1. 用编辑器把新内容写成 `lib/client.mjs`（明文）；
2. 用 node 拷成正式文件名：

```powershell
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.dsh/local-plugins/dsh-governor-mode/';fs.copyFileSync(p+'lib/client.mjs',p+'lib/client.js')"
```

3. 校验明文与语法后删掉 `.mjs` 中转文件。

## 已知边界（v1）

- 顶栏开关与总督页都是 root 作用域，**拿不到会话作用域的 `inputActions`**，所以输入井采用「打开总督会话 + 通过 `conversation.input.left` 的搬运桥把文字写进它的草稿」，而不是直接投递。
- 完成气泡目前只显示状态与标题：读会话里最后一段输出需要接 chat store（v1 未接）。
- 子会话上限 8：达到上限后不再显示「新建子会话」。
