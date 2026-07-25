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

// Inline fixtures (formerly golden v1 ids — golden v2 is live-traffic data, so
// these recall-floor texts live here now instead of coupling to the eval set).
const MUST_CAPTURE = {
  'openclaw-mcp': 'The next version of OpenClaw is also an MCP, you can use it instead of Anthropic\'s message channel MCP to connect to a much wider range of message providers.',
  'figma-mcp-workflow': 'the more I\'ve been digging into the new Figma MCP, the more excited I am about it. something new I\'m trying is starting with a very ugly sketch in Figma, and then having Claude Code flesh it out in Figma so I can tweak and edit before sending the final back to Claude Code',
  'structured-outputs': 'Structured outputs are the most underrated feature in LLM APIs. Stop parsing markdown. Just define a schema.',
  'three-key-loops': '"Loop engineering" is a hot buzzphrase after mentions of it by Boris Cherny and Peter Steinberger went viral. In this letter, I\'d like to share my 3 key loops for building 0-to-1 products: the agentic coding loop (minutes), the developer feedback loop (tens of minutes to hours), and the external feedback loop (hours to weeks). Over the weekend I built a typing app for my daughter and my coding agent worked for an hour, testing in a browser, before getting back to me.',
  'whisper-fact-check': 'I fact-checked 6 viral AI threads this week: transcribed 58 minutes of video with whisper.cpp, pulled both long-form articles, checked every claim. Scoreboard: 2 real, 2 funnels, 1 fake credential, 1 fabricated quote. Full method and transcripts in the writeup: kuanyu.dev/feed-audit',
  'agent-harness-oss': 'We just open-sourced our agent harness on GitHub - 47 deterministic checks plus an adversarial review pass, MIT licensed. Join our Discord if you want to contribute, PRs welcome. Benchmarks against SWE-bench in the README.',
};
const NON_TIP_SIGNAL = {
  'sqlite-take': 'SQLite can handle 100k+ concurrent readers. Most apps don\'t need Postgres. We switched and our infrastructure cost dropped to $0.',
  'trust-aphorism': 'Just because someone trusts you quickly doesn\'t mean you need to trust them quickly. It\'s a more advanced manipulation move, typically from people who need something from you.',
  'sold-back-rant': 'The sun was free. They sold you SPF 50 and a vitamin D deficiency. Sleep was free. They sold you an app, a pill, and a wearable that tells you your sleep was bad. Walking was free. They sold you a treadmill, a fitness tracker, and a £180 pair of trainers. Fasting was free. They sold you meal replacement shakes and the anxiety that skipping breakfast would wreck your metabolism. The 20th century removed access to everything the body needs to function. The 21st century is selling it back, one subscription at a time.',
};

describe('XraiTips.isTip vs golden set', () => {
  it('captures known tip-shaped signal', () => {
    for (const [name, text] of Object.entries(MUST_CAPTURE)) {
      expect(tips.isTip(text), `${name} should be a tip`).toBe(true);
    }
  });

  it('ignores non-tip signal (aphorisms, commentary without a named tool)', () => {
    for (const [name, text] of Object.entries(NON_TIP_SIGNAL)) {
      expect(tips.isTip(text), `${name} should NOT be a tip`).toBe(false);
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
