import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { indexedDB as fakeIndexedDB, IDBKeyRange } from 'fake-indexeddb';

const root = join(import.meta.dir, '..');
const knowledgeSrc = readFileSync(join(root, 'extension/lib/knowledge.js'), 'utf8');
const memorySrc = readFileSync(join(root, 'extension/lib/memory.js'), 'utf8');
const mainSrc = readFileSync(join(root, 'extension/content/x/main.js'), 'utf8');
const workerSrc = readFileSync(join(root, 'extension/background/worker.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));

let dbSeq = 0;

function chromeStub(sendMessage) {
  const storage = Object.create(null);
  return {
    runtime: {
      id: 'knowledge-test',
      lastError: undefined,
      sendMessage: sendMessage || ((msg, cb) => cb({ embedding: [1, 0], model: msg.model, version: 1 })),
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (storage[key] !== undefined) out[key] = storage[key];
          cb(out);
        },
        set: (values, cb) => { Object.assign(storage, values); if (cb) cb(); },
        remove: (keys, cb) => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key];
          if (cb) cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };
}

function loadKnowledge(options = {}) {
  const chrome = options.chrome || chromeStub(options.sendMessage);
  const loaded = new Function(
    'indexedDB', 'IDBKeyRange', 'chrome',
    knowledgeSrc + '\nreturn { RaiKnowledge: RaiKnowledge, LocalSemanticIndex: LocalSemanticIndex };'
  )(fakeIndexedDB, IDBKeyRange, chrome);
  loaded.RaiKnowledge.configure({
    dbName: 'xrai_knowledge_test_' + (++dbSeq),
    embeddingModel: options.embeddingModel || 'test-embed:1',
    embeddingVersion: options.embeddingVersion || 7,
    embed: options.embed,
  });
  return loaded;
}

function feed(overrides = {}) {
  return Object.assign({
    tweetId: 't1',
    text: 'A concrete claim about agent reliability',
    author: 'kuan',
    decision: 'shown',
    prediction: 'signal',
    source: 'model',
    confidence: 0.91,
    model: 'stage-one-model',
    reason: 'specific evidence',
    ts: 1_000,
  }, overrides);
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.happyDOM.setURL('https://x.com/home');
});

describe('LocalSemanticIndex', () => {
  it('normalizes vectors and returns a deterministic top five with known state', () => {
    const { LocalSemanticIndex } = loadKnowledge();
    expect(LocalSemanticIndex.normalize([3, 4])).toEqual([0.6, 0.8]);

    const records = Array.from({ length: 7 }, (_, i) => ({
      tweetId: 't' + i,
      embedding: LocalSemanticIndex.normalize([7 - i, i]),
      exposureState: i === 0 ? 'hidden' : 'shown',
      directOpenedAt: i === 1 ? 50 : 0,
      maxDwellMs: i === 2 ? 1_000 : 0,
      updatedAt: 100 - i,
    }));
    const results = LocalSemanticIndex.search(records, [1, 0], 99);

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.tweetId)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(results.map((r) => r.knownState)).toEqual(['unknown', 'strong', 'strong', 'weak', 'weak']);
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
  });
});

describe('RaiKnowledge retrieval status', () => {
  it('distinguishes a valid empty result from an embedding failure', async () => {
    const healthy = loadKnowledge({ embed: async () => [1, 0] }).RaiKnowledge;
    expect(await healthy.searchWithStatus('unseen claim', 5)).toEqual({ ok: true, records: [] });

    const broken = loadKnowledge({ embed: async () => { throw new Error('embed down'); } }).RaiKnowledge;
    expect(await broken.searchWithStatus('unseen claim', 5)).toMatchObject({
      ok: false,
      records: [],
      error: 'embed down',
    });
    expect(await broken.search('unseen claim', 5)).toEqual([]);
  });
});

describe('RaiKnowledge exposure ledger', () => {
  it('stores every non-empty shown/hidden feed decision with local embedding metadata', async () => {
    const { RaiKnowledge } = loadKnowledge({ embed: async () => [3, 4] });
    await RaiKnowledge.recordFeedDecision(feed());
    await RaiKnowledge.recordFeedDecision(feed({ tweetId: 't2', decision: 'hidden', prediction: 'noise' }));
    await RaiKnowledge.recordFeedDecision(feed({ tweetId: 'empty', text: '   ' }));

    const shown = await RaiKnowledge.get('t1');
    const hidden = await RaiKnowledge.get('t2');
    expect(shown).toMatchObject({
      text: 'A concrete claim about agent reliability',
      decision: 'shown', source: 'model', exposureState: 'shown', knownState: 'weak',
      embedding: [0.6, 0.8], embeddingModel: 'test-embed:1', embeddingVersion: 7,
    });
    expect(shown.textHash).toBeTruthy();
    expect(hidden).toMatchObject({ exposureState: 'hidden', knownState: 'unknown' });
    expect(await RaiKnowledge.get('empty')).toBeUndefined();
  });

  it('upserts one record per tweet and only ledger evidence can strengthen knownState', async () => {
    const { RaiKnowledge } = loadKnowledge({ embed: async () => [1, 0] });
    await RaiKnowledge.recordFeedDecision(feed({ decision: 'hidden', prediction: 'noise' }));
    await RaiKnowledge.recordFeedDecision(feed({ decision: 'shown', ts: 2_000 }));
    expect(await RaiKnowledge.count()).toBe(1);
    expect(await RaiKnowledge.get('t1')).toMatchObject({ exposureState: 'shown', knownState: 'weak' });

    await RaiKnowledge.recordReadDwell('t1', 999, { timestamp: 3_000 });
    expect((await RaiKnowledge.get('t1')).knownState).toBe('weak');
    await RaiKnowledge.recordReadDwell('t1', 1_000, { timestamp: 4_000 });
    expect((await RaiKnowledge.get('t1')).knownState).toBe('strong');
  });

  it('a later direct status-page open strengthens hidden and preserves full available text', async () => {
    const { RaiKnowledge } = loadKnowledge({ embed: async (text) => text.includes('full') ? [0, 2] : [1, 0] });
    await RaiKnowledge.recordFeedDecision(feed({ decision: 'hidden', prediction: 'noise', text: 'short text' }));
    await RaiKnowledge.recordDirectOpen({
      tweetId: 't1', text: 'full expanded direct-open text', author: 'kuan', timestamp: 5_000,
    });

    expect(await RaiKnowledge.get('t1')).toMatchObject({
      text: 'full expanded direct-open text', exposureState: 'direct-open', knownState: 'strong',
      directOpenedAt: 5_000, embedding: [0, 1],
    });
    expect(await RaiKnowledge.count()).toBe(1);
  });

  it('fails open when local embeddings are unavailable but retains the claim', async () => {
    const { RaiKnowledge } = loadKnowledge({ embed: async () => { throw new Error('model absent'); } });
    await expect(RaiKnowledge.recordFeedDecision(feed())).resolves.toBeDefined();
    const record = await RaiKnowledge.get('t1');
    expect(record.text).toContain('agent reliability');
    expect(record.embedding).toBeUndefined();
    expect(record.embeddingError).toContain('model absent');
  });

  it('deduplicates concurrent embedding work for the same claim version', async () => {
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { RaiKnowledge } = loadKnowledge({
      embed: async () => { calls++; await pending; return [1, 0]; },
    });
    const first = RaiKnowledge.recordFeedDecision(feed());
    const second = RaiKnowledge.recordFeedDecision(feed({ ts: 2_000 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(await RaiKnowledge.get('t1')).toMatchObject({
      embedding: [1, 0], embeddingModel: 'test-embed:1', embeddingVersion: 7,
    });
  });
});

describe('retrieval, retention, clear, and export', () => {
  it('embeds a query and retrieves at most five records in descending cosine order', async () => {
    const vectors = {
      query: [1, 0], alpha: [1, 0], beta: [0.8, 0.2], gamma: [0, 1],
      delta: [0.7, 0.3], epsilon: [0.6, 0.4], zeta: [0.5, 0.5],
    };
    const { RaiKnowledge } = loadKnowledge({ embed: async (text) => vectors[text] });
    for (const text of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      await RaiKnowledge.recordFeedDecision(feed({ tweetId: text, text, ts: Date.now() }));
    }
    await RaiKnowledge.recordReadDwell('beta', 1_000);

    const results = await RaiKnowledge.search('query', 50);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.tweetId)).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'zeta']);
    expect(results.find((r) => r.tweetId === 'beta').knownState).toBe('strong');
  });

  it('prunes by age first, then keeps only the newest configured count', async () => {
    const now = 400 * 86_400_000;
    const { RaiKnowledge } = loadKnowledge({ embed: async () => [1, 0] });
    await RaiKnowledge.recordFeedDecision(feed({ tweetId: 'old', ts: now - 366 * 86_400_000 }));
    for (let i = 0; i < 5; i++) {
      await RaiKnowledge.recordFeedDecision(feed({ tweetId: 'new-' + i, ts: now - i * 1_000 }));
    }

    const result = await RaiKnowledge.pruneRetention({ now, maxAgeDays: 365, maxRecords: 3 });
    expect(result.removedByAge).toBe(1);
    expect(result.removedByCount).toBe(2);
    expect((await RaiKnowledge.getAll()).map((r) => r.tweetId).sort()).toEqual(['new-0', 'new-1', 'new-2']);
  });

  it('exports claim text/classification/exposure/embedding version without a collector', async () => {
    const { RaiKnowledge } = loadKnowledge({ embed: async () => [1, 0] });
    await RaiKnowledge.recordFeedDecision(feed());
    const out = await RaiKnowledge.exportData();
    expect(out.platform).toBe('x');
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({
      tweetId: 't1', text: 'A concrete claim about agent reliability',
      prediction: 'signal', decision: 'shown', source: 'model',
      exposureState: 'shown', embeddingModel: 'test-embed:1', embeddingVersion: 7,
    });
  });

  it('RaiMemory.clearAll clears fingerprints and knowledge but preserves append-only events', async () => {
    const chrome = chromeStub();
    const loaded = new Function(
      'indexedDB', 'IDBKeyRange', 'chrome',
      memorySrc + '\n' + knowledgeSrc + '\nreturn { RaiMemory: RaiMemory, RaiKnowledge: RaiKnowledge };'
    )(fakeIndexedDB, IDBKeyRange, chrome);
    loaded.RaiKnowledge.configure({ dbName: 'xrai_knowledge_test_' + (++dbSeq), embed: async () => [1, 0] });
    await loaded.RaiMemory.init('x');
    await loaded.RaiKnowledge.init();
    await loaded.RaiMemory.markSeen('fp', 'signal');
    await loaded.RaiMemory.logEvent({ platform: 'x', tweetId: 'source-event', text: 'append only' });
    await loaded.RaiKnowledge.recordFeedDecision(feed());

    await loaded.RaiMemory.clearAll();
    expect(await loaded.RaiMemory.hasSeen('fp')).toBe(false);
    expect(await loaded.RaiMemory.countEvents()).toBe(1);
    expect(await loaded.RaiKnowledge.count()).toBe(0);
  });
});

describe('local seed import', () => {
  const events = [
    feed({ tweetId: 'shown', text: 'shown claim', ts: 1_000 }),
    feed({ tweetId: 'hidden', text: 'hidden claim', decision: 'hidden', prediction: 'noise', ts: 1_100 }),
    { platform: 'x', kind: 'read', tweetId: 'shown', dwellMs: 1_200, decision: 'shown', source: 'model', ts: 1_500 },
    feed({ tweetId: 'shown', text: 'newest shown claim', ts: 2_000 }),
    feed({ tweetId: 'blank', text: '', ts: 3_000 }),
    { platform: 'youtube', decision: 'shown', tweetId: 'yt', text: 'ignore', ts: 4_000 },
  ];

  it('pure preparation deduplicates feed decisions and derives exposure from ledger events', () => {
    const { RaiKnowledge } = loadKnowledge();
    const prepared = RaiKnowledge.prepareSeedRecords(events);
    expect(prepared.map((r) => r.tweetId).sort()).toEqual(['hidden', 'shown']);
    expect(prepared.find((r) => r.tweetId === 'shown')).toMatchObject({
      text: 'newest shown claim', exposureState: 'shown', knownState: 'strong', maxDwellMs: 1_200,
    });
    expect(prepared.find((r) => r.tweetId === 'hidden').knownState).toBe('unknown');
  });

  it('preserves shown exposure when a later duplicate decision is hidden', () => {
    const { RaiKnowledge } = loadKnowledge();
    const prepared = RaiKnowledge.prepareSeedRecords([
      feed({ tweetId: 'mixed', decision: 'shown', ts: 1_000 }),
      feed({ tweetId: 'mixed', decision: 'hidden', prediction: 'noise', ts: 2_000 }),
    ]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ exposureState: 'shown', knownState: 'weak' });
  });

  it('marks exact-cap historical seed text as truncated', () => {
    const { RaiKnowledge } = loadKnowledge();
    const prepared = RaiKnowledge.prepareSeedRecords([
      feed({ tweetId: 'capped', text: 'x'.repeat(500), ts: 1_000 }),
    ]);
    expect(prepared[0]).toMatchObject({ truncated: true, text: 'x'.repeat(500) });
  });

  it('never upgrades historical off-home route proxies to direct-open evidence', () => {
    const { RaiKnowledge } = loadKnowledge();
    const prepared = RaiKnowledge.prepareSeedRecords([
      feed({ tweetId: 'status-read', text: 'historical claim', ts: 1_000 }),
      {
        platform: 'x', kind: 'read', tweetId: 'status-read', dwellMs: 1_200,
        decision: 'reading', source: 'off-home', url: '/kuan/status/status-read', ts: 2_000,
      },
    ]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      tweetId: 'status-read', exposureState: 'shown', knownState: 'strong', maxDwellMs: 1_200,
    });
    expect(prepared[0].directOpenedAt).toBeUndefined();
  });

  it('is idempotent and never overwrites a newer live record', async () => {
    let embeddings = 0;
    const { RaiKnowledge } = loadKnowledge({ embed: async () => { embeddings++; return [1, 0]; } });
    const first = await RaiKnowledge.importSeed(events);
    expect(first).toMatchObject({ inserted: 2, updated: 0, skipped: 0 });
    const afterFirstEmbeddings = embeddings;
    const second = await RaiKnowledge.importSeed(events);
    expect(second).toMatchObject({ inserted: 0, updated: 0, skipped: 2 });
    expect(await RaiKnowledge.count()).toBe(2);
    expect(embeddings).toBe(afterFirstEmbeddings);

    await RaiKnowledge.recordFeedDecision(feed({ tweetId: 'shown', text: 'newer live full text', ts: 9_000 }));
    await RaiKnowledge.importSeed(events);
    expect((await RaiKnowledge.get('shown')).text).toBe('newer live full text');
  });

  it('continues importing other records when one embedding fails', async () => {
    const { RaiKnowledge } = loadKnowledge({
      embed: async (text) => { if (text.includes('hidden')) throw new Error('missing model'); return [1, 0]; },
    });
    const result = await RaiKnowledge.importSeed(events);
    expect(result).toMatchObject({ inserted: 2, embedded: 1, pending: 1, failed: 1 });
    expect(await RaiKnowledge.count()).toBe(2);
    expect((await RaiKnowledge.get('shown')).embedding).toEqual([1, 0]);
    expect((await RaiKnowledge.get('hidden')).embedding).toBeUndefined();
  });
});

describe('runtime integration', () => {
  it('loads knowledge after memory and before X runtime consumers', () => {
    const xBlock = manifest.content_scripts.find((block) => block.matches.some((m) => m.includes('x.com')));
    const memoryIndex = xBlock.js.indexOf('lib/knowledge.js');
    expect(memoryIndex).toBeGreaterThan(xBlock.js.indexOf('lib/memory.js'));
    expect(memoryIndex).toBeLessThan(xBlock.js.indexOf('content/core/dwell.js'));
    expect(memoryIndex).toBeLessThan(xBlock.js.indexOf('content/x/main.js'));
  });

  it('stage-1 logging queues knowledge after the source log without awaiting it', () => {
    const patched = mainSrc.replace(
      /\n  if \(document\.readyState === 'loading'\)[\s\S]*?\n  return \{ start: start \};/,
      '\n  return { start: start, _logTweet: logTweet };'
    );
    const calls = [];
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const RaiMemory = {
      logEvent: () => calls.push('event'),
      mirrorEvent: () => calls.push('mirror'),
    };
    const RaiKnowledge = {
      recordFeedDecision: () => { calls.push('knowledge'); return pending; },
    };
    const RaiDwell = { observe: () => calls.push('dwell') };
    const main = new Function(
      'RaiMemory', 'RaiKnowledge', 'RaiDwell',
      patched + '\nreturn XraiMain;'
    )(RaiMemory, RaiKnowledge, RaiDwell);

    const result = main._logTweet(document.createElement('article'), 'shown', { id: 't1', text: 'full', mediaType: 'text', author: 'kuan' }, 'full', 'signal', 0.9, 'model', {});
    expect(result).toBeUndefined();
    expect(calls).toEqual(['dwell', 'event', 'mirror', 'knowledge']);
    settle();
  });

  it('exposes claim history through the X memory export bridge', async () => {
    const patched = mainSrc.replace(
      /\n  if \(document\.readyState === 'loading'\)[\s\S]*?\n  return \{ start: start \};/,
      '\n  return { start: start };'
    );
    const RaiKnowledge = {
      exportData: () => Promise.resolve({
        schemaVersion: 1,
        platform: 'x',
        embeddingModel: 'all-minilm:latest',
        embeddingVersion: 1,
        claims: [{ tweetId: 't1', text: 'claim', exposureState: 'shown' }],
      }),
    };
    new Function(
      'RaiMemory', 'RaiKnowledge', 'RaiDwell',
      patched + '\nreturn XraiMain;'
    )({}, RaiKnowledge, {});

    const response = new Promise((resolve) => {
      window.addEventListener('xrai-memory-export-response', resolve, { once: true });
    });
    window.dispatchEvent(new CustomEvent('xrai-memory-export-request'));
    await response;
    const exported = JSON.parse(document.getElementById('xrai-memory-export-data').textContent);
    expect(exported).toMatchObject({
      platform: 'x', embeddingModel: 'all-minilm:latest',
      claims: [{ tweetId: 't1', text: 'claim', exposureState: 'shown' }],
    });
  });
});

describe('Ollama embedding adapter', () => {
  function loadWorker(chrome) {
    return new Function(
      'chrome',
      workerSrc + '\nreturn { embedLocal: embedLocal, DEFAULT_EMBEDDING_MODEL: DEFAULT_EMBEDDING_MODEL };'
    )(chrome || { runtime: { onMessage: { addListener() {} } }, storage: { local: { get() {}, set() {} } } });
  }

  it('uses /api/embed and falls back to the compatible /api/embeddings endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).endsWith('/api/embed')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ embedding: [3, 4] }) };
    };
    try {
      const worker = loadWorker();
      const result = await worker.embedLocal('claim text', worker.DEFAULT_EMBEDDING_MODEL, 'http://localhost:11434');
      expect(calls.map((c) => c.url)).toEqual([
        'http://localhost:11434/api/embed',
        'http://localhost:11434/api/embeddings',
      ]);
      expect(calls[0].body).toMatchObject({ model: 'all-minilm:latest', input: 'claim text' });
      expect(calls[1].body).toMatchObject({ model: 'all-minilm:latest', prompt: 'claim text' });
      expect(result.embedding).toEqual([3, 4]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes cloud-mode embedding messages to local Ollama and outside localTextChain', async () => {
    let listener;
    const originalFetch = globalThis.fetch;
    const urls = [];
    const chrome = {
      runtime: { onMessage: { addListener(fn) { listener = fn; } }, lastError: undefined },
      storage: {
        local: {
          get(key, cb) { cb({ xrai_config: { mode: 'cloud', ollamaUrl: 'http://local-ollama:11434' } }); },
          set(obj, cb) { if (cb) cb(); },
        },
      },
    };
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) };
    };
    try {
      loadWorker(chrome);
      const response = await new Promise((resolve) => {
        listener({ action: 'embedLocal', platform: 'x', text: 'claim' }, {}, resolve);
      });
      expect(response.embedding).toEqual([1, 0]);
      expect(urls).toContain('http://local-ollama:11434/api/embed');
      expect(urls.some((url) => url.startsWith('https://api.snratio.xyz'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
