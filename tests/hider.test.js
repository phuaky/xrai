import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load the IIFE source and eval in a context with a mock document
const hiderSrc = readFileSync(join(import.meta.dir, '../extension/content/hider.js'), 'utf8');

function createMockElement() {
  const el = document.createElement('article');
  // Add some child content
  const child1 = document.createElement('div');
  child1.textContent = 'Tweet content';
  el.appendChild(child1);
  return el;
}

function loadHider() {
  // Strip the var assignment so eval returns the IIFE result
  const stripped = hiderSrc.replace(/var XraiHider\s*=\s*/, '');
  return eval(stripped);
}

describe('XraiHider', () => {
  let XraiHider;

  beforeEach(() => {
    XraiHider = loadHider();
  });

  describe('hide() with blur method', () => {
    it('creates a peek button overlay', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      expect(el.getAttribute('data-xrai-hidden')).toBe('blur');
      const btn = el.querySelector('.xrai-peek-btn');
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe('👁 Show');
    });

    it('does not set _xraiBlurHandler on the element', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      expect(el._xraiBlurHandler).toBeUndefined();
    });

    it('sets position relative on element for button positioning', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      expect(el.style.position).toBe('relative');
    });
  });

  describe('peek button toggle', () => {
    it('clicking button reveals tweet (sets data-xrai-revealed)', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      const btn = el.querySelector('.xrai-peek-btn');
      btn.click();

      expect(el.hasAttribute('data-xrai-revealed')).toBe(true);
      expect(btn.textContent).toBe('Hide');
    });

    it('clicking button again re-hides tweet', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      const btn = el.querySelector('.xrai-peek-btn');
      btn.click(); // reveal
      btn.click(); // hide again

      expect(el.hasAttribute('data-xrai-revealed')).toBe(false);
      expect(btn.textContent).toBe('👁 Show');
    });

    it('rapid toggling does not break state', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      const btn = el.querySelector('.xrai-peek-btn');
      for (let i = 0; i < 20; i++) {
        btn.click();
      }
      // 20 clicks = even number = back to hidden
      expect(el.hasAttribute('data-xrai-revealed')).toBe(false);
      expect(btn.textContent).toBe('👁 Show');
    });
  });

  describe('clicking element does NOT toggle blur', () => {
    it('clicking the article element itself does not change state', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      // Clicking the element should not toggle anything
      el.click();

      expect(el.hasAttribute('data-xrai-revealed')).toBe(false);
      expect(el.querySelector('.xrai-peek-btn').textContent).toBe('👁 Show');
    });
  });

  describe('show()', () => {
    it('removes peek button and blur attributes', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');

      // Reveal first
      el.querySelector('.xrai-peek-btn').click();

      XraiHider.show(el);

      expect(el.querySelector('.xrai-peek-btn')).toBeNull();
      expect(el.hasAttribute('data-xrai-hidden')).toBe(false);
      expect(el.hasAttribute('data-xrai-revealed')).toBe(false);
      expect(el._xraiPeekBtn).toBeUndefined();
    });
  });

  describe('other hide methods still work', () => {
    it('remove method sets display none', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'remove');

      expect(el.style.display).toBe('none');
      expect(el.querySelector('.xrai-peek-btn')).toBeNull();
    });

    it('collapse method sets height and adds click handler', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'collapse');

      expect(el.style.height).toBe('4px');
      expect(el._xraiExpandHandler).toBeDefined();
      expect(el.querySelector('.xrai-peek-btn')).toBeNull();
    });
  });

  describe('skip already hidden', () => {
    it('does not double-hide an element', () => {
      const el = createMockElement();
      XraiHider.hide(el, 'blur');
      XraiHider.hide(el, 'blur'); // second call

      const buttons = el.querySelectorAll('.xrai-peek-btn');
      expect(buttons.length).toBe(1);
    });
  });
});
