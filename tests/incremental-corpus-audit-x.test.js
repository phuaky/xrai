import { describe, it, expect } from 'bun:test';
import incremental from '../benchmarks/incremental-corpus-audit-x.js';

function corpus(id, overrides = {}) {
  return Object.assign({
    id, text: `claim ${id}`, author: 'author', media: 'text', decision: 'shown',
    source: 'model', timestamp: Number(id), dwellMs: 0,
    exposureState: 'shown-unread', truncated: false,
  }, overrides);
}

function verdict(id, reason = 'judged') {
  return {
    id, importance: 'normal', topic: `topic ${id}`, contentType: 'post',
    claimCluster: `claim-${id}`, novelty: 'new-signal', funnelRisk: false,
    standaloneValue: true, confidence: 0.9, reason,
  };
}

describe('incremental corpus audit', () => {
  it('selects new and byte-changed rows while reusing only identical rows', () => {
    const baseline = [corpus('1'), corpus('2')];
    const current = [corpus('1'), corpus('2', { text: 'fuller claim 2' }), corpus('3')];
    const diff = incremental.diffCorpus(current, baseline);
    expect(diff.rows.map((row) => row.id)).toEqual(['2', '3']);
    expect(diff.newIds).toEqual(['3']);
    expect(diff.changedIds).toEqual(['2']);
    expect(diff.unchangedIds).toEqual(['1']);
  });

  it('merges validated incremental verdicts over the frozen baseline in current order', () => {
    const baselineCorpus = [corpus('1'), corpus('2')];
    const currentCorpus = [corpus('1'), corpus('2', { dwellMs: 1200 }), corpus('3')];
    const baselineVerdicts = [verdict('1', 'old one'), verdict('2', 'stale two')];
    const incrementalCorpus = [currentCorpus[1], currentCorpus[2]];
    const incrementalVerdicts = [verdict('2', 'fresh two'), verdict('3', 'new three')];
    const merged = incremental.mergeVerdicts(
      currentCorpus, baselineCorpus, baselineVerdicts, incrementalCorpus, incrementalVerdicts,
    );
    expect(merged.map((row) => row.reason)).toEqual(['old one', 'fresh two', 'new three']);
  });

  it('parses only strict named options', () => {
    expect(incremental.parseArgs(['prepare', '--batch-size=50'])).toEqual({
      command: 'prepare', options: { 'batch-size': '50' },
    });
    expect(() => incremental.parseArgs(['prepare', '--wat=1'])).toThrow('Unknown or empty option');
    expect(() => incremental.parseArgs(['unknown'])).toThrow('Expected command');
  });
});
