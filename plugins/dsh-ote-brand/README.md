# dsh-ote-brand

The **OTE Work** brand skin for the DSH Web shell.

It takes the three brand seats the shell publishes and repaints them, without
editing a single shipped file:

| Surface | Shipped | With this skin |
| --- | --- | --- |
| `sidebar.brand.mark` | the DeepSeek whale | the OTE Work mark in the artwork’s own ink, 32% over the seat size |
| `sidebar.brand.name` | the “deepseek `HARNESS`” wordmark | the white “OTE Work” wordmark |
| `conversation.hero.brand.mark` | the animated fish | the OTE Work mark, 32% over the seat size |
| hero headline copy | “探索未至之境” | “让构想皆成现实” |
| hero preview pill | “预览版” | deleted |

## 中文速览

- **Logo**：用户给的 OTE 星形 logo，白底被解成 alpha（不是阈值化），通过
  `mask-image` 上色，**墨色就是原图的墨色**（继承 `--dsw-alias-label-primary`：浅色
  侧栏上是近黑，深色皮肤上是近白）。**不要把它写死成白色**：这张线稿的笔宽在 31.68px
  下只有约 0.56 CSS px（`npm run measure:strokes` 可复现），白色发丝线落在浅色侧栏上
  等于消失——这就是"只有 OTE Work 没有 logo"的原因。渲染
  尺寸是席位请求值的 **1.32 倍**（`MARK_SCALE`，先 +10% 再 +20%）。侧栏
  31.68×26.79 比品牌行原本固定的 24px 身份盒更高，所以本插件只在含此 logo 的行上
  解除该行的固定高度与 `overflow:hidden`，否则星星的尖角会被裁掉。
- **OTE Work 字标**：粗体圆润的 **Baloo 2 Bold** 轮廓（不是文字），白色，带
  温柔投影。之所以做成轮廓：外壳自己的字标就是 SVG path，这样不依赖安装字体、
  不需要 `@font-face`、不会回退，阴影也能用 `drop-shadow()` 贴合字形的边缘。
- **标语**：首屏 `hero.headline` 是 `dsh-client-ui-conversation` 字典里的字面量，
  locale 服务拒绝同一 namespace/locale 的重复注册，所以由浏览器半边直接改写那一个
  文本节点（MutationObserver 回调是微任务，绘制前完成，不会闪一下旧文案）。
- **预览版**：由样式表 `display:none` 掉。
- 官方品牌行**没有被禁用**：本插件以 **优先级 `-1`** 占用同一批席位（注册表渲染
  最低优先级），所以删掉下面那一行配置就完全恢复原样。

## Mount

The profile mounts it as one host row. In `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: ote-brand
      name: dsh-ote-brand
```

and the package must resolve from the profile — either installed through the CLI
or linked into `profiles/<profile>/node_modules`:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ote-brand" `
  -Target "$env:USERPROFILE\.dsh\local-plugins\dsh-ote-brand"
```

The package also ships a `cordis.patch.yml`, so `dsh plugin add` can mount the
same row through the bundle channel instead. Do not do both.

The junction is what keeps the package resolvable, and it is not recorded in the
profile's `package.json`/`pnpm-lock.yaml` (the row is hand-mounted, exactly like
the profile's MCP rows). A later `dsh plugin` install/uninstall runs pnpm in that
profile and may prune it — re-create the junction, or move the package to a real
`link:` dependency and refresh the lockfile if you want it to survive.

## Why the pieces are shaped this way

**The seats.** `@deepseek-ai/dsh-client-ui-brand-official` already occupies both
sidebar seats, and a `single` slot rejects a second registration at the same
priority. The registry renders the *lowest* priority — it says so in the
conflict message it throws — so this skin registers at `-1`. The stock brand row
is never touched, and removing this plugin's row restores it exactly.

**The mark** (`assets/ote-work-mark.png`). The supplied artwork is black line art
on paper white, and the “remove the background” step is a coverage solve rather
than a threshold: for ink on a white page, a pixel's coverage *is*
`(paper − luminance) / (paper − ink)`, so the original anti-aliased edges survive
exactly and no white box is left behind (`tools/make-mark.mjs`, with the measured
paper level and a floor for JPEG ringing around the strokes). The result is
trimmed to the ink bounding box, so the mark fills its seat instead of carrying
the scan's own padding. It is painted through a `mask-image`, which is what keeps
those anti-aliased edges at 26–45 px.

The skin keeps the artwork’s own ink: `color: inherit`, which is the shell’s label
colour — near-black on a light sidebar, near-white on a dark one. That is what the
supplied artwork is (black line art), and it is the difference between visible and
gone here: `npm run measure:strokes` reports the artwork’s median stroke as 9 of its
512 px, which collapses to **0.56 CSS px** at the brand row’s 31.68 px. A dark hairline
at that weight still reads; the same line in white over a pale sidebar does not, which
is what “only OTE Work, no logo” looked like.

**The wordmark.** Outlines, not text — the same choice the shell makes for its own
wordmark, and it is what lets the skin:

- need no installed font, no `@font-face` request and no fallback;
- get a *gentle* shadow that follows the letterforms (`drop-shadow()`), where a
  `text-shadow` would follow the text box;
- stay white on both themes, because the tight dark edge in the shadow keeps the
  letterforms separated from a pale sidebar.

`tools/make-wordmark.mjs` lays the string out with fontkit — advances and
kerning from `layout()` — bakes every glyph into one SVG path in a tight ink box,
and writes it between the `@generated:ote-wordmark` markers. It reads the string
from `BRAND_NAME` in `lib/client.js`, so the artwork and the accessible name
cannot drift apart. The face (Baloo 2 Bold, SIL OFL) and how to swap it are in
[`assets/FONT.md`](assets/FONT.md).

**The hero headline.** It is the one surface with no seat of its own: a literal in
`dsh-client-ui-conversation`'s own dictionary (`hero.headline`), and the locale
service rejects a second registration of a namespace/locale pair, so a skin
cannot re-register it. The browser half therefore rewrites that one text node in
the DOM. MutationObserver callbacks are microtasks, so the rewrite lands before
the frame is painted — no flash of the shipped copy. The watcher keeps the found
node cached and re-queries at most every `LOOKUP_BACKOFF_MS`, so a busy
transcript costs one `isConnected` check per mutation batch, not a document scan.

## Build

The artwork is generated, and the generators are the only thing in here that is
not plain source:

```powershell
npm run build          # mark → wordmark → embed, in that order
npm run build:mark     # assets/ote-work-source.jpg  → assets/ote-work-mark.png
npm run build:wordmark # assets/*.woff2              → the outlined path in lib/client.js
npm run build:embed    # assets/ote-work-mark.png    → the data URI in lib/client.js
npm run measure:strokes # how thick the mark's strokes are at each seat size
npm run preview        # docs/brand-preview.png, rendered from the shipped bytes
npm test               # the browser-half suite
```

`build` needs `sharp` (rasterising) and `fontkit` (outlining). Neither is a
dependency of this package — both already ship with the DSH install, in two
different places, so `tools/resolve.mjs` locates them from `--modules <dir>`,
`DSH_PLUGIN_MODULES`, the profile directory, or a path into the install found in
the environment. The error names every anchor it tried when none answers.

If you replace the mark with artwork of a different aspect ratio, `build:mark`
warns about the stale `MARK_RATIO` in `lib/client.js` — update it. The wordmark
ratio needs no constant: it comes from the generated ink box.

## Coupling to shipped internals

Two things here depend on names the shell does not promise:

- **The CSS-module suffixes.** The preview pill is hidden through
  `[class*="_previewBadge"]`. A CSS-module class is `<hash>_<exported name>`, and
  only the exported name is stable (the shipped class is `Hqq-bq_previewBadge`).
  The hash prefix changes between builds, the suffix does not.
- **The hero title cell.** `[class*="_titleGroup"] > span:first-child` is the
  headline text React owns. The skin rewrites that node's text in place, so
  React's node identity survives and a locale switch is corrected by the same
  watcher.

Both are checked by `npm test`, which is also what will fail first if a future
DSH build renames them. The catch is silent by construction — those surfaces
would simply revert to the shipped brand, which is also the failure mode if this
plugin's row is removed.

## Verification

`npm test` covers the bundle shape, the three seat registrations, the shadowing
priority, the stylesheet lifecycle across a reload, the mark's geometry and
its 1.32× scale together with the row-growing rules that keep the taller star
uncropped, the decoded PNG, the outlined wordmark (its ink ratio, its subpaths
and that it needs no escaping), that the mark carries no ink colour of its own (it
must inherit the shell label colour), the white wordmark's shadow rules in both themes, and the hero-copy rewrite including the rerender and remount
paths.

A real Chromium was also used while chasing the “the brand button has no icon”
report: a page built from the shipped stylesheet proved, by pixel readback, that
the data URI decodes to 512×433 with an 81.5% fully transparent field and 11.9%
anti-aliased ink, that `mask-image` resolves to it, and that the brand identity
grows to the 26.78 px mark inside a 36 px rail button. `tools/preview.mjs` is the
durable form of that check.

It does not cover rendered pixels. `docs/brand-preview.png` is that check, by
construction: `tools/preview.mjs` reads the *shipped* mark data URI and wordmark
path out of `lib/client.js` and composes them at the real seat metrics on both
theme fills, so the picture is of the final bytes rather than of a re-run of the
generators. `docs/mark-transparency.png` is the generated mark over a
checkerboard, which is how the removed background is checked.

`docs/sidebar-light.png` and `docs/sidebar-dark.png` are the same idea through a
**real Chromium**: the shipped stylesheet is loaded into a page that replicates
the shipped brand row, over a pale sidebar (`#f5e8e9`, a live wallpaper's colour)
and a dark one. They are what settled the ink question — the mark is a hairline
line drawing, so its colour has to contrast with the sidebar rather than be fixed.

Still worth one glance in the running app: the sidebar brand row and its
collapsed rail, the blank-session hero (mark, “让构想皆成现实”, no pill), and
that the white wordmark is legible on your actual wallpaper.

## Files

| Path | Role |
| --- | --- |
| `lib/index.js` | host half — an empty row, present only so the harness serves the client bundle |
| `lib/client.js` | browser half — the skin (mark, wordmark, stylesheet, hero copy); holds the two `@generated` blocks |
| `cordis.patch.yml` | the profile bundle patch that mounts the row |
| `assets/ote-work-source.jpg` | the artwork as supplied |
| `assets/ote-work-mark.png` | the generated transparent mark |
| `assets/baloo2-700-latin.woff2` | the vendored wordmark face (source only; never served) |
| `assets/OFL-Baloo2.txt` | that face's license |
| `assets/FONT.md` | where the face came from, and how to swap it |
| `docs/brand-preview.png` | the brand row in both themes, rendered from the shipped bytes |
| `docs/sidebar-light.png` / `docs/sidebar-dark.png` | the shipped stylesheet in a real Chromium, over a pale and a dark sidebar |
| `docs/mark-transparency.png` | the generated mark over a checkerboard |
| `tools/resolve.mjs` | locating `sharp` and `fontkit` in the DSH install |
| `tools/make-mark.mjs` | source artwork → transparent mark |
| `tools/make-wordmark.mjs` | face + string → outlined wordmark |
| `tools/embed-mark.mjs` | mark → the `@generated:ote-mark` block |
| `tools/measure-strokes.mjs` | the mark’s stroke weight at each seat size |
| `tools/preview.mjs` | shipped artwork → `docs/brand-preview.png` |
| `tests/` | the browser-half suite |
