/* rai — Content Memory (IndexedDB fingerprint store + stats/time/log, per-platform).
   Stats + daily time are worker-owned: tabs send deltas ({action:'statsDelta'|'timeDelta'}),
   the worker serializes the read-modify-write, and pills converge via storage.onChanged. */
const RaiMemory = (function () {
  'use strict';

  // Storage namespace — set via init(platform). 'xrai' for X (legacy-compatible),
  // 'ytrai' for YouTube. All keys + the IndexedDB name derive from this prefix.
  var PREFIX = { x: 'xrai', youtube: 'ytrai' };
  var _prefix = 'xrai';
  var _platformName = 'x'; // worker-facing platform id (delta messages route on this)

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

  // djb2 hash
  function djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  function init(platform) {
    if (platform && PREFIX[platform]) {
      _prefix = PREFIX[platform];
      _platformName = platform;
    }
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

  // Stats totals are owned by the service worker: every decision sends a
  // delta message and the worker applies it through one serialized
  // read-modify-write chain. Tabs used to keep their own copy of the totals
  // and blind-overwrite the shared key every 10s — with two tabs open that
  // was a lost-update race (last writer wins), and a stale background tab's
  // unload flush could erase everything counted since it opened.
  // Generic kept/hidden counters: for X, kept=signal hidden=noise; for
  // YouTube, kept=music/motivational hidden=everything blurred.
  var _statsFailQueue = null; // deltas the worker never acked, re-merged into the next send

  function _requeueStatsDelta(delta) {
    if (!_statsFailQueue) _statsFailQueue = { total: 0, kept: 0, hidden: 0 };
    _statsFailQueue.total += delta.total;
    _statsFailQueue.kept += delta.kept;
    _statsFailQueue.hidden += delta.hidden;
  }

  // chrome.storage access that survives extension reloads: a tab opened
  // before the reload keeps its old content script, and every chrome.* call
  // in it throws "Extension context invalidated". Orphaned tabs must fail
  // soft (zeros / no-ops), not spray uncaught errors onto the extension card.
  function storageGet(keys, cb) {
    try {
      chrome.storage.local.get(keys, cb);
    } catch (e) {
      cb({});
    }
  }

  function storageSet(obj, cb) {
    try {
      chrome.storage.local.set(obj, function () { if (cb) cb(); });
    } catch (e) {
      if (cb) cb();
    }
  }

  function _readStoredStats(cb) {
    storageGet(statsKey(), function (result) {
      var s = (result && result[statsKey()]) || { total: 0, kept: 0, hidden: 0 };
      // Back-compat: pre-rename installs stored {signal,noise}
      if (s.signal !== undefined && s.kept === undefined) {
        s.kept = s.signal;
        s.hidden = s.noise || 0;
      }
      cb(s);
    });
  }

  function getStats() {
    return new Promise(function (resolve) {
      _readStoredStats(function (s) {
        var q = _statsFailQueue;
        // Daily slice — worker resets it on date rollover; a stale stored date
        // means nothing counted yet today. Unacked deltas are all "today" by
        // definition, so the fail-queue merges into both views.
        var t = (s.today && s.today.date === _todayStr()) ? s.today : { total: 0, kept: 0, hidden: 0 };
        resolve({
          total: (s.total || 0) + (q ? q.total : 0),
          kept: (s.kept || 0) + (q ? q.kept : 0),
          hidden: (s.hidden || 0) + (q ? q.hidden : 0),
          today: {
            date: _todayStr(),
            total: (t.total || 0) + (q ? q.total : 0),
            kept: (t.kept || 0) + (q ? q.kept : 0),
            hidden: (t.hidden || 0) + (q ? q.hidden : 0)
          }
        });
      });
    });
  }

  // outcome: 'kept' (shown) or 'hidden' (filtered/blurred)
  function incrementStats(outcome) {
    var delta = {
      total: 1,
      kept: outcome === 'kept' ? 1 : 0,
      hidden: outcome === 'hidden' ? 1 : 0
    };
    if (_statsFailQueue) {
      delta.total += _statsFailQueue.total;
      delta.kept += _statsFailQueue.kept;
      delta.hidden += _statsFailQueue.hidden;
      _statsFailQueue = null;
    }
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { action: 'statsDelta', platform: _platformName, delta: delta },
          function (resp) {
            if (chrome.runtime.lastError || !resp || !resp.ok) _requeueStatsDelta(delta);
            resolve();
          }
        );
      } catch (e) {
        // Extension context invalidated (reload mid-session) — hold the delta
        // in case a later send works; lost with the page otherwise.
        _requeueStatsDelta(delta);
        resolve();
      }
    });
  }

  // Cross-tab convergence: the worker's writes land here in every tab, so
  // each pill re-renders from the shared totals no matter which tab counted.
  var _statsListeners = [];

  function onStatsChanged(cb) {
    _statsListeners.push(cb);
    if (_statsListeners.length > 1) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[statsKey()]) return;
      var v = changes[statsKey()].newValue || { total: 0, kept: 0, hidden: 0 };
      for (var i = 0; i < _statsListeners.length; i++) {
        try { _statsListeners[i](v); } catch (e) { /* listener error, keep going */ }
      }
    });
  }

  // === Daily time tracking ===
  // Same delta contract as stats: ticks send elapsed seconds to the worker,
  // which accumulates per day. A dropped tick loses ≤30s — acceptable — so
  // there is no retry queue here.
  var _timeInterval = null;
  var _mirrorTimer = null;
  var _lastTickTime = 0;

  function _todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _sendTimeDelta(seconds) {
    try {
      chrome.runtime.sendMessage(
        { action: 'timeDelta', platform: _platformName, seconds: seconds, date: _todayStr() },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) { /* extension context invalidated */ }
  }

  function startSession() {
    if (_timeInterval) return;
    _lastTickTime = Date.now();

    _timeInterval = setInterval(function () {
      var now = Date.now();
      if (!document.hidden) {
        var elapsed = Math.round((now - _lastTickTime) / 1000);
        if (elapsed > 0) _sendTimeDelta(elapsed);
      }
      _lastTickTime = now;
    }, 30000);

    // Mirror buffer drains on size (MIRROR_FLUSH_AT); this timer bounds the
    // wait so a slow session still tails live into the collector.
    _mirrorTimer = setInterval(flushMirror, 10000);

    window.addEventListener('beforeunload', function () {
      if (_timeInterval) {
        clearInterval(_timeInterval);
        _timeInterval = null;
      }
      if (_mirrorTimer) {
        clearInterval(_mirrorTimer);
        _mirrorTimer = null;
      }
      if (_lastTickTime && !document.hidden) {
        var elapsed = Math.round((Date.now() - _lastTickTime) / 1000);
        if (elapsed > 0) _sendTimeDelta(elapsed);
      }
      // Last chance for deltas the worker never acked (it processes messages
      // even after the sending page is gone).
      if (_statsFailQueue) {
        var q = _statsFailQueue;
        _statsFailQueue = null;
        try {
          chrome.runtime.sendMessage({ action: 'statsDelta', platform: _platformName, delta: q });
        } catch (e) { /* extension context invalidated */ }
      }
      flushMirror();
    });
  }

  function getDailyTime() {
    return new Promise(function (resolve) {
      storageGet(timeKey(), function (result) {
        var data = result[timeKey()] || {};
        resolve(data.date === _todayStr() ? (data.seconds || 0) : 0);
      });
    });
  }

  function clearAll() {
    // Key removal fires storage.onChanged, so every open tab's pill zeroes too.
    // Append-only source events are deliberately preserved; only fingerprints
    // and the derived knowledge/index stores are user-clearable memory.
    try {
      chrome.storage.local.remove([statsKey(), timeKey()]);
    } catch (e) { /* orphaned tab (extension reloaded) — nothing to clear from here */ }
    _statsFailQueue = null;

    var fingerprints = new Promise(function (resolve) {
      if (!db) { resolve(); return; }
      try {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });

    return fingerprints.then(function () {
      if (_platformName !== 'x' || typeof RaiKnowledge === 'undefined' || !RaiKnowledge.clear) return;
      try { return Promise.resolve(RaiKnowledge.clear()).catch(function () {}); }
      catch (e) { /* derived knowledge clear is fail-soft */ }
    });
  }

  // === Classification log (for training/improving prompts) ===
  var MAX_CLASSIFICATIONS = 1000;
  var COLLECTOR_URL = 'http://localhost:11435';
  var FLUSH_EVERY = 100;

  function logClassification(text, mediaType, prediction, confidence, source) {
    return new Promise(function (resolve) {
      storageGet(classificationsKey(), function (result) {
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
        storageSet(obj, function () { resolve(); });
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
    if (!record) return;
    record.ts = record.ts || Date.now(); // collector dedupes on ts; don't rely on logEvent having stamped it
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
        body: JSON.stringify({ platform: _prefix, entries: entries }),
        // keepalive lets the beforeunload flush survive the tab closing
        // (bodies stay well under the 64KB keepalive cap at 20 entries)
        keepalive: true
      }).catch(function () { /* collector not running, that's fine */ });
    } catch (e) { /* ignore */ }
  }

  function getClassifications() {
    return new Promise(function (resolve) {
      storageGet(classificationsKey(), function (result) {
        resolve(result[classificationsKey()] || []);
      });
    });
  }

  function exportAll() {
    return getClassifications().then(function (classifications) {
      return JSON.stringify({ classifications: classifications }, null, 2);
    });
  }

  return {
    init: init,
    computeFingerprint: computeFingerprint,
    hasSeen: hasSeen,
    markSeen: markSeen,
    pruneOld: pruneOld,
    getStats: getStats,
    onStatsChanged: onStatsChanged,
    clearAll: clearAll,
    logClassification: logClassification,
    getClassifications: getClassifications,
    exportAll: exportAll,
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
