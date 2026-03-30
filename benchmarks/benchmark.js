// xrai Model Benchmark — tests speed and accuracy of local models
// Run: node benchmarks/benchmark.js

const OLLAMA_URL = 'http://localhost:11434';

const MODELS = ['gemma2:2b', 'phi4-mini'];

// 78 test tweets with expected labels (38 signal, 40 noise)
// Sources: synthetic + timeline 2026-03-30 + bookmarks extraction
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

  // Real signal — from bookmarks
  { text: "prediction re the end of spreadsheets. AI code gen means that anything that is currently modeled as a spreadsheet is better modeled in code. You get all the advantages of software - libraries, open source, AI, all the complexity and expressiveness.", expected: 'signal', author: '@andrewchen' },
  { text: "people are buying rigs worth thousands of dollars while your five year old GPUs can run 9B parameter open source LLMs", expected: 'signal', media: 'image', author: '@aviral10x' },
  { text: "I'm not the only one doing this. - karpathy best thought leader, best person to learn from imo. Nanochat is the best way to get into training LLMs its the simplest and most digestible source for building your first AI model", expected: 'signal', media: 'image', author: '@0xSero' },
  { text: "When someone signs up to your SaaS, grab their email domain, get a summary from Firecrawl, have an LLM generate you the best starting keywords/configuration/demo project", expected: 'signal', author: '@arvidkahl' },
  { text: "I mass launched 70+ startups since 2013. Here's my stack: a $5/month VPS, PHP, jQuery, SQLite. No frameworks. No dependencies. No team. $2.7M ARR.", expected: 'signal', author: '@levelsio' },
  { text: "Every page on all of my sites has a screenshot for og:image social media cards. Remote OK has 1.7 million user profiles, millions of job filter combo pages.", expected: 'signal', author: '@levelsio' },
  { text: "Structured outputs are the most underrated feature in LLM APIs. Stop parsing markdown. Just define a schema.", expected: 'signal', author: '@jxnlco' },
  { text: "LangGraph just hit 1M downloads. The shift from chains to graphs is real. Agents need cycles, not pipelines.", expected: 'signal', author: '@hwchase17' },
  { text: "Tailwind CSS v4 alpha is out. New engine, 10x faster builds, and native CSS cascade layers.", expected: 'signal', author: '@adamwathan' },
  { text: "Gumroad hit $200M in creator payouts. Our team is 3 people. SaaS doesn't need to be complicated.", expected: 'signal', author: '@shl' },
  { text: "DeepSeek-R1 is here! Performance on par with OpenAI-o1. Fully open-source model.", expected: 'signal', author: '@deepseek_ai' },
  { text: "Firecrawl v2 can now extract structured data from any website. No more parsing HTML. Just define your schema and go.", expected: 'signal', author: '@nickscamara_' },
  { text: "80% of auditing is codebase understanding. How can you make someone faster at understanding code?", expected: 'signal', author: '@0xjimmyk' },
  { text: "Used deep research to extract common keywords, product mentions, and painpoints from subreddits", expected: 'signal', author: '@mayowaoshin' },
  { text: "Crazy story how we built Cursor Directory in 3 hours and gathered over 1.1M views.", expected: 'signal', media: 'image', author: '@pontusab' },
  { text: "the only things you need to know: your account has a base score and it runs before your tweet is evaluated: verified accounts: +100 automatic unverified accounts: max +55 then multiplied by your follower ratio", expected: 'signal', author: '@retardmode' },
  { text: "If only someone told me this before my 1st startup: 1. Validate. I wasted at least 5 years building things nobody wanted.", expected: 'signal', author: '@johnrushx' },
  { text: "I spent 6 months building an AI writing tool nobody wanted. Then I pivoted to a simple grammar checker and got 50k users in 2 weeks.", expected: 'signal', author: '@JamesBorrell' },

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

  // Real noise — from bookmarks (video bait, vague, entertainment)
  { text: "Test if you can read at 900 words per minute with this technique", expected: 'noise', media: 'video', author: '@InternetH0F' },
  { text: "iPhone 13 battery cell replacement", expected: 'noise', media: 'video', author: '@_Brainboxx' },
  { text: "Gym etiquette final boss", expected: 'noise', media: 'video', author: '@unhingedfeed' },
  { text: "your favorite founders' favorite founder", expected: 'noise', media: 'video', author: '@jacobandreou' },
  { text: "This new anime season is looking cool. Would you watch this?", expected: 'noise', media: 'video', author: '@Leaflit' },
  { text: "Ever heard of the Michelangelo effect?", expected: 'noise', media: 'video', author: '@manly_mentor' },
  { text: "goodnight", expected: 'noise', author: '@Abhinavstwt' },
  { text: "The danger that's killing your long term health: Muscle loss. Here's what happens: Memory loss, Trouble walking, Chronic disease. But luckily there is a simple answer. Here is your ultimate guide.", expected: 'noise', media: 'image', author: '@theoliveranwar' },
  { text: "Start building your moat now it's not too late", expected: 'noise', media: 'image', author: '@boringmarketer' },
  { text: "The fastest way to change your life isn't: Starting a business, Investing in crypto. It's fixing your sleep.", expected: 'noise', author: '@edendotso' },
  { text: "How to do marketing (If you are Solopreneurs who sucks at marketing)", expected: 'noise', media: 'image', author: '@DanKulkov' },
  { text: "Back pain? This is the one book you need. I know someone who only read the description and got better.", expected: 'noise', media: 'image', author: '@julianweisser' },
  { text: "Your pitch deck is losing you money.", expected: 'noise', media: 'image', author: '@KevinHenrikson' },
  { text: "The 7 best free AI tools that will save you 100+ hours a week", expected: 'noise', media: 'image', author: '@alexfinnx' },
  { text: "Everything you need to know about building a $1M agency", expected: 'noise', media: 'image', author: '@charlierward' },

  // Real noise — from chrome.storage classifications (misclassified by model)
  { text: "THIS GUY BUILT AN APP MASCOT THAT CAN EAT, SLEEP, AND CHANGE COLOR USING A STATE MACHINE.", expected: 'noise', media: 'video' },
  { text: "2098x 209,700% gain in one call. Someone in our private tg channel caught $PIXEL at $2.4K before flying to $10m", expected: 'noise', media: 'image' },
  { text: "THE TICKER IS $___", expected: 'noise' },
  { text: "WEB 3 SOCIAL MEDIA JUST GOT A LOT EASIER TO BUILD", expected: 'noise', media: 'video' },
  { text: "NOTHING BEATS A MONDAY MORNING PUMP", expected: 'noise', media: 'image' },
  { text: "If you want to build a startup that makes real money, here's what actually works", expected: 'noise' },
  { text: "Every SaaS founder should know this pricing trick", expected: 'noise' },
  { text: "GM CT SAY IT BACK", expected: 'noise', media: 'image' },

  // Real signal — from chrome.storage classifications (correctly classified)
  { text: "DefiLlama launched an MCP that brings onchain data directly to AI agent. 23 tools covering data across protocols.", expected: 'signal', media: 'video' },
  { text: "This is nuts: Clawdbot figured out how to transcribe and respond to a voice message on its own, detecting the Opus format, converting to wav, transcribing", expected: 'signal' },
  { text: "PimEyes has been doing this since 2017. The scary part isn't the technology. It's that most people are only finding out now.", expected: 'signal' },
];

const SYSTEM_PROMPT = `You classify tweets as signal or noise. Output ONLY valid JSON.
Score 4 dimensions (0 or 1 each):
- NOVELTY: New info (1) or recycled take (0)?
- SPECIFICITY: Concrete details (1) or vague claims (0)?
- DENSITY: High insight per word (1) or filler (0)?
- AUTHENTICITY: Genuine sharing (1) or engagement farming (0)?

NOISE indicators: ALL CAPS text, vague hype ("insane", "wild", "crazy"), video+short text, no concrete details, crypto pumps.
SIGNAL indicators: specific numbers/tools/results, personal experience with details, technical content.

Score 3-4 = signal (confidence 0.75-0.95). Score 0-2 = noise (confidence 0.75-0.95). Score 2 with some specifics = noise confidence 0.6.
Output: {"prediction":"signal"|"noise","confidence":0.6-0.95}`;

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
