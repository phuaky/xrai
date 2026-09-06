import { describe, it, expect } from 'bun:test';
import { loadYoutubePrefilter } from '../benchmarks/load-extension.js';

describe('YtraiPrefilter balanced decisions', () => {
  const prefilter = loadYoutubePrefilter();

  it('keeps deliberate formats and recurring interests immediately', () => {
    expect(prefilter.prefilter({ title: '8 hour GitHub outage. A postmortem.', channel: '' }))
      .toMatchObject({ category: 'useful' });
    expect(prefilter.prefilter({ title: 'The Ugly Truth About Hand Grinders!', channel: '' }))
      .toMatchObject({ category: 'useful' });
    expect(prefilter.prefilter({ title: 'The Fruit that BROKE Conor McGregor', channel: 'Fight Films by Patrick Gavia' }))
      .toMatchObject({ category: 'useful' });
  });

  it('blurs only explicit low-context patterns immediately', () => {
    for (const title of [
      'No Way Unc Did That',
      'Dune: Part Three - Official Trailer',
      'Reacting to the Worst Reviewed Restaurant in My City',
      'Joe Rogan LOSES IT Breaking Down Training',
    ]) {
      expect(prefilter.prefilter({ title, channel: '' }))
        .toMatchObject({ category: 'distraction', reason: 'clear-distraction' });
    }
  });

  it('leaves ambiguous interest clips for the model', () => {
    expect(prefilter.prefilter({ title: 'Makhachev Fears grappling with Morales', channel: '' }))
      .toBeNull();
    expect(prefilter.prefilter({ title: 'Khabib tells Abubakar how to iron a shirt', channel: '' }))
      .toBeNull();
  });
});
