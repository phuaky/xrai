#!/usr/bin/env node

// Burst-latency benchmark over recent live X traffic.
//
// Usage:
//   node benchmarks/bench-live-x.js
//   node benchmarks/bench-live-x.js --since 2026-07-23 --sample 24
//   node benchmarks/bench-live-x.js --concurrency 1,2,3 --model MODEL

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');

const ROOT = path.join(__dirname, '..');
const EVENTS_PATH = path.join(ROOT, 'data/events-x.jsonl');
const RESULTS_DIR = path.join(__dirname, 'results');
const OLLAMA_URL = 'http://localhost:11434';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function quantile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function unloadOtherRaiModels(target) {
  try {
    const data = await fetch(OLLAMA_URL + '/api/ps').then((r) => r.json());
    const known = new Set([
      L.loadConfigDefaults().x.model,
      L.loadConfigDefaults().youtube.model,
    ]);
    for (const m of data.models || []) {
      const name = m.name || m.model;
      if (!name || name === target || !known.has(name)) continue;
      await fetch(OLLAMA_URL + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
      });
    }
  } catch {
    // The model availability check below will produce the useful error.
  }
}

async function main() {
  if (!fs.existsSync(EVENTS_PATH)) {
    throw new Error('Missing live data: ' + EVENTS_PATH);
  }

  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const since = arg('since', new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
  const sampleSize = Number(arg('sample', '24'));
  const concurrencies = arg('concurrency', '1,2,3').split(',').map(Number).filter((n) => n > 0);
  const model = arg('model', defaults.model);
  const cutoff = Date.parse(since + 'T00:00:00Z');

  const byId = new Map();
  for (const row of readRows(EVENTS_PATH)) {
    if (row.ts < cutoff || row.kind || row.source !== 'model' || !row.text || !row.tweetId) continue;
    if (!byId.has(String(row.tweetId))) byId.set(String(row.tweetId), row);
  }
  const items = [...byId.values()]
    .sort((a, b) => hash(a.tweetId) - hash(b.tweetId))
    .slice(0, sampleSize);
  if (!items.length) throw new Error('No model-classified X tweets found since ' + since);

  await unloadOtherRaiModels(model);
  const tags = await fetch(OLLAMA_URL + '/api/tags').then((r) => r.json());
  const names = (tags.models || []).map((m) => m.name);
  if (!names.includes(model)) throw new Error(`Model "${model}" is not installed`);

  async function classify(item) {
    const userMsg = L.toUserMessage({ text: item.text, media: item.mediaType, author: item.author });
    const start = Date.now();
    const res = await fetch(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: worker.X_CLASSIFY_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        stream: false,
        think: false,
        keep_alive: worker.TEXT_KEEP_ALIVE,
        options: {
          temperature: 0.1,
          num_predict: 80,
          num_ctx: worker.TEXT_NUM_CTX,
        },
      }),
    });
    await res.json();
    return Date.now() - start;
  }

  async function run(concurrency) {
    let next = 0;
    const times = [];
    const start = Date.now();
    let firstMs = null;

    async function lane() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        const ms = await classify(items[i]);
        times.push(ms);
        if (firstMs === null) firstMs = Date.now() - start;
      }
    }

    await Promise.all(Array.from({ length: concurrency }, lane));
    const wallMs = Date.now() - start;
    return {
      concurrency,
      items: times.length,
      firstMs,
      p50: quantile(times, 0.5),
      p90: quantile(times, 0.9),
      p95: quantile(times, 0.95),
      avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      wallMs,
      tweetsPerSecond: Number((times.length / (wallMs / 1000)).toFixed(2)),
    };
  }

  console.log(`bench-live-x: ${items.length} tweets since ${since} | model=${model}`);
  console.log('warming model...');
  await classify(items[0]);

  const results = [];
  for (const concurrency of concurrencies) {
    const result = await run(concurrency);
    results.push(result);
    console.log(result);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = path.join(RESULTS_DIR, `bench-live-x-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({
    date: new Date().toISOString(),
    since,
    sampleSize: items.length,
    model,
    results,
  }, null, 2) + '\n');
  console.log('result written:', path.relative(process.cwd(), out));
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
