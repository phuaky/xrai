/* ytrai — Shorts consumption tracker + gentle doom-scroll nudge */
var YtraiShorts = (function () {
  'use strict';

  var TICK_MS = 2000;
  var BINGE_GAP_MS = 3 * 60 * 1000;   // away from Shorts > 3 min => the binge resets

  var cfg = { shortsNudge: true, shortsLimitCount: 10, shortsLimitMinutes: 5 };

  // Persisted per-day consumption (the "track" part).
  var daily = { date: null, count: 0, seconds: 0 };

  // Current binge (in-memory) — drives the nudge.
  var bingeCount = 0;
  var bingeSeconds = 0;
  var lastActiveTs = 0;
  var lastShortId = null;
  var nudgeCountThreshold = 10;
  var nudgeSecThreshold = 300;
  var overlayShown = false;
  var timer = null;
  var saveTimer = null;

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function onShorts() {
    return window.location.pathname.indexOf('/shorts/') === 0;
  }

  function currentShortId() {
    var m = window.location.pathname.match(/\/shorts\/([\w-]+)/);
    return m ? m[1] : null;
  }

  function init(config) {
    if (config) {
      cfg.shortsNudge = config.shortsNudge !== false;
      cfg.shortsLimitCount = config.shortsLimitCount || 10;
      cfg.shortsLimitMinutes = config.shortsLimitMinutes || 5;
    }
    resetThresholds();
    loadDaily().then(updatePill);

    document.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('yt-navigate-finish', onNav);
    timer = setInterval(tick, TICK_MS);
    onNav(); // handle a direct load onto a /shorts/ page
  }

  function resetThresholds() {
    nudgeCountThreshold = cfg.shortsLimitCount;
    nudgeSecThreshold = cfg.shortsLimitMinutes * 60;
  }

  function loadDaily() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('ytrai_shorts', function (r) {
        var d = (r && r.ytrai_shorts) || {};
        var t = todayStr();
        daily = (d.date === t)
          ? { date: t, count: d.count || 0, seconds: d.seconds || 0 }
          : { date: t, count: 0, seconds: 0 };
        resolve();
      });
    });
  }

  function saveDaily() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      chrome.storage.local.set({ ytrai_shorts: { date: daily.date, count: daily.count, seconds: daily.seconds } });
    }, 3000);
  }

  function rolloverIfNeeded() {
    var t = todayStr();
    if (daily.date !== t) daily = { date: t, count: 0, seconds: 0 };
  }

  function resetBinge() {
    bingeCount = 0;
    bingeSeconds = 0;
    overlayShown = false;
    resetThresholds();
  }

  function onNav() {
    if (!onShorts()) {
      removeOverlay();
      overlayShown = false;   // allow a fresh nudge if they dive back in over-limit
      return;
    }
    registerShort();
  }

  // Count a Short the moment the visible /shorts/<id> changes.
  function registerShort() {
    var id = currentShortId();
    if (!id || id === lastShortId) return;

    var now = Date.now();
    if (lastActiveTs && (now - lastActiveTs) > BINGE_GAP_MS) resetBinge();
    lastShortId = id;

    bingeCount++;
    rolloverIfNeeded();
    daily.count++;
    saveDaily();

    if (typeof RaiMemory !== 'undefined' && RaiMemory.logEvent) {
      RaiMemory.logEvent({ platform: 'youtube', kind: 'short', videoId: id, bingeIndex: bingeCount, url: window.location.pathname });
    }
    updatePill();
    maybeNudge();
  }

  // Accumulate active time while actually on Shorts and the tab is visible.
  function tick() {
    if (!onShorts() || document.hidden) return;
    var now = Date.now();
    if (lastActiveTs && (now - lastActiveTs) > BINGE_GAP_MS) resetBinge();
    lastActiveTs = now;
    registerShort();   // poll fallback in case yt-navigate-finish didn't fire on the swipe

    rolloverIfNeeded();
    var secs = TICK_MS / 1000;
    bingeSeconds += secs;
    daily.seconds += secs;
    saveDaily();
    updatePill();
    maybeNudge();
  }

  function maybeNudge() {
    if (!cfg.shortsNudge || overlayShown) return;
    if (bingeCount >= nudgeCountThreshold || bingeSeconds >= nudgeSecThreshold) {
      showOverlay();
    }
  }

  // Pressing "5 more min" pushes both thresholds out by one limit, so it re-fires later.
  function snooze() {
    overlayShown = false;
    nudgeCountThreshold = bingeCount + cfg.shortsLimitCount;
    nudgeSecThreshold = bingeSeconds + cfg.shortsLimitMinutes * 60;
  }

  function removeOverlay() {
    var el = document.getElementById('rai-shorts-nudge');
    if (el) el.remove();
  }

  function showOverlay() {
    overlayShown = true;
    removeOverlay();
    var mins = Math.max(1, Math.round(bingeSeconds / 60));

    var backdrop = document.createElement('div');
    backdrop.className = 'rai-nudge-backdrop';
    backdrop.id = 'rai-shorts-nudge';

    var card = document.createElement('div');
    card.className = 'rai-nudge-card';
    card.innerHTML =
      '<div class="rai-nudge-title">📱 Snap out of it?</div>' +
      '<div class="rai-nudge-body">' + bingeCount + ' Shorts · ' + mins + ' min this binge. Still doom-scrolling?</div>' +
      '<div class="rai-nudge-actions">' +
      '<button class="rai-nudge-leave">Leave Shorts</button>' +
      '<button class="rai-nudge-stay">5 more min</button>' +
      '</div>';
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    card.querySelector('.rai-nudge-leave').addEventListener('click', function () {
      removeOverlay();
      window.location.href = 'https://www.youtube.com/';
    });
    card.querySelector('.rai-nudge-stay').addEventListener('click', function () {
      removeOverlay();
      snooze();
    });
  }

  function updatePill() {
    if (typeof RaiIndicator === 'undefined' || !RaiIndicator.setExtra) return;
    if (!daily.count) { RaiIndicator.setExtra(''); return; }
    RaiIndicator.setExtra('📱 ' + daily.count + ' Shorts · ' + Math.round(daily.seconds / 60) + 'm');
  }

  function getToday() {
    return { count: daily.count, seconds: daily.seconds };
  }

  return { init: init, getToday: getToday };
})();
