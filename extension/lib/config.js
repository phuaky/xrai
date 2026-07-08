/* rai — Config (chrome.storage.local wrapper, per-platform) */
var RaiConfig = (function () {
  'use strict';

  // Storage-key prefix per platform — keeps X data (xrai_*) and YouTube data
  // (ytrai_*) fully separate. X keys are unchanged from the pre-split layout,
  // so existing X config/stats/training data is preserved.
  var PREFIX = { x: 'xrai', youtube: 'ytrai' };

  var DEFAULTS = {
    x: {
      model: 'dhiltgen/gemma4:e2b-mlx-bf16',
      ollamaUrl: 'http://localhost:11434',
      confidenceThreshold: 0.7,
      contentFilter: 'posts-only',
      // 'blur' keeps hidden cards visible-but-quiet: the ✗ correction button
      // stays reachable, so false-hides can be caught. 'remove' hides them
      // completely and silently (no correction possible).
      hideMethod: 'blur',
      replyStyle: 'curious',
      memoryRetentionDays: 30,
      maxModelCallsPerMinute: 100,
      batchSize: 5,
      batchFlushDelay: 2000,
      // Image bait check — gates image-bearing signal tweets behind a vision
      // model before reveal (blur first, same as YouTube). See CLAUDE.md.
      imageBaitEnabled: true,
      imageModel: 'qwen3-vl:30b',
      imageConfidenceThreshold: 0.6
    },
    youtube: {
      model: 'gemma2:2b',
      ollamaUrl: 'http://localhost:11434',
      confidenceThreshold: 0.6,
      keepMotivational: true,        // also keep motivational videos, not just music
      hideMethod: 'blur',            // blur everything that isn't kept
      memoryRetentionDays: 30,
      maxModelCallsPerMinute: 120,
      // Image bait check — gates music/motivational thumbnails behind a
      // vision model before reveal, to catch bait thumbnails on titles that
      // would otherwise pass the text classifier.
      imageBaitEnabled: true,
      imageModel: 'qwen3-vl:30b',
      imageConfidenceThreshold: 0.6,
      // Shorts consumption tracker + gentle doom-scroll nudge
      shortsNudge: true,             // show the snap-out overlay past the limit
      shortsLimitCount: 10,          // nudge after N Shorts in one binge
      shortsLimitMinutes: 5          // ...or M minutes of continuous Shorts
    }
  };

  var cache = {}; // platform -> config object

  function keyFor(platform) {
    return (PREFIX[platform] || 'xrai') + '_config';
  }

  function defaultsFor(platform) {
    return DEFAULTS[platform] || DEFAULTS.x;
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function getConfig(platform) {
    platform = platform || 'x';
    return new Promise(function (resolve) {
      if (cache[platform]) { resolve(Object.assign({}, cache[platform])); return; }
      if (hasStorage()) {
        chrome.storage.local.get(keyFor(platform), function (result) {
          cache[platform] = Object.assign({}, defaultsFor(platform), result[keyFor(platform)] || {});
          resolve(Object.assign({}, cache[platform]));
        });
      } else {
        cache[platform] = Object.assign({}, defaultsFor(platform));
        resolve(Object.assign({}, cache[platform]));
      }
    });
  }

  function saveConfig(platform, partial) {
    platform = platform || 'x';
    return new Promise(function (resolve) {
      cache[platform] = Object.assign({}, cache[platform] || defaultsFor(platform), partial);
      if (hasStorage()) {
        var obj = {};
        obj[keyFor(platform)] = cache[platform];
        chrome.storage.local.set(obj, function () {
          resolve(Object.assign({}, cache[platform]));
        });
      } else {
        resolve(Object.assign({}, cache[platform]));
      }
    });
  }

  function resetConfig(platform) {
    platform = platform || 'x';
    cache[platform] = null;
    return new Promise(function (resolve) {
      if (hasStorage()) {
        chrome.storage.local.remove(keyFor(platform), function () {
          cache[platform] = Object.assign({}, defaultsFor(platform));
          resolve(Object.assign({}, cache[platform]));
        });
      } else {
        cache[platform] = Object.assign({}, defaultsFor(platform));
        resolve(Object.assign({}, cache[platform]));
      }
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    getConfig: getConfig,
    saveConfig: saveConfig,
    resetConfig: resetConfig
  };
})();
