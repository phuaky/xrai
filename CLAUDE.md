# CLAUDE.md

Instructions for Claude Code when working on this repo.

## Project Overview

xrai is a Chrome extension that filters Twitter/X feeds using local AI (Ollama). It classifies tweets as signal (tech/AI/startup content) or noise (everything else) and hides noise instantly.

## Architecture

**Chrome Extension** (Manifest V3, vanilla JS, no build step):
- Content scripts inject into x.com, detect tweets via MutationObserver
- Classification pipeline: reply filter → memory dedup → prefilter (regex) → viewport gate → Ollama model
- Service worker proxies HTTP calls to Ollama (content scripts can't call localhost in MV3)
- All state in chrome.storage.local + IndexedDB

**Ollama** (local, port 11434):
- Default model: `gemma2:2b` (93% accuracy, 210ms, 1.6GB)
- Backup model: `phi4-mini` (93%, 285ms, 2.5GB)
- Classification prompt uses 5 dimensions: RELEVANT, NOVELTY, SPECIFICITY, DENSITY, ACTIONABLE
- Replies use a separate prompt with style options (curious/insight/connect)

**Data Collector** (optional, port 11435):
- `node scripts/collector.js` — receives classification data from extension
- Saves to `data/classifications.jsonl` (append-only JSONL)
- Extension auto-flushes every 100 entries
- `--improve` flag auto-runs analysis every 200 entries

## Key Files

| File | Purpose |
|------|---------|
| `extension/content/main.js` | Orchestrator — wires the whole pipeline |
| `extension/content/prefilter.js` | Regex noise filter with tech safelist |
| `extension/lib/ollama.js` | Ollama API client + classification/reply prompts |
| `extension/lib/memory.js` | IndexedDB fingerprints + classification log + corrections |
| `extension/lib/config.js` | User preferences (model, threshold, hide method) |
| `extension/content/detector.js` | MutationObserver tweet detection + media detection |
| `extension/content/viewport.js` | IntersectionObserver — only classify visible tweets |
| `extension/content/classifier.js` | Batch queue with rate limiting |
| `extension/background/worker.js` | Service worker — proxies Ollama HTTP calls |
| `scripts/collector.js` | Local HTTP server for auto-exporting classification data |
| `scripts/improve.js` | Meta-learning script — analyzes corrections for prompt improvement |
| `benchmarks/benchmark.js` | Tests model accuracy/speed on 45 labeled tweets |
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

### Exporting data manually (if collector not running)
In Chrome DevTools console on x.com:
```javascript
chrome.storage.local.get('xrai_classifications', r => copy(JSON.stringify(r.xrai_classifications)))
```

## Configuration Defaults

```javascript
{
  model: 'gemma2:2b',
  ollamaUrl: 'http://localhost:11434',
  confidenceThreshold: 0.7,
  contentFilter: 'posts-only',
  hideMethod: 'remove',      // 'remove' | 'collapse' | 'blur'
  replyStyle: 'curious',     // 'curious' | 'technical' | 'casual'
  memoryRetentionDays: 30,
  maxModelCallsPerMinute: 20,
  batchSize: 5,
  batchFlushDelay: 2000
}
```

## X ToS Compliance

- Never calls X's API — only reads DOM already rendered
- Never auto-posts, auto-likes, auto-follows
- Replies are copy-paste only (never touches X's composer)
- CSS-only tweet hiding (display:none)
- No scraping — processes only what user sees in their session
