// transcribe.ts — debug-only HTTP endpoint that runs a single WAV file
// through OpenAI's HTTP Whisper transcription endpoint.
//
// BUG-DIAG-2026-06-01: this entire file exists to isolate "is the mic
// pipeline working?" from "is the Realtime API's Whisper transcribing
// our audio correctly?" The user reported that the Realtime path was
// returning fabricated transcripts ("It's embarrassing but I don't
// think anybody like this. Oh, Gillingham thinks he's a king…") —
// likely Whisper hallucinations on near-silent or malformed audio. By
// running the same captured PCM through the HTTP Whisper endpoint and
// surfacing the result in the mic-test modal, the user (and we) can
// see directly whether:
//
//   - The mic is capturing audio at all (playback in the modal sounds
//     like their voice).
//   - The audio is intelligible after the worklet's downsample +
//     Int16 PCM serialization (HTTP Whisper returns a sensible
//     transcript of what they said).
//   - The Realtime-specific path is the broken one (HTTP Whisper
//     transcribes correctly but the Realtime session does not).
//
// Once the audio pipeline is verified, this file + its route + the
// modal that calls it should be deleted in one pass. Grep for
// `BUG-DIAG-2026-06-01` to find every site.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { log } from './logger.js';

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — OpenAI's documented limit for whisper-1.

interface TranscribeOptions {
  readonly openaiApiKey: string;
}

/**
 * Handle a POST /api/transcribe-test request. The client POSTs a single
 * `audio/wav` body (raw bytes, no multipart wrapper); this handler
 * wraps it in a FormData and forwards to OpenAI's HTTP transcription
 * endpoint with `model: whisper-1` (the same Whisper revision the
 * Realtime API uses), then returns the JSON transcript verbatim.
 *
 * Every failure path returns a JSON error with `error.code` and
 * `error.message` so the modal can render a precise diagnosis instead
 * of "something broke."
 *
 * @param req incoming HTTP request — must be POST with audio/wav body
 * @param res HTTP response — answered as application/json
 * @param opts { openaiApiKey } resolved from the env at startup
 */
export async function handleTranscribeTest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TranscribeOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      error: { code: 'method_not_allowed', message: 'POST only.' },
    });
    return;
  }
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('audio/wav') && !contentType.startsWith('audio/x-wav')) {
    sendJson(res, 415, {
      error: {
        code: 'unsupported_content_type',
        message: `Expected Content-Type: audio/wav, got "${contentType}".`,
      },
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBodyWithLimit(req, MAX_BODY_BYTES);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn({ event: 'transcribe.body_read_failed', message });
    sendJson(res, 413, {
      error: { code: 'body_read_failed', message },
    });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, {
      error: { code: 'empty_body', message: 'Request body had zero bytes — no audio to transcribe.' },
    });
    return;
  }
  // Minimal sanity check: a real WAV starts with "RIFF" + size + "WAVE".
  // If the client sent garbage, surface that here instead of letting
  // OpenAI return a generic 400.
  if (body.length < 12
      || body.toString('ascii', 0, 4) !== 'RIFF'
      || body.toString('ascii', 8, 12) !== 'WAVE') {
    sendJson(res, 400, {
      error: {
        code: 'not_a_wav',
        message: `Body did not begin with RIFF/WAVE header (got bytes ${[...body.subarray(0, 4)].map((b) => b.toString(16)).join(' ')} / ${[...body.subarray(8, 12)].map((b) => b.toString(16)).join(' ')}). The mic test build must produce a real WAV file.`,
      },
    });
    return;
  }

  // Build a multipart FormData with the audio + model fields and POST
  // it to OpenAI. Node 18+ has global FormData and fetch.
  const form = new FormData();
  // Wrap the body in a Blob so FormData treats it as a file upload.
  const blob = new Blob([body], { type: 'audio/wav' });
  form.append('file', blob, 'mic-test.wav');
  form.append('model', 'whisper-1');
  // The Realtime API session is configured with language: 'en' (see
  // src/proxy.ts), so pin the same here for an apples-to-apples test.
  form.append('language', 'en');

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.openaiApiKey}`,
      },
      body: form,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.error({ event: 'transcribe.upstream_network_error', message });
    sendJson(res, 502, {
      error: {
        code: 'upstream_network_error',
        message: `Could not reach OpenAI's transcription endpoint: ${message}`,
      },
    });
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // Surface OpenAI's error body so the modal can show the real reason
    // (e.g. invalid API key, model deprecated, audio too short).
    log.warn({
      event: 'transcribe.upstream_non_2xx',
      status: upstream.status,
      bodySample: text.slice(0, 400),
    });
    sendJson(res, upstream.status, {
      error: {
        code: 'upstream_error',
        message: `OpenAI transcription returned HTTP ${upstream.status}.`,
        upstreamBody: safeJsonOrText(text),
      },
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.error({
      event: 'transcribe.upstream_non_json',
      message,
      bodySample: text.slice(0, 200),
    });
    sendJson(res, 502, {
      error: {
        code: 'upstream_non_json',
        message: `OpenAI returned non-JSON: ${message}`,
        sample: text.slice(0, 200),
      },
    });
    return;
  }

  // The OpenAI response shape is { text: "transcribed text" }.
  log.info({
    event: 'transcribe.ok',
    bytes: body.length,
    transcriptLen: (parsed as { text?: string }).text?.length ?? 0,
  });
  sendJson(res, 200, parsed);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function safeJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 400);
  }
}

/**
 * Read the entire request body into a Buffer, rejecting if it exceeds
 * `limitBytes`. The limit guard is essential: an unbounded read would
 * be a trivial DoS surface on a public endpoint.
 */
function readBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) {
        reject(new Error(`Request body exceeded ${limitBytes} bytes (Whisper limit).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { reject(err); });
  });
}
