// Tips ledger — fast, no-Ollama checks for detection + lifecycle.
// Detection is deliberately high-recall: it only sees SHOWN tweets, so the
// classifier (which hides funnel bait) is the precision layer, and the
// ledger's mark step is the value judgment. These tests pin the recall floor
// and the invariant that plain noise never looks tip-shaped.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTips as loadXraiTips, loadGolden } from '../benchmarks/load-extension.js';
import { loadTips, loadStatuses, setStatus, resolveTweetId, digest } from '../scripts/tips.js';

const tips = loadXraiTips();
const golden = loadGolden();
const text = (id) => golden.items.find((i) => i.id === id).text;

describe('XraiTips.isTip vs golden set', () => {
  // Recall floor: tweets a tips ledger obviously must capture.
  const MUST_CAPTURE = [
    'x-014', // OpenClaw MCP — "use it instead of"
    'x-016', // Figma MCP workflow — "something new I'm trying"
    'x-027', // structured outputs tip
    'x-114', // "share my 3 key loops"
    'x-115', // whisper.cpp fact-check method
    'x-117', // open-sourced agent harness
  ];
  it('captures known tip-shaped signal', () => {
    for (const id of MUST_CAPTURE) {
      expect(tips.isTip(text(id)), `${id} should be a tip`).toBe(true);
    }
  });

  it('ignores non-tip signal (aphorisms, commentary without a named tool)', () => {
    for (const id of ['x-010', 'x-011', 'x-012']) {
      expect(tips.isTip(text(id)), `${id} should NOT be a tip`).toBe(false);
    }
  });

  it('never fires on plain-noise tier (tempting-noise excluded: the model hides those before capture)', () => {
    const hits = golden.items.filter((i) => i.tier === 'noise' && tips.isTip(i.text));
    expect(hits.map((i) => i.id)).toEqual([]);
  });

  it('rejects one-liners even with tool words', () => {
    expect(tips.isTip('use claude code')).toBe(false);
    expect(tips.isTip('')).toBe(false);
  });
});

describe('tips ledger lifecycle', () => {
  function makeLedger(records) {
    const dir = mkdtempSync(join(tmpdir(), 'xrai-tips-'));
    writeFileSync(join(dir, 'tips.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return dir;
  }
  const RECORDS = [
    { tweetId: '1001', author: 'a', text: 'tip one', capturedAt: 1000 },
    { tweetId: '1002', author: 'b', text: 'tip two', capturedAt: 2000 },
    { tweetId: '2001', author: 'c', text: 'tip three', capturedAt: 3000 },
  ];

  it('loads and dedupes intake by tweetId', () => {
    const dir = makeLedger([...RECORDS, { tweetId: '1001', author: 'a', text: 'dupe replay' }]);
    expect(loadTips(dir).length).toBe(3);
    rmSync(dir, { recursive: true });
  });

  it('mark → digest drops resolved, floats useful above unread', () => {
    const dir = makeLedger(RECORDS);
    setStatus(dir, '1001', 'useful', 'evaluate against AlgorithmFloor');
    setStatus(dir, '1002', 'implemented');
    const d = digest(loadTips(dir), loadStatuses(dir));
    expect(d.map((t) => t.tweetId)).toEqual(['1001', '2001']); // useful first, implemented gone
    expect(d[0].status).toBe('useful');
    expect(d[0].note).toBe('evaluate against AlgorithmFloor');
    expect(d[1].status).toBe('new');
    rmSync(dir, { recursive: true });
  });

  it('rejects unknown statuses and ambiguous id prefixes', () => {
    const dir = makeLedger(RECORDS);
    expect(() => setStatus(dir, '1001', 'meh')).toThrow();
    const loaded = loadTips(dir);
    expect(() => resolveTweetId(loaded, '10')).toThrow(); // 1001 vs 1002
    expect(resolveTweetId(loaded, '20')).toBe('2001');
    expect(() => resolveTweetId(loaded, '999')).toThrow();
    rmSync(dir, { recursive: true });
  });
});
