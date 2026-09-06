import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { bootXMain } from './helpers/x-main.js';

describe('production tweet click handling', () => {
  let ctx;
  let originalOpen;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.happyDOM.setURL('https://x.com/search');
    originalOpen = window.open;
    window.open = mock(() => null);
    ctx = bootXMain({ memoryAware: false });
  });

  afterEach(() => {
    window.open = originalOpen;
    document.body.innerHTML = '';
  });

  it('opens the tweet permalink in a new tab', () => {
    const article = ctx.emit({ author: 'swyx', id: '123' });
    article.querySelector('[data-testid="tweetText"]').click();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith('https://x.com/swyx/status/123', '_blank');
  });

  it.each([{ author: null }, { id: null }])('ignores incomplete tweet data: %j', (data) => {
    ctx.emit(data).querySelector('[data-testid="tweetText"]').click();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('waits until a blurred tweet is revealed', () => {
    const article = ctx.emit();
    article.setAttribute('data-xrai-hidden', 'blur');
    const text = article.querySelector('[data-testid="tweetText"]');
    text.click();
    expect(window.open).not.toHaveBeenCalled();
    article.setAttribute('data-xrai-revealed', '1');
    text.click();
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('waits until classification is no longer pending', () => {
    const article = ctx.emit();
    article.setAttribute('data-xrai-pending', '1');
    const text = article.querySelector('[data-testid="tweetText"]');
    text.click();
    expect(window.open).not.toHaveBeenCalled();
    article.removeAttribute('data-xrai-pending');
    text.click();
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('does not reopen the current status page', () => {
    window.happyDOM.setURL('https://x.com/maker/status/tweet-1');
    ctx.emit().querySelector('[data-testid="tweetText"]').click();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(['like', 'retweet', 'reply', 'Tweet-User-Avatar', 'videoPlayer', 'tweetPhoto'])(
    'preserves clicks on %s controls', (testId) => {
      const article = ctx.emit();
      const control = document.createElement('div');
      control.setAttribute('data-testid', testId);
      article.querySelector('[data-testid="tweetText"]').appendChild(control);
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      control.dispatchEvent(click);
      expect(window.open).not.toHaveBeenCalled();
      expect(click.defaultPrevented).toBe(false);
    },
  );

  it('does not attach a second listener when a tweet is emitted again', () => {
    const article = ctx.emit();
    ctx.emit({}, article);
    article.querySelector('[data-testid="tweetText"]').click();
    expect(window.open).toHaveBeenCalledTimes(1);
  });
});
