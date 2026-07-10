/* rai-cloud — hosted classification, free while in beta. Cloudflare Worker + D1.
 *
 * Speaks the same request/response shape as Ollama's /api/chat and /api/tags
 * so extension/background/worker.js needs zero changes to its call sites —
 * only the base URL + an Authorization header differ in Cloud mode.
 *
 * No accounts: the api_key minted by /api/free-key IS the account. No email,
 * no login, no payment. The credit balance exists as an abuse cap, not a
 * paywall — paid top-ups can return later without touching this design.
 * Balance is in fractional cents (real per-call cost is ~$0.00002 on Groq's
 * llama-3.1-8b-instant, so integer cents would lose all precision).
 */

const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const COST_PER_CALL_CENTS = 0.01; // ~5x real Groq cost — simple flat charge per call
const FREE_GRANT_CENTS = 500;     // 50,000 classifications — months of normal scrolling
const FREE_KEYS_PER_IP = 3;       // abuse cap, not a business rule

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
  });
}

function bearer(request) {
  var h = request.headers.get('Authorization') || '';
  var m = h.match(/^Bearer\s+(.+)$/);
  return m ? m[1] : null;
}

function randomApiKey() {
  var bytes = crypto.getRandomValues(new Uint8Array(24));
  var hex = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return 'rai_live_' + hex;
}

async function getBalance(env, apiKey) {
  var row = await env.DB.prepare('SELECT credit_balance_cents FROM api_keys WHERE api_key = ?')
    .bind(apiKey).first();
  return row ? row.credit_balance_cents : null;
}

// --- /api/chat — the hot path, mirrors Ollama's request/response shape ---
async function handleChat(request, env) {
  var apiKey = bearer(request);
  if (!apiKey) return json({ error: 'missing api key' }, 401);

  var balance = await getBalance(env, apiKey);
  if (balance === null) return json({ error: 'invalid api key' }, 401);
  if (balance < COST_PER_CALL_CENTS) return json({ error: 'out of credits', balance_cents: balance }, 402);

  var body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }

  var messages = (body.messages || []).map(function (m) {
    return { role: m.role, content: m.content };
  });
  var maxTokens = (body.options && body.options.num_predict) || 200;
  var temperature = (body.options && body.options.temperature) || 0.1;

  var groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        stream: false
      })
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed' }, 502);
  }

  if (!groqRes.ok) {
    return json({ error: 'upstream error', status: groqRes.status }, 502);
  }

  var data = await groqRes.json();
  var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

  // Decrement balance — best-effort, not a transaction. At this cost per
  // call, a lost decrement on a rare race is not worth the complexity of
  // D1 batch/transaction handling.
  await env.DB.prepare('UPDATE api_keys SET credit_balance_cents = credit_balance_cents - ? WHERE api_key = ?')
    .bind(COST_PER_CALL_CENTS, apiKey).run();

  // Ollama shape: { message: { content }, ... }
  return json({ message: { role: 'assistant', content: content } });
}

async function handleTags(request, env) {
  var apiKey = bearer(request);
  if (!apiKey) return json({ error: 'missing api key' }, 401);
  var balance = await getBalance(env, apiKey);
  if (balance === null) return json({ error: 'invalid api key' }, 401);
  return json({ models: [{ name: GROQ_MODEL + ' (cloud)' }] });
}

async function handleBalance(request, env) {
  var apiKey = bearer(request);
  if (!apiKey) return json({ error: 'missing api key' }, 401);
  var balance = await getBalance(env, apiKey);
  if (balance === null) return json({ error: 'invalid api key' }, 401);
  return json({ balance_cents: balance });
}

// --- Free key: mint an api_key with a preloaded balance. One click in the
// extension settings (or curl). Capped per IP so a scripted loop can't drain
// the Groq account; the cap is generous because the goal is users, not rent.
async function handleFreeKey(request, env) {
  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  var row = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE created_ip = ?')
    .bind(ip).first();
  if (row && row.n >= FREE_KEYS_PER_IP) {
    return json({ error: 'free key limit reached for this network — email phuaky2017@gmail.com if you need another' }, 429);
  }

  var apiKey = randomApiKey();
  await env.DB.prepare('INSERT INTO api_keys (api_key, credit_balance_cents, created_at, created_ip) VALUES (?, ?, ?, ?)')
    .bind(apiKey, FREE_GRANT_CENTS, Date.now(), ip).run();

  return json({ api_key: apiKey, balance_cents: FREE_GRANT_CENTS });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    var url = new URL(request.url);
    try {
      if (url.pathname === '/api/chat' && request.method === 'POST') return await handleChat(request, env);
      if (url.pathname === '/api/tags' && request.method === 'GET') return await handleTags(request, env);
      if (url.pathname === '/api/balance' && request.method === 'GET') return await handleBalance(request, env);
      if (url.pathname === '/api/free-key' && request.method === 'POST') return await handleFreeKey(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'internal error', detail: (e && e.message) || String(e) }, 500);
    }
  }
};
