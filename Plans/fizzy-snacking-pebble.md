# Plan: Simplify xrai Classification Pipeline

## Context

The current pipeline has 6 skip points across 4 files (detector, main, viewport, classifier). The viewport gate uses dual IntersectionObservers with concurrency caps, visibility timers, and a pending map — 150 lines that can silently drop tweets. The batch classifier adds flush timers and rate limiting complexity. Tweets scrolled past quickly never get classified. No logging at silent skip points.

**Goal:** Replace with a flat, cache-based pipeline where every tweet gets a decision, 3-5 concurrent Ollama calls, and console logs at every step.

## Changes

### 1. Rewrite `extension/content/classifier.js` — Simple concurrent queue

Replace the batch queue with a concurrent classifier:
- `resultCache` Map: tweetId → `{prediction, confidence, source}` — replaces both the old `processed` Set in detector AND the fingerprint dedup
- `checkCache(id)` — returns cached result or null
- `cacheResult(id, result)` — stores result
- `classify(id, text, mediaType, callback)` — if cached, callback immediately; otherwise queue for Ollama
- Max 5 in-flight Ollama calls (`activeCount` counter)
- When a call completes: cache result, fire callback, drain next from queue
- Rate limit stays (20/min) as the only throttle
- Each tweet sends its own `chrome.runtime.sendMessage({action: 'classify'})` — no batching into one prompt

### 2. Flatten `extension/content/main.js` — Straight pipeline with cache

Remove viewport gate integration. The `handleTweet` function becomes:

```
handleTweet(info):
  1. Reply filter (posts-only + isReply → hide, LOG)
  2. Prefilter regex (noise pattern → hide + cache result, LOG)
  3. XraiClassifier.classify(id, text, mediaType, callback)
     - Cache hit → apply result instantly (LOG)
     - Cache miss → queue for Ollama → callback with result (LOG)
     - noise + confidence >= threshold → hide
     - else → show + attach reply button
```

Every path gets a `console.log('[xrai] ...')` line. No silent drops.

Remove: `XraiViewport.observe()` call, fingerprint computation (`XraiMemory.computeFingerprint` call at line 90).

### 3. Simplify `extension/content/detector.js` — Remove `processed` Set

- Remove the `processed` Set and its check at line 115
- Instead, just call callbacks for every tweet element found
- The classifier's `resultCache` handles "already classified" by returning cached result instantly
- Keep `extractData`, `extractTweetId`, etc. unchanged
- Keep MutationObserver + debounce unchanged

Wait — actually we still need element-level dedup. The MutationObserver fires on every DOM change. Without the `processed` Set, the same tweet element triggers `handleTweet` on every mutation. The cache will return instantly for known IDs, but we'd still be calling `handleTweet` + extracting data 10-20x per tweet.

**Revised approach:** Keep `processed` Set in detector for element-level dedup (prevents redundant `extractData` calls), BUT add a log when skipping. The classifier cache is for when the same tweet ID appears after a scroll-back (element is new but content was already classified).

### 4. Delete viewport gate — `extension/content/viewport.js`

Remove this file entirely. Remove its `<script>` tag from `extension/manifest.json` (or wherever content scripts are declared).

### 5. Update `extension/manifest.json`

Remove `content/viewport.js` from the content_scripts array.

## Files Modified

| File | Action |
|------|--------|
| `extension/content/classifier.js` | Rewrite — concurrent queue with result cache |
| `extension/content/main.js` | Simplify — flat pipeline, remove viewport, add logs |
| `extension/content/detector.js` | Minor — add log to processed-skip |
| `extension/content/viewport.js` | Delete |
| `extension/manifest.json` | Remove viewport.js from content_scripts |

## Files NOT Modified

| File | Reason |
|------|--------|
| `extension/background/worker.js` | Already has `classifySingle` — we just call it per-tweet instead of batch |
| `extension/content/prefilter.js` | Stays as-is, working well |
| `extension/content/hider.js` | Stays as-is |
| `extension/lib/memory.js` | Stays for classification logging (not dedup) |
| `extension/lib/config.js` | Stays as-is |

## Verification

1. `node -c` syntax check all modified JS files
2. Load extension in Chrome (`chrome://extensions` → reload)
3. Open x.com, open DevTools console, filter by `[xrai]`
4. Verify every tweet produces exactly one log line:
   - `[xrai] REPLY hide` — reply filtered
   - `[xrai] PREFILTER kill: <reason>` — regex caught it
   - `[xrai] CACHE hit: <signal/noise>` — already classified this ID
   - `[xrai] OLLAMA → <signal/noise> (<confidence>)` — fresh classification
5. Scroll down, scroll back up — confirm cache hits on return
6. Check no tweets slip through without a log line
7. Verify Ollama health check still works (indicator shows connected)
