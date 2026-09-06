/* ytrai - conservative show/blur policy (pure logic, no browser dependencies) */
var YtraiPolicy = (function () {
  'use strict';

  var DEFAULT_THRESHOLD = 0.6;

  function normalizeCategory(value) {
    var category = String(value || '').trim().toLowerCase();
    if (category === 'music') return 'music';
    if (category === 'motivational' || category === 'motivation') return 'motivational';
    if (category === 'useful' || category === 'worthwhile' || category === 'signal' ||
        category === 'informative' || category === 'educational') return 'useful';
    // "other" is the legacy model label for content outside music/motivation.
    if (category === 'distraction' || category === 'noise' || category === 'other') return 'distraction';
    return 'unknown';
  }

  function confidenceOf(result) {
    var confidence = Number(result && result.confidence);
    if (!Number.isFinite(confidence)) return 0;
    return Math.min(1, Math.max(0, confidence));
  }

  function decide(result, options) {
    options = options || {};
    var threshold = Number(options.threshold);
    if (!Number.isFinite(threshold)) threshold = DEFAULT_THRESHOLD;
    var confidence = confidenceOf(result);
    var category = normalizeCategory(result && result.category);
    var source = String((result && result.source) || 'model');
    var prefiltered = source.indexOf('prefilter:') === 0;

    if (!result || result._error || source === 'error' || category === 'unknown') {
      return {
        decision: 'kept', category: 'useful', confidence: confidence,
        cause: !result ? 'missing-result' : (result._error ? 'model-error' : 'unknown-category')
      };
    }

    if (prefiltered && category === 'distraction') {
      return {
        decision: 'blurred', category: category, confidence: confidence,
        cause: 'prefilter-distraction'
      };
    }

    if (category === 'motivational') {
      if (options.keepMotivational === false && confidence >= threshold) {
        return { decision: 'blurred', category: category, confidence: confidence, cause: 'motivation-disabled' };
      }
      return { decision: 'kept', category: category, confidence: confidence, cause: 'motivational' };
    }

    if (prefiltered || category === 'music' || category === 'useful') {
      return { decision: 'kept', category: category, confidence: confidence, cause: category };
    }

    // Uncertainty is not permission to hide. Only a confident, recognized
    // distraction verdict can blur a recommendation.
    if (confidence >= threshold) {
      return { decision: 'blurred', category: 'distraction', confidence: confidence, cause: 'confident-distraction' };
    }
    return {
      decision: 'kept', category: 'distraction', confidence: confidence,
      cause: 'low-confidence-distraction'
    };
  }

  return {
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    normalizeCategory: normalizeCategory,
    decide: decide
  };
})();
