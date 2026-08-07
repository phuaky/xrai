import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorker } from '../benchmarks/load-extension.js';
import {
  NOVELTY_SYSTEM,
  buildUserMessage,
  createOllamaRequest,
  evaluateGate,
  loadEventTexts,
  parseNoveltyOutput,
  resolveCases,
  summarizeResults,
} from '../benchmarks/novelty-spike-x.js';

function jsonl(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'rai-novelty-spike-'));
  const file = join(dir, 'events-x.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

describe('ISC-52 novelty spike', () => {
  it('strictly accepts only the two exact one-field predictions', () => {
    expect(parseNoveltyOutput('{"prediction":"repeat"}')).toEqual({ prediction: 'repeat' });
    expect(parseNoveltyOutput('  {"prediction":"meaningful-update"}\n')).toEqual({ prediction: 'meaningful-update' });

    for (const raw of [
      '```json\n{"prediction":"repeat"}\n```',
      '{"prediction":"new-signal"}',
      '{"prediction":"repeat","reason":"same claim"}',
      '{"novelty":"repeat"}',
      '[{"prediction":"repeat"}]',
      'repeat',
      '',
    ]) {
      expect(parseNoveltyOutput(raw)).toBeNull();
    }
  });

  it('resolves each tweet ID to the longest available text deterministically', () => {
    const eventsPath = jsonl([
      { tweetId: 'a', kind: 'read', text: 'short' },
      { tweetId: 'a', decision: 'shown', text: 'the complete available text' },
      { tweetId: 'b', text: 'same length one' },
      { tweetId: 'b', text: 'same length two' },
      { tweetId: 'c', text: '' },
    ]);

    const texts = loadEventTexts(eventsPath);
    expect(texts.get('a')).toMatchObject({ text: 'the complete available text', line: 2 });
    expect(texts.get('b')).toMatchObject({ text: 'same length two', line: 4 });
    expect(texts.has('c')).toBe(false);
  });

  it('resolves valid cases while rejecting missing IDs and more than five contexts', () => {
    const texts = new Map([
      ['current', { text: 'current claim', truncated: false }],
      ...Array.from({ length: 6 }, (_, i) => [`ctx-${i + 1}`, { text: `context ${i + 1}`, truncated: false }]),
    ]);
    const fixture = {
      items: [
        { id: 'valid', currentId: 'current', contextIds: ['ctx-1', 'ctx-2'], expected: 'repeat' },
        { id: 'missing', currentId: 'absent', contextIds: ['ctx-1'], expected: 'repeat' },
        { id: 'too-many', currentId: 'current', contextIds: ['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4', 'ctx-5', 'ctx-6'], expected: 'meaningful-update' },
      ],
    };

    const resolved = resolveCases(fixture, texts);
    expect(resolved.valid).toHaveLength(1);
    expect(resolved.valid[0].contexts).toHaveLength(2);
    expect(resolved.invalid.map((item) => item.id)).toEqual(['missing', 'too-many']);
  });

  it('builds a stable prompt with no more than five ordered contexts', () => {
    const contexts = Array.from({ length: 5 }, (_, i) => ({ id: `ctx-${i + 1}`, text: `old ${i + 1}`, truncated: i === 0 }));
    const message = buildUserMessage({ id: 'current', text: 'new facts', truncated: false }, contexts);

    expect(message).toContain('CONTEXT TWEETS (5, in supplied order)');
    expect(message.indexOf('ctx-1')).toBeLessThan(message.indexOf('ctx-5'));
    expect(message).toContain('[historical text truncated at source]');
    expect(message).toContain('CURRENT TWEET\nid=current');
    expect(() => buildUserMessage({ id: 'current', text: 'x' }, contexts.concat({ id: 'ctx-6', text: 'old 6' }))).toThrow();
  });

  it('creates an Ollama request using the production text-call policy', () => {
    const worker = loadWorker();
    expect({ keepAlive: worker.TEXT_KEEP_ALIVE, numCtx: worker.TEXT_NUM_CTX }).toEqual({ keepAlive: '30m', numCtx: 8192 });
    const request = createOllamaRequest('production-x-model', worker.TEXT_KEEP_ALIVE, worker.TEXT_NUM_CTX, 'prompt');
    expect(request).toEqual({
      model: 'production-x-model',
      messages: [
        { role: 'system', content: NOVELTY_SYSTEM },
        { role: 'user', content: 'prompt' },
      ],
      stream: false,
      think: false,
      keep_alive: '30m',
      options: { temperature: 0.1, num_predict: 80, num_ctx: 8192 },
    });
  });

  it('reports agreement overall and by expected class', () => {
    const summary = summarizeResults([
      { expected: 'repeat', parsed: { prediction: 'repeat' } },
      { expected: 'repeat', parsed: { prediction: 'meaningful-update' } },
      { expected: 'repeat', parsed: null },
      { expected: 'meaningful-update', parsed: { prediction: 'meaningful-update' } },
    ]);

    expect(summary.overall).toMatchObject({ total: 4, valid: 3, correct: 2, agreement: 2 / 3 });
    expect(summary.byClass.repeat).toMatchObject({ total: 3, valid: 2, correct: 1, agreement: 0.5 });
    expect(summary.byClass['meaningful-update']).toMatchObject({ total: 1, valid: 1, correct: 1, agreement: 1 });
  });

  it('passes only at 75 percent agreement with at least 40 valid cases', () => {
    expect(evaluateGate({ overall: { valid: 40, agreement: 0.75 } })).toEqual({ pass: true, failures: [] });
    expect(evaluateGate({ overall: { valid: 39, agreement: 1 } }).pass).toBe(false);
    expect(evaluateGate({ overall: { valid: 40, agreement: 0.749 } }).pass).toBe(false);
  });
});
