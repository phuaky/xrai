/* rai — attention ledger: per-card dwell tracking.
 *
 * Records how long each decided card was actually on screen ({kind:'read'}
 * events in the durable log + best-effort collector mirror). This is the
 * measurement layer for the daily digest: what was READ, not just what the
 * feed showed. Lives in core/ (Rai* namespace) — only wired into X for now;
 * YouTube feed dwell is deliberately cut (the feed is blurred by default).
 *
 * Accepted limits, by design:
 * - Re-reads within one page load are lost: the X detector's `processed` set
 *   never re-emits a tweetId, so a card scrolled away and back never
 *   re-registers. Undercount, never double-count.
 * - A 2s sweep detects detached cards and SPA route changes. Dwell itself uses
 *   active wall-clock intervals, pausing exactly while the tab is hidden.
 */
var RaiDwell = (function () {
  'use strict';

  var TICK_MS = 2000;
  var MIN_DWELL_MS = 1000;    // below this = scrolled past, not read
  var VISIBLE_RATIO = 0.5;    // half the card on screen counts as "looking at it"

  var platform = 'x';
  var entries = new Map();    // id -> {..., dwellMs, visible, activeStartedAt}
  var io = null;
  var timer = null;
  var lastHref = null;

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function init(p) {
    if (timer) return;
    platform = p || 'x';
    lastHref = window.location.href;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(ioCallback, { threshold: VISIBLE_RATIO });
    }
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', visibilityChange);
    window.addEventListener('beforeunload', finalizeAll);
  }

  // Called once per card, after its filter decision. meta carries the
  // decision context so the read event joins the decision event on id.
  function observe(el, meta) {
    if (!el || !meta || !meta.id || entries.has(meta.id)) return;
    el._raiDwellId = meta.id;
    entries.set(meta.id, {
      el: el,
      id: meta.id,
      author: meta.author,
      snippet: (meta.snippet || '').substring(0, 140),
      decision: meta.decision,
      source: meta.source,
      dwellMs: 0,
      visible: false,
      activeStartedAt: 0
    });
    if (io) io.observe(el);
  }

  function ioCallback(ioEntries) {
    for (var i = 0; i < ioEntries.length; i++) {
      var e = ioEntries[i];
      var id = e.target._raiDwellId;
      var entry = id && entries.get(id);
      if (!entry) continue;
      if (e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO) {
        if (!entry.visible) {
          entry.visible = true;
          if (!document.hidden) entry.activeStartedAt = Date.now();
        }
      } else if (entry.visible) {
        // True exit after having been seen. (The initial below-the-fold
        // notification arrives with visible=false — keep waiting, don't drop.)
        finalize(id);
      }
    }
  }

  function activeElapsed(entry) {
    if (!entry) return 0;
    var active = entry.visible && !document.hidden && entry.activeStartedAt
      ? Math.max(0, Date.now() - entry.activeStartedAt)
      : 0;
    return entry.dwellMs + active;
  }

  function visibilityChange() {
    var now = Date.now();
    entries.forEach(function (entry) {
      if (!entry.visible) return;
      if (document.hidden) {
        if (entry.activeStartedAt) {
          entry.dwellMs += Math.max(0, now - entry.activeStartedAt);
          entry.activeStartedAt = 0;
        }
      } else if (!entry.activeStartedAt) {
        entry.activeStartedAt = now;
      }
    });
  }

  // Every exit path funnels through finalize; map-delete-first makes it
  // idempotent, so IO-exit / sweep / nav / unload can never double-log.
  function finalize(id) {
    var entry = entries.get(id);
    if (!entry) return;
    var elapsed = activeElapsed(entry);
    entries.delete(id);
    if (io) io.unobserve(entry.el);
    if (elapsed < MIN_DWELL_MS) return;
    var record = {
      platform: platform,
      kind: 'read',
      tweetId: entry.id,
      author: entry.author,
      text: entry.snippet,
      decision: entry.decision,
      source: entry.source,
      dwellMs: elapsed,
      date: todayStr(),
      url: window.location.pathname
    };
    if (typeof RaiMemory !== 'undefined' && RaiMemory.logEvent) RaiMemory.logEvent(record);
    if (typeof RaiMemory !== 'undefined' && RaiMemory.mirrorEvent) RaiMemory.mirrorEvent(record);
    if (typeof RaiKnowledge !== 'undefined' && RaiKnowledge.recordReadDwell) {
      try {
        Promise.resolve(RaiKnowledge.recordReadDwell(entry.id, elapsed, {
          timestamp: Date.now(), decision: entry.decision, source: entry.source
        })).catch(function () {});
      } catch (e) { /* knowledge projection must not affect attention logging */ }
    }
  }

  function getActiveElapsed(id) {
    return activeElapsed(entries.get(id));
  }

  function finalizeAll() {
    var ids = Array.from(entries.keys());
    for (var i = 0; i < ids.length; i++) finalize(ids[i]);
    if (typeof RaiMemory !== 'undefined' && RaiMemory.flushMirror) RaiMemory.flushMirror();
  }

  // X virtualizes timeline nodes with no teardown callback — the sweep is the
  // backstop that releases IO refs on detached cards.
  function sweep() {
    entries.forEach(function (entry, id) {
      if (!entry.el.isConnected) finalize(id);
    });
  }

  // X has NO SPA nav event a content script can hear (page-world pushState is
  // invisible from the isolated world), so route changes are detected by
  // polling href in the tick. In-flight entries belong to the page just left.
  function navCheck() {
    if (lastHref === null) { lastHref = window.location.href; return; }
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    finalizeAll();
  }

  function tick() {
    navCheck();
    sweep();
  }

  return { init: init, observe: observe, getActiveElapsed: getActiveElapsed };
})();
