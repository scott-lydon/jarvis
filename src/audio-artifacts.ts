// audio-artifacts.ts — Single Point of Truth for two runtime audio-input
// concerns that previously had multiple, inconsistent representations:
//
//   1. WHISPER_ARTIFACTS — short canned phrases that the whisper-1 model
//      emits on near-silent audio (its YouTube-corpus training falls
//      back to "Thanks for watching" / "See you next time" / etc. when
//      it can't transcribe). When we see one of these, the audio was
//      effectively silence — the user did NOT speak.
//
//   2. STOP_COMMANDS — short verbal "be quiet" commands (e.g. "quiet",
//      "stop talking", "shut up", "hold on") the user uses to cut Jarvis
//      off WITHOUT initiating a new conversational turn. These get the
//      barge-in treatment (cancel the in-flight response, halt playback)
//      but the model must NOT generate a follow-up reply afterwards.
//
// SPOT rule: this file is the only place these lists are defined. The
// proxy uses them at runtime to suppress / cancel; the system prompt
// renders them into IGNORE directives at session boot. The shape is
// 100% data — no module-level effects — so importing it from both Node
// and the browser is fine.
//
// Reason this matters (bug filed 2026-06-01 by the user): the prior
// implementation had the artifact list ONLY in the system prompt. When
// Whisper returned "I'll see you next time" the client rendered it as a
// USER turn bubble; the model, per the prompt, refused to act on it and
// produced "Hey there, I noticed it's a bit quiet" instead. Two sources
// of truth ("user said X" in the UI, "user said nothing" in the model's
// behavior) directly contradicted each other. Filtering at the proxy
// with one shared list keeps the UI and the model in sync.

// Bug-R fix (2026-06-02): normalize must strip ALL punctuation, not just
// trailing. Whisper frequently inserts commas / periods / quotes mid-
// transcript ("Quiet, please.", "Be quiet, Jarvis.") which the prior
// trailing-only regex left intact — so exact-match against the SILENCE
// list missed phrasings the user clearly meant as a stop command.
// Internal whitespace gets collapsed too so "be   quiet" matches "be
// quiet".
const NORMALIZE_PUNCT_ANYWHERE = /[.!?,;:'"`-]+/g;
const NORMALIZE_WHITESPACE = /\s+/g;

/** Whisper YouTube-corpus filler phrases — strong sign of near-silence. */
export const WHISPER_ARTIFACTS: readonly string[] = [
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "thank you so much for watching",
  "thanks for tuning in",
  "don't forget to like and subscribe",
  "subscribe to my channel",
  "if you enjoyed this video",
  "if you enjoyed this video, please like and subscribe",
  "see you in the next one",
  "see you in the next video",
  "see you next time",
  "i'll see you next time",
  "i'll see you in the next one",
  "see you next video",
  "like and subscribe",
];

/**
 * Short verbal "be quiet" commands. When the user utters one of these
 * while Jarvis is talking, the proxy still cancels the in-flight
 * response (so the audio actually stops), but it ALSO suppresses the
 * follow-up reply the model would have produced, by sending the
 * transcript into the conversation history as a no-reply turn and
 * cancelling any response.create that was queued.
 */
export const STOP_COMMANDS: readonly string[] = [
  "quiet",
  "quiet now",
  "be quiet",
  "shut up",
  "shush",
  "stop",
  "stop talking",
  "stop please",
  "wait",
  "hold on",
  "one second",
  "one moment",
  "hold up",
  "pause",
  "silence",
];

/**
 * Bug-O (2026-06-01) — silenced-mode entry phrases.
 *
 * Superset of STOP_COMMANDS that also includes turn-ending phrases the
 * user explicitly wants to put Jarvis into silenced mode. The user's
 * spec: "When a deterministic browser layer detects one of those
 * specific words, then Jarvis goes into silenced mode. Where it stops
 * making sound mid sentence (instantly), and then presents a text with
 * a different visual ui."
 *
 * In silenced mode the proxy:
 *   - Cancels any in-flight response (audio stops mid-sentence).
 *   - Sends session.update with turn_detection.create_response=false
 *     so the model does not auto-respond to subsequent VAD-detected
 *     speech (transcripts still flow so we can detect the resume
 *     phrase).
 *   - Emits jarvis.silenced so the client renders the yellow banner.
 *
 * Wider net than STOP_COMMANDS so the user doesn't have to think
 * about which phrasing they used; isStopCommand stays the narrower
 * filter used for "cancel this one response" without entering full
 * silenced mode.
 */
export const SILENCE_PHRASES: readonly string[] = [
  ...STOP_COMMANDS,
  "stop it",
  "stop now",
  "stop please now",
  "no more",
  "enough",
  "that's enough",
  "thats enough",
  "ok enough",
  "okay enough",
  "alright stop",
  "all right stop",
  "shut it",
  "be silent",
  "go silent",
  "silent now",
  "silent please",
  "not now",
  "hold that thought",
  "hold the phone",
  "give me a second",
  "give me a moment",
  "just a sec",
  "just a second",
  "just a moment",
];

/**
 * Bug-O (2026-06-01) — silenced-mode resume phrases.
 *
 * While Jarvis is silenced, only one of these phrases (deterministic
 * match) takes him back to active. Intentionally conservative — we do
 * NOT want a casual "okay" or "yes" to accidentally resume Jarvis when
 * the user was talking to someone else in the room.
 *
 * The banner copy MUST instruct the user with one of these exact
 * phrases (default: "speak") so they know how to resume.
 */
export const RESUME_PHRASES: readonly string[] = [
  "speak",
  "speak now",
  "speak up",
  "you can speak",
  "you may speak",
  "talk",
  "talk to me",
  "resume",
  "continue",
  "go ahead",
  "proceed",
  "unsilence",
  "unmute",
  "jarvis speak",
  "okay speak",
];

export function isSilencePhrase(transcript: string): boolean {
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  const norm = normalize(transcript);
  for (const s of SILENCE_PHRASES) {
    if (norm === normalize(s)) return true;
  }
  // Bug-R (2026-06-02): short-phrase heuristic as a deterministic
  // fallback BEFORE the LLM agentic check (which lives in src/proxy.ts).
  // This catches the common case Whisper-with-context phrasings ("quiet
  // please", "shush jarvis", "be silent", "enough now") without an API
  // round-trip.
  if (matchesShortPhraseHeuristic(norm)) return true;
  return false;
}

export function isResumePhrase(transcript: string): boolean {
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  const norm = normalize(transcript);
  for (const r of RESUME_PHRASES) {
    if (norm === normalize(r)) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text.trim().toLowerCase()
    .replace(NORMALIZE_PUNCT_ANYWHERE, '')
    .replace(NORMALIZE_WHITESPACE, ' ')
    .trim();
}

/**
 * Bug-R (2026-06-02) — short-phrase silence heuristic.
 *
 * If a transcript is 3 words or fewer AND contains one of these
 * unambiguous silence keywords as a whole word, treat it as a silence
 * command even if the exact phrasing wasn't enumerated in
 * SILENCE_PHRASES. Reasoning: at this length, the user is almost
 * certainly addressing Jarvis directly with an imperative — false
 * positives like "she was quiet" require more than 3 words to be
 * grammatically natural.
 *
 * "stop" and "shut" are intentionally NOT in this keyword set because
 * they appear too often in conversational uses ("stop the car",
 * "shut the door"). Both have their exact variants in SILENCE_PHRASES.
 */
const SHORT_PHRASE_SILENCE_KEYWORDS: ReadonlySet<string> = new Set([
  'quiet',
  'silence',
  'silent',
  'shush',
  'hush',
  'enough',
  'pause',
  'halt',
  'mute',
]);

function matchesShortPhraseHeuristic(norm: string): boolean {
  if (norm.length === 0) return false;
  const words = norm.split(' ').filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 3) return false;
  for (const w of words) {
    if (SHORT_PHRASE_SILENCE_KEYWORDS.has(w)) return true;
  }
  return false;
}

/**
 * Returns true if `transcript` matches a known Whisper YouTube-corpus
 * filler artifact (exact, case-insensitive, trailing-punctuation
 * insensitive). False otherwise.
 *
 * @param transcript the raw transcript Whisper produced
 * @returns whether the transcript should be treated as silence
 */
export function isWhisperArtifact(transcript: string): boolean {
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  const norm = normalize(transcript);
  for (const a of WHISPER_ARTIFACTS) {
    if (norm === normalize(a)) return true;
  }
  return false;
}

/**
 * Returns true if `transcript` matches a known "be quiet" stop command.
 * Exact, case-insensitive, trailing-punctuation insensitive. False
 * otherwise.
 *
 * @param transcript the raw transcript Whisper produced
 * @returns whether the user is telling Jarvis to be quiet (no follow-up
 *   response should be generated)
 */
export function isStopCommand(transcript: string): boolean {
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  const norm = normalize(transcript);
  for (const s of STOP_COMMANDS) {
    if (norm === normalize(s)) return true;
  }
  return false;
}

/**
 * Render the artifact list for inclusion in the system prompt. We
 * surface only the first ~6 entries (a representative sample) plus
 * "or similar" so the prompt stays token-efficient — the proxy already
 * filters comprehensively at runtime, the prompt is belt-and-suspenders.
 *
 * @returns a quoted, comma-separated list e.g. `"foo", "bar", "baz"` …
 */
export function formatArtifactListForPrompt(): string {
  const sample = WHISPER_ARTIFACTS.slice(0, 6);
  return sample.map((p) => `"${p}"`).join(', ');
}

/**
 * Render the stop-command list for inclusion in the system prompt.
 *
 * @returns a quoted, comma-separated list of the canonical stop commands
 */
export function formatStopCommandsForPrompt(): string {
  const sample = STOP_COMMANDS.slice(0, 8);
  return sample.map((p) => `"${p}"`).join(', ');
}
