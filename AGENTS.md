# Keystone — the reference

Keystone is a local deck tool for technical talks: presenter, editor, theme, components, and feedback to Claude Code
by drawing and talking over the slides. This file is the whole reference, for people and for coding agents (Claude
Code reads it through `CLAUDE.md`). The README is the short introduction; `examples/keystone/` is the guide, as a deck.

## Getting started

Required: [Node.js](https://nodejs.org) 22 or later, and git.

```sh
git clone https://github.com/ancarmona/keystone.git
cd keystone
npm start
```

Open <http://localhost:4320>: **the guide to Keystone**, a deck made with Keystone that shows how to create a deck,
write slides, and work with Claude by drawing and talking (`examples/keystone`, in English and French). Also
<http://localhost:4321> (the style library, one example slide per layout and component) and <http://localhost:4322>
(a minimal deck, `examples/hello`).

Optional, for some features:

| Tool | For |
|---|---|
| [Claude Code](https://claude.com/claude-code) (`claude` on the `PATH`, signed in) | Styling slides, handling feedback, "Claude auto" |
| [Codex CLI](https://github.com/openai/codex) (`codex` on the `PATH`, signed in) | "Claude auto" run by Codex instead (see "Claude with no terminal") |
| Google Chrome, Chromium or Microsoft Edge | Screenshots, WebP encoding, thumbnails of published talks (found by itself; `CHROME=<path>` to choose one) |
| [uv](https://docs.astral.sh/uv/) | Transcription of feedback recordings (Whisper `large-v3-turbo`, on your machine; the model downloads on first use) |
| `npx` (comes with Node) | `tools/meshopt.mjs` downloads gltfpack when it runs |

Keystone runs on macOS, Windows and Linux (`npm run check` tests it on yours). What differs:

| | macOS | Windows | Linux |
|---|---|---|---|
| Transcription | [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) on Apple silicon (faster-whisper on Intel) | [faster-whisper](https://github.com/SYSTRAN/faster-whisper): on an NVIDIA GPU (the CUDA libraries, about 1 GB, download with the first recording), else the CPU | faster-whisper, as on Windows |
| Claude's spoken answers | System voice (`say`) | A system voice of your language (Settings › Time & language › Speech); without one, the browser's voices | The browser's voices |
| Shortcuts | `⌘` | `Ctrl` | `Ctrl` |

Environment variables in this file are written for macOS and Linux (`DECK_LANG=fr npm run shots`); in
PowerShell: `$env:DECK_LANG="fr"; npm run shots`.

Server settings, as environment variables:

| Variable | Default | Use |
|---|---|---|
| `PORT` | `4321` | Port of a single deck (`node server.js <deck folder>`) |
| `HOST` | `127.0.0.1` | Listen on another address, e.g. a Tailscale address to open the presenter on a phone or a tablet |
| `DECK` | — | Deck folder to serve, same as the argument |

### Keys of the presenter

| Key | Action |
|---|---|
| `→` `↓` `Space` `PageDown` | Next build step or slide |
| `←` `↑` `PageUp` | Previous |
| `Home` / `End` | First / last slide |
| `O` | Overview: every slide, the other decks of the server, **+ New deck** |
| `E` | Editor: the brief of the slide, its speaker notes, a message to Claude |
| `F` | Full screen |
| `L` | The deck's next language (also `?lang=fr` in the address) |
| `R` | Record feedback (`R` again saves, `Escape` twice discards, `⌘Z` takes the last stroke back, `N` adds a slide) |
| `T` | Tasks: Claude's tasks from the feedback sessions, "Claude auto", the log of the last run |
| `D` | The feedback language as it is written |
| `⌘S` | Save the editor |

Touch screens (phone, tablet): swipe left or right, or tap the left or right edge of the slide, to change slide; a tap
shows the bar, which keeps the presenting buttons only. Full screen: the browser's on iPad; on iPhone (no full screen
for pages), Share › Add to Home Screen: the deck then opens as a full-screen web app with its name and icon
(`/manifest.webmanifest`, `/icon.png` = `<deck>/assets/icon.png` 512×512, else `assets/brand/icon.png` of `decks/public/`
then `public/`). On a phone (touch and a short side under 600 px, or `?phone` in the address) each slide is rendered
with `<html class="sa-phone">` (`/render/<id>?phone`): a deck's CSS can make its text bigger there, since the slide shows at about half size.

Pages reload by themselves when a file of the deck or of `public/` changes. The presenter keeps only the slides near
the current one loaded, so decks with many WebGL slides stay within the browser's limits.

## Decks

Keystone holds no talk: each deck is a folder anywhere on disk (`deck.json` + `slides/`). Examples: `examples/keystone/` (the guide to Keystone, a deck about itself), `examples/hello/` (a minimal deck).

Your own decks: `decks/` (not in the Keystone repo: `.gitignore`; often a git repository of its own, cloned there):
- `decks/<id>/` — a deck, with its own `CLAUDE.md` for that talk when it needs one; `decks/CLAUDE.md` for all of them.
- `decks/keystone.json` — its decks (same format as `keystone.json`, `dir` relative to `decks/`), served with those of
  `keystone.json`. "+ New deck" adds to it.
- `decks/public/` — a file here replaces the same file of `public/`, in the server and in published talks: your logos
  (`decks/public/assets/brand/`, same file names), the reader's `site.json`, your tokens. The tool keeps neutral ones.

Run: `node server.js` (`npm start`) serves every deck of `keystone.json` (`examples/keystone` 4320, the guide to Keystone; `library` 4321; `examples/hello` 4322) and of
`decks/keystone.json`, each on its own port. `node server.js <deck folder>` (or `DECK=<deck folder>`,
or no argument from inside a deck folder) serves that deck alone on 4321 (no dependencies, Node ≥ 22; `PORT` to change;
`HOST` to listen elsewhere than 127.0.0.1, e.g. a Tailscale address to open it on a phone). Pages reload live when any
file under the deck folder or `public/` changes. Files are cached by the browser and revalidated (ETag), so slides share three.js, fonts and the theme instead of downloading them again. Text and model files (JS, CSS, HTML, JSON, SVG, GLB, .bin) are sent gzipped.

New deck: the overview's "+ New deck" asks for a title and a style guide, creates `decks/<id>/` (`deck.json` and a
`cover` slide to style), adds it to `decks/keystone.json` and serves it at once on the next free port
(`POST /api/decks {title, style}`).

Style guides: `library/styles/<id>/` = `style.json` (`id`, `default`, `css`) + `style.md` (its rules; starts with
`# Style: Name` then one paragraph that says what it looks like: the creation dialog shows both; optional `media`:
files of the library deck, e.g. its cover photo, copied into each new deck's `assets/media/`). A deck names its
guide in `deck.json` (`"style": "<id>"`; none = the default one): follow that `style.md` when styling its slides. A
guide whose `css` is not `/public/theme.css` (a file under `public/`, e.g. `/public/styles/<id>.css`) gets that
stylesheet added to every slide of the deck, after the theme. `GET /api/styles` lists the guides. Today there is one
guide, `rail`. (`tools/deploy.mjs` publishes the theme only: a second guide needs its stylesheet published too.)

Links between decks: the overview (`O`) lists the decks of the server at the top; a slide links to another deck with
`<a href="deck:<id>#<n>">` (id = the deck folder's name, slide number optional; handled by `display.js`). One port per
deck keeps every deck URL (`/deck/`, `/slides/`, `/api/`) unchanged. `GET /api/decks` lists the decks and their ports.

Publishing (website or standalone): `node tools/deploy.mjs <deck folder> --out <folder> [--url <site address>]` writes the deck
read-only in the website's talk format: `talks/<slug>/` (talk.json, the reader page, slides, thumbnails, cover, og.jpg),
`talks/_shared/` (theme, components, brand, reader), `talks/index.json` (every talk deployed there), `assets/fonts/`,
`css/tokens.css`. Settings: the `publish` block of `deck.json` (see the script's header; `examples/hello` has one).
Website: `--out <the site's public folder>`; the site's name, address and links: `public/reader/site.json`
(`name`, `url`, `railPrefix`, `home`, `index`, `contact`, `work`, `follow`; yours in `decks/public/reader/site.json`). Standalone: any empty folder, served at its root by any static server.
Only published files leave the deck: no briefs, notes, checks or prompts; deck files only when a slide references them;
unstyled slides are skipped. `deck:` links become links to that talk (`/talks/<slug>/#n`) when the target deck is
published and listed; to a deck with no `publish` block or with `"publish": { "listed": false }` they are removed (the
text stays). `listed: false` also keeps the talk out of `talks/index.json`. Uses the installed Chrome, Chromium or Edge (`CHROME` to override) for WebP and thumbnails.

## Layout

Tool (URL `/public/…`):
- `server.js` — static server, JSON API, live reload. `keystone.json` — the decks `node server.js` serves, with their ports.
  `public/index.html` — presenter + editor.
- `public/tokens.css` — colours and type (`--ink`, `--ink-2`, `--ink-3`, `--rule`, `--rule-2`, `--dim`, `--gray`, `--field`, `--light`, `--white`, `--red`, `--display`, `--body`, `--mono`). Published talks get a copy (`css/tokens.css`).
- `public/theme.css` — slide components (1px rules, 12px red squares, mono labels at 12px/.12em); `public/fonts/` — Poppins woff2 + `fonts.css` (SIL OFL, `OFL.txt`).
- `public/components/` — generic components (`anim.js`, `diagram.css`, `stage.js`, `uhdr.js`, `softshadow.js`, `backdrop.js`); `public/vendor/` — three.js (+ `jsm/`: GLTFLoader, post-processing for GTAO).
- `public/assets/env/` — environment maps (`studio.uhdr.jpg`, `exterior.uhdr.jpg`: Ultra HDR, ~200 KB, from the CC0 HDRIs of Poly Haven `studio_small_09` and `kloofendal_48d_partly_cloudy`), made with `uv run tools/env.py <in.exr> <out.uhdr.jpg>`; `envs.json` holds each map's orientation, exposure and sun (what `env.py` prints). `decks/public/assets/env/` can replace maps and settings.
- `public/assets/brand/` — logos used on slides (a neutral Keystone mark; yours in `decks/public/assets/brand/`). `public/styles/` — header style variants (A/B/C).
- `tools/screenshots.mjs`, `tools/cdp-check.mjs` — layout and animation checks (see below).
- `tools/meshopt.mjs` — compress GLB geometry with meshopt (gltfpack through npx), in place; run after every GLB export. `stage.js` `loadModel()` decodes it; a slide with its own `GLTFLoader` adds `.setMeshoptDecoder(MeshoptDecoder)` (`/public/vendor/jsm/libs/meshopt_decoder.module.js`) and must not overwrite a loaded mesh's own transform (put it in a group).
- `tools/asset.mjs` — copy media of another deck or of the library into a deck: `node tools/asset.mjs <file> … <deck folder>` → `<deck>/assets/media/…` (a file from another `assets/<sub>/` keeps its `<sub>`), prints the `/deck/assets/…` address. A deck holds everything its slides show: never point a slide at another deck's folder or server.
- `tools/webp.mjs` — convert a folder's PNG/JPEG images to WebP and update references; `tools/chrome.mjs` — headless Chrome (WebP encoding, screenshots) for the tools.
- `tools/ks.mjs` — the feedback language (`.ks`): its types, parser and checker; `tools/transcribe.py` — local Whisper, adds the voice to a session (see "Feedback sessions").
- `tools/deploy.mjs` — publish a deck as static files (see above). `public/reader/` — the read-only talk reader it
  publishes (`talk.html` page template, `site.json` host links: home, talk list, contact, follow). Its "⋯" menu, top
  right next to the close cross (`menu.js`), makes downloads in the reader's own browser, nothing stored on the server:
  "Download PDF" (`print.js`: every slide at rest, one 1280×720 page each, through the browser's print window, "Save as
  PDF"; the text stays text, canvases and videos become still images) and the current slide as PNG or WebP
  (`capture.js`: our own DOM → SVG `foreignObject` → canvas capture, no library; WebP only where the browser writes it).
  A WebGL canvas comes out right when it keeps its drawing buffer (`stage.js` does) or redraws on `sa:resize`.
  Every text file the deploy copies has `.png` / `.jpg` names rewritten to `.webp`: never write such a token in code
  (`t.png` became `t.webp`).
- `library/` — the style library (brand, style, layouts, components); also a deck of example slides.

Deck folder (URL `/deck/…` for its files, `/slides/<id>/…` for slide folders):
- `deck.json` — deck title (`title`, in the deck's language; `titles: { "<lang>": … }` in the others), language (`lang`: the language `slide.html` is written in, `en` by default), style guide (`style`, optional), slide order (`order`, array of slide ids), optional `publish` settings.
- `slides/<id>/brief.json` — what the user wrote in the editor: `title`, `text`, `notes`, `status` (`todo` | `done`).
- `slides/<id>/slide.html` — the styled slide (an HTML fragment, 1280×720). Missing = the brief is shown as a draft.
- `slides/<id>/reference.png` — optional original slide (e.g. Keynote), for comparison.
- `assets/` — the deck's media (`/deck/assets/…`); `components/` — the deck's own components (`/deck/components/…`).
- `server.mjs` (optional) — deck API routes: `export const routes = { "POST /api/x": async ({ req, res, url, body, json, deckDir }) => … }` (`body()` parses the JSON request, `json(code, data)` answers).
- `feedback/<YYYYMMDD-HHMMSS>/` — feedback sessions: `feedback.ks`, `voice.webm`, one picture per slide visit (not in git).
- `screenshots/` — `npm run shots` output; `.trash/` — deleted slides.

## Styling a slide

The user writes briefs in the browser editor (key `E`): title, text, speaker notes. Saving a changed title or text
sets `status: "todo"`. What the user wants from Claude comes through feedback sessions (see "Feedback sessions"): a
recording, or the editor's "Message to Claude" (a `Note` line). The old `prompt` field of the brief is gone.

1. Find work: slides whose `brief.json` has `"status": "todo"`, or that have no `slide.html`.
2. Write `slides/<id>/slide.html` from the brief's title and text, following the user's feedback on that slide. Start from the style library
   (`library/README.md`: brand rules, layouts, components, each as `.md` + `.json` with an example slide; a deck's own
   `<deck>/library/` adds to it). `node server.js library` shows the examples.
3. Set `"status": "done"` in that `brief.json`. (`slides/<id>/prompt.done.txt` = the archive of the old prompts, kept as the source of the slides made from them.)

Slide fragment conventions:
- Render target is exactly 1280×720; position with absolute coordinates or a contained grid.
- Structure (style « Rail »): every content slide = `<header class="sa-head"><img class="sa-logo" …><h1 class="sa-band">CHAPTER</h1></header>` (red rail on the left, chapter stacked upright) + `<h2 class="sa-title">Slide title</h2>` (sentence case). The deck's CLAUDE.md lists its chapters. Chapter slides are numbered covers (`.sa-section-num` + `.sa-section-title` [+ `.sa-section-sub`]).
- Text scale: title 42 (`.sa-title`), lead 26 (`.sa-lead`, top 150), body & lists 24 (`.sa-list` with `.pro` + / `.con` − / plain ■), captions 14 mono. Closing line: `.sa-takeaway` (bottom, same place everywhere). Content lives between x 73–1207 and y ≈ 150–660.
- Other components: `.sa-monogram` (`monogram.webp`; `.is-faint` for 10 %), cover (`<!-- body: sa-cover -->` on the first line), `.sa-cover-photo`, `.sa-wordmark`, `.sa-cover-title`. Content pieces: `.sa-card` (`.is-key`), `.sa-stat`, `.sa-label`, `.sa-heading` (26 / `.is-small` 22), `.sa-caption`, `.sa-source`, `.sa-procon`, `.sa-agenda`, `.sa-sources`, `.sa-closing`, `.sa-qr`, `.sa-list.is-placed` (see `library/README.md`). Don't create per-slide title/subtitle/list/card/label variants: use or extend the theme.
- Titles: sentence case, white, one or two lines; typography follows the deck's language (French: `&nbsp;` before `: ; ? !`; rules: `library/styles/rail/style.md`, `library/brand.md`). Rules are 1px.
- Palette: only the tokens of `public/tokens.css` in CSS (`var(--red)`, never `#ee342c`). Raw colours stay only where CSS variables cannot go (canvas and three.js code, SVG presentation attributes) and for data colours. Display type Poppins (titles), body Helvetica. No other colors unless the feedback asks.
- Assets: brand images `/public/assets/brand/...`, deck media `/deck/assets/...`; files placed in the slide's own folder can be referenced relatively.
- Images are WebP (never PNG or JPEG, except `*.uhdr.jpg` environments). New PNG/JPEG files: `node tools/webp.mjs <folder> …` converts them in place (lossless for diagrams and data images such as splat maps and checkers, lossy .9 for renders and photos) and rewrites every reference; `--dry` lists first.
- Phone: `.sa-phone …` rules adapt a slide for a phone screen (see "Keys of the presenter"); the slide keeps its 1280×720 layout.
- Slide-local `<style>` and `<script>` are fine. The presenter fires `sa:enter` and `sa:leave` on the slide's `window` and toggles `body.sa-active` (use them to start videos or animations).
- Slide text is in the deck's language (`lang` in `deck.json`, English by default); technical terms keep their usual English form. Translate copy written in another language (a sketch, a note).
- Keep the user's wording. Fix nothing in their text unless the feedback asks.
- Several slides on one subject: each slide is one idea and reads on its own. Its title says the idea. Do not label
  the slides as parts of a list: no "Answer 1", "Problem 2", "Part 3", "Step 2/5", "Continued" (or the same in any language) in a title or a
  lead, and no sentence that points at another slide ("comme vu avant", "la réponse au problème 2"). The order of the
  slides gives the sequence. (Items inside one slide can be numbered when their order matters.)

Generic components (`public/components/`):
- `anim.js` — entrance animations: put `data-in="<ms>"` (+ `data-anim="rise|fade|pop|draw|wipe|drop"`, `data-dur`) on elements; plays on `sa:enter`. `draw` needs an SVG path with `pathLength="1" stroke-dasharray="1"`.
- `diagram.css` — `.dg-node` (`.data` / `.prog` red / `.fixed` outlined) pipeline boxes, `.dg-svg` overlay with `.link` / `.pass` / `.route` paths, `.dg-tile`, `.dg-pass-label`, `.dg-caption`, `.dg-heading`, `.dg-screen-tri`.
- three.js: `import * as THREE from "/public/vendor/three.module.min.js"`. GLTFLoader: `/public/vendor/jsm/GLTFLoader.js`.
- `stage.js` — three.js foundation: `stage(canvas, w, h, { look, env, clear, draw })` → `{ renderer, scene, ready }` (pixel ratio and `sa:resize` handled). Looks: `unlit` (MeshBasic, exact colours: checkers, UV views), `simple` (Blinn-Phong, sky + key + rim lights), `pbr` (Ultra HDR environment `studio` | `exterior` + its sun, neutral tone mapping; the environment follows the camera's yaw and pitch, so the light stays the same relative to the view). `material(look, params)` makes a matching material from Standard-style params; `applyLook(model, look)` converts a loaded GLB; `loadModel(url)` (cached, returns a copy); `playLoop(frame)`. Draw with the returned `render(camera)`: in `pbr` it adds ambient occlusion (GTAO); `renderer.render()` still works, without AO (figures that draw several viewports by hand). `softShadow(floor, camera)` (pbr, once the scene is complete): how much of the HDRI's light reaches a floor plane (PlaneGeometry), as its aoMap — soft contact shadows, no light added. Quality is automatic: anisotropic filtering on every texture; touch devices get pixel ratio ≤ 2 and half-resolution AO, and AO pauses while a figure animates below ~45 fps (60 fps measured on an iPhone with AO and soft shadow). `uhdr.js` — Ultra HDR decoder used by it (strips the gain map's ICC profile: Safari would colour-convert it). `softshadow.js` — the soft shadow. `backdrop.js` — an opaque plane painted with a 2D canvas that fills the camera view: glass
(`MeshPhysicalMaterial` transmission) only refracts opaque objects of the scene, so its ground, grid or glow goes there
(use `ao: false`). Physical materials and glTF `KHR_materials_*`: `library/components/three/component.md`.
- `display.js` (loaded by every slide page) — canvases must render at `saPixelRatio()` (devicePixelRatio × the slide's on-screen scale; the presenter scales slides with a CSS transform, so `devicePixelRatio` alone, or a fixed 2×, is too low on a big screen) and re-size on `sa:resize`. Use the helpers: three.js `fitRenderer(renderer, w, h, redraw)` from `/public/components/canvas.js` (stage.js figures get it already); 2D `saCanvas2d(el, w, h, redraw, units)` (a global, so classic scripts can use it; modules: `canvas2d` from `canvas.js`), which draws in slide px × `units` (`units` 2 keeps code written for a fixed 2× canvas).
- The presenter keeps only slides within ±2 of the current one loaded (WebGL context limit).

## Languages

- A deck is written in one language: `lang` in `deck.json` (English by default; "+ New deck" uses the user's language, below). `slide.html` holds the only markup, styles and code, in that language. A translation into another language is `slides/<id>/slide.<lang>.json` (`tools/i18n.mjs`): `/render/<id>?lang=<lang>` builds that page from both, with `<html lang="<lang>">`; no translation = the slide in the deck's language. The deck's languages: its own first, then `languages` in `deck.json` or else every language a slide has a translation for. Deck title in another language: `titles` in `deck.json`.
- `slide.<lang>.json` = `{ "blocks": { "<innerHTML of an element in slide.html>": "<translated innerHTML>" }, "attrs": { "<alt/title/aria-label in slide.html>": "<translated>" } }`. A block is an element's whole content (a heading, paragraph, list item, label; a whole `<ul>` when the list itself changes), so bold, links and line breaks can move. Keys are copied exactly from `slide.html` and must not nest (one block per element).
- Strings written by code: `saT({ en: "Red", fr: "Rouge" })` (display.js; a missing language gets the first one); numbers: `n.toLocaleString(document.documentElement.lang)`. `saT("Rouge", "Red")` (French, English) is the older form. Components that write text can also check `document.documentElement.lang`.
- Longer text in one language that needs room: an `html[lang="<lang>"] …` CSS rule in `slide.html` (never a second copy of the slide).
- Presenter: `/?lang=<lang>`, or the language button / key `L` (the next language of the deck). The overview flags styled slides without translation as “Not translated”, and “Translation outdated” when `slide.html` was edited after translating (some blocks no longer match: those parts show in the deck's language).
- When a slide is (re)styled or its text edited, update its translations (code changes need nothing), with the typography of each language (English: no space before `? ! :`, 2,048; French: `&nbsp;` before `: ; ? !`, 2&nbsp;048).
- Check: `DECK_LANG=<lang> npm run shots [-- ids]` → `<deck>/screenshots/<lang>/`; `DECK_LANG=<lang> node tools/cdp-check.mjs …` (PowerShell: `$env:DECK_LANG="fr"; npm run shots`).
- Briefs, notes and fact checks are in the deck's language (checks are anchored on the text of `slide.html`, so their dots sit unplaced on the right in another language).
- The user's language is another setting: `userLang` in `decks/keystone.json` (else `keystone.json`; English by default). Claude's tasks, questions and spoken answers are in it, the voice is transcribed in it, and new decks are written in it.

## Fact checks

`<deck>/slides/<id>/checks.json` = `{ checkedAt, checks: [{ id, anchor, verdict: ok|nuance|faux, note, source?: {label, url?}, status: open|todo|answered, thread: [{from: user|claude, text, at}] }] }`.
Shown as dots on the slide while the editor is open (`E`); `anchor` is a verbatim piece of slide text (the dot sits at its end). Clicking a dot opens the bubble with a reply field (`POST /api/checks/:slide/:check {text}` appends to `thread` and sets `status: "todo"`).

Answering: find checks with `"status": "todo"`, append `{from: "claude", text, at}` to `thread`, set `"status": "answered"`. Change the slide or the verdict only when the reply asks for it.

## Feedback sessions (draw + talk)

The user records feedback in the presenter: key `R`, then draw on the slides, speak and change slide; `R` saves,
`Escape` twice discards, `⌘Z` takes the last stroke back. One recording is one session, whatever the number of slides
(an `Enter` line at each slide change): the user often explains one thing over several slides. A recording with no
stroke and no word is dropped. The session is one file, `<deck>/feedback/<session>/feedback.ks`, written in a small typed language. One statement per line: `Type name(arguments);`. An argument is a `"string"`, a
number, an `Enum::Value`, the name of an earlier statement, or a value `Type(arguments)`. No braces, no expressions.
`tools/ks.mjs` holds the types and the checker (`node tools/ks.mjs <file.ks>`).

```
Session session("20261012-093412");
Enter e1(Time(0), "who-am-i");
Stroke s1(Kind::Loop, Color::Red, Span(3634, 5059), Point(948, 559), Point(765, 275), Point(1009, 81), Point(921, 541));
Target t1(s1, "img.sa-intro-visual", "");
Say v1(Span(4150, 5050), Word(4150, "take"), Word(4350, "this"), Word(4550, "image"), Word(4850, "here"));
Undo u1(Time(7181), s2);
Task k1(State::Todo, "who-am-i", "Flip the photo (horizontal mirror)", s1, v1);
Reply r1(k1, "Rather a 180° rotation.");
Close c1(k1);
```

- Times are ms since the recording started; positions are slide px (1280×720). Lines are in the order things happened.
- `Enter(Time, slide id)` — the slide shown from that time. `Stroke(Kind, Color, Span, Point...)` — a stroke, reduced to
  a few points. `Target(Stroke, element, text)` — a slide element under that stroke (`tag#id.class` and the start of its
  text; none = the stroke is over an empty area). `Say(Span, Word(start, text)...)` — words said with no pause.
  `Note(text)` — a message typed in the editor ("Message to Claude") for the slide of the session: it counts like words.
  `Undo(Time, Stroke)` — the user took that stroke back. `Task(State, slide id, text, names...)` — written by Claude.
  `Reply(Task, text)` and `Close(Task)` — written by the user from the task's pin. `About(session, task)` — at the top
  of a session recorded as a follow-up on that task.
- `Kind` (`Tap`, `Line`, `Loop`, `Scribble`, `Free`) is a hint from the stroke's geometry. The points are the truth.
- Pictures `<n>-<slide>.png` (n = the nth `Enter`): the slide as it was when the session was saved, with the strokes
  of that visit, each named and coloured. Read handwriting and sketches from the picture, not from the points.
  The picture shows the slide's resting state (not a build step or a moved 3D camera).

Handling feedback:

1. Find work: sessions whose `feedback.ks` has no `Task` and no `About` line (new), or has `State::Todo` tasks.
   Never take a `State::Stopped` task: the user interrupted it.
2. Read the file and its pictures. Match words and strokes by time: "this", "here", "that image" point at the stroke
   drawn while they were said (the voice starts 0.2 to 0.5 s after its stroke). `Target` says what a stroke is on.
3. Append one `Task` per request at the end of the file, then do them: `State::Todo` → `State::Doing` → `State::Done`.
   The task text is in the user's language (`userLang`) and says what will be done. Unclear or two possible meanings: `State::Ask` with the
   question as text, and do not change the slide. Run `node tools/ks.mjs <file>` after every edit of the file.
   The presenter's panel (key `T`) shows the tasks live, in three groups: questions for the user (`State::Ask`),
   in progress (`Doing`, `Todo`), done (folded). One row per task: keep the task text short and start it with the
   action, the row shows two lines of it. The user clears a task with its × (`Close`), or all done tasks at once.
4. Update the slide's translations (`slide.<lang>.json`) when the text of `slide.html` changed. Screenshots: in a terminal session, check the layout as "Checking
   layout" says. In a run started by the server ("Claude with no terminal"), take none for a first change: it is slow,
   so the user looks at the slide and comes back when something is wrong (a `Reply` or a follow-up). Then, for that
   task, take the screenshot, look at it and fix. Do not tell the user that no screenshot was taken: it is the rule,
   not news.

DSL view (key `D`): the presenter shows the language as it is written, with each type's signature before its first
use: live while recording (the part in progress, line by line), then the saved file with the `Say` lines, then the
`Task` lines as Claude writes them. Not recording, it shows the session of the open pin, else the last recording.

New slides. Two ways, both through feedback:
- The user adds a slide while recording (key `N`, or the editor's "+ Slide after") and speaks on it: the session is on
  a slide "not styled yet" whose brief title is still "New slide". Write its `brief.json` from what was said (`title`,
  `text`: the user's words, tidied; `status: "done"`), then write its `slide.html`.
- The user asks for one ("add a slide after this one that…"): create `slides/<id>/` (id: a short lowercase slug not
  used yet) with `brief.json` (`title`, `text`, `notes: ""`, `status: "done"`) and `slide.html`, and put the id in the
  `order` of the deck's `deck.json`, right after the slide the user was on unless they say where. The Task's slide id
  is the new slide, so its pin is there.
A slide with 3D is a task for the strong pass; any other slide, for the fast one.
When the user asks for several slides at once ("make me five or six slides that explain…"), each part of the
subject is one slide with its own title, with no numbering of the parts (see "Slide fragment conventions").

Pins: while the panel is open (and while recording), each task is a pin on its slide, at the centre of the strokes it
names (so name the strokes and phrases a task comes from; no stroke = a pin on the top edge). A `State::Ask` task is
a "?" pin. Its card shows the task,
what was heard, and draws the strokes again. From the card the user:
- removes the pin: `Close`. A closed task that is not `Done` must not be done.
- comes back to it, with a typed `Reply` or a follow-up recording (a new session that starts with `About`). Both set
  the task back to `State::Todo`: do it again with the replies and with every session that is `About` it, then
  `State::Done`. A follow-up session gets `Task` lines of its own only for requests that are new.

Reading rules:
- A session can go over several slides. Read all of it before writing tasks: the user keeps talking while changing
  slide, so a request can be about several slides, or about the slide shown just before or just after the words (the
  `Enter` times say which slide was on screen, not always which slide the words are about). One task per request,
  on the slide it changes; a request for several slides gets one task per slide.
- An `Undo` stroke does not count. Words such as "no wait", "I got it wrong", "forget that" cancel what was said or
  drawn just before. A `Kind::Scribble` over an earlier stroke cancels that stroke; over a slide element it usually
  means "remove this" (the words decide).
- Whisper invents words on noises with no speech ("Thanks for watching!", in French "Sous-titrage ST' 501"): ignore them.
  A word that looks wrong is often a technical term misheard ("nanny" = Nanite).

Claude with no terminal: the panel has a switch, "Claude auto" (off by default, kept per deck in
`feedback/claude.json`). On, the server starts Claude Code itself (`claude -p`, from the Keystone root) when a part is
saved or the user replies on a pin, one run at a time, in two levels:
- the fast pass (Sonnet, effort medium) does nearly everything: it writes the tasks and does them (text, style,
  layout, new slides, diagrams, 2D animations), also the tasks the user comes back to (a `Reply` or a follow-up
  recording). It leaves two kinds of task in `State::Todo`, with a text that says exactly what to do;
- the strong pass (Opus) follows at once on those: 3D work (three.js, WebGL, a shader, a 3D scene on a canvas), and a
  task the user came back to twice or more (the fast pass did not get it right).
All runs of a deck share one Claude session: a run within 60 min of the last one resumes it (`--resume`, with either
model), so Claude remembers the work in progress; later, or when the session holds more than 90,000 tokens (a big
session makes every run slow), a new session starts with no memory of the earlier work. When a recording starts, a short run
makes Claude read the slide on screen, so it is ready when the first part arrives. That Claude can edit files and run
only read-only commands, `node tools/ks.mjs`, `node tools/asset.mjs`, `npm run shots` and `node tools/cdp-check.mjs`
(no user is there to approve anything else). `claude.json` holds the session id (open it in a terminal with `claude --resume <id>`) and
Claude's last sentence, shown in the panel.
Codex instead of Claude: `"agent": "codex"` in the deck's `feedback/claude.json` (`codex` on the `PATH`, signed in).
The server then runs `codex exec --json` in the deck folder, with the same prompt, steps and review: both passes use
the model of your Codex config, the fast one with reasoning `medium`, the strong one `high`. Its sandbox lets it write
in the deck folder (and the temporary folder) only, with the network open so that `npm run shots` reaches the
server. A run within 60 min of the last one resumes its session (`codex exec resume`; Codex compacts a long session
by itself); `claude.json` holds that session id (`codex resume <id>` in a terminal).
The presenter shows what happens now in its bottom left corner, with Clawd playing the stage: `listening` (the user
records), `transcribing` (the save), then Claude's run: `reading`, `looking` (a picture), `tasks` (it edits the session
file), `working` (it edits a slide), `checking` (screenshots), and `done`, `ask` (a `State::Ask` task) or `error` at the
end. The server reads the run as a stream of events and pushes each step (stage + one line: the file read or edited, a
command's description) to the open pages. Animations: `public/assets/clawd/<stage>.gif`, fan-made GIFs from the
clawd-on-desk project (github.com/rullerzhou-afk/clawd-on-desk; its images are not under the code's licence, and the
Clawd character belongs to Anthropic). They are for this local tool only: not in git (`.gitignore`), never copied
into a published talk. Without them the presenter shows a plain pixel mascot.
Where Claude works: the slide whose files it reads or edits has an orange frame on the stage, its thumbnail is
marked in the overview, and the popup has a button to go there.
Review: the server remembers the text files of the slides of each run (and `deck.json`) before the run. When a run
ends with changes, a dialog opens (not while recording; also "Review" in the popup and the panel): the changed
slides in a list, each slide in one large view that shows it as it is now or as it was (one toggle, or Space;
`/render/<id>?before=1` renders it as it was), then the changed lines of each file. "Later" keeps the review, "Done" ends it: the next review starts from then
(`GET` and `DELETE /api/claude/review`). The texts "before" are kept in `feedback/review.json`: the review survives a
restart of the server.
Stop (in the popup while a run is in progress, and in the panel): the server kills the run. Every task in progress
or to do becomes `State::Stopped` and a session not read yet gets a stopped task, so nothing starts again by itself;
what was already changed in the files stays. A stopped task starts again only when the user comes back to it.
The popup shows the lines the run added and removed in the deck's files (+ −, counted from its edits; the session
files do not count). Its ▴ opens the run in detail (the panel's "Log" opens the last run again): per file, then what
Claude says between its steps, each step, and how much it thinks (the stream gives a count of tokens, never the
thoughts). In the strong pass, write one short sentence to the user before each step: that is what the detail shows.
The panel's "Voice" switch makes Claude say aloud the sentences that end a run and each new question, never while
the user records (the microphone would hear it). The presenter open on the computer that serves it: that computer
speaks with its system voice (`POST /api/say {text}` or `{stop: true}`). A Mac: `say` (System Settings › Accessibility ›
Spoken Content chooses it, a Siri voice works). Windows: PowerShell and System.Speech, with a voice of the user's language
(Settings › Time & language › Speech; none: the browser speaks). Linux: the browser speaks. The server tells the pages when the voice starts, with its length, and when it
stops: the popup's bar shrinks with the voice and the popup leaves when Claude has finished speaking (voice off: after
12 s). Open from another device: the browser speaks, with a voice of the user's language on that device. So end
a run with one or two short sentences to the user, in plain spoken words of the user's language: no code, no file name.
Speed: a step of a run takes 1 to 2 s, so the server puts all the pending feedback in the prompt (session files,
picture paths, slide files) with a four-step procedure, starts no run when nothing is pending, and loads no connector
(MCP). The pictures are taken while the voice is transcribed. Thinking is the longest and least steady part of a
run: the models and the effort of the two levels are `FAST` and `STRONG` in `server.js`.

How it works: `POST /api/feedback {events, audio}` writes the session and runs `uv run tools/transcribe.py` (in the user's language, `userLang`)
(`large-v3-turbo` on this computer: mlx-whisper on a Mac with Apple silicon, faster-whisper elsewhere, on an NVIDIA GPU
when `nvidia-smi` is found (the server adds the CUDA libraries to uv), else on the CPU; the brief of the slide on screen is its vocabulary; the sound level
drops words invented over silence and puts each word where its sound is). `/render/<id>?feedback=<session>&visit=<n>`
draws a visit's strokes over the slide (the pictures come from it, through headless Chrome).

## Checking layout

(Not in a run started by the server for a feedback: see "Handling feedback", step 4.)
After any slide change, with the server running on the deck, run `npm run shots` (or `npm run shots -- <id> …`; `PORT=<deck port>` when several decks are served) from this folder and look at `<deck>/screenshots/NN-id.png` (the script asks the server which deck it serves). It captures each slide's resting (final) state at 1280×720. Watch for text overlapping other elements, lists breaking apart, and large empty areas.

To test builds and animations for real (real time, real arrow keys in the presenter): `node tools/cdp-check.mjs <slideNumber> "wait:1000,shot:a,key:ArrowRight,wait:1500,shot:b" /tmp/out` → `/tmp/out-a.png`, `/tmp/out-b.png`. Headless `--screenshot` does not run timers or animations reliably.

## API (used by the editor)

- `GET /api/deck` · `GET /api/info` (served deck's name and folder) · `GET /api/decks` (decks of this server, ports) · `POST /api/decks {title}` (a new deck) · `POST /api/slides {after, brief}` · `PUT /api/slides/:id {title,text,notes}` · `DELETE /api/slides/:id` (moves to `.trash/`) · `PUT /api/order {order}` · plus the deck's `server.mjs` routes.
- `GET /api/ks` (the feedback language's types) · `GET /api/feedback` (sessions: phrases and tasks) · `POST /api/feedback {events, audio, mime, about?}` · `PUT /api/feedback/:session/say/:name {text}` · `POST /api/feedback/:session/task/:name {close: true}` or `{reply}` · `PUT /api/claude {auto}` · `POST /api/claude/warm {slide}` · `POST /api/claude/stop`.
- `GET /render/:id` renders one slide as a full document.

## Licence

Apache License 2.0 (`LICENSE`): use, copy, change and sell Keystone and works based on it; keep the `NOTICE` file
with them (it credits SASU Sentient Art). Third-party files keep their own licences (`THIRD_PARTY.md`): three.js and
meshoptimizer (MIT), Poppins (SIL OFL 1.1), the Poly Haven environments (CC0). The Clawd animations the presenter can
show are not part of Keystone (`public/assets/clawd/`, not in git).
