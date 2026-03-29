/* xrai — Viewport Gate (IntersectionObserver, 500ms visibility threshold) */
var XraiViewport = (function () {
  'use strict';

  var MAX_QUEUE = 5;
  var VISIBILITY_MS = 500;

  var observer = null;
  var timers = new Map();    // element -> timeoutId
  var pending = new Map();   // element -> { data, onReady }
  var queueCount = 0;

  function init() {
    if (observer) return;
    observer = new IntersectionObserver(handleIntersection, {
      rootMargin: '200px 0px',
      threshold: 0.3
    });
  }

  function handleIntersection(entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (entry.isIntersecting) {
        // Start 500ms timer
        if (!timers.has(el) && pending.has(el)) {
          var timer = setTimeout(function () {
            timers.delete(el);
            var info = pending.get(el);
            if (info && queueCount < MAX_QUEUE) {
              queueCount++;
              pending.delete(el);
              observer.unobserve(el);
              try { info.onReady(info.data); } catch (e) { /* silent */ }
              // Decrement after a delay to allow next batch
              setTimeout(function () { queueCount = Math.max(0, queueCount - 1); }, 3000);
            }
          }, VISIBILITY_MS);
          timers.set(el, timer);
        }
      } else {
        // Scrolled away before 500ms — cancel
        if (timers.has(el)) {
          clearTimeout(timers.get(el));
          timers.delete(el);
        }
      }
    });
  }

  function observe(element, data, onReady) {
    init();
    if (queueCount >= MAX_QUEUE) return; // queue full
    pending.set(element, { data: data, onReady: onReady });
    observer.observe(element);
  }

  function unobserve(element) {
    if (timers.has(element)) {
      clearTimeout(timers.get(element));
      timers.delete(element);
    }
    pending.delete(element);
    if (observer) observer.unobserve(element);
  }

  return {
    observe: observe,
    unobserve: unobserve
  };
})();
