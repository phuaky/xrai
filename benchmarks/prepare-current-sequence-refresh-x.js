#!/usr/bin/env node

// Builds seed/exclusion inputs for a combined chronological refresh: the prior
// 102 approved disjoint scenarios remain seeds, while new semantic proposals
// are restricted to IDs absent from the frozen August 5 corpus.

const fs = require('fs');
const path = require('path');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const CURRENT_DIR = path.join(ROOT, 'data', 'luna-audit-x-current-2026-08-20');
const BASELINE_DIR = path.join(ROOT, 'data', 'luna-audit-x-gpt-5.6-luna');

function readRows(file) {
  return audit.parseJsonlStrict(file).map(({ row }) => row);
}

function tripleKey(ids) {
  return ids.map(String).sort().join('|');
}

function buildInputs(options = {}) {
  const currentDir = path.resolve(options.currentDir || CURRENT_DIR);
  const baselineDir = path.resolve(options.baselineDir || BASELINE_DIR);
  const scenarios = audit.readJsonStrict(path.join(baselineDir, 'sequence-scenarios.json'));
  audit.validateScenarioArtifact(scenarios);
  const priorCandidates = readRows(path.join(baselineDir, 'sequence-candidates', 'candidates.jsonl'));
  const candidateByTriple = new Map(priorCandidates.map((candidate) => [
    tripleKey(candidate.rows.map((row) => row.id)), candidate,
  ]));
  const seeds = scenarios.scenarios.map((scenario, index) => {
    const ids = scenario.steps.map((step) => step.id);
    const prior = candidateByTriple.get(tripleKey(ids));
    if (!prior) throw new Error(`prior candidate missing scenario ${scenario.id}`);
    return {
      candidateId: `candidate-${String(index).padStart(4, '0')}`,
      minSimilarity: prior.minSimilarity,
      rows: ids.map((id) => ({ id })),
    };
  });

  const baselineCorpus = readRows(path.join(baselineDir, 'corpus.jsonl'));
  const baselineIds = baselineCorpus.map((row) => row.id).sort();
  const seedFile = path.join(currentDir, 'sequence-seed-candidates.jsonl');
  const excludeFile = path.join(currentDir, 'sequence-baseline-ids.txt');
  fs.writeFileSync(seedFile, audit.jsonl(seeds));
  fs.writeFileSync(excludeFile, baselineIds.join('\n') + '\n');
  return {
    seedCount: seeds.length,
    excludedBaselineIds: baselineIds.length,
    seedFile,
    excludeFile,
    seedSha256: audit.sha256(fs.readFileSync(seedFile)),
    excludeSha256: audit.sha256(fs.readFileSync(excludeFile)),
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildInputs(), null, 2)); }
  catch (error) {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = { tripleKey, buildInputs };
