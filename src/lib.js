/*
 * BIP39 Viewer: pure logic, no DOM (spec section 5).
 * UMD: module.exports in Node (unit tests), self.Bip39Lib in the browser.
 *
 * The driver rules decide which of the two native scrollers is in charge: the word list or the
 * letter reel. They are reducers: (state, input) -> { state, ...decisions }, never mutating input.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.Bip39Lib = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A strip that moved this recently (ms) may still be coasting on native momentum.
  const FREEZE_MS = 120;
  // After this long without moving (ms), the reel no longer owns the list.
  const REEL_IDLE_MS = 300;
  // Programmatic positions come back rounded to device pixels and re-snapped (px).
  const ECHO_PX = 1.5;
  // A frozen strip can still report leftover motion: Chrome applies one more fling step on top of
  // the freeze position, then re-snaps. Its scroll events count as leftover until it has been
  // still this long (ms).
  const COAST_MS = 300;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // First index in [lo, hi) whose element is >= value.
  function lowerBound(sorted, value, lo, hi) {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the element nearest to `value` in an ascending array. Ties go to the lower index; -1 if empty. */
  function nearestIndex(sorted, value) {
    const n = sorted ? sorted.length : 0;
    if (n === 0) return -1;
    const j = lowerBound(sorted, value, 0, n);
    if (j === 0) return 0;
    const below = sorted[j - 1];
    if (j < n && sorted[j] - value < value - below) return j;
    return lowerBound(sorted, below, 0, j - 1); // first of any equal values
  }

  /** Letter k of word `index`, given each letter's first word index in ascending order; -1 if none. */
  function letterOf(index, first) {
    const n = first ? first.length : 0;
    if (n === 0) return -1;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (first[mid] <= index) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? lo - 1 : 0;
  }

  /** Lowercase hex of an ArrayBuffer, a typed array/Buffer, or an array of byte values. */
  function bytesToHex(bytes) {
    const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      // toString instead of instanceof: a buffer from another realm is still a buffer
      : Object.prototype.toString.call(bytes) === '[object ArrayBuffer]' ? new Uint8Array(bytes)
        : Uint8Array.from(bytes);
    let hex = '';
    for (let i = 0; i < u8.length; i++) hex += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return hex;
  }

  /** The text english.txt holds for these words: one per line, with a trailing newline. */
  function listText(words) {
    return words.join('\n') + '\n';
  }

  /* ---------- driver rules ---------- */

  function createState() {
    return {
      driver: 'list', // the strip that positions the other one
      lastEngaged: null, // the strip the user last pressed, touched, wheeled or keyed
      lastMove: { list: -Infinity, reel: -Infinity }, // time of each strip's last user-made move
      expect: { list: null, reel: null }, // target scrollTop of our own pending programmatic move
      coasting: { list: -Infinity, reel: -Infinity } // until when a frozen strip's motion is leftover
    };
  }

  function copy(s) {
    return {
      driver: s.driver,
      lastEngaged: s.lastEngaged,
      lastMove: { list: s.lastMove.list, reel: s.lastMove.reel },
      expect: { list: s.expect.list, reel: s.expect.reel },
      coasting: { list: s.coasting.list, reel: s.coasting.reel }
    };
  }

  function checkStrip(which) {
    if (which !== 'list' && which !== 'reel') throw new TypeError('strip must be "list" or "reel"');
  }

  /** True when a scroll event only reports a position we set ourselves. */
  function isEcho(scrollTop, expected, tol = ECHO_PX) {
    return expected !== null && expected !== undefined && Math.abs(scrollTop - expected) <= tol;
  }

  /** Records a programmatic move of `which` to `top`, so its scroll events are not taken for the user's. */
  function expectScroll(state, which, top) {
    checkStrip(which);
    const s = copy(state);
    s.expect[which] = top;
    return s;
  }

  /**
   * The user took hold of a strip (passive pointerdown/touchstart/wheel/keydown on it).
   * freeze: the other strip, if it is still coasting and must be stopped on its nearest snap.
   * settle: the reel was following the list; align it with the list's letter first, so that
   *         grabbing the reel never moves the list by itself.
   */
  function onEngage(state, which, now) {
    checkStrip(which);
    const s = copy(state);
    s.lastEngaged = which;
    s.expect[which] = null; // whatever we were animating there, the user owns it now
    s.coasting[which] = -Infinity;
    let freeze = null;
    let settle = false;
    if (state.driver !== which) {
      const other = which === 'list' ? 'reel' : 'list';
      if (now - state.lastMove[other] <= FREEZE_MS) freeze = other;
      settle = which === 'reel';
      s.driver = which;
    }
    return { state: s, freeze: freeze, settle: settle };
  }

  /**
   * We stopped `which` on `top` because the user took hold of the other strip (or we are gliding
   * it onto the snap position such a freeze missed). Until it has been still for COAST_MS,
   * whatever it still does is leftover momentum or our glide, not the user's.
   */
  function onFreeze(state, which, top, now) {
    checkStrip(which);
    const s = copy(state);
    s.expect[which] = top;
    s.coasting[which] = now + COAST_MS;
    return s;
  }

  /**
   * A list scroll event. Echoes of our own jumps and leftover motion after a freeze change no
   * driver. Anything else is the user's (touch, wheel, keyboard, scrollbar, assistive tech); it
   * hands the list back the lead unless the reel is still being worked.
   */
  function onListScroll(state, input) {
    if (isEcho(input.scrollTop, state.expect.list)) return { state: state, echo: true, coasting: false };
    const s = copy(state);
    if (input.now <= state.coasting.list) {
      s.coasting.list = input.now + COAST_MS;
      return { state: s, echo: false, coasting: true };
    }
    s.expect.list = null;
    s.lastMove.list = input.now;
    if (s.driver === 'reel' && (s.lastEngaged === 'list' || input.now - s.lastMove.reel > REEL_IDLE_MS)) {
      s.driver = 'list';
    }
    return { state: s, echo: false, coasting: false };
  }

  /**
   * A reel scroll event. Leftover motion after a freeze is not the user's, and while one of our
   * moves is pending every event belongs to it: a smooth scroll passes through positions far from
   * its target. The user can only move the reel after engaging it, which clears both.
   */
  function onReelScroll(state, input) {
    const target = state.expect.reel;
    const landed = isEcho(input.scrollTop, target);
    if (input.now <= state.coasting.reel) {
      const s = copy(state);
      s.coasting.reel = input.now + COAST_MS;
      if (landed) s.expect.reel = null;
      return { state: s, programmatic: false, coasting: true };
    }
    if (target !== null) {
      if (!landed) return { state: state, programmatic: true, coasting: false };
      const done = copy(state);
      done.expect.reel = null;
      return { state: done, programmatic: true, coasting: false };
    }
    const s = copy(state);
    s.lastMove.reel = input.now;
    if (s.driver !== 'reel' && s.lastEngaged === 'reel') s.driver = 'reel';
    return { state: s, programmatic: false, coasting: false };
  }

  /* ---------- reel geometry ---------- */

  /** Letter nearest the reel's centre for a reel scrollTop (letter k is centred at base + k * notch); -1 if unknown. */
  function reelIndexAt(scrollTop, notch, count, base = 0) {
    if (!(notch > 0) || !(count > 0)) return -1;
    return clamp(Math.round((scrollTop - base) / notch), 0, count - 1);
  }

  /** Fisheye --d for letter i at reel position pos (in notches): the distance, capped, 2 decimals. */
  function fisheye(i, pos, max = Infinity) {
    const d = Math.abs(i - pos);
    return (d > max ? max : d).toFixed(2);
  }

  return Object.freeze({
    FREEZE_MS: FREEZE_MS,
    REEL_IDLE_MS: REEL_IDLE_MS,
    ECHO_PX: ECHO_PX,
    COAST_MS: COAST_MS,
    clamp: clamp,
    nearestIndex: nearestIndex,
    letterOf: letterOf,
    bytesToHex: bytesToHex,
    listText: listText,
    isEcho: isEcho,
    createState: createState,
    expectScroll: expectScroll,
    onEngage: onEngage,
    onFreeze: onFreeze,
    onListScroll: onListScroll,
    onReelScroll: onReelScroll,
    reelIndexAt: reelIndexAt,
    fisheye: fisheye
  });
}));
