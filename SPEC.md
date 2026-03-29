# xrai — See Through X Content With AI

> X-ray your feed. Local AI classifies tweets as signal or noise. Noise disappears. Signal stays. You never see the same content twice. Reply to signal tweets in your voice — copy-paste, never automated.

## The Problem

Twitter/X feeds are 80%+ noise: engagement bait, clickbait videos, NSFW traps, recycled takes, rage bait. Scrolling through this destroys focus and wastes time. Existing solutions either require cloud APIs (cost, latency, ban risk) or are too complex to maintain.

## The Solution

A Chrome extension that runs a local AI model (via Ollama) to classify every tweet as it appears in your DOM. Noise is hidden instantly. Signal tweets stay visible. A content memory ensures you never see the same tweet twice across sessions. When you find a signal tweet worth replying to, the extension generates a reply in your voice — but YOU copy-paste it. Zero automation. Zero bot behavior.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         YOUR MACHINE                             │
│                                                                  │
│  ┌─────────────────┐         ┌──────────────────────────────┐   │
│  │  Chrome Browser  │         │  Ollama (local, port 11434)  │   │
│  │                  │         │                              │   │
│  │  ┌────────────┐  │  HTTP   │  Model: qwen2.5:1.5b        │   │
│  │  │ xrai ext   │──┼────────▶│  or llama3.2:3b              │   │
│  │  │            │  │ local   │  or gemma2:2b                │   │
│  │  │ content    │  │ only    │                              │   │
│  │  │ scripts    │  │         │  Runs when you browse X      │   │
│  │  └────────────┘  │         │  Idle RAM: ~300MB            │   │
│  │                  │         │  Active RAM: ~1-2GB          │   │
│  └─────────────────┘         └──────────────────────────────┘   │
│                                                                  │
│  No cloud server. No API keys. No accounts. No billing.          │
│  Everything runs on your machine.                                │
└──────────────────────────────────────────────────────────────────┘
```

## Core Principles

1. **Local-first** — All AI runs on your machine via Ollama. No data leaves your computer.
2. **Subtract, don't add** — Noise disappears. We don't add UI for noise. No sidebars, no analysis cards, no verdict explanations.
3. **Zero bot behavior** — We read what's already rendered in YOUR browser. We never call X's API. We never auto-post. Replies are copy-paste only.
4. **Content memory** — A fingerprint store ensures you never see the same content twice across sessions.
5. **Lightweight** — Minimal extension code. No server. No accounts. One config file.

## X Terms of Service Compliance

This extension is designed to comply with X's ToS:

- **No API access**: We never call X's API. We only read DOM elements already rendered in the user's browser.
- **No automation**: We never click buttons, submit forms, or trigger actions on X. Reply text is generated for the user to manually copy-paste.
- **No scraping at scale**: We process only tweets visible in the user's current browser session, same as a human reading their feed.
- **No bot behavior**: We don't auto-follow, auto-like, auto-retweet, or auto-reply. All engagement actions are manual.
- **User-initiated only**: The extension only activates when the user opens x.com. It observes the same DOM the user sees.
- **CSS-only modification**: Hiding tweets is done via CSS (`display:none`), same as browser extensions like ad blockers that are widely accepted.

This is functionally equivalent to a user manually scrolling past tweets they don't want to read — the extension just does the evaluation faster.

## Components

### 1. Tweet Detector (`content/detector.js`)

Watches the DOM for new tweet elements using MutationObserver.

**Behavior:**
- Debounced (150ms) to batch DOM mutations
- Extracts: text, author, media type (video/image/gif/text-only), tweet ID
- Detects replies vs original posts
- Computes content fingerprint for dedup

**Media detection matters because:**
- Video + vague text ("this is so good", "wait for it") = almost always noise
- Image-only with no text = usually engagement bait
- Text-only tweets are the primary signal source for tech content

### 2. Content Memory (`lib/memory.js`)

Persistent fingerprint store ensuring no content is shown twice.

**How it works:**
```
fingerprint = hash( lowercase(normalize(text)) + mediaType )
```

- Stored in IndexedDB (`xrai_memory` database)
- Fields: `fingerprint`, `first_seen`, `last_seen`, `classification`, `view_count`
- Lookup is O(1) — happens before classification
- Auto-prunes entries older than 30 days on startup
- Handles retweets: same text from different authors → same fingerprint
- Estimated storage: ~2MB for 50,000 fingerprints

**Flow:**
```
Tweet detected → compute fingerprint → check memory
  SEEN? → hide immediately (no classification needed, zero latency)
  NEW?  → proceed to classification
```

### 3. Pre-Filter (`content/prefilter.js`)

Instant local classification using regex patterns. No model needed.

**Catches (with high confidence):**
- NSFW/suggestive keywords (onlyfans, thirst trap, etc.)
- Engagement bait patterns (follow for follow, ratio, retweet if)
- Spam/scam patterns (free money, giveaway, passive income)
- Clickbait video patterns (video + vague text < 30 chars)
- Media-only tweets with no text

**Result:** Noise tweets caught here are hidden instantly and added to memory. Saves model calls.

### 4. Local Classifier (`lib/classifier.js`)

Sends tweet text + media context to Ollama for signal/noise classification.

**Prompt design:**
```
System: You classify tweets. Output JSON only.
Score on 4 dimensions (0 or 1 each):
- NOVELTY: New information or recycled take?
- SPECIFICITY: Concrete details or vague claims?
- DENSITY: High insight-to-word ratio?
- AUTHENTICITY: Genuine sharing or engagement farming?

If tweet has video/image media with vague text, lean toward noise.

Score 3-4 = signal. Score 0-2 = noise.

Output: {"prediction":"signal"|"noise","confidence":0.0-1.0}
```

**Model options (ranked by speed on Apple Silicon):**
| Model | Size | RAM | Speed (est.) | Quality |
|-------|------|-----|-------------|---------|
| `qwen2.5:1.5b` | 1.0 GB | ~1.2 GB | ~30-50ms | Good for binary classification |
| `gemma2:2b` | 1.6 GB | ~1.8 GB | ~40-60ms | Good reasoning |
| `llama3.2:3b` | 2.0 GB | ~2.2 GB | ~60-100ms | Best quality |
| `phi3:mini` | 2.3 GB | ~2.5 GB | ~70-110ms | Strong at structured output |

**Recommendation:** Start with `qwen2.5:1.5b` for speed, benchmark against `llama3.2:3b` for quality.

**Batch processing:**
- Queue tweets, flush every 2 seconds or when 5 accumulate
- Single Ollama call with multiple tweets in prompt (batch classification)
- Rate limited: max 20 calls/minute to Ollama (prevent resource saturation)

### 5. Viewport Gate (`content/viewport.js`)

Only classifies tweets the user is actually looking at.

**Behavior:**
- Uses IntersectionObserver to track tweet visibility
- Tweet must be visible for 500ms before queuing for classification
- If user scrolls past quickly → skip (no model call wasted)
- Max 5 tweets in classification queue at any time
- Tweets above the viewport that were never visible → hide on scroll-back OR classify lazily

### 6. Reply Generator (`content/reply.js`)

Generates reply suggestions for signal tweets. User manually copy-pastes.

**Trigger:** User clicks a small "Reply" icon on signal tweets (only visible on hover).

**Behavior:**
- Sends tweet text + context to Ollama with reply prompt
- Generates 2-3 short reply options (different styles: curious, add-on, react)
- Displays in a small floating card near the tweet
- User copies text, manually pastes into X's reply composer
- **Never** touches X's DOM for posting. Copy button only.

**Reply prompt includes:**
- Tweet text and author
- User's voice profile (if configured — stored locally in a JSON file)
- Constraints: 5-15 words target, max 80 chars, no hashtags, match energy

**Voice profile:** A local JSON file (`~/.xrai/voice.json`) describing the user's writing style. Generated once from a sample of the user's own tweets (pasted in manually or scraped from their profile page DOM). Updated manually whenever the user wants.

### 7. Status Indicator (`content/indicator.js`)

A minimal floating pill. The ONLY persistent UI element.

```
┌──────────────────────────────────────────────────────┐
│  xrai: 12 shown | 31 hidden | local ● | ⚙           │
└──────────────────────────────────────────────────────┘
```

- **Shown/hidden counts** — how filtered is your feed right now
- **Model status** — green dot = Ollama connected, red = offline (pre-filter only mode)
- **Settings gear** — click to open minimal settings popup

**Settings popup (inline, not a separate page):**
- Model selector dropdown (from Ollama's available models)
- Aggressiveness slider (confidence threshold: 0.5 = aggressive, 0.9 = permissive)
- Content filter: Posts only / Posts + replies
- Reply style: Curious / Technical / Casual
- Clear memory button
- Stats: total tweets processed, time estimated saved

### 8. Ollama Lifecycle (`lib/ollama.js`)

**The core concern:** "What server is running? How do I start/stop it?"

**Strategy: Detect, don't manage.**

The extension does NOT start or stop Ollama. It only checks if Ollama is available.

**Setup (one-time, documented in README):**

Option A — Login Item (recommended for Mac):
```bash
# Ollama starts automatically on login
# Just install Ollama normally: https://ollama.ai
# It adds itself to Login Items by default on Mac
# Verify: System Settings → General → Login Items → Ollama should be listed
```

Option B — Manual:
```bash
# Start Ollama when you want to use xrai
ollama serve
# Or pull and it auto-serves:
ollama pull qwen2.5:1.5b
```

**Extension behavior:**
```
On x.com tab open:
  1. Check http://localhost:11434/api/tags (health check)
  2. Ollama running?
     YES → green dot in pill, use local model
     NO  → red dot in pill, show "Ollama not running" tooltip
           Fall back to pre-filter only mode
           (still filters NSFW/clickbait/seen-content, just no AI classification)
  3. Check if selected model is pulled
     YES → ready
     NO  → show "Model not found. Run: ollama pull qwen2.5:1.5b"
```

**No Docker. No server management UI. No process spawning from extension.**

Ollama is a user-level application, like Spotify or Slack. It sits in the background. The extension just uses it when available.

## File Structure

```
xrai/
├── SPEC.md                    ← This document
├── README.md                  ← Setup guide
├── LICENSE                    ← MIT
├── extension/
│   ├── manifest.json          ← Manifest V3, minimal permissions
│   ├── content/
│   │   ├── detector.js        ← MutationObserver, tweet extraction, media detection
│   │   ├── prefilter.js       ← Regex patterns for instant noise detection
│   │   ├── viewport.js        ← IntersectionObserver, visibility gating
│   │   ├── classifier.js      ← Ollama API calls, batch processing, queue
│   │   ├── reply.js           ← Reply generation UI + copy button
│   │   ├── indicator.js       ← Floating status pill + settings popup
│   │   ├── hider.js           ← CSS manipulation to hide/show tweets
│   │   ├── main.js            ← Orchestrator, wires everything together
│   │   └── styles.css         ← Minimal CSS for indicator + reply card
│   ├── lib/
│   │   ├── memory.js          ← Content fingerprint store (IndexedDB)
│   │   ├── ollama.js          ← Ollama health check, model listing
│   │   └── config.js          ← User preferences (chrome.storage.local)
│   └── background/
│       └── worker.js          ← Service worker for Ollama HTTP calls
├── benchmarks/
│   ├── test-tweets.json       ← Sample tweets for model benchmarking
│   └── benchmark.js           ← Script to test model speed + accuracy
└── .xrai/
    └── voice.json.example     ← Example voice profile template
```

## Permissions (Minimal)

```json
{
  "permissions": ["storage"],
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*",
    "http://localhost:11434/*"
  ]
}
```

- `storage` — for preferences and content memory
- `x.com/*` / `twitter.com/*` — to inject content scripts
- `localhost:11434/*` — to call Ollama API from service worker

No `tabs`, no `scripting`, no `sidePanel`, no `unlimitedStorage`.

## Data Flow

```
Tweet appears in DOM
      │
      ▼
  ┌─ DETECT ─┐
  │ Extract:  │
  │ text      │
  │ author    │
  │ media     │
  │ fingerprint│
  └─────┬─────┘
        │
        ▼
  ┌─ MEMORY CHECK ─┐
  │ Seen before?    │──── YES ──▶ HIDE (instant, no model call)
  └────────┬───────┘
           │ NO
           ▼
  ┌─ PRE-FILTER ───┐
  │ NSFW keyword?   │──── YES ──▶ HIDE + save to memory
  │ Clickbait video?│
  │ Spam pattern?   │
  └────────┬───────┘
           │ PASS
           ▼
  ┌─ VIEWPORT GATE ─┐
  │ Visible > 500ms? │──── NO ──▶ SKIP (don't waste model call)
  │ Queue < 5?       │
  └────────┬────────┘
           │ YES
           ▼
  ┌─ CLASSIFY (Ollama) ─┐
  │ Score: N/S/D/A       │
  │ 3-4 → SIGNAL         │──── SIGNAL ──▶ SHOW + save to memory
  │ 0-2 → NOISE          │──── NOISE  ──▶ HIDE + save to memory
  └──────────────────────┘

On SIGNAL tweet, user hovers:
  [📋 Reply] button appears
      │
      ▼
  ┌─ REPLY GEN (Ollama) ─┐
  │ 2-3 short replies     │
  │ in user's voice style │
  │ [Copy] button each    │
  │ User pastes manually  │
  └───────────────────────┘
```

## What's NOT Included (By Design)

- No cloud server
- No user accounts or login
- No billing or payment
- No usage tracking or analytics
- No sidebar with analysis cards
- No auto-posting or auto-replying
- No X API calls
- No Docker
- No voice profiles UI (just a local JSON file)
- No onboarding modal
- No side panel

## Benchmarking Plan

Before building, we need to know which model is fastest and good enough:

```bash
# 1. Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 2. Pull candidate models
ollama pull qwen2.5:1.5b
ollama pull gemma2:2b
ollama pull llama3.2:3b
ollama pull phi3:mini

# 3. Run benchmark
node benchmarks/benchmark.js

# Tests:
# - 50 sample tweets (25 signal, 25 noise, manually labeled)
# - Measures: latency per tweet, accuracy vs labels, RAM usage
# - Batch mode: 5 tweets per call
# - Output: table comparing all models
```

## Configuration

All config is in `chrome.storage.local`. No external files except the optional voice profile.

```javascript
{
  // Model settings
  model: 'qwen2.5:1.5b',         // Active model
  ollamaUrl: 'http://localhost:11434',

  // Filter settings
  confidenceThreshold: 0.7,       // Below this → default to noise
  contentFilter: 'posts-only',    // 'posts-only' | 'all'
  hideMethod: 'remove',           // 'remove' | 'collapse' | 'blur'

  // Reply settings
  replyStyle: 'curious',          // 'curious' | 'technical' | 'casual'
  voiceProfile: null,             // Loaded from ~/.xrai/voice.json if exists

  // Memory settings
  memoryRetentionDays: 30,        // Auto-prune after this

  // Rate limiting
  maxModelCallsPerMinute: 20,
  batchSize: 5,
  batchFlushDelay: 2000           // ms
}
```

## Open Questions

1. **Model benchmarks** — Need to actually run the benchmark to pick the default model. Planned for first session.
2. **Fuzzy dedup** — Should content memory use exact text hash or fuzzy matching (catches "same news, slightly different wording")? Start with exact, iterate.
3. **Reply card positioning** — Float near the tweet or anchor to bottom of screen? Need to prototype.
4. **Keyboard shortcuts** — Worth adding? (e.g., `R` to generate reply for focused tweet, `H` to manually hide)
