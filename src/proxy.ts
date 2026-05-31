// OpenAI Realtime Proxy Layer (plan.md §2.1).
//
// For each downstream client WebSocket, opens ONE upstream WebSocket to
// `wss://api.openai.com/v1/realtime?model=<MODEL>` and shuttles events
// in both directions.
//
// Rules baked in here:
//   - GA endpoint only: the URL carries `model=gpt-realtime` and no
//     `OpenAI-Beta` header is sent (lesson Y / constitution §1).
//   - Client→upstream messages are coerced to UTF-8 strings; binary
//     Buffer forwards trip GA's input parser (lesson F6).
//   - The server-side fully-nested `session.update` is built here, with
//     `audio.input.format = {type:"pcm16", rate:24000}` and the same on
//     `audio.output.format` (lesson Y2).
//   - Upstream `response.output_audio.delta` is renamed to the client
//     as `response.audio.delta` so the web/iOS clients can use the
//     stable name (lesson Y).
//   - Project-namespaced events whose `type` starts with `jarvis.` are
//     NOT forwarded upstream (lesson Y1); they are used for in-process
//     signaling (telemetry, force-state, etc.) only.
//   - Function calls from the model run through the Tool Dispatcher and
//     the resulting `conversation.item.create` + `response.create` are
//     posted back upstream. Tool errors are surfaced as JSON results so
//     the model can speak them honestly (zero-hallucination — US-06).
//   - Slow tools (with `slowFiller`) cause an immediate spoken filler
//     before the upstream tool result is appended (US-02).

import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket as UpstreamWS, type RawData } from 'ws';
import type { WebSocket as ClientWS } from 'ws';

import type { JarvisEnv } from './env.js';
import { log } from './logger.js';
import { buildSystemPrompt, type PersistedUserContext } from './session.js';
import type { ToolDispatcher } from './tools/dispatcher.js';
import type { ToolContext } from './tools/types.js';

const REALTIME_ROOT = 'wss://api.openai.com/v1/realtime';

interface ProxyOptions {
  readonly env: JarvisEnv;
  readonly dispatcher: ToolDispatcher;
  readonly client: ClientWS;
  readonly userCtx: PersistedUserContext;
  readonly toolCtx: ToolContext;
  readonly onTurn?: (turn: { readonly role: 'user' | 'assistant' | 'tool'; readonly content: string }) => void;
}

interface IncomingFunctionCall {
  name: string;
  call_id: string;
  arguments: string;
  completed: boolean;
}

export function runProxy(opts: ProxyOptions): void {
  const { env, dispatcher, client, userCtx, toolCtx, onTurn } = opts;

  // Integration tests point at a local fake upstream via the env override;
  // production always uses the real OpenAI Realtime endpoint.
  const upstreamUrl = env.realtimeUrlOverride
    ?? `${REALTIME_ROOT}?model=${encodeURIComponent(env.realtimeModel)}`;
  // GA: Authorization only. NO `OpenAI-Beta` header — that triggers the
  // deprecated Beta shape and breaks everything subtly.
  const upstream = new UpstreamWS(upstreamUrl, {
    headers: {
      'Authorization': `Bearer ${env.openaiApiKey}`,
      // No 'OpenAI-Beta' here, intentionally. See lesson Y.
      'User-Agent': 'jarvis-proxy/0.1',
    },
  });

  // Function-call accumulator. The Realtime API streams arguments as
  // deltas; we coalesce them into one string before dispatching.
  const inflightCalls = new Map<string, IncomingFunctionCall>();

  // Cleanup helpers.
  let closed = false;
  function closeAll(reason: string, code = 1000): void {
    if (closed) return;
    closed = true;
    log.info({ event: 'proxy.close', reason, userId: userCtx.userId });
    try { client.close(code, reason); } catch { /* ignore */ }
    try { upstream.close(code, reason); } catch { /* ignore */ }
  }

  // ---- Upstream lifecycle ----
  upstream.on('open', () => {
    log.info({ event: 'proxy.upstream_open', userId: userCtx.userId });
    const systemPrompt = buildSystemPrompt({ env, dispatcher, user: userCtx });
    const tools = dispatcher.openaiToolsSpec(env);
    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        // Lesson F5: the explicit English directive lives in the system prompt
        // because GA Realtime ignores `language: "en"` field hints in
        // borderline audio. Belt-and-suspenders: instructions string ALSO has
        // the line.
        instructions: systemPrompt,
        audio: {
          // Lesson Y2: the FULLY NESTED shape. Flat audio_input/audio_output
          // shapes silently fail and lead to garbage audio.
          input: {
            format: { type: 'pcm16', rate: 24000 },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.55,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
            },
            transcription: { model: 'whisper-1' },
          },
          output: {
            format: { type: 'pcm16', rate: 24000 },
            voice: env.realtimeVoice,
          },
        },
        tools,
        tool_choice: 'auto',
      },
    };
    upstream.send(JSON.stringify(sessionUpdate));
    // Tell the downstream client the session is live; the client uses
    // this to flip its status from "connecting" to "listening".
    safeClientSend({ type: 'jarvis.session_ready', userId: userCtx.userId });
  });

  upstream.on('message', (raw: RawData) => {
    const text = rawToString(raw);
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(text) as Record<string, unknown>;
    } catch {
      log.warn({ event: 'proxy.upstream_non_json', sample: text.slice(0, 120) });
      return;
    }
    const type = typeof evt['type'] === 'string' ? evt['type'] : '';
    handleUpstreamEvent(type, evt);
  });

  upstream.on('close', (code: number, reasonBuf: Buffer) => {
    const reason = reasonBuf.toString('utf8');
    log.warn({ event: 'proxy.upstream_close', code, reason, userId: userCtx.userId });
    safeClientSend({ type: 'jarvis.upstream_closed', code, reason });
    closeAll('upstream_closed');
  });

  upstream.on('error', (err: Error) => {
    log.error({ event: 'proxy.upstream_error', message: err.message, userId: userCtx.userId });
    safeClientSend({ type: 'jarvis.error', error: 'upstream_error', message: err.message });
  });

  // ---- Downstream lifecycle ----
  client.on('message', (raw: RawData) => {
    // F6: GA Realtime rejects binary; coerce to UTF-8 string.
    const text = rawToString(raw);
    // Y1: never forward jarvis.* events upstream — these are local signals.
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const t = typeof parsed['type'] === 'string' ? parsed['type'] : '';
      if (t.startsWith('jarvis.')) {
        handleClientLocalEvent(t, parsed);
        return;
      }
    } catch {
      // Non-JSON message — refuse to forward; GA Realtime rejects junk.
      log.warn({ event: 'proxy.client_non_json', sample: text.slice(0, 80) });
      return;
    }
    if (upstream.readyState !== UpstreamWS.OPEN) {
      log.warn({ event: 'proxy.upstream_not_ready', userId: userCtx.userId });
      return;
    }
    upstream.send(text);
  });

  client.on('close', (code: number, reasonBuf: Buffer) => {
    log.info({ event: 'proxy.client_close', code, reason: reasonBuf.toString('utf8'), userId: userCtx.userId });
    closeAll('client_closed');
  });

  client.on('error', (err: Error) => {
    log.error({ event: 'proxy.client_error', message: err.message, userId: userCtx.userId });
    closeAll('client_error', 1011);
  });

  // ---- Helpers ----
  function safeClientSend(evt: Record<string, unknown>): void {
    if (closed) return;
    try { client.send(JSON.stringify(evt)); } catch (err) {
      log.error({ event: 'proxy.client_send_failed', message: (err as Error).message });
    }
  }

  function safeUpstreamSend(evt: Record<string, unknown>): void {
    if (closed) return;
    if (upstream.readyState !== UpstreamWS.OPEN) return;
    try { upstream.send(JSON.stringify(evt)); } catch (err) {
      log.error({ event: 'proxy.upstream_send_failed', message: (err as Error).message });
    }
  }

  function handleClientLocalEvent(type: string, evt: Record<string, unknown>): void {
    if (type === 'jarvis.barge_in') {
      // US-04 server side: emit response.cancel upstream within 300ms.
      // The dispatcher hasn't pre-flighted any tool call here; this is
      // pure model-cancel.
      log.info({ event: 'proxy.barge_in', userId: userCtx.userId });
      safeUpstreamSend({ type: 'response.cancel' });
      return;
    }
    if (type === 'jarvis.ping') {
      safeClientSend({ type: 'jarvis.pong', ts: new Date().toISOString() });
      return;
    }
    log.debug({ event: 'proxy.unknown_local_event', type, fields: Object.keys(evt) });
  }

  function handleUpstreamEvent(type: string, evt: Record<string, unknown>): void {
    // Y: rename the GA audio delta event to the older name our clients use.
    if (type === 'response.output_audio.delta') {
      safeClientSend({ ...evt, type: 'response.audio.delta' });
      return;
    }
    if (type === 'response.output_audio.done') {
      safeClientSend({ ...evt, type: 'response.audio.done' });
      return;
    }
    if (type === 'response.output_audio_transcript.delta') {
      safeClientSend({ ...evt, type: 'response.audio_transcript.delta' });
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const transcript = readString(evt, 'transcript');
      onTurn?.({ role: 'assistant', content: transcript });
      safeClientSend({ ...evt, type: 'response.audio_transcript.done' });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = readString(evt, 'transcript');
      if (transcript.length > 0) onTurn?.({ role: 'user', content: transcript });
      safeClientSend(evt);
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const callId = readString(evt, 'call_id');
      const name = readString(evt, 'name');
      const argsDelta = readString(evt, 'delta');
      const existing = inflightCalls.get(callId);
      if (existing === undefined) {
        inflightCalls.set(callId, { name, call_id: callId, arguments: argsDelta, completed: false });
      } else {
        existing.arguments += argsDelta;
        if (name.length > 0) existing.name = name;
      }
      // Don't forward the partial deltas downstream; they're internal.
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const callId = readString(evt, 'call_id');
      const name = readString(evt, 'name');
      const argsStr = readString(evt, 'arguments');
      const merged = inflightCalls.get(callId) ?? { name, call_id: callId, arguments: '', completed: false };
      merged.completed = true;
      if (argsStr.length > 0) merged.arguments = argsStr;
      if (name.length > 0) merged.name = name;
      inflightCalls.set(callId, merged);
      // Fire-and-forget; we don't want to block the upstream event loop.
      void handleFunctionCall(merged).catch((err: unknown) => {
        log.error({
          event: 'proxy.function_call_failed_unexpectedly',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    if (type === 'error') {
      log.error({ event: 'proxy.upstream_emitted_error', payload: evt });
      safeClientSend(evt);
      return;
    }
    // Default: forward as-is.
    safeClientSend(evt);
  }

  async function handleFunctionCall(call: IncomingFunctionCall): Promise<void> {
    const def = dispatcher.get(call.name);
    let parsedArgs: unknown = {};
    try {
      parsedArgs = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
    } catch (cause) {
      log.warn({
        event: 'proxy.function_call_args_unparseable',
        tool: call.name,
        message: cause instanceof Error ? cause.message : String(cause),
        sample: call.arguments.slice(0, 200),
      });
      parsedArgs = {};
    }

    // US-02: filler audio cue if the tool is slow-tagged. Emit it BEFORE
    // the result is appended so the agent's spoken filler reaches the
    // user immediately.
    const filler = def?.slowFiller;
    if (filler !== undefined && filler.length > 0) {
      safeClientSend({ type: 'jarvis.filler', text: filler, tool: call.name });
      safeUpstreamSend({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: filler }],
        },
      });
      // Tiny pacing pause so the filler is acknowledged before result.
      await delay(50);
    }

    const result = await dispatcher.dispatch(call.name, parsedArgs, toolCtx);
    safeClientSend({
      type: 'jarvis.tool_result',
      tool: call.name,
      ok: result.ok,
      durationMs: result.durationMs,
      result: result.value,
    });
    onTurn?.({ role: 'tool', content: JSON.stringify({ name: call.name, args: parsedArgs, result: result.value }) });

    safeUpstreamSend({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result.value),
      },
    });
    safeUpstreamSend({ type: 'response.create' });

    inflightCalls.delete(call.call_id);
  }
}

function readString(evt: Record<string, unknown>, key: string): string {
  const v = evt[key];
  return typeof v === 'string' ? v : '';
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}
