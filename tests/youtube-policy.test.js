import { describe, it, expect } from 'bun:test';
import { loadYoutubePolicy } from '../benchmarks/load-extension.js';

describe('YtraiPolicy', () => {
  const policy = loadYoutubePolicy();

  it('keeps music, motivation, and useful recommendations', () => {
    for (const category of ['music', 'motivational', 'useful']) {
      expect(policy.decide({ category, confidence: 0.95, source: 'model' }))
        .toMatchObject({ decision: 'kept', category });
    }
  });

  it('blurs only confident distraction', () => {
    expect(policy.decide({ category: 'distraction', confidence: 0.9, source: 'model' }, { threshold: 0.6 }))
      .toMatchObject({ decision: 'blurred', cause: 'confident-distraction' });
    expect(policy.decide({ category: 'distraction', confidence: 0.59, source: 'model' }, { threshold: 0.6 }))
      .toMatchObject({ decision: 'kept', cause: 'low-confidence-distraction' });
  });

  it('honors a high-precision distraction prefilter verdict', () => {
    expect(policy.decide({
      category: 'distraction', confidence: 0.95, source: 'prefilter:clear-distraction'
    }, { threshold: 0.6 })).toMatchObject({
      decision: 'blurred', cause: 'prefilter-distraction'
    });
  });

  it('fails open for errors, missing results, and unknown labels', () => {
    expect(policy.decide(null)).toMatchObject({ decision: 'kept' });
    expect(policy.decide({ source: 'error' })).toMatchObject({ decision: 'kept' });
    expect(policy.decide({ category: 'podcast', confidence: 0.99, source: 'model' }))
      .toMatchObject({ decision: 'kept', cause: 'unknown-category' });
  });

  it('supports legacy other verdicts without weakening the confidence gate', () => {
    expect(policy.decide({ category: 'other', confidence: 0.9, source: 'model' }, { threshold: 0.6 }))
      .toMatchObject({ decision: 'blurred', category: 'distraction' });
  });

  it('respects the motivational toggle only at high confidence', () => {
    expect(policy.decide(
      { category: 'motivational', confidence: 0.9, source: 'model' },
      { keepMotivational: false, threshold: 0.6 }
    )).toMatchObject({ decision: 'blurred', cause: 'motivation-disabled' });
    expect(policy.decide(
      { category: 'motivational', confidence: 0.4, source: 'model' },
      { keepMotivational: false, threshold: 0.6 }
    )).toMatchObject({ decision: 'kept' });
    expect(policy.decide(
      { category: 'motivational', confidence: 0.85, source: 'prefilter:motivational' },
      { keepMotivational: false, threshold: 0.6 }
    )).toMatchObject({ decision: 'blurred', cause: 'motivation-disabled' });
  });
});
