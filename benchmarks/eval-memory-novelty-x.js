#!/usr/bin/env node

// Runtime-prompt novelty evaluation over the 50 real ISC-52 cases. Unlike the
// earlier kill-switch spike, this calls the complete production memory pipeline:
// focused novelty, conditional confirmation/overlap checks, a collapse guard,
// then the strict six-field verdict.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');
const novelty = require('./novelty-spike-x.js');

const ROOT = path.join(__dirname, '..');
const EVENTS_PATH = path.join(ROOT, 'data', 'events-x.jsonl');
const CASES_PATH = path.join(__dirname, 'novelty-spike-cases-x.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'all-minilm:latest';
const MIN_VALID = 50;
const MIN_POLICY_AGREEMENT = 0.85;
const MIN_REPEAT_COLLAPSE_RECALL = 0.8;
const MAX_UPDATE_FALSE_COLLAPSE = 0;

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

async function requireModels(models) {
  const response = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const data = await response.json();
  const names = (data.models || []).map((entry) => entry.name);
  for (const model of models) {
    if (!names.includes(model)) throw new Error(`Required model not installed: ${model}`);
  }
}

async function unloadYouTubeModel() {
  await fetch(OLLAMA_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: L.loadConfigDefaults().youtube.model, keep_alive: 0 }),
    signal: AbortSignal.timeout(5_000),
  }).catch(function () {});
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function fixtureSimilarities(items) {
  const textById = new Map();
  for (const item of items) {
    textById.set(item.current.id, item.current.text);
    for (const context of item.contexts) textById.set(context.id, context.text);
  }
  const ids = [...textById.keys()];
  const response = await fetch(OLLAMA_URL + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: ids.map((id) => textById.get(id)),
      truncate: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/embed returned HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== ids.length) {
    throw new Error('Embedding response did not cover the novelty fixture');
  }
  const vectorById = new Map(ids.map((id, index) => [id, data.embeddings[index]]));
  return new Map(items.map((item) => [
    item.id,
    item.contexts.map((context) => cosine(
      vectorById.get(item.current.id),
      vectorById.get(context.id),
    )),
  ]));
}

function payload(item, similarities) {
  return {
    current: {
      id: item.current.id,
      text: item.current.text,
      author: '',
      truncated: item.current.truncated === true,
    },
    contexts: item.contexts.slice(0, 5).map((context, index) => ({
      tweetId: context.id,
      text: context.text,
      author: '',
      truncated: context.truncated === true,
      similarity: similarities[index],
    })),
  };
}

async function main() {
  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const fixture = novelty.loadCases(CASES_PATH);
  const resolved = novelty.resolveCases(fixture, novelty.loadEventTexts(EVENTS_PATH));
  if (resolved.invalid.length) throw new Error(`Fixture has ${resolved.invalid.length} invalid cases`);
  await requireModels([defaults.model, EMBEDDING_MODEL]);
  await unloadYouTubeModel();
  const similarities = await fixtureSimilarities(resolved.valid);

  const warm = payload(resolved.valid[0], similarities.get(resolved.valid[0].id));
  await worker.scheduleMemoryClassification(warm.current, warm.contexts, defaults.model, OLLAMA_URL);

  const results = [];
  for (const item of resolved.valid) {
    const input = payload(item, similarities.get(item.id));
    const startedAt = performance.now();
    try {
      const verdict = await worker.scheduleMemoryClassification(
        input.current,
        input.contexts,
        defaults.model,
        OLLAMA_URL,
      );
      const ms = performance.now() - startedAt;
      const exact = verdict.novelty === item.expected;
      const collapsedClass = verdict.novelty === 'repeat' || verdict.novelty === 'reinforcement';
      const policyCorrect = item.expected === 'repeat' ? collapsedClass : !collapsedClass;
      results.push({
        id: item.id,
        expected: item.expected,
        predicted: verdict.novelty,
        confidence: verdict.confidence,
        exact,
        collapsedClass,
        policyCorrect,
        noveltySide: verdict._noveltySide,
        noveltyChecks: verdict._noveltyChecks,
        maxSimilarity: Math.max(...input.contexts.map((context) => context.similarity)),
        ms: Number(ms.toFixed(1)),
      });
      console.log(`  ${policyCorrect ? 'PASS' : 'MISS'} ${item.id} expected=${item.expected} ` +
        `predicted=${verdict.novelty} ${ms.toFixed(0)}ms`);
    } catch (error) {
      const ms = performance.now() - startedAt;
      results.push({
        id: item.id,
        expected: item.expected,
        predicted: null,
        confidence: null,
        exact: false,
        collapsedClass: false,
        policyCorrect: false,
        failure: String((error && error.message) || error),
        ms: Number(ms.toFixed(1)),
      });
      console.log(`  FAIL ${item.id} expected=${item.expected} invalid-output ${ms.toFixed(0)}ms`);
    }
  }

  const valid = results.filter((result) => result.predicted);
  const exact = valid.filter((result) => result.exact);
  const policyCorrect = valid.filter((result) => result.policyCorrect);
  const repeats = valid.filter((result) => result.expected === 'repeat');
  const collapsedRepeats = repeats.filter((result) => result.collapsedClass);
  const updates = valid.filter((result) => result.expected === 'meaningful-update');
  const collapsedUpdates = updates.filter((result) => result.collapsedClass);
  const latencies = valid.map((result) => result.ms);
  const summary = {
    total: results.length,
    valid: valid.length,
    exact: exact.length,
    exactAgreement: valid.length ? exact.length / valid.length : 0,
    policyCorrect: policyCorrect.length,
    policyAgreement: valid.length ? policyCorrect.length / valid.length : 0,
    repeats: repeats.length,
    collapsedRepeats: collapsedRepeats.length,
    repeatCollapseRecall: repeats.length ? collapsedRepeats.length / repeats.length : 0,
    meaningfulUpdates: updates.length,
    meaningfulUpdatesCollapsed: collapsedUpdates.length,
    updateFalseCollapseRate: updates.length ? collapsedUpdates.length / updates.length : 0,
    latency: {
      p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    },
  };
  const failures = [];
  if (summary.valid < MIN_VALID) failures.push(`valid ${summary.valid} < ${MIN_VALID}`);
  if (summary.policyAgreement < MIN_POLICY_AGREEMENT) {
    failures.push(`policy agreement ${(summary.policyAgreement * 100).toFixed(1)}% < ${MIN_POLICY_AGREEMENT * 100}%`);
  }
  if (summary.repeatCollapseRecall < MIN_REPEAT_COLLAPSE_RECALL) {
    failures.push(`repeat collapse recall ${(summary.repeatCollapseRecall * 100).toFixed(1)}% < ${MIN_REPEAT_COLLAPSE_RECALL * 100}%`);
  }
  if (summary.updateFalseCollapseRate > MAX_UPDATE_FALSE_COLLAPSE) {
    failures.push(`${summary.meaningfulUpdatesCollapsed} material updates assigned a collapse class`);
  }
  summary.gate = { pass: failures.length === 0, failures };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const output = path.join(RESULTS_DIR, `eval-memory-novelty-x-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify({
    date: new Date().toISOString(),
    model: defaults.model,
    promptSha: L.sha([
      worker.X_MEMORY_NOVELTY_SYSTEM,
      worker.X_MEMORY_FAMILIAR_CONFIRM_SYSTEM,
      worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM,
      worker.X_MEMORY_IMPORTANCE_SYSTEM,
      worker.X_MEMORY_SYSTEM,
    ].join('\n---\n')),
    summary,
    results,
  }, null, 2) + '\n');

  console.log('\n================ RUNTIME MEMORY NOVELTY ================');
  console.log(JSON.stringify(summary, null, 2));
  console.log('result written:', path.relative(process.cwd(), output));
  if (!summary.gate.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Fatal:', error.message || error);
  process.exitCode = 2;
});
