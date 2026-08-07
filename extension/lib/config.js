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
      // 'remove' drops hidden cards from the feed entirely — noise costs zero
      // attention. False-hide evidence comes from offline judge audits of the
      // durable decision log now, not live corrections ('blur' + peek is
      // still selectable in settings).
      hideMethod: 'remove',
      configVersion: 3,
      memoryRetentionDays: 30,
      maxModelCallsPerMinute: 100,
      batchSize: 5,
      batchFlushDelay: 2000,
      // Image bait check — gates image-bearing signal tweets behind a vision
      // model before reveal (blur first, same as YouTube). See CLAUDE.md.
      // Paused by default after 1,626 live checks produced zero bait verdicts
      // at p50 4.8s / p95 16.0s. It remains available as an opt-in control
      // while labeled image data accumulates.
      imageBaitEnabled: false,
      imageModel: 'qwen3-vl:30b',
      imageConfidenceThreshold: 0.6,
      // Hop nudge — cross-platform X ↔ YouTube doom-loop detector (worker
      // evaluates; this toggle only gates the overlay on this platform).
      hopNudge: true,
      // Reply guard — on the user's OWN status pages, classify replies as
      // bad faith (hostile/bot/spam) vs fine and blur the bad ones. Targets
      // bad faith, NOT sentiment: critical/skeptical on-topic replies stay
      // visible. Replies are always blur-with-peek regardless of hideMethod —
      // a wrongly hidden reply on your own post could be a lead.
      replyGuard: true,
      ownHandle: 'phuakuanyu',
      replyConfidenceThreshold: 0.7,
      // Post-reveal semantic-memory pass. Stage 1 remains authoritative; this
      // can only request a reversible collapse after the tweet is visible.
      memoryAware: true,
      memoryConfidenceThreshold: 0.75,
      // Cloud mode — routes classification through the hosted endpoint
      // instead of local Ollama, for users who skip local setup. Free
      // while in beta, opt-in, off by default. See background/worker.js.
      mode: 'local',
      cloudApiKey: ''
    },
    youtube: {
      configVersion: 1,
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
      imageBaitEnabled: false,
      imageModel: 'qwen3-vl:30b',
      imageConfidenceThreshold: 0.6,
      // Shorts consumption tracker + gentle doom-scroll nudge
      shortsNudge: true,             // show the snap-out overlay past the limit
      shortsLimitCount: 10,          // nudge after N Shorts in one binge
      shortsLimitMinutes: 5,         // ...or M minutes of continuous Shorts
      // Hop nudge — see the x block above; one detector, per-platform overlay toggle.
      hopNudge: true,
      // Cloud mode — see the x block above for details. X and YouTube share
      // one cloudApiKey (one account, one balance, both platforms).
      mode: 'local',
      cloudApiKey: ''
    }
  };

  var cache = {}; // platform -> config object
  var listeners = {}; // platform -> config change listeners in this content world

  function notify(platform) {
    var snapshot = Object.assign({}, cache[platform] || defaultsFor(platform));
    (listeners[platform] || []).forEach(function (listener) {
      try { listener(snapshot); } catch (e) { /* config saved even if a listener fails */ }
    });
  }

  function keyFor(platform) {
    return (PREFIX[platform] || 'xrai') + '_config';
  }

  function defaultsFor(platform) {
    return DEFAULTS[platform] || DEFAULTS.x;
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  // A tab opened before an extension reload keeps its old content script;
  // chrome.storage calls in it throw "Extension context invalidated". Fail
  // soft to defaults there — never spray uncaught errors from orphaned tabs.
  function safeGet(key, cb) {
    try {
      chrome.storage.local.get(key, cb);
    } catch (e) {
      cb({});
    }
  }

  function safeSet(obj, cb) {
    try {
      chrome.storage.local.set(obj, function () { if (cb) cb(); });
    } catch (e) {
      if (cb) cb();
    }
  }

  function getConfig(platform) {
    platform = platform || 'x';
    return new Promise(function (resolve) {
      if (cache[platform]) { resolve(Object.assign({}, cache[platform])); return; }
      if (hasStorage()) {
        safeGet(keyFor(platform), function (result) {
          var stored = result[keyFor(platform)] || {};
          // v2 migration (Jul 2026): X default flipped blur→remove when the ✗
          // correction affordance was removed. Applies once to configs saved
          // before configVersion existed; a deliberate blur re-pick afterwards
          // sticks (saves carry configVersion from DEFAULTS).
          if (platform === 'x' && !stored.configVersion && stored.hideMethod === 'blur') {
            stored.hideMethod = 'remove';
            stored.configVersion = 2;
          }
          // Aug 2026: pause the unevaluated 30B vision gate after live
          // telemetry showed multi-second waits and no positive catches.
          // A deliberate re-enable after this one-time migration sticks.
          var currentVersion = defaultsFor(platform).configVersion || 0;
          if ((stored.configVersion || 0) < currentVersion) {
            stored.imageBaitEnabled = false;
            stored.configVersion = currentVersion;
            var migrated = {};
            migrated[keyFor(platform)] = stored;
            safeSet(migrated);
          }
          cache[platform] = Object.assign({}, defaultsFor(platform), stored);
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
        safeSet(obj, function () {
          notify(platform);
          resolve(Object.assign({}, cache[platform]));
        });
      } else {
        notify(platform);
        resolve(Object.assign({}, cache[platform]));
      }
    });
  }

  function resetConfig(platform) {
    platform = platform || 'x';
    cache[platform] = null;
    return new Promise(function (resolve) {
      function toDefaults() {
        cache[platform] = Object.assign({}, defaultsFor(platform));
        notify(platform);
        resolve(Object.assign({}, cache[platform]));
      }
      if (hasStorage()) {
        try {
          chrome.storage.local.remove(keyFor(platform), toDefaults);
        } catch (e) {
          toDefaults();
        }
      } else {
        toDefaults();
      }
    });
  }

  function onChanged(platform, listener) {
    platform = platform || 'x';
    if (typeof listener !== 'function') return function () {};
    if (!listeners[platform]) listeners[platform] = [];
    listeners[platform].push(listener);
    return function () {
      var index = listeners[platform].indexOf(listener);
      if (index !== -1) listeners[platform].splice(index, 1);
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    getConfig: getConfig,
    saveConfig: saveConfig,
    resetConfig: resetConfig,
    onChanged: onChanged
  };
})();
