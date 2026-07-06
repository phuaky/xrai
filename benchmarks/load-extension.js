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

// X_CLASSIFY_SYSTEM + parseXClassification from the service worker (chrome stubbed)
function loadWorker() {
  const src = loadSource('extension/background/worker.js');
  const chromeStub = {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: { get() {}, set() {} } },
  };
  return new Function(
    'chrome',
    src + '\nreturn { X_CLASSIFY_SYSTEM: X_CLASSIFY_SYSTEM, parseXClassification: parseXClassification };'
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

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

module.exports = {
  loadPrefilter,
  loadTips,
  loadWorker,
  loadConfigDefaults,
  loadGolden,
  toPrefilterData,
  toUserMessage,
  decide,
  isSignalTier,
  sha,
};
