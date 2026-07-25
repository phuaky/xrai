/* xrai — Reply-guard routing (pure logic, no DOM/chrome deps)

   Decides WHERE the reply guard runs and WHICH cards it may touch. Kept pure
   so tests/replyfilter.test.js can pin the immunity rules (main tweet, own
   author, non-own pages) without a browser. main.js owns the pipeline. */
var XraiReplyRoute = (function () {
  'use strict';

  // /<handle>/status/<id> with optional trailing segments (/photo/1, /analytics)
  var STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

  // Parse a pathname into { handle, statusId } or null when not a status page.
  function statusPage(pathname) {
    var m = STATUS_PATH.exec(pathname || '');
    if (!m) return null;
    return { handle: m[1], statusId: m[2] };
  }

  // The guard is active only on the OWN status page — someone else's thread
  // renders untouched (Out of Scope v1).
  function guardPage(pathname, ownHandle) {
    if (!ownHandle) return null;
    var page = statusPage(pathname);
    if (!page) return null;
    if (page.handle.toLowerCase() !== String(ownHandle).toLowerCase()) return null;
    return page;
  }

  // Immunity: the main tweet itself and the user's own replies in the thread
  // are never classified or touched, whatever their content.
  function shouldGuard(data, page, ownHandle) {
    if (!data || !data.id || !page) return false;
    if (data.id === page.statusId) return false;
    if (data.author && ownHandle &&
        String(data.author).toLowerCase() === String(ownHandle).toLowerCase()) return false;
    return true;
  }

  return {
    statusPage: statusPage,
    guardPage: guardPage,
    shouldGuard: shouldGuard
  };
})();
