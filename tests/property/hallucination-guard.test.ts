// Property test for US-06 zero-hallucination guard (Slice 7).
//
// Spec criterion (spec.md US-06): "When asked about something Jarvis
// cannot ground in a tool response, this prompt, or user memory, the
// assistant says it does not know rather than guessing."
//
// We CANNOT run a live model in CI on every test run — too costly, too
// flaky. The contract this test enforces is the prompt-level contract:
//
//   FOR every category of un-groundable question {weather without a
//   tool, repository facts without GitHub, personal facts not in user
//   memory, news, identity claims, future events, internal infrastructure,
//   private keys, off-topic trivia, time-sensitive prices, ...},
//   the system prompt MUST carry both:
//     - an explicit "say I don't know" directive,
//     - a hallucination-guard sentence that names tool/memory/prompt as
//       the only legitimate grounding source.
//
// The actual model-side enforcement is checked manually with a couple
// of live prompts at demo time. This test guarantees the *prompt* the
// model is being initialized with cannot be silently weakened.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildSystemPrompt, emptyUserContext } from '../../src/session.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const TEST_ENV = {
  openaiApiKey: 'sk-test',
  githubToken: null,
  wttrBaseUrl: 'https://example.invalid',
  dbPath: ':memory:',
  port: 0,
  realtimeModel: 'gpt-realtime',
  realtimeVoice: 'marin',
  host: '127.0.0.1',
  realtimeUrlOverride: null,
} as const;

// (LIVE_DATA_CATEGORIES now lives inside the describe block below — the
// new property is narrower than the old blanket guard: only categories
// that REQUIRE a live tool source must trigger the "no live source"
// language. General-knowledge categories were removed from this list
// because the model is now ALLOWED to answer them from training.)

const fakeWeather: ToolDefinition<{ location: string }> = {
  name: 'wttr_get',
  description: 'Look up live weather.',
  userFacingSummary: 'Tell you the current weather anywhere wttr.in covers.',
  schema: z.object({ location: z.string() }),
  handler: () => Promise.resolve('ok'),
};

function promptWithSomeToolsAndUser(): string {
  const d = new ToolDispatcher();
  d.register(fakeWeather);
  return buildSystemPrompt({ env: TEST_ENV, dispatcher: d, user: emptyUserContext('u', true) });
}

function promptWithNoTools(): string {
  return buildSystemPrompt({ env: TEST_ENV, dispatcher: new ToolDispatcher(), user: emptyUserContext('u', true) });
}

function promptWithOfflineMemory(): string {
  return buildSystemPrompt({ env: TEST_ENV, dispatcher: new ToolDispatcher(), user: emptyUserContext('u', false) });
}

// Rewritten (2026-05-31) after the user caught that the previous, much
// stricter prompt was forcing the model into tool-router mode for every
// turn — including ambiguous transcripts like "you", which it routed to
// weather. The new prompt frames Jarvis as a CONVERSATIONAL AI FIRST that
// happens to also have tools. The property below pins the new contract:
//   - LIVE-data hallucination is still forbidden (numeric weather values,
//     PR counts, etc.) — this is the narrow, surgical guard.
//   - General-knowledge questions are answered like any LLM would.
//   - Ambiguous transcripts get a conversational response, NOT a tool call.

describe('US-06 hallucination guard — narrow live-data guard, not blanket', () => {
  // Live-data un-groundable categories: these MUST trigger the
  // "no live source" directive. General knowledge categories (history,
  // science, math, definitions) are NOT in this list — they're answered
  // from training, the same way ChatGPT would answer them.
  const LIVE_DATA_CATEGORIES = [
    'weather without the weather tool',
    'GitHub PR list without a token',
    'GitHub issue body without a token',
    'recent merges without a token',
    'private repository contents',
    'today\'s news headlines',
    'live stock prices',
    'live sports scores',
    'an arbitrary commit hash',
    'tomorrow\'s weather forecast',
  ] as const;

  for (const category of LIVE_DATA_CATEGORIES) {
    it(`carries the narrow live-data "no live source" directive for: ${category}`, () => {
      const prompts = [promptWithSomeToolsAndUser(), promptWithNoTools(), promptWithOfflineMemory()];
      for (const p of prompts) {
        expect(p, `prompt must require a tool-grounded source for LIVE data (${category})`).toMatch(/live source/i);
        expect(p, `prompt must instruct honest tool-error surfacing (${category})`).toMatch(/surface the error honestly/i);
      }
    });
  }

  it('the prompt positions the model as conversational FIRST, tools SECOND', () => {
    const p = promptWithSomeToolsAndUser();
    expect(p, 'prompt must name Jarvis as a conversational AI').toMatch(/conversational|hold normal.*conversations|talk(ing)? with the user/i);
    // Compare against the OLD failure mode: "(and only these)" — that
    // exact wording is what forced the model into tool-router mode.
    expect(p, 'prompt must NOT say "and only these"').not.toMatch(/and only these/i);
  });

  it('the prompt explicitly permits general-knowledge answers without a tool', () => {
    const p = promptWithSomeToolsAndUser();
    expect(p, 'prompt must say general-knowledge questions can be answered from the model\'s own knowledge').toMatch(/general[- ]knowledge|own knowledge/i);
  });

  it('the prompt tells the model to engage conversationally on ambiguous/short input', () => {
    const p = promptWithSomeToolsAndUser();
    // The directive: short/ambiguous input → conversational response, NOT tool call.
    expect(p).toMatch(/short, unclear, or ambiguous|engage like a person|do NOT default to calling a tool/i);
  });

  it('the slow-tool reminder is still in the prompt (US-02)', () => {
    expect(promptWithSomeToolsAndUser()).toMatch(/briefly say what you are doing first/i);
  });

  it('the barge-in reminder is in the prompt (US-04)', () => {
    expect(promptWithSomeToolsAndUser()).toMatch(/stop immediately and listen/i);
  });

  it('memory-offline state still surfaces in the prompt (US-03)', () => {
    expect(promptWithOfflineMemory()).toMatch(/Memory: OFFLINE/);
  });
});
