# dsh-token-hud

A token card inside the **left sidebar**, directly above the Settings row, in the
shell's additive `sidebar.footer.action` seat.

It is the supplied `TokenCard` design, ported: accent icon tile and title, a
`单位：亿 / 百万` switch, a dominant hero number with a quiet unit, a trend
sub-line, an iOS hairline, and three rounded metric tiles with the cache tile
carrying a miniature activity ring.

```
  TOKEN 用量
  ╭─────────────────────────────╮
  │ ⚡ Token 计量        单位：亿 │
  │                             │
  │ 总输出 Token                 │
  │ 0.14亿                      │
  │ ↘-56.2% · 较昨日 · 累计 14,077,631 tokens
  │ ─────────────────────────── │
  │ ╭───────╮ ╭───────╮ ╭─────╮ │
  │ │今日    │ │缓存    │ │输入  │ │
  │ │1.3百万 │ │98.7% ◯ │ │0.72亿│ │
  │ │8.9%占比│ │节约52亿│ │1:0.2 │ │
  │ ╰───────╯ ╰───────╯ ╰─────╯ │
  ╰─────────────────────────────╯
[ ⚙ 设置 ]
```

## Where it sits

One occupant of **`sidebar.footer.action`** — the shell's own additive seat at
the sidebar foot, declared by ui-sidebar as "optional actions beside Settings at
the sidebar foot", with `replaceRisk: none`.

The seat hands the occupant `{ wide }` (`false` = the 56px collapsed rail), where
a card has no room, so it renders nothing.

### Geometry

The column is `padding: 6px 12px` (`--dsh-sidebar-inline-padding`), but its
**session list cancels that padding** so rows reach the column's edge:

```css
/* ui-sidebar's own region area */
._regionArea { margin-left: -4px; margin-right: calc(-1 * var(--dsh-sidebar-inline-padding)); padding-left: 4px }
```

The block does the same, so it spans the whole column, then insets its card by
8px:

| | value |
|---|---|
| width | `calc(100% + 2 × var(--dsh-sidebar-inline-padding) - 1px)` |
| margin | `calc(-1 * var(--dsh-sidebar-inline-padding))` on both sides |
| padding | `8px 8px 10px` |
| card padding | `12px 12px 11px` |
| `box-sizing` | `border-box` |

The `- 1px` keeps the outer flex size just under the line so sub-pixel rounding
can never push the block onto a line of its own.

### One occupant per line

`footerActions` is a `display: flex` **row**, and it is shared: ui-cordis's panel
layer sits in it as `width: 100%; flex: none` — it takes the whole line and cannot
shrink, so without help it displaces this card out of the column entirely.

One scoped rule fixes that, without touching the other occupant:

```css
:has(> [data-dsh-token-hud="block"]) { flex-wrap: wrap }
```

## Porting the design

The component arrived as React + Tailwind + `lucide-react`. Three things it
assumed do not hold here:

| The design assumed | What this file does |
|---|---|
| A build step (Tailwind, JSX, bundler) | The bundle is a plain `window.__ModuleLoader__.load({ id, factory })` script: utility classes become inline styles plus one injected `<style>`, and JSX becomes `React.createElement` |
| `lucide-react` | The five icons are inlined as SVG children (`bolt`, `sparkles`, `database`, `layers`, `arrow-up/down-right`) |
| `max-w-xl` — a 576px panel | The rail gives the card **318px** (measured), so the ramp is scaled down once and the tiles are laid out from the top rather than `justify-between` |

### Scale

The design is authored at `text-6xl` / `p-7`. One step down, proportions intact:

| Element | Design | Here |
|---|---|---|
| Hero number | 48px (`text-5xl`) | 30px |
| Hero unit | 22px (`text-2xl`) | 14px |
| Card padding | 24–28px (`p-6`/`p-7`) | 12px |
| Corner radius | 32px (`rounded-[32px]`) | 20px |
| Tile padding | 14px (`p-3.5`) | 6px |
| Title | 14px | 12px |
| Hero label / sub-line | 12px | 10px / 9.5px |
| Tile label / value / caption | 12 / 18–20 / 11px | 9.5 / 13.5 / 9px |

Nothing overflows at 318px: all three tile labels and all three captions fit on
one line. The whole card is ~190px tall.

### Colour

The design's `bg-white/90 dark:bg-[#1C1C1E]/90` pair assumes Tailwind's own
light/dark switch. This app is themed — and wallpapered — by its own tokens, so
surfaces, borders and text come from `--dsw-alias-*` and follow the active theme.
The four accents keep the design's literal Tailwind palette, because the app has
no token for amber or indigo.

**The rim is mixed from the text colour**, not `--dsw-alias-border-l1`:

```css
border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #e7ebf3) 13%, transparent)
```

That token is faint enough to vanish when the panel sits on a same-coloured
sidebar, which is exactly what happened in the light theme: a white card on a
white rail with no visible edge.

### Font

The design's stack, with PingFang as the requested fallback:

```css
-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", system-ui, sans-serif
```

`-apple-system` resolves to SF Pro on macOS (paired with PingFang for CJK); on
Windows it resolves to nothing, so **PingFang SC** is used for everything.

> Verified on Windows 11 + Chromium 152: `"PingFang SC"` resolves and renders
> real weights at 400/500/600/700. The Chinese-named families a Windows PingFang
> port installs (`苹方_常规`, `苹方_中等`, …) are **not** resolvable from CSS —
> they fall through to Microsoft YaHei — so the English family name is the one
> that matters.

## What it shows

The design's `TokenMetrics` interface, mapped onto the one host route:

| Design field | Route field | Tile |
|---|---|---|
| `totalOutputTokens` | `total.output` | Hero |
| `todayTokens` | `today.output` | 今日 Token |
| `cacheHitRate` | `cacheHitRate` | 缓存命中率 |
| `inputTokens` | `total.uncachedInput` | 输入 Token |
| `cachedTokens` | `total.cacheRead` | 节约 (on the cache tile) |
| `trendPercentage` | `trendPercentage` | trend chip |

`todayTokens` reads **today's output**, not today's total. The tile reports it as
a share of the hero's all-time output, and today's total (which is mostly cache
reads) against all-time output produced a nonsense 3000% share.

### Units

The design's formatter, unchanged: the hero and the input tile follow the switch
(`亿` = 10⁸, `百万` = 10⁶), while 今日 and 节约 walk the scales automatically
(亿 → 百万 → 万 → plain count).

| tokens | shown |
|---|---|
| 14 077 631 (hero, 亿) | `0.14亿` |
| 14 077 631 (hero, 百万) | `14.1百万` |
| 5 252 400 640 (auto) | `52.52亿` |
| 2 400 000 (auto) | `2.4百万` |
| 24 000 (auto) | `2.4万` |
| 9 100 (auto) | `9100` |

### The trend chip

`trendPercentage` is today against **yesterday**, and the chip is
direction-aware: rising is emerald with an `↗`, falling is rose with a `↘`.
When there is no previous day the route answers `null` and the chip *and its
separator* drop out — the design's `?? 14.8` would have printed an invented
number, which is worse than printing nothing.

The hover tooltip says what the comparison actually is: today is still in
progress, yesterday is a full day. A mid-afternoon reading therefore looks
negative, which is the data, not a bug.

## Data source

The host half serves one read-only route, `GET /api/token-hud/usage`, aggregated
from the **session projection cache** (`$DSH_HOME/storages/session_projcache/sessions/*.json`).

Each projection document already carries:

- `tokenUsage.totals` — the session's own `uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`
- `contextActivity.days[YYYY-MM-DD]` — per-day `tokens`, `requests`, and per-provider / per-model / per-period (`peak` | `off`) token buckets

Those are the same numbers the UI's own meters read, so the card never disagrees
with the rest of the app. Reading them costs no session-log replay and covers
sessions that are not live.

Every file is cached by `(mtime, size)`, so a poll only re-reads what actually
changed; the whole aggregate is additionally reused for `cacheTtlMs`.

A file that is mid-write, truncated, or carries no usage rows is **skipped**,
never fatal — the aggregate simply excludes it and the next poll picks it up.

## Config

Set on the `token-hud` row in the profile patch (`cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Render the card at all |
| `intervalMs` | `20000` | Browser refresh cadence, floored at `2000` |
| `cacheTtlMs` | `15000` | How long the host reuses one aggregate, floored at `0` |

There is nothing to position — the sidebar owns the layout.

## Failure behaviour

- Host route down or erroring → the card keeps showing the last good numbers, and renders nothing at all before the first success.
- No projection cache yet → an all-zero meter, still `ok: true`.
- Missing payload blocks → zeroed fields, no crash.
- No previous day → no trend chip.

## Tests

```
node tests/run.mjs
```

45 checks across two suites:

- **host (14)** — route shape, aggregation across documents, the day-over-day trend and its `null` case, cache hit rate, peak/off split, skipping of corrupt/usage-less documents, display normalization, TTL reuse, mtime-driven re-read, absent cache directory, non-GET rejection, disposer registration.
- **client (31)** — bundle id and factory shape, requires nothing outside the seeded browser module table, Cordis export surface, `sidebar.footer.action` registration, **the full-bleed width, both negative margins and the 8px card inset**, **the visible rim in both themes**, **the compact scale** (a 30px hero, 12px card padding, and no type on the card larger than the hero), the strict hierarchy (30 > 13.5 > 9.5 > 9 read off the rendered tree), the scoped `:has()` wrap rule plus the card material (radius, translucent `color-mix` fill, backdrop blur, `:hover`, `prefers-reduced-motion`), the design's block order (header → hero → hairline → three tiles), the unit switch in both 亿 and 百万, the auto scales down to 万 and to a plain count, the `TokenMetrics` mapping, the tooltip detail, **the trend chip's presence, direction and absence**, the cache ring's offset, zero/missing-data robustness, English fallback, supplied-translator preference, interactive unit switching, stylesheet removal on dispose, collapsed-rail suppression, `enabled: false`, and interval re-arming.

## Design notes

- **Only node builtins are imported** by the host half and **only `react` / `react/jsx-runtime`** (both seeded in the browser module table) by the client half. The package therefore declares no `@deepseek-ai/dsh-*` peer, so the runtime's compatibility gate cannot block it, and no cross-plugin module injection is needed.
- The browser half uses a re-arming `setTimeout` rather than `setInterval`, so a configured `intervalMs` takes effect on the next tick instead of only after a reload.
- **The surface lives in the stylesheet, the geometry inline.** An inline `background` would beat the `:hover` rule, so the card's fill, rim, radius and shadow are CSS and only layout is inline.
- Every colour is a theme token except the four accents and the two shadow layers, which have to carry their own alpha.
- `:has()` needs Chromium 105+; `color-mix()` needs 111+; this app runs Electron 44 / Chromium 152.
