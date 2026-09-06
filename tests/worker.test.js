import { describe, it, expect } from 'bun:test';
import { setTimeout as delay } from 'timers/promises';
import { loadWorker } from '../benchmarks/load-extension.js';

describe('local text scheduling', () => {
  it('serializes shared production-model work without platform-switch churn', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const calls = [];
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/ps')) {
        return {
          json: async () => ({ models: [{ name: 'dhiltgen/gemma4:e2b-mlx-bf16' }] }),
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
      const ytModel = xModel;
      const results = await Promise.all([
        worker.scheduleLocalText(xModel, 'http://ollama.test', task('x-1')),
        worker.scheduleLocalText(xModel, 'http://ollama.test', task('x-2')),
        worker.scheduleLocalText(ytModel, 'http://ollama.test', task('yt-1')),
      ]);

      expect(results).toEqual(['x-1', 'x-2', 'yt-1']);
      expect(maxActive).toBe(1);
      expect(calls.filter((call) => call.body?.keep_alive === 0).map((call) => call.body.model))
        .toEqual([]);
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

  it('still unloads the prior model for an explicit custom-model switch', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const calls = [];
    const productionModel = 'dhiltgen/gemma4:e2b-mlx-bf16';
    const customModel = 'gemma2:2b';

    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/ps')) {
        return { json: async () => ({ models: [{ name: productionModel }] }) };
      }
      const body = JSON.parse(options.body || '{}');
      calls.push(body);
      return { json: async () => ({}) };
    };

    try {
      await worker.scheduleLocalText(productionModel, 'http://ollama.test', async () => 'production');
      await worker.scheduleLocalText(customModel, 'http://ollama.test', async () => 'custom');
      expect(calls.filter((body) => body.keep_alive === 0).map((body) => body.model))
        .toEqual([productionModel]);
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
          system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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
        { id: 'now', text: 'A much broader factual report. '.repeat(12) },
        [{ tweetId: 'before', text: 'One event fragment', similarity: 0.7 }],
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
    expect(worker.parseMemoryNovelty('{"prediction":"reinforcement"}')).toEqual({
      prediction: 'reinforcement',
    });
    expect(worker.parseMemoryNovelty('meaningful-update\nSupporting explanation')).toEqual({
      prediction: 'meaningful-update',
    });
    expect(worker.parseMemoryNovelty('meaningful-update because facts changed')).toBeNull();
    expect(worker.parseMemoryImportance('{"importance":"critical"}')).toEqual({ importance: 'critical' });
    expect(worker.parseMemoryImportance('normal\nSupporting explanation')).toEqual({ importance: 'normal' });
    expect(worker.parseMemoryImportance('normal confidence')).toBeNull();
    expect(worker.parseMemoryImportance('{"importance":"low"}')).toBeNull();
    expect(worker.parseMemoryImportance('{"importance":"normal","action":"show"}')).toBeNull();
    const assessment = {
      importance: 'normal', funnelRisk: false, standaloneValue: true,
      confidence: 0.9, reason: 'Useful facts are present',
    };
    expect(worker.parseMemoryAssessment(JSON.stringify(assessment))).toEqual(assessment);
    expect(worker.parseMemoryAssessment(JSON.stringify({ ...assessment, novelty: 'repeat' }))).toBeNull();
    const value = {
      funnelRisk: false, standaloneValue: true,
      confidence: 0.9, reason: 'Useful facts are present',
    };
    expect(worker.parseMemoryValueAssessment(JSON.stringify(value))).toEqual(value);
    expect(worker.parseMemoryValueAssessment(JSON.stringify({ ...value, importance: 'normal' }))).toBeNull();
  });

  it('pins the final model contract and keeps Luna out of runtime', () => {
    const worker = loadWorker();
    const prompts = [
      worker.X_MEMORY_NOVELTY_SYSTEM,
      worker.X_MEMORY_FAMILIAR_CONFIRM_SYSTEM,
      worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
      worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM,
      worker.X_MEMORY_IMPORTANCE_SYSTEM,
      worker.X_MEMORY_SYSTEM,
    ];

    expect(worker.X_MEMORY_SYSTEM).toContain('Return exactly these four keys and no others');
    expect(worker.X_MEMORY_SYSTEM).toContain('Never add importance, novelty, knownState, or action');
    expect(worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM).toContain('final safety check');
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/\bLuna\b/i);
      expect(prompt).not.toContain('claimCluster');
    }
  });

  it('recognizes concrete critical updates without treating clarification lists as alerts', () => {
    const worker = loadWorker();
    const cases = [
      ['Another UPDATE: 1) the witness stepped forward 2) records were released', 'enumerated-update'],
      ['CLAUDE OPUS 5 DROPS TODAY at half the prior price.', 'release-timing'],
      ['A quantum signature system was weakened enough to recover its secret key.', 'security-finding'],
      ['Anthropic will develop custom AI chips for Claude.', 'company-action'],
      ['Google DeepMind CEO steps down to become chair.', 'personnel-change'],
      ['The team worked around the clock and made it happen in time. Enjoy Fable.', 'completed-release'],
    ];
    for (const [text, expected] of cases) {
      expect(worker.criticalFamiliarSignalKind({ text })).toBe(expected);
    }
    expect(worker.criticalFamiliarSignalKind({
      text: ('A few questions about the project. Would appreciate clarification: ' +
        '1) Is it local? 2) Who pays? 3) What license applies? ').repeat(3),
    })).toBeNull();
    expect(worker.isDirectOpportunityInvitation({
      text: 'The program is back, who’s down to go to Kazakhstan?',
    })).toBe(true);
  });

  it('shows a critical-shaped familiar item before the model can flatten its importance', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const systems = [];
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      const system = request.messages[0].content;
      systems.push(system);
      const content = system === worker.X_MEMORY_SYSTEM
        ? JSON.stringify({
          funnelRisk: false, standaloneValue: true,
          confidence: 0.9, reason: 'Concrete update safety lane',
        })
        : JSON.stringify({ prediction: 'repeat' });
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        {
          id: 'now',
          text: 'Another UPDATE: 1) the witness stepped forward 2) records were released. Thoughts?',
        },
        [{
          tweetId: 'before', text: 'The earlier allegation.', similarity: 0.7,
          knownState: 'strong',
        }],
        'model',
        'http://ollama.test',
      );
      expect(result.importance).toBe('critical');
      expect(result.novelty).toBe('repeat');
      expect(result._importanceChecks).toEqual([
        { kind: 'critical-safety', importance: 'critical', lane: 'enumerated-update' },
      ]);
      expect(systems).toEqual([worker.X_MEMORY_SYSTEM]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still collapses an exact duplicate with a critical-looking headline', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const text = 'JUST IN: Anthropic will develop custom AI chips for Claude.';
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({
            funnelRisk: false, standaloneValue: true,
            confidence: 0.9, reason: 'Exact duplicate',
          }) },
        }),
      };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text },
        [{ tweetId: 'before', text, similarity: 1, knownState: 'strong' }],
        'model',
        'http://ollama.test',
      );
      expect(result.importance).toBe('normal');
      expect(result._importanceChecks).toEqual([
        { kind: 'exact-containment', importance: 'normal' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
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
      expect(request.format).toBe('json');
      expect(request.options).toMatchObject({ temperature: 0, num_predict: 100, num_ctx: 4096 });
      expect(request.options.seed).toBe(worker.MEMORY_SEED);
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
          system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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
        { id: 'now', text: 'A much broader factual report. '.repeat(12) },
        [{ tweetId: 'before', text: 'One event fragment', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(users[4]).not.toContain('CONTEXT TWEETS');
      expect(users[4]).not.toContain('FOCUSED NOVELTY REQUIRED');
      expect(users[4]).not.toContain('FOCUSED IMPORTANCE');
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

  it('does not let high embedding overlap reverse a focused update', async () => {
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
          system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
        content = JSON.stringify({ importance: 'normal' });
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM ||
                 system === worker.X_MEMORY_FAMILIAR_CONFIRM_SYSTEM) {
        content = JSON.stringify({ prediction: 'meaningful-update' });
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'meaningful-update', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Concrete update preserved',
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
        worker.X_MEMORY_FAMILIAR_CONFIRM_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'meaningful-update' },
        { kind: 'familiar-confirm', prediction: 'meaningful-update' },
      ]);
      expect(result.novelty).toBe('meaningful-update');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves a rechecked update regardless of retrieved exposure strength', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;

    async function classify(knownState) {
      const systems = [];
      const requiredNovelty = 'meaningful-update';
      globalThis.fetch = async (url, options = {}) => {
        if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
        const request = JSON.parse(options.body);
        const system = request.messages[0].content;
        systems.push(system);
        let content;
        if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
            system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
          content = '{"importance":"normal"}';
        } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
          content = '{"prediction":"repeat"}';
        } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
          content = '{"prediction":"meaningful-update"}';
        } else {
          content = JSON.stringify({
            importance: 'normal', novelty: requiredNovelty, funnelRisk: false,
            standaloneValue: true, confidence: 0.9, reason: 'Exposure-aware result',
          });
        }
        return { ok: true, json: async () => ({ message: { content } }) };
      };

      const result = await worker.classifyMemory(
        { id: 'now', text: 'A broader factual report with participants and mechanics. '.repeat(8) },
        [{ tweetId: 'before', text: 'One event fragment', similarity: 0.7, knownState }],
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
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(strongResult.result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'repeat' },
        { kind: 'update-recheck', prediction: 'meaningful-update' },
      ]);
      expect(strongResult.result.novelty).toBe('meaningful-update');
      expect(strongResult.result._importanceChecks).toEqual([
        { kind: 'focused-new-information', importance: 'normal' },
      ]);

      const weakResult = await classify('weak');
      expect(weakResult.systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(weakResult.result.novelty).toBe('meaningful-update');
      expect(weakResult.result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'repeat' },
        { kind: 'update-recheck', prediction: 'meaningful-update' },
      ]);
      expect(weakResult.result._importanceChecks).toEqual([
        { kind: 'focused-new-information', importance: 'normal' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps independent support on the familiar reinforcement side', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const system = JSON.parse(options.body).messages[0].content;
      let content;
      if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        content = '{"prediction":"reinforcement"}';
      } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM ||
                 system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
        content = '{"importance":"normal"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'reinforcement', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Supports known conclusion',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'Another independent example supports the known claim. '.repeat(3) },
        [{
          tweetId: 'before',
          text: 'The established claim and its factual basis remain unchanged. '.repeat(3),
          knownState: 'strong',
          similarity: 0.7,
        }],
        'model',
        'http://ollama.test',
      );
      expect(result.novelty).toBe('reinforcement');
      expect(result._noveltySide).toBe('familiar');
      expect(result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'reinforcement' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rechecks a materially broader report even when the first pass calls it reinforcement', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const systems = [];
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).endsWith('/api/chat')) return { ok: true, json: async () => ({}) };
      const system = JSON.parse(options.body).messages[0].content;
      systems.push(system);
      let content;
      if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        content = '{"prediction":"reinforcement"}';
      } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"meaningful-update"}';
      } else if (system === worker.X_MEMORY_IMPORTANCE_SYSTEM) {
        content = '{"importance":"normal"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'meaningful-update', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Broader report adds mechanics',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'A broader report with participants and mechanics. '.repeat(8) },
        [{ tweetId: 'before', text: 'One event fragment', similarity: 0.7 }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(result.novelty).toBe('meaningful-update');
      expect(result._noveltyChecks).toEqual([
        { kind: 'focused', prediction: 'reinforcement' },
        { kind: 'update-recheck', prediction: 'meaningful-update' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not let a topic-specific launch check reverse a rechecked update', async () => {
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
          system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
        content = '{"importance":"normal"}';
      } else if (system === worker.X_MEMORY_NOVELTY_SYSTEM) {
        content = '{"prediction":"repeat"}';
      } else if (system === worker.X_MEMORY_UPDATE_RECHECK_SYSTEM) {
        content = '{"prediction":"meaningful-update"}';
      } else {
        content = JSON.stringify({
          importance: 'normal', novelty: 'meaningful-update', funnelRisk: false,
          standaloneValue: true, confidence: 0.9, reason: 'Launch update preserved',
        });
      }
      return { ok: true, json: async () => ({ message: { content } }) };
    };

    try {
      const result = await worker.classifyMemory(
        { id: 'now', text: 'Falcon 9 mission report with participants, hardware, mechanics, results, and purpose. '.repeat(6) },
        [{
          tweetId: 'before', text: 'Falcon 9 launches', similarity: 0.8,
          knownState: 'strong',
        }],
        'model',
        'http://ollama.test',
      );
      expect(systems).toEqual([
        worker.X_MEMORY_NOVELTY_SYSTEM,
        worker.X_MEMORY_UPDATE_RECHECK_SYSTEM,
        worker.X_MEMORY_IMPORTANCE_SYSTEM,
        worker.X_MEMORY_SYSTEM,
      ]);
      expect(result.novelty).toBe('meaningful-update');
      expect(result._noveltyChecks.at(-1)).toEqual({
        kind: 'update-recheck', prediction: 'meaningful-update',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes every familiar collapse candidate through the general critical guard', async () => {
    const worker = loadWorker();
    const originalFetch = globalThis.fetch;
    const cases = ['Claude model update', 'Network School Malaysia update',
      'Airtable acquisition valuation', 'Ordinary familiar topic'].map((text) =>
      (text + ' with enough context to require a model-based critical safety decision. ').repeat(3));

    try {
      for (const text of cases) {
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
          } else if (system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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
        expect(systems).toContain(worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM);
        expect(result.importance).toBe('critical');
        expect(result._importanceCheck).toBe('critical');
        expect(result._importanceChecks).toEqual([
          { kind: 'focused', importance: 'normal' },
          { kind: 'collapse-guard', importance: 'critical', lane: 'x-memory-collapse-guard' },
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
      } else if (system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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
        { id: 'now', text: 'Ordinary familiar topic with enough detail for a model safety decision. '.repeat(3) },
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
          system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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
      } else if (system === worker.X_MEMORY_COLLAPSE_GUARD_SYSTEM) {
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

  it('bounds the current assessment and at most five focused context summaries', () => {
    const worker = loadWorker();
    const contexts = Array.from({ length: 7 }, (_, index) => ({
      tweetId: 'ctx-' + index,
      author: 'author',
      text: String(index).repeat(3_000),
    }));
    const message = worker.buildMemoryUserMessage({ id: 'now', text: 'x'.repeat(7_000) }, contexts);
    const lines = message.split('\n');
    const current = JSON.parse(lines[1]);

    expect(current.text).toHaveLength(6_000);
    expect(current.truncated).toBe(true);
    expect(message).not.toContain('ctx-0');

    const focused = worker.buildMemoryNoveltyUserMessage(
      { id: 'now', text: 'x'.repeat(7_000) },
      contexts,
    );
    expect(focused).toContain('CONTEXT TWEETS (5, in supplied order)');
    expect(focused).not.toContain('ctx-5');
    expect(focused).not.toContain('ctx-6');
    expect(focused).not.toContain('x'.repeat(6_001));
  });

  it('reserves the broader-report safety recheck for materially fuller reports', () => {
    const worker = loadWorker();
    expect(worker.shouldRunMemoryUpdateRecheck(
      { text: 'A broader report with concrete details. '.repeat(10) },
      [{ text: 'One event fragment' }],
    )).toBe(true);
    expect(worker.shouldRunMemoryUpdateRecheck(
      { text: 'A short restatement' },
      [{ text: 'A detailed known report with the same event and its consequences' }],
    )).toBe(false);
    expect(worker.shouldRunMemoryUpdateRecheck(
      { text: 'We are investigating the incident and sharing preliminary findings.' },
      [{ text: 'An observer says the incident happened.' }],
    )).toBe(true);
    expect(worker.shouldRunMemoryUpdateRecheck(
      { text: 'Code Arena now measures fullstack capabilities.' },
      [{ text: 'Code Arena ranked the prior model on frontend tasks.' }],
    )).toBe(true);
  });
});
