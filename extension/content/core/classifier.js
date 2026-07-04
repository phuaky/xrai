/* rai — Classifier (concurrent queue with result cache, platform-agnostic) */
var RaiClassifier = (function () {
  'use strict';

  var MAX_CONCURRENT = 5;
  var MAX_CALLS_PER_MINUTE = 100;
  var _platform = 'x';

  var resultCache = {};    // id -> result object (whatever the worker returned + source)
  var queue = [];          // { id, payload, cb }
  var activeCount = 0;
  var callTimestamps = [];

  function configure(cfg) {
    if (!cfg) return;
    if (cfg.maxModelCallsPerMinute) MAX_CALLS_PER_MINUTE = cfg.maxModelCallsPerMinute;
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

  function isRateLimited() {
    var now = Date.now();
    callTimestamps = callTimestamps.filter(function (t) { return now - t < 60000; });
    return callTimestamps.length >= MAX_CALLS_PER_MINUTE;
  }

  // payload: platform-specific object forwarded to the worker.
  //   X       -> { text, mediaType, author }
  //   youtube -> { text (title), channel }
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
    while (queue.length > 0 && activeCount < MAX_CONCURRENT && !isRateLimited()) {
      send(queue.shift());
    }
    if (queue.length > 0 && isRateLimited()) {
      setTimeout(drain, 3000);
    }
  }

  function send(item) {
    activeCount++;
    callTimestamps.push(Date.now());

    if (!chrome.runtime || !chrome.runtime.id) {
      // Extension context invalidated (reload). Fail open so the caller can
      // clear the pending blur instead of leaving the card stuck forever.
      activeCount--;
      if (item.cb) item.cb({ source: 'error' });
      return;
    }

    var msg = Object.assign({ action: 'classify', platform: _platform }, item.payload);

    chrome.runtime.sendMessage(msg, function (response) {
      activeCount--;

      var result;
      if (chrome.runtime.lastError || !response) {
        result = { source: 'error' };
      } else {
        result = Object.assign({ source: 'model' }, response);
      }
      cacheResult(item.id, result);

      try {
        console.log('[rai] OLLAMA | ' + _platform + ' | id:' + item.id + ' | ' +
          (result.prediction || result.category || result.source) +
          (result.confidence !== undefined ? ' (' + result.confidence + ')' : '') +
          ' | ' + ((item.payload && item.payload.text) || '').substring(0, 70));
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
