// Fast, no-Ollama regression checks. These pin the deterministic parts of the
// X pipeline so a "small tweak" can't silently change filtering behavior.
// The model-in-the-loop eval lives in benchmarks/eval-x.js (needs Ollama).
import { describe, it, expect } from 'bun:test';
import {
  loadPrefilter,
  loadWorker,
  loadConfigDefaults,
  loadGolden,
  toPrefilterData,
  decide,
  isSignalTier,
  sha,
} from '../benchmarks/load-extension.js';

const prefilter = loadPrefilter();
const worker = loadWorker();
const defaults = loadConfigDefaults();
const golden = loadGolden();

// ─── Prefilter invariants ───────────────────────────────────────────────────
// A prefilter false-hide is the worst failure class: deterministic, silent,
// and it bypasses the confidence threshold entirely. This test is a ratchet:
// it fails if any NEW signal item gets prefiltered, and also fails if a
// known false-hide gets fixed without being removed from the list below.

// Known prefilter false-hides — signal tweets the prefilter currently kills.
// Each entry is a BUG to fix, not an acceptance. Fix the regex, then remove
// the id here. (x-012 was the last one — fixed 2026-07-06 by requiring a 2nd
// distinct ENTERTAINMENT_NOISE term before hiding long-form text.)
const KNOWN_PREFILTER_FALSE_HIDES = [];

describe('prefilter vs golden set', () => {
  it('never prefilters signal (ratchet: see KNOWN_PREFILTER_FALSE_HIDES)', () => {
    const hit = [];
    for (const item of golden.items) {
      if (!isSignalTier(item.tier)) continue;
      const r = prefilter.prefilter(toPrefilterData(item));
      if (r) hit.push(`${item.id} [${r.reason}] "${item.text.slice(0, 60)}"`);
    }
    const unexpected = hit.filter((h) => !KNOWN_PREFILTER_FALSE_HIDES.some((id) => h.startsWith(id)));
    expect(unexpected).toEqual([]);
    // Ratchet the other way: if a known false-hide is fixed, remove it from the list
    for (const id of KNOWN_PREFILTER_FALSE_HIDES) {
      expect(hit.some((h) => h.startsWith(id))).toBe(true);
    }
  });

  it('never prefilters critical-signal, no exceptions', () => {
    for (const item of golden.items) {
      if (item.tier !== 'critical-signal') continue;
      const r = prefilter.prefilter(toPrefilterData(item));
      expect(r === null ? null : `${item.id} killed by ${r.reason}`).toBe(null);
    }
  });

  it('still catches the pinned noise cases', () => {
    // Golden v2 (live-traffic) items — re-pinned when v1 synthetic ids retired.
    const pins = {
      'live-2070538368174223674': 'engagement-bait', // "If you don't wake up excited and go to bed tired, drop everything..."
      'live-2071159146200863121': 'entertainment',   // "Woman drinking bubble tea on MRT platform sparks debate..."
      'live-2075804235191714160': 'spam',            // "You won't get rich just working hard..."
      'live-2076434411600425060': 'funnel-bait',     // "I ranked India's most famous tourist attractions..."
    };
    for (const [id, reason] of Object.entries(pins)) {
      const item = golden.items.find((i) => i.id === id);
      const r = prefilter.prefilter(toPrefilterData(item));
      expect(r?.reason).toBe(reason);
    }
  });

  it('passes recent live signal false-hides to the model', () => {
    const recentSignal = [
      "building is 10x easier now. figuring out what's worth building isn't.",
      'Why is the search and discoverability of people that I already follow so hard on Twitter.',
      'Hotels made for people who care about sleep, fitness and workout. All beds use sleep mattresses, AC goes cold, air purifiers are everywhere, and the restaurant serves longevity food. The gym has proper weights and ergs, there are daily classes, and there is a quiet laptop-friendly working space for people building companies.',
      'NVIDIA is making a substantial investment in SSI that will let us 10x our compute in the next 12 months.',
      'Software is becoming malleable. This allows us to move 10x faster than before.',
    ];
    for (const text of recentSignal) {
      expect(prefilter.prefilter({ text, hasMedia: false })).toBe(null);
    }
  });
});

// ─── Parser: must fail OPEN (shown), never fail closed ─────────────────────
describe('parseXClassification', () => {
  const threshold = defaults.x.confidenceThreshold;

  it('parses valid output', () => {
    const r = worker.parseXClassification('{"prediction":"signal","confidence":0.9,"reason":"specific numbers"}');
    expect(r).toEqual({ prediction: 'signal', confidence: 0.9, reason: 'specific numbers' });
  });

  it('garbage output falls back to noise@0.5 — which is SHOWN at the default threshold', () => {
    for (const raw of ['total garbage', 'I think this is noise because it is vague', '{"prediction":"noise","confidence":"high"}']) {
      const r = worker.parseXClassification(raw);
      expect(r.confidence).toBe(0.5);
      expect(decide(null, r, threshold).decision).toBe('shown');
    }
  });
});

// ─── Decision logic: threshold edges (mirrors main.js handleTweet) ─────────
describe('decide()', () => {
  const t = defaults.x.confidenceThreshold;

  it('hides noise at/above threshold, shows below', () => {
    expect(decide(null, { prediction: 'noise', confidence: t }, t).decision).toBe('hidden');
    expect(decide(null, { prediction: 'noise', confidence: t - 0.01 }, t).decision).toBe('shown');
    expect(decide(null, { prediction: 'signal', confidence: 0.99 }, t).decision).toBe('shown');
  });

  it('prefilter hides UNCONDITIONALLY — the threshold is never consulted', () => {
    // This is current production behavior. If you make the prefilter respect
    // the threshold (probably a good idea), update this test + main.js together.
    const r = decide({ prediction: 'noise', confidence: 0.1, reason: 'spam' }, null, t);
    expect(r.decision).toBe('hidden');
  });
});

// ─── Drift pins: prompt + config ────────────────────────────────────────────
// If either fails, the change may be intentional — but it changes what gets
// hidden. Re-run `node benchmarks/eval-x.js`, review the metrics, then
// `--bless` a new baseline and update the pin.
describe('drift pins', () => {
  it('X classify prompt is pinned', () => {
    expect(sha(worker.X_CLASSIFY_SYSTEM)).toBe('7fed6a900f019b71');
  });

  it('X config defaults are pinned', () => {
    expect(defaults.x.confidenceThreshold).toBe(0.7);
    expect(defaults.x.model).toBe('dhiltgen/gemma4:e2b-mlx-bf16');
    expect(defaults.x.contentFilter).toBe('posts-only');
    expect(defaults.x.imageBaitEnabled).toBe(false);
    expect(defaults.youtube.imageBaitEnabled).toBe(false);
  });
});
