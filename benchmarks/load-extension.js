// Loads the REAL production artifacts (prompt, parser, prefilter, config defaults)
// out of the extension source, so evals can never drift from what actually ships.
// benchmark.js kept its own copy of the prompt and input format and drifted — this
// module exists so that can't happen again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function loadSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// XraiPrefilter — pure IIFE, no browser deps
function loadPrefilter() {
  const src = loadSource('extension/content/x/prefilter.js');
  return new Function(src + '\nreturn XraiPrefilter;')();
}

// XraiTips — pure IIFE, no browser deps
function loadTips() {
  const src = loadSource('extension/content/x/tips.js');
  return new Function(src + '\nreturn XraiTips;')();
}

// XraiReplyRoute — pure IIFE, no browser deps (reply-guard routing/immunity)
function loadReplyRoute() {
  const src = loadSource('extension/content/x/replyroute.js');
  return new Function(src + '\nreturn XraiReplyRoute;')();
}

// YtraiPrefilter — pure IIFE, no browser deps
function loadYoutubePrefilter() {
  const src = loadSource('extension/content/youtube/prefilter.js');
  return new Function(src + '\nreturn YtraiPrefilter;')();
}

// RaiHops — pure IIFE, no browser deps (hop-detection logic)
function loadHops() {
  const src = loadSource('extension/lib/hops.js');
  return new Function(src + '\nreturn RaiHops;')();
}

// Prompts + parsers from the service worker (chrome stubbed)
function loadWorker() {
  const src = loadSource('extension/background/worker.js');
  const chromeStub = {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: { get() {}, set() {} } },
  };
  return new Function(
    'chrome',
    src +
      '\nreturn { X_CLASSIFY_SYSTEM: X_CLASSIFY_SYSTEM, parseXClassification: parseXClassification, ' +
      'X_REPLY_SYSTEM: X_REPLY_SYSTEM, parseReplyClassification: parseReplyClassification, ' +
      'YT_CLASSIFY_SYSTEM: YT_CLASSIFY_SYSTEM, parseYoutubeClassification: parseYoutubeClassification };'
  )(chromeStub);
}

// RaiConfig.DEFAULTS (chrome absent → falls back to in-memory defaults)
function loadConfigDefaults() {
  const src = loadSource('extension/lib/config.js');
  return new Function(src + '\nreturn RaiConfig.DEFAULTS;')();
}

function loadGolden() {
  return JSON.parse(loadSource('benchmarks/golden-x.json'));
}

function loadGoldenYoutube() {
  return JSON.parse(loadSource('benchmarks/golden-youtube.json'));
}

function loadGoldenReplies() {
  return JSON.parse(loadSource('benchmarks/golden-replies-x.json'));
}

// Golden item → the `data` shape XraiPrefilter.prefilter() receives in production
function toPrefilterData(item) {
  return {
    text: item.text,
    hasMedia: !!item.media && item.media !== 'text',
    hasVideo: item.media === 'video',
    hasImage: item.media === 'image',
  };
}

// Golden item → the exact user message classifyX() sends to Ollama
function toUserMessage(item) {
  let msg = 'Tweet: "' + (item.text || '') + '"';
  if (item.media && item.media !== 'text') msg += ' [has ' + item.media + ']';
  return msg;
}

// Mirror of the handleTweet decision path in extension/content/x/main.js.
// Note the asymmetry this encodes: a prefilter hit hides UNCONDITIONALLY
// (the confidence threshold is never consulted); only the model path
// respects confidenceThreshold.
function decide(prefilterResult, modelResult, threshold) {
  if (prefilterResult) {
    return {
      decision: 'hidden',
      stage: 'prefilter',
      reason: prefilterResult.reason,
      confidence: prefilterResult.confidence,
    };
  }
  if (modelResult.prediction === 'noise' && modelResult.confidence >= threshold) {
    return { decision: 'hidden', stage: 'model', reason: modelResult.reason, confidence: modelResult.confidence };
  }
  return { decision: 'shown', stage: 'model', reason: modelResult.reason, confidence: modelResult.confidence };
}

function isSignalTier(tier) {
  return tier === 'signal' || tier === 'critical-signal';
}

// Golden reply item → the `data` shape prefilterReply() receives in production
function toReplyPrefilterData(item) {
  return { text: item.text };
}

// Golden reply item → the exact user message classifyReply() sends to Ollama
function toReplyUserMessage(item) {
  return 'Reply' + (item.author ? ' from @' + item.author : '') + ': "' + (item.text || '') + '"';
}

// Mirror of replyVerdictOf()/applyReplyDecision() in extension/content/x/main.js.
// Same asymmetry as the feed: a prefilter verdict blurs UNCONDITIONALLY; only
// the model path respects replyConfidenceThreshold. Everything else is shown.
function decideReply(prefilterResult, modelResult, threshold) {
  if (prefilterResult) {
    return { decision: 'blurred', stage: 'prefilter', verdict: prefilterResult.verdict, confidence: prefilterResult.confidence };
  }
  const bad = modelResult.verdict && modelResult.verdict !== 'fine' && modelResult.confidence >= threshold;
  return { decision: bad ? 'blurred' : 'shown', stage: 'model', verdict: bad ? modelResult.verdict : 'fine', confidence: modelResult.confidence };
}

function isReplyKeepTier(tier) {
  return tier === 'genuine' || tier === 'tempting-bad-faith';
}

// Golden YouTube item → the `data` shape YtraiPrefilter.prefilter() receives in production
function toYoutubePrefilterData(item) {
  return { title: item.title, channel: item.channel };
}

// Golden YouTube item → the exact user message classifyYoutube() sends to Ollama
function toYoutubeUserMessage(item) {
  let msg = 'Title: "' + (item.title || '') + '"';
  if (item.channel) msg += '\nChannel: "' + item.channel + '"';
  return msg;
}

// Mirror of applyDecision() in extension/content/youtube/main.js. Note the same
// asymmetry as X's decide(): a prefilter keep bypasses confidenceThreshold
// entirely; only the model path respects it.
function decideYoutube(prefilterResult, modelResult, keepMotivational, threshold) {
  const result = prefilterResult
    ? { category: prefilterResult.category, confidence: prefilterResult.confidence, source: 'prefilter:' + prefilterResult.reason }
    : { category: modelResult.category, confidence: modelResult.confidence, source: 'model' };
  const isPrefilter = result.source.indexOf('prefilter') === 0;

  let keep = false;
  if (result.category === 'music') keep = true;
  else if (result.category === 'motivational' && keepMotivational) keep = true;

  if (keep && !isPrefilter && result.confidence !== undefined && result.confidence < threshold) {
    keep = false;
  }

  return { decision: keep ? 'kept' : 'blurred', stage: isPrefilter ? 'prefilter' : 'model', category: result.category, confidence: result.confidence };
}

function isKeepTier(tier) {
  return tier === 'music' || tier === 'motivational';
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

module.exports = {
  loadPrefilter,
  loadYoutubePrefilter,
  loadHops,
  loadTips,
  loadReplyRoute,
  loadWorker,
  loadConfigDefaults,
  loadGolden,
  loadGoldenYoutube,
  loadGoldenReplies,
  toPrefilterData,
  toUserMessage,
  toYoutubePrefilterData,
  toYoutubeUserMessage,
  toReplyPrefilterData,
  toReplyUserMessage,
  decide,
  decideYoutube,
  decideReply,
  isSignalTier,
  isKeepTier,
  isReplyKeepTier,
  sha,
};
