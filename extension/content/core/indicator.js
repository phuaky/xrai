/* rai — Status Indicator (floating pill + settings popup, platform-aware) */
var RaiIndicator = (function () {
  'use strict';

  var pill = null;
  var countsEl = null;
  var statusEl = null;
  var extraEl = null;
  var dotEl = null;
  var gearEl = null;
  var popup = null;
  var counts = { kept: 0, hidden: 0 };
  var status = { connected: false, classify: false, label: 'offline' };
  var popupOpen = false;

  var _platform = 'x';
  var _mode = 'local';
  var L = { name: 'rai', keptWord: 'kept', hiddenWord: 'hidden', siteWord: 'this site' };

  function init(platform, labels) {
    if (platform) _platform = platform;
    if (labels) L = Object.assign({}, L, labels);
    if (pill) return;

    if (typeof RaiConfig !== 'undefined' && RaiConfig.getConfig) {
      RaiConfig.getConfig(_platform).then(function (cfg) {
        _mode = cfg.mode === 'cloud' ? 'cloud' : 'local';
        render();
      });
    }

    pill = document.createElement('div');
    pill.id = 'xrai-pill';

    countsEl = document.createElement('span');
    countsEl.className = 'xrai-pill-text';

    dotEl = document.createElement('span');
    dotEl.className = 'xrai-dot xrai-dot-red';

    statusEl = document.createElement('span');
    statusEl.className = 'xrai-pill-status';

    extraEl = document.createElement('span');
    extraEl.className = 'xrai-pill-extra';

    gearEl = document.createElement('span');
    gearEl.className = 'xrai-pill-gear';
    gearEl.textContent = '⚙';
    gearEl.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePopup();
    });

    pill.appendChild(countsEl);
    pill.appendChild(document.createTextNode(' '));
    pill.appendChild(dotEl);
    pill.appendChild(statusEl);
    pill.appendChild(extraEl);
    pill.appendChild(document.createTextNode(' '));
    pill.appendChild(gearEl);

    document.body.appendChild(pill);

    if (typeof RaiMemory !== 'undefined' && RaiMemory.getStats) {
      RaiMemory.getStats().then(function (stats) {
        if (!stats) return;
        counts.kept = stats.kept || 0;
        counts.hidden = stats.hidden || 0;
        render();
      });
    }

    render();
  }

  function render() {
    if (!pill) return;
    countsEl.textContent = L.name + ': ' + counts.kept + ' ' + L.keptWord + ' | ' + counts.hidden + ' ' + L.hiddenWord;

    var dotClass = 'xrai-dot xrai-dot-red';
    if (status.connected && status.classify) dotClass = 'xrai-dot xrai-dot-green';
    else if (status.connected) dotClass = 'xrai-dot xrai-dot-orange';
    dotEl.className = dotClass;
    dotEl.title = 'server: ' + (status.connected ? '✓' : '✗') +
      ' classify: ' + (status.classify ? '✓' : '✗');

    var statusText = '';
    if (_mode === 'cloud') {
      if (!status.connected) statusText = 'cloud offline';
      else if (!status.classify) statusText = 'cloud up · classify ✗';
      else statusText = 'cloud';
    } else {
      if (!status.connected) statusText = 'ollama offline';
      else if (!status.classify) statusText = 'ollama up · classify ✗ (CORS?)';
      else statusText = 'local';
    }
    statusEl.textContent = statusText;
  }

  function update(newCounts, newStatus) {
    if (newCounts) {
      if (typeof newCounts.kept === 'number') counts.kept = newCounts.kept;
      if (typeof newCounts.hidden === 'number') counts.hidden = newCounts.hidden;
    }
    if (newStatus) {
      status.connected = newStatus.connected !== undefined ? newStatus.connected : status.connected;
      status.classify = newStatus.classify !== undefined ? newStatus.classify : status.classify;
      status.label = newStatus.label || status.label;
    }
    render();
  }

  function incrementKept() { counts.kept++; render(); }
  function incrementHidden() { counts.hidden++; render(); }

  // Optional trailing segment on the pill (used by the YouTube Shorts tracker).
  function setExtra(text) {
    if (!extraEl) return;
    extraEl.textContent = text ? ' · ' + text : '';
  }

  function togglePopup() {
    if (popupOpen) { closePopup(); return; }
    popupOpen = true;

    popup = document.createElement('div');
    popup.id = 'xrai-settings';
    popup.innerHTML = '<div class="xrai-settings-loading">Loading...</div>';
    document.body.appendChild(popup);

    setTimeout(function () {
      document.addEventListener('click', outsideClickHandler);
    }, 100);

    RaiConfig.getConfig(_platform).then(function (cfg) {
      renderSettings(cfg);
    });
  }

  function outsideClickHandler(e) {
    if (popup && !popup.contains(e.target) && !pill.contains(e.target)) {
      closePopup();
    }
  }

  function closePopup() {
    if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
    popup = null;
    popupOpen = false;
    document.removeEventListener('click', outsideClickHandler);
  }

  function renderSettings(cfg) {
    if (!popup) return;

    // Platform-specific control row
    var extraControl = '';
    if (_platform === 'x') {
      extraControl =
        '<label>Content<select id="xrai-s-filter">' +
        '<option value="posts-only"' + (cfg.contentFilter === 'posts-only' ? ' selected' : '') + '>Posts only</option>' +
        '<option value="all"' + (cfg.contentFilter === 'all' ? ' selected' : '') + '>All</option>' +
        '</select></label>';
    } else if (_platform === 'youtube') {
      extraControl =
        '<label>Keep motivational<input type="checkbox" id="xrai-s-motivational"' +
        (cfg.keepMotivational ? ' checked' : '') + '></label>' +
        '<div class="xrai-settings-sub">Shorts doom-scroll</div>' +
        '<label>Snap-out nudge<input type="checkbox" id="xrai-s-shorts-nudge"' +
        (cfg.shortsNudge !== false ? ' checked' : '') + '></label>' +
        '<label>Nudge after (Shorts)<input type="number" id="xrai-s-shorts-count" min="1" max="200" value="' + (cfg.shortsLimitCount || 10) + '"></label>' +
        '<label>…or minutes<input type="number" id="xrai-s-shorts-min" min="1" max="120" value="' + (cfg.shortsLimitMinutes || 5) + '"></label>';
    }

    var aggressivenessLabel = _platform === 'youtube' ? 'Strictness' : 'Aggressiveness';
    var cloudMode = cfg.mode === 'cloud';

    var cloudControl =
      '<label>Mode<select id="xrai-s-mode">' +
      '<option value="local"' + (!cloudMode ? ' selected' : '') + '>Local (free, needs Ollama)</option>' +
      '<option value="cloud"' + (cloudMode ? ' selected' : '') + '>Cloud (free beta, no setup)</option>' +
      '</select></label>' +
      '<div id="xrai-s-cloud-fields" style="display:' + (cloudMode ? 'block' : 'none') + '">' +
      '<label>API key<input type="password" id="xrai-s-cloud-key" placeholder="rai_live_..." value="' + (cfg.cloudApiKey || '') + '"></label>' +
      '<div class="xrai-settings-actions"><button type="button" id="xrai-s-free-key"' +
      (cfg.cloudApiKey ? ' style="display:none"' : '') + '>Get a free key</button></div>' +
      '<div class="xrai-settings-sub" id="xrai-s-cloud-balance">' +
      (cloudMode ? 'Checking balance…' : '') +
      '</div>' +
      '<div class="xrai-settings-sub"><a href="https://snratio.xyz/privacy.html" target="_blank" rel="noopener">What cloud mode sends</a></div>' +
      '</div>';

    popup.innerHTML =
      '<div class="xrai-settings-title">' + L.name + ' settings</div>' +
      cloudControl +
      '<label>Model<select id="xrai-s-model"><option value="">Loading models...</option></select></label>' +
      '<label>' + aggressivenessLabel + '<input type="range" id="xrai-s-threshold" min="0.5" max="0.9" step="0.05" value="' + cfg.confidenceThreshold + '"><span id="xrai-s-threshold-val">' + cfg.confidenceThreshold + '</span></label>' +
      extraControl +
      '<label>Image bait check<input type="checkbox" id="xrai-s-image-bait"' +
      (cfg.imageBaitEnabled !== false ? ' checked' : '') + '></label>' +
      '<label>Hide method<select id="xrai-s-hide">' +
      '<option value="remove"' + (cfg.hideMethod === 'remove' ? ' selected' : '') + '>Remove</option>' +
      '<option value="collapse"' + (cfg.hideMethod === 'collapse' ? ' selected' : '') + '>Collapse</option>' +
      '<option value="blur"' + (cfg.hideMethod === 'blur' ? ' selected' : '') + '>Blur</option>' +
      '</select></label>' +
      '<div class="xrai-settings-actions">' +
      '<button id="xrai-s-save">Save</button>' +
      '<button id="xrai-s-clear">Clear memory</button>' +
      '</div>' +
      '<div class="xrai-settings-actions">' +
      '<button id="xrai-s-export">⬇ Export log (.jsonl)</button>' +
      '</div>' +
      '<div class="xrai-settings-stats" id="xrai-s-stats">Loading stats...</div>';

    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ action: 'listModels', platform: _platform }, function (response) {
        if (chrome.runtime.lastError || !response) return;
        var select = popup && popup.querySelector('#xrai-s-model');
        if (!select) return;
        var models = response.models || [];
        select.innerHTML = models.map(function (m) {
          var selected = m === cfg.model ? ' selected' : '';
          return '<option value="' + m + '"' + selected + '>' + m + '</option>';
        }).join('');
        if (models.length === 0) {
          select.innerHTML = '<option value="">No models found</option>';
        }
      });
    }

    var slider = popup.querySelector('#xrai-s-threshold');
    var sliderVal = popup.querySelector('#xrai-s-threshold-val');
    slider.addEventListener('input', function () {
      sliderVal.textContent = slider.value;
    });

    var modeSelect = popup.querySelector('#xrai-s-mode');
    var cloudFields = popup.querySelector('#xrai-s-cloud-fields');
    modeSelect.addEventListener('change', function () {
      cloudFields.style.display = modeSelect.value === 'cloud' ? 'block' : 'none';
    });

    if (cloudMode && cfg.cloudApiKey) {
      chrome.runtime.sendMessage({ action: 'checkBalance', platform: _platform }, function (response) {
        var el = popup && popup.querySelector('#xrai-s-cloud-balance');
        if (!el) return;
        if (!response || response.error) {
          el.textContent = 'Balance unavailable — check your API key';
        } else {
          // Balance is fractional cents at 0.01¢/classification, so ×100 = calls left
          el.textContent = '~' + Math.max(0, Math.round(response.balance_cents * 100)).toLocaleString() + ' free classifications left';
        }
      });
    }

    var freeKeyBtn = popup.querySelector('#xrai-s-free-key');
    freeKeyBtn.addEventListener('click', function () {
      freeKeyBtn.textContent = 'Creating key…';
      freeKeyBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'getFreeKey', platform: _platform }, function (response) {
        if (!popup) return;
        var balanceEl = popup.querySelector('#xrai-s-cloud-balance');
        if (!response || !response.api_key) {
          freeKeyBtn.textContent = 'Get a free key';
          freeKeyBtn.disabled = false;
          if (balanceEl) balanceEl.textContent = (response && response.error) || 'Key request failed — try again';
          return;
        }
        popup.querySelector('#xrai-s-cloud-key').value = response.api_key;
        freeKeyBtn.style.display = 'none';
        if (balanceEl) {
          balanceEl.textContent = 'Key created — ~' + Math.round(response.balance_cents * 100).toLocaleString() +
            ' free classifications. Hit Save.';
        }
      });
    });

    popup.querySelector('#xrai-s-save').addEventListener('click', function () {
      var partial = {
        model: popup.querySelector('#xrai-s-model').value,
        confidenceThreshold: parseFloat(slider.value),
        imageBaitEnabled: popup.querySelector('#xrai-s-image-bait').checked,
        hideMethod: popup.querySelector('#xrai-s-hide').value,
        mode: modeSelect.value,
        cloudApiKey: popup.querySelector('#xrai-s-cloud-key').value.trim()
      };
      if (_platform === 'x') {
        partial.contentFilter = popup.querySelector('#xrai-s-filter').value;
      } else if (_platform === 'youtube') {
        partial.keepMotivational = popup.querySelector('#xrai-s-motivational').checked;
        partial.shortsNudge = popup.querySelector('#xrai-s-shorts-nudge').checked;
        partial.shortsLimitCount = parseInt(popup.querySelector('#xrai-s-shorts-count').value, 10) || 10;
        partial.shortsLimitMinutes = parseInt(popup.querySelector('#xrai-s-shorts-min').value, 10) || 5;
      }
      RaiConfig.saveConfig(_platform, partial).then(function () {
        _mode = partial.mode === 'cloud' ? 'cloud' : 'local';
        closePopup();
      });
    });

    popup.querySelector('#xrai-s-clear').addEventListener('click', function () {
      RaiMemory.clearAll().then(function () {
        var statsEl = popup.querySelector('#xrai-s-stats');
        if (statsEl) statsEl.textContent = 'Memory cleared!';
      });
    });

    popup.querySelector('#xrai-s-export').addEventListener('click', function () {
      var btn = popup.querySelector('#xrai-s-export');
      btn.textContent = 'Exporting…';
      RaiMemory.getEvents().then(function (events) {
        if (!events || !events.length) { btn.textContent = 'No events logged yet'; return; }
        var jsonl = events.map(function (e) { return JSON.stringify(e); }).join('\n');
        var blob = new Blob([jsonl], { type: 'application/x-ndjson' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = L.name + '-log-' + new Date().toISOString().slice(0, 10) + '.jsonl';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        btn.textContent = '⬇ Exported ' + events.length + ' events';
      });
    });

    Promise.all([RaiMemory.getStats(), RaiMemory.getDailyTime(), RaiMemory.countEvents()]).then(function (results) {
      var stats = results[0];
      var dailySecs = results[1];
      var logged = results[2];
      var statsEl = popup.querySelector('#xrai-s-stats');
      if (!statsEl) return;
      var timeSaved = Math.round((stats.hidden || 0) * 3);
      var dailyMin = Math.floor(dailySecs / 60);
      var dailyLabel = dailyMin < 60
        ? dailyMin + 'm'
        : Math.floor(dailyMin / 60) + 'h ' + (dailyMin % 60) + 'm';
      var shortsLine = '';
      if (_platform === 'youtube' && typeof YtraiShorts !== 'undefined' && YtraiShorts.getToday) {
        var st = YtraiShorts.getToday();
        shortsLine = '\n📱 Shorts today: ' + st.count + ' · ' + Math.round(st.seconds / 60) + 'm';
      }
      statsEl.textContent = 'Processed: ' + stats.total +
        ' | Kept: ' + stats.kept +
        ' | Hidden: ' + stats.hidden +
        '\nLogged: ' + logged + ' events · Today on ' + L.siteWord + ': ' + dailyLabel +
        shortsLine;
    });
  }

  return {
    init: init,
    update: update,
    incrementKept: incrementKept,
    incrementHidden: incrementHidden,
    setExtra: setExtra,
    // back-compat aliases (X main historically used shown/hidden naming)
    incrementShown: incrementKept
  };
})();
