// Integration test for US-04 server-side barge-in latency (Slice 6).
//
// Spec criterion (spec.md US-04):
//   "When the user starts speaking while Jarvis is talking, server-side
//    `response.cancel` must reach the upstream model within 300 ms of the
//    `jarvis.barge_in` event being received from the client."
//
// We stand up a FAKE upstream WebSocket server (NOT OpenAI) and point
// the proxy at it via JARVIS_REALTIME_URL_OVERRIDE. The fake upstream
// records every event it receives and the wall-clock time at which it
// received it. A fake downstream client connects, waits for the
// `jarvis.session_ready` event, then sends `jarvis.barge_in` and asserts
// that the fake upstream receives `{type:"response.cancel"}` within
// 300 ms.
//
// The constitution allows "fake upstream WS" because it is a
// network-shape test, not a data-shape test (the actual response.cancel
// payload is what we are measuring, not a stubbed value).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { WebSocketServer, WebSocket as ClientWS, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';

import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import { runProxy } from '../../src/proxy.js';
import { emptyUserContext } from '../../src/session.js';

interface UpstreamEvent { readonly receivedAtMs: number; readonly type: string; readonly raw: string }

interface Harness {
  readonly downstreamUrl: string;
  readonly upstreamEvents: UpstreamEvent[];
  readonly close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const events: UpstreamEvent[] = [];

  // --- Fake upstream (impersonates wss://api.openai.com/v1/realtime). ---
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
      events.push({ receivedAtMs: Date.now(), type, raw: text });
    });
  });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstreamHttp.address() as AddressInfo).port;
  const upstreamUrl = `ws://127.0.0.1:${String(upstreamPort)}/`;

  // --- Downstream proxy ---
  const proxyHttp = createServer();
  const proxyWss = new WebSocketServer({ server: proxyHttp, path: '/realtime' });
  const env = {
    openaiApiKey: 'sk-test',
    githubToken: null,
    wttrBaseUrl: 'https://example.invalid',
    dbPath: ':memory:',
    port: 0,
    realtimeModel: 'gpt-realtime',
    realtimeVoice: 'marin',
    host: '127.0.0.1',
    realtimeUrlOverride: upstreamUrl,
  } as const;
  proxyWss.on('connection', (client) => {
    runProxy({
      env,
      dispatcher: new ToolDispatcher(),
      client,
      userCtx: emptyUserContext('u-barge-in', true),
      toolCtx: { userId: 'u-barge-in', env, db: null },
    });
  });
  await new Promise<void>((resolve) => proxyHttp.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxyHttp.address() as AddressInfo).port;
  const downstreamUrl = `ws://127.0.0.1:${String(proxyPort)}/realtime`;

  return {
    downstreamUrl,
    upstreamEvents: events,
    close: async () => {
      await new Promise<void>((resolve) => { proxyWss.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { proxyHttp.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { upstreamWss.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { upstreamHttp.close(() => { resolve(); }); });
    },
  };
}

let harness: Harness;
beforeEach(async () => { harness = await startHarness(); });
afterEach(async () => { await harness.close(); });

describe('US-04 server-side barge-in latency', () => {
  it('jarvis.barge_in causes response.cancel to reach upstream within 300 ms', async () => {
    const downstream = new ClientWS(harness.downstreamUrl);
    await new Promise<void>((resolve, reject) => {
      downstream.once('open', () => { resolve(); });
      downstream.once('error', reject);
    });

    // Wait for session_ready to confirm the upstream connection is open
    // (the proxy emits this AFTER it has sent session.update upstream).
    await waitForServerEvent(downstream, 'jarvis.session_ready', 2_000);

    const sentAtMs = Date.now();
    downstream.send(JSON.stringify({ type: 'jarvis.barge_in' }));

    // Poll the recorded upstream events until response.cancel appears or
    // we exceed the 300 ms budget.
    const budgetMs = 300;
    const deadline = sentAtMs + budgetMs;
    let cancelEvt: UpstreamEvent | undefined;
    while (Date.now() < deadline + 50) {  // tiny slack to read the event after it lands
      cancelEvt = harness.upstreamEvents.find((e) => e.type === 'response.cancel');
      if (cancelEvt !== undefined) break;
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    downstream.close();

    expect(cancelEvt, 'expected response.cancel to be received by the fake upstream').toBeDefined();
    if (cancelEvt === undefined) return;
    const latencyMs = cancelEvt.receivedAtMs - sentAtMs;
    expect(latencyMs).toBeLessThanOrEqual(budgetMs);
  });

  it('jarvis.* events are NOT forwarded upstream (lesson Y1)', async () => {
    const downstream = new ClientWS(harness.downstreamUrl);
    await new Promise<void>((resolve, reject) => {
      downstream.once('open', () => { resolve(); });
      downstream.once('error', reject);
    });
    await waitForServerEvent(downstream, 'jarvis.session_ready', 2_000);

    downstream.send(JSON.stringify({ type: 'jarvis.client_hello', userId: 'u-barge-in' }));
    downstream.send(JSON.stringify({ type: 'jarvis.ping' }));
    await new Promise<void>((r) => setTimeout(r, 50));
    downstream.close();

    const upstreamJarvisLeaks = harness.upstreamEvents.filter((e) => e.type.startsWith('jarvis.'));
    expect(upstreamJarvisLeaks, 'jarvis.* events must never reach the upstream model').toHaveLength(0);
  });
});

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}

async function waitForServerEvent(ws: ClientWS, expectedType: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`timeout waiting for ${expectedType}`)); }, timeoutMs);
    ws.on('message', (raw: RawData) => {
      const text = rawToString(raw);
      let evt: { type?: unknown };
      try { evt = JSON.parse(text) as { type?: unknown }; } catch { return; }
      if (typeof evt.type === 'string' && evt.type === expectedType) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
