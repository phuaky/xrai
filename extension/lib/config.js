/* xrai — Config (chrome.storage.local wrapper) */
var XraiConfig = (function () {
  'use strict';

  var DEFAULTS = {
    model: 'dhiltgen/gemma4:e2b-mlx-bf16',
    ollamaUrl: 'http://localhost:11434',
    confidenceThreshold: 0.7,
    contentFilter: 'posts-only',
    hideMethod: 'remove',
    replyStyle: 'curious',
    memoryRetentionDays: 30,
    maxModelCallsPerMinute: 100,
    batchSize: 5,
    batchFlushDelay: 2000
  };

  var cache = null;

  function getConfig() {
    return new Promise(function (resolve) {
      if (cache) { resolve(Object.assign({}, cache)); return; }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('xrai_config', function (result) {
          cache = Object.assign({}, DEFAULTS, result.xrai_config || {});
          resolve(Object.assign({}, cache));
        });
      } else {
        cache = Object.assign({}, DEFAULTS);
        resolve(Object.assign({}, cache));
      }
    });
  }

  function saveConfig(partial) {
    return new Promise(function (resolve) {
      cache = Object.assign({}, cache || DEFAULTS, partial);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ xrai_config: cache }, function () {
          resolve(Object.assign({}, cache));
        });
      } else {
        resolve(Object.assign({}, cache));
      }
    });
  }

  function resetConfig() {
    cache = null;
    return new Promise(function (resolve) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove('xrai_config', function () {
          cache = Object.assign({}, DEFAULTS);
          resolve(Object.assign({}, cache));
        });
      } else {
        cache = Object.assign({}, DEFAULTS);
        resolve(Object.assign({}, cache));
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
