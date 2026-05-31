// Rolling memory summarizer (plan.md §2.6, US-03).
//
// Re-summarises a user's conversation roughly every N new turns. Calls
// the OpenAI Chat Completions API (NOT Realtime) to compress the prior
// summary + recent turns into one short paragraph, then upserts it
// into `memory_summaries`.
//
// Real OpenAI call, no mocks. If the call fails, the prior summary is
// preserved and the failure is logged; the user's session keeps working
// because the raw turns are always available.

import type { Db, TurnRow } from './db.js';
import type { JarvisEnv } from './env.js';
import { log } from './logger.js';

const TURNS_PER_RESUMMARIZE = 20;
const RECENT_WINDOW_FOR_PROMPT = 40;
const SUMMARY_MODEL = 'gpt-4o-mini';
const SUMMARY_MAX_CHARS = 1500;
const SUMMARY_TIMEOUT_MS = 8_000;

interface SummaryRow { readonly turn_count: number }

/**
 * Decide whether to re-summarise this user and, if so, do it inline.
 * Cheap to call from the per-turn write path: the SELECT is one query,
 * the OpenAI call is gated by the turn threshold.
 */
export async function maybeRollSummary(db: Db, userId: string, env: JarvisEnv): Promise<void> {
  const prior = db.raw
    .prepare<{ user_id: string }, SummaryRow>(`SELECT turn_count FROM memory_summaries WHERE user_id = @user_id`)
    .get({ user_id: userId });
  const prevTurnCount = prior?.turn_count ?? 0;
  const totalNow = db.raw
    .prepare<{ user_id: string }, { c: number }>(`SELECT COUNT(*) AS c FROM turns WHERE user_id = @user_id`)
    .get({ user_id: userId })?.c ?? 0;

  if (totalNow - prevTurnCount < TURNS_PER_RESUMMARIZE) return;

  const recentRows = db.recentTurns(userId, RECENT_WINDOW_FOR_PROMPT);
  const recent: readonly TurnRow[] = [...recentRows].reverse();

  const priorSummary = db.raw
    .prepare<{ user_id: string }, { summary: string }>(`SELECT summary FROM memory_summaries WHERE user_id = @user_id`)
    .get({ user_id: userId })?.summary ?? '';

  const newSummary = await summarizeWithOpenAI({
    apiKey: env.openaiApiKey,
    priorSummary,
    recentTurns: recent,
  });

  if (newSummary === null) return;

  db.upsertSummary(userId, newSummary.slice(0, SUMMARY_MAX_CHARS), totalNow);
  log.info({ event: 'summary.rolled', userId, turnCount: totalNow });
}

interface SummarizeInput {
  readonly apiKey: string;
  readonly priorSummary: string;
  readonly recentTurns: readonly TurnRow[];
}

async function summarizeWithOpenAI(input: SummarizeInput): Promise<string | null> {
  const turnsText = input.recentTurns
    .map((t) => `[${t.role}] ${t.content.slice(0, 600)}`)
    .join('\n');
  const userMsg = [
    'Update the rolling summary below to incorporate the recent turns.',
    'The new summary is for an assistant called Jarvis to read at the start of the NEXT session;',
    'keep it to 4-6 short sentences, no bullet lists, third-person, prefer concrete nouns',
    '("the openemr/openemr repo", "Austin weather") over vague references ("the project").',
    'If the prior summary is empty, write a fresh one from the recent turns alone.',
    '',
    'PRIOR SUMMARY:',
    input.priorSummary.length > 0 ? input.priorSummary : '(none yet)',
    '',
    'RECENT TURNS (oldest first):',
    turnsText,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, SUMMARY_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You write very short, factual conversation summaries for an assistant\'s long-term memory. No greetings, no headers.' },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      log.warn({ event: 'summary.openai_bad_status', status: res.status });
      return null;
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    return content.length > 0 ? content : null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn({ event: 'summary.openai_fetch_failed', message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
