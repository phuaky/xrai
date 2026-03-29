// xrai Model Benchmark — tests speed and accuracy of local models
// Run: node benchmarks/benchmark.js

const OLLAMA_URL = 'http://localhost:11434';

const MODELS = ['gemma2:2b', 'gemma3:1b', 'gemma3:4b', 'qwen3:1.7b', 'qwen3:4b', 'phi4-mini'];

// 50 test tweets with expected labels (25 signal, 25 noise)
// Includes synthetic + real tweets scraped from timeline 2026-03-30
const TEST_TWEETS = [
  // ═══════════════════════════════════════════════
  // SIGNAL tweets — tech, insightful, specific
  // ═══════════════════════════════════════════════

  // Synthetic signal
  { text: "Just shipped a feature that reduced latency by 40% using connection pooling in Postgres. The key was pgBouncer with transaction-level pooling.", expected: 'signal' },
  { text: "We hit 10k users today. Biggest lesson: the feature we almost cut (dark mode) drives 60% of retention.", expected: 'signal' },
  { text: "New paper from DeepMind shows that chain-of-thought prompting works because it reduces the effective complexity of the task, not because it mimics human reasoning.", expected: 'signal' },
  { text: "After 3 years of running Kubernetes in production: just use a managed service. The operational overhead of self-hosting is never worth it below 50 engineers.", expected: 'signal' },
  { text: "TIL you can use CSS container queries instead of media queries for component-level responsive design. Game changer for design systems.", expected: 'signal' },
  { text: "Cloudflare just announced R2 egress is now completely free. This changes the economics of serving static assets significantly.", expected: 'signal' },
  { text: "We moved from microservices back to a monolith. Deployment time went from 45min to 3min. Sometimes boring tech wins.", expected: 'signal' },
  { text: "Released v2.0 of our open source CLI tool. Added streaming output, plugin system, and cut binary size by 70%.", expected: 'signal' },
  { text: "The real bottleneck in most AI apps isn't the model, it's the data pipeline. We spent 3 months on data quality and accuracy jumped from 72% to 94%.", expected: 'signal' },
  { text: "SQLite can handle 100k+ concurrent readers. Most apps don't need Postgres. We switched and our infrastructure cost dropped to $0.", expected: 'signal' },

  // Real signal — from timeline 2026-03-30
  { text: "Just because someone trusts you quickly doesn't mean you need to trust them quickly. It's a more advanced manipulation move, typically from people who need something from you.", expected: 'signal', author: '@AlexHormozi' },
  { text: "The sun was free. They sold you SPF 50 and a vitamin D deficiency. Sleep was free. They sold you an app, a pill, and a wearable that tells you your sleep was bad. Walking was free. They sold you a treadmill, a fitness tracker, and a £180 pair of trainers. Fasting was free. They sold you meal replacement shakes and the anxiety that skipping breakfast would wreck your metabolism. The 20th century removed access to everything the body needs to function. The 21st century is selling it back, one subscription at a time.", expected: 'signal', author: '@SamaHoole' },
  { text: "I actively vibe/code apps to 5000+ customers at my SaaS companies (one at 40 millish ARR). I built and now maintain 3-4 apps/core parts of our business with it. I am a turbo claude code user. I'm not saying it's not useful. I saying that despite being incredibly useful, its also stupid as hell. Even with extreme guardrails/watching its a competent junior dev who does whatever it wants and you have to watch like a hawk. At somepoint making code fast is NOT an advantage and if your using claude/codex to push and review its own code...your actually an insane person.", expected: 'signal', author: '@ZssBecker' },
  { text: "The next version of OpenClaw is also an MCP, you can use it instead of Anthropic's message channel MCP to connect to a much wider range of message providers.", expected: 'signal', author: '@steipete' },
  { text: "Thesis: the problem with AI working in every domain = all the edge cases. Antithesis: domains with lots of edge cases = difficult & time consuming to practically impossible for error-prone people. Synthesis: such domains = where AI agents will do best. (Such as SAAS migration…)", expected: 'signal', author: '@pmarca' },
  { text: "the more I've been digging into the new Figma MCP, the more excited I am about it. something new I'm trying is starting with a very ugly sketch in Figma, and then having Claude Code flesh it out in Figma so I can tweak and edit before sending the final back to Claude Code", expected: 'signal', author: '@trq212' },
  { text: "1.5M views with 800 comments. shocked UGC face with a snapchat caption -> app demo. remember, simple formats scale well", expected: 'signal', author: '@jaxxdwyer' },
  { text: "Claire Vo's first day with OpenClaw it deleted her family calendar. Now she runs 9 agents across 3 Mac Minis, and said \"I haven't felt like this since I was a teenager learning to code.\" Her sales agent Sam does a daily CRM sweep, identifies decision-makers from new signups.", expected: 'signal', author: '@lennysan' },
  { text: "The only 4 jobs that will remain at tech companies.", expected: 'signal', media: 'image', author: '@chintanzalani' },
  { text: "No electricity, no battery, Swiss movement tropical fan from 1910. The full wind lasts about 30 minutes. It still works.", expected: 'signal', media: 'video', author: '@BrianRoemmele' },

  // ═══════════════════════════════════════════════
  // NOISE tweets — bait, vague, engagement farming
  // ═══════════════════════════════════════════════

  // Synthetic noise
  { text: "this is so good 😂", expected: 'noise', media: 'video' },
  { text: "Jamaican girl almost gets Ray cancelled but Kai saves him", expected: 'noise', media: 'video' },
  { text: "My Italian grandma taught me this.", expected: 'noise', media: 'video' },
  { text: "The coke ruined it", expected: 'noise', media: 'video' },
  { text: "You won't believe what happened next 🤯", expected: 'noise' },
  { text: "Follow me for daily motivation 💪 Like if you agree! RT to spread the word!", expected: 'noise' },
  { text: "Unpopular opinion: hard work beats talent every time. Who agrees?", expected: 'noise' },
  { text: "I made $10k in my first month with this one simple trick. DM me to learn how!", expected: 'noise' },
  { text: "She's so beautiful 😍🔥", expected: 'noise', media: 'image' },
  { text: "How football is made", expected: 'noise', media: 'video' },

  // Real noise — from timeline 2026-03-30
  { text: "The best way to end something is to starve it... 💯", expected: 'noise', media: 'video', author: '@ModernxDad' },
  { text: "She literally explained why you must keep going.", expected: 'noise', media: 'video', author: '@parveen__tyagi' },
  { text: "I need one of these.", expected: 'noise', media: 'image', author: '@DefiantLs' },
  { text: "Before you ask AI another dumb coding question… watch this.", expected: 'noise', media: 'video', author: '@IamKyros69' },
  { text: "Woman logic:", expected: 'noise', media: 'image', author: '@ZherkaOfficial' },
  { text: "If Lionel Messi had perfect side profile", expected: 'noise', media: 'image', author: '@interesting_aIl' },
  { text: "True", expected: 'noise', author: '@elonmusk' },
  { text: "The fraudsters always come up with the most sympathetic excuses and do so very loudly, because that is what swindlers do", expected: 'noise', author: '@elonmusk' },
  { text: "To succeed you just need to do so many reps is unreasonable that you fail.", expected: 'noise', author: '@AlexHormozi' },
  { text: "I have a theory that life meets you at your level of audacity", expected: 'noise', author: '@ashebytes' },
  { text: "Palantir CEO, Alex Karp says only 2 types of people will survive the AI era..", expected: 'noise', media: 'video', author: '@damianplayer' },
  { text: "i often think about this..", expected: 'noise', media: 'image', author: '@oprydai' },
  { text: "One great thing about SF is that you can see criminals just roaming the street!", expected: 'noise', author: '@mil0theminer' },
  { text: "A moving man will meet his luck", expected: 'noise', author: '@Adikastakes' },
  { text: "Ever wondered how Olympics can become more sustainable, efficient and intelligent?", expected: 'noise', author: '@AlibabaGroup' },
];

const SYSTEM_PROMPT = `You classify tweets as signal or noise. Output ONLY valid JSON, nothing else.

Score on 4 dimensions (0 or 1):
1. NOVELTY - New info or recycled take?
2. SPECIFICITY - Concrete details or vague?
3. DENSITY - High insight-to-word ratio?
4. AUTHENTICITY - Genuine or engagement bait?

Score 3-4 = signal. Score 0-2 = noise.
If tweet has video/image with vague text, lean noise.

Output format: {"prediction":"signal" or "noise","confidence":0.0-1.0}`;

async function classifyTweet(model, tweet) {
  const userMsg = tweet.media
    ? `<tweet media="${tweet.media}">\n${tweet.text}\n</tweet>`
    : `<tweet>\n${tweet.text}\n</tweet>`;

  const start = Date.now();

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      options: { temperature: 0.3, num_predict: 100 }
    })
  });

  const elapsed = Date.now() - start;
  const data = await res.json();
  const content = data.message?.content || '';

  // Parse response
  let prediction = null;
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      prediction = parsed.prediction?.toLowerCase();
    }
  } catch (e) {
    // Try simple extraction
    if (content.toLowerCase().includes('noise')) prediction = 'noise';
    else if (content.toLowerCase().includes('signal')) prediction = 'signal';
  }

  return { prediction, elapsed, raw: content.substring(0, 100) };
}

async function benchmarkModel(model) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MODEL: ${model}`);
  console.log(`${'═'.repeat(60)}`);

  // Warm up (first call loads model into RAM)
  console.log('  Warming up (loading model into RAM)...');
  const warmStart = Date.now();
  await classifyTweet(model, TEST_TWEETS[0]);
  console.log(`  Warm-up: ${Date.now() - warmStart}ms\n`);

  let correct = 0;
  let total = 0;
  let totalTime = 0;
  const times = [];
  const errors = [];

  for (const tweet of TEST_TWEETS) {
    const result = await classifyTweet(model, tweet);
    total++;
    totalTime += result.elapsed;
    times.push(result.elapsed);

    const match = result.prediction === tweet.expected;
    if (match) correct++;

    const icon = match ? '✓' : '✗';
    const label = `${tweet.expected.padEnd(6)}`;
    const got = `${(result.prediction || '???').padEnd(6)}`;
    const text = tweet.text.substring(0, 45).padEnd(45);
    const media = tweet.media ? ` [${tweet.media}]` : '';

    if (!match) {
      errors.push({ text: tweet.text.substring(0, 50), expected: tweet.expected, got: result.prediction });
    }

    console.log(`  ${icon} ${result.elapsed.toString().padStart(5)}ms | expect:${label} got:${got} | ${text}${media}`);
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const avg = Math.round(totalTime / total);

  console.log(`\n  RESULTS:`);
  console.log(`  Accuracy: ${correct}/${total} (${Math.round(correct/total*100)}%)`);
  console.log(`  Avg time: ${avg}ms | Median: ${median}ms | P95: ${p95}ms`);
  console.log(`  Total:    ${totalTime}ms for ${total} tweets`);

  if (errors.length > 0) {
    console.log(`\n  MISCLASSIFIED:`);
    errors.forEach(e => console.log(`    "${e.text}..." expected ${e.expected}, got ${e.got}`));
  }

  return { model, accuracy: correct/total, avgMs: avg, medianMs: median, p95Ms: p95, correct, total, errors: errors.length };
}

async function main() {
  console.log('xrai Model Benchmark');
  const signalCount = TEST_TWEETS.filter(t => t.expected === 'signal').length;
  const noiseCount = TEST_TWEETS.filter(t => t.expected === 'noise').length;
  console.log(`Testing ${MODELS.length} models on ${TEST_TWEETS.length} tweets (${signalCount} signal, ${noiseCount} noise)\n`);

  const results = [];

  for (const model of MODELS) {
    try {
      const result = await benchmarkModel(model);
      results.push(result);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      results.push({ model, accuracy: 0, avgMs: 0, error: e.message });
    }
  }

  // Summary table
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ${'Model'.padEnd(18)} ${'Accuracy'.padEnd(10)} ${'Avg'.padEnd(8)} ${'Median'.padEnd(8)} ${'P95'.padEnd(8)} Errors`);
  console.log(`  ${'─'.repeat(55)}`);

  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.model.padEnd(18)} ERROR: ${r.error}`);
    } else {
      console.log(`  ${r.model.padEnd(18)} ${(Math.round(r.accuracy*100)+'%').padEnd(10)} ${(r.avgMs+'ms').padEnd(8)} ${(r.medianMs+'ms').padEnd(8)} ${(r.p95Ms+'ms').padEnd(8)} ${r.errors}`);
    }
  }

  // Recommendation
  const best = results.filter(r => !r.error).sort((a, b) => {
    // Prefer accuracy, then speed
    if (Math.abs(a.accuracy - b.accuracy) > 0.1) return b.accuracy - a.accuracy;
    return a.avgMs - b.avgMs;
  })[0];

  if (best) {
    console.log(`\n  RECOMMENDATION: ${best.model}`);
    console.log(`  ${Math.round(best.accuracy*100)}% accuracy at ${best.avgMs}ms avg`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
