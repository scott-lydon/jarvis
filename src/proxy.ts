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

import { agenticallyCheckSilence } from './agentic-silence-check.js';
import { isResumePhrase, isSilencePhrase, isStopCommand, isWhisperArtifact } from './audio-artifacts.js';
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

  // Bug-O (2026-06-01) — silenced-mode state. When the user utters a
  // silence phrase the proxy:
  //   1. Cancels any in-flight response.
  //   2. Sends session.update with turn_detection.create_response=false
  //      so subsequent VAD turns do NOT trigger automatic responses.
  //   3. Emits jarvis.silenced to the client so the yellow banner
  //      renders and the playback context is torn down.
  // Transcripts STILL flow while silenced so the proxy can detect a
  // resume phrase ("speak", "continue", etc.) and flip back.
  let silenced = false;

  // Bug-O (2026-06-01) — track the in-flight response_id so we can
  // target response.cancel precisely. Without it, OpenAI returns the
  // 'Cancellation failed: no active response found' error when the
  // response had already finished — a benign race we surfaced as a
  // user-visible upstream error before this commit.
  let currentResponseId: string | null = null;

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
          // Lesson Y2: FULLY NESTED `audio.input.format` shape. Flat
          // `audio_input` shapes silently fail and lead to garbage audio.
          //
          // Lesson Y3 (2026-05-31, found via live deploy probe at
          // https://jarvis-biyx.onrender.com): the GA enum for `format.type`
          // is `audio/pcm | audio/pcmu | audio/pcma`. An older spec drop
          // used `pcm16` and OpenAI ACCEPTED it for a window, then started
          // rejecting it with:
          //     invalid_request_error / invalid_value /
          //     "Invalid value: 'pcm16'. Supported values are:
          //      'audio/pcm', 'audio/pcmu', and 'audio/pcma'."
          //     param: session.audio.input.format.type
          // We send `audio/pcm` here. The wire encoding is unchanged
          // (PCM16 little-endian @ 24 kHz mono); only the type label moved.
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            // Bug-P (2026-06-01) tightening on top of Bug-C tuning. The
            // user reported phantom Jarvis responses where the proxy
            // produced a turn without a corresponding user-turn bubble —
            // i.e. VAD was triggering on background room noise / TV / a
            // dog / etc. Tuned:
            //   - threshold 0.75 (was 0.6): only loud + structured
            //     audio counts as speech. Ambient noise stays under.
            //   - silence_duration_ms 1500 (was 1200): more conservative
            //     phrase boundary; reduces chopping the user mid-thought.
            //   - prefix_padding_ms 600 (was 500): a bit more lead-in so
            //     the first syllable isn't clipped.
            turn_detection: {
              type: 'server_vad',
              threshold: 0.75,
              prefix_padding_ms: 600,
              silence_duration_ms: 1500,
              create_response: true,
            },
            // Lesson Y4 (2026-06-01): switch from `whisper-1` to
            // `gpt-realtime-whisper`. whisper-1 is the LEGACY model
            // ("existing Whisper integrations… not natively streaming")
            // — per OpenAI's Realtime transcription docs it's
            // retiring around June 2026 anyway. The streaming-chunk
            // hallucinations the user kept hitting ("I'll see you
            // next time", "Gillingham thinks he's a king…") are the
            // exact failure mode whisper-1 has when OpenAI's server
            // VAD feeds it short turn-boundary clips without
            // streaming context: it falls back to its training-
            // corpus priors, which are YouTube-heavy. The newer
            // gpt-realtime-whisper was built specifically for live
            // streaming sessions like this one and is the documented
            // recommendation for low-latency realtime transcription.
            //
            // Source: developers.openai.com/api/docs/guides/realtime-transcription
            //
            // language=en stays so the model doesn't try to match
            // non-English phonemes. The Realtime endpoint does NOT
            // accept a transcription `prompt` field for steering
            // (only the HTTP /v1/audio/transcriptions endpoint does;
            // see src/transcribe.ts where we use it on the diagnostic
            // path). Vocabulary biasing in the realtime path stays
            // on the system-prompt side (CONVERSATION_LINE).
            transcription: { model: 'gpt-realtime-whisper', language: 'en' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: env.realtimeVoice,
          },
        },
        tools,
        tool_choice: 'auto',
      },
    };
    // Lesson Y5 retracted (2026-06-01): the `include` field belongs
    // inside `session` per the docs' transcription-session example,
    // NOT at the top level of session.update — and even when placed
    // correctly it appears unsupported on the realtime voice-agent
    // session type, where OpenAI returns
    //   "Unknown parameter: 'include'."
    // and REJECTS the entire session.update — which cascades: no
    // system prompt applied, no transcription model selected, no
    // VAD config, no user-turn events flowing back. We are not
    // consuming logprobs yet anyway; dropped until OpenAI documents
    // the field for realtime voice agents.
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
      // Bug-O (2026-06-01): scope the cancel to the in-flight
      // response_id when we have one. OpenAI returns a benign error if
      // there is nothing to cancel; the upstream error handler drops
      // it (Bug-Q) but it's better to not emit the cancel at all when
      // we know there's no work to halt.
      if (currentResponseId !== null) {
        safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
      } else {
        safeUpstreamSend({ type: 'response.cancel' });
      }
      return;
    }
    if (type === 'jarvis.silenced') {
      // Bug-S (2026-06-02) — the BROWSER detected silence. The client
      // already torn down playback and flipped isSilenced=true locally
      // (so even in-transit audio.delta is dropped on the floor); our
      // job here is to (a) cancel any in-flight upstream response so
      // we stop burning tokens, and (b) flip the session's
      // create_response to false so OpenAI's server VAD does not auto-
      // generate a new response for the silence-command turn itself.
      log.info({
        event: 'proxy.client_silenced',
        transcript: typeof evt['transcript'] === 'string' ? evt['transcript'] : '',
        userId: userCtx.userId,
      });
      silenced = true;
      if (currentResponseId !== null) {
        safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
      }
      safeUpstreamSend({
        type: 'session.update',
        session: {
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.75,
                prefix_padding_ms: 600,
                silence_duration_ms: 1500,
                create_response: false,
              },
            },
          },
        },
      });
      return;
    }
    if (type === 'jarvis.unsilenced') {
      // Bug-S (2026-06-02) — browser detected the resume phrase. Flip
      // create_response back to true so subsequent VAD turns trigger
      // normal responses again.
      log.info({
        event: 'proxy.client_unsilenced',
        transcript: typeof evt['transcript'] === 'string' ? evt['transcript'] : '',
        userId: userCtx.userId,
      });
      silenced = false;
      safeUpstreamSend({
        type: 'session.update',
        session: {
          audio: {
            input: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.75,
                prefix_padding_ms: 600,
                silence_duration_ms: 1500,
                create_response: true,
              },
            },
          },
        },
      });
      return;
    }
    if (type === 'jarvis.ping') {
      safeClientSend({ type: 'jarvis.pong', ts: new Date().toISOString() });
      return;
    }
    log.debug({ event: 'proxy.unknown_local_event', type, fields: Object.keys(evt) });
  }

  function handleUpstreamEvent(type: string, evt: Record<string, unknown>): void {
    // Bug-O (2026-06-01): track the in-flight response_id so the
    // silence / barge-in paths can target response.cancel precisely.
    // OpenAI returns 'no active response found' as an upstream error
    // when we cancel a response that has already finished — purely a
    // race condition, surfaced to the user as a red banner before.
    // Tracking the id lets us decide whether sending response.cancel
    // is worthwhile in the first place.
    if (type === 'response.created') {
      const response = evt['response'];
      if (response !== null && typeof response === 'object') {
        const id = (response as { id?: unknown }).id;
        if (typeof id === 'string') currentResponseId = id;
      }
    }
    if (type === 'response.done') {
      currentResponseId = null;
    }
    // Y: rename the GA audio delta event to the older name our clients use.
    if (type === 'response.output_audio.delta') {
      // Bug-O: while silenced, suppress every audio.delta forwarded to
      // the client even if OpenAI's response.cancel arrived AFTER the
      // server had already started streaming. Belt for the race.
      if (silenced) return;
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

      // Bug-O (2026-06-01) — RESUME path. If we are currently silenced
      // and the transcript matches a resume phrase, exit silenced mode
      // BEFORE anything else: re-enable create_response on the session,
      // forward the user-turn bubble, emit jarvis.unsilenced.
      if (silenced && isResumePhrase(transcript)) {
        log.info({ event: 'proxy.resume_phrase', transcript, userId: userCtx.userId });
        silenced = false;
        safeUpstreamSend({
          type: 'session.update',
          session: {
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.75,
                  prefix_padding_ms: 600,
                  silence_duration_ms: 1500,
                  create_response: true,
                },
              },
            },
          },
        });
        onTurn?.({ role: 'user', content: transcript });
        safeClientSend(evt);
        safeClientSend({ type: 'jarvis.unsilenced', transcript });
        return;
      }

      // Bug-O (2026-06-01) — SILENCE-ENTRY path. The user said any of
      // SILENCE_PHRASES ("quiet", "silence", "shut up", "enough", …).
      //   1. Forward the user-turn bubble (the user did speak; UI
      //      should show what was heard).
      //   2. If a response is currently in flight, send response.cancel
      //      targeting its id so OpenAI doesn't error with 'no active
      //      response found' when we're racing.
      //   3. Send session.update flipping create_response=false so the
      //      model doesn't auto-reply to subsequent VAD turns until
      //      we exit silenced mode.
      //   4. Emit jarvis.silenced so the client tears down playback
      //      and renders the yellow banner.
      if (isSilencePhrase(transcript)) {
        log.info({ event: 'proxy.silence_entry', transcript, userId: userCtx.userId });
        silenced = true;
        onTurn?.({ role: 'user', content: transcript });
        safeClientSend(evt);
        if (currentResponseId !== null) {
          safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
        }
        safeUpstreamSend({
          type: 'session.update',
          session: {
            audio: {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.75,
                  prefix_padding_ms: 600,
                  silence_duration_ms: 1500,
                  create_response: false,
                },
              },
            },
          },
        });
        safeClientSend({ type: 'jarvis.silenced', transcript });
        return;
      }

      // Bug-I SPOT enforcement (2026-06-01): Whisper YouTube-corpus
      // artifacts. Suppress the fake user bubble + cancel the auto-
      // triggered reply + emit jarvis.input_discarded for transparency.
      if (isWhisperArtifact(transcript)) {
        log.info({
          event: 'proxy.transcript_discarded_whisper_artifact',
          transcript,
          userId: userCtx.userId,
        });
        if (currentResponseId !== null) {
          safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
        }
        safeClientSend({
          type: 'jarvis.input_discarded',
          reason: 'whisper_artifact',
          transcript,
        });
        return;
      }

      // Bug-J (2026-06-01): stop commands (narrower than silence). The
      // user said something like "quiet now" / "stop talking" — cancel
      // this one response, but don't enter the full silenced mode.
      // (The phrase set overlaps with SILENCE_PHRASES so today this
      // branch is unreachable; kept for the narrow-stop semantics in
      // case we split the two lists later.)
      if (isStopCommand(transcript)) {
        log.info({
          event: 'proxy.stop_command_acknowledged',
          transcript,
          userId: userCtx.userId,
        });
        onTurn?.({ role: 'user', content: transcript });
        safeClientSend(evt);
        if (currentResponseId !== null) {
          safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
        }
        safeClientSend({
          type: 'jarvis.input_discarded',
          reason: 'stop_command',
          transcript,
        });
        return;
      }

      if (transcript.length > 0) onTurn?.({ role: 'user', content: transcript });
      safeClientSend(evt);

      // Bug-R (2026-06-02) — AGENTIC FALLBACK. User explicitly asked:
      //   "make an agentic check for every incoming message to see if
      //   it is a form of saying quiet as a fallback (though slower it
      //   would catch the cases faster than not catching them if they
      //   weren't added to the list)."
      // Deterministic checks above (isSilencePhrase with its short-phrase
      // heuristic) catch the bulk of phrasings — the agentic check is
      // the last-line net for anything we didn't enumerate.
      //
      // Fire-and-forget: the user-turn event was already forwarded
      // above (synchronous), so the bubble appears immediately. The
      // gpt-4o-mini call resolves in ~200-500 ms; if it says YES we
      // cancel the in-flight response and enter silenced mode, which
      // tears down the playback context client-side. The user hears
      // the first ~300 ms of Jarvis's response then it cuts off and
      // the yellow banner appears — much better than the response
      // playing in full.
      //
      // Gate: only invoke for short utterances (≤ 10 words) where a
      // silence command is plausible. Longer transcripts are
      // conversational and never silence commands; not worth the call.
      const wordCount = transcript.split(/\s+/).filter((w) => w.length > 0).length;
      if (!silenced && wordCount > 0 && wordCount <= 10) {
        void (async () => {
          const result = await agenticallyCheckSilence(transcript, {
            openaiApiKey: env.openaiApiKey,
          });
          if (!result.isSilence || silenced) return;
          log.info({
            event: 'proxy.agentic_silence_triggered',
            transcript,
            rawModelResponse: result.rawResponse,
            userId: userCtx.userId,
          });
          silenced = true;
          if (currentResponseId !== null) {
            safeUpstreamSend({ type: 'response.cancel', response_id: currentResponseId });
          }
          safeUpstreamSend({
            type: 'session.update',
            session: {
              audio: {
                input: {
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.75,
                    prefix_padding_ms: 600,
                    silence_duration_ms: 1500,
                    create_response: false,
                  },
                },
              },
            },
          });
          safeClientSend({ type: 'jarvis.silenced', transcript });
        })().catch((err: unknown) => {
          log.warn({
            event: 'proxy.agentic_silence_unexpected',
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
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
      // Bug-Q (2026-06-01) — suppress benign "Cancellation failed: no
      // active response found" upstream errors. We send response.cancel
      // for any silence / barge-in / artifact event, but the response
      // may have already finished by the time the cancel arrives. The
      // race is HARMLESS — the response is over either way — but it
      // surfaced as a red error banner that misled the user. Log it
      // at info level for telemetry and drop the forward.
      const errorObj = evt['error'];
      const errorMessage = errorObj !== null && typeof errorObj === 'object'
        ? String((errorObj as { message?: unknown }).message ?? '')
        : '';
      if (errorMessage.toLowerCase().includes('no active response found')
          || errorMessage.toLowerCase().includes('cancellation failed')) {
        log.info({
          event: 'proxy.upstream_cancel_raced',
          message: errorMessage,
          userId: userCtx.userId,
        });
        return;
      }
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
