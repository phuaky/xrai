#!/usr/bin/env node

// Replays the production memory classifier over the exact cases missed by a
// prior sequence run. This is a fast diagnostic loop; the full sequence gate
// remains the release authority.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'data', 'luna-audit-x-current-2026-08-20');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function categories(step, detail) {
  const result = [];
  if (step.importance === 'critical' && detail.action === 'collapse') result.push('critical');
  if ((step.novelty === 'new-signal' || step.novelty === 'meaningful-update') &&
      detail.action === 'collapse') result.push('novelty');
  if (step.importance === 'normal' &&
      (step.novelty === 'reinforcement' || step.novelty === 'repeat') &&
      step.hasStrongKnownPrior && detail.action === 'show') result.push('familiar');
  if (step.importance === 'normal' && step.funnelRisk && !step.standaloneValue &&
      detail.action === 'show') result.push('funnel');
  return result;
}

function expectedAction(category) {
  return category === 'critical' || category === 'novelty' ? 'show' : 'collapse';
}

async function requireModel(model) {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!(payload.models || []).some((entry) => entry.name === model)) {
    throw new Error(`Required model not installed: ${model}`);
  }
}

async function main() {
  const auditDir = path.resolve(option('audit-dir', DEFAULT_DIR));
  const scenariosPath = path.resolve(option('scenarios', path.join(auditDir, 'sequence-scenarios.json')));
  const baselineReportPath = path.resolve(option(
    'baseline-report', path.join(auditDir, 'sequence-predictions-report.json'),
  ));
  const outPath = path.resolve(option('out', path.join(auditDir, 'memory-error-replay.json')));
  const artifact = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  audit.validateScenarioArtifact(artifact);
  const baseline = JSON.parse(fs.readFileSync(baselineReportPath, 'utf8'));
  const detailById = new Map(baseline.details.map((detail) => [detail.id, detail]));
  const scenarioByStepId = new Map();
  const stepById = new Map();
  for (const scenario of artifact.scenarios) {
    for (const step of scenario.steps) {
      stepById.set(step.id, step);
      scenarioByStepId.set(step.id, scenario);
    }
  }

  const cases = [];
  for (const step of stepById.values()) {
    const detail = detailById.get(step.id);
    if (!detail) throw new Error(`Missing baseline detail for ${step.id}`);
    const missed = categories(step, detail);
    if (missed.length) cases.push({ step, detail, categories: missed });
  }
  if (!cases.length) throw new Error('Baseline report contains no sequence misses');

  const defaults = L.loadConfigDefaults().x;
  const worker = L.loadWorker();
  const memoryPass = L.loadMemoryPass();
  await requireModel(defaults.model);

  const results = [];
  let failures = 0;
  for (const [index, item] of cases.entries()) {
    const scenario = scenarioByStepId.get(item.step.id);
    const scenarioSteps = new Map(scenario.steps.map((step) => [step.id, step]));
    const contexts = item.detail.contexts.map((context) => {
      const prior = scenarioSteps.get(context.tweetId);
      if (!prior) throw new Error(`${item.step.id}: missing context ${context.tweetId}`);
      return {
        tweetId: prior.id,
        text: prior.text,
        author: prior.author || '',
        truncated: prior.truncated === true,
        knownState: context.knownState,
        similarity: context.similarity,
      };
    });
    let verdict = null;
    let action = 'show';
    let failure = null;
    const startedAt = performance.now();
    try {
      verdict = await worker.scheduleMemoryClassification({
        id: item.step.id,
        text: item.step.text,
        author: item.step.author || '',
        truncated: item.step.truncated === true,
      }, contexts, defaults.model, OLLAMA_URL);
      action = memoryPass.decide(verdict, contexts, defaults.memoryConfidenceThreshold).action;
    } catch (error) {
      failure = String((error && error.message) || error || 'memory classification failed');
      failures++;
    }
    results.push({
      id: item.step.id,
      categories: item.categories,
      truth: {
        importance: item.step.importance,
        novelty: item.step.novelty,
        funnelRisk: item.step.funnelRisk,
        standaloneValue: item.step.standaloneValue,
      },
      baselineAction: item.detail.action,
      action,
      fixed: item.categories.every((category) => action === expectedAction(category)),
      contexts: item.detail.contexts,
      verdict,
      failure,
      ms: Number((performance.now() - startedAt).toFixed(1)),
    });
    console.log(`case ${index + 1}/${cases.length} id=${item.step.id} action=${action}`);
  }

  const categorySummary = {};
  for (const category of ['critical', 'novelty', 'familiar', 'funnel']) {
    const matching = results.filter((result) => result.categories.includes(category));
    categorySummary[category] = {
      fixed: matching.filter((result) => result.action === expectedAction(category)).length,
      total: matching.length,
    };
  }
  const report = {
    schemaVersion: 1,
    kind: 'rai-x-memory-error-replay',
    sourceReportSha256: audit.sha256(fs.readFileSync(baselineReportPath)),
    model: defaults.model,
    caseCount: results.length,
    failures,
    categorySummary,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    caseCount: report.caseCount,
    failures: report.failures,
    categorySummary: report.categorySummary,
    out: path.relative(process.cwd(), outPath),
  }, null, 2));
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = { categories, expectedAction };
