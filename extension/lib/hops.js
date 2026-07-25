/* rai — Hop detection (the X ↔ YouTube avoidance loop, pure logic, no chrome deps) */
// Notices the doom-hop: open YouTube, bounce to X, close, reopen, repeat — the
// signature of avoiding something. Content scripts on both platforms report
// visits; the service worker evaluates them here against one shared state.
var RaiHops = (function () {
  'use strict';

  // A "churn" transition is the tell of the loop:
  //  - switching platform (any visit type) within CHAIN_GAP_MS, or
  //  - a fresh page LOAD of the same platform within RELOAD_GAP_MS
  //    (close-and-reopen, compulsive refresh).
  // Same-platform visibility flips never churn — alt-tabbing between X and an
  // editor is work, not hopping. Only a real reload/reopen or a cross-platform
  // bounce counts.
  var CHAIN_GAP_MS = 4 * 60 * 1000;
  var RELOAD_GAP_MS = 3 * 60 * 1000;
  var HORIZON_MS = 10 * 60 * 1000;  // visits older than this fall out of the window
  var TRIGGER = 3;                  // churn transitions within the horizon → nudge
  var SNOOZE_MS = 20 * 60 * 1000;   // auto-cooldown once a nudge fires
  var MAX_EVENTS = 40;

  function emptyState() {
    return { events: [], snoozeUntil: 0 };
  }

  function churnCount(events) {
    var n = 0;
    for (var i = 1; i < events.length; i++) {
      var prev = events[i - 1];
      var cur = events[i];
      var gap = cur.ts - prev.ts;
      if (gap < 0) continue;
      if (cur.p !== prev.p) {
        if (gap <= CHAIN_GAP_MS) n++;
      } else if (cur.e === 'load' && gap <= RELOAD_GAP_MS) {
        n++;
      }
    }
    return n;
  }

  // ev: {p:'x'|'youtube', e:'load'|'vis'}. armed=false records the visit but
  // never fires (the reporting platform has the nudge toggled off — the other
  // platform's counts must stay whole either way).
  // Returns { state, nudge, churn, spanMs }; state is a new object, safe to
  // persist as-is (plain JSON).
  function evaluate(state, ev, now, armed) {
    if (!state || !Array.isArray(state.events)) state = emptyState();

    var events = state.events.filter(function (x) {
      return x && typeof x.ts === 'number' && now - x.ts <= HORIZON_MS;
    }).slice(-(MAX_EVENTS - 1));
    events.push({ p: ev.p, e: ev.e, ts: now });

    var churn = churnCount(events);
    var spanMs = events.length > 1 ? now - events[0].ts : 0;
    var snoozed = now < (state.snoozeUntil || 0);

    if (churn >= TRIGGER && !snoozed && armed) {
      // Fire once, then cool down; clearing the window means the next episode
      // has to rebuild from zero rather than re-firing on the first visit
      // after the snooze expires.
      return {
        state: { events: [], snoozeUntil: now + SNOOZE_MS },
        nudge: true,
        churn: churn,
        spanMs: spanMs
      };
    }

    return {
      state: { events: events, snoozeUntil: state.snoozeUntil || 0 },
      nudge: false,
      churn: churn,
      spanMs: spanMs
    };
  }

  // "Off for today" — explicit snooze until a caller-chosen timestamp.
  function snooze(state, untilTs) {
    return { events: [], snoozeUntil: untilTs };
  }

  return {
    evaluate: evaluate,
    snooze: snooze,
    emptyState: emptyState,
    TRIGGER: TRIGGER,
    CHAIN_GAP_MS: CHAIN_GAP_MS,
    RELOAD_GAP_MS: RELOAD_GAP_MS,
    HORIZON_MS: HORIZON_MS,
    SNOOZE_MS: SNOOZE_MS
  };
})();
