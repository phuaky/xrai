# CLAUDE.md

Instructions for Claude Code when working on this repo.

## Project Overview

**rai** is a Chrome extension that filters social feeds using local AI (Ollama). One extension, two platforms, shared core:

- **X / Twitter** (`x.com`): classifies tweets as **signal** (tech/AI/startup) or **noise** (everything else) and hides noise.
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
    hops.js      → RaiHops       # pure hop-detection logic (X↔YT doom-loop), worker-loaded
    ollama.js                    # legacy XraiOllama client (unused, not loaded)
  content/
    core/                        # SHARED, neutral Rai* namespace
      classifier.js → RaiClassifier   # serial low-latency queue + result cache + activity feed
      hider.js      → RaiHider        # blur / remove / collapse + peek button
      indicator.js  → RaiIndicator    # status pill (pulses while classifying) + today-first panel + auto-save settings
      dwell.js      → RaiDwell        # attention ledger: per-card dwell tracking (X only for now)
      hopnudge.js   → RaiHopNudge     # X↔YT hop-loop overlay (detection in lib/hops.js via worker)
      styles.css                      # tag-agnostic selectors ([data-xrai-*])
    x/                           # X-specific, Xrai* namespace
      detector.js  → XraiDetector     # tweet detection + media + text expansion
      prefilter.js → XraiPrefilter    # regex noise filter + tech safelist (+ prefilterReply)
      replyroute.js → XraiReplyRoute  # reply-guard routing/immunity (pure, worker-free)
      tips.js      → XraiTips          # workflow-tip detection (feeds the tips ledger)
      main.js      → XraiMain           # pipeline: hide noise, keep signal + reply guard
    youtube/                     # YouTube-specific, Ytrai* namespace
      detector.js  → YtraiDetector     # video-card detection (recycle-aware)
      prefilter.js → YtraiPrefilter    # regex KEEP for obvious music/motivational
      shorts.js    → YtraiShorts       # Shorts consumption tracker + doom-scroll nudge
      watch.js     → YtraiWatch        # attention ledger: watch-time per video on /watch
      main.js      → YtraiMain           # inverted pipeline: blur all, reveal music/motivational
```

**Namespace convention:** shared core = `Rai*` (RaiConfig/RaiMemory/RaiClassifier/RaiHider/RaiIndicator). X-specific = `Xrai*`. YouTube-specific = `Ytrai*`. Internal CSS classes, `data-xrai-*` attributes, and storage prefixes (`xrai_*` for X, `ytrai_*` for YouTube) are intentionally kept — they preserve user data and keep tests green. The service worker routes by a `platform` field on every message.

**X pipeline** (`content/x/main.js`, scoped to `/home*`): reply filter → prefilter (regex) → result cache → Ollama (signal/noise). Off-home routes render untouched — except the user's OWN status pages, where the **reply guard** runs (see below).

**YouTube pipeline** (`content/youtube/main.js`, scoped to home `/`, `/feed/subscriptions`, and the `/watch` sidebar): cache → prefilter (instant keep) → fail-open if Ollama down → blur immediately + classify → reveal only `music` (and `motivational` if enabled). The main watch video and channel/search pages are never touched.

**Ollama** (local, port 11434):
- X default model: `dhiltgen/gemma4:e2b-mlx-bf16`. YouTube default: `gemma2:2b` (fast — titles are short and the prefilter handles the obvious music).
- X prompt: 4 dimensions (NOVELTY/SPECIFICITY/DENSITY/AUTHENTICITY) → `{prediction, confidence, reason}`.
- X reply prompt: `{verdict: hostile|bot|spam|fine, confidence}` (reply guard, own status pages only).
- YouTube prompt: `{category: music|motivational|other, confidence}`.
- All system prompts live in `extension/background/worker.js` (`X_CLASSIFY_SYSTEM`, `X_REPLY_SYSTEM`, `YT_CLASSIFY_SYSTEM`).

**Data Collector** (optional, port 11435):
- `node scripts/collector.js` — receives classification data, splits per platform into `data/classifications-x.jsonl` / `data/classifications-youtube.jsonl`.
- Extension auto-flushes every 100 entries. `--improve` auto-runs analysis every 200 X entries (improve.js is X-tuned).
- Also receives attention-ledger events (`POST /events` → `data/events-<platform>.jsonl`) and tips (`POST /tips`).

## Key Files

| File | Purpose |
|------|---------|
| `extension/background/worker.js` | Service worker — platform-routed Ollama proxy + both prompts |
| `extension/lib/config.js` | `RaiConfig` — per-platform config |
| `extension/lib/memory.js` | `RaiMemory` — per-platform stats/time/log + IndexedDB |
| `extension/content/core/classifier.js` | `RaiClassifier` — serial queue + cache (text) + activity feed |
| `extension/content/core/image-classifier.js` | `RaiImageClassifier` — small queue + cache for the image bait check |
| `extension/content/core/hider.js` | `RaiHider` — blur/remove/collapse + peek/label buttons |
| `extension/content/core/indicator.js` | `RaiIndicator` — pill + per-platform settings |
| `extension/content/x/main.js` | `XraiMain` — X pipeline (hide noise) + reply guard |
| `extension/content/x/detector.js` | `XraiDetector` — tweet detection (+ `rescan()` for SPA revisits) |
| `extension/content/x/prefilter.js` | `XraiPrefilter` — regex noise filter + `prefilterReply` (reply guard) |
| `extension/content/x/replyroute.js` | `XraiReplyRoute` — reply-guard routing/immunity (pure; tests: `tests/replyfilter.test.js`) |
| `benchmarks/golden-replies-x.json` | Tiered golden set for the reply guard (bad-faith / tempting-bad-faith / genuine) |
| `extension/content/youtube/main.js` | `YtraiMain` — YouTube pipeline (blur all, reveal music) |
| `extension/content/youtube/detector.js` | `YtraiDetector` — video-card detection (recycle-aware) |
| `extension/content/youtube/prefilter.js` | `YtraiPrefilter` — regex keep for obvious music/motivational |
| `scripts/collector.js` | Local HTTP server, per-platform classification logs + `/tips` + `/events` intake + `/easy` (board suggestion) |
| `extension/lib/hops.js` | `RaiHops` — pure hop-detection logic (tests: `tests/hopnudge.test.js`) |
| `extension/content/core/hopnudge.js` | `RaiHopNudge` — hop-loop overlay + visit reporting |
| `scripts/tips.js` | Tips ledger CLI — digest / mark / stats over `data/tips.jsonl` |
| `extension/content/core/dwell.js` | `RaiDwell` — attention ledger: per-card dwell tracking |
| `extension/content/youtube/watch.js` | `YtraiWatch` — attention ledger: /watch time per video |
| `scripts/digest.js` | Daily attention digest CLI — deterministic assembly + `--analyze` via codex |
| `extension/content/x/tips.js` | `XraiTips` — workflow-tip detection (high recall by design) |
| `benchmarks/eval-x.js` | X full-pipeline eval + regression gate (see "Evals") |
| `benchmarks/golden-x.json` | Tiered golden set — source of truth for X eval data |
| `benchmarks/eval-youtube.js` | YouTube full-pipeline eval + regression gate (see "Evals") |
| `benchmarks/golden-youtube.json` | Tiered golden set — source of truth for YouTube eval data |
| `benchmarks/load-extension.js` | Loads real prompt/parser/prefilter/config from extension source (both platforms) |
| `benchmarks/bench-live-x.js` | Burst-latency benchmark over recent live X decisions |
| `benchmarks/audit-live-x.js` | Prepare/judge/report workflow for stratified recent-traffic audits |
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

# Start data collector (optional; also receives tips)
node scripts/collector.js
node scripts/collector.js --improve

# Tips ledger — workflow tips captured from the feed
node scripts/tips.js               # digest: useful-but-unimplemented first, then unread
node scripts/tips.js mark <id-prefix> read|useful|implemented|rejected|na [note]
node scripts/tips.js stats

# Attention ledger — daily digest of what was actually read/watched
node scripts/digest.js                    # today's record → data/daily/YYYY-MM-DD.md
node scripts/digest.js 2026-07-09 --analyze   # + goal-mapping via codex (gpt-5.5)
node scripts/digest.js --json             # machine-readable (for kyu)

# X eval + regression gate (needs Ollama; ~2-5 min)
bun run eval:x            # run against blessed baseline, exit 1 on regression
bun run eval:x:bless      # re-bless baseline after an INTENTIONAL prompt/prefilter/model change
node benchmarks/eval-x.js --limit 10   # quick smoke run
node benchmarks/bench-live-x.js --since 2026-07-23 --sample 24
node benchmarks/audit-live-x.js prepare --since 2026-07-23

# YouTube eval + regression gate (needs Ollama; ~1 min)
bun run eval:youtube            # run against blessed baseline, exit 1 on regression
bun run eval:youtube:bless      # re-bless baseline after an INTENTIONAL prompt/prefilter/model change
node benchmarks/eval-youtube.js --limit 10   # quick smoke run

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

## Evals — what "better" means for the YouTube filter

Inverted asymmetry from X: YouTube blurs by default and reveals only music/motivational,
so a wrongly-blurred music/motivational video is the INVISIBLE cost (you never know you
missed a good song), and a wrongly-revealed "other" video is the FELT cost (a distracting
video shows). Same principle as X — guard the side no one can feel — opposite direction.

Metrics, in priority order (computed by `benchmarks/eval-youtube.js` over `golden-youtube.json`):
1. **Keep recall** (guarded metric — invisible in daily use). Gate: max 3pt drop vs baseline.
2. **False-keep rate** (felt metric). Gate: max 5pt rise vs baseline. `tempting-other` tier =
   titles/channels that superficially resemble music/motivational bait, reported separately.
3. Weighted cost = 2×keep-lost + 1×false-keep. Latency p50/p95 (warn only).

Rules: same as X's, mirrored — any change to `YT_CLASSIFY_SYSTEM`, `youtube/prefilter.js`,
the default model, or `confidenceThreshold` → run `bun run eval:youtube`; if intentional
and acceptable, `bun run eval:youtube:bless`. Prefilter false-keeps are the worst failure
class here too: deterministic, silent, and bypass the confidence threshold.

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
X records carry `prediction`/`text`/`author`/`tweetId` instead of `category`/`title`/`channel`/`videoId`. `source` distinguishes `prefilter:<reason>` (regex shortcut) from `model` (the prompt's actual output) — **filter to `source:"model"` to study/improve the prompt**. New decision records preserve the complete expanded tweet text. Records written before August 5, 2026 capped `text` at 500 characters, so long historical tweets cannot be reconstructed from the local mirror.

**Export:** pill → settings → "export log" downloads the full per-platform log. Programmatic: dispatch `xrai-export-request` / `ytrai-export-request`, then read `#xrai-export-data` / `#ytrai-export-data` on the `*-export-response` event.

**Optional collector** (`scripts/collector.js`, port 11435) receives a best-effort live mirror, no longer required for durability: every decision record now rides `RaiMemory.mirrorEvent` → `POST /events` → `data/events-<platform>.jsonl` (flushed at 20 events, every 10s, and on tab close with `keepalive`), alongside the attention-ledger events. The worker separately POSTs raw model I/O → `data/model-io.jsonl`. (`data/classifications-<platform>.jsonl` is legacy — `logClassification` has no callers; `tail -f data/events-x.jsonl` is the live stream.)

**Stats totals + daily time** (`<prefix>_stats_totals` / `<prefix>_daily_time` in chrome.storage.local — the pill's numbers) are **worker-owned**: content scripts send `{action:'statsDelta'|'timeDelta'}` messages, the worker applies them through one serialized read-modify-write chain (same pattern as `rai_hop_state`), and pills re-render from `storage.onChanged` so all tabs converge. `_stats_totals` also carries a `today: {date, total, kept, hidden}` sub-record the worker resets on date rollover (worker-local clock) — the pill shows today's hidden count, the panel shows today's numbers with all-time as a footnote. Tabs never write these keys directly — per-tab copies with periodic overwrite was a lost-update race that corrupted counts whenever two X tabs were open.

> **Ground truth (X):** the one-tap ✗ correction button was REMOVED (Jul 2026 — it went untapped for its whole life; `{kind:"correction"}` events may still exist in old logs). False-hide evidence now comes from **offline judge audits**: periodically re-judge the durable decision log with a stronger model (`benchmarks/audit-live-x.js`, stratified by source/confidence), send disagreements to Kuan for labeling, and graduate them into `benchmarks/golden-x.json`. Because nothing needs to stay clickable, X `hideMethod` now defaults to `remove` (config v2 migration flips stored `blur` once; config v3 disables the unevaluated image gate once; deliberate later settings changes stick).

## Tips Ledger (workflow tips: seen → read → evaluated → implemented)

Answers "what useful workflow tips crossed the feed that we still haven't acted on?"

- **Detect** (`extension/content/x/tips.js` → `XraiTips.isTip`): a SHOWN tweet that names a
  stack tool (Claude Code, MCP, agents, …) AND describes a copyable practice (how-to,
  setup, first-person method, release). Deliberately high recall — capture only runs on
  tweets that survived filtering, so the classifier is the precision layer (funnel bait
  wearing tip clothing gets hidden before it can be captured). Tests pin the recall floor
  and the plain-noise-never-fires invariant (`tests/tips.test.js`).
- **Capture** (`main.js maybeCaptureTip`): fires on feed-shown (cache/model/Ollama-off)
  and off-home reading (opening a tip's status page = strongest interest signal, context
  `reading`). Writes a `{kind:"tip"}` event
  to the durable log + POSTs to the collector `/tips` → `data/tips.jsonl` (append-only,
  deduped by tweetId across restarts). Collector down = tips only in the durable log.
- **Track** (`scripts/tips.js`): statuses in `data/tips-status.json` — `new` (implicit) →
  `read` → `useful` → `implemented | rejected | na`. The digest surfaces unresolved tips,
  evaluated-`useful` first (known-good and still not acted on), then unread.
- **Evaluate**: judging "are we already doing this?" is kyu's / the Upgrade skill's job
  (`tips.js list --json` is the handoff format), not this repo's — the CLI stays deterministic.

## Attention Ledger (what was actually READ, not just what the feed showed)

Intent: close the loop between attention spent and goals served. rai decides what you
*see*; the ledger measures what you actually *read* and feeds it back as a saved daily
record with goal mapping against `~/.claude/PAI/USER/TELOS/GOALS.md`.

- **X dwell** (`core/dwell.js` → `RaiDwell`): one IntersectionObserver (≥50% visible) +
  2s tick. Every logged decision in `x/main.js logTweet` starts an observation (so read
  events carry `decision`/`source` and join decision events on `tweetId`); the off-home
  branch observes explicitly with `decision:'reading'` (status-page reading = strongest
  attention signal). Finalizes on viewport exit / node detach (sweep) / href change
  (polled — X has no SPA nav event) / beforeunload, all through one idempotent
  `finalize`. Logs `{kind:'read', dwellMs, ...}` only at ≥1s dwell. Known undercount:
  re-reads within a page load are lost (detector's `processed` set never re-emits).
- **YouTube watch time** (`youtube/watch.js` → `YtraiWatch`): `/watch` only. Accrues 2s
  ticks when tab visible AND playing AND `currentTime` advanced AND no ad
  (`#movie_player.ad-showing`). Background-tab audio deliberately does NOT count.
  Writes cumulative `{kind:'watch', seconds, partial:true}` every 30s (crash safety) +
  a final record; downstream collapses via MAX(seconds) per (videoId, date).
- **Egress**: events go to the durable IndexedDB log (source of truth) AND
  best-effort to the collector via `RaiMemory.mirrorEvent` → `POST /events` →
  `data/events-<platform>.jsonl` (pure append; collapsing is digest-time).
  Classification decisions ride the same pipe (no `kind` field — digest
  filters by kind, so it ignores them).
- **Digest** (`scripts/digest.js`): deterministic CLI (tips.js philosophy) —
  totals, per-item lists, exact repeats across days → `data/daily/YYYY-MM-DD.md`.
  `--analyze` shells `codex exec -s read-only` for goal mapping / themes / semantic
  repeats / worth-deeper-processing / gaps. Run it in the morning session.
- Deliberately deferred: embeddings + in-feed "seen before" badges, YouTube feed dwell
  (feed is blurred by default), collector-reconnect backfill, cron scheduling.
- No prompt/prefilter/model/threshold changes → eval gates unaffected.

## Configuration Defaults

```javascript
// X (xrai_config)
{ model: 'dhiltgen/gemma4:e2b-mlx-bf16', confidenceThreshold: 0.7,
  contentFilter: 'posts-only', hideMethod: 'remove',
  maxModelCallsPerMinute: 100, hopNudge: true,
  replyGuard: true, ownHandle: 'phuakuanyu', replyConfidenceThreshold: 0.7 }

// YouTube (ytrai_config)
{ model: 'gemma2:2b', confidenceThreshold: 0.6, keepMotivational: true,
  hideMethod: 'blur', maxModelCallsPerMinute: 120,
  shortsNudge: true, shortsLimitCount: 10, shortsLimitMinutes: 5,
  hopNudge: true }
```

### Reply guard (`x/replyroute.js` + `prefilterReply` + `X_REPLY_SYSTEM`)
Blurs bad-faith replies on the user's OWN status pages (`x.com/<ownHandle>/status/…`)
— everywhere else off-home stays untouched. Targets **bad faith, not sentiment**:
`hostile` (slurs, identity attacks, harm-wishes), `bot`, `spam` get blurred;
criticism, skepticism, accusations, and mockery of the idea are `fine` and stay
visible (hiding pushback = echo-chamber failure mode, pinned by tests).

- **Pipeline** (`main.js handleOwnReply`, inverse trust posture from the feed):
  shown-by-default while classifying (genuine replies never flash-blurred) →
  cache (`reply:<id>` keys, so feed `{prediction}` and reply `{verdict}` never
  collide) → `prefilterReply` (high-precision slur/spam regex, NO tech safelist,
  blurs unconditionally) → fail-open if Ollama down → `classifyReply` on the
  shared 3-in-flight queue, blur only at `confidence ≥ replyConfidenceThreshold`.
- **Immunity** (`XraiReplyRoute.shouldGuard`, pure, pinned by tests): the main
  tweet and the user's own replies are never touched; other users' status pages
  never activate the guard.
- **Always blur-with-peek**, ignoring `hideMethod` — a wrongly hidden reply on
  your own post could be a lead, recoverability is non-negotiable. Peek clicks
  log `{kind:'peek', surface:'own-replies'}` — free ground truth for false-
  positive audits. Decision events carry `surface:'own-replies'` in the durable
  log + collector mirror. Pill shows `🛡 blurred/screened replies` per thread.
- **SPA revisits**: `main.js` polls the path; re-entering an own thread calls
  `XraiDetector.rescan()` so cached verdicts re-apply (replays are not re-logged).
- **Evals**: `tests/replyfilter.test.js` (no Ollama) pins prefilter-never-fires-
  on-genuine/tempting tiers, parser fail-open, immunity rules, threshold edges,
  and the `X_REPLY_SYSTEM` sha. A model-in-the-loop reply eval is deliberately
  deferred until real `surface:'own-replies'` data accumulates. Feed eval gates
  are untouched by design (`X_CLASSIFY_SYSTEM` sha pinned unchanged).

### Hop nudge (`lib/hops.js` + `content/core/hopnudge.js` + worker)
Notices the cross-platform avoidance loop — quickly bouncing X ↔ YouTube, or
close-and-reopening the same feed — and interrupts it with a full-screen overlay
that names the pattern, asks what's actually going on ("What are we trying to do?
Avoiding something? About to start something big?"), and offers the smallest real
next action.

- **Detect**: both content scripts report `load` (fresh document) and `vis`
  (tab foregrounded) visits via `{action:'hopVisit'}`; the worker evaluates them
  against one shared window in `chrome.storage.local` (`rai_hop_state`, writes
  serialized). A **churn** transition = platform switch within 4 min, or a
  same-platform fresh load within 3 min (reopen/compulsive refresh).
  Same-platform visibility flips NEVER churn — alt-tabbing to an editor is work.
  3 churns within a 10-min horizon → nudge, then 20-min auto-cooldown ("Off for
  today" snoozes to local midnight). Logic is pure (`RaiHops.evaluate`), pinned
  by `tests/hopnudge.test.js`.
- **Easy action**: overlay fetches collector `GET /easy` — today's needle's first
  unchecked `doneWhen` item from `founder-home/state.json` (path override:
  `RAI_STATE_JSON`), else the shortest `nextTry` among `now` tasks; static
  fallback line when the collector's down.
- **Ledger**: every fire writes `{kind:'hop', churn, spanMs}` to the durable log
  + mirrors to `/events`, so the daily digest can count loop days.
- Per-platform overlay toggle: `hopNudge` (settings popup, both platforms);
  visits are recorded even when toggled off so the other platform stays accurate.
- No prompt/prefilter/model/threshold changes → eval gates unaffected.

### Shorts consumption tracker (`content/youtube/shorts.js` → `YtraiShorts`)
Separate from the blur filter (which doesn't touch `/shorts/`). Tracks Shorts watched + active time per day (`ytrai_shorts` in chrome.storage), detects a "binge" (continuous run, resets after a 3-min gap away from Shorts), and shows a dismissable **snap-out overlay** once a binge hits `shortsLimitCount` Shorts OR `shortsLimitMinutes`. Counts via `yt-navigate-finish` + a 2s tick poll (swipe events aren't always fired). Each Short is also written to the durable event log as `{kind:"short", videoId, ...}`. Pill shows `📱 N Shorts · Mm`; limits + nudge toggle live in the YouTube settings popup.

## ToS Compliance (both platforms)

- Never calls X's or YouTube's API — only reads already-rendered DOM
- Never auto-posts, likes, follows, or clicks site actions
- CSS-only hiding/blurring (`display:none` / `filter: blur`)
- No scraping — processes only what the user already sees
