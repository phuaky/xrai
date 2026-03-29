/* xrai — Service Worker (proxies Ollama HTTP calls for content scripts) */

var DEFAULT_URL = 'http://localhost:11434';
var DEFAULT_MODEL = 'qwen2.5:1.5b';

var CLASSIFY_SYSTEM = 'You classify tweets as signal or noise. Output ONLY valid JSON.\nScore 4 dimensions (0 or 1 each):\n- NOVELTY: New info (1) or recycled take (0)?\n- SPECIFICITY: Concrete details (1) or vague (0)?\n- DENSITY: High insight per word (1) or filler (0)?\n- AUTHENTICITY: Genuine (1) or engagement farming (0)?\nMedia with vague text = noise.\nScore 3-4 = signal. 0-2 = noise.\nOutput: {"prediction":"signal"|"noise","confidence":0.0-1.0}';

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

// Health check
function checkHealth(ollamaUrl) {
  return fetch(ollamaUrl + '/api/tags', {
    method: 'GET',
    signal: AbortSignal.timeout(3000)
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var models = (data.models || []).map(function (m) { return m.name; });
      return { available: true, models: models };
    })
    .catch(function () {
      return { available: false, models: [] };
    });
}

// Classify single tweet
function classifySingle(text, mediaType, model, ollamaUrl) {
  var userMsg = 'Tweet: "' + text + '"';
  if (mediaType && mediaType !== 'text') {
    userMsg += ' [has ' + mediaType + ']';
  }
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
      return parseClassification((data.message && data.message.content) || '');
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
      return parseBatchClassification((data.message && data.message.content) || '', tweets);
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
      return {
        prediction: obj.prediction === 'signal' ? 'signal' : 'noise',
        confidence: Math.min(1, Math.max(0, parseFloat(obj.confidence) || 0.5))
      };
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
        checkHealth(url).then(sendResponse);
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

      default:
        sendResponse({ error: 'Unknown action' });
    }
  });

  return true; // async response
});
