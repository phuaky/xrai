/* ytrai — YouTube Orchestrator (blur everything, reveal only music + motivational) */
var YtraiMain = (function () {
  'use strict';

  var PLATFORM = 'youtube';
  var config = null;
  var ollamaAvailable = false;

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

      checkHealth();

      RaiIndicator.init(PLATFORM, { name: 'ytrai', keptWord: 'kept', hiddenWord: 'blurred', siteWord: 'YouTube' });

      YtraiDetector.onVideo(handleVideo);
      YtraiDetector.start();

      // Shorts consumption tracker + gentle doom-scroll nudge
      if (typeof YtraiShorts !== 'undefined') YtraiShorts.init(cfg);

      console.log('[ytrai] Running. Keep music' + (cfg.keepMotivational ? ' + motivational' : '') + '. Hide: ' + cfg.hideMethod);
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

    // 2. Pre-filter — instant keep for obvious music / motivational.
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
    RaiClassifier.classify(data.id, { text: data.title, channel: data.channel }, function (result) {
      // Generation guard: YouTube recycles card elements during scroll. If this
      // element was reassigned to a different video while we were classifying,
      // drop the stale result so it doesn't stomp the new video's decision.
      if (el._ytraiId !== data.id) return;
      applyDecision(el, data, result, threshold, true);
    });
  }

  function applyDecision(el, data, result, threshold, shouldLog) {
    // Worker unreachable — fail open.
    if (result.source === 'error') {
      keepVideo(el, data, 'other', '');
      if (shouldLog) logDecision(data, 'kept', result, 'other');
      return;
    }

    var cat = result.category || 'other';
    var isPrefilter = result.source && result.source.indexOf('prefilter') === 0;
    var keep = false;
    var label = '';

    if (cat === 'music') {
      keep = true;
      label = '♪ music';
    } else if (cat === 'motivational' && config && config.keepMotivational) {
      keep = true;
      label = '💪 motivation';
    }

    // Strictness: a low-confidence model keep gets blurred anyway. Prefilter keeps bypass.
    if (keep && !isPrefilter && result.confidence !== undefined && result.confidence < threshold) {
      keep = false;
    }

    if (keep) {
      keepVideo(el, data, cat, label);
      if (shouldLog) logDecision(data, 'kept', result, cat);
    } else {
      blurVideo(el, data, cat);
      if (shouldLog) logDecision(data, 'blurred', result, cat);
    }
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
    RaiMemory.logEvent({
      platform: 'youtube',
      decision: decision,                       // 'kept' | 'blurred'
      category: cat || result.category || 'other',
      confidence: result.confidence,
      source: result.source,                    // prefilter:<reason> | model | ollama-off | error
      model: result._model,
      raw: result._raw,                         // raw model output (model path only)
      ms: result._ms,
      title: data.title,
      channel: data.channel,
      videoId: data.id,
      url: location.pathname
    });
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
