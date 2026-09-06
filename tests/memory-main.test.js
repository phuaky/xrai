import { describe, it, expect, beforeEach } from 'bun:test';
import { bootXMain as boot } from './helpers/x-main.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  window.happyDOM.setURL('https://x.com/home');
});

describe('X stage-2 integration', () => {
  it('starts memory work only after a kept tweet is revealed', async () => {
    const ctx = boot();
    ctx.emit();
    expect(ctx.memoryCalls).toHaveLength(0);
    expect(ctx.order.slice(0, 3)).toEqual(['pending', 'revealed', 'keep-label']);

    await tick();
    expect(ctx.memoryCalls).toHaveLength(1);
    expect(ctx.order.indexOf('memory-start')).toBeGreaterThan(ctx.order.indexOf('revealed'));
    expect(ctx.memoryCalls[0]).toMatchObject({
      id: 'tweet-1', text: 'A concrete AI release', threshold: 0.75,
      model: 'production-x', stage1Source: 'model',
    });
  });

  it('never invokes memory on a stage-1 hidden verdict', async () => {
    const ctx = boot({ stage1Result: { prediction: 'noise', confidence: 0.9, source: 'model' } });
    ctx.emit();
    await tick();
    expect(ctx.memoryCalls).toHaveLength(0);
    expect(ctx.order).toContain('hidden');
  });

  it('bypasses every stage-2 operation when memory-aware filtering is off', async () => {
    const ctx = boot({ memoryAware: false });
    ctx.emit();
    await tick();
    expect(ctx.memoryCalls).toHaveLength(0);

    ctx.updateConfig({ memoryAware: true });
    ctx.emit({ id: 'tweet-2', text: 'Another release' });
    await tick();
    expect(ctx.memoryCalls).toHaveLength(1);
  });

  it('applies only a post-reveal reversible collapse request', async () => {
    const ctx = boot({ requestCollapse: true });
    const element = ctx.emit();
    await tick();
    expect(ctx.order.indexOf('collapsed:familiar repeat')).toBeGreaterThan(ctx.order.indexOf('revealed'));
    expect(typeof element._revealMemory).toBe('function');
    element._revealMemory();
    expect(ctx.events).toContainEqual(expect.objectContaining({
      kind: 'memory-reveal', tweetId: 'tweet-1', novelty: 'repeat', label: 'familiar repeat',
    }));
  });
});
