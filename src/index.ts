// Jarvis server entry point.
//
// Wires together: env, SQLite, Tool Dispatcher, HTTP+WebSocket server,
// and the OpenAI Realtime proxy. Run via `npm run dev` (tsx watch) or
// `npm start` after `npm run build`.

import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket as ClientWS } from 'ws';

import { loadEnv } from './env.js';
import { log } from './logger.js';
import { runProxy } from './proxy.js';
import { emptyUserContext, resolveUserId } from './session.js';
import { openDb, type Db } from './db.js';
import { ToolDispatcher } from './tools/dispatcher.js';
import { registerAllTools } from './tools/registry.js';

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

  const http = createServer((req, res) => {
    // Healthcheck endpoint for Render/Fly probes.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ts: new Date().toISOString(),
        capabilities: dispatcher.capabilities(env).map((c) => ({ name: c.name, available: c.available })),
      }));
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

try {
  main();
} catch (err) {
  log.error({ event: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
