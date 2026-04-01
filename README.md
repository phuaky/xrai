# xrai

X-ray your Twitter/X feed with local AI. Noise disappears. Signal stays.

**Everything runs on your machine.** No cloud APIs. No accounts. No data leaves your computer.

## What it does

A Chrome extension that classifies every tweet in your feed as **signal** (worth reading) or **noise** (skip) using a local AI model via [Ollama](https://ollama.ai). Noise tweets are hidden instantly.

When you find a signal tweet worth replying to, xrai generates reply suggestions that you **copy-paste manually** — zero automation, zero bot behavior.

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
              Signal (score 3-4/4) → SHOW
              Noise  (score 0-2/4) → HIDE
```

**4-dimension scoring** (each 0 or 1):
- **Novelty** — New info or recycled take?
- **Specificity** — Concrete details or vague claims?
- **Density** — High insight-to-word ratio?
- **Authenticity** — Genuine sharing or engagement farming?

## Setup

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
xrai/
├── extension/
│   ├── manifest.json        # Chrome Manifest V3
│   ├── content/
│   │   ├── detector.js      # Tweet detection (MutationObserver, debounced)
│   │   ├── prefilter.js     # Regex noise filter (11 categories + tech safelist)
│   │   ├── classifier.js    # Concurrent queue (max 5) with result cache
│   │   ├── hider.js         # Hide/blur/collapse noise tweets
│   │   ├── reply.js         # Reply generation (copy-paste only)
│   │   ├── indicator.js     # Status pill UI
│   │   ├── main.js          # Orchestrator — flat pipeline, every tweet gets a decision
│   │   └── styles.css
│   ├── lib/
│   │   ├── memory.js        # Classification log + corrections (chrome.storage)
│   │   ├── ollama.js        # Ollama API client + classification prompt
│   │   └── config.js        # User preferences (chrome.storage.local)
│   └── background/
│       └── worker.js        # Service worker (Ollama HTTP proxy)
├── scripts/
│   ├── collector.js         # Local data collector (port 11435)
│   └── improve.js           # Meta-learning analysis script
├── benchmarks/
│   └── benchmark.js         # Model speed/accuracy tests (45 tweets)
├── data/                    # Local classification data (gitignored)
├── SPEC.md                  # Full architecture spec
└── CLAUDE.md                # Dev instructions for AI assistants
```

## License

MIT
