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
    const pins = {
      'x-043': 'clickbait-phrase', // "You won't believe what happened next 🤯"
      'x-044': 'engagement-bait',  // "Follow me for daily motivation 💪..."
      'x-046': 'spam',             // "I made $10k in my first month with this one simple trick..."
      'x-080': 'crypto-pump',      // "2098x 209,700% gain in one call..."
    };
    for (const [id, reason] of Object.entries(pins)) {
      const item = golden.items.find((i) => i.id === id);
      const r = prefilter.prefilter(toPrefilterData(item));
      expect(r?.reason).toBe(reason);
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
    expect(sha(worker.X_CLASSIFY_SYSTEM)).toBe('c8b70eecf243a9a8');
  });

  it('X config defaults are pinned', () => {
    expect(defaults.x.confidenceThreshold).toBe(0.7);
    expect(defaults.x.model).toBe('dhiltgen/gemma4:e2b-mlx-bf16');
    expect(defaults.x.contentFilter).toBe('posts-only');
  });
});
