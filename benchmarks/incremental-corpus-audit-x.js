#!/usr/bin/env node

// Incremental GPT-5.6 Luna refresh. It freezes the current append-only event
// ledger, sends only new or byte-changed canonical rows to Luna, then merges
// those validated verdicts with byte-identical August 5 judgments.

const fs = require('fs');
const path = require('path');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE = path.join(ROOT, 'data', 'events-x.jsonl');
const DEFAULT_BASELINE_DIR = path.join(ROOT, 'data', 'luna-audit-x-gpt-5.6-luna');
const DEFAULT_OUT = path.join(ROOT, 'data', 'luna-audit-x-increment-2026-08-20');
const DEFAULT_COMBINED_OUT = path.join(ROOT, 'data', 'luna-audit-x-current-2026-08-20');
const PROVENANCE_FILE = 'incremental-provenance.json';

function readCorpus(file) {
  return audit.parseJsonlStrict(file).map(({ row, line }) =>
    audit.validateCorpusRow(row, `${file}:${line}`));
}

function readVerdicts(file) {
  return audit.parseJsonlStrict(file).map(({ row, line }) =>
    audit.validateLunaVerdict(row, `${file}:${line}`));
}

function uniqueMap(rows, label) {
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) throw new Error(`${label}: duplicate ID ${row.id}`);
    byId.set(row.id, row);
  }
  return byId;
}

function idSha(rows) {
  const ids = rows.map((row) => row.id).sort();
  return audit.sha256(Buffer.from(ids.join('\n') + (ids.length ? '\n' : '')));
}

function diffCorpus(current, baseline) {
  const baselineById = uniqueMap(baseline, 'baseline corpus');
  const rows = [];
  const newIds = [];
  const changedIds = [];
  const unchangedIds = [];
  for (const row of current) {
    const prior = baselineById.get(row.id);
    if (!prior) {
      rows.push(row);
      newIds.push(row.id);
    } else if (audit.stableJson(row) !== audit.stableJson(prior)) {
      rows.push(row);
      changedIds.push(row.id);
    } else {
      unchangedIds.push(row.id);
    }
  }
  return { rows, newIds, changedIds, unchangedIds };
}

function exactIdSet(actual, expected, label) {
  const actualIds = new Set(actual.map((row) => row.id));
  const expectedIds = new Set(expected.map((row) => row.id));
  if (actualIds.size !== actual.length || expectedIds.size !== expected.length) {
    throw new Error(`${label}: duplicate ID`);
  }
  for (const id of actualIds) if (!expectedIds.has(id)) throw new Error(`${label}: unknown ID ${id}`);
  for (const id of expectedIds) if (!actualIds.has(id)) throw new Error(`${label}: missing ID ${id}`);
}

function writeImmutable(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file);
    if (!existing.equals(bytes)) throw new Error(`${file}: frozen artifact differs; use a fresh output directory`);
    return;
  }
  fs.writeFileSync(file, bytes);
}

function sourceEntries(bytes, source) {
  return audit.parseJsonlTextStrict(bytes.toString('utf8'), source);
}

function prepare(options = {}) {
  const source = path.resolve(options.source || DEFAULT_SOURCE);
  const baselineDir = path.resolve(options.baselineDir || DEFAULT_BASELINE_DIR);
  const out = path.resolve(options.out || DEFAULT_OUT);
  const combinedOut = path.resolve(options.combinedOut || DEFAULT_COMBINED_OUT);
  const batchSize = Number(options.batchSize || 100);
  const sourceBytes = fs.readFileSync(source);
  const fullSourceSha256 = audit.sha256(sourceBytes);
  const parsed = sourceEntries(sourceBytes, source);
  const currentCorpus = audit.buildCanonicalCorpus(parsed);

  const baselineCorpusFile = path.join(baselineDir, 'corpus.jsonl');
  const baselineVerdictsFile = path.join(baselineDir, 'luna-verdicts.jsonl');
  const baselineCorpusBytes = fs.readFileSync(baselineCorpusFile);
  const baselineVerdictBytes = fs.readFileSync(baselineVerdictsFile);
  const baselineCorpus = readCorpus(baselineCorpusFile);
  const baselineVerdicts = readVerdicts(baselineVerdictsFile);
  exactIdSet(baselineVerdicts, baselineCorpus, 'baseline verdicts');

  const diff = diffCorpus(currentCorpus, baselineCorpus);
  if (!diff.rows.length) throw new Error('current corpus has no new or changed rows');
  const diffIds = new Set(diff.rows.map((row) => row.id));
  const incrementalEvents = parsed.filter(({ row }) => diffIds.has(String(row.tweetId || '')));
  const incrementalSourceBytes = Buffer.from(incrementalEvents.map(({ raw }) => raw).join('\n') + '\n');
  const incrementalSource = path.join(out, 'source-snapshot.jsonl');
  writeImmutable(incrementalSource, incrementalSourceBytes);
  const fullSourceSnapshot = path.join(combinedOut, 'source-snapshot.jsonl');
  writeImmutable(fullSourceSnapshot, sourceBytes);

  const manifest = audit.prepareAll({ source: incrementalSource, out, batchSize });
  const preparedCorpus = readCorpus(path.join(out, manifest.corpusFile));
  exactIdSet(preparedCorpus, diff.rows, 'prepared incremental corpus');
  for (let index = 0; index < preparedCorpus.length; index++) {
    if (audit.stableJson(preparedCorpus[index]) !== audit.stableJson(diff.rows[index])) {
      throw new Error(`prepared incremental corpus row ${index} differs from current canonical row`);
    }
  }

  const currentCorpusBytes = Buffer.from(audit.jsonl(currentCorpus));
  writeImmutable(path.join(combinedOut, 'corpus.jsonl'), currentCorpusBytes);
  const provenance = {
    schemaVersion: 1,
    kind: 'rai-x-incremental-luna-provenance',
    source: fullSourceSnapshot,
    liveSource: source,
    fullSourceSha256,
    fullSourceRows: parsed.length,
    baselineDir,
    baselineCorpusSha256: audit.sha256(baselineCorpusBytes),
    baselineVerdictsSha256: audit.sha256(baselineVerdictBytes),
    baselineIds: baselineCorpus.length,
    currentCorpusSha256: audit.sha256(currentCorpusBytes),
    currentIds: currentCorpus.length,
    incrementalCorpusSha256: manifest.corpusSha256,
    incrementalIdSha256: idSha(diff.rows),
    incrementalIds: diff.rows.length,
    newIds: diff.newIds.length,
    changedIds: diff.changedIds.length,
    unchangedIds: diff.unchangedIds.length,
    incrementalAuditDir: out,
    combinedAuditDir: combinedOut,
  };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance, null, 2) + '\n');
  writeImmutable(path.join(out, PROVENANCE_FILE), provenanceBytes);
  writeImmutable(path.join(combinedOut, PROVENANCE_FILE), provenanceBytes);
  return provenance;
}

function validateFrozenInputs(provenance) {
  if (audit.sha256(fs.readFileSync(provenance.source)) !== provenance.fullSourceSha256) {
    throw new Error('full source checksum changed after incremental preparation');
  }
  const baselineCorpusFile = path.join(provenance.baselineDir, 'corpus.jsonl');
  const baselineVerdictsFile = path.join(provenance.baselineDir, 'luna-verdicts.jsonl');
  if (audit.sha256(fs.readFileSync(baselineCorpusFile)) !== provenance.baselineCorpusSha256) {
    throw new Error('baseline corpus checksum changed');
  }
  if (audit.sha256(fs.readFileSync(baselineVerdictsFile)) !== provenance.baselineVerdictsSha256) {
    throw new Error('baseline verdict checksum changed');
  }
}

function loadProvenance(out) {
  const file = path.join(path.resolve(out || DEFAULT_OUT), PROVENANCE_FILE);
  const value = audit.readJsonStrict(file);
  if (!value || value.kind !== 'rai-x-incremental-luna-provenance' || value.schemaVersion !== 1) {
    throw new Error(`${file}: invalid incremental provenance`);
  }
  return value;
}

function mergeVerdicts(currentCorpus, baselineCorpus, baselineVerdicts, incrementalCorpus, incrementalVerdicts) {
  exactIdSet(baselineVerdicts, baselineCorpus, 'baseline verdict merge input');
  exactIdSet(incrementalVerdicts, incrementalCorpus, 'incremental verdict merge input');
  const diff = diffCorpus(currentCorpus, baselineCorpus);
  exactIdSet(incrementalCorpus, diff.rows, 'incremental corpus versus current diff');
  const baselineById = uniqueMap(baselineVerdicts, 'baseline verdicts');
  const incrementalById = uniqueMap(incrementalVerdicts, 'incremental verdicts');
  return currentCorpus.map((row) => {
    const verdict = incrementalById.get(row.id) || baselineById.get(row.id);
    if (!verdict) throw new Error(`combined verdict missing ID ${row.id}`);
    return verdict;
  });
}

function merge(options = {}) {
  const out = path.resolve(options.out || DEFAULT_OUT);
  const provenance = loadProvenance(out);
  validateFrozenInputs(provenance);
  const validation = audit.validateAudit({ out });
  const currentCorpus = readCorpus(path.join(provenance.combinedAuditDir, 'corpus.jsonl'));
  const baselineCorpus = readCorpus(path.join(provenance.baselineDir, 'corpus.jsonl'));
  const baselineVerdicts = readVerdicts(path.join(provenance.baselineDir, 'luna-verdicts.jsonl'));
  const incrementalCorpus = validation.corpus;
  const incrementalVerdicts = validation.verdicts;
  const combined = mergeVerdicts(
    currentCorpus, baselineCorpus, baselineVerdicts, incrementalCorpus, incrementalVerdicts,
  );
  const combinedBytes = Buffer.from(audit.jsonl(combined));
  const combinedFile = path.join(provenance.combinedAuditDir, 'luna-verdicts.jsonl');
  writeImmutable(combinedFile, combinedBytes);
  return {
    currentIds: currentCorpus.length,
    baselineReused: currentCorpus.length - incrementalCorpus.length,
    incrementalVerdicts: incrementalVerdicts.length,
    combinedVerdicts: combined.length,
    combinedCorpusSha256: audit.sha256(fs.readFileSync(path.join(provenance.combinedAuditDir, 'corpus.jsonl'))),
    combinedVerdictsSha256: audit.sha256(combinedBytes),
    fullSourceSha256: provenance.fullSourceSha256,
    judgeModel: validation.run.model,
    reasoning: validation.run.reasoning,
  };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['prepare', 'validate', 'merge'].includes(command)) {
    throw new Error('Expected command: prepare, validate, or merge');
  }
  const options = {};
  const allowed = new Set(['source', 'baseline-dir', 'out', 'combined-out', 'batch-size']);
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--') || !token.includes('=')) throw new Error(`Invalid option ${token}`);
    const [name, ...valueParts] = token.slice(2).split('=');
    if (!allowed.has(name) || !valueParts.join('=')) throw new Error(`Unknown or empty option --${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`Duplicate option --${name}`);
    options[name] = valueParts.join('=');
  }
  return { command, options };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const options = {
    source: parsed.options.source,
    baselineDir: parsed.options['baseline-dir'],
    out: parsed.options.out,
    combinedOut: parsed.options['combined-out'],
    batchSize: parsed.options['batch-size'],
  };
  if (parsed.command === 'prepare') {
    console.log(JSON.stringify(prepare(options), null, 2));
    return;
  }
  const out = path.resolve(options.out || DEFAULT_OUT);
  const provenance = loadProvenance(out);
  validateFrozenInputs(provenance);
  if (parsed.command === 'validate') {
    const validation = audit.validateAudit({ out });
    console.log(JSON.stringify({
      complete: validation.complete,
      corpusCount: validation.corpusCount,
      verdictCount: validation.verdictCount,
      pendingBatches: validation.pendingBatches,
      fullSourceSha256: provenance.fullSourceSha256,
      incrementalSourceSha256: validation.sourceSha256,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(merge({ out }), null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  diffCorpus,
  mergeVerdicts,
  prepare,
  merge,
  parseArgs,
};
