import { it, expect } from 'bun:test';
import { loadWorker } from '../benchmarks/load-extension.js';

// Simulate model-load time against the actual requested deadline, without
// making every regression run wait for a real cold load.
async function probe({ loadMs = 19000, status = 200, offline = false } = {}) {
  const worker = loadWorker();
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const deadlines = new WeakMap();
  const calls = [];
  AbortSignal.timeout = ms => {
    const signal = new AbortController().signal;
    deadlines.set(signal, ms);
    return signal;
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (offline) throw new TypeError('Failed to fetch');
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'model' }] }));
    if (loadMs > deadlines.get(options.signal)) throw new DOMException('signal timed out', 'TimeoutError');
    return new Response('{}', { status });
  };
  try {
    return { result: await worker.checkHealth('http://ollama.test', 'model', 'test-key'), calls };
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
}

it('allows the documented 19-second text cold start without disabling classification', async () => {
  const { result, calls } = await probe();
  expect(result).toEqual({ available: true, models: ['model'], classify: true });
  const request = JSON.parse(calls[1].options.body);
  expect(request.options.num_ctx).toBe(8192);
  expect(request.keep_alive).toBe('30m');
  expect(calls[1].options.headers.Authorization).toBe('Bearer test-key');
});

it('still bounds a stuck health POST and preserves fail-open diagnostics', async () => {
  const { result, calls } = await probe({ loadMs: 31000 });
  expect(result.available).toBe(true);
  expect(result.classify).toBe(false);
  expect(result.postError).toBe('signal timed out');
  expect(calls).toHaveLength(2);
});

it('does not report HTTP POST rejection as a healthy classifier', async () => {
  const { result } = await probe({ loadMs: 0, status: 403 });
  expect(result.available).toBe(true);
  expect(result.classify).toBe(false);
  expect(result.postStatus).toBe(403);
});

it('keeps an unreachable server offline', async () => {
  const { result, calls } = await probe({ offline: true });
  expect(result.available).toBe(false);
  expect(result.classify).toBe(false);
  expect(calls).toHaveLength(1);
});
