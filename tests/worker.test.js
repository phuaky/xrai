import { describe, it, expect } from 'bun:test';
import { setTimeout as delay } from 'timers/promises';
import { loadWorker } from '../benchmarks/load-extension.js';

describe('local text scheduling', () => {
  it('serializes work and unloads the prior rai model on platform switches', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const calls = [];
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/ps')) {
        return {
          json: async () => ({ models: [{ name: 'gemma2:2b' }] }),
        };
      }
      const body = JSON.parse(options.body || '{}');
      calls.push({ url: String(url), body });
      return { json: async () => ({}) };
    };

    const task = (name) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push({ task: name, phase: 'start' });
      await delay(5);
      calls.push({ task: name, phase: 'end' });
      active--;
      return name;
    };

    try {
      const xModel = 'dhiltgen/gemma4:e2b-mlx-bf16';
      const ytModel = 'gemma2:2b';
      const results = await Promise.all([
        worker.scheduleLocalText(xModel, 'http://ollama.test', task('x-1')),
        worker.scheduleLocalText(xModel, 'http://ollama.test', task('x-2')),
        worker.scheduleLocalText(ytModel, 'http://ollama.test', task('yt-1')),
      ]);

      expect(results).toEqual(['x-1', 'x-2', 'yt-1']);
      expect(maxActive).toBe(1);
      expect(calls.filter((call) => call.body?.keep_alive === 0).map((call) => call.body.model))
        .toEqual([ytModel, xModel]);
      expect(calls.filter((call) => call.task).map((call) => `${call.task}:${call.phase}`))
        .toEqual([
          'x-1:start',
          'x-1:end',
          'x-2:start',
          'x-2:end',
          'yt-1:start',
          'yt-1:end',
        ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs queued stage-1 work before the post-reveal memory lane', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const order = [];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/ps')) return { json: async () => ({ models: [] }) };
      return { json: async () => ({}) };
    };

    const task = (name, wait = 0) => async () => {
      order.push(name + ':start');
      if (wait) await delay(wait);
      order.push(name + ':end');
      return name;
    };

    try {
      const model = 'dhiltgen/gemma4:e2b-mlx-bf16';
      const memory = worker.scheduleMemoryText(model, 'http://ollama.test', task('memory'));
      const stage1a = worker.scheduleLocalText(model, 'http://ollama.test', task('stage-1a', 5));
      const stage1b = worker.scheduleLocalText(model, 'http://ollama.test', task('stage-1b'));
      expect(await Promise.all([memory, stage1a, stage1b])).toEqual(['memory', 'stage-1a', 'stage-1b']);
      expect(order).toEqual([
        'stage-1a:start',
        'stage-1a:end',
        'stage-1b:start',
        'stage-1b:end',
        'memory:start',
        'memory:end',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('lets stage-1 work interleave between memory model phases', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const order = [];
    let releaseNovelty;
    const noveltyGate = new Promise((resolve) => { releaseNovelty = resolve; });

    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/ps')) return { json: async () => ({ models: [] }) };
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
          system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        order.push(system === worker.X_MEMORY_IMPORTANCE_SYSTEM ? 'importance' : 'guard');
        return {
          ok: true,
          json: async () => ({ message: { content: '{"importance":"normal"}' } }),
        };
      }
      if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        order.push('novelty:start');
        await noveltyGate;
        order.push('novelty:end');
        return {
          ok: true,
          json: async () => ({ message: { content: '{"prediction":"repeat"}' } }),
        };
      }
      if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        order.push('recheck');
        return {
          ok: true,
          json: async () => ({ message: { content: '{"prediction":"repeat"}' } }),
        };
      }
      order.push('verdict');
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              importance: 'normal', novelty: 'repeat', funnelRisk: false,
              standaloneValue: true, confidence: 0.9, reason: 'Same claim',
            }),
          },
        }),
      };
    };

    try {
      const memory = worker.scheduleMemoryClassification(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.7 }],
        'dhiltgen/gemma4:e2b-mlx-bf16',
        'http://ollama.test',
      );
      await delay(30);
      const stage1 = worker.scheduleLocalText(
        'dhiltgen/gemma4:e2b-mlx-bf16',
        'http://ollama.test',
        async () => { order.push('stage-1'); },
      );
      releaseNovelty();
      await Promise.all([memory, stage1]);
      expect(order).toEqual([
        'novelty:start', 'novelty:end', 'stage-1',
        'recheck', 'importance', 'guard', 'verdict',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('memory classification contract', () => {
  it('strictly parses exactly the six model-owned fields', () => {
    const worker = loadWorker();
    const valid = {
      importance: 'normal',
      novelty: 'meaningful-update',
      funnelRisk: false,
      standaloneValue: true,
      confidence: 0.91,
      reason: 'Adds measured benchmark',
    };
    expect(worker.parseMemoryClassification(JSON.stringify(valid))).toEqual(valid);
    for (const invalid of [
      { ...valid, action: 'collapse' },
      { ...valid, knownState: 'strong' },
      { ...valid, confidence: '0.91' },
      { ...valid, novelty: 'update' },
      { ...valid, reason: '' },
    ]) {
      expect(worker.parseMemoryClassification(JSON.stringify(invalid))).toBeNull();
    }
    expect(worker.parseMemoryClassification('```json\n' + JSON.stringify(valid) + '\n```')).toEqual(valid);
    expect(worker.parseMemoryClassification('Result:\n' + JSON.stringify(valid))).toBeNull();
    expect(worker.parseMemoryNovelty('{"prediction":"repeat"}')).toEqual({ prediction: 'repeat' });
    expect(worker.parseMemoryNovelty('{"prediction":"meaningful-update","action":"show"}')).toBeNull();
    expect(worker.parseMemoryNovelty('{"prediction":"reinforcement"}')).toBeNull();
    expect(worker.parseMemoryImportance('{"importance":"critical"}')).toEqual({ importance: 'critical' });
    expect(worker.parseMemoryImportance('{"importance":"low"}')).toBeNull();
    expect(worker.parseMemoryImportance('{"importance":"normal","action":"show"}')).toBeNull();
  });

  it('pins the final model contract and keeps Luna out of runtime', () => {
    const worker = loadWorker();
    const prompts = [
      worker.X_MEMORY_NOVELTY_SYSTEM,
      worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
      worker.X_MEMORY_UPDATE_CONFIRM_SYSTEM,
      worker.X_MEMORY_HIGH_OVERLAP_SYSTEM,
      worker.X_MEMORY_LAUNCH_REPEAT_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_AI_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_NS_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_EVENT_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM,
      worker.X_MEMORY_IMPORTANCE_SYSTEM,
      worker.X_MEMORY_SYSTEM,
    ];

    expect(worker.X_MEMORY_SYSTEM).toContain('Return exactly these six keys and no others');
    expect(worker.X_MEMORY_SYSTEM).toContain('novelty is one string, never separate boolean keys');
    expect(worker.X_MEMORY_SYSTEM).toContain('knownState, or action');
    expect(worker.X_MEMORY_SYSTEM).toContain('FOCUSED NOVELTY REQUIRED');
    expect(worker.X_MEMORY_SYSTEM).toContain('FOCUSED IMPORTANCE');
    expect(worker.X_MEMORY_COLLAPSE_GUARD_AI_SYSTEM).not.toContain('IMMEDIATE CRITICAL');
    expect(worker.X_MEMORY_COLLAPSE_GUARD_NS_SYSTEM).not.toContain('IMMEDIATE NORMAL');
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/\bLuna\b/i);
      expect(prompt).not.toContain('claimCluster');
    }
  });

  it('uses bounded low-temperature settings for the final local memory call', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/chat')) {
        const candidate = JSON.parse(options.body);
        const system = candidate.messages[0].content;
        if (system === worker.X_MEMORY_SYSTEM) request = candidate;
        const content = system === worker.X_MEMORY_IMPORTANCE_SYSTEM
          ? JSON.stringify({ importance: 'normal' })
          : JSON.stringify({
            importance: 'normal', novelty: 'new-signal', funnelRisk: false,
            standaloneValue: true, confidence: 0.9, reason: 'No earlier context',
          });
        return {
          ok: true,
          json: async () => ({ message: { content } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      await worker.classifyMemory({ id: 'now', text: 'current' }, [], 'model', 'http://ollama.test');
      expect(request.format).toBeUndefined();
      expect(request.options).toMatchObject({ temperature: 0.1, num_predict: 100, num_ctx: 4096 });
      expect(request.options.seed).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses a focused novelty lane before the strict six-field verdict', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const systems = [];
    const users = [];
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      systems.push(system);
      users.push(request.messages[1].content);
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
          system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        content = JSON.stringify({ importance: 'normal' });
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
          system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = JSON.stringify({ prediction: 'repeat' });
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'repeat', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Same familiar claim',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(users[4]).toContain('CONTEXT TWEETS (0, quoted JSON data)');
      expect(users[4]).toContain('FOCUSED NOVELTY REQUIRED: "repeat"');
      expect(users[4]).toContain('FOCUSED IMPORTANCE: "normal"');
      expect(result.novelty).toBe('repeat');
      expect(result._noveltySide).toBe('familiar');
      expect(result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'repeat' },
        { kind: 'update-recheck', prediction: 'repeat' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a second model verdict before a high-overlap update becomes familiar', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const systems = [];
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      systems.push(system);
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
          system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        content = JSON.stringify({ importance: 'normal' });
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        content = JSON.stringify({ prediction: 'meaningful-update' });
      } else if (system === worker.X_MEMORY_HIGH_OVERLAP_SYSTEM) {
        content = JSON.stringify({ prediction: 'repeat' });
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'repeat', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Same high-overlap event',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.9 }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_HIGH_OVERLAP_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'meaningful-update' },
        { kind: 'high-overlap', prediction: 'repeat' },
      ]);
      expect(result.novelty).toBe('repeat');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('confirms promoted updates only when retrieved exposure is strong', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;

    async function classify(knownState) {
      const systems = [];
      const requiredNovelty = knownState === 'strong' ? 'repeat' : 'meaningful-update';
      globalThis.fetch = async (url, options = {}) => {
        if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
        const request = JSON.parse(options.body);
        const system = request.messages[0].content;
        systems.push(system);
        let content;
        if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
            system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
          content = '{"importance":"normal"}';
        } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
          content = '{"prediction":"repeat"}';
        } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
          content = '{"prediction":"meaningful-update"}';
        } else if (system === worker.X_MEMORY_UPDATE_CONFIRM_SYSTEM) {
          content = '{"prediction":"repeat"}';
        } else {
          content = JSON.stringify({
            importance: 'normal', novelty: requiredNovelty, funnelRisk: false,
            standaloneValue: true, confidence: 0.9, reason: 'Exposure-aware result',
          });
        }
        return { ok: true, json: async () => ({ message: { content } }) };
      };

      const result = await worker.classifyMemory(
        { id: 'now', text: 'A familiar claim with one more framing sentence' },
        [{ tweetId: 'before', text: 'The established claim', similarity: 0.7, knownState }],
        'model',
        'http://ollama.test',
      );
      return { result, systems };
    }

    try {
      const strongResult = await classify('strong');
      expect(strongResult.systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_UPDATE_CONFIRM_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(strongResult.result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'repeat' },
        { kind: 'update-recheck', prediction: 'meaningful-update' },
        { kind: 'update-confirm', prediction: 'repeat' },
      ]);
      expect(strongResult.result._importanceChecks).toEqual([
        { kind: 'focused', importance: 'normal' },
        { kind: 'collapse-guard', importance: 'normal', lane: 'x-memory-collapse-guard' },
      ]);

      const weakResult = await classify('weak');
      expect(weakResult.systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(weakResult.result.novelty).toBe('meaningful-update');
      expect(weakResult.result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'repeat' },
        { kind: 'update-recheck', prediction: 'meaningful-update' },
      ]);
      expect(weakResult.result._importanceChecks).toEqual([
        { kind: 'final', importance: 'normal' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs the literal Falcon repeat check before collapsing a strong-known launch caption', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const systems = [];
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      systems.push(system);
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
          system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        content = '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM ||
                 system === worker.X_MEMORY_UPDATE_CONFIRM_SYSTEM) {
        content = '{"prediction":"meaningful-update"}';
      } else if (system === worker.X_MEMORY_LAUNCH_REPEAT_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'repeat', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Same Falcon 9 launch',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'Falcon 9 launches from pad. Watch live.' },
        [{
          tweetId: 'before', text: 'Falcon 9 mission to orbit is live', similarity: 0.8,
          knownState: 'strong',
        }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_UPDATE_CONFIRM_SYSTEM,
        worker.X_MEMORY_LAUNCH_REPEAT_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(result.novelty).toBe('repeat');
      expect(result._noveltyChecks.at(-1)).toEqual({ kind: 'launch-repeat', prediction: 'repeat' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes familiar collapse candidates through the matching critical guard', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const cases = [
      ['Claude model update', worker.X_MEMORY_COLLAPSE_GUARD_AI_SYSTEM, 'x-memory-collapse-guard-ai'],
      ['Network School Malaysia update', worker.X_MEMORY_COLLAPSE_GUARD_NS_SYSTEM, 'x-memory-collapse-guard-ns'],
      ['Airtable acquisition valuation', worker.X_MEMORY_COLLAPSE_GUARD_EVENT_SYSTEM, 'x-memory-collapse-guard-event'],
      ['Ordinary familiar topic', worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM, 'x-memory-collapse-guard'],
    ];

    try {
      for (const [text, expectedGuard, expectedLane] of cases) {
        const systems = [];
        globalThis.fetch = async (url, options = {}) => {
          if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
          const request = JSON.parse(options.body);
          const system = request.messages[0].content;
          systems.push(system);
          let content;
          if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM) {
            content = '{"importance":"normal"}';
          } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
                     system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
            content = '{"prediction":"repeat"}';
          } else if (system === expectedGuard) {
            content = '{"importance":"critical"}';
          } else {
            content = JSON.stringify({
              importance: 'critical', novelty: 'repeat', funnelRisk: false,
              standaloneValue: true, confidence: 0.9, reason: 'Guarded critical repeat',
            });
          }
          return { ok: true, json: async () => ({ message: { content } }) };
        };

        const result = await worker.classifyMemory(
          { id: 'now', text },
          [{ tweetId: 'before', text: 'Known context', similarity: 0.7, knownState: 'strong' }],
          'model',
          'http://ollama.test',
        );
        expect(systems).toContain(expectedGuard);
        expect(result.importance).toBe('critical');
        expect(result._importanceCheck).toBe('critical');
        expect(result._importanceChecks).toEqual([
          { kind: 'focused', importance: 'normal' },
          { kind: 'collapse-guard', importance: 'critical', lane: expectedLane },
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries malformed collapse-guard output once', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    let guardCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM) {
        content = '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
                 system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else if (system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        guardCalls++;
        content = guardCalls === 1 ? '{"importance":"low"}' : '{"importance":"critical"}';
      } else {
        content = JSON.stringify({
          importance: 'critical', novelty: 'repeat', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Retry recovered guard',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'Ordinary familiar topic' },
        [{ tweetId: 'before', text: 'Known context', similarity: 0.7, knownState: 'strong' }],
        'model',
        'http://ollama.test',
      );
      expect(guardCalls).toBe(2);
      expect(result.importance).toBe('critical');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a final verdict that contradicts the focused novelty side', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
          system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        content = '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
          system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'meaningful-update', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Contradicts focused side',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      await expect(worker.classifyMemory(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      )).rejects.toThrow('memory novelty contradicted focused label');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a final verdict that contradicts focused importance', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM) {
        content = '{"importance":"critical"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
          system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'repeat', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Contradicts importance',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      await expect(worker.classifyMemory(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      )).rejects.toThrow('memory importance contradicted focused label');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries malformed focused and contradictory final model outputs once', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    let importanceCalls = 0;
    let verdictCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      let content;
      if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM) {
        importanceCalls++;
        content = importanceCalls === 1
          ? '{"importance":"2"}'
          : '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_COLLAPSE_GUARD_GENERAL_SYSTEM) {
        content = '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
          system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else {
        verdictCalls++;
        content = JSON.stringify({
          importance: 'normal',
          novelty: verdictCalls === 1 ? 'meaningful-update' : 'repeat',
          funnelRisk: false,
          standaloneValue: true,
          confidence: 0.9,
          reason: 'Same familiar claim',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'current' },
        [{ tweetId: 'before', text: 'context', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      );
      expect(importanceCalls).toBe(2);
      expect(verdictCalls).toBe(2);
      expect(result.importance).toBe('normal');
      expect(result.novelty).toBe('repeat');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds the current tweet and at most five context summaries', () => {
    const worker = loadWorker();
    const contexts = Array.from({ length: 7 }, (_, index) => ({
      tweetId: 'ctx-' + index,
      author: 'author',
      text: String(index).repeat(3_000),
    }));
    const message = worker.buildMemoryUserMessage({ id: 'now', text: 'x'.repeat(7_000) }, contexts);
    const lines = message.split('\n');
    const supplied = JSON.parse(lines[1]);
    const current = JSON.parse(lines[3]);

    expect(current.text).toHaveLength(6_000);
    expect(current.truncated).toBe(true);
    expect(supplied).toHaveLength(worker.MEMORY_MAX_CONTEXTS);
    expect(supplied.every((context) => context.text.length === 1_200 && context.truncated)).toBe(true);
    expect(message).not.toContain('ctx-6');

    const focused = worker.buildMemoryNoveltyUserMessage(
      { id: 'now', text: 'x'.repeat(7_000) },
      contexts,
    );
    expect(focused).toContain('CONTEXT TWEETS (5, in supplied order)');
    expect(focused).not.toContain('ctx-5');
    expect(focused).not.toContain('ctx-6');
    expect(focused).not.toContain('x'.repeat(6_001));
  });
});
