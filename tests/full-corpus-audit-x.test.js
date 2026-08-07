import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseJsonlStrict,
  buildCanonicalCorpus,
  validateCorpusRow,
  validateLunaVerdict,
  prepareAll,
  validateAudit,
  validateLunaOutputFile,
  reportAudit,
  mineSequenceScenarios,
  validateScenarioArtifact,
  productionPredictionConfiguration,
  validatePredictionProvenance,
  computeSequenceMetrics,
  enforceSequenceThresholds,
  parseCliArgs,
  sha256,
} from '../benchmarks/full-corpus-audit-x.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rai-full-corpus-audit-'));
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

const RUN = {
  schemaVersion: 1,
  kind: 'rai-x-full-corpus-luna-run',
  model: 'gpt-5.5',
  reasoning: 'medium',
};

function writeRun(out) {
  writeFileSync(join(out, 'run.json'), JSON.stringify(RUN) + '\n');
}

function writeValidatedBatch(out, batch, verdicts) {
  const output = join(out, batch.outputFile);
  writeFileSync(output, jsonl(verdicts));
  const expectedRows = parseJsonlStrict(join(out, batch.file)).map(({ row }) => row);
  const validated = validateLunaOutputFile(output, batch, expectedRows, RUN);
  writeFileSync(join(out, batch.validationFile), JSON.stringify(validated.record) + '\n');
  return output;
}

const baseEvents = [
  { tweetId: '101', decision: 'shown', source: 'model', prediction: 'signal', confidence: 0.8, text: 'short', author: 'old', mediaType: 'text', ts: 100 },
  { tweetId: '101', decision: 'hidden', source: 'prefilter:generic-news', prediction: 'noise', confidence: 0.99, text: 'the longest retained decision text', author: '', mediaType: '', ts: 200 },
  { tweetId: '101', decision: 'shown', source: 'model', prediction: 'signal', confidence: 0.7, text: 'same length latest text value 12', author: 'new', mediaType: 'image', ts: 200 },
  { tweetId: '101', kind: 'read', decision: 'shown', source: 'model', dwellMs: 700, text: 'read copy', author: 'read-author', ts: 250 },
  { tweetId: '101', kind: 'read', decision: 'reading', source: 'off-home', dwellMs: 600, text: 'proxy copy', ts: 300 },
  { tweetId: '102', decision: 'shown', source: 'model', text: 'x'.repeat(500), author: 'cap', ts: 400 },
  { tweetId: '102', decision: 'shown', source: 'model', text: '', author: '', ts: 401 },
  { tweetId: '103', decision: 'shown', source: 'model', text: '', author: null, ts: 500 },
  { tweetId: '104', decision: 'shown', source: 'model', text: 'reply', surface: 'own-replies', ts: 600 },
  { tweetId: '105', decision: 'blurred', source: 'model', text: 'wrong decision', ts: 700 },
];

describe('strict JSONL and canonical corpus', () => {
  it('fails malformed JSON with exact file and physical line', () => {
    const dir = tempDir();
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"ok":1}\nnot-json\n');
    expect(() => parseJsonlStrict(file)).toThrow(`${file}:2`);
  });

  it('rejects conflicting duplicate JSON keys at every object depth', () => {
    const dir = tempDir();
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"id":"1","novelty":"new-signal","novelty":"repeat"}\n');
    expect(() => parseJsonlStrict(file)).toThrow('duplicate field "novelty"');
    writeFileSync(file, '{"id":"1","steps":[{"novelty":"new-signal","novelty":"repeat"}]}\n');
    expect(() => parseJsonlStrict(file)).toThrow('duplicate field "novelty"');
  });

  it('merges retained feed decisions deterministically using the specified precedence', () => {
    const corpus = buildCanonicalCorpus(baseEvents.map((row, index) => ({ row, line: index + 1 })));
    expect(corpus.map((row) => row.id)).toEqual(['101', '102', '103']);
    expect(corpus[0]).toEqual({
      id: '101',
      text: 'the longest retained decision text',
      author: 'read-author',
      media: 'image',
      decision: 'shown',
      source: 'model',
      timestamp: 100,
      dwellMs: 1300,
      exposureState: 'off-home-proxy',
      truncated: false,
    });
    expect(corpus[1].truncated).toBe(true);
    expect(corpus[2].text).toBe('');
    expect(corpus[2].exposureState).toBe('shown-unread');
  });

  it('uses equal-length latest text and explicit direct-open without inferring it from off-home', () => {
    const rows = [
      { row: { tweetId: '9', decision: 'shown', source: 'model', text: 'first', ts: 1 }, line: 1 },
      { row: { tweetId: '9', decision: 'shown', source: 'model', text: 'later', ts: 2 }, line: 2 },
      { row: { tweetId: '9', kind: 'read', decision: 'reading', source: 'off-home', dwellMs: 1000, ts: 3 }, line: 3 },
    ];
    expect(buildCanonicalCorpus(rows)[0]).toMatchObject({ text: 'later', exposureState: 'off-home-proxy' });
    rows.push({ row: { tweetId: '9', kind: 'direct-open', exposureState: 'direct-open', ts: 4 }, line: 4 });
    expect(buildCanonicalCorpus(rows)[0].exposureState).toBe('direct-open');
  });
});

describe('strict schemas', () => {
  it('accepts exact corpus rows and rejects missing or unknown fields', () => {
    const row = buildCanonicalCorpus(baseEvents.map((value, index) => ({ row: value, line: index + 1 })))[0];
    expect(validateCorpusRow(row)).toEqual(row);
    expect(() => validateCorpusRow({ ...row, extra: true })).toThrow('unknown field');
    const { text, ...missing } = row;
    expect(() => validateCorpusRow(missing)).toThrow('missing field');
  });

  it('accepts the Luna contract and rejects knownState, action, unknown fields, and bad enums', () => {
    const verdict = {
      id: '101', importance: 'critical', topic: 'agents', contentType: 'release', claimCluster: 'claude-code-release',
      novelty: 'meaningful-update', funnelRisk: false, standaloneValue: true, confidence: 0.74, reason: 'New release details',
    };
    expect(validateLunaVerdict(verdict)).toEqual(verdict);
    expect(() => validateLunaVerdict({ ...verdict, knownState: 'strong' })).toThrow('unknown field');
    expect(() => validateLunaVerdict({ ...verdict, action: 'show' })).toThrow('unknown field');
    expect(() => validateLunaVerdict({ ...verdict, importance: 'critical-signal' })).toThrow('importance');
    expect(() => validateLunaVerdict({ ...verdict, id: 101 })).toThrow('digit-only JSON string');
    expect(() => validateLunaVerdict({ ...verdict, confidence: 1.01 })).toThrow('confidence');
  });
});

describe('strict CLI parsing', () => {
  it('rejects misspelled, duplicate, irrelevant, and positional options', () => {
    expect(() => parseCliArgs(['prepare-all', '--batch-szie', '1'])).toThrow('Unknown option');
    expect(() => parseCliArgs(['report', '--out', 'a', '--out', 'b'])).toThrow('Duplicate option');
    expect(() => parseCliArgs(['report', '--allow-incomplete'])).toThrow('Unknown option');
    expect(() => parseCliArgs(['validate', 'stray'])).toThrow('Unexpected positional');
    expect(parseCliArgs(['validate', '--out', 'audit', '--allow-incomplete'])).toMatchObject({ command: 'validate', values: { out: 'audit' } });
  });
});

describe('prepare, resume, validate, and report', () => {
  it('creates deterministic full checksums, preserves validated outputs, and routes every low-confidence verdict', () => {
    const dir = tempDir();
    const source = join(dir, 'events-x.jsonl');
    const out = join(dir, 'audit');
    writeFileSync(source, jsonl(baseEvents));

    const first = prepareAll({ source, out, batchSize: 2 });
    writeRun(out);
    expect(first.counts).toEqual({ sourceRows: 10, eligibleRows: 6, uniqueIds: 3, emptyTextIds: 1, truncatedIds: 1, batches: 2 });
    expect(first.sourceSha256).toBe(sha256(readFileSync(source)));
    expect(first.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.batches.every((batch) => /^[a-f0-9]{64}$/.test(batch.sha256))).toBe(true);

    const verdicts = [
      { id: '101', importance: 'normal', topic: 'agents', contentType: 'opinion', claimCluster: 'c1', novelty: 'repeat', funnelRisk: false, standaloneValue: true, confidence: 0.74, reason: 'Familiar claim' },
      { id: '102', importance: 'critical', topic: 'jobs', contentType: 'opportunity', claimCluster: 'c2', novelty: 'new-signal', funnelRisk: false, standaloneValue: true, confidence: 0.75, reason: 'Concrete opportunity' },
      { id: '103', importance: 'normal', topic: 'tools', contentType: 'funnel', claimCluster: 'c3', novelty: 'reinforcement', funnelRisk: true, standaloneValue: false, confidence: 0.2, reason: 'Needs review' },
    ];
    for (const batch of first.batches) {
      const ids = parseJsonlStrict(join(out, batch.file)).map(({ row }) => row.id);
      writeValidatedBatch(out, batch, verdicts.filter((row) => ids.includes(row.id)));
    }
    const validated = validateAudit({ out });
    expect(validated.complete).toBe(true);
    expect(validated.validatedBatches).toBe(2);

    const outputPath = join(out, first.batches[0].outputFile);
    const beforeMtime = statSync(outputPath).mtimeMs;
    const beforeBytes = readFileSync(outputPath, 'utf8');
    const second = prepareAll({ source, out, batchSize: 2 });
    expect(second).toEqual(first);
    expect(readFileSync(outputPath, 'utf8')).toBe(beforeBytes);
    expect(statSync(outputPath).mtimeMs).toBe(beforeMtime);

    const report = reportAudit({ out });
    expect(report.reviewCount).toBe(2);
    const review = parseJsonlStrict(join(out, 'human-review.jsonl')).map(({ row }) => row);
    expect(review.map((row) => row.id)).toEqual(['101', '103']);
    expect(existsSync(join(out, 'luna-verdicts.jsonl'))).toBe(true);
  });

  it('never re-certifies stale Luna output when batch content changes with the same IDs', () => {
    const dir = tempDir();
    const source = join(dir, 'events-x.jsonl');
    const out = join(dir, 'audit');
    const original = [{ tweetId: '101', decision: 'shown', source: 'model', text: 'old claim', ts: 1 }];
    writeFileSync(source, jsonl(original));
    const manifest = prepareAll({ source, out, batchSize: 10 });
    writeRun(out);
    const verdict = { id: '101', importance: 'normal', topic: 'x', contentType: 'post', claimCluster: 'c', novelty: 'repeat', funnelRisk: false, standaloneValue: true, confidence: 0.9, reason: 'Judged old claim' };
    const output = writeValidatedBatch(out, manifest.batches[0], [verdict]);
    validateAudit({ out });
    const outputBefore = readFileSync(output, 'utf8');

    writeFileSync(source, jsonl([{ ...original[0], text: 'materially different new claim' }]));
    expect(() => prepareAll({ source, out, batchSize: 10 })).toThrow('stale Luna output');
    expect(readFileSync(output, 'utf8')).toBe(outputBefore);
  });

  it('never invents judge provenance for an output missing its runner-created sidecar', () => {
    const dir = tempDir();
    const source = join(dir, 'events-x.jsonl');
    const out = join(dir, 'audit');
    writeFileSync(source, jsonl([{ tweetId: '101', decision: 'shown', source: 'model', text: 'claim', ts: 1 }]));
    const manifest = prepareAll({ source, out, batchSize: 10 });
    writeRun(out);
    const verdict = { id: '101', importance: 'normal', topic: 'x', contentType: 'post', claimCluster: 'c', novelty: 'new-signal', funnelRisk: false, standaloneValue: true, confidence: 1, reason: 'ok' };
    writeFileSync(join(out, manifest.batches[0].outputFile), jsonl([verdict]));
    expect(() => validateAudit({ out })).toThrow('runner-created validation sidecar');
    expect(() => prepareAll({ source, out, batchSize: 10 })).toThrow('lacks its runner-created validation sidecar');
  });

  it('rejects duplicate, unknown, missing, wrong-schema, and wrong-checksum output instead of resuming', () => {
    const dir = tempDir();
    const source = join(dir, 'events-x.jsonl');
    const out = join(dir, 'audit');
    writeFileSync(source, jsonl(baseEvents.slice(0, 3)));
    const manifest = prepareAll({ source, out, batchSize: 10 });
    writeRun(out);
    const batch = manifest.batches[0];
    const output = join(out, batch.outputFile);
    const validationFile = join(out, batch.validationFile);
    const good = { id: '101', importance: 'normal', topic: 'x', contentType: 'post', claimCluster: 'c', novelty: 'new-signal', funnelRisk: false, standaloneValue: true, confidence: 1, reason: 'ok' };
    writeFileSync(validationFile, '{}\n');
    writeFileSync(output, jsonl([good, good]));
    expect(() => validateAudit({ out })).toThrow('duplicate ID');
    writeFileSync(output, jsonl([{ ...good, id: '999' }]));
    expect(() => validateAudit({ out })).toThrow(/unknown ID|missing ID/);
    writeFileSync(output, jsonl([{ ...good, action: 'show' }]));
    expect(() => validateAudit({ out })).toThrow('unknown field');
    writeValidatedBatch(out, batch, [good]);
    validateAudit({ out });
    writeFileSync(validationFile, JSON.stringify({ stale: true }) + '\n');
    expect(() => validateAudit({ out })).toThrow('validation sidecar mismatch');
  });
});

describe('sequence scenario and metric foundation', () => {
  function corpusAndVerdicts() {
    const corpus = [];
    const verdicts = [];
    const novelties = ['new-signal', 'reinforcement', 'meaningful-update'];
    for (let c = 0; c < 100; c++) {
      for (let step = 0; step < 3; step++) {
        const id = `${c + 1}${String(step + 1).padStart(2, '0')}`;
        corpus.push({
          id, text: `claim ${c} step ${step}`, author: 'a', media: 'text', decision: 'shown', source: 'model',
          timestamp: c * 10 + step, dwellMs: step === 0 ? 1500 : 0, exposureState: step === 0 ? 'read' : 'shown-unread', truncated: false,
        });
        verdicts.push({
          id, importance: c === 0 && step < 2 ? 'critical' : 'normal', topic: 'topic', contentType: c % 2 ? 'post' : 'funnel',
          claimCluster: `cluster-${c}`, novelty: novelties[step], funnelRisk: c % 2 === 0 && step === 1, standaloneValue: !(c % 2 === 0 && step === 1),
          confidence: 0.9, reason: 'fixture',
        });
      }
    }
    return { corpus, verdicts };
  }

  it('mines deterministic >=3-step chronological scenarios and enforces the 100-scenario artifact floor', () => {
    const { corpus, verdicts } = corpusAndVerdicts();
    const artifact = mineSequenceScenarios(corpus, verdicts);
    expect(artifact.scenarios).toHaveLength(100);
    expect(artifact.scenarios[0].steps.map((step) => step.timestamp)).toEqual([0, 1, 2]);
    expect(validateScenarioArtifact(artifact).scenarioCount).toBe(100);
    expect(mineSequenceScenarios(corpus, verdicts)).toEqual(artifact);
    expect(mineSequenceScenarios(corpus, verdicts.toReversed())).toEqual(artifact);
    expect(() => validateScenarioArtifact({ ...artifact, scenarios: artifact.scenarios.slice(0, 99) })).toThrow('at least 100');

    const forged = structuredClone(artifact);
    forged.scenarios[0].steps[1].hasStrongKnownPrior = false;
    expect(() => validateScenarioArtifact(forged)).toThrow('differs from ledger evidence');
  });

  it('keeps one continuous history per claim cluster instead of resetting known state across chunks', () => {
    const { corpus, verdicts } = corpusAndVerdicts();
    const oneCluster = verdicts.map((verdict) => ({ ...verdict, claimCluster: 'shared-claim' }));
    const artifact = mineSequenceScenarios(corpus, oneCluster);
    const ids = artifact.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.id));

    expect(artifact.scenarios).toHaveLength(1);
    expect(artifact.scenarios[0].steps).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    expect(validateScenarioArtifact(artifact, { minimum: 1 }).scenarioCount).toBe(1);
  });

  it('binds predictions to the exact scenario artifact and rejects failed runs', () => {
    const { corpus, verdicts } = corpusAndVerdicts();
    const artifact = mineSequenceScenarios(corpus, verdicts);
    const dir = tempDir();
    const predictionsPath = join(dir, 'sequence-predictions.jsonl');
    const reportPath = join(dir, 'sequence-predictions-report.json');
    const predictions = artifact.scenarios.flatMap((scenario) =>
      scenario.steps.map((step) => ({ id: step.id, action: 'show' }))
    );
    const predictionBytes = jsonl(predictions);
    writeFileSync(predictionsPath, predictionBytes);
    const configuration = productionPredictionConfiguration();
    const report = {
      schemaVersion: 1,
      kind: 'rai-x-sequence-predictions',
      date: '2026-08-05T00:00:00.000Z',
      ...configuration,
      scenariosSha256: artifact.scenariosSha256,
      predictionsSha256: sha256(Buffer.from(predictionBytes)),
      predictionCount: predictions.length,
      failures: 0,
      latency: { p50Ms: 1, p95Ms: 2 },
      details: predictions.map((prediction) => ({ id: prediction.id, failure: null })),
    };
    writeFileSync(reportPath, JSON.stringify(report));
    expect(validatePredictionProvenance(
      artifact,
      predictionsPath,
      predictions,
      reportPath,
    ).failures).toBe(0);
    writeFileSync(reportPath, JSON.stringify({ ...report, model: 'not-production' }));
    expect(() => validatePredictionProvenance(
      artifact,
      predictionsPath,
      predictions,
      reportPath,
    )).toThrow('differs from production');
    writeFileSync(reportPath, JSON.stringify({ ...report, failures: 1 }));
    expect(() => validatePredictionProvenance(
      artifact,
      predictionsPath,
      predictions,
      reportPath,
    )).toThrow('had 1 failures');
    writeFileSync(reportPath, JSON.stringify({ ...report, scenariosSha256: '0'.repeat(64) }));
    expect(() => validatePredictionProvenance(
      artifact,
      predictionsPath,
      predictions,
      reportPath,
    )).toThrow('different scenarios');
  });

  it('computes pure ISC-39–43 metrics and enforces every threshold', () => {
    const { corpus, verdicts } = corpusAndVerdicts();
    const artifact = mineSequenceScenarios(corpus, verdicts);
    const predictions = artifact.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({
      id: step.id,
      action: step.importance === 'critical' || step.novelty === 'new-signal' || step.novelty === 'meaningful-update' ? 'show' : 'collapse',
    })));
    const metrics = computeSequenceMetrics(artifact, predictions);
    expect(metrics.criticalSignalRecall).toBe(1);
    expect(metrics.showRetention).toBe(1);
    expect(metrics.strongKnownCollapseRecall).toBe(1);
    expect(metrics.falseCollapseRate).toBe(0);
    expect(metrics.valueFreeFunnelCollapseRate).toBeGreaterThanOrEqual(0.85);
    expect(enforceSequenceThresholds(metrics).pass).toBe(true);
    expect(() => computeSequenceMetrics(artifact, predictions.slice(1))).toThrow('missing ID');
    const failingValues = {
      criticalSignalRecall: 0.99,
      showRetention: 0.849,
      strongKnownCollapseRecall: 0.799,
      falseCollapseRate: 0.051,
      valueFreeFunnelCollapseRate: 0.849,
    };
    for (const [name, value] of Object.entries(failingValues)) {
      const gate = enforceSequenceThresholds({ ...metrics, [name]: value });
      expect(gate.pass).toBe(false);
      expect(gate.failures.some((failure) => failure.startsWith(name))).toBe(true);
    }
  });
});
