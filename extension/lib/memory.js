/* rai — Content Memory (IndexedDB fingerprint store + stats/time/log, per-platform) */
const RaiMemory = (function () {
  'use strict';

  // Storage namespace — set via init(platform). 'xrai' for X (legacy-compatible),
  // 'ytrai' for YouTube. All keys + the IndexedDB name derive from this prefix.
  var PREFIX = { x: 'xrai', youtube: 'ytrai' };
  var _prefix = 'xrai';

  var DB_VERSION = 2;
  const STORE_NAME = 'fingerprints';
  const EVENTS_STORE = 'events';   // durable, append-only classification log (never auto-dropped)
  const EVENTS_CAP = 200000;       // prune oldest beyond this (~tens of MB)
  let db = null;
  let _evWrites = 0;

  function dbName() { return _prefix + '_memory'; }
  function statsKey() { return _prefix + '_stats_totals'; }
  function timeKey() { return _prefix + '_daily_time'; }
  function classificationsKey() { return _prefix + '_classifications'; }
  function correctionsKey() { return _prefix + '_corrections'; }

  // djb2 hash
  function djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  function init(platform) {
    if (platform && PREFIX[platform]) _prefix = PREFIX[platform];
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }
      var req = indexedDB.open(dbName(), DB_VERSION);
      req.onupgradeneeded = function (e) {
        var idb = e.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          var store = idb.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
          store.createIndex('last_seen', 'last_seen', { unique: false });
        }
        if (!idb.objectStoreNames.contains(EVENTS_STORE)) {
          var ev = idb.createObjectStore(EVENTS_STORE, { keyPath: 'id', autoIncrement: true });
          ev.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = function (e) {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  function computeFingerprint(text, mediaType) {
    var normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return djb2(normalized + '|' + (mediaType || 'text'));
  }

  function hasSeen(fingerprint) {
    return new Promise(function (resolve) {
      if (!db) { resolve(false); return; }
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).get(fingerprint);
      req.onsuccess = function () { resolve(!!req.result); };
      req.onerror = function () { resolve(false); };
    });
  }

  function markSeen(fingerprint, classification) {
    return new Promise(function (resolve) {
      if (!db) { resolve(); return; }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.get(fingerprint);
      req.onsuccess = function () {
        var now = Date.now();
        var entry = req.result;
        if (entry) {
          entry.last_seen = now;
          entry.view_count += 1;
          if (classification) entry.classification = classification;
          store.put(entry);
        } else {
          store.put({
            fingerprint: fingerprint,
            first_seen: now,
            last_seen: now,
            classification: classification || 'unknown',
            view_count: 1
          });
        }
        resolve();
      };
      req.onerror = function () { resolve(); };
    });
  }

  function pruneOld(days) {
    days = days || 30;
    return new Promise(function (resolve) {
      if (!db) { resolve(0); return; }
      var cutoff = Date.now() - days * 86400000;
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var idx = store.index('last_seen');
      var range = IDBKeyRange.upperBound(cutoff);
      var count = 0;
      var cursor = idx.openCursor(range);
      cursor.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          c.delete();
          count++;
          c.continue();
        } else {
          resolve(count);
        }
      };
      cursor.onerror = function () { resolve(count); };
    });
  }

  // === Durable classification event log (IndexedDB, append-only) ===
  // The source of truth for "everything we read". Never auto-dropped on flush —
  // survives with or without the collector running, exportable on demand.

  function logEvent(record) {
    return new Promise(function (resolve) {
      if (!db || !record) { resolve(); return; }
      try {
        record.ts = record.ts || Date.now();
        var tx = db.transaction(EVENTS_STORE, 'readwrite');
        tx.objectStore(EVENTS_STORE).add(record);
        tx.oncomplete = function () {
          resolve();
          if ((++_evWrites % 1000) === 0) pruneEvents(EVENTS_CAP);
        };
        tx.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }

  function getEvents() {
    return new Promise(function (resolve) {
      if (!db) { resolve([]); return; }
      try {
        var tx = db.transaction(EVENTS_STORE, 'readonly');
        var req = tx.objectStore(EVENTS_STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  }

  function countEvents() {
    return new Promise(function (resolve) {
      if (!db) { resolve(0); return; }
      try {
        var tx = db.transaction(EVENTS_STORE, 'readonly');
        var req = tx.objectStore(EVENTS_STORE).count();
        req.onsuccess = function () { resolve(req.result || 0); };
        req.onerror = function () { resolve(0); };
      } catch (e) { resolve(0); }
    });
  }

  function clearEvents() {
    return new Promise(function (resolve) {
      if (!db) { resolve(); return; }
      try {
        var tx = db.transaction(EVENTS_STORE, 'readwrite');
        tx.objectStore(EVENTS_STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }

  // Keep only the most recent `keepN` events (delete oldest by ts).
  function pruneEvents(keepN) {
    return new Promise(function (resolve) {
      if (!db) { resolve(0); return; }
      countEvents().then(function (total) {
        var toDelete = total - keepN;
        if (toDelete <= 0) { resolve(0); return; }
        try {
          var tx = db.transaction(EVENTS_STORE, 'readwrite');
          var idx = tx.objectStore(EVENTS_STORE).index('ts');
          var cursor = idx.openCursor();
          var n = 0;
          cursor.onsuccess = function (e) {
            var c = e.target.result;
            if (c && n < toDelete) { c.delete(); n++; c.continue(); }
            else { resolve(n); }
          };
          cursor.onerror = function () { resolve(n); };
        } catch (e) { resolve(0); }
      });
    });
  }

  // In-memory stats accumulator — avoids async read-modify-write races.
  // Generic kept/hidden counters: for X, kept=signal hidden=noise; for
  // YouTube, kept=music/motivational hidden=everything blurred.
  var _memStats = null;
  var _statsFlushTimer = null;
  var STATS_FLUSH_INTERVAL = 10000;

  function _ensureStatsLoaded() {
    return new Promise(function (resolve) {
      if (_memStats) { resolve(); return; }
      chrome.storage.local.get(statsKey(), function (result) {
        if (!_memStats) {
          _memStats = result[statsKey()] || { total: 0, kept: 0, hidden: 0 };
          // Back-compat: migrate old {signal,noise} shape into {kept,hidden}
          if (_memStats.signal !== undefined && _memStats.kept === undefined) {
            _memStats.kept = _memStats.signal;
            _memStats.hidden = _memStats.noise || 0;
          }
        }
        resolve();
      });
    });
  }

  function _flushStats() {
    if (!_memStats) return;
    var obj = {};
    obj[statsKey()] = { total: _memStats.total, kept: _memStats.kept, hidden: _memStats.hidden };
    chrome.storage.local.set(obj);
  }

  function _startStatsFlush() {
    if (_statsFlushTimer) return;
    _statsFlushTimer = setInterval(_flushStats, STATS_FLUSH_INTERVAL);
  }

  function getStats() {
    return _ensureStatsLoaded().then(function () {
      return { total: _memStats.total, kept: _memStats.kept, hidden: _memStats.hidden };
    });
  }

  // outcome: 'kept' (shown) or 'hidden' (filtered/blurred)
  function incrementStats(outcome) {
    return _ensureStatsLoaded().then(function () {
      _memStats.total++;
      if (outcome === 'kept') _memStats.kept++;
      else if (outcome === 'hidden') _memStats.hidden++;
      _startStatsFlush();
      return { total: _memStats.total, kept: _memStats.kept, hidden: _memStats.hidden };
    });
  }

  // === Daily time tracking ===
  var _timeInterval = null;
  var _memTime = null; // { date, seconds }
  var _lastTickTime = 0;

  function _todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _ensureTimeLoaded() {
    return new Promise(function (resolve) {
      if (_memTime) { resolve(); return; }
      chrome.storage.local.get(timeKey(), function (result) {
        if (!_memTime) {
          var data = result[timeKey()] || {};
          var today = _todayStr();
          _memTime = (data.date === today)
            ? { date: today, seconds: data.seconds || 0 }
            : { date: today, seconds: 0 };
        }
        resolve();
      });
    });
  }

  function startSession() {
    if (_timeInterval) return;
    _lastTickTime = Date.now();

    _ensureTimeLoaded().then(function () {
      _timeInterval = setInterval(function () {
        if (!document.hidden) {
          var now = Date.now();
          var elapsed = Math.round((now - _lastTickTime) / 1000);
          _lastTickTime = now;
          _saveTimeIncrement(elapsed);
        } else {
          _lastTickTime = Date.now();
        }
      }, 30000);
    });

    window.addEventListener('beforeunload', function () {
      if (_timeInterval) {
        clearInterval(_timeInterval);
        _timeInterval = null;
      }
      if (_lastTickTime && !document.hidden) {
        var elapsed = Math.round((Date.now() - _lastTickTime) / 1000);
        if (elapsed > 0) _saveTimeIncrement(elapsed);
      }
      _flushStats();
    });
  }

  function _saveTimeIncrement(seconds) {
    if (!_memTime) return;
    var today = _todayStr();
    if (_memTime.date !== today) {
      _memTime = { date: today, seconds: 0 };
    }
    _memTime.seconds += seconds;
    var obj = {};
    obj[timeKey()] = { date: _memTime.date, seconds: _memTime.seconds };
    chrome.storage.local.set(obj);
  }

  function getDailyTime() {
    if (_memTime) {
      var today = _todayStr();
      return Promise.resolve(_memTime.date === today ? _memTime.seconds : 0);
    }
    return new Promise(function (resolve) {
      chrome.storage.local.get(timeKey(), function (result) {
        var data = result[timeKey()] || {};
        resolve(data.date !== _todayStr() ? 0 : (data.seconds || 0));
      });
    });
  }

  function clearAll() {
    return new Promise(function (resolve) {
      chrome.storage.local.remove([statsKey(), timeKey()]);
      _memStats = { total: 0, kept: 0, hidden: 0 };
      _memTime = { date: _todayStr(), seconds: 0 };
      if (!db) { resolve(); return; }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  // === Classification log (for training/improving prompts) ===
  var MAX_CLASSIFICATIONS = 1000;
  var COLLECTOR_URL = 'http://localhost:11435';
  var FLUSH_EVERY = 100;

  function logClassification(text, mediaType, prediction, confidence, source) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(classificationsKey(), function (result) {
        var log = result[classificationsKey()] || [];
        log.push({
          text: (text || '').substring(0, 300),
          mediaType: mediaType || 'text',
          prediction: prediction,
          confidence: confidence || 0,
          source: source || 'unknown',
          timestamp: Date.now()
        });
        if (log.length >= FLUSH_EVERY) {
          flushToCollector(log);
          log = [];
        }
        if (log.length > MAX_CLASSIFICATIONS) log = log.slice(-MAX_CLASSIFICATIONS);
        var obj = {};
        obj[classificationsKey()] = log;
        chrome.storage.local.set(obj, function () { resolve(); });
      });
    });
  }

  function flushToCollector(entries) {
    try {
      fetch(COLLECTOR_URL + '/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: _prefix, entries: entries })
      }).catch(function () { /* collector not running, that's fine */ });
    } catch (e) { /* ignore */ }
  }

  // === Attention-ledger mirror — best-effort disk copy of read/watch events ===
  // IndexedDB (logEvent) stays the source of truth; this buffers records and
  // POSTs them to the collector's /events endpoint so digest.js can read them
  // from data/events-<platform>.jsonl. Collector down = events only in IDB
  // (same contract as tips; reconnect backfill is a known v2 gap).
  var _mirrorBuf = [];
  var MIRROR_FLUSH_AT = 20;

  function mirrorEvent(record) {
    _mirrorBuf.push(record);
    if (_mirrorBuf.length >= MIRROR_FLUSH_AT) flushMirror();
  }

  function flushMirror() {
    if (!_mirrorBuf.length) return;
    var entries = _mirrorBuf;
    _mirrorBuf = [];
    try {
      fetch(COLLECTOR_URL + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: _prefix, entries: entries })
      }).catch(function () { /* collector not running, that's fine */ });
    } catch (e) { /* ignore */ }
  }

  function getClassifications() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(classificationsKey(), function (result) {
        resolve(result[classificationsKey()] || []);
      });
    });
  }

  function exportAll() {
    return Promise.all([getClassifications(), getCorrections()]).then(function (results) {
      return JSON.stringify({ classifications: results[0], corrections: results[1] }, null, 2);
    });
  }

  function saveCorrection(text, mediaType, aiPrediction, userCorrection) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(correctionsKey(), function (result) {
        var corrections = result[correctionsKey()] || [];
        corrections.push({
          text: (text || '').substring(0, 300),
          mediaType: mediaType || 'text',
          aiPrediction: aiPrediction,
          userCorrection: userCorrection,
          timestamp: Date.now()
        });
        if (corrections.length > 500) corrections = corrections.slice(-500);
        var obj = {};
        obj[correctionsKey()] = corrections;
        chrome.storage.local.set(obj, function () { resolve(); });
      });
    });
  }

  function getCorrections() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(correctionsKey(), function (result) {
        resolve(result[correctionsKey()] || []);
      });
    });
  }

  function getCorrectionCount() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(correctionsKey(), function (result) {
        resolve((result[correctionsKey()] || []).length);
      });
    });
  }

  function clearCorrections() {
    return new Promise(function (resolve) {
      var obj = {};
      obj[correctionsKey()] = [];
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  function exportCorrections() {
    return getCorrections().then(function (corrections) {
      return JSON.stringify(corrections, null, 2);
    });
  }

  return {
    init: init,
    computeFingerprint: computeFingerprint,
    hasSeen: hasSeen,
    markSeen: markSeen,
    pruneOld: pruneOld,
    getStats: getStats,
    clearAll: clearAll,
    logClassification: logClassification,
    getClassifications: getClassifications,
    exportAll: exportAll,
    saveCorrection: saveCorrection,
    getCorrections: getCorrections,
    getCorrectionCount: getCorrectionCount,
    clearCorrections: clearCorrections,
    exportCorrections: exportCorrections,
    incrementStats: incrementStats,
    startSession: startSession,
    getDailyTime: getDailyTime,
    logEvent: logEvent,
    mirrorEvent: mirrorEvent,
    flushMirror: flushMirror,
    getEvents: getEvents,
    countEvents: countEvents,
    clearEvents: clearEvents,
    pruneEvents: pruneEvents
  };
})();
