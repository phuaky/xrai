import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load detector source
const detectorSrc = readFileSync(join(import.meta.dir, '../extension/content/detector.js'), 'utf8');

// We need to extract the pure functions. The IIFE only exposes onTweet/start/stop,
// but we can eval a modified version that also exposes internal helpers for testing.
function loadDetectorInternals() {
  // Patch the IIFE to expose internals
  const patched = detectorSrc
    .replace(
      'return {\n    onTweet: onTweet,\n    start: start,\n    stop: stop\n  };',
      'return {\n    onTweet: onTweet,\n    start: start,\n    stop: stop,\n    _extractTweetId: extractTweetId,\n    _extractAuthor: extractAuthor,\n    _extractData: extractData\n  };'
    )
    .replace(/var XraiDetector\s*=\s*/, '');
  return eval(patched);
}

function createTweetArticle(author, tweetId) {
  const article = document.createElement('article');
  article.setAttribute('data-testid', 'tweet');

  // Author link
  const authorLink = document.createElement('a');
  authorLink.setAttribute('href', '/' + author);
  article.appendChild(authorLink);

  // Status link (with time element)
  const statusLink = document.createElement('a');
  statusLink.setAttribute('href', '/' + author + '/status/' + tweetId);
  statusLink.href = 'https://x.com/' + author + '/status/' + tweetId;
  const timeEl = document.createElement('time');
  timeEl.textContent = '2h';
  statusLink.appendChild(timeEl);
  article.appendChild(statusLink);

  // Tweet text
  const textDiv = document.createElement('div');
  textDiv.setAttribute('data-testid', 'tweetText');
  textDiv.textContent = 'This is a test tweet';
  article.appendChild(textDiv);

  return article;
}

describe('XraiDetector internals', () => {
  let detector;

  detector = loadDetectorInternals();

  describe('extractTweetId', () => {
    it('extracts tweet ID from status link', () => {
      const article = createTweetArticle('testuser', '1234567890');
      const id = detector._extractTweetId(article);
      expect(id).toBe('1234567890');
    });

    it('returns null for tweets without status links', () => {
      const article = document.createElement('article');
      article.innerHTML = '<div>No links here</div>';
      const id = detector._extractTweetId(article);
      expect(id).toBeNull();
    });

    it('extracts ID from time element parent link as fallback', () => {
      const article = document.createElement('article');
      const link = document.createElement('a');
      link.href = 'https://x.com/user/status/9876543210';
      const time = document.createElement('time');
      time.textContent = '3h';
      link.appendChild(time);
      article.appendChild(link);
      const id = detector._extractTweetId(article);
      expect(id).toBe('9876543210');
    });
  });

  describe('extractAuthor', () => {
    it('extracts author handle from profile link', () => {
      const article = createTweetArticle('swyx', '123');
      const author = detector._extractAuthor(article);
      expect(author).toBe('swyx');
    });

    it('returns null when no profile links exist', () => {
      const article = document.createElement('article');
      const link = document.createElement('a');
      link.setAttribute('href', 'https://external.com');
      article.appendChild(link);
      const author = detector._extractAuthor(article);
      expect(author).toBeNull();
    });
  });

  describe('permalink construction', () => {
    it('can construct a valid permalink from extracted data', () => {
      const article = createTweetArticle('elonmusk', '1799999999999');
      const data = detector._extractData(article);
      expect(data).not.toBeNull();
      const permalink = 'https://x.com/' + data.author + '/status/' + data.id;
      expect(permalink).toBe('https://x.com/elonmusk/status/1799999999999');
    });

    it('extractData returns null for tweets without IDs', () => {
      const article = document.createElement('article');
      article.innerHTML = '<div>No tweet data</div>';
      const data = detector._extractData(article);
      expect(data).toBeNull();
    });
  });
});
