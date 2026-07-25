/* rai — Hop nudge (notices the X ↔ YouTube avoidance loop and interrupts it) */
// Reports page loads + tab-foregrounds to the service worker, which evaluates
// them cross-platform (lib/hops.js). When the worker says "you're hopping",
// this shows a full-screen overlay that names the loop, asks what's actually
// going on, and offers the smallest real next action — pulled live from the
// local collector's /easy endpoint (founder-home board) when it's running,
// a static line when it isn't.
var RaiHopNudge = (function () {
  'use strict';

  var COLLECTOR_URL = 'http://localhost:11435';
  var FALLBACK_EASY = 'Open the board, pick the smallest send, fire it.';

  var _platform = 'x';
  var _enabled = true;

  function init(platform, cfg) {
    _platform = platform === 'youtube' ? 'youtube' : 'x';
    _enabled = !cfg || cfg.hopNudge !== false;

    visit('load');
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') visit('vis');
    });
  }

  function visit(eventType) {
    if (!chrome.runtime || !chrome.runtime.id) return;
    try {
      chrome.runtime.sendMessage(
        { action: 'hopVisit', platform: _platform, event: eventType, enabled: _enabled },
        function (res) {
          if (chrome.runtime.lastError || !res) return;
          if (res.nudge && _enabled) onHop(res);
        }
      );
    } catch (e) { /* extension reloaded mid-page — ignore */ }
  }

  function onHop(res) {
    // Durable record first — the attention ledger should know the loop fired
    // even if the overlay gets dismissed without a thought.
    if (typeof RaiMemory !== 'undefined' && RaiMemory.logEvent) {
      var rec = {
        platform: _platform, kind: 'hop',
        churn: res.churn, spanMs: res.spanMs, url: location.pathname
      };
      RaiMemory.logEvent(rec);
      if (RaiMemory.mirrorEvent) {
        RaiMemory.mirrorEvent(rec);
        RaiMemory.flushMirror();
      }
    }
    fetchEasy(function (easy) { showOverlay(res, easy); });
  }

  function fetchEasy(cb) {
    try {
      fetch(COLLECTOR_URL + '/easy', { signal: AbortSignal.timeout(1500) })
        .then(function (r) { return r.json(); })
        .then(function (d) { cb(d && d.suggestion ? d : null); })
        .catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }

  function removeOverlay() {
    var el = document.getElementById('rai-hop-nudge');
    if (el) el.remove();
  }

  function endOfDayTs() {
    var d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function showOverlay(res, easy) {
    removeOverlay();
    var mins = Math.max(1, Math.ceil((res.spanMs || 0) / 60000));

    var backdrop = document.createElement('div');
    backdrop.className = 'rai-nudge-backdrop';
    backdrop.id = 'rai-hop-nudge';

    var card = document.createElement('div');
    card.className = 'rai-nudge-card';
    card.innerHTML =
      '<div class="rai-nudge-title">🔁 You\'re hopping.</div>' +
      '<div class="rai-nudge-body">' +
      res.churn + ' switches between X and YouTube in ' + mins + ' min.<br>' +
      'What are we actually trying to do right now?<br>' +
      'Avoiding something? About to start something big?' +
      '</div>' +
      '<div class="rai-nudge-easy">' +
      '<div class="rai-nudge-easy-label"></div>' +
      '<div class="rai-nudge-easy-text"></div>' +
      '<div class="rai-nudge-easy-detail"></div>' +
      '</div>' +
      '<div class="rai-nudge-actions">' +
      '<button class="rai-nudge-leave">Back to it</button>' +
      '<button class="rai-nudge-stay">Off for today</button>' +
      '</div>';

    // Suggestion text comes from outside the extension (the board via the
    // collector) — set it via textContent, never innerHTML.
    card.querySelector('.rai-nudge-easy-label').textContent =
      easy && easy.source === 'needle' ? "Today's needle — smallest open piece:" : 'Smallest real move:';
    card.querySelector('.rai-nudge-easy-text').textContent =
      (easy && easy.suggestion) || FALLBACK_EASY;
    var detailEl = card.querySelector('.rai-nudge-easy-detail');
    if (easy && easy.detail) detailEl.textContent = easy.detail;
    else detailEl.remove();

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Cooldown is already set worker-side the moment the nudge fired, so
    // "Back to it" only needs to close the overlay.
    card.querySelector('.rai-nudge-leave').addEventListener('click', removeOverlay);
    card.querySelector('.rai-nudge-stay').addEventListener('click', function () {
      try {
        chrome.runtime.sendMessage({ action: 'hopSnooze', untilTs: endOfDayTs() }, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      removeOverlay();
    });
  }

  return { init: init };
})();
