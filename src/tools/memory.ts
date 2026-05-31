// Memory + Preferences tools (plan.md §2.3, US-03, US-08, US-11).
//
// Three concrete tools:
//   - memory_write(key, value) — write a short fact to durable memory.
//   - preference_set(key, value) — persist a user preference.
//   - preference_clear(key)     — remove a preference.
//
// All three require persistence; when the DB is offline they return a
// structured error (the agent must surface this honestly).

import { z } from 'zod';

import type { ToolDefinition } from './types.js';
import { log } from '../logger.js';

const preferenceKeys = z.enum([
  'never_mention',
  'flag_author',
  'flag_repo',
  'preferred_units',
  'wake_phrase',
  'custom_note',
]);

const memoryWriteSchema = z.object({
  key: z.string().min(1).max(120).describe('A short identifier for the fact, e.g. "favorite_repo".'),
  value: z.string().min(1).max(2000).describe('The fact to remember, in plain English.'),
});

function upsertPreferenceRow(db: NonNullable<import('./types.js').ToolContext['db']>, userId: string, key: string, value: string): void {
  db.prepare<{ user_id: string; key: string; value: string; ts: string }>(
    `INSERT INTO preferences (user_id, key, value, updated_at)
     VALUES (@user_id, @key, @value, @ts)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ user_id: userId, key, value, ts: new Date().toISOString() });
}

export const memoryWriteTool: ToolDefinition<z.infer<typeof memoryWriteSchema>> = {
  name: 'memory_write',
  description: 'Save a short fact to the user\'s durable memory so it is available in future sessions.',
  userFacingSummary: 'Save a fact you tell me so I remember it next time we talk.',
  schema: memoryWriteSchema,
  // eslint-disable-next-line @typescript-eslint/require-await -- handler type is async by contract
  handler: async (args, ctx) => {
    if (ctx.db === null) {
      return { error: 'memory_offline', message: 'The memory database is not connected right now.' } as const;
    }
    try {
      upsertPreferenceRow(ctx.db, ctx.userId, `note:${args.key}`, args.value);
      return { ok: true, key: args.key };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error({ event: 'memory_write.failed', userId: ctx.userId, key: args.key, message });
      return { error: 'memory_write_failed', message } as const;
    }
  },
};

const prefSetSchema = z.object({
  key: preferenceKeys.describe('Which preference to set.'),
  value: z.string().min(1).max(500).describe('The preference value (e.g. "fahrenheit", a topic name, an author handle).'),
});

export const preferenceUpsertTool: ToolDefinition<z.infer<typeof prefSetSchema>> = {
  name: 'preference_set',
  description: 'Set a user preference such as "never mention <topic>", "always flag PRs from <author>", or "preferred units".',
  userFacingSummary: 'Remember preferences like "never mention X" or "flag pull requests from this author".',
  schema: prefSetSchema,
  // eslint-disable-next-line @typescript-eslint/require-await -- handler type is async by contract
  handler: async (args, ctx) => {
    if (ctx.db === null) {
      return { error: 'memory_offline', message: 'Preferences cannot be saved right now.' } as const;
    }
    try {
      upsertPreferenceRow(ctx.db, ctx.userId, args.key, args.value);
      return { ok: true, key: args.key, value: args.value };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error({ event: 'preference_set.failed', userId: ctx.userId, key: args.key, message });
      return { error: 'preference_set_failed', message } as const;
    }
  },
};

const prefClearSchema = z.object({
  key: preferenceKeys.describe('Which preference to remove.'),
});

export const preferenceDeleteTool: ToolDefinition<z.infer<typeof prefClearSchema>> = {
  name: 'preference_clear',
  description: 'Remove a previously-set user preference.',
  userFacingSummary: 'Forget a preference you previously asked me to remember.',
  schema: prefClearSchema,
  // eslint-disable-next-line @typescript-eslint/require-await -- handler type is async by contract
  handler: async (args, ctx) => {
    if (ctx.db === null) {
      return { error: 'memory_offline', message: 'Preferences cannot be cleared right now.' } as const;
    }
    try {
      ctx.db.prepare<{ user_id: string; key: string }>(
        `DELETE FROM preferences WHERE user_id = @user_id AND key = @key`,
      ).run({ user_id: ctx.userId, key: args.key });
      return { ok: true, key: args.key };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error({ event: 'preference_clear.failed', userId: ctx.userId, key: args.key, message });
      return { error: 'preference_clear_failed', message } as const;
    }
  },
};
