#!/usr/bin/env node

// xrai Data Collector — receives classification data from the extension
// Runs a tiny local server on port 11435 that the extension POSTs to
// Saves to data/classifications.jsonl (append-only, one JSON per line)
//
// Usage:
//   node scripts/collector.js              # start collector
//   node scripts/collector.js --improve    # start collector + auto-improve at 200 new entries
//
// The extension auto-sends every 100 classifications to this endpoint.
// Data is append-only — never loses old entries.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 11435;
const DATA_DIR = path.join(__dirname, '..', 'data');
const CLASSIFICATIONS_FILE = path.join(DATA_DIR, 'classifications.jsonl');
const MODEL_LOG_FILE = path.join(DATA_DIR, 'model-io.jsonl');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const TIPS_FILE = path.join(DATA_DIR, 'tips.jsonl');
const AUTO_IMPROVE = process.argv.includes('--improve');
const IMPROVE_THRESHOLD = 200;

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Track stats
let totalReceived = 0;
let sinceLastImprove = 0;

// Tip dedupe survives restarts: seed from what's already on disk
const seenTipIds = new Set();
if (fs.existsSync(TIPS_FILE)) {
  for (const line of fs.readFileSync(TIPS_FILE, 'utf8').trim().split('\n')) {
    try { const t = JSON.parse(line); if (t.tweetId) seenTipIds.add(String(t.tweetId)); } catch (e) { /* skip bad line */ }
  }
}

// Attention-event exact-duplicate guard (re-POST retries only; per-process)
const seenEventKeys = new Set();

// Load existing stats
if (fs.existsSync(STATS_FILE)) {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    totalReceived = stats.totalReceived || 0;
    sinceLastImprove = stats.sinceLastImprove || 0;
  } catch (e) { /* fresh start */ }
}

function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify({
    totalReceived,
    sinceLastImprove,
    lastUpdated: new Date().toISOString()
  }, null, 2));
}

const server = http.createServer((req, res) => {
  // CORS headers for extension
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', totalReceived, sinceLastImprove }));
    return;
  }

  // Receive classifications. Body is either a raw array (legacy X) or
  // { platform, entries } (current). Data is split per platform on disk.
  if (req.method === 'POST' && req.url === '/classifications') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let platform = 'x';
        let entries;
        if (Array.isArray(parsed)) {
          entries = parsed;
        } else {
          const p = parsed.platform;
          platform = (p === 'ytrai' || p === 'youtube') ? 'youtube' : 'x';
          entries = parsed.entries || [];
        }
        if (!Array.isArray(entries)) throw new Error('Expected entries array');

        const file = path.join(DATA_DIR, `classifications-${platform}.jsonl`);
        const lines = entries.map(e => JSON.stringify(Object.assign({ platform }, e))).join('\n') + '\n';
        fs.appendFileSync(file, lines);

        totalReceived += entries.length;
        sinceLastImprove += entries.length;
        saveStats();

        const counts = entries.reduce((a, e) => { a[e.prediction] = (a[e.prediction] || 0) + 1; return a; }, {});
        console.log(`[collector] +${entries.length} ${platform} entries (${JSON.stringify(counts)}) | total: ${totalReceived} | since improve: ${sinceLastImprove}`);

        // Auto-improve trigger (improve.js is X-tuned, so only for X data)
        if (AUTO_IMPROVE && platform === 'x' && sinceLastImprove >= IMPROVE_THRESHOLD) {
          console.log(`[collector] ${IMPROVE_THRESHOLD} new entries since last improve — triggering analysis...`);
          sinceLastImprove = 0;
          saveStats();
          triggerImprove(file);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: entries.length, total: totalReceived }));
      } catch (e) {
        console.error('[collector] Parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Receive a workflow tip (from extension/content/x/tips.js capture).
  // Append-only to data/tips.jsonl, deduped by tweetId across restarts.
  // Status lifecycle lives in scripts/tips.js, never here.
  if (req.method === 'POST' && req.url === '/tips') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const tip = JSON.parse(body);
        if (!tip.tweetId || !tip.text) throw new Error('tip needs tweetId + text');
        if (seenTipIds.has(String(tip.tweetId))) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, duplicate: true }));
          return;
        }
        seenTipIds.add(String(tip.tweetId));
        fs.appendFileSync(TIPS_FILE, JSON.stringify(tip) + '\n');
        console.log(`[collector] +1 tip (${seenTipIds.size} total) @${tip.author || '?'} [${tip.context || '?'}] "${(tip.text || '').substring(0, 70)}..."`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: seenTipIds.size }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Receive attention-ledger events ({kind:'read'} dwell / {kind:'watch'})
  // from RaiMemory.flushMirror. Pure append to data/events-<platform>.jsonl —
  // NO upsert here; all collapsing (same-day dwell sums, watch-partial MAX)
  // happens read-time in scripts/digest.js. The in-memory Set only drops
  // exact re-POSTs; partials legitimately repeat a videoId with new ts/seconds.
  if (req.method === 'POST' && req.url === '/events') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const p = parsed.platform;
        const platform = (p === 'ytrai' || p === 'youtube') ? 'youtube' : 'x';
        const entries = parsed.entries || [];
        if (!Array.isArray(entries)) throw new Error('Expected entries array');

        const lines = [];
        for (const e of entries) {
          const key = `${e.kind}|${e.tweetId || e.videoId || ''}|${e.ts || ''}|${e.dwellMs ?? e.seconds ?? ''}`;
          if (seenEventKeys.has(key)) continue;
          seenEventKeys.add(key);
          lines.push(JSON.stringify(Object.assign({ platform }, e)));
        }
        if (lines.length) {
          fs.appendFileSync(path.join(DATA_DIR, `events-${platform}.jsonl`), lines.join('\n') + '\n');
        }
        console.log(`[collector] +${lines.length} ${platform} attention events (${entries.length - lines.length} dup)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: lines.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Receive model I/O log — every single model call with input + raw output
  if (req.method === 'POST' && req.url === '/model-log') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        fs.appendFileSync(MODEL_LOG_FILE, JSON.stringify(entry) + '\n');
        const r = entry.result || {};
        const verdict = r.prediction || r.category || '?';
        console.log(`[collector] model-io (${entry.platform || 'x'}): ${verdict} (${r.confidence}) ${entry.elapsed}ms | "${(entry.input || '').substring(0, 60)}..."`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Get model I/O log
  if (req.method === 'GET' && req.url === '/model-log') {
    if (!fs.existsSync(MODEL_LOG_FILE)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const lines = fs.readFileSync(MODEL_LOG_FILE, 'utf8').trim().split('\n');
    const entries = lines.filter(l => l).map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // Get recent classifications (for the improve script)
  if (req.method === 'GET' && req.url === '/classifications') {
    if (!fs.existsSync(CLASSIFICATIONS_FILE)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const lines = fs.readFileSync(CLASSIFICATIONS_FILE, 'utf8').trim().split('\n');
    const entries = lines.filter(l => l).map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function triggerImprove(file) {
  const { execSync } = require('child_process');
  try {
    const target = file || CLASSIFICATIONS_FILE;
    const output = execSync(`node ${path.join(__dirname, 'improve.js')} ${target}`, { encoding: 'utf8', timeout: 30000 });
    console.log(output);
  } catch (e) {
    console.error('[collector] Improve script error:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`[xrai collector] Listening on http://localhost:${PORT}`);
  console.log(`[xrai collector] Data file: ${CLASSIFICATIONS_FILE}`);
  console.log(`[xrai collector] Total entries: ${totalReceived}`);
  if (AUTO_IMPROVE) {
    console.log(`[xrai collector] Auto-improve: every ${IMPROVE_THRESHOLD} new entries`);
  }
  console.log('');
});
