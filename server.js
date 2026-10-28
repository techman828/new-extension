// Web server: serves the tracker page, accepts its commands and streams state changes to it.
//
//   GET  /api/events          Server-Sent Events: a "state" event, then "changes" events
//   POST /api/<command>       JSON body; replies { ok, result } or { ok: false, error }
//   GET  /*                   the page's own files (PAGE_FILES)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStore } from './store.js';
import { DEFAULT_STATE, createMonitor } from './monitor.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
const DATA_FILE = resolve(ROOT, process.env.DATA_FILE ?? 'data/state.json');
// Required before exposing the site beyond this machine: the server holds your Upwork session.
const PASSWORD = process.env.APP_PASSWORD ?? '';
const MAX_BODY = 20_000_000; // relayResult carries whole Upwork search pages
// Commands the browser extension (extension/) may send: saving the connection it read from Upwork,
// and relaying the Upwork requests the server itself is blocked from making.
const EXTENSION_COMMANDS = new Set(['saveConnection', 'relayNext', 'relayResult']);

// The page and the server share this folder, so only these files are served; the server code
// and the saved state (which holds the Upwork session) never are.
const PAGE_FILES = new Set([
  'index.html', 'app.js', 'app.css', 'filters.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const store = await createStore(DATA_FILE, DEFAULT_STATE);
const monitor = createMonitor(store);
const clients = new Set();

store.onChanged((changes) => {
  const visible = monitor.publicChanges(changes);
  if (visible) for (const res of clients) sendEvent(res, 'changes', visible);
});

const server = createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Upwork Job Tracker"' }).end('Password required');
      return;
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/events' && req.method === 'GET') return openEvents(req, res);
    if (pathname.startsWith('/api/') && req.method === 'POST') return await runCommand(req, res, pathname.slice(5));
    if (req.method === 'GET' || req.method === 'HEAD') return await serveFile(res, pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('Server error');
  }
});

function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const given = Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  sendEvent(res, 'state', monitor.publicState());
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function runCommand(req, res, type) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  };
  // JSON-only, same-origin commands: other sites can't send these without a CORS preflight.
  const origin = req.headers.origin;
  const fromExtension = EXTENSION_COMMANDS.has(type) && origin?.startsWith('chrome-extension://');
  if (!req.headers['content-type']?.startsWith('application/json') || (origin && !fromExtension && new URL(origin).host !== req.headers.host)) {
    return reply(403, { ok: false, error: 'Cross-origin request rejected' });
  }
  const handler = Object.hasOwn(monitor.handlers, type) && monitor.handlers[type];
  if (!handler) return reply(404, { ok: false, error: `Unknown command: ${type}` });

  let msg;
  try {
    msg = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return reply(400, { ok: false, error: err.message });
  }
  try {
    reply(200, { ok: true, result: await handler(msg) });
  } catch (err) {
    reply(200, { ok: false, error: String(err?.message ?? err) });
  }
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!PAGE_FILES.has(name)) return res.writeHead(404).end('Not found');
  try {
    const path = join(ROOT, name);
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function shutdown() {
  server.close();
  for (const res of clients) res.end();
  await store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Upwork Job Tracker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn('Warning: listening beyond this machine without APP_PASSWORD — anyone who can reach it can use your Upwork session.');
  }
  monitor.resume();
});
