/* xrai — Main Orchestrator (flat pipeline, every tweet gets a decision) */
var XraiMain = (function () {
  'use strict';

  var config = null;
  var ollamaAvailable = false;
  var offHomeLogged = Object.create(null);

  function isHomeFeed() {
    var path = window.location.pathname;
    return path === '/' || path === '/home' || path.indexOf('/home/') === 0;
  }

  function start() {
    console.log('[xrai] Starting...');

    // 1. Init memory (for classification logging) + start time tracking
    XraiMemory.init().catch(function (e) {
      console.warn('[xrai] Memory init error:', e);
    });
    XraiMemory.startSession();

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
          var detail = response.postStatus ? 'HTTP ' + response.postStatus : response.postError || 'unknown';
          console.warn('[xrai] Ollama running but classify POST failed (' + detail + '). Pre-filter only.');
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

  function attachNewTabHandler(el, data) {
    if (!data.author || !data.id) return;
    var tweetText = el.querySelector('[data-testid="tweetText"]');
    if (!tweetText || tweetText._xraiNewTab) return;
    tweetText._xraiNewTab = true;
    tweetText.addEventListener('click', function (e) {
      // Don't intercept if clicking inside interactive elements
      if (e.target.closest('[data-testid="like"], [data-testid="retweet"], [data-testid="reply"], [data-testid="Tweet-User-Avatar"], [role="group"], video, [data-testid="videoPlayer"], [data-testid="tweetPhoto"]')) return;
      // Don't open if tweet is pending classification or blurred and not revealed
      if (el.hasAttribute('data-xrai-pending')) return;
      if (el.getAttribute('data-xrai-hidden') === 'blur' && !el.hasAttribute('data-xrai-revealed')) return;
      // Don't open new tab if already viewing this tweet
      if (window.location.pathname.indexOf('/status/' + data.id) !== -1) return;
      e.preventDefault();
      e.stopPropagation();
      window.open('https://x.com/' + data.author + '/status/' + data.id, '_blank');
    });
  }

  function buildMediaTag(data) {
    var parts = [data.mediaType || 'text'];
    if (data.hasQuote) parts.push('quote');
    if (data.hasCard) parts.push('card');
    if (data.isMediaOnly) parts.push('media-only');
    return parts.join('+');
  }

  function buildEnrichedText(data) {
    var parts = [];
    if (data.text) parts.push(data.text);
    if (data.quotedText) parts.push('[quoted] ' + data.quotedText);
    if (data.cardText) parts.push('[card] ' + data.cardText);
    return parts.join(' ');
  }

  function handleTweet(info) {
    var el = info.element;
    var data = info.data;
    var threshold = (config && config.confidenceThreshold) || 0.7;
    var mediaTag = buildMediaTag(data);
    var enrichedText = buildEnrichedText(data);

    // Log when tweet text was expanded from truncated state
    if (data.wasExpanded) {
      console.log('[xrai] EXPAND | @' + (data.author || '?') + ' | id:' + data.id + ' | main tweet text was expanded');
    }
    if (data.wasQuoteExpanded) {
      console.log('[xrai] EXPAND | @' + (data.author || '?') + ' | id:' + data.id + ' | quoted tweet text was expanded');
    }

    // Off-home routes (status detail, profile, explore, etc.): user is reading intentionally,
    // so skip the entire filtering pipeline. Keep reply button + new-tab handlers available.
    if (!isHomeFeed()) {
      if (data.id && !offHomeLogged[data.id]) {
        offHomeLogged[data.id] = true;
        console.log('[xrai] SKIP   | path=' + window.location.pathname + ' | off-home, no filtering | id:' + data.id);
      }
      XraiReply.attachReplyButton(el, data);
      attachNewTabHandler(el, data);
      return;
    }

    // Step 1: Reply filter — blur stays (was applied or apply now)
    if (config && config.contentFilter === 'posts-only' && data.isReply) {
      console.log('[xrai] REPLY  | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | reply filtered | ' + (enrichedText || '').substring(0, 80));
      XraiHider.hide(el, config.hideMethod, 'reply filtered');
      XraiMemory.incrementStats('noise');
      XraiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 2: Pre-filter (regex) — blur stays, apply confirmed hide
    var pfResult = XraiPrefilter.prefilter(data);
    if (pfResult) {
      console.log('[xrai] PREFLT | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | ' + pfResult.reason + ' | ' + (enrichedText || '').substring(0, 80));
      XraiHider.hide(el, config ? config.hideMethod : 'remove', 'prefilter: ' + pfResult.reason);
      XraiClassifier.cachePrefilter(data.id, 'noise', pfResult.confidence, pfResult.reason);
      XraiMemory.logClassification(data.text, data.mediaType, 'noise', pfResult.confidence, 'prefilter:' + pfResult.reason);
      XraiMemory.incrementStats('noise');
      XraiMemory.markSeen(XraiMemory.computeFingerprint(data.text, data.mediaType), 'noise');
      XraiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 2.5: Media-only tweets — has media but no text context at all
    if (data.isMediaOnly) {
      var mediaOnlyResult = { prediction: 'noise', confidence: 0.55, source: 'media-only' };
      console.log('[xrai] MEDIA  | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | media-only, no text to classify');
      XraiClassifier.cachePrefilter(data.id, 'noise', 0.55, 'media-only');
      XraiMemory.logClassification('', data.mediaType, 'noise', 0.55, 'media-only');
      XraiMemory.incrementStats('noise');
      XraiMemory.markSeen(XraiMemory.computeFingerprint('', data.mediaType), 'noise');
      // Low confidence — don't aggressively hide, use blur so user can reveal
      XraiHider.hide(el, 'blur', 'media-only: no text to classify');
      XraiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 3: If Ollama unavailable, show by default (no blur)
    if (!ollamaAvailable) {
      console.log('[xrai] OFF    | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | showing by default | ' + (enrichedText || '').substring(0, 80));
      XraiMemory.logClassification(data.text, data.mediaType, 'signal', 0.5, 'default');
      XraiMemory.incrementStats('signal');
      XraiMemory.markSeen(XraiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
      XraiIndicator.incrementShown();
      XraiReply.attachReplyButton(el, data);
      attachNewTabHandler(el, data);
      return;
    }

    // Step 4: Check cache synchronously to avoid blur flash on cached signal tweets
    var cached = XraiClassifier.checkCache(data.id);
    if (cached) {
      if (cached.prediction === 'noise' && cached.confidence >= threshold) {
        var cachedReason = cached.reason
          ? 'AI: ' + cached.reason
          : cached.source && cached.source.indexOf('prefilter:') === 0
            ? 'prefilter: ' + cached.source.substring(10)
            : 'AI: noise (' + cached.confidence + ')';
        XraiHider.hide(el, config ? config.hideMethod : 'remove', cachedReason);
        XraiIndicator.incrementHidden();
      } else {
        var cachedSignalReason = cached.reason
          ? 'AI: ' + cached.reason
          : 'AI: signal (' + cached.confidence + ')';
        XraiHider.addSignalLabel(el, cachedSignalReason);
        XraiIndicator.incrementShown();
        XraiReply.attachReplyButton(el, data);
      }
      attachNewTabHandler(el, data);
      return;
    }

    // Step 5: Blur immediately while waiting for classification
    XraiHider.blurPending(el);

    // Step 6: Classify (Ollama queue) — use enriched text for better context
    XraiClassifier.classify(data.id, enrichedText, data.mediaType, data.author, function (result) {
      if (result.prediction === 'noise' && result.confidence >= threshold) {
        var reasonLabel = result.reason
          ? 'AI: ' + result.reason
          : 'AI: noise (' + result.confidence + ')';
        XraiHider.unblurPending(el);
        XraiHider.hide(el, config ? config.hideMethod : 'remove', reasonLabel);
        XraiMemory.logClassification(data.text, data.mediaType, 'noise', result.confidence, result.source || 'model');
        XraiMemory.incrementStats('noise');
        XraiMemory.markSeen(XraiMemory.computeFingerprint(data.text, data.mediaType), 'noise');
        XraiIndicator.incrementHidden();
      } else {
        XraiHider.unblurPending(el);
        var signalLabel = result.reason
          ? 'AI: ' + result.reason
          : 'AI: signal (' + result.confidence + ')';
        XraiHider.addSignalLabel(el, signalLabel);
        XraiMemory.logClassification(data.text, data.mediaType, 'signal', result.confidence, result.source || 'model');
        XraiMemory.incrementStats('signal');
        XraiMemory.markSeen(XraiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
        XraiIndicator.incrementShown();
        XraiReply.attachReplyButton(el, data);
      }
      attachNewTabHandler(el, data);
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
