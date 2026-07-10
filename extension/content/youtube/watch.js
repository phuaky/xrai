/* ytrai — attention ledger: watch-time per video on /watch pages.
 *
 * The feed filter never touches the main watch video; this module measures
 * it. Writes {kind:'watch'} events (durable log + collector mirror) with
 * CUMULATIVE seconds: a partial record every ~30s (crash safety — a watch can
 * be long) and a final non-partial record on nav away. Downstream collapses
 * per (videoId, date) via MAX(seconds); rows are append-only, never mutated.
 *
 * What counts as watching: tab visible AND video playing AND playback time
 * actually advancing AND no ad. Background-tab audio deliberately does NOT
 * count — this is an attention ledger, and background music is the
 * non-distracted case the whole YouTube filter exists to protect.
 * "currentTime advanced" is a boolean gate feeding fixed 2s increments
 * (shorts.js pattern), so seeks and rewinds can't inflate the total.
 */
var YtraiWatch = (function () {
  'use strict';

  var TICK_MS = 2000;
  var PARTIAL_EVERY_S = 30;   // cumulative partial record cadence
  var MIN_WATCH_S = 2;        // one tick — drops autoplay flicks

  var cur = null;             // {videoId, title, channel, seconds, lastTime, lastPartialS}
  var timer = null;

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function onWatch() {
    return window.location.pathname.indexOf('/watch') === 0;
  }

  function currentVideoId() {
    var m = window.location.search.match(/[?&]v=([\w-]+)/);
    return m ? m[1] : null;
  }

  function init() {
    if (timer) return;
    document.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('beforeunload', function () { finalize(); });
    timer = setInterval(tick, TICK_MS);
    onNav(); // handle a direct load onto a /watch page
  }

  function onNav() {
    var id = onWatch() ? currentVideoId() : null;
    if (cur && cur.videoId !== id) finalize();
    if (id && !cur) {
      cur = { videoId: id, title: '', channel: '', seconds: 0, lastTime: null, lastPartialS: 0 };
    }
  }

  // Title/channel render after yt-navigate-finish — fill lazily each tick.
  function fillMeta() {
    if (!cur.title) {
      var t = (document.title || '').replace(/ - YouTube$/, '').trim();
      var h1 = document.querySelector('h1.ytd-watch-metadata');
      cur.title = ((h1 && h1.textContent.trim()) || t).substring(0, 200);
    }
    if (!cur.channel) {
      var ch = document.querySelector('#owner ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a');
      if (ch) cur.channel = ch.textContent.trim().substring(0, 100);
    }
  }

  function adShowing() {
    var player = document.getElementById('movie_player');
    return !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  }

  function tick() {
    if (!cur) { if (onWatch()) onNav(); return; }   // poll fallback if nav event missed
    if (!onWatch()) { finalize(); return; }
    if (currentVideoId() !== cur.videoId) { onNav(); return; }
    if (document.hidden) return;

    var video = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
    if (!video) return;

    var t = video.currentTime;
    var advanced = cur.lastTime !== null && t > cur.lastTime;
    cur.lastTime = t;
    if (video.paused || adShowing() || !advanced) return;

    cur.seconds += TICK_MS / 1000;
    fillMeta();
    if (cur.seconds - cur.lastPartialS >= PARTIAL_EVERY_S) {
      cur.lastPartialS = cur.seconds;
      writeRecord(cur, true);
    }
  }

  function writeRecord(c, partial) {
    var record = {
      platform: 'youtube',
      kind: 'watch',
      videoId: c.videoId,
      title: c.title,
      channel: c.channel,
      seconds: Math.round(c.seconds),   // cumulative — MAX per (videoId, date) downstream
      partial: !!partial,
      date: todayStr(),
      url: '/watch'
    };
    if (typeof RaiMemory !== 'undefined' && RaiMemory.logEvent) RaiMemory.logEvent(record);
    if (typeof RaiMemory !== 'undefined' && RaiMemory.mirrorEvent) RaiMemory.mirrorEvent(record);
  }

  function finalize() {
    if (!cur) return;
    var c = cur;
    cur = null;
    if (c.seconds >= MIN_WATCH_S) writeRecord(c, false);
    if (typeof RaiMemory !== 'undefined' && RaiMemory.flushMirror) RaiMemory.flushMirror();
  }

  return { init: init };
})();
