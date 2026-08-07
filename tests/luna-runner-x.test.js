import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareAll, validateLunaOutputFile } from '../benchmarks/full-corpus-audit-x.js';
import {
  parseArgs,
  ensureRun,
  prepare,
  assertSourceSnapshot,
  pendingBatches,
} from '../benchmarks/run-luna-audit-x.js';
import {
  parseArgs as parseSequenceArgs,
} from '../benchmarks/run-luna-sequence-candidates-x.js';

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('resumable Luna runner', () => {
  it('parses bounded runner options', () => {
    expect(parseArgs([])).toMatchObject({ model: 'gpt-5.6-luna', reasoning: 'high' });
    expect(parseSequenceArgs([])).toMatchObject({ model: 'gpt-5.6-luna', reasoning: 'high' });
    expect(parseArgs(['--model=gpt-5.5', '--reasoning=high', '--parallel=4', '--dry-run']))
      .toMatchObject({ model: 'gpt-5.5', reasoning: 'high', parallel: 4, dryRun: true });
    expect(() => parseArgs(['--parallel=0'])).toThrow('1 to 16');
    expect(() => parseArgs(['--reasoning=extreme'])).toThrow('reasoning');
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown option');
  });

  it('validates completed outputs and resumes from the first missing batch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rai-luna-runner-'));
    const source = join(dir, 'events.jsonl');
    const out = join(dir, 'audit');
    writeFileSync(source, jsonl([
      { tweetId: '101', decision: 'shown', source: 'model', text: 'first', ts: 1 },
      { tweetId: '102', decision: 'shown', source: 'model', text: 'second', ts: 2 },
    ]));
    const manifest = prepareAll({ source, out, batchSize: 1 });
    const first = manifest.batches[0];
    const outputPath = join(out, first.outputFile);
    writeFileSync(outputPath, jsonl([{
      id: '101', importance: 'normal', topic: 'topic', contentType: 'post',
      claimCluster: 'claim', novelty: 'new-signal', funnelRisk: false,
      standaloneValue: true, confidence: 0.9, reason: 'first claim',
    }]));
    const prepared = prepare(out);
    const run = ensureRun(out, {
      model: 'gpt-5.5',
      reasoning: 'medium',
    });
    const validated = validateLunaOutputFile(
      outputPath,
      first,
      prepared.expectedRows.get(first.file),
      run,
    );
    writeFileSync(
      join(out, first.validationFile),
      JSON.stringify(validated.record) + '\n',
    );

    const pending = pendingBatches(prepared, run);
    expect(pending.map((batch) => batch.file)).toEqual([manifest.batches[1].file]);
    expect(existsSync(join(out, first.validationFile))).toBe(true);
    expect(assertSourceSnapshot(prepared)).toBe(manifest.sourceSha256);
    writeFileSync(source, readFileSync(source, 'utf8') + jsonl([
      { tweetId: '103', decision: 'shown', source: 'model', text: 'third', ts: 3 },
    ]));
    expect(() => assertSourceSnapshot(prepared)).toThrow('source checksum differs from manifest');
  });
});
