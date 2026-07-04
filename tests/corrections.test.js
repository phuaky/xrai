import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load the hider IIFE the same way hider.test.js does
const hiderSrc = readFileSync(join(import.meta.dir, '../extension/content/core/hider.js'), 'utf8');

function loadHider() {
  const stripped = hiderSrc.replace(/var RaiHider\s*=\s*/, '');
  return eval(stripped);
}

function createCard() {
  const el = document.createElement('article');
  const child = document.createElement('div');
  child.textContent = 'Tweet content';
  el.appendChild(child);
  return el;
}

describe('wrong button (one-tap corrections)', () => {
  let RaiHider;

  beforeEach(() => {
    RaiHider = loadHider();
  });

  it('renders once and fires the callback on click, then removes itself', () => {
    const el = createCard();
    let fired = 0;
    RaiHider.addWrongButton(el, () => fired++);
    RaiHider.addWrongButton(el, () => fired++); // second attach is a no-op
    const btns = el.querySelectorAll('.xrai-wrong-btn');
    expect(btns.length).toBe(1);
    btns[0].click();
    expect(fired).toBe(1);
    expect(el.querySelector('.xrai-wrong-btn')).toBeNull();
    // after removal, a new button can be attached (e.g. corrected card re-hidden)
    RaiHider.addWrongButton(el, () => fired++);
    expect(el.querySelector('.xrai-wrong-btn')).not.toBeNull();
  });

  it('click reaches the button through the blur click-guard', () => {
    const el = createCard();
    document.body.appendChild(el);
    RaiHider.hide(el, 'blur', 'AI: noise');
    let fired = 0;
    RaiHider.addWrongButton(el, () => fired++);
    // Dispatch a real bubbling click so the capture-phase guard runs first
    el.querySelector('.xrai-wrong-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(fired).toBe(1);
    el.remove();
  });

  it('show() cleans up the wrong button along with blur artifacts', () => {
    const el = createCard();
    RaiHider.hide(el, 'blur', 'AI: noise');
    RaiHider.addWrongButton(el, () => {});
    RaiHider.show(el);
    expect(el.querySelector('.xrai-wrong-btn')).toBeNull();
    expect(el.querySelector('.xrai-peek-btn')).toBeNull();
    expect(el.getAttribute('data-xrai-hidden')).toBeNull();
  });
});
