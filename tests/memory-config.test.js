import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '../extension/lib/config.js'), 'utf8');

function loadConfig() {
  return new Function(source + '\nreturn RaiConfig;')();
}

describe('memory-aware configuration', () => {
  it('defaults on at the evaluated threshold while image bait stays off', () => {
    const config = loadConfig();
    expect(config.DEFAULTS.x).toMatchObject({
      memoryAware: true,
      memoryConfidenceThreshold: 0.75,
      imageBaitEnabled: false,
    });
    expect(config.DEFAULTS.youtube.memoryAware).toBeUndefined();
    expect(config.DEFAULTS.youtube.imageBaitEnabled).toBe(false);
  });

  it('notifies the live X pipeline when the rollback toggle changes', async () => {
    const config = loadConfig();
    const changes = [];
    const unsubscribe = config.onChanged('x', (next) => changes.push(next));
    await config.saveConfig('x', { memoryAware: false, memoryConfidenceThreshold: 0.85 });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ memoryAware: false, memoryConfidenceThreshold: 0.85 });
    unsubscribe();
    await config.saveConfig('x', { memoryAware: true });
    expect(changes).toHaveLength(1);
  });
});
