# Brand rules

The brand of the decks: tone, colours, shapes, type, logos. Edit it (and `brand.json`) for your own brand; a file of
`decks/public/` replaces the same file of `public/` (your logos, tokens), so your decks can carry your brand while the
tool keeps the neutral one; a file of `<deck>/public/` does the same for that deck only (one brand per deck).

## Tone

- Direct, teaching, honest about limits. Precise, with concrete numbers.
- Explain the **why**, not only the how.
- Show expertise (demos, numbers, diagrams); do not claim it.
- Banned words: cutting-edge, innovative / innovant, passionate / passionné, highest quality, premium.
- Talks: in the deck's language (`lang` in `deck.json`, English by default); technical terms keep their usual
  English form. Other languages in `slide.<lang>.json` (one `slide.html`, see `AGENTS.md`). Keep the speaker's wording.

## Colour

- Near-black ground (`--ink`), white text, one red (`--red`, #EE342C) as the only accent.
- Greys only for hierarchy: `--light` > `--field` > `--gray` > `--dim`. Surfaces: `--ink-2` raised, `--ink-3` sunken.
- In CSS use the tokens, never raw values. Raw colours only where CSS variables cannot go (canvas, three.js, SVG
  presentation attributes) and for data colours.
- Red is for emphasis: one red idea per slide (a phrase in the lead or the takeaway, the key card, node or value).
  Titles stay white.

## Shape

- One rule kind: 1px `--rule`, never 2px. Accent bars: the 4px top border of a card (`.sa-card`, white or red).
- No decorative gradients. No rounded corners (exception in use: `.dg-node`, see `components/diagram`).
- 12px red squares as bullets and markers. Mono labels at 12px, uppercase, letter-spacing .12em.

## Type

- Display (titles, takeaways, figure captions): Poppins, `--display`.
- Body: Helvetica, `--body`. Labels, captions, numbers: `--mono`.
- Sizes: title 42, lead 26, body and lists 24, takeaway 28. Content headings 26 (22 in small cards), big values
  34 (40), card text 18, lists in a card 20, captions 14 mono, labels 12 mono caps.
- Titles in sentence case (see `styles/rail/style.md`); chapter names in capitals.
- Typography follows the language. English: no space before `: ; ? !`, numbers as 10.24 and 2,048. French: a
  non-breaking space (`&nbsp;`) before `: ; ? !` and between a number and its unit (`10,24&nbsp;px/cm`). In both, a
  non-breaking space between a number and its unit (`46&nbsp;px`).

## Logos

Files in `public/assets/brand/`:

| File | Use |
|---|---|
| `sa-monogram-white.svg` | Rail logo (`.sa-logo`), white |
| `monogram.webp` | Giant monogram on cover-ground slides (`.sa-monogram`): fills the slide height, cut by the right edge |
| `wordmark-white.webp` | Cover wordmark (`.sa-wordmark`), brand block on red |
| `wordmark-color.webp` | Light grounds only |
| `logo-icon.webp` | Small icon |

The files of the tool are a neutral Keystone mark: replace them in `decks/public/assets/brand/` (same names).
