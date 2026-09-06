import { describe, it, expect } from 'bun:test';
import live from '../benchmarks/bench-memory-live-x.js';

describe('current memory replay inputs', () => {
  it('accepts an explicit sample size and rejects undersized runs', () => {
    expect(live.parseArgs([])).toEqual({ sampleSize: 100 });
    expect(live.parseArgs(['--sample=12'])).toEqual({ sampleSize: 12 });
    expect(() => live.parseArgs(['--sample=1'])).toThrow('--sample must be an integer >= 2');
  });

  it('deduplicates current shown model signals and carries read evidence', () => {
    const recent = Date.parse('2026-08-10T00:00:00Z');
    const rows = live.candidateTweets([
      { decision: 'shown', source: 'model', prediction: 'signal', tweetId: '1', text: 'short', ts: recent, author: 'a' },
      { decision: 'shown', source: 'model', prediction: 'signal', tweetId: '1', text: 'longer current text', ts: recent + 1, author: 'a' },
      { kind: 'read', tweetId: '1', dwellMs: 1200, ts: recent + 2 },
      { decision: 'hidden', source: 'model', prediction: 'noise', tweetId: '2', text: 'ignore', ts: recent },
      { decision: 'shown', source: 'prefilter:safe', prediction: 'signal', tweetId: '3', text: 'ignore', ts: recent },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '1', text: 'longer current text', maxDwellMs: 1200 });
  });
});
