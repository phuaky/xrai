/* xrai — Classifier (concurrent queue with result cache) */
var XraiClassifier = (function () {
  'use strict';

  var MAX_CONCURRENT = 5;
  var MAX_CALLS_PER_MINUTE = 20;

  var resultCache = {};    // tweetId -> { prediction, confidence, source }
  var queue = [];          // { id, text, mediaType, cb }
  var activeCount = 0;
  var callTimestamps = [];

  function configure(cfg) {
    // Accept config but we only need maxModelCallsPerMinute
    if (cfg.maxModelCallsPerMinute) MAX_CALLS_PER_MINUTE = cfg.maxModelCallsPerMinute;
  }

  function checkCache(id) {
    return resultCache[id] || null;
  }

  function cacheResult(id, result) {
    resultCache[id] = result;
  }

  function isRateLimited() {
    var now = Date.now();
    callTimestamps = callTimestamps.filter(function (t) { return now - t < 60000; });
    return callTimestamps.length >= MAX_CALLS_PER_MINUTE;
  }

  function classify(id, text, mediaType, cb) {
    // Check cache first
    var cached = checkCache(id);
    if (cached) {
      console.log('[xrai] CACHE hit:', cached.prediction, '(' + cached.confidence + ')', '|', (text || '').substring(0, 80));
      if (cb) cb(cached);
      return;
    }

    // Queue for Ollama
    queue.push({ id: id, text: text, mediaType: mediaType, cb: cb });
    drain();
  }

  function drain() {
    while (queue.length > 0 && activeCount < MAX_CONCURRENT && !isRateLimited()) {
      var item = queue.shift();
      send(item);
    }

    // If rate limited and items remain, retry after delay
    if (queue.length > 0 && isRateLimited()) {
      setTimeout(drain, 3000);
    }
  }

  function send(item) {
    activeCount++;
    callTimestamps.push(Date.now());

    if (!chrome.runtime || !chrome.runtime.id) {
      activeCount--;
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'classify', text: item.text, mediaType: item.mediaType },
      function (response) {
        activeCount--;

        if (chrome.runtime.lastError || !response) {
          var fallback = { prediction: 'noise', confidence: 0.5, source: 'error' };
          cacheResult(item.id, fallback);
          console.log('[xrai] OLLAMA error, fallback noise |', (item.text || '').substring(0, 80));
          if (item.cb) item.cb(fallback);
        } else {
          var result = {
            prediction: response.prediction || 'noise',
            confidence: response.confidence || 0.5,
            source: 'model'
          };
          cacheResult(item.id, result);
          console.log('[xrai] OLLAMA \u2192', result.prediction, '(' + result.confidence + ')', '|', (item.text || '').substring(0, 80));
          if (item.cb) item.cb(result);
        }

        // Drain next
        drain();
      }
    );
  }

  // Allow prefilter results to be cached too
  function cachePrefilter(id, prediction, confidence, reason) {
    cacheResult(id, { prediction: prediction, confidence: confidence, source: 'prefilter:' + reason });
  }

  return {
    configure: configure,
    classify: classify,
    checkCache: checkCache,
    cachePrefilter: cachePrefilter
  };
})();
