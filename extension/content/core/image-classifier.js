/* rai — Image Classifier (small concurrent queue for image bait checks, platform-agnostic) */
var RaiImageClassifier = (function () {
  'use strict';

  // Vision calls are RAM-heavy and Ollama serializes them on the target
  // machine. One in flight avoids multiplying per-card wait time.
  var MAX_CONCURRENT = 1;
  var _platform = 'x';

  var resultCache = {};    // id -> { baity, confidence, reason, source }
  var queue = [];          // { id, payload, cb }
  var activeCount = 0;

  // Activity feed for the status pill/panel — same contract as RaiClassifier.
  // `current` is the most recently dispatched, still-unresolved item.
  var _activityCb = null;
  var _activeItem = null;

  function onActivity(cb) { _activityCb = cb; }

  function notifyActivity() {
    if (!_activityCb) return;
    try {
      _activityCb({
        current: _activeItem ? {
          id: _activeItem.id,
          text: (_activeItem.payload && _activeItem.payload.contextText) || '',
          author: '',
          channel: ''
        } : null,
        active: activeCount,
        queued: queue.length
      });
    } catch (e) { /* listener error, keep classifying */ }
  }

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
    notifyActivity();
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
      notifyActivity();
      if (item.cb) item.cb({ baity: false, confidence: 0, source: 'error' });
      return;
    }

    _activeItem = item;
    notifyActivity();

    var msg = {
      action: 'classifyImage',
      platform: _platform,
      imageUrl: item.payload.imageUrl,
      contextText: item.payload.contextText
    };

    chrome.runtime.sendMessage(msg, function (response) {
      activeCount--;
      if (_activeItem === item) _activeItem = null;
      notifyActivity();

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
    classify: classify,
    onActivity: onActivity
  };
})();
