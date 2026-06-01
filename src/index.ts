// Jarvis server entry point.
//
// Wires together: env, SQLite, Tool Dispatcher, HTTP+WebSocket server,
// and the OpenAI Realtime proxy. Run via `npm run dev` (tsx watch) or
// `npm start` after `npm run build`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket as ClientWS } from 'ws';

import { loadEnv } from './env.js';
import { log } from './logger.js';
import { runProxy } from './proxy.js';
import { emptyUserContext, resolveUserId } from './session.js';
import { openDb, type Db } from './db.js';
import { ToolDispatcher } from './tools/dispatcher.js';
import { registerAllTools } from './tools/registry.js';
import { maybeRollSummary } from './memory-summarizer.js';
// BUG-DIAG-2026-06-01: debug-only mic-pipeline → HTTP Whisper isolation
// endpoint. Delete this import + the route below when the modal is
// removed. Grep for BUG-DIAG-2026-06-01.
import { handleTranscribeTest } from './transcribe.js';

function main(): void {
  const env = loadEnv();
  log.info({
    event: 'startup',
    port: env.port,
    realtimeModel: env.realtimeModel,
    githubConfigured: env.githubToken !== null,
    dbPath: env.dbPath,
  });

  // Persistence: best-effort. If the DB can't open, we keep going with
  // memory-offline mode so the voice loop still works (plan.md §2.2).
  let db: Db | null = null;
  try {
    db = openDb(env.dbPath);
  } catch (cause) {
    log.error({
      event: 'startup.db_open_failed',
      message: cause instanceof Error ? cause.message : String(cause),
      dbPath: env.dbPath,
    });
  }

  const dispatcher = new ToolDispatcher();
  registerAllTools(dispatcher);

  // Resolve the static web bundle directory once. In production
  // (Render's `npm run build && npm run web:build`) the bundle lives at
  // <repo>/web/dist relative to the compiled `dist/index.js`. We resolve
  // off `import.meta.url` so the path is correct regardless of where the
  // process was launched from.
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const staticRoot = resolvePath(moduleDir, '..', 'web', 'dist');
  const staticAvailable = existsSync(staticRoot) && existsSync(join(staticRoot, 'index.html'));
  if (!staticAvailable) {
    log.warn({
      event: 'static.bundle_missing',
      staticRoot,
      hint: 'Run `npm run web:build` to produce web/dist/. The /healthz API path will still work, but / will 404.',
    });
  }

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    // Healthcheck endpoint for Render/Fly probes — JSON path always wins.
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ts: new Date().toISOString(),
        capabilities: dispatcher.capabilities(env).map((c) => ({ name: c.name, available: c.available })),
      }));
      return;
    }
    // /realtime is the WebSocketServer's path; never serve a body here.
    // The WS upgrade hits a separate handler attached by `new WebSocketServer({...})`.
    if (url === '/realtime' || url.startsWith('/realtime?')) {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('upgrade required');
      return;
    }
    // BUG-DIAG-2026-06-01: debug-only HTTP Whisper isolation endpoint.
    // Used by the mic-test modal to verify mic capture + transcription
    // independent of the Realtime WebSocket path. Remove when the modal
    // is deleted.
    if (url === '/api/transcribe-test') {
      void handleTranscribeTest(req, res, { openaiApiKey: env.openaiApiKey })
        .catch((err: unknown) => {
          log.error({
            event: 'transcribe.handler_threw',
            message: err instanceof Error ? err.message : String(err),
          });
          // Best-effort error surface — the handler should have already
          // responded in nearly all paths; this catches handler bugs.
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code: 'handler_threw', message: 'see server logs' } }));
          }
        });
      return;
    }
    if (staticAvailable) {
      serveStatic(staticRoot, url, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: http, path: '/realtime' });

  wss.on('connection', (client: ClientWS, req: IncomingMessage) => {
    const userIdHeader = pickHeader(req.headers['x-user-id']);
    const userId = resolveUserId(userIdHeader);
    log.info({ event: 'connection.opened', userId, remoteAddr: req.socket.remoteAddress ?? null });

    const userCtx = db === null
      ? emptyUserContext(userId, false)
      : db.loadUserContext(userId);

    if (db !== null) db.ensureUser(userId);

    const toolCtx = { userId, env, db: db?.raw ?? null } as const;

    try {
      runProxy({
        env,
        dispatcher,
        client,
        userCtx,
        toolCtx,
        onTurn: (turn) => {
          if (db === null) return;
          try {
            db.appendTurn(userId, turn.role, turn.content);
          } catch (cause) {
            log.error({
              event: 'turn.persist_failed',
              message: cause instanceof Error ? cause.message : String(cause),
              userId,
            });
          }
          // US-03 cross-session recall (Slice 4): after assistant turns,
          // fire-and-forget the rolling summarizer. The function gates
          // itself by a 20-new-turn threshold so we are not hitting the
          // OpenAI Chat Completions API after every word. We never block
          // the WebSocket loop on this — failures are logged inside.
          if (turn.role === 'assistant') {
            void maybeRollSummary(db, userId, env).catch((cause: unknown) => {
              log.error({
                event: 'summary.roll_failed_unexpectedly',
                message: cause instanceof Error ? cause.message : String(cause),
                userId,
              });
            });
          }
        },
      });
    } catch (err) {
      log.error({
        event: 'proxy.run_threw',
        message: err instanceof Error ? err.message : String(err),
      });
      try { client.close(1011, 'proxy_error'); } catch { /* ignore */ }
    }
  });

  http.listen(env.port, env.host, () => {
    log.info({ event: 'listening', host: env.host, port: env.port });
  });

  const shutdown = (sig: string): void => {
    log.warn({ event: 'shutdown.begin', signal: sig });
    wss.close();
    http.close(() => {
      if (db !== null) db.close();
      log.warn({ event: 'shutdown.done' });
      process.exit(0);
    });
    // Force-exit after 5 seconds if something hangs.
    setTimeout(() => { process.exit(1); }, 5000).unref();
  };
  process.once('SIGINT',  () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
}

function pickHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return value[0];
}

const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':  'application/json',
};

/**
 * Serve a file out of the static web bundle directory. Hand-rolled
 * (no Express / no serve-static) so we keep the dependency list tight.
 *
 * Behavior:
 *   - "/"            -> staticRoot/index.html
 *   - "/foo/bar"     -> staticRoot/foo/bar (404 if missing)
 *   - any path with ".." -> 400 (path-traversal guard)
 *
 * Why a guard against ".." in the URL: even though Node's `path.join`
 * collapses traversal, surfacing the request as a 400 makes the failure
 * mode obvious in the logs instead of returning a confusing 404.
 */
function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  // Strip query string and decode.
  const pathOnly = urlPath.split('?')[0] ?? '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad path encoding');
    return;
  }
  if (decoded.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('path traversal not allowed');
    return;
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(root)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('path escapes static root');
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const mime = STATIC_MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    // index.html should NEVER cache (we want clients to pick up new builds);
    // hashed assets under /assets/ may cache aggressively.
    'Cache-Control': abs.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(abs).pipe(res);
}

try {
  main();
} catch (err) {
  log.error({ event: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
