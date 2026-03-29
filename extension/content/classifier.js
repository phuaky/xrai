/* xrai — Classifier Queue (batching, rate limiting, worker messaging) */
var XraiClassifier = (function () {
  'use strict';

  var queue = [];
  var callbacks = {};  // id -> callback fn
  var flushTimer = null;
  var callTimestamps = [];  // rate limit tracking
  var config = { batchSize: 5, batchFlushDelay: 2000, maxModelCallsPerMinute: 20 };

  function configure(cfg) {
    if (cfg.batchSize) config.batchSize = cfg.batchSize;
    if (cfg.batchFlushDelay) config.batchFlushDelay = cfg.batchFlushDelay;
    if (cfg.maxModelCallsPerMinute) config.maxModelCallsPerMinute = cfg.maxModelCallsPerMinute;
  }

  function isRateLimited() {
    var now = Date.now();
    // Remove timestamps older than 1 minute
    callTimestamps = callTimestamps.filter(function (t) { return now - t < 60000; });
    return callTimestamps.length >= config.maxModelCallsPerMinute;
  }

  function enqueue(id, text, mediaType, cb) {
    queue.push({ id: id, text: text, mediaType: mediaType });
    if (cb) callbacks[id] = cb;

    if (queue.length >= config.batchSize) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, config.batchFlushDelay);
    }
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;

    if (queue.length === 0) return;
    if (isRateLimited()) {
      // Retry after a short delay
      flushTimer = setTimeout(flush, 5000);
      return;
    }

    var batch = queue.splice(0, config.batchSize);
    callTimestamps.push(Date.now());

    var tweets = batch.map(function (t) {
      return { id: t.id, text: t.text, mediaType: t.mediaType };
    });

    chrome.runtime.sendMessage(
      { action: 'classifyBatch', tweets: tweets },
      function (response) {
        if (chrome.runtime.lastError) {
          // On error, mark all as noise
          batch.forEach(function (t) {
            if (callbacks[t.id]) {
              callbacks[t.id]({ id: t.id, prediction: 'noise', confidence: 0.5 });
              delete callbacks[t.id];
            }
          });
          return;
        }
        var results = (response && response.results) || [];
        batch.forEach(function (t, i) {
          var result = results[i] || { id: t.id, prediction: 'noise', confidence: 0.5 };
          if (callbacks[t.id]) {
            callbacks[t.id](result);
            delete callbacks[t.id];
          }
        });
      }
    );

    // If more items remain, schedule next flush
    if (queue.length > 0) {
      flushTimer = setTimeout(flush, config.batchFlushDelay);
    }
  }

  return {
    configure: configure,
    enqueue: enqueue,
    flush: flush
  };
})();
