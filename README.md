# rai

Filter your feeds with local AI. One Chrome extension, two platforms:

- **X / Twitter** — noise disappears, signal stays.
- **YouTube** — everything blurs except **music** and **motivational** videos.

**Local-first by default.** Ollama handles inference on your machine with no account required. Optional cloud mode routes text classification through `api.snratio.xyz` only when explicitly enabled; X semantic memory, embeddings, and contextual filtering remain local.

## What it does

**On X:** stage 1 classifies every tweet as **signal** (worth reading) or **noise** (skip). Noise disappears immediately. Signal appears immediately, then an asynchronous memory pass compares it with up to five locally stored tweets and quietly collapses strong-known repeats or value-free funnels. New information, meaningful updates, critical content, weakly known matches, and low-confidence verdicts always stay visible. Every contextual collapse has a one-click reveal.

On your own X status pages, the **reply guard** blurs high-confidence hostile, bot, or spam replies while leaving criticism and disagreement visible. The optional vision check can screen photos for thirst-trap/bait imagery, but it remains off by default while a labeled image eval set is built.

**On YouTube:** classifies every video by its **title + channel** as `music`, `motivational`, or `other`, and **blurs everything that isn't music or motivational**. For when you open YouTube to listen to music but keep getting pulled into videos. The optional vision check can also screen thumbnails. Hit "👁 Show" on any blurred card to reveal it.

## How it works

```
Tweet appears → Reply? (posts-only mode) → HIDE
                     ↓ not a reply
              Tech/AI safelist + deterministic noise prefilter
                     ↓ passes
              Exact-result cache → otherwise stage-1 classifier
                     ↓
              Noise → REMOVE
              Signal → SHOW immediately
                          ↓ asynchronous, local-only
                   Embed current tweet
                          ↓
                Retrieve top 5 local memories
                          ↓
             Focused novelty / importance checks
                          ↓
                 Strict six-field verdict
                          ↓
                Deterministic action policy
                   ↙                   ↘
                SHOW          reversible COLLAPSE
```

When the optional image-bait check is enabled, a photo or thumbnail must also pass the local vision gate before it reveals. The image gate is disabled by default.

**Stage-1 scoring** (each dimension is 0 or 1):
- **Novelty** — New information or a recycled take?
- **Specificity** — Concrete details or vague claims?
- **Density** — High insight-to-word ratio?
- **Authenticity** — Genuine sharing or engagement farming?

## Memory-aware X filtering

Stage 2 answers a different question from stage 1: not merely "is this good?", but "is this still worth your attention given what you have already seen?"

- **Reveal first** — Stage-1-kept tweets render before memory work begins. The slower contextual pass never blocks the feed.
- **Bounded local retrieval** — `all-minilm:latest` embeds the current tweet and retrieves at most five similar records from the separate local `xrai_knowledge` IndexedDB database. The full history is never put into a runtime prompt.
- **Evidence-based familiarity** — A prior tweet is `strong` knowledge only after at least 1,000ms of active dwell or an exact direct status-page open. Merely showing a tweet is weak evidence; hidden content does not become known.
- **Model judges meaning, code decides action** — The production X model returns only `importance`, `novelty`, `funnelRisk`, `standaloneValue`, `confidence`, and `reason`. Deterministic policy code computes `knownState` and the final `show`/`collapse` action.
- **Conservative collapse** — Critical content, new signals, meaningful updates, low-confidence verdicts, and matches supported only by weak/unknown exposure always show. Strong-known repeats and reinforcements, plus non-critical value-free funnels, may collapse.
- **Recoverable and interruptible** — Every collapse has a one-click reveal. A late collapse is suppressed after 1,000ms of active dwell, and the **Collapse familiar posts** setting is a live rollback toggle.
- **Fail-open** — Storage, embedding, retrieval, messaging, timeout, model, or parser failures leave the tweet visible.
- **Local even in cloud mode** — Optional cloud mode can handle stage-1 text classification, but embeddings and all memory-aware classification still use local Ollama.

The prompt suite was evaluated offline against 5,229 real X records and 102 disjoint chronological scenarios, judged with GPT-5.6 Luna at high reasoning. Luna is evaluation tooling only: it is never called by the extension at runtime. The production sequence gate passed with 100% critical-signal recall, 96.36% show retention, 82.22% strong-known collapse recall, and a 3.64% false-collapse rate.

**Historical-memory note:** `benchmarks/seed-memory-x.js` currently verifies complete and idempotent import in an isolated IndexedDB. It does not backfill the installed Chrome profile's live `xrai_knowledge` database, so after reloading the extension, live semantic memory grows from newly processed tweets.

## YouTube: music-only mode

```
Video card appears (home / subscriptions / watch sidebar)
        ↓
  Obvious music? ("Official Video", "feat.", "- Topic", VEVO, lofi…) → SHOW (instant, regex)
  Obvious motivational? ("motivation", "discipline", Goggins…)       → SHOW (instant, regex)
        ↓ not obvious
  Blur immediately → Ollama classifies title+channel
        ↓
  music / motivational → SHOW, or image bait check when enabled
        ↓                        ↓
  other → stays BLURRED    bait → stays BLURRED ("AI: bait-thumbnail")
  ("👁 Show" to peek)       clean → SHOW (♪ music / 💪 motivation badge)
```

- **Scoped** to the home feed, subscriptions, and the watch-page "up next" sidebar — the surfaces that distract you. The video you're actually watching, search results, and channel pages are left alone.
- **Default model** `gemma2:2b` (fast — titles are short and the regex prefilter handles obvious music, so the model only sees ambiguous cases).
- **Keep motivational** is a toggle in settings (on by default). Turn it off for music only.
- **Fail-open** — if Ollama is down, nothing is blurred (YouTube stays usable).

## Image bait check

When enabled, photos on X and thumbnails on YouTube get one more gate before they reveal: a
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
- Toggle: **Image bait check** in the ⚙ settings popup (off by default).
  Model + confidence threshold: `imageModel` / `imageConfidenceThreshold` in
  config (default `qwen3-vl:30b` @ 0.6).
- Live telemetry through August 5, 2026 found 1,626 checks, zero bait verdicts,
  p50 4.8s, and p95 16.0s. The gate now fails open after 8 seconds and remains
  opt-in until labels support a real accuracy eval.
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

### 2. Pull the models

```bash
ollama pull dhiltgen/gemma4:e2b-mlx-bf16  # X stage 1 + memory-aware verdicts
ollama pull all-minilm:latest              # X semantic-memory embeddings
ollama pull gemma2:2b                      # YouTube title + channel classifier
```

Optional image-bait filtering additionally requires `ollama pull qwen3-vl:30b`. The extension settings expose the active models, but changing a production model should be followed by its corresponding regression eval.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Go to [x.com](https://x.com) and scroll

> **macOS:** After a reboot, Ollama (launched as a Login Item) does not inherit the `OLLAMA_ORIGINS` env var, so the extension gets **HTTP 403** and falls back to prefilter-only. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the one-time LaunchAgent fix that makes it persist across reboots.

### 4. Start the data collector (optional)

Every decision is already written to a durable, append-only IndexedDB log in the browser. The collector adds a best-effort local JSONL mirror for analysis:

```bash
node scripts/collector.js              # listens on localhost:11435
node scripts/collector.js --improve    # also analyzes every 200 new X decisions
```

The current streams are `data/events-x.jsonl`, `data/events-youtube.jsonl`, and `data/model-io.jsonl`. Events flush in small batches and on tab close. If the collector is unavailable, filtering and the browser's durable log continue normally.

## Features

- **Local-first** — Ollama is the default; cloud text classification is optional and explicit
- **Memory-aware X filter** — Top-five semantic retrieval collapses only deterministic, high-confidence cases after reveal
- **Tech-focused stage 1** — Tuned for AI engineers and entrepreneurs, with tech/AI safelisting
- **Result cache** — Revisiting a card applies its exact cached result without another classification
- **High-precision prefilters** — Obvious X noise and obvious YouTube keeps resolve instantly
- **Low-latency scheduling** — Stage-1 work takes priority over the asynchronous memory queue
- **Reply guard** — Bad-faith, bot, and spam replies on your own X threads blur with one-click peek
- **Recoverable filtering** — Contextual X collapses and YouTube blurs always have a reveal control
- **Fail-open runtime** — Local service, storage, parser, and messaging failures preserve content
- **Attention ledger** — Records actual X dwell and foreground YouTube watch time, not merely impressions
- **Workflow-tip ledger** — Captures actionable practices from X for later review
- **Interruption nudges** — Detects X↔YouTube hopping and configurable YouTube Shorts binges
- **Offline regression system** — Golden sets, live audits, sequence evals, and latency gates protect recall

## Local data and evaluation

Classification decisions, memory verdicts, dwell/watch events, peeks, tips, hops, and Shorts activity are stored locally. Use **⬇ Export log** in the extension settings to download a platform's full durable log. The optional collector mirrors those events into `data/` for CLI analysis.

The event log records whether a decision came from a deterministic prefilter or a model. Prompt studies should filter to `source: "model"`; cache replays are not re-logged.

### Running tests, benchmarks, and audits

```bash
# Fast test suite
bun test

# Canonical production-pipeline regression gates (requires Ollama)
bun run eval:x
bun run eval:youtube

# Memory novelty and full chronological-sequence gates
bun run eval:x:memory-novelty
bun run audit:x:corpus -- report \
  --out data/luna-audit-x-gpt-5.6-luna

# Burst latency on recent live X traffic
bun run bench:x:live -- --since 2026-07-23 --sample 24

# Prepare a stratified offline audit of recent decisions
bun run audit:x -- prepare --since 2026-07-23
```

Changing the production prompt, prefilter, model, or confidence threshold requires its canonical eval. Bless a new baseline only for an intentional, reviewed behavior change.

## X Terms of Service

xrai is designed to comply with X's ToS:

- **No API access** — Only reads DOM elements already rendered in your browser
- **No automation** — Never clicks buttons, submits forms, or triggers actions
- **No scraping** — Processes only posts and video cards already rendered in your current session
- **No posting** — Never generates or sends replies, likes, follows, or other site actions
- **CSS-only filtering** — Hides, blurs, or collapses existing DOM cards, like an ad blocker

## Project structure

```
xrai/                               # repo name is historical; extension is "rai"
├── extension/
│   ├── manifest.json               # Chrome MV3; X + YouTube content scripts
│   ├── background/
│   │   └── worker.js               # Platform-routed Ollama/cloud proxy + prompt suite
│   ├── lib/
│   │   ├── config.js               # Per-platform preferences and migrations
│   │   ├── memory.js               # Durable event ledger, stats, and collector mirror
│   │   ├── knowledge.js            # X semantic-memory IndexedDB + top-five retrieval
│   │   └── hops.js                 # Pure X↔YouTube loop detection
│   └── content/
│       ├── core/                    # Shared classifier, hider, indicator, dwell, nudges
│       ├── x/
│       │   ├── detector.js         # Tweet detection and SPA rescans
│       │   ├── prefilter.js        # High-precision noise filter + reply prefilter
│       │   ├── replyroute.js       # Own-thread reply-guard routing and immunity
│       │   ├── memorypass.js       # Async retrieval, fail-open policy, dwell suppression
│       │   └── main.js             # Stage 1 reveal + asynchronous memory pass
│       └── youtube/                 # Feed filter, Shorts tracker, and watch ledger
├── scripts/
│   ├── collector.js                # Optional local event mirror (port 11435)
│   ├── digest.js                   # Daily attention digest
│   └── tips.js                     # Workflow-tip ledger CLI
├── benchmarks/
│   ├── eval-x.js                   # Canonical X stage-1 regression gate
│   ├── eval-memory-novelty-x.js    # Memory policy/prompt regression gate
│   ├── full-corpus-audit-x.js      # Provenance-bound Luna + sequence evaluation
│   ├── seed-memory-x.js            # Isolated historical-import verification
│   └── bench-memory-pass-x.js      # End-to-end contextual-pass latency replay
├── tests/                           # Bun + happy-dom regression suite
├── data/                            # Local logs and audit artifacts (gitignored)
├── ISA.md                           # 52/52 verified memory-filter ideal state
└── CLAUDE.md                        # Repository operating instructions
```

## License

MIT
