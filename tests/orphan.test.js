// Orphaned-tab resilience: when the extension is reloaded, tabs opened before
// the reload keep their old content script and every chrome.* call throws
// "Extension context invalidated". Storage reads/writes must fail SOFT
// (defaults / zeros / resolved promises), never surface uncaught errors on
// the extension card. Regression for the lib/memory.js:233 error (Jul 2026).
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const memorySrc = readFileSync(join(root, 'extension/lib/memory.js'), 'utf8');
const configSrc = readFileSync(join(root, 'extension/lib/config.js'), 'utf8');

// Every chrome API throws, exactly like an invalidated context.
function deadChrome() {
  const boom = () => { throw new Error('Extension context invalidated.'); };
  return {
    runtime: { get id() { return undefined; }, sendMessage: boom },
    storage: {
      local: { get: boom, set: boom, remove: boom },
      onChanged: { addListener: boom }
    }
  };
}

const loadMemory = () => new Function('chrome', memorySrc + '\nreturn RaiMemory;')(deadChrome());
const loadConfig = () => new Function('chrome', configSrc + '\nreturn RaiConfig;')(deadChrome());

describe('orphaned tab (chrome.* throws)', () => {
  it('RaiMemory.getStats resolves zeros instead of rejecting', async () => {
    const stats = await loadMemory().getStats();
    expect(stats.total).toBe(0);
    expect(stats.kept).toBe(0);
    expect(stats.hidden).toBe(0);
    expect(stats.today.total).toBe(0);
  });

  it('RaiMemory.getDailyTime resolves 0', async () => {
    expect(await loadMemory().getDailyTime()).toBe(0);
  });

  it('RaiMemory.clearAll resolves', async () => {
    await loadMemory().clearAll();
  });

  it('RaiMemory.logClassification and getClassifications resolve', async () => {
    const mem = loadMemory();
    await mem.logClassification('text', 'text', 'noise', 0.9, 'model');
    expect(await mem.getClassifications()).toEqual([]);
  });

  it('RaiConfig.getConfig falls back to defaults', async () => {
    const cfg = await loadConfig().getConfig('x');
    expect(cfg.model).toBe('dhiltgen/gemma4:e2b-mlx-bf16');
    expect(cfg.confidenceThreshold).toBe(0.7);
  });

  it('RaiConfig.saveConfig resolves (in-memory only)', async () => {
    const config = loadConfig();
    const cfg = await config.saveConfig('x', { hideMethod: 'blur' });
    expect(cfg.hideMethod).toBe('blur');
  });

  it('RaiConfig.resetConfig resolves to defaults', async () => {
    const cfg = await loadConfig().resetConfig('x');
    expect(cfg.hideMethod).toBe('remove');
  });
});
