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
      RaiImageClassifier.configure({ platform: PLATFORM });

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

  // === Workflow-tip capture — the tips-ledger intake ===
  // Tip-shaped tweets that survive filtering (or that Kuan opens directly)
  // get POSTed to the local collector's /tips endpoint, fire-and-forget, and
  // mirrored to the durable event log. The collector dedupes by tweetId;
  // scripts/tips.js owns read/evaluated/implemented status.
  var TIPS_URL = 'http://localhost:11435/tips';
  var tipSent = Object.create(null);

  function maybeCaptureTip(data, text, context) {
    if (!data.id || tipSent[data.id]) return;
    if (typeof XraiTips === 'undefined' || !XraiTips.isTip(text)) return;
    tipSent[data.id] = true;
    console.log('[xrai] TIP    | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + context + ' | ' + (text || '').substring(0, 80));
    RaiMemory.logEvent({
      platform: 'x', kind: 'tip', context: context,
      text: (text || '').substring(0, 1000), author: data.author, tweetId: data.id
    });
    try {
      fetch(TIPS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tweetId: data.id,
          author: data.author,
          url: 'https://x.com/' + (data.author || 'i') + '/status/' + data.id,
          text: (text || '').substring(0, 1000),
          context: context,
          capturedAt: Date.now()
        })
      }).catch(function () { /* collector not running, that's fine */ });
    } catch (e) { /* ignore */ }
  }

  // === One-tap corrections — the ground-truth loop ===
  // Correction events join the durable log on tweetId (see CLAUDE.md Data
  // Pipeline). They are the ONLY live source of false-hide evidence: hidden
  // signal is invisible in daily use unless the user can peek and object.

  function attachWrongOnKept(el, data, text, confidence, source) {
    RaiHider.addWrongButton(el, function () {
      RaiMemory.saveCorrection(text, data.mediaType, 'signal', 'noise');
      RaiMemory.logEvent({
        platform: 'x', kind: 'correction', was: 'shown', correctedTo: 'noise',
        source: source, confidence: confidence,
        text: (text || '').substring(0, 500), author: data.author, tweetId: data.id
      });
      RaiHider.hide(el, 'blur', 'you marked: noise');
    }, 'Noise? Click to hide it and record the correction');
  }

  function attachWrongOnHidden(el, data, text, confidence, source) {
    // Only blur-hidden cards have visible UI to correct from.
    if (el.getAttribute('data-xrai-hidden') !== 'blur') return;
    RaiHider.addWrongButton(el, function () {
      RaiMemory.saveCorrection(text, data.mediaType, 'noise', 'signal');
      RaiMemory.logEvent({
        platform: 'x', kind: 'correction', was: 'hidden', correctedTo: 'signal',
        source: source, confidence: confidence,
        text: (text || '').substring(0, 500), author: data.author, tweetId: data.id
      });
      RaiHider.show(el);
      RaiHider.addKeepLabel(el, 'corrected: signal');
      XraiReply.attachReplyButton(el, data);
      // A corrected-to-signal tweet is user-vouched — capture if tip-shaped.
      maybeCaptureTip(data, text, 'corrected');
    }, 'Worth seeing? Click to reveal it and record the correction');
  }

  // === Golden-set labeling — the image-bait ground-truth loop ===
  // Only offered on tweets that actually carry a checkable photo, so it never
  // spams text-only or video tweets.
  function attachGoldenSetButtons(el, data, text) {
    if (!data.hasImage || !data.imageUrl) return;
    RaiHider.addImageLabelButtons(el, function (label) {
      RaiMemory.logEvent({
        platform: 'x', kind: 'image-label', label: label,
        imageUrl: data.imageUrl, text: (text || '').substring(0, 300),
        author: data.author, tweetId: data.id
      });
      console.log('[xrai] LABEL  | @' + (data.author || '?') + ' | id:' + data.id + ' | labeled: ' + label);
    });
  }

  // === Image bait gate — runs only on tweets already headed for "shown" ===
  // Noise tweets skip this entirely (already hidden, no point spending the
  // extra second-plus on a vision call). Text-only signal tweets skip it too
  // (finish(false) fires immediately, same as before this feature existed).
  // Image tweets blur-then-reveal, matching the YouTube pattern: never let a
  // bait thumbnail flash on screen while the model is still thinking.
  function finalizeSignal(el, data, enrichedText, confidence, source, result) {
    function finish(hideAsBait, imgResult) {
      if (hideAsBait) {
        RaiHider.unblurPending(el);
        var reasonLabel = imgResult && imgResult.reason ? 'AI: bait image (' + imgResult.reason + ')' : 'AI: bait image';
        RaiHider.hide(el, config ? config.hideMethod : 'blur', reasonLabel);
        logTweet('hidden', data, enrichedText, 'bait-image', imgResult ? imgResult.confidence : 0.6, 'image-model', imgResult);
        RaiMemory.incrementStats('hidden');
        RaiIndicator.incrementHidden();
        attachWrongOnHidden(el, data, enrichedText, imgResult ? imgResult.confidence : 0.6, 'image-model');
      } else {
        RaiHider.unblurPending(el);
        var signalLabel = (result && result.reason) ? 'AI: ' + result.reason : 'AI: signal (' + (confidence || 0.5) + ')';
        RaiHider.addKeepLabel(el, signalLabel);
        logTweet('shown', data, enrichedText, 'signal', confidence || 0.5, source, result);
        RaiMemory.incrementStats('kept');
        RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
        RaiIndicator.incrementKept();
        XraiReply.attachReplyButton(el, data);
        attachWrongOnKept(el, data, enrichedText, confidence || 0.5, source);
        maybeCaptureTip(data, enrichedText, 'feed');
      }
      attachNewTabHandler(el, data);
      attachGoldenSetButtons(el, data, enrichedText);
    }

    var imageBaitOn = config && config.imageBaitEnabled !== false;
    if (!data.hasImage || !data.imageUrl || !imageBaitOn) { finish(false, null); return; }

    var imgThreshold = (config && config.imageConfidenceThreshold) || 0.6;
    var cachedImg = RaiImageClassifier.checkCache(data.id);
    if (cachedImg) { finish(cachedImg.baity && cachedImg.confidence >= imgThreshold, cachedImg); return; }

    RaiHider.blurPending(el, 0);
    RaiImageClassifier.classify(data.id, { imageUrl: data.imageUrl, contextText: enrichedText }, function (imgResult) {
      finish(imgResult.baity && imgResult.confidence >= imgThreshold, imgResult);
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
      // Reading a tip on its own status page is the strongest interest signal.
      maybeCaptureTip(data, enrichedText, 'reading');
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
      attachWrongOnHidden(el, data, enrichedText, pfResult.confidence, 'prefilter:' + pfResult.reason);
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
      attachWrongOnHidden(el, data, '', 0.55, 'media-only');
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
      maybeCaptureTip(data, enrichedText, 'feed');
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
        attachWrongOnHidden(el, data, enrichedText, cached.confidence, cached.source || 'cache');
        attachNewTabHandler(el, data);
        return;
      }
      // Cached signal — still needs the image-bait gate if this tweet has a
      // photo (RaiImageClassifier has its own cache, so a re-encountered
      // tweet with an already-checked image reveals instantly, no flash).
      finalizeSignal(el, data, enrichedText, cached.confidence, cached.source || 'cache', cached);
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
        attachWrongOnHidden(el, data, enrichedText, result.confidence, result.source || 'model');
        attachNewTabHandler(el, data);
      } else {
        // Signal — element is already blurred from Step 5. finalizeSignal
        // owns the image-bait gate and, either way, the final unblur/reveal
        // (or bait-hide) plus attachNewTabHandler.
        finalizeSignal(el, data, enrichedText, result.confidence || 0.5, result.source || 'model', result);
      }
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
