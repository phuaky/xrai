/* ytrai — YouTube Video Detector (MutationObserver + recycle-aware extraction) */
var YtraiDetector = (function () {
  'use strict';

  var callbacks = [];
  var observer = null;
  var debounceTimer = null;
  var DEBOUNCE_MS = 200;

  // Every flavour of video card YouTube renders across home / subs / search / sidebar.
  var RENDERERS = [
    'ytd-rich-item-renderer',       // home + subscriptions grid
    'ytd-video-renderer',           // search results, some feeds
    'ytd-grid-video-renderer',      // older grid shelves
    'ytd-compact-video-renderer'    // watch-page sidebar (up next / related)
  ].join(', ');

  function onVideo(cb) {
    callbacks.push(cb);
  }

  // videoId from the first watch / shorts link inside the card.
  function extractVideoId(el) {
    var links = el.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var m = href.match(/[?&]v=([\w-]{6,})/);
      if (m) return m[1];
      var s = href.match(/\/shorts\/([\w-]{6,})/);
      if (s) return 'short:' + s[1];
    }
    return null;
  }

  function readTitleFrom(node) {
    if (!node) return '';
    var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt;
    if (node.getAttribute) {
      var attr = node.getAttribute('title') || node.getAttribute('aria-label');
      if (attr) return attr.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function extractTitle(el) {
    var primary = el.querySelector('#video-title');
    var t = readTitleFrom(primary);
    if (t) return t;
    // Shorts lockups + fallbacks
    var alt = el.querySelector(
      '.shortsLockupViewModelHostMetadataTitle, h3 a#video-title-link, #video-title-link, h3 a, a#video-title'
    );
    return readTitleFrom(alt);
  }

  // Thumbnail <img> src — used by the image bait check. YouTube lazy-loads
  // these, so prefer whichever attribute actually has a real URL at scan time.
  function extractThumbnail(el) {
    var img = el.querySelector('ytd-thumbnail img, #thumbnail img, .shortsLockupViewModelHostThumbnailContainer img');
    if (!img) return '';
    return img.src || img.getAttribute('data-thumb') || '';
  }

  function extractChannel(el) {
    var cn = el.querySelector('ytd-channel-name, #channel-name, .ytd-channel-name');
    if (cn) {
      // Drill into the actual name node; take the first line so trailing badge /
      // metadata text can't break the end-anchored "- Topic" prefilter match.
      var nameNode = cn.querySelector('#text, a, yt-formatted-string') || cn;
      var legacyName = (nameNode.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
      if (legacyName) return legacyName;
    }

    // YouTube's 2026 lockup cards replaced ytd-channel-name with a metadata
    // view model. Its first metadata text node is the byline; later nodes are
    // view count and age. Keep this scoped so labels added by rai are ignored.
    var modern = el.querySelector('yt-content-metadata-view-model');
    if (!modern) return '';
    var rows = modern.querySelectorAll('.ytContentMetadataViewModelMetadataText');
    for (var i = 0; i < rows.length; i++) {
      var value = (rows[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!value || value === '\u2022' || /^\d[\d.,]*[KMB]?\s+views?$/i.test(value) || /\sago$/i.test(value)) continue;
      return value;
    }
    return '';
  }

  function scan() {
    var nodes = document.querySelectorAll(RENDERERS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var id = extractVideoId(el);
      if (!id) continue;
      if (el._ytraiId === id) continue;        // same video already handled on this element

      // Element recycled to a different video — reset prior visual state NOW,
      // before bailing on a not-yet-rendered title, so a stale blur/label from
      // the previous video can't persist on the recycled card.
      if (el._ytraiId && el._ytraiId !== id && typeof RaiHider !== 'undefined') {
        RaiHider.show(el);
        RaiHider.unblurPending(el);
        el._ytraiId = null;
      }

      var title = extractTitle(el);
      if (!title) continue;                     // card not fully rendered yet — retry next mutation

      el._ytraiId = id;
      var data = { id: id, title: title, channel: extractChannel(el), thumbnailUrl: extractThumbnail(el) };
      for (var c = 0; c < callbacks.length; c++) {
        try { callbacks[c]({ element: el, data: data }); } catch (e) { /* silent */ }
      }
    }
  }

  function handleMutations() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, DEBOUNCE_MS);
  }

  function start() {
    if (observer) return;
    scan();
    observer = new MutationObserver(handleMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    // YouTube is a SPA — re-scan after client-side navigations.
    document.addEventListener('yt-navigate-finish', function () {
      setTimeout(scan, 300);
    });
    window.addEventListener('yt-navigate-finish', function () {
      setTimeout(scan, 300);
    });
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }

  return {
    onVideo: onVideo,
    start: start,
    stop: stop,
    scan: scan,
    _extractVideoId: extractVideoId,
    _extractTitle: extractTitle,
    _extractChannel: extractChannel,
    _extractThumbnail: extractThumbnail
  };
})();
