# CLAUDE.md

Instructions for Claude Code when working on this repo.

## Project Overview

xrai is a Chrome extension that filters Twitter/X feeds using local AI (Ollama). It classifies tweets as signal (tech/AI/startup content) or noise (everything else) and hides noise instantly.

## Architecture

**Chrome Extension** (Manifest V3, vanilla JS, no build step):
- Content scripts inject into x.com, detect tweets via MutationObserver
- Classification pipeline: reply filter → prefilter (regex) → result cache → Ollama model (5 concurrent)
- Filtering is scoped to `/home*` (and `/`) only — status detail, profile, explore, notifications, search, bookmarks, lists, and messages render tweets untouched (no blur, hide, or classify). Detection + reply-button + new-tab handlers still attach everywhere.
- Service worker proxies HTTP calls to Ollama (content scripts can't call localhost in MV3)
- All state in chrome.storage.local + in-memory result cache (no IndexedDB dedup)

**Ollama** (local, port 11434):
- Default model: `phi4-mini` (92% accuracy, 518ms avg, 2.5GB) — best accuracy
- Backup model: `gemma2:2b` (88%, 231ms avg, 1.6GB) — fastest
- Classification prompt uses 4 dimensions: NOVELTY, SPECIFICITY, DENSITY, AUTHENTICITY
- Benchmark: 89 tweets (41 signal, 48 noise) from synthetic + real timeline + bookmarks + chrome.storage
- Replies use a separate prompt with style options (curious/insight/connect)

**Data Collector** (optional, port 11435):
- `node scripts/collector.js` — receives classification data from extension
- Saves to `data/classifications.jsonl` (append-only JSONL)
- Extension auto-flushes every 100 entries
- `--improve` flag auto-runs analysis every 200 entries

## Key Files

| File | Purpose |
|------|---------|
| `extension/content/main.js` | Orchestrator — flat pipeline, every tweet gets a decision |
| `extension/content/prefilter.js` | Regex noise filter with tech safelist |
| `extension/lib/ollama.js` | Ollama API client + classification/reply prompts |
| `extension/lib/memory.js` | Classification log + corrections (IndexedDB, no dedup) |
| `extension/lib/config.js` | User preferences (model, threshold, hide method) |
| `extension/content/detector.js` | MutationObserver tweet detection + media detection |
| `extension/content/classifier.js` | Concurrent queue (max 5) with result cache |
| `extension/background/worker.js` | Service worker — proxies Ollama HTTP calls |
| `scripts/collector.js` | Local HTTP server for auto-exporting classification data |
| `scripts/improve.js` | Meta-learning script — analyzes corrections for prompt improvement |
| `benchmarks/benchmark.js` | Tests model accuracy/speed on 78 labeled tweets |
| `benchmarks/bookmarks-raw.json` | Raw tweet dump from X bookmarks (114 entries) |
| `SPEC.md` | Full architecture specification |

## Common Commands

```bash
# Start data collector (optional, saves classifications to local filesystem)
node scripts/collector.js
node scripts/collector.js --improve    # auto-improve every 200 entries

# Run model benchmark
node benchmarks/benchmark.js

# Analyze classifications for filter improvements
node scripts/improve.js data/classifications.jsonl

# Syntax check all JS files
for f in extension/lib/*.js extension/content/*.js extension/background/*.js scripts/*.js; do node -c "$f" && echo "OK: $f"; done

# Check Ollama status
curl -s http://localhost:11434/api/tags | python3 -m json.tool

# Pull recommended model
ollama pull gemma2:2b

# List installed models
ollama list

# Test a single classification
curl -s http://localhost:11434/api/chat -d '{
  "model": "gemma2:2b",
  "messages": [{"role": "system", "content": "Classify tweet. JSON: {\"prediction\":\"signal\"|\"noise\",\"confidence\":0.8}"},
               {"role": "user", "content": "Your tweet text here"}],
  "stream": false, "options": {"temperature": 0.1}
}'
```

## Development

### Loading the extension
1. `chrome://extensions` → Developer mode ON → Load unpacked → select `extension/`
2. After code changes: click the reload icon on the extension card, then refresh x.com

### Content script isolation
Content scripts run in an isolated world — `XraiMain`, `XraiDetector`, etc. are NOT accessible from the page's JS console. They communicate with the service worker via `chrome.runtime.sendMessage`.

### Adding prefilter patterns
Edit `extension/content/prefilter.js`. Patterns caught by TECH_SIGNAL or BIZ_SIGNAL regex are safelisted (never filtered). Everything else goes through the noise regex categories, then the short-video/short-image catch-all.

### Modifying the classification prompt
Edit the `CLASSIFY_SYSTEM` variable in `extension/lib/ollama.js`. Keep prompts short — these run on 1.5-4B models. Test changes with `node benchmarks/benchmark.js`.

### Adding new models to benchmark
Edit `MODELS` array in `benchmarks/benchmark.js`. Run `ollama pull model:tag` first.

## Data Pipeline

```
Extension (x.com)
  → every 100 classifications → POST localhost:11435/classifications
  → collector.js appends to data/classifications.jsonl
  → at 200 new entries (with --improve): runs scripts/improve.js
  → improve.js analyzes patterns, generates prompt for claude -p
```

### Extracting training data from chrome.storage (PRIMARY source for benchmark improvement)

The extension stores every classification decision in `chrome.storage.local` under `xrai_classifications` (up to 1,000 entries) and user corrections under `xrai_corrections` (up to 500 entries). **This is the primary data source for improving the benchmark and prompts.**

**Method 1: Via service worker message** (works from content script or DevTools extension context):
```javascript
chrome.runtime.sendMessage({ action: 'exportData' }, function(data) {
  console.log('Classifications:', data.classifications.length);
  console.log('Corrections:', data.corrections.length);
  copy(JSON.stringify(data)); // copies to clipboard
});
```

**Method 2: Direct chrome.storage access** (DevTools console on x.com, select extension context):
```javascript
chrome.storage.local.get(['xrai_classifications', 'xrai_corrections'], r => {
  copy(JSON.stringify({ classifications: r.xrai_classifications, corrections: r.xrai_corrections }))
});
```

**Method 3: Via data collector** (auto-exports when running):
```bash
node scripts/collector.js  # receives data at localhost:11435, saves to data/classifications.jsonl
```

**Workflow for improving benchmarks:**
1. Browse X with the extension active — it accumulates classification data
2. Export classifications using any method above
3. Review and label the data (especially corrections — these are misclassifications)
4. Add labeled tweets to `benchmarks/benchmark.js` TEST_TWEETS array
5. Run `node benchmarks/benchmark.js` to measure model accuracy
6. Use misclassification patterns to improve prompts in `extension/background/worker.js`

## Configuration Defaults

```javascript
{
  model: 'phi4-mini',
  ollamaUrl: 'http://localhost:11434',
  confidenceThreshold: 0.7,
  contentFilter: 'posts-only',
  hideMethod: 'remove',      // 'remove' | 'collapse' | 'blur'
  replyStyle: 'curious',     // 'curious' | 'technical' | 'casual'
  memoryRetentionDays: 30,
  maxModelCallsPerMinute: 100
}
```

## X ToS Compliance

- Never calls X's API — only reads DOM already rendered
- Never auto-posts, auto-likes, auto-follows
- Replies are copy-paste only (never touches X's composer)
- CSS-only tweet hiding (display:none)
- No scraping — processes only what user sees in their session
