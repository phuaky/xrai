/* xrai — Status Indicator (floating pill + settings popup) */
var XraiIndicator = (function () {
  'use strict';

  var pill = null;
  var countsEl = null;
  var statusEl = null;
  var dotEl = null;
  var gearEl = null;
  var popup = null;
  var counts = { shown: 0, hidden: 0 };
  var status = { connected: false, classify: false, reply: false, label: 'offline' };
  var popupOpen = false;

  function init() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'xrai-pill';

    countsEl = document.createElement('span');
    countsEl.className = 'xrai-pill-text';

    dotEl = document.createElement('span');
    dotEl.className = 'xrai-dot xrai-dot-red';

    statusEl = document.createElement('span');
    statusEl.className = 'xrai-pill-status';

    gearEl = document.createElement('span');
    gearEl.className = 'xrai-pill-gear';
    gearEl.textContent = '\u2699';
    gearEl.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePopup();
    });

    pill.appendChild(countsEl);
    pill.appendChild(document.createTextNode(' '));
    pill.appendChild(dotEl);
    pill.appendChild(statusEl);
    pill.appendChild(document.createTextNode(' '));
    pill.appendChild(gearEl);

    document.body.appendChild(pill);

    // Hydrate counts from lifetime stats (fix #25)
    if (typeof XraiMemory !== 'undefined' && XraiMemory.getStats) {
      XraiMemory.getStats().then(function (stats) {
        if (!stats) return;
        counts.shown = stats.signal || 0;
        counts.hidden = stats.noise || 0;
        render();
      });
    }

    render();
  }

  function render() {
    if (!pill) return;
    countsEl.textContent = 'xrai: ' + counts.shown + ' shown | ' + counts.hidden + ' hidden';

    var dotClass = 'xrai-dot xrai-dot-red';
    if (status.connected && status.classify) dotClass = 'xrai-dot xrai-dot-green';
    else if (status.connected) dotClass = 'xrai-dot xrai-dot-orange';
    dotEl.className = dotClass;
    dotEl.title = 'server: ' + (status.connected ? '\u2713' : '\u2717') +
      ' classify: ' + (status.classify ? '\u2713' : '\u2717') +
      ' reply: ' + (status.reply ? '\u2713' : '\u2717');

    var statusText = '';
    if (!status.connected) statusText = 'ollama offline';
    else if (!status.classify) statusText = 'ollama up \u00b7 classify \u2717 (CORS?)';
    else statusText = 'local';
    statusEl.textContent = statusText;
  }

  function update(newCounts, newStatus) {
    if (newCounts) {
      if (typeof newCounts.shown === 'number') counts.shown = newCounts.shown;
      if (typeof newCounts.hidden === 'number') counts.hidden = newCounts.hidden;
    }
    if (newStatus) {
      status.connected = newStatus.connected !== undefined ? newStatus.connected : status.connected;
      status.classify = newStatus.classify !== undefined ? newStatus.classify : status.classify;
      status.reply = newStatus.reply !== undefined ? newStatus.reply : status.reply;
      status.label = newStatus.label || status.label;
    }
    render();
  }

  function incrementShown() { counts.shown++; render(); }
  function incrementHidden() { counts.hidden++; render(); }

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

    XraiConfig.getConfig().then(function (cfg) {
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
    popup.innerHTML =
      '<div class="xrai-settings-title">xrai settings</div>' +
      '<label>Model<select id="xrai-s-model"><option value="">Loading models...</option></select></label>' +
      '<label>Aggressiveness<input type="range" id="xrai-s-threshold" min="0.5" max="0.9" step="0.05" value="' + cfg.confidenceThreshold + '"><span id="xrai-s-threshold-val">' + cfg.confidenceThreshold + '</span></label>' +
      '<label>Content<select id="xrai-s-filter"><option value="posts-only"' + (cfg.contentFilter === 'posts-only' ? ' selected' : '') + '>Posts only</option><option value="all"' + (cfg.contentFilter === 'all' ? ' selected' : '') + '>All</option></select></label>' +
      '<label>Hide method<select id="xrai-s-hide"><option value="remove"' + (cfg.hideMethod === 'remove' ? ' selected' : '') + '>Remove</option><option value="collapse"' + (cfg.hideMethod === 'collapse' ? ' selected' : '') + '>Collapse</option><option value="blur"' + (cfg.hideMethod === 'blur' ? ' selected' : '') + '>Blur</option></select></label>' +
      '<div class="xrai-settings-actions">' +
      '<button id="xrai-s-save">Save</button>' +
      '<button id="xrai-s-clear">Clear memory</button>' +
      '</div>' +
      '<div class="xrai-settings-stats" id="xrai-s-stats">Loading stats...</div>';

    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ action: 'listModels' }, function (response) {
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

    popup.querySelector('#xrai-s-save').addEventListener('click', function () {
      XraiConfig.saveConfig({
        model: popup.querySelector('#xrai-s-model').value,
        confidenceThreshold: parseFloat(slider.value),
        contentFilter: popup.querySelector('#xrai-s-filter').value,
        hideMethod: popup.querySelector('#xrai-s-hide').value
      }).then(function () {
        closePopup();
      });
    });

    popup.querySelector('#xrai-s-clear').addEventListener('click', function () {
      XraiMemory.clearAll().then(function () {
        var statsEl = popup.querySelector('#xrai-s-stats');
        if (statsEl) statsEl.textContent = 'Memory cleared!';
      });
    });

    Promise.all([XraiMemory.getStats(), XraiMemory.getDailyTime()]).then(function (results) {
      var stats = results[0];
      var dailySecs = results[1];
      var statsEl = popup.querySelector('#xrai-s-stats');
      if (!statsEl) return;
      var timeSaved = Math.round(stats.noise * 3);
      var dailyMin = Math.floor(dailySecs / 60);
      var dailyLabel = dailyMin < 60
        ? dailyMin + 'm'
        : Math.floor(dailyMin / 60) + 'h ' + (dailyMin % 60) + 'm';
      statsEl.textContent = 'Processed: ' + stats.total +
        ' | Signal: ' + stats.signal +
        ' | Noise: ' + stats.noise +
        ' | ~' + timeSaved + 's saved' +
        '\nToday on X: ' + dailyLabel;
    });
  }

  return {
    init: init,
    update: update,
    incrementShown: incrementShown,
    incrementHidden: incrementHidden
  };
})();
