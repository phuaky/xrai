#!/usr/bin/env bun
// One-off seed verification for X claim history.
// Reads the append-only local event mirror, imports every retained feed decision
// with a real local embedding, then proves exact coverage and idempotence in an
// isolated IndexedDB. It never reads or writes Luna output.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = join(import.meta.dir, '..');
const SOURCE = resolve(process.argv.find((arg) => arg.endsWith('.jsonl')) || join(ROOT, 'data/events-x.jsonl'));
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.RAI_EMBEDDING_MODEL || 'all-minilm:latest';
const LIMIT_ARG = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Math.max(1, Number(LIMIT_ARG.split('=')[1]) || 0) : null;

function parseJsonl(path) {
  const raw = readFileSync(path, 'utf8');
  const rows = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (error) {
      throw new Error(`${path}:${i + 1}: invalid JSON: ${error.message}`);
    }
  }
  return {
    rows,
    sha256: createHash('sha256').update(raw).digest('hex'),
    physicalRows: lines.filter((line) => line.trim()).length,
  };
}

async function embed(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: text, truncate: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ollama embed HTTP ${response.status}`);
  const data = await response.json();
  const vector = data.embedding || (data.embeddings && data.embeddings[0]);
  if (!Array.isArray(vector) || !vector.length) throw new Error('invalid embedding response');
  return vector;
}

function loadKnowledge() {
  const source = readFileSync(join(ROOT, 'extension/lib/knowledge.js'), 'utf8');
  const chrome = {
    runtime: { lastError: undefined, sendMessage() {} },
    storage: { local: { get(_keys, cb) { cb({}); }, set(_value, cb) { if (cb) cb(); } } },
  };
  const loaded = new Function(
    'indexedDB', 'IDBKeyRange', 'chrome',
    `${source}\nreturn { RaiKnowledge: RaiKnowledge };`,
  )(indexedDB, IDBKeyRange, chrome);
  loaded.RaiKnowledge.configure({
    dbName: `xrai_seed_verify_${process.pid}`,
    embeddingModel: MODEL,
    embeddingVersion: 1,
    embed,
  });
  return loaded.RaiKnowledge;
}

const source = parseJsonl(SOURCE);
const knowledge = loadKnowledge();
const allPrepared = knowledge.prepareSeedRecords(source.rows);
const selected = LIMIT ? allPrepared.slice(0, LIMIT) : allPrepared;
const ids = new Set(selected.map((record) => record.tweetId));
const boundedEvents = source.rows.filter((event) => ids.has(String(event.tweetId || '')));
const prepared = knowledge.prepareSeedRecords(boundedEvents);

if (!prepared.length) throw new Error('no retained X feed decisions with text');

const started = performance.now();
const first = await knowledge.importSeed(boundedEvents);
const records = await knowledge.getAll();
const missingEmbedding = records.filter((record) => !Array.isArray(record.embedding) || !record.embedding.length);
const second = await knowledge.importSeed(boundedEvents);
const elapsedMs = performance.now() - started;

if (records.length !== prepared.length) {
  throw new Error(`coverage mismatch: prepared=${prepared.length} stored=${records.length}`);
}
if (missingEmbedding.length) {
  throw new Error(`missing embeddings for ${missingEmbedding.length} records; first=${missingEmbedding[0].tweetId}`);
}
if (second.inserted !== 0 || second.updated !== 0 || records.length !== await knowledge.count()) {
  throw new Error(`idempotence failure: ${JSON.stringify(second)}`);
}

const states = records.reduce((out, record) => {
  out[record.knownState] = (out[record.knownState] || 0) + 1;
  return out;
}, {});
const truncated = prepared.filter((record) => record.text.length === 500).length;

console.log(JSON.stringify({
  source: SOURCE,
  sourceSha256: source.sha256,
  physicalRows: source.physicalRows,
  prepared: prepared.length,
  stored: records.length,
  embedded: records.length - missingEmbedding.length,
  knownState: states,
  exact500Text: truncated,
  firstImport: first,
  secondImport: second,
  model: MODEL,
  elapsedMs: Math.round(elapsedMs),
  recordsPerSecond: Number((records.length / (elapsedMs / 1000)).toFixed(1)),
}, null, 2));
