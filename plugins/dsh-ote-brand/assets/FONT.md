# The wordmark face

`baloo2-700-latin.woff2` is the **Baloo 2 Bold (700)** Latin subset, used only as
the *source* for `tools/make-wordmark.mjs`. The shipped wordmark is the outlined
result, so the browser never loads this file — it exists so the artwork can be
regenerated and audited.

| | |
| --- | --- |
| Family | Baloo 2 |
| Weight | 700 (Bold) |
| Designer | Ek Type |
| License | SIL Open Font License 1.1 — `OFL-Baloo2.txt` |
| Upstream | <https://github.com/google/fonts/tree/main/ofl/baloo2> |
| Downloaded from | `https://fonts.googleapis.com/css2?family=Baloo+2:wght@700&display=swap` (the `/* latin */` `woff2` source, 2026-10) |

Baloo 2 was chosen for a bold face whose terminals and counters are genuinely
rounded: the brief was a 粗体圆润 wordmark, and it is the heaviest of the rounded
faces compared (Nunito ExtraBold, Quicksand Bold, Fredoka SemiBold, Comfortaa
Bold) while staying legible at the sidebar's 13 px ink height.

## Swapping the face

Any Latin WOFF2 or TTF works, as long as the license permits redistribution —
OFL faces keep the OFL file beside them, the way `OFL-Baloo2.txt` sits here.

```powershell
# put the new face in assets/, then regenerate the outlined wordmark
node tools/make-wordmark.mjs assets/<face>.woff2
node tests/run.mjs
```

`make-wordmark.mjs` reads the string to outline from `BRAND_NAME` in
`lib/client.js`, so the artwork and the accessible name cannot drift apart. It
refuses a face that is missing any glyph the string needs.

Note that renaming the file does not change the artwork: only the outlined path
in `lib/client.js` does.
