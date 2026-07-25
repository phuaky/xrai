// Boot smoke test: execute every content-script file in exact manifest order
// (one shared scope per platform, same as Chrome's isolated world) and assert
// the whole chain runs without throwing and the pill appears. Catches the
// class of failure where each file is individually valid but the ensemble
// breaks at injection time (missing global, bad cross-file reference,
// load-order regression).
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import 'fake-indexeddb/auto';

const root = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));

function chromeStub() {
  return {
    runtime: {
      id: 'boot-test',
      lastError: undefined,
      sendMessage: (msg, cb) => { if (cb) cb(undefined); },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get: (keys, cb) => cb({}),
        set: (obj, cb) => { if (cb) cb(); },
        remove: (keys, cb) => { if (cb) cb(); }
      },
      onChanged: { addListener() {} }
    }
  };
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

describe('content-script boot (manifest order)', () => {
  for (const block of manifest.content_scripts) {
    const platform = block.matches[0].includes('youtube') ? 'youtube' : 'x';

    it(`${platform}: all ${block.js.length} files execute and the pill appears`, async () => {
      document.body.innerHTML = '';
      const src = block.js
        .map((f) => readFileSync(join(root, 'extension', f), 'utf8'))
        .join('\n;\n');

      // Shared function scope = every file's top-level `var` is visible to
      // the later files, mirroring Chrome's per-frame isolated world.
      new Function('chrome', src)(chromeStub());

      // start() resolves config via (stubbed) storage before creating the pill.
      await new Promise((r) => setTimeout(r, 50));
      expect(document.getElementById('xrai-pill')).not.toBe(null);
    });
  }
});
