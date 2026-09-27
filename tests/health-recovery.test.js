import { it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

it('rescans X on initial connection and recovery, but not every healthy poll', () => {
  const callbacks = [], intervals = [];
  let rescans = 0;
  const noop = () => {};
  const source = readFileSync(new URL('../extension/content/x/main.js', import.meta.url), 'utf8');
  const deps = {
    chrome: { runtime: { id: 'health-test', sendMessage: (_, cb) => callbacks.push(cb) } },
    document: { readyState: 'complete' },
    window: { location: { pathname: '/home' }, addEventListener: noop },
    RaiMemory: { init: async () => {}, startSession: noop },
    RaiConfig: { getConfig: () => ({ then: cb => cb({}) }) },
    RaiClassifier: { configure: noop, onActivity: noop },
    RaiImageClassifier: { configure: noop, onActivity: noop },
    RaiIndicator: { init: noop, update: noop },
    XraiDetector: { onTweet: noop, start: noop, rescan: () => rescans++ },
    setInterval: (cb, ms) => { intervals.push({ cb, ms }); return intervals.length; },
  };
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  expect(rescans).toBe(0);
  callbacks.shift()({ available: true, classify: true });
  expect(rescans).toBe(1);
  const poll = intervals.find(item => item.ms === 30000).cb;
  poll(); callbacks.shift()({ available: true, classify: false });
  expect(rescans).toBe(1);
  poll(); callbacks.shift()({ available: true, classify: true });
  expect(rescans).toBe(2);
  poll(); callbacks.shift()({ available: true, classify: true });
  expect(rescans).toBe(2);
});
