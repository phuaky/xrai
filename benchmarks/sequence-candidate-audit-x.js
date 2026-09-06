#!/usr/bin/env node

// Validates Luna's second-pass chronological same-claim decisions over locally
// proposed semantic triples, then builds sequence scenarios exclusively from
// high-confidence approved candidates and their sequence-aware step labels.

const fs = require('fs');
const path = require('path');
const audit = require('./full-corpus-audit-x.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_AUDIT_DIR = path.join(ROOT, 'data', 'luna-audit-x');
const APPROVAL_THRESHOLD = 0.75;
const VERDICT_FIELDS = [
  'candidateId', 'sameClaim', 'claimCluster', 'confidence', 'reason', 'steps',
];
const STEP_VERDICT_FIELDS = [
  'id', 'importance', 'topic', 'contentType', 'novelty', 'funnelRisk',
  'standaloneValue', 'confidence', 'reason',
];
const NOVELTIES = new Set([
  'new-signal', 'meaningful-update', 'reinforcement', 'repeat',
]);
const MANIFEST_FIELDS = [
  'schemaVersion', 'kind', 'corpusSha256', 'verdictsSha256', 'embeddingModel',
  'embeddingInput', 'similarityThreshold', 'maxIdUses',
  'exactClusterSupplementLimit', 'exactClusterSupplementCount',
  'exactClusterMaxRows', 'semanticCandidateCount', 'excludedIds',
  'excludedIdSha256', 'seedCandidateCount', 'candidateCount',
  'candidatesSha256', 'batches',
];
const BATCH_FIELDS = [
  'index', 'file', 'promptFile', 'outputFile', 'validationFile', 'count',
  'sha256', 'candidateIdSha256', 'promptSha256', 'candidateIds',
];
const RUN_FIELDS = ['schemaVersion', 'kind', 'model', 'reasoning'];
const SIDECAR_FIELDS = [
  'schemaVersion', 'batchSha256', 'candidateIdSha256', 'promptSha256',
  'outputSha256', 'outputIdSha256', 'count', 'judgeModel', 'reasoning',
];

function readJson(file) {
  return audit.readJsonStrict(file);
}

function parseJsonlBytes(bytes, file) {
  return audit.parseJsonlTextStrict(bytes.toString('utf8'), file).map(({ row }) => row);
}

function readJsonl(file) {
  return parseJsonlBytes(fs.readFileSync(file), file);
}

function exactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = fields.slice().sort();
  if (actual.join('|') !== expected.join('|')) throw new Error(`${label}: fields differ from schema`);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected non-empty string`);
}

function idChecksum(ids) {
  const bytes = ids.map(String).sort().join('\n') + (ids.length ? '\n' : '');
  return audit.sha256(Buffer.from(bytes));
}

function validateCandidate(candidate, label) {
  exactFields(candidate, ['candidateId', 'minSimilarity', 'rows'], label);
  if (!/^candidate-\d{4}$/.test(candidate.candidateId)) throw new Error(`${label}: invalid candidateId`);
  if (!Number.isFinite(candidate.minSimilarity) || candidate.minSimilarity < -1 || candidate.minSimilarity > 1) {
    throw new Error(`${label}: invalid minSimilarity`);
  }
  if (!Array.isArray(candidate.rows) || candidate.rows.length !== 3) throw new Error(`${label}: requires three rows`);
  let previous = Number.NEGATIVE_INFINITY;
  const ids = new Set();
  for (const [index, row] of candidate.rows.entries()) {
    exactFields(row, [
      'id', 'text', 'author', 'media', 'timestamp', 'dwellMs', 'exposureState',
      'lunaTopic', 'lunaClaimCluster',
    ], `${label}.rows[${index}]`);
    if (!/^\d+$/.test(row.id)) throw new Error(`${label}.rows[${index}]: invalid id`);
    if (ids.has(row.id)) throw new Error(`${label}: duplicate tweet ID ${row.id}`);
    ids.add(row.id);
    if (typeof row.text !== 'string' || !row.text.trim()) throw new Error(`${label}.rows[${index}]: empty text`);
    if (!Number.isFinite(row.timestamp) || row.timestamp < previous) throw new Error(`${label}: rows not chronological`);
    previous = row.timestamp;
  }
  return candidate;
}

function validateStepVerdict(step, label) {
  exactFields(step, STEP_VERDICT_FIELDS, label);
  if (!/^\d+$/.test(step.id)) throw new Error(`${label}: invalid id`);
  if (step.importance !== 'critical' && step.importance !== 'normal') throw new Error(`${label}: invalid importance`);
  nonEmptyString(step.topic, `${label}.topic`);
  nonEmptyString(step.contentType, `${label}.contentType`);
  if (!NOVELTIES.has(step.novelty)) throw new Error(`${label}: invalid novelty`);
  if (typeof step.funnelRisk !== 'boolean') throw new Error(`${label}: funnelRisk must be boolean`);
  if (typeof step.standaloneValue !== 'boolean') throw new Error(`${label}: standaloneValue must be boolean`);
  if (!Number.isFinite(step.confidence) || step.confidence < 0 || step.confidence > 1) {
    throw new Error(`${label}: invalid confidence`);
  }
  nonEmptyString(step.reason, `${label}.reason`);
  return step;
}

function validateVerdict(verdict, label, candidate = null) {
  exactFields(verdict, VERDICT_FIELDS, label);
  if (!/^candidate-\d{4}$/.test(verdict.candidateId)) throw new Error(`${label}: invalid candidateId`);
  if (candidate && verdict.candidateId !== candidate.candidateId) throw new Error(`${label}: candidateId differs from input`);
  if (typeof verdict.sameClaim !== 'boolean') throw new Error(`${label}: sameClaim must be boolean`);
  nonEmptyString(verdict.claimCluster, `${label}.claimCluster`);
  const normalizedCluster = verdict.claimCluster.trim().toLowerCase();
  if (verdict.sameClaim && normalizedCluster === 'rejected') throw new Error(`${label}: approved verdict cannot be rejected`);
  if (!verdict.sameClaim && verdict.claimCluster !== 'rejected') {
    throw new Error(`${label}: rejected verdict must use exact claimCluster rejected`);
  }
  if (!Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1) {
    throw new Error(`${label}: invalid confidence`);
  }
  nonEmptyString(verdict.reason, `${label}.reason`);
  if (!Array.isArray(verdict.steps)) throw new Error(`${label}: steps must be an array`);
  if (!verdict.sameClaim) {
    if (verdict.steps.length) throw new Error(`${label}: rejected verdict must have empty steps`);
    return verdict;
  }
  if (verdict.steps.length !== 3) throw new Error(`${label}: approved verdict requires three steps`);
  const expectedIds = candidate ? candidate.rows.map((row) => row.id) : null;
  for (const [index, step] of verdict.steps.entries()) {
    validateStepVerdict(step, `${label}.steps[${index}]`);
    if (expectedIds && step.id !== expectedIds[index]) {
      throw new Error(`${label}.steps[${index}]: step ID or order differs from candidate`);
    }
    if (index === 0 && step.novelty !== 'new-signal') {
      throw new Error(`${label}.steps[0]: first chronological step must be new-signal`);
    }
    if (index > 0 && step.novelty === 'new-signal') {
      throw new Error(`${label}.steps[${index}]: later same-claim step cannot be new-signal`);
    }
  }
  return verdict;
}

function canonicalCluster(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || value.trim();
}

function candidateProjection(corpusRow, verdict) {
  return {
    id: corpusRow.id,
    text: corpusRow.text,
    author: corpusRow.author,
    media: corpusRow.media,
    timestamp: corpusRow.timestamp,
    dwellMs: corpusRow.dwellMs,
    exposureState: corpusRow.exposureState,
    lunaTopic: verdict.topic,
    lunaClaimCluster: verdict.claimCluster,
  };
}

function loadPrepared(auditDir) {
  const candidateDir = path.join(auditDir, 'sequence-candidates');
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!Object.prototype.hasOwnProperty.call(manifest, 'maxIdUses')) {
    manifest.maxIdUses = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'exactClusterSupplementLimit')) {
    manifest.exactClusterSupplementLimit = 0;
    manifest.exactClusterSupplementCount = 0;
    manifest.exactClusterMaxRows = 12;
    manifest.semanticCandidateCount = manifest.candidateCount - (manifest.seedCandidateCount || 0);
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'excludedIds')) {
    manifest.excludedIds = [];
    manifest.excludedIdSha256 = idChecksum([]);
  }
  exactFields(manifest, MANIFEST_FIELDS, manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'rai-x-sequence-candidate-audit') {
    throw new Error(`${manifestPath}: invalid manifest identity`);
  }
  if (!Array.isArray(manifest.batches)) throw new Error(`${manifestPath}: batches must be an array`);
  if (!Number.isInteger(manifest.candidateCount) || manifest.candidateCount < 100) {
    throw new Error(`${manifestPath}: invalid candidateCount`);
  }
  if (!Number.isInteger(manifest.exactClusterSupplementLimit) || manifest.exactClusterSupplementLimit < 0 ||
      !Number.isInteger(manifest.exactClusterSupplementCount) || manifest.exactClusterSupplementCount < 0 ||
      manifest.exactClusterSupplementCount > manifest.exactClusterSupplementLimit ||
      !Number.isInteger(manifest.exactClusterMaxRows) || manifest.exactClusterMaxRows < 3 ||
      !Number.isInteger(manifest.semanticCandidateCount) || manifest.semanticCandidateCount < 0 ||
      manifest.seedCandidateCount + manifest.semanticCandidateCount + manifest.exactClusterSupplementCount !==
        manifest.candidateCount) {
    throw new Error(`${manifestPath}: invalid candidate source counts`);
  }
  if (!Number.isInteger(manifest.seedCandidateCount) || manifest.seedCandidateCount < 0 ||
      manifest.seedCandidateCount > manifest.candidateCount) {
    throw new Error(`${manifestPath}: invalid seedCandidateCount`);
  }
  if (!Number.isFinite(manifest.similarityThreshold) ||
      manifest.similarityThreshold < -1 || manifest.similarityThreshold > 1) {
    throw new Error(`${manifestPath}: invalid similarityThreshold`);
  }
  if (!Number.isInteger(manifest.maxIdUses) || manifest.maxIdUses < 0) {
    throw new Error(`${manifestPath}: invalid maxIdUses`);
  }
  if (!Array.isArray(manifest.excludedIds) ||
      manifest.excludedIds.some((id) => !/^\d+$/.test(id)) ||
      new Set(manifest.excludedIds).size !== manifest.excludedIds.length ||
      manifest.excludedIds.join('|') !== manifest.excludedIds.slice().sort().join('|')) {
    throw new Error(`${manifestPath}: invalid excludedIds`);
  }
  if (manifest.excludedIdSha256 !== idChecksum(manifest.excludedIds)) {
    throw new Error(`${manifestPath}: excluded ID checksum mismatch`);
  }
  nonEmptyString(manifest.embeddingModel, `${manifestPath}.embeddingModel`);
  nonEmptyString(manifest.embeddingInput, `${manifestPath}.embeddingInput`);

  const corpusPath = path.join(auditDir, 'corpus.jsonl');
  const verdictPath = path.join(auditDir, 'luna-verdicts.jsonl');
  const corpusBytes = fs.readFileSync(corpusPath);
  const verdictBytes = fs.readFileSync(verdictPath);
  if (audit.sha256(corpusBytes) !== manifest.corpusSha256) throw new Error('candidate manifest corpus checksum mismatch');
  if (audit.sha256(verdictBytes) !== manifest.verdictsSha256) throw new Error('candidate manifest verdict checksum mismatch');
  const corpus = parseJsonlBytes(corpusBytes, corpusPath)
    .map((row, index) => audit.validateCorpusRow(row, `${corpusPath}:${index + 1}`));
  const sourceVerdicts = parseJsonlBytes(verdictBytes, verdictPath)
    .map((row, index) => audit.validateLunaVerdict(row, `${verdictPath}:${index + 1}`));
  const corpusById = new Map(corpus.map((row) => [row.id, row]));
  const sourceVerdictById = new Map(sourceVerdicts.map((row) => [row.id, row]));
  if (corpusById.size !== corpus.length || sourceVerdictById.size !== sourceVerdicts.length ||
      corpusById.size !== sourceVerdictById.size ||
      [...corpusById.keys()].some((id) => !sourceVerdictById.has(id))) {
    throw new Error('candidate source ID sets differ');
  }

  const candidateFile = path.join(candidateDir, 'candidates.jsonl');
  const candidateBytes = fs.readFileSync(candidateFile);
  if (audit.sha256(candidateBytes) !== manifest.candidatesSha256) throw new Error('candidate corpus checksum mismatch');
  const candidates = parseJsonlBytes(candidateBytes, candidateFile)
    .map((row, index) => validateCandidate(row, `candidate[${index}]`));
  if (candidates.length !== manifest.candidateCount) throw new Error('candidate count mismatch');
  const candidateIds = new Set();
  const excludedIds = new Set(manifest.excludedIds);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const expectedCandidateId = `candidate-${String(candidateIndex).padStart(4, '0')}`;
    if (candidate.candidateId !== expectedCandidateId) throw new Error(`candidate[${candidateIndex}]: non-sequential candidateId`);
    if (candidateIds.has(candidate.candidateId)) throw new Error(`duplicate candidate ${candidate.candidateId}`);
    candidateIds.add(candidate.candidateId);
    for (const [index, row] of candidate.rows.entries()) {
      if (candidateIndex >= manifest.seedCandidateCount && excludedIds.has(row.id)) {
        throw new Error(`${candidate.candidateId}.rows[${index}]: excluded proposal ID`);
      }
      const corpusRow = corpusById.get(row.id);
      const verdict = sourceVerdictById.get(row.id);
      if (!corpusRow || !verdict) throw new Error(`candidate row ${row.id} missing from current source`);
      if (corpusRow.decision !== 'shown') throw new Error(`candidate row ${row.id} never reached the stage-2 memory pass`);
      const expected = candidateProjection(corpusRow, verdict);
      if (audit.stableJson(row) !== audit.stableJson(expected)) {
        throw new Error(`${candidate.candidateId}.rows[${index}]: differs from current corpus/Luna projection`);
      }
    }
  }

  let offset = 0;
  const batchCandidates = new Map();
  for (const [index, batch] of manifest.batches.entries()) {
    exactFields(batch, BATCH_FIELDS, `${manifestPath}.batches[${index}]`);
    if (batch.index !== index) throw new Error(`${manifestPath}.batches[${index}]: non-sequential index`);
    if (!Number.isInteger(batch.count) || batch.count < 1) throw new Error(`${manifestPath}.batches[${index}]: invalid count`);
    const file = path.join(candidateDir, batch.file);
    const bytes = fs.readFileSync(file);
    if (audit.sha256(bytes) !== batch.sha256) throw new Error(`${file}: checksum mismatch`);
    const rows = parseJsonlBytes(bytes, file)
      .map((row, rowIndex) => validateCandidate(row, `${file}:${rowIndex + 1}`));
    if (rows.length !== batch.count) throw new Error(`${file}: batch count mismatch`);
    const expected = candidates.slice(offset, offset + batch.count);
    if (audit.stableJson(rows) !== audit.stableJson(expected)) throw new Error(`${file}: batch content mismatch`);
    const actualIds = rows.map((row) => row.candidateId);
    if (audit.stableJson(batch.candidateIds) !== audit.stableJson(actualIds)) {
      throw new Error(`${file}: manifest candidateIds differ from batch rows`);
    }
    if (idChecksum(actualIds) !== batch.candidateIdSha256) throw new Error(`${file}: candidate ID checksum mismatch`);
    const promptPath = path.join(candidateDir, batch.promptFile);
    if (audit.sha256(fs.readFileSync(promptPath)) !== batch.promptSha256) throw new Error(`${promptPath}: prompt checksum mismatch`);
    batchCandidates.set(batch.file, rows);
    offset += batch.count;
  }
  if (offset !== candidates.length) throw new Error('candidate batches do not cover all candidates');
  return {
    candidateDir,
    manifest,
    candidates,
    candidateIds,
    batchCandidates,
    corpus,
    sourceVerdicts,
    corpusById,
    sourceVerdictById,
    corpusBytes,
    verdictBytes,
  };
}

function loadRun(candidateDir) {
  const file = path.join(candidateDir, 'run.json');
  const run = readJson(file);
  exactFields(run, RUN_FIELDS, file);
  if (run.schemaVersion !== 1 || run.kind !== 'rai-x-sequence-candidate-luna-run') {
    throw new Error(`${file}: invalid run identity`);
  }
  nonEmptyString(run.model, `${file}.model`);
  nonEmptyString(run.reasoning, `${file}.reasoning`);
  return run;
}

function validateCandidateOutputFile(file, batch, expectedCandidates, run) {
  const outputBytes = fs.readFileSync(file);
  const expectedById = new Map(expectedCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const rows = parseJsonlBytes(outputBytes, file).map((row, index) =>
    validateVerdict(row, `${file}:${index + 1}`, expectedById.get(row.candidateId) || null));
  const expectedIds = expectedCandidates.map((row) => row.candidateId);
  const actualIds = rows.map((row) => row.candidateId);
  if (new Set(actualIds).size !== actualIds.length) throw new Error(`${file}: duplicate candidate verdict ID`);
  if (idChecksum(actualIds) !== idChecksum(expectedIds)) throw new Error(`${file}: candidate verdict ID set differs`);
  if (rows.length !== batch.count) throw new Error(`${file}: expected ${batch.count} verdicts, got ${rows.length}`);
  return {
    verdicts: rows,
    record: {
      schemaVersion: 1,
      batchSha256: batch.sha256,
      candidateIdSha256: batch.candidateIdSha256,
      promptSha256: batch.promptSha256,
      outputSha256: audit.sha256(outputBytes),
      outputIdSha256: idChecksum(actualIds),
      count: rows.length,
      judgeModel: run.model,
      reasoning: run.reasoning,
    },
  };
}

function validateOutputs(auditDir, allowIncomplete) {
  const prepared = loadPrepared(auditDir);
  const run = loadRun(prepared.candidateDir);
  const verdicts = [];
  const pending = [];
  for (const batch of prepared.manifest.batches) {
    const file = path.join(prepared.candidateDir, batch.outputFile);
    const validationFile = path.join(prepared.candidateDir, batch.validationFile);
    if (!fs.existsSync(file) && !fs.existsSync(validationFile)) {
      pending.push(batch.file);
      continue;
    }
    if (!fs.existsSync(file) || !fs.existsSync(validationFile)) {
      throw new Error(`${file}: output and validation sidecar must both exist`);
    }
    const validated = validateCandidateOutputFile(
      file,
      batch,
      prepared.batchCandidates.get(batch.file),
      run,
    );
    const sidecar = readJson(validationFile);
    exactFields(sidecar, SIDECAR_FIELDS, validationFile);
    if (audit.stableJson(sidecar) !== audit.stableJson(validated.record)) {
      throw new Error(`${validationFile}: validation sidecar mismatch`);
    }
    verdicts.push(...validated.verdicts);
  }
  if (pending.length && !allowIncomplete) throw new Error(`candidate audit incomplete: ${pending.length} batches pending`);
  const allIds = new Set(verdicts.map((row) => row.candidateId));
  if (!pending.length && allIds.size !== prepared.candidateIds.size) throw new Error('combined candidate ID set differs');
  return { ...prepared, run, verdicts, pending };
}

function verdictStatus(verdict) {
  if (!verdict.sameClaim) return 'judge-rejected';
  if (verdict.confidence < APPROVAL_THRESHOLD) return 'below-claim-threshold';
  if (verdict.steps.some((step) => step.confidence < APPROVAL_THRESHOLD)) return 'below-step-threshold';
  return 'applied';
}

function candidateQuality(candidate, verdictByCandidate) {
  const verdict = verdictByCandidate.get(candidate.candidateId);
  return verdict.confidence + Math.min(...verdict.steps.map((step) => step.confidence));
}

function greedyDisjoint(candidates, comparator) {
  const selected = [];
  const used = new Set();
  for (const candidate of candidates.slice().sort(comparator)) {
    const ids = candidate.rows.map((row) => row.id);
    if (ids.some((id) => used.has(id))) continue;
    ids.forEach((id) => used.add(id));
    selected.push(candidate);
  }
  return selected;
}

function selectDisjointApproved(candidates, verdictByCandidate) {
  const frequency = new Map();
  for (const candidate of candidates) {
    for (const row of candidate.rows) frequency.set(row.id, (frequency.get(row.id) || 0) + 1);
  }
  const qualityOrder = (left, right) =>
    candidateQuality(right, verdictByCandidate) - candidateQuality(left, verdictByCandidate) ||
    right.minSimilarity - left.minSimilarity ||
    left.candidateId.localeCompare(right.candidateId);
  const scarcityOrder = (left, right) => {
    const leftFrequency = left.rows.reduce((sum, row) => sum + frequency.get(row.id), 0);
    const rightFrequency = right.rows.reduce((sum, row) => sum + frequency.get(row.id), 0);
    return leftFrequency - rightFrequency || qualityOrder(left, right);
  };
  const similarityOrder = (left, right) =>
    right.minSimilarity - left.minSimilarity || qualityOrder(left, right);
  const attempts = [scarcityOrder, qualityOrder, similarityOrder].map((comparator) =>
    greedyDisjoint(candidates, comparator));
  attempts.sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length;
    const leftQuality = left.reduce((sum, candidate) => sum + candidateQuality(candidate, verdictByCandidate), 0);
    const rightQuality = right.reduce((sum, candidate) => sum + candidateQuality(candidate, verdictByCandidate), 0);
    return rightQuality - leftQuality ||
      left.map((candidate) => candidate.candidateId).join('|')
        .localeCompare(right.map((candidate) => candidate.candidateId).join('|'));
  });
  return attempts[0];
}

function selectWithSeedBasis(candidates, verdictByCandidate, seedCandidateCount, excludedIds) {
  const eligible = candidates.filter((candidate) =>
    verdictStatus(verdictByCandidate.get(candidate.candidateId)) === 'applied');
  const globalSelection = selectDisjointApproved(eligible, verdictByCandidate);
  if (!excludedIds.length || !seedCandidateCount) return globalSelection;

  const seedIds = new Set(candidates
    .slice(0, seedCandidateCount)
    .map((candidate) => candidate.candidateId));
  const seedEligible = eligible.filter((candidate) => seedIds.has(candidate.candidateId));
  const supplementEligible = eligible.filter((candidate) => !seedIds.has(candidate.candidateId));
  const seedSelection = selectDisjointApproved(seedEligible, verdictByCandidate);
  const selectedTweetIds = new Set(seedSelection.flatMap((candidate) =>
    candidate.rows.map((row) => row.id)));
  if (selectedTweetIds.size !== excludedIds.length ||
      excludedIds.some((id) => !selectedTweetIds.has(id))) {
    return globalSelection;
  }

  const supplementSelection = selectDisjointApproved(supplementEligible, verdictByCandidate);
  const anchoredSelection = seedSelection.concat(supplementSelection);
  return anchoredSelection.length > globalSelection.length
    ? anchoredSelection
    : globalSelection;
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

function build(auditDir) {
  const result = validateOutputs(auditDir, false);
  const verdictByCandidate = new Map(result.verdicts.map((row) => [row.candidateId, row]));
  const statuses = new Map(result.verdicts.map((row) => [row.candidateId, verdictStatus(row)]));
  const eligibleApproved = result.candidates
    .filter((candidate) => statuses.get(candidate.candidateId) === 'applied');
  const approved = selectWithSeedBasis(
    result.candidates,
    verdictByCandidate,
    result.manifest.seedCandidateCount,
    result.manifest.excludedIds,
  );
  const approvedIds = new Set(approved.map((candidate) => candidate.candidateId));
  for (const candidate of eligibleApproved) {
    if (!approvedIds.has(candidate.candidateId)) statuses.set(candidate.candidateId, 'overlap-excluded');
  }

  const reconciledById = new Map(result.sourceVerdicts.map((row) => [row.id, { ...row }]));
  const sequenceCorpus = [];
  const sequenceVerdicts = [];
  for (const candidate of approved) {
    const candidateVerdict = verdictByCandidate.get(candidate.candidateId);
    const label = canonicalCluster(candidateVerdict.claimCluster);
    const cluster = `luna-second-pass-${candidate.candidateId}-${label}`;
    for (const [index, candidateRow] of candidate.rows.entries()) {
      const corpusRow = result.corpusById.get(candidateRow.id);
      const step = candidateVerdict.steps[index];
      const reconciledVerdict = audit.validateLunaVerdict({
        id: candidateRow.id,
        importance: step.importance,
        topic: step.topic,
        contentType: step.contentType,
        claimCluster: cluster,
        novelty: step.novelty,
        funnelRisk: step.funnelRisk,
        standaloneValue: step.standaloneValue,
        confidence: step.confidence,
        reason: step.reason,
      }, `${candidate.candidateId}.steps[${index}]`);
      reconciledById.set(candidateRow.id, reconciledVerdict);
      sequenceCorpus.push(corpusRow);
      sequenceVerdicts.push(reconciledVerdict);
    }
  }

  const byTime = (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id);
  sequenceCorpus.sort(byTime);
  const sequenceVerdictById = new Map(sequenceVerdicts.map((row) => [row.id, row]));
  const orderedSequenceVerdicts = sequenceCorpus.map((row) => sequenceVerdictById.get(row.id));
  const reconciled = result.sourceVerdicts.map((row) => reconciledById.get(row.id));

  const reconciledBytes = Buffer.from(audit.jsonl(reconciled));
  const sequenceCorpusBytes = Buffer.from(audit.jsonl(sequenceCorpus));
  const sequenceVerdictBytes = Buffer.from(audit.jsonl(orderedSequenceVerdicts));
  const artifact = audit.mineSequenceScenarios(sequenceCorpus, orderedSequenceVerdicts);
  audit.validateScenarioArtifact(artifact);
  if (artifact.scenarioCount !== approved.length) {
    throw new Error(`approved candidate/scenario count mismatch: ${approved.length}/${artifact.scenarioCount}`);
  }
  const approvedClusters = new Set(approved.map((candidate) => `luna-second-pass-${candidate.candidateId}-`));
  for (const scenario of artifact.scenarios) {
    if (![...approvedClusters].some((prefix) => scenario.claimCluster.startsWith(prefix))) {
      throw new Error(`scenario ${scenario.id} does not map to an approved second-pass candidate`);
    }
  }

  const artifactBytes = Buffer.from(JSON.stringify(artifact, null, 2) + '\n');
  const statusCounts = {
    applied: 0,
    'judge-rejected': 0,
    'below-claim-threshold': 0,
    'below-step-threshold': 0,
    'overlap-excluded': 0,
  };
  for (const status of statuses.values()) statusCounts[status]++;
  const candidateVerdictBytes = Buffer.from(audit.jsonl(result.verdicts));
  const report = {
    schemaVersion: 1,
    kind: 'rai-x-sequence-candidate-report',
    corpusSha256: result.manifest.corpusSha256,
    sourceVerdictsSha256: result.manifest.verdictsSha256,
    judgeModel: result.run.model,
    reasoning: result.run.reasoning,
    candidateCount: result.candidates.length,
    eligibleApprovedCount: eligibleApproved.length,
    appliedCount: statusCounts.applied,
    overlapExcludedCount: statusCounts['overlap-excluded'],
    judgeRejectedCount: statusCounts['judge-rejected'],
    belowClaimThresholdCount: statusCounts['below-claim-threshold'],
    belowStepThresholdCount: statusCounts['below-step-threshold'],
    notAppliedCount: result.candidates.length - statusCounts.applied,
    approvalThreshold: APPROVAL_THRESHOLD,
    candidateVerdictsSha256: audit.sha256(candidateVerdictBytes),
    reconciledVerdictsSha256: audit.sha256(reconciledBytes),
    sequenceCorpusSha256: audit.sha256(sequenceCorpusBytes),
    sequenceVerdictsSha256: audit.sha256(sequenceVerdictBytes),
    scenarioCount: artifact.scenarioCount,
    itemCount: artifact.itemCount,
    scenariosSha256: artifact.scenariosSha256,
  };

  writeAtomic(path.join(auditDir, 'luna-verdicts-reconciled.jsonl'), reconciledBytes);
  writeAtomic(path.join(auditDir, 'sequence-corpus.jsonl'), sequenceCorpusBytes);
  writeAtomic(path.join(auditDir, 'sequence-verdicts.jsonl'), sequenceVerdictBytes);
  writeAtomic(path.join(auditDir, 'sequence-scenarios.json'), artifactBytes);
  writeAtomic(path.join(result.candidateDir, 'report.json'), Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  return report;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const auditArg = argv.find((arg) => arg.startsWith('--audit-dir='));
  const auditDir = path.resolve(auditArg ? auditArg.slice(12) : DEFAULT_AUDIT_DIR);
  if (command === 'validate') {
    const result = validateOutputs(auditDir, argv.includes('--allow-incomplete'));
    const statuses = result.verdicts.map(verdictStatus);
    console.log(JSON.stringify({
      candidateCount: result.candidates.length,
      verdictCount: result.verdicts.length,
      pendingBatches: result.pending.length,
      eligibleApprovedAt075: statuses.filter((status) => status === 'applied').length,
      judgeRejected: statuses.filter((status) => status === 'judge-rejected').length,
      belowClaimThreshold: statuses.filter((status) => status === 'below-claim-threshold').length,
      belowStepThreshold: statuses.filter((status) => status === 'below-step-threshold').length,
    }, null, 2));
    return;
  }
  if (command === 'build') {
    console.log(JSON.stringify(build(auditDir), null, 2));
    return;
  }
  throw new Error('Expected command: validate or build');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVAL_THRESHOLD,
  validateCandidate,
  validateStepVerdict,
  validateVerdict,
  candidateProjection,
  loadPrepared,
  loadRun,
  validateCandidateOutputFile,
  validateOutputs,
  verdictStatus,
  selectDisjointApproved,
  selectWithSeedBasis,
  build,
};
