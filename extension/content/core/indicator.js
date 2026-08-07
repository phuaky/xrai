/* rai — Status Indicator (floating pill + today-first panel, platform-aware)

   Pill: status dot + today's hidden count. The dot pulses while a classifier
   is actually working (activity fed by RaiClassifier/RaiImageClassifier) and
   the whole pill is the button — click for the panel.
   Panel: TODAY stats first (the thing you glance at), live "checking …" line
   while classifying, all-time as a footnote. Config lives one tap deeper in
   a settings view where every control saves on change (no Save button). */
var RaiIndicator = (function () {
  'use strict';

  var pill = null;
  var dotEl = null;
  var countEl = null;
  var labelEl = null;
  var extraEl = null;
  var popup = null;
  var popupOpen = false;
  var popupView = 'today';

  var counts = {
    total: 0, kept: 0, hidden: 0,
    todayTotal: 0, todayKept: 0, todayHidden: 0
  };
  var status = { connected: false, classify: false };
  var activity = { text: null, image: null };  // per-source snapshots from onActivity
  var _lastPillCount = null;

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

    dotEl = document.createElement('span');
    dotEl.className = 'xrai-dot xrai-dot-red';

    countEl = document.createElement('span');
    countEl.className = 'xrai-pill-count';

    labelEl = document.createElement('span');
    labelEl.className = 'xrai-pill-label';

    extraEl = document.createElement('span');
    extraEl.className = 'xrai-pill-extra';

    pill.appendChild(dotEl);
    pill.appendChild(countEl);
    pill.appendChild(labelEl);
    pill.appendChild(extraEl);
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePopup();
    });

    document.body.appendChild(pill);

    if (typeof RaiMemory !== 'undefined' && RaiMemory.getStats) {
      RaiMemory.getStats().then(function (stats) {
        if (stats) seedCounts(stats);
        render();
      });
    }

    // Worker-written totals are the shared truth: re-render from them whenever
    // any tab counts, so pills agree across tabs (the local increment* bumps
    // below only bridge the instant before the worker's write lands).
    if (typeof RaiMemory !== 'undefined' && RaiMemory.onStatsChanged) {
      RaiMemory.onStatsChanged(function (stats) {
        seedCounts(stats);
        render();
      });
    }

    render();
  }

  function seedCounts(stats) {
    counts.total = stats.total || 0;
    counts.kept = stats.kept || 0;
    counts.hidden = stats.hidden || 0;
    var t = stats.today || {};
    counts.todayTotal = t.total || 0;
    counts.todayKept = t.kept || 0;
    counts.todayHidden = t.hidden || 0;
  }

  // Merge the two classifier queues into one "is anything happening" view.
  function busyInfo() {
    var t = activity.text;
    var i = activity.image;
    var inFlight = (t ? (t.active || 0) + (t.queued || 0) : 0) +
                   (i ? (i.active || 0) + (i.queued || 0) : 0);
    var current = (t && t.current) || (i && i.current) || null;
    return {
      busy: inFlight > 0,
      current: current,
      waiting: Math.max(0, inFlight - (current ? 1 : 0))
    };
  }

  function offlineText() {
    return (_mode === 'cloud' ? 'cloud' : 'ollama') + ' offline';
  }

  function currentLabel(cur) {
    if (!cur) return '—';
    var who = cur.author ? '@' + cur.author : (cur.channel || '');
    var txt = (cur.text || '').replace(/\s+/g, ' ').trim();
    if (!who && !txt) return 'image check';
    if (txt.length > 34) txt = txt.substring(0, 34) + '…';
    return who ? who + ' — “' + txt + '”' : '“' + txt + '”';
  }

  function render() {
    if (!pill) return;
    var b = busyInfo();
    var healthy = status.connected && status.classify;

    var dotClass = 'xrai-dot ';
    if (!status.connected) dotClass += 'xrai-dot-red';
    else if (!status.classify) dotClass += 'xrai-dot-orange';
    else dotClass += 'xrai-dot-green';
    if (healthy && b.busy) dotClass += ' xrai-dot-pulse';
    dotEl.className = dotClass;

    if (!status.connected) {
      countEl.textContent = '';
      labelEl.textContent = offlineText();
    } else if (!status.classify) {
      countEl.textContent = '';
      labelEl.textContent = 'classify ✗' + (_mode === 'local' ? ' (CORS?)' : '');
    } else {
      var n = counts.todayHidden;
      countEl.textContent = String(n);
      labelEl.textContent = L.hiddenWord + ' today';
      if (_lastPillCount !== null && _lastPillCount !== n) {
        countEl.classList.remove('xrai-tick');
        void countEl.offsetWidth;
        countEl.classList.add('xrai-tick');
        setTimeout(function () {
          if (countEl) countEl.classList.remove('xrai-tick');
        }, 200);
      }
      _lastPillCount = n;
    }

    // Quiet mode: healthy + idle = fade back, stop competing with the feed.
    pill.classList.toggle('xrai-pill-quiet', healthy && !b.busy);

    renderPanelLive();
  }

  function update(newCounts, newStatus) {
    if (newCounts) {
      if (typeof newCounts.kept === 'number') counts.kept = newCounts.kept;
      if (typeof newCounts.hidden === 'number') counts.hidden = newCounts.hidden;
    }
    if (newStatus) {
      status.connected = newStatus.connected !== undefined ? newStatus.connected : status.connected;
      status.classify = newStatus.classify !== undefined ? newStatus.classify : status.classify;
    }
    render();
  }

  function incrementKept() {
    counts.kept++; counts.total++;
    counts.todayKept++; counts.todayTotal++;
    render();
  }

  function incrementHidden() {
    counts.hidden++; counts.total++;
    counts.todayHidden++; counts.todayTotal++;
    render();
  }

  // Classifier queue snapshots land here (wired in each platform's main.js).
  function setActivity(source, snapshot) {
    activity[source] = snapshot;
    render();
  }

  // Optional trailing segment on the pill (used by the YouTube Shorts tracker).
  function setExtra(text) {
    if (!extraEl) return;
    extraEl.textContent = text ? ' · ' + text : '';
  }

  function togglePopup() {
    if (popupOpen) { closePopup(); return; }
    popupOpen = true;
    popupView = 'today';

    popup = document.createElement('div');
    popup.id = 'xrai-settings';
    document.body.appendChild(popup);
    renderPanel();

    setTimeout(function () {
      document.addEventListener('click', outsideClickHandler);
    }, 100);
  }

  function outsideClickHandler(e) {
    // A click on a panel link can synchronously re-render the panel (back /
    // settings), detaching the clicked node before this bubbled handler runs.
    // A detached target is never an "outside" click — ignore it.
    if (e.target && e.target.isConnected === false) return;
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

  function renderPanel() {
    if (!popup) return;
    if (popupView === 'settings') { renderSettingsView(); return; }
    renderTodayView();
  }

  // === Today view — the default: what did rai do for you today ===

  function renderTodayView() {
    var isYt = _platform === 'youtube';
    popup.innerHTML =
      '<div class="xrai-p-head"><span class="xrai-p-name"></span>' +
      '<span class="xrai-p-status"><span class="xrai-dot xrai-dot-green" id="xrai-p-dot"></span><span id="xrai-p-stat"></span></span></div>' +
      '<div id="xrai-p-live" style="display:none">' +
      '<div class="xrai-p-row"><span class="xrai-p-k">checking</span><span class="xrai-p-v" id="xrai-p-cur"></span></div>' +
      '<div class="xrai-p-row"><span class="xrai-p-k">queued</span><span class="xrai-p-v" id="xrai-p-q"></span></div>' +
      '</div>' +
      '<div class="xrai-p-sec">today</div>' +
      '<div class="xrai-p-hero" id="xrai-p-hero"></div>' +
      '<div class="xrai-p-herosub">processed today</div>' +
      '<div class="xrai-p-row"><span class="xrai-p-k">' + L.keptWord + '</span><span class="xrai-p-v" id="xrai-p-kept"></span></div>' +
      '<div class="xrai-p-row"><span class="xrai-p-k">' + L.hiddenWord + '</span><span class="xrai-p-v" id="xrai-p-hid"></span></div>' +
      '<div class="xrai-p-row"><span class="xrai-p-k">time on ' + L.siteWord + '</span><span class="xrai-p-v" id="xrai-p-time">—</span></div>' +
      (isYt ? '<div class="xrai-p-row"><span class="xrai-p-k">shorts</span><span class="xrai-p-v" id="xrai-p-shorts">—</span></div>' : '') +
      '<div class="xrai-p-foot"><span id="xrai-p-life"></span><span class="xrai-p-link" id="xrai-p-goset">settings</span></div>';

    popup.querySelector('.xrai-p-name').textContent = L.name;
    popup.querySelector('#xrai-p-goset').addEventListener('click', function () {
      popupView = 'settings';
      renderPanel();
    });

    renderPanelLive();

    if (typeof RaiMemory !== 'undefined') {
      RaiMemory.getStats().then(function (stats) {
        if (!stats) return;
        seedCounts(stats);
        renderPanelLive();
      });
      RaiMemory.getDailyTime().then(function (secs) {
        var el = popup && popup.querySelector('#xrai-p-time');
        if (el) el.textContent = formatMinutes(Math.floor(secs / 60));
      });
    }

    if (isYt && typeof YtraiShorts !== 'undefined' && YtraiShorts.getToday) {
      var st = YtraiShorts.getToday();
      var sEl = popup.querySelector('#xrai-p-shorts');
      if (sEl) sEl.textContent = st.count + ' · ' + Math.round(st.seconds / 60) + 'm';
    }
  }

  // Refresh the live parts of the today view (status word, checking line,
  // numbers) without rebuilding the DOM — called from render() on every
  // stats/activity change so an open panel stays truthful.
  function renderPanelLive() {
    if (!popup || popupView !== 'today') return;
    var statEl = popup.querySelector('#xrai-p-stat');
    if (!statEl) return;

    var b = busyInfo();
    var healthy = status.connected && status.classify;

    var pDot = popup.querySelector('#xrai-p-dot');
    var dotClass = 'xrai-dot ';
    if (!status.connected) dotClass += 'xrai-dot-red';
    else if (!status.classify) dotClass += 'xrai-dot-orange';
    else dotClass += 'xrai-dot-green';
    if (healthy && b.busy) dotClass += ' xrai-dot-pulse';
    pDot.className = dotClass;

    if (!status.connected) statEl.textContent = offlineText();
    else if (!status.classify) statEl.textContent = 'classify ✗';
    else statEl.textContent = (b.busy ? 'filtering' : 'idle') + (_mode === 'cloud' ? ' · cloud' : '');

    var liveWrap = popup.querySelector('#xrai-p-live');
    if (liveWrap) {
      liveWrap.style.display = b.busy ? 'block' : 'none';
      if (b.busy) {
        popup.querySelector('#xrai-p-cur').textContent = currentLabel(b.current);
        popup.querySelector('#xrai-p-q').textContent = String(b.waiting);
      }
    }

    var heroEl = popup.querySelector('#xrai-p-hero');
    if (heroEl) heroEl.textContent = counts.todayTotal.toLocaleString();
    var keptEl = popup.querySelector('#xrai-p-kept');
    if (keptEl) keptEl.textContent = counts.todayKept.toLocaleString();
    var hidEl = popup.querySelector('#xrai-p-hid');
    if (hidEl) hidEl.textContent = counts.todayHidden.toLocaleString();
    var lifeEl = popup.querySelector('#xrai-p-life');
    if (lifeEl) lifeEl.textContent = counts.total.toLocaleString() + ' all-time';
  }

  function formatMinutes(min) {
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
  }

  // === Settings view — every control saves on change, no Save button ===

  function renderSettingsView() {
    RaiConfig.getConfig(_platform).then(function (cfg) {
      if (!popup || popupView !== 'settings') return;
      buildSettings(cfg);
    });
  }

  function buildSettings(cfg) {
    var extraControl = '';
    if (_platform === 'x') {
      extraControl =
        '<label>Content<select id="xrai-s-filter">' +
        '<option value="posts-only">Posts only</option>' +
        '<option value="all">All</option>' +
        '</select></label>' +
        '<div class="xrai-settings-sub">Memory-aware signal</div>' +
        '<label>Collapse familiar posts<input type="checkbox" id="xrai-s-memory-aware"></label>' +
        '<label>Memory confidence<input type="range" id="xrai-s-memory-threshold" min="0.5" max="0.95" step="0.05"><span id="xrai-s-memory-threshold-val"></span></label>' +
        '<div class="xrai-settings-sub">Reply guard (your posts)</div>' +
        '<label>Blur bad-faith replies<input type="checkbox" id="xrai-s-replyguard"></label>' +
        '<label>Your handle<input type="text" id="xrai-s-ownhandle" placeholder="yourhandle"></label>';
    } else if (_platform === 'youtube') {
      extraControl =
        '<label>Keep motivational<input type="checkbox" id="xrai-s-motivational"></label>' +
        '<div class="xrai-settings-sub">Shorts doom-scroll</div>' +
        '<label>Snap-out nudge<input type="checkbox" id="xrai-s-shorts-nudge"></label>' +
        '<label>Nudge after (Shorts)<input type="number" id="xrai-s-shorts-count" min="1" max="200"></label>' +
        '<label>…or minutes<input type="number" id="xrai-s-shorts-min" min="1" max="120"></label>';
    }

    var aggressivenessLabel = _platform === 'youtube' ? 'Strictness' : 'Aggressiveness';
    var cloudMode = cfg.mode === 'cloud';
    var memoryActions = _platform === 'x'
      ? ' · <span class="xrai-p-link" id="xrai-s-export-memory">export memory</span>' +
        ' · <span class="xrai-p-link" id="xrai-s-seed-memory">seed history</span>'
      : '';

    popup.innerHTML =
      '<div class="xrai-p-head"><span class="xrai-p-name"></span><span class="xrai-p-savenote" id="xrai-s-saved">saved</span></div>' +
      '<label>Mode<select id="xrai-s-mode">' +
      '<option value="local">Local (free, needs Ollama)</option>' +
      '<option value="cloud">Cloud (free beta, no setup)</option>' +
      '</select></label>' +
      '<div id="xrai-s-cloud-fields" style="display:' + (cloudMode ? 'block' : 'none') + '">' +
      '<label>API key<input type="password" id="xrai-s-cloud-key" placeholder="rai_live_..."></label>' +
      '<div class="xrai-settings-actions"><button type="button" id="xrai-s-free-key">Get a free key</button></div>' +
      '<div class="xrai-settings-sub" id="xrai-s-cloud-balance"></div>' +
      '<div class="xrai-settings-sub"><a href="https://snratio.xyz/privacy.html" target="_blank" rel="noopener">What cloud mode sends</a></div>' +
      '</div>' +
      '<label>Model<select id="xrai-s-model"><option value="">Loading models...</option></select></label>' +
      '<label>' + aggressivenessLabel + '<input type="range" id="xrai-s-threshold" min="0.5" max="0.9" step="0.05"><span id="xrai-s-threshold-val"></span></label>' +
      extraControl +
      '<label>Image bait check<input type="checkbox" id="xrai-s-image-bait"></label>' +
      '<label>Hop nudge (X↔YT)<input type="checkbox" id="xrai-s-hop-nudge"></label>' +
      '<label>Hide method<select id="xrai-s-hide">' +
      '<option value="remove">Remove</option>' +
      '<option value="collapse">Collapse</option>' +
      '<option value="blur">Blur</option>' +
      '</select></label>' +
      '<div class="xrai-p-foot">' +
      '<span><span class="xrai-p-link" id="xrai-s-export">export log</span>' + memoryActions +
      ' · <span class="xrai-p-link xrai-p-danger" id="xrai-s-clear">clear memory</span></span>' +
      '<span class="xrai-p-link" id="xrai-s-back">back</span></div>';

    popup.querySelector('.xrai-p-name').textContent = L.name + ' settings';

    // Values via properties, not markup — survives quotes in the API key.
    var modeSelect = popup.querySelector('#xrai-s-mode');
    modeSelect.value = cloudMode ? 'cloud' : 'local';
    var keyInput = popup.querySelector('#xrai-s-cloud-key');
    keyInput.value = cfg.cloudApiKey || '';
    var slider = popup.querySelector('#xrai-s-threshold');
    slider.value = cfg.confidenceThreshold;
    var sliderVal = popup.querySelector('#xrai-s-threshold-val');
    sliderVal.textContent = String(cfg.confidenceThreshold);
    popup.querySelector('#xrai-s-image-bait').checked = cfg.imageBaitEnabled !== false;
    popup.querySelector('#xrai-s-hop-nudge').checked = cfg.hopNudge !== false;
    popup.querySelector('#xrai-s-hide').value = cfg.hideMethod || 'remove';
    if (_platform === 'x') {
      popup.querySelector('#xrai-s-filter').value = cfg.contentFilter || 'posts-only';
      popup.querySelector('#xrai-s-memory-aware').checked = cfg.memoryAware !== false;
      var memorySlider = popup.querySelector('#xrai-s-memory-threshold');
      memorySlider.value = cfg.memoryConfidenceThreshold || 0.75;
      popup.querySelector('#xrai-s-memory-threshold-val').textContent = String(cfg.memoryConfidenceThreshold || 0.75);
      popup.querySelector('#xrai-s-replyguard').checked = cfg.replyGuard !== false;
      popup.querySelector('#xrai-s-ownhandle').value = cfg.ownHandle || '';
    } else if (_platform === 'youtube') {
      popup.querySelector('#xrai-s-motivational').checked = !!cfg.keepMotivational;
      popup.querySelector('#xrai-s-shorts-nudge').checked = cfg.shortsNudge !== false;
      popup.querySelector('#xrai-s-shorts-count').value = cfg.shortsLimitCount || 10;
      popup.querySelector('#xrai-s-shorts-min').value = cfg.shortsLimitMinutes || 5;
    }

    var freeKeyBtn = popup.querySelector('#xrai-s-free-key');
    freeKeyBtn.style.display = cfg.cloudApiKey ? 'none' : '';

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

    // --- auto-save wiring ---
    var savedEl = popup.querySelector('#xrai-s-saved');
    var savedTimer = null;
    function flashSaved() {
      if (!savedEl) return;
      savedEl.classList.add('xrai-p-savenote-show');
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(function () {
        if (savedEl) savedEl.classList.remove('xrai-p-savenote-show');
      }, 1200);
    }
    function save(partial) {
      RaiConfig.saveConfig(_platform, partial).then(function (newCfg) {
        _mode = newCfg.mode === 'cloud' ? 'cloud' : 'local';
        flashSaved();
        render();
      });
    }

    modeSelect.addEventListener('change', function () {
      popup.querySelector('#xrai-s-cloud-fields').style.display =
        modeSelect.value === 'cloud' ? 'block' : 'none';
      save({ mode: modeSelect.value });
    });
    keyInput.addEventListener('change', function () {
      save({ cloudApiKey: keyInput.value.trim() });
    });
    popup.querySelector('#xrai-s-model').addEventListener('change', function (e) {
      if (e.target.value) save({ model: e.target.value });
    });
    slider.addEventListener('input', function () {
      sliderVal.textContent = slider.value;
    });
    slider.addEventListener('change', function () {
      save({ confidenceThreshold: parseFloat(slider.value) });
    });
    popup.querySelector('#xrai-s-image-bait').addEventListener('change', function (e) {
      save({ imageBaitEnabled: e.target.checked });
    });
    popup.querySelector('#xrai-s-hop-nudge').addEventListener('change', function (e) {
      save({ hopNudge: e.target.checked });
    });
    popup.querySelector('#xrai-s-hide').addEventListener('change', function (e) {
      save({ hideMethod: e.target.value });
    });
    if (_platform === 'x') {
      popup.querySelector('#xrai-s-filter').addEventListener('change', function (e) {
        save({ contentFilter: e.target.value });
      });
      popup.querySelector('#xrai-s-memory-aware').addEventListener('change', function (e) {
        save({ memoryAware: e.target.checked });
      });
      var memorySlider = popup.querySelector('#xrai-s-memory-threshold');
      var memorySliderVal = popup.querySelector('#xrai-s-memory-threshold-val');
      memorySlider.addEventListener('input', function () {
        memorySliderVal.textContent = memorySlider.value;
      });
      memorySlider.addEventListener('change', function () {
        save({ memoryConfidenceThreshold: parseFloat(memorySlider.value) });
      });
      popup.querySelector('#xrai-s-replyguard').addEventListener('change', function (e) {
        save({ replyGuard: e.target.checked });
      });
      popup.querySelector('#xrai-s-ownhandle').addEventListener('change', function (e) {
        save({ ownHandle: e.target.value.replace(/^@/, '').trim() });
      });
    } else if (_platform === 'youtube') {
      popup.querySelector('#xrai-s-motivational').addEventListener('change', function (e) {
        save({ keepMotivational: e.target.checked });
      });
      popup.querySelector('#xrai-s-shorts-nudge').addEventListener('change', function (e) {
        save({ shortsNudge: e.target.checked });
      });
      popup.querySelector('#xrai-s-shorts-count').addEventListener('change', function (e) {
        save({ shortsLimitCount: parseInt(e.target.value, 10) || 10 });
      });
      popup.querySelector('#xrai-s-shorts-min').addEventListener('change', function (e) {
        save({ shortsLimitMinutes: parseInt(e.target.value, 10) || 5 });
      });
    }

    // Cloud balance + free-key flow (runtime.id check = orphaned-tab guard)
    if (cloudMode && cfg.cloudApiKey && chrome.runtime && chrome.runtime.id) {
      var balEl = popup.querySelector('#xrai-s-cloud-balance');
      balEl.textContent = 'Checking balance…';
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

    freeKeyBtn.addEventListener('click', function () {
      if (!chrome.runtime || !chrome.runtime.id) {
        freeKeyBtn.textContent = 'Extension reloaded — refresh this page';
        return;
      }
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
        keyInput.value = response.api_key;
        save({ cloudApiKey: response.api_key });
        freeKeyBtn.style.display = 'none';
        if (balanceEl) {
          balanceEl.textContent = 'Key created — ~' + Math.round(response.balance_cents * 100).toLocaleString() +
            ' free classifications. Saved.';
        }
      });
    });

    popup.querySelector('#xrai-s-back').addEventListener('click', function () {
      popupView = 'today';
      renderPanel();
    });

    // Clear memory: two-tap confirm — the only destructive control here.
    // Clears fingerprints + stats totals; the durable event log is untouched.
    var clearLink = popup.querySelector('#xrai-s-clear');
    var clearArmed = false;
    clearLink.addEventListener('click', function () {
      if (!clearArmed) {
        clearArmed = true;
        clearLink.textContent = 'sure? click again';
        setTimeout(function () {
          if (clearArmed && popup) {
            clearArmed = false;
            clearLink.textContent = 'clear memory';
          }
        }, 2500);
        return;
      }
      clearArmed = false;
      RaiMemory.clearAll().then(function () {
        if (popup) clearLink.textContent = 'cleared';
        setTimeout(function () {
          if (popup) clearLink.textContent = 'clear memory';
        }, 1500);
      });
    });

    if (_platform === 'x') {
      popup.querySelector('#xrai-s-export-memory').addEventListener('click', function () {
        var btn = popup.querySelector('#xrai-s-export-memory');
        if (typeof RaiKnowledge === 'undefined' || !RaiKnowledge.exportData) {
          btn.textContent = 'memory unavailable';
          return;
        }
        btn.textContent = 'exporting…';
        RaiKnowledge.exportData().then(function (data) {
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'xrai-memory-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          btn.textContent = 'exported ' + data.claims.length + ' claims';
        }).catch(function () { btn.textContent = 'export failed'; });
      });

      popup.querySelector('#xrai-s-seed-memory').addEventListener('click', function () {
        var btn = popup.querySelector('#xrai-s-seed-memory');
        if (typeof RaiKnowledge === 'undefined' || !RaiKnowledge.importSeed) {
          btn.textContent = 'memory unavailable';
          return;
        }
        btn.textContent = 'seeding…';
        RaiMemory.getEvents().then(function (events) {
          return RaiKnowledge.importSeed(events || []);
        }).then(function (result) {
          btn.textContent = result.pending
            ? result.embedded + ' ready · ' + result.pending + ' retry'
            : result.embedded + ' claims ready';
        }).catch(function () { btn.textContent = 'seed failed'; });
      });
    }

    popup.querySelector('#xrai-s-export').addEventListener('click', function () {
      var btn = popup.querySelector('#xrai-s-export');
      btn.textContent = 'exporting…';
      RaiMemory.getEvents().then(function (events) {
        if (!events || !events.length) { btn.textContent = 'no events logged yet'; return; }
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
        btn.textContent = 'exported ' + events.length + ' events';
      });
    });
  }

  return {
    init: init,
    update: update,
    incrementKept: incrementKept,
    incrementHidden: incrementHidden,
    setActivity: setActivity,
    setExtra: setExtra,
    // back-compat aliases (X main historically used shown/hidden naming)
    incrementShown: incrementKept
  };
})();
