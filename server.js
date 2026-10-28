// Copyright 2026 SASU Sentient Art
// SPDX-License-Identifier: Apache-2.0
// Keystone: local presentation server. No dependencies: node server.js [deck folder]
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import fs from "node:fs/promises";
import { watch, existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTranslation, translate } from "./tools/i18n.mjs";
import { parse, ENUMS, STATEMENTS, VALUES } from "./tools/ks.mjs";
import { launchChrome } from "./tools/chrome.mjs";

// The tool (this server, public/) is shared by every deck. Decks are folders anywhere on disk:
//   node server.js <deck folder>   one deck on PORT (or DECK=<deck folder>; or the current folder if it holds a deck.json)
//   node server.js                 every deck of keystone.json, each on its own port: { "decks": [{ "dir", "port" }] }
// decks/ is your own space, outside the Keystone repo (.gitignore): your decks, listed in decks/keystone.json (same format,
// dirs relative to decks/, added to those of keystone.json), and decks/public/, whose files replace those of public/
// (your logos, the reader's site.json…). A deck's own public/ (<deck>/public/) comes first: its brand, for that deck only.
// A deck's URLs are the same whatever its port: one port per deck keeps /deck/, /slides/ and /api/ unchanged.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const LIST = path.join(ROOT, "keystone.json");
const DECKS = path.join(ROOT, "decks");
const OWN_LIST = path.join(DECKS, "keystone.json");
const OVERLAY = path.join(DECKS, "public");
// Languages. A deck's slides are written in its "lang" (deck.json; English by default) and translated into others
// (slides/<id>/slide.<lang>.json, tools/i18n.mjs). The user's language is another setting: Claude's tasks and spoken
// answers, the voice transcription, the language of new decks. "userLang" in decks/keystone.json, else in
// keystone.json; English by default.
const settings = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const USER_LANG = settings(OWN_LIST).userLang || settings(LIST).userLang || "en";
const langName = code => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code); } catch { return code; } };
const LANG_CODE = /^[a-z]{2}$/;
const viewLang = url => { const l = url.searchParams.get("lang"); return LANG_CODE.test(l || "") ? l : null; };   // ?lang=<code>
// A deck's title in a language: "title" is in the deck's own language, "titles" holds the others ("titleEn": older decks)
const titleIn = (deck, lang) => !lang || lang === (deck.lang || "en") ? deck.title : deck.titles?.[lang] || (lang === "en" && deck.titleEn) || deck.title;
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || "127.0.0.1";   // e.g. a Tailscale address, to open the deck on a phone

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff2": "font/woff2", ".woff": "font/woff", ".mjs": "text/javascript; charset=utf-8", ".glb": "model/gltf-binary",
};

// Tools started by the server (uv for Whisper, claude): the server may be started from an app with a short PATH
const WIN = process.platform === "win32";
const PATH_KEY = Object.keys(process.env).find(k => k.toUpperCase() === "PATH") || "PATH";   // "Path" on Windows
const TOOL_ENV = { ...process.env, [PATH_KEY]: [process.env[PATH_KEY], ...(WIN ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
  path.join(os.homedir(), ".local", "bin")].join(path.delimiter) };
// How to start a command of that PATH. On Windows: its .exe, or its .cmd (what npm installs), which only runs through
// cmd.exe, so its arguments are quoted here (Node joins them as they are when it uses a shell).
function tool(name) {
  if (WIN) for (const dir of TOOL_ENV[PATH_KEY].split(path.delimiter)) for (const ext of [".exe", ".cmd"]) {
    const file = path.join(dir, name + ext);
    if (!existsSync(file)) continue;
    if (ext === ".exe") return { file, args: a => a, shell: false };
    const quote = a => /^[\w.\/:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
    return { file: `"${file}"`, args: a => a.map(quote), shell: true };
  }
  return { file: name, args: a => a, shell: false };
}
const onPath = name => TOOL_ENV[PATH_KEY].split(path.delimiter).some(d => existsSync(path.join(d, name + (WIN ? ".exe" : ""))));
// Whisper on an NVIDIA GPU (faster-whisper, not on a Mac): it needs the CUDA 12 libraries, which uv adds (about 1 GB, once)
const CUDA = process.platform !== "darwin" && onPath("nvidia-smi") ? ["--with", "nvidia-cublas-cu12", "--with", "nvidia-cudnn-cu12"] : [];
// Claude runs with no connector (mail, chat…): it starts faster and has no use for them
const NO_MCP = path.join(os.tmpdir(), "keystone-no-mcp.json");
// Claude works on one feedback at a time for the whole server
let claudeQueue = Promise.resolve();
const CLAUDE_TTL = 60 * 60e3;   // a feedback within this time of the last one goes to the same Claude session…
// …while that session is small. Measured: a session used for 80 min had grown to 230,000 tokens, and each Opus run
// then waited 17 to 28 s before its first action (2 s in a new session, which starts at about 33,000 tokens).
const CLAUDE_CTX = 90_000;

// Claude's voice, said by this computer with its system voice. A Mac: `say` with no voice named, so the voice chosen
// in System Settings › Accessibility › Spoken Content is used (a Siri voice too, which no browser can use). Windows:
// the default voice of Settings › Time & language › Speech, through PowerShell (System.Speech). Elsewhere the
// presenter uses the browser's voices. One sentence at a time. The sentence is first written to a sound file, so its
// length is known before it is played: `tell` gets { start, ms } when the sound starts and { end, more } when it stops
// (the presenter's popup follows the voice).
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
// Windows: only with a voice of the user's language installed (Settings › Time & language › Speech, or a language
// pack: "Microsoft Hortense Desktop" for French…). None: the browser speaks. Looked up once.
const WIN_VOICE = !WIN ? Promise.resolve("") : new Promise(done => execFile("powershell.exe", [...PS,
  `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like '${USER_LANG}*' } | ForEach-Object { $_.VoiceInfo.Name } | Select-Object -First 1`],
  { windowsHide: true }, (err, out) => done(err ? "" : String(out).trim())));
const speaks = async () => process.platform === "darwin" || !!(await WIN_VOICE);
const wavMs = file => {   // length of a PCM .wav: its "data" chunk / bytes per second
  const b = readFileSync(file), rate = b.readUInt32LE(28);
  for (let i = 12; i + 8 <= b.length; i += 8 + b.readUInt32LE(i + 4)) if (b.toString("ascii", i, i + 4) === "data") return Math.round(1000 * b.readUInt32LE(i + 4) / rate);
  return 0;
};
let sayQueue = Promise.resolve(), sayChild = null, sayRound = 0, sayWaiting = 0;
function sayText(text, tell = () => {}) {
  const round = sayRound, base = path.join(os.tmpdir(), `keystone-say-${process.pid}-${Date.now()}`), file = base + (WIN ? ".wav" : ".aiff");
  const run = (command, args, input) => new Promise(done => {
    sayChild = spawn(command, args, { stdio: [input == null ? "ignore" : "pipe", "pipe", "ignore"], windowsHide: true });
    let out = ""; sayChild.stdout.on("data", chunk => out += chunk);
    sayChild.on("close", () => done(out)); sayChild.on("error", () => done(""));
    if (input != null) { sayChild.stdin.on("error", () => {}); sayChild.stdin.end(input); }   // the text goes through stdin: it is never read as an option
  });
  sayWaiting++;
  sayQueue = sayQueue.then(async () => {
    try {
      let ms = 0;
      if (WIN) {   // the text goes through a UTF-8 file: PowerShell 5 reads stdin in the console's code page
        writeFileSync(base + ".txt", text);
        const voice = (await WIN_VOICE).replace(/'/g, "''");
        if (round === sayRound) await run("powershell.exe", [...PS, `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $s.SetOutputToWaveFile('${file}'); $s.Speak((Get-Content -Raw -Encoding UTF8 '${base}.txt')); $s.Dispose()`]);
        ms = round === sayRound && existsSync(file) ? wavMs(file) : 0;
        if (ms && round === sayRound) { tell({ start: true, ms: ms + 500 }); await run("powershell.exe", [...PS, `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`]); }
      } else {
        if (round === sayRound) await run("say", ["-o", file], text);
        ms = round === sayRound ? Math.round(1000 * Number((await run("afinfo", [file])).match(/estimated duration: ([\d.]+)/)?.[1] || 0)) : 0;
        if (ms && round === sayRound) { tell({ start: true, ms: ms + 500 }); await run("afplay", [file]); }   // + 500: the player takes about that long to start and to stop (measured: 4.9 s for 4.1 s of sound)
      }
    } finally { sayWaiting--; tell({ end: true, more: sayWaiting > 0 }); for (const f of [file, base + ".txt"]) fs.rm(f, { force: true }).catch(() => {}); }
  });
}
function sayStop() { sayRound++; sayChild?.kill(); }

// Lines added and removed between two texts (what a diff shows as + and −)
function lineDiff(before, after) {
  const x = before ? before.split("\n") : [], y = after ? after.split("\n") : [];
  let s = 0, e = 0;   // the same lines at both ends are left out
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const p = x.slice(s, x.length - e), q = y.slice(s, y.length - e);
  if (p.length * q.length > 4e6) return [q.length, p.length];
  const row = new Array(q.length + 1).fill(0);   // longest common subsequence of the lines in between
  for (const line of p) for (let j = 1, diag = 0; j <= q.length; j++) { const up = row[j]; row[j] = line === q[j - 1] ? diag + 1 : Math.max(up, row[j - 1]); diag = up; }
  return [q.length - row[q.length], p.length - row[q.length]];
}

// The style guides: library/styles/<id>/ (style.json: id, default, css; style.md: its rules, "# Style: Name" then a
// paragraph that says what it looks like). A deck names its guide in deck.json ("style"); none = the default one.
const STYLES = path.join(ROOT, "library", "styles");
async function styleGuides() {
  const out = [];
  for (const id of (await fs.readdir(STYLES).catch(() => [])).sort()) {
    const info = await readJSON(path.join(STYLES, id, "style.json"), null); if (!info) continue;
    const md = await fs.readFile(path.join(STYLES, id, "style.md"), "utf8").catch(() => "");
    out.push({ id, default: !!info.default, css: info.css || "/public/theme.css", media: info.media || [], name: md.match(/^# Style: (.+?)(?: \(default\))?$/m)?.[1] || id,
      about: (md.split("\n\n")[1] || "").replace(/\s+/g, " ").replace(/`/g, "").split(/(?<=\.) /)[0] });
  }
  return out.sort((a, b) => b.default - a.default);
}

// The changed lines between two texts, with two lines around each change: { add, del, hunks: [[" " | "+" | "-" | "…", line]] }
function diffLines(before, after) {
  const x = before ? before.split("\n") : [], y = after ? after.split("\n") : [];
  let s = 0, e = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const p = x.slice(s, x.length - e), q = y.slice(s, y.length - e), ops = [];
  if (p.length * q.length > 3e6) ops.push(...p.map(l => ["-", l]), ...q.map(l => ["+", l]));
  else {
    const w = q.length + 1, t = new Uint32Array((p.length + 1) * w);   // longest common subsequence of what is left of p and q
    for (let i = p.length - 1; i >= 0; i--) for (let j = q.length - 1; j >= 0; j--) t[i * w + j] = p[i] === q[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    for (let i = 0, j = 0; i < p.length || j < q.length;) {
      if (i < p.length && j < q.length && p[i] === q[j]) { ops.push([" ", p[i]]); i++; j++; }
      else if (i < p.length && (j === q.length || t[(i + 1) * w + j] >= t[i * w + j + 1])) ops.push(["-", p[i++]]);
      else ops.push(["+", q[j++]]);
    }
  }
  const all = [...x.slice(0, s).map(l => [" ", l]), ...ops, ...x.slice(x.length - e).map(l => [" ", l])], near = new Uint8Array(all.length), hunks = [];
  all.forEach((o, k) => { if (o[0] !== " ") for (let m = Math.max(0, k - 2); m <= Math.min(all.length - 1, k + 2); m++) near[m] = 1; });
  let add = 0, del = 0;
  all.forEach((o, k) => { if (o[0] === "+") add++; if (o[0] === "-") del++; if (near[k]) hunks.push([o[0], o[1].slice(0, 400)]); else if (hunks.at(-1)?.[0] !== "…") hunks.push(["…", ""]); });
  return { add, del, hunks: hunks.slice(0, 800) };
}

const readJSON = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } };
const writeJSON = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const validId = id => /^[a-z0-9][a-z0-9-]*$/.test(id);

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const json = (res, code, data) => { res.writeHead(code, { "content-type": TYPES[".json"] }); res.end(JSON.stringify(data)); };

// Files are cached by the browser and revalidated on every use (ETag from size and modification time): each slide is
// its own page, so without this every slide downloads three.js, the fonts and the theme again. An edited file gets a
// new ETag, so live reload still shows it at once.
// Text and model files are sent gzipped when the browser accepts it (three.js 692 → 172 kB: it counts on mobile data);
// each one is compressed once per version and kept in memory. Images and fonts are already compressed.
const GZIP = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".glb", ".bin"]);
const gzipped = new Map();   // file → { etag, data }
async function gzipOnce(file, etag) {
  const hit = gzipped.get(file);
  if (hit?.etag === etag) return hit.data;
  const data = zlib.gzipSync(await fs.readFile(file), { level: 6 });
  gzipped.set(file, { etag, data });
  return data;
}

async function serveFile(req, res, file, base) {
  if (!file.startsWith(base + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const ext = path.extname(file).toLowerCase();
    const head = { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-cache", etag, vary: "accept-encoding", "accept-ranges": "bytes" };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, head); return res.end(); }
    // Byte ranges: Safari (iPhone, iPad, Mac) plays a video only when the server answers them
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && (r[1] || r[2])) {
      const start = r[1] ? Number(r[1]) : Math.max(0, st.size - Number(r[2])), end = r[1] && r[2] ? Math.min(Number(r[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    if (GZIP.has(ext) && st.size > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      const data = await gzipOnce(file, etag);
      res.writeHead(200, { ...head, "content-encoding": "gzip", "content-length": data.length });
      return res.end(data);
    }
    res.writeHead(200, head);
    res.end(await fs.readFile(file));
  } catch { json(res, 404, { error: "not found" }); }
}

// One deck: its own handler, live reload and port.
async function serveDeck(DECK_DIR, port) {
  const DECK_NAME = path.basename(DECK_DIR);
  const SLIDES = path.join(DECK_DIR, "slides");
  const DECK = path.join(DECK_DIR, "deck.json");
  // /public/<file>: the deck's own brand (<deck>/public/), else decks/public/, else the tool's
  const LAYERS = [path.join(DECK_DIR, "public"), OVERLAY, PUBLIC];
  const layer = rel => LAYERS.find(d => existsSync(path.join(d, rel))) || PUBLIC;
  // Optional deck routes: <deck>/server.mjs exports `routes` = { "POST /api/…": async ({ req, res, url, body, json, deckDir }) => … }
  const DECK_ROUTES = existsSync(path.join(DECK_DIR, "server.mjs"))
    ? (await import(pathToFileURL(path.join(DECK_DIR, "server.mjs")))).routes || {} : {};

  // The deck's languages: its own ("lang", English by default) first, then deck.json "languages" or else every
  // language a slide has a translation for (slides/<id>/slide.<lang>.json).
  async function deckLangs(deck) {
    const source = deck.lang || "en", found = new Set(deck.languages || []);
    if (!deck.languages) for (const id of deck.order || []) for (const f of await fs.readdir(path.join(SLIDES, id)).catch(() => [])) {
      const m = f.match(/^slide\.([a-z]{2})\.json$/); if (m) found.add(m[1]);
    }
    found.delete(source);
    return { source, languages: [source, ...[...found].sort()] };
  }
  // The deck seen in one of its languages (?lang=<code>; none: its own). In another language a slide is rendered from
  // slide.html + its translation: translated = it has one; outdated = some of it no longer matches slide.html (edited since).
  async function loadDeck(view) {
    const deck = await readJSON(DECK, { title: "Presentation", order: [] }), { source, languages } = await deckLangs(deck);
    const lang = languages.includes(view) ? view : source;
    const slides = await Promise.all(deck.order.map(async id => {
      const dir = path.join(SLIDES, id);
      const brief = await readJSON(path.join(dir, "brief.json"), {});
      const { checks = [] } = await readJSON(path.join(dir, "checks.json"), {});
      const styled = existsSync(path.join(dir, "slide.html")), tr = lang !== source ? readTranslation(dir, lang) : null;
      const outdated = !!(styled && tr && translate(await fs.readFile(path.join(dir, "slide.html"), "utf8"), tr).missing.length);
      return { id, brief, checks, styled, translated: lang === source || !!tr, outdated, reference: existsSync(path.join(dir, "reference.png")) };
    }));
    return { title: titleIn(deck, lang), lang, source, languages, userLang: USER_LANG, slides };
  }

  function slugify(s) {
    const base = String(s || "slide").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "slide";
    let id = base, n = 2;
    while (existsSync(path.join(SLIDES, id))) id = `${base}-${n++}`;
    return id;
  }

  // Every slide renders as a full 1280x720 document inside an iframe.
  function page(id, body, extraHead = "", style = "", lang = "en") {
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
  <base href="/slides/${id}/">
  <meta name="viewport" content="width=1280">
  <link rel="stylesheet" href="/public/theme.css"><script src="/public/components/display.js"></script>${style ? `<link rel="stylesheet" href="/public/styles/${style}.css">` : ""}${extraHead}
  </head><body class="sa-slide">${body}</body></html>`;
  }

  // The stylesheet of the deck's style guide, when it is not the default theme
  async function styleHead() {
    const id = (await readJSON(DECK, {})).style, guide = id && (await styleGuides()).find(g => g.id === id);   // read at each render: the style can change
    return guide && guide.css !== "/public/theme.css" ? `<link rel="stylesheet" href="${esc(guide.css)}">` : "";
  }
  async function renderSlide(id, style = "", view = null, was) {   // was: the slide.html to show instead of the file (null: there was none)
    const head = await styleHead();
    const dir = path.join(SLIDES, id);
    const brief = await readJSON(path.join(dir, "brief.json"), {});
    const source = (await readJSON(DECK, {})).lang || "en";
    let lang = view || source;
    try {
      const tr = lang !== source ? readTranslation(dir, lang) : null;
      if (!tr) lang = source;   // not translated: the slide in its own language
      if (was === null) throw new Error("no slide then");
      let html = translate(was ?? await fs.readFile(path.join(dir, "slide.html"), "utf8"), tr).html;
      // Optional first line "<!-- body: sa-cover -->" adds classes to <body>
      const m = html.match(/^\s*<!--\s*body:\s*([\w\s-]+?)\s*-->/);
      return page(id, html, head, style, lang).replace('<body class="sa-slide">', `<body class="sa-slide${m ? " " + m[1] : ""}">`);
    } catch {
      // Not styled yet: show the raw brief so the deck is always presentable
      const ref = existsSync(path.join(dir, "reference.png"));
      return page(id, `
  <div class="sa-draft">
    <header class="sa-head"><img class="sa-logo" src="/public/assets/brand/sa-monogram-white.svg" alt=""><h1 class="sa-band">${esc(brief.title || "Untitled")}</h1></header>
    <div class="sa-draft-body ${ref ? "has-ref" : ""}">
      <div class="sa-draft-text">${esc(brief.text)}</div>
      ${ref ? `<figure class="sa-draft-ref"><img src="reference.png" alt=""><figcaption>Keynote reference</figcaption></figure>` : ""}
    </div>
    <span class="sa-draft-flag">Draft · to style</span>
  </div>`, head, style, source);
    }
  }

  // Feedback sessions: <deck>/feedback/<YYYYMMDD-HHMMSS>/feedback.ks (tools/ks.mjs is the language), voice.webm, and
  // one picture per slide visit that has strokes. Recorded in the presenter (key R); Claude adds the Task lines.
  const FEEDBACK = path.join(DECK_DIR, "feedback");
  const validSession = id => /^\d{8}-\d{6}$/.test(id);
  const readSession = async id => parse(await fs.readFile(path.join(FEEDBACK, id, "feedback.ks"), "utf8"));
  // Strokes of each slide visit (one visit per Enter line), without the ones the user took back
  function visits(statements) {
    const undone = new Set(statements.filter(s => s.type === "Undo").map(s => s.v[1])), out = [];
    for (const s of statements) {
      if (s.type === "Enter") out.push({ n: out.length + 1, slide: s.v[1], strokes: [] });
      if (s.type === "Stroke" && out.length && !undone.has(s.name)) out.at(-1).strokes.push(s);
    }
    return out;
  }

  // Claude without a terminal. With "auto" on (the panel's switch, kept in feedback/claude.json), a saved session or
  // a reply on a pin starts Claude Code here (claude -p): it handles the pending feedback as AGENTS.md says, and the
  // user follows the Task lines in the panel. The first run starts a Claude session, the next ones resume it
  // (--resume), so Claude remembers what it just did; after CLAUDE_TTL with no run a new session starts.
  // No user answers its permission prompts: it may edit files and run only the commands listed below.
  const CLAUDE_FILE = path.join(FEEDBACK, "claude.json");
  const CLAUDE_TOOLS = ["Bash(node tools/ks.mjs:*)", "Bash(node tools/asset.mjs:*)", "Bash(npm run shots:*)", "Bash(node tools/cdp-check.mjs:*)"];
  const claudeTools = async () => [...CLAUDE_TOOLS, ...(await deckLangs(await readJSON(DECK, {}))).languages.slice(1)   // and in each other language of the deck
    .flatMap(l => [`Bash(DECK_LANG=${l} npm run shots:*)`, `Bash(DECK_LANG=${l} node tools/cdp-check.mjs:*)`])];
  let claudeRunning = null, claudeWaiting = false, claudeStep = "", claudeStage = "", claudeModel = "";   // start time of the run in progress; a run is queued; what Claude does now, and which model
  const claudeState = async () => ({ auto: false, ...await readJSON(CLAUDE_FILE, {}), running: claudeRunning, queued: claudeWaiting, step: claudeStep, stage: claudeStage, model: claudeModel, slide: claudeSlide, changed: claudeChanged, log: claudeLog, diff: claudeDiffState() });
  // What Claude does now goes straight to the open pages (the presenter shows it next to its mascot)
  let claudePushed = 0;
  async function pushClaude() {
    claudePushed = Date.now();
    const data = `data: ${JSON.stringify({ claude: await claudeState() })}\n\n`;
    for (const res of clients) res.write(data);
  }
  // The log of the run in progress (kept until the next one), for the presenter's detail view: what Claude says
  // between its steps, each step, how much it thinks (its thoughts themselves are not in the stream: only a count
  // of tokens), and the lines it adds and removes in the deck's files (not in the session files).
  let claudeLog = [], claudeDiff = new Map();   // [{ t: ms since the run started, kind: pass | say | step | think, text }]; file → [added, removed]
  const claudeLogged = (kind, text) => { claudeLog.push({ t: Date.now() - (claudeRunning || Date.now()), kind, text: String(text).slice(0, 500) }); if (claudeLog.length > 150) claudeLog.shift(); };
  function claudeNote(ev) {   // → true when the pages must be told now
    if (ev.type === "system" && ev.subtype === "thinking_tokens") {
      const last = claudeLog.at(-1), text = `Thinking (about ${ev.estimated_tokens} tokens)`;
      if (last?.kind === "think") last.text = text; else claudeLogged("think", text);
      return Date.now() - claudePushed > 700;
    }
    if (ev.type !== "assistant") return false;
    let told = false;
    for (const b of ev.message?.content || []) {
      if (b.type === "text" && b.text.trim()) { claudeLogged("say", b.text.trim()); told = true; }
      if (b.type !== "tool_use") continue;
      claudeLogged("step", claudeStepOf({ type: "assistant", message: { content: [b] } })[0]); told = true;
      const i = b.input || {}, file = i.file_path && path.resolve(ROOT, i.file_path);
      // The slide Claude is on: the one whose file it reads or edits, or that it shoots
      const on = file?.startsWith(SLIDES + path.sep) ? path.relative(SLIDES, file).split(path.sep)[0] : String(i.command || "").match(/shots -- ([a-z0-9-]+)/)?.[1];
      if (on && existsSync(path.join(SLIDES, on))) claudeSlide = on;
      if (!file || file.startsWith(FEEDBACK + path.sep) || !/^(Edit|Write)$/.test(b.name)) continue;
      if (reviewed(file) && !reviewBefore.has(file)) try { reviewBefore.set(file, existsSync(file) ? readFileSync(file, "utf8") : null); } catch {}   // a file outside the run's slides: as it is now, just before the change
      let was = ""; if (b.name === "Write") try { was = readFileSync(file, "utf8"); } catch {}   // the tool has not run yet: this is the file before
      const [add, del] = b.name === "Edit" ? lineDiff(String(i.old_string ?? ""), String(i.new_string ?? "")) : lineDiff(was, String(i.content ?? ""));
      const sum = claudeDiff.get(file) || [0, 0];
      claudeDiff.set(file, [sum[0] + add, sum[1] + del]);
    }
    return told;
  }
  // The review: what Claude changed in the deck since the user last looked. The text files of the slides a run is
  // about (and deck.json) are remembered before the run; any other file, when Claude first changes it. The review
  // compares them with the files as they are now, slide by slide, and lasts until the user closes it ("Done").
  // It is kept in feedback/review.json (paths from the deck folder), so a restart of the server does not lose it.
  const REVIEW_FILE = path.join(FEEDBACK, "review.json");
  const reviewBefore = new Map(Object.entries(await readJSON(REVIEW_FILE, {})).map(([file, text]) => [path.join(DECK_DIR, file), text]));   // file → its text before Claude's first change (null: there was no file)
  const reviewSave = () => fs.mkdir(FEEDBACK, { recursive: true }).then(() => writeJSON(REVIEW_FILE, Object.fromEntries([...reviewBefore].map(([file, text]) => [path.relative(DECK_DIR, file), text])))).catch(err => console.error("review:", err.message));
  // After a run: a file that is as it was has nothing to show, and will be remembered again before the next run
  async function reviewPrune() {
    for (const [file, before] of reviewBefore) if (await fs.readFile(file, "utf8").catch(() => null) === before) reviewBefore.delete(file);
    await reviewSave();
  }
  const reviewed = file => /\.(html|json|js|mjs|css|svg)$/i.test(file) && file.startsWith(DECK_DIR + path.sep) && !file.startsWith(FEEDBACK + path.sep) && !file.includes(`${path.sep}screenshots${path.sep}`);
  async function reviewKeep(ids) {
    const files = [DECK, ...(await Promise.all(ids.map(async id => (await fs.readdir(path.join(SLIDES, id)).catch(() => [])).map(f => path.join(SLIDES, id, f))))).flat()];
    for (const file of files) if (reviewed(file) && !reviewBefore.has(file)) reviewBefore.set(file, await fs.readFile(file, "utf8").catch(() => null));
  }
  async function reviewState(lines = true) {
    const order = (await readJSON(DECK, { order: [] })).order || [], slides = new Map();
    for (const [file, before] of reviewBefore) {
      const now = await fs.readFile(file, "utf8").catch(() => null);
      if (now === before) continue;
      const name = path.relative(DECK_DIR, file), id = name.split(path.sep)[0] === "slides" ? name.split(path.sep)[1] : "";
      const d = diffLines(before ?? "", now ?? "");
      if (!slides.has(id)) slides.set(id, { id, number: order.indexOf(id) + 1, title: id ? (await readJSON(path.join(SLIDES, id, "brief.json"), {})).title || id : "Deck", files: [], add: 0, del: 0, created: false, removed: false, visual: false });
      const s = slides.get(id);
      s.files.push({ file: name.split(path.sep).join("/"), add: d.add, del: d.del, hunks: lines ? d.hunks : undefined }); s.add += d.add; s.del += d.del;
      if (path.basename(file) === "slide.html") { s.visual = true; s.created = before === null; s.removed = now === null; }
    }
    const list = [...slides.values()].sort((a, b) => (a.number || 1e9) - (b.number || 1e9));
    return { slides: list, add: list.reduce((n, s) => n + s.add, 0), del: list.reduce((n, s) => n + s.del, 0) };
  }
  let claudeSlide = "", claudeChanged = (await reviewState(false)).slides.length;   // the slide Claude works on now; how many slides the review holds
  const claudeDiffState = () => { const files = [...claudeDiff].map(([f, [a, d]]) => [path.relative(DECK_DIR, f).split(path.sep).join("/").replace(/^(\.\.\/)+/, ""), a, d]); return { files, add: files.reduce((n, f) => n + f[1], 0), del: files.reduce((n, f) => n + f[2], 0) }; };
  // A step of the run → [one line, stage]: the file read or edited, or the command's own description. The stage
  // picks the mascot's animation: reading, looking (a picture), tasks (the session file), working (a slide),
  // checking (screenshots); "" keeps the stage as it is.
  function claudeStepOf(ev) {
    for (const b of ev.type === "assistant" && ev.message?.content || []) {
      if (b.type !== "tool_use") continue;
      const i = b.input || {}, file = i.file_path ? path.relative(DECK_DIR, i.file_path).split(path.sep).join("/").replace(/^(\.\.\/)+/, "") : "";
      const picture = /\.(png|webp|jpe?g)$/i.test(file);
      if (b.name === "Read") return [`${picture ? "Looking at" : "Reading"} ${file}`, picture ? "looking" : "reading"];
      if (b.name === "Edit" || b.name === "Write") return [`Editing ${file}`, /feedback\.ks$/.test(file) ? "tasks" : "working"];
      if (b.name === "Bash") return [String(i.description || i.command || "Running a command").slice(0, 90),
        /shots|cdp-check/.test(i.command) ? "checking" : /tools\/ks\.mjs/.test(i.command) ? "" : "reading"];
      return [b.name, ""];
    }
  }
  async function saveClaude(change) {   // also tells the panel: the file change is pushed to the open pages
    await fs.mkdir(FEEDBACK, { recursive: true });
    await writeJSON(CLAUDE_FILE, { auto: false, ...await readJSON(CLAUDE_FILE, {}), ...change });
  }
  // The sessions Claude has work on. → [{ id, file, text, kind, why, pictures, slides }], kind: "new" (no Task, not
  // a follow-up), "todo" (a task to do: left by the fast pass, or the user came back to it), "follow" (a follow-up
  // recording on such a task). A session that is still being saved is not there yet.
  const saving = new Set();
  async function pendingFeedback() {
    const ids = (await fs.readdir(FEEDBACK).catch(() => [])).filter(id => validSession(id) && !saving.has(id)).sort();
    const all = await Promise.all(ids.map(async id => {
      const file = path.join(FEEDBACK, id, "feedback.ks"), text = await fs.readFile(file, "utf8").catch(() => "");
      return { id, file, text, st: parse(text).statements };
    }));
    const out = [];
    for (const s of all) {
      const of = type => s.st.filter(x => x.type === type), closed = new Set(of("Close").map(c => c.v[0]));
      const todo = of("Task").filter(t => t.v[0] === "Todo" && !closed.has(t.name)), about = of("About")[0]?.v;
      const follows = about && all.find(o => o.id === about[0])?.st.some(t => t.type === "Task" && t.name === about[1] && t.v[0] === "Todo");
      const kind = todo.length ? "todo" : follows ? "follow" : !of("Task").length && !about && s.text ? "new" : "";
      if (!kind) continue;
      // A task to do: left by the fast pass (first time), or the user came back to it (a Reply, or a follow-up recording)
      // How many times the user came back to a task (Reply lines and follow-up recordings): 0 = it was left to do
      const back = t => of("Reply").filter(r => r.v[0] === t.name).length + all.filter(o => o.st.some(x => x.type === "About" && x.v[0] === s.id && x.v[1] === t.name)).length;
      const times = n => !n ? "left to do" : n === 1 ? "the user came back to it once" : `the user came back to it ${n} times`;
      const why = { new: "new: no Task line yet", todo: `to do: ${todo.map(t => `${t.name} (${times(back(t))})`).join(", ")}`,
        follow: `follow-up on task ${about?.[1]} of session ${about?.[0]}` }[kind];
      const again = todo.length ? Math.min(...todo.map(back)) : 0;   // 2 or more on every task: the fast model failed twice, the strong one takes it
      const pictures = (await fs.readdir(path.join(FEEDBACK, s.id))).filter(f => f.endsWith(".png")).sort().map(f => path.join(FEEDBACK, s.id, f));
      // Its slides, with their state: the user's message may be about a slide that is not styled yet
      const slides = await Promise.all([...new Set([...of("Enter").map(e => e.v[1]), ...of("Task").map(t => t.v[1])])].map(async id => {
        const brief = rel(path.join(SLIDES, id, "brief.json")), file = path.join(SLIDES, id, "slide.html");
        return rel(file) + (!existsSync(file) ? ` (not styled yet: brief in ${brief})` : (await readJSON(path.join(SLIDES, id, "brief.json"), {})).status === "todo" ? ` (its brief changed since it was styled: ${brief})` : "");
      }));
      out.push({ ...s, kind, why, again, pictures, slides, ids: [...new Set([...of("Enter").map(e => e.v[1]), ...of("Task").map(t => t.v[1])])] });
    }
    return out;
  }

  // Two levels. The fast one does nearly everything: it writes the tasks and does them, also the ones the user comes
  // back to. The strong one takes what the fast one leaves to do: 3D work, and a task the user came back to twice or
  // more (the fast one did not get it right). Measured on a day of use with a wider rule: the strong one took 93 %
  // of the time, on tasks that were not 3D.
  const FAST = { model: "sonnet", effort: "medium" }, STRONG = { model: "opus" };
  const rel = f => path.relative(ROOT, f) || ".";

  // One run of Claude Code, read as a stream of events (one JSON per line); the last event holds its answer.
  // It resumes the deck's Claude session when the last run is less than CLAUDE_TTL old and the session is under
  // CLAUDE_CTX tokens (a session can be resumed with another model); else a new session starts, with no memory of
  // the earlier work. Each step is pushed to the pages, unless quiet. Stopped after 20 min.
  async function claudeExec(level, prompt, quiet = false) {
    const st = await readJSON(CLAUDE_FILE, {});
    const resume = st.session && Date.now() - st.at < CLAUDE_TTL && st.ctx < CLAUDE_CTX, session = resume ? st.session : crypto.randomUUID();
    let ctx = 0;   // tokens the session holds: what the last request sent
    const tools = await claudeTools();
    const run = flag => new Promise((done, fail) => {
      // The prompt goes through stdin: it holds whole slides and sessions, longer than a Windows command line (32,767 characters)
      writeFileSync(NO_MCP, '{"mcpServers":{}}');
      const claude = tool("claude");
      const child = spawn(claude.file, claude.args(["-p", flag, session, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
        "--strict-mcp-config", "--mcp-config", NO_MCP,
        "--model", level.model, ...(level.effort ? ["--effort", level.effort] : []),   // less thinking = faster
        "--allowedTools", ...tools, ...(DECK_DIR.startsWith(ROOT + path.sep) ? [] : ["--add-dir", DECK_DIR])]),
        { cwd: ROOT, env: { ...TOOL_ENV, PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"], shell: claude.shell, windowsHide: true });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      const timer = setTimeout(() => child.kill(), 20 * 60e3);
      claudeChild = child;
      let buffer = "", errors = "", result = null;
      child.stdout.on("data", chunk => {
        buffer += chunk;
        for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
          let ev; try { ev = JSON.parse(buffer.slice(0, i)); } catch { continue; }
          if (ev.type === "result") result = ev;
          const u = ev.type === "assistant" && ev.message?.usage;
          if (u) ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const step = !quiet && claudeStepOf(ev);
          if (step) { claudeStep = step[0]; claudeStage = step[1] || claudeStage; }
          if (!quiet && claudeNote(ev)) pushClaude();
        }
      });
      child.stderr.on("data", chunk => errors = (errors + chunk).slice(-600));
      child.on("error", fail);
      child.on("close", () => {
        clearTimeout(timer); claudeChild = null;
        result && !result.is_error ? done(String(result.result)) : fail(new Error(result?.result || errors.trim() || "Claude stopped with no answer"));
      });
    });
    // A session that can no longer be resumed: start a new one
    const gone = err => /No conversation found/.test(err.message) ? run("--session-id") : Promise.reject(err);
    try { return await (resume ? run("--resume").catch(gone) : run("--session-id")); }
    finally { await saveClaude({ session, at: Date.now(), ctx }); }
  }

  // Everything Claude needs is in the prompt (the session files, their pictures, the slides): each thing it has to
  // look for is one more step, and a step takes 1 to 2 s.
  let claudeStyle = "";   // set before each run: the deck's style guide, when deck.json names one
  const claudePrompt = (level, why, pending) => `${why}
Deck "${DECK_NAME}": folder ${rel(DECK_DIR)}, served on port ${port} (PORT is set: "npm run shots -- <id>" shoots this deck)${claudeStyle}.
This is all the feedback you have to handle now. Do not list or search the feedback folder.
${pending.map(s => `
=== ${rel(s.file)} (${s.why})
pictures: ${s.pictures.map(rel).join(", ") || "none (no stroke)"} · slides: ${s.slides.join(", ")}
${s.text.trim()}`).join("\n")}

Handle it as the "Feedback sessions" section of AGENTS.md says, in as few steps as you can (use several tools in one step). A session can go over several slides (Enter lines): the user keeps talking while changing slide, and one request can be about several slides, or about the slide shown just before or just after the words. Read the whole session before you write its tasks. A Note line is a message the user typed: it counts like spoken words. The user may ask for new slides, or speak on a slide just created ("New slide", not styled yet): see "New slides" in AGENTS.md. When you write several slides on one subject, each slide is one idea with its own title: never label them as numbered parts ("Answer 1", "Part 2", "Step 3/5", in any language). Write the Task texts, the State::Ask questions and your last sentences in ${langName(USER_LANG)}, the user's language; slide text is in the deck's language. When the feedback asks to style or update a slide marked "not styled yet" or "its brief changed", do it as "Styling a slide" in AGENTS.md says, then set "status": "done" in its brief.json.
1. Read the pictures and the slide files you need, in one step.
${level === FAST ? `2. You do the work yourself: text, style, layout, new slides, diagrams, 2D animations. Append the Task lines of the new sessions (every session must get one): State::Doing for what you do, State::Ask for a question, State::Done with the reason when there is nothing to do. A task marked "to do" is yours too: the user came back to it, read its Reply lines and the follow-up sessions, set it to State::Doing. Edit the slides in the same step (and the slide's translations, slide.<lang>.json, when the text of slide.html changed).
Two kinds of task are not for you. Leave them in State::Todo and do not start them, a stronger model takes them right after you: a task that needs 3D (three.js, WebGL, a shader, a 3D scene on a canvas), whose text must then say exactly what to do; and a task marked "the user came back to it 2 times" or more.`
  : `2. These tasks are for you: 3D work that the fast pass left with its instructions, or a task the user came back to more than once because the result was not right (read the Reply lines and the follow-up sessions). Set them to State::Doing and do them (and the slide's translations, slide.<lang>.json, when the text of slide.html changed). State::Ask for a question. The user can follow you live: before each step, write one short sentence in ${langName(USER_LANG)}, to the user${USER_LANG === "fr" ? ' ("tu")' : ""}, that says what you are going to do and why.`}
3. One command: node tools/ks.mjs <the session files>. Take no screenshot for a task you do for the first time. For a task the user came back to, the user saw something wrong: after your change, run npm run shots -- <slide id>, look at the picture, and fix what is wrong before you go on. Checking every change with a picture is slow, so the user looks at the slide and comes back to you when something is not right.
4. Set the tasks you did to State::Done. No check after that: the presenter reports a session file that is wrong.
No user reads this conversation, the user only sees the Task lines in the presenter. Never ask a question here: write a State::Ask task. Do not commit, do not push, do not start or stop a server.
Change files with the Read and Edit tools only. Never write a file with a shell command (printf, echo, cat >) and do not start a command with cd: no user can approve it, it is refused and costs a step. Only read-only commands, "node tools/ks.mjs", "node tools/asset.mjs", "npm run shots" and "node tools/cdp-check.mjs" run, from the Keystone root.
An image, a video or a model of another deck or of the style library (you can read every deck's files): copy it into this deck with "node tools/asset.mjs <file> [<file> …] ${rel(DECK_DIR)}", which prints the /deck/assets/… address to write in the slide. Never point a slide at another deck's folder or server, and never ask the user to copy a file.
End with one or two short sentences in ${langName(USER_LANG)} that say what you did. The presenter shows them and can read them aloud to the user: speak to the user${USER_LANG === "fr" ? ' ("tu")' : ""}, plain words, no code, no file name, no backticks. Say what changed on the slides, nothing about how you worked: never say that you took no screenshot or did not look at the result, in these sentences or in a task's text.`;

  // The user interrupts Claude (the popup's Stop): its process is killed, and nothing stays to do. Every task in
  // progress or to do becomes State::Stopped, and a session not read yet gets a stopped task, so the next run does
  // not take them again. The user comes back to a stopped task (a reply on its pin) to start it again. What Claude
  // already changed in the files stays.
  let claudeChild = null, claudeStopping = false;
  function stopClaude() {
    if (!claudeRunning) return false;
    claudeStopping = true; claudeStep = "Stopping"; claudeChild?.kill(); pushClaude();
    return true;
  }
  async function stopPending() {
    for (const id of (await fs.readdir(FEEDBACK).catch(() => [])).filter(id => validSession(id) && !saving.has(id))) {
      const file = path.join(FEEDBACK, id, "feedback.ks"), text = await fs.readFile(file, "utf8").catch(() => "");
      const st = parse(text).statements, of = type => st.filter(x => x.type === type), closed = new Set(of("Close").map(c => c.v[0]));
      const rows = text.replace(/\n+$/, "").split("\n"), open = of("Task").filter(t => /^(Doing|Todo)$/.test(t.v[0]) && !closed.has(t.name));
      for (const t of open) rows[t.line - 1] = rows[t.line - 1].replace(/State::\w+/, "State::Stopped");
      const unread = text && !of("Task").length && !of("About").length;
      if (unread) rows.push(`Task k1(State::Stopped, ${JSON.stringify(of("Enter")[0]?.v[1] || "")}, "Interrompu avant d'être traité. Réponds sur ce pin pour le relancer."${st.filter(x => /^(Stroke|Say|Note)$/.test(x.type)).map(x => ", " + x.name).join("")});`);
      if (!open.length && !unread) continue;
      const next = rows.join("\n") + "\n";
      if (!parse(next).errors.length) await fs.writeFile(file, next);
    }
  }

  // Feedback was saved or changed: the fast pass on the new sessions, then the strong pass on what is left to do.
  // One at a time; feedback that arrives during a run is taken by the next one. Nothing to do: no run.
  function wakeClaude(why) {
    if (claudeWaiting) return;   // the queued run will see this feedback too
    claudeWaiting = true;
    claudeQueue = claudeQueue.then(async () => {
      claudeWaiting = false;
      if (!(await readJSON(CLAUDE_FILE, {})).auto) return;
      let last = null;
      for (const level of [FAST, STRONG]) {
        // The fast pass gets everything, unless the user came back twice or more to all of it; the strong pass, what
        // is still to do after it
        const all = await pendingFeedback(), pending = level === FAST ? (all.some(s => s.kind === "new" || (s.kind === "todo" && s.again < 2)) ? all : []) : all.filter(s => s.kind !== "new");
        if (!pending.length) continue;
        await reviewKeep(pending.flatMap(s => s.ids));
        const guide = (await readJSON(DECK, {})).style;
        claudeStyle = guide ? `. Its style guide is "${guide}": follow ${rel(path.join(STYLES, String(guide), "style.md"))}` : "";
        if (!claudeRunning) { claudeRunning = Date.now(); claudeLog = []; claudeDiff = new Map(); }
        claudeModel = level.model; claudeStep = level === FAST ? "Reading the feedback" : "Taking the 3D work"; claudeStage = "reading";
        claudeLogged("pass", level === FAST ? "Sonnet: reads the feedback, writes the tasks and does them" : "Opus: takes what Sonnet left (3D, or a task you came back to twice)");
        await pushClaude();
        try { last = { ok: true, at: Date.now(), text: (await claudeExec(level, claudePrompt(level, why, pending))).trim().slice(-600) }; }   // the strong pass's sentence replaces the fast one's
        catch (err) { last = { ok: false, at: Date.now(), text: String(err.message).trim().slice(-600) }; if (!claudeStopping) console.error("claude:", last.text); break; }
        if (claudeStopping) break;
      }
      if (claudeStopping) {
        claudeStopping = false; await stopPending(); claudeLogged("pass", "Stopped by the user");
        last = { ok: true, at: Date.now(), text: "Je me suis arrêté. Ce qui était en cours est marqué comme arrêté, et ce que j'avais déjà modifié reste en place." };
      }
      if (!last) return;
      claudeRunning = null; claudeStep = claudeModel = claudeSlide = "";
      await reviewPrune();
      claudeChanged = (await reviewState(false)).slides.length;
      await saveClaude({ last });
    }).catch(err => console.error("claude:", err));
  }

  // A recording starts: Claude reads the slide on screen meanwhile, so its session and its cache are warm when the
  // feedback arrives. Nothing is shown and nothing is changed. Not when a run is in progress or about to start.
  let claudeWarming = false;
  function warmClaude(slide) {
    if (claudeWarming || claudeWaiting || claudeRunning) return;
    claudeWarming = true;
    claudeQueue = claudeQueue.then(async () => {
      if (!(await readJSON(CLAUDE_FILE, {})).auto) return;
      await claudeExec(FAST, `The user starts recording feedback on slide "${slide}" of deck "${DECK_NAME}" (folder ${rel(DECK_DIR)}). The feedback comes in a moment.
Get ready: read ${rel(path.join(SLIDES, slide, "slide.html"))} now. Change no file and run no command. Answer with the single word: ready`, true);
    }).catch(err => console.error("claude (warm):", err.message)).finally(() => claudeWarming = false);
  }

  // Change a task from the presenter: append a line named <prefix><n> (the first free n) and/or set the task back
  // to Todo. The file is written only when it is still valid. → false when the task does not exist.
  async function changeTask(session, task, prefix, line, todo) {
    const ks = path.join(FEEDBACK, session, "feedback.ks"), text = await fs.readFile(ks, "utf8").catch(() => "");
    const { statements } = parse(text), target = statements.find(s => s.type === "Task" && s.name === task);
    if (!target) return false;
    const rows = text.replace(/\n+$/, "").split("\n");
    if (todo) rows[target.line - 1] = rows[target.line - 1].replace(/State::\w+/, "State::Todo");
    let n = 1; while (statements.some(s => s.name === prefix + n)) n++;
    if (line) rows.push(line(prefix + n));
    const next = rows.join("\n") + "\n", { errors } = parse(next);
    if (errors.length) throw new Error(`feedback.ks line ${errors[0].line}: ${errors[0].message}`);
    await fs.writeFile(ks, next);
    return true;
  }

  // The strokes of one visit drawn over its slide, each with its name and its own colour:
  // /render/<id>?feedback=<session>&visit=<n>. Handwriting and sketches are read from this picture: a list of points
  // says where a stroke goes, not what it draws.
  async function feedbackOverlay(session, n) {
    const { statements } = validSession(session) ? await readSession(session).catch(() => ({ statements: [] })) : { statements: [] };
    const COLORS = ["#ffd43b", "#4dabf7", "#69db7c", "#ff922b", "#f783ac", "#e599f7"];
    const strokes = (visits(statements)[n - 1]?.strokes || []).map((s, i) => {
      const pts = s.v.slice(3), c = COLORS[i % COLORS.length];
      return `<polyline points="${(pts.length > 1 ? pts : [pts[0], pts[0]]).join(" ")}" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="${pts[0][0] - 6}" y="${pts[0][1] - 6}" text-anchor="end" fill="${c}" stroke="#000" stroke-width="3" paint-order="stroke" font-family="monospace" font-size="14">${s.name}</text>`;
    });
    return `<svg width="1280" height="720" viewBox="0 0 1280 720" style="position:absolute;left:0;top:0;z-index:9999;pointer-events:none">${strokes.join("")}</svg>`;
  }

  // The picture of each visit that has strokes: <n>-<slide>.png, taken when the session is saved, so it shows the
  // slide as it was then (resting state; a later edit of the slide does not change it).
  async function snapshots(session, statements) {
    const todo = visits(statements).filter(v => v.strokes.length);
    if (!todo.length) return;
    const chrome = await launchChrome();
    try {
      const page = await chrome.newPage();
      for (const v of todo) {
        await page.send("Page.navigate", { url: `http://${HOST}:${port}/render/${v.slide}?feedback=${session}&visit=${v.n}` });
        await new Promise(r => setTimeout(r, 2500));
        const { data } = await page.send("Page.captureScreenshot", { format: "png" });
        await fs.writeFile(path.join(FEEDBACK, session, `${v.n}-${v.slide}.png`), Buffer.from(data, "base64"));
      }
    } finally { chrome.close(); }
  }

  // Live reload: any change under the deck folder or public/ is pushed to the deck's open pages
  const clients = new Set();
  let pending;
  function broadcast(file) {
    clearTimeout(pending);
    pending = setTimeout(() => { for (const res of clients) res.write(`data: ${JSON.stringify({ file })}\n\n`); }, 120);
  }
  watch(DECK_DIR, { recursive: true }, (_, f) => broadcast(f));
  publicListeners.add(broadcast);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === "/" || p === "/index.html") return serveFile(req, res, path.join(PUBLIC, "index.html"), PUBLIC);
      if (p.startsWith("/public/")) {
        const dir = layer(p.slice(8));
        return serveFile(req, res, path.join(dir, p.slice(8)), dir);
      }
      if (p.startsWith("/deck/")) return serveFile(req, res, path.join(DECK_DIR, p.slice(6)), DECK_DIR);
      // Web app (Add to Home Screen, install): the deck's name, full screen, landscape; its icon is <deck>/assets/icon.png
      // (512×512), else the brand's (/public/assets/brand/icon.png)
      if (p === "/manifest.webmanifest") {
        const d = await readJSON(DECK, {}), name = titleIn(d, viewLang(url)) || DECK_NAME;
        res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" });
        return res.end(JSON.stringify({ name, short_name: name, start_url: "/", scope: "/", display: "fullscreen", orientation: "landscape",
          background_color: "#000000", theme_color: "#000000", icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }] }));
      }
      if (p === "/icon.png") {
        const own = path.join(DECK_DIR, "assets", "icon.png"), brand = layer("assets/brand/icon.png");
        return existsSync(own) ? serveFile(req, res, own, DECK_DIR) : serveFile(req, res, path.join(brand, "assets", "brand", "icon.png"), brand);
      }

      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": ok\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      let m;
      if ((m = p.match(/^\/render\/([a-z0-9-]+)$/))) {
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        const style = (url.searchParams.get("style") || "").replace(/[^a-z0-9-]/g, "");
        // ?before=1: the slide as it was before Claude's changes (the review); a slide Claude did not change: as it is
        const was = url.searchParams.has("before") ? reviewBefore.get(path.join(SLIDES, m[1], "slide.html")) : undefined;
        let html = await renderSlide(m[1], style, viewLang(url), was);
        // ?phone: the presenter runs on a phone; <html class="sa-phone"> lets the slide's CSS adapt (bigger text)
        if (url.searchParams.has("phone")) html = html.replace("<html ", '<html class="sa-phone" ');
        const fb = url.searchParams.get("feedback");
        return res.end(fb ? html.replace("</body>", await feedbackOverlay(fb, Number(url.searchParams.get("visit")) || 1) + "</body>") : html);
      }
      if ((m = p.match(/^\/slides\/([a-z0-9-]+)\/(.+)$/))) return serveFile(req, res, path.join(SLIDES, m[1], m[2]), SLIDES);

      if (p === "/api/info" && req.method === "GET") return json(res, 200, { name: DECK_NAME, dir: DECK_DIR, userLang: USER_LANG });
      // The decks served by this process, for links between decks (each on its own port of the same host)
      if (p === "/api/decks" && req.method === "GET") {
        const lang = viewLang(url);
        return json(res, 200, { current: DECK_NAME, decks: await Promise.all(served.map(async d => {
          const info = await readJSON(path.join(d.dir, "deck.json"), {});
          return { id: d.id, title: titleIn(info, lang) || d.id, port: d.port };
        })) });
      }
      if (p === "/api/styles" && req.method === "GET") return json(res, 200, { styles: await styleGuides() });

      // A new deck (the overview's "+ New deck"): decks/<id>/ in the Keystone folder, with a cover slide to style,
      // added to decks/keystone.json and served at once by this process on the next free port.
      if (p === "/api/decks" && req.method === "POST") {
        const { title: given, style } = await body(req), title = String(given || "").trim(), guides = await styleGuides();
        if (!title) return json(res, 400, { error: "a deck needs a title" });
        if (style && !guides.some(g => g.id === style)) return json(res, 400, { error: `no style guide "${style}" in library/styles` });
        const base = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "deck";
        let id = base;
        for (let n = 2; served.some(d => d.id === id) || existsSync(path.join(DECKS, id)); n++) id = `${base}-${n}`;
        const dir = path.join(DECKS, id), list = await readJSON(OWN_LIST, { decks: [] });
        const free = port => new Promise(ok => { const probe = net.createServer().once("error", () => ok(false)).once("listening", () => probe.close(() => ok(true))).listen(port, HOST); });
        let next = Math.max(PORT, ...served.map(d => d.port), ...list.decks.map(d => d.port || 0)) + 1;
        while (!await free(next)) next++;
        await fs.mkdir(path.join(dir, "slides", "cover"), { recursive: true });
        await writeJSON(path.join(dir, "deck.json"), { title, lang: USER_LANG, style: style || guides.find(g => g.default)?.id || "", order: ["cover"] });   // written in the user's language
        await writeJSON(path.join(dir, "slides", "cover", "brief.json"), { title, text: "", notes: "", status: "todo", updatedAt: new Date().toISOString() });
        // The media of the style guide (its cover photo…), so the deck's slides can use them from the start
        for (const file of guides.find(g => g.id === (style || guides.find(x => x.default)?.id))?.media || []) {
          const from = path.join(ROOT, "library", file);
          if (!from.startsWith(path.join(ROOT, "library") + path.sep) || !existsSync(from)) continue;
          await fs.mkdir(path.join(dir, "assets", "media"), { recursive: true });
          await fs.copyFile(from, path.join(dir, "assets", "media", path.basename(file)));
        }
        {   // one deck per line, as the file is written by hand
          list.decks.push({ dir: path.relative(DECKS, dir), port: next });
          const others = Object.entries(list).filter(([k]) => k !== "decks").map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("");   // userLang… stay
          await fs.writeFile(OWN_LIST, `{\n${others}  "decks": [\n${list.decks.map(d => `    { ${Object.entries(d).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`).join(",\n")}\n  ]\n}\n`);
        }
        served.push({ dir, port: next, id });
        await serveDeck(dir, next);
        return json(res, 201, { id, port: next, dir: path.relative(ROOT, dir) });
      }
      if (p === "/api/deck" && req.method === "GET") return json(res, 200, await loadDeck(viewLang(url)));

      if (p === "/api/slides" && req.method === "POST") {
        const { after, brief = {} } = await body(req);
        const id = slugify(brief.title);
        await fs.mkdir(path.join(SLIDES, id), { recursive: true });
        await writeJSON(path.join(SLIDES, id, "brief.json"), { title: "", text: "", notes: "", ...brief, status: "todo", updatedAt: new Date().toISOString() });
        const deck = await readJSON(DECK, { title: "Presentation", order: [] });
        const i = deck.order.indexOf(after);
        deck.order.splice(i < 0 ? deck.order.length : i + 1, 0, id);
        await writeJSON(DECK, deck);
        return json(res, 201, { id });
      }

      if ((m = p.match(/^\/api\/slides\/([a-z0-9-]+)$/)) && validId(m[1])) {
        const id = m[1], dir = path.join(SLIDES, id), file = path.join(dir, "brief.json");
        if (req.method === "PUT") {
          const incoming = await body(req);
          const prev = await readJSON(file, {});
          const next = { ...prev };
          for (const k of ["title", "text", "notes"]) if (k in incoming) next[k] = String(incoming[k]);
          const changed = ["title", "text"].some(k => (prev[k] ?? "") !== (next[k] ?? ""));
          if (changed) next.status = "todo";
          next.updatedAt = new Date().toISOString();
          await writeJSON(file, next);
          return json(res, 200, { brief: next });
        }
        if (req.method === "DELETE") {
          // Soft delete: the folder moves to .trash, nothing is lost
          const deck = await readJSON(DECK, { order: [] });
          deck.order = deck.order.filter(x => x !== id);
          await writeJSON(DECK, deck);
          await fs.mkdir(path.join(DECK_DIR, ".trash"), { recursive: true });
          await fs.rename(dir, path.join(DECK_DIR, ".trash", `${id}-${Date.now()}`)).catch(() => {});
          return json(res, 200, { ok: true });
        }
      }

      // Reply to one of Claude's fact checks: appended to the bubble's thread, Claude answers in checks.json
      if ((m = p.match(/^\/api\/checks\/([a-z0-9-]+)\/([a-z0-9-]+)$/)) && req.method === "POST") {
        const file = path.join(SLIDES, m[1], "checks.json");
        const data = await readJSON(file, null);
        const check = data?.checks?.find(c => c.id === m[2]);
        if (!check) return json(res, 404, { error: "check not found" });
        const text = String((await body(req)).text || "").trim();
        if (!text) return json(res, 400, { error: "empty reply" });
        (check.thread ||= []).push({ from: "user", text, at: new Date().toISOString() });
        check.status = "todo";
        await writeJSON(file, data);
        return json(res, 200, { check });
      }

      // The feedback language's types, for the presenter's DSL view
      if (p === "/api/ks" && req.method === "GET") return json(res, 200, { ENUMS, STATEMENTS, VALUES });

      // The sessions, newest first, for the presenter's panel: what was said, and Claude's tasks
      if (p === "/api/feedback" && req.method === "GET") {
        const ids = (await fs.readdir(FEEDBACK).catch(() => [])).filter(validSession).sort().reverse();
        const sessions = await Promise.all(ids.map(async id => {
          const { statements: st, errors } = await readSession(id).catch(e => ({ statements: [], errors: [{ line: 0, message: e.message }] }));
          const of = type => st.filter(s => s.type === type);
          const by = new Map(st.map(s => [s.name, s])), words = s => s.v.slice(1).map(w => w[1]).join(" ");
          return { id, errors, slides: [...new Set(of("Enter").map(s => s.v[1]))], about: of("About")[0]?.v || null,
            says: of("Say").map(s => ({ name: s.name, text: words(s) })),
            // A task is shown as a pin on its slide: at the centre of the strokes it comes from, with what was heard
            tasks: of("Task").map(s => {
              const from = s.v.slice(3).map(n => by.get(n)), strokes = from.filter(x => x?.type === "Stroke").map(x => x.v.slice(3));
              const xs = strokes.flat().map(q => q[0]), ys = strokes.flat().map(q => q[1]);
              return { name: s.name, state: s.v[0], slide: s.v[1], text: s.v[2], strokes,
                at: xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : null,
                heard: from.filter(x => x?.type === "Say" || x?.type === "Note").map(x => x.type === "Say" ? words(x) : x.v[0]),
                replies: of("Reply").filter(r => r.v[0] === s.name).map(r => r.v[1]),
                closed: of("Close").some(c => c.v[0] === s.name) };
            }) };
        }));
        // Sessions recorded as a follow-up on a task (About)
        for (const s of sessions) for (const t of s.tasks) t.follows = sessions.filter(o => o.about?.[0] === s.id && o.about[1] === t.name).map(o => o.id);
        return json(res, 200, { sessions, claude: await claudeState() });
      }

      // The presenter asks this computer to say a sentence, or to be quiet. Not a Mac or Windows: the presenter uses the browser's voices.
      if (p === "/api/say" && req.method === "POST") {
        const { text, stop } = await body(req);
        if (!await speaks()) return json(res, 200, { ok: false });
        // The pages of this deck are told when the voice starts and stops
        if (stop) sayStop(); else if (String(text || "").trim()) sayText(String(text).slice(0, 1500), voice => { for (const page of clients) page.write(`data: ${JSON.stringify({ voice })}\n\n`); });
        return json(res, 200, { ok: true });
      }

      if (p === "/api/claude/stop" && req.method === "POST") return json(res, 200, { ok: stopClaude() });
      // The review of Claude's changes, and "Done": the user has seen them, the next review starts from now
      if (p === "/api/claude/review" && req.method === "GET") return json(res, 200, await reviewState());
      if (p === "/api/claude/review" && req.method === "DELETE") { reviewBefore.clear(); await reviewSave(); claudeChanged = 0; pushClaude(); return json(res, 200, { ok: true }); }

      if (p === "/api/claude/warm" && req.method === "POST") {
        const { slide } = await body(req);
        if (validId(String(slide)) && existsSync(path.join(SLIDES, slide, "slide.html"))) warmClaude(slide);
        return json(res, 200, { ok: true });
      }

      // The panel's switch: Claude handles feedback by itself or not. Turned on, it takes what is waiting.
      if (p === "/api/claude" && req.method === "PUT") {
        const given = await body(req);
        if ("auto" in given) {   // {} only reads the state
          const auto = !!given.auto;
          await saveClaude({ auto });
          if (auto) wakeClaude("The user turned automatic feedback handling on.");
        }
        return json(res, 200, await claudeState());
      }

      // The user's actions on a task's pin, written in its session: {close: true} removes the pin, {reply: text}
      // says more about the task and sets it back to Todo
      if ((m = p.match(/^\/api\/feedback\/(\d{8}-\d{6})\/task\/(\w+)$/)) && req.method === "POST") {
        const { close, reply } = await body(req);
        const line = close ? name => `Close ${name}(${m[2]});` : String(reply || "").trim() ? name => `Reply ${name}(${m[2]}, ${JSON.stringify(String(reply).trim())});` : null;
        if (!line) return json(res, 400, { error: "empty reply" });
        if (!await changeTask(m[1], m[2], close ? "c" : "r", line, !close)) return json(res, 404, { error: "task not found" });
        if (!close) wakeClaude(`The user replied on task ${m[2]} of feedback session ${m[1]}.`);
        return json(res, 200, { ok: true });
      }

      // A recording from the presenter: slide changes, strokes and undos in the order they happened, and the voice.
      // One recording = one session, whatever the number of slides: the user often explains one thing over several
      // slides. tools/transcribe.py adds the Say lines. A recording with no stroke, no word and no note is dropped.
      if (p === "/api/feedback" && req.method === "POST") {
        const { events = [], audio = "", mime = "", about } = await body(req);
        const two = v => String(v).padStart(2, "0");
        const name = d => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
        let at = Date.now(), id = name(new Date(at));
        while (saving.has(id) || existsSync(path.join(FEEDBACK, id))) id = name(new Date(at += 1000));   // two parts in the same second
        saving.add(id);
        const dir = path.join(FEEDBACK, id), ks = path.join(dir, "feedback.ks");
        let follows = false;
        try {
        const n = v => Math.max(0, Math.round(Number(v) || 0)), str = v => JSON.stringify(String(v ?? ""));
        const lines = [`Session session(${str(id)});`];
        // A follow-up recorded from a task's pin
        follows = !!about && validSession(about.session) && (await readSession(about.session).catch(() => ({ statements: [] }))).statements.some(x => x.type === "Task" && x.name === about.task);
        if (follows) lines.push(`About a1(${str(about.session)}, ${str(about.task)});`);
        let e = 0, s = 0, t = 0, u = 0, notes = 0;
        for (const ev of events) {
          // A message typed in the editor. Long pastes (a sketch file) do not go there: all of it is given to Claude.
          if (ev.type === "note" && String(ev.text || "").trim()) {
            if (String(ev.text).length > 6000) { saving.delete(id); return json(res, 400, { error: "message too long (6000 characters at most)" }); }
            lines.push(`Note n${++notes}(${str(String(ev.text).trim())});`);
          }
          if (ev.type === "enter" && validId(ev.slide)) lines.push(`Enter e${++e}(Time(${n(ev.t)}), ${str(ev.slide)});`);
          if (ev.type === "stroke" && ev.points?.length) {
            lines.push(`Stroke s${++s}(Kind::${ENUMS.Kind.includes(ev.kind) ? ev.kind : "Free"}, Color::Red, Span(${n(ev.span[0])}, ${n(ev.span[1])}), ${ev.points.map(([x, y]) => `Point(${n(x)}, ${n(y)})`).join(", ")});`);
            for (const o of ev.targets || []) lines.push(`Target t${++t}(s${s}, ${str(o.el)}, ${str(o.text)});`);
          }
          if (ev.type === "undo") lines.push(`Undo u${++u}(Time(${n(ev.t)}), s${n(ev.stroke)});`);
        }
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(ks, lines.join("\n") + "\n");
        // The pictures only need the strokes: they are taken while the voice is transcribed
        const pictures = snapshots(id, parse(lines.join("\n")).statements).catch(err => console.error("feedback pictures:", err.message));
        let said = { says: 0, text: "" };
        if (audio) {
          const file = path.join(dir, "voice." + (/mp4/.test(mime) ? "m4a" : "webm"));
          await fs.writeFile(file, Buffer.from(audio, "base64"));
          const uv = tool("uv");
          const { stdout } = await promisify(execFile)(uv.file, uv.args(["run", ...CUDA, path.join(ROOT, "tools", "transcribe.py"), ks, file, "--lang", USER_LANG]), { env: TOOL_ENV, shell: uv.shell, windowsHide: true });
          said = JSON.parse(stdout.trim().split("\n").at(-1));
        }
        const { errors } = await readSession(id);
        if (errors.length) throw new Error(`feedback/${id}/feedback.ks line ${errors[0].line}: ${errors[0].message}`);
        if (!s && !said.says && !notes) {   // the user only went through this slide
          await pictures; await fs.rm(dir, { recursive: true });
          return json(res, 200, { session: null, strokes: 0, says: 0, text: "" });
        }
        if (follows) await changeTask(about.session, about.task, "", null, true);   // that task goes back to Todo
        json(res, 200, { session: id, strokes: s, ...said });
        await pictures;
        } finally { saving.delete(id); }
        return wakeClaude(`Feedback session ${id} was just recorded${follows ? ` as a follow-up on task ${about.task} of session ${about.session}` : ""}.`);
      }

      // A phrase corrected in the panel: same number of words = each keeps its time, else they are spread over the phrase
      if ((m = p.match(/^\/api\/feedback\/(\d{8}-\d{6})\/say\/(\w+)$/)) && req.method === "PUT") {
        const ks = path.join(FEEDBACK, m[1], "feedback.ks");
        const text = await fs.readFile(ks, "utf8").catch(() => ""), say = parse(text).statements.find(s => s.type === "Say" && s.name === m[2]);
        if (!say) return json(res, 404, { error: "phrase not found" });
        const [[t0, t1], ...old] = say.v, words = [];
        // "?" and "!" stand alone in French: they stay with the word before, as in the file
        for (const w of String((await body(req)).text || "").trim().split(/\s+/).filter(Boolean)) /^[^\p{L}\p{N}]+$/u.test(w) && words.length ? words[words.length - 1] += " " + w : words.push(w);
        if (!words.length) return json(res, 400, { error: "empty phrase" });
        const at = k => words.length === old.length ? old[k][0] : Math.round(t0 + (t1 - t0) * k / words.length);
        const line = `Say ${say.name}(Span(${t0}, ${t1}), ${words.map((w, k) => `Word(${at(k)}, ${JSON.stringify(w)})`).join(", ")});`;
        await fs.writeFile(ks, text.split("\n").map((l, k) => k === say.line - 1 ? line : l).join("\n"));
        return json(res, 200, { ok: true });
      }

      if (p === "/api/order" && req.method === "PUT") {
        const { order } = await body(req);
        const deck = await readJSON(DECK, { order: [] });
        if (!Array.isArray(order) || order.length !== deck.order.length || !order.every(id => deck.order.includes(id)))
          return json(res, 400, { error: "order must be a permutation of the current slides" });
        deck.order = order;
        await writeJSON(DECK, deck);
        return json(res, 200, { ok: true });
      }

      const route = DECK_ROUTES[`${req.method} ${p}`];
      if (route) return route({ req, res, url, body: () => body(req), json: (code, data) => json(res, code, data), deckDir: DECK_DIR });

      json(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      json(res, 500, { error: String(err.message || err) });
    }
  });

  server.listen(port, HOST, () => console.log(`Keystone · deck "${DECK_NAME}" → http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${port}`));
}

// Which decks: a folder given (or the current folder holding a deck.json) = that deck alone; else keystone.json + decks/keystone.json.
const arg = process.argv[2] || process.env.DECK;
const listed = async (file, base) => (await readJSON(file, { decks: [] })).decks.map(d => ({ dir: path.resolve(base, d.dir), port: d.port }));
const served = arg || existsSync("deck.json") ? [{ dir: path.resolve(arg || "."), port: PORT }]
  : [...await listed(LIST, ROOT), ...await listed(OWN_LIST, DECKS)].map((d, i) => ({ ...d, port: d.port || PORT + i }));
for (const d of served) {
  d.id = path.basename(d.dir);
  if (!existsSync(path.join(d.dir, "deck.json"))) { console.error(`No deck.json in ${d.dir}
Usage: node server.js <deck folder>  (or list decks in keystone.json)`); process.exit(1); }
}
if (!served.length) { console.error("Usage: node server.js <deck folder>  (or list decks in keystone.json)"); process.exit(1); }

const publicListeners = new Set();   // live reload of every deck when the tool (public/) changes
watch(PUBLIC, { recursive: true }, (_, f) => publicListeners.forEach(b => b(f)));
if (existsSync(OVERLAY)) watch(OVERLAY, { recursive: true }, (_, f) => publicListeners.forEach(b => b(f)));
for (const d of served) await serveDeck(d.dir, d.port);
