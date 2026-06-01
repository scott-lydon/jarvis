// BUG-DIAG-2026-06-01 — coverage for the debug mic-test endpoint.
//
// Boots the handleTranscribeTest handler against a stubbed fetch that
// stands in for OpenAI's HTTP Whisper endpoint and asserts every
// failure path returns a SPECIFIC, actionable JSON error so the
// mic-test modal can render it. The handler is the only thing standing
// between a debug-only popup and a remote 25 MB DoS surface; the
// guards must be sturdy.
//
// Delete this file in one pass when the diagnostic modal is removed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleTranscribeTest } from '../../src/transcribe.js';

interface BootedServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function bootHandler(openaiApiKey: string): Promise<BootedServer> {
  const server: Server = createServer((req, res) => {
    void handleTranscribeTest(req, res, { openaiApiKey }).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unhandled', message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/api/transcribe-test`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

/** Build a minimal but valid WAV header + N samples of silence. */
function buildSilentWav(sampleCount = 1200, sampleRate = 24_000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const dataSize = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * 2, 28);
  buf.writeUInt16LE(numChannels * 2, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('handleTranscribeTest (BUG-DIAG-2026-06-01)', () => {
  let booted: BootedServer;
  const fetchSpy = vi.fn();
  const realFetch = global.fetch;

  beforeEach(async () => {
    fetchSpy.mockReset();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    booted = await bootHandler('test-key');
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await booted.close();
  });

  it('rejects non-POST methods with 405 + actionable JSON', async () => {
    const res = await realFetch(booted.url, { method: 'GET' });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('rejects wrong Content-Type with 415 + actionable JSON', async () => {
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hi: 'there' }),
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.code).toBe('unsupported_content_type');
    expect(body.error.message).toContain('audio/wav');
  });

  it('rejects empty body with 400', async () => {
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('empty_body');
  });

  it('rejects non-WAV body with 400 + named diagnostic', async () => {
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('not_a_wav');
    // The body must name the byte sequence we got so the modal can
    // tell the user EXACTLY why the WAV header check failed.
    expect(body.error.message).toContain('RIFF');
  });

  it('forwards a valid WAV to OpenAI and returns the transcript', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ text: 'hey how are you' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const wav = buildSilentWav();
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('hey how are you');
    // Confirm the upstream call carried the right Authorization header
    // and hit the right URL.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    const init = call?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(init.method).toBe('POST');
  });

  it('surfaces an OpenAI 4xx with the upstream body intact', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 'invalid_api_key', message: 'key invalid' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    const wav = buildSilentWav();
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.upstreamBody.error.code).toBe('invalid_api_key');
  });

  it('handles upstream network errors with 502 + named diagnostic', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const wav = buildSilentWav();
    const res = await realFetch(booted.url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_network_error');
    expect(body.error.message).toContain('ECONNREFUSED');
  });
});
