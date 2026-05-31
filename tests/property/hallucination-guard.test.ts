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

// 20 representative un-groundable prompt categories. Each one is the
// kind of question a model with no tool/memory access for that topic
// could quietly fabricate an answer to. If the prompt-level guard is
// missing, hallucination is unconstrained.
const UNGROUNDABLE_CATEGORIES = [
  'weather without the weather tool',
  'GitHub PR list without a token',
  'GitHub issue body without a token',
  'recent merges without a token',
  'private repository contents',
  'a user\'s home address',
  'today\'s news headlines',
  'live stock prices',
  'live sports scores',
  'an arbitrary commit hash',
  'a colleague\'s phone number',
  'the user\'s social security number',
  'tomorrow\'s weather forecast',
  'an internal service URL',
  'a private API key value',
  'a Slack message the assistant did not receive',
  'a file path the assistant has never been told about',
  'historical trivia outside training',
  'a person\'s exact age',
  'a flight\'s gate number',
] as const;

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

describe('US-06 hallucination guard — prompt-level property', () => {
  for (const category of UNGROUNDABLE_CATEGORIES) {
    it(`carries an explicit "do not guess" directive for category: ${category}`, () => {
      // The text of the directive must be identical regardless of category
      // — it's a single rule, not a per-category one. We assert each
      // category once so that if the rule is ever weakened, the failure
      // surface lists every prompt category that would be left exposed.
      const prompts = [promptWithSomeToolsAndUser(), promptWithNoTools(), promptWithOfflineMemory()];
      for (const p of prompts) {
        // Required directives:
        expect(p, `prompt must instruct "say I don't know" (category: ${category})`).toMatch(/I don't know/i);
        expect(p, `prompt must name tool / memory / this prompt as the only grounding (${category})`).toMatch(/grounded in a tool response, in this prompt, or in the user memory/i);
        expect(p, `prompt must forbid guessing (${category})`).toMatch(/Do not guess/i);
        expect(p, `prompt must instruct honest tool-error surfacing (${category})`).toMatch(/surface the error honestly/i);
      }
    });
  }

  it('the "I don\'t know" directive is one line and unconditional', () => {
    const p = promptWithSomeToolsAndUser();
    // No "if applicable", "when in doubt", etc. — the rule is unconditional.
    const guardLine = p.split('\n').find((l) => l.toLowerCase().includes("i don't know")) ?? '';
    expect(guardLine, 'I don\'t know directive must be present').not.toBe('');
    expect(guardLine.toLowerCase()).not.toMatch(/when in doubt|if applicable|usually/);
  });

  it('the slow-tool reminder is also in the prompt (US-02 paired)', () => {
    expect(promptWithSomeToolsAndUser()).toMatch(/briefly say what you are doing first/i);
  });

  it('the barge-in reminder is in the prompt (US-04 paired)', () => {
    expect(promptWithSomeToolsAndUser()).toMatch(/stop immediately and listen/i);
  });
});
