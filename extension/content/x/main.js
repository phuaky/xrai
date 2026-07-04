/* xrai — X/Twitter Orchestrator (flat pipeline, every tweet gets a decision) */
var XraiMain = (function () {
  'use strict';

  var PLATFORM = 'x';
  var config = null;
  var ollamaAvailable = false;
  var offHomeLogged = Object.create(null);

  function isHomeFeed() {
    var path = window.location.pathname;
    return path === '/' || path === '/home' || path.indexOf('/home/') === 0;
  }

  function start() {
    console.log('[xrai] Starting...');

    RaiMemory.init(PLATFORM).catch(function (e) {
      console.warn('[xrai] Memory init error:', e);
    });
    RaiMemory.startSession();

    RaiConfig.getConfig(PLATFORM).then(function (cfg) {
      config = cfg;
      RaiClassifier.configure({ maxModelCallsPerMinute: cfg.maxModelCallsPerMinute, platform: PLATFORM });

      chrome.runtime.sendMessage({ action: 'checkHealth', platform: PLATFORM }, function (response) {
        if (chrome.runtime.lastError) {
          console.warn('[xrai] Service worker error:', chrome.runtime.lastError.message);
          ollamaAvailable = false;
          RaiIndicator.update(null, { connected: false, label: 'offline' });
          return;
        }
        ollamaAvailable = response && response.available && response.classify;
        if (response && response.available && response.classify) {
          console.log('[xrai] Ollama connected. Models:', (response.models || []).join(', '));
          RaiIndicator.update(null, { connected: true, classify: true });
        } else if (response && response.available) {
          var detail = response.postStatus ? 'HTTP ' + response.postStatus : response.postError || 'unknown';
          console.warn('[xrai] Ollama running but classify POST failed (' + detail + '). Pre-filter only.');
          RaiIndicator.update(null, { connected: true, classify: false });
        } else {
          console.log('[xrai] Ollama not available. Pre-filter only mode.');
          RaiIndicator.update(null, { connected: false, classify: false });
        }
      });

      RaiIndicator.init(PLATFORM, { name: 'xrai', keptWord: 'shown', hiddenWord: 'hidden', siteWord: 'X' });

      XraiDetector.onTweet(handleTweet);
      XraiDetector.start();

      console.log('[xrai] Running. Filter: ' + cfg.contentFilter + ', Hide: ' + cfg.hideMethod);
    });

    var healthInterval = setInterval(function () {
      if (!chrome.runtime || !chrome.runtime.id) {
        clearInterval(healthInterval);
        return;
      }
      try {
        chrome.runtime.sendMessage({ action: 'checkHealth', platform: PLATFORM }, function (response) {
          if (chrome.runtime.lastError) return;
          var wasAvailable = ollamaAvailable;
          ollamaAvailable = response && response.available && response.classify;
          if (wasAvailable !== ollamaAvailable) {
            RaiIndicator.update(null, {
              connected: response && response.available,
              classify: response && response.classify
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
      if (e.target.closest('[data-testid="like"], [data-testid="retweet"], [data-testid="reply"], [data-testid="Tweet-User-Avatar"], [role="group"], video, [data-testid="videoPlayer"], [data-testid="tweetPhoto"]')) return;
      if (el.hasAttribute('data-xrai-pending')) return;
      if (el.getAttribute('data-xrai-hidden') === 'blur' && !el.hasAttribute('data-xrai-revealed')) return;
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

  // Durable, per-decision record for the prompt-improvement study.
  function logTweet(decision, data, text, prediction, confidence, source, result) {
    RaiMemory.logEvent({
      platform: 'x',
      decision: decision,            // 'shown' | 'hidden'
      prediction: prediction,        // 'signal' | 'noise'
      confidence: confidence,
      source: source,                // reply-filter | prefilter:<reason> | media-only | default | model
      reason: result && result.reason,
      model: result && result._model,
      raw: result && result._raw,    // raw model output (model path only)
      ms: result && result._ms,
      text: (text || data.text || '').substring(0, 500),
      mediaType: data.mediaType,
      author: data.author,
      tweetId: data.id,
      url: location.pathname
    });
  }

  function handleTweet(info) {
    var el = info.element;
    var data = info.data;
    var threshold = (config && config.confidenceThreshold) || 0.7;
    var mediaTag = buildMediaTag(data);
    var enrichedText = buildEnrichedText(data);

    if (data.wasExpanded) {
      console.log('[xrai] EXPAND | @' + (data.author || '?') + ' | id:' + data.id + ' | main tweet text was expanded');
    }
    if (data.wasQuoteExpanded) {
      console.log('[xrai] EXPAND | @' + (data.author || '?') + ' | id:' + data.id + ' | quoted tweet text was expanded');
    }

    // Off-home routes: user is reading intentionally, skip filtering.
    if (!isHomeFeed()) {
      if (data.id && !offHomeLogged[data.id]) {
        offHomeLogged[data.id] = true;
        console.log('[xrai] SKIP   | path=' + window.location.pathname + ' | off-home, no filtering | id:' + data.id);
      }
      XraiReply.attachReplyButton(el, data);
      attachNewTabHandler(el, data);
      return;
    }

    // Step 1: Reply filter
    if (config && config.contentFilter === 'posts-only' && data.isReply) {
      console.log('[xrai] REPLY  | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | reply filtered | ' + (enrichedText || '').substring(0, 80));
      RaiHider.hide(el, config.hideMethod, 'reply filtered');
      RaiMemory.incrementStats('hidden');
      logTweet('hidden', data, enrichedText, 'noise', 0.9, 'reply-filter');
      RaiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 2: Pre-filter (regex)
    var pfResult = XraiPrefilter.prefilter(data);
    if (pfResult) {
      console.log('[xrai] PREFLT | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | ' + pfResult.reason + ' | ' + (enrichedText || '').substring(0, 80));
      RaiHider.hide(el, config ? config.hideMethod : 'remove', 'prefilter: ' + pfResult.reason);
      RaiClassifier.cacheResult(data.id, { prediction: 'noise', confidence: pfResult.confidence, source: 'prefilter:' + pfResult.reason });
      logTweet('hidden', data, enrichedText, 'noise', pfResult.confidence, 'prefilter:' + pfResult.reason);
      RaiMemory.incrementStats('hidden');
      RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'noise');
      RaiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 2.5: Media-only tweets
    if (data.isMediaOnly) {
      console.log('[xrai] MEDIA  | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | media-only, no text to classify');
      RaiClassifier.cacheResult(data.id, { prediction: 'noise', confidence: 0.55, source: 'media-only' });
      logTweet('hidden', data, '', 'noise', 0.55, 'media-only');
      RaiMemory.incrementStats('hidden');
      RaiMemory.markSeen(RaiMemory.computeFingerprint('', data.mediaType), 'noise');
      RaiHider.hide(el, 'blur', 'media-only: no text to classify');
      RaiIndicator.incrementHidden();
      attachNewTabHandler(el, data);
      return;
    }

    // Step 3: If Ollama unavailable, show by default
    if (!ollamaAvailable) {
      console.log('[xrai] OFF    | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | showing by default | ' + (enrichedText || '').substring(0, 80));
      logTweet('shown', data, enrichedText, 'signal', 0.5, 'default');
      RaiMemory.incrementStats('kept');
      RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
      RaiIndicator.incrementKept();
      XraiReply.attachReplyButton(el, data);
      attachNewTabHandler(el, data);
      return;
    }

    // Step 4: Check cache synchronously to avoid blur flash on cached signal tweets
    var cached = RaiClassifier.checkCache(data.id);
    if (cached) {
      if (cached.prediction === 'noise' && cached.confidence >= threshold) {
        var cachedReason = cached.reason
          ? 'AI: ' + cached.reason
          : cached.source && cached.source.indexOf('prefilter:') === 0
            ? 'prefilter: ' + cached.source.substring(10)
            : 'AI: noise (' + cached.confidence + ')';
        RaiHider.hide(el, config ? config.hideMethod : 'remove', cachedReason);
        RaiIndicator.incrementHidden();
      } else {
        var cachedSignalReason = cached.reason
          ? 'AI: ' + cached.reason
          : 'AI: signal (' + (cached.confidence || 0.5) + ')';
        RaiHider.addKeepLabel(el, cachedSignalReason);
        RaiIndicator.incrementKept();
        XraiReply.attachReplyButton(el, data);
      }
      attachNewTabHandler(el, data);
      return;
    }

    // Step 5: Blur immediately while waiting for classification
    RaiHider.blurPending(el);

    // Step 6: Classify (Ollama queue) — use enriched text for better context
    RaiClassifier.classify(data.id, { text: enrichedText, mediaType: data.mediaType, author: data.author }, function (result) {
      if (result.prediction === 'noise' && result.confidence >= threshold) {
        var reasonLabel = result.reason
          ? 'AI: ' + result.reason
          : 'AI: noise (' + result.confidence + ')';
        RaiHider.unblurPending(el);
        RaiHider.hide(el, config ? config.hideMethod : 'remove', reasonLabel);
        logTweet('hidden', data, enrichedText, 'noise', result.confidence, result.source || 'model', result);
        RaiMemory.incrementStats('hidden');
        RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'noise');
        RaiIndicator.incrementHidden();
      } else {
        RaiHider.unblurPending(el);
        var signalLabel = result.reason
          ? 'AI: ' + result.reason
          : 'AI: signal (' + (result.confidence || 0.5) + ')';
        RaiHider.addKeepLabel(el, signalLabel);
        logTweet('shown', data, enrichedText, 'signal', result.confidence || 0.5, result.source || 'model', result);
        RaiMemory.incrementStats('kept');
        RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
        RaiIndicator.incrementKept();
        XraiReply.attachReplyButton(el, data);
      }
      attachNewTabHandler(el, data);
    });
  }

  // DOM event bridge — allows page JS to pull the durable classification log
  window.addEventListener('xrai-export-request', function () {
    RaiMemory.getEvents().then(function (events) {
      var el = document.getElementById('xrai-export-data');
      if (!el) {
        el = document.createElement('div');
        el.id = 'xrai-export-data';
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      el.textContent = JSON.stringify(events);
      window.dispatchEvent(new CustomEvent('xrai-export-response'));
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  return { start: start };
})();
