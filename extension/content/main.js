/* xrai — Main Orchestrator (wires everything together) */
var XraiMain = (function () {
  'use strict';

  var config = null;
  var ollamaAvailable = false;

  function start() {
    console.log('[xrai] Starting...');

    // 1. Init memory
    XraiMemory.init()
      .then(function () {
        return XraiMemory.pruneOld(30);
      })
      .then(function (pruned) {
        if (pruned > 0) console.log('[xrai] Pruned ' + pruned + ' old entries');
      })
      .catch(function (e) {
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
        ollamaAvailable = response && response.available;
        if (ollamaAvailable) {
          console.log('[xrai] Ollama connected. Models:', (response.models || []).join(', '));
          XraiIndicator.update(null, { connected: true, label: 'local' });
        } else {
          console.log('[xrai] Ollama not available. Pre-filter only mode.');
          XraiIndicator.update(null, { connected: false, label: 'pre-filter only' });
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
    setInterval(function () {
      chrome.runtime.sendMessage({ action: 'checkHealth' }, function (response) {
        if (chrome.runtime.lastError) return;
        var wasAvailable = ollamaAvailable;
        ollamaAvailable = response && response.available;
        if (wasAvailable !== ollamaAvailable) {
          XraiIndicator.update(null, {
            connected: ollamaAvailable,
            label: ollamaAvailable ? 'local' : 'pre-filter only'
          });
        }
      });
    }, 30000);
  }

  function handleTweet(info) {
    var el = info.element;
    var data = info.data;

    // Step 1: Reply filter — skip replies if config says posts-only
    if (config && config.contentFilter === 'posts-only' && data.isReply) {
      XraiHider.hide(el, config.hideMethod);
      XraiIndicator.incrementHidden();
      return;
    }

    // Step 2: Check memory
    var fp = XraiMemory.computeFingerprint(data.text, data.mediaType);
    XraiMemory.hasSeen(fp).then(function (seen) {
      if (seen) {
        XraiHider.hide(el, config ? config.hideMethod : 'remove');
        XraiIndicator.incrementHidden();
        return;
      }

      // Step 3: Pre-filter
      var pfResult = XraiPrefilter.prefilter(data);
      if (pfResult) {
        XraiHider.hide(el, config ? config.hideMethod : 'remove');
        XraiMemory.markSeen(fp, 'noise');
        XraiMemory.logClassification(data.text, data.mediaType, 'noise', pfResult.confidence, 'prefilter:' + pfResult.reason);
        XraiIndicator.incrementHidden();
        return;
      }

      // Step 4: If Ollama unavailable, show by default (pre-filter already caught obvious noise)
      if (!ollamaAvailable) {
        XraiMemory.markSeen(fp, 'signal');
        XraiMemory.logClassification(data.text, data.mediaType, 'signal', 0.5, 'default');
        XraiIndicator.incrementShown();
        XraiReply.attachReplyButton(el, data);
        return;
      }

      // Step 5: Viewport gate -> Classifier
      XraiViewport.observe(el, data, function (viewportData) {
        var threshold = (config && config.confidenceThreshold) || 0.7;

        XraiClassifier.enqueue(viewportData.id, viewportData.text, viewportData.mediaType, function (result) {
          if (result.prediction === 'noise' && result.confidence >= threshold) {
            XraiHider.hide(el, config ? config.hideMethod : 'remove');
            XraiMemory.markSeen(fp, 'noise');
            XraiMemory.logClassification(viewportData.text, viewportData.mediaType, 'noise', result.confidence, 'model');
            XraiIndicator.incrementHidden();
          } else {
            XraiMemory.markSeen(fp, 'signal');
            XraiMemory.logClassification(viewportData.text, viewportData.mediaType, 'signal', result.confidence, 'model');
            XraiIndicator.incrementShown();
            XraiReply.attachReplyButton(el, viewportData);
          }
        });
      });
    });
  }

  // Auto-start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  return { start: start };
})();
