#!/usr/bin/env node

// Prepare, judge, and report a stratified audit of recent live X decisions.
//
// Usage:
//   node benchmarks/audit-live-x.js prepare --since 2026-07-23
//   node benchmarks/audit-live-x.js run --out data/judge-2026-08-05
//   node benchmarks/audit-live-x.js report --out data/judge-2026-08-05

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EVENTS_PATH = path.join(ROOT, 'data/events-x.jsonl');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function outputDir() {
  return path.resolve(ROOT, arg('out', `data/judge-${today()}`));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

function sample(rows, n) {
  return rows.slice().sort((a, b) => hash(a.tweetId) - hash(b.tweetId)).slice(0, n);
}

function quantile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
}

const JUDGE_PROMPT = (batch) => `You are labeling tweets for a personal feed-filter eval set. The user is Kuan: a solo founder in Singapore building trustworthy AI tools for professional work, especially Claude Code, AI agents, LLM infrastructure, and evals. He filters his X feed to tech/AI/startup signal only.

Read every item in this JSON file:
${batch}

Label each tweet with exactly one label:
- "critical-signal": content Kuan would most regret missing, such as an FDE/job lead, a potential paying-customer or pilot lead, or a major Claude/agent-infrastructure capability change he would act on the same day.
- "signal": novel, specific, dense, authentic tech/AI/startup/engineering content. A person sharing their own work, data, numbers, hands-on method, opinion, recommendation, or warning is signal when there is no funnel.
- "noise": everything else, including lifestyle, sports, politics, generic motivation, vague hype, crypto pumps, engagement farming, funnels, borrowed-authority reposts, and repost-farm captions.

Set "tempting": true only when a noise tweet superficially resembles tech signal. Signal labels always use false.
Judge only from the supplied text and media type; do not invent unseen media content.

Output only JSONL, one object per input item, with no prose or markdown:
{"id":"<tweet id>","label":"critical-signal|signal|noise","confidence":<0.5-1.0>,"tempting":<true|false>,"reason":"<max 8 words>"}

Every input item must appear exactly once.`;

function prepare() {
  const since = arg('since', new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
  const cutoff = Date.parse(since + 'T00:00:00Z');
  const out = outputDir();
  const rows = readJsonl(EVENTS_PATH);
  const decisions = new Map();
  const dwell = new Map();

  for (const row of rows) {
    if (!row.tweetId) continue;
    const id = String(row.tweetId);
    if (row.kind === 'read') {
      dwell.set(id, (dwell.get(id) || 0) + (row.dwellMs || 0));
      continue;
    }
    if (row.ts < cutoff || row.kind || !row.text || !row.decision) continue;
    if (row.surface === 'own-replies') continue;
    if (row.source !== 'model' && !String(row.source).startsWith('prefilter:')) continue;
    decisions.set(id, row);
  }

  const all = [...decisions.values()];
  const strata = {
    'prefilter-hide': sample(all.filter((r) => String(r.source).startsWith('prefilter:')), 80),
    'model-hide-unsure': sample(all.filter((r) =>
      r.source === 'model' && r.decision === 'hidden' && (r.confidence || 0) <= 0.85
    ), 120),
    'model-hide-confident': sample(all.filter((r) =>
      r.source === 'model' && r.decision === 'hidden' && (r.confidence || 0) > 0.85
    ), 70),
    'shown-unread': sample(all.filter((r) =>
      r.source === 'model' && r.decision === 'shown' && !dwell.has(String(r.tweetId))
    ), 80),
    'shown-read': all.filter((r) =>
      r.source === 'model' && r.decision === 'shown' && dwell.has(String(r.tweetId))
    ).sort((a, b) => (dwell.get(String(b.tweetId)) || 0) - (dwell.get(String(a.tweetId)) || 0)).slice(0, 50),
  };

  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(out).filter((f) => /^batch-|^out-|^raw-/.test(f))) {
    fs.rmSync(path.join(out, file));
  }

  const meta = {};
  const items = [];
  for (const [stratum, selected] of Object.entries(strata)) {
    for (const row of selected) {
      const id = String(row.tweetId);
      if (meta[id]) continue;
      meta[id] = {
        stratum,
        decision: row.decision,
        source: row.source,
        confidence: row.confidence,
        prediction: row.prediction,
        dwellMs: dwell.get(id) || 0,
        author: row.author,
        text: row.text,
        media: row.mediaType || 'text',
        ts: row.ts,
        ms: row.ms,
      };
      items.push({
        id,
        author: row.author || null,
        text: row.text,
        media: row.mediaType || 'text',
      });
    }
  }

  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const batchSize = Number(arg('batch-size', '100'));
  for (let i = 0; i < items.length; i += batchSize) {
    const n = String(i / batchSize).padStart(2, '0');
    fs.writeFileSync(path.join(out, `batch-${n}.json`), JSON.stringify(items.slice(i, i + batchSize), null, 2) + '\n');
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    source: EVENTS_PATH,
    since,
    availableDecisions: all.length,
    sampled: items.length,
    strata: Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, v.length])),
  }, null, 2) + '\n');

  console.log(`prepared ${items.length} tweets in ${out}`);
  for (const [name, selected] of Object.entries(strata)) console.log(`  ${name}: ${selected.length}`);
}

function parseJudgeOutput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const rows = [];
  for (const line of trimmed.split('\n')) {
    try {
      const row = JSON.parse(line.trim());
      if (row && row.id) rows.push(row);
    } catch {}
  }
  return rows;
}

function runCodex(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codex judge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex judge exited ${code}\n${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runJudges() {
  const out = outputDir();
  const batchLimit = Number(arg('limit-batches', '0'));
  let batches = fs.readdirSync(out).filter((f) => /^batch-\d+\.json$/.test(f)).sort();
  if (batchLimit > 0) batches = batches.slice(0, batchLimit);
  if (!batches.length) throw new Error('No batches found; run prepare first');
  const concurrency = Number(arg('concurrency', '3'));
  let next = 0;

  async function lane() {
    while (true) {
      const i = next++;
      if (i >= batches.length) return;
      const batchName = batches[i];
      const batch = path.join(out, batchName);
      const stem = batchName.replace('.json', '');
      const rawPath = path.join(out, `raw-${stem}.txt`);
      const verdictPath = path.join(out, `out-${stem}.jsonl`);
      const expected = JSON.parse(fs.readFileSync(batch, 'utf8')).length;
      if (readJsonl(verdictPath).length === expected) {
        console.log('skipping', batchName, '(complete)');
        continue;
      }
      const args = [
        'exec', '--ephemeral', '-s', 'read-only', '-C', ROOT,
        JUDGE_PROMPT(batch),
      ];
      console.log('judging', batchName);
      const result = await runCodex(args, Number(arg('timeout-ms', String(4 * 60 * 1000))));
      fs.writeFileSync(rawPath, result.stdout || '');
      const verdicts = parseJudgeOutput(result.stdout || '');
      if (verdicts.length !== expected) {
        throw new Error(
          `${batchName}: expected ${expected} verdicts, got ${verdicts.length}` +
          (result.stderr ? `\n${result.stderr.slice(-2000)}` : '')
        );
      }
      fs.writeFileSync(
        verdictPath,
        verdicts.map((v) => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : '')
      );
      console.log(`  ${batchName}: ${verdicts.length} verdicts`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, lane));
}

function report() {
  const out = outputDir();
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const verdicts = {};
  for (const file of fs.readdirSync(out).filter((f) => /^out-batch-\d+\.jsonl$/.test(f))) {
    for (const row of readJsonl(path.join(out, file))) verdicts[String(row.id)] = row;
  }

  const rows = [];
  const seenText = new Set();
  for (const [id, m] of Object.entries(meta)) {
    const v = verdicts[id];
    if (!v || !['critical-signal', 'signal', 'noise'].includes(v.label)) continue;
    const textKey = m.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);
    rows.push({ id, ...m, judge: v.label, judgeConfidence: Number(v.confidence) || 0.5, tempting: !!v.tempting, judgeReason: v.reason });
  }

  const isSignal = (label) => label === 'signal' || label === 'critical-signal';
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
  const byStratum = {};
  for (const row of rows) (byStratum[row.stratum] ||= []).push(row);

  let md = `# Live X audit - ${today()}\n\n`;
  md += `${rows.length} unique tweets judged from ${manifest.since} onward (${manifest.sampled} sampled; stratified, not a population estimate).\n\n`;
  md += '| stratum | n | signal | critical | noise | pipeline error in this stratum |\n';
  md += '|---|---:|---:|---:|---:|---|\n';
  const notes = {
    'prefilter-hide': 'judge signal = deterministic false hide',
    'model-hide-unsure': 'judge signal = false hide',
    'model-hide-confident': 'judge signal = confident false hide',
    'shown-unread': 'judge noise = false keep',
    'shown-read': 'judge noise = read false keep',
  };
  for (const name of Object.keys(manifest.strata)) {
    const selected = byStratum[name] || [];
    const signal = selected.filter((r) => r.judge === 'signal').length;
    const critical = selected.filter((r) => r.judge === 'critical-signal').length;
    const noise = selected.filter((r) => r.judge === 'noise').length;
    md += `| ${name} | ${selected.length} | ${signal} | ${critical} | ${noise} | ${notes[name]} |\n`;
  }

  const hides = rows.filter((r) => r.decision === 'hidden');
  const shows = rows.filter((r) => r.decision === 'shown');
  const liveTimes = rows.filter((r) => r.source === 'model' && Number.isFinite(r.ms)).map((r) => r.ms);
  md += `\nWithin this stratified sample, ${pct(hides.filter((r) => isSignal(r.judge)).length, hides.length)} of hides were judged signal and ${pct(shows.filter((r) => r.judge === 'noise').length, shows.length)} of shows were judged noise.\n`;
  md += `Sampled live model latency: p50 ${quantile(liveTimes, 0.5)}ms, p95 ${quantile(liveTimes, 0.95)}ms.\n`;

  const disagreements = rows
    .filter((r) => (r.decision === 'hidden' && isSignal(r.judge)) || (r.decision === 'shown' && r.judge === 'noise'))
    .sort((a, b) => {
      const aCritical = a.judge === 'critical-signal' ? 1 : 0;
      const bCritical = b.judge === 'critical-signal' ? 1 : 0;
      return bCritical - aCritical || b.judgeConfidence - a.judgeConfidence || b.dwellMs - a.dwellMs;
    });
  const queue = disagreements.slice(0, 20);
  fs.writeFileSync(path.join(out, 'hard-label-queue.json'), JSON.stringify(queue, null, 2) + '\n');
  let queueMd = '# Hard-label queue\n\nUse c = critical-signal, s = signal, n = noise, - = skip.\n\n';
  queue.forEach((r, i) => {
    queueMd += `**${i + 1}.** @${r.author || '?'} - local ${r.decision}, judge ${r.judge} (${r.judgeConfidence})\n`;
    queueMd += `> ${r.text.replace(/\n/g, ' ').slice(0, 500)}\n\n`;
  });
  fs.writeFileSync(path.join(out, 'hard-label-queue.md'), queueMd);

  const evalItems = rows
    .filter((r) => r.judgeConfidence >= 0.75)
    .map((r) => ({
      id: `audit-${r.id}`,
      text: r.text,
      tier: r.judge === 'noise' ? (r.tempting ? 'tempting-noise' : 'noise') : r.judge,
      author: r.author || undefined,
      media: r.media && r.media !== 'text' ? r.media : undefined,
    }));
  fs.writeFileSync(path.join(out, 'eval-set.json'), JSON.stringify({
    version: `live-audit-${today()}`,
    note: `Stratified live X audit from ${manifest.since}; Codex-judged, confidence >= 0.75, not yet hand-blessed.`,
    items: evalItems,
  }, null, 2) + '\n');
  md += `\nGenerated eval-set.json with ${evalItems.length} high-confidence items and a ${queue.length}-item human review queue.\n`;
  fs.writeFileSync(path.join(out, 'report.md'), md);

  console.log(`report written: ${path.join(out, 'report.md')}`);
  console.log(`eval set: ${evalItems.length} items`);
  console.log(`human queue: ${queue.length} items`);
}

async function main() {
  const command = process.argv[2] || 'prepare';
  if (command === 'prepare') prepare();
  else if (command === 'run') await runJudges();
  else if (command === 'report') report();
  else throw new Error('Expected prepare, run, or report');
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
