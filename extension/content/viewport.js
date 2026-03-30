/* xrai — Viewport Gate (IntersectionObserver + lookahead pre-classification) */
var XraiViewport = (function () {
  'use strict';

  // Visible tweets: must be in view for 300ms before classifying
  var VISIBILITY_MS = 300;
  // Lookahead: pre-classify tweets within 1500px below viewport
  // These get classified before you scroll to them
  var LOOKAHEAD_MARGIN = '1500px 0px 0px 0px';
  var MAX_VISIBLE_QUEUE = 5;   // concurrent visible tweets being classified
  var MAX_LOOKAHEAD_QUEUE = 3; // concurrent lookahead tweets (gentle on Ollama)

  var visibleObserver = null;
  var lookaheadObserver = null;
  var timers = new Map();      // element -> timeoutId
  var pending = new Map();     // element -> { data, onReady }
  var visibleCount = 0;
  var lookaheadCount = 0;
  var classified = new Set();  // elements already sent to classifier

  function initVisible() {
    if (visibleObserver) return;
    visibleObserver = new IntersectionObserver(handleVisible, {
      rootMargin: '200px 0px',
      threshold: 0.3
    });
  }

  function initLookahead() {
    if (lookaheadObserver) return;
    lookaheadObserver = new IntersectionObserver(handleLookahead, {
      rootMargin: LOOKAHEAD_MARGIN,
      threshold: 0.1
    });
  }

  function handleVisible(entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (classified.has(el)) return;

      if (entry.isIntersecting) {
        if (!timers.has(el) && pending.has(el)) {
          var timer = setTimeout(function () {
            timers.delete(el);
            var info = pending.get(el);
            if (info && visibleCount < MAX_VISIBLE_QUEUE) {
              visibleCount++;
              classified.add(el);
              pending.delete(el);
              visibleObserver.unobserve(el);
              if (lookaheadObserver) lookaheadObserver.unobserve(el);
              try { info.onReady(info.data); } catch (e) { /* silent */ }
              setTimeout(function () { visibleCount = Math.max(0, visibleCount - 1); }, 2000);
            }
          }, VISIBILITY_MS);
          timers.set(el, timer);
        }
      } else {
        if (timers.has(el)) {
          clearTimeout(timers.get(el));
          timers.delete(el);
        }
      }
    });
  }

  function handleLookahead(entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (classified.has(el)) return;

      if (entry.isIntersecting && pending.has(el) && lookaheadCount < MAX_LOOKAHEAD_QUEUE) {
        // In lookahead zone — classify immediately (no visibility timer)
        lookaheadCount++;
        classified.add(el);
        var info = pending.get(el);
        pending.delete(el);
        if (lookaheadObserver) lookaheadObserver.unobserve(el);
        if (visibleObserver) visibleObserver.unobserve(el);
        if (timers.has(el)) {
          clearTimeout(timers.get(el));
          timers.delete(el);
        }
        try { info.onReady(info.data); } catch (e) { /* silent */ }
        setTimeout(function () { lookaheadCount = Math.max(0, lookaheadCount - 1); }, 2000);
      }
    });
  }

  function observe(element, data, onReady) {
    initVisible();
    initLookahead();
    if (classified.has(element)) return;
    pending.set(element, { data: data, onReady: onReady });
    visibleObserver.observe(element);
    lookaheadObserver.observe(element);
  }

  function unobserve(element) {
    if (timers.has(element)) {
      clearTimeout(timers.get(element));
      timers.delete(element);
    }
    pending.delete(element);
    if (visibleObserver) visibleObserver.unobserve(element);
    if (lookaheadObserver) lookaheadObserver.unobserve(element);
  }

  return {
    observe: observe,
    unobserve: unobserve
  };
})();
