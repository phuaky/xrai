// Attention ledger — /watch time tracking (no Ollama, no real timers).
// Pinned invariants: time accrues only when the tab is visible AND the video
// is playing AND playback actually advanced AND no ad is showing; partial
// records carry CUMULATIVE seconds (MAX-collapse downstream); nav re-keys
// finalize the old video exactly once; autoplay flicks (<2s) are dropped.
import { describe, it, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const watchSrc = readFileSync(join(import.meta.dir, '../extension/content/youtube/watch.js'), 'utf8');

let logged = [];
let flushes = 0;

globalThis.RaiMemory = {
  logEvent: (r) => logged.push(r),
  mirrorEvent: () => {},
  flushMirror: () => flushes++,
};

function loadWatch() {
  const patched = watchSrc
    .replace(
      'return { init: init };',
      'return { init: init, _onNav: onNav, _tick: tick, _finalize: finalize, _getCur: function () { return cur; } };'
    )
    .replace(/var YtraiWatch\s*=\s*/, '');
  return eval(patched);
}

function setupPlayer() {
  document.body.innerHTML = '';
  const player = document.createElement('div');
  player.id = 'movie_player';
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  let t = 0;
  Object.defineProperty(video, 'currentTime', { get: () => t, set: (v) => { t = v; }, configurable: true });
  Object.defineProperty(video, 'paused', { value: false, writable: true, configurable: true });
  player.appendChild(video);
  document.body.appendChild(player);
  return { player, video };
}

// One accrual step: advance playback, then tick.
function play(watch, video, secs) {
  for (let i = 0; i < secs / 2; i++) {
    video.currentTime = video.currentTime + 2;
    watch._tick();
  }
}

describe('YtraiWatch', () => {
  let watch, player, video;
  beforeEach(() => {
    logged = [];
    flushes = 0;
    ({ player, video } = setupPlayer());
    window.happyDOM.setURL('https://www.youtube.com/watch?v=abc123'); // about:blank can't take pushState paths
    document.title = 'Blinding Lights - YouTube';
    watch = loadWatch();
    watch._onNav();
    watch._tick(); // first tick only primes lastTime — no accrual
  });

  it('accrues fixed 2s per tick while playing and title is captured', () => {
    play(watch, video, 6);
    expect(watch._getCur().seconds).toBe(6);
    expect(watch._getCur().title).toBe('Blinding Lights');
  });

  it('does not accrue when paused', () => {
    video.paused = true;
    play(watch, video, 4);
    expect(watch._getCur().seconds).toBe(0);
  });

  it('does not accrue during an ad', () => {
    player.classList.add('ad-showing');
    play(watch, video, 4);
    expect(watch._getCur().seconds).toBe(0);
  });

  it('does not accrue in a background tab (background music ≠ attention)', () => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    play(watch, video, 4);
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    expect(watch._getCur().seconds).toBe(0);
  });

  it('does not accrue when playback time is not advancing (stall/buffer)', () => {
    watch._tick(); // currentTime unchanged
    watch._tick();
    expect(watch._getCur().seconds).toBe(0);
  });

  it('nav to a new video finalizes the old one exactly once, then tracks the new id', () => {
    play(watch, video, 6);
    history.pushState({}, '', '/watch?v=def456');
    watch._onNav();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ kind: 'watch', videoId: 'abc123', seconds: 6, partial: false });
    expect(flushes).toBe(1);
    expect(watch._getCur().videoId).toBe('def456');
  });

  it('drops autoplay flicks below the 2s floor', () => {
    history.pushState({}, '', '/');
    watch._tick(); // off /watch → finalize with 0s
    expect(logged.length).toBe(0);
  });

  it('emits cumulative partials every 30s; final record is the MAX', () => {
    play(watch, video, 34);
    const partials = logged.filter((r) => r.partial);
    expect(partials.length).toBe(1);
    expect(partials[0].seconds).toBe(30);
    play(watch, video, 4);
    watch._finalize();
    const final = logged.find((r) => !r.partial);
    expect(final.seconds).toBe(38);
    expect(Math.max(...logged.map((r) => r.seconds))).toBe(final.seconds);
  });
});
