// Copyright 2026 SASU Sentient Art
// SPDX-License-Identifier: Apache-2.0
// Deploy one deck as static files in the website's talk format, into any folder (the website's site/public, or an
// empty folder for a standalone copy that any static server can host).
//
//   node tools/deploy.mjs <deck folder> --out <folder> [--url https://example.com]
//
// The talk's settings are the "publish" block of the deck's deck.json:
//   { "slug", "title", "description", "author", "event", "date", "languages": ["en", "fr"] (first = default; default:
//     the deck's own language only), "sourceLang" (language of slide.html; default: the deck's "lang", else "en"), "first", "skip": [ids], "cover": id, "requires": "webgl" | "webgpu" | "",
//     "listed": false (optional: published, but kept out of talks/index.json and of links from other talks) }
//
// The site's address (for og: tags) is --url, else "url" in public/reader/site.json, whose "name" is the site name in the
// page title. A file of decks/public/ replaces the same file of public/ (your brand, your site.json), as in the server;
// a file of the deck's own public/ (<deck>/public/: that deck's brand) replaces both.
//
// Links between decks (<a href="deck:<id>#<n>">, decks listed in keystone.json or decks/keystone.json) become links to that talk on the site
// when the deck is published and listed; otherwise the link is removed (its text stays). Deploy the target deck too.
//
// Writes into <out>:
//   talks/<slug>/        talk.json, index.html (the reader), cover.webp, og.jpg, slides/<id>/<lang>.html + thumb-<lang>.webp,
//                        the files of each slide folder, and the deck files the slides reference (assets/, components/)
//   talks/_shared/       the Keystone files the slides use (theme, components, three.js, brand images) and the reader
//   talks/index.json     every talk deployed to this folder (the host's talk list reads it)
//   assets/fonts/, css/tokens.css   Keystone's fonts and tokens (the website's own pages use them too)
// A deck with its own public/ keeps its brand out of the shared folders, so talks of other brands are not changed:
// what it uses of the tool, its fonts and tokens included, goes to talks/<slug>/_shared/ instead.
//
// Only published files leave the deck: slides are rendered from slide.html (+ slide.<lang>.json translations), editor files
// (brief.json, checks.json, prompt.done.txt, reference.png) are never copied, and deck files are copied only when
// referenced. PNG and JPEG are published as WebP. Thumbnails are screenshots of the published slides at rest
// (builds played to the end), taken in the installed Chrome over the DevTools protocol (CHROME to override its path).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTranslation, translate } from "./i18n.mjs";
import { launchChrome, encodeWebp } from "./chrome.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const OVERLAY = path.join(ROOT, "decks", "public");
const publicFile = rel => [path.join(OWN, rel), path.join(OVERLAY, rel), path.join(PUBLIC, rel)].find(f => fs.existsSync(f)) || path.join(PUBLIC, rel);
const READER = path.join(PUBLIC, "reader");

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const OUT_ARG = opt("--out");
const OUT = OUT_ARG && path.resolve(OUT_ARG);
const URL_ARG = opt("--url");
const DECK_DIR = args[0] && path.resolve(args[0]);
if (!DECK_DIR || !OUT) { console.error("Usage: node tools/deploy.mjs <deck folder> --out <folder> [--url <site address>]"); process.exit(1); }
const OWN = path.join(DECK_DIR, "public");   // the deck's own brand, if any

const deck = JSON.parse(fs.readFileSync(path.join(DECK_DIR, "deck.json"), "utf8"));
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const pub = deck.publish;
const SITE = readJSON(publicFile("reader/site.json")) || {};
const URL_BASE = (URL_ARG || SITE.url || "").replace(/\/$/, "");
if (!pub?.slug) { console.error(`No "publish" block with a "slug" in ${path.join(DECK_DIR, "deck.json")}`); process.exit(1); }

const SLUG = pub.slug;
const LANGS = pub.languages || [pub.sourceLang || deck.lang || "en"];
const SOURCE_LANG = pub.sourceLang || deck.lang || "en";
const TALKS = path.join(OUT, "talks");
const TALK = path.join(TALKS, SLUG);
const BRANDED = fs.existsSync(OWN);
const SHARED = BRANDED ? path.join(TALK, "_shared") : path.join(TALKS, "_shared");
const SHARED_URL = BRANDED ? `/talks/${SLUG}/_shared/` : "/talks/_shared/";
const FONTS = path.join(OUT, "assets", "fonts");
const TOKENS = path.join(OUT, "css", "tokens.css");

const META = new Set(["brief.json", "checks.json", "prompt.done.txt", "reference.png"]);   // editor files, never published
const TEXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);
const IMAGES = new Set([".png", ".jpg", ".jpeg"]);
const REF = /\/(?:public|deck)\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-]/g;   // absolute paths in Keystone: /public/… (tool), /deck/… (deck); not ending with "." (end of a sentence)

// Point Keystone's absolute paths at the published folders; images become WebP (web addresses and Ultra HDR stay as they are).
function rewrite(text) {
  return (BRANDED ? text : text
    .replace(/(?<=["'(])\/public\/fonts\//g, "/assets/fonts/")
    .replace(/(?<=["'(])\/public\/tokens\.css/g, "/css/tokens.css"))
    .replace(/(?<=["'(])\/public\//g, SHARED_URL)
    .replace(/(?<=["'(])\/deck\//g, `/talks/${SLUG}/`)
    .replace(/(?<=["'(])\/slides\//g, `/talks/${SLUG}/slides/`)
    .replace(/([^"'()\s`]*)\.(?:png|jpe?g)\b/g, (m, stem) => stem.includes("//") || stem.endsWith(".uhdr") ? m : `${stem}.webp`);
}

// Links to other decks: <a … href="deck:<id>#<n>" …>text</a> → that talk's page (slide n), opened in the whole window.
// A deck that is not published, or published with "listed": false, cannot be reached: the link becomes a <span>.
const listed = (file, base) => (readJSON(file)?.decks || []).map(d => path.resolve(base, d.dir));
const DECKS = Object.fromEntries([...listed(path.join(ROOT, "keystone.json"), ROOT), ...listed(path.join(ROOT, "decks", "keystone.json"), path.join(ROOT, "decks"))]
  .map(dir => [path.basename(dir), readJSON(path.join(dir, "deck.json"))?.publish]));
const deployed = () => new Set((readJSON(path.join(TALKS, "index.json"))?.talks || []).map(t => t.slug));
function deckLinks(fragment, id) {
  return fragment.replace(/<a\b([^>]*?)\shref="deck:([\w-]+)(#\d+)?"([^>]*)>([\s\S]*?)<\/a>/g, (m, pre, target, slide = "", post, text) => {
    const tp = DECKS[target];
    if (!tp?.slug || tp.listed === false) {
      console.warn(`  ${id}: link to deck "${target}" removed (${!tp ? "not in keystone.json or not published" : !tp.slug ? "not published" : "unlisted"})`);
      return `<span${pre}${post}>${text}</span>`;
    }
    if (tp.slug !== SLUG && !deployed().has(tp.slug)) console.warn(`  ${id}: links to "${tp.slug}", not deployed in this folder yet`);
    return `<a${pre} href="/talks/${tp.slug}/${slide}" target="_top"${post}>${text}</a>`;
  });
}

// Same document as the server's renderSlide().
function page(id, fragment, lang) {
  const m = fragment.match(/^\s*<!--\s*body:\s*([\w\s-]+?)\s*-->/);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">\n<base href="/talks/${SLUG}/slides/${id}/">\n` +
    `<meta name="viewport" content="width=1280">\n<link rel="stylesheet" href="${SHARED_URL}theme.css">\n` +
    `<script src="${SHARED_URL}components/display.js"></script>\n` +
    `</head><body class="sa-slide${m ? " " + m[1] : ""}">${rewrite(fragment)}</body></html>\n`;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// JPEG (photos) quality .82, PNG (logos, diagrams) quality .9; optional width.
async function toWebp(encoder, data, dst, { png = true, width = 0 } = {}) {
  write(dst, await encodeWebp(encoder, data, { mime: png ? "image/png" : "image/jpeg", width, quality: png ? 0.9 : 0.82 }));
}

// ---- Export ----

async function exportTalk(encoder) {
  fs.rmSync(TALK, { recursive: true, force: true });
  const order = pub.first ? deck.order.slice(deck.order.indexOf(pub.first)) : deck.order;
  const skip = new Set(pub.skip || []);
  const slides = [];
  const refs = new Set(["/public/theme.css", "/public/components/display.js"]);   // every slide page links them (page())

  // ref: the file's own /public/… or /deck/… path, so relative imports in modules (import … from "./x.js") are followed.
  async function copy(src, dst, ref) {
    const ext = path.extname(src).toLowerCase();
    if (TEXT.has(ext)) {
      const text = fs.readFileSync(src, "utf8");
      for (const r of text.match(REF) || []) refs.add(r);
      if (ref && (ext === ".js" || ext === ".mjs"))
        for (const [, rel] of text.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) refs.add(path.posix.join(path.posix.dirname(ref), rel));
      write(dst, rewrite(text));
    } else if (IMAGES.has(ext) && !src.endsWith(".uhdr.jpg")) {   // Ultra HDR keeps its gain map: copied as is
      await toWebp(encoder, fs.readFileSync(src), dst.replace(/\.(png|jpe?g)$/i, ".webp"), { png: ext === ".png" });
    } else {
      write(dst, fs.readFileSync(src));
    }
  }

  for (const id of order) {
    if (skip.has(id)) continue;
    const src = path.join(DECK_DIR, "slides", id);
    if (!fs.existsSync(path.join(src, "slide.html"))) { console.warn(`  skipped ${id}: no slide.html (not styled yet)`); continue; }
    slides.push(id);
    const source = fs.readFileSync(path.join(src, "slide.html"), "utf8");
    for (const lang of LANGS) {
      const tr = lang !== SOURCE_LANG ? readTranslation(src, lang) : null, { html: fragment, missing } = translate(source, tr);
      if (lang !== SOURCE_LANG && !tr) console.warn(`  ${id}: no slide.${lang}.json, ${lang} shows the ${SOURCE_LANG} slide`);
      if (missing.length) console.warn(`  ${id}: slide.${lang}.json is outdated (${missing.length} text(s) no longer in slide.html, shown in ${SOURCE_LANG})`);
      for (const r of fragment.match(REF) || []) refs.add(r);
      write(path.join(TALK, "slides", id, `${lang}.html`), page(id, deckLinks(fragment, id), lang));
    }
    for (const f of fs.readdirSync(src, { withFileTypes: true })) {
      if (f.isFile() && !META.has(f.name) && !/^slide(\.\w+)?\.html$|^slide\.\w+\.json$/.test(f.name)) await copy(path.join(src, f.name), path.join(TALK, "slides", id, f.name));
    }
  }
  if (!slides.length) throw new Error("No styled slide to publish");

  // The reader: every file of public/reader/ but its page template, which becomes the talk's index.html below.
  const template = fs.readFileSync(publicFile("reader/talk.html"), "utf8");
  for (const r of template.match(REF) || []) refs.add(r);
  const files = [READER, path.join(OVERLAY, "reader"), path.join(OWN, "reader")].flatMap(d => fs.existsSync(d) ? fs.readdirSync(d) : []);
  for (const f of new Set(files)) if (f !== "talk.html") refs.add(`/public/reader/${f}`);

  // Copy what the slides use, following references inside copied css/js until nothing new appears.
  const done = new Set();
  for (let ref; (ref = [...refs].find(r => !done.has(r))); ) {
    done.add(ref);
    const [, kind, rel] = ref.match(/^\/(public|deck)\/(.+)$/);
    let src, dst;
    if (kind === "public") {
      src = publicFile(rel);
      dst = BRANDED ? path.join(SHARED, rel) : rel.startsWith("fonts/") ? path.join(FONTS, rel.slice(6)) : rel === "tokens.css" ? TOKENS : path.join(SHARED, rel);
    } else {
      src = path.join(DECK_DIR, rel);
      dst = path.join(TALK, rel);
    }
    if (fs.statSync(src, { throwIfNoEntry: false })?.isFile()) await copy(src, dst, ref);
    else console.warn(`  missing: ${ref}`);
  }

  const info = { title: pub.title || deck.titleEn || deck.title, description: pub.description || "", author: pub.author || "",
    event: pub.event || "", date: pub.date || "", requires: pub.requires || "", languages: LANGS, slides };
  write(path.join(TALK, "talk.json"), JSON.stringify(info, null, 2) + "\n");

  const fields = { ...Object.fromEntries(Object.entries(info).map(([k, v]) => [k, esc(v)])), slug: SLUG, lang: LANGS[0], url: URL_BASE,
    site: esc(SITE.name || "Keystone"), railPrefix: esc(SITE.railPrefix || "") };
  write(path.join(TALK, "index.html"), rewrite(template).replace(/\$(\w+)/g, (m, k) => k in fields ? fields[k] : m));
  return info;
}

// ---- Thumbnails: each published slide at rest, served from <out> ----

const SETTLE = `(async () => {
  document.body.classList.add("sa-active");
  dispatchEvent(new CustomEvent("sa:enter", { detail: { dir: 1 } }));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(2000);
  for (let i = 0; i < 30 && window.saNext?.(); i++) await wait(1000);
  await wait(600);
})()`;

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
  ".mp4": "video/mp4", ".webm": "video/webm", ".gif": "image/gif", ".jpg": "image/jpeg" };

function serve() {
  const server = http.createServer((req, res) => {
    let file = path.join(OUT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = path.join(file, "index.html");
    if (!file.startsWith(path.resolve(OUT)) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

async function shoot(chrome, encoder, info) {
  const server = await serve();
  const port = server.address().port;
  const cover = pub.cover && info.slides.includes(pub.cover) ? pub.cover : info.slides[0];
  const jobs = info.slides.flatMap(id => LANGS.map(lang => ({ id, lang })));
  let next = 0;
  async function worker() {
    const tab = await chrome.newPage();
    for (let job; (job = jobs[next++]); ) {
      const url = `http://127.0.0.1:${port}/talks/${SLUG}/slides/${job.id}/${job.lang}.html`;
      await tab.send("Page.navigate", { url });
      const loaded = `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`;
      for (let i = 0; i < 150 && !(await tab.evaluate(loaded)); i++) await sleep(100);
      await tab.evaluate(SETTLE);
      const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
      const png = Buffer.from(data, "base64");
      await toWebp(encoder, png, path.join(TALK, "slides", job.id, `thumb-${job.lang}.webp`), { width: 400 });
      if (job.id === cover && job.lang === LANGS[0]) {
        await toWebp(encoder, png, path.join(TALK, "cover.webp"), { width: 960 });
        const og = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 85, clip: { x: 0, y: 0, width: 1280, height: 672, scale: 1 } });
        write(path.join(TALK, "og.jpg"), Buffer.from(og.data, "base64"));
      }
    }
    await tab.close();
  }
  try { await Promise.all([worker(), worker(), worker(), worker()]); } finally { server.close(); }
  console.log(`  ${jobs.length} thumbnails`);
  return cover;
}

// ---- Talk list: talks/index.json keeps every talk deployed to <out>, in deploy order ----

function updateIndex(info) {
  const file = path.join(TALKS, "index.json");
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { talks: [] };
  const entry = { slug: SLUG, title: info.title, description: info.description, author: info.author, event: info.event,
    date: info.date, languages: info.languages, slides: info.slides.length, cover: `/talks/${SLUG}/cover.webp` };
  const i = list.talks.findIndex(t => t.slug === SLUG);
  if (pub.listed === false) { if (i >= 0) list.talks.splice(i, 1); }   // unlisted: reachable by its address only
  else if (i < 0) list.talks.push(entry); else list.talks[i] = entry;
  write(file, JSON.stringify(list, null, 2) + "\n");
}

const chrome = await launchChrome();
try {
  const encoder = await chrome.newPage();
  console.log(`${SLUG}: ${DECK_DIR} → ${TALK}`);
  const info = await exportTalk(encoder);
  await shoot(chrome, encoder, info);
  updateIndex(info);
  const size = fs.readdirSync(TALK, { recursive: true }).reduce((n, f) => n + (fs.statSync(path.join(TALK, f)).isFile() ? fs.statSync(path.join(TALK, f)).size : 0), 0);
  console.log(`${SLUG}: ${info.slides.length} slides, ${LANGS.length} languages, ${(size / 1e6).toFixed(1)} MB`);
} finally {
  chrome.close();
}
