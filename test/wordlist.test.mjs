// wordlist/english.txt: every property the site relies on (SPEC §1), checked independently of the build,
// plus the build's validateWordlist() on the real file and on damaged copies of it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { validateWordlist, WORD_COUNT, WORDLIST_SHA256 } from '../scripts/build.mjs';

const OFFICIAL_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
const BYTES = readFileSync(new URL('../wordlist/english.txt', import.meta.url));
const TEXT = BYTES.toString('utf8');
const WORDS = TEXT.split('\n').slice(0, -1);

// SPEC §1: words per first letter, and the 0-based index of each letter's first word.
const COUNTS = {
  a: 136, b: 117, c: 186, d: 112, e: 100, f: 106, g: 76, h: 64, i: 55, j: 20, k: 20, l: 76, m: 105,
  n: 41, o: 55, p: 132, q: 8, r: 108, s: 250, t: 121, u: 35, v: 46, w: 69, y: 6, z: 4,
};
const FIRST = {
  a: 0, b: 136, c: 253, d: 439, e: 551, f: 651, g: 757, h: 833, i: 897, j: 952, k: 972, l: 992, m: 1068,
  n: 1173, o: 1214, p: 1269, q: 1401, r: 1409, s: 1517, t: 1767, u: 1888, v: 1923, w: 1969, y: 2038, z: 2044,
};

describe('wordlist/english.txt', () => {
  test('has the sha256 of the official BIP39 English list', () => {
    assert.equal(createHash('sha256').update(BYTES).digest('hex'), OFFICIAL_SHA256);
    assert.equal(WORDLIST_SHA256, OFFICIAL_SHA256, 'the build checks against the same hash');
  });

  test('contains only a-z and LF bytes (ASCII, no BOM, no CR, no spaces)', () => {
    const bad = BYTES.findIndex((b) => b !== 0x0a && (b < 0x61 || b > 0x7a));
    assert.equal(bad, -1, `unexpected byte 0x${BYTES[bad]?.toString(16)} at offset ${bad}`);
  });

  test('ends with exactly one newline', () => {
    assert.ok(TEXT.endsWith('\n'));
    assert.ok(!TEXT.endsWith('\n\n'));
  });

  test(`has exactly ${WORD_COUNT} lines (2^11, so every 0-based index fits in 11 bits)`, () => {
    assert.equal(WORD_COUNT, 2048);
    assert.equal(WORDS.length, 2048);
    assert.equal(TEXT.match(/\n/g).length, 2048);
    assert.equal(2 ** 11, WORDS.length);
  });

  test('every line is 3 to 8 lowercase letters', () => {
    for (const [i, word] of WORDS.entries()) assert.match(word, /^[a-z]{3,8}$/, `line ${i + 1}`);
    const lengths = new Set(WORDS.map((w) => w.length));
    assert.deepEqual([...lengths].sort(), [3, 4, 5, 6, 7, 8]);
  });

  test('is strictly ascending (sorted, no duplicates)', () => {
    for (let i = 1; i < WORDS.length; i++) assert.ok(WORDS[i - 1] < WORDS[i], `line ${i + 1}: ${WORDS[i - 1]} !< ${WORDS[i]}`);
    assert.equal(new Set(WORDS).size, WORDS.length);
  });

  test('the first four letters identify every word uniquely', () => {
    const prefixes = new Map();
    for (const [i, word] of WORDS.entries()) {
      const prefix = word.slice(0, 4);
      assert.ok(!prefixes.has(prefix), `line ${i + 1} ${word} shares "${prefix}" with ${prefixes.get(prefix)}`);
      prefixes.set(prefix, word);
    }
  });

  test('has 25 first letters (every letter but x) with the per-letter counts from the spec', () => {
    const counts = {};
    for (const word of WORDS) counts[word[0]] = (counts[word[0]] ?? 0) + 1;
    assert.deepEqual(counts, COUNTS);
    assert.equal(Object.keys(counts).length, 25);
    assert.equal(Object.keys(counts).join(''), 'abcdefghijklmnopqrstuvwyz');
    assert.equal(Object.values(COUNTS).reduce((a, b) => a + b, 0), 2048);
  });

  test('each letter starts at the 0-based index from the spec, and its words are contiguous', () => {
    for (const [letter, first] of Object.entries(FIRST)) {
      assert.equal(WORDS.findIndex((w) => w[0] === letter), first, `first "${letter}" word`);
      const last = first + COUNTS[letter] - 1;
      assert.equal(WORDS.findLastIndex((w) => w[0] === letter), last, `last "${letter}" word`);
      assert.ok(WORDS.slice(first, last + 1).every((w) => w[0] === letter));
    }
  });

  test('starts with "abandon" and ends with "zoo"; spot checks of 1-based line numbers', () => {
    assert.equal(WORDS[0], 'abandon');
    assert.equal(WORDS[2047], 'zoo');
    assert.equal(WORDS.indexOf('access') + 1, 11);
    assert.equal(WORDS.indexOf('baby') + 1, 137);
    assert.equal(WORDS.indexOf('zero') + 1, 2046);
  });
});

describe('validateWordlist()', () => {
  const lines = (words) => `${words.join('\n')}\n`;
  const replaceLine = (n, word) => lines(WORDS.map((w, i) => (i === n - 1 ? word : w)));

  test('accepts the real file as a Buffer or a string and returns its words and sha256', () => {
    for (const input of [BYTES, TEXT]) {
      const { words, sha256 } = validateWordlist(input);
      assert.deepEqual(words, WORDS);
      assert.equal(sha256, OFFICIAL_SHA256);
    }
  });

  test('rejects CR line endings', () => {
    assert.throws(() => validateWordlist(TEXT.replace(/\n/g, '\r\n')), /line 1 contains a carriage return/);
    assert.throws(() => validateWordlist(TEXT.replace('\nzoo\n', '\nzoo\r\n')), /line 2048 contains a carriage return/);
  });

  test('rejects a missing or doubled trailing newline', () => {
    assert.throws(() => validateWordlist(TEXT.slice(0, -1)), /must end with a newline/);
    assert.throws(() => validateWordlist(`${TEXT}\n`), /exactly one newline/);
  });

  test('rejects a missing, extra or blank line', () => {
    assert.throws(() => validateWordlist(lines(WORDS.slice(1))), /expected exactly 2048 lines, found 2047/);
    assert.throws(() => validateWordlist(lines([...WORDS, 'zoom'])), /found 2049/);
    assert.throws(() => validateWordlist(lines(['abandon', '', ...WORDS.slice(1)])), /found 2049/);
  });

  test('rejects words that are not 3 to 8 lowercase letters', () => {
    assert.throws(() => validateWordlist(replaceLine(5, 'Above')), /line 5: "Above" does not match/);
    assert.throws(() => validateWordlist(replaceLine(10, 'ab')), /line 10: "ab" does not match/);
    assert.throws(() => validateWordlist(replaceLine(8, 'abstracts')), /line 8: "abstracts" does not match/);
    assert.throws(() => validateWordlist(replaceLine(2, 'abil ity')), /line 2: "abil ity" does not match/);
    assert.throws(() => validateWordlist(`﻿${TEXT}`), /line 1: "\\ufeffabandon" does not match/);
  });

  test('rejects unsorted or duplicate words', () => {
    const swapped = [...WORDS];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.throws(() => validateWordlist(lines(swapped)), /line 3: "ability" does not sort strictly after "able"/);
    assert.throws(() => validateWordlist(replaceLine(2, 'abandon')), /line 2: "abandon" does not sort strictly after "abandon"/);
  });

  test('rejects two words with the same first four letters', () => {
    // "abandons" keeps the list sorted (abandon < abandons < able) but repeats the prefix "aban".
    assert.throws(() => validateWordlist(replaceLine(2, 'abandons')), /line 2: "abandons" has the same first four letters \("aban"\) as line 1/);
  });

  test('rejects a well-formed list that is not the official one (sha256)', () => {
    // "zoos" keeps every structural property, so only the hash can catch it.
    assert.throws(() => validateWordlist(replaceLine(2048, 'zoos')), /sha256 is [0-9a-f]{64}, expected 2f5eed53/);
  });

  test('errors are BuildErrors that name the file', () => {
    assert.throws(() => validateWordlist(''), (err) => err.name === 'BuildError' && err.message.startsWith('wordlist/english.txt: '));
  });
});
