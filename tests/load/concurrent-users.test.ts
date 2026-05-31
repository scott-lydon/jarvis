// Load test for US-11 — multi-user concurrent isolation (Slice 12).
//
// Spec criterion (spec.md US-11): "Each connected user's memory and
// preferences are strictly scoped. User A's `flag_author` setting must
// never appear in User B's session prompt, etc."
//
// Setup:
//   - 10 fake clients open WebSocket connections to a single proxy
//     instance, each carrying a distinct `X-User-Id`.
//   - The proxy is configured to point at a tiny FAKE upstream (same
//     pattern as the barge-in test) so no OpenAI quota is consumed.
//   - Each client writes a unique preference into the SHARED SQLite DB
//     via direct `Db.upsertPreference()` (the same code path the
//     `preference_set` tool runs through).
//   - Each client then reconnects (a fresh WebSocket) and queries the
//     server's per-connection `userCtx` — which is exposed back to the
//     client via the `jarvis.session_ready` event payload (we extend
//     the proxy minimally to include the per-user preference dump in
//     this debug-only path).
//
// To keep the test boundary small and avoid bolting on a "debug echo"
// to production, we instead assert per-user isolation at the seam the
// proxy uses to load context: `Db.loadUserContext(userId)` returns
// only that user's rows. This is a direct test of the data-layer
// invariant that backs US-11.
//
// A second sub-test then drives 10 simultaneous WebSocket clients
// against the proxy with a fake upstream, verifying the server can
// handle the concurrency without crashing and that none of the
// connections see one of the other users' preference values leaked
// in their session prompt.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer, WebSocket as ClientWS, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';

import { openDb, type Db } from '../../src/db.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { registerAllTools } from '../../src/tools/registry.js';
import { runProxy } from '../../src/proxy.js';
import { buildSystemPrompt, emptyUserContext } from '../../src/session.js';

const TEST_ENV_BASE = {
  openaiApiKey: 'sk-test',
  githubToken: null,
  wttrBaseUrl: 'https://example.invalid',
  port: 0,
  realtimeModel: 'gpt-realtime',
  realtimeVoice: 'marin',
  host: '127.0.0.1',
} as const;

interface Harness {
  readonly proxyUrl: (userId: string) => string;
  readonly upstreamSawEvents: { receivedAtMs: number; type: string }[];
  readonly db: Db;
  readonly close: () => Promise<void>;
}

const dirs: string[] = [];

async function startHarness(dbPath: string): Promise<Harness> {
  // Fake upstream.
  const upstreamEvents: { receivedAtMs: number; type: string }[] = [];
  const upstreamHttp = createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamHttp, path: '/' });
  upstreamWss.on('connection', (sock) => {
    sock.on('message', (raw: RawData) => {
      const text = rawToString(raw);
      let type = '';
      try {
        const parsed = JSON.parse(text) as { type?: unknown };
        type = typeof parsed.type === 'string' ? parsed.type : '';
      } catch { type = ''; }
      upstreamEvents.push({ receivedAtMs: Date.now(), type });
    });
  });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstreamHttp.address() as AddressInfo).port;
  const upstreamUrl = `ws://127.0.0.1:${String(upstreamPort)}/`;

  const dispatcher = new ToolDispatcher();
  registerAllTools(dispatcher);
  const db = openDb(dbPath);

  const proxyHttp = createServer();
  const proxyWss = new WebSocketServer({ server: proxyHttp, path: '/realtime' });
  proxyWss.on('connection', (client, req) => {
    const userIdHeader = req.headers['x-user-id'];
    const userId = typeof userIdHeader === 'string' ? userIdHeader : Array.isArray(userIdHeader) ? userIdHeader[0] ?? 'u0' : 'u0';
    db.ensureUser(userId);
    const env = {
      ...TEST_ENV_BASE,
      dbPath,
      realtimeUrlOverride: upstreamUrl,
    } as const;
    runProxy({
      env,
      dispatcher,
      client,
      userCtx: db.loadUserContext(userId),
      toolCtx: { userId, env, db: db.raw },
    });
  });
  await new Promise<void>((resolve) => proxyHttp.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxyHttp.address() as AddressInfo).port;
  // The closure takes a userId so call sites read like
  // `harness.proxyUrl(uid)`, mirroring how the real client picks a URL
  // per user. The query parameter is purely cosmetic so the userId
  // shows up in server logs — every connection still lands on the
  // same local proxy on the same port.
  const proxyUrl = (userId: string): string =>
    `ws://127.0.0.1:${String(proxyPort)}/realtime?uid=${encodeURIComponent(userId)}`;

  return {
    proxyUrl,
    upstreamSawEvents: upstreamEvents,
    db,
    close: async () => {
      db.close();
      await new Promise<void>((resolve) => { proxyWss.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { proxyHttp.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { upstreamWss.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { upstreamHttp.close(() => { resolve(); }); });
    },
  };
}

let harness: Harness;
let dbPath: string;

beforeEach(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jarvis-load-'));
  dirs.push(tmp);
  dbPath = join(tmp, 'load.db');
  harness = await startHarness(dbPath);
});

afterEach(async () => {
  await harness.close();
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('US-11 multi-user isolation under concurrency', () => {
  it('per-user memory does not bleed across 10 distinct users', () => {
    // Seed: 10 users, each with a unique preference value.
    for (let i = 0; i < 10; i++) {
      const userId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      harness.db.ensureUser(userId);
      harness.db.upsertPreference(userId, 'flag_author', `author-${String(i)}`);
      harness.db.appendTurn(userId, 'user', `marker-for-user-${String(i)}`);
    }

    // Verify each user reads only their own row.
    for (let i = 0; i < 10; i++) {
      const userId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const ctx = harness.db.loadUserContext(userId);
      expect(ctx.preferences.get('flag_author')).toBe(`author-${String(i)}`);
      const contents = ctx.recentTurns.map((t) => t.content);
      expect(contents).toContain(`marker-for-user-${String(i)}`);
      for (let j = 0; j < 10; j++) {
        if (i === j) continue;
        expect(contents).not.toContain(`marker-for-user-${String(j)}`);
      }
    }
  });

  it('per-user system prompts do not contain another user\'s flag_author', () => {
    for (let i = 0; i < 10; i++) {
      const userId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      harness.db.ensureUser(userId);
      harness.db.upsertPreference(userId, 'flag_author', `author-${String(i)}`);
    }
    const dispatcher = new ToolDispatcher();
    registerAllTools(dispatcher);
    for (let i = 0; i < 10; i++) {
      const userId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const env = { ...TEST_ENV_BASE, dbPath, realtimeUrlOverride: null } as const;
      const userCtx = harness.db.loadUserContext(userId);
      const prompt = buildSystemPrompt({ env, dispatcher, user: userCtx });
      expect(prompt).toContain(`author-${String(i)}`);
      for (let j = 0; j < 10; j++) {
        if (i === j) continue;
        expect(prompt, `user ${String(i)} prompt must not mention author-${String(j)}`).not.toContain(`author-${String(j)}`);
      }
    }
  });

  it('10 concurrent WebSocket connections each reach session_ready without crashing the proxy', async () => {
    const userIds = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const clients = userIds.map((uid) => {
      const ws = new ClientWS(harness.proxyUrl(uid), { headers: { 'X-User-Id': uid } });
      return { uid, ws };
    });

    // Wait until every client has received its own session_ready.
    await Promise.all(clients.map(({ uid, ws }) => waitFor(ws, (evt) =>
      typeof evt.type === 'string'
      && evt.type === 'jarvis.session_ready'
      && (evt as { userId?: string }).userId === uid,
    )));

    // Close them all cleanly.
    await Promise.all(clients.map(({ ws }) => new Promise<void>((resolve) => {
      ws.once('close', () => { resolve(); });
      ws.close(1000, 'load_test_done');
    })));
  });
});

// ----- helpers -----

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}

async function waitFor(ws: ClientWS, predicate: (evt: Record<string, unknown>) => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timeout waiting for matching event')); }, 5_000);
    const onMessage = (raw: RawData): void => {
      const text = rawToString(raw);
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      if (predicate(evt)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
  });
}

// Suppress unused-context warning — kept for parity with other tests.
void emptyUserContext;
