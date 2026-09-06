import { describe, it, expect } from 'bun:test';
import replay from '../benchmarks/replay-memory-errors-x.js';

describe('focused memory error replay', () => {
  it('selects each prior sequence miss by the canonical gate definition', () => {
    const step = {
      importance: 'critical',
      novelty: 'meaningful-update',
      funnelRisk: false,
      standaloneValue: true,
      hasStrongKnownPrior: true,
    };
    expect(replay.categories(step, { action: 'collapse' })).toEqual(['critical', 'novelty']);
    expect(replay.expectedAction('critical')).toBe('show');
    expect(replay.expectedAction('familiar')).toBe('collapse');
  });
});
