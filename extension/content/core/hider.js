/* rai — Hider (CSS manipulation to hide/blur/collapse cards, platform-agnostic) */
var RaiHider = (function () {
  'use strict';

  var PENDING_BLUR_DELAY_MS = 300;

  // blurPending(el)        -> blur after a short delay (X: avoids flashing cached signal)
  // blurPending(el, 0)     -> blur immediately/synchronously (YouTube: blur-first UX)
  function blurPending(element, delayMs) {
    if (!element) return;
    if (element._raiPendingTimer || element.hasAttribute('data-xrai-pending')) return;
    if (delayMs === undefined) delayMs = PENDING_BLUR_DELAY_MS;

    if (delayMs <= 0) {
      element.setAttribute('data-xrai-pending', '1');
      element.style.position = 'relative';
      return;
    }
    element._raiPendingTimer = setTimeout(function () {
      element._raiPendingTimer = null;
      element.setAttribute('data-xrai-pending', '1');
      element.style.position = 'relative';
    }, delayMs);
  }

  function unblurPending(element) {
    if (!element) return;
    if (element._raiPendingTimer) {
      clearTimeout(element._raiPendingTimer);
      element._raiPendingTimer = null;
    }
    element.removeAttribute('data-xrai-pending');
    element.style.position = '';
  }

  function hide(element, method, reason) {
    if (!element || element.getAttribute('data-xrai-hidden')) return;
    element.removeAttribute('data-xrai-pending');
    method = method || 'remove';
    element.setAttribute('data-xrai-hidden', method);

    if (method === 'remove') {
      element.style.display = 'none';
    } else if (method === 'collapse') {
      element.style.height = '4px';
      element.style.overflow = 'hidden';
      element.style.opacity = '0.3';
      element.style.cursor = 'pointer';
      element.style.transition = 'all 0.2s ease';
      element._xraiExpandHandler = function () {
        if (element.getAttribute('data-xrai-expanded')) {
          element.style.height = '4px';
          element.style.overflow = 'hidden';
          element.style.opacity = '0.3';
          element.removeAttribute('data-xrai-expanded');
        } else {
          element.style.height = '';
          element.style.overflow = '';
          element.style.opacity = '0.6';
          element.setAttribute('data-xrai-expanded', '1');
        }
      };
      element.addEventListener('click', element._xraiExpandHandler);
    } else if (method === 'blur') {
      element.style.position = 'relative';
      var btn = document.createElement('button');
      btn.className = 'xrai-peek-btn';
      btn.textContent = '👁 Show';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (element.hasAttribute('data-xrai-revealed')) {
          element.removeAttribute('data-xrai-revealed');
          btn.textContent = '👁 Show';
        } else {
          element.setAttribute('data-xrai-revealed', '1');
          btn.textContent = 'Hide';
        }
      });
      element.appendChild(btn);
      element._xraiPeekBtn = btn;

      if (reason) {
        var label = document.createElement('div');
        label.className = 'xrai-blur-label';
        label.textContent = reason;
        element.appendChild(label);
        element._xraiBlurLabel = label;
      }

      // Guard: swallow clicks on the blurred card so the site's link handlers
      // don't navigate away when the user misses the peek button.
      var guard = function (e) {
        if (element.hasAttribute('data-xrai-revealed')) return;
        var t = e.target;
        if (t && (t.closest('.xrai-peek-btn') || t.closest('.xrai-blur-label') || t.closest('.xrai-wrong-btn'))) return;
        e.preventDefault();
        e.stopPropagation();
      };
      element.addEventListener('click', guard, true);
      element._xraiBlurGuard = guard;
    }
  }

  function show(element) {
    if (!element) return;
    element.removeAttribute('data-xrai-hidden');
    element.removeAttribute('data-xrai-expanded');

    element.style.display = '';
    element.style.height = '';
    element.style.overflow = '';
    element.style.opacity = '';
    element.style.cursor = '';
    element.style.filter = '';
    element.style.transition = '';
    element.removeAttribute('data-xrai-revealed');

    if (element._xraiExpandHandler) {
      element.removeEventListener('click', element._xraiExpandHandler);
      delete element._xraiExpandHandler;
    }
    if (element._xraiPeekBtn) {
      element._xraiPeekBtn.remove();
      delete element._xraiPeekBtn;
    }
    if (element._xraiBlurLabel) {
      element._xraiBlurLabel.remove();
      delete element._xraiBlurLabel;
    }
    if (element._xraiBlurGuard) {
      element.removeEventListener('click', element._xraiBlurGuard, true);
      delete element._xraiBlurGuard;
    }
    if (element._xraiSignalLabel) {
      element._xraiSignalLabel.remove();
      delete element._xraiSignalLabel;
    }
    removeWrongButton(element);
  }

  // One-tap correction affordance ("✗" bottom-right). The click both fixes the
  // card AND records ground truth — the only path that ever surfaces false-hides
  // from live browsing, so it feeds the eval golden set.
  function addWrongButton(element, onWrong, titleText) {
    if (!element || element._xraiWrongBtn) return;
    element.style.position = 'relative';
    var btn = document.createElement('button');
    btn.className = 'xrai-wrong-btn';
    btn.textContent = '✗';
    btn.title = titleText || 'Wrong call? Click to correct';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      removeWrongButton(element);
      onWrong();
    });
    element.appendChild(btn);
    element._xraiWrongBtn = btn;
  }

  function removeWrongButton(element) {
    if (element && element._xraiWrongBtn) {
      element._xraiWrongBtn.remove();
      delete element._xraiWrongBtn;
    }
  }

  // Small green badge on kept cards (X: "signal"; YouTube: "♪ music" / "motivation")
  function addKeepLabel(element, reason) {
    if (!element || !reason || element._xraiSignalLabel) return;
    element.style.position = 'relative';
    var label = document.createElement('div');
    label.className = 'xrai-signal-label';
    label.textContent = reason;
    element.appendChild(label);
    element._xraiSignalLabel = label;
  }

  return {
    blurPending: blurPending,
    unblurPending: unblurPending,
    hide: hide,
    show: show,
    addKeepLabel: addKeepLabel,
    addSignalLabel: addKeepLabel, // back-compat alias
    addWrongButton: addWrongButton,
    removeWrongButton: removeWrongButton
  };
})();
