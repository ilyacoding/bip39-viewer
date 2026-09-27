#!/usr/bin/env node
// End-to-end test for the BIP39 viewer.
//
// Builds the site into a temp dir, serves it on 127.0.0.1, drives headless Chrome over the DevTools
// protocol as an iPhone-class touch device (390x844 @3x) and checks the scroll-only contract from the
// spec: DOM shape, no errors/CSP violations, same-origin-only network, centring/reel geometry after real
// touch drags and flings, no highlight on the centred word, screenshots (dark + light + desktop), the
// privacy veil and offline mode. The p* checks then attack the zero-tracking promise (see SECURITY.md).
//
// Dependency-free: Node >= 22 (global WebSocket) and a local Chrome/Chromium.
//
//   npm run e2e                               build + serve + test; screenshots and report.json in .e2e/
//   node scripts/e2e.mjs --headed             run in a visible browser window
//   node scripts/e2e.mjs --keep               leave the server running afterwards (and the browser, with --headed)
//   node scripts/e2e.mjs --out <dir>          write screenshots/report to <dir> instead of .e2e/
//   node scripts/e2e.mjs --url <url>          test an already-served page instead of building
//   node scripts/e2e.mjs --verbose            log console messages and requests as they happen
//   node scripts/e2e.mjs --cpu-throttle 4     slow the page's main thread 4x (shakes out timing bugs)
//   CHROME_PATH=/path/to/chrome npm run e2e   choose the browser binary
//
// Exit code: 0 when nothing FAILed, 1 when a check failed, 2 on a setup error.

import { spawn } from 'node:child_process';
import { accessSync, constants as FS, existsSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22 || typeof globalThis.WebSocket !== 'function') {
  console.error(`e2e: needs Node >= 22 with its global WebSocket (used to talk to Chrome); this is Node ${process.version}${NODE_MAJOR >= 22 ? ' with WebSocket disabled' : ''}.`);
  process.exit(2);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------
// Expectations (from SPEC.md)
// ---------------------------------------------------------------------------------------------------
const WORDS = 2048;
const LETTERS = 25;
const TOL = 2; // px: "centered" tolerance
const STABLE_MS = 600; // scroll positions unchanged for this long = settled
const SETTLE_TIMEOUT = 15000;
const VERIFY_TIMEOUT = 3000;
const LOAD_TIMEOUT = 20000;
const SW_TIMEOUT = 15000;
const ROW = 48; // .w height (px)
const HEAD = 72; // .head height (px)
const NOTCH = 56; // .reel__l height = reel scroll step (px)
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3 };
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      headed: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      out: { type: 'string' },
      url: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      'cpu-throttle': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (e) {
  console.error(`e2e: ${e.message}\nRun with --help for usage.`);
  process.exit(2);
}
if (opts.help) {
  console.log(
    'Usage: node scripts/e2e.mjs [--headed] [--keep] [--out <dir>] [--url <url>] [--verbose] [--cpu-throttle <n>]\n' +
      '  --headed   show the browser window\n' +
      '  --keep     keep the server (and the browser, with --headed) running until Ctrl+C\n' +
      '  --out      screenshot/report directory (default: .e2e/ in the repo)\n' +
      '  --url      test this URL instead of building and serving dist\n' +
      '  --verbose  log console messages and requests live\n' +
      '  --cpu-throttle <n>  slow the page main thread n times (Emulation.setCPUThrottlingRate)\n' +
      'Environment: CHROME_PATH=<browser binary>',
  );
  process.exit(0);
}
const CPU_THROTTLE = opts['cpu-throttle'] === undefined ? 1 : Number(opts['cpu-throttle']);
if (!(CPU_THROTTLE >= 1 && CPU_THROTTLE <= 20)) {
  console.error('e2e: --cpu-throttle must be a number from 1 to 20');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------
// Cleanup: every resource registers an async disposer; run on success, failure and signals.
// ---------------------------------------------------------------------------------------------------
const disposers = [];
const lastResort = { procs: new Set(), dirs: new Set() };
let cleaning = null;
function onCleanup(fn) {
  disposers.push(fn);
}
function cleanup() {
  cleaning ??= (async () => {
    while (disposers.length) {
      const fn = disposers.pop();
      try {
        await withTimeout(Promise.resolve().then(fn), 10000, 'cleanup step');
      } catch (e) {
        console.error(`e2e: cleanup: ${e.message}`);
      }
    }
  })();
  return cleaning;
}
let signals = 0;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => {
    if (signals++) process.exit(code);
    console.error(`\ne2e: ${sig}, cleaning up...`);
    cleanup().finally(() => process.exit(process.exitCode ?? code));
  });
}
process.on('exit', () => {
  // Synchronous last resort if something escaped the async cleanup.
  for (const p of lastResort.procs) if (p.exitCode === null && p.signalCode === null) try { p.kill('SIGKILL'); } catch {}
  for (const d of lastResort.dirs) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
async function sleepUntil(t) {
  const d = t - now();
  if (d > 0) await sleep(d);
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const fmt = (n) => (typeof n === 'number' ? (Math.round(n * 10) / 10).toString() : String(n));
class SetupError extends Error {}

// ---------------------------------------------------------------------------------------------------
// Minimal CDP client (browser-level WebSocket + flattened sessions)
// ---------------------------------------------------------------------------------------------------
class CDP {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #handlers = new Set();
  closed = false;

  static connect(url, timeoutMs = 10000) {
    return new Promise((resolveConn, rejectConn) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        rejectConn(new Error(`CDP: connect to ${url} timed out`));
        try { ws.close(); } catch {}
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolveConn(new CDP(ws)); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(timer); rejectConn(new Error(`CDP: connect failed: ${e.message ?? e.type}`)); }, { once: true });
    });
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error(`CDP: connection closed during ${p.method}`)); }
      this.#pending.clear();
    });
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of [...this.#handlers]) {
      try { h(msg); } catch (e) { console.error('e2e: event handler error:', e); }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`CDP: closed (${method})`));
    const id = ++this.#nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`${method}: no reply after ${timeoutMs}ms`)); }, timeoutMs);
      this.#pending.set(id, { resolve: res, reject: rej, method, timer });
      this.#ws.send(JSON.stringify(msg));
    });
  }

  onEvent(fn) {
    this.#handlers.add(fn);
    return () => this.#handlers.delete(fn);
  }

  close() {
    try { this.#ws.close(); } catch {}
  }
}

class Session {
  constructor(cdp, id, info = {}) {
    this.cdp = cdp;
    this.id = id;
    this.info = info;
  }
  send(method, params = {}, timeoutMs) {
    return this.cdp.send(method, params, this.id, timeoutMs);
  }
  on(method, fn) {
    return this.cdp.onEvent((m) => { if (m.sessionId === this.id && m.method === method) fn(m.params); });
  }
  // Resolves with the first matching event; subscribe *before* triggering the action.
  waitFor(method, pred = () => true, timeoutMs = 10000) {
    let off;
    const p = new Promise((res) => { off = this.on(method, (params) => { if (pred(params)) res(params); }); });
    return withTimeout(p, timeoutMs, `waiting for ${method}`).finally(() => off());
  }
}

// ---------------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------------
function findChrome() {
  if (process.env.CHROME_PATH) {
    try { accessSync(process.env.CHROME_PATH, FS.X_OK); return process.env.CHROME_PATH; } catch {
      throw new SetupError(`CHROME_PATH=${process.env.CHROME_PATH} is not an executable file`);
    }
  }
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) for (const d of dirs) candidates.push(join(d, name));
  for (const c of candidates) {
    try { accessSync(c, FS.X_OK); return c; } catch {}
  }
  throw new SetupError('Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH=/path/to/chrome.');
}

async function launchChrome({ exe, headed }) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'bip39-e2e-profile-'));
  lastResort.dirs.add(userDataDir);
  const args = [
    ...(headed ? [] : ['--headless=new']),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--force-color-profile=srgb',
    `--window-size=${PHONE.width},${PHONE.height}`,
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  lastResort.procs.add(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-6000); });
  const exited = new Promise((res) => proc.once('exit', res));
  const chrome = { exe, proc, userDataDir, stderr: () => stderr };
  onCleanup(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const done = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)]);
      if (!done) { proc.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); }
    }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    lastResort.dirs.delete(userDataDir);
  });

  // Chrome writes "<port>\n<browser ws path>" once DevTools is listening.
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = now() + 30000;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new SetupError(`Chrome exited during startup (code ${proc.exitCode}).\n${stderr}`);
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).split('\n').map((s) => s.trim());
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) return { ...chrome, wsUrl: `ws://127.0.0.1:${port}${path}` };
    } catch {}
    if (now() > deadline) throw new SetupError(`Chrome did not write DevToolsActivePort within 30s.\n${stderr}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------
// Code that runs inside the page. Only via Runtime.evaluate / addScriptToEvaluateOnNewDocument, which
// CSP does not govern; nothing here touches a Trusted Types sink or injects <script>.
// ---------------------------------------------------------------------------------------------------

// Installed before any page script: records securitypolicyviolation events (incl. Trusted Types).
const PROBE = `(() => {
  if (window.__e2e) return;
  const csp = [];
  Object.defineProperty(window, '__e2e', { value: { csp, frames: null }, enumerable: false });
  document.addEventListener('securitypolicyviolation', (e) => {
    csp.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, sample: e.sample,
      source: e.sourceFile, line: e.lineNumber, disposition: e.disposition });
  }, true);
})();`;

// Privacy spy, installed before any page script next to PROBE. Wraps every API that could send, store or
// read something the zero-tracking promise rules out, and records the calls made by page code (a stack
// frame from the page's own URL; the harness's own Runtime.evaluate frames are anonymous). Each wrapper
// calls straight through with the same arguments, so it touches no Trusted Types sink and the page
// behaves exactly as without it. location cannot be wrapped (its properties are unforgeable): check p5
// scans the shipped script for it instead, and p7 shows hostile URLs change nothing.
const SPY = `(() => {
  if (window.__e2eSpy) return;
  const log = [];
  Object.defineProperty(window, '__e2eSpy', { value: log, enumerable: false });
  const here = location.href.split(/[?#]/)[0]; // (a sandboxed frame's origin is "null"; its URL is not)
  const fromPage = () => String(new Error().stack || '').includes(here);
  const note = (api, detail) => { if (fromPage()) log.push({ api, detail: String(detail === undefined ? '' : detail).slice(0, 80) }); };
  const wrapFn = (obj, key, api) => {
    const d = obj && Object.getOwnPropertyDescriptor(obj, key);
    if (!d || typeof d.value !== 'function' || !d.configurable) return;
    const orig = d.value;
    Object.defineProperty(obj, key, { ...d, value: function (...args) { note(api, args[0]); return orig.apply(this, args); } });
  };
  const wrapGet = (obj, key, api) => {
    const d = obj && Object.getOwnPropertyDescriptor(obj, key);
    if (!d || !d.configurable || typeof d.get !== 'function') return;
    Object.defineProperty(obj, key, { ...d,
      get() { note(api + ' (read)'); return d.get.call(this); },
      ...(d.set ? { set(v) { note(api + ' (write)', v); d.set.call(this, v); } } : {}) });
  };
  const wrapCtor = (key) => {
    const Orig = window[key];
    if (typeof Orig !== 'function') return;
    const W = function (...args) { note('new ' + key, args[0]); return Reflect.construct(Orig, args, new.target || Orig); };
    W.prototype = Orig.prototype;
    Object.defineProperty(window, key, { value: W, writable: true, configurable: true });
  };
  wrapFn(window, 'fetch', 'fetch');
  wrapFn(XMLHttpRequest.prototype, 'open', 'XMLHttpRequest');
  wrapFn(Navigator.prototype, 'sendBeacon', 'sendBeacon');
  for (const k of ['WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'Notification']) wrapCtor(k);
  wrapFn(window, 'open', 'window.open');
  wrapFn(window, 'postMessage', 'postMessage');
  for (const k of ['pushState', 'replaceState', 'back', 'forward', 'go']) wrapFn(History.prototype, k, 'history.' + k);
  wrapGet(History.prototype, 'state', 'history.state');
  for (const k of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) wrapFn(Storage.prototype, k, 'Storage.' + k);
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'name', 'opener']) wrapGet(window, k, k);
  for (const k of ['clipboard', 'storage', 'geolocation', 'mediaDevices', 'credentials']) wrapGet(Navigator.prototype, k, 'navigator.' + k);
  for (const k of ['cookie', 'referrer', 'URL', 'documentURI', 'domain']) wrapGet(Document.prototype, k, 'document.' + k);
  wrapGet(Node.prototype, 'baseURI', 'baseURI');
  wrapFn(Document.prototype, 'execCommand', 'execCommand');
  if (typeof ServiceWorkerContainer === 'function') wrapFn(ServiceWorkerContainer.prototype, 'register', 'serviceWorker.register');
  const add = EventTarget.prototype.addEventListener;
  Object.defineProperty(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value: function (type, fn, opts) {
    if (fromPage()) {
      const on = this === window ? 'window' : this === document ? 'document' : this && this.id ? '#' + this.id : (this && this.constructor && this.constructor.name) || '?';
      log.push({ api: 'listen', detail: type, on, passive: !!(opts && typeof opts === 'object' && opts.passive) });
    }
    return add.call(this, type, fn, opts);
  } });
})();`;

// Listeners page code may register (check p4): the two scrollers' scroll events, the passive "which strip
// did the user take hold of" events, viewport/visibility/lifecycle events, and prefers-reduced-motion.
const LISTEN_OK = new Set(['scroll', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'resize', 'orientationchange', 'visibilitychange', 'pagehide', 'pageshow', 'load', 'change']);
const MUST_BE_PASSIVE = new Set(['scroll', 'pointerdown', 'touchstart', 'wheel', 'keydown']);

// Check p5: the shipped inline script must not even mention these (comments stripped first). A hit is not
// automatically a leak, but anything that reads the URL, referrer, window.name or messages, stores
// state, or talks to the network must be reviewed against SECURITY.md before this list is relaxed.
const SCRIPT_DENY = [
  [/\blocation\b/, 'location (URL, query, hash)'],
  [/\bdocument\s*\.\s*(URL|documentURI|referrer|cookie|domain)\b/, 'document.URL/referrer/cookie/domain'],
  [/\bbaseURI\b/, 'baseURI'],
  [/\.\s*name\b(?!\s*\()/, '.name (window.name)'],
  [/\bopener\b/, 'opener'],
  [/\bpostMessage\b|\bonmessage\b|\bMessageChannel\b|\bBroadcastChannel\b/, 'cross-window messages'],
  [/['"`](message|messageerror|hashchange|popstate|storage|copy|cut|paste|beforeunload|unload|click|dblclick|contextmenu|selectstart|selectionchange|input|devicemotion|deviceorientation|mousemove|pointermove|touchmove)['"`]/, 'a listener beyond scroll + passive engage'],
  [/\b(localStorage|sessionStorage|indexedDB|cookieStore|openDatabase|caches)\b/, 'storage / Cache API'],
  [/\bhistory\s*\.\s*(pushState|replaceState|state|back|forward|go)\b/, 'history entries or state'],
  [/\bURLSearchParams\b|\bdecodeURI(Component)?\b/, 'URL parsing'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b|\bRTCPeerConnection\b|\bWebTransport\b/, 'network API'],
  [/\bopen\s*\(/, 'window.open'],
  [/\bimport\s*\(|\bimportScripts\b|\bnew\s+(Shared)?Worker\b/, 'loading more code'],
  [/\beval\s*\(|\bnew\s+Function\b|\bset(Timeout|Interval)\s*\(\s*['"`]/, 'code from strings'],
  [/\b(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|createContextualFragment|DOMParser)\b|\bdocument\s*\.\s*write/, 'HTML string sink'],
  [/\bnavigator\s*\.\s*(clipboard|geolocation|mediaDevices|share|credentials|storage|userAgent|getBattery|sendBeacon)\b/, 'navigator API'],
  [/\bexecCommand\b|\bgetSelection\b/, 'selection / clipboard'],
  [/\bwss?:|https?:\/\//, 'absolute URL'],
];
// The service worker may fetch (that is its job) but only what the page itself requests or precaches.
const SW_DENY = [
  [/\bfetch\s*\(\s*(?!request\b)/, 'fetch() of something other than the intercepted request'],
  [/\bpostMessage\b|['"`](message|push|sync|periodicsync|notificationclick|backgroundfetchsuccess)['"`]/, 'messages / push / background sync'],
  [/\bimportScripts\b|\beval\s*\(|\bnew\s+Function\b/, 'loading more code'],
  [/\b(indexedDB|cookieStore|showNotification|backgroundFetch|openWindow|matchAll)\b/, 'storage / notifications / client control'],
  [/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/, 'network API besides fetch'],
  [/\bwss?:|https?:\/\//, 'absolute URL'],
];

// Installed in a cross-site frame before its first script (check p11): the spy, to see whether the framed
// page registers a service worker, and paint timing, to tell whether anything was painted before hiding.
const FRAME_PAINT = `${SPY}
(() => {
  if (window.top === window || window.__e2eFramePaint) return;
  const out = window.__e2eFramePaint = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) out.push({ name: e.name, t: e.startTime }); }).observe({ type: 'paint', buffered: true }); } catch (e) {}
})();`;

// p7: one load, once the list has settled: a hash of the whole DOM, plus the traces a payload would leave.
async function pageFingerprint() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.documentElement.outerHTML));
  return {
    dom: [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(''),
    pwned: window.__pwned ?? null,
    polluted: ({}).polluted ?? null,
    csp: window.__e2e ? window.__e2e.csp.map((v) => v.directive) : [],
    images: document.images.length,
    scripts: document.scripts.length,
    title: document.title,
    referrer: document.referrer,
    name: window.name,
  };
}

// p9: code injected into the page (as a successful XSS would be) tries to reach the attacker at X.
async function pageCspProbe(X) {
  const out = {};
  const attempt = async (k, f) => { try { const v = await f(); out[k] = v === undefined ? 'attempted' : String(v); } catch (e) { out[k] = e.name; } };
  const settle = (el) => new Promise((r) => {
    el.addEventListener('load', () => r('loaded'), { once: true });
    el.addEventListener('error', () => r('error event'), { once: true });
    setTimeout(() => r('no event'), 1000);
  });
  await attempt('fetch', () => fetch(`${X}/p9-fetch?w=zoo`).then(() => 'loaded'));
  await attempt('XHR', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', `${X}/p9-xhr`); x.onload = () => res('loaded'); x.onerror = () => res('error event'); x.send(); }));
  await attempt('sendBeacon', () => (navigator.sendBeacon(`${X}/p9-beacon`, 'w=zoo') ? 'queued' : 'refused'));
  await attempt('WebSocket', () => new Promise((res) => { const w = new WebSocket(`${X.replace(/^http/, 'ws')}/p9-ws`); w.onopen = () => res('open'); w.onerror = () => res('error event'); }));
  await attempt('EventSource', () => new Promise((res) => { const e = new EventSource(`${X}/p9-sse`); e.onopen = () => res('open'); e.onerror = () => { e.close(); res('error event'); }; }));
  await attempt('img', () => { const i = new Image(); const p = settle(i); i.src = `${X}/p9-img.png`; document.body.append(i); return p; });
  await attempt('CSS background', () => { document.body.style.backgroundImage = `url("${X}/p9-bg.png")`; return new Promise((r) => setTimeout(() => r('set'), 100)); });
  await attempt('stylesheet', () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `${X}/p9-style.css`; const p = settle(l); document.head.append(l); return p; });
  await attempt('font', () => new FontFace('p9', `url("${X}/p9-font.woff2")`).load().then(() => 'loaded'));
  await attempt('import()', () => import(`${X}/p9-module.mjs`).then(() => 'loaded'));
  await attempt('prefetch', () => { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = `${X}/p9-prefetch`; const p = settle(l); document.head.append(l); return p; });
  await attempt('iframe', () => { const f = document.createElement('iframe'); f.src = `${X}/p9-frame`; document.body.append(f); return new Promise((r) => setTimeout(() => r('appended'), 200)); });
  let base = null;
  await attempt('<base>', () => { const b = document.createElement('base'); b.href = `${X}/`; document.head.append(b); if (document.baseURI.startsWith(X)) base = document.baseURI; return base ? 'applied' : 'ignored'; });
  await attempt('form POST', () => { const f = document.createElement('form'); f.method = 'post'; f.action = `${X}/p9-form`; document.body.append(f); f.submit(); return new Promise((r) => setTimeout(() => r('submitted'), 200)); });
  return { out, base, csp: window.__e2e ? window.__e2e.csp.map((v) => v.directive) : [] };
}

// p8: every string-to-HTML/script sink must throw under Trusted Types, and eval must be refused by CSP.
function pageTrustedTypesProbe() {
  const out = {};
  const attempt = (k, f) => { try { f(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.name; } };
  const verify = document.getElementById('verify');
  attempt('innerHTML', () => { verify.innerHTML = '<img src=x onerror="window.__pwned=1">'; });
  attempt('outerHTML', () => { verify.outerHTML = '<b>x</b>'; });
  attempt('insertAdjacentHTML', () => verify.insertAdjacentHTML('beforeend', '<b>x</b>'));
  attempt('document.write', () => document.write('<b>x</b>'));
  attempt('DOMParser', () => new DOMParser().parseFromString('<b>x</b>', 'text/html'));
  attempt('createContextualFragment', () => document.createRange().createContextualFragment('<b>x</b>'));
  attempt('iframe.srcdoc', () => { document.createElement('iframe').srcdoc = '<b>x</b>'; });
  attempt('script.text', () => { document.createElement('script').text = 'window.__pwned = 2'; });
  attempt('script.src', () => { document.createElement('script').src = 'data:text/javascript,window.__pwned=3'; });
  attempt('onclick attribute', () => verify.setAttribute('onclick', 'window.__pwned = 4'));
  attempt('setTimeout(string)', () => setTimeout('window.__pwned = 5', 0));
  attempt('new Worker(url)', () => new Worker('data:text/javascript,1'));
  attempt('createPolicy("attacker")', () => trustedTypes.createPolicy('attacker', { createHTML: (s) => s }));
  // The page claims its one policy name at load, so nobody can take "bip39" after it.
  if ('serviceWorker' in navigator && window.isSecureContext && window.top === window) attempt('createPolicy("bip39")', () => trustedTypes.createPolicy('bip39', { createHTML: (s) => s }));
  // DevTools' own evaluation is exempt from CSP; code running in an ordinary task is not.
  return new Promise((res) => setTimeout(() => {
    attempt('eval', () => eval('1'));
    attempt('new Function', () => new Function('return 1')());
    setTimeout(() => res({ out, pwned: window.__pwned ?? null, rows: document.querySelectorAll('.w').length }), 50);
  }, 0));
}

// p10: nothing can be selected (so no copy, Look Up, Search or Touch to Search), translated or typed into.
function pageContentGrabAudit() {
  const problems = [];
  const body = [document.body, ...document.body.querySelectorAll('*')];
  const all = [document.documentElement, ...document.querySelectorAll('*')];
  const name = (e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/)[0]}` : '');
  const selectable = body.filter((e) => getComputedStyle(e).userSelect !== 'none');
  if (selectable.length) problems.push(`${selectable.length} element(s) allow text selection, e.g. ${name(selectable[0])}`);
  const translatable = all.filter((e) => e.translate !== false);
  if (translatable.length) problems.push(`${translatable.length} element(s) are open to translation, e.g. ${name(translatable[0])}`);
  if (document.documentElement.getAttribute('translate') !== 'no') problems.push('<html> lacks translate="no"');
  if (document.querySelector('meta[name="google"]')?.getAttribute('content') !== 'notranslate') problems.push('no <meta name="google" content="notranslate">');
  const editable = all.filter((e) => e.isContentEditable);
  if (editable.length || document.designMode !== 'off') problems.push(`${editable.length} editable element(s), designMode ${document.designMode}`);
  const keyboard = document.querySelectorAll('input, textarea, select, button, form, a[href], area[href], [contenteditable], [inputmode], [autofocus]');
  if (keyboard.length) problems.push(`${keyboard.length} element(s) that can take text or a tap: ${name(keyboard[0])}`);
  return {
    problems,
    detail: `user-select none on all ${body.length} body elements, translate off on all ${all.length} elements (html translate="no", meta google notranslate), 0 editable or keyboard-summoning elements`,
  };
}

function stripComments(js) {
  // Enough for our own sources: no regex literals or strings contain "//" or "/*".
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function pageSnapshot() {
  const html = document.documentElement;
  const list = document.getElementById('list');
  const reel = document.getElementById('reel');
  const words = document.querySelectorAll('.w');
  const letters = [...document.querySelectorAll('.reel__l')];
  const center = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  // Centre of a scroller's viewport (both strips span the full height, so both are the screen centre).
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + el.clientTop + el.clientHeight / 2; };
  const vc = list && list.clientHeight ? mid(list) : window.innerHeight / 2;
  const rc = reel && reel.clientHeight ? mid(reel) : vc;
  const text = (el) => (el.querySelector('.w__t') || el).textContent;
  // Nothing marks the word at the centre on screen, so find it geometrically: the row whose centre is
  // nearest the list's centre (rows are in vertical order). Within TOL of it = snapped.
  let lo = 0, hi = words.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (center(words[m]) < vc) lo = m + 1; else hi = m; }
  let near = null;
  for (const j of [lo - 1, lo]) {
    if (j < 0 || j >= words.length) continue;
    const c = center(words[j]);
    const d = Math.abs(c - vc);
    if (!near || d < near.delta) near = { index: j, text: text(words[j]), center: c, delta: d, letter: words[j].closest('.sec')?.dataset.letter ?? null };
  }
  const ra = document.querySelectorAll('.reel__l.is-active');
  return {
    vc,
    rc,
    highlighted: document.querySelectorAll('.w.is-active').length,
    centred: near,
    reelActiveCount: ra.length,
    reelActive: ra[0] ? { index: letters.indexOf(ra[0]), text: ra[0].textContent.trim(), center: center(ra[0]) } : null,
    verify: document.getElementById('verify')?.dataset.state ?? null,
    list: list ? { top: list.scrollTop, max: list.scrollHeight - list.clientHeight } : null,
    reel: reel ? { top: reel.scrollTop, max: reel.scrollHeight - reel.clientHeight } : null,
    classes: html.className,
    visibility: document.visibilityState,
    url: location.href,
  };
}

function pageSections() {
  const words = [...document.querySelectorAll('.w')];
  return [...document.querySelectorAll('.sec')].map((s) => {
    const w = s.querySelector('.w');
    return { letter: s.dataset.letter, first: w?.querySelector('.w__t')?.textContent ?? null, firstIndex: words.indexOf(w), count: s.querySelectorAll('.w').length };
  });
}

function pageDom() {
  const html = document.documentElement;
  const forbidden = [...document.querySelectorAll('input,textarea,select,button,form,a,[contenteditable]')];
  const reel = document.getElementById('reel');
  const list = document.getElementById('list');
  const rr = reel?.getBoundingClientRect();
  const lr = list?.getBoundingClientRect();
  const words = [...document.querySelectorAll('.w__t')].map((e) => e.textContent);
  // Layout heights (offsetHeight ignores the reel's fisheye transforms).
  const sizes = (sel) => {
    const v = [...document.querySelectorAll(sel)].map((e) => e.offsetHeight);
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  };
  return {
    row: sizes('.w'),
    head: sizes('.head'),
    notch: sizes('.reel__l'),
    w: document.querySelectorAll('.w').length,
    sec: document.querySelectorAll('.sec').length,
    reel: document.querySelectorAll('.reel__l').length,
    forbidden: forbidden.map((e) => e.outerHTML.slice(0, 80)),
    js: html.classList.contains('js'),
    noJs: html.classList.contains('no-js'),
    firstWord: words[0] ?? null,
    lastWord: words[words.length - 1] ?? null,
    sorted: words.every((w, i) => i === 0 || words[i - 1] < w),
    reelRect: rr ? { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom, width: rr.width } : null,
    listRect: lr ? { left: lr.left, right: lr.right, top: lr.top, bottom: lr.bottom, width: lr.width } : null,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    touch: navigator.maxTouchPoints,
    ua: navigator.userAgent,
  };
}

// Resolves once list and reel scrollTop have not changed for `stableMs` (or the timeout passes).
function pageWaitStable(stableMs, timeoutMs) {
  return new Promise((res) => {
    const list = document.getElementById('list');
    const reel = document.getElementById('reel');
    const t0 = performance.now();
    let last = null;
    let since = t0;
    const tick = () => {
      const t = performance.now();
      const v = `${list ? list.scrollTop : 0}|${reel ? reel.scrollTop : 0}`;
      if (v !== last) { last = v; since = t; }
      if (t - since >= stableMs) return res({ ok: true, ms: Math.round(t - t0), value: v });
      if (t - t0 > timeoutMs) return res({ ok: false, ms: Math.round(t - t0), value: v });
      setTimeout(tick, 16);
    };
    tick();
  });
}

// "No current-word highlight" at the current position: nothing marks the row at the centre, in the DOM,
// in computed styles or in overlapping boxes. Also returns the geometry of the rows around the centre for
// the pixel comparison done in Node (pixelRowAudit).
function pageHighlightAudit() {
  const problems = [];
  const list = document.getElementById('list');
  const reel = document.getElementById('reel');
  const rows = [...document.querySelectorAll('.w')];
  if (!list || !rows.length) return { problems: ['no #list or no .w rows'], centre: null, peers: 0, overlap: 0, pix: null };
  for (const sel of ['.lens', '#bits', '.w.is-active', '.w [class*="active"]', '[aria-current]', '[aria-selected]', '#list [style]']) {
    const n = document.querySelectorAll(sel).length;
    if (n) problems.push(`${n}× ${sel} in the DOM`);
  }
  const odd = rows.filter((r) => r.getAttributeNames().some((a) => a !== 'class') || [...r.classList].some((c) => c !== 'w' && c !== 'w--g'));
  if (odd.length) problems.push(`${odd.length} row(s) carry more than class="w[ w--g]", e.g. ${odd[0].outerHTML.slice(0, 100)}`);

  const lr = list.getBoundingClientRect();
  const vc = lr.top + list.clientTop + list.clientHeight / 2;
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (mid(rows[m]) < vc) lo = m + 1; else hi = m; }
  const c = lo > 0 && Math.abs(mid(rows[lo - 1]) - vc) <= Math.abs(mid(rows[lo]) - vc) ? lo - 1 : lo;
  const row = rows[c];
  const word = (r) => r.querySelector('.w__t')?.textContent ?? '?';
  const name = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') +
    (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '');

  // Computed styles: the centred row against rows near it and far away of the same kind (.w--g rows carry
  // their hairline, so they are compared with each other). Matching on w--g alone, not the whole class
  // list, so that a state class on the centred row cannot exclude it from the comparison.
  const PROPS = ['color', 'font-weight', 'font-size', 'font-style', 'opacity', 'background-color', 'background-image', 'transform',
    'filter', 'text-shadow', 'text-decoration-line', 'outline-style', 'box-shadow', 'visibility', 'mix-blend-mode', 'letter-spacing'];
  const parts = (r) => [['.w', r], ['.w__n', r.querySelector('.w__n')], ['.w__t', r.querySelector('.w__t')], ['b', r.querySelector('.w__t b')]];
  const style = (el) => {
    if (!el) return ['missing'];
    const s = getComputedStyle(el);
    return [...PROPS.map((p) => `${p}: ${s.getPropertyValue(p)}`), ...['::before', '::after'].map((p) => `${p} content: ${getComputedStyle(el, p).content}`)];
  };
  const ref = parts(row).map(([, el]) => style(el));
  const peers = [];
  for (const off of [1, -1, 2, -2, 3, -3, 6, -6, 40, -40, 400, -400, 1500, -1500]) {
    const j = c + off;
    if (j >= 0 && j < rows.length && rows[j].classList.contains('w--g') === row.classList.contains('w--g')) peers.push(j);
  }
  const diffs = new Set();
  for (const j of peers) {
    parts(rows[j]).forEach(([part, el], k) => {
      const s2 = style(el);
      const i = s2.findIndex((v, q) => v !== ref[k][q]);
      if (i >= 0) diffs.add(`${part} ${ref[k][i]} on the centred "${word(row)}" but ${s2[i]} on "${word(rows[j])}"`);
    });
  }
  problems.push(...[...diffs].slice(0, 4));

  // Nothing but the row, its ancestors and the reel may overlap the centred row. Every box is tested:
  // elementsFromPoint() would miss a pointer-events:none overlay such as the old lens band.
  const rr = row.getBoundingClientRect();
  const over = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el === row || row.contains(el) || el.contains(row) || (reel && reel.contains(el))) continue;
    const r = el.getBoundingClientRect();
    const ix = Math.min(r.right, rr.right) - Math.max(r.left, rr.left);
    const iy = Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top);
    if (ix > 0.5 && iy > 0.5 && getComputedStyle(el).visibility !== 'hidden') over.push(name(el));
  }
  if (over.length) problems.push(`${over.length} element(s) overlap the centred row: ${over.slice(0, 5).join(', ')}`);
  // ...and its ancestors paint nothing of their own that could mark the centre (a fixed band in a background).
  for (let el = row.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    const pseudo = ['::before', '::after'].filter((p) => !/^(none|normal)$/.test(getComputedStyle(el, p).content));
    if (s.backgroundImage !== 'none' || pseudo.length) {
      problems.push(`ancestor ${name(el)} paints ${s.backgroundImage !== 'none' ? `a background-image ${s.backgroundImage.slice(0, 60)}` : ''}${pseudo.length ? ` ${pseudo.join('/')} content` : ''}`);
    }
  }

  // Up to two rows either side of the centre, fully on screen and clear of the edge fades.
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const near = [];
  for (let j = Math.max(0, c - 2); j <= Math.min(rows.length - 1, c + 2); j++) {
    const b = box(rows[j]);
    if (b.t >= lr.top + 60 && b.b <= lr.bottom - 60) near.push({ index: j, word: word(rows[j]), row: b, n: box(rows[j].querySelector('.w__n')), t: box(rows[j].querySelector('.w__t')) });
  }
  let pix = null;
  if (near.length >= 2) {
    const x0 = Math.floor(Math.min(...near.map((q) => q.row.l))), x1 = Math.ceil(Math.max(...near.map((q) => q.row.r)));
    const y0 = Math.floor(Math.min(...near.map((q) => q.row.t))), y1 = Math.ceil(Math.max(...near.map((q) => q.row.b)));
    pix = { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, rows: near };
  }
  return { problems, centre: { index: c, word: word(row), delta: mid(row) - vc }, peers: peers.length, overlap: over.length, pix };
}

function pageStartFrames() {
  const rec = { deltas: [], run: true, last: 0 };
  const loop = (t) => {
    if (rec.last) rec.deltas.push(t - rec.last);
    rec.last = t;
    if (rec.run) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__e2e.frames = rec;
  return true;
}

function pageStopFrames() {
  const rec = window.__e2e.frames;
  if (!rec) return [];
  rec.run = false;
  return rec.deltas;
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------
class Run {
  constructor(cdp, target, outDir) {
    this.cdp = cdp;
    this.target = target; // { url, origin }
    this.outDir = outDir;
    this.results = [];
    this.phase = 'setup';
    this.requests = []; // { ctx, phase, url, method, type, requestId, status?, fromSW?, error? }
    this.consoleErrors = []; // { ctx, phase, kind, text }
    this.consoleWarnings = [];
    this.issues = []; // Audits issues { ctx, phase, code, detail }
    this.cspProbe = []; // securitypolicyviolation events from the probe
    this.workers = new Map(); // sessionId -> Session (our origin's service workers)
    this.foreignWorkers = new Set(); // e.g. built-in component extensions: resumed, otherwise ignored
    this.inflight = new Map(); // ctx:requestId -> start time
    this.lastRequestAt = 0;
    this.docPhase = 'setup'; // phase in which the current document was loaded
    this.offline = false;
    this.shots = [];
    this.shotErrors = [];
    this.sections = null;
    this.frameStats = null;
    this.highlight = []; // no-current-word-highlight audits: { label, problems, detail }
    this.spyLog = []; // SPY records from every main-page document: { api, detail, on?, passive?, phase }
    this.docLoads = 0; // documents loaded in the main tab
    this.mainContextId = null; // browser context of the main tab (isolated attack contexts are others)
    this.contexts = new Set(); // disposers of isolated browser contexts still open
    this.urlBaseline = null;
  }

  log(...a) {
    if (opts.verbose) console.log('  ·', ...a);
  }

  // --- event capture ------------------------------------------------------------------------------
  ctxOf(sessionId) {
    if (sessionId === this.page?.id) return 'page';
    const w = this.workers.get(sessionId);
    return w ? 'sw' : null;
  }

  onEvent(m) {
    const { method, params } = m;
    if (!m.sessionId) {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'service_worker') this.attachWorker(params);
      if (method === 'Target.detachedFromTarget') { this.workers.delete(params.sessionId); this.foreignWorkers.delete(params.sessionId); }
      return;
    }
    const ctx = this.ctxOf(m.sessionId);
    if (!ctx) return;
    const phase = this.phase;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const r = { ctx, phase, url: params.request.url, method: params.request.method, type: params.type ?? null, requestId: params.requestId, initiator: params.initiator?.type };
        this.requests.push(r);
        this.inflight.set(`${ctx}:${params.requestId}`, now());
        if (ctx === 'page') this.lastRequestAt = now();
        this.log(`[${ctx}/${phase}] request ${r.method} ${r.url} (${r.type})`);
        break;
      }
      case 'Network.responseReceived': {
        const r = this.findRequest(ctx, params.requestId);
        if (r) { r.status = params.response.status; r.fromSW = !!params.response.fromServiceWorker; r.fromCache = !!params.response.fromDiskCache; }
        break;
      }
      case 'Network.loadingFinished':
        this.inflight.delete(`${ctx}:${params.requestId}`);
        break;
      case 'Network.loadingFailed': {
        this.inflight.delete(`${ctx}:${params.requestId}`);
        const r = this.findRequest(ctx, params.requestId);
        if (r) r.error = params.errorText + (params.blockedReason ? ` [${params.blockedReason}]` : '');
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails;
        const text = d.exception?.description || d.exception?.value || d.text;
        this.addConsole(ctx, 'error', 'uncaught', `${text}${d.url ? ` @ ${d.url}:${d.lineNumber + 1}` : ''}`);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
        if (params.type === 'error' || params.type === 'assert') this.addConsole(ctx, 'error', `console.${params.type}`, text);
        else if (params.type === 'warning') this.addConsole(ctx, 'warning', 'console.warn', text);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry;
        const text = `${e.text}${e.url ? ` (${e.url})` : ''}`;
        if (e.level === 'error') this.addConsole(ctx, 'error', `log.${e.source}`, text);
        else if (e.level === 'warning') this.addConsole(ctx, 'warning', `log.${e.source}`, text);
        break;
      }
      case 'Audits.issueAdded': {
        const i = params.issue;
        const d = i.details?.contentSecurityPolicyIssueDetails;
        const detail = d
          ? `${d.contentSecurityPolicyViolationType} ${d.violatedDirective}${d.blockedURL ? ` ${d.blockedURL}` : ''}`
          : JSON.stringify(i.details).slice(0, 200);
        this.issues.push({ ctx, phase, code: i.code, detail });
        this.log(`[${ctx}/${phase}] issue ${i.code}: ${detail}`);
        break;
      }
    }
  }

  findRequest(ctx, id) {
    for (let i = this.requests.length - 1; i >= 0; i--) if (this.requests[i].ctx === ctx && this.requests[i].requestId === id) return this.requests[i];
    return null;
  }

  addConsole(ctx, level, kind, text) {
    const entry = { ctx, phase: this.phase, kind, text: String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 400) };
    (level === 'error' ? this.consoleErrors : this.consoleWarnings).push(entry);
    this.log(`[${ctx}/${entry.phase}] ${level} ${kind}: ${entry.text}`);
  }

  async attachWorker({ sessionId, targetInfo, waitingForDebugger }) {
    const s = new Session(this.cdp, sessionId, targetInfo);
    let origin = null;
    try { origin = new URL(targetInfo.url).origin; } catch {}
    // Workers of the isolated attack contexts (checks p7-p15) are someone else's: keep them out of a and b.
    const otherContext = this.mainContextId && targetInfo.browserContextId && targetInfo.browserContextId !== this.mainContextId;
    if (origin !== this.target.origin || otherContext) {
      this.foreignWorkers.add(sessionId);
      if (waitingForDebugger) s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      return;
    }
    this.workers.set(sessionId, s);
    this.log(`service worker attached: ${targetInfo.url}`);
    try {
      await Promise.all([s.send('Runtime.enable'), s.send('Network.enable'), s.send('Log.enable').catch(() => {})]);
      if (this.offline) await this.setOffline(s, true);
    } catch (e) {
      this.log(`worker setup: ${e.message}`);
    } finally {
      if (waitingForDebugger) s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  }

  // --- page helpers -------------------------------------------------------------------------------
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await this.page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`in-page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async poll(fn, args, pred, timeoutMs, label) {
    const t0 = now();
    let last;
    for (;;) {
      try { last = await this.eval(fn, ...args); } catch (e) { last = { error: e.message }; }
      if (pred(last)) return { ok: true, value: last, ms: now() - t0 };
      if (now() - t0 > timeoutMs) return { ok: false, value: last, ms: now() - t0, label };
      await sleep(25);
    }
  }

  snapshot() {
    return this.eval(pageSnapshot);
  }

  async waitStable(timeoutMs = SETTLE_TIMEOUT, stableMs = STABLE_MS) {
    const r = await this.eval(pageWaitStable, stableMs, timeoutMs);
    if (!r.ok) throw new Error(`scroll did not settle within ${timeoutMs}ms (last ${r.value})`);
    // One more frame so rAF-driven classes/readouts reflect the final position.
    await this.eval(() => new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(() => r2(true)))));
    return r;
  }

  async emulatePhone() {
    const p = this.page;
    await p.send('Emulation.setDeviceMetricsOverride', {
      ...PHONE, mobile: true, screenWidth: PHONE.width, screenHeight: PHONE.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  }

  async emulateDesktop() {
    const p = this.page;
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await p.send('Emulation.setDeviceMetricsOverride', { ...DESKTOP, mobile: false, screenWidth: DESKTOP.width, screenHeight: DESKTOP.height });
    await p.send('Emulation.setUserAgentOverride', { userAgent: this.desktopUA });
  }

  async setScheme(value) {
    await this.page.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value }] });
    await this.settleAnimations();
  }

  // Two frames for the style change to land, then wait for CSS transitions (colour fades) to finish.
  async settleAnimations(timeoutMs = 2000) {
    await this.eval((ms) => new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
        Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, ms))])
          .then(() => requestAnimationFrame(() => done(true)));
      }));
    }), timeoutMs);
  }

  async screenshot(name) {
    await this.settleAnimations().catch(() => {});
    const { data } = await this.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
    const file = join(this.outDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    this.shots.push(file);
    return file;
  }

  // Dark + light screenshots of the current state; leaves the page in dark.
  async shotPair(name) {
    await this.setScheme('dark');
    const a = await this.screenshot(`mobile-dark-${name}`);
    await this.setScheme('light');
    const b = await this.screenshot(`mobile-light-${name}`);
    await this.setScheme('dark');
    return [a, b];
  }

  async navigate(url) {
    const loaded = this.page.waitFor('Page.loadEventFired', () => true, LOAD_TIMEOUT);
    const r = await this.page.send('Page.navigate', { url });
    if (r.errorText) { loaded.catch(() => {}); throw new Error(`navigation to ${url} failed: ${r.errorText}`); }
    await loaded;
    this.loadedAt = now();
    this.docPhase = this.phase;
    this.docLoads++;
  }

  async reload() {
    await this.collectProbe();
    const loaded = this.page.waitFor('Page.loadEventFired', () => true, LOAD_TIMEOUT);
    await this.page.send('Page.reload', { ignoreCache: false });
    await loaded;
    this.loadedAt = now();
    this.docPhase = this.phase;
    this.docLoads++;
  }

  // No page request in flight and none started for `quietMs` (late favicon/manifest fetches etc.).
  async waitNetworkIdle(quietMs = 500, timeoutMs = 5000) {
    const t0 = now();
    for (;;) {
      const busy = [...this.inflight.keys()].some((k) => k.startsWith('page:'));
      if (!busy && now() - this.lastRequestAt >= quietMs) return true;
      if (now() - t0 > timeoutMs) return false;
      await sleep(50);
    }
  }

  // The page's CSP probe lives in the document; harvest it before the document goes away.
  async collectProbe() {
    try {
      const v = await this.eval(() => ({ csp: window.__e2e ? window.__e2e.csp.splice(0) : [], spy: window.__e2eSpy ? window.__e2eSpy.splice(0) : [] }));
      for (const x of v.csp) this.cspProbe.push({ ...x, phase: this.docPhase });
      for (const x of v.spy) this.spyLog.push({ ...x, phase: this.docPhase });
    } catch {}
  }

  async waitAppReady(timeoutMs = 10000) {
    const r = await this.poll(
      () => document.readyState === 'complete' && document.documentElement.classList.contains('js') && document.querySelectorAll('.w').length,
      [], (v) => typeof v === 'number' && v > 0, timeoutMs, 'app ready');
    if (!r.ok) throw new Error(`page not ready after ${timeoutMs}ms (html.js missing or no .w rows): ${JSON.stringify(r.value)}`);
  }

  // --- touch input --------------------------------------------------------------------------------
  // One-finger vertical drag from y0 to y1 over `ms`, ~60 Hz moves with matching timestamps.
  // hold > 0: keep the finger still before lifting (no fling); hold = 0: lift at speed (fling).
  async touchDrag(x, y0, y1, ms, hold = 0, session = this.page) {
    const steps = Math.max(3, Math.round(ms / 16));
    const wall0 = Date.now() / 1000;
    const t0 = now();
    const pt = (y) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 0.5 }];
    const send = (type, y, at) =>
      session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : pt(y), timestamp: wall0 + at / 1000 });
    await send('touchStart', y0, 0);
    let ended = false;
    try {
      for (let i = 1; i <= steps; i++) {
        const at = (ms * i) / steps;
        await sleepUntil(t0 + at);
        await send('touchMove', y0 + ((y1 - y0) * i) / steps, at);
      }
      if (hold) await sleepUntil(t0 + ms + hold);
      await send('touchEnd', y1, ms + hold);
      ended = true;
    } finally {
      // Never leave a finger down: a dangling touch would corrupt every later gesture.
      if (!ended) await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
    }
  }

  async geometry() {
    return this.eval(() => {
      const r = document.getElementById('reel')?.getBoundingClientRect();
      const l = document.querySelectorAll('.reel__l');
      const notch = l.length > 1 ? l[1].offsetTop - l[0].offsetTop : 0; // reel scroll distance per letter
      return { w: innerWidth, h: innerHeight, reelX: r ? r.left + r.width / 2 : innerWidth - 28, reelLeft: r ? r.left : innerWidth - 56, notch };
    });
  }

  // Invariants that must hold whenever both strips are at rest. The centred word is found geometrically
  // (nothing marks it); within TOL of the list centre proves the list snapped.
  restProblems(s, { expectWord, expectLetter } = {}) {
    const p = [];
    const w = s.centred;
    if (!w) p.push('no .w rows to centre');
    else {
      const d = w.center - s.vc;
      if (Math.abs(d) > TOL) p.push(`word nearest the centre, "${w.text}", is ${fmt(d)}px off it (not snapped)`);
      if (expectWord && w.text !== expectWord) p.push(`centred word "${w.text}" (want "${expectWord}")`);
    }
    if (s.reelActiveCount !== 1) p.push(`${s.reelActiveCount} .reel__l.is-active (want 1)`);
    if (s.reelActive) {
      const d = s.reelActive.center - s.rc;
      if (Math.abs(d) > TOL) p.push(`reel letter ${s.reelActive.text} is ${fmt(d)}px off the reel centre`);
      if (w && s.reelActive.text.toLowerCase() !== w.text[0]) p.push(`reel shows ${s.reelActive.text} but the centred word is "${w.text}"`);
      if (expectLetter && s.reelActive.text !== expectLetter) p.push(`reel letter ${s.reelActive.text} (want ${expectLetter})`);
    }
    return p;
  }

  // At the very end the outro snaps into view (scroll-snap-align: end), so zoo rests above the centre.
  endProblems(s) {
    const p = [];
    if (s.centred?.text !== 'zoo') p.push(`the word nearest the centre is "${s.centred?.text}" (want zoo)`);
    if (s.reelActive?.text !== 'Z') p.push(`reel shows ${s.reelActive?.text} (want Z)`);
    if (s.reelActiveCount !== 1) p.push(`${s.reelActiveCount} .reel__l.is-active (want 1)`);
    if (s.list && s.list.top < s.list.max - 1) p.push(`list at ${fmt(s.list.top)} of ${fmt(s.list.max)} (want the end)`);
    return p;
  }

  describe(s) {
    const w = s.centred;
    if (!w) return `no word rows; list ${fmt(s.list?.top)}`;
    return `"${w.text}" #${w.index + 1} Δ${fmt(w.center - s.vc)}px, reel ${s.reelActive?.text ?? '?'} Δ${fmt((s.reelActive?.center ?? NaN) - s.rc)}px`;
  }

  // --- results ------------------------------------------------------------------------------------
  record(id, name, status, details) {
    if (signals) return; // interrupted: don't report the fallout of tearing the browser down
    this.results.push({ id, name, status, details });
    const tag = status === 'PASS' ? 'ok  ' : status === 'FAIL' ? 'FAIL' : status;
    const d = status === 'FAIL' ? ` — ${details.length > 240 ? `${details.slice(0, 240)}…` : details}` : '';
    console.log(`  ${tag.padEnd(4)} ${id.padEnd(3)} ${name}${d}`);
  }

  async check(id, name, fn) {
    try {
      const r = await fn();
      if (r === undefined) return;
      const [problems, okDetail] = r;
      if (problems === 'SKIP') this.record(id, name, 'SKIP', okDetail);
      else if (problems === 'INFO') this.record(id, name, 'INFO', okDetail);
      else if (problems.length) {
        this.record(id, name, 'FAIL', problems.join('; ') + (okDetail ? ` [${okDetail}]` : ''));
        await this.failShot(id);
      } else this.record(id, name, 'PASS', okDetail);
    } catch (e) {
      this.record(id, name, 'FAIL', `error: ${e.message}`);
      await this.failShot(id);
    }
  }

  // Audits the no-current-word-highlight contract at the current (resting) position; check n reports it.
  async auditHighlight(label) {
    const entry = { label, problems: [], detail: '' };
    this.highlight.push(entry);
    try {
      const a = await this.eval(pageHighlightAudit);
      entry.problems.push(...a.problems);
      let px = 'no pixel sample (fewer than 2 rows clear of the edges)';
      if (a.pix) {
        const { clip, rows } = a.pix;
        const shot = await this.page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
        const r = pixelRowAudit(decodePng(Buffer.from(shot.data, 'base64')), clip, rows);
        entry.problems.push(...r.problems);
        px = r.detail;
      }
      entry.detail = `"${a.centre?.word}" vs ${a.peers} rows of its kind, ${a.overlap} overlapping boxes, ${px}`;
    } catch (e) {
      entry.problems.push(`audit failed: ${e.message}`);
    }
  }

  async failShot(id) {
    try { await this.screenshot(`fail-${id}`); } catch {}
  }

  // --- main flow ----------------------------------------------------------------------------------
  async run() {
    const cdp = this.cdp;
    cdp.onEvent((m) => this.onEvent(m));
    const version = await cdp.send('Browser.getVersion');
    this.browserVersion = version.product;
    this.desktopUA = version.userAgent.replace('HeadlessChrome', 'Chrome');

    // Service workers: auto-attach (paused) so their requests/console are captured from the start.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker' }] });

    const { targetInfos } = await cdp.send('Target.getTargets');
    let pageTarget = targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank');
    if (!pageTarget) pageTarget = { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId };
    this.targetId = pageTarget.targetId;
    this.mainContextId = (await cdp.send('Target.getTargetInfo', { targetId: this.targetId }).catch(() => null))?.targetInfo?.browserContextId ?? null;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.page = new Session(cdp, sessionId);
    const p = this.page;
    await Promise.all([p.send('Page.enable'), p.send('Runtime.enable'), p.send('Log.enable'), p.send('Network.enable'), p.send('Audits.enable')]);
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
    if (CPU_THROTTLE > 1) await p.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    await this.emulatePhone();
    await this.setScheme('dark');

    // ---- first load
    this.phase = 'load';
    await this.navigate(this.target.url);
    let ready = true;
    try { await this.waitAppReady(); } catch (e) { ready = false; this.record('load', 'Page loads and app script runs', 'FAIL', e.message); await this.failShot('load'); }

    await this.check('c', 'DOM: 2048 .w, 25 .sec, 25 .reel__l, no inputs/links, html.js', async () => {
      const d = await this.eval(pageDom);
      this.dom = d;
      const p2 = [];
      if (d.w !== WORDS) p2.push(`${d.w} .w (want ${WORDS})`);
      if (d.sec !== LETTERS) p2.push(`${d.sec} .sec (want ${LETTERS})`);
      if (d.reel !== LETTERS) p2.push(`${d.reel} .reel__l (want ${LETTERS})`);
      if (d.forbidden.length) p2.push(`forbidden elements: ${d.forbidden.join(' | ')}`);
      if (!d.js || d.noJs) p2.push(`html class: js=${d.js} no-js=${d.noJs}`);
      if (d.firstWord !== 'abandon' || d.lastWord !== 'zoo') p2.push(`first/last word ${d.firstWord}/${d.lastWord}`);
      if (!d.sorted) p2.push('words not strictly sorted');
      const size = (name, v, want) => { if (!v || v.min !== want || v.max !== want) p2.push(`${name} height ${v ? (v.min === v.max ? v.min : `${v.min}–${v.max}`) : '?'}px (spec ${want}px)`); };
      size('.w', d.row, ROW);
      size('.head', d.head, HEAD);
      size('.reel__l', d.notch, NOTCH);
      return [p2, `${d.w} words (${d.firstWord}…${d.lastWord}), ${d.sec} sections, ${d.reel} reel letters, 0 forbidden elements, html.js; rows ${d.row?.max}px, headers ${d.head?.max}px, reel notch ${d.notch?.max}px; viewport ${d.viewport.w}x${d.viewport.h}@${d.viewport.dpr}x`];
    });
    this.sections = ready ? await this.eval(pageSections).catch(() => null) : null;

    await this.check('d', 'Initial state: abandon + A centred, verify ok ≤3s', async () => {
      const s = await this.snapshot();
      const p2 = this.restProblems(s, { expectWord: 'abandon', expectLetter: 'A' });
      const v = await this.poll(() => document.getElementById('verify')?.dataset.state, [], (x) => x === 'ok', Math.max(0, VERIFY_TIMEOUT - (now() - this.loadedAt)), 'verify');
      if (!v.ok) p2.push(`#verify data-state="${v.value}" ${fmt(now() - this.loadedAt)}ms after load (want ok ≤${VERIFY_TIMEOUT}ms)`);
      await this.auditHighlight('initial');
      return [p2, `${this.describe(s)}; #verify ${v.value} ${fmt(now() - this.loadedAt)}ms after load (list centre ${fmt(s.vc)}px, reel centre ${fmt(s.rc)}px)`];
    });
    this.urlBaseline = ready ? await this.urlState().catch(() => null) : null;
    if (ready) await this.shotPair('1-initial').catch((e) => this.shotErrors.push(`initial: ${e.message}`));

    // ---- service worker: ready + controlling (reload once if needed)
    this.phase = 'sw';
    this.sw = await this.ensureServiceWorker();
    // Let late load-time fetches (browser favicon/manifest) finish before the quiet window starts.
    this.idleBeforeInteract = await this.waitNetworkIdle(500, 5000);

    // ---- interactions: from here until the veil check, the page must not touch the network
    this.phase = 'interact';
    const g = await this.geometry();
    this.geo = g;
    const listX = Math.round(Math.min(g.reelLeft, g.w) * 0.4); // on the word rows, clear of the reel
    const reelX = Math.round(g.reelX);
    const notch = g.notch > 0 ? g.notch : NOTCH;

    await this.check('e', 'List fling: settles centred, reel letter matches', async () => {
      const before = await this.snapshot();
      await this.eval(pageStartFrames);
      // ~2 700 px/s upward flick over the lower-middle of the list, released at speed.
      await this.touchDrag(listX, Math.round(g.h * 0.72), Math.round(g.h * 0.36), 110, 0);
      const st = await this.waitStable();
      const frames = await this.eval(pageStopFrames);
      this.frameStats = frameStats(frames);
      const s = await this.snapshot();
      const p2 = this.restProblems(s);
      const moved = s.list.top - before.list.top;
      const finger = Math.round(g.h * 0.36);
      // The gesture must clearly have scrolled the list; how far the fling carries is Chrome's business.
      if (moved < finger / 2) p2.push(`list moved only ${fmt(moved)}px for a ${finger}px flick (touch gesture not applied?)`);
      await this.auditHighlight('list fling');
      return [p2, `${this.describe(s)}; moved ${fmt(moved)}px for a ${finger}px flick (×${fmt(moved / finger)}), settled in ${st.ms}ms`];
    });
    await this.shotPair('2-mid-list').catch((e) => this.shotErrors.push(`mid-list: ${e.message}`));

    await this.check('f1', 'Reel slow drag 3 notches up from A → D, list at "dad"', async () => {
      let s = await this.snapshot();
      const pre = [];
      if (s.reelActive?.text !== 'A') {
        // Bring the reel back to A first (drag down past the top), so the drag below starts at A.
        const k = Math.max(1, s.reelActive?.index ?? 1);
        await this.touchDrag(reelX, Math.round(g.h * 0.2), Math.round(g.h * 0.2 + Math.min(g.h * 0.7, (k + 1) * notch)), 700, 200);
        await this.waitStable();
        s = await this.snapshot();
        pre.push(`reset reel to ${s.reelActive?.text} first`);
        if (s.reelActive?.text !== 'A') return [[`could not bring the reel back to A first: ${this.describe(s)}`], pre.join('; ')];
      }
      const y0 = Math.round(g.h * 0.62);
      await this.touchDrag(reelX, y0, y0 - 3 * notch, 900, 250); // 3 notches = 168px with the spec's 56px notch
      await this.waitStable();
      s = await this.snapshot();
      const p2 = this.restProblems(s, { expectWord: 'dad', expectLetter: 'D' });
      if (s.reel && Math.abs(s.reel.top - 3 * notch) > 1) p2.push(`reel scrollTop ${fmt(s.reel.top)} (want ${3 * notch})`);
      const driving = /\bis-reel-driving\b/.test(s.classes);
      await this.auditHighlight('reel drag');
      return [p2, `${pre.length ? pre.join('; ') + '; ' : ''}dragged ${3 * notch}px: ${this.describe(s)}; reel scrollTop ${fmt(s.reel?.top)}; html.is-reel-driving=${driving}`];
    });
    await this.shotPair('3-after-reel-drag').catch((e) => this.shotErrors.push(`after reel drag: ${e.message}`));

    await this.check('f2', 'Reel fast fling: list lands on the first word of the reel letter', async () => {
      const before = await this.snapshot();
      await this.touchDrag(reelX, Math.round(g.h * 0.75), Math.round(g.h * 0.45), 80, 0);
      await this.waitStable();
      const s = await this.snapshot();
      const p2 = this.restProblems(s);
      const sec = this.sections?.find((x) => x.letter === s.reelActive?.text.toLowerCase());
      if (!sec) p2.push(`no section for reel letter ${s.reelActive?.text}`);
      else if (s.centred?.text !== sec.first) p2.push(`list shows "${s.centred?.text}", want first ${sec.letter.toUpperCase()} word "${sec.first}"`);
      if (s.reelActive && before.reelActive && s.reelActive.index <= before.reelActive.index) p2.push(`reel did not advance (${before.reelActive.text} → ${s.reelActive.text})`);
      await this.auditHighlight('reel fling');
      return [p2, `${before.reelActive?.text} → ${this.describe(s)}`];
    });

    await this.check('g', 'List drag across a letter boundary: reel follows', async () => {
      const s = await this.snapshot();
      if (!s.centred || !this.sections) return [['no centred word / section data'], ''];
      const k = this.sections.findIndex((x) => x.letter === s.centred.letter);
      // Target: two rows past the nearest letter boundary (backwards if possible, else forwards).
      const options = [];
      if (k > 0) options.push({ target: this.sections[k].firstIndex - 2, want: this.sections[k - 1].letter });
      if (k >= 0 && k < this.sections.length - 1) options.push({ target: this.sections[k + 1].firstIndex + 1, want: this.sections[k + 1].letter });
      const dists = await this.eval((i, ts) => {
        const w = document.querySelectorAll('.w');
        const c = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        return ts.map((t) => c(w[i]) - c(w[t]));
      }, s.centred.index, options.map((o) => o.target));
      options.forEach((o, j) => { o.dist = dists[j]; });
      const opt = options.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0];
      if (!opt || Math.abs(opt.dist) > g.h * 0.55) return ['SKIP', `no letter boundary within a one-finger drag of "${s.centred.text}" (f2 failed?)`];
      // Finger moves by +dist (down = back towards A); start so the whole path stays on screen.
      const y0 = opt.dist > 0 ? Math.round(g.h * 0.25) : Math.round(g.h * 0.75);
      await this.touchDrag(listX, y0, y0 + opt.dist, 700, 250);
      await this.waitStable();
      const s2 = await this.snapshot();
      const p2 = this.restProblems(s2);
      if (s2.centred?.letter !== opt.want) p2.push(`centred word "${s2.centred?.text}" is not in ${opt.want.toUpperCase()}`);
      if (s2.reelActive?.text.toLowerCase() !== opt.want) p2.push(`reel stayed on ${s2.reelActive?.text} (want ${opt.want.toUpperCase()})`);
      if (/\bis-reel-driving\b/.test(s2.classes)) p2.push('html.is-reel-driving still set after the list was dragged');
      return [p2, `"${s.centred.text}" → drag ${fmt(opt.dist)}px → ${this.describe(s2)}`];
    });

    // Extra (beyond the spec's list): the ~120 ms hand-off. Grabbing one strip while the other still
    // coasts must leave both consistent. Chrome already stops the coasting strip by itself (a new touch
    // or the app's scrollTop jump preempts the fling), so this guards the driver/echo rules, not
    // freeze() itself, which exists for iOS Safari momentum and cannot be exercised here.
    await this.check('g3', 'Hand-off mid-motion: grab one strip while the other still coasts', async () => {
      if (!this.sections) return [['no section data'], ''];
      const p2 = [];
      const det = [];
      const moving = () => this.eval(() => new Promise((r) => {
        const l = document.getElementById('list'), rl = document.getElementById('reel');
        const a = [l.scrollTop, rl.scrollTop];
        setTimeout(() => r({ list: l.scrollTop !== a[0], reel: rl.scrollTop !== a[1] }), 30);
      }));
      // 1) Fling the list, then take the reel one notch while the list is still coasting.
      await this.touchDrag(listX, Math.round(g.h * 0.72), Math.round(g.h * 0.36), 110, 0);
      const m1 = await moving();
      await this.touchDrag(reelX, Math.round(g.h * 0.6), Math.round(g.h * 0.6) - notch, 500, 250);
      await this.waitStable();
      let s = await this.snapshot();
      for (const x of this.restProblems(s)) p2.push(`reel grab: ${x}`);
      const sec = this.sections.find((x) => x.letter === s.reelActive?.text.toLowerCase());
      if (sec && s.centred?.text !== sec.first) p2.push(`reel grab: list shows "${s.centred?.text}", want first ${sec.letter.toUpperCase()} word "${sec.first}"`);
      det.push(`list ${m1.list ? 'coasting' : 'already still'} → reel grab: ${this.describe(s)}`);
      // 2) Fling the reel, then drag the list two rows while the reel is still coasting.
      await this.touchDrag(reelX, Math.round(g.h * 0.75), Math.round(g.h * 0.45), 80, 0);
      const m2 = await moving();
      await this.touchDrag(listX, Math.round(g.h * 0.6), Math.round(g.h * 0.6) - 2 * ROW, 400, 250);
      await this.waitStable();
      s = await this.snapshot();
      for (const x of this.restProblems(s)) p2.push(`list grab: ${x}`);
      if (/\bis-reel-driving\b/.test(s.classes)) p2.push('list grab: html.is-reel-driving still set');
      det.push(`reel ${m2.reel ? 'coasting' : 'already still'} → list grab: ${this.describe(s)}`);
      return [p2, det.join('; ')];
    });

    await this.check('g2', 'End of list: reel to Z, list to the end: zoo, outro', async () => {
      let s = await this.snapshot();
      for (let i = 0; i < 5 && s.reelActive?.text !== 'Z'; i++) {
        await this.touchDrag(reelX, Math.round(g.h * 0.85), Math.round(g.h * 0.25), 90, 0);
        await this.waitStable();
        s = await this.snapshot();
      }
      if (s.reelActive?.text !== 'Z') return [[`reel flings did not reach Z (${this.describe(s)})`], ''];
      const p2 = this.restProblems(s, { expectWord: 'zebra', expectLetter: 'Z' });
      for (let i = 0; i < 4 && s.list.top < s.list.max - 1; i++) {
        await this.touchDrag(listX, Math.round(g.h * 0.75), Math.round(g.h * 0.3), 100, 0);
        await this.waitStable();
        s = await this.snapshot();
      }
      if (s.list.top < s.list.max - 1) p2.push(`list stopped at ${fmt(s.list.top)} of ${fmt(s.list.max)}`);
      if (s.centred?.text !== 'zoo') p2.push(`centred word at the end is "${s.centred?.text}" (want zoo)`);
      if (s.reelActive?.text !== 'Z') p2.push(`reel shows ${s.reelActive?.text} at the end`);
      const outro = await this.eval(() => { const r = document.querySelector('.outro')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; });
      if (!outro || outro.top > g.h) p2.push('outro not visible at the end');
      await this.shotPair('4-end').catch((e) => this.shotErrors.push(`end: ${e.message}`));
      await this.auditHighlight('end of list');
      return [p2, `reel → Z ("zebra"), list at end (${fmt(s.list.top)}/${fmt(s.list.max)}): "${s.centred?.text}", outro top at ${fmt(outro?.top)}px`];
    });

    await this.check('n', 'No current-word highlight: the centred row looks like every other row', async () => {
      const p2 = [];
      for (const h of this.highlight) for (const x of h.problems) p2.push(`${h.label}: ${x}`);
      if (!this.highlight.length) p2.push('no audit ran');
      return [p2, `no .lens/#bits/.w.is-active; computed styles, overlapping boxes and pixels checked at ${this.highlight.length} resting positions: ${this.highlight.map((h) => `${h.label}: ${h.detail}`).join('; ')}`];
    });

    await this.check('i', 'Veil: html.is-veiled while the page is hidden', () => this.checkVeil());

    const interactionRequests = this.requests.filter((r) => r.phase === 'interact');

    // ---- desktop screenshots (fresh load at 1280x800)
    this.phase = 'desktop';
    await this.check('h2', 'Desktop 1280x800: fresh load centred + screenshots', async () => {
      await this.emulateDesktop();
      await this.reload();
      await this.waitAppReady();
      await this.waitStable(5000);
      const s = await this.snapshot();
      await this.setScheme('dark');
      await this.screenshot('desktop-dark');
      await this.setScheme('light');
      await this.screenshot('desktop-light');
      await this.setScheme('dark');
      return [this.restProblems(s, { expectWord: 'abandon', expectLetter: 'A' }), this.describe(s)];
    });
    await this.emulatePhone();

    // ---- offline via the service worker
    this.phase = 'offline';
    await this.check('j', 'Offline: reload served by the service worker, 2048 words', () => this.checkOffline());

    // ---- privacy red team (p*, r*): more input on this tab and its end state, then attacks from isolated
    // browser contexts, whose events stay out of checks a and b.
    await this.runPrivacyChecks();
    this.phase = 'done';
    await this.waitNetworkIdle(300, 3000);
    await this.eval(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))).catch(() => {});
    await this.collectProbe();

    // ---- summaries: (h) screenshots, (a) console/CSP, (b) network, (k) frame times
    const shots = this.shots.filter((f) => !/[\\/]fail-[^\\/]*$/.test(f));
    const mobile = shots.filter((f) => /mobile-(dark|light)-/.test(f)).length;
    const desktop = shots.filter((f) => /desktop-/.test(f)).length;
    const hp = [...this.shotErrors];
    if (mobile < 8) hp.push(`${mobile}/8 mobile screenshots`);
    if (desktop < 1) hp.push('no desktop screenshot');
    this.record('h', 'Screenshots: 4 states × dark/light + desktop', hp.length ? 'FAIL' : 'PASS',
      hp.length ? hp.join('; ') : `${mobile} mobile + ${desktop} desktop PNGs in ${displayPath(this.outDir)}`);
    this.checkConsole();
    this.checkNetwork(interactionRequests);
    const fs2 = this.frameStats;
    this.record('k', 'Frame times during the list fling (info only)', 'INFO',
      fs2 ? `rAF interval p50 ${fmt(fs2.p50)}ms, p95 ${fmt(fs2.p95)}ms, max ${fmt(fs2.max)}ms over ${fs2.n} frames` : 'not measured');
  }

  // ---------------------------------------------------------------------------------------------------
  // Privacy red team (p*, r*): try to break the zero-tracking promise; SECURITY.md has the threat model.
  // p1-p6 use this tab after all the scrolling, hiding and reloading above. p7-p15 attack from isolated
  // browser contexts (fresh storage), with an attacker server on another site (localhost vs 127.0.0.1).
  // ---------------------------------------------------------------------------------------------------
  async runPrivacyChecks() {
    this.phase = 'privacy';
    await this.check('p1', 'Keyboard, wheel, rotation: still centred and in sync, no request', () => this.checkMoreInput());
    this.phase = 'privacy-end';
    await this.check('p2', 'Storage empty after interaction: no cookies/local/session/IndexedDB; cache = sw.js ASSETS; 1 SW', () => this.checkStorage());
    await this.check('p3', 'No URL, history, title or window.name change after interaction and reloads', () => this.checkUrlUnchanged());
    await this.check('p4', 'Runtime spy: page calls no network/storage/URL/history API; listeners are scroll + passive engage', () => this.checkSpy());
    await this.check('p5', 'Shipped code never reads URL/referrer/name/messages, stores or sends anything (static scan)', () => this.checkShippedCode());
    await this.check('p6', 'Offline reload: every page request answered by the SW; no page network attempt', () => this.checkOfflineAttempts());

    this.phase = 'attack';
    let att = null;
    try {
      att = await startAttacker(this.target.url);
      onCleanup(() => att.close());
    } catch (e) {
      this.record('p7', 'Attacker server', 'FAIL', `could not start: ${e.message}`);
      return;
    }
    onCleanup(async () => { for (const close of [...this.contexts]) await close(); });
    this.attacker = att;
    await this.checkInjection(att); // p7 hostile URL, p9 CSP, p8 Trusted Types (one isolated tab)
    await this.check('p10', 'Selection and copy impossible; translate=no everywhere; nothing editable', () => this.checkSelection());
    await this.checkFraming(att); // p11 + r1
    await this.checkOpener(att); // p12 + r2
    await this.check('p13', 'file:// single saved file works offline: 2048 words, verify ok, no network', () => this.checkFileUrl());
    await this.check('p14', 'JavaScript disabled: list still scrolls and snaps; no reel, storage or request', () => this.checkJsDisabled());
    await this.check('p15', 'Back/forward cache: coming back shows abandon, not the last word', () => this.checkBfcache(att));
    await this.check('p16', 'Behind other tabs for the attack checks: this tab made no request', async () => {
      const r = this.requests.filter((q) => q.ctx === 'page' && q.phase === 'attack' && !/^(data|blob|about):/.test(q.url));
      const vis = await this.eval(() => document.visibilityState).catch(() => '?');
      return [r.map((q) => `request while in the background: ${q.method} ${q.url}`), `${r.length} page requests while the isolated attack tabs were in front (page now ${vis})`];
    });
  }

  // p1: the ways to scroll that the touch checks above do not use. Everything here is phase 'privacy'.
  async checkMoreInput() {
    const p = [];
    const det = [];
    await this.page.send('Page.bringToFront').catch(() => {});
    const g = await this.geometry();
    const listX = Math.round(Math.min(g.reelLeft, g.w) * 0.4);
    const key = async (keyName, vk, times = 1) => {
      for (let i = 0; i < times; i++) {
        await this.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      }
    };
    const step = async (label, act, expect = {}) => {
      await act();
      await this.waitStable(SETTLE_TIMEOUT, 400);
      const s = await this.snapshot();
      for (const x of expect === 'end' ? this.endProblems(s) : this.restProblems(s, expect)) p.push(`${label}: ${x}`);
      det.push(`${label} → ${s.centred?.text ?? '?'}/${s.reelActive?.text ?? '?'}`);
      return s;
    };
    const focused = await this.eval(() => document.activeElement?.id || document.activeElement?.tagName || null);
    if (focused !== 'list') p.push(`keyboard focus is on ${focused}, not #list`);
    await step('End', () => key('End', 35), 'end');
    await step('Home', () => key('Home', 36), { expectWord: 'abandon', expectLetter: 'A' });
    await step('PageDown×2', () => key('PageDown', 34, 2));
    await step('ArrowDown×3', () => key('ArrowDown', 40, 3));
    const w0 = await step('wheel on list', () => this.page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: listX, y: Math.round(g.h / 2), deltaX: 0, deltaY: 900 }));
    const wheelReel = () => this.page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(g.reelX), y: Math.round(g.h / 2), deltaX: 0, deltaY: 2 * (g.notch || NOTCH) });
    let w1 = await step('wheel on reel', wheelReel);
    if (w0.reelActive && w1.reelActive && w1.reelActive.index <= w0.reelActive.index) {
      // App quirk (reported, not a privacy issue): Chrome scrolls the reel on the compositor before the
      // passive wheel listener runs, and engage() -> settleReel() -> alignReel() writes scrollTop, which
      // cancels that scroll. So the first wheel tick on the reel after using the list is swallowed.
      det.push('(first wheel tick on the reel swallowed: app quirk)');
      w1 = await step('wheel on reel again', wheelReel);
    }
    const sec = this.sections?.find((x) => x.letter === w1.reelActive?.text.toLowerCase());
    if (sec && w1.centred?.text !== sec.first) p.push(`wheel on reel: list shows "${w1.centred?.text}", want first ${sec.letter.toUpperCase()} word "${sec.first}"`);
    if (w0.reelActive && w1.reelActive && w1.reelActive.index <= w0.reelActive.index) p.push(`wheel on reel did not advance it (${w0.reelActive.text} → ${w1.reelActive.text})`);
    const word = w1.centred?.text;
    await step('landscape', () => this.page.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.height, height: PHONE.width, deviceScaleFactor: PHONE.deviceScaleFactor, mobile: true,
      screenWidth: PHONE.height, screenHeight: PHONE.width, screenOrientation: { type: 'landscapePrimary', angle: 90 },
    }), { expectWord: word });
    await step('portrait', () => this.emulatePhone(), { expectWord: word });
    const reqs = this.requests.filter((r) => r.phase === 'privacy' && r.ctx === 'page' && !/^(data|blob|about):/.test(r.url));
    for (const r of reqs) p.push(`page request while scrolling: ${r.method} ${r.url}`);
    return [p, `${det.join(', ')}; ${reqs.length} page requests`];
  }

  // VERSION and ASSETS of the deployed sw.js: what Cache Storage may hold (p2), and its source (p5).
  async swInfo() {
    if (this.swCache) return this.swCache;
    const url = new URL('./sw.js', this.target.url).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const text = await res.text();
    const v = /\bVERSION\s*=\s*("(?:[^"\\]|\\.)*")/.exec(text);
    const a = /\bASSETS\s*=\s*(\[[^\]]*\])/.exec(text);
    const prefix = /\bCACHE\s*=\s*'([^']*)'\s*\+\s*VERSION\b/.exec(text);
    const version = v ? JSON.parse(v[1]) : null;
    this.swCache = {
      text,
      version,
      cacheName: version === null ? null : `${prefix ? prefix[1] : 'bip39-'}${version}`,
      assets: a ? JSON.parse(a[1]).map((x) => new URL(x, url).href).sort() : null,
    };
    return this.swCache;
  }

  // p2
  async checkStorage() {
    const p = [];
    const origin = this.target.origin;
    const sw = await this.swInfo();
    if (!sw.assets || !sw.cacheName) p.push('could not read VERSION/ASSETS from sw.js');
    const { cookies } = await this.cdp.send('Storage.getCookies', this.mainContextId ? { browserContextId: this.mainContextId } : {});
    if (cookies.length) p.push(`${cookies.length} cookie(s): ${cookies.map((c) => `${c.name}@${c.domain}`).join(', ')}`);
    const docCookie = await this.eval(() => document.cookie);
    if (docCookie) p.push(`document.cookie is "${docCookie.slice(0, 80)}"`);
    await this.page.send('DOMStorage.enable').catch(() => {});
    for (const isLocalStorage of [true, false]) {
      const kind = isLocalStorage ? 'localStorage' : 'sessionStorage';
      const r = await this.page.send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage } }).catch((e) => ({ error: e.message }));
      if (r.error) p.push(`${kind}: ${r.error}`);
      else if (r.entries.length) p.push(`${kind} holds ${r.entries.length} item(s): ${r.entries.map((e) => e[0]).join(', ')}`);
    }
    const idb = await this.page.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin }).catch((e) => ({ error: e.message }));
    if (idb.error) p.push(`IndexedDB: ${idb.error}`);
    else if (idb.databaseNames.length) p.push(`IndexedDB databases: ${idb.databaseNames.join(', ')}`);
    const { caches } = await this.page.send('CacheStorage.requestCacheNames', { securityOrigin: origin });
    const names = caches.map((c) => c.cacheName);
    if (sw.cacheName && (names.length !== 1 || names[0] !== sw.cacheName)) p.push(`Cache Storage holds ${JSON.stringify(names)} (want only "${sw.cacheName}")`);
    let entries = 0;
    const missing = [];
    for (const c of caches) {
      const { cacheDataEntries } = await this.page.send('CacheStorage.requestEntries', { cacheId: c.cacheId, skipCount: 0, pageSize: 200 });
      const urls = cacheDataEntries.map((e) => e.requestURL);
      entries += urls.length;
      const extra = sw.assets ? urls.filter((u) => !sw.assets.includes(u)) : [];
      if (extra.length) p.push(`cache "${c.cacheName}" holds more than sw.js ASSETS: ${extra.join(', ')}`);
      if (sw.assets) missing.push(...sw.assets.filter((u) => !urls.includes(u)));
    }
    const usage = await this.page.send('Storage.getUsageAndQuota', { origin });
    const used = usage.usageBreakdown.filter((u) => u.usage > 0 && !['cache_storage', 'service_workers'].includes(u.storageType));
    if (used.length) p.push(`storage in use besides the offline copy: ${used.map((u) => `${u.storageType} ${u.usage} B`).join(', ')}`);
    const regs = await this.eval(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: (r.active || r.waiting || r.installing)?.scriptURL ?? null })));
    const scope = new URL('./', this.target.url).href;
    const script = new URL('./sw.js', this.target.url).href;
    if (regs.length !== 1 || regs[0].scope !== scope || regs[0].script !== script) p.push(`service worker registrations ${JSON.stringify(regs)} (want exactly ${script} for ${scope})`);
    const kb = (t) => fmt((usage.usageBreakdown.find((u) => u.storageType === t)?.usage ?? 0) / 1024);
    return [p, `0 cookies, localStorage/sessionStorage/IndexedDB empty; Cache Storage: "${names.join('", "')}" with ${entries} entries, all in sw.js ASSETS${missing.length ? ` (not yet cached: ${missing.length})` : ''}; usage: cache ${kb('cache_storage')} KB + SW ${kb('service_workers')} KB, nothing else; 1 SW registration (${script})`];
  }

  async urlState() {
    const inPage = await this.eval(() => ({ href: location.href, title: document.title, name: window.name, length: history.length, state: history.state }));
    const nav = await this.page.send('Page.getNavigationHistory');
    return { ...inPage, entries: nav.entries.map((e) => e.url), current: nav.currentIndex };
  }

  // p3
  async checkUrlUnchanged() {
    const a = this.urlBaseline;
    if (!a) return ['SKIP', 'no baseline (first load failed)'];
    const b = await this.urlState();
    const p = [];
    for (const k of ['href', 'title', 'name', 'length', 'current']) if (a[k] !== b[k]) p.push(`${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
    if (b.state !== null) p.push(`history.state is ${JSON.stringify(b.state)}`);
    if (JSON.stringify(a.entries) !== JSON.stringify(b.entries)) p.push(`session history ${JSON.stringify(a.entries)} → ${JSON.stringify(b.entries)}`);
    if (b.href !== this.target.url) p.push(`URL is ${b.href}, not ${this.target.url}`);
    return [p, `after ${this.docLoads} loads of this tab and all the scrolling: URL ${b.href}, title "${b.title}", window.name "${b.name}", history.length ${b.length}, state null, session history unchanged (${b.entries.length} entries)`];
  }

  // p4
  async checkSpy() {
    await this.collectProbe();
    const p = [];
    const log = this.spyLog;
    if (!log.length) return [['the spy recorded nothing (not installed?)'], ''];
    const calls = log.filter((x) => x.api !== 'listen');
    const bad = calls.filter((x) => !(x.api === 'serviceWorker.register' && x.detail === './sw.js'));
    for (const x of summarizeSpy(bad)) p.push(`page code used ${x}`);
    const listens = log.filter((x) => x.api === 'listen');
    for (const x of listens) {
      if (!LISTEN_OK.has(x.detail)) p.push(`page code listens for "${x.detail}" on ${x.on}`);
      else if (MUST_BE_PASSIVE.has(x.detail) && !x.passive) p.push(`"${x.detail}" listener on ${x.on} is not passive`);
    }
    // on* handler properties and anything the spy could not see: DevTools' own listener list.
    const seen = [];
    for (const [expr, label] of [['window', 'window'], ['document', 'document'], ["document.getElementById('list')", '#list'], ["document.getElementById('reel')", '#reel']]) {
      const { result } = await this.page.send('Runtime.evaluate', { expression: expr });
      if (!result?.objectId) continue;
      const { listeners } = await this.page.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      await this.page.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
      for (const l of listeners) {
        seen.push(`${label}:${l.type}`);
        if (!LISTEN_OK.has(l.type) && l.type !== 'securitypolicyviolation') p.push(`${label} has a "${l.type}" listener`);
      }
    }
    const regs = calls.length - bad.length;
    const types = [...new Set(listens.map((x) => `${x.on} ${x.detail}${x.passive ? ' (passive)' : ''}`))];
    return [[...new Set(p)], `${this.docLoads} page loads; page code called serviceWorker.register('./sw.js') ${regs}× and none of fetch, XHR, sendBeacon, WebSocket, EventSource, RTCPeerConnection, Worker, window.open, postMessage, history.*, Storage, cookies, IndexedDB, caches, clipboard, window.name, referrer, document.URL or baseURI; listeners: ${types.join(', ')}`];
  }

  // p5
  async checkShippedCode() {
    const p = [];
    const html = await (await fetch(this.target.url)).text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const external = scripts.filter((m) => /\bsrc\s*=/i.test(m[1]));
    if (external.length) p.push(`${external.length} external <script src>`);
    const code = stripComments(scripts.map((m) => m[2]).join('\n'));
    const sw = stripComments((await this.swInfo()).text);
    const hits = (src, deny, where) => {
      for (const [re, why] of deny) {
        const m = re.exec(src);
        if (m) p.push(`${where}: ${why}: "…${src.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}…"`);
      }
    };
    hits(code, SCRIPT_DENY, 'page script');
    hits(sw, SW_DENY, 'sw.js');
    // Self-test: the patterns catch what they are there for.
    const bad = ['location.hash', 'const q = document.referrer', 'x = window.name', "addEventListener('message', f)", 'localStorage.setItem(k, v)',
      'fetch(u)', 'navigator.sendBeacon(u, d)', 'history.pushState(null, "", u)', 'eval(s)', 'el.innerHTML = s', 'new Worker(u)', 'window.open(u)', 'new URLSearchParams(q)'];
    const missed = bad.filter((x) => !SCRIPT_DENY.some(([re]) => re.test(x)));
    if (missed.length) p.push(`scanner self-test missed: ${missed.join(' | ')}`);
    return [p, `${scripts.length} inline script (${fmt(code.length / 1024)} KB without comments) and sw.js (${fmt(sw.length / 1024)} KB) match none of ${SCRIPT_DENY.length} + ${SW_DENY.length} patterns: no location/referrer/window.name/opener/messages, storage, history, network, string-to-code or HTML sinks; sw.js fetches only the request it intercepts; scanner self-test ok`];
  }

  // p6 (uses what check j recorded)
  checkOfflineAttempts() {
    const j = this.results.find((r) => r.id === 'j');
    const reqs = this.requests.filter((r) => r.phase === 'offline' && !/^(data|blob|about):/.test(r.url));
    if (j?.status !== 'PASS' || !reqs.length) return ['SKIP', 'the offline reload (j) did not pass'];
    const p = [];
    const page = reqs.filter((r) => r.ctx === 'page');
    for (const r of page.filter((q) => !q.fromSW)) p.push(`page request not answered by the service worker: ${r.method} ${r.url} (${r.error ?? r.status})`);
    const sw = reqs.filter((r) => r.ctx === 'sw');
    for (const r of sw.filter((q) => !(q.method === 'GET' && q.url === this.target.url))) p.push(`service worker network attempt besides the page itself: ${r.method} ${r.url}`);
    return [p, `offline reload: ${page.length} page requests, all answered from the SW cache; network attempts: ${sw.map((r) => `SW GET ${new URL(r.url).pathname} → ${r.error ?? r.status}`).join(', ') || 'none'} (the SW tries the network first for the page itself, so an online reload picks up a new deployment)`];
  }

  // ---- isolated browser contexts --------------------------------------------------------------------
  async isolatedPage({ phone = true, touch = phone, jsDisabled = false, width = 420, height = 700 } = {}) {
    const cdp = this.cdp;
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const offs = [];
    const close = async () => {
      if (!this.contexts.delete(close)) return;
      offs.forEach((off) => off());
      await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    };
    this.contexts.add(close);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = new Session(cdp, sessionId, { targetId, browserContextId });
    const rec = { requests: [], dialogs: [], exceptions: [] };
    offs.push(
      s.on('Network.requestWillBeSent', (e) => rec.requests.push({ url: e.request.url, method: e.request.method, type: e.type })),
      s.on('Page.javascriptDialogOpening', (e) => { rec.dialogs.push(e.message); s.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); }),
      s.on('Runtime.exceptionThrown', (e) => rec.exceptions.push(String(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).split('\n')[0])),
    );
    await Promise.all([s.send('Page.enable'), s.send('Runtime.enable'), s.send('Network.enable')]);
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    if (phone) await s.send('Emulation.setDeviceMetricsOverride', { ...PHONE, mobile: true, screenWidth: PHONE.width, screenHeight: PHONE.height });
    else await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
    if (touch) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (jsDisabled) await s.send('Emulation.setScriptExecutionDisabled', { value: true });
    await s.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return { s, rec, targetId, browserContextId, close };
  }

  // html.js, all rows and the integrity check done, both strips at rest.
  async waitReadyIn(s, { verify = true } = {}) {
    const r = await pollIn(s, () => ({ ready: document.readyState, js: document.documentElement.classList.contains('js'), n: document.querySelectorAll('.w').length, verify: document.getElementById('verify')?.dataset.state }),
      (v) => v.ready === 'complete' && v.js && v.n === WORDS && (!verify || v.verify === 'ok'), 8000);
    if (!r.ok) throw new Error(`page not ready: ${JSON.stringify(r.value)}`);
    const st = await evalIn(s, pageWaitStable, 300, 5000);
    if (!st.ok) throw new Error(`scroll did not settle (${st.value})`);
  }

  // p7 (hostile URLs), then p9 (CSP) and p8 (Trusted Types) in the same isolated tab.
  async checkInjection(att) {
    let tab;
    try {
      tab = await this.isolatedPage();
    } catch (e) {
      for (const id of ['p7', 'p9', 'p8']) this.record(id, 'Injection checks', 'FAIL', `isolated tab: ${e.message}`);
      return;
    }
    const { s, rec, close } = tab;
    try {
      await this.check('p7', 'Hostile query, hash, referrer and window.name: inert (same DOM, no dialog/request)', async () => {
        const p = [];
        await navigateIn(s, this.target.url);
        await this.waitReadyIn(s);
        // window.name survives same-site navigations: the page below starts with this one.
        await evalIn(s, () => { window.name = '"><svg onload=alert(7)><img src=x onerror=alert(8)>'; return true; });
        const clean = await evalIn(s, pageFingerprint);
        const payloads = [
          '?q=%3Cscript%3Ewindow.__pwned%3D1%3C%2Fscript%3E&x=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E#%3Cimg%20src%3Dx%20onerror%3Dalert(2)%3E',
          '?javascript:alert(3)#javascript:alert(4)//',
          '?__proto__%5Bpolluted%5D=1&constructor%5Bprototype%5D%5Bpolluted%5D=1&w=zoo#%22%3E%3Csvg%20onload%3Dalert(5)%3E',
        ];
        const before = rec.requests.length;
        for (const q of payloads) {
          const url = new URL(q, this.target.url).href;
          await navigateIn(s, url, { referrer: `${att.url}/?r=%3Cscript%3Ealert(6)%3C%2Fscript%3E` });
          await this.waitReadyIn(s);
          const f = await evalIn(s, pageFingerprint);
          const tag = q.slice(0, 24);
          if (f.dom !== clean.dom) p.push(`${tag}…: the DOM differs from a clean load (${f.dom} vs ${clean.dom})`);
          if (f.pwned !== null || f.polluted !== null) p.push(`${tag}…: payload ran (pwned=${f.pwned}, polluted=${f.polluted})`);
          if (f.csp.length) p.push(`${tag}…: ${f.csp.length} CSP/TT report(s): ${f.csp.join(', ')}`);
          if (f.images || f.scripts !== clean.scripts || f.title !== clean.title) p.push(`${tag}…: images ${f.images}, scripts ${f.scripts}, title "${f.title}"`);
          if (!f.referrer.startsWith(att.url)) p.push(`${tag}…: the hostile referrer was not delivered (${f.referrer}), test is void`);
          if (!f.name.includes('onload')) p.push(`${tag}…: the hostile window.name was not delivered, test is void`);
        }
        const foreign = rec.requests.slice(before).filter((r) => { try { return new URL(r.url).origin !== this.target.origin; } catch { return !/^(data|blob|about):/.test(r.url); } });
        for (const r of foreign) p.push(`request to another origin: ${r.method} ${r.url}`);
        if (rec.dialogs.length) p.push(`dialogs opened: ${rec.dialogs.join(' | ')}`);
        return [p, `3 hostile URLs (script/img/svg/javascript:/__proto__ in query and hash) with a hostile referrer and window.name: DOM sha256 ${clean.dom} identical to a clean load each time, list at abandon, 0 dialogs, 0 CSP reports, 0 cross-origin requests`];
      });

      await this.check('p9', 'CSP blocks injected external fetch/XHR/beacon/WS/SSE/img/CSS/font/import/frame/form', async () => {
        const p = [];
        await navigateIn(s, this.target.url);
        await this.waitReadyIn(s);
        const X = att.url;
        const log0 = att.log.length;
        const tcp0 = att.connections();
        const r = await evalIn(s, pageCspProbe, X);
        await sleep(400); // anything that got through would reach the attacker server by now
        const hits = att.log.slice(log0).filter((x) => x.url.startsWith('/p9-'));
        for (const h of hits) p.push(`the attacker server received ${h.method} ${h.url}`);
        if (r.base) p.push(`an injected <base> changed document.baseURI to ${r.base}`);
        if (!r.csp.length) p.push('no securitypolicyviolation was reported (probe missing?)');
        const tcp = att.connections() - tcp0;
        const dirs = Object.entries(r.csp.reduce((m, d) => ((m[d] = (m[d] ?? 0) + 1), m), {})).map(([d, n]) => `${d}×${n}`).join(', ');
        return [p, `${Object.keys(r.out).length} injection attempts (${Object.entries(r.out).map(([k, v]) => `${k}: ${v}`).join(', ')}); CSP reports: ${dirs}; attacker server: 0 HTTP requests${tcp ? `, ${tcp} bare TCP connect(s) from the blocked frame/form navigations (Chrome connects before its CSP check; no data sent)` : ''}`];
      });

      await this.check('p8', 'Trusted Types block every HTML/script string sink; eval and new Function blocked', async () => {
        const r = await evalIn(s, pageTrustedTypesProbe);
        const p = [];
        for (const [k, v] of Object.entries(r.out)) if (v === 'ALLOWED') p.push(`${k} was allowed`);
        if (r.pwned !== null) p.push(`injected code ran (window.__pwned = ${r.pwned})`);
        if (r.rows !== WORDS) p.push(`the list lost rows (${r.rows})`);
        return [p, `${Object.keys(r.out).length} attempts, all refused: ${Object.entries(r.out).map(([k, v]) => `${k} (${v})`).join(', ')}; the list is intact`];
      });
    } finally {
      await close();
    }
  }

  // p10
  async checkSelection() {
    const { s, rec, close, browserContextId } = await this.isolatedPage({ phone: false, touch: false, width: 390, height: 844 });
    try {
      const p = [];
      await navigateIn(s, this.target.url);
      await this.waitReadyIn(s);
      await s.send('Page.bringToFront').catch(() => {});
      // Headless Chrome has its own clipboard (the system one is never touched): put a sentinel in it.
      const SENTINEL = 'bip39-e2e-clipboard-sentinel';
      await this.cdp.send('Browser.grantPermissions', { origin: this.target.origin, browserContextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
      const readClip = () => evalGesture(s, 'navigator.clipboard.readText().catch((e) => "unavailable: " + e.name)');
      const put = await evalGesture(s, `navigator.clipboard.writeText(${JSON.stringify(SENTINEL)}).then(() => navigator.clipboard.readText()).catch((e) => "unavailable: " + e.name)`);
      const clipboard = put === SENTINEL;
      await evalIn(s, () => { window.__copies = []; document.addEventListener('copy', () => window.__copies.push(getSelection().toString()), true); return true; });
      const pt = await evalIn(s, () => { const r = document.querySelectorAll('.w__t')[2].getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }; });
      const mouse = (type, x, y, button = 'left', clickCount = 1) => s.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
      const selection = () => evalIn(s, () => getSelection().toString());
      const out = {};
      for (const n of [1, 2, 3]) { await mouse('mousePressed', pt.x, pt.y, 'left', n); await mouse('mouseReleased', pt.x, pt.y, 'left', n); }
      out['double/triple click'] = await selection();
      await mouse('mousePressed', pt.x, pt.y); await mouse('mouseMoved', pt.x + 120, pt.y + 150); await mouse('mouseReleased', pt.x + 120, pt.y + 150);
      out['mouse drag'] = await selection();
      await mouse('mousePressed', pt.x, pt.y, 'right'); await mouse('mouseReleased', pt.x, pt.y, 'right');
      out['right click (macOS selects the word)'] = await selection();
      const mod = process.platform === 'darwin' ? 4 : 2; // Meta / Ctrl
      const chord = async (k, command) => {
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: mod, commands: [command] });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: mod });
      };
      await chord('a', 'selectAll');
      out['select-all shortcut'] = await selection();
      await chord('c', 'copy');
      out['execCommand selectAll'] = await evalIn(s, () => { document.execCommand('selectAll'); return getSelection().toString(); });
      out['script selectAllChildren + copy'] = await evalIn(s, () => { getSelection().selectAllChildren(document.body); const t = getSelection().toString(); document.execCommand('copy'); getSelection().removeAllRanges(); return t; });
      await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1, radiusX: 8, radiusY: 8, force: 0.5 }] });
      await sleep(900);
      await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      out['touch long-press'] = await selection();
      for (const [k, v] of Object.entries(out)) if (v) p.push(`${k} selected "${v.slice(0, 40)}"`);
      const copies = await evalIn(s, () => window.__copies);
      if (copies.some((c) => c)) p.push(`a copy event carried a selection: "${copies.find((c) => c).slice(0, 40)}"`);
      const after = clipboard ? await readClip() : null;
      if (clipboard && after !== SENTINEL) p.push(`the clipboard changed to "${String(after).slice(0, 40)}"`);
      const dom = await evalIn(s, pageContentGrabAudit);
      p.push(...dom.problems);
      return [p, `${Object.keys(out).join(', ')}: selection empty every time; ${copies.length} copy events, all empty${clipboard ? '; clipboard still holds the sentinel after the copy shortcut and execCommand("copy")' : '; clipboard not testable here'}; ${dom.detail}`];
    } finally {
      await close();
    }
  }

  // p11 + r1: a page on another site frames the viewer.
  async checkFraming(att) {
    const results = {};
    for (const mode of ['plain', 'sandbox-scripts', 'sandbox']) {
      try {
        results[mode] = await this.framedLook(att, mode);
      } catch (e) {
        results[mode] = { error: e.message };
      }
    }
    await this.check('p11', 'Cross-site frame: the viewer hides itself (plain and sandbox="allow-scripts")', async () => {
      const p = [];
      for (const mode of ['plain', 'sandbox-scripts']) {
        const r = results[mode];
        if (r.error) { p.push(`${mode}: ${r.error}`); continue; }
        if (r.inkShare > 0.001) p.push(`${mode}: ${fmt(r.inkShare * 100)}% of the frame's pixels differ from its background (words visible)`);
        if (r.rowsWithBoxes) p.push(`${mode}: ${r.rowsWithBoxes} rows still laid out`);
        if (r.swRegistered) p.push(`${mode}: the framed page registered a service worker in the framing site's storage`);
        if (!r.probe) p.push(`${mode}: the in-frame probe was not installed, so paint timing and worker registration are unknown`);
      }
      const d = (m) => { const r = results[m]; return r.error ? `${m}: error` : `${m}: ${fmt(r.inkShare * 100)}% non-background pixels, ${r.rowsWithBoxes} rows laid out, first-contentful-paint ${r.fcp ?? 'none'}${r.swRegistered ? ', SW registered' : ', no serviceWorker.register call'}`; };
      return [p, `${d('plain')}; ${d('sandbox-scripts')} (no FCP = nothing was painted before hiding; on a slow network the first rows can paint before the script at the end arrives)`];
    });
    const r = results.sandbox;
    this.record('r1', 'Residual: <iframe sandbox> without allow-scripts shows the list (hiding needs JS)', 'INFO',
      r.error ? `not measured: ${r.error}` : `${fmt(r.inkShare * 100)}% non-background pixels, ${r.rowsWithBoxes} rows laid out: ${r.inkShare > 0.001 ? 'visible, as documented in SECURITY.md (needs a frame-ancestors header, which GitHub Pages cannot send)' : 'hidden'}`);
  }

  async framedLook(att, mode) {
    const FRAME_W = 360, FRAME_H = 600;
    const { s, close } = await this.isolatedPage({ phone: false, touch: false, width: 400, height: 700 });
    const frames = [];
    const off = s.on('Target.attachedToTarget', (e) => {
      const fs = new Session(this.cdp, e.sessionId, e.targetInfo);
      if (e.targetInfo.type === 'iframe') frames.push(fs);
      // Record paint timing inside the frame from its very first moment, then let it run.
      (e.targetInfo.type === 'iframe' ? fs.send('Page.enable').then(() => fs.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_PAINT })) : Promise.resolve())
        .catch(() => {}).finally(() => fs.send('Runtime.runIfWaitingForDebugger').catch(() => {}));
    });
    try {
      await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await navigateIn(s, `${att.url}/frame-${mode}`);
      const t0 = now();
      while (!frames.length && now() - t0 < 5000) await sleep(25);
      if (!frames.length) throw new Error('the cross-site frame did not attach (no site isolation?)');
      const fs = frames[0];
      await fs.send('Runtime.enable').catch(() => {});
      const state = await pollIn(fs, () => ({ ready: document.readyState, n: document.querySelectorAll('.w').length, classes: document.documentElement.className }),
        (v) => v.ready === 'complete' && v.n === WORDS && (mode === 'sandbox' || /\bjs\b/.test(v.classes)), 8000);
      if (!state.ok) throw new Error(`framed page not ready: ${JSON.stringify(state.value)}`);
      await evalIn(s, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
      const inner = await evalIn(fs, () => ({
        rowsWithBoxes: [...document.querySelectorAll('.w')].filter((w) => w.getClientRects().length && w.getBoundingClientRect().height > 0).length,
        probe: Array.isArray(window.__e2eFramePaint) && Array.isArray(window.__e2eSpy),
        fcp: (window.__e2eFramePaint || []).find((x) => x.name === 'first-contentful-paint')?.t ?? null,
        swCalls: (window.__e2eSpy || []).filter((x) => x.api === 'serviceWorker.register').length,
      }));
      const shot = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: FRAME_W, height: FRAME_H, scale: 1 }, captureBeyondViewport: false });
      const inkShare = nonDominantShare(decodePng(Buffer.from(shot.data, 'base64')));
      const targets = (await this.cdp.send('Target.getTargets')).targetInfos;
      const swRegistered = inner.swCalls > 0 || targets.some((t) => t.type === 'service_worker' && t.browserContextId === s.info.browserContextId);
      return { inkShare, rowsWithBoxes: inner.rowsWithBoxes, probe: inner.probe, fcp: inner.fcp === null ? null : `${fmt(inner.fcp)}ms`, swRegistered };
    } finally {
      off();
      await close();
    }
  }

  // p12 + r2: a page on another site opens the viewer with window.open() and keeps the handle.
  async checkOpener(att) {
    let residual = 'not measured';
    await this.check('p12', 'Cross-site opener cannot read the page; javascript: navigation refused', async () => {
      const { s, close, browserContextId } = await this.isolatedPage({ phone: false, touch: false });
      try {
        const p = [];
        await navigateIn(s, `${att.url}/opener`);
        // Not awaited yet: the harness's browser-wide auto-attach (which holds service workers until they are
        // watched) also holds a new window, and so window.open(), until a client attaches to that window.
        const opening = evalGesture(s, `!!(window.__w = window.open(${JSON.stringify(this.target.url)}, 'bip39-e2e'))`);
        opening.catch(() => {});
        let pop = null;
        for (const t0 = now(); !pop && now() - t0 < 5000; await sleep(50)) {
          pop = (await this.cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.browserContextId === browserContextId && t.targetId !== s.info.targetId);
        }
        if (!pop) return [[`no popup appeared (window.open returned ${await Promise.race([opening, sleep(100).then(() => 'nothing yet')])})`], ''];
        const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: pop.targetId, flatten: true });
        const ps = new Session(this.cdp, sessionId, pop);
        await ps.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        if (!(await opening)) return [['window.open was blocked (no user gesture?)'], ''];
        const dialogs = [];
        const offDialog = ps.on('Page.javascriptDialogOpening', (e) => { dialogs.push(e.message); ps.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); });
        await Promise.all([ps.send('Page.enable'), ps.send('Runtime.enable')]);
        await this.waitReadyIn(ps);
        const probe = await evalIn(s, () => {
          const w = window.__w;
          const out = {};
          const reads = {
            'location.href': () => w.location.href, document: () => w.document.title, name: () => w.name, 'list scroll': () => w.document.getElementById('list').scrollTop,
            'history.length': () => w.history.length, localStorage: () => w.localStorage.length, 'frames[0]': () => w.frames[0].location.href,
          };
          for (const [k, f] of Object.entries(reads)) { try { out[k] = `READ ${String(f())}`; } catch (e) { out[k] = e.name; } }
          try { w.location.href = 'javascript:document.title="pwned";alert(1)'; out['javascript: navigation'] = 'no error'; } catch (e) { out['javascript: navigation'] = e.name; }
          return out;
        });
        await sleep(300);
        for (const [k, v] of Object.entries(probe)) if (String(v).startsWith('READ') || v === 'no error') p.push(`the opener could ${k === 'javascript: navigation' ? 'start a javascript: navigation' : `read ${k}`} (${v})`);
        const title = await evalIn(ps, () => document.title);
        if (title !== 'BIP39 Wordlist' || dialogs.length) p.push(`the popup ran the opener's code (title "${title}", ${dialogs.length} dialogs)`);
        offDialog();
        // Residual: the opener can still send this tab elsewhere (no Cross-Origin-Opener-Policy on GitHub Pages).
        await evalIn(s, (u) => { window.__w.location.href = u; return true; }, `${att.url}/phish`);
        let where = null;
        for (const t0 = now(); now() - t0 < 3000; await sleep(50)) {
          where = (await this.cdp.send('Target.getTargets')).targetInfos.find((t) => t.targetId === pop.targetId)?.url ?? null;
          if (where && where.startsWith(att.url)) break;
        }
        residual = where && where.startsWith(att.url) ? `yes: window.open's handle moved the tab to ${where} (needs a COOP header, which GitHub Pages cannot send)` : `no (tab stayed at ${where})`;
        return [p, `${Object.entries(probe).map(([k, v]) => `${k}: ${v}`).join(', ')}; popup untouched ("${title}", 0 dialogs)`];
      } finally {
        await close();
      }
    });
    this.record('r2', 'Residual: a cross-site opener can still redirect this tab (reverse tabnabbing)', 'INFO', residual);
  }

  // p13: the safest way to use it: the single saved file, opened from disk with the network off.
  async checkFileUrl() {
    const dir = await mkdtemp(join(tmpdir(), 'bip39-e2e-file-'));
    lastResort.dirs.add(dir);
    const { s, rec, close } = await this.isolatedPage();
    try {
      const file = join(dir, 'index.html');
      if (this.target.dir) await copyFile(join(this.target.dir, 'index.html'), file);
      else await writeFile(file, Buffer.from(await (await fetch(this.target.url)).arrayBuffer()));
      await this.setOffline(s, true);
      await navigateIn(s, pathToFileURL(file).href);
      await this.waitReadyIn(s);
      await s.send('Page.bringToFront').catch(() => {});
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
      const st = await evalIn(s, pageWaitStable, 400, SETTLE_TIMEOUT);
      const snap = await evalIn(s, pageSnapshot);
      const p = this.endProblems(snap).map((x) => `after End: ${x}`);
      if (!st.ok) p.push('the list did not settle after End');
      const net = rec.requests.filter((r) => !/^(file|data|blob|about):/.test(r.url));
      for (const r of net) p.push(`network request: ${r.method} ${r.url}`);
      for (const x of rec.exceptions) p.push(`uncaught: ${x}`);
      const csp = await evalIn(s, () => (window.__e2e ? window.__e2e.csp.map((v) => `${v.directive} ${v.blocked}`) : []));
      for (const x of csp) p.push(`CSP report: ${x}`);
      const info = await evalIn(s, () => ({ secure: window.isSecureContext, origin: location.origin }));
      const files = [...new Set(rec.requests.map((r) => r.url.split('/').pop()))];
      return [p, `${pathToFileURL(file).href.replace(/\/[^/]*\/index\.html$/, '/…/index.html')} (only index.html, network offline): 2048 words, verify ok (isSecureContext ${info.secure}), End → ${this.describe(snap)}; requests: ${files.join(', ')} (file:// only; a missing favicon is harmless), 0 exceptions, 0 CSP reports`];
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
      lastResort.dirs.delete(dir);
    }
  }

  // p14
  async checkJsDisabled() {
    const { s, rec, close, browserContextId } = await this.isolatedPage({ jsDisabled: true });
    try {
      const p = [];
      await navigateIn(s, this.target.url);
      const r = await pollIn(s, () => ({ ready: document.readyState, n: document.querySelectorAll('.w').length }), (v) => v.ready === 'complete' && v.n === WORDS, 8000);
      if (!r.ok) return [[`page not ready: ${JSON.stringify(r.value)}`], ''];
      const look = await evalIn(s, () => ({
        classes: document.documentElement.className,
        js: document.documentElement.classList.contains('js'),
        noJs: document.documentElement.classList.contains('no-js'),
        reel: getComputedStyle(document.getElementById('reel')).display,
        scrollable: document.getElementById('list').scrollHeight > document.getElementById('list').clientHeight,
        verify: document.getElementById('verify')?.dataset.state,
        // What the reader sees: a ::after message (if the stylesheet has one for no-JS) or the text itself.
        verifyText: (() => {
          const el = document.getElementById('verify');
          const after = el ? getComputedStyle(el, '::after').content : 'none';
          return /^["']/.test(after) ? after.slice(1, -1) : el?.textContent;
        })(),
      }));
      if (!look.noJs || look.js) p.push(`html class "${look.classes}" (the page script ran?)`);
      if (look.reel !== 'none') p.push(`the reel is shown (display ${look.reel}) although it cannot work without JS`);
      if (!look.scrollable) p.push('the list cannot scroll');
      const loadReqs = rec.requests.length;
      const top0 = await evalIn(s, () => document.getElementById('list').scrollTop);
      await this.touchDrag(Math.round(PHONE.width * 0.4), Math.round(PHONE.height * 0.72), Math.round(PHONE.height * 0.36), 110, 0, s);
      // No page timers without JS: poll from here until the list is at rest.
      let last = null, since = now();
      for (const t0 = now(); now() - t0 < SETTLE_TIMEOUT; await sleep(50)) {
        const v = await evalIn(s, () => document.getElementById('list').scrollTop);
        if (v !== last) { last = v; since = now(); } else if (now() - since > 500) break;
      }
      const snap = await evalIn(s, pageSnapshot);
      if (!(last > top0)) p.push(`a touch fling did not scroll the list (${top0} → ${last})`);
      const w = snap.centred;
      if (!w || Math.abs(w.center - snap.vc) > TOL) p.push(`not snapped: "${w?.text}" ${fmt((w?.center ?? NaN) - snap.vc)}px off the centre`);
      for (const q of rec.requests.slice(loadReqs)) p.push(`request while scrolling: ${q.method} ${q.url}`);
      const foreign = rec.requests.filter((q) => { try { return new URL(q.url).origin !== this.target.origin; } catch { return true; } });
      for (const q of foreign) p.push(`cross-origin request: ${q.url}`);
      const usage = await s.send('Storage.getUsageAndQuota', { origin: this.target.origin });
      const used = usage.usageBreakdown.filter((u) => u.usage > 0);
      if (used.length) p.push(`storage used: ${used.map((u) => `${u.storageType} ${u.usage} B`).join(', ')}`);
      const { cookies } = await this.cdp.send('Storage.getCookies', { browserContextId });
      if (cookies.length) p.push(`${cookies.length} cookie(s)`);
      const sws = (await this.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'service_worker' && t.browserContextId === browserContextId);
      if (sws.length) p.push(`${sws.length} service worker(s) running`);
      const paths = [...new Set(rec.requests.map((q) => { try { return new URL(q.url).pathname; } catch { return q.url; } }))];
      return [p, `html.no-js kept, reel hidden, fling ${fmt(top0)} → ${fmt(last)}px and CSS snap centres "${w?.text}" (Δ${fmt((w?.center ?? NaN) - snap.vc)}px); requests ${paths.join(' ')} at load, 0 while scrolling; no storage, cookies or service worker. Without JS there is no frame hiding, no veil and no integrity check (#verify shows "${look.verifyText?.slice(0, 60)}")`];
    } finally {
      await close();
    }
  }

  // p15: bfcache needs cacheable responses; the e2e server sends no-store, GitHub Pages sends max-age=600.
  async checkBfcache(att) {
    let site = this.target.url;
    let server = null;
    if (this.target.dir) {
      server = await startStaticServer(this.target.dir, 'max-age=600');
      site = server.url;
    }
    const { s, close } = await this.isolatedPage();
    try {
      const p = [];
      await navigateIn(s, site);
      await this.waitReadyIn(s);
      await s.send('Page.bringToFront').catch(() => {});
      await this.touchDrag(Math.round(PHONE.width * 0.4), Math.round(PHONE.height * 0.72), Math.round(PHONE.height * 0.3), 100, 0, s);
      await evalIn(s, pageWaitStable, 400, SETTLE_TIMEOUT);
      const before = await evalIn(s, pageSnapshot);
      await evalIn(s, () => { window.__e2eKept = true; return true; });
      await navigateIn(s, `${att.url}/away`);
      const hist = await s.send('Page.getNavigationHistory');
      const nav = s.waitFor('Page.frameNavigated', (e) => !e.frame.parentId, LOAD_TIMEOUT);
      await s.send('Page.navigateToHistoryEntry', { entryId: hist.entries[hist.currentIndex - 1].id });
      const how = (await nav).type;
      await this.waitReadyIn(s, { verify: false });
      const after = await evalIn(s, pageSnapshot);
      const kept = await evalIn(s, () => ({ kept: window.__e2eKept === true, veiled: document.documentElement.classList.contains('is-veiled') }));
      p.push(...this.restProblems(after, { expectWord: 'abandon', expectLetter: 'A' }));
      if (kept.veiled) p.push('still veiled after coming back');
      if (before.centred?.text === 'abandon') p.push('the fling did not move the list, test is void');
      const bf = how === 'BackForwardCacheRestore' && kept.kept;
      return [p, `left at "${before.centred?.text}", back via ${bf ? 'the back/forward cache (same document)' : `a new load (${how})`}: ${this.describe(after)}, not veiled`];
    } finally {
      await close();
      if (server) await server.close();
    }
  }

  async ensureServiceWorker() {
    const info = { supported: false, controller: false, reloaded: false, scope: null, error: null };
    try {
      const has = await this.eval(() => 'serviceWorker' in navigator && window.isSecureContext);
      info.supported = has;
      if (!has) return info;
      const ready = await this.eval((ms) => Promise.race([
        navigator.serviceWorker.ready.then((r) => ({ scope: r.scope, active: !!r.active, controller: !!navigator.serviceWorker.controller })),
        new Promise((r) => setTimeout(() => r(null), ms)),
      ]), SW_TIMEOUT);
      if (!ready) { info.error = `navigator.serviceWorker.ready did not resolve within ${SW_TIMEOUT}ms`; return info; }
      info.scope = ready.scope;
      let c = await this.poll(() => !!navigator.serviceWorker.controller, [], (v) => v === true, 3000, 'controller');
      if (!c.ok) {
        info.reloaded = true;
        await this.reload();
        await this.waitAppReady();
        c = await this.poll(() => !!navigator.serviceWorker.controller, [], (v) => v === true, 5000, 'controller');
      }
      info.controller = c.ok;
    } catch (e) {
      info.error = e.message;
    }
    return info;
  }

  async checkVeil() {
    const p = [];
    const before = await this.eval(() => ({ vis: document.visibilityState, veiled: document.documentElement.classList.contains('is-veiled') }));
    if (before.vis !== 'visible') return ['SKIP', `page not visible to begin with (${before.vis})`];
    if (before.veiled) p.push('html.is-veiled set while visible');
    // Hide the page by opening and activating another tab in the same window.
    let other;
    try {
      ({ targetId: other } = await this.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: false, background: false }));
    } catch (e) {
      return ['SKIP', `could not open a second tab to hide the page: ${e.message}`];
    }
    let hidden;
    try {
      await this.cdp.send('Target.activateTarget', { targetId: other }).catch(() => {});
      hidden = await this.poll(() => ({ vis: document.visibilityState, veiled: document.documentElement.classList.contains('is-veiled') }), [], (v) => v.vis === 'hidden', 3000, 'hidden');
    } finally {
      await this.cdp.send('Target.activateTarget', { targetId: this.targetId }).catch(() => {});
      await this.page.send('Page.bringToFront').catch(() => {});
      await this.cdp.send('Target.closeTarget', { targetId: other }).catch(() => {});
    }
    if (!hidden.ok) return ['SKIP', `could not hide the page in this browser mode (visibilityState stayed "${hidden.value?.vis}")`];
    if (!hidden.value.veiled) p.push('html.is-veiled not set while document.visibilityState = hidden');
    const back = await this.poll(() => ({ vis: document.visibilityState, veiled: document.documentElement.classList.contains('is-veiled') }), [], (v) => v.vis === 'visible' && !v.veiled, 3000, 'visible');
    if (!back.ok) p.push(`after re-activating: visibilityState=${back.value?.vis}, is-veiled=${back.value?.veiled}`);
    return [p, `other tab active: visibilityState=${hidden.value.vis}, is-veiled=${hidden.value.veiled}; back: visibilityState=${back.value?.vis}, is-veiled=${back.value?.veiled}`];
  }

  async checkOffline() {
    const sw = this.sw;
    if (!sw?.supported) return [['service worker API unavailable (not a secure context?)'], ''];
    if (sw.error) return [[`service worker: ${sw.error}`], ''];
    if (!sw.controller) return [[`no service worker controls the page${sw.reloaded ? ' even after a reload' : ''}`], `scope ${sw.scope}`];
    // Make sure the SW finished installing (precache) before cutting the network.
    const ctl = await this.poll(() => navigator.serviceWorker.controller?.state, [], (v) => v === 'activated', 5000, 'sw activated');
    const nav = [];
    const off = this.page.on('Network.responseReceived', (e) => { if (e.type === 'Document') nav.push({ url: e.response.url, status: e.response.status, fromSW: !!e.response.fromServiceWorker }); });
    this.offline = true;
    try {
      await this.setOffline(this.page, true);
      for (const w of this.workers.values()) await this.setOffline(w, true).catch(() => {});
      const onLine = await this.eval(() => navigator.onLine);
      await this.reload();
      const r = await this.poll(() => ({ n: document.querySelectorAll('.w').length, js: document.documentElement.classList.contains('js'), url: location.href, onLine: navigator.onLine }), [],
        (v) => v.n === WORDS && v.js, 8000, 'offline render');
      const verify = await this.poll(() => document.getElementById('verify')?.dataset.state, [], (v) => v === 'ok', VERIFY_TIMEOUT, 'verify');
      const p = [];
      if (!r.ok) p.push(`offline reload shows ${r.value?.n ?? 0} .w (js=${r.value?.js}) at ${r.value?.url}`);
      const doc = nav[nav.length - 1];
      if (doc && !doc.fromSW) p.push(`document not served by the service worker (status ${doc.status})`);
      if (onLine !== false) p.push(`navigator.onLine=${onLine} under offline emulation (emulation not applied?)`);
      return [p, `sw ${ctl.value ?? '?'}${sw.reloaded ? ' (after 1 reload)' : ''}, navigator.onLine=${onLine}; offline reload: ${r.value?.n} words, document ${doc ? (doc.fromSW ? 'from service worker' : 'from network') : 'n/a'}, #verify ${verify.value}`];
    } finally {
      off();
      this.offline = false;
      await this.setOffline(this.page, false).catch(() => {});
      for (const w of this.workers.values()) await this.setOffline(w, false).catch(() => {});
    }
  }

  async setOffline(session, offline) {
    const cond = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    try {
      await session.send('Network.emulateNetworkConditions', cond);
    } catch {
      // Newer protocol split (emulateNetworkConditions is deprecated in recent Chrome).
      await session.send('Network.overrideNetworkState', cond).catch(() => {});
      await session.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [{ urlPattern: '', ...cond }] });
    }
  }

  checkConsole() {
    // Network failures while the network is deliberately offline are expected, not app errors.
    const errs = this.consoleErrors.filter((e) => !(e.phase === 'offline' && e.kind === 'log.network'));
    const csp = this.issues.filter((i) => i.code === 'ContentSecurityPolicyIssue');
    const other = this.issues.filter((i) => i.code !== 'ContentSecurityPolicyIssue');
    const lines = [
      ...errs.map((e) => ({ key: `[${e.ctx}] ${e.kind}: ${e.text}`, phase: e.phase })),
      ...csp.map((i) => ({ key: `[${i.ctx}] CSP issue: ${i.detail}`, phase: i.phase })),
      ...this.cspProbe.map((v) => ({ key: `[page] securitypolicyviolation: ${v.directive} blocked=${v.blocked}${v.sample ? ` sample="${v.sample}"` : ''}`, phase: v.phase })),
    ];
    const extra = [];
    if (this.consoleWarnings.length) extra.push(`${this.consoleWarnings.length} warning(s): ${summarize(this.consoleWarnings.map((w) => ({ key: `[${w.ctx}] ${w.kind}: ${w.text}`, phase: w.phase })), 3)}`);
    if (other.length) extra.push(`other DevTools issues: ${[...new Set(other.map((i) => i.code))].join(', ')}`);
    const ignored = this.consoleErrors.length - errs.length;
    if (ignored) extra.push(`${ignored} network error(s) while offline ignored`);
    const counts = `${errs.length} console/log error(s), ${csp.length} CSP issue(s), ${this.cspProbe.length} securitypolicyviolation event(s)`;
    this.record('a', 'No console errors, exceptions or CSP/Trusted Types violations', lines.length ? 'FAIL' : 'PASS',
      lines.length ? `${counts}: ${summarize(lines, 8)}${extra.length ? ` [${extra.join('; ')}]` : ''}` : `${counts}${extra.length ? `; ${extra.join('; ')}` : ''}`);
  }

  checkNetwork(interactionRequests) {
    const origin = this.target.origin;
    const net = this.requests.filter((r) => !/^(data|blob|about):/.test(r.url));
    const foreign = net.filter((r) => { try { return new URL(r.url).origin !== origin; } catch { return true; } });
    const pageDuring = interactionRequests.filter((r) => r.ctx === 'page' && !/^(data|blob|about):/.test(r.url));
    const swDuring = interactionRequests.filter((r) => r.ctx === 'sw');
    const lines = [
      ...foreign.map((r) => ({ key: `cross-origin ${r.ctx} request: ${r.method} ${r.url}`, phase: r.phase })),
      ...pageDuring.map((r) => ({ key: `page request during interactions: ${r.method} ${r.url} (${r.type})`, phase: r.phase })),
    ];
    const paths = [...new Set(net.map((r) => { try { return new URL(r.url).pathname; } catch { return r.url; } }))].sort();
    const byCtx = (c) => net.filter((r) => r.ctx === c).length;
    const note = this.idleBeforeInteract === false ? ' (network was still busy when interactions started)' : '';
    this.record('b', 'Network: same-origin only, nothing new during interactions', lines.length ? 'FAIL' : 'PASS',
      lines.length ? summarize(lines, 8) + note
        : `${net.length} requests (page ${byCtx('page')}, service worker ${byCtx('sw')}), all ${origin}; none from the page during interactions${swDuring.length ? ` (${swDuring.length} SW fetches)` : ''}; paths: ${paths.join(' ')}`);
  }
}

// Collapse repeated messages: "text (×3: load, desktop, offline)".
function summarize(lines, max) {
  const groups = new Map();
  for (const { key, phase } of lines) {
    const g = groups.get(key) ?? { n: 0, phases: new Set() };
    g.n++;
    g.phases.add(phase);
    groups.set(key, g);
  }
  const out = [...groups].slice(0, max).map(([k, g]) => `${k.length > 300 ? `${k.slice(0, 300)}…` : k} (${g.n > 1 ? `×${g.n}, ` : ''}${[...g.phases].join('/')})`);
  if (groups.size > max) out.push(`… ${groups.size - max} more (see report.json)`);
  return out.join('; ');
}

// ---------------------------------------------------------------------------------------------------
// Helpers for the isolated tabs of the privacy checks (any Session)
// ---------------------------------------------------------------------------------------------------
async function evalIn(session, fn, ...args) {
  const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
  return evaluateIn(session, { expression, returnByValue: true, awaitPromise: true });
}

// As if the user had just tapped (window.open, clipboard).
function evalGesture(session, expression) {
  return evaluateIn(session, { expression, returnByValue: true, awaitPromise: true, userGesture: true });
}

async function evaluateIn(session, params) {
  let r;
  try {
    r = await session.send('Runtime.evaluate', params, 15000);
  } catch (e) {
    throw new Error(`${e.message} (${params.expression.replace(/\s+/g, ' ').slice(0, 70)}…)`);
  }
  if (r.exceptionDetails) throw new Error(`in-page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function pollIn(session, fn, pred, timeoutMs) {
  const t0 = now();
  for (;;) {
    let value;
    try { value = await evalIn(session, fn); } catch (e) { value = { error: e.message }; }
    if (value && pred(value)) return { ok: true, value };
    if (now() - t0 > timeoutMs) return { ok: false, value };
    await sleep(25);
  }
}

async function navigateIn(session, url, extra = {}) {
  const loaded = session.waitFor('Page.loadEventFired', () => true, LOAD_TIMEOUT);
  const r = await session.send('Page.navigate', { url, ...extra });
  if (r.errorText) { loaded.catch(() => {}); throw new Error(`navigation to ${url} failed: ${r.errorText}`); }
  await loaded;
}

// The attacker: pages on another site (localhost, while the viewer is on 127.0.0.1) that frame and open the
// viewer. It logs every request and connection it receives, so anything that slips past CSP shows up here.
async function startAttacker(targetUrl) {
  const log = [];
  let connections = 0;
  const frame = (attrs) => `<!doctype html><meta charset="utf-8"><title>attacker</title><style>html,body{margin:0;background:#f0f}iframe{display:block;border:0;width:360px;height:600px}</style><iframe ${attrs} src="${targetUrl}"></iframe>`;
  const page = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${title}`;
  const pages = {
    '/frame-plain': frame(''),
    '/frame-sandbox-scripts': frame('sandbox="allow-scripts"'),
    '/frame-sandbox': frame('sandbox'),
    '/opener': page('attacker'),
    '/away': page('elsewhere'),
    '/phish': page('look-alike'),
  };
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url });
    const body = pages[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'Content-Type': `text/${body ? 'html' : 'plain'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body ?? 'not found\n');
  });
  server.on('connection', () => { connections++; });
  server.on('upgrade', (req, socket) => { log.push({ method: 'UPGRADE', url: req.url }); socket.destroy(); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  let closing = null;
  return {
    url: `http://localhost:${server.address().port}`,
    log,
    connections: () => connections,
    close: () => (closing ??= new Promise((res) => { server.close(() => res()); server.closeAllConnections(); })),
  };
}

// dist/ with cacheable responses (like GitHub Pages' max-age=600), for the back/forward cache check.
async function startStaticServer(dir, cacheControl) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    const path = req.url.split(/[?#]/)[0];
    const file = path.endsWith('/') ? 'index.html' : path.slice(1);
    try {
      if (!/^[\w.-]+$/.test(file) || file.startsWith('.')) throw new Error('bad path');
      const body = await readFile(join(dir, file));
      res.writeHead(200, { 'Content-Type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  let closing = null;
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => (closing ??= new Promise((res) => { server.close(() => res()); server.closeAllConnections(); })) };
}

// Share of pixels that differ from the most common colour: ~0 for a blank frame, several % for words.
function nonDominantShare(img) {
  const counts = new Map();
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const k = img.data.readUInt32BE(i * 4);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return n ? 1 - Math.max(...counts.values()) / n : 1;
}

function summarizeSpy(entries) {
  const m = new Map();
  for (const x of entries) {
    const k = `${x.api}(${x.detail})`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

function displayPath(p) {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

// Minimal PNG reader for Chrome screenshots (8-bit RGB or RGBA, not interlaced) -> RGBA pixels.
function decodePng(buf) {
  if (buf.length < 8 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace) throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${ctype}, interlace ${interlace}`);
  const bpp = ctype === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp];
      out[o + 1] = line[x * bpp + 1];
      out[o + 2] = line[x * bpp + 2];
      out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

// Pixels of the rows around the centre (see pageHighlightAudit): the empty parts of every row must be one
// and the same background colour, and the strongest ink of each word and each number must be the same
// colour on every row. A highlight of any kind (colour, band, outline, glow) breaks one of the two.
function pixelRowAudit(img, clip, rows) {
  const k = img.width / clip.width; // device pixels per CSS px
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const zone = (l, t, r, b, fn) => {
    const x0 = Math.max(0, Math.round((l - clip.x) * k)), x1 = Math.min(img.width, Math.round((r - clip.x) * k));
    const y0 = Math.max(0, Math.round((t - clip.y) * k)), y1 = Math.min(img.height, Math.round((b - clip.y) * k));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        fn([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
    }
  };
  const problems = [];
  // Empty parts: between the number and the word, and right of the word; clear of the top/bottom edge
  // (the .w--g hairline).
  const bg = new Map();
  for (const q of rows) {
    const add = (c) => { const key = c.join(','); bg.set(key, (bg.get(key) ?? 0) + 1); };
    zone(q.n.r + 2, q.row.t + 3, q.t.l - 2, q.row.b - 3, add);
    zone(q.t.r + 6, q.row.t + 3, q.row.r - 2, q.row.b - 3, add);
  }
  const bgKeys = [...bg.keys()];
  if (bgKeys.length !== 1) problems.push(`pixels: the empty parts of the ${rows.length} rows around the centre are not one uniform colour (${bgKeys.length}: ${bgKeys.slice(0, 4).map((x) => `rgb(${x})`).join(', ')})`);
  const base = (bgKeys[0] ?? '0,0,0').split(',').map(Number);
  const strongest = (l, t, r, b) => {
    let best = null, bd = -1;
    zone(l, t, r, b, (c) => { const d = dist(c, base); if (d > bd) { bd = d; best = c; } });
    return best;
  };
  const inks = rows.map((q) => ({ word: q.word, t: strongest(q.t.l, q.t.t, q.t.r, q.t.b), n: strongest(q.n.l, q.n.t, q.n.r, q.n.b) }));
  for (const [part, label] of [['t', 'word'], ['n', 'number']]) {
    const ref = inks[0][part];
    if (inks.some((x) => !x[part] || !ref || dist(x[part], ref) > 6)) {
      problems.push(`pixels: the strongest ${label} ink differs between rows: ${inks.map((x) => `${x.word} rgb(${x[part]})`).join(', ')}`);
    }
  }
  return {
    problems,
    detail: `${rows.length} rows' pixels: background ${bgKeys.length === 1 ? `rgb(${bgKeys[0]}) everywhere` : 'not uniform'}, word ink rgb(${inks[0].t}), number ink rgb(${inks[0].n}) on every row`,
  };
}

function frameStats(deltas) {
  const d = deltas.filter((x) => x > 0).sort((a, b) => a - b);
  if (!d.length) return null;
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  return { n: d.length, p50: q(0.5), p95: q(0.95), max: d[d.length - 1] };
}

// ---------------------------------------------------------------------------------------------------
// Build + serve (or use --url)
// ---------------------------------------------------------------------------------------------------
async function prepareTarget() {
  if (opts.url) {
    let u;
    try { u = new URL(opts.url); } catch { throw new SetupError(`--url: not a valid URL: ${opts.url}`); }
    return { url: u.href, origin: u.origin, server: null, dir: null };
  }
  for (const f of ['scripts/build.mjs', 'scripts/serve.mjs']) {
    if (!existsSync(join(ROOT, f))) throw new SetupError(`${f} is missing; cannot build/serve (use --url to test a running server).`);
  }
  const { build } = await import(pathToFileURL(join(ROOT, 'scripts/build.mjs')).href);
  const { startServer } = await import(pathToFileURL(join(ROOT, 'scripts/serve.mjs')).href);
  if (typeof build !== 'function' || typeof startServer !== 'function') throw new SetupError('scripts/build.mjs must export build() and scripts/serve.mjs must export startServer()');
  const dir = await mkdtemp(join(tmpdir(), 'bip39-e2e-dist-'));
  lastResort.dirs.add(dir);
  onCleanup(async () => { await rm(dir, { recursive: true, force: true }); lastResort.dirs.delete(dir); });
  try {
    await build({ root: ROOT, outDir: dir, quiet: true });
  } catch (e) {
    throw new SetupError(`build failed: ${e?.name === 'BuildError' ? e.message : (e?.stack ?? e)}`);
  }
  const server = await startServer({ dir, port: 0, host: '127.0.0.1' });
  onCleanup(() => server.close());
  const u = new URL(server.url);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return { url: u.href, origin: u.origin, server, dir };
}

function printTable(results) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (s, st) => {
    if (!color) return s;
    const c = { PASS: 32, FAIL: 31, SKIP: 33, INFO: 36 }[st] ?? 0;
    return `\x1b[${c}m${s}\x1b[0m`;
  };
  const w = Math.max(...results.map((r) => r.name.length));
  const cols = process.stdout.columns || 160;
  console.log(`\n${'ID'.padEnd(4)} ${'CHECK'.padEnd(w)}  RESULT  DETAILS`);
  console.log(`${'-'.repeat(4)} ${'-'.repeat(w)}  ------  ${'-'.repeat(Math.max(7, Math.min(60, cols - w - 16)))}`);
  const order = ['load', 'a', 'b', 'c', 'd', 'e', 'f1', 'f2', 'g', 'g3', 'g2', 'n', 'h', 'h2', 'i', 'j', 'k',
    'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'r1', 'r2', 'run'];
  const rank = (r) => { const i = order.indexOf(r.id); return i < 0 ? order.length : i; };
  for (const r of [...results].sort((x, y) => rank(x) - rank(y))) {
    const lead = `${r.id.padEnd(4)} ${r.name.padEnd(w)}  `;
    console.log(`${lead}${paint(r.status.padEnd(6), r.status)}  ${r.details}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped, ${count('INFO')} info`);
}

async function removeOldShots(dir) {
  try {
    for (const f of await readdir(dir)) if (/^(mobile|desktop|fail)-.*\.png$/.test(f)) await unlink(join(dir, f));
  } catch {}
}

async function main() {
  const outDir = opts.out ? resolve(opts.out) : join(ROOT, '.e2e');
  await mkdir(outDir, { recursive: true });
  await removeOldShots(outDir);

  const exe = findChrome(); // fail fast, before building
  const target = await prepareTarget();
  console.log(`e2e: testing ${target.url}${target.dir ? ` (built into ${target.dir})` : ''}${CPU_THROTTLE > 1 ? `, CPU throttled ${CPU_THROTTLE}x` : ''}`);
  const chrome = await launchChrome({ exe, headed: opts.headed });
  const cdp = await CDP.connect(chrome.wsUrl);
  onCleanup(() => cdp.close());
  const run = new Run(cdp, target, outDir);
  let crashed = null;
  try {
    await run.run();
  } catch (e) {
    crashed = e;
    run.record('run', 'Harness completed', 'FAIL', `aborted: ${e.message}`);
  }
  if (signals) return 130;
  console.log(`e2e: ${run.browserVersion ?? 'Chrome'} (${chrome.exe})`);
  printTable(run.results);
  const report = {
    url: target.url, browser: run.browserVersion, when: new Date().toISOString(), results: run.results, aborted: crashed ? String(crashed.stack) : null, dom: run.dom, geometry: run.geo,
    serviceWorker: run.sw, frameStats: run.frameStats, requests: run.requests, consoleErrors: run.consoleErrors,
    consoleWarnings: run.consoleWarnings, issues: run.issues, cspProbe: run.cspProbe, screenshots: run.shots.map((f) => relative(outDir, f)),
  };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Screenshots and report.json: ${displayPath(outDir)}`);
  const failed = crashed || run.results.some((r) => r.status === 'FAIL');

  if (opts.keep) {
    if (!opts.headed) { await cdp.send('Browser.close').catch(() => {}); }
    console.log(`\n--keep: ${target.server ? `serving ${target.url}` : 'nothing served by e2e'}${opts.headed ? ' (browser left open)' : ''}. Press Ctrl+C to stop.`);
    process.exitCode = failed ? 1 : 0;
    await new Promise(() => {}); // until a signal handler exits
  }
  return failed ? 1 : 0;
}

main()
  .then(async (code) => { await cleanup(); process.exit(code); })
  .catch(async (e) => {
    console.error(e instanceof SetupError ? `e2e: ${e.message}` : e);
    await cleanup();
    process.exit(e instanceof SetupError ? 2 : 1);
  });
