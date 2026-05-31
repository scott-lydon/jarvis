// Unit tests for the Tool Dispatcher. Real zod schemas; no mocks.
//
// Covers (plan.md §2.3):
//   - register / list / capabilities
//   - dispatch happy path
//   - args validation error
//   - unknown tool error
//   - handler throw → wrapped tool_failed
//   - availability gating (disabled tool stays out of openai spec)

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolDispatcher } from '../../src/tools/dispatcher.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

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

const ctx: ToolContext = { userId: 'u1', env, db: null };

const echoTool: ToolDefinition<{ msg: string }> = {
  name: 'echo',
  description: 'Echo back a message.',
  schema: z.object({ msg: z.string().min(1) }),
  handler: (args) => Promise.resolve({ echoed: args.msg }),
};

const flakyTool: ToolDefinition<{ x: number }> = {
  name: 'flaky',
  description: 'Always throws.',
  schema: z.object({ x: z.number() }),
  handler: () => { throw new Error('boom'); },
};

const gatedTool: ToolDefinition<{ k: string }> = {
  name: 'gated',
  description: 'Disabled when no GitHub token.',
  schema: z.object({ k: z.string() }),
  available: (e) => e.githubToken === null ? 'no token' : null,
  handler: () => Promise.resolve('ok'),
};

describe('ToolDispatcher', () => {
  it('echo: happy path', async () => {
    const d = new ToolDispatcher();
    d.register(echoTool);
    const r = await d.dispatch('echo', { msg: 'hi' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ echoed: 'hi' });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('echo: invalid args returns tool_args_invalid', async () => {
    const d = new ToolDispatcher();
    d.register(echoTool);
    const r = await d.dispatch('echo', { msg: 123 }, ctx);
    expect(r.ok).toBe(false);
    expect((r.value as { error: string }).error).toBe('tool_args_invalid');
  });

  it('unknown tool returns tool_not_found', async () => {
    const d = new ToolDispatcher();
    const r = await d.dispatch('nope', {}, ctx);
    expect(r.ok).toBe(false);
    expect((r.value as { error: string }).error).toBe('tool_not_found');
  });

  it('handler throw is wrapped as tool_failed', async () => {
    const d = new ToolDispatcher();
    d.register(flakyTool);
    const r = await d.dispatch('flaky', { x: 1 }, ctx);
    expect(r.ok).toBe(false);
    const v = r.value as { error: string; message?: string };
    expect(v.error).toBe('tool_failed');
    expect(v.message).toContain('boom');
  });

  it('disabled tool is omitted from openaiToolsSpec', () => {
    const d = new ToolDispatcher();
    d.register(echoTool);
    d.register(gatedTool);
    const spec = d.openaiToolsSpec(env);
    const names = spec.map((s) => (s as { name: string }).name);
    expect(names).toContain('echo');
    expect(names).not.toContain('gated');
  });

  it('disabled tool dispatch returns tool_disabled', async () => {
    const d = new ToolDispatcher();
    d.register(gatedTool);
    const r = await d.dispatch('gated', { k: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect((r.value as { error: string }).error).toBe('tool_disabled');
  });

  it('capabilities reflect availability flag', () => {
    const d = new ToolDispatcher();
    d.register(echoTool);
    d.register(gatedTool);
    const caps = d.capabilities(env);
    const echoCap = caps.find((c) => c.name === 'echo');
    const gatedCap = caps.find((c) => c.name === 'gated');
    expect(echoCap?.available).toBe(true);
    expect(gatedCap?.available).toBe(false);
    expect(gatedCap?.disabledReason).toBe('no token');
  });
});
