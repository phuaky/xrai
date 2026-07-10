// Attention ledger — dwell tracking lifecycle (no Ollama, no real timers).
// happy-dom's IntersectionObserver never fires, so the observer callback,
// tick, sweep, and navCheck are exposed and driven synchronously. The pinned
// invariants: every exit path funnels through ONE idempotent finalize (never
// double-logs), sub-threshold glances are dropped, hidden tabs accrue
// nothing, and decision context rides the read event.
import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const dwellSrc = readFileSync(join(import.meta.dir, '../extension/content/core/dwell.js'), 'utf8');

let logged = [];
let mirrored = [];
let flushes = 0;

globalThis.RaiMemory = {
  logEvent: (r) => logged.push(r),
  mirrorEvent: (r) => mirrored.push(r),
  flushMirror: () => flushes++,
};

function loadDwell() {
  const patched = dwellSrc
    .replace(
      'return { init: init, observe: observe };',
      'return { init: init, observe: observe, _ioCallback: ioCallback, _tick: tick, _sweep: sweep, _navCheck: navCheck, _finalize: finalize, _finalizeAll: finalizeAll, _entries: entries };'
    )
    .replace(/var RaiDwell\s*=\s*/, '');
  return eval(patched);
}

function makeCard(id) {
  const el = document.createElement('article');
  document.body.appendChild(el);
  return el;
}

function enter(dwell, el) {
  dwell._ioCallback([{ target: el, isIntersecting: true, intersectionRatio: 0.6 }]);
}

function exit(dwell, el) {
  dwell._ioCallback([{ target: el, isIntersecting: false, intersectionRatio: 0 }]);
}

const META = { id: 't1', author: 'kuan', snippet: 'agent harness tip', decision: 'shown', source: 'model' };

describe('RaiDwell lifecycle', () => {
  let dwell;
  beforeEach(() => {
    logged = [];
    mirrored = [];
    flushes = 0;
    document.body.innerHTML = '';
    window.happyDOM.setURL('https://x.com/home'); // about:blank can't take pushState paths
    dwell = loadDwell();
    dwell._navCheck(); // prime lastHref (init() is not called — it starts a real interval)
  });

  it('accrues per visible tick and logs once on viewport exit', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    dwell._tick();
    dwell._tick();
    dwell._tick();
    exit(dwell, el);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({
      kind: 'read', tweetId: 't1', author: 'kuan',
      decision: 'shown', source: 'model', dwellMs: 6000,
    });
    expect(mirrored.length).toBe(1);
  });

  it('drops sub-threshold glances (<1s) without logging', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    exit(dwell, el); // no tick between — dwellMs 0
    expect(logged.length).toBe(0);
    expect(dwell._entries.size).toBe(0); // still finalized (released)
  });

  it('initial below-the-fold notification does not drop the entry', () => {
    const el = makeCard();
    dwell.observe(el, META);
    exit(dwell, el); // IO's initial not-intersecting callback, never visible
    expect(dwell._entries.size).toBe(1); // still waiting, not finalized
    dwell._tick();
    expect(dwell._entries.get('t1').dwellMs).toBe(0); // invisible entries don't accrue
  });

  it('never double-logs: IO-exit then sweep on the same card', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    dwell._tick();
    exit(dwell, el);
    el.remove();
    dwell._sweep();
    dwell._finalize('t1');
    expect(logged.length).toBe(1);
  });

  it('sweep is the backstop for cards virtualized away without an IO exit', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    dwell._tick();
    el.remove(); // X detaches timeline nodes with no teardown callback
    dwell._sweep();
    expect(logged.length).toBe(1);
    expect(logged[0].dwellMs).toBe(2000);
  });

  it('accrues nothing while the tab is hidden', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    dwell._tick();
    dwell._tick();
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    exit(dwell, el);
    expect(logged.length).toBe(0); // 0ms accrued < threshold
  });

  it('route change finalizes all in-flight entries and flushes the mirror', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    dwell._tick();
    history.pushState({}, '', '/kuan/status/999');
    dwell._navCheck();
    expect(logged.length).toBe(1);
    expect(dwell._entries.size).toBe(0);
    expect(flushes).toBe(1);
  });

  it('observe is once per id and requires an id', () => {
    const el = makeCard();
    dwell.observe(el, META);
    dwell.observe(makeCard(), META); // same id — ignored
    dwell.observe(makeCard(), { author: 'x' }); // no id — ignored
    expect(dwell._entries.size).toBe(1);
  });

  it('snippet is capped at 140 chars', () => {
    const el = makeCard();
    dwell.observe(el, { ...META, id: 't2', snippet: 'x'.repeat(500) });
    enter(dwell, el);
    dwell._tick();
    exit(dwell, el);
    expect(logged[0].text.length).toBe(140);
  });
});
