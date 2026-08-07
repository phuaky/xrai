import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const source = readFileSync(join(root, 'extension/content/x/memorypass.js'), 'utf8');

function loadPass(options = {}) {
  const events = [];
  const messages = [];
  const chrome = {
    runtime: {
      id: 'memory-pass-test',
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(message);
        callback(options.response || {
          importance: 'normal',
          novelty: 'repeat',
          funnelRisk: false,
          standaloneValue: true,
          confidence: 0.9,
          reason: 'Already established',
          _ms: 20,
        });
      },
    },
  };
  const RaiKnowledge = {
    searchWithStatus: options.searchWithStatus || (async () => ({ ok: true, records: options.contexts || [] })),
    recordReadDwell: options.recordReadDwell || (() => Promise.resolve()),
  };
  const RaiMemory = {
    logEvent: (event) => events.push(event),
    mirrorEvent() {},
  };
  const RaiDwell = {
    getActiveElapsed: () => options.activeDwellMs || 0,
  };
  const pass = new Function(
    'chrome', 'RaiKnowledge', 'RaiMemory', 'RaiDwell',
    source + '\nreturn XraiMemoryPass;'
  )(chrome, RaiKnowledge, RaiMemory, RaiDwell);
  return { pass, events, messages };
}

function verdict(overrides = {}) {
  return Object.assign({
    importance: 'normal',
    novelty: 'repeat',
    funnelRisk: false,
    standaloneValue: true,
    confidence: 0.9,
    reason: 'Already established',
  }, overrides);
}

const strong = [{ tweetId: 'old', knownState: 'strong', similarity: 0.9 }];
const weak = [{ tweetId: 'old', knownState: 'weak', similarity: 0.9 }];

describe('XraiMemoryPass model contract', () => {
  it('accepts only the bounded contextual fields and rejects policy fields', () => {
    const { pass } = loadPass();
    expect(pass.validateVerdict(verdict())).toEqual(verdict());
    expect(pass.validateVerdict(verdict({ action: 'collapse' }))).toBeNull();
    expect(pass.validateVerdict(verdict({ knownState: 'strong' }))).toBeNull();
    expect(pass.validateVerdict(verdict({ novelty: 'familiar' }))).toBeNull();
    expect(pass.validateVerdict(verdict({ confidence: 1.1 }))).toBeNull();
    expect(pass.validateVerdict(verdict({ reason: '' }))).toBeNull();
  });

  it('caps the reason stored from the model', () => {
    const { pass } = loadPass();
    expect(pass.validateVerdict(verdict({ reason: 'x'.repeat(200) })).reason).toHaveLength(120);
  });
});

describe('XraiMemoryPass deterministic policy', () => {
  it('always shows critical content, new signals, and meaningful updates', () => {
    const { pass } = loadPass();
    expect(pass.decide(verdict({ importance: 'critical' }), strong, 0.75).action).toBe('show');
    expect(pass.decide(verdict({ novelty: 'new-signal', funnelRisk: true, standaloneValue: false }), strong, 0.75).action).toBe('show');
    expect(pass.decide(verdict({ novelty: 'meaningful-update', funnelRisk: true, standaloneValue: false }), strong, 0.75).action).toBe('show');
  });

  it('collapses only confident strong-known repeats and reinforcements', () => {
    const { pass } = loadPass();
    expect(pass.decide(verdict({ novelty: 'repeat' }), strong, 0.75)).toMatchObject({ action: 'collapse', label: 'familiar repeat' });
    expect(pass.decide(verdict({ novelty: 'reinforcement' }), strong, 0.75)).toMatchObject({ action: 'collapse', label: 'familiar reinforcement' });
    expect(pass.decide(verdict({ novelty: 'repeat' }), weak, 0.75).action).toBe('show');
    expect(pass.decide(verdict({ novelty: 'reinforcement', confidence: 0.74 }), strong, 0.75).action).toBe('show');
  });

  it('collapses confident value-free funnels but not standalone CTAs', () => {
    const { pass } = loadPass();
    expect(pass.decide(verdict({ funnelRisk: true, standaloneValue: false }), weak, 0.75)).toMatchObject({
      action: 'collapse',
      label: 'value-free funnel',
    });
    expect(pass.decide(verdict({ funnelRisk: true, standaloneValue: true }), weak, 0.75).action).toBe('show');
  });
});

describe('XraiMemoryPass orchestration', () => {
  it('retrieves no more than five records and logs complete observability', async () => {
    const contexts = Array.from({ length: 7 }, (_, index) => ({
      tweetId: index === 0 ? 'current' : 'ctx-' + index,
      text: 'Earlier claim ' + index,
      author: 'a' + index,
      knownState: index === 1 ? 'strong' : 'weak',
      similarity: 1 - index / 10,
    }));
    const { pass, messages, events } = loadPass({ contexts });
    const result = await pass.run({ id: 'current', text: 'Current claim', threshold: 0.75, model: 'prod' });

    expect(result.action).toBe('collapse');
    expect(messages).toHaveLength(1);
    expect(messages[0].contexts).toHaveLength(5);
    expect(messages[0].contexts.every((context) => context.tweetId !== 'current')).toBe(true);
    expect(events[0]).toMatchObject({
      kind: 'memory-decision',
      tweetId: 'current',
      novelty: 'repeat',
      finalAction: 'collapse',
      actionCause: 'repeat',
      model: 'prod',
      failure: null,
    });
    expect(events[0].retrievedTweetIds).toHaveLength(5);
    expect(Number.isFinite(events[0].totalMs)).toBe(true);
  });

  it('fails open without calling the model when retrieval fails', async () => {
    const { pass, messages, events } = loadPass({
      searchWithStatus: async () => ({ ok: false, records: [], error: 'embed down' }),
    });
    const result = await pass.run({ id: 'current', text: 'Current claim' });

    expect(result).toMatchObject({ action: 'show', failure: 'retrieval-failed' });
    expect(messages).toHaveLength(0);
    expect(events[0]).toMatchObject({ finalAction: 'show', failure: 'retrieval-failed' });
  });

  it('fails open on invalid model output', async () => {
    const { pass, events } = loadPass({ contexts: strong, response: { novelty: 'repeat' } });
    const result = await pass.run({ id: 'current', text: 'Current claim' });
    expect(result).toMatchObject({ action: 'show', failure: 'invalid-model-output' });
    expect(events[0].finalAction).toBe('show');
  });

  it('suppresses a late collapse after one second of active dwell', async () => {
    let strengthened = null;
    const { pass, events } = loadPass({
      contexts: strong,
      activeDwellMs: 1_000,
      recordReadDwell: (id, ms) => { strengthened = { id, ms }; return Promise.resolve(); },
    });
    const result = await pass.run({ id: 'current', text: 'Current claim' });

    expect(result).toMatchObject({ action: 'show', cause: 'active-dwell-suppressed', activeDwellMs: 1_000 });
    expect(strengthened).toEqual({ id: 'current', ms: 1_000 });
    expect(events[0]).toMatchObject({ finalAction: 'show', actionCause: 'active-dwell-suppressed' });
  });
});
