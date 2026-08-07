/* xrai — exposure-aware claim history + local semantic index (X only).
 *
 * Claim history is deliberately separate from the append-only xrai_memory event
 * ledger. One xrai_knowledge record exists per tweetId. Models may contribute
 * classification metadata and embeddings, but knownState is derived only from
 * exposure evidence: shown, read dwell, and explicit status-page opens.
 */
var LocalSemanticIndex = (function () {
  'use strict';

  var MAX_RESULTS = 5;
  var STRONG_DWELL_MS = 1000;

  function normalize(vector) {
    if (!Array.isArray(vector) || vector.length === 0) return null;
    var sum = 0;
    var out = new Array(vector.length);
    for (var i = 0; i < vector.length; i++) {
      var value = Number(vector[i]);
      if (!Number.isFinite(value)) return null;
      out[i] = value;
      sum += value * value;
    }
    if (!(sum > 0)) return null;
    var magnitude = Math.sqrt(sum);
    for (var j = 0; j < out.length; j++) out[j] = out[j] / magnitude;
    return out;
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
    var score = 0;
    for (var i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
      score += a[i] * b[i];
    }
    return Math.max(-1, Math.min(1, score));
  }

  function knownState(record) {
    if (!record) return 'unknown';
    if ((record.directOpenedAt || 0) > 0 || (record.maxDwellMs || 0) >= STRONG_DWELL_MS) return 'strong';
    return record.exposureState === 'shown' ? 'weak' : 'unknown';
  }

  // Pure full-scan helper. This intentionally has no IndexedDB dependency so a
  // 10k-record latency benchmark can exercise the real search implementation.
  function search(records, queryVector, limit) {
    var query = normalize(queryVector);
    if (!query) return [];
    var cap = Math.max(0, Math.min(MAX_RESULTS, Number(limit) || MAX_RESULTS));
    if (cap === 0) return [];

    var scored = [];
    var list = Array.isArray(records) ? records : [];
    for (var i = 0; i < list.length; i++) {
      var record = list[i];
      var embedding = normalize(record && record.embedding);
      if (!embedding || embedding.length !== query.length) continue;
      var similarity = cosine(query, embedding);
      if (similarity === null) continue;
      scored.push(Object.assign({}, record, {
        embedding: embedding,
        knownState: knownState(record),
        similarity: similarity
      }));
    }

    scored.sort(function (a, b) {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      var timeDiff = (b.updatedAt || b.lastSeenAt || 0) - (a.updatedAt || a.lastSeenAt || 0);
      if (timeDiff) return timeDiff;
      return String(a.tweetId || '').localeCompare(String(b.tweetId || ''));
    });
    return scored.slice(0, cap);
  }

  return {
    MAX_RESULTS: MAX_RESULTS,
    STRONG_DWELL_MS: STRONG_DWELL_MS,
    normalize: normalize,
    cosine: cosine,
    knownState: knownState,
    search: search
  };
})();

var RaiKnowledge = (function () {
  'use strict';

  var DEFAULT_DB_NAME = 'xrai_knowledge';
  var DB_VERSION = 1;
  var STORE_NAME = 'claims';
  var DEFAULT_EMBEDDING_MODEL = 'all-minilm:latest';
  var DEFAULT_EMBEDDING_VERSION = 1;
  var DEFAULT_MAX_AGE_DAYS = 365;
  var DEFAULT_MAX_RECORDS = 50000;
  var DAY_MS = 86400000;

  var _dbName = DEFAULT_DB_NAME;
  var _embeddingModel = DEFAULT_EMBEDDING_MODEL;
  var _embeddingVersion = DEFAULT_EMBEDDING_VERSION;
  var _embedOverride = null;
  var _db = null;
  var _initPromise = null;
  var _embeddingInFlight = Object.create(null);

  function configure(options) {
    options = options || {};
    if (options.dbName && options.dbName !== _dbName) {
      if (_db) _db.close();
      _db = null;
      _initPromise = null;
      _embeddingInFlight = Object.create(null);
      _dbName = options.dbName;
    }
    if (options.embeddingModel) _embeddingModel = options.embeddingModel;
    if (options.embeddingVersion !== undefined) _embeddingVersion = options.embeddingVersion;
    if (Object.prototype.hasOwnProperty.call(options, 'embed')) _embedOverride = options.embed || null;
  }

  function init() {
    if (_db) return Promise.resolve(_db);
    if (_initPromise) return _initPromise;
    _initPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(_dbName, DB_VERSION);
      } catch (e) {
        _initPromise = null;
        reject(e);
        return;
      }
      req.onupgradeneeded = function (event) {
        var idb = event.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          var store = idb.createObjectStore(STORE_NAME, { keyPath: 'tweetId' });
          store.createIndex('lastSeenAt', 'lastSeenAt', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      req.onsuccess = function (event) {
        _db = event.target.result;
        _db.onversionchange = function () { _db.close(); _db = null; _initPromise = null; };
        resolve(_db);
      };
      req.onerror = function (event) {
        _initPromise = null;
        reject(event.target.error || new Error('knowledge database open failed'));
      };
    });
    return _initPromise;
  }

  function timestampOf(record) {
    var value = Number(record && (record.ts || record.timestamp || record.updatedAt));
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  function textHash(text) {
    var value = String(text || '');
    var hash = 5381;
    for (var i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  function errorText(error) {
    return String((error && error.message) || error || 'embedding unavailable').substring(0, 300);
  }

  function exposureRank(state) {
    if (state === 'direct-open') return 3;
    if (state === 'shown') return 2;
    if (state === 'hidden') return 1;
    return 0;
  }

  function mergeExposure(existing, incoming) {
    return exposureRank(incoming) > exposureRank(existing) ? incoming : (existing || incoming || 'hidden');
  }

  function withKnownState(record) {
    if (!record) return undefined;
    return Object.assign({}, record, { knownState: LocalSemanticIndex.knownState(record) });
  }

  function getRaw(tweetId) {
    if (!tweetId) return Promise.resolve(undefined);
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(STORE_NAME, 'readonly');
          var req = tx.objectStore(STORE_NAME).get(String(tweetId));
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    }).catch(function () { return undefined; });
  }

  function get(tweetId) {
    return getRaw(tweetId).then(withKnownState);
  }

  function getAllRaw() {
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(STORE_NAME, 'readonly');
          var req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
    }).catch(function () { return []; });
  }

  function getAll() {
    return getAllRaw().then(function (records) { return records.map(withKnownState); });
  }

  function count() {
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(STORE_NAME, 'readonly');
          var req = tx.objectStore(STORE_NAME).count();
          req.onsuccess = function () { resolve(req.result || 0); };
          req.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    }).catch(function () { return 0; });
  }

  // Atomic same-ID reducer. Returning null from updater leaves the row unchanged.
  function update(tweetId, updater) {
    if (!tweetId) return Promise.resolve({ changed: false });
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        var outcome = { changed: false };
        try {
          var tx = idb.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          var req = store.get(String(tweetId));
          req.onsuccess = function () {
            var existing = req.result;
            var next = updater(existing);
            if (!next) {
              outcome = { changed: false, existing: existing };
              return;
            }
            store.put(next);
            outcome = { changed: true, inserted: !existing, record: next };
          };
          req.onerror = function () { outcome = { changed: false }; };
          tx.oncomplete = function () { resolve(outcome); };
          tx.onerror = function () { resolve({ changed: false }); };
          tx.onabort = function () { resolve({ changed: false }); };
        } catch (e) { resolve({ changed: false }); }
      });
    }).catch(function () { return { changed: false }; });
  }

  function requestEmbedding(text) {
    if (_embedOverride) {
      return Promise.resolve().then(function () {
        return _embedOverride(text, { model: _embeddingModel, version: _embeddingVersion });
      });
    }
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage({
          action: 'embedLocal',
          platform: 'x',
          model: _embeddingModel,
          version: _embeddingVersion,
          text: text
        }, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'embedding message failed'));
            return;
          }
          if (!response || response.error) {
            reject(new Error((response && response.error) || 'embedding unavailable'));
            return;
          }
          resolve(response.embedding);
        });
      } catch (e) { reject(e); }
    });
  }

  function embedAndAttach(tweetId, text, expectedHash) {
    var key = [tweetId, expectedHash, _embeddingModel, _embeddingVersion].join('|');
    if (_embeddingInFlight[key]) return _embeddingInFlight[key];

    var run = requestEmbedding(text).then(function (vector) {
      var normalized = LocalSemanticIndex.normalize(vector);
      if (!normalized) throw new Error('invalid embedding vector');
      return update(tweetId, function (existing) {
        if (!existing || existing.textHash !== expectedHash) return null;
        var next = Object.assign({}, existing, {
          embedding: normalized,
          embeddingModel: _embeddingModel,
          embeddingVersion: _embeddingVersion,
          embeddingUpdatedAt: Date.now()
        });
        delete next.embeddingError;
        return next;
      });
    }).catch(function (error) {
      return update(tweetId, function (existing) {
        if (!existing || existing.textHash !== expectedHash) return null;
        if (existing.embedding && existing.embeddingModel === _embeddingModel &&
            existing.embeddingVersion === _embeddingVersion) return null;
        var next = Object.assign({}, existing, { embeddingError: errorText(error) });
        delete next.embedding;
        delete next.embeddingUpdatedAt;
        return next;
      });
    }).then(function () { return get(tweetId); });

    _embeddingInFlight[key] = run.finally(function () { delete _embeddingInFlight[key]; });
    return _embeddingInFlight[key];
  }

  function recordFeedDecision(record) {
    var tweetId = record && record.tweetId;
    var text = String((record && record.text) || '').trim();
    if (!tweetId || !text) return Promise.resolve(undefined);
    var ts = timestampOf(record);
    var hash = textHash(text);
    var incomingExposure = record.decision === 'shown' ? 'shown' : 'hidden';

    return update(tweetId, function (existing) {
      var current = existing || {};
      var replaceContent = !existing || ts >= (existing.contentUpdatedAt || 0);
      var chosenText = replaceContent ? text : existing.text;
      var chosenHash = textHash(chosenText);
      var next = Object.assign({}, current, {
        tweetId: String(tweetId),
        firstSeenAt: existing ? Math.min(existing.firstSeenAt || ts, ts) : ts,
        lastSeenAt: Math.max(existing ? (existing.lastSeenAt || 0) : 0, ts),
        updatedAt: Math.max(existing ? (existing.updatedAt || 0) : 0, ts),
        liveUpdatedAt: Math.max(existing ? (existing.liveUpdatedAt || 0) : 0, ts),
        exposureState: mergeExposure(existing && existing.exposureState, incomingExposure),
        recordOrigin: 'live'
      });
      if (replaceContent) {
        Object.assign(next, {
          text: text,
          textHash: hash,
          contentUpdatedAt: ts,
          author: record.author,
          decision: record.decision,
          prediction: record.prediction,
          confidence: record.confidence,
          source: record.source,
          reason: record.reason,
          model: record.model,
          mediaType: record.mediaType,
          url: record.url,
          stage1Ms: record.ms,
          truncated: record.truncated === true
        });
      }
      if (existing && existing.textHash !== chosenHash) {
        delete next.embedding;
        delete next.embeddingUpdatedAt;
      }
      return next;
    }).then(function (outcome) {
      var saved = outcome.record || outcome.existing;
      if (!saved) return undefined;
      var needsEmbedding = !saved.embedding || saved.textHash !== hash ||
        saved.embeddingModel !== _embeddingModel || saved.embeddingVersion !== _embeddingVersion;
      return needsEmbedding ? embedAndAttach(tweetId, saved.text, saved.textHash) : withKnownState(saved);
    });
  }

  function recordDirectOpen(record) {
    var tweetId = record && record.tweetId;
    var text = String((record && record.text) || '').trim();
    if (!tweetId || !text) return Promise.resolve(undefined);
    var ts = timestampOf(record);
    var hash = textHash(text);

    return update(tweetId, function (existing) {
      var replaceContent = !existing || ts >= (existing.contentUpdatedAt || 0);
      var next = Object.assign({}, existing || {}, {
        tweetId: String(tweetId),
        firstSeenAt: existing ? Math.min(existing.firstSeenAt || ts, ts) : ts,
        lastSeenAt: Math.max(existing ? (existing.lastSeenAt || 0) : 0, ts),
        updatedAt: Math.max(existing ? (existing.updatedAt || 0) : 0, ts),
        liveUpdatedAt: Math.max(existing ? (existing.liveUpdatedAt || 0) : 0, ts),
        exposureState: 'direct-open',
        directOpenedAt: Math.max(existing ? (existing.directOpenedAt || 0) : 0, ts),
        directOpenUrl: record.url,
        recordOrigin: 'live'
      });
      if (replaceContent) {
        next.text = text;
        next.textHash = hash;
        next.contentUpdatedAt = ts;
        next.author = record.author;
        next.truncated = record.truncated === true;
      }
      if (existing && existing.textHash !== next.textHash) {
        delete next.embedding;
        delete next.embeddingUpdatedAt;
      }
      return next;
    }).then(function (outcome) {
      var saved = outcome.record || outcome.existing;
      if (!saved) return undefined;
      var needsEmbedding = !saved.embedding || saved.embeddingModel !== _embeddingModel ||
        saved.embeddingVersion !== _embeddingVersion;
      return needsEmbedding ? embedAndAttach(tweetId, saved.text, saved.textHash) : withKnownState(saved);
    });
  }

  function recordReadDwell(tweetId, dwellMs, meta) {
    var elapsed = Math.max(0, Number(dwellMs) || 0);
    var ts = timestampOf(meta || {});
    return update(tweetId, function (existing) {
      if (!existing) return null;
      return Object.assign({}, existing, {
        maxDwellMs: Math.max(existing.maxDwellMs || 0, elapsed),
        lastDwellAt: Math.max(existing.lastDwellAt || 0, ts),
        lastDwellDecision: meta && meta.decision,
        lastDwellSource: meta && meta.source,
        updatedAt: Math.max(existing.updatedAt || 0, ts),
        liveUpdatedAt: Math.max(existing.liveUpdatedAt || 0, ts)
      });
    }).then(function () { return get(tweetId); });
  }

  function searchWithStatus(text, limit) {
    var query = String(text || '').trim();
    if (!query) return Promise.resolve({ ok: false, records: [], error: 'empty-query' });
    return requestEmbedding(query).then(function (vector) {
      return getAllRaw().then(function (records) {
        return { ok: true, records: LocalSemanticIndex.search(records, vector, limit) };
      });
    }).catch(function (error) {
      return {
        ok: false,
        records: [],
        error: String((error && error.message) || error || 'retrieval-failed')
      };
    });
  }

  function search(text, limit) {
    return searchWithStatus(text, limit).then(function (result) {
      return result.ok ? result.records : [];
    });
  }

  function deleteIds(ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          for (var i = 0; i < ids.length; i++) store.delete(ids[i]);
          tx.oncomplete = function () { resolve(ids.length); };
          tx.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    }).catch(function () { return 0; });
  }

  function pruneRetention(options) {
    options = options || {};
    var now = Number(options.now) || Date.now();
    var maxAgeDays = options.maxAgeDays === undefined ? DEFAULT_MAX_AGE_DAYS : Number(options.maxAgeDays);
    var maxRecords = options.maxRecords === undefined ? DEFAULT_MAX_RECORDS : Math.max(0, Number(options.maxRecords));
    var cutoff = now - maxAgeDays * DAY_MS;

    return getAllRaw().then(function (records) {
      var oldIds = [];
      var retained = [];
      for (var i = 0; i < records.length; i++) {
        var stamp = records[i].lastSeenAt || records[i].updatedAt || 0;
        if (stamp < cutoff) oldIds.push(records[i].tweetId);
        else retained.push(records[i]);
      }
      retained.sort(function (a, b) {
        var diff = (b.lastSeenAt || b.updatedAt || 0) - (a.lastSeenAt || a.updatedAt || 0);
        if (diff) return diff;
        return String(a.tweetId).localeCompare(String(b.tweetId));
      });
      var countIds = retained.slice(maxRecords).map(function (record) { return record.tweetId; });
      return deleteIds(oldIds.concat(countIds)).then(function () {
        return { removedByAge: oldIds.length, removedByCount: countIds.length };
      });
    }).catch(function () { return { removedByAge: 0, removedByCount: 0 }; });
  }

  function clear() {
    return init().then(function (idb) {
      return new Promise(function (resolve) {
        try {
          var tx = idb.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    }).catch(function () {});
  }

  function exportData() {
    return getAll().then(function (claims) {
      return {
        schemaVersion: 1,
        platform: 'x',
        exportedAt: new Date().toISOString(),
        embeddingModel: _embeddingModel,
        embeddingVersion: _embeddingVersion,
        claims: claims
      };
    });
  }

  // Pure historical-log preparation: feed decisions supply claims; read events
  // supply exposure evidence. No Luna fields are read or required.
  function prepareSeedRecords(events) {
    var rows = Array.isArray(events) ? events : [];
    var byId = Object.create(null);
    var dwellById = Object.create(null);

    for (var i = 0; i < rows.length; i++) {
      var event = rows[i] || {};
      if (event.platform && event.platform !== 'x') continue;
      if (!event.tweetId) continue;
      var id = String(event.tweetId);
      if (event.kind === 'read') {
        dwellById[id] = Math.max(dwellById[id] || 0, Number(event.dwellMs) || 0);
        // Historical `source:off-home` reads are only a route proxy. They can
        // establish strong knowledge through dwell, but never claim an exact
        // direct-open event that the old ledger did not record.
        continue;
      }
      if (event.kind || event.surface === 'own-replies') continue;
      if (event.decision !== 'shown' && event.decision !== 'hidden') continue;
      var text = String(event.text || '').trim();
      if (!text) continue;
      var ts = timestampOf(event);
      var current = byId[id];
      if (!current || ts >= current.contentUpdatedAt) {
        byId[id] = {
          tweetId: id,
          text: text,
          textHash: textHash(text),
          author: event.author,
          decision: event.decision,
          prediction: event.prediction,
          confidence: event.confidence,
          source: event.source,
          reason: event.reason,
          model: event.model,
          mediaType: event.mediaType,
          url: event.url,
          firstSeenAt: current ? Math.min(current.firstSeenAt, ts) : ts,
          lastSeenAt: Math.max(current ? current.lastSeenAt : 0, ts),
          contentUpdatedAt: ts,
          updatedAt: ts,
          exposureState: mergeExposure(current && current.exposureState, event.decision === 'shown' ? 'shown' : 'hidden'),
          truncated: event.truncated === true || text.length === 500,
          recordOrigin: 'seed'
        };
      } else {
        current.firstSeenAt = Math.min(current.firstSeenAt, ts);
        current.lastSeenAt = Math.max(current.lastSeenAt, ts);
        current.exposureState = mergeExposure(current.exposureState, event.decision === 'shown' ? 'shown' : 'hidden');
      }
    }

    return Object.keys(byId).map(function (id) {
      var record = byId[id];
      record.maxDwellMs = dwellById[id] || 0;
      return withKnownState(record);
    });
  }

  function importPrepared(record) {
    var seed = Object.assign({}, record);
    delete seed.knownState;
    var sourceAt = seed.updatedAt || seed.lastSeenAt || seed.contentUpdatedAt || 0;
    return update(seed.tweetId, function (existing) {
      if (existing && (existing.updatedAt || 0) >= sourceAt) return null;
      var next = Object.assign({}, existing || {}, seed, {
        firstSeenAt: existing ? Math.min(existing.firstSeenAt || seed.firstSeenAt, seed.firstSeenAt) : seed.firstSeenAt,
        lastSeenAt: Math.max(existing ? (existing.lastSeenAt || 0) : 0, seed.lastSeenAt || 0),
        updatedAt: Math.max(existing ? (existing.updatedAt || 0) : 0, sourceAt),
        exposureState: mergeExposure(existing && existing.exposureState, seed.exposureState),
        maxDwellMs: Math.max(existing ? (existing.maxDwellMs || 0) : 0, seed.maxDwellMs || 0),
        directOpenedAt: Math.max(existing ? (existing.directOpenedAt || 0) : 0, seed.directOpenedAt || 0),
        recordOrigin: existing && existing.recordOrigin === 'live' ? 'live' : 'seed'
      });
      if (existing && existing.contentUpdatedAt > seed.contentUpdatedAt) {
        next.text = existing.text;
        next.textHash = existing.textHash;
        next.contentUpdatedAt = existing.contentUpdatedAt;
        next.author = existing.author;
        next.decision = existing.decision;
        next.prediction = existing.prediction;
        next.confidence = existing.confidence;
        next.source = existing.source;
        next.reason = existing.reason;
        next.model = existing.model;
        next.mediaType = existing.mediaType;
        next.url = existing.url;
        next.truncated = existing.truncated === true;
      }
      if (!existing || existing.textHash !== next.textHash) {
        delete next.embedding;
        delete next.embeddingUpdatedAt;
      }
      return next;
    }).then(function (outcome) {
      var saved = outcome.record || outcome.existing;
      var status = outcome.changed ? (outcome.inserted ? 'inserted' : 'updated') : 'skipped';
      if (!saved) return { status: status };
      var needsEmbedding = !saved.embedding || saved.embeddingModel !== _embeddingModel ||
        saved.embeddingVersion !== _embeddingVersion;
      if (!needsEmbedding) return { status: status, record: withKnownState(saved) };
      return embedAndAttach(saved.tweetId, saved.text, saved.textHash).then(function (embedded) {
        return { status: status, record: embedded };
      });
    });
  }

  function importSeed(events) {
    var prepared = prepareSeedRecords(events);
    var result = {
      prepared: prepared.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      embedded: 0,
      pending: 0,
      failed: 0
    };
    var chain = Promise.resolve();
    prepared.forEach(function (record) {
      chain = chain.then(function () {
        return importPrepared(record).then(function (outcome) {
          result[outcome.status]++;
          if (outcome.record && outcome.record.embedding) result.embedded++;
          else if (outcome.record) {
            result.pending++;
            if (outcome.record.embeddingError) result.failed++;
          }
        });
      });
    });
    return chain.then(function () { return result; });
  }

  function retryPendingEmbeddings(limit) {
    var cap = limit === undefined ? 25 : Math.max(0, Number(limit) || 0);
    return getAllRaw().then(function (records) {
      var pending = records.filter(function (record) { return record.text && !record.embedding; }).slice(0, cap);
      var chain = Promise.resolve();
      pending.forEach(function (record) {
        chain = chain.then(function () { return embedAndAttach(record.tweetId, record.text, record.textHash); });
      });
      return chain.then(function () { return pending.length; });
    });
  }

  return {
    DEFAULT_DB_NAME: DEFAULT_DB_NAME,
    DEFAULT_EMBEDDING_MODEL: DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_VERSION: DEFAULT_EMBEDDING_VERSION,
    configure: configure,
    init: init,
    deriveKnownState: LocalSemanticIndex.knownState,
    prepareSeedRecords: prepareSeedRecords,
    recordFeedDecision: recordFeedDecision,
    recordDirectOpen: recordDirectOpen,
    recordReadDwell: recordReadDwell,
    retryPendingEmbeddings: retryPendingEmbeddings,
    search: search,
    searchWithStatus: searchWithStatus,
    get: get,
    getAll: getAll,
    count: count,
    pruneRetention: pruneRetention,
    clear: clear,
    exportData: exportData,
    importSeed: importSeed
  };
})();
