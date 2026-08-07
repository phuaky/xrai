#!/usr/bin/env node

// ISC-36/37: replay 24 real stage-1-kept X golden tweets through the
// production classifier, then measure the asynchronous memory pass from reveal
// to deterministic show/collapse. The benchmark also runs the production local
// embedding and 10,000-record full-scan retrieval path after each reveal.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SAMPLE_SIZE = 24;
const RETRIEVAL_RECORDS = 10_000;
const STAGE1_BASELINE_MS = 854;
const STAGE1_MAX_P50_MS = STAGE1_BASELINE_MS * 1.1;
const MEMORY_MAX_P50_MS = 1_500;
const MEMORY_MAX_P95_MS = 3_000;

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function loadIndex() {
  const source = fs.readFileSync(path.join(ROOT, 'extension/lib/knowledge.js'), 'utf8');
  return new Function(source + '\nreturn LocalSemanticIndex;')();
}

function loadMemoryPass() {
  const source = fs.readFileSync(path.join(ROOT, 'extension/content/x/memorypass.js'), 'utf8');
  return new Function(source + '\nreturn XraiMemoryPass;')();
}

function selectReplayItems() {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline-x.json'), 'utf8'));
  const items = L.loadGolden().items.filter((item) =>
    (item.tier === 'signal' || item.tier === 'critical-signal') &&
    baseline.decisions[item.id] === 'shown'
  ).slice(0, SAMPLE_SIZE);
  if (items.length !== SAMPLE_SIZE) throw new Error(`Need ${SAMPLE_SIZE} baseline-kept live golden tweets; found ${items.length}`);
  return items;
}

function syntheticRecords(index, base, count) {
  const records = new Array(count);
  for (let i = 0; i < count; i++) {
    const vector = new Array(base.length);
    for (let j = 0; j < base.length; j++) {
      const perturbation = (((i + 1) * (j + 17)) % 101 - 50) / 5000;
      vector[j] = base[j] + perturbation;
    }
    records[i] = {
      tweetId: String(90_000_000 + i),
      embedding: index.normalize(vector),
      exposureState: i % 3 === 0 ? 'shown' : 'hidden',
      maxDwellMs: i % 11 === 0 ? 1_000 : 0,
      updatedAt: i,
    };
  }
  return records;
}

async function requireModels(model) {
  const response = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const data = await response.json();
  const names = (data.models || []).map((entry) => entry.name);
  for (const required of [model, 'all-minilm:latest']) {
    if (!names.includes(required)) throw new Error(`Required model not installed: ${required}`);
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

function contextualPayload(items, index) {
  const item = items[index];
  const prior = items.slice(Math.max(0, index - 5), index);
  return {
    current: {
      id: item.id,
      text: item.text,
      author: item.author || '',
      truncated: false,
    },
    contexts: prior.map((context) => ({
      tweetId: context.id,
      text: context.text,
      author: context.author || '',
      truncated: false,
      knownState: 'strong',
    })),
  };
}

async function main() {
  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const prefilter = L.loadPrefilter();
  const index = loadIndex();
  const memoryPass = loadMemoryPass();
  const items = selectReplayItems();

  await requireModels(defaults.model);
  await unloadYouTubeModel();
  console.log(`bench-memory-pass-x: ${items.length} baseline-kept live golden tweets | model=${defaults.model}`);
  console.log(`  stage-1 baseline=${STAGE1_BASELINE_MS}ms | memory contexts<=5 | retrieval records=${RETRIEVAL_RECORDS}`);

  const warm = contextualPayload(items, 1);
  await worker.scheduleLocalText(defaults.model, OLLAMA_URL, function () {
    return worker.classifyX(warm.current.text, items[1].media, warm.current.author, defaults.model, OLLAMA_URL, '');
  });
  const warmEmbedding = await worker.embedLocal(warm.current.text, 'all-minilm:latest', OLLAMA_URL);
  await worker.scheduleMemoryClassification(warm.current, warm.contexts, defaults.model, OLLAMA_URL);

  const base = index.normalize(warmEmbedding.embedding);
  const records = syntheticRecords(index, base, RETRIEVAL_RECORDS);
  index.search(records, base, 5);

  const stage1Latencies = [];
  const memoryLatencies = [];
  const rows = [];
  let preRevealMemoryOps = 0;
  let stage1Kept = 0;
  let validMemoryVerdicts = 0;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const input = contextualPayload(items, itemIndex);
    const prefilterResult = prefilter.prefilter({
      text: input.current.text,
      hasMedia: !!item.media && item.media !== 'text',
      hasVideo: item.media === 'video',
      hasImage: item.media === 'image',
    });
    if (prefilterResult) throw new Error(`${item.id}: baseline-kept replay case hit prefilter ${prefilterResult.reason}`);

    let revealed = false;
    const stage1StartedAt = performance.now();
    const stage1 = await worker.scheduleLocalText(defaults.model, OLLAMA_URL, function () {
      return worker.classifyX(input.current.text, item.media || 'text', input.current.author, defaults.model, OLLAMA_URL, '');
    });
    const stage1Ms = performance.now() - stage1StartedAt;
    stage1Latencies.push(stage1Ms);
    const kept = !(stage1.prediction === 'noise' && stage1.confidence >= defaults.confidenceThreshold);
    if (!kept) throw new Error(`${item.id}: production stage 1 no longer keeps this baseline replay case`);
    stage1Kept++;
    revealed = true;

    const markMemoryOperation = function () {
      if (!revealed) preRevealMemoryOps++;
    };
    const memoryStartedAt = performance.now();
    markMemoryOperation();
    const embedded = await worker.embedLocal(input.current.text, 'all-minilm:latest', OLLAMA_URL);
    markMemoryOperation();
    const retrieved = index.search(records, embedded.embedding, 5);
    if (retrieved.length !== 5) throw new Error(`${item.id}: retrieval returned ${retrieved.length} records`);

    let memory = null;
    let action = 'show';
    let failure = null;
    markMemoryOperation();
    try {
      memory = await worker.scheduleMemoryClassification(
        input.current,
        input.contexts,
        defaults.model,
        OLLAMA_URL,
      );
      const verdict = memoryPass.validateVerdict(memory);
      if (!verdict) throw new Error('content-side verdict validation failed');
      action = memoryPass.decide(verdict, input.contexts, defaults.memoryConfidenceThreshold).action;
      validMemoryVerdicts++;
    } catch (error) {
      failure = String((error && error.message) || error);
    }
    const memoryMs = performance.now() - memoryStartedAt;
    memoryLatencies.push(memoryMs);
    rows.push({
      id: item.id,
      contexts: input.contexts.length,
      stage1Ms: Number(stage1Ms.toFixed(1)),
      stage1Prediction: stage1.prediction,
      stage1Confidence: stage1.confidence,
      memoryMs: Number(memoryMs.toFixed(1)),
      memoryNovelty: memory && memory.novelty,
      memoryConfidence: memory && memory.confidence,
      finalAction: action,
      failure,
    });
    console.log(`  ${item.id} stage1=${stage1Ms.toFixed(0)}ms memory=${memoryMs.toFixed(0)}ms ` +
      `novelty=${memory ? memory.novelty : 'FAIL'} action=${action}`);
  }

  const summary = {
    sampleSize: items.length,
    stage1Kept,
    validMemoryVerdicts,
    preRevealMemoryOps,
    stage1: {
      baselineMs: STAGE1_BASELINE_MS,
      maxP50Ms: STAGE1_MAX_P50_MS,
      p50Ms: Number(percentile(stage1Latencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(stage1Latencies, 0.95).toFixed(1)),
    },
    memory: {
      maxP50Ms: MEMORY_MAX_P50_MS,
      maxP95Ms: MEMORY_MAX_P95_MS,
      p50Ms: Number(percentile(memoryLatencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(memoryLatencies, 0.95).toFixed(1)),
    },
  };
  const failures = [];
  if (items.length !== SAMPLE_SIZE) failures.push(`sample size ${items.length} != ${SAMPLE_SIZE}`);
  if (stage1Kept !== SAMPLE_SIZE) failures.push(`stage-1 kept ${stage1Kept} != ${SAMPLE_SIZE}`);
  if (validMemoryVerdicts !== SAMPLE_SIZE) failures.push(`valid memory verdicts ${validMemoryVerdicts} != ${SAMPLE_SIZE}`);
  if (preRevealMemoryOps !== 0) failures.push(`pre-reveal memory operations ${preRevealMemoryOps} != 0`);
  if (summary.stage1.p50Ms > STAGE1_MAX_P50_MS) failures.push(`stage-1 p50 ${summary.stage1.p50Ms}ms > ${STAGE1_MAX_P50_MS.toFixed(1)}ms`);
  if (summary.memory.p50Ms > MEMORY_MAX_P50_MS) failures.push(`memory p50 ${summary.memory.p50Ms}ms > ${MEMORY_MAX_P50_MS}ms`);
  if (summary.memory.p95Ms > MEMORY_MAX_P95_MS) failures.push(`memory p95 ${summary.memory.p95Ms}ms > ${MEMORY_MAX_P95_MS}ms`);
  summary.gate = { pass: failures.length === 0, failures };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const output = path.join(RESULTS_DIR, `bench-memory-pass-x-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify({
    date: new Date().toISOString(),
    model: defaults.model,
    embeddingModel: 'all-minilm:latest',
    retrievalRecords: RETRIEVAL_RECORDS,
    summary,
    rows,
  }, null, 2) + '\n');

  console.log('\n================ ISC-36/37 SUMMARY ================');
  console.log(JSON.stringify(summary, null, 2));
  console.log('result written:', path.relative(process.cwd(), output));
  if (!summary.gate.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Fatal:', error.message || error);
  process.exitCode = 2;
});
