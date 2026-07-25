/* xrai — X/Twitter Orchestrator (flat pipeline, every tweet gets a decision) */
var XraiMain = (function () {
  'use strict';

  var PLATFORM = 'x';
  var config = null;
  var ollamaAvailable = false;
  var offHomeLogged = Object.create(null);

  // === Live activity — feeds the pill/panel and marks the card being judged ===
  // pendingEls maps tweetId -> element for cards awaiting a verdict; the
  // classifier activity feed says which id is at Ollama RIGHT NOW, and that
  // card gets data-xrai-active (the breathing blur in styles.css).
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

      // Attention ledger — per-card dwell tracking (see core/dwell.js)
      if (typeof RaiDwell !== 'undefined') RaiDwell.init(PLATFORM);

      // Hop nudge — X ↔ YouTube doom-loop detector (see core/hopnudge.js)
      if (typeof RaiHopNudge !== 'undefined') RaiHopNudge.init(PLATFORM, cfg);

      // Reply guard vs SPA navigation: X rebuilds article nodes on soft nav
      // and there is no nav event, so poll the path (same approach as dwell).
      // Revisiting an own thread re-emits its cards (detector.rescan) so
      // cached verdicts re-apply; leaving one clears the pill's reply count.
      var lastGuardPath = window.location.pathname;
      setInterval(function () {
        if (window.location.pathname === lastGuardPath) return;
        lastGuardPath = window.location.pathname;
        var page = (config && config.replyGuard !== false && typeof XraiReplyRoute !== 'undefined')
          ? XraiReplyRoute.guardPage(lastGuardPath, config.ownHandle)
          : null;
        if (page) {
          XraiDetector.rescan();
        } else {
          RaiIndicator.setExtra('');
        }
      }, 1500);

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
  // Also the single attach point for dwell tracking: every logged decision
  // starts a visibility observation, so read events carry decision context
  // and join the decision event on tweetId.
  function logTweet(el, decision, data, text, prediction, confidence, source, result) {
    if (typeof RaiDwell !== 'undefined' && el) {
      RaiDwell.observe(el, {
        id: data.id, author: data.author,
        snippet: text || data.text || '',
        decision: decision, source: source
      });
    }
    var record = {
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
    };
    RaiMemory.logEvent(record);      // durable IDB log (source of truth); stamps record.ts
    RaiMemory.mirrorEvent(record);   // best-effort live copy → collector → data/events-x.jsonl
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
        logTweet(el, 'hidden', data, enrichedText, 'bait-image', imgResult ? imgResult.confidence : 0.6, 'image-model', imgResult);
        RaiMemory.incrementStats('hidden');
        RaiIndicator.incrementHidden();
      } else {
        RaiHider.unblurPending(el);
        var signalLabel = (result && result.reason) ? 'AI: ' + result.reason : 'AI: signal (' + (confidence || 0.5) + ')';
        RaiHider.addKeepLabel(el, signalLabel);
        logTweet(el, 'shown', data, enrichedText, 'signal', confidence || 0.5, source, result);
        RaiMemory.incrementStats('kept');
        RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
        RaiIndicator.incrementKept();
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
    trackPending(data.id, el);
    RaiImageClassifier.classify(data.id, { imageUrl: data.imageUrl, contextText: enrichedText }, function (imgResult) {
      untrackPending(data.id);
      finish(imgResult.baity && imgResult.confidence >= imgThreshold, imgResult);
    });
  }

  // === Reply guard — bad-faith replies on the user's OWN status pages ===
  // Inverse trust posture from the feed: everything is shown by default and
  // stays shown while classifying (a genuine reply must never flash-blurred);
  // only a hostile/bot/spam verdict blurs — always blur-with-peek, never
  // remove, whatever hideMethod says. A wrongly hidden reply on your own post
  // could be a lead, so recoverability is non-negotiable. Criticism and
  // skepticism are "fine" by design — the guard targets bad faith, not
  // sentiment (see X_REPLY_SYSTEM + prefilterReply).

  var replyCounts = { statusId: null, screened: 0, blurred: 0 };
  var replyGuardAnnounced = Object.create(null);

  function bumpReplyCounts(page, bad) {
    if (replyCounts.statusId !== page.statusId) {
      replyCounts = { statusId: page.statusId, screened: 0, blurred: 0 };
    }
    replyCounts.screened++;
    if (bad) replyCounts.blurred++;
    RaiIndicator.setExtra('🛡 ' + replyCounts.blurred + '/' + replyCounts.screened + ' replies');
  }

  // Prefilter verdicts blur unconditionally (high-precision by contract);
  // model verdicts respect replyConfidenceThreshold. Mirrored by
  // decideReply() in benchmarks/load-extension.js — keep them in sync.
  function replyVerdictOf(result, threshold) {
    if (!result || !result.verdict || result.verdict === 'fine') return 'fine';
    if (result.source && result.source.indexOf('prefilter') === 0) return result.verdict;
    return result.confidence >= threshold ? result.verdict : 'fine';
  }

  function logReply(decision, data, text, verdict, confidence, source, result) {
    var record = {
      platform: 'x',
      surface: 'own-replies',
      decision: decision,            // 'shown' | 'blurred'
      verdict: verdict,              // 'hostile' | 'bot' | 'spam' | 'fine'
      confidence: confidence,
      source: source,                // prefilter:<reason> | model | default
      model: result && result._model,
      raw: result && result._raw,
      ms: result && result._ms,
      text: (text || '').substring(0, 500),
      author: data.author,
      tweetId: data.id,
      url: location.pathname
    };
    RaiMemory.logEvent(record);
    RaiMemory.mirrorEvent(record);
  }

  function applyReplyDecision(el, data, page, text, result, replay) {
    var threshold = (config && config.replyConfidenceThreshold) || 0.7;
    var verdict = replyVerdictOf(result, threshold);
    var bad = verdict !== 'fine';
    bumpReplyCounts(page, bad);

    if (bad) {
      console.log('[xrai] RGUARD | @' + (data.author || '?') + ' | id:' + data.id + ' | blurred (' + verdict + ', ' + result.source + ') | ' + (text || '').substring(0, 80));
      RaiHider.hide(el, 'blur', verdict + ' reply', function onPeek() {
        var peek = {
          platform: 'x', kind: 'peek', surface: 'own-replies',
          verdict: verdict, tweetId: data.id, author: data.author,
          url: location.pathname
        };
        RaiMemory.logEvent(peek);
        RaiMemory.mirrorEvent(peek);
        // Blurred replies only start accruing dwell once actually readable.
        if (typeof RaiDwell !== 'undefined') {
          RaiDwell.observe(el, {
            id: data.id, author: data.author, snippet: text,
            decision: 'peeked', source: 'reply-guard'
          });
        }
      });
    } else {
      attachNewTabHandler(el, data);
      if (typeof RaiDwell !== 'undefined') {
        RaiDwell.observe(el, {
          id: data.id, author: data.author, snippet: text,
          decision: 'shown', source: replay ? 'reply-cache' : result.source
        });
      }
      maybeCaptureTip(data, text, 'reading');
    }

    // Cache replays re-apply the decision but are never re-logged.
    if (!replay) logReply(bad ? 'blurred' : 'shown', data, text, verdict, result.confidence, result.source, result);
  }

  function handleOwnReply(el, data, enrichedText, page) {
    if (!replyGuardAnnounced[page.statusId]) {
      replyGuardAnnounced[page.statusId] = true;
      console.log('[xrai] RGUARD | active on /' + page.handle + '/status/' + page.statusId);
    }

    // Immunity: the main tweet and the user's own replies are never touched —
    // they get the plain off-home reading treatment (dwell + tips).
    if (!XraiReplyRoute.shouldGuard(data, page, config.ownHandle)) {
      attachNewTabHandler(el, data);
      if (typeof RaiDwell !== 'undefined') {
        RaiDwell.observe(el, {
          id: data.id, author: data.author, snippet: enrichedText,
          decision: 'reading', source: 'own-status'
        });
      }
      maybeCaptureTip(data, enrichedText, 'reading');
      return;
    }

    // Reply cache ids are prefixed: the shared RaiClassifier cache also holds
    // feed results keyed by tweetId, and a feed {prediction} must never be
    // mistaken for a reply {verdict}.
    var cacheId = 'reply:' + data.id;

    var cached = RaiClassifier.checkCache(cacheId);
    if (cached) {
      applyReplyDecision(el, data, page, enrichedText, cached, true);
      return;
    }

    var pf = XraiPrefilter.prefilterReply(data);
    if (pf) {
      var pfResult = { verdict: pf.verdict, confidence: pf.confidence, source: 'prefilter:' + pf.reason };
      RaiClassifier.cacheResult(cacheId, pfResult);
      applyReplyDecision(el, data, page, enrichedText, pfResult, false);
      return;
    }

    if (!ollamaAvailable) {
      // Fail open: no model, no blur — never guess a reply into the blur.
      var offResult = { verdict: 'fine', confidence: 0.5, source: 'default' };
      RaiClassifier.cacheResult(cacheId, offResult);
      applyReplyDecision(el, data, page, enrichedText, offResult, false);
      return;
    }

    RaiClassifier.classify(cacheId, { action: 'classifyReply', text: enrichedText, author: data.author }, function (result) {
      if (!result.verdict) result = Object.assign({}, result, { verdict: 'fine', confidence: 0.5 });
      applyReplyDecision(el, data, page, enrichedText, result, false);
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

    // Own status page: reply guard — blur bad-faith replies, keep everything
    // else (including criticism) visible. All other off-home routes skip.
    if (!isHomeFeed()) {
      var guardPage = (config && config.replyGuard !== false && typeof XraiReplyRoute !== 'undefined')
        ? XraiReplyRoute.guardPage(window.location.pathname, config.ownHandle)
        : null;
      if (guardPage) {
        handleOwnReply(el, data, enrichedText, guardPage);
        return;
      }
      if (data.id && !offHomeLogged[data.id]) {
        offHomeLogged[data.id] = true;
        console.log('[xrai] SKIP   | path=' + window.location.pathname + ' | off-home, no filtering | id:' + data.id);
      }
      attachNewTabHandler(el, data);
      // Off-home skips logTweet, so attach dwell explicitly — status-page
      // reading is the strongest attention signal and must not be dropped.
      if (typeof RaiDwell !== 'undefined') {
        RaiDwell.observe(el, {
          id: data.id, author: data.author, snippet: enrichedText,
          decision: 'reading', source: 'off-home'
        });
      }
      // Reading a tip on its own status page is the strongest interest signal.
      maybeCaptureTip(data, enrichedText, 'reading');
      return;
    }

    // Step 1: Reply filter
    if (config && config.contentFilter === 'posts-only' && data.isReply) {
      console.log('[xrai] REPLY  | @' + (data.author || '?') + ' | id:' + data.id + ' | ' + mediaTag + ' | reply filtered | ' + (enrichedText || '').substring(0, 80));
      RaiHider.hide(el, config.hideMethod, 'reply filtered');
      RaiMemory.incrementStats('hidden');
      logTweet(el, 'hidden', data, enrichedText, 'noise', 0.9, 'reply-filter');
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
      logTweet(el, 'hidden', data, enrichedText, 'noise', pfResult.confidence, 'prefilter:' + pfResult.reason);
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
      logTweet(el, 'hidden', data, '', 'noise', 0.55, 'media-only');
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
      logTweet(el, 'shown', data, enrichedText, 'signal', 0.5, 'default');
      RaiMemory.incrementStats('kept');
      RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'signal');
      RaiIndicator.incrementKept();
      attachNewTabHandler(el, data);
      maybeCaptureTip(data, enrichedText, 'feed');
      return;
    }

    // Step 4: Check cache synchronously to avoid blur flash on cached signal tweets
    var cached = RaiClassifier.checkCache(data.id);
    if (cached) {
      // Cache replays are not re-logged, and deliberately not dwell-observed
      // either (a re-seen blurred tweet is low-value attention data).
      if (cached.prediction === 'noise' && cached.confidence >= threshold) {
        var cachedReason = cached.reason
          ? 'AI: ' + cached.reason
          : cached.source && cached.source.indexOf('prefilter:') === 0
            ? 'prefilter: ' + cached.source.substring(10)
            : 'AI: noise (' + cached.confidence + ')';
        RaiHider.hide(el, config ? config.hideMethod : 'remove', cachedReason);
        RaiIndicator.incrementHidden();
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
    trackPending(data.id, el);

    // Step 6: Classify (Ollama queue) — use enriched text for better context
    RaiClassifier.classify(data.id, { text: enrichedText, mediaType: data.mediaType, author: data.author }, function (result) {
      untrackPending(data.id);
      if (result.prediction === 'noise' && result.confidence >= threshold) {
        var reasonLabel = result.reason
          ? 'AI: ' + result.reason
          : 'AI: noise (' + result.confidence + ')';
        RaiHider.unblurPending(el);
        RaiHider.hide(el, config ? config.hideMethod : 'remove', reasonLabel);
        logTweet(el, 'hidden', data, enrichedText, 'noise', result.confidence, result.source || 'model', result);
        RaiMemory.incrementStats('hidden');
        RaiMemory.markSeen(RaiMemory.computeFingerprint(data.text, data.mediaType), 'noise');
        RaiIndicator.incrementHidden();
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
