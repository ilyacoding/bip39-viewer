/*
 * BIP39 Viewer: DOM wiring (spec section 5). Runs after lib.js in the same inline classic script,
 * at the end of <body>, so the DOM is complete.
 *
 * Two native scrollers: #list (words) and #reel (first letters). Only their scroll events move
 * anything. Passive pointerdown/touchstart/wheel/keydown listeners just tell us which strip the
 * user took hold of: no clicks, no coordinates, no preventDefault, no custom physics.
 */
(function () {
  'use strict';

  const Lib = self.Bip39Lib;
  const root = document.documentElement;
  const PASSIVE = { passive: true };
  const ENGAGE_EVENTS = ['pointerdown', 'touchstart', 'wheel', 'keydown'];
  const SW_URL = './sw.js';
  // Freeze hold (ms, and at least two frames). Two frames stop iOS momentum; Chrome only lets go
  // of a fling after its steps have been refused for a few frames.
  const HOLD_MS = 100;
  // A strip that moved this recently (ms) is being scrolled; geometry fixes leave it alone.
  const ACTIVE_MS = 150;
  const VERIFY_TEXT = {
    ok: '\u2713 Checked in your browser: these 2048 words hash to the SHA\u2011256 below, identical to english.txt in bitcoin/bips.',
    bad: '\u2717 Check failed: these words do not hash to the SHA\u2011256 below. Do not use this page.',
    unavailable: 'This browser cannot run the check here. Compare the SHA\u2011256 below with english.txt in bitcoin/bips.'
  };

  const byId = (id) => document.getElementById(id);
  const all = (el, selector) => Array.prototype.slice.call(el.querySelectorAll(selector));
  const now = () => performance.now();

  markFramed();
  try {
    history.scrollRestoration = 'manual';
  } catch (e) { /* not supported: nothing to restore anyway */ }
  const engine = Lib ? createEngine() : null;
  watchVisibility();
  verifyWordlist();
  registerServiceWorker();

  function markFramed() {
    let framed;
    try {
      framed = window.top !== window.self;
    } catch (e) {
      framed = true;
    }
    if (framed) root.classList.add('is-framed');
  }

  /* ---------- scroll engine ---------- */

  function createEngine() {
    const list = byId('list');
    const words = list ? all(list, '.w') : [];
    const N = words.length;
    if (!N) return null;

    const reel = byId('reel');
    const bits = byId('bits');
    const letters = reel ? all(reel, '.reel__l') : [];
    const L = letters.length;
    // first[k]: index of the first word of letter k, taken from the rendered sections.
    const first = all(list, '.sec').map((sec) => words.indexOf(sec.querySelector('.w')));
    const withReel = L > 0 && L === first.length && first[0] === 0 &&
      first.every((f, k) => k === 0 || f > first[k - 1]);

    const centers = new Float64Array(N); // list scrollTop that puts word i in the lens
    const bitsWidth = Math.max(1, Math.ceil(Math.log2(N)));
    const dCache = [];
    const frozen = { list: 0, reel: 0 }; // token of the strip's active freeze; 0 = not frozen
    const rested = { list: false, reel: false }; // a strip may have stopped off its place: check
    const timers = { list: 0, reel: 0 };
    let freezeSeq = 0;
    let maxList = 0;
    let notch = 0; // reel scrollTop per letter; 0 while the reel is not rendered
    let reelBase = 0; // reel scrollTop that centres letter 0 (0 under the CSS contract)
    let maxReel = 0;
    let dMax = 0; // letters farther away are off-screen; their --d stays pinned
    let sizeKey = '';
    let geometryDirty = false; // the viewport changed; positions are in flux until remeasure()
    let geometryToken = 0;

    let S = Lib.createState();
    let active = -1;
    let activeLetter = -1;
    let reelTarget = -1; // letter the reel was last sent to while following the list
    let reelSeen = 0; // reel letter at the last update: tells a moved reel from a moved list
    let alignTop = 0; // where alignReel() last put the reel...
    let alignChecks = 0; // ...and for how many more updates to make sure it stayed there
    let restKind = 'word'; // where the list last rested: on restWord, or at the 'top'/'bottom' end
    let restWord = 0;
    let frame = 0;

    let reduced = false;
    const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (motion) {
      reduced = motion.matches;
      const onMotion = (e) => { reduced = e.matches; };
      if (motion.addEventListener) motion.addEventListener('change', onMotion);
      else if (motion.addListener) motion.addListener(onMotion);
    }

    // Without a usable reel the no-js layout (no reel) stays; the list still works on its own.
    if (withReel) {
      root.classList.remove('no-js');
      root.classList.add('js');
    }

    // Every visit starts at "abandon".
    list.scrollTop = 0;
    if (withReel) reel.scrollTop = 0;
    measure();
    if (reelReady()) reel.scrollTop = reelTopFor(0);
    update();
    try {
      list.focus({ preventScroll: true }); // arrow keys and space scroll the list straight away
    } catch (e) { /* focus options unsupported */ }

    list.addEventListener('scroll', onListScroll, PASSIVE);
    ENGAGE_EVENTS.forEach((type) => list.addEventListener(type, engageList, PASSIVE));
    if (withReel) {
      reel.addEventListener('scroll', onReelScroll, PASSIVE);
      // keydown too: a mouse press focuses the reel (tabindex=-1), then arrow keys scroll it
      ENGAGE_EVENTS.forEach((type) => reel.addEventListener(type, engageReel, PASSIVE));
    }

    // resize fires before the scroll events of the same frame, so it flags the re-snap that
    // WebKit performs with the old viewport height before anything records it.
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => remeasure(false));
      observer.observe(list);
      if (withReel) observer.observe(reel);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => requestAnimationFrame(() => remeasure(true)), () => {});
    }

    return { restart: restart };

    /* geometry */

    function measure() {
      const h = list.clientHeight;
      if (!h) return false; // not rendered (e.g. framed): keep the last good geometry
      const base = list.scrollTop - list.getBoundingClientRect().top - list.clientTop - h / 2;
      for (let i = 0; i < N; i++) {
        const r = words[i].getBoundingClientRect();
        centers[i] = r.top + r.height / 2 + base;
      }
      maxList = Math.max(0, list.scrollHeight - h);
      if (withReel) measureReel();
      sizeKey = currentSizeKey();
      return true;
    }

    function measureReel() {
      const h = reel.clientHeight;
      const c0 = letterCenter(letters[0]);
      let step = L > 1 ? (letterCenter(letters[L - 1]) - c0) / (L - 1) : NaN;
      if (!(step > 0)) step = letters[0].offsetHeight;
      if (!h || !(step > 0)) {
        notch = 0;
        return;
      }
      notch = step;
      reelBase = Number.isFinite(c0) ? c0 - h / 2 : 0;
      maxReel = Math.max(0, reel.scrollHeight - h);
      dMax = Math.ceil(h / 2 / notch) + 2;
      dCache.length = 0;
    }

    // Letter centre in reel content coordinates. offsetTop ignores the fisheye transforms.
    function letterCenter(el) {
      let y = el.offsetHeight / 2;
      for (let e = el; e !== reel; e = e.offsetParent) {
        if (!e) return NaN;
        y += e.offsetTop;
      }
      return y;
    }

    function currentSizeKey() {
      return list.clientWidth + 'x' + list.clientHeight + '/' + (withReel ? reel.clientHeight : 0);
    }

    function reelReady() {
      return withReel && notch > 0;
    }

    function listTopFor(i) {
      return Lib.clamp(Math.round(centers[i]), 0, maxList);
    }

    function reelTopFor(k) {
      return Lib.clamp(Math.round(reelBase + k * notch), 0, maxReel);
    }

    // Programmatic scroll that the scroll handlers will recognise as ours.
    function setTop(which, top) {
      const el = which === 'list' ? list : reel;
      if (Math.abs(el.scrollTop - top) < 0.5) return;
      S = Lib.expectScroll(S, which, top);
      el.scrollTop = top;
    }

    function onViewportChange() {
      geometryDirty = true;
      requestAnimationFrame(() => remeasure(true));
    }

    function remeasure(force) {
      if ((force || currentSizeKey() !== sizeKey) && !measure()) return;
      restoreRest();
      // WebKit can re-snap once more after our first write, so write again a frame later.
      const token = ++geometryToken;
      requestAnimationFrame(() => {
        if (token !== geometryToken) return;
        restoreRest();
        geometryDirty = false;
        schedule();
      });
    }

    // Puts the list back where it rested before the geometry changed (the same word in the
    // lens, or the same end), and the reel on that word's letter.
    function restoreRest() {
      const t = now();
      if (t - S.lastMove.list < ACTIVE_MS || t - S.lastMove.reel < ACTIVE_MS) return;
      const top = restKind === 'word' ? listTopFor(restWord) : restKind === 'top' ? 0 : maxList;
      setTop('list', top);
      if (reelReady()) {
        const k = Lib.letterOf(restKind === 'word' ? restWord : Lib.nearestIndex(centers, top), first);
        setTop('reel', reelTopFor(k));
        reelTarget = k;
        reelSeen = k;
      }
    }

    /* driver */

    function commit(next) {
      const was = S.driver;
      S = next;
      if (next.driver === was) return;
      root.classList.toggle('is-reel-driving', next.driver === 'reel');
      if (next.driver === 'list') reelTarget = -1; // follow afresh from wherever the reel is
    }

    function engageList() {
      engage('list');
    }

    function engageReel() {
      engage('reel');
    }

    function engage(which) {
      thaw(which); // this strip must scroll under the user's finger right away
      const r = Lib.onEngage(S, which, now());
      commit(r.state);
      if (r.freeze) freeze(r.freeze);
      if (r.settle) settleReel();
      schedule();
    }

    function onListScroll() {
      if (geometryDirty) return; // WebKit re-snapping with the old viewport height, not the user
      const r = Lib.onListScroll(S, { now: now(), scrollTop: list.scrollTop });
      commit(r.state);
      if (r.coasting) recheck('list', Lib.COAST_MS);
      schedule();
    }

    function onReelScroll() {
      if (geometryDirty) return;
      const r = Lib.onReelScroll(S, { now: now(), scrollTop: reel.scrollTop });
      commit(r.state);
      if (r.coasting) recheck('reel', Lib.COAST_MS);
      schedule();
    }

    // Leftover momentum after a freeze can leave a strip off its place. Chrome's snap fling
    // cannot be stopped and wins any tug of war, so look again once the strip has been still.
    function recheck(which, ms) {
      clearTimeout(timers[which]);
      timers[which] = setTimeout(() => {
        rested[which] = true;
        schedule();
      }, Math.ceil(ms) + 20);
    }

    // Stops native momentum (a box that cannot scroll cannot coast) on the nearest snap position.
    // Held for at least two frames, since a style change made in one frame may never reach the
    // compositor, and for HOLD_MS.
    function freeze(which) {
      if (which === 'reel' && !reelReady()) return;
      const el = which === 'list' ? list : reel;
      const current = el.scrollTop;
      el.style.setProperty('overflow-y', 'hidden');
      let top;
      if (which === 'list') {
        top = listTopFor(Lib.nearestIndex(centers, current));
      } else {
        reelTarget = Lib.reelIndexAt(current, notch, L, reelBase);
        top = reelTopFor(reelTarget);
      }
      S = Lib.onFreeze(S, which, top, now());
      if (Math.abs(current - top) >= 0.5) el.scrollTop = top;
      const token = ++freezeSeq;
      const start = now();
      let frames = 0;
      frozen[which] = token;
      const tick = () => {
        if (frozen[which] !== token) return;
        if (++frames >= 2 && now() - start >= HOLD_MS) thaw(which);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    function thaw(which) {
      if (!frozen[which]) return;
      frozen[which] = 0;
      (which === 'list' ? list : reel).style.removeProperty('overflow-y');
      schedule();
    }

    // The reel may still be gliding after the list; start the user's grab from the list's letter.
    function settleReel() {
      if (!reelReady()) return;
      alignReel(Lib.letterOf(Lib.nearestIndex(centers, list.scrollTop), first));
    }

    // Puts letter k in the lens at once (an instant write also cancels a smooth scroll).
    function alignReel(k) {
      const top = reelTopFor(k);
      if (Math.abs(reel.scrollTop - top) >= 0.5) {
        S = Lib.expectScroll(S, 'reel', top);
        reel.scrollTop = top;
        // Chrome adds the cancelled glide's in-flight step on top of the write, then stops
        // off the notch. Too soon for a user drag (touch slop), so just write it again.
        alignTop = top;
        alignChecks = 2;
      }
      reelSeen = k;
      return (top - reelBase) / notch;
    }

    /* rendering: one frame per burst of scroll events */

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    function update() {
      frame = 0;
      if (geometryDirty) return; // remeasure() puts things back, then schedules this again
      // Read both positions before any write, so no write forces a layout.
      let listTop = list.scrollTop;
      let reelTop = reelReady() ? reel.scrollTop : 0;
      let a = Lib.nearestIndex(centers, listTop);

      if (rested.list) {
        rested.list = false;
        const wait = S.coasting.list - now();
        if (wait > 0) {
          recheck('list', wait);
        } else if (Math.abs(listTop - centers[a]) > 1 && listTop > 1 && listTop < maxList - 1) {
          // A freeze in Chrome can leave the list between two words: finish the snap.
          const top = listTopFor(a);
          S = Lib.onFreeze(S, 'list', top, now()); // the glide is ours, not the user's
          list.scrollTo({ top: top, behavior: reduced ? 'auto' : 'smooth' });
        }
      }

      if (reelReady()) {
        let pos = (reelTop - reelBase) / notch;
        if (alignChecks > 0) {
          alignChecks--;
          const off = Math.abs(reelTop - alignTop);
          if (off >= 0.5 && off < notch / 2) {
            S = Lib.expectScroll(S, 'reel', alignTop);
            reel.scrollTop = alignTop;
            reelTop = alignTop;
            pos = (alignTop - reelBase) / notch;
          }
        }
        if (S.driver === 'reel') {
          const k = Lib.clamp(Math.round(pos), 0, L - 1);
          const listLetter = Lib.letterOf(a, first);
          if (k !== listLetter && k !== reelSeen) {
            // The reel moved to another letter. Jump, don't animate: the reel is the animation.
            a = first[k];
            listTop = listTopFor(a);
            S = Lib.expectScroll(S, 'list', listTop);
            list.scrollTop = listTop;
          } else if (k !== listLetter) {
            // Only the list moved: leftover momentum that a freeze could not stop (Chrome's snap
            // fling). Until the user moves the reel, the reel reflects the list.
            pos = alignReel(listLetter);
          }
        } else if (!frozen.reel) {
          const k = Lib.letterOf(a, first);
          const top = reelTopFor(k);
          const off = Math.abs(reelTop - top) >= 0.5;
          if (k !== reelTarget || (off && rested.reel)) {
            const wait = S.coasting.reel - now();
            if (wait > 0) {
              recheck('reel', wait); // leftover momentum after a freeze: let it end first
            } else if (off) {
              S = Lib.expectScroll(S, 'reel', top);
              reel.scrollTo({ top: top, behavior: reduced ? 'auto' : 'smooth' });
              if (reduced) pos = (top - reelBase) / notch;
            }
          }
          reelTarget = k;
          rested.reel = false;
        }
        paintReel(pos);
        reelSeen = Lib.clamp(Math.round(pos), 0, L - 1);
      }

      setActive(a);
      // Remember where the list rests, to put it back after a geometry change.
      if (Math.abs(listTop - centers[a]) <= 1) {
        restKind = 'word';
        restWord = a;
      } else if (listTop <= 1) {
        restKind = 'top';
      } else if (listTop >= maxList - 1) {
        restKind = 'bottom';
      }
    }

    function setActive(a) {
      if (a === active) return;
      if (active >= 0) words[active].classList.remove('is-active');
      words[a].classList.add('is-active');
      active = a;
      if (bits) bits.textContent = Lib.toBits(a, bitsWidth);
    }

    function paintReel(pos) {
      for (let i = 0; i < L; i++) {
        const d = Lib.fisheye(i, pos, dMax);
        if (d !== dCache[i]) {
          dCache[i] = d;
          letters[i].style.setProperty('--d', d);
        }
      }
      const k = Lib.clamp(Math.round(pos), 0, L - 1);
      if (k !== activeLetter) {
        if (activeLetter >= 0) letters[activeLetter].classList.remove('is-active');
        letters[k].classList.add('is-active');
        activeLetter = k;
      }
    }

    // Back/forward cache: a returning visit starts at "abandon" like any other.
    function restart() {
      commit(Lib.createState());
      restKind = 'word';
      restWord = 0;
      setTop('list', 0);
      if (reelReady()) {
        setTop('reel', reelTopFor(0));
        reelTarget = 0;
        reelSeen = 0;
      }
      schedule();
    }
  }

  /* ---------- privacy ---------- */

  // Blank the page while it is hidden, so app-switcher snapshots show no words (best effort).
  function watchVisibility() {
    const veil = (on) => root.classList.toggle('is-veiled', on);
    document.addEventListener('visibilitychange', () => veil(document.visibilityState === 'hidden'));
    window.addEventListener('pagehide', () => veil(true));
    window.addEventListener('pageshow', (e) => {
      veil(document.visibilityState === 'hidden');
      if (e.persisted && engine) engine.restart();
    });
  }

  /* ---------- integrity ---------- */

  // Hash exactly the words on screen and compare with the SHA-256 of english.txt baked in at build.
  function verifyWordlist() {
    const out = byId('verify');
    const list = byId('list');
    if (!out || !list) return;
    const show = (state) => {
      out.dataset.state = state;
      out.textContent = VERIFY_TEXT[state];
    };
    const subtle = window.crypto && window.crypto.subtle; // secure contexts only
    if (!Lib || !subtle || typeof TextEncoder !== 'function') {
      show('unavailable');
      return;
    }
    const text = Lib.listText(all(list, '.w__t').map((el) => el.textContent));
    let digest;
    try {
      digest = subtle.digest('SHA-256', new TextEncoder().encode(text));
    } catch (e) {
      show('unavailable');
      return;
    }
    digest.then((buf) => {
      if (Lib.bytesToHex(buf) === String(list.dataset.sha256 || '').toLowerCase()) {
        show('ok');
        return;
      }
      show('bad');
      const alarm = byId('alarm');
      if (alarm) alarm.hidden = false;
    }, () => show('unavailable'));
  }

  /* ---------- offline ---------- */

  // Trusted Types are enforced, so the worker URL must come from our one policy, which allows
  // exactly SW_URL and nothing else.
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    let url = SW_URL;
    const tt = window.trustedTypes;
    if (tt && typeof tt.createPolicy === 'function') {
      try {
        url = tt.createPolicy('bip39', {
          createScriptURL: (value) => {
            if (value !== SW_URL) throw new TypeError('bip39: script URL not allowed');
            return value;
          }
        }).createScriptURL(SW_URL);
      } catch (e) {
        return;
      }
    }
    const register = () => {
      try {
        navigator.serviceWorker.register(url, { scope: './' }).catch(() => {});
      } catch (e) { /* e.g. storage blocked: stay online-only */ }
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
})();
