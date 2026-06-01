// Session Manager (plan.md §2.2).
//
// Builds the system prompt the OpenAI Realtime session is configured
// with, owns the per-connection user context, and exposes the live
// capability list to the proxy so US-05 ("what can you do?") is grounded
// in the actual Tool Dispatcher registry instead of a hardcoded string.

import { randomUUID } from 'node:crypto';

import type { JarvisEnv } from './env.js';
import type { CapabilityEntry, ToolDispatcher } from './tools/dispatcher.js';

export interface PersistedUserContext {
  readonly userId: string;
  readonly memorySummary: string | null;
  readonly recentTurns: readonly { readonly role: string; readonly content: string; readonly ts: string }[];
  readonly preferences: ReadonlyMap<string, string>;
  readonly memoryAvailable: boolean;
}

export interface SessionInputs {
  readonly env: JarvisEnv;
  readonly dispatcher: ToolDispatcher;
  readonly user: PersistedUserContext;
}

const IDENTITY_LINE = [
  // Bug-2 root-cause rewrite (2026-05-31): the previous identity line
  // ("voice-first assistant for frontline workers") plus the capability
  // block's "you can call these tools (and only these)" framing made the
  // model behave as a tool router with NO general conversational ability.
  // When the user said anything the model couldn't immediately map to a
  // tool (e.g. a one-word transcript like "you"), it scanned its 9 tools,
  // picked the one closest to "general question someone might ask", and
  // called weather. That was the prompt's fault, not the model's.
  //
  // gpt-realtime is a frontier model. It can hold any conversation. This
  // identity now positions it as a CONVERSATIONAL AI FIRST that ALSO has
  // a few live tools. Tools are optional, not the point.
  "You are Jarvis, a friendly voice-first AI assistant. You hold normal, intelligent conversations about anything — exactly the way a capable AI like ChatGPT would. You happen to also have a small set of live tools (real-time weather, GitHub queries, durable memory) you CAN use when the user clearly wants real-time data, but most interactions are just conversation. Speak naturally, concise sentences, no headers, no markdown, no lists read out as 'bullet one'.",
].join(' ');

const LANGUAGE_LINE =
  // Lesson F5: GA Realtime silently coerces to other languages on borderline audio.
  'Always respond in English.';

const CONVERSATION_LINE = [
  // Bug-2 fix (rewrite): be a normal conversational partner FIRST. Tools
  // are a fallback when real-time data is clearly needed.
  'Default to a conversational response. If the user says something short, unclear, or ambiguous (a single word like "you", "okay", "right", a transcription artifact, or just casual chatter), engage like a person would — ask what they mean, play along, or share a thought — do NOT default to calling a tool. Tools are only for when the user is clearly asking for real-time data you cannot answer from your own knowledge.',
  // For general knowledge that DOES live in your training, just answer
  // — same way ChatGPT would. Don't refuse with "I don't know" on
  // general-knowledge questions just because there's no matching tool.
  'For general-knowledge questions (history, science, definitions, math, advice, opinion, jokes, etc.), answer from your own knowledge confidently. You are not limited to information accessible via your tools.',
  // Bug-E fix (2026-05-31): Whisper, when fed near-silence or a very
  // brief noise fragment, frequently falls back to the most common
  // phrases in its YouTube-heavy training corpus: "Thanks for
  // watching!", "Don't forget to like and subscribe", "Subscribe to my
  // channel", "If you enjoyed this video", "See you next time", etc.
  // These are TRANSCRIPTION ARTIFACTS, not what the user said.
  'If the transcribed message looks like generic YouTube filler — "Thanks for watching", "Don\'t forget to like and subscribe", "Subscribe to my channel", "If you enjoyed this video", "See you in the next one", or similar — IGNORE IT. It is a Whisper transcription artifact on near-silence, not a real user utterance. Stay quiet and keep waiting; do not respond, do not call a tool, do not comment on background noise or "whistling tones".',
].join(' ');

const HALLUCINATION_GUARD = [
  // Narrowed (2026-05-31): the guard NOW only fires on specific
  // real-world-data claims (PR counts, weather values, commit hashes).
  // For general knowledge, the model behaves like a normal LLM.
  'For LIVE, time-sensitive, or specific external-system data — current weather values, current PR/issue counts on a specific repo, specific commit hashes, today\'s news — if you cannot ground the claim in a tool response, in this prompt, or in the user\'s memory below, say "I don\'t have a live source for that right now" rather than guessing a number.',
  'When a tool errors, surface the error honestly ("I tried to reach GitHub but it timed out.") rather than fabricating.',
].join(' ');

const SLOW_TOOL_LINE =
  'When you call a tool, briefly say what you are doing first ("One moment, pulling that now." / "Looking up the weather." / "Checking GitHub.") so the user knows you are working.';

const BARGE_IN_LINE =
  'If the user starts speaking while you are talking, stop immediately and listen.';

/**
 * Build the system prompt for an outgoing `session.update`.
 *
 * Composition:
 *   1. Identity
 *   2. Capability list — rendered from the live Tool Dispatcher (US-05).
 *   3. Memory digest — summary + last-N turns (US-03).
 *   4. Preferences — user "never mention X / always flag Y" rows (US-11).
 *   5. Language directive (lesson F5).
 *   6. Hallucination guard (US-06).
 *   7. Slow-tool filler reminder (US-02).
 *   8. Barge-in reminder (US-04).
 *
 * Every block is collapsed to one line so token budget is predictable.
 * Inputs: env, dispatcher (for live tool surface), user context.
 * Outputs: a single string ready to be sent as `session.instructions`.
 * Failure modes: none — the function is pure; callers handle empty user.
 */
export function buildSystemPrompt(input: SessionInputs): string {
  const { env, dispatcher, user } = input;
  const caps = dispatcher.capabilities(env);
  return [
    IDENTITY_LINE,
    CONVERSATION_LINE,
    capabilityBlock(caps),
    memoryBlock(user),
    preferencesBlock(user),
    LANGUAGE_LINE,
    HALLUCINATION_GUARD,
    SLOW_TOOL_LINE,
    BARGE_IN_LINE,
  ].filter((line) => line.length > 0).join('\n\n');
}

function capabilityBlock(caps: readonly CapabilityEntry[]): string {
  // Soft framing (2026-05-31 rewrite): tools are AVAILABLE, not REQUIRED.
  // The previous "you can call these tools (and only these)" wording
  // pushed the model into tool-routing mode, which made it call weather
  // on any ambiguous input. Now: tools are optional, only used when the
  // user clearly wants live data.
  const available = caps.filter((c) => c.available);
  const disabled = caps.filter((c) => !c.available);
  const availLines = available.length === 0
    ? 'No live tools are wired right now; answer purely from your own knowledge and the user memory below.'
    : 'When the user clearly asks for live or real-time data, you may call one of these tools (you do NOT have to call a tool on every turn):\n' +
      available.map((c) => `  - ${c.name}: ${c.summary}`).join('\n');
  const disabledLines = disabled.length === 0
    ? ''
    : '\nThese tools are disabled in this environment; only mention them if the user asks directly:\n' +
      disabled.map((c) => `  - ${c.name}: ${c.disabledReason ?? 'unavailable'}`).join('\n');
  return `Available tools:\n${availLines}${disabledLines}`;
}

function memoryBlock(user: PersistedUserContext): string {
  if (!user.memoryAvailable) {
    return 'Memory: OFFLINE for this session (the database was unreachable). Cross-session recall is unavailable; tell the user honestly if asked.';
  }
  const summary = user.memorySummary?.trim() ?? '';
  const recent = user.recentTurns.slice(0, 10).map((t) => `  [${t.role}] ${t.content}`).join('\n');
  const parts: string[] = [`Memory for user ${user.userId}:`];
  if (summary.length > 0) parts.push(`Rolling summary: ${summary}`);
  else parts.push('Rolling summary: (no prior sessions)');
  if (recent.length > 0) parts.push(`Most recent turns:\n${recent}`);
  return parts.join('\n');
}

function preferencesBlock(user: PersistedUserContext): string {
  if (user.preferences.size === 0) return '';
  const lines: string[] = ['User preferences (honor strictly):'];
  for (const [k, v] of user.preferences) lines.push(`  - ${k}: ${v}`);
  return lines.join('\n');
}

/**
 * Resolve the connecting user's UUID. The web/iOS client sends it as
 * `X-User-Id` on the WebSocket upgrade request; if absent, mint a new
 * UUID v4 and the client persists it on its side.
 */
export function resolveUserId(headerValue: string | undefined): string {
  if (headerValue !== undefined && /^[0-9a-fA-F-]{36}$/.test(headerValue)) {
    return headerValue.toLowerCase();
  }
  return randomUUID();
}

/**
 * Default empty user context — used when persistence is disabled or the
 * user is connecting for the first time before the row is inserted.
 */
export function emptyUserContext(userId: string, memoryAvailable: boolean): PersistedUserContext {
  return {
    userId,
    memorySummary: null,
    recentTurns: [],
    preferences: new Map(),
    memoryAvailable,
  };
}
