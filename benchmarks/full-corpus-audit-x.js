#!/usr/bin/env node

// Full-corpus X audit tooling for the offline Luna judge and sequence eval.
// This file is intentionally disconnected from extension runtime code. It reads
// append-only collector events, prepares deterministic batches/prompts, validates
// externally produced verdicts, and mines eval scenarios.
//
// Usage:
//   node benchmarks/full-corpus-audit-x.js prepare-all [--source data/events-x.jsonl] [--out data/luna-audit-x]
//   node benchmarks/full-corpus-audit-x.js validate [--out data/luna-audit-x] [--allow-incomplete]
//   node benchmarks/full-corpus-audit-x.js report [--out data/luna-audit-x]
//   node benchmarks/full-corpus-audit-x.js mine-sequences [--out data/luna-audit-x] [--predictions predictions.jsonl]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE = path.join(ROOT, 'data', 'events-x.jsonl');
const DEFAULT_OUT = path.join(ROOT, 'data', 'luna-audit-x');
const DEFAULT_SEQUENCE_EMBEDDING_MODEL = 'all-minilm:latest';
const SCHEMA_VERSION = 1;
const CORPUS_FIELDS = [
  'id', 'text', 'author', 'media', 'decision', 'source',
  'timestamp', 'dwellMs', 'exposureState', 'truncated',
];
const LUNA_FIELDS = [
  'id', 'importance', 'topic', 'contentType', 'claimCluster', 'novelty',
  'funnelRisk', 'standaloneValue', 'confidence', 'reason',
];
const EXPOSURE_STATES = new Set(['direct-open', 'off-home-proxy', 'read', 'shown-unread', 'hidden-unread']);
const NOVELTIES = new Set(['new-signal', 'meaningful-update', 'reinforcement', 'repeat']);
const ACTIONS = new Set(['show', 'collapse']);
const SCENARIO_ARTIFACT_FIELDS = [
  'schemaVersion', 'kind', 'corpusSha256', 'verdictsSha256', 'scenarioCount',
  'itemCount', 'scenarios', 'scenariosSha256',
];
const SCENARIO_FIELDS = ['id', 'claimCluster', 'checksum', 'steps'];
const SCENARIO_STEP_FIELDS = [
  'id', 'timestamp', 'text', 'author', 'media', 'truncated', 'dwellMs',
  'exposureState', 'hasStrongKnownPrior', 'importance', 'topic', 'contentType',
  'novelty', 'funnelRisk', 'standaloneValue', 'confidence', 'reason',
];
const SEQUENCE_THRESHOLDS = Object.freeze({
  criticalSignalRecall: 1,
  showRetention: 0.85,
  strongKnownCollapseRecall: 0.8,
  falseCollapseRate: 0.05,
  valueFreeFunnelCollapseRate: 0.85,
});

const LUNA_PROMPT_HEADER = `You are Luna, an offline corpus judge building an evaluation artifact for rai's X memory filter.

This is eval-only work. Do not propose or emit extension runtime code, runtime prompts, knownState, or final actions. Judge every supplied corpus row independently while using the other rows in this batch for wording consistency.

Output JSONL only, exactly one object for every input id, with no markdown or prose. Every object must have exactly these fields:
{"id":"<input id>","importance":"critical|normal","topic":"<concise topic>","contentType":"<concise type>","claimCluster":"<stable same-claim cluster label>","novelty":"new-signal|meaningful-update|reinforcement|repeat","funnelRisk":false,"standaloneValue":true,"confidence":0.0,"reason":"<concise evidence-based reason>"}

Rules:
- importance, novelty, and user familiarity are separate judgments.
- critical means an opportunity or development the user would most regret missing.
- meaningful-update requires changed facts, numbers, evidence, release state, outage state, benchmark results, or a new actionable opportunity.
- reinforcement independently supports a familiar claim without materially changing it.
- repeat adds no meaningful delta.
- funnelRisk is true when the post tries to move the reader to a comment, DM, subscription, community, course, purchase, or external continuation.
- standaloneValue is true only when the supplied tweet itself delivers useful information before that request.
- claimCluster must be stable enough to group chronological versions of the same underlying claim.
- If text is empty, use topic/contentType/claimCluster "unjudgeable-empty-text", importance "normal", novelty "new-signal", funnelRisk false, standaloneValue false, confidence 0, and reason "No local text available".
- Never emit knownState or action. Those belong to deterministic ledger and policy code.
- Do not invent content absent from text or media metadata.
`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function writeIfChanged(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(contents))) return false;
  fs.writeFileSync(file, contents);
  return true;
}

function assertNoDuplicateObjectKeys(raw, label) {
  const stack = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const start = index;
      index++;
      for (; index < raw.length; index++) {
        if (raw[index] === '\\') index++;
        else if (raw[index] === '"') break;
      }
      if (index >= raw.length) throw new Error(`${label}: unterminated JSON string`);
      const current = stack[stack.length - 1];
      if (current && current.type === 'object' && current.expectingKey) {
        let cursor = index + 1;
        while (/\s/.test(raw[cursor] || '')) cursor++;
        if (raw[cursor] === ':') {
          const key = JSON.parse(raw.slice(start, index + 1));
          if (current.keys.has(key)) throw new Error(`${label}: duplicate field ${JSON.stringify(key)}`);
          current.keys.add(key);
          current.expectingKey = false;
        }
      }
      continue;
    }
    if (character === '{') {
      stack.push({ type: 'object', keys: new Set(), expectingKey: true });
    } else if (character === '[') {
      stack.push({ type: 'array' });
    } else if (character === '}' || character === ']') {
      stack.pop();
    } else if (character === ',') {
      const current = stack[stack.length - 1];
      if (current && current.type === 'object') current.expectingKey = true;
    }
  }
}

function parseJsonTextStrict(raw, label) {
  try {
    assertNoDuplicateObjectKeys(raw, label);
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
}

function readJsonStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  return parseJsonTextStrict(raw, file);
}

function parseJsonlTextStrict(raw, file) {
  const lines = raw.split('\n');
  const parsed = [];
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    const finalTrailingLine = index === lines.length - 1 && text === '';
    if (finalTrailingLine) continue;
    if (!text.trim()) throw new Error(`${file}:${index + 1}: blank JSONL row`);
    let row;
    try {
      assertNoDuplicateObjectKeys(text, `${file}:${index + 1}`);
      row = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
    }
    if (!isPlainObject(row)) throw new Error(`${file}:${index + 1}: expected a JSON object`);
    parsed.push({ row, line: index + 1, raw: text });
  }
  return parsed;
}

function parseJsonlStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  return parseJsonlTextStrict(raw, file);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateExactFields(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label}: expected object`);
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}: unknown field ${JSON.stringify(key)}`);
  }
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label}: missing field ${JSON.stringify(key)}`);
  }
}

function assertNonEmptyString(value, field, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: ${field} must be a non-empty string`);
}

function validTweetId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validateCorpusRow(row, label = 'corpus row') {
  validateExactFields(row, CORPUS_FIELDS, label);
  if (!validTweetId(row.id)) throw new Error(`${label}: id must be a digit-only JSON string`);
  if (typeof row.text !== 'string') throw new Error(`${label}: text must be a string`);
  if (row.author !== null && typeof row.author !== 'string') throw new Error(`${label}: author must be string or null`);
  if (typeof row.media !== 'string' || !row.media) throw new Error(`${label}: media must be a non-empty string`);
  if (row.decision !== 'shown' && row.decision !== 'hidden') throw new Error(`${label}: decision must be shown or hidden`);
  if (typeof row.source !== 'string') throw new Error(`${label}: source must be a string`);
  if (!Number.isFinite(row.timestamp)) throw new Error(`${label}: timestamp must be finite`);
  if (!Number.isFinite(row.dwellMs) || row.dwellMs < 0) throw new Error(`${label}: dwellMs must be non-negative`);
  if (!EXPOSURE_STATES.has(row.exposureState)) throw new Error(`${label}: invalid exposureState`);
  if (typeof row.truncated !== 'boolean') throw new Error(`${label}: truncated must be boolean`);
  return row;
}

function validateLunaVerdict(row, label = 'Luna verdict') {
  validateExactFields(row, LUNA_FIELDS, label);
  if (!validTweetId(row.id)) throw new Error(`${label}: id must be a digit-only JSON string`);
  if (row.importance !== 'critical' && row.importance !== 'normal') throw new Error(`${label}: invalid importance`);
  assertNonEmptyString(row.topic, 'topic', label);
  assertNonEmptyString(row.contentType, 'contentType', label);
  assertNonEmptyString(row.claimCluster, 'claimCluster', label);
  if (!NOVELTIES.has(row.novelty)) throw new Error(`${label}: invalid novelty`);
  if (typeof row.funnelRisk !== 'boolean') throw new Error(`${label}: funnelRisk must be boolean`);
  if (typeof row.standaloneValue !== 'boolean') throw new Error(`${label}: standaloneValue must be boolean`);
  if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
    throw new Error(`${label}: confidence must be between 0 and 1`);
  }
  assertNonEmptyString(row.reason, 'reason', label);
  return row;
}

function eventOrder(entry) {
  const ts = Number.isFinite(entry.row.ts) ? entry.row.ts : Number.NEGATIVE_INFINITY;
  return [ts, entry.line];
}

function compareEventEntries(left, right) {
  const [leftTs, leftLine] = eventOrder(left);
  const [rightTs, rightLine] = eventOrder(right);
  return leftTs - rightTs || leftLine - rightLine;
}

function isEligibleFeedDecision(row) {
  return row.kind == null && validTweetId(row.tweetId) &&
    (row.decision === 'shown' || row.decision === 'hidden') && row.surface !== 'own-replies';
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

function mediaValue(row) {
  const media = row.mediaType !== undefined ? row.mediaType : row.media;
  if (typeof media === 'string' && media.trim()) return media;
  return null;
}

function isExplicitDirectOpen(row) {
  return row.exposureState === 'direct-open' || row.kind === 'direct-open' ||
    row.directOpen === true || row.source === 'direct-open';
}

function canonicalizeGroup(id, feedEntries, allEntries) {
  const sortedFeed = feedEntries.slice().sort(compareEventEntries);
  const earliest = sortedFeed[0];
  const latest = sortedFeed[sortedFeed.length - 1];
  if (!Number.isFinite(earliest.row.ts)) throw new Error(`tweet ${id}: eligible feed row line ${earliest.line} lacks finite ts`);

  let bestText = null;
  for (const entry of sortedFeed) {
    if (!nonEmptyText(entry.row.text)) continue;
    if (!bestText || entry.row.text.length > bestText.row.text.length ||
        (entry.row.text.length === bestText.row.text.length && compareEventEntries(entry, bestText) > 0)) {
      bestText = entry;
    }
  }

  const sortedAll = allEntries.slice().sort(compareEventEntries);
  let author = null;
  let media = null;
  for (const entry of sortedAll) {
    if (typeof entry.row.author === 'string' && entry.row.author.trim()) author = entry.row.author;
    const nextMedia = mediaValue(entry.row);
    if (nextMedia) media = nextMedia;
  }

  let dwellMs = 0;
  let directOpen = false;
  let offHomeProxy = false;
  for (const entry of allEntries) {
    const row = entry.row;
    if (row.kind === 'read' && Number.isFinite(row.dwellMs) && row.dwellMs > 0) dwellMs += row.dwellMs;
    if (isExplicitDirectOpen(row)) directOpen = true;
    if (row.kind === 'read' && row.source === 'off-home') offHomeProxy = true;
  }

  let exposureState;
  if (directOpen) exposureState = 'direct-open';
  else if (offHomeProxy) exposureState = 'off-home-proxy';
  else if (dwellMs > 0) exposureState = 'read';
  else exposureState = latest.row.decision === 'shown' ? 'shown-unread' : 'hidden-unread';

  const text = bestText ? bestText.row.text : '';
  const hasLongerDecisionVersion = sortedFeed.some((entry) => nonEmptyText(entry.row.text) && entry.row.text.length > 500);
  return validateCorpusRow({
    id,
    text,
    author,
    media: media || 'text',
    decision: latest.row.decision,
    source: typeof latest.row.source === 'string' ? latest.row.source : '',
    timestamp: earliest.row.ts,
    dwellMs,
    exposureState,
    truncated: text.length === 500 && !hasLongerDecisionVersion,
  }, `corpus row ${id}`);
}

function buildCanonicalCorpus(parsedEvents) {
  const feedById = new Map();
  const retainedIds = new Set();
  for (const entry of parsedEvents) {
    if (!entry || !isPlainObject(entry.row) || !Number.isInteger(entry.line) || entry.line < 1) {
      throw new Error('parsed event entries must contain row and physical line');
    }
    if (!isEligibleFeedDecision(entry.row)) continue;
    if (!Number.isFinite(entry.row.ts)) throw new Error(`source line ${entry.line}: eligible feed decision lacks finite ts`);
    const id = String(entry.row.tweetId).trim();
    retainedIds.add(id);
    if (!feedById.has(id)) feedById.set(id, []);
    feedById.get(id).push(entry);
  }

  const allById = new Map([...retainedIds].map((id) => [id, []]));
  for (const entry of parsedEvents) {
    if (!validTweetId(entry.row.tweetId)) continue;
    const id = String(entry.row.tweetId).trim();
    if (allById.has(id)) allById.get(id).push(entry);
  }

  return [...retainedIds]
    .map((id) => ({ row: canonicalizeGroup(id, feedById.get(id), allById.get(id)), firstLine: Math.min(...feedById.get(id).map((entry) => entry.line)) }))
    .sort((left, right) => left.row.timestamp - right.row.timestamp || left.firstLine - right.firstLine || left.row.id.localeCompare(right.row.id))
    .map(({ row }) => row);
}

function uniqueIds(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    const id = String(row.id);
    if (ids.has(id)) throw new Error(`${label}: duplicate ID ${id}`);
    ids.add(id);
  }
  return ids;
}

function exactIdSet(actualRows, expectedRows, label) {
  const actual = uniqueIds(actualRows, label);
  const expected = uniqueIds(expectedRows, `${label} expected inputs`);
  for (const id of actual) if (!expected.has(id)) throw new Error(`${label}: unknown ID ${id}`);
  for (const id of expected) if (!actual.has(id)) throw new Error(`${label}: missing ID ${id}`);
  return actual;
}

function idChecksum(rows) {
  return sha256(rows.map((row) => String(row.id)).sort().join('\n') + (rows.length ? '\n' : ''));
}

function batchPrompt(batchRelativePath, batchSha256, count) {
  return `${LUNA_PROMPT_HEADER}\nBatch file: ${batchRelativePath}\nBatch SHA-256: ${batchSha256}\nExpected verdict count: ${count}\nRead the batch file and output the required JSONL.\n`;
}

function validationRecord(batch, outputBytes, verdicts, run) {
  return {
    schemaVersion: SCHEMA_VERSION,
    batchSha256: batch.sha256,
    batchIdSha256: batch.idSha256,
    promptSha256: batch.promptSha256,
    outputSha256: sha256(outputBytes),
    outputIdSha256: idChecksum(verdicts),
    count: verdicts.length,
    judgeModel: run.model,
    reasoning: run.reasoning,
  };
}

function validateLunaOutputFile(outputPath, batch, expectedRows, run) {
  const outputBytes = fs.readFileSync(outputPath);
  const parsed = parseJsonlTextStrict(outputBytes.toString('utf8'), outputPath);
  const verdicts = parsed.map(({ row, line }) => validateLunaVerdict(row, `${outputPath}:${line}`));
  exactIdSet(verdicts, expectedRows, outputPath);
  if (verdicts.length !== batch.count) throw new Error(`${outputPath}: expected ${batch.count} verdicts, got ${verdicts.length}`);
  if (idChecksum(verdicts) !== batch.idSha256) throw new Error(`${outputPath}: ID checksum does not match batch`);
  return { verdicts, record: validationRecord(batch, outputBytes, verdicts, run) };
}

function validateBatchOutput(out, batch, expectedRows, run) {
  return validateLunaOutputFile(path.join(out, batch.outputFile), batch, expectedRows, run);
}

function priorBatchFor(previousManifest, batch) {
  if (!previousManifest || !Array.isArray(previousManifest.batches)) return null;
  return previousManifest.batches.find((candidate) => candidate.outputFile === batch.outputFile) || null;
}

function validateExistingOutputProvenance(out, batch, expectedRows, previousManifest, run) {
  const outputPath = path.join(out, batch.outputFile);
  const validationPath = path.join(out, batch.validationFile);
  if (!fs.existsSync(outputPath)) return null;

  const prior = priorBatchFor(previousManifest, batch);
  if (!prior || prior.sha256 !== batch.sha256 || prior.idSha256 !== batch.idSha256 ||
      prior.promptSha256 !== batch.promptSha256) {
    throw new Error(`${outputPath}: stale Luna output; input batch or prompt changed, regenerate this verdict file`);
  }

  const { record } = validateBatchOutput(out, batch, expectedRows, run);
  if (!fs.existsSync(validationPath)) {
    throw new Error(`${validationPath}: existing Luna output lacks its runner-created validation sidecar`);
  }
  const sidecar = readJsonStrict(validationPath);
  if (stableJson(sidecar) !== stableJson(record)) {
    throw new Error(`${validationPath}: validation sidecar mismatch; regenerate or remove the stale output and sidecar`);
  }
  return null;
}

function prepareAll(options = {}) {
  const source = path.resolve(options.source || DEFAULT_SOURCE);
  const out = path.resolve(options.out || DEFAULT_OUT);
  const batchSize = Number(options.batchSize || 100);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');

  const sourceBefore = fs.readFileSync(source);
  const sourceSha256 = sha256(sourceBefore);
  const parsedEvents = parseJsonlTextStrict(sourceBefore.toString('utf8'), source);
  const corpus = buildCanonicalCorpus(parsedEvents);
  if (!corpus.length) throw new Error(`${source}: no eligible feed decisions; refusing an empty audit`);
  const corpusBytes = Buffer.from(jsonl(corpus));
  const corpusSha256 = sha256(corpusBytes);
  const eligibleRows = parsedEvents.filter(({ row }) => isEligibleFeedDecision(row)).length;
  const previousManifestPath = path.join(out, 'manifest.json');
  const previousManifest = fs.existsSync(previousManifestPath) ? readJsonStrict(previousManifestPath) : null;

  const preparedBatches = [];
  for (let offset = 0; offset < corpus.length; offset += batchSize) {
    const rows = corpus.slice(offset, offset + batchSize);
    const index = offset / batchSize;
    const stem = `batch-${String(index).padStart(4, '0')}`;
    const file = `batches/${stem}.jsonl`;
    const promptFile = `prompts/${stem}.txt`;
    const outputFile = `outputs/${stem}.jsonl`;
    const validationFile = `outputs/${stem}.validated.json`;
    const bytes = Buffer.from(jsonl(rows));
    const batchSha256 = sha256(bytes);
    const prompt = batchPrompt(file, batchSha256, rows.length);
    const batch = {
      index,
      file,
      promptFile,
      outputFile,
      validationFile,
      count: rows.length,
      sha256: batchSha256,
      idSha256: idChecksum(rows),
      promptSha256: sha256(Buffer.from(prompt)),
    };
    preparedBatches.push({ batch, rows, bytes, prompt });
  }

  const hasExistingOutputs = preparedBatches.some(({ batch }) =>
    fs.existsSync(path.join(out, batch.outputFile))
  );
  const run = hasExistingOutputs ? loadAuditRun(out) : null;
  const sidecarsToWrite = [];
  for (const prepared of preparedBatches) {
    const sidecar = validateExistingOutputProvenance(
      out,
      prepared.batch,
      prepared.rows,
      previousManifest,
      run,
    );
    if (sidecar) sidecarsToWrite.push(sidecar);
  }

  const sourceBeforePublishSha256 = sha256(fs.readFileSync(source));
  if (sourceBeforePublishSha256 !== sourceSha256) throw new Error(`${source}: source checksum changed during prepare-all`);

  fs.mkdirSync(path.join(out, 'outputs'), { recursive: true });
  writeIfChanged(path.join(out, 'corpus.jsonl'), corpusBytes);
  for (const { batch, bytes, prompt } of preparedBatches) {
    writeIfChanged(path.join(out, batch.file), bytes);
    writeIfChanged(path.join(out, batch.promptFile), prompt);
  }
  for (const { file, record } of sidecarsToWrite) writeIfChanged(file, JSON.stringify(record, null, 2) + '\n');

  const batches = preparedBatches.map(({ batch }) => batch);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rai-x-full-corpus-luna-audit',
    source: path.resolve(source),
    sourceSha256,
    sourceBytes: sourceBefore.length,
    corpusFile: 'corpus.jsonl',
    corpusSha256,
    corpusIdSha256: idChecksum(corpus),
    batchSize,
    counts: {
      sourceRows: parsedEvents.length,
      eligibleRows,
      uniqueIds: corpus.length,
      emptyTextIds: corpus.filter((row) => !row.text).length,
      truncatedIds: corpus.filter((row) => row.truncated).length,
      batches: batches.length,
    },
    batches,
  };
  writeIfChanged(previousManifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const sourceAfterSha256 = sha256(fs.readFileSync(source));
  if (sourceAfterSha256 !== sourceSha256) throw new Error(`${source}: source checksum changed during prepare-all`);
  return manifest;
}

function loadManifest(out) {
  const file = path.join(out, 'manifest.json');
  const manifest = readJsonStrict(file);
  if (!isPlainObject(manifest) || manifest.kind !== 'rai-x-full-corpus-luna-audit') throw new Error(`${file}: wrong manifest kind`);
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`${file}: unsupported schemaVersion`);
  if (!Array.isArray(manifest.batches)) throw new Error(`${file}: batches must be an array`);
  return manifest;
}

function loadAuditRun(out) {
  const file = path.join(out, 'run.json');
  const run = readJsonStrict(file);
  validateExactFields(run, ['schemaVersion', 'kind', 'model', 'reasoning'], file);
  if (run.schemaVersion !== SCHEMA_VERSION || run.kind !== 'rai-x-full-corpus-luna-run') {
    throw new Error(`${file}: invalid run identity`);
  }
  assertNonEmptyString(run.model, 'model', file);
  assertNonEmptyString(run.reasoning, 'reasoning', file);
  return run;
}

function validatePreparedInputs(out, manifest) {
  const corpusPath = path.join(out, manifest.corpusFile);
  const corpusBytes = fs.readFileSync(corpusPath);
  if (sha256(corpusBytes) !== manifest.corpusSha256) throw new Error(`${corpusPath}: corpus checksum mismatch`);
  const corpus = parseJsonlTextStrict(corpusBytes.toString('utf8'), corpusPath)
    .map(({ row, line }) => validateCorpusRow(row, `${corpusPath}:${line}`));
  uniqueIds(corpus, corpusPath);
  if (corpus.length !== manifest.counts.uniqueIds) throw new Error(`${corpusPath}: corpus count mismatch`);
  if (idChecksum(corpus) !== manifest.corpusIdSha256) throw new Error(`${corpusPath}: corpus ID checksum mismatch`);

  let offset = 0;
  for (const batch of manifest.batches) {
    const batchPath = path.join(out, batch.file);
    const bytes = fs.readFileSync(batchPath);
    if (sha256(bytes) !== batch.sha256) throw new Error(`${batchPath}: batch checksum mismatch`);
    const rows = parseJsonlTextStrict(bytes.toString('utf8'), batchPath)
      .map(({ row, line }) => validateCorpusRow(row, `${batchPath}:${line}`));
    const expected = corpus.slice(offset, offset + batch.count);
    if (stableJson(rows) !== stableJson(expected)) throw new Error(`${batchPath}: batch content does not match corpus slice`);
    if (idChecksum(rows) !== batch.idSha256) throw new Error(`${batchPath}: batch ID checksum mismatch`);
    const promptPath = path.join(out, batch.promptFile);
    if (sha256(fs.readFileSync(promptPath)) !== batch.promptSha256) throw new Error(`${promptPath}: prompt checksum mismatch`);
    offset += batch.count;
  }
  if (offset !== corpus.length) throw new Error('manifest batches do not cover the full corpus');
  return corpus;
}

function validateAudit(options = {}) {
  const out = path.resolve(options.out || DEFAULT_OUT);
  const allowIncomplete = !!options.allowIncomplete;
  const manifest = loadManifest(out);
  const sourceBeforeSha256 = sha256(fs.readFileSync(manifest.source));
  if (sourceBeforeSha256 !== manifest.sourceSha256) throw new Error(`${manifest.source}: source checksum differs from manifest`);
  const corpus = validatePreparedInputs(out, manifest);
  const hasOutputs = manifest.batches.some((batch) =>
    fs.existsSync(path.join(out, batch.outputFile))
  );
  const run = hasOutputs ? loadAuditRun(out) : null;

  const verdicts = [];
  const pending = [];
  let validatedBatches = 0;
  let offset = 0;
  for (const batch of manifest.batches) {
    const expectedRows = corpus.slice(offset, offset + batch.count);
    const outputPath = path.join(out, batch.outputFile);
    const validationPath = path.join(out, batch.validationFile);
    const hasOutput = fs.existsSync(outputPath);
    const hasValidation = fs.existsSync(validationPath);
    if (!hasOutput && !hasValidation) {
      pending.push(batch.file);
    } else if (!hasOutput || !hasValidation) {
      throw new Error(`${outputPath}: output and runner-created validation sidecar must both exist`);
    } else {
      const validated = validateBatchOutput(out, batch, expectedRows, run);
      const sidecar = readJsonStrict(validationPath);
      if (stableJson(sidecar) !== stableJson(validated.record)) {
        throw new Error(`${validationPath}: validation sidecar mismatch; output is not resumable`);
      }
      verdicts.push(...validated.verdicts);
      validatedBatches++;
    }
    offset += batch.count;
  }

  if (pending.length && !allowIncomplete) {
    throw new Error(`audit incomplete: missing output for ${pending[0]} (${pending.length} batch${pending.length === 1 ? '' : 'es'} pending)`);
  }
  if (!pending.length) exactIdSet(verdicts, corpus, 'combined Luna outputs');

  const sourceAfterSha256 = sha256(fs.readFileSync(manifest.source));
  if (sourceAfterSha256 !== sourceBeforeSha256) throw new Error(`${manifest.source}: source checksum changed during validation`);

  return {
    complete: pending.length === 0,
    sourceSha256: sourceBeforeSha256,
    corpusSha256: manifest.corpusSha256,
    corpusCount: corpus.length,
    validatedBatches,
    pendingBatches: pending.length,
    verdictCount: verdicts.length,
    corpus,
    verdicts,
    manifest,
    run,
  };
}

function reportAudit(options = {}) {
  const out = path.resolve(options.out || DEFAULT_OUT);
  const result = validateAudit({ out });
  const verdictById = new Map(result.verdicts.map((row) => [row.id, row]));
  const corpusById = new Map(result.corpus.map((row) => [row.id, row]));
  const orderedVerdicts = result.corpus.map((row) => verdictById.get(row.id));
  const unjudgeable = orderedVerdicts.filter((row) => !corpusById.get(row.id).text.trim());
  const unjudgeableIds = new Set(unjudgeable.map((row) => row.id));
  const review = orderedVerdicts.filter((row) => row.confidence < 0.75 || unjudgeableIds.has(row.id));
  writeIfChanged(path.join(out, 'luna-verdicts.jsonl'), jsonl(orderedVerdicts));
  writeIfChanged(path.join(out, 'human-review.jsonl'), jsonl(review));
  writeIfChanged(path.join(out, 'unjudgeable-empty-text.jsonl'), jsonl(unjudgeable));

  const report = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rai-x-full-corpus-luna-report',
    sourceSha256: result.sourceSha256,
    corpusSha256: result.corpusSha256,
    corpusCount: result.corpusCount,
    verdictCount: orderedVerdicts.length,
    judgeModel: result.run.model,
    reasoning: result.run.reasoning,
    reviewThreshold: 0.75,
    reviewCount: review.length,
    unjudgeableEmptyTextCount: unjudgeable.length,
    verdictsSha256: sha256(Buffer.from(jsonl(orderedVerdicts))),
    reviewSha256: sha256(Buffer.from(jsonl(review))),
    unjudgeableSha256: sha256(Buffer.from(jsonl(unjudgeable))),
  };
  writeIfChanged(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

function validateExactJoin(corpus, verdicts) {
  corpus.forEach((row, index) => validateCorpusRow(row, `corpus[${index}]`));
  verdicts.forEach((row, index) => validateLunaVerdict(row, `verdicts[${index}]`));
  exactIdSet(verdicts, corpus, 'corpus/Luna join');
  return new Map(verdicts.map((row) => [row.id, row]));
}

function strongKnown(row) {
  return row.dwellMs >= 1000 || row.exposureState === 'direct-open';
}

function canonicalClaimCluster(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || value.trim();
}

function mineSequenceScenarios(corpus, verdicts) {
  const verdictById = validateExactJoin(corpus, verdicts);
  const orderedVerdicts = corpus.map((row) => verdictById.get(row.id));
  const groups = new Map();
  for (const corpusRow of corpus) {
    if (!corpusRow.text.trim()) continue;
    const verdict = verdictById.get(corpusRow.id);
    const claimCluster = canonicalClaimCluster(verdict.claimCluster);
    if (!groups.has(claimCluster)) groups.set(claimCluster, []);
    groups.get(claimCluster).push({ corpusRow, verdict });
  }

  const scenarios = [];
  for (const [claimCluster, entries] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (entries.length < 3) continue;
    entries.sort((left, right) => left.corpusRow.timestamp - right.corpusRow.timestamp || left.corpusRow.id.localeCompare(right.corpusRow.id));
    let hasStrongKnownPrior = false;
    const steps = entries.map(({ corpusRow, verdict }) => {
      const step = {
        id: corpusRow.id,
        timestamp: corpusRow.timestamp,
        text: corpusRow.text,
        author: corpusRow.author,
        media: corpusRow.media,
        truncated: corpusRow.truncated,
        dwellMs: corpusRow.dwellMs,
        exposureState: corpusRow.exposureState,
        hasStrongKnownPrior,
        importance: verdict.importance,
        topic: verdict.topic,
        contentType: verdict.contentType,
        novelty: verdict.novelty,
        funnelRisk: verdict.funnelRisk,
        standaloneValue: verdict.standaloneValue,
        confidence: verdict.confidence,
        reason: verdict.reason,
      };
      if (strongKnown(corpusRow)) hasStrongKnownPrior = true;
      return step;
    });
    const scenarioChecksum = sha256(stableJson({ claimCluster, steps }));
    scenarios.push({
      id: `sequence-${scenarioChecksum.slice(0, 20)}`,
      claimCluster,
      checksum: scenarioChecksum,
      steps,
    });
  }
  scenarios.sort((left, right) => left.steps[0].timestamp - right.steps[0].timestamp || left.id.localeCompare(right.id));

  const artifactCore = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rai-x-sequence-scenarios',
    corpusSha256: sha256(Buffer.from(jsonl(corpus))),
    verdictsSha256: sha256(Buffer.from(jsonl(orderedVerdicts))),
    scenarioCount: scenarios.length,
    itemCount: scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
    scenarios,
  };
  return { ...artifactCore, scenariosSha256: sha256(stableJson(scenarios)) };
}

function validateScenarioArtifact(artifact, options = {}) {
  const minimum = options.minimum === undefined ? 100 : options.minimum;
  validateExactFields(artifact, SCENARIO_ARTIFACT_FIELDS, 'scenario artifact');
  if (artifact.kind !== 'rai-x-sequence-scenarios') throw new Error('scenario artifact: wrong kind');
  if (artifact.schemaVersion !== SCHEMA_VERSION) throw new Error('scenario artifact: unsupported schemaVersion');
  if (!/^[a-f0-9]{64}$/.test(artifact.corpusSha256) || !/^[a-f0-9]{64}$/.test(artifact.verdictsSha256) ||
      !/^[a-f0-9]{64}$/.test(artifact.scenariosSha256)) throw new Error('scenario artifact: invalid SHA-256');
  if (!Array.isArray(artifact.scenarios)) throw new Error('scenario artifact: scenarios must be an array');
  if (artifact.scenarios.length < minimum) throw new Error(`scenario artifact: expected at least ${minimum} scenarios`);
  if (artifact.scenarioCount !== artifact.scenarios.length) throw new Error('scenario artifact: scenarioCount mismatch');

  const scenarioIds = new Set();
  const itemIds = new Set();
  let itemCount = 0;
  for (const [index, scenario] of artifact.scenarios.entries()) {
    const label = `scenario[${index}]`;
    validateExactFields(scenario, SCENARIO_FIELDS, label);
    if (typeof scenario.id !== 'string' || !scenario.id) throw new Error(`${label}: invalid id`);
    if (scenarioIds.has(scenario.id)) throw new Error(`${label}: duplicate scenario ID ${scenario.id}`);
    scenarioIds.add(scenario.id);
    assertNonEmptyString(scenario.claimCluster, 'claimCluster', label);
    if (!/^[a-f0-9]{64}$/.test(scenario.checksum)) throw new Error(`${label}: invalid checksum`);
    if (!Array.isArray(scenario.steps) || scenario.steps.length < 3) throw new Error(`${label}: requires at least 3 steps`);
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    let expectedStrongKnownPrior = false;
    for (const [stepIndex, step] of scenario.steps.entries()) {
      const stepLabel = `${label}.steps[${stepIndex}]`;
      validateExactFields(step, SCENARIO_STEP_FIELDS, stepLabel);
      if (!validTweetId(step.id)) throw new Error(`${stepLabel}: invalid id`);
      if (itemIds.has(step.id)) throw new Error(`${stepLabel}: duplicate item ID ${step.id}`);
      itemIds.add(step.id);
      if (!Number.isFinite(step.timestamp) || step.timestamp < previousTimestamp) throw new Error(`${stepLabel}: not chronological`);
      previousTimestamp = step.timestamp;
      if (typeof step.text !== 'string') throw new Error(`${stepLabel}: text must be a string`);
      if (step.author !== null && typeof step.author !== 'string') throw new Error(`${stepLabel}: invalid author`);
      if (typeof step.media !== 'string' || !step.media) throw new Error(`${stepLabel}: invalid media`);
      if (typeof step.truncated !== 'boolean') throw new Error(`${stepLabel}: invalid truncated`);
      if (!Number.isFinite(step.dwellMs) || step.dwellMs < 0) throw new Error(`${stepLabel}: invalid dwellMs`);
      if (!EXPOSURE_STATES.has(step.exposureState)) throw new Error(`${stepLabel}: invalid exposureState`);
      if (step.hasStrongKnownPrior !== expectedStrongKnownPrior) {
        throw new Error(`${stepLabel}: hasStrongKnownPrior differs from ledger evidence`);
      }
      if (strongKnown(step)) expectedStrongKnownPrior = true;
      if (step.importance !== 'critical' && step.importance !== 'normal') throw new Error(`${stepLabel}: invalid importance`);
      assertNonEmptyString(step.topic, 'topic', stepLabel);
      assertNonEmptyString(step.contentType, 'contentType', stepLabel);
      if (!NOVELTIES.has(step.novelty)) throw new Error(`${stepLabel}: invalid novelty`);
      if (typeof step.funnelRisk !== 'boolean' || typeof step.standaloneValue !== 'boolean') throw new Error(`${stepLabel}: invalid policy fields`);
      if (!Number.isFinite(step.confidence) || step.confidence < 0 || step.confidence > 1) throw new Error(`${stepLabel}: invalid confidence`);
      assertNonEmptyString(step.reason, 'reason', stepLabel);
      itemCount++;
    }
    const expectedChecksum = sha256(stableJson({ claimCluster: scenario.claimCluster, steps: scenario.steps }));
    if (scenario.checksum !== expectedChecksum) throw new Error(`${label}: checksum mismatch`);
    if (scenario.id !== `sequence-${expectedChecksum.slice(0, 20)}`) throw new Error(`${label}: deterministic ID mismatch`);
  }
  if (artifact.itemCount !== itemCount) throw new Error('scenario artifact: itemCount mismatch');
  if (artifact.scenariosSha256 !== sha256(stableJson(artifact.scenarios))) throw new Error('scenario artifact: scenarios checksum mismatch');
  return { scenarioCount: artifact.scenarios.length, itemCount };
}

function validatePredictions(artifact, predictions) {
  if (!Array.isArray(predictions)) throw new Error('predictions must be an array');
  const expected = artifact.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({ id: step.id })));
  for (const [index, prediction] of predictions.entries()) {
    validateExactFields(prediction, ['id', 'action'], `prediction[${index}]`);
    if (!validTweetId(prediction.id)) throw new Error(`prediction[${index}]: invalid id`);
    if (!ACTIONS.has(prediction.action)) throw new Error(`prediction[${index}]: invalid action`);
  }
  exactIdSet(predictions, expected, 'sequence predictions');
  return new Map(predictions.map((prediction) => [prediction.id, prediction.action]));
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function productionPredictionConfiguration() {
  const defaults = require('./load-extension.js').loadConfigDefaults().x;
  return {
    model: defaults.model,
    embeddingModel: DEFAULT_SEQUENCE_EMBEDDING_MODEL,
    memoryConfidenceThreshold: defaults.memoryConfidenceThreshold,
  };
}

function validatePredictionProvenance(artifact, predictionPath, predictions, reportPath, expectedConfiguration) {
  const resolvedReport = reportPath || predictionPath.replace(/\.jsonl$/, '-report.json');
  const reportBytes = fs.readFileSync(resolvedReport);
  const report = parseJsonTextStrict(reportBytes.toString('utf8'), resolvedReport);
  validateExactFields(report, [
    'schemaVersion', 'kind', 'date', 'model', 'embeddingModel',
    'memoryConfidenceThreshold', 'scenariosSha256', 'predictionsSha256',
    'predictionCount', 'failures', 'latency', 'details',
  ], resolvedReport);
  if (report.schemaVersion !== SCHEMA_VERSION || report.kind !== 'rai-x-sequence-predictions') {
    throw new Error(`${resolvedReport}: invalid prediction report identity`);
  }
  assertNonEmptyString(report.model, 'model', resolvedReport);
  assertNonEmptyString(report.embeddingModel, 'embeddingModel', resolvedReport);
  if (!Number.isFinite(report.memoryConfidenceThreshold) ||
      report.memoryConfidenceThreshold < 0 || report.memoryConfidenceThreshold > 1) {
    throw new Error(`${resolvedReport}: invalid memoryConfidenceThreshold`);
  }
  const expected = expectedConfiguration || productionPredictionConfiguration();
  for (const field of ['model', 'embeddingModel', 'memoryConfidenceThreshold']) {
    if (report[field] !== expected[field]) {
      throw new Error(`${resolvedReport}: ${field} ${JSON.stringify(report[field])} differs from production ${JSON.stringify(expected[field])}`);
    }
  }
  if (!Number.isInteger(report.predictionCount) || report.predictionCount < 0) {
    throw new Error(`${resolvedReport}: invalid predictionCount`);
  }
  if (!Number.isInteger(report.failures) || report.failures < 0) {
    throw new Error(`${resolvedReport}: invalid failures`);
  }
  if (!Array.isArray(report.details)) throw new Error(`${resolvedReport}: details must be an array`);
  if (report.scenariosSha256 !== artifact.scenariosSha256) {
    throw new Error(`${resolvedReport}: predictions were produced for different scenarios`);
  }
  const predictionBytes = fs.readFileSync(predictionPath);
  const snapshotPredictions = parseJsonlTextStrict(predictionBytes.toString('utf8'), predictionPath).map(({ row }) => row);
  if (stableJson(snapshotPredictions) !== stableJson(predictions)) {
    throw new Error(`${predictionPath}: predictions changed during provenance validation`);
  }
  if (report.predictionsSha256 !== sha256(predictionBytes)) {
    throw new Error(`${resolvedReport}: prediction checksum mismatch`);
  }
  if (report.predictionCount !== predictions.length) throw new Error(`${resolvedReport}: prediction count mismatch`);
  if (report.details.length !== report.predictionCount) throw new Error(`${resolvedReport}: prediction detail count mismatch`);
  const detailIds = report.details.map((detail, index) => {
    if (!isPlainObject(detail) || !validTweetId(detail.id)) throw new Error(`${resolvedReport}: invalid detail ${index}`);
    if (detail.failure != null) throw new Error(`${resolvedReport}: detail ${detail.id} records a failure`);
    return { id: detail.id };
  });
  exactIdSet(detailIds, predictions, `${resolvedReport} details`);
  if (report.failures !== 0) throw new Error(`${resolvedReport}: prediction run had ${report.failures} failures`);
  return { ...report, reportSha256: sha256(reportBytes) };
}

function computeSequenceMetrics(artifact, predictions) {
  validateScenarioArtifact(artifact);
  const actionById = validatePredictions(artifact, predictions);
  const counts = {
    criticalShown: 0,
    criticalTotal: 0,
    noveltyShown: 0,
    noveltyTotal: 0,
    strongKnownCollapsed: 0,
    strongKnownTotal: 0,
    noveltyCollapsed: 0,
    valueFreeFunnelCollapsed: 0,
    valueFreeFunnelTotal: 0,
  };

  for (const scenario of artifact.scenarios) {
    for (const step of scenario.steps) {
      const action = actionById.get(step.id);
      if (step.importance === 'critical') {
        counts.criticalTotal++;
        if (action === 'show') counts.criticalShown++;
      }
      if (step.novelty === 'new-signal' || step.novelty === 'meaningful-update') {
        counts.noveltyTotal++;
        if (action === 'show') counts.noveltyShown++;
        else counts.noveltyCollapsed++;
      }
      if (step.importance === 'normal' &&
          (step.novelty === 'reinforcement' || step.novelty === 'repeat') &&
          step.hasStrongKnownPrior) {
        counts.strongKnownTotal++;
        if (action === 'collapse') counts.strongKnownCollapsed++;
      }
      if (step.importance === 'normal' && step.funnelRisk && !step.standaloneValue) {
        counts.valueFreeFunnelTotal++;
        if (action === 'collapse') counts.valueFreeFunnelCollapsed++;
      }
    }
  }

  return {
    criticalSignalRecall: ratio(counts.criticalShown, counts.criticalTotal),
    showRetention: ratio(counts.noveltyShown, counts.noveltyTotal),
    strongKnownCollapseRecall: ratio(counts.strongKnownCollapsed, counts.strongKnownTotal),
    falseCollapseRate: ratio(counts.noveltyCollapsed, counts.noveltyTotal),
    valueFreeFunnelCollapseRate: ratio(counts.valueFreeFunnelCollapsed, counts.valueFreeFunnelTotal),
    counts,
  };
}

function enforceSequenceThresholds(metrics, thresholds = SEQUENCE_THRESHOLDS) {
  const checks = [
    ['criticalSignalRecall', 'minimum'],
    ['showRetention', 'minimum'],
    ['strongKnownCollapseRecall', 'minimum'],
    ['falseCollapseRate', 'maximum'],
    ['valueFreeFunnelCollapseRate', 'minimum'],
  ];
  const failures = [];
  for (const [name, direction] of checks) {
    const value = metrics[name];
    const threshold = thresholds[name];
    if (!Number.isFinite(value)) failures.push(`${name}: no eligible cases`);
    else if (direction === 'minimum' && value < threshold) failures.push(`${name}: ${value} < ${threshold}`);
    else if (direction === 'maximum' && value > threshold) failures.push(`${name}: ${value} > ${threshold}`);
  }
  return { pass: failures.length === 0, thresholds: { ...thresholds }, failures };
}

function validateSequenceBuildProvenance(out, scenarioPath) {
  const resolvedScenarioPath = path.resolve(scenarioPath || path.join(out, 'sequence-scenarios.json'));
  const artifact = readJsonStrict(resolvedScenarioPath);
  validateScenarioArtifact(artifact);

  const corpusPath = path.join(out, 'sequence-corpus.jsonl');
  const verdictPath = path.join(out, 'sequence-verdicts.jsonl');
  const corpusBytes = fs.readFileSync(corpusPath);
  const verdictBytes = fs.readFileSync(verdictPath);
  if (sha256(corpusBytes) !== artifact.corpusSha256) throw new Error(`${corpusPath}: differs from scenario artifact`);
  if (sha256(verdictBytes) !== artifact.verdictsSha256) throw new Error(`${verdictPath}: differs from scenario artifact`);
  const corpus = parseJsonlTextStrict(corpusBytes.toString('utf8'), corpusPath)
    .map(({ row, line }) => validateCorpusRow(row, `${corpusPath}:${line}`));
  const verdicts = parseJsonlTextStrict(verdictBytes.toString('utf8'), verdictPath)
    .map(({ row, line }) => validateLunaVerdict(row, `${verdictPath}:${line}`));
  const rebuilt = mineSequenceScenarios(corpus, verdicts);
  if (stableJson(rebuilt) !== stableJson(artifact)) {
    throw new Error(`${resolvedScenarioPath}: artifact differs from its immutable sequence inputs`);
  }

  const candidateReportPath = path.join(out, 'sequence-candidates', 'report.json');
  const candidateReportBytes = fs.readFileSync(candidateReportPath);
  const candidateReport = parseJsonTextStrict(candidateReportBytes.toString('utf8'), candidateReportPath);
  if (candidateReport.schemaVersion !== SCHEMA_VERSION || candidateReport.kind !== 'rai-x-sequence-candidate-report') {
    throw new Error(`${candidateReportPath}: invalid candidate report identity`);
  }
  if (candidateReport.scenariosSha256 !== artifact.scenariosSha256 ||
      candidateReport.sequenceCorpusSha256 !== artifact.corpusSha256 ||
      candidateReport.sequenceVerdictsSha256 !== artifact.verdictsSha256) {
    throw new Error(`${candidateReportPath}: scenario provenance differs from built artifact`);
  }
  if (candidateReport.appliedCount !== artifact.scenarioCount ||
      candidateReport.scenarioCount !== artifact.scenarioCount ||
      candidateReport.itemCount !== artifact.itemCount) {
    throw new Error(`${candidateReportPath}: approved candidate counts differ from built artifact`);
  }
  assertNonEmptyString(candidateReport.judgeModel, 'judgeModel', candidateReportPath);
  assertNonEmptyString(candidateReport.reasoning, 'reasoning', candidateReportPath);
  return {
    artifact,
    candidateReport,
    candidateReportPath,
    candidateReportSha256: sha256(candidateReportBytes),
  };
}

function mineSequencesFromAudit(options = {}) {
  const out = path.resolve(options.out || DEFAULT_OUT);
  const validation = validateAudit({ out });

  if (options.predictions) {
    if (options.verdicts) throw new Error('--verdicts cannot be combined with --predictions; score the built scenario artifact');
    const sequence = validateSequenceBuildProvenance(out, options.scenarios);
    const artifact = sequence.artifact;
    const predictionPath = path.resolve(options.predictions);
    const predictionReportPath = options.predictionReport
      ? path.resolve(options.predictionReport)
      : predictionPath.replace(/\.jsonl$/, '-report.json');
    const predictions = parseJsonlStrict(predictionPath).map(({ row }) => row);
    const predictionProvenance = validatePredictionProvenance(
      artifact,
      predictionPath,
      predictions,
      predictionReportPath,
    );
    const metrics = computeSequenceMetrics(artifact, predictions);
    const gate = enforceSequenceThresholds(metrics);
    const evaluation = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'rai-x-sequence-eval-report',
      corpusSha256: validation.corpusSha256,
      scenariosSha256: artifact.scenariosSha256,
      candidateReportSha256: sequence.candidateReportSha256,
      judgeModel: sequence.candidateReport.judgeModel,
      judgeReasoning: sequence.candidateReport.reasoning,
      model: predictionProvenance.model,
      embeddingModel: predictionProvenance.embeddingModel,
      memoryConfidenceThreshold: predictionProvenance.memoryConfidenceThreshold,
      predictionReportSha256: predictionProvenance.reportSha256,
      predictionsSha256: predictionProvenance.predictionsSha256,
      metrics,
      gate,
    };
    writeIfChanged(path.join(out, 'sequence-report.json'), JSON.stringify(evaluation, null, 2) + '\n');
    if (!gate.pass) throw new Error(`sequence thresholds failed: ${gate.failures.join('; ')}`);
    return { artifact, evaluation };
  }

  const verdicts = options.verdicts
    ? parseJsonlStrict(path.resolve(options.verdicts)).map(({ row, line }) =>
      validateLunaVerdict(row, `${path.resolve(options.verdicts)}:${line}`))
    : validation.verdicts;
  const artifact = mineSequenceScenarios(validation.corpus, verdicts);
  validateScenarioArtifact(artifact);
  writeIfChanged(path.join(out, 'sequence-scenarios.json'), JSON.stringify(artifact, null, 2) + '\n');
  return { artifact, evaluation: null };
}

const CLI_OPTIONS = Object.freeze({
  'prepare-all': { values: new Set(['source', 'out', 'batch-size']), flags: new Set() },
  validate: { values: new Set(['out']), flags: new Set(['allow-incomplete']) },
  report: { values: new Set(['out']), flags: new Set() },
  'mine-sequences': { values: new Set(['out', 'verdicts', 'scenarios', 'predictions', 'prediction-report']), flags: new Set() },
});

function parseCliArgs(argv) {
  const command = argv[0];
  const definition = CLI_OPTIONS[command];
  if (!definition) throw new Error('Expected command: prepare-all, validate, report, or mine-sequences');
  const values = {};
  const flags = new Set();
  const seen = new Set();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--') || token === '--') throw new Error(`Unexpected positional argument ${JSON.stringify(token)}`);
    const name = token.slice(2);
    if (seen.has(name)) throw new Error(`Duplicate option --${name}`);
    seen.add(name);
    if (definition.flags.has(name)) {
      flags.add(name);
      continue;
    }
    if (!definition.values.has(name)) throw new Error(`Unknown option --${name} for ${command}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    values[name] = value;
  }
  return { command, values, flags };
}

function printPrepare(manifest) {
  console.log(`source rows: ${manifest.counts.sourceRows}`);
  console.log(`eligible feed decisions: ${manifest.counts.eligibleRows}`);
  console.log(`unique retained IDs: ${manifest.counts.uniqueIds}`);
  console.log(`empty-text IDs retained: ${manifest.counts.emptyTextIds}`);
  console.log(`truncated IDs: ${manifest.counts.truncatedIds}`);
  console.log(`batches: ${manifest.counts.batches}`);
  console.log(`source sha256: ${manifest.sourceSha256}`);
  console.log(`corpus sha256: ${manifest.corpusSha256}`);
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.command;
  const out = path.resolve(parsed.values.out || DEFAULT_OUT);
  if (command === 'prepare-all') {
    const manifest = prepareAll({
      source: path.resolve(parsed.values.source || DEFAULT_SOURCE),
      out,
      batchSize: Number(parsed.values['batch-size'] || '100'),
    });
    printPrepare(manifest);
    return;
  }
  if (command === 'validate') {
    const result = validateAudit({ out, allowIncomplete: parsed.flags.has('allow-incomplete') });
    console.log(JSON.stringify({
      complete: result.complete,
      corpusCount: result.corpusCount,
      verdictCount: result.verdictCount,
      validatedBatches: result.validatedBatches,
      pendingBatches: result.pendingBatches,
      sourceSha256: result.sourceSha256,
      corpusSha256: result.corpusSha256,
    }, null, 2));
    return;
  }
  if (command === 'report') {
    console.log(JSON.stringify(reportAudit({ out }), null, 2));
    return;
  }
  const result = mineSequencesFromAudit({
    out,
    verdicts: parsed.values.verdicts || null,
    scenarios: parsed.values.scenarios || null,
    predictions: parsed.values.predictions || null,
    predictionReport: parsed.values['prediction-report'] || null,
  });
  console.log(JSON.stringify({
    scenarioCount: result.artifact.scenarioCount,
    itemCount: result.artifact.itemCount,
    scenariosSha256: result.artifact.scenariosSha256,
    gate: result.evaluation ? result.evaluation.gate : null,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Fatal: ${error.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  LUNA_PROMPT_HEADER,
  SEQUENCE_THRESHOLDS,
  sha256,
  stableJson,
  jsonl,
  readJsonStrict,
  parseJsonlTextStrict,
  parseJsonlStrict,
  isEligibleFeedDecision,
  buildCanonicalCorpus,
  validateCorpusRow,
  validateLunaVerdict,
  loadManifest,
  loadAuditRun,
  validatePreparedInputs,
  validateLunaOutputFile,
  prepareAll,
  validateAudit,
  reportAudit,
  mineSequenceScenarios,
  validateScenarioArtifact,
  productionPredictionConfiguration,
  validatePredictionProvenance,
  validateSequenceBuildProvenance,
  computeSequenceMetrics,
  enforceSequenceThresholds,
  mineSequencesFromAudit,
  parseCliArgs,
  main,
};
