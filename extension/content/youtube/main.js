/* ytrai - YouTube Orchestrator (keep worthwhile videos, blur confident distraction) */
var YtraiMain = (function () {
  'use strict';

  var PLATFORM = 'youtube';
  var config = null;
  var ollamaAvailable = false;

  // === Live activity — feeds the pill/panel and marks the card being judged ===
  // Same contract as x/main.js: pendingEls maps videoId -> element, the
  // classifier activity feed says which id is at Ollama, that card gets
  // data-xrai-active (the breathing blur in styles.css).
  var pendingEls = Object.create(null);
  var markedId = null;
  var actText = null;
  var actImage = null;

  function refreshActiveCard() {
    var cur = (actText && actText.current) || (actImage && actImage.current) || null;
    var id = cur && cur.id;
    if (markedId && markedId !== id) {
      var prev = pendingEls[markedId];
      if (prev) prev.removeAttribute('data-xrai-active');
    }
    markedId = id || null;
    if (id && pendingEls[id]) pendingEls[id].setAttribute('data-xrai-active', '1');
  }

  function trackPending(id, el) {
    if (id) pendingEls[id] = el;
  }

  function untrackPending(id) {
    if (!id) return;
    var el = pendingEls[id];
    if (el) el.removeAttribute('data-xrai-active');
    delete pendingEls[id];
    if (markedId === id) markedId = null;
  }

  // Which surfaces to filter. Home + subscriptions = the passive distraction feeds;
  // watch sidebar = where you get pulled away mid-song. Search/channel pages are
  // intentional navigation, so they're left alone.
  function pageMode() {
    var p = window.location.pathname;
    if (p === '/') return 'full';
    if (p.indexOf('/feed/subscriptions') === 0) return 'full';
    if (p.indexOf('/watch') === 0) return 'sidebar';
    return 'none';
  }

  function shouldFilter() {
    return pageMode() !== 'none';
  }

  function start() {
    console.log('[ytrai] Starting...');

    RaiMemory.init(PLATFORM).catch(function (e) {
      console.warn('[ytrai] Memory init error:', e);
    });
    RaiMemory.startSession();

    RaiConfig.getConfig(PLATFORM).then(function (cfg) {
      config = cfg;
      RaiClassifier.configure({ maxModelCallsPerMinute: cfg.maxModelCallsPerMinute, platform: PLATFORM });
      RaiImageClassifier.configure({ platform: PLATFORM });

      RaiClassifier.onActivity(function (snap) {
        actText = snap;
        RaiIndicator.setActivity('text', snap);
        refreshActiveCard();
      });
      RaiImageClassifier.onActivity(function (snap) {
        actImage = snap;
        RaiIndicator.setActivity('image', snap);
        refreshActiveCard();
      });

      checkHealth();

      RaiIndicator.init(PLATFORM, { name: 'ytrai', keptWord: 'kept', hiddenWord: 'blurred', siteWord: 'YouTube' });

      YtraiDetector.onVideo(handleVideo);
      YtraiDetector.start();

      // Shorts consumption tracker + gentle doom-scroll nudge
      if (typeof YtraiShorts !== 'undefined') YtraiShorts.init(cfg);

      // Attention ledger — watch-time per video on /watch (see watch.js)
      if (typeof YtraiWatch !== 'undefined') YtraiWatch.init();

      // Hop nudge — X ↔ YouTube doom-loop detector (see core/hopnudge.js)
      if (typeof RaiHopNudge !== 'undefined') RaiHopNudge.init(PLATFORM, cfg);

      console.log('[ytrai] Running. Keep worthwhile content. Hide: ' + cfg.hideMethod);
    });

    var healthInterval = setInterval(function () {
      if (!chrome.runtime || !chrome.runtime.id) {
        clearInterval(healthInterval);
        return;
      }
      try {
        checkHealth();
      } catch (e) {
        clearInterval(healthInterval);
      }
    }, 30000);
  }

  function checkHealth() {
    chrome.runtime.sendMessage({ action: 'checkHealth', platform: PLATFORM }, function (response) {
      if (chrome.runtime.lastError) {
        ollamaAvailable = false;
        RaiIndicator.update(null, { connected: false, label: 'offline' });
        return;
      }
      ollamaAvailable = response && response.available && response.classify;
      RaiIndicator.update(null, {
        connected: response && response.available,
        classify: response && response.classify
      });
    });
  }

  function handleVideo(info) {
    var el = info.element;
    var data = info.data;

    if (!shouldFilter()) {
      // Defensive: never leave a card blurred on a non-filtered page.
      RaiHider.unblurPending(el);
      return;
    }

    var threshold = (config && config.confidenceThreshold) || 0.6;

    // 1. Cached decision — apply instantly (no blur flash for known music).
    //    Don't re-log cache replays; the first decision was already logged.
    var cached = RaiClassifier.checkCache(data.id);
    if (cached) {
      applyDecision(el, data, cached, threshold, false);
      return;
    }

    // 2. Pre-filter — instant decisions for high-precision obvious cases.
    var pf = YtraiPrefilter.prefilter(data);
    if (pf) {
      var pfRes = { category: pf.category, confidence: pf.confidence, source: 'prefilter:' + pf.reason };
      RaiClassifier.cacheResult(data.id, pfRes);
      applyDecision(el, data, pfRes, threshold, true);
      return;
    }

    // 3. Ollama down — fail open (show everything) so YouTube stays usable.
    if (!ollamaAvailable) {
      keepVideo(el, data, 'other', '');
      logDecision(data, 'kept', { category: 'other', confidence: 0.5, source: 'ollama-off' });
      return;
    }

    // 4. Blur immediately, then classify by title + channel.
    RaiHider.blurPending(el, 0);
    trackPending(data.id, el);
    RaiClassifier.classify(data.id, { text: data.title, channel: data.channel }, function (result) {
      untrackPending(data.id);
      // Generation guard: YouTube recycles card elements during scroll. If this
      // element was reassigned to a different video while we were classifying,
      // drop the stale result so it doesn't stomp the new video's decision.
      if (el._ytraiId !== data.id) return;
      applyDecision(el, data, result, threshold, true);
    });
  }

  function applyDecision(el, data, result, threshold, shouldLog) {
    var verdict = YtraiPolicy.decide(result, {
      threshold: threshold,
      keepMotivational: !config || config.keepMotivational !== false
    });
    var cat = verdict.category;
    var label = '';

    if (cat === 'music') {
      label = '♪ music';
    } else if (cat === 'motivational') {
      label = 'motivation';
    } else if (cat === 'useful') {
      label = 'useful';
    }

    if (verdict.decision === 'kept') {
      finalizeKeep(el, data, cat, label, result, shouldLog);
    } else {
      blurVideo(el, data, cat);
      if (shouldLog) logDecision(data, 'blurred', result, cat);
    }
  }

  // === Image bait gate — runs only on videos already headed for "keep" ===
  // Everything blurred for being distraction never reaches here, so this
  // only spends the extra time on candidates that would
  // otherwise reveal. Card is already blurred (default state), so there's
  // no flash risk either way — just a longer wait before reveal.
  function finalizeKeep(el, data, cat, label, result, shouldLog) {
    function finish(showAsBait, imgResult) {
      if (showAsBait) {
        blurVideo(el, data, 'bait-thumbnail');
        if (shouldLog) logDecision(data, 'blurred', imgResult, 'bait-thumbnail');
      } else {
        keepVideo(el, data, cat, label);
        if (shouldLog) logDecision(data, 'kept', result, cat);
      }
      // Label controls belong to the opt-in image experiment. Keeping them
      // hidden by default avoids adding controls to every useful video.
      if (imageBaitOn) attachGoldenSetButtons(el, data);
    }

    var imageBaitOn = config && config.imageBaitEnabled !== false;
    if (!data.thumbnailUrl || !imageBaitOn) { finish(false, null); return; }

    var imgThreshold = (config && config.imageConfidenceThreshold) || 0.6;
    var cachedImg = RaiImageClassifier.checkCache(data.id);
    if (cachedImg) { finish(cachedImg.baity && cachedImg.confidence >= imgThreshold, cachedImg); return; }

    trackPending(data.id, el);
    RaiImageClassifier.classify(data.id, { imageUrl: data.thumbnailUrl, contextText: data.title }, function (imgResult) {
      untrackPending(data.id);
      // Generation guard: card may have recycled to a different video while
      // the image call was in flight.
      if (el._ytraiId !== data.id) return;
      finish(imgResult.baity && imgResult.confidence >= imgThreshold, imgResult);
    });
  }

  // === Golden-set labeling — the image-bait ground-truth loop ===
  // Only offered while the experimental image gate is enabled.
  function attachGoldenSetButtons(el, data) {
    if (!data.thumbnailUrl) return;
    RaiHider.addImageLabelButtons(el, function (label) {
      RaiMemory.logEvent({
        platform: 'youtube', kind: 'image-label', label: label,
        imageUrl: data.thumbnailUrl, title: data.title, channel: data.channel, videoId: data.id
      });
      console.log('[ytrai] LABEL  | ' + (data.channel || '?') + ' | id:' + data.id + ' | labeled: ' + label);
    });
  }

  function keepVideo(el, data, cat, label) {
    RaiHider.unblurPending(el);
    if (el.getAttribute('data-xrai-hidden')) RaiHider.show(el);
    if (label) RaiHider.addKeepLabel(el, label);
    RaiMemory.incrementStats('kept');
    RaiIndicator.incrementKept();
    console.log('[ytrai] KEEP   | ' + (data.channel || '?') + ' | ' + (label || cat) + ' | ' + (data.title || '').substring(0, 70));
  }

  function blurVideo(el, data, cat) {
    RaiHider.hide(el, (config && config.hideMethod) || 'blur', cat || 'other');
    RaiMemory.incrementStats('hidden');
    RaiIndicator.incrementHidden();
    console.log('[ytrai] BLUR   | ' + (data.channel || '?') + ' | ' + (cat || 'other') + ' | ' + (data.title || '').substring(0, 70));
  }

  // Durable, per-decision record for the prompt-improvement study.
  function logDecision(data, decision, result, cat) {
    var record = {
      platform: 'youtube',
      decision: decision,                       // 'kept' | 'blurred'
      category: cat || result.category || 'other',
      confidence: result.confidence,
      source: result.source,                    // prefilter:<reason> | model | ollama-off | error
      reason: result.reason,
      model: result._model,
      raw: result._raw,                         // raw model output (model path only)
      ms: result._ms,
      title: data.title,
      channel: data.channel,
      videoId: data.id,
      url: location.pathname
    };
    RaiMemory.logEvent(record);      // durable IDB log (source of truth); stamps record.ts
    RaiMemory.mirrorEvent(record);   // best-effort live copy → collector → data/events-youtube.jsonl
  }

  // DOM event bridge — lets page JS pull the durable classification log.
  window.addEventListener('ytrai-export-request', function () {
    RaiMemory.getEvents().then(function (events) {
      var el = document.getElementById('ytrai-export-data');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ytrai-export-data';
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      el.textContent = JSON.stringify(events);
      window.dispatchEvent(new CustomEvent('ytrai-export-response'));
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  return { start: start };
})();
