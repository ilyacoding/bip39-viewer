#!/usr/bin/env node
// End-to-end test for the BIP39 viewer.
//
// Builds the site into a temp dir, serves it on 127.0.0.1, drives headless Chrome over the DevTools
// protocol as an iPhone-class touch device (390x844 @3x) and checks the scroll-only contract from the
// spec: DOM shape, no errors/CSP violations, same-origin-only network, lens/reel geometry after real
// touch drags and flings, screenshots (dark + light + desktop), the privacy veil and offline mode.
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
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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
const bits11 = (i) => i.toString(2).padStart(11, '0');
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

function pageSnapshot() {
  const html = document.documentElement;
  const list = document.getElementById('list');
  const reel = document.getElementById('reel');
  const vc = window.innerHeight / 2;
  const words = document.querySelectorAll('.w');
  const letters = [...document.querySelectorAll('.reel__l')];
  const center = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const text = (el) => (el.querySelector('.w__t') || el).textContent;
  const act = document.querySelectorAll('.w.is-active');
  const a = act[0] || null;
  const idx = a ? Array.prototype.indexOf.call(words, a) : -1;
  // Word geometrically closest to the viewport centre (rows are in vertical order).
  let lo = 0, hi = words.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (center(words[m]) < vc) lo = m + 1; else hi = m; }
  let near = null;
  for (const j of [lo - 1, lo]) {
    if (j < 0 || j >= words.length) continue;
    const d = Math.abs(center(words[j]) - vc);
    if (!near || d < near.delta) near = { index: j, text: text(words[j]), delta: d };
  }
  const ra = document.querySelectorAll('.reel__l.is-active');
  const lens = document.querySelector('.lens');
  return {
    vc,
    lensCenter: lens ? center(lens) : null,
    activeCount: act.length,
    active: a ? { index: idx, text: text(a), center: center(a), letter: a.closest('.sec')?.dataset.letter ?? null } : null,
    nearest: near,
    reelActiveCount: ra.length,
    reelActive: ra[0] ? { index: letters.indexOf(ra[0]), text: ra[0].textContent.trim(), center: center(ra[0]) } : null,
    bits: document.getElementById('bits')?.textContent ?? null,
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
    if (origin !== this.target.origin) {
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

  async waitStable(timeoutMs = SETTLE_TIMEOUT) {
    const r = await this.eval(pageWaitStable, STABLE_MS, timeoutMs);
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
  }

  async reload() {
    await this.collectProbe();
    const loaded = this.page.waitFor('Page.loadEventFired', () => true, LOAD_TIMEOUT);
    await this.page.send('Page.reload', { ignoreCache: false });
    await loaded;
    this.loadedAt = now();
    this.docPhase = this.phase;
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
      const v = await this.eval(() => (window.__e2e ? window.__e2e.csp.splice(0) : []));
      for (const x of v) this.cspProbe.push({ ...x, phase: this.docPhase });
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
  async touchDrag(x, y0, y1, ms, hold = 0) {
    const steps = Math.max(3, Math.round(ms / 16));
    const wall0 = Date.now() / 1000;
    const t0 = now();
    const pt = (y) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 0.5 }];
    const send = (type, y, at) =>
      this.page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : pt(y), timestamp: wall0 + at / 1000 });
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
      if (!ended) await this.page.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
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

  // Invariants that must hold whenever both strips are at rest.
  restProblems(s, { expectWord, expectLetter } = {}) {
    const p = [];
    if (s.activeCount !== 1) p.push(`${s.activeCount} .w.is-active (want 1)`);
    if (s.reelActiveCount !== 1) p.push(`${s.reelActiveCount} .reel__l.is-active (want 1)`);
    if (s.active) {
      const d = s.active.center - s.vc;
      if (Math.abs(d) > TOL) p.push(`active word "${s.active.text}" is ${fmt(d)}px off centre`);
      if (s.bits !== bits11(s.active.index)) p.push(`#bits "${s.bits}" != ${bits11(s.active.index)} (index ${s.active.index})`);
      if (s.nearest && s.nearest.index !== s.active.index) p.push(`word nearest the lens is "${s.nearest.text}", not the active "${s.active.text}"`);
      if (expectWord && s.active.text !== expectWord) p.push(`active word "${s.active.text}" (want "${expectWord}")`);
    }
    if (s.reelActive) {
      const d = s.reelActive.center - s.vc;
      if (Math.abs(d) > TOL) p.push(`reel letter ${s.reelActive.text} is ${fmt(d)}px off centre`);
      if (s.active && s.reelActive.text.toLowerCase() !== s.active.text[0]) p.push(`reel shows ${s.reelActive.text} but active word is "${s.active.text}"`);
      if (expectLetter && s.reelActive.text !== expectLetter) p.push(`reel letter ${s.reelActive.text} (want ${expectLetter})`);
    }
    return p;
  }

  describe(s) {
    if (!s.active) return `no active word; list ${fmt(s.list?.top)}`;
    return `"${s.active.text}" #${s.active.index + 1} Δ${fmt(s.active.center - s.vc)}px, reel ${s.reelActive?.text ?? '?'} Δ${fmt((s.reelActive?.center ?? NaN) - s.vc)}px, bits ${s.bits}`;
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
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.page = new Session(cdp, sessionId);
    const p = this.page;
    await Promise.all([p.send('Page.enable'), p.send('Runtime.enable'), p.send('Log.enable'), p.send('Network.enable'), p.send('Audits.enable')]);
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
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

    await this.check('d', 'Initial state: abandon + A centred, bits 0…0, verify ok ≤3s', async () => {
      const s = await this.snapshot();
      const p2 = this.restProblems(s, { expectWord: 'abandon', expectLetter: 'A' });
      if (s.bits !== '00000000000') p2.push(`#bits "${s.bits}"`);
      const v = await this.poll(() => document.getElementById('verify')?.dataset.state, [], (x) => x === 'ok', Math.max(0, VERIFY_TIMEOUT - (now() - this.loadedAt)), 'verify');
      if (!v.ok) p2.push(`#verify data-state="${v.value}" ${fmt(now() - this.loadedAt)}ms after load (want ok ≤${VERIFY_TIMEOUT}ms)`);
      return [p2, `${this.describe(s)}; #verify ${v.value} ${fmt(now() - this.loadedAt)}ms after load (lens centre ${fmt(s.lensCenter)}px, viewport centre ${fmt(s.vc)}px)`];
    });
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

    await this.check('e', 'List fling: settles centred, reel letter + bits match', async () => {
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
      else if (s.active?.text !== sec.first) p2.push(`list shows "${s.active?.text}", want first ${sec.letter.toUpperCase()} word "${sec.first}"`);
      if (s.reelActive && before.reelActive && s.reelActive.index <= before.reelActive.index) p2.push(`reel did not advance (${before.reelActive.text} → ${s.reelActive.text})`);
      return [p2, `${before.reelActive?.text} → ${this.describe(s)}`];
    });

    await this.check('g', 'List drag across a letter boundary: reel follows', async () => {
      const s = await this.snapshot();
      if (!s.active || !this.sections) return [['no active word / section data'], ''];
      const k = this.sections.findIndex((x) => x.letter === s.active.letter);
      // Target: two rows past the nearest letter boundary (backwards if possible, else forwards).
      const options = [];
      if (k > 0) options.push({ target: this.sections[k].firstIndex - 2, want: this.sections[k - 1].letter });
      if (k >= 0 && k < this.sections.length - 1) options.push({ target: this.sections[k + 1].firstIndex + 1, want: this.sections[k + 1].letter });
      const dists = await this.eval((i, ts) => {
        const w = document.querySelectorAll('.w');
        const c = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        return ts.map((t) => c(w[i]) - c(w[t]));
      }, s.active.index, options.map((o) => o.target));
      options.forEach((o, j) => { o.dist = dists[j]; });
      const opt = options.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0];
      if (!opt || Math.abs(opt.dist) > g.h * 0.55) return ['SKIP', `no letter boundary within a one-finger drag of "${s.active.text}" (f2 failed?)`];
      // Finger moves by +dist (down = back towards A); start so the whole path stays on screen.
      const y0 = opt.dist > 0 ? Math.round(g.h * 0.25) : Math.round(g.h * 0.75);
      await this.touchDrag(listX, y0, y0 + opt.dist, 700, 250);
      await this.waitStable();
      const s2 = await this.snapshot();
      const p2 = this.restProblems(s2);
      if (s2.active?.letter !== opt.want) p2.push(`active word "${s2.active?.text}" is not in ${opt.want.toUpperCase()}`);
      if (s2.reelActive?.text.toLowerCase() !== opt.want) p2.push(`reel stayed on ${s2.reelActive?.text} (want ${opt.want.toUpperCase()})`);
      if (/\bis-reel-driving\b/.test(s2.classes)) p2.push('html.is-reel-driving still set after the list was dragged');
      return [p2, `"${s.active.text}" → drag ${fmt(opt.dist)}px → ${this.describe(s2)}`];
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
      if (sec && s.active?.text !== sec.first) p2.push(`reel grab: list shows "${s.active?.text}", want first ${sec.letter.toUpperCase()} word "${sec.first}"`);
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

    await this.check('g2', 'End of list: reel to Z, list to the end: zoo, 11111111111, outro', async () => {
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
      if (s.active?.text !== 'zoo') p2.push(`active word at the end is "${s.active?.text}" (want zoo)`);
      if (s.bits !== '11111111111') p2.push(`#bits "${s.bits}" at the end`);
      if (s.reelActive?.text !== 'Z') p2.push(`reel shows ${s.reelActive?.text} at the end`);
      const outro = await this.eval(() => { const r = document.querySelector('.outro')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; });
      if (!outro || outro.top > g.h) p2.push('outro not visible at the end');
      await this.shotPair('4-end').catch((e) => this.shotErrors.push(`end: ${e.message}`));
      return [p2, `reel → Z ("zebra"), list at end (${fmt(s.list.top)}/${fmt(s.list.max)}): "${s.active?.text}" bits ${s.bits}, outro top at ${fmt(outro?.top)}px`];
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

function displayPath(p) {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
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
  const order = ['load', 'a', 'b', 'c', 'd', 'e', 'f1', 'f2', 'g', 'g3', 'g2', 'h', 'h2', 'i', 'j', 'k', 'run'];
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
