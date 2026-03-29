/* xrai — Pre-filter (regex-based instant noise detection) */
var XraiPrefilter = (function () {
  'use strict';

  var NSFW = /\b(onlyfans|thirst\s*trap|horny|nude[s]?|nudes|nsfw|xxx|porn|sexy|topless|lingerie|18\+|barely\s*legal|slutty|booty|thicc|come\s*see\s*me|link\s*in\s*bio.*\b(spicy|exclusive|content))\b/i;

  var ENGAGEMENT_BAIT = /\b(follow\s*(for|4)\s*follow|f4f|ratio\s+this|retweet\s*if|like\s*if\s*you|rt\s*if|drop\s*your|comment\s*your|tag\s*(a\s*friend|someone)|who\s*(else|agrees)|unpopular\s*opinion.*:?\s*$|what'?s\s*your\s*excuse|bet\s*you\s*can'?t|only\s*\d+%\s*(of\s*people|can|will)|this\s*is\s*a\s*test)\b/i;

  // Engagement suffixes — vague takes ending with bait
  var ENGAGEMENT_SUFFIX = /\b(who\s*agrees\??|thoughts\??|am\s*i\s*wrong\??|change\s*my\s*mind|let\s*that\s*sink\s*in|read\s*that\s*again|iykyk|no\s*cap)\s*[.!?]*$/i;

  var SPAM = /\b(free\s*money|giveaway|passive\s*income|make\s*\$?\d+[k]?\s*(a\s*day|daily|per\s*month|in\s*my\s*first)|get\s*rich|dm\s*me\s*for|crypto\s*gem|100x\s*potential|guaranteed\s*returns|airdrop|drop\s*wallet|whitelist\s*spot|one\s*simple\s*trick|one\s*weird\s*trick|this\s*one\s*trick|side\s*hustle|financial\s*freedom)\b/i;

  var CLICKBAIT_PHRASES = /\b(you\s*won'?t\s*believe|wait\s*(for|till)\s*(it|the\s*end)|this\s*is\s*so\s*(good|crazy|funny|wild|insane)|my\s*(grandma|mom|dad|kid)\s*(taught|showed|told)|i\s*can'?t\s*(believe|stop)|no\s*way|bro\s*what|absolute\s*madness|i'?m\s*dead|crying|screaming|watch\s*till\s*(the\s*)?end)\b/i;

  var CLICKBAIT_VIDEO_SHORT = /^.{0,30}$/;

  function prefilter(data) {
    var text = (data.text || '').trim();
    var hasMedia = data.hasMedia || data.hasVideo || data.hasImage || data.hasGif;
    var mediaType = data.mediaType || 'text';

    // Empty text with media = likely engagement bait
    if (!text && hasMedia) {
      return { prediction: 'noise', confidence: 0.85, reason: 'media-only, no text', source: 'prefilter' };
    }

    // Ultra-short text without media = usually nothing useful
    if (text.length < 15 && !hasMedia) {
      return { prediction: 'noise', confidence: 0.80, reason: 'ultra-short text', source: 'prefilter' };
    }

    // NSFW
    if (NSFW.test(text)) {
      return { prediction: 'noise', confidence: 0.95, reason: 'nsfw', source: 'prefilter' };
    }

    // Engagement bait
    if (ENGAGEMENT_BAIT.test(text)) {
      return { prediction: 'noise', confidence: 0.9, reason: 'engagement-bait', source: 'prefilter' };
    }

    // Engagement suffixes (vague take + "who agrees?")
    if (ENGAGEMENT_SUFFIX.test(text)) {
      return { prediction: 'noise', confidence: 0.85, reason: 'engagement-suffix', source: 'prefilter' };
    }

    // Spam
    if (SPAM.test(text)) {
      return { prediction: 'noise', confidence: 0.9, reason: 'spam', source: 'prefilter' };
    }

    // Clickbait phrases — catch even WITHOUT video
    if (CLICKBAIT_PHRASES.test(text) && text.length < 80) {
      return { prediction: 'noise', confidence: 0.85, reason: 'clickbait-phrase', source: 'prefilter' };
    }

    // Clickbait video: has video + vague short text
    if (data.hasVideo && CLICKBAIT_VIDEO_SHORT.test(text)) {
      return { prediction: 'noise', confidence: 0.85, reason: 'clickbait-video', source: 'prefilter' };
    }

    // Not caught — pass to AI
    return null;
  }

  return { prefilter: prefilter };
})();
