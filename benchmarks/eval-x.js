// xrai X eval — full-pipeline regression harness (prefilter + model + threshold).
//
// What "better" means here, in priority order:
//   1. Critical-signal recall = 100%. These are the tweets Kuan would most regret
//      never seeing (FDE leads, paid-pilot leads, Claude/agent infra). A hidden
//      critical tweet is a silent, unbounded-cost failure.
//   2. Signal recall (guarded metric). Hidden signal is INVISIBLE in daily use —
//      you can never feel this getting worse, only this eval can see it.
//   3. Noise catch rate (felt metric). Leaked noise is annoying but visible.
//   Weighted cost = 5*criticalLost + 2*signalLost + 1*noiseLeaked.
//
// Unlike benchmark.js (legacy), this runs the REAL pipeline: the production
// prefilter, the production system prompt, the production parser, the production
// input format, the production model, and the production threshold — all loaded
// from extension source via load-extension.js, so it cannot drift.
//
// Usage:
//   node benchmarks/eval-x.js            # run + gate against baseline-x.json
//   node benchmarks/eval-x.js --bless    # run + write new baseline
//   node benchmarks/eval-x.js --limit 10 # smoke run (no gate, no bless)
//   node benchmarks/eval-x.js --model X  # override model
//
// Exit codes: 0 = pass, 1 = regression vs baseline, 2 = setup error.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');

const OLLAMA_URL = 'http://localhost:11434';
const BASELINE_PATH = path.join(__dirname, 'baseline-x.json');
const RESULTS_DIR = path.join(__dirname, 'results');

// Gate thresholds (vs baseline)
const MAX_SIGNAL_RECALL_DROP = 0.03; // 3 points
const MAX_NOISE_CATCH_DROP = 0.05;   // 5 points

async function classify(model, item, worker) {
  const userMsg = L.toUserMessage(item);
  const start = Date.now();
  const res = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: worker.X_CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1, num_predict: 80 }, // mirror classifyX exactly
    }),
  });
  const data = await res.json();
  const raw = (data.message && data.message.content) || '';
  return { parsed: worker.parseXClassification(raw), raw, ms: Date.now() - start };
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

async function main() {
  const args = process.argv.slice(2);
  const bless = args.includes('--bless');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const modelIdx = args.indexOf('--model');

  const golden = L.loadGolden();
  const prefilter = L.loadPrefilter();
  const worker = L.loadWorker();
  const defaults = L.loadConfigDefaults().x;
  const model = modelIdx !== -1 ? args[modelIdx + 1] : defaults.model;
  const threshold = defaults.confidenceThreshold;
  const promptSha = L.sha(worker.X_CLASSIFY_SYSTEM);
  const prefilterSha = L.sha(fs.readFileSync(path.join(__dirname, '../extension/content/x/prefilter.js'), 'utf8'));

  // Ollama up?
  try {
    const tags = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    const names = (tags.models || []).map((m) => m.name);
    if (!names.includes(model)) {
      console.error(`Model "${model}" not found in Ollama. Available: ${names.join(', ')}`);
      process.exit(2);
    }
  } catch (e) {
    console.error('Ollama not reachable at ' + OLLAMA_URL + ' — start it, then re-run.');
    process.exit(2);
  }

  const items = limit ? golden.items.slice(0, limit) : golden.items;
  console.log(`eval-x: ${items.length} items | model=${model} | threshold=${threshold} | prompt=${promptSha} | prefilter=${prefilterSha}\n`);

  // Warm up
  await classify(model, items[0], worker);

  const results = [];
  const times = [];
  for (const item of items) {
    const pf = prefilter.prefilter(L.toPrefilterData(item));
    let modelResult = null;
    let raw = '';
    if (!pf) {
      const c = await classify(model, item, worker);
      modelResult = c.parsed;
      raw = c.raw;
      times.push(c.ms);
    }
    const d = L.decide(pf, modelResult || {}, threshold);
    const expected = L.isSignalTier(item.tier) ? 'shown' : 'hidden';
    const correct = d.decision === expected;
    results.push({
      id: item.id,
      tier: item.tier,
      decision: d.decision,
      stage: d.stage,
      confidence: d.confidence,
      correct,
      text: item.text.slice(0, 80),
    });
    const icon = correct ? '✓' : '✗';
    const flag = !correct && item.tier === 'critical-signal' ? '  ◀◀ CRITICAL SIGNAL LOST' : '';
    console.log(
      `  ${icon} ${item.id} ${item.tier.padEnd(15)} ${d.decision.padEnd(6)} [${d.stage}${d.reason ? ':' + d.reason : ''}]${flag}`
    );
  }

  // === Metrics ===
  const by = (tier) => results.filter((r) => r.tier === tier);
  const criticalLost = by('critical-signal').filter((r) => r.decision === 'hidden');
  const signalItems = results.filter((r) => L.isSignalTier(r.tier));
  const signalLost = signalItems.filter((r) => r.decision === 'hidden');
  const plainSignalLost = signalLost.filter((r) => r.tier === 'signal');
  const noiseItems = results.filter((r) => !L.isSignalTier(r.tier));
  const noiseLeaked = noiseItems.filter((r) => r.decision === 'shown');
  const temptingLeaked = by('tempting-noise').filter((r) => r.decision === 'shown');
  const prefilterFalseHides = signalLost.filter((r) => r.stage === 'prefilter');

  const signalRecall = 1 - signalLost.length / signalItems.length;
  const criticalRecall = 1 - criticalLost.length / by('critical-signal').length;
  const noiseCatch = 1 - noiseLeaked.length / noiseItems.length;
  const weightedCost = 5 * criticalLost.length + 2 * plainSignalLost.length + 1 * noiseLeaked.length;

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] || 0;
  const p95 = times[Math.floor(times.length * 0.95)] || 0;

  const summary = {
    date: new Date().toISOString(),
    model,
    threshold,
    promptSha,
    prefilterSha,
    goldenVersion: golden.version,
    items: items.length,
    criticalRecall,
    signalRecall,
    noiseCatch,
    weightedCost,
    criticalLost: criticalLost.map((r) => r.id),
    signalLostIds: signalLost.map((r) => r.id),
    noiseLeakedIds: noiseLeaked.map((r) => r.id),
    prefilterFalseHideIds: prefilterFalseHides.map((r) => r.id),
    latency: { p50, p95 },
    decisions: Object.fromEntries(results.map((r) => [r.id, r.decision])),
  };

  console.log('\n══════════════════ SUMMARY ══════════════════');
  console.log(`  Critical-signal recall : ${pct(criticalRecall)}  (${criticalLost.length} lost — MUST be 0)`);
  console.log(`  Signal recall (guarded): ${pct(signalRecall)}  (${signalLost.length}/${signalItems.length} hidden — you can't feel these)`);
  console.log(`  Noise catch (felt)     : ${pct(noiseCatch)}  (${noiseLeaked.length}/${noiseItems.length} leaked, ${temptingLeaked.length} tempting)`);
  console.log(`  Weighted cost          : ${weightedCost}  (5×critical + 2×signal + 1×noise)`);
  console.log(`  Prefilter false-hides  : ${prefilterFalseHides.length}  (deterministic, threshold-bypassing, silent)`);
  console.log(`  Model latency          : p50 ${p50}ms | p95 ${p95}ms`);
  if (criticalLost.length) criticalLost.forEach((r) => console.log(`    ✗ CRITICAL LOST: ${r.id} "${r.text}"`));
  if (prefilterFalseHides.length) prefilterFalseHides.forEach((r) => console.log(`    ✗ PREFILTER FALSE-HIDE: ${r.id} "${r.text}"`));

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);
  const outPath = path.join(RESULTS_DIR, `eval-x-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2) + '\n');
  console.log(`\n  Result written: ${path.relative(process.cwd(), outPath)}`);

  if (limit) {
    console.log('  (smoke run — no gate, no bless)');
    return;
  }

  if (bless) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log(`  Baseline blessed: ${path.relative(process.cwd(), BASELINE_PATH)}`);
    return;
  }

  // === Regression gate ===
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log('\n  No baseline yet — run with --bless to establish one.');
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];

  if (base.promptSha !== promptSha)
    failures.push(`prompt changed since baseline (${base.promptSha} → ${promptSha}) — intentional? re-bless after reviewing metrics`);
  if (base.prefilterSha !== prefilterSha)
    failures.push(`prefilter changed since baseline (${base.prefilterSha} → ${prefilterSha}) — intentional? re-bless after reviewing metrics`);
  if (base.model !== model) failures.push(`model changed since baseline (${base.model} → ${model})`);

  const newCriticalLosses = summary.criticalLost.filter((id) => !base.criticalLost.includes(id));
  if (newCriticalLosses.length) failures.push(`NEW critical-signal losses: ${newCriticalLosses.join(', ')}`);
  if (signalRecall < base.signalRecall - MAX_SIGNAL_RECALL_DROP)
    failures.push(`signal recall dropped ${pct(base.signalRecall)} → ${pct(signalRecall)} (max drop ${MAX_SIGNAL_RECALL_DROP * 100}pts)`);
  if (noiseCatch < base.noiseCatch - MAX_NOISE_CATCH_DROP)
    failures.push(`noise catch dropped ${pct(base.noiseCatch)} → ${pct(noiseCatch)} (max drop ${MAX_NOISE_CATCH_DROP * 100}pts)`);

  const flips = Object.keys(summary.decisions).filter(
    (id) => base.decisions && base.decisions[id] && base.decisions[id] !== summary.decisions[id]
  );
  if (flips.length) console.log(`\n  Decision flips vs baseline (${flips.length}): ${flips.join(', ')}`);
  if (p95 > (base.latency?.p95 || Infinity) * 2)
    console.log(`  ⚠ latency p95 doubled vs baseline (${base.latency.p95}ms → ${p95}ms) — feed will feel slower`);

  if (failures.length) {
    console.log('\n══════════ REGRESSION GATE: FAIL ══════════');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('\n══════════ REGRESSION GATE: PASS ══════════');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
