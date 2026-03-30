/* xrai — Reply Generator UI (floating card with copy buttons) */
var XraiReply = (function () {
  'use strict';

  var activeCard = null;
  var closeHandler = null;

  function attachReplyButton(element, data) {
    if (element.querySelector('.xrai-reply-btn')) return;
    var btn = document.createElement('div');
    btn.className = 'xrai-reply-btn';
    btn.innerHTML = '&#x1F4CB;'; // clipboard emoji
    btn.title = 'Generate reply';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      showReplyCard(element, data);
    });
    // Position relative to tweet actions area
    var actions = element.querySelector('[role="group"]');
    if (actions) {
      actions.style.position = 'relative';
      actions.appendChild(btn);
    } else {
      element.style.position = 'relative';
      element.appendChild(btn);
    }
  }

  function showReplyCard(tweetEl, data) {
    closeActiveCard();

    var card = document.createElement('div');
    card.className = 'xrai-reply-card';
    card.innerHTML = '<div class="xrai-reply-loading">Generating replies...</div>';

    // Position near the tweet
    var rect = tweetEl.getBoundingClientRect();
    card.style.top = (window.scrollY + rect.bottom + 8) + 'px';
    card.style.left = Math.max(8, rect.left) + 'px';

    document.body.appendChild(card);
    activeCard = card;

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(function () {
      closeHandler = function (e) {
        if (card && !card.contains(e.target)) {
          closeActiveCard();
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);

    // Request replies via service worker
    if (!chrome.runtime || !chrome.runtime.id) return;
    chrome.runtime.sendMessage(
      {
        action: 'reply',
        tweetText: data.text,
        authorHandle: data.author,
        style: 'curious'
      },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.replies) {
          card.innerHTML = '<div class="xrai-reply-error">Failed to generate. Is Ollama running?</div>';
          return;
        }
        renderReplies(card, response.replies);
      }
    );
  }

  function renderReplies(card, replies) {
    var html = '<div class="xrai-reply-header">Reply options</div>';
    replies.forEach(function (r) {
      html += '<div class="xrai-reply-option">' +
        '<span class="xrai-reply-style">' + (r.style || '') + '</span>' +
        '<span class="xrai-reply-text">' + escapeHtml(r.text) + '</span>' +
        '<button class="xrai-reply-copy" data-text="' + escapeAttr(r.text) + '">Copy</button>' +
        '</div>';
    });
    card.innerHTML = html;

    // Attach copy handlers
    card.querySelectorAll('.xrai-reply-copy').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var text = btn.getAttribute('data-text');
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        });
      });
    });
  }

  function closeActiveCard() {
    if (activeCard && activeCard.parentNode) {
      activeCard.parentNode.removeChild(activeCard);
    }
    activeCard = null;
    if (closeHandler) {
      document.removeEventListener('click', closeHandler);
      closeHandler = null;
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    attachReplyButton: attachReplyButton,
    closeActiveCard: closeActiveCard
  };
})();
