import { describe, it, expect, beforeEach, mock } from 'bun:test';

describe('attachNewTabHandler', () => {
  // We test the new-tab handler logic directly by simulating what main.js does
  let openedUrls;
  let originalOpen;

  beforeEach(() => {
    openedUrls = [];
    originalOpen = window.open;
    window.open = mock((url, target) => {
      openedUrls.push({ url, target });
    });
  });

  function createTweetElement(author, tweetId, opts = {}) {
    const article = document.createElement('article');

    const textDiv = document.createElement('div');
    textDiv.setAttribute('data-testid', 'tweetText');
    textDiv.textContent = 'Some tweet text here';
    article.appendChild(textDiv);

    if (opts.blurred) {
      article.setAttribute('data-xrai-hidden', 'blur');
    }
    if (opts.revealed) {
      article.setAttribute('data-xrai-revealed', '1');
    }

    return { article, textDiv };
  }

  // Replicate the attachNewTabHandler logic from main.js
  function attachNewTabHandler(el, data) {
    if (!data.author || !data.id) return;
    var tweetText = el.querySelector('[data-testid="tweetText"]');
    if (!tweetText || tweetText._xraiNewTab) return;
    tweetText._xraiNewTab = true;
    tweetText.addEventListener('click', function (e) {
      if (e.target.closest('[data-testid="like"], [data-testid="retweet"], [data-testid="reply"], [data-testid="Tweet-User-Avatar"], [role="group"], video, [data-testid="videoPlayer"], [data-testid="tweetPhoto"]')) return;
      if (el.getAttribute('data-xrai-hidden') === 'blur' && !el.hasAttribute('data-xrai-revealed')) return;
      e.preventDefault();
      e.stopPropagation();
      window.open('https://x.com/' + data.author + '/status/' + data.id, '_blank');
    });
  }

  it('opens tweet permalink in new tab on text click', () => {
    const { article, textDiv } = createTweetElement('swyx', '123456');
    attachNewTabHandler(article, { author: 'swyx', id: '123456' });
    textDiv.click();

    expect(openedUrls.length).toBe(1);
    expect(openedUrls[0].url).toBe('https://x.com/swyx/status/123456');
    expect(openedUrls[0].target).toBe('_blank');
  });

  it('does not open for tweets with no author', () => {
    const { article, textDiv } = createTweetElement(null, '123');
    attachNewTabHandler(article, { author: null, id: '123' });
    textDiv.click();

    expect(openedUrls.length).toBe(0);
  });

  it('does not open for tweets with no id', () => {
    const { article, textDiv } = createTweetElement('swyx', null);
    attachNewTabHandler(article, { author: 'swyx', id: null });
    textDiv.click();

    expect(openedUrls.length).toBe(0);
  });

  it('does not open for blurred (unrevealed) tweets', () => {
    const { article, textDiv } = createTweetElement('swyx', '123', { blurred: true });
    attachNewTabHandler(article, { author: 'swyx', id: '123' });
    textDiv.click();

    expect(openedUrls.length).toBe(0);
  });

  it('opens for revealed (unblurred) noise tweets', () => {
    const { article, textDiv } = createTweetElement('swyx', '123', { blurred: true, revealed: true });
    attachNewTabHandler(article, { author: 'swyx', id: '123' });
    textDiv.click();

    expect(openedUrls.length).toBe(1);
    expect(openedUrls[0].url).toBe('https://x.com/swyx/status/123');
  });

  it('does not intercept clicks on like button', () => {
    const { article, textDiv } = createTweetElement('swyx', '123');
    attachNewTabHandler(article, { author: 'swyx', id: '123' });

    // Simulate a like button inside tweet text (edge case)
    const likeBtn = document.createElement('div');
    likeBtn.setAttribute('data-testid', 'like');
    textDiv.appendChild(likeBtn);

    // Create a click event that originates from the like button
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: likeBtn });
    textDiv.dispatchEvent(event);

    expect(openedUrls.length).toBe(0);
  });

  it('does not attach handler twice', () => {
    const { article, textDiv } = createTweetElement('swyx', '123');
    attachNewTabHandler(article, { author: 'swyx', id: '123' });
    attachNewTabHandler(article, { author: 'swyx', id: '123' });
    textDiv.click();

    expect(openedUrls.length).toBe(1);
  });
});
