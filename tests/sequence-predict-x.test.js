import { describe, it, expect } from 'bun:test';
import {
  cosine,
  ledgerKnownState,
  retrievePriorContexts,
} from '../benchmarks/predict-memory-sequences-x.js';
import { loadMemoryPass } from '../benchmarks/load-extension.js';

describe('sequence prediction inputs', () => {
  it('derives known state only from direct-open and dwell evidence', () => {
    expect(ledgerKnownState({ exposureState: 'direct-open', dwellMs: 0 })).toBe('strong');
    expect(ledgerKnownState({ exposureState: 'read', dwellMs: 1000 })).toBe('strong');
    expect(ledgerKnownState({ exposureState: 'read', dwellMs: 999 })).toBe('weak');
    expect(ledgerKnownState({ exposureState: 'shown-unread', dwellMs: 0 })).toBe('weak');
    expect(ledgerKnownState({ exposureState: 'hidden-unread', dwellMs: 0 })).toBe('unknown');
  });

  it('retrieves only prior items, ordered by similarity and capped at five', () => {
    const steps = Array.from({ length: 7 }, (_, index) => ({
      id: String(index + 1),
      text: `step ${index + 1}`,
      author: null,
      truncated: false,
      exposureState: index === 0 ? 'direct-open' : 'shown-unread',
      dwellMs: 0,
    }));
    const vectors = new Map([
      ['1', [1, 0]],
      ['2', [0.9, 0.1]],
      ['3', [0.8, 0.2]],
      ['4', [0.7, 0.3]],
      ['5', [0.6, 0.4]],
      ['6', [0, 1]],
      ['7', [1, 0]],
    ]);

    const contexts = retrievePriorContexts(steps, 6, vectors, 5);
    expect(contexts.map((context) => context.tweetId)).toEqual(['1', '2', '3', '4', '5']);
    expect(contexts[0].knownState).toBe('strong');
    expect(contexts.every((context, index) => index === 0 ||
      context.similarity <= contexts[index - 1].similarity)).toBe(true);
    expect(contexts.some((context) => context.tweetId === '6')).toBe(false);
  });

  it('uses the production deterministic policy for predictions', () => {
    const policy = loadMemoryPass().decide({
      importance: 'normal',
      novelty: 'repeat',
      funnelRisk: false,
      standaloneValue: true,
      confidence: 0.9,
      reason: 'Same claim',
    }, [{ knownState: 'strong' }], 0.75);

    expect(policy.action).toBe('collapse');
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
});
