#!/usr/bin/env node

// rai Daily Digest — the attention ledger's output.
//
// Reads data/events-<platform>.jsonl (written by the collector's /events
// endpoint from RaiDwell {kind:'read'} + YtraiWatch {kind:'watch'} records)
// and assembles a saved daily record of what was actually READ and WATCHED:
// totals, per-item lists, and exact repeats across days.
//
// The CLI is deterministic (same philosophy as tips.js). Goal-mapping,
// themes, semantic repeats, and "worth deeper processing" are an LLM's job:
// --analyze shells out to `codex exec -s read-only` with a self-contained
// prompt (day's items + TELOS/GOALS.md) and appends the result.
//
// Usage:
//   node scripts/digest.js [YYYY-MM-DD]             # assemble + write data/daily/<date>.md
//   node scripts/digest.js [YYYY-MM-DD] --analyze   # + goal-mapping analysis via codex
//   node scripts/digest.js [YYYY-MM-DD] --json      # machine-readable assembly (for kyu)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const GOALS_FILE = path.join(os.homedir(), '.claude', 'PAI', 'USER', 'TELOS', 'GOALS.md');

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
  }
  return rows;
}

function loadEvents(dir) {
  const d = dir || DEFAULT_DATA_DIR;
  return [
    ...loadJsonl(path.join(d, 'events-x.jsonl')),
    ...loadJsonl(path.join(d, 'events-youtube.jsonl')),
  ];
}

// Defensive enrichment: classifications-x.jsonl rows currently carry NO
// tweetId (logClassification never included it), so this map is empty today
// and reads rely on their own decision/source fields. If the classification
// log ever gains tweetId, model reason/confidence join in automatically.
function loadClassificationMap(dir) {
  const map = new Map();
  for (const row of loadJsonl(path.join(dir || DEFAULT_DATA_DIR, 'classifications-x.jsonl'))) {
    if (row.tweetId) map.set(String(row.tweetId), row);
  }
  return map;
}

// One row per tweetId for the day; multiple same-day read sessions sum.
function collapseReads(events, dateStr) {
  const rows = new Map();
  for (const e of events) {
    if (e.kind !== 'read' || e.date !== dateStr || !e.tweetId) continue;
    const id = String(e.tweetId);
    const r = rows.get(id);
    if (r) {
      r.dwellMs += e.dwellMs || 0;
      r.sessions++;
    } else {
      rows.set(id, {
        tweetId: id, author: e.author, text: e.text,
        decision: e.decision, source: e.source,
        dwellMs: e.dwellMs || 0, sessions: 1,
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.dwellMs - a.dwellMs);
}

// One row per videoId for the day; partials carry cumulative seconds → MAX wins.
function collapseWatches(events, dateStr) {
  const rows = new Map();
  for (const e of events) {
    if (e.kind !== 'watch' || e.date !== dateStr || !e.videoId) continue;
    const id = String(e.videoId);
    const r = rows.get(id);
    if (r) {
      r.seconds = Math.max(r.seconds, e.seconds || 0);
      if (!r.title && e.title) r.title = e.title;
      if (!r.channel && e.channel) r.channel = e.channel;
    } else {
      rows.set(id, { videoId: id, title: e.title || '', channel: e.channel || '', seconds: e.seconds || 0 });
    }
  }
  return [...rows.values()].sort((a, b) => b.seconds - a.seconds);
}

// Today's reads that were also read on an earlier date — the "you've seen
// this before" signal (exact id match; same-idea-reworded is --analyze's job).
function readRepeats(events, todayReads, dateStr) {
  const datesById = new Map();
  for (const e of events) {
    if (e.kind !== 'read' || !e.tweetId || !e.date) continue;
    const id = String(e.tweetId);
    if (!datesById.has(id)) datesById.set(id, new Set());
    datesById.get(id).add(e.date);
  }
  return todayReads
    .map((r) => {
      const earlier = [...(datesById.get(r.tweetId) || [])].filter((d) => d < dateStr).sort();
      return earlier.length ? { ...r, earlierDates: earlier } : null;
    })
    .filter(Boolean);
}

function assemble(events, dateStr, classificationMap) {
  const reads = collapseReads(events, dateStr).map((r) => {
    const c = classificationMap && classificationMap.get(r.tweetId);
    return c ? { ...r, prediction: c.prediction, confidence: c.confidence, reason: c.reason } : r;
  });
  const watches = collapseWatches(events, dateStr);
  const perChannel = {};
  for (const w of watches) {
    const ch = w.channel || '(unknown channel)';
    perChannel[ch] = (perChannel[ch] || 0) + w.seconds;
  }
  return {
    date: dateStr,
    reads,
    watches,
    repeats: readRepeats(events, reads, dateStr),
    totals: {
      readCount: reads.length,
      readAuthors: new Set(reads.map((r) => r.author).filter(Boolean)).size,
      readDwellMs: reads.reduce((s, r) => s + r.dwellMs, 0),
      watchCount: watches.length,
      watchSeconds: watches.reduce((s, w) => s + w.seconds, 0),
      perChannel,
    },
  };
}

function fmtMin(ms) {
  const m = ms / 60000;
  return m >= 1 ? Math.round(m) + 'm' : Math.round(ms / 1000) + 's';
}

function fmtSec(s) {
  return s >= 60 ? Math.round(s / 60) + 'm' : Math.round(s) + 's';
}

function oneLine(t, n) {
  return (t || '').replace(/\s+/g, ' ').slice(0, n || 100);
}

function renderMarkdown(a) {
  const L = [];
  L.push(`# Attention ledger — ${a.date}`);
  L.push('');
  L.push('## Totals');
  L.push(`- X: ${a.totals.readCount} tweets read (${a.totals.readAuthors} authors), ${fmtMin(a.totals.readDwellMs)} total dwell`);
  L.push(`- YouTube: ${a.totals.watchCount} videos, ${fmtSec(a.totals.watchSeconds)} watched`);
  for (const [ch, s] of Object.entries(a.totals.perChannel).sort((x, y) => y[1] - x[1])) {
    L.push(`  - ${ch}: ${fmtSec(s)}`);
  }
  if (a.reads.length) {
    L.push('');
    L.push('## Read on X (by dwell)');
    for (const r of a.reads) {
      L.push(`- ${fmtMin(r.dwellMs)} @${r.author || '?'} [${r.decision}/${r.source}] — ${oneLine(r.text, 110)}`);
    }
  }
  if (a.watches.length) {
    L.push('');
    L.push('## Watched on YouTube');
    for (const w of a.watches) {
      L.push(`- ${fmtSec(w.seconds)} ${w.channel || '?'} — ${oneLine(w.title, 110)}`);
    }
  }
  if (a.repeats.length) {
    L.push('');
    L.push('## Repeats — read before (reminder, not new information)');
    for (const r of a.repeats) {
      L.push(`- @${r.author || '?'} — ${oneLine(r.text, 90)} (also read: ${r.earlierDates.join(', ')})`);
    }
  }
  L.push('');
  return L.join('\n');
}

function buildAnalysisPrompt(a) {
  let goals = '';
  try { goals = fs.readFileSync(GOALS_FILE, 'utf8'); } catch (e) { /* no goals file */ }
  return [
    'You are analyzing one day of social-media attention data for Kuan.',
    'Below are (1) his active goals and (2) everything he actually read on X and watched on YouTube today, with time spent.',
    '',
    'Return ONLY markdown, starting with "## Analysis", with these subsections:',
    '- **Goal mapping** — which items serve which active goal (cite goal IDs like G17). Be strict: most feed content serves nothing.',
    '- **Themes** — the 3-5 topics today\'s attention actually went to, with rough time share.',
    '- **Semantic repeats** — items that are the same idea reworded (different tweets, same insight). Name them so re-reading can be skipped next time.',
    '- **Worth deeper processing** — at most 3 items worth a deliberate follow-up, and why. Skip the section if nothing qualifies.',
    '- **Gaps** — active goals that got ZERO relevant intake today.',
    '',
    goals ? '=== ACTIVE GOALS (TELOS/GOALS.md) ===\n' + goals : '(GOALS.md not found — skip the Goal mapping and Gaps sections.)',
    '',
    '=== TODAY\'S ATTENTION DATA ===',
    JSON.stringify({ date: a.date, totals: a.totals, reads: a.reads, watches: a.watches, repeats: a.repeats }, null, 1),
  ].join('\n');
}

function runAnalysis(a) {
  const prompt = buildAnalysisPrompt(a);
  const res = spawnSync('codex', ['exec', '-s', 'read-only', prompt], {
    encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    console.error('[digest] codex exec failed:', res.error ? res.error.message : (res.stderr || '').slice(-500));
    return null;
  }
  const out = (res.stdout || '').trim();
  // codex exec prints session preamble before the reply — keep from the
  // "## Analysis" marker we demanded, or the whole output as fallback.
  const i = out.indexOf('## Analysis');
  return i >= 0 ? out.slice(i) : out;
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((x) => x.startsWith('--'));
  const dateStr = args.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) || todayStr();
  const dir = DEFAULT_DATA_DIR;

  const a = assemble(loadEvents(dir), dateStr, loadClassificationMap(dir));

  if (flags.includes('--json')) {
    console.log(JSON.stringify(a, null, 2));
    return;
  }

  if (!a.reads.length && !a.watches.length) {
    console.log(`No attention events for ${dateStr}. (Is the collector running while you browse? node scripts/collector.js)`);
    return;
  }

  let md = renderMarkdown(a);
  if (flags.includes('--analyze')) {
    console.log('[digest] running goal-mapping analysis via codex exec...');
    const analysis = runAnalysis(a);
    if (analysis) md += '\n' + analysis + '\n';
  }

  const outDir = path.join(dir, 'daily');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${dateStr}.md`);
  fs.writeFileSync(outFile, md);
  console.log(md);
  console.log(`\nsaved → ${path.relative(process.cwd(), outFile)}`);
}

if (require.main === module) main();

module.exports = { loadEvents, loadClassificationMap, collapseReads, collapseWatches, readRepeats, assemble, renderMarkdown, buildAnalysisPrompt };
