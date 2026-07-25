// Hop detection — fast, no-Ollama pins for the X ↔ YouTube doom-loop nudge.
// The invariant that matters most is the NON-fire case: same-platform
// visibility flapping (alt-tabbing between X and an editor all day) must
// never trigger, or the nudge becomes noise and gets turned off forever.
import { describe, it, expect } from 'bun:test';
import { loadHops } from '../benchmarks/load-extension.js';

const Hops = loadHops();

const T0 = 1_000_000_000_000; // fixed base timestamp — logic is Date-free
const SEC = 1000;
const MIN = 60 * SEC;

// Run a visit sequence through evaluate, threading state like the worker does.
// Each step: [platform, eventType, tsOffset]. Returns every per-step verdict.
function run(steps, { armed = true, state = Hops.emptyState() } = {}) {
  const out = [];
  for (const [p, e, ts] of steps) {
    const res = Hops.evaluate(state, { p, e }, T0 + ts, armed);
    state = res.state;
    out.push({ nudge: res.nudge, churn: res.churn, state });
  }
  return out;
}

describe('RaiHops.evaluate — fires on the real loop', () => {
  it('nudges on rapid X ↔ YouTube alternation (the described pattern)', () => {
    const steps = run([
      ['youtube', 'load', 0],
      ['x', 'vis', 20 * SEC],
      ['youtube', 'vis', 45 * SEC],
      ['x', 'vis', 70 * SEC],
    ]);
    expect(steps[2].nudge).toBe(false); // 2 switches — not yet
    expect(steps[3].nudge).toBe(true);  // 3rd switch — that's the loop
    expect(steps[3].churn).toBe(3);
  });

  it('nudges on same-platform close-and-reopen churn (fresh loads)', () => {
    const steps = run([
      ['x', 'load', 0],
      ['x', 'load', 1 * MIN],
      ['x', 'load', 2 * MIN],
      ['x', 'load', 3 * MIN],
    ]);
    expect(steps[3].nudge).toBe(true); // 4 opens = 3 reopen-transitions
  });

  it('mixed pattern counts both switch and reopen churn', () => {
    const steps = run([
      ['youtube', 'load', 0],
      ['x', 'load', 30 * SEC],       // switch (1)
      ['x', 'load', 90 * SEC],       // reopen (2)
      ['youtube', 'vis', 2 * MIN],   // switch (3)
    ]);
    expect(steps[3].nudge).toBe(true);
  });

  it('firing sets a snooze and clears the window', () => {
    const steps = run([
      ['youtube', 'vis', 0],
      ['x', 'vis', 10 * SEC],
      ['youtube', 'vis', 20 * SEC],
      ['x', 'vis', 30 * SEC],
    ]);
    const fired = steps[3];
    expect(fired.nudge).toBe(true);
    expect(fired.state.events).toEqual([]);
    expect(fired.state.snoozeUntil).toBe(T0 + 30 * SEC + Hops.SNOOZE_MS);
  });
});

describe('RaiHops.evaluate — never fires on normal use', () => {
  it('same-platform visibility flapping (work alt-tabbing) never churns', () => {
    const steps = [];
    for (let i = 0; i < 12; i++) steps.push(['x', 'vis', i * 30 * SEC]);
    const out = run(steps);
    expect(out.every((s) => !s.nudge)).toBe(true);
    expect(out[out.length - 1].churn).toBe(0);
  });

  it('slow alternation (checking each site once in a while) never fires', () => {
    const out = run([
      ['youtube', 'vis', 0],
      ['x', 'vis', 5 * MIN],
      ['youtube', 'vis', 10 * MIN],
      ['x', 'vis', 15 * MIN],
    ]);
    expect(out.every((s) => !s.nudge)).toBe(true);
  });

  it('one platform switch is not a loop', () => {
    const out = run([
      ['youtube', 'load', 0],
      ['x', 'load', 30 * SEC],
    ]);
    expect(out[1].nudge).toBe(false);
    expect(out[1].churn).toBe(1);
  });

  it('a slow same-platform reload is not churn', () => {
    const out = run([
      ['x', 'load', 0],
      ['x', 'load', Hops.RELOAD_GAP_MS + 1 * SEC],
    ]);
    expect(out[1].churn).toBe(0);
  });

  it('visits older than the horizon fall out of the window', () => {
    const out = run([
      ['youtube', 'vis', 0],
      ['x', 'vis', 10 * SEC],           // switch — but ancient by the end
      ['youtube', 'vis', 12 * MIN],     // beyond HORIZON of the first two
      ['x', 'vis', 12 * MIN + 10 * SEC],
      ['youtube', 'vis', 12 * MIN + 20 * SEC],
    ]);
    // Only 2 switches survive in the window — no nudge.
    expect(out[4].nudge).toBe(false);
    expect(out[4].churn).toBe(2);
  });
});

describe('RaiHops — snooze and arming', () => {
  it('suppresses during snooze, fires again after it expires', () => {
    const hop = (ts) => [
      ['youtube', 'vis', ts],
      ['x', 'vis', ts + 10 * SEC],
      ['youtube', 'vis', ts + 20 * SEC],
      ['x', 'vis', ts + 30 * SEC],
    ];
    let out = run(hop(0));
    expect(out[3].nudge).toBe(true);
    let state = out[3].state;

    // Immediately keep hopping — snoozed, must not re-fire.
    out = run(hop(1 * MIN), { state });
    expect(out.every((s) => !s.nudge)).toBe(true);
    state = out[3].state;

    // Well past the snooze — a fresh loop fires again.
    out = run(hop(Hops.SNOOZE_MS + 15 * MIN), { state });
    expect(out[3].nudge).toBe(true);
  });

  it('explicit snooze() clears events and holds until the given ts', () => {
    const state = Hops.snooze(Hops.emptyState(), T0 + 60 * MIN);
    const out = run([
      ['youtube', 'vis', 0],
      ['x', 'vis', 10 * SEC],
      ['youtube', 'vis', 20 * SEC],
      ['x', 'vis', 30 * SEC],
    ], { state });
    expect(out.every((s) => !s.nudge)).toBe(true);
  });

  it('disarmed (nudge toggled off) records visits but never fires', () => {
    const out = run([
      ['youtube', 'vis', 0],
      ['x', 'vis', 10 * SEC],
      ['youtube', 'vis', 20 * SEC],
      ['x', 'vis', 30 * SEC],
    ], { armed: false });
    expect(out[3].nudge).toBe(false);
    expect(out[3].churn).toBe(3);            // still counted...
    expect(out[3].state.events.length).toBe(4); // ...and retained for the other platform
  });

  it('state survives a JSON round-trip (chrome.storage.local shape)', () => {
    const out = run([
      ['youtube', 'load', 0],
      ['x', 'vis', 10 * SEC],
    ]);
    const revived = JSON.parse(JSON.stringify(out[1].state));
    const res = Hops.evaluate(revived, { p: 'youtube', e: 'vis' }, T0 + 20 * SEC, true);
    expect(res.churn).toBe(2);
  });

  it('garbage state fails open to empty (never throws, never insta-fires)', () => {
    for (const bad of [null, undefined, {}, { events: 'nope' }, 42]) {
      const res = Hops.evaluate(bad, { p: 'x', e: 'load' }, T0, true);
      expect(res.nudge).toBe(false);
      expect(res.state.events.length).toBe(1);
    }
  });
});
