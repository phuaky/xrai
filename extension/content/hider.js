/* xrai — Hider (CSS manipulation to hide/show noise tweets) */
var XraiHider = (function () {
  'use strict';

  function hide(element, method) {
    if (!element || element.getAttribute('data-xrai-hidden')) return;
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
      element.style.filter = 'blur(8px)';
      element.style.transition = 'filter 0.2s ease';
      element._xraiBlurHandler = function () {
        if (element.style.filter) {
          element.style.filter = '';
        } else {
          element.style.filter = 'blur(8px)';
        }
      };
      element.addEventListener('click', element._xraiBlurHandler);
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

    if (element._xraiExpandHandler) {
      element.removeEventListener('click', element._xraiExpandHandler);
      delete element._xraiExpandHandler;
    }
    if (element._xraiBlurHandler) {
      element.removeEventListener('click', element._xraiBlurHandler);
      delete element._xraiBlurHandler;
    }
  }

  return {
    hide: hide,
    show: show
  };
})();
