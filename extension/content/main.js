/* xrai — Main Orchestrator (flat pipeline, every tweet gets a decision) */
var XraiMain = (function () {
  'use strict';

  var config = null;
  var ollamaAvailable = false;

  function start() {
    console.log('[xrai] Starting...');

    // 1. Init memory (for classification logging)
    XraiMemory.init().catch(function (e) {
      console.warn('[xrai] Memory init error:', e);
    });

    // 2. Load config
    XraiConfig.getConfig().then(function (cfg) {
      config = cfg;
      XraiClassifier.configure(cfg);

      // 3. Check Ollama health via service worker
      chrome.runtime.sendMessage({ action: 'checkHealth' }, function (response) {
        if (chrome.runtime.lastError) {
          console.warn('[xrai] Service worker error:', chrome.runtime.lastError.message);
          ollamaAvailable = false;
          XraiIndicator.update(null, { connected: false, label: 'offline' });
          return;
        }
        ollamaAvailable = response && response.available && response.classify;
        if (response && response.available && response.classify) {
          console.log('[xrai] Ollama connected. Models:', (response.models || []).join(', '));
          XraiIndicator.update(null, { connected: true, classify: true, reply: true });
        } else if (response && response.available) {
          console.warn('[xrai] Ollama running but classify POST failed (CORS?). Pre-filter only.');
          XraiIndicator.update(null, { connected: true, classify: false, reply: false });
        } else {
          console.log('[xrai] Ollama not available. Pre-filter only mode.');
          XraiIndicator.update(null, { connected: false, classify: false, reply: false });
        }
      });

      // 4. Init UI
      XraiIndicator.init();

      // 5. Start detector
      XraiDetector.onTweet(handleTweet);
      XraiDetector.start();

      console.log('[xrai] Running. Filter: ' + cfg.contentFilter + ', Hide: ' + cfg.hideMethod);
    });

    // Periodic health check (every 30s)
    var healthInterval = setInterval(function () {
      if (!chrome.runtime || !chrome.runtime.id) {
        clearInterval(healthInterval);
        return;
      }
      try {
        chrome.runtime.sendMessage({ action: 'checkHealth' }, function (response) {
          if (chrome.runtime.lastError) return;
          var wasAvailable = ollamaAvailable;
          ollamaAvailable = response && response.available && response.classify;
          if (wasAvailable !== ollamaAvailable) {
            XraiIndicator.update(null, {
              connected: response && response.available,
              classify: response && response.classify,
              reply: response && response.reply
            });
          }
        });
      } catch (e) {
        clearInterval(healthInterval);
      }
    }, 30000);
  }

  function handleTweet(info) {
    var el = info.element;
    var data = info.data;
    var threshold = (config && config.confidenceThreshold) || 0.7;

    // Step 1: Reply filter
    if (config && config.contentFilter === 'posts-only' && data.isReply) {
      console.log('[xrai] REPLY hide |', (data.text || '').substring(0, 80));
      XraiHider.hide(el, config.hideMethod);
      XraiIndicator.incrementHidden();
      return;
    }

    // Step 2: Pre-filter (regex)
    var pfResult = XraiPrefilter.prefilter(data);
    if (pfResult) {
      console.log('[xrai] PREFILTER kill:', pfResult.reason, '|', (data.text || '').substring(0, 80));
      XraiHider.hide(el, config ? config.hideMethod : 'remove');
      XraiClassifier.cachePrefilter(data.id, 'noise', pfResult.confidence, pfResult.reason);
      XraiMemory.logClassification(data.text, data.mediaType, 'noise', pfResult.confidence, 'prefilter:' + pfResult.reason);
      XraiIndicator.incrementHidden();
      return;
    }

    // Step 3: If Ollama unavailable, show by default
    if (!ollamaAvailable) {
      console.log('[xrai] OLLAMA OFF \u2014 showing by default:', (data.text || '').substring(0, 80));
      XraiMemory.logClassification(data.text, data.mediaType, 'signal', 0.5, 'default');
      XraiIndicator.incrementShown();
      XraiReply.attachReplyButton(el, data);
      return;
    }

    // Step 4: Classify (cache hit = instant, cache miss = Ollama queue)
    XraiClassifier.classify(data.id, data.text, data.mediaType, function (result) {
      if (result.prediction === 'noise' && result.confidence >= threshold) {
        XraiHider.hide(el, config ? config.hideMethod : 'remove');
        XraiMemory.logClassification(data.text, data.mediaType, 'noise', result.confidence, result.source || 'model');
        XraiIndicator.incrementHidden();
      } else {
        XraiMemory.logClassification(data.text, data.mediaType, 'signal', result.confidence, result.source || 'model');
        XraiIndicator.incrementShown();
        XraiReply.attachReplyButton(el, data);
      }
    });
  }

  // DOM event bridge — allows page JS to request classification data
  window.addEventListener('xrai-export-request', function () {
    Promise.all([XraiMemory.getClassifications(), XraiMemory.getCorrections()])
      .then(function (results) {
        var data = { classifications: results[0], corrections: results[1] };
        var el = document.getElementById('xrai-export-data');
        if (!el) {
          el = document.createElement('div');
          el.id = 'xrai-export-data';
          el.style.display = 'none';
          document.body.appendChild(el);
        }
        el.textContent = JSON.stringify(data);
        window.dispatchEvent(new CustomEvent('xrai-export-response'));
      });
  });

  // Auto-start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  return { start: start };
})();
