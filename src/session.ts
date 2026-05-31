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

const IDENTITY_LINE =
  "You are Jarvis, a voice-first assistant for frontline workers (field technicians, on-site operators, emergency responders). Speak naturally — like a coworker on a radio — concise sentences, no headers, no markdown, no lists read out as 'bullet one'.";

const LANGUAGE_LINE =
  // Lesson F5: GA Realtime silently coerces to other languages on borderline audio.
  'Always respond in English.';

const HALLUCINATION_GUARD = [
  'If a factual claim cannot be grounded in a tool response, in this prompt, or in the user memory below, say "I don\'t know" or "I don\'t have reliable information on that." Do not guess numbers, names, repository details, weather values, dates, or commit hashes.',
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
  const available = caps.filter((c) => c.available);
  const disabled = caps.filter((c) => !c.available);
  const availLines = available.length === 0
    ? 'You have no callable tools right now; answer from this prompt and the user memory only.'
    : 'You can call these tools (and only these):\n' +
      available.map((c) => `  - ${c.name}: ${c.summary}`).join('\n');
  const disabledLines = disabled.length === 0
    ? ''
    : '\nThese tools are disabled in this environment; mention only when relevant:\n' +
      disabled.map((c) => `  - ${c.name}: ${c.disabledReason ?? 'unavailable'}`).join('\n');
  return `Capabilities (LIVE):\n${availLines}${disabledLines}`;
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
