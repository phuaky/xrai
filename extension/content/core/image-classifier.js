/* rai — Image Classifier (small concurrent queue for image bait checks, platform-agnostic) */
var RaiImageClassifier = (function () {
  'use strict';

  // Image calls are slow (1-3s+) and the vision model is RAM-heavy when
  // warm — keep concurrency low so a fast scroll doesn't pile up requests.
  var MAX_CONCURRENT = 2;
  var _platform = 'x';

  var resultCache = {};    // id -> { baity, confidence, reason, source }
  var queue = [];          // { id, payload, cb }
  var activeCount = 0;

  function configure(cfg) {
    if (!cfg) return;
    if (cfg.platform) _platform = cfg.platform;
  }

  function checkCache(id) {
    return resultCache[id] || null;
  }

  function cacheResult(id, result) {
    resultCache[id] = result;
  }

  function clearCache(id) {
    if (id) { delete resultCache[id]; } else { resultCache = {}; }
  }

  // payload: { imageUrl, contextText }
  function classify(id, payload, cb) {
    var cached = checkCache(id);
    if (cached) {
      if (cb) cb(cached);
      return;
    }
    queue.push({ id: id, payload: payload || {}, cb: cb });
    drain();
  }

  function drain() {
    while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
      send(queue.shift());
    }
  }

  function send(item) {
    activeCount++;

    if (!chrome.runtime || !chrome.runtime.id) {
      // Extension context invalidated (reload) — fail open, never hide on this.
      activeCount--;
      if (item.cb) item.cb({ baity: false, confidence: 0, source: 'error' });
      return;
    }

    var msg = {
      action: 'classifyImage',
      platform: _platform,
      imageUrl: item.payload.imageUrl,
      contextText: item.payload.contextText
    };

    chrome.runtime.sendMessage(msg, function (response) {
      activeCount--;

      var result;
      if (chrome.runtime.lastError || !response) {
        result = { baity: false, confidence: 0, source: 'error' };
      } else {
        result = Object.assign({ source: 'model' }, response);
      }
      cacheResult(item.id, result);

      try {
        console.log('[rai] IMAGE  | ' + _platform + ' | id:' + item.id + ' | baity:' + result.baity +
          (result.confidence !== undefined ? ' (' + result.confidence + ')' : ''));
      } catch (e) { /* logging is best-effort */ }

      if (item.cb) item.cb(result);
      drain();
    });
  }

  return {
    configure: configure,
    checkCache: checkCache,
    cacheResult: cacheResult,
    clearCache: clearCache,
    classify: classify
  };
})();
