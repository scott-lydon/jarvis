// Session manager tests — system prompt assembly and userId resolution.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildSystemPrompt, emptyUserContext, resolveUserId } from '../../src/session.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const env = {
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

const fakeWeather: ToolDefinition<{ location: string }> = {
  name: 'wttr_get',
  description: 'Look up live weather.',
  userFacingSummary: 'Tell you the current weather anywhere wttr.in covers.',
  schema: z.object({ location: z.string() }),
  handler: () => Promise.resolve('ok'),
};

const fakeGithub: ToolDefinition<{ owner: string; repo: string }> = {
  name: 'github_list_prs',
  description: 'List open PRs.',
  userFacingSummary: 'List open or recent pull requests on a public GitHub repository.',
  schema: z.object({ owner: z.string(), repo: z.string() }),
  available: (e) => e.githubToken === null ? 'GITHUB_TOKEN missing' : null,
  handler: () => Promise.resolve('ok'),
};

describe('buildSystemPrompt', () => {
  it('contains the literal English directive (lesson F5)', () => {
    const d = new ToolDispatcher();
    d.register(fakeWeather);
    const out = buildSystemPrompt({ env, dispatcher: d, user: emptyUserContext('u', true) });
    expect(out).toContain('Always respond in English.');
  });

  it('enumerates the live capability list (US-05)', () => {
    const d = new ToolDispatcher();
    d.register(fakeWeather);
    const out = buildSystemPrompt({ env, dispatcher: d, user: emptyUserContext('u', true) });
    expect(out).toContain('wttr_get');
    expect(out).toContain('Tell you the current weather');
  });

  it('lists disabled tools separately so the model can explain why', () => {
    const d = new ToolDispatcher();
    d.register(fakeWeather);
    d.register(fakeGithub);
    const out = buildSystemPrompt({ env, dispatcher: d, user: emptyUserContext('u', true) });
    expect(out).toContain('disabled');
    expect(out).toContain('github_list_prs');
    expect(out).toContain('GITHUB_TOKEN missing');
  });

  it('flags memory OFFLINE when persistence is unavailable', () => {
    const d = new ToolDispatcher();
    const out = buildSystemPrompt({ env, dispatcher: d, user: emptyUserContext('u', false) });
    expect(out).toContain('Memory: OFFLINE');
  });

  it('contains the narrow live-data hallucination guard (US-06, rewritten 2026-05-31)', () => {
    const d = new ToolDispatcher();
    const out = buildSystemPrompt({ env, dispatcher: d, user: emptyUserContext('u', true) });
    // The guard fires only on LIVE-data claims now (weather values, PR
    // counts, today's news), not on general knowledge.
    expect(out).toMatch(/live source/i);
    // And the prompt positions Jarvis as conversational FIRST.
    expect(out).toMatch(/conversational|hold normal.*conversations/i);
  });
});

describe('resolveUserId', () => {
  it('passes through a valid UUID v4 shape (case-insensitive)', () => {
    const u = '550E8400-e29b-41d4-a716-446655440000';
    expect(resolveUserId(u)).toBe(u.toLowerCase());
  });

  it('mints a new UUID when the header is absent', () => {
    const u = resolveUserId(undefined);
    expect(u).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a new UUID when the header is malformed', () => {
    const u = resolveUserId('not-a-uuid');
    expect(u).toMatch(/^[0-9a-f-]{36}$/);
  });
});
