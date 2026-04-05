/* xrai — Hider (CSS manipulation to hide/show noise tweets) */
var XraiHider = (function () {
  'use strict';

  function blurPending(element) {
    if (!element) return;
    element.setAttribute('data-xrai-pending', '1');
    element.style.position = 'relative';
  }

  function unblurPending(element) {
    if (!element) return;
    element.removeAttribute('data-xrai-pending');
    element.style.position = '';
  }

  function hide(element, method) {
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
      // Blur is applied via CSS: article[data-xrai-hidden="blur"] > *:not(.xrai-peek-btn)
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
  }

  return {
    blurPending: blurPending,
    unblurPending: unblurPending,
    hide: hide,
    show: show
  };
})();
