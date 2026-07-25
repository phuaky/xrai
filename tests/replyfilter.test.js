// Fast, no-Ollama pins for the X reply guard (own-status-page bad-faith
// filtering). Guards the invariant that matters most here: a genuine reply —
// including harsh, skeptical, on-topic pushback — is NEVER deterministically
// hidden. The model-in-the-loop reply eval is deliberately deferred until the
// durable log accumulates real surface:'own-replies' data (see ISA).
import { describe, it, expect } from 'bun:test';
import {
  loadPrefilter,
  loadReplyRoute,
  loadWorker,
  loadConfigDefaults,
  loadGoldenReplies,
  toReplyPrefilterData,
  decideReply,
  isReplyKeepTier,
  sha,
} from '../benchmarks/load-extension.js';

const prefilter = loadPrefilter();
const route = loadReplyRoute();
const worker = loadWorker();
const defaults = loadConfigDefaults();
const golden = loadGoldenReplies();

const OWN = defaults.x.ownHandle;

// ─── Prefilter: never fires on genuine or tempting-bad-faith replies ────────
// A reply-prefilter false-hide is the worst failure class: deterministic,
// silent, bypasses the threshold — and on your OWN posts it can hide a lead.
// Ratchet: same discipline as KNOWN_PREFILTER_FALSE_HIDES in regression.test.js.
const KNOWN_REPLY_FALSE_HIDES = [];

describe('prefilterReply vs golden replies', () => {
  it('never fires on genuine or tempting-bad-faith tiers (the anti-echo-chamber pin)', () => {
    const hit = [];
    for (const item of golden.items) {
      if (!isReplyKeepTier(item.tier)) continue;
      const r = prefilter.prefilterReply(toReplyPrefilterData(item));
      if (r) hit.push(`${item.id} [${r.reason}] "${item.text.slice(0, 60)}"`);
    }
    const unexpected = hit.filter((h) => !KNOWN_REPLY_FALSE_HIDES.some((id) => h.startsWith(id)));
    expect(unexpected).toEqual([]);
    for (const id of KNOWN_REPLY_FALSE_HIDES) {
      expect(hit.some((h) => h.startsWith(id))).toBe(true);
    }
  });

  it('catches the real Jul 22 slur reply (reply-001) as hostile', () => {
    const item = golden.items.find((i) => i.id === 'reply-001');
    const r = prefilter.prefilterReply(toReplyPrefilterData(item));
    expect(r?.verdict).toBe('hostile');
  });

  it('catches the pinned spam/hostile cases', () => {
    const pins = {
      'reply-002': 'hostile', // kys
      'reply-003': 'spam',    // grow-your-account reply bot
      'reply-005': 'spam',    // wallet-drop airdrop
      'reply-007': 'hostile', // slur + go-back-to-your-country
    };
    for (const [id, verdict] of Object.entries(pins)) {
      const item = golden.items.find((i) => i.id === id);
      const r = prefilter.prefilterReply(toReplyPrefilterData(item));
      expect(r?.verdict).toBe(verdict);
    }
  });

  it('empty/media-only replies pass to the model, never prefiltered', () => {
    expect(prefilter.prefilterReply({ text: '' })).toBe(null);
    expect(prefilter.prefilterReply({})).toBe(null);
  });
});

// ─── Routing immunity: main tweet, own author, non-own pages ────────────────
describe('XraiReplyRoute', () => {
  it('activates only on the own status page', () => {
    expect(route.guardPage(`/${OWN}/status/123`, OWN)).toEqual({ handle: OWN, statusId: '123' });
    expect(route.guardPage(`/${OWN.toUpperCase()}/status/123`, OWN)).not.toBe(null); // case-insensitive
    expect(route.guardPage(`/${OWN}/status/123/photo/1`, OWN)).not.toBe(null);
    expect(route.guardPage('/someoneelse/status/123', OWN)).toBe(null);
    expect(route.guardPage('/home', OWN)).toBe(null);
    expect(route.guardPage(`/${OWN}`, OWN)).toBe(null);
    expect(route.guardPage(`/${OWN}/status/123`, '')).toBe(null); // no handle configured → off
  });

  it('main tweet is immune whatever its content', () => {
    const page = { handle: OWN, statusId: '999' };
    expect(route.shouldGuard({ id: '999', author: OWN }, page, OWN)).toBe(false);
  });

  it("the user's own replies in the thread are immune", () => {
    const page = { handle: OWN, statusId: '999' };
    expect(route.shouldGuard({ id: '1000', author: OWN }, page, OWN)).toBe(false);
    expect(route.shouldGuard({ id: '1000', author: OWN.toUpperCase() }, page, OWN)).toBe(false);
  });

  it('other authors\' replies are guarded', () => {
    const page = { handle: OWN, statusId: '999' };
    expect(route.shouldGuard({ id: '1000', author: 'sometroll' }, page, OWN)).toBe(true);
  });
});

// ─── Parser: must fail OPEN (shown), never fail closed ─────────────────────
describe('parseReplyClassification', () => {
  const threshold = defaults.x.replyConfidenceThreshold;

  it('parses valid output', () => {
    expect(worker.parseReplyClassification('{"verdict":"hostile","confidence":0.9}'))
      .toEqual({ verdict: 'hostile', confidence: 0.9 });
    expect(worker.parseReplyClassification('{"verdict":"spam","confidence":0.8}'))
      .toEqual({ verdict: 'spam', confidence: 0.8 });
  });

  it('garbage output falls back to fine@0.5 — the reply is SHOWN', () => {
    for (const raw of ['lol whatever', 'this reply seems hostile to me', '{"verdict":"hostile","confidence":"high"}']) {
      const r = worker.parseReplyClassification(raw);
      expect(decideReply(null, r, threshold).decision).toBe('shown');
    }
  });

  it('unknown verdict labels are treated as fine (shown), even at high confidence', () => {
    const r = worker.parseReplyClassification('{"verdict":"angry","confidence":0.95}');
    expect(r.verdict).toBe('fine');
    expect(decideReply(null, r, threshold).decision).toBe('shown');
  });
});

// ─── Decision logic: threshold edges (mirrors main.js replyVerdictOf) ──────
describe('decideReply()', () => {
  const t = defaults.x.replyConfidenceThreshold;

  it('blurs bad verdicts at/above threshold, shows below', () => {
    expect(decideReply(null, { verdict: 'hostile', confidence: t }, t).decision).toBe('blurred');
    expect(decideReply(null, { verdict: 'hostile', confidence: t - 0.01 }, t).decision).toBe('shown');
    expect(decideReply(null, { verdict: 'fine', confidence: 0.99 }, t).decision).toBe('shown');
  });

  it('prefilter blurs UNCONDITIONALLY — the threshold is never consulted', () => {
    const r = decideReply({ verdict: 'spam', confidence: 0.1 }, null, t);
    expect(r.decision).toBe('blurred');
  });
});

// ─── Golden set shape ───────────────────────────────────────────────────────
describe('golden-replies-x.json', () => {
  it('has ≥20 items across all three tiers, seeded with the real Jul 22 replies', () => {
    expect(golden.items.length).toBeGreaterThanOrEqual(20);
    const tiers = new Set(golden.items.map((i) => i.tier));
    expect(tiers).toEqual(new Set(['bad-faith', 'tempting-bad-faith', 'genuine']));
    // The three real replies from the post that motivated this feature:
    expect(golden.items.find((i) => i.author === 'lik3icar3_1')?.tier).toBe('bad-faith');
    expect(golden.items.find((i) => i.author === 'GeliMat22')?.expected).toBe('shown');
    expect(golden.items.find((i) => i.author === 'naygozalova')?.tier).toBe('genuine');
  });

  it('tempting-bad-faith is always expected shown — sentiment is not a signal', () => {
    for (const item of golden.items) {
      if (item.tier === 'tempting-bad-faith') expect(item.expected).toBe('shown');
    }
  });
});

// ─── Drift pins: prompt + config ────────────────────────────────────────────
describe('reply-guard drift pins', () => {
  it('X reply prompt is pinned', () => {
    expect(sha(worker.X_REPLY_SYSTEM)).toBe('d29e91b495988766');
  });

  it('reply-guard config defaults are pinned', () => {
    expect(defaults.x.replyGuard).toBe(true);
    expect(defaults.x.ownHandle).toBe('phuakuanyu');
    expect(defaults.x.replyConfidenceThreshold).toBe(0.7);
  });

  it('Anti (ISC-33): the feed prompt is untouched by this feature', () => {
    expect(sha(worker.X_CLASSIFY_SYSTEM)).toBe('c8b70eecf243a9a8');
  });
});
