#!/usr/bin/env node
// Tiny static file server for dist/: local development and the e2e harness (production is GitHub Pages).
// Node >= 20 built-ins only.
//
//   node scripts/serve.mjs [--port 8080] [--host 127.0.0.1]      (the PORT environment variable also works)
//
// GET and HEAD only. Every response carries Cache-Control: no-store. "/" serves index.html; anything that is not
// a regular file inside the served directory is a 404. Request paths are percent-decoded exactly once and any
// ".", ".." or empty segment, backslash, colon or NUL is rejected (400), so encoded traversal and absolute paths
// cannot escape the directory; resolved files are also checked against the directory after following symlinks.

import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SELF = fileURLToPath(import.meta.url);

/** <repo>/dist */
export const DEFAULT_DIR = path.resolve(path.dirname(SELF), '..', 'dist');

const TEXT_PLAIN = 'text/plain; charset=utf-8';
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': TEXT_PLAIN,
});

/** Content-Type for a file name. CNAME has no extension and is plain text. */
export function contentType(file) {
  const name = path.basename(file);
  if (name === 'CNAME') return TEXT_PLAIN;
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Maps a request target ("/path?query") to a file path inside `root`, or returns null when the target is not a
 * plain origin-form path that stays inside `root`. A trailing "/" means index.html.
 */
export function resolveRequestPath(root, target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  let pathname = target.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const segments = pathname.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[\\:\0]/.test(s))) return null;
  const file = path.join(root, ...segments);
  return isInside(root, file) ? file : null;
}

function sendText(req, res, status, message) {
  const body = Buffer.from(`${status} ${message}\n`);
  res.writeHead(status, { 'Content-Type': TEXT_PLAIN, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
  return status;
}

/** Handles one request; resolves to the status code sent. `root` must already be a real path. */
async function handle(root, req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendText(req, res, 405, 'Method Not Allowed');
  }
  const file = resolveRequestPath(root, req.url);
  if (file === null) return sendText(req, res, 400, 'Bad Request');

  let body;
  try {
    const real = await fs.realpath(file);
    if (!isInside(root, real) || !(await fs.stat(real)).isFile()) return sendText(req, res, 404, 'Not Found');
    body = await fs.readFile(real);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'ELOOP'].includes(err.code)) return sendText(req, res, 404, 'Not Found');
    throw err;
  }
  res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
  return 200;
}

/**
 * Starts serving `dir`.
 * @param {{ dir?: string, port?: number, host?: string, log?: (line: string) => void }} [options]
 *   port 0 picks a free ephemeral port; `log` receives one "METHOD /url STATUS" line per request.
 * @returns {Promise<{ server: import('node:http').Server, url: string, close: () => Promise<void> }>}
 *   `url` is "http://host:port/"; close() stops listening, drops open connections and resolves once closed.
 */
export async function startServer({ dir = DEFAULT_DIR, port = 8080, host = '127.0.0.1', log } = {}) {
  let root;
  try {
    root = await fs.realpath(path.resolve(dir));
    if (!(await fs.stat(root)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
  } catch (err) {
    throw Object.assign(new Error(`cannot serve ${dir}: ${err.code === 'ENOENT' ? 'no such directory' : err.message}`), { code: err.code });
  }

  const server = http.createServer((req, res) => {
    handle(root, req, res).then(
      (status) => log?.(`${req.method} ${req.url} ${status}`),
      (err) => {
        log?.(`${req.method} ${req.url} 500 ${err.message}`);
        if (res.headersSent) res.destroy(err);
        else sendText(req, res, 500, 'Internal Server Error');
      },
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const urlHost = host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${urlHost}:${server.address().port}/`;
  let closing = null;
  const close = () =>
    (closing ??= new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }));
  return { server, url, close };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('usage: node scripts/serve.mjs [--port 8080] [--host 127.0.0.1]   (PORT env also works; --port 0 = any free port)');
    return;
  }
  const port = values.port ?? process.env.PORT ?? '8080';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error(`invalid port ${JSON.stringify(port)}`);
  const host = values.host ?? '127.0.0.1';
  const shown = `${path.relative(process.cwd(), DEFAULT_DIR) || '.'}${path.sep}`;

  let running;
  try {
    running = await startServer({ dir: DEFAULT_DIR, port: Number(port), host, log: (line) => console.log(line) });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${shown} not found; run "npm run build" first`);
    if (err.code === 'EADDRINUSE') throw new Error(`${host}:${port} is already in use (try --port 0 for a free port)`);
    throw err;
  }
  console.log(`Serving ${shown} at ${running.url}  (Ctrl+C to stop)`);
  const stop = () => running.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isMain()) {
  main().catch((err) => {
    console.error(`serve: ${err.message}`);
    process.exitCode = 1;
  });
}
