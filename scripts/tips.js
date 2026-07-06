#!/usr/bin/env node

// xrai Tips Ledger — track workflow tips from the feed: read → evaluated → implemented.
//
// Intake is automatic: extension/content/x/tips.js flags tip-shaped SHOWN tweets,
// main.js POSTs them to the collector's /tips endpoint → data/tips.jsonl
// (append-only). This CLI owns the status lifecycle in data/tips-status.json
// and answers the question the ledger exists for: "what looked useful that we
// still haven't acted on?"
//
// Status lifecycle:
//   new (implicit) → read → useful → implemented | rejected | na
//   'useful' means evaluated against the current setup and worth adopting.
//   To evaluate a batch against PAI, hand `tips.js list --json` to kyu or the
//   Upgrade skill (its Thread-0 prior-work audit answers "already using it?").
//
// Usage:
//   node scripts/tips.js                    # digest: actionable tips (default)
//   node scripts/tips.js list [--all|--json]
//   node scripts/tips.js mark <tweetId|prefix> <status> [note...]
//   node scripts/tips.js stats

const fs = require('fs');
const path = require('path');

const STATUSES = ['read', 'useful', 'implemented', 'rejected', 'na'];
const RESOLVED = ['implemented', 'rejected', 'na'];
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

function tipsFile(dir) { return path.join(dir, 'tips.jsonl'); }
function statusFile(dir) { return path.join(dir, 'tips-status.json'); }

function loadTips(dir) {
  const file = tipsFile(dir || DEFAULT_DATA_DIR);
  if (!fs.existsSync(file)) return [];
  const seen = new Set();
  const tips = [];
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try {
      const t = JSON.parse(line);
      if (!t.tweetId || seen.has(String(t.tweetId))) continue;
      seen.add(String(t.tweetId));
      tips.push(t);
    } catch (e) { /* skip bad line */ }
  }
  return tips;
}

function loadStatuses(dir) {
  const file = statusFile(dir || DEFAULT_DATA_DIR);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

function setStatus(dir, tweetId, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
  const statuses = loadStatuses(dir);
  statuses[String(tweetId)] = { status, note: note || '', updatedAt: new Date().toISOString() };
  fs.writeFileSync(statusFile(dir || DEFAULT_DATA_DIR), JSON.stringify(statuses, null, 2) + '\n');
  return statuses[String(tweetId)];
}

// Resolve a (possibly partial) tweetId against captured tips. Throws when
// ambiguous — marking the wrong tip silently would corrupt the ledger.
function resolveTweetId(tips, idOrPrefix) {
  const matches = tips.filter((t) => String(t.tweetId).startsWith(String(idOrPrefix)));
  if (matches.length === 0) throw new Error(`no captured tip matches "${idOrPrefix}"`);
  if (matches.length > 1) throw new Error(`"${idOrPrefix}" is ambiguous (${matches.length} matches) — use more digits`);
  return String(matches[0].tweetId);
}

// The view the ledger exists for: everything not yet resolved, most
// evaluated-useful first (those are "we KNOW it's good and STILL haven't
// acted"), then read-but-unevaluated, then unread.
const DIGEST_ORDER = { useful: 0, read: 1, new: 2 };

function digest(tips, statuses) {
  return tips
    .map((t) => ({ ...t, status: (statuses[String(t.tweetId)] || {}).status || 'new', note: (statuses[String(t.tweetId)] || {}).note || '' }))
    .filter((t) => !RESOLVED.includes(t.status))
    .sort((a, b) => (DIGEST_ORDER[a.status] ?? 9) - (DIGEST_ORDER[b.status] ?? 9) || (b.capturedAt || 0) - (a.capturedAt || 0));
}

function age(ts) {
  if (!ts) return '?';
  const d = (Date.now() - ts) / 86400000;
  return d < 1 ? 'today' : Math.floor(d) + 'd';
}

function printTip(t, i) {
  const badge = { new: '● UNREAD', read: '○ read  ', useful: '★ USEFUL' }[t.status] || t.status;
  console.log(`  ${badge}  ${String(t.tweetId).slice(0, 8)}…  @${(t.author || '?').padEnd(16)} ${age(t.capturedAt).padEnd(6)} ${(t.context || '').padEnd(9)}`);
  console.log(`           ${(t.text || '').replace(/\s+/g, ' ').slice(0, 110)}`);
  if (t.note) console.log(`           note: ${t.note}`);
  console.log(`           ${t.url || ''}`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'digest';
  const dir = DEFAULT_DATA_DIR;
  const tips = loadTips(dir);
  const statuses = loadStatuses(dir);

  if (cmd === 'digest') {
    const d = digest(tips, statuses);
    if (!d.length) {
      console.log('Tips ledger: nothing actionable. ' + (tips.length ? `(${tips.length} captured, all resolved)` : '(nothing captured yet — is the collector running?)'));
      return;
    }
    const useful = d.filter((t) => t.status === 'useful');
    console.log(`Tips ledger — ${d.length} actionable (${useful.length} evaluated-useful, ${d.filter((t) => t.status === 'new').length} unread)\n`);
    if (useful.length) console.log('  ▼ evaluated USEFUL and still not implemented — act or reject:\n');
    d.forEach(printTip);
    console.log(`\n  mark one:  node scripts/tips.js mark <id-prefix> read|useful|implemented|rejected|na [note]`);
    return;
  }

  if (cmd === 'list') {
    const all = tips.map((t) => ({ ...t, ...(statuses[String(t.tweetId)] || { status: 'new' }) }));
    const rows = args.includes('--all') ? all : all.filter((t) => !RESOLVED.includes(t.status || 'new'));
    if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
    rows.forEach(printTip);
    console.log(`\n  ${rows.length} shown / ${all.length} captured`);
    return;
  }

  if (cmd === 'mark') {
    const [, idOrPrefix, status, ...noteParts] = args;
    if (!idOrPrefix || !status) { console.error('usage: tips.js mark <tweetId|prefix> <status> [note...]'); process.exit(1); }
    const tweetId = resolveTweetId(tips, idOrPrefix);
    const entry = setStatus(dir, tweetId, status, noteParts.join(' '));
    const tip = tips.find((t) => String(t.tweetId) === tweetId);
    console.log(`marked ${tweetId} → ${entry.status}${entry.note ? ` (${entry.note})` : ''}`);
    console.log(`  "${(tip.text || '').slice(0, 80)}"`);
    return;
  }

  if (cmd === 'stats') {
    const counts = { new: 0, read: 0, useful: 0, implemented: 0, rejected: 0, na: 0 };
    for (const t of tips) counts[(statuses[String(t.tweetId)] || {}).status || 'new']++;
    console.log(`captured: ${tips.length}`);
    for (const [k, v] of Object.entries(counts)) if (v) console.log(`  ${k.padEnd(12)} ${v}`);
    return;
  }

  console.error(`unknown command "${cmd}" — try: digest | list | mark | stats`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { loadTips, loadStatuses, setStatus, resolveTweetId, digest, STATUSES, RESOLVED };
