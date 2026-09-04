# STELLARSIGHT — visual assets

Brand: a map pin in signal orange-red, carrying a four-pointed star — the point
on the map where something payable lives. Dark-first developer-infrastructure
chrome; all page texture is CSS/inline-SVG, so nothing here is load-bearing for
layout.

Palette: accent `#F5400E` · ink `#070B14` · surface `#0D1220` · cream `#F2EDE3`

| File | What it is | Intended use |
| --- | --- | --- |
| `stellarsight-mark.svg` | 512×512 — the mark: accent pin, ink core, white four-pointed star. Transparent ground. | Standalone mark at 24–128px (README header, footer). The nav and search chrome use an inline-SVG mirror of this file (`src/components/Marks.tsx`), so the UI never depends on it resolving. |
| `favicon.svg` | The same mark geometry. | `<link rel="icon" href="/assets/favicon.svg">` — both icon links in `index.html` point here. |
| `og-card.svg` | 1200×630 source — ink ground, mark, wordmark, tagline. | Source of truth for the share card. |
| `og-card.png` | 1200×630 raster of the same. | `og:image` / `twitter:image`. Already exactly 1.91:1 — do not letterbox. |

## Notes

- The web app must degrade gracefully if any file here is missing: `AssetImg`
  removes itself on error, and every brand mark in the chrome is inline SVG.
- No file depends on any other; nothing references a font or an external URL.
