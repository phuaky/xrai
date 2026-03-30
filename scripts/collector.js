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
const AUTO_IMPROVE = process.argv.includes('--improve');
const IMPROVE_THRESHOLD = 200;

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Track stats
let totalReceived = 0;
let sinceLastImprove = 0;

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

  // Receive classifications
  if (req.method === 'POST' && req.url === '/classifications') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entries = JSON.parse(body);
        if (!Array.isArray(entries)) throw new Error('Expected array');

        // Append each entry as a JSONL line
        const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFileSync(CLASSIFICATIONS_FILE, lines);

        totalReceived += entries.length;
        sinceLastImprove += entries.length;
        saveStats();

        const noiseCount = entries.filter(e => e.prediction === 'noise').length;
        const signalCount = entries.filter(e => e.prediction === 'signal').length;
        console.log(`[collector] +${entries.length} entries (${signalCount} signal, ${noiseCount} noise) | total: ${totalReceived} | since improve: ${sinceLastImprove}`);

        // Auto-improve trigger
        if (AUTO_IMPROVE && sinceLastImprove >= IMPROVE_THRESHOLD) {
          console.log(`[collector] ${IMPROVE_THRESHOLD} new entries since last improve — triggering analysis...`);
          sinceLastImprove = 0;
          saveStats();
          triggerImprove();
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

  // Receive model I/O log — every single model call with input + raw output
  if (req.method === 'POST' && req.url === '/model-log') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        fs.appendFileSync(MODEL_LOG_FILE, JSON.stringify(entry) + '\n');
        console.log(`[collector] model-io: ${entry.prediction} (${entry.confidence}) ${entry.elapsed}ms | "${(entry.input || '').substring(0, 60)}..."`);
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

function triggerImprove() {
  const { execSync } = require('child_process');
  try {
    const output = execSync(`node ${path.join(__dirname, 'improve.js')} ${CLASSIFICATIONS_FILE}`, { encoding: 'utf8', timeout: 30000 });
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
