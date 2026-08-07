// rai YouTube eval — full-pipeline regression harness (prefilter + model + threshold).
//
// What "better" means here, in priority order — the mirror image of X's asymmetry:
//   1. Keep recall (guarded metric). A music/motivational video wrongly blurred is
//      INVISIBLE in daily use — you never know you missed a good song. This eval
//      exists to guard the side no one can feel.
//   2. False-keep rate (felt metric). An "other" video wrongly revealed is annoying
//      but visible — you'll notice a distracting video slipped through.
//   Weighted cost = 2*keepLost + 1*falseKeep.
//
// Runs the REAL pipeline: production prefilter, system prompt, parser, input
// format, and threshold — all loaded from extension source via load-extension.js.
//
// Usage:
//   node benchmarks/eval-youtube.js            # run + gate against baseline-youtube.json
//   node benchmarks/eval-youtube.js --bless    # run + write new baseline
//   node benchmarks/eval-youtube.js --limit 10 # smoke run (no gate, no bless)
//   node benchmarks/eval-youtube.js --model X  # override model
//
// Exit codes: 0 = pass, 1 = regression vs baseline, 2 = setup error.

const fs = require('fs');
const path = require('path');
const L = require('./load-extension.js');

const OLLAMA_URL = 'http://localhost:11434';
const BASELINE_PATH = path.join(__dirname, 'baseline-youtube.json');
const RESULTS_DIR = path.join(__dirname, 'results');

// Gate thresholds (vs baseline)
const MAX_KEEP_RECALL_DROP = 0.03;    // 3 points
const MAX_FALSE_KEEP_RISE = 0.05;     // 5 points

async function classify(model, item, worker) {
  const userMsg = L.toYoutubeUserMessage(item);
  const start = Date.now();
  const res = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: worker.YT_CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      stream: false,
      think: false,
      keep_alive: worker.TEXT_KEEP_ALIVE,
      options: {
        temperature: 0.1,
        num_predict: 40,
        num_ctx: worker.TEXT_NUM_CTX,
      },
    }),
  });
  const data = await res.json();
  const raw = (data.message && data.message.content) || '';
  return { parsed: worker.parseYoutubeClassification(raw), raw, ms: Date.now() - start };
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

  const golden = L.loadGoldenYoutube();
  const prefilter = L.loadYoutubePrefilter();
  const worker = L.loadWorker();
  const defaults = L.loadConfigDefaults().youtube;
  const model = modelIdx !== -1 ? args[modelIdx + 1] : defaults.model;
  const threshold = defaults.confidenceThreshold;
  const keepMotivational = defaults.keepMotivational !== false;
  const promptSha = L.sha(worker.YT_CLASSIFY_SYSTEM);
  const prefilterSha = L.sha(fs.readFileSync(path.join(__dirname, '../extension/content/youtube/prefilter.js'), 'utf8'));

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
  console.log(`eval-youtube: ${items.length} items | model=${model} | threshold=${threshold} | keepMotivational=${keepMotivational} | prompt=${promptSha} | prefilter=${prefilterSha}\n`);

  // Warm up
  await classify(model, items[0], worker);

  const results = [];
  const times = [];
  for (const item of items) {
    const pf = prefilter.prefilter(L.toYoutubePrefilterData(item));
    let modelResult = null;
    let raw = '';
    if (!pf) {
      const c = await classify(model, item, worker);
      modelResult = c.parsed;
      raw = c.raw;
      times.push(c.ms);
    }
    const d = L.decideYoutube(pf, modelResult || {}, keepMotivational, threshold);
    const expected = L.isKeepTier(item.tier) ? 'kept' : 'blurred';
    const correct = d.decision === expected;
    results.push({
      id: item.id,
      tier: item.tier,
      decision: d.decision,
      stage: d.stage,
      category: d.category,
      confidence: d.confidence,
      correct,
      title: item.title.slice(0, 80),
    });
    const icon = correct ? '✓' : '✗';
    console.log(
      `  ${icon} ${item.id} ${item.tier.padEnd(15)} ${d.decision.padEnd(8)} [${d.stage}:${d.category}]`
    );
  }

  // === Metrics ===
  const by = (tier) => results.filter((r) => r.tier === tier);
  const keepItems = results.filter((r) => L.isKeepTier(r.tier));
  const keepLost = keepItems.filter((r) => r.decision === 'blurred');
  const otherItems = results.filter((r) => !L.isKeepTier(r.tier));
  const falseKeeps = otherItems.filter((r) => r.decision === 'kept');
  const temptingFalseKeeps = by('tempting-other').filter((r) => r.decision === 'kept');
  const prefilterFalseKeeps = falseKeeps.filter((r) => r.stage === 'prefilter');

  const keepRecall = 1 - keepLost.length / keepItems.length;
  const falseKeepRate = falseKeeps.length / otherItems.length;
  const weightedCost = 2 * keepLost.length + 1 * falseKeeps.length;

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] || 0;
  const p95 = times[Math.floor(times.length * 0.95)] || 0;

  const summary = {
    date: new Date().toISOString(),
    model,
    threshold,
    keepMotivational,
    promptSha,
    prefilterSha,
    goldenVersion: golden.version,
    items: items.length,
    keepRecall,
    falseKeepRate,
    weightedCost,
    keepLostIds: keepLost.map((r) => r.id),
    falseKeepIds: falseKeeps.map((r) => r.id),
    prefilterFalseKeepIds: prefilterFalseKeeps.map((r) => r.id),
    latency: { p50, p95 },
    decisions: Object.fromEntries(results.map((r) => [r.id, r.decision])),
  };

  console.log('\n══════════════════ SUMMARY ══════════════════');
  console.log(`  Keep recall (guarded) : ${pct(keepRecall)}  (${keepLost.length}/${keepItems.length} blurred — you can't feel these)`);
  console.log(`  False-keep rate (felt): ${pct(falseKeepRate)}  (${falseKeeps.length}/${otherItems.length} leaked, ${temptingFalseKeeps.length} tempting)`);
  console.log(`  Weighted cost          : ${weightedCost}  (2×keepLost + 1×falseKeep)`);
  console.log(`  Prefilter false-keeps  : ${prefilterFalseKeeps.length}  (deterministic, threshold-bypassing, silent)`);
  console.log(`  Model latency          : p50 ${p50}ms | p95 ${p95}ms`);
  if (keepLost.length) keepLost.forEach((r) => console.log(`    ✗ KEEP LOST: ${r.id} "${r.title}"`));
  if (prefilterFalseKeeps.length) prefilterFalseKeeps.forEach((r) => console.log(`    ✗ PREFILTER FALSE-KEEP: ${r.id} "${r.title}"`));

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);
  const outPath = path.join(RESULTS_DIR, `eval-youtube-${Date.now()}.json`);
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

  const newKeepLosses = summary.keepLostIds.filter((id) => !base.keepLostIds.includes(id));
  if (newKeepLosses.length) failures.push(`NEW keep losses: ${newKeepLosses.join(', ')}`);
  if (keepRecall < base.keepRecall - MAX_KEEP_RECALL_DROP)
    failures.push(`keep recall dropped ${pct(base.keepRecall)} → ${pct(keepRecall)} (max drop ${MAX_KEEP_RECALL_DROP * 100}pts)`);
  if (falseKeepRate > base.falseKeepRate + MAX_FALSE_KEEP_RISE)
    failures.push(`false-keep rate rose ${pct(base.falseKeepRate)} → ${pct(falseKeepRate)} (max rise ${MAX_FALSE_KEEP_RISE * 100}pts)`);

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
