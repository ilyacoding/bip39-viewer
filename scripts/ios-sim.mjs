#!/usr/bin/env node
// Optional: look at the built site in Mobile Safari on an iOS simulator (macOS + Xcode only).
// Not part of `npm run e2e`.
//
//   node scripts/ios-sim.mjs                       build, serve dist on 127.0.0.1, boot "iPhone 17", open the page,
//                                                  save .e2e/ios-<device>-<light|dark>.png, shut the simulator down
//   node scripts/ios-sim.mjs --device "iPhone 18 Pro"
//   node scripts/ios-sim.mjs --keep                leave the simulator and the server running (Ctrl+C stops the server)
//   node scripts/ios-sim.mjs --out <dir> --port <n>
//
// The simulator shares the Mac's network stack, so 127.0.0.1 inside it is this machine. A simulator this script
// boots is screenshotted in its current appearance and the opposite one (restored afterwards), then shut down.
// A simulator that was already running belongs to someone else: it only gets the page opened and one screenshot
// in its current appearance, and is left booted.

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_TIMEOUT = 60000;
const PAINT_MS = 2500; // after the page's own load-time request, let Safari finish painting

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      device: { type: 'string', default: 'iPhone 17' },
      keep: { type: 'boolean', default: false },
      out: { type: 'string' },
      port: { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (e) {
  console.error(`ios-sim: ${e.message}`);
  process.exit(2);
}
if (opts.help) {
  console.log('Usage: node scripts/ios-sim.mjs [--device "iPhone 17"] [--keep] [--out <dir>] [--port <n>]');
  process.exit(0);
}
if (process.platform !== 'darwin') {
  console.error('ios-sim: needs macOS with Xcode (xcrun simctl).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('ios-sim:', ...a);

function run(cmd, args, { timeout = 60000, allowFail = false } = {}) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) rej(new Error(`${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      else res({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const simctl = (args, o) => run('xcrun', ['simctl', ...args], o);

// ---- cleanup (success, failure, Ctrl+C)
const disposers = [];
let cleaning = null;
const cleanup = () => (cleaning ??= (async () => {
  while (disposers.length) {
    try { await disposers.pop()(); } catch (e) { console.error(`ios-sim: cleanup: ${e.message}`); }
  }
})());
const tmpDirs = new Set();
process.on('exit', () => { for (const d of tmpDirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });
let signalled = 0;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    if (signalled++) process.exit(code);
    cleanup().finally(() => process.exit(process.exitCode ?? code));
  });
}

async function findDevice(name) {
  const { stdout } = await simctl(['list', 'devices', 'available', '-j']);
  const { devices } = JSON.parse(stdout);
  const runtimeVersion = (key) => (key.match(/(\d+)-(\d+)(?:-(\d+))?$/) || []).slice(1).map((n) => Number(n || 0));
  const newestFirst = Object.keys(devices).filter((k) => /iOS/.test(k)).sort((a, b) => {
    const [x, y] = [runtimeVersion(a), runtimeVersion(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  for (const rt of newestFirst) {
    const d = devices[rt].find((x) => x.name === name && x.isAvailable !== false);
    if (d) return { ...d, runtime: rt.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '') };
  }
  const names = [...new Set(newestFirst.flatMap((rt) => devices[rt].map((x) => x.name)))];
  throw new Error(`no available simulator named "${name}". Available: ${names.join(', ')}`);
}

async function main() {
  try { await run('xcrun', ['simctl', 'help'], { timeout: 30000 }); } catch {
    throw new Error('xcrun simctl is not available (install Xcode and its command line tools).');
  }
  const outDir = opts.out ? resolve(opts.out) : join(ROOT, '.e2e');
  await mkdir(outDir, { recursive: true });

  // ---- build + serve
  for (const f of ['scripts/build.mjs', 'scripts/serve.mjs']) if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing`);
  const { build } = await import(pathToFileURL(join(ROOT, 'scripts/build.mjs')).href);
  const { startServer } = await import(pathToFileURL(join(ROOT, 'scripts/serve.mjs')).href);
  const dist = await mkdtemp(join(tmpdir(), 'bip39-ios-dist-'));
  tmpDirs.add(dist);
  disposers.push(async () => { await rm(dist, { recursive: true, force: true }); tmpDirs.delete(dist); });
  await build({ root: ROOT, outDir: dist, quiet: true });
  const hits = [];
  const server = await startServer({ dir: dist, port: Number(opts.port), host: '127.0.0.1', log: (line) => hits.push({ line, t: Date.now() }) });
  disposers.push(() => server.close());
  log(`serving ${server.url}`);

  // ---- simulator
  const dev = await findDevice(opts.device);
  const slug = dev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const wasBooted = dev.state === 'Booted';
  const simulatorAppWasRunning = spawnSync('pgrep', ['-x', 'Simulator']).status === 0;
  log(`${dev.name} (${dev.runtime}, ${dev.udid}) is ${dev.state.toLowerCase()}`);
  if (!wasBooted && !opts.keep) {
    disposers.push(async () => {
      log(`shutting down ${dev.name}`);
      await simctl(['shutdown', dev.udid], { allowFail: true, timeout: 60000 });
      // Quit Simulator.app only if we started it and no other simulator is still running in it.
      const others = (await simctl(['list', 'devices', 'booted'], { allowFail: true })).stdout.includes('(Booted)');
      if (!simulatorAppWasRunning && !others) await run('osascript', ['-e', 'quit app "Simulator"'], { allowFail: true, timeout: 15000 });
    });
  }
  // bootstatus -b boots the device if needed and returns once it has finished booting.
  await simctl(['bootstatus', dev.udid, '-b'], { timeout: 240000 });
  await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', dev.udid], { allowFail: true });

  const appearance = (await simctl(['ui', dev.udid, 'appearance'], { allowFail: true })).stdout.trim(); // "light" | "dark" | "unsupported"
  const known = appearance === 'light' || appearance === 'dark';
  const schemes = !known ? [null] : wasBooted ? [appearance] : [appearance, appearance === 'dark' ? 'light' : 'dark'];
  if (known && !wasBooted) disposers.push(() => simctl(['ui', dev.udid, 'appearance', appearance], { allowFail: true }));
  if (wasBooted) log(`it was already booted: leaving its ${appearance} appearance alone and not shutting it down`);

  // ---- open the page; wait until the server has seen it (first load: also the app's load-time GET /sw.js)
  const openAndWait = async (url, needSw) => {
    const t0 = Date.now();
    await simctl(['openurl', dev.udid, url]);
    const deadline = t0 + LOAD_TIMEOUT;
    const seen = (re) => hits.some((h) => h.t >= t0 && re.test(h.line));
    while (!(seen(/^GET \/(\?\S*)? /) && (!needSw || seen(/^GET \/sw\.js /)))) {
      if (Date.now() > deadline) {
        const got = hits.filter((h) => h.t >= t0).map((h) => h.line).join(', ') || 'no requests';
        throw new Error(`Safari did not load ${url} within ${LOAD_TIMEOUT / 1000}s (server saw: ${got})`);
      }
      await sleep(100);
    }
    log(`loaded ${url} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${hits.filter((h) => h.t >= t0).map((h) => h.line.split(' ').slice(0, 2).join(' ')).join(', ')})`);
    await sleep(PAINT_MS);
  };
  await openAndWait(server.url, true);

  const shots = [];
  for (const scheme of schemes) {
    if (scheme && scheme !== appearance) {
      // Safari re-tints its own bars only on a fresh load, so switch, then load the page again
      // (a new query string makes Safari load it instead of refocusing the open tab).
      await simctl(['ui', dev.udid, 'appearance', scheme]);
      await openAndWait(`${server.url}?appearance=${scheme}`, false);
    }
    const file = join(outDir, `ios-${slug}${scheme ? `-${scheme}` : ''}.png`);
    await simctl(['io', dev.udid, 'screenshot', '--type=png', file], { timeout: 30000 });
    shots.push(file);
  }
  const shown = (f) => { const r = relative(process.cwd(), f); return r && !r.startsWith('..') ? r : f; };
  log(`screenshots: ${shots.map(shown).join(', ')}`);

  if (opts.keep) {
    log(`--keep: ${dev.name} stays booted; serving ${server.url} until Ctrl+C`);
    await new Promise(() => {});
  }
}

main()
  .then(async () => { await cleanup(); process.exit(0); })
  .catch(async (e) => {
    console.error(`ios-sim: ${e.message}`);
    await cleanup();
    process.exit(1);
  });
