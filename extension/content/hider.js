/* xrai — Hider (CSS manipulation to hide/show noise tweets) */
var XraiHider = (function () {
  'use strict';

  var PENDING_BLUR_DELAY_MS = 300;

  function blurPending(element) {
    if (!element) return;
    if (element._xraiPendingTimer || element.hasAttribute('data-xrai-pending')) return;
    element._xraiPendingTimer = setTimeout(function () {
      element._xraiPendingTimer = null;
      element.setAttribute('data-xrai-pending', '1');
      element.style.position = 'relative';
    }, PENDING_BLUR_DELAY_MS);
  }

  function unblurPending(element) {
    if (!element) return;
    if (element._xraiPendingTimer) {
      clearTimeout(element._xraiPendingTimer);
      element._xraiPendingTimer = null;
    }
    element.removeAttribute('data-xrai-pending');
    element.style.position = '';
  }

  function hide(element, method, reason) {
    if (!element || element.getAttribute('data-xrai-hidden')) return;
    // Clear pending blur state when transitioning to confirmed hide
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
      btn.textContent = '\uD83D\uDC41 Show';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (element.hasAttribute('data-xrai-revealed')) {
          element.removeAttribute('data-xrai-revealed');
          btn.textContent = '\uD83D\uDC41 Show';
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

      // Guard: swallow clicks on the blurred article so X's link handlers don't
      // navigate away when the user misses the peek button.
      var guard = function (e) {
        if (element.hasAttribute('data-xrai-revealed')) return;
        var t = e.target;
        if (t && (t.closest('.xrai-peek-btn') || t.closest('.xrai-blur-label'))) return;
        e.preventDefault();
        e.stopPropagation();
      };
      element.addEventListener('click', guard, true);
      element._xraiBlurGuard = guard;
    }
  }

  function show(element) {
    if (!element) return;
    var method = element.getAttribute('data-xrai-hidden');
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
  }

  function addSignalLabel(element, reason) {
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
    addSignalLabel: addSignalLabel
  };
})();
