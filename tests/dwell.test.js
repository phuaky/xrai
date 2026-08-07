// Attention ledger — dwell tracking lifecycle (no Ollama, no real timers).
// happy-dom's IntersectionObserver never fires, so the observer callback,
// tick, sweep, and navCheck are exposed and driven synchronously. The pinned
// invariants: every exit path funnels through ONE idempotent finalize (never
// double-logs), sub-threshold glances are dropped, hidden tabs accrue
// nothing, and decision context rides the read event.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const dwellSrc = readFileSync(join(import.meta.dir, '../extension/content/core/dwell.js'), 'utf8');

let logged = [];
let mirrored = [];
let strengthened = [];
let flushes = 0;
let now = 0;
const realDateNow = Date.now;

globalThis.RaiMemory = {
  logEvent: (r) => logged.push(r),
  mirrorEvent: (r) => mirrored.push(r),
  flushMirror: () => flushes++,
};
globalThis.RaiKnowledge = {
  recordReadDwell: (tweetId, dwellMs, meta) => strengthened.push({ tweetId, dwellMs, meta }),
};

function loadDwell() {
  const patched = dwellSrc
    .replace(
      'return { init: init, observe: observe, getActiveElapsed: getActiveElapsed };',
      'return { init: init, observe: observe, getActiveElapsed: getActiveElapsed, _ioCallback: ioCallback, _tick: tick, _sweep: sweep, _navCheck: navCheck, _visibilityChange: visibilityChange, _finalize: finalize, _finalizeAll: finalizeAll, _entries: entries };'
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

function advance(ms) {
  now += ms;
}

const META = { id: 't1', author: 'kuan', snippet: 'agent harness tip', decision: 'shown', source: 'model' };

describe('RaiDwell lifecycle', () => {
  let dwell;
  beforeEach(() => {
    logged = [];
    mirrored = [];
    strengthened = [];
    flushes = 0;
    now = 100_000;
    Date.now = () => now;
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.body.innerHTML = '';
    window.happyDOM.setURL('https://x.com/home'); // about:blank can't take pushState paths
    dwell = loadDwell();
    dwell._navCheck(); // prime lastHref (init() is not called — it starts a real interval)
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('accrues per visible tick and logs once on viewport exit', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    advance(2_000);
    dwell._tick();
    advance(2_000);
    dwell._tick();
    advance(2_000);
    dwell._tick();
    exit(dwell, el);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({
      kind: 'read', tweetId: 't1', author: 'kuan',
      decision: 'shown', source: 'model',
    });
    expect(logged[0].dwellMs).toBeGreaterThanOrEqual(6000);
    expect(mirrored.length).toBe(1);
    expect(strengthened).toEqual([{
      tweetId: 't1', dwellMs: expect.any(Number),
      meta: { timestamp: expect.any(Number), decision: 'shown', source: 'model' },
    }]);
    expect(strengthened[0].dwellMs).toBeGreaterThanOrEqual(6000);
  });

  it('exposes current-impression dwell for collapse suppression', () => {
    const el = makeCard();
    dwell.observe(el, META);
    expect(dwell.getActiveElapsed('t1')).toBe(0);
    enter(dwell, el);
    advance(2_000);
    dwell._tick();
    expect(dwell.getActiveElapsed('t1')).toBe(2_000);
    expect(dwell.getActiveElapsed('missing')).toBe(0);
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
    advance(2_000);
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
    advance(2_000);
    dwell._tick();
    el.remove(); // X detaches timeline nodes with no teardown callback
    dwell._sweep();
    expect(logged.length).toBe(1);
    expect(logged[0].dwellMs).toBeGreaterThanOrEqual(2000);
  });

  it('pauses exactly while the tab is hidden', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    advance(500);
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    dwell._visibilityChange();
    advance(10_000);
    dwell._tick();
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    dwell._visibilityChange();
    advance(400);
    exit(dwell, el);
    expect(logged.length).toBe(0); // 900ms active; hidden interval excluded
  });

  it('does not award a fixed tick to a card that just became visible', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    advance(10);
    dwell._tick();
    exit(dwell, el);
    expect(logged.length).toBe(0);
  });

  it('route change finalizes all in-flight entries and flushes the mirror', () => {
    const el = makeCard();
    dwell.observe(el, META);
    enter(dwell, el);
    advance(2_000);
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
    advance(2_000);
    dwell._tick();
    exit(dwell, el);
    expect(logged[0].text.length).toBe(140);
  });
});
