#!/usr/bin/env node

// ISC-57: replay current post-freeze traffic through the production stage-1
// model, real local embeddings/retrieval, memory model, and deterministic policy.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');

const ROOT = path.join(__dirname, '..');
const SOURCE = process.env.RAI_X_EVENTS || path.join(ROOT, 'data', 'events-x.jsonl');
const RESULTS_DIR = path.join(__dirname, 'results');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'all-minilm:latest';
const DEFAULT_SAMPLE_SIZE = 100;
const MIN_RETRIEVAL_SUCCESS_RATE = 0.99;
const CUTOFF_TS = Date.parse('2026-08-06T00:00:00Z');

function parseArgs(argv) {
  const sampleArg = argv.find((arg) => arg.startsWith('--sample='));
  const sampleSize = sampleArg ? Number(sampleArg.slice('--sample='.length)) : DEFAULT_SAMPLE_SIZE;
  if (!Number.isInteger(sampleSize) || sampleSize < 2) throw new Error('--sample must be an integer >= 2');
  return { sampleSize };
}

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function parseEvents(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function loadIndex() {
  const source = fs.readFileSync(path.join(ROOT, 'extension/lib/knowledge.js'), 'utf8');
  return new Function(source + '\nreturn LocalSemanticIndex;')();
}

function candidateTweets(events) {
  const dwellById = new Map();
  for (const event of events) {
    if (event.kind !== 'read' || !event.tweetId) continue;
    const id = String(event.tweetId);
    dwellById.set(id, (dwellById.get(id) || 0) + Math.max(0, Number(event.dwellMs) || 0));
  }

  const byId = new Map();
  for (const event of events) {
    if (event.kind != null || event.decision !== 'shown' || event.source !== 'model' ||
        event.prediction !== 'signal' || !event.tweetId || !String(event.text || '').trim() ||
        !Number.isFinite(event.ts) || event.ts < CUTOFF_TS) continue;
    const id = String(event.tweetId);
    const current = byId.get(id);
    if (!current || String(event.text).length > String(current.text).length ||
        (String(event.text).length === String(current.text).length && event.ts > current.ts)) {
      byId.set(id, event);
    }
  }
  return [...byId.values()].sort((left, right) => left.ts - right.ts).map((event) => ({
    id: String(event.tweetId),
    text: String(event.text),
    author: event.author || '',
    mediaType: event.mediaType || 'text',
    timestamp: event.ts,
    maxDwellMs: dwellById.get(String(event.tweetId)) || 0,
  }));
}

async function requireModels(model) {
  const response = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const data = await response.json();
  const names = (data.models || []).map((entry) => entry.name || entry.model);
  for (const required of [model, EMBEDDING_MODEL]) {
    if (!names.includes(required)) throw new Error(`Required model not installed: ${required}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const prefilter = L.loadPrefilter();
  const memoryPass = L.loadMemoryPass();
  const index = loadIndex();
  const events = parseEvents(SOURCE);
  const candidates = candidateTweets(events);
  if (candidates.length < options.sampleSize) {
    throw new Error(`Need ${options.sampleSize} current shown/model/signal candidates; found ${candidates.length}`);
  }
  await requireModels(defaults.model);

  const history = [];
  const rows = [];
  const stage1Latencies = [];
  const memoryLatencies = [];
  let preRevealMemoryOps = 0;
  let stage1Attempts = 0;
  let stage1Kept = 0;
  let retrievalAttempts = 0;
  let retrievalSuccesses = 0;
  let nonEmptyRetrievals = 0;
  let validMemoryVerdicts = 0;

  console.log(`bench-memory-live-x: target=${options.sampleSize} candidates=${candidates.length}`);
  for (const item of candidates) {
    if (stage1Kept >= options.sampleSize) break;
    const prefilterResult = prefilter.prefilter({
      text: item.text,
      hasMedia: item.mediaType !== 'text',
      hasVideo: item.mediaType === 'video',
      hasImage: item.mediaType === 'image',
    });
    if (prefilterResult) continue;

    stage1Attempts++;
    const stage1StartedAt = performance.now();
    const stage1 = await worker.scheduleLocalText(defaults.model, OLLAMA_URL, function () {
      return worker.classifyX(item.text, item.mediaType, item.author, defaults.model, OLLAMA_URL, '');
    });
    const stage1Ms = performance.now() - stage1StartedAt;
    const kept = !(stage1.prediction === 'noise' && stage1.confidence >= defaults.confidenceThreshold);
    if (!kept) continue;
    stage1Kept++;
    stage1Latencies.push(stage1Ms);
    let revealed = true;

    const memoryStartedAt = performance.now();
    retrievalAttempts++;
    let embedded;
    let contexts = [];
    let retrievalFailure = null;
    try {
      if (!revealed) preRevealMemoryOps++;
      embedded = await worker.embedLocal(item.text, EMBEDDING_MODEL, OLLAMA_URL);
      if (!revealed) preRevealMemoryOps++;
      contexts = index.search(history, embedded.embedding, 5);
      retrievalSuccesses++;
      if (contexts.length) nonEmptyRetrievals++;
    } catch (error) {
      retrievalFailure = String((error && error.message) || error);
    }

    let memory = null;
    let finalAction = 'show';
    let classificationFailure = null;
    if (!retrievalFailure) {
      try {
        if (!revealed) preRevealMemoryOps++;
        memory = await worker.scheduleMemoryClassification({
          id: item.id,
          text: item.text,
          author: item.author,
          truncated: false,
        }, contexts.map((context) => ({
          tweetId: context.tweetId,
          text: context.text,
          author: context.author,
          knownState: context.knownState,
          similarity: context.similarity,
          truncated: context.truncated === true,
        })), defaults.model, OLLAMA_URL);
        const verdict = memoryPass.validateVerdict(memory);
        if (!verdict) throw new Error('strict memory verdict validation failed');
        finalAction = memoryPass.decide(verdict, contexts, defaults.memoryConfidenceThreshold).action;
        validMemoryVerdicts++;
      } catch (error) {
        classificationFailure = String((error && error.message) || error);
      }
    }
    const memoryMs = performance.now() - memoryStartedAt;
    memoryLatencies.push(memoryMs);

    if (embedded && Array.isArray(embedded.embedding)) {
      history.push({
        tweetId: item.id,
        text: item.text,
        author: item.author,
        embedding: embedded.embedding,
        exposureState: 'shown',
        maxDwellMs: item.maxDwellMs,
        updatedAt: item.timestamp,
        truncated: false,
      });
    }
    rows.push({
      id: item.id,
      stage1Ms: Number(stage1Ms.toFixed(1)),
      contexts: contexts.length,
      maxSimilarity: contexts.length ? Number(contexts[0].similarity.toFixed(4)) : null,
      retrievalFailure,
      memoryMs: Number(memoryMs.toFixed(1)),
      memoryNovelty: memory && memory.novelty,
      finalAction,
      classificationFailure,
    });
    console.log(`  ${stage1Kept}/${options.sampleSize} ${item.id} stage1=${stage1Ms.toFixed(0)}ms ` +
      `contexts=${contexts.length} memory=${memoryMs.toFixed(0)}ms action=${finalAction}`);
  }

  const retrievalSuccessRate = retrievalAttempts ? retrievalSuccesses / retrievalAttempts : 0;
  const summary = {
    source: SOURCE,
    sourceRows: events.length,
    currentCandidates: candidates.length,
    target: options.sampleSize,
    stage1Attempts,
    stage1Kept,
    preRevealMemoryOps,
    retrievalAttempts,
    retrievalSuccesses,
    retrievalSuccessRate: Number(retrievalSuccessRate.toFixed(4)),
    nonEmptyRetrievals,
    validMemoryVerdicts,
    stage1: {
      p50Ms: Number(percentile(stage1Latencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(stage1Latencies, 0.95).toFixed(1)),
    },
    memory: {
      p50Ms: Number(percentile(memoryLatencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(memoryLatencies, 0.95).toFixed(1)),
    },
  };
  const failures = [];
  if (stage1Kept < options.sampleSize) failures.push(`stage-1 kept ${stage1Kept}/${options.sampleSize}`);
  if (retrievalSuccessRate < MIN_RETRIEVAL_SUCCESS_RATE) {
    failures.push(`retrieval success ${(retrievalSuccessRate * 100).toFixed(1)}% < 99%`);
  }
  if (preRevealMemoryOps !== 0) failures.push(`pre-reveal memory operations ${preRevealMemoryOps}`);
  if (nonEmptyRetrievals < 1) failures.push('no non-empty retrieved context');
  if (validMemoryVerdicts !== stage1Kept) failures.push(`valid memory verdicts ${validMemoryVerdicts}/${stage1Kept}`);
  summary.gate = { pass: failures.length === 0, failures };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const output = path.join(RESULTS_DIR, `bench-memory-live-x-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify({
    date: new Date().toISOString(),
    model: defaults.model,
    embeddingModel: EMBEDDING_MODEL,
    summary,
    rows,
  }, null, 2) + '\n');
  console.log('\n================ ISC-57 SUMMARY ================');
  console.log(JSON.stringify(summary, null, 2));
  console.log('result written:', path.relative(process.cwd(), output));
  if (!summary.gate.pass) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal:', error.message || error);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, candidateTweets };
