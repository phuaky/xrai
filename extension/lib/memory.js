/* xrai — Content Memory (IndexedDB fingerprint store) */
const XraiMemory = (function () {
  'use strict';

  const DB_NAME = 'xrai_memory';
  const DB_VERSION = 1;
  const STORE_NAME = 'fingerprints';
  let db = null;

  // djb2 hash
  function djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  function init() {
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var store = e.target.result.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
        store.createIndex('last_seen', 'last_seen', { unique: false });
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

  function getStats() {
    return new Promise(function (resolve) {
      if (!db) { resolve({ total: 0, signal: 0, noise: 0 }); return; }
      var tx = db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var stats = { total: 0, signal: 0, noise: 0 };
      var cursor = store.openCursor();
      cursor.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          stats.total++;
          if (c.value.classification === 'signal') stats.signal++;
          else if (c.value.classification === 'noise') stats.noise++;
          c.continue();
        } else {
          resolve(stats);
        }
      };
      cursor.onerror = function () { resolve(stats); };
    });
  }

  function clearAll() {
    return new Promise(function (resolve) {
      if (!db) { resolve(); return; }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  // === Classification log (for training/improving prompts) ===
  // Stores every classification decision with full context
  var CLASSIFICATIONS_KEY = 'xrai_classifications';
  var MAX_CLASSIFICATIONS = 1000;
  var COLLECTOR_URL = 'http://localhost:11435';
  var FLUSH_EVERY = 100; // auto-send to collector every N entries

  function logClassification(tweetText, mediaType, prediction, confidence, source) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CLASSIFICATIONS_KEY, function (result) {
        var log = result[CLASSIFICATIONS_KEY] || [];
        log.push({
          text: (tweetText || '').substring(0, 300),
          mediaType: mediaType || 'text',
          prediction: prediction,
          confidence: confidence || 0,
          source: source || 'unknown',
          timestamp: Date.now()
        });
        // Auto-flush to local collector every FLUSH_EVERY entries
        if (log.length >= FLUSH_EVERY) {
          flushToCollector(log);
          log = []; // clear after sending
        }
        if (log.length > MAX_CLASSIFICATIONS) log = log.slice(-MAX_CLASSIFICATIONS);
        var obj = {};
        obj[CLASSIFICATIONS_KEY] = log;
        chrome.storage.local.set(obj, function () { resolve(); });
      });
    });
  }

  function flushToCollector(entries) {
    // Fire and forget — don't block if collector isn't running
    try {
      fetch(COLLECTOR_URL + '/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entries)
      }).catch(function () { /* collector not running, that's fine */ });
    } catch (e) { /* ignore */ }
  }

  function getClassifications() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CLASSIFICATIONS_KEY, function (result) {
        resolve(result[CLASSIFICATIONS_KEY] || []);
      });
    });
  }

  function exportAll() {
    // Export both classifications and corrections as JSON for improve script
    return Promise.all([getClassifications(), getCorrections()]).then(function (results) {
      return JSON.stringify({ classifications: results[0], corrections: results[1] }, null, 2);
    });
  }

  // === Correction tracking (for meta-learning) ===
  // Stored in chrome.storage.local so the improve script can read via export

  var CORRECTIONS_KEY = 'xrai_corrections';

  function saveCorrection(tweetText, mediaType, aiPrediction, userCorrection) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CORRECTIONS_KEY, function (result) {
        var corrections = result[CORRECTIONS_KEY] || [];
        corrections.push({
          text: (tweetText || '').substring(0, 300),
          mediaType: mediaType || 'text',
          aiPrediction: aiPrediction,
          userCorrection: userCorrection,
          timestamp: Date.now()
        });
        // Keep last 500 corrections
        if (corrections.length > 500) corrections = corrections.slice(-500);
        var obj = {};
        obj[CORRECTIONS_KEY] = corrections;
        chrome.storage.local.set(obj, function () { resolve(); });
      });
    });
  }

  function getCorrections() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CORRECTIONS_KEY, function (result) {
        resolve(result[CORRECTIONS_KEY] || []);
      });
    });
  }

  function getCorrectionCount() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(CORRECTIONS_KEY, function (result) {
        resolve((result[CORRECTIONS_KEY] || []).length);
      });
    });
  }

  function clearCorrections() {
    return new Promise(function (resolve) {
      var obj = {};
      obj[CORRECTIONS_KEY] = [];
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  function exportCorrections() {
    // Returns corrections as JSON string for the improve script
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
    exportCorrections: exportCorrections
  };
})();
