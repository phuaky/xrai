#!/usr/bin/env node

// Scores the combined current sequence artifact without requiring a monolithic
// full-corpus Luna manifest. Candidate, scenario, and prediction provenance are
// still validated by the canonical audit helpers before metrics are accepted.

const fs = require('fs');
const path = require('path');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const CURRENT_DIR = path.join(ROOT, 'data', 'luna-audit-x-current-2026-08-20');
const BASELINE_DIR = path.join(ROOT, 'data', 'luna-audit-x-gpt-5.6-luna');

function main() {
  const out = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || CURRENT_DIR);
  const baselineDir = path.resolve(
    process.argv.find((arg) => arg.startsWith('--baseline-dir='))?.slice(15) || BASELINE_DIR,
  );
  const scenariosPath = path.join(out, 'sequence-scenarios.json');
  const predictionPath = path.join(out, 'sequence-predictions.jsonl');
  const predictionReportPath = path.join(out, 'sequence-predictions-report.json');
  const sequence = audit.validateSequenceBuildProvenance(out, scenariosPath);
  const artifact = sequence.artifact;
  const predictions = audit.parseJsonlStrict(predictionPath).map(({ row }) => row);
  const prediction = audit.validatePredictionProvenance(
    artifact, predictionPath, predictions, predictionReportPath,
  );
  const metrics = audit.computeSequenceMetrics(artifact, predictions);
  const gate = audit.enforceSequenceThresholds(metrics);
  const baselineIds = new Set(audit.parseJsonlStrict(path.join(baselineDir, 'corpus.jsonl'))
    .map(({ row }) => row.id));
  const postFreezeScenarios = artifact.scenarios.filter((scenario) =>
    scenario.steps.some((step) => !baselineIds.has(step.id)));
  if (!postFreezeScenarios.length) gate.failures.push('no scenario contains a post-freeze tweet');
  gate.pass = gate.failures.length === 0;
  const report = {
    schemaVersion: 1,
    kind: 'rai-x-current-sequence-eval-report',
    corpusSha256: audit.sha256(fs.readFileSync(path.join(out, 'corpus.jsonl'))),
    scenariosSha256: artifact.scenariosSha256,
    candidateReportSha256: sequence.candidateReportSha256,
    judgeModel: sequence.candidateReport.judgeModel,
    judgeReasoning: sequence.candidateReport.reasoning,
    model: prediction.model,
    embeddingModel: prediction.embeddingModel,
    memoryConfidenceThreshold: prediction.memoryConfidenceThreshold,
    predictionReportSha256: prediction.reportSha256,
    predictionsSha256: prediction.predictionsSha256,
    scenarioCount: artifact.scenarioCount,
    itemCount: artifact.itemCount,
    postFreezeScenarioCount: postFreezeScenarios.length,
    postFreezeItemCount: postFreezeScenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
    metrics,
    gate,
  };
  fs.writeFileSync(path.join(out, 'sequence-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!gate.pass) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 2;
  }
}
