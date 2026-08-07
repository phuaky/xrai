#!/usr/bin/env bun
// ISC-35: real local query embedding plus the production top-five full scan over
// 10,000 claim-history records. Reports p50/p95 and fails above the 150ms p95 gate.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.RAI_EMBEDDING_MODEL || 'all-minilm:latest';
const RECORDS = 10_000;
const RUNS = Math.max(5, Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1]) || 30);
const P95_GATE_MS = 150;

function loadIndex() {
  const source = readFileSync(join(ROOT, 'extension/lib/knowledge.js'), 'utf8');
  return new Function(`${source}\nreturn LocalSemanticIndex;`)();
}

async function embed(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: text, truncate: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ollama embed HTTP ${response.status}`);
  const data = await response.json();
  const vector = data.embedding || (data.embeddings && data.embeddings[0]);
  if (!Array.isArray(vector) || !vector.length) throw new Error('invalid embedding response');
  return vector;
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

const index = loadIndex();
const queryText = 'local AI agents with concrete reliability benchmarks and production evidence';
const base = index.normalize(await embed(queryText));
const records = new Array(RECORDS);

// Deterministic, dimension-correct vectors with varied similarity. These are
// normalized once as they are in claim history; search still executes its real
// validation/normalization path on every query.
for (let i = 0; i < RECORDS; i++) {
  const vector = new Array(base.length);
  for (let j = 0; j < base.length; j++) {
    const perturbation = (((i + 1) * (j + 17)) % 101 - 50) / 5000;
    vector[j] = base[j] + perturbation;
  }
  records[i] = {
    tweetId: String(10_000_000 + i),
    embedding: index.normalize(vector),
    exposureState: i % 3 === 0 ? 'shown' : 'hidden',
    maxDwellMs: i % 11 === 0 ? 1_000 : 0,
    updatedAt: i,
  };
}

// Warm local model and JIT before measured runs.
await embed(queryText);
index.search(records, base, 5);

const latencies = [];
let lastResults = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const query = await embed(queryText);
  lastResults = index.search(records, query, 5);
  latencies.push(performance.now() - started);
}
latencies.sort((a, b) => a - b);

const output = {
  records: RECORDS,
  dimensions: base.length,
  runs: RUNS,
  model: MODEL,
  p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
  p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
  maxMs: Number(latencies.at(-1).toFixed(1)),
  resultCount: lastResults.length,
  ordered: lastResults.every((result, i) => i === 0 || lastResults[i - 1].similarity >= result.similarity),
  gateMs: P95_GATE_MS,
};
console.log(JSON.stringify(output, null, 2));

if (output.resultCount !== 5 || !output.ordered || output.p95Ms > P95_GATE_MS) process.exitCode = 1;
