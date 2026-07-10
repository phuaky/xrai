/* rai — Service Worker (proxies Ollama HTTP calls, platform-routed) */

var DEFAULT_URL = 'http://localhost:11434';
var DEFAULT_MODEL = { x: 'dhiltgen/gemma4:e2b-mlx-bf16', youtube: 'gemma2:2b' };
var DEFAULT_IMAGE_MODEL = 'qwen3-vl:30b';
var CONFIG_KEY = { x: 'xrai_config', youtube: 'ytrai_config' };

// Cloud mode — hosted, Ollama-API-compatible endpoint (see rai-cloud/).
// Text classification only; the vision bait-check stays local-only for now.
var CLOUD_URL = 'https://api.snratio.xyz';

// Ollama ignores an unrecognized Authorization header, so this can be sent
// unconditionally rather than branched per call site.
function authHeaders(apiKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  return headers;
}

// MoE model, ~19GB resident when warm — kept alive across a browsing session
// so back-to-back thumbnail checks don't each eat the ~7s cold-load penalty,
// but freed automatically once you stop scrolling for a while.
var IMAGE_KEEP_ALIVE = '10m';
// Single-image classification prompt needs a few hundred tokens, not
// Qwen3-VL's 256K default context — that default inflates RAM ~45GB for no
// benefit and was the whole reason the model looked RAM-expensive in testing.
var IMAGE_NUM_CTX = 4096;

// === X: signal vs noise ===
var X_CLASSIFY_SYSTEM = 'You classify tweets as signal or noise. Output ONLY valid JSON.\nScore 4 dimensions (0 or 1 each):\n- NOVELTY: New info (1) or recycled take (0)?\n- SPECIFICITY: Concrete details (1) or vague claims (0)?\n- DENSITY: High insight per word (1) or filler (0)?\n- AUTHENTICITY: Genuine sharing (1) or engagement farming (0)?\n\nBAIT test — any hit forces AUTHENTICITY=0; two or more hits = noise regardless of other scores:\n- promises specifics it never delivers ("the exact prompt/config below", "bookmark this, then read")\n- funnel ending: join a community/telegram/discord/cohort, paid group, "part 2 coming soon", course tease\n- borrowed authority: the tweet IS a dramatic verbatim "quote" from a famous engineer/CEO, with an employer title and usually a video ("Anthropic Engineer X: \\"...\\" watch below"). Merely mentioning or recommending a famous person is NOT bait\n- manufactured urgency about acting on THIS post: buy/join/save before a deadline, "you will be left behind". Discussing risks or news topics is NOT bait\n- repost-farm framing: a breathless caption describing another person’s talk/video as the whole content, "watch the full episode, then read the article below"\n\nNOISE indicators: ALL CAPS text, vague hype ("insane", "wild", "crazy"), video+short text, no concrete details, crypto pumps.\nSIGNAL indicators: specific numbers/tools/results, personal experience with details, technical content. A person sharing their OWN work, data, or writing is signal even when it links out. A personal opinion, recommendation, or warning in the author own voice — even about famous people or alarming topics — is signal when there is no funnel, no video tease, and no verbatim quote-as-content.\n\nScore 3-4 = signal (confidence 0.75-0.95). Score 0-2 = noise (confidence 0.75-0.95). Score 2 with some specifics = noise confidence 0.6.\nOutput: {"prediction":"signal"|"noise","confidence":0.6-0.95,"reason":"1-5 word summary"}';

var X_REPLY_SYSTEM = 'Generate short reply options for a tweet. Output ONLY valid JSON array.\nRules: 5-15 words each, max 80 chars, no hashtags, match energy.\nOutput: [{"style":"curious","text":"..."},{"style":"insight","text":"..."},{"style":"connect","text":"..."}]';

// === YouTube: music / motivational / other ===
var YT_CLASSIFY_SYSTEM = 'You label a YouTube video as MUSIC, MOTIVATIONAL, or OTHER from its title and channel. Output ONLY valid JSON.\n\nMUSIC = songs, official music videos, audio tracks, albums, singles, EPs, live performances, concerts, covers, remixes, DJ sets, mixes, lo-fi / study / sleep / focus beats, instrumentals, classical, soundtracks/OST, full-song playlists. Strong hints: "Official Video", "Official Audio", "Official Music Video", "(Lyrics)", "ft."/"feat.", "remix", "VEVO", a channel ending in "- Topic".\nMOTIVATIONAL = motivational speeches, discipline / mindset / self-improvement talks meant to inspire action, workout motivation, stoicism, goal-setting pep talks.\nOTHER = everything else: vlogs, podcasts (unless purely motivational), gaming, news, politics, reactions, commentary, tutorials/how-to, reviews, unboxings, comedy/skits, sports, movie/TV/trailer clips, documentaries, interviews, explainers, cooking, travel, ASMR, kids content.\n\nRules:\n- Judge ONLY by the title + channel.\n- Background music inside a non-music video is still OTHER.\n- If unsure between MUSIC and OTHER, choose OTHER.\n\nOutput: {"category":"music"|"motivational"|"other","confidence":0.0-1.0}';

// === Image bait check: shared across X photos + YouTube thumbnails ===
var IMAGE_BAIT_SYSTEM = 'You judge whether an image is being used as clickbait via a sexualized or suggestive image of a person — cleavage, bikini/lingerie, alluring pose, thirst-trap framing — to bait clicks, unrelated to genuine content value.\n\nFully clothed fitness, workout, sports, or motivational imagery is NOT bait even when the person is attractive or fit — judge the intent and framing of the shot, not attractiveness. Movie/TV/game posters, album covers, and news photos are NOT bait. When genuinely unsure, prefer NOT bait (baity=false) — the cost of a wrongly-hidden legitimate thumbnail is worse than a missed one.\n\nOutput ONLY valid JSON: {"baity":true|false,"confidence":0.0-1.0,"reason":"3-6 words"}';

// Get per-platform config from storage
function getConfig(platform) {
  var key = CONFIG_KEY[platform] || CONFIG_KEY.x;
  var def = DEFAULT_MODEL[platform] || DEFAULT_MODEL.x;
  return new Promise(function (resolve) {
    chrome.storage.local.get(key, function (result) {
      var cfg = result[key] || {};
      var cloud = cfg.mode === 'cloud';
      // ollamaUrl always points at local Ollama — the image bait-check stays
      // local-only in Cloud mode v1 (no hosted vision endpoint yet), so it
      // needs the real local URL even when text classification goes to the
      // cloud. classifyUrl is the one text/reply/health calls should use.
      resolve({
        ollamaUrl: cfg.ollamaUrl || DEFAULT_URL,
        classifyUrl: cloud ? CLOUD_URL : (cfg.ollamaUrl || DEFAULT_URL),
        model: cfg.model || def,
        imageModel: cfg.imageModel || DEFAULT_IMAGE_MODEL,
        cloud: cloud,
        apiKey: cloud ? (cfg.cloudApiKey || '') : ''
      });
    });
  });
}

// Health check — tests an actual POST (catches CORS/403), not just GET
function checkHealth(ollamaUrl, model, apiKey) {
  var result = { available: false, models: [], classify: false, reply: false };

  return fetch(ollamaUrl + '/api/tags', {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(3000)
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      result.models = (data.models || []).map(function (m) { return m.name; });
      result.available = true;
      return fetch(ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          think: false,
          options: { num_predict: 1 }
        })
      });
    })
    .then(function (r) {
      if (r.ok) {
        result.classify = true;
        result.reply = true;
      } else {
        result.postStatus = r.status;
        console.warn('[rai-worker] Health POST failed: HTTP ' + r.status);
      }
      return result;
    })
    .catch(function (e) {
      result.postError = (e && e.message) || 'unknown';
      console.warn('[rai-worker] Health check error:', result.postError);
      return result;
    });
}

// === Model I/O log — POSTs to local collector (optional) ===
var COLLECTOR_URL = 'http://localhost:11435';

function logModelIO(platform, input, rawOutput, parsed, model, elapsed) {
  var entry = {
    platform: platform,
    input: input.substring(0, 500),
    rawOutput: rawOutput.substring(0, 1000),
    result: parsed,
    model: model,
    elapsed: elapsed,
    timestamp: Date.now()
  };
  fetch(COLLECTOR_URL + '/model-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  }).catch(function () { /* collector not running, that's fine */ });
}

// --- Classification dispatch ---

function classify(platform, msg, model, ollamaUrl, apiKey) {
  if (platform === 'youtube') {
    return classifyYoutube(msg.text, msg.channel, model, ollamaUrl, apiKey);
  }
  return classifyX(msg.text, msg.mediaType, model, ollamaUrl, apiKey);
}

function classifyX(text, mediaType, model, ollamaUrl, apiKey) {
  var userMsg = 'Tweet: "' + (text || '') + '"';
  if (mediaType && mediaType !== 'text') {
    userMsg += ' [has ' + mediaType + ']';
  }
  var start = Date.now();
  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: X_CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1, num_predict: 80 }
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = (data.message && data.message.content) || '';
      var parsed = parseXClassification(raw);
      var elapsed = Date.now() - start;
      logModelIO('x', userMsg, raw, parsed, model, elapsed);
      parsed._model = model;
      parsed._raw = raw.slice(0, 1500);
      parsed._input = userMsg.slice(0, 1000);
      parsed._ms = elapsed;
      return parsed;
    })
    .catch(function () {
      return { prediction: 'noise', confidence: 0.5 };
    });
}

function classifyYoutube(title, channel, model, ollamaUrl, apiKey) {
  var userMsg = 'Title: "' + (title || '') + '"';
  if (channel) userMsg += '\nChannel: "' + channel + '"';
  var start = Date.now();
  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: YT_CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1, num_predict: 40 }
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = (data.message && data.message.content) || '';
      var parsed = parseYoutubeClassification(raw);
      var elapsed = Date.now() - start;
      logModelIO('youtube', userMsg, raw, parsed, model, elapsed);
      parsed._model = model;
      parsed._raw = raw.slice(0, 1500);
      parsed._input = userMsg.slice(0, 1000);
      parsed._ms = elapsed;
      return parsed;
    })
    .catch(function () {
      return { category: 'other', confidence: 0.5 };
    });
}

// === Image bait classification ===
// Fetches image bytes in the service worker (host_permissions cover the CDN
// domains, so this avoids the tainted-canvas/CORS wall a content script would
// hit) and sends them to a vision model alongside the surrounding text.
function fetchImageBase64(url) {
  return fetch(url, { signal: AbortSignal.timeout(8000) })
    .then(function (r) {
      if (!r.ok) throw new Error('image fetch HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(function (buf) {
      var bytes = new Uint8Array(buf);
      var binary = '';
      var CHUNK = 0x8000;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    });
}

function classifyImage(platform, imageUrl, contextText, model, ollamaUrl) {
  var start = Date.now();
  if (!imageUrl) return Promise.resolve({ baity: false, confidence: 0 });

  return fetchImageBase64(imageUrl)
    .then(function (b64) {
      var userMsg = 'Context: "' + (contextText || '').substring(0, 200) + '"';
      return fetch(ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          think: false,
          keep_alive: IMAGE_KEEP_ALIVE,
          messages: [
            { role: 'system', content: IMAGE_BAIT_SYSTEM },
            { role: 'user', content: userMsg, images: [b64] }
          ],
          stream: false,
          options: { temperature: 0.1, num_predict: 60, num_ctx: IMAGE_NUM_CTX }
        })
      });
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = (data.message && data.message.content) || '';
      var parsed = parseImageClassification(raw);
      var elapsed = Date.now() - start;
      logModelIO(platform + '-image', contextText || '', raw, parsed, model, elapsed);
      parsed._model = model;
      parsed._raw = raw.slice(0, 500);
      parsed._ms = elapsed;
      return parsed;
    })
    .catch(function (e) {
      // Fail open — a fetch/model error must never hide legitimate content.
      console.warn('[rai-worker] Image classify error:', (e && e.message) || e);
      return { baity: false, confidence: 0 };
    });
}

function parseImageClassification(content) {
  try {
    var match = content.match(/\{[\s\S]*?\}/);
    if (match) {
      var obj = JSON.parse(match[0]);
      var result = {
        baity: obj.baity === true,
        confidence: Math.min(1, Math.max(0, parseFloat(obj.confidence) || 0.5))
      };
      if (obj.reason && typeof obj.reason === 'string') {
        result.reason = obj.reason.substring(0, 50);
      }
      return result;
    }
  } catch (e) { /* fallback */ }
  // Unparseable output fails open rather than hiding on a guess.
  return { baity: false, confidence: 0.5 };
}

// Generate reply (X only)
function generateReply(tweetText, authorHandle, style, model, ollamaUrl, apiKey) {
  var userMsg = 'Tweet by @' + (authorHandle || 'unknown') + ': "' + tweetText + '"';
  userMsg += '\nPreferred style: ' + (style || 'curious');

  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: X_REPLY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      think: false,
      options: { temperature: 0.7, num_predict: 200 }
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      return parseReplies((data.message && data.message.content) || '');
    })
    .catch(function () {
      return [{ style: 'error', text: 'Failed to generate reply. Is Ollama running?' }];
    });
}

function listModels(ollamaUrl, apiKey) {
  return fetch(ollamaUrl + '/api/tags', { headers: authHeaders(apiKey), signal: AbortSignal.timeout(3000) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      return (data.models || []).map(function (m) { return m.name; });
    })
    .catch(function () { return []; });
}

// --- Parse helpers ---

function parseXClassification(content) {
  try {
    var match = content.match(/\{[\s\S]*?\}/);
    if (match) {
      var obj = JSON.parse(match[0]);
      var result = {
        prediction: obj.prediction === 'signal' ? 'signal' : 'noise',
        confidence: Math.min(1, Math.max(0, parseFloat(obj.confidence) || 0.5))
      };
      if (obj.reason && typeof obj.reason === 'string') {
        result.reason = obj.reason.substring(0, 50);
      }
      return result;
    }
  } catch (e) { /* fallback */ }
  if (/signal/i.test(content)) return { prediction: 'signal', confidence: 0.6 };
  return { prediction: 'noise', confidence: 0.5 };
}

function parseYoutubeClassification(content) {
  var match = content.match(/\{[\s\S]*?\}/);
  if (match) {
    var raw = match[0];
    var obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      // Small models often emit unquoted JSON: {category: music, confidence: 0.9}.
      // Repair it so the real confidence isn't lost to the fallback below.
      try {
        var cleaned = raw
          .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')        // quote bare keys
          .replace(/:\s*(music|motivational|other)\b/gi, ': "$1"');  // quote bare category values
        obj = JSON.parse(cleaned);
      } catch (e2) { obj = null; }
    }
    if (obj) {
      var cat = String(obj.category || '').toLowerCase();
      if (cat !== 'music' && cat !== 'motivational' && cat !== 'other') {
        cat = /music/.test(cat) ? 'music' : (/motiv/.test(cat) ? 'motivational' : 'other');
      }
      return {
        category: cat,
        confidence: Math.min(1, Math.max(0, parseFloat(obj.confidence) || 0.5))
      };
    }
  }
  // No parseable object — require an explicit label and default to 'other'
  // (fail closed: blur unless we're reasonably sure it's music/motivational).
  if (/category"?\s*:?\s*"?\s*music/i.test(content)) return { category: 'music', confidence: 0.55 };
  if (/category"?\s*:?\s*"?\s*motiv/i.test(content)) return { category: 'motivational', confidence: 0.55 };
  return { category: 'other', confidence: 0.5 };
}

function parseReplies(content) {
  try {
    var match = content.match(/\[[\s\S]*?\]/);
    if (match) {
      var arr = JSON.parse(match[0]);
      return arr.filter(function (r) { return r.text; }).slice(0, 3);
    }
  } catch (e) { /* fallback */ }
  return [{ style: 'error', text: 'Could not parse reply.' }];
}

// --- Message handler ---

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.action) return false;
  var platform = msg.platform || 'x';

  getConfig(platform).then(function (cfg) {
    // classifyUrl/apiKey route to the cloud endpoint in Cloud mode; the image
    // bait-check always uses ollamaUrl (local-only, see getConfig above).
    var url = cfg.classifyUrl;
    var model = cfg.model;
    var apiKey = cfg.apiKey;

    switch (msg.action) {
      case 'checkHealth':
        checkHealth(url, model, apiKey).then(sendResponse);
        break;

      case 'classify':
        classify(platform, msg, model, url, apiKey).then(sendResponse);
        break;

      case 'classifyImage':
        classifyImage(platform, msg.imageUrl, msg.contextText, cfg.imageModel, cfg.ollamaUrl).then(sendResponse);
        break;

      case 'reply':
        generateReply(msg.tweetText, msg.authorHandle, msg.style, model, url, apiKey).then(function (replies) {
          sendResponse({ replies: replies });
        });
        break;

      case 'listModels':
        listModels(url, apiKey).then(function (models) {
          sendResponse({ models: models });
        });
        break;

      case 'checkBalance':
        if (!cfg.cloud || !apiKey) { sendResponse({ error: 'not in cloud mode' }); break; }
        fetch(CLOUD_URL + '/api/balance', { headers: authHeaders(apiKey), signal: AbortSignal.timeout(5000) })
          .then(function (r) { return r.json(); })
          .then(sendResponse)
          .catch(function () { sendResponse({ error: 'balance check failed' }); });
        break;

      case 'getFreeKey':
        fetch(CLOUD_URL + '/api/free-key', { method: 'POST', signal: AbortSignal.timeout(8000) })
          .then(function (r) { return r.json(); })
          .then(sendResponse)
          .catch(function () { sendResponse({ error: 'could not reach the cloud endpoint' }); });
        break;

      case 'exportData':
        var prefix = platform === 'youtube' ? 'ytrai' : 'xrai';
        chrome.storage.local.get([prefix + '_classifications', prefix + '_corrections'], function (result) {
          sendResponse({
            classifications: result[prefix + '_classifications'] || [],
            corrections: result[prefix + '_corrections'] || []
          });
        });
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
  });

  return true; // async response
});
