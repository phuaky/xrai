/* xrai — Status Indicator (floating pill + settings popup) */
var XraiIndicator = (function () {
  'use strict';

  var pill = null;
  var popup = null;
  var counts = { shown: 0, hidden: 0 };
  var status = { connected: false, classify: false, reply: false, label: 'offline' };
  var popupOpen = false;

  function init() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'xrai-pill';
    pill.innerHTML = buildPillHtml();
    document.body.appendChild(pill);

    pill.querySelector('.xrai-pill-gear').addEventListener('click', function (e) {
      e.stopPropagation();
      togglePopup();
    });
  }

  function buildPillHtml() {
    var dotClass = 'xrai-dot-red';
    if (status.connected && status.classify) dotClass = 'xrai-dot-green';
    else if (status.connected) dotClass = 'xrai-dot-orange';

    var statusParts = [];
    if (!status.connected) {
      statusParts.push('ollama offline');
    } else if (!status.classify) {
      statusParts.push('ollama up · classify ✗ (CORS?)');
    } else {
      statusParts.push('local');
    }

    return '<span class="xrai-pill-text">xrai: ' +
      counts.shown + ' shown | ' + counts.hidden + ' hidden</span>' +
      ' <span class="xrai-dot ' + dotClass + '" title="server: ' + (status.connected ? '✓' : '✗') + ' classify: ' + (status.classify ? '✓' : '✗') + ' reply: ' + (status.reply ? '✓' : '✗') + '"></span>' +
      '<span class="xrai-pill-status">' + statusParts.join('') + '</span>' +
      ' <span class="xrai-pill-gear">&#x2699;</span>';
  }

  function update(newCounts, newStatus) {
    if (newCounts) {
      counts.shown = newCounts.shown || counts.shown;
      counts.hidden = newCounts.hidden || counts.hidden;
    }
    if (newStatus) {
      status.connected = newStatus.connected !== undefined ? newStatus.connected : status.connected;
      status.classify = newStatus.classify !== undefined ? newStatus.classify : status.classify;
      status.reply = newStatus.reply !== undefined ? newStatus.reply : status.reply;
      status.label = newStatus.label || status.label;
    }
    if (pill) pill.innerHTML = buildPillHtml();
    // Re-attach gear listener
    if (pill) {
      pill.querySelector('.xrai-pill-gear').addEventListener('click', function (e) {
        e.stopPropagation();
        togglePopup();
      });
    }
  }

  function incrementShown() { counts.shown++; update(); }
  function incrementHidden() { counts.hidden++; update(); }

  function togglePopup() {
    if (popupOpen) { closePopup(); return; }
    popupOpen = true;

    popup = document.createElement('div');
    popup.id = 'xrai-settings';
    popup.innerHTML = '<div class="xrai-settings-loading">Loading...</div>';
    document.body.appendChild(popup);

    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', outsideClickHandler);
    }, 100);

    // Load config and render
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

    // Populate model dropdown from Ollama
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

    // Threshold slider feedback
    var slider = popup.querySelector('#xrai-s-threshold');
    var sliderVal = popup.querySelector('#xrai-s-threshold-val');
    slider.addEventListener('input', function () {
      sliderVal.textContent = slider.value;
    });

    // Save
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

    // Clear memory
    popup.querySelector('#xrai-s-clear').addEventListener('click', function () {
      XraiMemory.clearAll().then(function () {
        var statsEl = popup.querySelector('#xrai-s-stats');
        if (statsEl) statsEl.textContent = 'Memory cleared!';
      });
    });

    // Load stats
    XraiMemory.getStats().then(function (stats) {
      var statsEl = popup.querySelector('#xrai-s-stats');
      if (!statsEl) return;
      var timeSaved = Math.round(stats.noise * 3); // ~3s per hidden tweet
      statsEl.textContent = 'Processed: ' + stats.total +
        ' | Signal: ' + stats.signal +
        ' | Noise: ' + stats.noise +
        ' | ~' + timeSaved + 's saved';
    });
  }

  return {
    init: init,
    update: update,
    incrementShown: incrementShown,
    incrementHidden: incrementHidden
  };
})();
