/* xrai — Service Worker (proxies Ollama HTTP calls for content scripts) */

var DEFAULT_URL = 'http://localhost:11434';
var DEFAULT_MODEL = 'phi4-mini';

var CLASSIFY_SYSTEM = 'You classify tweets as signal or noise. Output ONLY valid JSON.\nScore 4 dimensions (0 or 1 each):\n- NOVELTY: New info (1) or recycled take (0)?\n- SPECIFICITY: Concrete details (1) or vague claims (0)?\n- DENSITY: High insight per word (1) or filler (0)?\n- AUTHENTICITY: Genuine sharing (1) or engagement farming (0)?\n\nNOISE indicators: ALL CAPS text, vague hype (\"insane\", \"wild\", \"crazy\"), video+short text, no concrete details, crypto pumps.\nSIGNAL indicators: specific numbers/tools/results, personal experience with details, technical content.\n\nScore 3-4 = signal (confidence 0.75-0.95). Score 0-2 = noise (confidence 0.75-0.95). Score 2 with some specifics = noise confidence 0.6.\nOutput: {"prediction":"signal"|"noise","confidence":0.6-0.95,"reason":"1-5 word summary"}';

var REPLY_SYSTEM = 'Generate short reply options for a tweet. Output ONLY valid JSON array.\nRules: 5-15 words each, max 80 chars, no hashtags, match energy.\nOutput: [{"style":"curious","text":"..."},{"style":"insight","text":"..."},{"style":"connect","text":"..."}]';

// Get config from storage
function getConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('xrai_config', function (result) {
      var cfg = result.xrai_config || {};
      resolve({
        ollamaUrl: cfg.ollamaUrl || DEFAULT_URL,
        model: cfg.model || DEFAULT_MODEL
      });
    });
  });
}

// Health check — tests actual POST (catches CORS issues), not just GET
function checkHealth(ollamaUrl, model) {
  var result = { available: false, models: [], classify: false, reply: false };

  return fetch(ollamaUrl + '/api/tags', {
    method: 'GET',
    signal: AbortSignal.timeout(3000)
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      result.models = (data.models || []).map(function (m) { return m.name; });
      result.available = true;
      // Now test actual POST (this is what was returning 403)
      return fetch(ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          options: { num_predict: 1 }
        })
      });
    })
    .then(function (r) {
      if (r.ok) {
        result.classify = true;
        result.reply = true; // same endpoint, if classify works reply works
      }
      return result;
    })
    .catch(function () {
      return result;
    });
}

// === Model I/O log — POSTs to local collector (data/model-io.jsonl) ===
var COLLECTOR_URL = 'http://localhost:11435';

function logModelIO(input, rawOutput, parsed, model, elapsed) {
  var entry = {
    input: input.substring(0, 500),
    rawOutput: rawOutput.substring(0, 1000),
    prediction: parsed.prediction,
    confidence: parsed.confidence,
    model: model,
    elapsed: elapsed,
    timestamp: Date.now()
  };
  // Fire and forget — don't block classification if collector isn't running
  fetch(COLLECTOR_URL + '/model-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  }).catch(function () { /* collector not running, that's fine */ });
}

// Classify single tweet
function classifySingle(text, mediaType, model, ollamaUrl) {
  var userMsg = 'Tweet: "' + text + '"';
  if (mediaType && mediaType !== 'text') {
    userMsg += ' [has ' + mediaType + ']';
  }
  var start = Date.now();
  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 80 }
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = (data.message && data.message.content) || '';
      var parsed = parseClassification(raw);
      logModelIO(userMsg, raw, parsed, model, Date.now() - start);
      return parsed;
    })
    .catch(function () {
      return { prediction: 'noise', confidence: 0.5 };
    });
}

// Classify batch
function classifyBatch(tweets, model, ollamaUrl) {
  if (!tweets || tweets.length === 0) return Promise.resolve([]);
  if (tweets.length === 1) {
    return classifySingle(tweets[0].text, tweets[0].mediaType, model, ollamaUrl)
      .then(function (r) {
        return [{ id: tweets[0].id, prediction: r.prediction, confidence: r.confidence }];
      });
  }

  var lines = tweets.map(function (t, i) {
    var tag = t.mediaType && t.mediaType !== 'text' ? ' [' + t.mediaType + ']' : '';
    return (i + 1) + '. "' + (t.text || '').substring(0, 200) + '"' + tag;
  });
  var userMsg = 'Classify each tweet:\n' + lines.join('\n') + '\nOutput JSON array: [{"id":1,"prediction":"signal"|"noise","confidence":0.0-1.0},...]';

  var start = Date.now();
  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 60 * tweets.length }
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var raw = (data.message && data.message.content) || '';
      var results = parseBatchClassification(raw, tweets);
      logModelIO(userMsg, raw, { prediction: 'batch(' + results.length + ')', confidence: 0 }, model, Date.now() - start);
      return results;
    })
    .catch(function () {
      return tweets.map(function (t) {
        return { id: t.id, prediction: 'noise', confidence: 0.5 };
      });
    });
}

// Generate reply
function generateReply(tweetText, authorHandle, style, model, ollamaUrl) {
  var userMsg = 'Tweet by @' + (authorHandle || 'unknown') + ': "' + tweetText + '"';
  userMsg += '\nPreferred style: ' + (style || 'curious');

  return fetch(ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: REPLY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      stream: false,
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

// List models
function listModels(ollamaUrl) {
  return fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      return (data.models || []).map(function (m) { return m.name; });
    })
    .catch(function () { return []; });
}

// --- Parse helpers ---

function parseClassification(content) {
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

function parseBatchClassification(content, tweets) {
  try {
    var match = content.match(/\[[\s\S]*?\]/);
    if (match) {
      var arr = JSON.parse(match[0]);
      return tweets.map(function (t, i) {
        var item = arr[i] || {};
        return {
          id: t.id,
          prediction: item.prediction === 'signal' ? 'signal' : 'noise',
          confidence: Math.min(1, Math.max(0, parseFloat(item.confidence) || 0.5))
        };
      });
    }
  } catch (e) { /* fallback */ }
  return tweets.map(function (t) {
    return { id: t.id, prediction: 'noise', confidence: 0.5 };
  });
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

  getConfig().then(function (cfg) {
    var url = cfg.ollamaUrl;
    var model = cfg.model;

    switch (msg.action) {
      case 'checkHealth':
        checkHealth(url, model || DEFAULT_MODEL).then(sendResponse);
        break;

      case 'classify':
        classifySingle(msg.text, msg.mediaType, model, url).then(sendResponse);
        break;

      case 'classifyBatch':
        classifyBatch(msg.tweets || [], model, url).then(function (results) {
          sendResponse({ results: results });
        });
        break;

      case 'reply':
        generateReply(msg.tweetText, msg.authorHandle, msg.style, model, url).then(function (replies) {
          sendResponse({ replies: replies });
        });
        break;

      case 'listModels':
        listModels(url).then(function (models) {
          sendResponse({ models: models });
        });
        break;

      case 'exportData':
        chrome.storage.local.get(['xrai_classifications', 'xrai_corrections'], function (result) {
          sendResponse({
            classifications: result.xrai_classifications || [],
            corrections: result.xrai_corrections || []
          });
        });
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
  });

  return true; // async response
});
