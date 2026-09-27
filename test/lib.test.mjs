import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Lib = require('../src/lib.js');

// First word index of each first letter (a b c d e f g h i j k l m n o p q r s t u v w y z), spec section 1.
const FIRST = [0, 136, 253, 439, 551, 651, 757, 833, 897, 952, 972, 992, 1068, 1173, 1214, 1269, 1401, 1409,
  1517, 1767, 1888, 1923, 1969, 2038, 2044];
const LETTERS = 'abcdefghijklmnopqrstuvwyz';
const WORDLIST = readFileSync(new URL('../wordlist/english.txt', import.meta.url), 'utf8');
const WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

function bruteNearest(a, v) {
  let best = -1;
  for (let i = 0; i < a.length; i++) {
    if (best < 0 || Math.abs(a[i] - v) < Math.abs(a[best] - v)) best = i;
  }
  return best;
}

describe('module shape', () => {
  it('exports a frozen API', () => {
    assert.ok(Object.isFrozen(Lib));
    for (const name of ['clamp', 'nearestIndex', 'letterOf', 'bytesToHex', 'listText', 'isEcho',
      'createState', 'expectScroll', 'onEngage', 'onFreeze', 'onListScroll', 'onReelScroll', 'reelIndexAt', 'fisheye']) {
      assert.equal(typeof Lib[name], 'function', name);
    }
    assert.equal(Lib.FREEZE_MS, 120);
    assert.equal(Lib.REEL_IDLE_MS, 300);
    assert.equal(Lib.ECHO_PX, 1.5);
    assert.equal(Lib.COAST_MS, 300);
  });
});

describe('clamp', () => {
  it('limits to the range', () => {
    assert.equal(Lib.clamp(5, 0, 10), 5);
    assert.equal(Lib.clamp(-1, 0, 10), 0);
    assert.equal(Lib.clamp(11, 0, 10), 10);
    assert.equal(Lib.clamp(0, 0, 0), 0);
  });
});

describe('nearestIndex', () => {
  const a = [0, 48, 96, 144];

  it('returns -1 for empty input', () => {
    assert.equal(Lib.nearestIndex([], 5), -1);
    assert.equal(Lib.nearestIndex(new Float64Array(0), 5), -1);
    assert.equal(Lib.nearestIndex(null, 5), -1);
  });

  it('handles a single element', () => {
    assert.equal(Lib.nearestIndex([7], -100), 0);
    assert.equal(Lib.nearestIndex([7], 7), 0);
    assert.equal(Lib.nearestIndex([7], 100), 0);
  });

  it('finds exact values and the edges', () => {
    a.forEach((v, i) => assert.equal(Lib.nearestIndex(a, v), i));
    assert.equal(Lib.nearestIndex(a, 0.4), 0);
    assert.equal(Lib.nearestIndex(a, 143.6), 3);
  });

  it('clamps values beyond both ends', () => {
    assert.equal(Lib.nearestIndex(a, -1e9), 0);
    assert.equal(Lib.nearestIndex(a, -0.1), 0);
    assert.equal(Lib.nearestIndex(a, 144.1), 3);
    assert.equal(Lib.nearestIndex(a, 1e9), 3);
    assert.equal(Lib.nearestIndex(a, Infinity), 3);
    assert.equal(Lib.nearestIndex(a, -Infinity), 0);
  });

  it('sends ties to the lower index', () => {
    assert.equal(Lib.nearestIndex(a, 24), 0);
    assert.equal(Lib.nearestIndex(a, 24.001), 1);
    assert.equal(Lib.nearestIndex(a, 23.999), 0);
    assert.equal(Lib.nearestIndex(a, 120), 2);
    assert.equal(Lib.nearestIndex([0, 10], 5), 0);
  });

  it('returns the first of equal values', () => {
    assert.equal(Lib.nearestIndex([1, 1, 1], 1), 0);
    assert.equal(Lib.nearestIndex([1, 1, 1], 5), 0);
    assert.equal(Lib.nearestIndex([0, 5, 5, 9], 5), 1);
    assert.equal(Lib.nearestIndex([0, 5, 5], 6), 1);
    assert.equal(Lib.nearestIndex([0, 5, 5, 20], 6), 1);
  });

  it('works on typed arrays with fractional centres', () => {
    const centers = Float64Array.from({ length: 2048 }, (_, i) => i * 48 + 0.33);
    assert.equal(Lib.nearestIndex(centers, 0), 0);
    assert.equal(Lib.nearestIndex(centers, 1068 * 48), 1068);
    assert.equal(Lib.nearestIndex(centers, 1068 * 48 + 24.33), 1068); // exact midpoint: lower
    assert.equal(Lib.nearestIndex(centers, 1068 * 48 + 24.34), 1069);
    assert.equal(Lib.nearestIndex(centers, 5e6), 2047);
  });

  it('agrees with a linear scan on random inputs', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rnd() * 40);
      const arr = Array.from({ length: n }, () => Math.round(rnd() * 200)).sort((x, y) => x - y);
      const v = Math.round(rnd() * 440 - 20) / 2;
      assert.equal(Lib.nearestIndex(arr, v), bruteNearest(arr, v), `arr=${arr} v=${v}`);
    }
  });
});

describe('letterOf', () => {
  it('maps every first index to its letter and its predecessor to the previous letter', () => {
    FIRST.forEach((f, k) => {
      assert.equal(Lib.letterOf(f, FIRST), k, `first of ${LETTERS[k]}`);
      if (k > 0) assert.equal(Lib.letterOf(f - 1, FIRST), k - 1, `last before ${LETTERS[k]}`);
    });
    assert.equal(Lib.letterOf(2047, FIRST), 24);
  });

  it('matches the first letter of every word in english.txt', () => {
    const words = WORDLIST.trimEnd().split('\n');
    assert.equal(words.length, 2048);
    words.forEach((w, i) => assert.equal(LETTERS[Lib.letterOf(i, FIRST)], w[0], `${i} ${w}`));
    FIRST.forEach((f, k) => assert.equal(words.findIndex((w) => w[0] === LETTERS[k]), f));
  });

  it('clamps out-of-range indexes and handles empty tables', () => {
    assert.equal(Lib.letterOf(-5, FIRST), 0);
    assert.equal(Lib.letterOf(99999, FIRST), 24);
    assert.equal(Lib.letterOf(3, []), -1);
  });
});

describe('bytesToHex and listText', () => {
  it('hex-encodes bytes, lowercase and zero-padded', () => {
    assert.equal(Lib.bytesToHex(new Uint8Array([0, 1, 15, 16, 171, 255])), '00010f10abff');
    assert.equal(Lib.bytesToHex(new Uint8Array([222, 173, 190, 239]).buffer), 'deadbeef');
    assert.equal(Lib.bytesToHex([1, 2, 254]), '0102fe');
    assert.equal(Lib.bytesToHex(new Uint8Array(0)), '');
  });

  it('respects typed-array views into a larger buffer', () => {
    const buf = new Uint8Array([9, 9, 0xca, 0xfe, 9]).buffer;
    assert.equal(Lib.bytesToHex(new Uint8Array(buf, 2, 2)), 'cafe');
    assert.equal(Lib.bytesToHex(new DataView(buf, 2, 2)), 'cafe');
  });

  it('matches node:crypto digests', () => {
    const digest = createHash('sha256').update('abc').digest();
    assert.equal(Lib.bytesToHex(digest), digest.toString('hex'));
    assert.equal(Lib.bytesToHex(digest), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rebuilds english.txt byte for byte from the words, so the page can verify it', () => {
    const words = WORDLIST.trimEnd().split('\n');
    const text = Lib.listText(words);
    assert.equal(text, WORDLIST);
    assert.equal(Lib.bytesToHex(createHash('sha256').update(text, 'utf8').digest()), WORDLIST_SHA256);
  });
});

describe('reel geometry helpers', () => {
  it('reelIndexAt rounds to the nearest notch and clamps', () => {
    assert.equal(Lib.reelIndexAt(0, 56, 25), 0);
    assert.equal(Lib.reelIndexAt(27.9, 56, 25), 0);
    assert.equal(Lib.reelIndexAt(28, 56, 25), 1);
    assert.equal(Lib.reelIndexAt(12 * 56, 56, 25), 12);
    assert.equal(Lib.reelIndexAt(-40, 56, 25), 0);
    assert.equal(Lib.reelIndexAt(99999, 56, 25), 24);
    assert.equal(Lib.reelIndexAt(66, 56, 25, 10), 1);
    assert.equal(Lib.reelIndexAt(10, 0, 25), -1);
    assert.equal(Lib.reelIndexAt(10, 56, 0), -1);
  });

  it('fisheye gives the distance in notches with 2 decimals, capped', () => {
    assert.equal(Lib.fisheye(3, 3), '0.00');
    assert.equal(Lib.fisheye(3, 1.25), '1.75');
    assert.equal(Lib.fisheye(0, 1.5), '1.50');
    assert.equal(Lib.fisheye(24, 0, 10), '10.00');
    assert.equal(Lib.fisheye(24, 20, 10), '4.00');
  });

  it('isEcho uses the tolerance and ignores a missing expectation', () => {
    assert.equal(Lib.isEcho(100, null), false);
    assert.equal(Lib.isEcho(100, undefined), false);
    assert.equal(Lib.isEcho(100, 100), true);
    assert.equal(Lib.isEcho(101.5, 100), true);
    assert.equal(Lib.isEcho(98.5, 100), true);
    assert.equal(Lib.isEcho(101.6, 100), false);
    assert.equal(Lib.isEcho(0, 0), true);
    assert.equal(Lib.isEcho(3, 0, 5), true);
  });
});

describe('driver rules', () => {
  const fresh = () => deepFreeze(Lib.createState());

  it('starts with the list driving and nothing pending', () => {
    const s = Lib.createState();
    assert.equal(s.driver, 'list');
    assert.equal(s.lastEngaged, null);
    assert.deepEqual(s.expect, { list: null, reel: null });
    assert.deepEqual(s.coasting, { list: -Infinity, reel: -Infinity });
    assert.equal(s.lastMove.list, -Infinity);
    assert.equal(s.lastMove.reel, -Infinity);
  });

  it('engaging the reel while the list moved recently freezes the list', () => {
    let s = Lib.onListScroll(fresh(), { now: 1000, scrollTop: 500 }).state;
    const r = Lib.onEngage(deepFreeze(s), 'reel', 1000 + Lib.FREEZE_MS);
    assert.equal(r.freeze, 'list');
    assert.equal(r.settle, true);
    assert.equal(r.state.driver, 'reel');
    assert.equal(r.state.lastEngaged, 'reel');
  });

  it('engaging the reel after the list came to rest freezes nothing', () => {
    const s = deepFreeze(Lib.onListScroll(fresh(), { now: 1000, scrollTop: 500 }).state);
    const r = Lib.onEngage(s, 'reel', 1000 + Lib.FREEZE_MS + 1);
    assert.equal(r.freeze, null);
    assert.equal(r.settle, true);
    assert.equal(r.state.driver, 'reel');
  });

  it('engaging the list while the reel is coasting freezes the reel', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(deepFreeze(s), { now: 500, scrollTop: 300 }).state;
    const r = Lib.onEngage(deepFreeze(s), 'list', 560);
    assert.equal(r.freeze, 'reel');
    assert.equal(r.settle, false);
    assert.equal(r.state.driver, 'list');
    assert.equal(r.state.lastEngaged, 'list');
  });

  it('engaging the strip that already drives changes nothing but lastEngaged', () => {
    const s = deepFreeze(Lib.onListScroll(fresh(), { now: 1000, scrollTop: 500 }).state);
    const r = Lib.onEngage(s, 'list', 1001);
    assert.equal(r.freeze, null);
    assert.equal(r.settle, false);
    assert.equal(r.state.driver, 'list');
    assert.equal(r.state.lastEngaged, 'list');
  });

  it('ignores a list echo', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(s, { now: 10, scrollTop: 56 }).state;
    s = deepFreeze(Lib.expectScroll(s, 'list', 6528));
    const r = Lib.onListScroll(s, { now: 2000, scrollTop: 6529.2 });
    assert.equal(r.echo, true);
    assert.equal(r.state, s); // same object: nothing changed
    assert.equal(r.state.driver, 'reel');
    assert.equal(r.state.expect.list, 6528);
    assert.equal(r.state.lastMove.list, -Infinity);
  });

  it('a non-echo list scroll clears the expectation and records the move', () => {
    const s = deepFreeze(Lib.expectScroll(fresh(), 'list', 6528));
    const r = Lib.onListScroll(s, { now: 50, scrollTop: 6540 });
    assert.equal(r.echo, false);
    assert.equal(r.state.expect.list, null);
    assert.equal(r.state.lastMove.list, 50);
  });

  it('a list non-echo scroll after engaging the list gives driver list', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(s, { now: 20, scrollTop: 112 }).state;
    s = Lib.onEngage(s, 'list', 40).state;
    const r = Lib.onListScroll(deepFreeze(s), { now: 60, scrollTop: 900 });
    assert.equal(r.state.driver, 'list');

    // The rule itself, even while the reel is still moving: the list was engaged last.
    const reelDrives = deepFreeze({ ...Lib.createState(), driver: 'reel', lastEngaged: 'list',
      lastMove: { list: -Infinity, reel: 59 } });
    assert.equal(Lib.onListScroll(reelDrives, { now: 60, scrollTop: 900 }).state.driver, 'list');
  });

  it('a list non-echo scroll while the reel drives but has been idle > 300 ms gives driver list', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = deepFreeze(Lib.onReelScroll(s, { now: 100, scrollTop: 56 }).state);
    assert.equal(s.driver, 'reel');
    assert.equal(Lib.onListScroll(s, { now: 100 + Lib.REEL_IDLE_MS, scrollTop: 900 }).state.driver, 'reel');
    const r = Lib.onListScroll(s, { now: 100 + Lib.REEL_IDLE_MS + 1, scrollTop: 900 });
    assert.equal(r.state.driver, 'list');
    assert.equal(r.state.lastEngaged, 'reel');
  });

  it('keeps the reel driving while the reel is actively moving', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    for (let t = 16; t <= 480; t += 16) {
      s = Lib.onReelScroll(s, { now: t, scrollTop: t }).state;
      s = Lib.onListScroll(s, { now: t + 1, scrollTop: 10000 + t }).state; // not an echo
      assert.equal(s.driver, 'reel', `t=${t}`);
    }
  });

  it('a reel scroll with lastEngaged reel gives driver reel', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(s, { now: 10, scrollTop: 56 }).state;
    s = Lib.onListScroll(s, { now: 1000, scrollTop: 400 }).state; // idle reel: list takes over
    assert.equal(s.driver, 'list');
    assert.equal(s.lastEngaged, 'reel');
    const r = Lib.onReelScroll(deepFreeze(s), { now: 1100, scrollTop: 90 });
    assert.equal(r.programmatic, false);
    assert.equal(r.state.driver, 'reel');
    assert.equal(r.state.lastMove.reel, 1100);
  });

  it('a reel scroll without the reel engaged leaves the list driving', () => {
    const r = Lib.onReelScroll(fresh(), { now: 5, scrollTop: 30 });
    assert.equal(r.programmatic, false);
    assert.equal(r.state.driver, 'list');
  });

  it('treats reel scrolls as ours while a programmatic move is pending, until it lands', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(s, { now: 10, scrollTop: 56 }).state;
    s = Lib.onListScroll(s, { now: 1000, scrollTop: 400 }).state; // list drives, lastEngaged still reel
    s = deepFreeze(Lib.expectScroll(s, 'reel', 672)); // smooth follow towards letter 12
    const mid = Lib.onReelScroll(s, { now: 1016, scrollTop: 300 });
    assert.equal(mid.programmatic, true);
    assert.equal(mid.state, s);
    assert.equal(mid.state.driver, 'list'); // our own animation must not hand the lead to the reel
    const landed = Lib.onReelScroll(mid.state, { now: 1300, scrollTop: 671.5 });
    assert.equal(landed.programmatic, true);
    assert.equal(landed.state.expect.reel, null);
    assert.equal(landed.state.lastMove.reel, 10);
  });

  it('engaging the reel cancels our pending reel move and asks to settle it', () => {
    const s = deepFreeze(Lib.expectScroll(fresh(), 'reel', 672));
    const r = Lib.onEngage(s, 'reel', 5);
    assert.equal(r.state.expect.reel, null);
    assert.equal(r.settle, true);
    assert.equal(r.state.driver, 'reel');
    // after that, reel scrolls are the user's
    const moved = Lib.onReelScroll(r.state, { now: 20, scrollTop: 500 });
    assert.equal(moved.programmatic, false);
    assert.equal(moved.state.lastMove.reel, 20);
  });

  it('leftover list motion after a freeze does not hand the lead back to the list', () => {
    // Seen in Chrome: the first event after the freeze write carries one more fling step.
    let s = Lib.onListScroll(fresh(), { now: 1000, scrollTop: 1793 }).state;
    const r = Lib.onEngage(s, 'reel', 1010);
    assert.equal(r.freeze, 'list');
    s = deepFreeze(Lib.onFreeze(r.state, 'list', 1776, 1012));
    assert.equal(s.expect.list, 1776);
    const ghost = Lib.onListScroll(s, { now: 1024, scrollTop: 1780 });
    assert.equal(ghost.coasting, true);
    assert.equal(ghost.echo, false);
    assert.equal(ghost.state.driver, 'reel'); // the reel has never moved, yet it keeps the lead
    assert.equal(ghost.state.lastMove.list, 1000); // not a user move
    assert.equal(ghost.state.expect.list, 1776); // the snap back is still an echo
    assert.equal(ghost.state.coasting.list, 1024 + Lib.COAST_MS);
    const back = Lib.onListScroll(ghost.state, { now: 1200, scrollTop: 1776.4 });
    assert.equal(back.echo, true);
    // after COAST_MS of stillness the list's own moves count again (e.g. assistive tech)
    const later = Lib.onListScroll(back.state, { now: 1024 + Lib.COAST_MS + 1, scrollTop: 2000 });
    assert.equal(later.coasting, false);
    assert.equal(later.state.driver, 'list');
  });

  it('engaging a frozen strip ends its coasting', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onFreeze(s, 'list', 480, 5);
    s = deepFreeze(Lib.onEngage(s, 'list', 20).state);
    assert.equal(s.coasting.list, -Infinity);
    assert.equal(s.expect.list, null);
    const r = Lib.onListScroll(s, { now: 30, scrollTop: 500 });
    assert.equal(r.coasting, false);
    assert.equal(r.state.lastMove.list, 30);
    assert.equal(r.state.driver, 'list');
  });

  it('leftover reel motion after a freeze is not the user\'s', () => {
    let s = Lib.onEngage(fresh(), 'reel', 0).state;
    s = Lib.onReelScroll(s, { now: 500, scrollTop: 690 }).state;
    const r = Lib.onEngage(s, 'list', 560);
    assert.equal(r.freeze, 'reel');
    s = deepFreeze(Lib.onFreeze(r.state, 'reel', 672, 561));
    const ghost = Lib.onReelScroll(s, { now: 575, scrollTop: 700 });
    assert.equal(ghost.coasting, true);
    assert.equal(ghost.state.driver, 'list');
    assert.equal(ghost.state.lastMove.reel, 500);
    assert.equal(ghost.state.expect.reel, 672);
    const landed = Lib.onReelScroll(ghost.state, { now: 700, scrollTop: 672 });
    assert.equal(landed.state.expect.reel, null);
    assert.equal(landed.state.driver, 'list');
  });

  it('rejects unknown strips', () => {
    assert.throws(() => Lib.onEngage(fresh(), 'page', 0), TypeError);
    assert.throws(() => Lib.expectScroll(fresh(), 'x', 0), TypeError);
    assert.throws(() => Lib.onFreeze(fresh(), 'y', 0, 0), TypeError);
  });
});
