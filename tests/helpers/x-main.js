import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '../../extension/content/x/main.js'), 'utf8');

export function bootXMain(options = {}) {
  let onTweet = null;
  let configListener = null;
  const memoryCalls = [];
  const order = [];
  const events = [];
  const config = Object.assign({
    model: 'production-x',
    confidenceThreshold: 0.7,
    memoryAware: options.memoryAware !== false,
    memoryConfidenceThreshold: 0.75,
    contentFilter: 'all',
    hideMethod: 'remove',
    imageBaitEnabled: false,
    hopNudge: false,
    replyGuard: false,
  }, options.config);

  const stubs = {
    chrome: {
      runtime: {
        id: 'memory-main-test',
        lastError: undefined,
        sendMessage(message, callback) {
          if (message.action === 'checkHealth') callback({ available: true, classify: true, models: [config.model] });
        },
      },
    },
    RaiMemory: {
      init: async () => {}, startSession() {}, incrementStats() {}, markSeen() {},
      computeFingerprint: () => 'fp',
      logEvent: (event) => events.push(event), mirrorEvent() {},
      getEvents: async () => [],
    },
    RaiKnowledge: {
      init: async () => {}, pruneRetention: async () => {}, retryPendingEmbeddings: async () => {},
      recordFeedDecision: async () => {}, exportData: async () => ({ claims: [] }),
    },
    RaiConfig: {
      getConfig: () => ({
        then(callback) { callback(Object.assign({}, config)); return Promise.resolve(); },
      }),
      onChanged(platform, listener) { configListener = listener; },
    },
    RaiClassifier: {
      configure() {}, onActivity() {}, checkCache: () => null, cacheResult() {},
      classify(id, payload, callback) {
        callback(options.stage1Result || {
          prediction: 'signal', confidence: 0.91, reason: 'useful', source: 'model', _model: config.model, _ms: 10,
        });
      },
    },
    RaiImageClassifier: { configure() {}, onActivity() {}, checkCache: () => null, classify() {} },
    RaiIndicator: {
      init() {}, update() {}, setActivity() {}, incrementHidden() {}, incrementKept() {}, setExtra() {},
    },
    RaiDwell: { init() {}, observe() {}, getActiveElapsed: () => 0 },
    RaiHopNudge: { init() {} },
    RaiHider: {
      blurPending() { order.push('pending'); },
      unblurPending() { order.push('revealed'); },
      hide() { order.push('hidden'); },
      addKeepLabel() { order.push('keep-label'); },
      addImageLabelButtons() {},
      collapseMemory(element, label, onReveal) {
        order.push('collapsed:' + label);
        element._revealMemory = onReveal;
        return true;
      },
    },
    XraiDetector: { onTweet(callback) { onTweet = callback; }, start() {}, rescan() {} },
    XraiPrefilter: { prefilter: () => null, prefilterReply: () => null },
    XraiReplyRoute: { guardPage: () => null },
    XraiTips: { isTip: () => false },
    XraiMemoryPass: {
      run(input) {
        order.push('memory-start');
        memoryCalls.push(input);
        if (options.requestCollapse) input.collapse('familiar repeat', { novelty: 'repeat' });
        return Promise.resolve({ action: options.requestCollapse ? 'collapse' : 'show' });
      },
    },
  };

  new Function(
    'chrome', 'RaiMemory', 'RaiKnowledge', 'RaiConfig', 'RaiClassifier', 'RaiImageClassifier',
    'RaiIndicator', 'RaiDwell', 'RaiHopNudge', 'RaiHider', 'XraiDetector', 'XraiPrefilter',
    'XraiReplyRoute', 'XraiTips', 'XraiMemoryPass', 'setInterval', 'requestIdleCallback',
    source + '\nreturn XraiMain;'
  )(
    stubs.chrome, stubs.RaiMemory, stubs.RaiKnowledge, stubs.RaiConfig, stubs.RaiClassifier,
    stubs.RaiImageClassifier, stubs.RaiIndicator, stubs.RaiDwell, stubs.RaiHopNudge,
    stubs.RaiHider, stubs.XraiDetector, stubs.XraiPrefilter, stubs.XraiReplyRoute,
    stubs.XraiTips, stubs.XraiMemoryPass, () => 1, () => 1
  );

  return {
    emit(dataOverrides = {}, element = null) {
      if (!element) {
        element = document.createElement('article');
        element.innerHTML = '<div data-testid="tweetText">tweet</div>';
      }
      document.body.appendChild(element);
      onTweet({
        element,
        data: Object.assign({
          id: 'tweet-1', text: 'A concrete AI release', author: 'maker', mediaType: 'text',
          hasImage: false, hasMedia: false, hasQuote: false, hasCard: false,
          isMediaOnly: false, isReply: false,
        }, dataOverrides),
      });
      return element;
    },
    memoryCalls,
    order,
    events,
    updateConfig(next) { Object.assign(config, next); configListener(Object.assign({}, config)); },
  };
}
