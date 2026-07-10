# Chrome Web Store listing — rai

Existing listing to update in place: `hdjhnmflmgfimgnpbngojcjfpmkcjmlk`
(currently "Signal/Noise Ratio" v1.0.1 — outdated, 2 installs, replace don't recreate)

## Name
rai — Local AI Feed Filter

## Category
Productivity

## Short description (132 char max)
Local-AI feed filter for X and YouTube. Signal stays, noise fades — no cloud, no account. Free cloud mode if you skip local setup.
(127 chars incl. spaces — trim if the console counts differently)

## Long description

**rai — your feed, without the noise.**

A Chrome extension that filters X (Twitter) and YouTube using a small AI model — by
default, one that runs entirely on your own machine.

**On X:** every tweet is classified as signal (worth reading) or noise (skip). Noise
hides instantly. Signal tweets get one-tap AI reply suggestions you copy-paste — rai
never posts anything for you.

**On YouTube:** every video is classified by title + channel as music, motivational,
or other — everything that isn't music or motivational blurs out. Built for when you
open YouTube to listen to music and don't want to get pulled into a rabbit hole.

**Local mode (default, free forever)**
- 100% on-device — the AI model runs on your machine via Ollama, nothing is sent
  anywhere
- No account, no login, no tracking
- One-tap correction button trains the filter from your actual mistakes
- Full data export any time

**Cloud mode (optional, free while in beta)**
- Skip the local AI setup — rai runs the model for you
- One click mints a free key — no account, no card, no subscription
- Same filtering, same privacy-respecting design — just no Ollama install required

**Measured, not vibes**
rai ships with a public, versioned accuracy eval (github.com/phuaky/xrai) — every
change to the filtering prompt is checked against a golden test set before it ships,
gated on catching real signal without letting noise through. Most feed filters don't
publish accuracy numbers. This one does.

**ToS-safe by design**
- Never calls the X or YouTube APIs
- Never posts, likes, follows, or clicks anything on your behalf
- CSS-only hiding/blurring of content already rendered on your screen

Website: https://snratio.xyz
Source: https://github.com/phuaky/xrai
Privacy: https://snratio.xyz/privacy.html

## Privacy policy URL
https://snratio.xyz/privacy.html

## Screenshots needed (1280x800px, 5 max)
1. Hero — X feed with visible signal tweets + blurred noise cards
2. YouTube home grid — blurred-except-music/motivational
3. Settings panel — Local/Cloud mode toggle, model picker, threshold slider
4. Status pill expanded — shown/hidden counts, connection status
5. Correction flow — the ✗ "you got this wrong" button on a card

## Permissions justification (for review)
- `storage`, `unlimitedStorage`: local classification cache + correction history
- Host permissions (x.com, twitter.com, youtube.com, i.ytimg.com, pbs.twimg.com):
  read already-rendered DOM content to classify it — no API calls
- `localhost:11434`/`11435`: local Ollama model + optional local data collector
- `api.snratio.xyz`: only contacted when the user opts into Cloud mode (free hosted
  classification for users without a local Ollama install)
