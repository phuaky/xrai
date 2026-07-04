# CLAUDE.md

Instructions for Claude Code when working on this repo.

## Project Overview

**rai** is a Chrome extension that filters social feeds using local AI (Ollama). One extension, two platforms, shared core:

- **X / Twitter** (`x.com`): classifies tweets as **signal** (tech/AI/startup) or **noise** (everything else) and hides noise. Generates copy-paste reply suggestions for signal tweets.
- **YouTube** (`www.youtube.com`): classifies videos by **title + channel** as `music` / `motivational` / `other`. **Blurs everything except music and motivational videos** — the inverse of X (blur-by-default, reveal-the-good). For when you open YouTube to listen to music but get distracted by videos.

The repo dir is still named `xrai` for history; the extension is `rai` (multi-platform).

## Architecture

**Chrome Extension** (Manifest V3, vanilla JS, no build step). Two `content_scripts` blocks (one per host) share the `core/` + `lib/` modules; platform-specific detection/prefilter/pipeline live in `content/x/` and `content/youtube/`.

```
extension/
  background/worker.js          # service worker — platform-routed Ollama proxy
  lib/
    config.js    → RaiConfig     # per-platform config (xrai_config / ytrai_config)
    memory.js    → RaiMemory     # per-platform stats/time/log + IndexedDB
    ollama.js                    # legacy XraiOllama client (unused, not loaded)
  content/
    core/                        # SHARED, neutral Rai* namespace
      classifier.js → RaiClassifier   # concurrent queue (max 5) + result cache, platform pass-through
      hider.js      → RaiHider        # blur / remove / collapse + peek button
      indicator.js  → RaiIndicator    # status pill + per-platform settings
      styles.css                      # tag-agnostic selectors ([data-xrai-*])
    x/                           # X-specific, Xrai* namespace
      detector.js  → XraiDetector     # tweet detection + media + text expansion
      prefilter.js → XraiPrefilter    # regex noise filter + tech safelist
      reply.js     → XraiReply         # reply generation (copy-paste only)
      main.js      → XraiMain           # pipeline: hide noise, keep signal
    youtube/                     # YouTube-specific, Ytrai* namespace
      detector.js  → YtraiDetector     # video-card detection (recycle-aware)
      prefilter.js → YtraiPrefilter    # regex KEEP for obvious music/motivational
      shorts.js    → YtraiShorts       # Shorts consumption tracker + doom-scroll nudge
      main.js      → YtraiMain           # inverted pipeline: blur all, reveal music/motivational
```

**Namespace convention:** shared core = `Rai*` (RaiConfig/RaiMemory/RaiClassifier/RaiHider/RaiIndicator). X-specific = `Xrai*`. YouTube-specific = `Ytrai*`. Internal CSS classes, `data-xrai-*` attributes, and storage prefixes (`xrai_*` for X, `ytrai_*` for YouTube) are intentionally kept — they preserve user data and keep tests green. The service worker routes by a `platform` field on every message.

**X pipeline** (`content/x/main.js`, scoped to `/home*`): reply filter → prefilter (regex) → result cache → Ollama (signal/noise). Off-home routes render untouched.

**YouTube pipeline** (`content/youtube/main.js`, scoped to home `/`, `/feed/subscriptions`, and the `/watch` sidebar): cache → prefilter (instant keep) → fail-open if Ollama down → blur immediately + classify → reveal only `music` (and `motivational` if enabled). The main watch video and channel/search pages are never touched.

**Ollama** (local, port 11434):
- X default model: `dhiltgen/gemma4:e2b-mlx-bf16`. YouTube default: `gemma2:2b` (fast — titles are short and the prefilter handles the obvious music).
- X prompt: 4 dimensions (NOVELTY/SPECIFICITY/DENSITY/AUTHENTICITY) → `{prediction, confidence, reason}`.
- YouTube prompt: `{category: music|motivational|other, confidence}`.
- Both system prompts live in `extension/background/worker.js` (`X_CLASSIFY_SYSTEM`, `YT_CLASSIFY_SYSTEM`).

**Data Collector** (optional, port 11435):
- `node scripts/collector.js` — receives classification data, splits per platform into `data/classifications-x.jsonl` / `data/classifications-youtube.jsonl`.
- Extension auto-flushes every 100 entries. `--improve` auto-runs analysis every 200 X entries (improve.js is X-tuned).

## Key Files

| File | Purpose |
|------|---------|
| `extension/background/worker.js` | Service worker — platform-routed Ollama proxy + both prompts |
| `extension/lib/config.js` | `RaiConfig` — per-platform config |
| `extension/lib/memory.js` | `RaiMemory` — per-platform stats/time/log + IndexedDB |
| `extension/content/core/classifier.js` | `RaiClassifier` — concurrent queue + cache |
| `extension/content/core/hider.js` | `RaiHider` — blur/remove/collapse + peek button |
| `extension/content/core/indicator.js` | `RaiIndicator` — pill + per-platform settings |
| `extension/content/x/main.js` | `XraiMain` — X pipeline (hide noise) |
| `extension/content/x/detector.js` | `XraiDetector` — tweet detection |
| `extension/content/x/prefilter.js` | `XraiPrefilter` — regex noise filter |
| `extension/content/youtube/main.js` | `YtraiMain` — YouTube pipeline (blur all, reveal music) |
| `extension/content/youtube/detector.js` | `YtraiDetector` — video-card detection (recycle-aware) |
| `extension/content/youtube/prefilter.js` | `YtraiPrefilter` — regex keep for obvious music/motivational |
| `scripts/collector.js` | Local HTTP server, per-platform classification logs |
| `benchmarks/eval-x.js` | X full-pipeline eval + regression gate (see "Evals") |
| `benchmarks/golden-x.json` | Tiered golden set — source of truth for X eval data |
| `benchmarks/load-extension.js` | Loads real prompt/parser/prefilter/config from extension source |
| `tests/regression.test.js` | Fast no-Ollama pins: prefilter invariants, parser fail-open, prompt/config hashes |
| `benchmarks/benchmark.js` | LEGACY — model-only benchmark; drifted from production (wrong models/prompt/format). Use eval-x.js |
| `SPEC.md` | Full architecture specification (X — predates YouTube) |

## Common Commands

```bash
# Syntax check all JS files
for f in extension/lib/*.js extension/content/core/*.js extension/content/x/*.js extension/content/youtube/*.js extension/background/*.js scripts/*.js; do node -c "$f" && echo "OK: $f"; done

# Run tests (bun + happy-dom)
bun install   # first time
bun test

# Start data collector (optional)
node scripts/collector.js
node scripts/collector.js --improve

# X eval + regression gate (needs Ollama; ~2-5 min)
bun run eval:x            # run against blessed baseline, exit 1 on regression
bun run eval:x:bless      # re-bless baseline after an INTENTIONAL prompt/prefilter/model change
node benchmarks/eval-x.js --limit 10   # quick smoke run

# Check Ollama status / models
curl -s http://localhost:11434/api/tags | python3 -m json.tool
ollama list

# Test a YouTube classification
curl -s http://localhost:11434/api/chat -d '{
  "model": "gemma2:2b",
  "messages": [{"role":"system","content":"Label the video music|motivational|other. JSON: {\"category\":\"music\",\"confidence\":0.9}"},
               {"role":"user","content":"Title: \"Weeknd - Blinding Lights (Official Video)\""}],
  "stream": false, "options": {"temperature": 0.1}
}'
```

## Evals — what "better" means for the X filter

The two error types are asymmetric in cost AND in visibility: leaked noise is felt
immediately (annoying, visible); hidden signal is silent — the user never sees what
was lost, so day-to-day tuning pressure always pushes toward over-hiding. The eval
exists to guard the side no one can feel.

Metrics, in priority order (computed by `benchmarks/eval-x.js` over `golden-x.json`):
1. **Critical-signal recall — must be 100%.** Tier `critical-signal` = tweets Kuan
   would most regret missing (FDE/job leads, paid-pilot leads, Claude/agent infra).
2. **Signal recall** (guarded metric — invisible in daily use). Gate: max 3pt drop vs baseline.
3. **Noise catch rate** (felt metric). Gate: max 5pt drop vs baseline. `tempting-noise`
   tier = tech-flavored bait that passes the prefilter safelist; reported separately.
4. Weighted cost = 5×critical-lost + 2×signal-lost + 1×noise-leaked. Latency p50/p95 (warn only).

NOT metrics: hidden count, total classified, symmetric accuracy, time-on-X alone.

Rules:
- Any change to `X_CLASSIFY_SYSTEM`, `prefilter.js`, the default model, or
  `confidenceThreshold` → run `bun run eval:x`; if the change is intentional and the
  metrics are acceptable, `bun run eval:x:bless` + update the prompt sha pin in
  `tests/regression.test.js`. The gate fails loudly on unblessed drift.
- `tests/regression.test.js` runs in plain `bun test` (no Ollama) and pins: prefilter
  must never fire on signal-tier items (ratchet with a named known-failures list),
  parser must fail OPEN (garbage → shown), threshold edge behavior, prompt/config hashes.
- Prefilter false-hides are the worst failure class: deterministic, silent, and they
  bypass the confidence threshold (`main.js` hides prefilter hits unconditionally).
- `benchmarks/benchmark.js` is legacy: it tests non-production models with a stale
  prompt copy in a non-production input format and never runs the prefilter. Don't
  extend it; extend `golden-x.json` + `eval-x.js` instead.

## Development

### Loading the extension
1. `chrome://extensions` → Developer mode ON → Load unpacked → select `extension/`
2. After code changes: click reload on the extension card, then refresh x.com / youtube.com

### Content script isolation
Content scripts run in an isolated world — `Rai*`, `XraiMain`, `YtraiMain` are NOT accessible from the page console. They talk to the service worker via `chrome.runtime.sendMessage` (every message carries a `platform` field).

### Adding prefilter patterns
- X noise: `extension/content/x/prefilter.js` (TECH_SIGNAL/BIZ_SIGNAL safelist, then noise categories).
- YouTube keeps: `extension/content/youtube/prefilter.js` (MUSIC_SIGNAL / MUSIC_CHANNEL / MOTIVATION_SIGNAL → instant keep; everything else goes to the AI and defaults to blur). Keep these HIGH-PRECISION — a false keep means a distracting video shows.

### Modifying the classification prompts
Edit `X_CLASSIFY_SYSTEM` or `YT_CLASSIFY_SYSTEM` in `extension/background/worker.js`. Keep prompts short — they run on 1.5–4B models.

### YouTube surfaces filtered
`YtraiMain.pageMode()`: `/` and `/feed/subscriptions` = full grid filtering; `/watch` = sidebar only; everything else (search, channel pages) = untouched. Expand here if you want search results filtered too.

## Data Pipeline (classification log for prompt improvement)

Every first-time decision on both platforms is written to a **durable IndexedDB event log** (`RaiMemory.logEvent` → `events` store in the `<prefix>_memory` DB) — append-only, never dropped on flush, survives with no server running. This is the source of truth for the planned prompt-improvement study. Cache replays are NOT re-logged (deduped by tweetId/videoId via the result cache).

**Event record shape:**
```json
{ "platform":"youtube", "decision":"blurred", "category":"other", "confidence":0.8,
  "source":"model", "model":"gemma2:2b", "raw":"<raw model output>", "ms":240,
  "title":"...", "channel":"...", "videoId":"...", "ts":..., "id":1 }
```
X records carry `prediction`/`text`/`author`/`tweetId` instead of `category`/`title`/`channel`/`videoId`. `source` distinguishes `prefilter:<reason>` (regex shortcut) from `model` (the prompt's actual output) — **filter to `source:"model"` to study/improve the prompt** (`raw` holds the model's verbatim output, `_input` was the exact user message).

**Export:** ⚙ settings pill → "⬇ Export log (.jsonl)" downloads the full per-platform log. Programmatic: dispatch `xrai-export-request` / `ytrai-export-request`, then read `#xrai-export-data` / `#ytrai-export-data` on the `*-export-response` event.

**Optional collector** (`scripts/collector.js`, port 11435) still receives a best-effort live mirror → `data/classifications-<platform>.jsonl` + `data/model-io.jsonl`, but is no longer required for durability.

> **Next lever for the study:** ground truth (was the decision correct?) is not captured yet. A one-tap "wrong" affordance calling `RaiMemory.saveCorrection` would turn this into a supervised dataset; corrections join the log on `videoId`/`tweetId`.

## Configuration Defaults

```javascript
// X (xrai_config)
{ model: 'dhiltgen/gemma4:e2b-mlx-bf16', confidenceThreshold: 0.7,
  contentFilter: 'posts-only', hideMethod: 'remove', replyStyle: 'curious',
  maxModelCallsPerMinute: 100 }

// YouTube (ytrai_config)
{ model: 'gemma2:2b', confidenceThreshold: 0.6, keepMotivational: true,
  hideMethod: 'blur', maxModelCallsPerMinute: 120,
  shortsNudge: true, shortsLimitCount: 10, shortsLimitMinutes: 5 }
```

### Shorts consumption tracker (`content/youtube/shorts.js` → `YtraiShorts`)
Separate from the blur filter (which doesn't touch `/shorts/`). Tracks Shorts watched + active time per day (`ytrai_shorts` in chrome.storage), detects a "binge" (continuous run, resets after a 3-min gap away from Shorts), and shows a dismissable **snap-out overlay** once a binge hits `shortsLimitCount` Shorts OR `shortsLimitMinutes`. Counts via `yt-navigate-finish` + a 2s tick poll (swipe events aren't always fired). Each Short is also written to the durable event log as `{kind:"short", videoId, ...}`. Pill shows `📱 N Shorts · Mm`; limits + nudge toggle live in the YouTube settings popup.

## ToS Compliance (both platforms)

- Never calls X's or YouTube's API — only reads already-rendered DOM
- Never auto-posts, likes, follows, or clicks site actions
- X replies are copy-paste only (never touches the composer)
- CSS-only hiding/blurring (`display:none` / `filter: blur`)
- No scraping — processes only what the user already sees
