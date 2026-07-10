// Daily digest — deterministic assembly over events-*.jsonl fixtures.
// Pinned invariants: same-day read sessions collapse into one summed row,
// watch partials collapse via MAX(seconds), repeats = same tweetId on an
// EARLIER date only, and rendering never throws on sparse rows.
// --analyze (codex shell-out) is deliberately untested.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEvents, assemble, collapseReads, collapseWatches, readRepeats, renderMarkdown } from '../scripts/digest.js';

function makeDataDir(xEvents, ytEvents) {
  const dir = mkdtempSync(join(tmpdir(), 'xrai-digest-'));
  if (xEvents) writeFileSync(join(dir, 'events-x.jsonl'), xEvents.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (ytEvents) writeFileSync(join(dir, 'events-youtube.jsonl'), ytEvents.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

const X = [
  { platform: 'x', kind: 'read', tweetId: '1', author: 'a', text: 'claude agent harness', decision: 'shown', source: 'model', dwellMs: 8000, date: '2026-07-09' },
  { platform: 'x', kind: 'read', tweetId: '1', author: 'a', text: 'claude agent harness', decision: 'shown', source: 'model', dwellMs: 4000, date: '2026-07-09' }, // second same-day session
  { platform: 'x', kind: 'read', tweetId: '2', author: 'b', text: 'status page deep read', decision: 'reading', source: 'off-home', dwellMs: 45000, date: '2026-07-09' },
  { platform: 'x', kind: 'read', tweetId: '1', author: 'a', text: 'claude agent harness', decision: 'shown', source: 'model', dwellMs: 3000, date: '2026-07-07' }, // earlier date → repeat
  { platform: 'x', kind: 'read', tweetId: '3', author: 'c', text: 'unrelated', decision: 'shown', source: 'model', dwellMs: 2000, date: '2026-07-08' }, // other day only
];

const YT = [
  { platform: 'youtube', kind: 'watch', videoId: 'v1', title: 'Song', channel: 'Ch', seconds: 30, partial: true, date: '2026-07-09' },
  { platform: 'youtube', kind: 'watch', videoId: 'v1', title: 'Song', channel: 'Ch', seconds: 90, partial: true, date: '2026-07-09' },
  { platform: 'youtube', kind: 'watch', videoId: 'v1', title: 'Song', channel: 'Ch', seconds: 112, partial: false, date: '2026-07-09' },
  { platform: 'youtube', kind: 'watch', videoId: 'v2', title: '', channel: '', seconds: 10, partial: false, date: '2026-07-09' },
];

describe('digest assembly', () => {
  const dir = makeDataDir(X, YT);
  const events = loadEvents(dir);
  const a = assemble(events, '2026-07-09', new Map());

  it('loads both platform files', () => {
    expect(events.length).toBe(X.length + YT.length);
  });

  it('collapses same-day read sessions into one summed row, sorted by dwell', () => {
    expect(a.reads.length).toBe(2);
    expect(a.reads[0]).toMatchObject({ tweetId: '2', dwellMs: 45000 }); // dwell-desc
    expect(a.reads[1]).toMatchObject({ tweetId: '1', dwellMs: 12000, sessions: 2 });
  });

  it('collapses watch partials via MAX(seconds), one row per video', () => {
    expect(a.watches.length).toBe(2);
    expect(a.watches[0]).toMatchObject({ videoId: 'v1', seconds: 112 });
  });

  it('flags repeats only for earlier dates, not same-day sessions', () => {
    expect(a.repeats.length).toBe(1);
    expect(a.repeats[0].tweetId).toBe('1');
    expect(a.repeats[0].earlierDates).toEqual(['2026-07-07']);
  });

  it('totals are computed over collapsed rows', () => {
    expect(a.totals).toMatchObject({ readCount: 2, readAuthors: 2, readDwellMs: 57000, watchCount: 2, watchSeconds: 122 });
    expect(a.totals.perChannel['Ch']).toBe(112);
  });

  it('renders markdown with all sections and survives sparse rows', () => {
    const md = renderMarkdown(a);
    expect(md).toContain('# Attention ledger — 2026-07-09');
    expect(md).toContain('## Read on X');
    expect(md).toContain('## Watched on YouTube');
    expect(md).toContain('## Repeats');
    expect(md).toContain('(unknown channel)'); // v2 has no channel
  });

  it('a day with no events assembles empty, not throwing', () => {
    const empty = assemble(events, '2026-01-01', new Map());
    expect(empty.reads).toEqual([]);
    expect(empty.watches).toEqual([]);
    expect(empty.repeats).toEqual([]);
  });

  it('missing files load as empty', () => {
    expect(loadEvents(mkdtempSync(join(tmpdir(), 'xrai-empty-')))).toEqual([]);
  });
});
