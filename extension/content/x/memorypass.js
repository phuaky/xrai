/* rai — X stage-2 memory pass.
 *
 * Runs only after stage 1 has revealed a kept tweet. Retrieval and model work
 * are asynchronous and fail open: this module can confirm show or request a
 * reversible collapse, but it can never delay or overturn the first verdict.
 */
var XraiMemoryPass = (function () {
  'use strict';

  var MAX_CONTEXTS = 5;
  var DEFAULT_THRESHOLD = 0.75;
  var MODEL_TIMEOUT_MS = 5000;
  var NOVELTIES = {
    'new-signal': true,
    'meaningful-update': true,
    'reinforcement': true,
    'repeat': true
  };

  function validateVerdict(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.prototype.hasOwnProperty.call(value, 'knownState') ||
        Object.prototype.hasOwnProperty.call(value, 'action')) return null;
    if (value.importance !== 'critical' && value.importance !== 'normal') return null;
    if (!NOVELTIES[value.novelty]) return null;
    if (typeof value.funnelRisk !== 'boolean' || typeof value.standaloneValue !== 'boolean') return null;
    if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
    if (typeof value.reason !== 'string' || !value.reason.trim()) return null;
    return {
      importance: value.importance,
      novelty: value.novelty,
      funnelRisk: value.funnelRisk,
      standaloneValue: value.standaloneValue,
      confidence: value.confidence,
      reason: value.reason.substring(0, 120)
    };
  }

  function decide(verdict, contexts, threshold) {
    var confidenceThreshold = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD;
    var list = Array.isArray(contexts) ? contexts : [];
    var strongKnown = list.some(function (context) { return context.knownState === 'strong'; });

    if (!verdict) return { action: 'show', label: null, strongKnown: strongKnown, cause: 'invalid-verdict' };
    if (verdict.importance === 'critical') {
      return { action: 'show', label: null, strongKnown: strongKnown, cause: 'critical' };
    }
    if (verdict.novelty === 'new-signal' || verdict.novelty === 'meaningful-update') {
      return { action: 'show', label: null, strongKnown: strongKnown, cause: verdict.novelty };
    }
    if (verdict.confidence < confidenceThreshold) {
      return { action: 'show', label: null, strongKnown: strongKnown, cause: 'low-confidence' };
    }
    if (verdict.funnelRisk && verdict.standaloneValue === false) {
      return { action: 'collapse', label: 'value-free funnel', strongKnown: strongKnown, cause: 'funnel' };
    }
    if (strongKnown && verdict.novelty === 'repeat') {
      return { action: 'collapse', label: 'familiar repeat', strongKnown: true, cause: 'repeat' };
    }
    if (strongKnown && verdict.novelty === 'reinforcement') {
      return { action: 'collapse', label: 'familiar reinforcement', strongKnown: true, cause: 'reinforcement' };
    }
    return { action: 'show', label: null, strongKnown: strongKnown, cause: 'not-strong-known' };
  }

  function workerCall(current, contexts) {
    return new Promise(function (resolve, reject) {
      if (!chrome.runtime || !chrome.runtime.id) {
        reject(new Error('extension context unavailable'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('memory model timeout'));
      }, MODEL_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({
          action: 'classifyMemory',
          platform: 'x',
          current: current,
          contexts: contexts.slice(0, MAX_CONTEXTS)
        }, function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'memory message failed'));
            return;
          }
          if (!response || response.error) {
            reject(new Error((response && response.error) || 'memory model unavailable'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function failureInfo(stage, code, detail) {
    return {
      stage: String(stage || 'unknown').substring(0, 40),
      code: String(code || 'memory-failed').substring(0, 80),
      detail: String(detail || code || 'memory failure').replace(/\s+/g, ' ').trim().substring(0, 300)
    };
  }

  function logOutcome(input, contexts, verdict, policy, timing, failure) {
    if (typeof RaiMemory === 'undefined' || !RaiMemory.logEvent) return;
    var record = {
      platform: 'x',
      kind: 'memory-decision',
      tweetId: input.id,
      retrievedTweetIds: contexts.map(function (context) { return context.tweetId; }),
      similarityScores: contexts.map(function (context) { return context.similarity; }),
      knownState: contexts.map(function (context) { return context.knownState; }),
      importance: verdict ? verdict.importance : null,
      novelty: verdict ? verdict.novelty : null,
      funnelRisk: verdict ? verdict.funnelRisk : null,
      standaloneValue: verdict ? verdict.standaloneValue : null,
      confidence: verdict ? verdict.confidence : null,
      reason: verdict ? verdict.reason : null,
      finalAction: policy.action,
      actionCause: policy.cause,
      strongKnown: policy.strongKnown,
      retrievalMs: timing.retrievalMs,
      classificationMs: timing.classificationMs,
      totalMs: timing.totalMs,
      failure: failure ? failure.code : null,
      failureStage: failure ? failure.stage : null,
      failureDetail: failure ? failure.detail : null,
      source: input.stage1Source,
      model: input.runtimeModel || input.model
    };
    try {
      RaiMemory.logEvent(record);
      if (RaiMemory.mirrorEvent) RaiMemory.mirrorEvent(record);
    } catch (e) { /* observability must not affect rendering */ }
  }

  function failOpen(input, contexts, startedAt, retrievalMs, failure) {
    var timing = {
      retrievalMs: retrievalMs || 0,
      classificationMs: 0,
      totalMs: Date.now() - startedAt
    };
    var policy = {
      action: 'show',
      label: null,
      strongKnown: (contexts || []).some(function (context) { return context.knownState === 'strong'; }),
      cause: 'failure'
    };
    logOutcome(input, contexts || [], null, policy, timing, failure);
    return {
      action: 'show',
      verdict: null,
      contexts: contexts || [],
      timing: timing,
      failure: failure.code,
      failureStage: failure.stage,
      failureDetail: failure.detail
    };
  }

  function run(input) {
    var startedAt = Date.now();
    var retrievalStartedAt = Date.now();
    if (!input || !input.id || !String(input.text || '').trim()) {
      return Promise.resolve(failOpen(input || {}, [], startedAt, 0,
        failureInfo('input', 'missing-input', 'Tweet ID or text is missing')));
    }
    if (typeof RaiKnowledge === 'undefined' || !RaiKnowledge.searchWithStatus) {
      return Promise.resolve(failOpen(input, [], startedAt, 0,
        failureInfo('retrieval', 'knowledge-unavailable', 'RaiKnowledge.searchWithStatus is unavailable')));
    }

    return RaiKnowledge.searchWithStatus(input.text, MAX_CONTEXTS).then(function (retrieval) {
      var retrievalMs = Date.now() - retrievalStartedAt;
      if (!retrieval || !retrieval.ok) {
        return failOpen(input, [], startedAt, retrievalMs,
          failureInfo('retrieval', 'retrieval-failed', retrieval && retrieval.error));
      }
      var contexts = (retrieval.records || []).filter(function (context) {
        return String(context.tweetId) !== String(input.id);
      }).slice(0, MAX_CONTEXTS);
      var classificationStartedAt = Date.now();
      return workerCall({
        id: String(input.id),
        text: String(input.text),
        author: input.author || '',
        truncated: input.truncated === true
      }, contexts.map(function (context) {
        return {
          tweetId: String(context.tweetId),
          text: String(context.text || ''),
          author: context.author || '',
          knownState: context.knownState,
          similarity: context.similarity,
          truncated: context.truncated === true
        };
      })).then(function (response) {
        var classificationMs = Date.now() - classificationStartedAt;
        var verdict = validateVerdict(response);
        if (!verdict) {
          return failOpen(input, contexts, startedAt, retrievalMs,
            failureInfo('classification', 'invalid-model-output', 'Memory model output failed strict validation'));
        }
        input.runtimeModel = response._model || input.model;
        var policy = decide(verdict, contexts, input.threshold);
        var activeDwellMs = 0;
        if (policy.action === 'collapse' && typeof RaiDwell !== 'undefined' && RaiDwell.getActiveElapsed) {
          activeDwellMs = RaiDwell.getActiveElapsed(String(input.id));
          if (activeDwellMs >= 1000) {
            policy = Object.assign({}, policy, { action: 'show', label: null, cause: 'active-dwell-suppressed' });
            if (typeof RaiKnowledge.recordReadDwell === 'function') {
              Promise.resolve(RaiKnowledge.recordReadDwell(input.id, activeDwellMs, {
                timestamp: Date.now(), decision: 'shown', source: 'memory-active-dwell'
              })).catch(function () {});
            }
          }
        }
        if (policy.action === 'collapse' && typeof input.collapse === 'function') {
          var applied = false;
          try { applied = input.collapse(policy.label, verdict) !== false; }
          catch (error) { applied = false; }
          if (!applied) {
            policy = Object.assign({}, policy, { action: 'show', label: null, cause: 'collapse-unavailable' });
          }
        }
        var timing = {
          retrievalMs: retrievalMs,
          classificationMs: response._ms || classificationMs,
          totalMs: Date.now() - startedAt
        };
        logOutcome(input, contexts, verdict, policy, timing, null);
        return {
          action: policy.action,
          label: policy.label,
          cause: policy.cause,
          verdict: verdict,
          contexts: contexts,
          timing: timing,
          activeDwellMs: activeDwellMs
        };
      }).catch(function (error) {
        return failOpen(input, contexts, startedAt, retrievalMs,
          failureInfo('classification', 'model-failed', (error && error.message) || error));
      });
    }).catch(function (error) {
      return failOpen(input, [], startedAt, Date.now() - retrievalStartedAt,
        failureInfo('retrieval', 'retrieval-failed', (error && error.message) || error));
    });
  }

  return {
    MAX_CONTEXTS: MAX_CONTEXTS,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    validateVerdict: validateVerdict,
    decide: decide,
    run: run
  };
})();
