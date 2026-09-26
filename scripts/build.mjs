#!/usr/bin/env node
// Builds dist/ from src/ and wordlist/ (SPEC §3). Node >= 20 built-ins only, no dependencies.
// Deterministic: the same inputs always give byte-identical output (no timestamps, fixed ordering).
//
//   node scripts/build.mjs            build into <repo>/dist and print a summary
//   node scripts/build.mjs --quiet    same, without the summary
//
// Every input is read and checked before dist/ is touched, so a failed build leaves the previous output intact.
// The pure helpers are exported for test/build.test.mjs and test/wordlist.test.mjs.

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const SELF = fileURLToPath(import.meta.url);

/** Repository root (the parent of scripts/). */
export const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');

/** sha256 of bip-0039/english.txt in bitcoin/bips. */
export const WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
export const WORD_COUNT = 2048;
export const WORD_RE = /^[a-z]{3,8}$/;

const VERSION_PLACEHOLDER = '"__BIP39_VERSION__"';
const ASSETS_PLACEHOLDER = '["__BIP39_ASSETS__"]';
/** Copied to dist/ but not precached by the service worker. */
const NOT_PRECACHED = new Set(['CNAME', 'robots.txt']);
/** Output names written by the build itself; src/static/ may not provide them. */
const GENERATED = new Set(['index.html', 'sw.js']);
/** Template markers that must appear exactly once (every marker must appear at least once). */
const SINGLE_MARKERS = ['CSP', 'STYLE', 'SCRIPT', 'LIST', 'REEL'];
const MARKER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** An expected, user-facing build failure (printed without a stack trace). */
export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small utilities

/** Locale-independent string order (UTF-16 code units), so sorting is identical on every machine. */
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON-quotes a value for error messages, with every non-printable or non-ASCII character escaped. */
function show(value) {
  return JSON.stringify(String(value)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** 1-based line number of a string index. */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

const sha256 = (data) => createHash('sha256').update(data);

/** base64 sha256 of the UTF-8 encoding of `text`, as used in CSP hash sources. */
export function sha256Base64(text) {
  return sha256(Buffer.from(text, 'utf8')).digest('base64');
}

// ---------------------------------------------------------------------------------------------------------------
// Wordlist

/**
 * Checks every property of wordlist/english.txt that the site relies on and throws a BuildError naming the
 * first violation. Structural checks run before the hash check so that a damaged file gets a precise message.
 * @param {string | Uint8Array} input  the file contents
 * @returns {{ words: string[], sha256: string }}
 */
export function validateWordlist(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const text = typeof input === 'string' ? input : bytes.toString('utf8');
  const fail = (message) => {
    throw new BuildError(`wordlist/english.txt: ${message}`);
  };

  const cr = text.indexOf('\r');
  if (cr !== -1) fail(`line ${lineAt(text, cr)} contains a carriage return (\\r); only LF line endings are allowed`);
  if (!text.endsWith('\n')) fail('must end with a newline (\\n)');
  if (text.endsWith('\n\n')) fail('must end with exactly one newline, but it ends with an empty line');

  const words = text.slice(0, -1).split('\n');
  if (words.length !== WORD_COUNT) fail(`expected exactly ${WORD_COUNT} lines, found ${words.length}`);

  const prefixLine = new Map();
  words.forEach((word, i) => {
    const line = i + 1;
    if (!WORD_RE.test(word)) fail(`line ${line}: ${show(word)} does not match ${WORD_RE}`);
    if (i > 0 && !(words[i - 1] < word)) {
      fail(`line ${line}: ${show(word)} does not sort strictly after ${show(words[i - 1])} (the list must be ascending, without duplicates)`);
    }
    const prefix = word.slice(0, 4);
    if (prefixLine.has(prefix)) {
      fail(`line ${line}: ${show(word)} has the same first four letters (${show(prefix)}) as line ${prefixLine.get(prefix)}`);
    }
    prefixLine.set(prefix, line);
  });

  const hex = sha256(bytes).digest('hex');
  if (hex !== WORDLIST_SHA256) fail(`sha256 is ${hex}, expected ${WORDLIST_SHA256} (the official BIP39 English list)`);
  return { words, sha256: hex };
}

// ---------------------------------------------------------------------------------------------------------------
// Markup ({{LIST}}, {{REEL}}, {{SHA256_GROUPED}}, {{CSP}})

/** Splits a sorted word array into runs by first letter: [{ letter, start, end }] with 0-based [start, end). */
function letterRuns(words) {
  if (!Array.isArray(words) || words.length === 0) throw new BuildError('expected a non-empty array of words');
  const runs = [];
  words.forEach((word, i) => {
    // Words go into markup unescaped, so only lowercase ASCII letters are acceptable.
    if (typeof word !== 'string' || !/^[a-z]+$/.test(word)) throw new BuildError(`invalid word at index ${i}: ${show(word)}`);
    const last = runs[runs.length - 1];
    if (last && last.letter === word[0]) {
      last.end = i + 1;
    } else {
      if (runs.some((run) => run.letter === word[0])) {
        throw new BuildError(`words starting with "${word[0]}" are not contiguous (the list must be sorted)`);
      }
      runs.push({ letter: word[0], start: i, end: i + 1 });
    }
  });
  return runs;
}

/**
 * {{LIST}}: one <section> per first letter, one element per line (SPEC §3). Numbers are 1-based.
 * <b> holds the first four letters; .w--g marks the first word of a new two-letter prefix inside a section
 * (never the section's first word). There is no whitespace inside .w__t, so its textContent is the word.
 */
export function renderList(words) {
  const lines = [];
  for (const { letter, start, end } of letterRuns(words)) {
    const id = `h-${letter}`;
    lines.push(
      `<section class="sec" data-letter="${letter}" aria-labelledby="${id}">`,
      `<h2 class="head" id="${id}"><span class="head__l">${letter.toUpperCase()}</span>` +
        `<span class="head__meta">${end - start} words · ${start + 1}–${end}</span></h2>`,
      `<ol class="words" start="${start + 1}">`,
    );
    for (let i = start; i < end; i++) {
      const word = words[i];
      const groupStart = i > start && word.slice(0, 2) !== words[i - 1].slice(0, 2);
      lines.push(
        `<li class="${groupStart ? 'w w--g' : 'w'}"><span class="w__n">${i + 1}</span>` +
          `<span class="w__t"><b>${word.slice(0, 4)}</b>${word.slice(4)}</span></li>`,
      );
    }
    lines.push('</ol>', '</section>');
  }
  return lines.join('\n');
}

/** {{REEL}}: one <span class="reel__l"> per first letter, in order, with nothing between them (SPEC §3). */
export function renderReel(words) {
  return letterRuns(words)
    .map(({ letter }) => `<span class="reel__l">${letter.toUpperCase()}</span>`)
    .join('');
}

/** "2f5eed53a472…" → "2f5eed53 a4727b4b …": groups of 8 hex characters separated by single spaces. */
export function groupHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex)) throw new TypeError(`groupHex: expected a hex string, got ${show(hex)}`);
  return hex.match(/.{1,8}/g).join(' ');
}

/** The page's Content-Security-Policy (SPEC §3), with hashes of the exact inline <style> and <script> text. */
export function buildCsp(styleText, scriptText) {
  return [
    "default-src 'none'",
    `script-src 'sha256-${sha256Base64(scriptText)}'`,
    `style-src 'sha256-${sha256Base64(styleText)}'`,
    "img-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types bip39',
  ].join('; ');
}

// ---------------------------------------------------------------------------------------------------------------
// Template

/**
 * Replaces {{MARKERS}} in ONE regex pass over the template only, so inserted CSS/JS is never re-scanned and `$`
 * sequences in it are never interpreted. Errors: an unknown marker, a value that is never used, a repeated
 * `single` marker, a "{{" in the template that is not a valid marker, and any "{{" left in the output.
 * @param {string} template
 * @param {Record<string, string>} values  marker name → replacement text
 * @param {{ single?: string[] }} [options]
 */
export function fillTemplate(template, values, { single = [] } = {}) {
  const counts = new Map();
  const out = template.replace(MARKER_RE, (match, name, offset) => {
    if (!Object.hasOwn(values, name)) throw new BuildError(`src/index.html line ${lineAt(template, offset)}: unknown marker ${match}`);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return String(values[name]);
  });
  for (const name of Object.keys(values)) {
    const n = counts.get(name) ?? 0;
    if (n === 0) throw new BuildError(`src/index.html: marker {{${name}}} is missing`);
    if (n > 1 && single.includes(name)) throw new BuildError(`src/index.html: marker {{${name}}} must appear exactly once (found ${n})`);
  }
  // Blank out valid markers (same length, so offsets and line numbers stay put) and look for leftovers.
  const stray = template.replace(MARKER_RE, (match) => ' '.repeat(match.length)).indexOf('{{');
  if (stray !== -1) {
    throw new BuildError(`src/index.html line ${lineAt(template, stray)}: "{{" that is not a valid marker (markers look like {{NAME}}, NAME in [A-Z0-9_])`);
  }
  const left = out.indexOf('{{');
  if (left !== -1) throw new BuildError(`built page line ${lineAt(out, left)}: "{{" is left in the output`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Inline CSS / JS checks

const STYLE_HAZARDS = [
  [/<\/style/i, '"</style" would close the inline <style> element early'],
  [/\{\{/, '"{{" is reserved for template markers'],
];
const SCRIPT_HAZARDS = [
  [/<\/script/i, '"</script" would close the inline <script> element early'],
  [/<!--/, '"<!--" would switch the HTML parser into its script-escape states'],
  [/\{\{/, '"{{" is reserved for template markers'],
];

function assertNoHazards(text, file, hazards) {
  for (const [re, why] of hazards) {
    const i = text.search(re);
    if (i !== -1) throw new BuildError(`${file} line ${lineAt(text, i)}: ${why}`);
  }
}

/** Compiles (never runs) `code` as a classic script and turns a SyntaxError into a BuildError with its location. */
function assertCompiles(code, filename) {
  try {
    new vm.Script(code, { filename });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new BuildError(`${String(err.stack).split('\n')[0]}: ${err.message}`);
  }
}

/** True when `code` ends in an expression that a following "(" would call, i.e. its last statement has no ";". */
function endsInOpenExpression(code) {
  try {
    new vm.Script(`${code}\n()`); // "()" is a SyntaxError at the start of a statement, valid only as a call
    return true;
  } catch {
    return false;
  }
}

/** True when the first token of `code` (after whitespace and comments) could continue a previous expression. */
function startsWithContinuation(code) {
  let rest = code;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('//')) {
      const nl = rest.indexOf('\n');
      rest = nl === -1 ? '' : rest.slice(nl + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      rest = end === -1 ? '' : rest.slice(end + 2);
    } else {
      return /^[([`+\-/]/.test(rest);
    }
  }
}

/** Checks src/lib.js, src/app.js and their concatenation (the inline script) for problems that break the page. */
function checkScript(lib, app, script) {
  assertNoHazards(lib, 'src/lib.js', SCRIPT_HAZARDS);
  assertNoHazards(app, 'src/app.js', SCRIPT_HAZARDS);
  assertCompiles(lib, 'src/lib.js');
  assertCompiles(app, 'src/app.js');
  if (startsWithContinuation(app) && endsInOpenExpression(lib)) {
    throw new BuildError(
      'src/lib.js does not end with ";" and src/app.js starts with "(", "[", "`", "+", "-" or "/": joined as ' +
        'lib.js + "\\n" + app.js they would parse as one expression. End src/lib.js with ";".',
    );
  }
  assertNoHazards(script, 'inline <script>', SCRIPT_HAZARDS);
  assertCompiles(script, 'inline <script> (src/lib.js + "\\n" + src/app.js)');
}

// ---------------------------------------------------------------------------------------------------------------
// Service worker and asset references

/**
 * sw.js VERSION: the first 12 hex chars of a sha256 over the other output files in sorted path order. Each file
 * contributes "<path>\0<byte length>\0<bytes>", so renames and content changes both change the version.
 * @param {Iterable<[string, Uint8Array]>} files  [path, bytes] pairs
 */
export function computeVersion(files) {
  const hash = createHash('sha256');
  for (const [name, data] of [...files].sort(([a], [b]) => byString(a, b))) {
    hash.update(`${name}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * dist/sw.js: src/sw.js with every "__BIP39_VERSION__" (quoted) replaced by the JSON string `version` and every
 * ["__BIP39_ASSETS__"] replaced by the JSON array `assets`. Missing or leftover placeholders are errors.
 */
export function renderServiceWorker(source, version, assets) {
  for (const placeholder of [VERSION_PLACEHOLDER, ASSETS_PLACEHOLDER]) {
    if (!source.includes(placeholder)) throw new BuildError(`src/sw.js: placeholder ${placeholder} is missing`);
  }
  const out = source
    .split(VERSION_PLACEHOLDER).join(JSON.stringify(version))
    .split(ASSETS_PLACEHOLDER).join(JSON.stringify(assets));
  const left = /__BIP39_[A-Z0-9_]*__/.exec(out);
  if (left) {
    throw new BuildError(`src/sw.js line ${lineAt(out, left.index)}: ${left[0]} is left after replacement ` +
      `(placeholders must be written exactly as ${VERSION_PLACEHOLDER} and ${ASSETS_PLACEHOLDER})`);
  }
  assertCompiles(out, 'dist/sw.js');
  return out;
}

/** Maps a same-origin relative URL to an output file name, or returns null for external/data/fragment URLs. */
function localFile(ref) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) return null;
  let name = ref.split(/[?#]/, 1)[0].replace(/^\.?\//, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    return ref;
  }
  return name === '' ? 'index.html' : name;
}

/** Every local file referenced by the template (src/href) or by a web manifest (icons/screenshots) must exist. */
function assertReferencesExist(template, files) {
  const refs = [];
  for (const m of template.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/gi)) refs.push(['src/index.html', m[1]]);
  for (const [name, data] of files) {
    if (!name.endsWith('.webmanifest')) continue;
    let manifest;
    try {
      manifest = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch (err) {
      throw new BuildError(`src/static/${name} is not valid JSON: ${err.message}`);
    }
    for (const item of [...(manifest?.icons ?? []), ...(manifest?.screenshots ?? [])]) {
      if (typeof item?.src === 'string') refs.push([`src/static/${name}`, item.src]);
    }
  }
  const missing = refs.filter(([, ref]) => {
    const file = localFile(ref);
    return file !== null && !files.has(file);
  });
  if (missing.length) {
    throw new BuildError(`referenced files are missing from src/static/: ${missing.map(([from, ref]) => `${ref} (in ${from})`).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output directory safety

/** realpath() of the deepest existing ancestor of `p`, with the non-existent remainder appended. */
function realpathLoose(p) {
  const tail = [];
  for (let current = p; ;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is strictly inside `parent` (both absolute). */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Throws a BuildError unless `outDir` may be wiped and rewritten: it must be exactly <root>/dist or, when passed
 * explicitly, a directory strictly inside os.tmpdir(). Symlinks are resolved first. The project root, the home
 * directory, the temp directory itself (and any of their ancestors) are always refused, as is an existing
 * non-directory. Returns the resolved real path.
 */
export function assertSafeOutDir(root, outDir, { explicit = true } = {}) {
  const rootReal = realpathLoose(path.resolve(root));
  const target = realpathLoose(path.resolve(outDir));
  const tmp = realpathLoose(os.tmpdir());
  const home = realpathLoose(os.homedir());
  const refuse = (why) => {
    throw new BuildError(`refusing to clean output directory ${outDir}: ${why}`);
  };

  for (const keep of [rootReal, home, tmp]) {
    if (target === keep || isInside(target, keep)) refuse(`it is or contains ${keep}`);
  }
  if (isInside(rootReal, target)) {
    if (target !== path.join(rootReal, 'dist')) refuse(`inside the project only ${path.join(rootReal, 'dist')} may be used`);
  } else {
    // A temp dir at the filesystem root or above the home directory would make this rule meaningless.
    const tmpIsSane = tmp !== path.parse(tmp).root && !isInside(tmp, home);
    if (!explicit || !tmpIsSane || !isInside(tmp, target)) {
      refuse(`it must be <root>/dist, or a directory inside ${tmp} passed explicitly as outDir`);
    }
  }
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat && !stat.isDirectory()) refuse('it exists and is not a directory');
  return target;
}

async function emptyDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs

async function readInput(root, rel) {
  try {
    return await fs.readFile(path.join(root, rel));
  } catch (err) {
    if (err.code === 'ENOENT') throw new BuildError(`missing ${rel}`);
    throw err;
  }
}

/**
 * Reads UTF-8 source text, dropping a BOM and normalising CRLF/CR to LF. Browsers normalise newlines before
 * hashing inline code for CSP, so the inserted text must not contain CR or the hashes would not match.
 */
async function readText(root, rel) {
  return (await readInput(root, rel)).toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** The regular files of src/static/ (flat; dotfiles skipped) as sorted [name, bytes] pairs. */
async function readStatic(root) {
  const dir = path.join(root, 'src', 'static');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new BuildError('missing src/static/');
    throw err;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => byString(a.name, b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = `src/static/${entry.name}`;
    if (!entry.isFile()) throw new BuildError(`${rel}: src/static/ must be flat and hold only regular files (no directories or symlinks)`);
    if (GENERATED.has(entry.name)) throw new BuildError(`${rel}: ${entry.name} is generated by the build and cannot come from src/static/`);
    files.push([entry.name, await fs.readFile(path.join(dir, entry.name))]);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// Build

/**
 * Builds the site.
 * @param {{ root?: string, outDir?: string, quiet?: boolean }} [options]
 *   root    repository root (default: the parent of scripts/)
 *   outDir  output directory (default: <root>/dist; see assertSafeOutDir for what else is allowed)
 *   quiet   do not print the summary
 * @returns {Promise<{ outDir: string, files: { path: string, bytes: number, gzipBytes: number }[],
 *   sha256: string, version: string, csp: string }>}
 */
export async function build({ root = DEFAULT_ROOT, outDir, quiet = false } = {}) {
  const rootDir = path.resolve(root);
  const explicit = outDir !== undefined && outDir !== null;
  const outPath = path.resolve(explicit ? outDir : path.join(rootDir, 'dist'));
  const target = assertSafeOutDir(rootDir, outPath, { explicit });

  const { words, sha256: wordlistSha256 } = validateWordlist(await readInput(rootDir, 'wordlist/english.txt'));
  const template = await readText(rootDir, 'src/index.html');
  const style = await readText(rootDir, 'src/styles.css');
  const lib = await readText(rootDir, 'src/lib.js');
  const app = await readText(rootDir, 'src/app.js');
  const swSource = await readText(rootDir, 'src/sw.js');
  const staticFiles = await readStatic(rootDir);

  assertNoHazards(style, 'src/styles.css', STYLE_HAZARDS);
  const script = `${lib}\n${app}`;
  checkScript(lib, app, script);
  const csp = buildCsp(style, script);

  const html = fillTemplate(
    template,
    {
      CSP: csp,
      STYLE: style,
      SCRIPT: script,
      LIST: renderList(words),
      REEL: renderReel(words),
      SHA256: wordlistSha256,
      SHA256_GROUPED: groupHex(wordlistSha256),
    },
    { single: SINGLE_MARKERS },
  );

  const files = new Map([['index.html', Buffer.from(html, 'utf8')], ...staticFiles]);
  assertReferencesExist(template, files);
  const version = computeVersion(files);
  const assets = ['./', ...staticFiles.map(([name]) => name).filter((name) => !NOT_PRECACHED.has(name)).map(encodeURIComponent)];
  files.set('sw.js', Buffer.from(renderServiceWorker(swSource, version, assets), 'utf8'));

  await emptyDir(target);
  const names = [...files.keys()].sort(byString);
  for (const name of names) await fs.writeFile(path.join(target, name), files.get(name));

  const summary = {
    outDir: outPath,
    files: names.map((name) => {
      const data = files.get(name);
      return { path: name, bytes: data.length, gzipBytes: gzipSync(data, { level: 9 }).length };
    }),
    sha256: wordlistSha256,
    version,
    csp,
  };
  if (!quiet) printSummary(summary, words.length);
  return summary;
}

function printSummary({ outDir, files, sha256: hex, version }, wordCount) {
  const n = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const width = Math.max(...files.map((file) => file.path.length));
  const where = path.relative(process.cwd(), outDir) || '.';
  const lines = [`Built ${where}${path.sep}: ${wordCount} words (sha256 ${hex.slice(0, 8)}…${hex.slice(-8)}), sw version ${version}`];
  for (const file of files) {
    lines.push(`  ${file.path.padEnd(width)}  ${n(file.bytes).padStart(9)} B   gzip ${n(file.gzipBytes).padStart(8)} B`);
  }
  console.log(lines.join('\n'));
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  build({ quiet: process.argv.includes('--quiet') }).catch((err) => {
    console.error(`build failed: ${err instanceof BuildError ? err.message : (err?.stack ?? err)}`);
    process.exitCode = 1;
  });
}
