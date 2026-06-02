// agentic-silence-check.ts — Bug-R (2026-06-02).
//
// Last-line LLM fallback for the silenced-mode detector. The
// deterministic SILENCE_PHRASES list + the short-phrase heuristic
// catch the bulk of "be quiet" phrasings, but the user explicitly
// asked for an agentic check on top: "make an agentic check for every
// incoming message to see if it is a form of saying quiet as a
// fallback (though slower it would catch the cases faster than not
// catching them if they weren't added to the list)."
//
// The check:
//   - Sends a one-shot Chat Completions request to gpt-4o-mini.
//   - Asks a single yes/no question framed to minimize false positives
//     (the model is told that the bar is "is this clearly an
//     imperative to be silent right now" — not "could this be
//     interpreted as wanting silence").
//   - Returns the boolean, plus the model's raw response for telemetry.
//
// Latency: ~200-500 ms wall clock against gpt-4o-mini in practice.
// Cost: ~$0.00015 per call. With the proxy only invoking this when
// the deterministic checks miss AND the transcript is short, the
// per-session cost is negligible.
//
// The function NEVER throws — it returns isSilence:false on any
// upstream failure so a network blip can't accidentally silence Jarvis.

import { log } from './logger.js';

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

interface AgenticCheckOptions {
  readonly openaiApiKey: string;
  /**
   * Optional override for the model. Default gpt-4o-mini — cheap and
   * fast, accuracy is more than sufficient for a binary yes/no.
   */
  readonly model?: string;
  /**
   * Optional timeout in ms. Default 1500 — anything slower defeats
   * the purpose of catching the silence fast.
   */
  readonly timeoutMs?: number;
}

export interface AgenticCheckResult {
  readonly isSilence: boolean;
  /** The raw model response for telemetry / DevSignalPanel. */
  readonly rawResponse: string;
  /** True if the call completed within the deadline. */
  readonly completed: boolean;
}

const SYSTEM_PROMPT
  = 'You are a binary classifier. The user is having a voice conversation with a '
  + 'voice assistant named Jarvis. You receive ONE transcript at a time. '
  + 'Decide: is this transcript an IMPERATIVE COMMAND telling Jarvis to be '
  + 'silent / quiet / stop talking right now?\n\n'
  + 'Respond with exactly one token: YES or NO.\n\n'
  + 'YES examples: "quiet", "be quiet", "shut up", "stop talking", "silence", '
  + '"hush", "enough", "stop please", "okay stop", "alright be quiet", '
  + '"jarvis quiet", "quiet please", "hold on", "wait", "one second".\n\n'
  + 'NO examples: "what is the weather", "tell me a joke", "she was quiet", '
  + '"stop the car", "I want to be quiet for a moment", "yes", "okay", '
  + '"continue", "go on", "speak", anything that is a question or a '
  + 'conversational reply.';

/**
 * Ask gpt-4o-mini whether the transcript is a silence command. Never
 * throws. On any failure (network, timeout, parse) returns
 * { isSilence: false, completed: false }.
 *
 * @param transcript the raw user transcript Whisper returned
 * @param opts.openaiApiKey resolved from env at startup
 * @returns result with the boolean and a telemetry-friendly raw response
 */
export async function agenticallyCheckSilence(
  transcript: string,
  opts: AgenticCheckOptions,
): Promise<AgenticCheckResult> {
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return { isSilence: false, rawResponse: '', completed: true };
  }
  const model = opts.model ?? 'gpt-4o-mini';
  const timeoutMs = opts.timeoutMs ?? 1500;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => { controller.abort(); }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        // Keep it cheap: max_tokens 1 is enough for "YES" or "NO".
        // We ask for max_tokens 4 in case the model insists on punctuation.
        max_tokens: 4,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Transcript: ${transcript}` },
        ],
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(timeoutHandle);
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn({
      event: 'agentic_silence.fetch_failed',
      message,
      transcript: transcript.slice(0, 80),
    });
    return { isSilence: false, rawResponse: `error: ${message}`, completed: false };
  }
  clearTimeout(timeoutHandle);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.warn({
      event: 'agentic_silence.non_2xx',
      status: response.status,
      bodySample: body.slice(0, 200),
    });
    return { isSilence: false, rawResponse: `http ${response.status}`, completed: false };
  }

  let parsed: unknown;
  try { parsed = await response.json(); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn({ event: 'agentic_silence.parse_failed', message });
    return { isSilence: false, rawResponse: `parse error: ${message}`, completed: false };
  }

  // OpenAI Chat Completions response shape:
  // { choices: [{ message: { content: "YES" } }] }
  const content = readChoiceContent(parsed);
  const normalized = content.trim().toLowerCase().replace(/[.!?,;:]+$/g, '');
  const isSilence = normalized === 'yes';
  log.info({
    event: 'agentic_silence.result',
    transcript: transcript.slice(0, 80),
    rawResponse: content,
    isSilence,
  });
  return { isSilence, rawResponse: content, completed: true };
}

function readChoiceContent(parsed: unknown): string {
  if (parsed === null || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (first === null || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}
