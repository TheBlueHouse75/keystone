<p align="center"><img src="public/assets/brand/wordmark-color.webp" alt="Keystone" width="360"></p>

# Keystone

A local deck tool for technical talks, made to work with [Claude Code](https://claude.com/claude-code). Each slide is
an HTML page (1280×720) with its own CSS and JavaScript, so it can hold a live three.js scene, a diagram that builds
step by step, or a real demo. You write what a slide must say, Claude styles it, and you correct it by drawing and
talking over your slides.

https://github.com/user-attachments/assets/6dffc607-1461-4b5a-b317-7f58a48e0627

<p align="center">
<img src="library/layouts/cover/thumb.png" width="32%" alt="Cover slide">
<img src="library/layouts/list/thumb.png" width="32%" alt="List slide">
<img src="library/components/diagram/thumb.png" width="32%" alt="Diagram slide">
</p>

## Features

- **Presenter and editor** in the browser, with live reload and an overview of every slide and deck.
- **Slides styled by Claude**: you write a brief (title, text, notes); Claude Code writes the slide from the style library.
- **Feedback by drawing and talking**: circle, point and speak over the slides; your voice is transcribed on your
  computer, and Claude turns it into tasks you can follow, answer and correct.
- **Claude auto**: Claude works on its own after each recording, and can say aloud what it did. Codex can take its
  place, per deck.
- **Style library**: brand rules, style guides, layouts and components, each with an example slide.
- **Any language**: a deck written in one language and translated into others, one HTML file per slide.
- **3D in slides**: three.js figures with studio or outdoor light, ambient occlusion and soft shadows.
- **Publishing**: a deck becomes a static, read-only talk for any website or static host.
- **Your decks and your brand stay yours**, in a folder of their own, apart from the tool.
- **macOS, Windows and Linux**, with Node 22 and nothing else to install.

## Start

```sh
git clone https://github.com/ancarmona/keystone.git
cd keystone
npm start
```

Then open <http://localhost:4320>: the guide to Keystone, a deck made with Keystone that shows how to create a deck,
write slides and work with Claude.

**Everything else is in [AGENTS.md](AGENTS.md)**: install options, decks and slides, feedback sessions, styles,
languages, 3D, publishing, tools and the API. It is written for you and for coding agents alike.

## Licence

[Apache License 2.0](LICENSE). Use, copy, change and sell Keystone and works based on it; keep the [`NOTICE`](NOTICE)
file with them, which credits Sentient Art. Third-party files: [`THIRD_PARTY.md`](THIRD_PARTY.md).

---

<p align="center">Made by <a href="https://sentient-art.xyz">Sentient Art</a><br><br>
<a href="https://sentient-art.xyz"><img src="docs/sentient-art.webp" alt="Sentient Art" width="220"></a></p>
