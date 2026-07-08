# rai

Filter your feeds with local AI. One Chrome extension, two platforms:

- **X / Twitter** — noise disappears, signal stays.
- **YouTube** — everything blurs except **music** and **motivational** videos.

**Everything runs on your machine.** No cloud APIs. No accounts. No data leaves your computer.

## What it does

**On X:** classifies every tweet as **signal** (worth reading) or **noise** (skip) using a local AI model via [Ollama](https://ollama.ai). Noise tweets are hidden instantly. Signal tweets with a photo get one more check — a vision model screens for thirst-trap/bait imagery before the tweet reveals (see [Image bait check](#image-bait-check)). For signal tweets worth replying to, rai generates reply suggestions you **copy-paste manually** — zero automation.

**On YouTube:** classifies every video by its **title + channel** as `music`, `motivational`, or `other`, and **blurs everything that isn't music or motivational**. For when you open YouTube to listen to music but keep getting pulled into videos. Music/motivational thumbnails get the same vision-model bait check as X before they reveal. Hit "👁 Show" on any blurred card to reveal it.

## How it works

```
Tweet appears → Reply? (posts-only mode) → HIDE
                     ↓ not a reply
              Has tech/AI keywords? → pass to AI (safelist)
                     ↓ no
              Obvious spam/bait? → HIDE (regex, instant)
              Entertainment/video? → HIDE (prefilter)
                     ↓ passes
              Already classified? → apply cached result
                     ↓ cache miss
              Ollama AI (up to 5 concurrent) → signal or noise
                     ↓
              Noise (score 0-2/4) → HIDE
              Signal (score 3-4/4), no photo → SHOW
              Signal (score 3-4/4), has photo → blur, image bait check
                     ↓
              Bait image  → HIDE ("AI: bait image")
              Clean image → SHOW
```

**4-dimension scoring** (each 0 or 1):
- **Novelty** — New info or recycled take?
- **Specificity** — Concrete details or vague claims?
- **Density** — High insight-to-word ratio?
- **Authenticity** — Genuine sharing or engagement farming?

## YouTube: music-only mode

```
Video card appears (home / subscriptions / watch sidebar)
        ↓
  Obvious music? ("Official Video", "feat.", "- Topic", VEVO, lofi…) → SHOW (instant, regex)
  Obvious motivational? ("motivation", "discipline", Goggins…)       → SHOW (instant, regex)
        ↓ not obvious
  Blur immediately → Ollama classifies title+channel
        ↓
  music / motivational → image bait check (thumbnail)
        ↓                        ↓
  other → stays BLURRED    bait → stays BLURRED ("AI: bait-thumbnail")
  ("👁 Show" to peek)       clean → SHOW (♪ music / 💪 motivation badge)
```

- **Scoped** to the home feed, subscriptions, and the watch-page "up next" sidebar — the surfaces that distract you. The video you're actually watching, search results, and channel pages are left alone.
- **Default model** `gemma2:2b` (fast — titles are short and the regex prefilter handles obvious music, so the model only sees ambiguous cases).
- **Keep motivational** is a toggle in settings (on by default). Turn it off for music only.
- **Fail-open** — if Ollama is down, nothing is blurred (YouTube stays usable).

## Image bait check

Photos on X and thumbnails on YouTube get one more gate before they reveal: a
local vision model ([`qwen3-vl:30b`](https://ollama.com/library/qwen3-vl), a
MoE model — ~19GB resident but faster once warm than the smaller dense
variants) screens for thirst-trap/bait imagery — sexualized framing used to
bait clicks, unrelated to the actual content. Fully clothed fitness/workout
content is explicitly **not** treated as bait, so legitimate motivational
videos still get through.

- Only runs on candidates that would otherwise be revealed (signal tweets
  with a photo; music/motivational-classified thumbnails) — text-only
  content and anything already hidden skips this entirely, so it costs
  nothing on the common path.
- Blur-then-reveal on both platforms — a bait image never flashes on screen
  while the model is still thinking.
- Toggle: **Image bait check** in the ⚙ settings popup (on by default).
  Model + confidence threshold: `imageModel` / `imageConfidenceThreshold` in
  config (default `qwen3-vl:30b` @ 0.6).
- **Golden-set labeling** — every image the check runs on gets two small
  buttons (🔞 bait / ✅ safe) so real examples accumulate from ordinary
  scrolling. Labels write to the same durable event log as everything else
  (`kind: "image-label"`) — export via ⬇ Export log in settings. This is
  what eventually grounds a proper accuracy eval for the image model, the
  same way `benchmarks/golden-x.json` grounds the text classifier today (no
  such golden set exists yet for images).
- Requires pulling the model once: `ollama pull qwen3-vl:30b`.

## Setup

> **Fastest path: [INSTALL.md](INSTALL.md)** — `bash scripts/setup.sh` handles
> Ollama, the CORS fix, model download, and a live end-to-end test. The manual
> steps below still work.

### 1. Install Ollama

Download from [ollama.ai](https://ollama.ai). On Mac, it sits in the menubar and auto-starts on login.

### 2. Pull a model

```bash
ollama pull phi4-mini    # recommended: 92% accuracy, 518ms, 2.5GB — best accuracy
ollama pull gemma2:2b    # backup: 88% accuracy, 231ms, 1.6GB — fastest
```

**Benchmarked models** (89 real tweets, Apple Silicon):

| Model | Accuracy | Speed | Size |
|-------|----------|-------|------|
| `phi4-mini` | **92%** | 518ms | 2.5 GB |
| `gemma2:2b` | 88% | **231ms** | 1.6 GB |

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Go to [x.com](https://x.com) and scroll

> **macOS:** After a reboot, Ollama (launched as a Login Item) does not inherit the `OLLAMA_ORIGINS` env var, so the extension gets **HTTP 403** and falls back to prefilter-only. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the one-time LaunchAgent fix that makes it persist across reboots.

### 4. Start the data collector (optional)

The extension logs every classification. To save this data to your local machine for improving filters:

```bash
node scripts/collector.js              # saves to data/classifications.jsonl
node scripts/collector.js --improve    # also auto-runs improve script every 200 entries
```

The collector runs on `localhost:11435`. The extension auto-sends every 100 classifications. If the collector isn't running, no problem — the extension works fine without it.

## Features

- **Local-first** — All AI runs on your machine via Ollama. No cloud, no API keys
- **Tech-focused** — Tuned for AI engineers and entrepreneurs. Tech/AI tweets safelisted
- **Result cache** — Scroll back up? Cached result applied instantly, no re-classification
- **Pre-filter** — 11 regex categories catch obvious noise instantly: NSFW, spam, engagement bait, clickbait, entertainment, crypto pumps, short-video/image, ultra-short text
- **Concurrent classification** — Up to 5 Ollama calls in parallel, every tweet gets classified
- **Reply generation** — Copy-paste only, never auto-posts
- **Rate limited** — 20 model calls/min max, debounced DOM observer
- **Self-improving** — Classification data collected automatically, feeds into improvement pipeline

## Data Collection & Self-Improving Filters

xrai automatically logs every classification decision (tweet text, media type, prediction, confidence, source).

### Automatic pipeline

```bash
# 1. Start the collector (runs alongside the extension)
node scripts/collector.js --improve

# 2. Browse x.com normally
#    Extension auto-sends data every 100 tweets

# 3. At 200 new entries, collector auto-runs improve analysis
#    Output: patterns in misclassifications + suggested regex/prompt fixes
```

### Manual pipeline

```bash
# Export from Chrome DevTools console on x.com:
chrome.storage.local.get('xrai_classifications', r => copy(JSON.stringify(r.xrai_classifications)))

# Save to file and analyze:
node scripts/improve.js classifications.json

# Pipe to Claude for AI-generated improvements:
node scripts/improve.js classifications.json | claude -p
```

### Data format

Classifications stored as JSONL in `data/classifications.jsonl`:

```json
{"text":"Just shipped a feature...","mediaType":"text","prediction":"signal","confidence":0.92,"source":"model","timestamp":1743282000}
{"text":"this is so good 😂","mediaType":"video","prediction":"noise","confidence":0.80,"source":"prefilter:short-video-non-tech","timestamp":1743282001}
```

### Running benchmarks

```bash
# Test model accuracy on 45 labeled tweets
node benchmarks/benchmark.js
```

## X Terms of Service

xrai is designed to comply with X's ToS:

- **No API access** — Only reads DOM elements already rendered in your browser
- **No automation** — Never clicks buttons, submits forms, or triggers actions
- **No scraping** — Processes only tweets visible in your current session
- **Replies are copy-paste** — Generated text is copied to clipboard, you paste manually
- **CSS-only hiding** — Same mechanism as ad blockers

## Project structure

```
xrai/                          # repo (named for history; extension is "rai")
├── extension/
│   ├── manifest.json          # Chrome MV3 — 2 content_script blocks (x.com, youtube.com)
│   ├── content/
│   │   ├── core/              # SHARED across both platforms
│   │   │   ├── classifier.js  # Concurrent queue (max 5) + result cache
│   │   │   ├── image-classifier.js  # Small queue (max 2) for the image bait check
│   │   │   ├── hider.js       # Hide/blur/collapse + peek/wrong/label buttons
│   │   │   ├── indicator.js   # Status pill + per-platform settings
│   │   │   └── styles.css
│   │   ├── x/                 # X-specific
│   │   │   ├── detector.js    # Tweet detection (MutationObserver)
│   │   │   ├── prefilter.js   # Regex noise filter + tech safelist
│   │   │   ├── reply.js       # Reply generation (copy-paste only)
│   │   │   └── main.js        # Pipeline: hide noise, keep signal
│   │   └── youtube/           # YouTube-specific
│   │       ├── detector.js    # Video-card detection (recycle-aware)
│   │       ├── prefilter.js   # Regex KEEP for obvious music/motivational
│   │       └── main.js        # Inverted pipeline: blur all, reveal music
│   ├── lib/
│   │   ├── memory.js          # Per-platform stats/log + IndexedDB (RaiMemory)
│   │   └── config.js          # Per-platform preferences (RaiConfig)
│   └── background/
│       └── worker.js          # Service worker — platform-routed Ollama proxy
├── scripts/
│   ├── collector.js           # Local data collector (port 11435)
│   └── improve.js             # Meta-learning analysis (X)
├── benchmarks/benchmark.js    # X model speed/accuracy tests
├── data/                      # Local classification data (gitignored)
├── SPEC.md                    # Architecture spec (X)
└── CLAUDE.md                  # Dev instructions for AI assistants
```

## License

MIT
