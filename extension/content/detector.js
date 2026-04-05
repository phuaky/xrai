/* xrai — Tweet Detector (MutationObserver + data extraction) */
var XraiDetector = (function () {
  'use strict';

  var callbacks = [];
  var processed = new Set();
  var observer = null;
  var debounceTimer = null;
  var DEBOUNCE_MS = 150;

  function onTweet(cb) {
    callbacks.push(cb);
  }

  function extractTweetId(el) {
    // Look for status link
    var link = el.querySelector('a[href*="/status/"]');
    if (link) {
      var match = link.href.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    // Fallback: use time element's parent link
    var time = el.querySelector('time');
    if (time && time.parentElement && time.parentElement.href) {
      var m2 = time.parentElement.href.match(/\/status\/(\d+)/);
      if (m2) return m2[1];
    }
    return null;
  }

  function extractAuthor(el) {
    // Author handle from the first link that looks like /@handle
    var links = el.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        return href.substring(1);
      }
    }
    return null;
  }

  function extractAuthorName(el) {
    var spans = el.querySelectorAll('[data-testid="User-Name"] span');
    if (spans.length > 0) return spans[0].textContent || '';
    return '';
  }

  function extractText(el) {
    // Get the tweet's own text, excluding quoted tweet text
    var quoteTweet = el.querySelector('[data-testid="quoteTweet"]');
    var tweetTexts = el.querySelectorAll('[data-testid="tweetText"]');
    for (var i = 0; i < tweetTexts.length; i++) {
      // Skip tweetText elements inside a quoted tweet
      if (quoteTweet && quoteTweet.contains(tweetTexts[i])) continue;
      return tweetTexts[i].textContent.trim();
    }
    return '';
  }

  function extractQuotedText(el) {
    var quote = el.querySelector('[data-testid="quoteTweet"]');
    if (!quote) return '';
    var textEl = quote.querySelector('[data-testid="tweetText"]');
    return textEl ? textEl.textContent.trim() : '';
  }

  function extractCardText(el) {
    var card = el.querySelector('[data-testid="card.wrapper"]');
    if (!card) return '';
    // Cards typically have a title and description in span/div elements
    var parts = [];
    var spans = card.querySelectorAll('span, div[dir="ltr"]');
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent.trim();
      if (t && parts.indexOf(t) === -1) parts.push(t);
    }
    return parts.join(' ').trim();
  }

  function detectMedia(el) {
    var hasVideo = !!(
      el.querySelector('[data-testid="videoPlayer"]') ||
      el.querySelector('video') ||
      el.querySelector('[data-testid="videoComponent"]')
    );
    var hasImage = !!el.querySelector('[data-testid="tweetPhoto"] img');
    var hasGif = !!el.querySelector('[data-testid="videoPlayer"][aria-label*="GIF"]');
    // If gif detection fails, check for the GIF badge
    if (!hasGif) {
      var badges = el.querySelectorAll('span');
      for (var i = 0; i < badges.length; i++) {
        if (badges[i].textContent === 'GIF') { hasGif = true; break; }
      }
    }
    var hasMedia = hasVideo || hasImage || hasGif;
    var mediaType = 'text';
    if (hasVideo) mediaType = 'video';
    else if (hasGif) mediaType = 'gif';
    else if (hasImage) mediaType = 'image';
    return { hasVideo: hasVideo, hasImage: hasImage, hasGif: hasGif, hasMedia: hasMedia, mediaType: mediaType };
  }

  function detectReply(el) {
    var ctx = el.querySelector('[data-testid="socialContext"]');
    if (ctx && /replying to/i.test(ctx.textContent)) return true;
    // Check if inside a reply thread
    var link = el.querySelector('a[href*="/status/"]');
    if (link && link.href) {
      var parts = link.href.split('/');
      var statusIdx = parts.indexOf('status');
      // If there's content after status/id, might be a reply context
      if (statusIdx >= 0 && parts.length > statusIdx + 2) return true;
    }
    return false;
  }

  function extractData(el) {
    var id = extractTweetId(el);
    if (!id) return null;
    var text = extractText(el);
    var quotedText = extractQuotedText(el);
    var cardText = extractCardText(el);
    var media = detectMedia(el);
    var hasQuote = quotedText !== '';
    var hasCard = cardText !== '';
    var isMediaOnly = media.hasMedia && text === '' && !hasQuote && !hasCard;
    return {
      id: id,
      text: text,
      quotedText: quotedText,
      cardText: cardText,
      author: extractAuthor(el),
      authorName: extractAuthorName(el),
      isReply: detectReply(el),
      hasVideo: media.hasVideo,
      hasImage: media.hasImage,
      hasGif: media.hasGif,
      hasMedia: media.hasMedia,
      mediaType: media.mediaType,
      hasQuote: hasQuote,
      hasCard: hasCard,
      isMediaOnly: isMediaOnly
    };
  }

  function scanArticles() {
    var articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(function (el) {
      var data = extractData(el);
      if (!data || !data.id) return;
      if (processed.has(data.id)) return;
      processed.add(data.id);
      callbacks.forEach(function (cb) {
        try { cb({ element: el, data: data }); } catch (e) { /* silent */ }
      });
    });
  }

  function handleMutations() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanArticles, DEBOUNCE_MS);
  }

  function start() {
    if (observer) return;
    // Initial scan
    scanArticles();
    // Watch for new tweets
    observer = new MutationObserver(handleMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }

  return {
    onTweet: onTweet,
    start: start,
    stop: stop
  };
})();
