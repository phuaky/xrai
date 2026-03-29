# xrai

X-ray your Twitter/X feed with local AI. Noise disappears. Signal stays.

**Everything runs on your machine.** No cloud APIs. No accounts. No data leaves your computer.

## What it does

A Chrome extension that classifies every tweet in your feed as **signal** (worth reading) or **noise** (skip) using a local AI model via [Ollama](https://ollama.ai). Noise tweets are hidden instantly. You never see the same content twice.

When you find a signal tweet worth replying to, xrai generates reply suggestions that you **copy-paste manually** — zero automation, zero bot behavior.

## How it works

```
Tweet appears → Already seen? → HIDE
                     ↓ new
              Obvious spam/bait? → HIDE (regex, instant)
                     ↓ passes
              On screen 500ms? → classify with local AI
                     ↓
              Signal (score 4-5/5) → SHOW
              Noise  (score 0-3/5) → HIDE
```

**5-dimension scoring** (each 0 or 1):
- **Novelty** — New info or recycled take?
- **Specificity** — Concrete details or vague claims?
- **Density** — High insight-to-word ratio?
- **Authenticity** — Genuine sharing or engagement farming?
- **Actionable** — Can you learn/use/apply this?

## Setup

### 1. Install Ollama

Download from [ollama.ai](https://ollama.ai). On Mac, it auto-starts on login.

### 2. Pull a model

```bash
ollama pull gemma2:2b    # recommended: 93% accuracy, 210ms, 1.6GB
```

**Benchmarked models** (on 45 real tweets, Apple Silicon):

| Model | Accuracy | Speed | Size |
|-------|----------|-------|------|
| `gemma2:2b` | **93%** | **210ms** | 1.6 GB |
| `phi4-mini` | 91% | 285ms | 2.5 GB |

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Go to [x.com](https://x.com) and scroll

### 4. Look for the indicator

A small pill appears in the bottom-right corner:

```
xrai: 12 shown | 31 hidden | local ●
```

Click the gear icon to adjust settings (model, aggressiveness, hide method).

## Features

- **Local-first** — All AI runs on your machine via Ollama
- **Content memory** — Never see the same tweet twice across sessions
- **Pre-filter** — Regex catches obvious noise instantly (NSFW, spam, clickbait) before the model
- **Viewport-aware** — Only classifies tweets you actually look at (saves compute)
- **Reply generation** — Copy-paste only, never auto-posts
- **Rate limited** — 20 model calls/min max, debounced DOM observer
- **Self-improving** — Correction tracking + meta-learning script

## Self-improving filters

xrai tracks when you disagree with its classification. After ~200 corrections, run the improve script:

```bash
# Export corrections from extension (in Chrome DevTools console):
# chrome.storage.local.get('xrai_corrections', r => copy(JSON.stringify(r.xrai_corrections)))

# Analyze and generate improvements:
node scripts/improve.js corrections.json
```

This generates a prompt you can pipe to `claude -p` to get updated regex patterns and prompt adjustments.

## X Terms of Service

xrai is designed to comply with X's ToS:

- **No API access** — Only reads DOM elements already rendered in your browser
- **No automation** — Never clicks buttons, submits forms, or triggers actions
- **No scraping** — Processes only tweets visible in your current session
- **Replies are copy-paste** — Generated text is copied to clipboard, you paste manually
- **CSS-only hiding** — Same mechanism as ad blockers

## Project structure

```
xrai/
├── extension/
│   ├── manifest.json        # Chrome Manifest V3
│   ├── content/
│   │   ├── detector.js      # Tweet detection (MutationObserver)
│   │   ├── prefilter.js     # Regex instant noise filter
│   │   ├── viewport.js      # Only classify visible tweets
│   │   ├── classifier.js    # Ollama batch queue
│   │   ├── hider.js         # Hide/blur noise tweets
│   │   ├── reply.js         # Reply generation (copy-paste)
│   │   ├── indicator.js     # Status pill UI
│   │   ├── main.js          # Orchestrator
│   │   └── styles.css
│   ├── lib/
│   │   ├── memory.js        # Content fingerprint store (IndexedDB)
│   │   ├── ollama.js        # Ollama API client
│   │   └── config.js        # User preferences
│   └── background/
│       └── worker.js        # Service worker (Ollama proxy)
├── scripts/
│   └── improve.js           # Meta-learning script
├── benchmarks/
│   └── benchmark.js         # Model speed/accuracy tests
└── SPEC.md                  # Full architecture spec
```

## License

MIT
