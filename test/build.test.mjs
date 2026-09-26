// scripts/build.mjs, and scripts/serve.mjs serving its output.
// Builds run from temporary fixture roots (the real wordlist and template plus stub CSS/JS/sw.js/static files) so
// these tests do not depend on source files that are still being written. The last test builds the real repo
// once all of its sources exist, and is skipped until then. Fixtures live in os.tmpdir(), never under test/.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertSafeOutDir, build, buildCsp, computeVersion, fillTemplate, groupHex, renderList, renderReel,
  renderServiceWorker, WORDLIST_SHA256,
} from '../scripts/build.mjs';
import { contentType, resolveRequestPath, startServer } from '../scripts/serve.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORDLIST = await fs.readFile(path.join(REPO, 'wordlist', 'english.txt'), 'utf8');
const WORDS = WORDLIST.split('\n').slice(0, -1);
const LETTERS = [...new Set(WORDS.map((w) => w[0]))];
const TEMPLATE = await fs.readFile(path.join(REPO, 'src', 'index.html'), 'utf8');
const GROUPED_SHA = '2f5eed53 a4727b4b f8880d8f 3f199efc 90e58503 646d9ff8 eff3a2ed 3b24dbda';
const EMPTY_SHA256_B64 = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

// SPEC §3, verbatim, with the two hash sources left open.
const CSP_SHAPE =
  "default-src 'none'; script-src 'sha256-{SCRIPT}'; style-src 'sha256-{STYLE}'; img-src 'self'; manifest-src 'self'; " +
  "worker-src 'self'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; " +
  "child-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types bip39";
const FIXED_DIRECTIVES = {
  'default-src': "'none'", 'img-src': "'self'", 'manifest-src': "'self'", 'worker-src': "'self'",
  'connect-src': "'none'", 'font-src': "'none'", 'media-src': "'none'", 'object-src': "'none'",
  'frame-src': "'none'", 'child-src': "'none'", 'form-action': "'none'", 'base-uri': "'none'",
  'require-trusted-types-for': "'script'", 'trusted-types': 'bip39',
};

// Stubs. The CSS and JS contain `$&`-style sequences, which must come out literally (one-pass replacement).
const STUB_SW = 'const VERSION = "__BIP39_VERSION__";\nconst ASSETS = ["__BIP39_ASSETS__"];\nself.addEventListener("install", () => {});\n';
const STUB = {
  'src/styles.css': ':root { --row: 48px; }\n/* $& $1 $$ $` $\' stay literal */\n.w__t b { font-weight: 600; }\n.head__meta::before { content: "\\00b7"; }\n',
  'src/lib.js':
    "(function (root, factory) {\n  if (typeof module === 'object' && module.exports) module.exports = factory();\n" +
    "  else root.Bip39Lib = factory();\n}(typeof self !== 'undefined' ? self : this, function () {\n" +
    "  'use strict';\n  return { literal: '$& $1 $$' };\n}));\n",
  'src/app.js': "(function () {\n  'use strict';\n  document.documentElement.classList.replace('no-js', 'js');\n}());\n",
  'src/sw.js': STUB_SW,
  'src/static/CNAME': 'bip39.uuid.me\n',
  'src/static/manifest.webmanifest': `${JSON.stringify({ name: 'BIP39 Wordlist', start_url: './', icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }] }, null, 2)}\n`,
  'src/static/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n',
  'src/static/apple-touch-icon.png': Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  'src/static/robots.txt': 'User-agent: *\nAllow: /\n',
  'src/static/.DS_Store': 'dotfiles are not copied',
};
const STUB_STATIC = Object.keys(STUB).filter((k) => k.startsWith('src/static/')).map((k) => k.slice('src/static/'.length));

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const TMP_DIRS = [];
after(() => Promise.all(TMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function tmpDir(prefix = 'bip39-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/** A temporary project root: real wordlist + template, stub sources; `overrides` replace files (null deletes). */
async function makeFixture(overrides = {}) {
  const root = await tmpDir('bip39-fixture-');
  const files = { 'wordlist/english.txt': WORDLIST, 'src/index.html': TEMPLATE, ...STUB, ...overrides };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

async function readDist(dir) {
  const names = (await fs.readdir(dir)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await fs.readFile(path.join(dir, name))])));
}

const b64 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

/** Separates <style>/<script> raw text from the markup ("skeleton") the way an HTML parser does. */
function splitPage(html) {
  const inline = { style: [], script: [] };
  let skeleton = '';
  let from = 0;
  const open = /<(style|script)\b[^>]*>/gi;
  for (let m; (m = open.exec(html)); ) {
    const tag = m[1].toLowerCase();
    const start = m.index + m[0].length;
    const close = new RegExp(`</${tag}`, 'gi');
    close.lastIndex = start;
    const end = close.exec(html)?.index;
    assert.ok(end !== undefined, `unterminated <${tag}>`);
    inline[tag].push({ open: m[0], text: html.slice(start, end) });
    skeleton += html.slice(from, start);
    from = end;
    open.lastIndex = end;
  }
  return { ...inline, skeleton: skeleton + html.slice(from) };
}

/** Exactly one inline <style> and <script>, a CSP <meta> placed first whose hashes match them. */
function checkInlineAndCsp(html) {
  const page = splitPage(html);
  assert.equal(page.style.length, 1, 'exactly one <style> element');
  assert.equal(page.script.length, 1, 'exactly one <script> element');
  assert.equal(page.style[0].open, '<style>');
  assert.equal(page.script[0].open, '<script>', 'a classic inline script (no src, type or nonce)');
  const style = page.style[0].text;
  const script = page.script[0].text;
  assert.doesNotMatch(style + script, /\r/, 'no CR in inline code (browsers normalise it before hashing)');
  const metas = [...page.skeleton.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  assert.equal(metas.length, 1, 'exactly one CSP <meta>');
  const csp = metas[0][1];
  assert.equal(csp, CSP_SHAPE.replace('{SCRIPT}', b64(script)).replace('{STYLE}', b64(style)));
  const cspAt = metas[0].index;
  for (const tag of ['<link', '<style', '<script', '<body']) {
    assert.ok(cspAt < page.skeleton.indexOf(tag), `the CSP <meta> comes before the first ${tag}`);
  }
  return { skeleton: page.skeleton, style, script, csp };
}

const FORBIDDEN = [
  [/<input\b/i, '<input>'],
  [/<textarea\b/i, '<textarea>'],
  [/<select\b/i, '<select>'],
  [/<button\b/i, '<button>'],
  [/<form\b/i, '<form>'],
  [/<a[\s>]/i, '<a>'],
  [/contenteditable/i, 'contenteditable'],
  [/<iframe\b/i, '<iframe>'],
  [/<script\b[^>]*\bsrc\s*=/i, '<script src>'],
  [/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i, '<link rel="stylesheet">'],
  [/\b(?:src|href|srcset|action|formaction|poster)\s*=\s*["']?\s*(?:https?:|\/\/)/i, 'an external src/href'],
  [/\son[a-z]+\s*=/i, 'an inline event handler'],
];

function checkNoForbidden(markup) {
  for (const [re, what] of FORBIDDEN) {
    const m = re.exec(markup);
    assert.equal(m, null, `forbidden ${what} near: ${m && markup.slice(Math.max(0, m.index - 40), m.index + 60)}`);
  }
}

/** Parses {{LIST}} line by line (one element per line) between </header> and <footer class="outro">. */
function parseList(markup) {
  const head = '</header>\n';
  const foot = '\n<footer class="outro">';
  const a = markup.indexOf(head);
  const b = markup.indexOf(foot);
  assert.ok(a !== -1 && b > a, 'the list sits between </header> and <footer class="outro">');
  const lines = markup.slice(a + head.length, b).split('\n');
  let i = 0;
  const take = (re, what) => {
    const line = lines[i++];
    const m = re.exec(line ?? '');
    assert.ok(m, `list line ${i}: expected ${what}, got ${JSON.stringify(line)}`);
    return m;
  };
  const sections = [];
  while (i < lines.length) {
    const s = take(/^<section class="sec" data-letter="([a-z])" aria-labelledby="h-([a-z])">$/, '<section class="sec">');
    const h = take(/^<h2 class="head" id="h-([a-z])"><span class="head__l">([A-Z])<\/span><span class="head__meta">([^<]*)<\/span><\/h2>$/, '<h2 class="head">');
    const o = take(/^<ol class="words" start="(\d+)">$/, '<ol class="words">');
    const items = [];
    while (lines[i]?.startsWith('<li')) {
      const m = take(/^<li class="(w|w w--g)"><span class="w__n">(\d+)<\/span><span class="w__t">(.*)<\/span><\/li>$/, '<li class="w">');
      items.push({ group: m[1] === 'w w--g', n: Number(m[2]), inner: m[3] });
    }
    take(/^<\/ol>$/, '</ol>');
    take(/^<\/section>$/, '</section>');
    sections.push({ letter: s[1], labelledBy: s[2], headId: h[1], headLetter: h[2], meta: h[3], start: Number(o[1]), items });
  }
  return sections;
}

/** The whole list contract for `words`; returns the parsed sections for spot checks. */
function checkList(markup, words) {
  const sections = parseList(markup);
  const letters = [...new Set(words.map((w) => w[0]))];
  assert.deepEqual(sections.map((s) => s.letter), letters, 'one section per first letter, in order');
  const items = sections.flatMap((s) => s.items);
  assert.equal(items.length, words.length, 'one li.w per word');
  let index = 0;
  for (const s of sections) {
    const count = s.items.length;
    assert.equal(s.labelledBy, s.letter);
    assert.equal(s.headId, s.letter);
    assert.equal(s.headLetter, s.letter.toUpperCase());
    assert.equal(s.start, index + 1, `<ol start> of ${s.letter}`);
    assert.equal(s.meta, `${count} words \u00b7 ${index + 1}\u2013${index + count}`, `head__meta of ${s.letter}`);
    s.items.forEach((item, j) => {
      const n = index + j;
      const word = words[n];
      assert.equal(item.n, n + 1, `number of ${word}`);
      assert.doesNotMatch(item.inner, /\s/, `no whitespace inside .w__t of ${word}`);
      assert.equal(item.inner.replace(/<\/?b>/g, ''), word, `.w__t text of #${n + 1}`);
      assert.equal(item.inner, `<b>${word.slice(0, 4)}</b>${word.slice(4)}`, `<b> prefix of ${word}`);
      const groupStart = j > 0 && word.slice(0, 2) !== words[n - 1].slice(0, 2);
      assert.equal(item.group, groupStart, `w--g on #${n + 1} ${word}`);
    });
    index += count;
  }
  return sections;
}

function checkReel(markup, words) {
  const m = /<div class="reel__track" id="reelTrack">(.*?)<\/div>/.exec(markup);
  assert.ok(m, 'reel track present');
  const letters = [...new Set(words.map((w) => w[0]))];
  assert.equal(m[1], letters.map((l) => `<span class="reel__l">${l.toUpperCase()}</span>`).join(''), 'reel letters and nothing else');
  return letters.length;
}

function checkShaMarkers(markup) {
  assert.equal(markup.split(`data-sha256="${WORDLIST_SHA256}"`).length, 2, 'data-sha256 on the list');
  assert.ok(markup.includes(GROUPED_SHA), 'grouped sha256 in the footer');
}

const expectedAssets = (staticNames) =>
  ['./', ...staticNames.filter((n) => !n.startsWith('.') && n !== 'CNAME' && n !== 'robots.txt').sort().map(encodeURIComponent)];

/** dist/sw.js is exactly src/sw.js with the two placeholders replaced. */
function checkServiceWorker(sw, source, version, assets) {
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(sw, /__BIP39_/);
  assert.ok(assets.includes('./') && assets.includes('manifest.webmanifest'));
  assert.ok(!assets.includes('CNAME') && !assets.includes('robots.txt'));
  const expected = source
    .split('"__BIP39_VERSION__"').join(JSON.stringify(version))
    .split('["__BIP39_ASSETS__"]').join(JSON.stringify(assets));
  assert.equal(sw, expected);
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

describe('build helpers', () => {
  test('groupHex() splits into space-separated groups of 8', () => {
    assert.equal(groupHex(WORDLIST_SHA256), GROUPED_SHA);
    assert.equal(groupHex('abc'), 'abc');
    assert.throws(() => groupHex('not hex'), TypeError);
  });

  test('buildCsp() is the exact spec policy with base64 sha256 hashes', () => {
    const empty = buildCsp('', '');
    assert.equal(empty, CSP_SHAPE.replace('{SCRIPT}', EMPTY_SHA256_B64).replace('{STYLE}', EMPTY_SHA256_B64));
    const csp = buildCsp('a{}', 'var x;');
    assert.ok(csp.includes(`script-src 'sha256-${b64('var x;')}'`));
    assert.ok(csp.includes(`style-src 'sha256-${b64('a{}')}'`));
  });

  test('renderList() produces the spec markup', () => {
    const words = ['abandon', 'ability', 'access', 'act', 'baby', 'bacon', 'zone', 'zoo'];
    assert.equal(renderList(words), [
      '<section class="sec" data-letter="a" aria-labelledby="h-a">',
      '<h2 class="head" id="h-a"><span class="head__l">A</span><span class="head__meta">4 words · 1–4</span></h2>',
      '<ol class="words" start="1">',
      '<li class="w"><span class="w__n">1</span><span class="w__t"><b>aban</b>don</span></li>',
      '<li class="w"><span class="w__n">2</span><span class="w__t"><b>abil</b>ity</span></li>',
      '<li class="w w--g"><span class="w__n">3</span><span class="w__t"><b>acce</b>ss</span></li>',
      '<li class="w"><span class="w__n">4</span><span class="w__t"><b>act</b></span></li>',
      '</ol>',
      '</section>',
      '<section class="sec" data-letter="b" aria-labelledby="h-b">',
      '<h2 class="head" id="h-b"><span class="head__l">B</span><span class="head__meta">2 words · 5–6</span></h2>',
      '<ol class="words" start="5">',
      '<li class="w"><span class="w__n">5</span><span class="w__t"><b>baby</b></span></li>',
      '<li class="w"><span class="w__n">6</span><span class="w__t"><b>baco</b>n</span></li>',
      '</ol>',
      '</section>',
      '<section class="sec" data-letter="z" aria-labelledby="h-z">',
      '<h2 class="head" id="h-z"><span class="head__l">Z</span><span class="head__meta">2 words · 7–8</span></h2>',
      '<ol class="words" start="7">',
      '<li class="w"><span class="w__n">7</span><span class="w__t"><b>zone</b></span></li>',
      '<li class="w"><span class="w__n">8</span><span class="w__t"><b>zoo</b></span></li>',
      '</ol>',
      '</section>',
    ].join('\n'));
    assert.match(renderList(['abandon']), /[\u00b7][\s\S]*[\u2013]/, 'middle dot and en dash are the real characters');
  });

  test('renderList()/renderReel() refuse unsorted groups and anything but a-z', () => {
    assert.throws(() => renderList(['baby', 'abandon', 'bacon']), /not contiguous/);
    assert.throws(() => renderList(['ab<i>']), /invalid word/);
    assert.throws(() => renderReel([]), /non-empty/);
  });

  test('renderReel() is 25 letter spans with nothing between them', () => {
    assert.equal(renderReel(WORDS), [...'ABCDEFGHIJKLMNOPQRSTUVWYZ'].map((l) => `<span class="reel__l">${l}</span>`).join(''));
  });

  test('fillTemplate() replaces in one pass and inserts values literally', () => {
    assert.equal(fillTemplate('a{{A}}b{{B_2}}c', { A: "$& $1 $$ $` $'", B_2: 'x' }), "a$& $1 $$ $` $'bxc");
  });

  test('fillTemplate() rejects unknown, missing, repeated single-use and malformed markers', () => {
    assert.throws(() => fillTemplate('{{A}}{{NOPE}}', { A: '' }), /line 1: unknown marker \{\{NOPE\}\}/);
    assert.throws(() => fillTemplate('{{A}}', { A: '', B: '' }), /\{\{B\}\} is missing/);
    assert.throws(() => fillTemplate('{{A}}\n{{A}}', { A: '' }, { single: ['A'] }), /exactly once \(found 2\)/);
    assert.equal(fillTemplate('{{A}}{{A}}', { A: 'x' }), 'xx');
    assert.throws(() => fillTemplate('{{A}}\n{{ A }}', { A: '' }), /line 2: "\{\{" that is not a valid marker/);
    assert.throws(() => fillTemplate('{{A}}{{lower}}', { A: '' }), /not a valid marker/);
    assert.throws(() => fillTemplate('{{A}}', { A: '{{' }), /"\{\{" is left in the output/);
  });

  test('computeVersion() is 12 hex chars, order-independent, and changes with names and contents', () => {
    const a = computeVersion([['a.txt', Buffer.from('1')], ['b.txt', Buffer.from('2')]]);
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.equal(computeVersion([['b.txt', Buffer.from('2')], ['a.txt', Buffer.from('1')]]), a);
    assert.notEqual(computeVersion([['a.txt', Buffer.from('1')], ['b.txt', Buffer.from('3')]]), a);
    assert.notEqual(computeVersion([['a.txt', Buffer.from('1')], ['c.txt', Buffer.from('2')]]), a);
    assert.notEqual(computeVersion([['a.txt', Buffer.from('12')], ['b.txt', Buffer.from('')]]), a);
  });

  test('renderServiceWorker() replaces every placeholder and rejects missing or leftover ones', () => {
    const out = renderServiceWorker(`${STUB_SW}// again: "__BIP39_VERSION__"\n`, '0123456789ab', ['./', 'a.png']);
    assert.equal(out, 'const VERSION = "0123456789ab";\nconst ASSETS = ["./","a.png"];\nself.addEventListener("install", () => {});\n// again: "0123456789ab"\n');
    assert.throws(() => renderServiceWorker('const ASSETS = ["__BIP39_ASSETS__"];', 'v', []), /"__BIP39_VERSION__" is missing/);
    assert.throws(() => renderServiceWorker('const VERSION = "__BIP39_VERSION__";', 'v', []), /\["__BIP39_ASSETS__"\] is missing/);
    assert.throws(() => renderServiceWorker(`${STUB_SW}const X = '__BIP39_VERSION__';\n`, 'v', []), /line 4: __BIP39_VERSION__ is left/);
    assert.throws(() => renderServiceWorker(`${STUB_SW}}\n`, 'v', []), /dist\/sw\.js/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Building a fixture

describe('build() on a fixture root', () => {
  let root;
  let out;
  let summary;
  let dist;
  let html;
  let page;

  before(async () => {
    root = await makeFixture();
    out = await tmpDir('bip39-out-');
    summary = await build({ root, outDir: out, quiet: true });
    dist = await readDist(out);
    html = dist['index.html'].toString('utf8');
    page = checkInlineAndCsp(html);
  });

  test('writes index.html, sw.js and the static files (dotfiles skipped)', () => {
    const expected = [...STUB_STATIC.filter((n) => !n.startsWith('.')), 'index.html', 'sw.js'].sort();
    assert.deepEqual(Object.keys(dist), expected);
  });

  test('copies static files verbatim, including CNAME', () => {
    for (const name of STUB_STATIC.filter((n) => !n.startsWith('.'))) {
      assert.ok(dist[name].equals(Buffer.from(STUB[`src/static/${name}`])), name);
    }
    assert.equal(dist.CNAME.toString('utf8'), 'bip39.uuid.me\n');
  });

  test('has exactly one inline <style> and <script>, and the CSP hashes match their exact text', () => {
    assert.equal(page.style, STUB['src/styles.css']);
    assert.equal(page.script, `${STUB['src/lib.js']}\n${STUB['src/app.js']}`);
    assert.ok(page.csp.includes(`'sha256-${b64(page.style)}'`) && page.csp.includes(`'sha256-${b64(page.script)}'`));
  });

  test('the CSP contains every directive from the spec and nothing else', () => {
    const directives = new Map(page.csp.split('; ').map((d) => [d.slice(0, d.indexOf(' ')), d.slice(d.indexOf(' ') + 1)]));
    assert.equal(directives.size, 16);
    for (const [name, value] of Object.entries(FIXED_DIRECTIVES)) assert.equal(directives.get(name), value, name);
    assert.match(directives.get('script-src'), /^'sha256-[A-Za-z0-9+/]{43}='$/);
    assert.match(directives.get('style-src'), /^'sha256-[A-Za-z0-9+/]{43}='$/);
    assert.equal(page.csp, summary.csp);
  });

  test('leaves no "{{" in any output file', () => {
    for (const [name, data] of Object.entries(dist)) assert.ok(!data.toString('latin1').includes('{{'), name);
  });

  test('fills the sha256 markers', () => {
    checkShaMarkers(page.skeleton);
  });

  test('renders 2048 li.w in wordlist order in 25 sections, and 25 reel letters', () => {
    const sections = checkList(page.skeleton, WORDS);
    assert.equal(sections.length, 25);
    assert.equal(sections.reduce((n, s) => n + s.items.length, 0), 2048);
    assert.equal(html.match(/<li class="w[ "]/g).length, 2048);
    assert.equal(checkReel(page.skeleton, WORDS), 25);
  });

  test('wraps the first four letters in <b>, the whole word when it is 3 or 4 letters long', () => {
    const inner = new Map(parseList(page.skeleton).flatMap((s) => s.items).map((it) => [it.inner.replace(/<\/?b>/g, ''), it.inner]));
    assert.equal(inner.get('abandon'), '<b>aban</b>don');
    assert.equal(inner.get('act'), '<b>act</b>');
    assert.equal(inner.get('able'), '<b>able</b>');
    assert.equal(inner.get('zoo'), '<b>zoo</b>');
    assert.equal(inner.get('zone'), '<b>zone</b>');
    const short = WORDS.filter((w) => w.length <= 4);
    assert.equal(short.length, 103 + 442);
    for (const w of short) assert.equal(inner.get(w), `<b>${w}</b>`);
  });

  test('head__meta reads "{count} words · {first}–{last}" (a, s, z)', () => {
    const meta = Object.fromEntries(parseList(page.skeleton).map((s) => [s.letter, s.meta]));
    assert.equal(meta.a, '136 words \u00b7 1\u2013136');
    assert.equal(meta.s, '250 words \u00b7 1518\u20131767');
    assert.equal(meta.z, '4 words \u00b7 2045\u20132048');
  });

  test('w--g marks exactly the words whose two-letter prefix changes, never a section\'s first word', () => {
    const sections = parseList(page.skeleton);
    for (const s of sections) assert.equal(s.items[0].group, false, `first word of ${s.letter}`);
    const flagged = sections.flatMap((s) => s.items).filter((it) => it.group).map((it) => WORDS[it.n - 1]);
    assert.equal(flagged.length, 175);
    assert.deepEqual(flagged.slice(0, 6), ['access', 'adapt', 'aerobic', 'affair', 'again', 'ahead']);
    assert.ok(flagged.includes('beach') && !flagged.includes('bean') && !flagged.includes('baby') && !flagged.includes('bacon'));
  });

  test('contains no inputs, links, frames, external resources or inline handlers', () => {
    checkNoForbidden(page.skeleton);
    assert.equal((page.skeleton.match(/<style\b/gi) ?? []).length, 1);
    assert.equal((page.skeleton.match(/<script\b/gi) ?? []).length, 1);
  });

  test('the forbidden-construct patterns catch what they should (self-check)', () => {
    const bad = ['<input type="text">', '<TEXTAREA>', '<select>', '<button>', '<form>', '<a href="x">', '<a>',
      '<div contenteditable>', '<iframe>', '<script src="x.js">', '<link rel="stylesheet" href="a.css">',
      '<img src="https://x.test/a.png">', '<img src=//x.test/a.png>', '<link href="http://x.test">', '<div onclick="f()">'];
    for (const sample of bad) assert.ok(FORBIDDEN.some(([re]) => re.test(sample)), sample);
    const ok = ['<abbr>', '<aside>', '<link rel="icon" href="favicon.svg" type="image/svg+xml">', '<p>No inputs, one list</p>'];
    for (const sample of ok) assert.ok(!FORBIDDEN.some(([re]) => re.test(sample)), sample);
  });

  test('sw.js gets a 12-hex VERSION and the precache list, with no placeholders left', () => {
    const sw = dist['sw.js'].toString('utf8');
    assert.doesNotMatch(sw, /__BIP39_/);
    const version = /const VERSION = "([^"]*)";/.exec(sw)[1];
    assert.match(version, /^[0-9a-f]{12}$/);
    assert.equal(version, summary.version);
    const assets = JSON.parse(/const ASSETS = (\[.*\]);/.exec(sw)[1]);
    assert.deepEqual(assets, ['./', 'apple-touch-icon.png', 'favicon.svg', 'manifest.webmanifest']);
    assert.ok(!assets.includes('CNAME') && !assets.includes('robots.txt') && !assets.includes('.DS_Store'));
    checkServiceWorker(sw, STUB_SW, summary.version, expectedAssets(STUB_STATIC));
  });

  test('returns a summary of what it wrote', () => {
    assert.equal(summary.outDir, out);
    assert.equal(summary.sha256, WORDLIST_SHA256);
    assert.deepEqual(summary.files.map((f) => f.path), Object.keys(dist));
    for (const f of summary.files) {
      assert.equal(f.bytes, dist[f.path].length, f.path);
      assert.ok(Number.isInteger(f.gzipBytes) && f.gzipBytes > 0, f.path);
    }
  });

  test('is deterministic: a second build is byte-identical', async () => {
    const out2 = await tmpDir('bip39-out-');
    const summary2 = await build({ root, outDir: out2, quiet: true });
    const dist2 = await readDist(out2);
    assert.deepEqual(Object.keys(dist2), Object.keys(dist));
    for (const name of Object.keys(dist)) assert.ok(dist[name].equals(dist2[name]), `${name} differs`);
    assert.deepEqual({ ...summary2, outDir: '' }, { ...summary, outDir: '' });
  });

  test('cleans outDir first: stale files go, the rebuild is identical', async () => {
    await fs.writeFile(path.join(out, 'stale.txt'), 'old');
    await fs.mkdir(path.join(out, 'stale-dir'));
    await build({ root, outDir: out, quiet: true });
    const again = await readDist(out);
    assert.deepEqual(Object.keys(again), Object.keys(dist));
    for (const name of Object.keys(dist)) assert.ok(dist[name].equals(again[name]), name);
  });

  test('the sw VERSION changes whenever another output file changes', async () => {
    const css = await makeFixture({ 'src/styles.css': `${STUB['src/styles.css']}.x { color: red; }\n` });
    const robots = await makeFixture({ 'src/static/robots.txt': 'User-agent: *\nDisallow:\n' });
    const v1 = (await build({ root: css, outDir: await tmpDir(), quiet: true })).version;
    const v2 = (await build({ root: robots, outDir: await tmpDir(), quiet: true })).version;
    assert.equal(new Set([summary.version, v1, v2]).size, 3);
  });

  test('defaults outDir to <root>/dist', async () => {
    const fixture = await makeFixture();
    const result = await build({ root: fixture, quiet: true });
    assert.equal(result.outDir, path.join(fixture, 'dist'));
    assert.ok((await fs.readFile(path.join(fixture, 'dist', 'index.html'))).equals(dist['index.html']));
  });

  test('normalises CRLF and a BOM in sources, so the hashes match what browsers see', async () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    const fixture = await makeFixture({
      'src/styles.css': `\uFEFF${crlf(STUB['src/styles.css'])}`,
      'src/lib.js': crlf(STUB['src/lib.js']),
      'src/index.html': crlf(TEMPLATE),
    });
    const outDir = await tmpDir();
    await build({ root: fixture, outDir, quiet: true });
    assert.ok((await fs.readFile(path.join(outDir, 'index.html'))).equals(dist['index.html']));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Failures

describe('build() failures', () => {
  const realWordlist = WORDLIST;
  const cases = [
    ['a damaged wordlist', { 'wordlist/english.txt': realWordlist.replace('\nzoo\n', '\nzoos\n') }, /wordlist\/english\.txt: sha256/],
    ['an unsorted wordlist', { 'wordlist/english.txt': realWordlist.replace('ability\nable\n', 'able\nability\n') }, /line 3: "ability"/],
    ['an unknown template marker', { 'src/index.html': TEMPLATE.replace('</body>', '{{NOPE}}\n</body>') }, /unknown marker \{\{NOPE\}\}/],
    ['a malformed template marker', { 'src/index.html': TEMPLATE.replace('</body>', '{{ LIST }}\n</body>') }, /"\{\{" that is not a valid marker/],
    ['a missing template marker', { 'src/index.html': TEMPLATE.replace('{{REEL}}', '') }, /\{\{REEL\}\} is missing/],
    ['a repeated {{SCRIPT}} marker', { 'src/index.html': TEMPLATE.replace('</body>', '<script>{{SCRIPT}}</script>\n</body>') }, /\{\{SCRIPT\}\} must appear exactly once/],
    ['"</style" in the CSS', { 'src/styles.css': 'a::after { content: "</STYLE>"; }\n' }, /src\/styles\.css line 1: "<\/style"/],
    ['"{{" in the CSS', { 'src/styles.css': 'a {}\n/* {{STYLE}} */\n' }, /src\/styles\.css line 2: "\{\{"/],
    ['"</script" in the JS', { 'src/app.js': 'var s = "</script>";\n' }, /src\/app\.js line 1: "<\/script"/],
    ['"<!--" in the JS', { 'src/lib.js': 'var a = 1;\n// <!-- x\n' }, /src\/lib\.js line 2: "<!--"/],
    ['a JS syntax error', { 'src/app.js': 'var ok = 1;\nfunction (\n' }, /src\/app\.js:2: Function statements require a function name/],
    ['lib.js without a final ";" before an app.js that starts with "("', { 'src/lib.js': 'var Bip39Lib = {}\n' }, /does not end with ";"/],
    ['a missing src/styles.css', { 'src/styles.css': null }, /missing src\/styles\.css/],
    ['a missing src/sw.js', { 'src/sw.js': null }, /missing src\/sw\.js/],
    ['a sw.js without the VERSION placeholder', { 'src/sw.js': 'const ASSETS = ["__BIP39_ASSETS__"];\n' }, /"__BIP39_VERSION__" is missing/],
    ['a sw.js without the ASSETS placeholder', { 'src/sw.js': 'const VERSION = "__BIP39_VERSION__";\n' }, /\["__BIP39_ASSETS__"\] is missing/],
    ['a sw.js with a misspelled placeholder', { 'src/sw.js': `${STUB_SW}const V = '__BIP39_VERSION__';\n` }, /__BIP39_VERSION__ is left/],
    ['a static file named like a generated one', { 'src/static/sw.js': '// no\n' }, /src\/static\/sw\.js: sw\.js is generated by the build/],
    ['a missing file referenced by the template', { 'src/static/apple-touch-icon.png': null }, /apple-touch-icon\.png \(in src\/index\.html\)/],
    ['a missing manifest icon', { 'src/static/manifest.webmanifest': '{"icons":[{"src":"icon-512.png"}]}' }, /icon-512\.png \(in src\/static\/manifest\.webmanifest\)/],
    ['an invalid manifest', { 'src/static/manifest.webmanifest': '{' }, /manifest\.webmanifest is not valid JSON/],
  ];

  for (const [name, overrides, error] of cases) {
    test(`rejects ${name} and leaves outDir untouched`, async () => {
      const root = await makeFixture(overrides);
      const outDir = await tmpDir('bip39-out-');
      await fs.writeFile(path.join(outDir, 'previous.txt'), 'keep');
      await assert.rejects(build({ root, outDir, quiet: true }), error);
      assert.equal(await fs.readFile(path.join(outDir, 'previous.txt'), 'utf8'), 'keep');
    });
  }

  test('rejects a missing src/static/ and a subdirectory inside it', async () => {
    const noStatic = await makeFixture();
    await fs.rm(path.join(noStatic, 'src', 'static'), { recursive: true });
    await assert.rejects(build({ root: noStatic, outDir: await tmpDir(), quiet: true }), /missing src\/static\//);
    const nested = await makeFixture();
    await fs.mkdir(path.join(nested, 'src', 'static', 'icons'));
    await assert.rejects(build({ root: nested, outDir: await tmpDir(), quiet: true }), /src\/static\/icons: src\/static\/ must be flat/);
  });

  test('the CLI prints a summary, and exits 1 with a clear message on error', async () => {
    const run = promisify(execFile);
    const fixture = await makeFixture();
    await fs.mkdir(path.join(fixture, 'scripts'));
    await fs.copyFile(path.join(REPO, 'scripts', 'build.mjs'), path.join(fixture, 'scripts', 'build.mjs'));
    const ok = await run(process.execPath, [path.join(fixture, 'scripts', 'build.mjs')], { cwd: fixture });
    assert.match(ok.stdout, /^Built dist\/: 2048 words \(sha256 2f5eed53…3b24dbda\), sw version [0-9a-f]{12}\n/);
    assert.match(ok.stdout, /index\.html .* B {3}gzip .* B/);
    assert.ok(existsSync(path.join(fixture, 'dist', 'index.html')));

    await fs.writeFile(path.join(fixture, 'wordlist', 'english.txt'), WORDLIST.replace('zoo\n', 'zoo'));
    const failed = await run(process.execPath, [path.join(fixture, 'scripts', 'build.mjs')], { cwd: fixture }).catch((err) => err);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, 'build failed: wordlist/english.txt: must end with a newline (\\n)\n');
    assert.ok(existsSync(path.join(fixture, 'dist', 'index.html')), 'the previous dist/ survives a failed build');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Output directory safety

describe('output directory safety', () => {
  test('assertSafeOutDir() allows <root>/dist and explicit directories inside os.tmpdir()', () => {
    assert.ok(assertSafeOutDir(REPO, path.join(REPO, 'dist'), { explicit: false }).endsWith(`${path.sep}dist`));
    assert.ok(assertSafeOutDir(REPO, path.join(os.tmpdir(), 'bip39-not-created', 'out')));
  });

  test('assertSafeOutDir() refuses anything else', () => {
    const refused = [
      REPO, path.dirname(REPO), path.parse(REPO).root, path.join(REPO, 'src'), path.join(REPO, 'wordlist'),
      path.join(REPO, 'distx'), path.join(REPO, 'dist', 'nested'), os.tmpdir(), os.homedir(),
      path.join(os.homedir(), 'bip39-not-created'), path.join(REPO, 'dist', '..', 'src'),
    ];
    for (const outDir of refused) assert.throws(() => assertSafeOutDir(REPO, outDir), /refusing/, outDir);
    // Inside os.tmpdir() is only allowed when passed explicitly.
    assert.throws(() => assertSafeOutDir(REPO, path.join(os.tmpdir(), 'x'), { explicit: false }), /refusing/);
  });

  test('build() refuses a bad outDir before touching anything', async () => {
    const root = await makeFixture();
    for (const outDir of [root, path.join(root, 'src'), path.join(root, 'wordlist'), path.join(root, 'out'), path.dirname(root)]) {
      await assert.rejects(build({ root, outDir, quiet: true }), /refusing/, outDir);
    }
    assert.equal(await fs.readFile(path.join(root, 'src', 'index.html'), 'utf8'), TEMPLATE);
    assert.equal(await fs.readFile(path.join(root, 'wordlist', 'english.txt'), 'utf8'), WORDLIST);
  });

  test('build() refuses an outDir that is a file', async () => {
    const root = await makeFixture();
    const file = path.join(await tmpDir(), 'not-a-dir');
    await fs.writeFile(file, 'keep');
    await assert.rejects(build({ root, outDir: file, quiet: true }), /exists and is not a directory/);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  });

  test('build() refuses a <root>/dist symlink that points elsewhere', async () => {
    const root = await makeFixture();
    const elsewhere = await tmpDir('bip39-elsewhere-');
    await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'keep');
    await fs.symlink(elsewhere, path.join(root, 'dist'), 'dir');
    await assert.rejects(build({ root, quiet: true }), /refusing/);
    assert.equal(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// scripts/serve.mjs

function request(url, rawPath, method = 'GET') {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('scripts/serve.mjs serving a build', () => {
  const SECRET = 'outside the served directory';
  let dist;
  let served;

  before(async () => {
    const base = await tmpDir('bip39-serve-');
    const outDir = path.join(base, 'dist');
    await build({ root: await makeFixture(), outDir, quiet: true });
    dist = await readDist(outDir);
    await fs.writeFile(path.join(base, 'secret.txt'), SECRET);
    await fs.symlink(path.join(base, 'secret.txt'), path.join(outDir, 'leak.txt'));
    served = await startServer({ dir: outDir, port: 0 });
  });
  after(() => served?.close());

  test('listens on 127.0.0.1 with an ephemeral port', () => {
    assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.notEqual(new URL(served.url).port, '8080');
  });

  test('serves every file with the right Content-Type and Cache-Control: no-store', async () => {
    const types = {
      'index.html': 'text/html; charset=utf-8',
      'sw.js': 'text/javascript; charset=utf-8',
      'manifest.webmanifest': 'application/manifest+json',
      'favicon.svg': 'image/svg+xml',
      'apple-touch-icon.png': 'image/png',
      'robots.txt': 'text/plain; charset=utf-8',
      CNAME: 'text/plain; charset=utf-8',
    };
    for (const [name, type] of Object.entries(types)) {
      const res = await request(served.url, `/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers['content-type'], type, name);
      assert.equal(res.headers['cache-control'], 'no-store', name);
      assert.ok(res.body.equals(dist[name]), name);
    }
  });

  test('serves index.html for / (query strings ignored)', async () => {
    for (const target of ['/', '/?utm=x']) {
      const res = await request(served.url, target);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.ok(res.body.equals(dist['index.html']));
    }
  });

  test('answers HEAD with headers only', async () => {
    const res = await request(served.url, '/sw.js', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers['content-length']), dist['sw.js'].length);
    assert.equal(res.body.length, 0);
  });

  test('404s for anything that is not a file in the directory, and 405s other methods', async () => {
    for (const target of ['/missing.js', '/index.html/', '/sub/', '/leak.txt']) {
      const res = await request(served.url, target);
      assert.equal(res.status, 404, target);
      assert.equal(res.headers['cache-control'], 'no-store', target);
    }
    const post = await request(served.url, '/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
  });

  test('refuses path traversal, encoded or not, and absolute paths', async () => {
    const attempts = [
      '/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/..%2fsecret.txt', '/.%2e/secret.txt',
      '/..\\secret.txt', '/%5c..%5csecret.txt', '//etc/passwd', '/%2fetc%2fpasswd', '/%2F..%2Fsecret.txt',
      '/./index.html', '/%00', '/%E0%A4%A', '/C:/Windows/win.ini', '/%252e%252e/secret.txt',
    ];
    for (const target of attempts) {
      const res = await request(served.url, target);
      assert.ok(res.status === 400 || res.status === 404, `${target} → ${res.status}`);
      assert.ok(!res.body.toString().includes(SECRET), target);
    }
  });

  test('resolveRequestPath() and contentType() in isolation', () => {
    const root = path.resolve('/srv/site');
    assert.equal(resolveRequestPath(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveRequestPath(root, '/a%20b.txt?x#y'), path.join(root, 'a b.txt'));
    for (const bad of ['/..', '/a/../..', '/%2e%2e', '//x', '/a//b', 'x', 'http://h/x', '/%zz', '/a\\b', '/c:x', '/%00']) {
      assert.equal(resolveRequestPath(root, bad), null, bad);
    }
    assert.equal(contentType('x/manifest.webmanifest'), 'application/manifest+json');
    assert.equal(contentType('CNAME'), 'text/plain; charset=utf-8');
    assert.equal(contentType('app.JS'), 'text/javascript; charset=utf-8');
    assert.equal(contentType('data.json'), 'application/json');
    assert.equal(contentType('blob.bin'), 'application/octet-stream');
  });

  test('startServer() rejects a missing directory; close() is idempotent', async () => {
    await assert.rejects(startServer({ dir: path.join(os.tmpdir(), 'bip39-does-not-exist'), port: 0 }), /no such directory/);
    const extra = await startServer({ dir: path.dirname(fileURLToPath(import.meta.url)), port: 0 });
    await Promise.all([extra.close(), extra.close()]);
    assert.equal(extra.server.listening, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real repo

describe('the real repo', () => {
  const NEEDED = [
    'src/index.html', 'src/styles.css', 'src/lib.js', 'src/app.js', 'src/sw.js',
    'src/static/CNAME', 'src/static/manifest.webmanifest', 'src/static/favicon.svg', 'src/static/apple-touch-icon.png',
  ];

  test('builds and meets the same contract (skipped until every source file exists)', async (t) => {
    const missing = NEEDED.filter((rel) => !existsSync(path.join(REPO, rel)));
    if (missing.length > 0) {
      t.skip(`real sources not complete yet; missing ${missing.join(', ')}`);
      return;
    }
    const source = async (rel) => (await fs.readFile(path.join(REPO, rel), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const outDir = await tmpDir('bip39-real-');
    const summary = await build({ root: REPO, outDir, quiet: true });
    const dist = await readDist(outDir);
    const html = dist['index.html'].toString('utf8');

    assert.ok(!html.includes('{{'), 'no "{{" left');
    const page = checkInlineAndCsp(html);
    assert.equal(page.csp, summary.csp);
    assert.equal(page.style, await source('src/styles.css'));
    assert.equal(page.script, `${await source('src/lib.js')}\n${await source('src/app.js')}`);
    const cssCode = page.style.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(cssCode, /@import/i, 'no @import');
    assert.doesNotMatch(cssCode, /url\(\s*["']?\s*(?:https?:|\/\/)/i, 'no external url()');
    checkNoForbidden(page.skeleton);
    assert.equal(parseList(page.skeleton).length, 25);
    checkList(page.skeleton, WORDS);
    assert.equal(checkReel(page.skeleton, WORDS), LETTERS.length);
    checkShaMarkers(page.skeleton);

    const staticNames = (await fs.readdir(path.join(REPO, 'src', 'static'))).filter((n) => !n.startsWith('.')).sort();
    assert.deepEqual(Object.keys(dist), [...staticNames, 'index.html', 'sw.js'].sort());
    for (const name of staticNames) {
      assert.ok(dist[name].equals(await fs.readFile(path.join(REPO, 'src', 'static', name))), `${name} copied verbatim`);
    }
    assert.equal(dist.CNAME.toString('utf8').trim(), 'bip39.uuid.me');
    checkServiceWorker(dist['sw.js'].toString('utf8'), await source('src/sw.js'), summary.version, expectedAssets(staticNames));

    const outDir2 = await tmpDir('bip39-real-');
    await build({ root: REPO, outDir: outDir2, quiet: true });
    const dist2 = await readDist(outDir2);
    for (const name of Object.keys(dist)) assert.ok(dist[name].equals(dist2[name]), `${name} differs between builds`);
  });
});
