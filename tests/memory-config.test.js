import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '../extension/lib/config.js'), 'utf8');

function loadConfig(chrome) {
  return new Function('chrome', source + '\nreturn RaiConfig;')(chrome);
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
    expect(config.DEFAULTS.youtube).toMatchObject({
      configVersion: 2,
      model: 'dhiltgen/gemma4:e2b-mlx-bf16',
      imageBaitEnabled: false,
    });
  });

  it('migrates the former YouTube default model but preserves custom choices', async () => {
    function storageWith(stored) {
      const writes = [];
      return {
        writes,
        chrome: {
          storage: {
            local: {
              get(_key, callback) { callback({ ytrai_config: { ...stored } }); },
              set(value, callback) { writes.push(value); if (callback) callback(); },
            },
          },
        },
      };
    }

    const formerDefault = storageWith({
      configVersion: 1,
      model: 'gemma2:2b',
      imageBaitEnabled: true,
    });
    const migrated = await loadConfig(formerDefault.chrome).getConfig('youtube');
    expect(migrated).toMatchObject({
      configVersion: 2,
      model: 'dhiltgen/gemma4:e2b-mlx-bf16',
      imageBaitEnabled: false,
    });
    expect(formerDefault.writes.at(-1).ytrai_config).toMatchObject({
      configVersion: 2,
      model: 'dhiltgen/gemma4:e2b-mlx-bf16',
    });

    const custom = storageWith({ configVersion: 1, model: 'custom-youtube-model' });
    expect(await loadConfig(custom.chrome).getConfig('youtube'))
      .toMatchObject({ configVersion: 2, model: 'custom-youtube-model' });
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
