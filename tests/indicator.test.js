// Smoke tests for the status pill + today-first panel (core/indicator.js).
// Loads the real source with stubbed chrome/RaiConfig/RaiMemory (same trick as
// benchmarks/load-extension.js) and drives it through happy-dom.
import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(import.meta.dir, '../extension/content/core/indicator.js'), 'utf8');

const STATS = {
  total: 23447, kept: 12684, hidden: 10763,
  today: { date: '2026-07-17', total: 312, kept: 143, hidden: 169 }
};

function makeIndicator(opts = {}) {
  const saved = [];
  let cleared = false;
  let seeded = null;
  const config = Object.assign({
    mode: 'local', model: 'test-model', confidenceThreshold: 0.7,
    contentFilter: 'posts-only', imageBaitEnabled: true, hopNudge: true,
    memoryAware: true, memoryConfidenceThreshold: 0.75,
    hideMethod: 'remove', cloudApiKey: ''
  }, opts.config);

  const RaiConfig = {
    getConfig: () => Promise.resolve(Object.assign({}, config)),
    saveConfig: (platform, partial) => {
      saved.push(partial);
      Object.assign(config, partial);
      return Promise.resolve(Object.assign({}, config));
    }
  };
  const RaiMemory = {
    getStats: () => Promise.resolve(opts.stats || STATS),
    onStatsChanged: () => {},
    getDailyTime: () => Promise.resolve(3780), // 63 min -> "1h 3m"
    clearAll: () => { cleared = true; return Promise.resolve(); },
    getEvents: () => Promise.resolve(opts.events || [])
  };
  const RaiKnowledge = {
    exportData: () => Promise.resolve({ claims: opts.claims || [] }),
    importSeed: (events) => {
      seeded = events;
      return Promise.resolve({ embedded: events.length, pending: 0 });
    }
  };
  const chrome = { runtime: {} }; // no .id -> listModels/balance paths skipped

  const RaiIndicator = new Function(
    'chrome', 'RaiConfig', 'RaiMemory', 'RaiKnowledge',
    src + '\nreturn RaiIndicator;'
  )(chrome, RaiConfig, RaiMemory, RaiKnowledge);

  return { RaiIndicator, saved, isCleared: () => cleared, seeded: () => seeded };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function initHealthy(opts) {
  const ctx = makeIndicator(opts);
  ctx.RaiIndicator.init('x', { name: 'xrai', keptWord: 'shown', hiddenWord: 'hidden', siteWord: 'X' });
  await tick();
  ctx.RaiIndicator.update(null, { connected: true, classify: true });
  return ctx;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('pill', () => {
  it("shows TODAY's hidden count, quiet while idle", async () => {
    await initHealthy();
    const pill = document.getElementById('xrai-pill');
    expect(pill.querySelector('.xrai-pill-count').textContent).toBe('169');
    expect(pill.querySelector('.xrai-pill-label').textContent).toBe('hidden today');
    expect(pill.querySelector('.xrai-dot').className).toContain('xrai-dot-green');
    expect(pill.classList.contains('xrai-pill-quiet')).toBe(true);
  });

  it('pulses while a classifier is busy, settles when the queue drains', async () => {
    const { RaiIndicator } = await initHealthy();
    const pill = document.getElementById('xrai-pill');

    RaiIndicator.setActivity('text', { current: { id: '1', text: 'hello', author: 'swyx' }, active: 1, queued: 2 });
    expect(pill.querySelector('.xrai-dot').className).toContain('xrai-dot-pulse');
    expect(pill.classList.contains('xrai-pill-quiet')).toBe(false);

    RaiIndicator.setActivity('text', { current: null, active: 0, queued: 0 });
    expect(pill.querySelector('.xrai-dot').className).not.toContain('xrai-dot-pulse');
    expect(pill.classList.contains('xrai-pill-quiet')).toBe(true);
  });

  it('shows offline state instead of counts when Ollama is down', async () => {
    const { RaiIndicator } = await initHealthy();
    RaiIndicator.update(null, { connected: false, classify: false });
    const pill = document.getElementById('xrai-pill');
    expect(pill.querySelector('.xrai-pill-count').textContent).toBe('');
    expect(pill.querySelector('.xrai-pill-label').textContent).toBe('ollama offline');
    expect(pill.querySelector('.xrai-dot').className).toContain('xrai-dot-red');
  });

  it('increment bumps the today count immediately (bridge before worker write)', async () => {
    const { RaiIndicator } = await initHealthy();
    RaiIndicator.incrementHidden();
    expect(document.querySelector('.xrai-pill-count').textContent).toBe('170');
  });
});

describe('panel — today view', () => {
  it('hero = processed today, rows, time, all-time footer', async () => {
    await initHealthy();
    document.getElementById('xrai-pill').click();
    await tick();

    const panel = document.getElementById('xrai-settings');
    expect(panel.querySelector('#xrai-p-hero').textContent).toBe((312).toLocaleString());
    expect(panel.querySelector('#xrai-p-kept').textContent).toBe((143).toLocaleString());
    expect(panel.querySelector('#xrai-p-hid').textContent).toBe((169).toLocaleString());
    expect(panel.querySelector('#xrai-p-time').textContent).toBe('1h 3m');
    expect(panel.querySelector('#xrai-p-life').textContent).toBe((23447).toLocaleString() + ' all-time');
    expect(panel.querySelector('#xrai-p-stat').textContent).toBe('idle');
  });

  it('live "checking" line appears only while busy and names the tweet', async () => {
    const { RaiIndicator } = await initHealthy();
    document.getElementById('xrai-pill').click();
    await tick();

    const panel = document.getElementById('xrai-settings');
    expect(panel.querySelector('#xrai-p-live').style.display).toBe('none');

    RaiIndicator.setActivity('text', {
      current: { id: '9', text: 'claude code subagents are the biggest unlock', author: 'swyx' },
      active: 1, queued: 2
    });
    expect(panel.querySelector('#xrai-p-live').style.display).toBe('block');
    expect(panel.querySelector('#xrai-p-cur').textContent).toContain('@swyx');
    expect(panel.querySelector('#xrai-p-q').textContent).toBe('2');
    expect(panel.querySelector('#xrai-p-stat').textContent).toBe('filtering');
  });
});

describe('panel — settings view', () => {
  async function openSettings(ctx) {
    document.getElementById('xrai-pill').click();
    await tick();
    document.getElementById('xrai-p-goset').click();
    await tick();
    return document.getElementById('xrai-settings');
  }

  it('every control auto-saves on change (no Save button)', async () => {
    const ctx = await initHealthy();
    const panel = await openSettings(ctx);
    expect(panel.querySelector('#xrai-s-save')).toBe(null);

    const hide = panel.querySelector('#xrai-s-hide');
    hide.value = 'blur';
    hide.dispatchEvent(new Event('change'));
    await tick();
    expect(ctx.saved).toContainEqual({ hideMethod: 'blur' });

    const bait = panel.querySelector('#xrai-s-image-bait');
    bait.checked = false;
    bait.dispatchEvent(new Event('change'));
    await tick();
    expect(ctx.saved).toContainEqual({ imageBaitEnabled: false });

    const memoryAware = panel.querySelector('#xrai-s-memory-aware');
    memoryAware.checked = false;
    memoryAware.dispatchEvent(new Event('change'));
    const memoryThreshold = panel.querySelector('#xrai-s-memory-threshold');
    memoryThreshold.value = '0.85';
    memoryThreshold.dispatchEvent(new Event('change'));
    await tick();
    expect(ctx.saved).toContainEqual({ memoryAware: false });
    expect(ctx.saved).toContainEqual({ memoryConfidenceThreshold: 0.85 });
  });

  it('clear memory requires a second confirming click', async () => {
    const ctx = await initHealthy();
    const panel = await openSettings(ctx);
    const clear = panel.querySelector('#xrai-s-clear');

    clear.click();
    expect(ctx.isCleared()).toBe(false);
    expect(clear.textContent).toBe('sure? click again');

    clear.click();
    await tick();
    expect(ctx.isCleared()).toBe(true);
  });

  it('seeds X claim history from the durable local event log without Luna', async () => {
    const events = [{ platform: 'x', tweetId: 't1', text: 'claim', decision: 'shown' }];
    const ctx = await initHealthy({ events });
    const panel = await openSettings(ctx);
    const seed = panel.querySelector('#xrai-s-seed-memory');
    expect(seed).not.toBe(null);
    seed.click();
    await tick();
    await tick();
    expect(ctx.seeded()).toEqual(events);
    expect(seed.textContent).toBe('1 claims ready');
  });

  it('back returns to the today view (and does not close the panel)', async () => {
    const ctx = await initHealthy();
    const panel = await openSettings(ctx);
    // Let the outside-click document handler attach (100ms after open) —
    // "back" re-renders the panel synchronously, detaching the clicked link
    // mid-bubble; a detached target must not read as an outside click.
    await new Promise((r) => setTimeout(r, 120));
    panel.querySelector('#xrai-s-back').click();
    await tick();
    expect(document.getElementById('xrai-settings')).not.toBe(null);
    expect(panel.querySelector('#xrai-p-hero')).not.toBe(null);
  });
});
