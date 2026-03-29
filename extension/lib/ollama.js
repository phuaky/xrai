/* xrai — Ollama client (health check + model calls) */
var XraiOllama = (function () {
  'use strict';

  var CLASSIFY_SYSTEM = 'You classify tweets for an AI engineer and entrepreneur. Output ONLY valid JSON.\n\nSIGNAL = content about: AI/ML, coding, developer tools, startups, SaaS, product building, tech announcements, engineering insights, business strategy with data, AI-generated media showcasing capabilities.\n\nNOISE = everything else: entertainment, sports, anime, cooking, lifestyle, motivational quotes, political opinions, celebrity gossip, memes, reaction videos, vague life advice, humor clips.\n\nScore 5 dimensions (0 or 1 each):\n- RELEVANT: About tech, AI, coding, startups, or business (1)? Or entertainment, lifestyle, general content (0)?\n- NOVELTY: New info, tool, announcement (1)? Or recycled take (0)?\n- SPECIFICITY: Names, numbers, tools, examples (1)? Or vague (0)?\n- DENSITY: High insight per word (1)? Or filler (0)?\n- ACTIONABLE: Reader can learn or apply this (1)? Or just an opinion (0)?\n\nIMPORTANT: If RELEVANT=0, the tweet is NOISE regardless of other scores.\nScore 4-5 = signal. 0-3 = noise.\n\nVideo/image with short vague text and no tech context = noise.\n\nOutput: {"prediction":"signal"|"noise","confidence":0.0-1.0}';

  var REPLY_SYSTEM = 'Generate short reply options for a tweet. Output ONLY valid JSON array.\nRules: 5-15 words each, max 80 chars, no hashtags, match the tweet energy.\nOutput: [{"style":"curious","text":"..."},{"style":"insight","text":"..."},{"style":"connect","text":"..."}]';

  function checkHealth(ollamaUrl) {
    ollamaUrl = ollamaUrl || 'http://localhost:11434';
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

  function classify(text, mediaType, model, ollamaUrl) {
    ollamaUrl = ollamaUrl || 'http://localhost:11434';
    model = model || 'qwen2.5:1.5b';
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
        var content = (data.message && data.message.content) || '';
        return parseClassification(content);
      })
      .catch(function () {
        return { prediction: 'noise', confidence: 0.5 };
      });
  }

  function classifyBatch(tweets, model, ollamaUrl) {
    ollamaUrl = ollamaUrl || 'http://localhost:11434';
    model = model || 'qwen2.5:1.5b';
    if (!tweets || tweets.length === 0) return Promise.resolve([]);
    if (tweets.length === 1) {
      return classify(tweets[0].text, tweets[0].mediaType, model, ollamaUrl)
        .then(function (r) { return [Object.assign({ id: tweets[0].id }, r)]; });
    }
    var lines = tweets.map(function (t, i) {
      var tag = t.mediaType && t.mediaType !== 'text' ? ' [' + t.mediaType + ']' : '';
      return (i + 1) + '. "' + t.text.substring(0, 200) + '"' + tag;
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
        var content = (data.message && data.message.content) || '';
        return parseBatchClassification(content, tweets);
      })
      .catch(function () {
        return tweets.map(function (t) {
          return { id: t.id, prediction: 'noise', confidence: 0.5 };
        });
      });
  }

  function generateReply(tweetText, authorHandle, voiceProfile, style, model, ollamaUrl) {
    ollamaUrl = ollamaUrl || 'http://localhost:11434';
    model = model || 'qwen2.5:1.5b';
    style = style || 'curious';
    var userMsg = 'Tweet by @' + (authorHandle || 'unknown') + ': "' + tweetText + '"';
    if (voiceProfile) {
      userMsg += '\nReply in this style: ' + voiceProfile;
    }
    userMsg += '\nPreferred style: ' + style;

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
        var content = (data.message && data.message.content) || '';
        return parseReplies(content);
      })
      .catch(function () {
        return [{ style: 'error', text: 'Failed to generate reply. Is Ollama running?' }];
      });
  }

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
    return [{ style: 'error', text: 'Could not parse reply. Try again.' }];
  }

  return {
    checkHealth: checkHealth,
    classify: classify,
    classifyBatch: classifyBatch,
    generateReply: generateReply
  };
})();
