#!/usr/bin/env node

// ISC-53/54: exercise the exact production worker adapter against real Ollama,
// including one forced cold load and a 100-call warm reliability run.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./load-extension.js');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = 'all-minilm:latest';
const EXPECTED_DIMENSIONS = 384;
const WARM_RUNS = 100;
const WARM_P95_GATE_MS = 150;

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function validVector(result) {
  return !!result && Array.isArray(result.embedding) &&
    result.embedding.length === EXPECTED_DIMENSIONS &&
    result.embedding.every(Number.isFinite);
}

function unloadEmbeddingModel() {
  const stopped = spawnSync('ollama', ['stop', MODEL], { encoding: 'utf8' });
  if (stopped.error) throw stopped.error;
  if (stopped.status !== 0) {
    throw new Error(`ollama stop failed: ${(stopped.stderr || stopped.stdout || '').trim()}`);
  }
}

async function installedModels() {
  const response = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const data = await response.json();
  return (data.models || []).map((entry) => entry.name || entry.model);
}

async function timedEmbedding(worker, text) {
  const startedAt = performance.now();
  const result = await worker.embedLocal(text, MODEL, OLLAMA_URL);
  return { result, elapsedMs: performance.now() - startedAt };
}

async function main() {
  const worker = L.loadWorker();
  const models = await installedModels();
  if (!models.includes(MODEL)) throw new Error(`Required model not installed: ${MODEL}`);

  unloadEmbeddingModel();
  const cold = await timedEmbedding(worker, 'rai cold-start embedding health probe');

  const warmLatencies = [];
  let warmSuccesses = 0;
  for (let index = 0; index < WARM_RUNS; index++) {
    const probe = await timedEmbedding(worker, `rai warm embedding health probe ${index}`);
    warmLatencies.push(probe.elapsedMs);
    if (validVector(probe.result)) warmSuccesses++;
  }

  const summary = {
    model: MODEL,
    configuredTimeoutMs: worker.EMBEDDING_TIMEOUT_MS,
    configuredKeepAlive: worker.EMBEDDING_KEEP_ALIVE,
    dimensions: cold.result && cold.result.embedding && cold.result.embedding.length,
    cold: {
      success: validVector(cold.result),
      elapsedMs: Number(cold.elapsedMs.toFixed(1)),
      beforeDeadline: cold.elapsedMs < worker.EMBEDDING_TIMEOUT_MS,
    },
    warm: {
      runs: WARM_RUNS,
      successes: warmSuccesses,
      p50Ms: Number(percentile(warmLatencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(warmLatencies, 0.95).toFixed(1)),
      maxMs: Number(Math.max(...warmLatencies).toFixed(1)),
      gateMs: WARM_P95_GATE_MS,
    },
  };
  const failures = [];
  if (!summary.cold.success) failures.push('cold adapter response is not a valid 384-dimensional vector');
  if (!summary.cold.beforeDeadline) failures.push(`cold load ${summary.cold.elapsedMs}ms exceeded ${summary.configuredTimeoutMs}ms`);
  if (warmSuccesses !== WARM_RUNS) failures.push(`warm successes ${warmSuccesses}/${WARM_RUNS}`);
  if (summary.warm.p95Ms > WARM_P95_GATE_MS) failures.push(`warm p95 ${summary.warm.p95Ms}ms > ${WARM_P95_GATE_MS}ms`);
  summary.gate = { pass: failures.length === 0, failures };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const output = path.join(RESULTS_DIR, `bench-embedding-worker-x-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), summary }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log('result written:', path.relative(process.cwd(), output));
  if (!summary.gate.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Fatal:', error.message || error);
  process.exitCode = 2;
});
