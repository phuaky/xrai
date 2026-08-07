#!/usr/bin/env node

// Runs the real production memory classifier and deterministic policy over the
// chronological claim-cluster scenarios produced by full-corpus-audit-x.js.
// Context retrieval stays local and bounded: only prior items in the same
// scenario are eligible, ranked by the production embedding model, top five.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'luna-audit-x');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.RAI_EMBEDDING_MODEL || 'all-minilm:latest';
const EMBEDDING_BATCH_SIZE = 128;

function option(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const SCENARIOS_PATH = path.resolve(option(
  'scenarios',
  path.join(AUDIT_DIR, 'sequence-scenarios.json'),
));
const OUTPUT_PATH = path.resolve(option(
  'out',
  path.join(AUDIT_DIR, 'sequence-predictions.jsonl'),
));
const REPORT_PATH = path.resolve(option(
  'report',
  path.join(AUDIT_DIR, 'sequence-predictions-report.json'),
));

function percentile(values, quantile) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function writePredictions(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(rows));
}

async function requireModels(models) {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const data = await response.json();
  const installed = new Set((data.models || []).map((entry) => entry.name));
  for (const model of models) {
    if (!installed.has(model)) throw new Error(`Required model not installed: ${model}`);
  }
}

async function unloadYouTubeModel() {
  await fetch(`${OLLAMA_URL}/api/generate`, {
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
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator ? dot / denominator : 0;
}

async function embedTexts(steps) {
  const vectorById = new Map();
  const eligible = steps.filter((step) => String(step.text || '').trim());
  for (let offset = 0; offset < eligible.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = eligible.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch.map((step) => step.text),
        truncate: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Ollama /api/embed returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== batch.length) {
      throw new Error(`Embedding response covered ${data.embeddings?.length || 0}/${batch.length} items`);
    }
    batch.forEach((step, index) => vectorById.set(step.id, data.embeddings[index]));
    console.log(`embedded ${Math.min(offset + batch.length, eligible.length)}/${eligible.length}`);
  }
  return vectorById;
}

function ledgerKnownState(step) {
  if (step.exposureState === 'direct-open' || step.dwellMs >= 1000) return 'strong';
  if (step.exposureState === 'hidden-unread') return 'unknown';
  return 'weak';
}

function retrievePriorContexts(steps, currentIndex, vectorById, limit) {
  const current = steps[currentIndex];
  const currentVector = vectorById.get(current.id);
  if (!currentVector) return [];
  return steps.slice(0, currentIndex)
    .filter((step) => vectorById.has(step.id))
    .map((step) => ({
      tweetId: step.id,
      text: step.text,
      author: step.author || '',
      truncated: step.truncated === true,
      knownState: ledgerKnownState(step),
      similarity: cosine(currentVector, vectorById.get(step.id)),
    }))
    .sort((left, right) => right.similarity - left.similarity || left.tweetId.localeCompare(right.tweetId))
    .slice(0, limit);
}

async function main() {
  const artifact = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  audit.validateScenarioArtifact(artifact);
  const partialPath = `${OUTPUT_PATH}.partial`;

  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const memoryPass = L.loadMemoryPass();
  const allSteps = artifact.scenarios.flatMap((scenario) => scenario.steps);

  await requireModels([defaults.model, EMBEDDING_MODEL]);
  await unloadYouTubeModel();
  const vectorById = await embedTexts(allSteps);

  const predictions = [];
  const details = [];
  const latencies = [];
  let failures = 0;

  for (let scenarioIndex = 0; scenarioIndex < artifact.scenarios.length; scenarioIndex++) {
    const scenario = artifact.scenarios[scenarioIndex];
    for (let stepIndex = 0; stepIndex < scenario.steps.length; stepIndex++) {
      const step = scenario.steps[stepIndex];
      const contexts = retrievePriorContexts(
        scenario.steps,
        stepIndex,
        vectorById,
        worker.MEMORY_MAX_CONTEXTS,
      );
      let action = 'show';
      let verdict = null;
      let failure = null;
      const startedAt = performance.now();

      if (String(step.text || '').trim()) {
        try {
          verdict = await worker.scheduleMemoryClassification({
            id: step.id,
            text: step.text,
            author: step.author || '',
            truncated: step.truncated === true,
          }, contexts, defaults.model, OLLAMA_URL);
          action = memoryPass.decide(
            verdict,
            contexts,
            defaults.memoryConfidenceThreshold,
          ).action;
        } catch (error) {
          failure = String((error && error.message) || error || 'memory classification failed');
          failures++;
        }
      } else {
        failure = 'empty-text-fail-open';
        failures++;
      }

      const ms = performance.now() - startedAt;
      latencies.push(ms);
      predictions.push({ id: step.id, action });
      details.push({
        id: step.id,
        scenarioId: scenario.id,
        truth: {
          importance: step.importance,
          novelty: step.novelty,
          funnelRisk: step.funnelRisk,
          standaloneValue: step.standaloneValue,
        },
        contexts: contexts.map((context) => ({
          tweetId: context.tweetId,
          similarity: context.similarity,
          knownState: context.knownState,
        })),
        verdict,
        action,
        failure,
        ms: Number(ms.toFixed(1)),
      });
    }
    writePredictions(partialPath, predictions);
    console.log(
      `scenario ${scenarioIndex + 1}/${artifact.scenarios.length} ` +
      `items=${predictions.length}/${artifact.itemCount} failures=${failures}`,
    );
  }

  const predictionRows = jsonl(predictions);
  const report = {
    schemaVersion: 1,
    kind: 'rai-x-sequence-predictions',
    date: new Date().toISOString(),
    model: defaults.model,
    embeddingModel: EMBEDDING_MODEL,
    memoryConfidenceThreshold: defaults.memoryConfidenceThreshold,
    scenariosSha256: artifact.scenariosSha256,
    predictionsSha256: audit.sha256(predictionRows),
    predictionCount: predictions.length,
    failures,
    latency: {
      p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
      p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    },
    details,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  if (failures) {
    throw new Error(`${failures} sequence classification failure(s); predictions are not scoreable`);
  }
  writePredictions(OUTPUT_PATH, predictions);
  if (fs.existsSync(partialPath)) fs.rmSync(partialPath);
  console.log(JSON.stringify({
    predictionCount: report.predictionCount,
    failures: report.failures,
    latency: report.latency,
    predictions: path.relative(process.cwd(), OUTPUT_PATH),
    report: path.relative(process.cwd(), REPORT_PATH),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  cosine,
  ledgerKnownState,
  retrievePriorContexts,
};
