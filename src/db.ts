// Persistence Layer (plan.md §2.6).
//
// Wraps better-sqlite3 in a tight surface so the Session Manager and
// Tool Dispatcher never touch SQL strings directly. All queries are
// parameterised by `user_id` so per-user isolation (US-11) is enforced
// at this seam.
//
// On open, the runtime PRAGMAs (`journal_mode = WAL`, `foreign_keys = ON`)
// are applied per-connection; the migration runner (`src/db/migrate.ts`)
// owns initial schema creation, but if the DB file is missing here we
// run migrations first so a fresh server has a usable database without
// a separate command.

import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

type BSDatabase = Database.Database;

import { log } from './logger.js';
import { migrate } from './db/migrate.js';
import type { PersistedUserContext } from './session.js';

export interface PreferenceRow {
  readonly user_id: string;
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
}

export interface TurnRow {
  readonly id: number;
  readonly user_id: string;
  readonly role: string;
  readonly content: string;
  readonly ts: string;
}

export interface Db {
  readonly raw: BSDatabase;
  ensureUser(userId: string): void;
  loadUserContext(userId: string): PersistedUserContext;
  appendTurn(userId: string, role: 'user' | 'assistant' | 'tool', content: string): void;
  upsertPreference(userId: string, key: string, value: string): void;
  deletePreference(userId: string, key: string): void;
  upsertSummary(userId: string, summary: string, turnCount: number): void;
  recentTurns(userId: string, limit: number): readonly TurnRow[];
  countTurnsSince(userId: string, sinceTs: string): number;
  close(): void;
}

export function openDb(path: string): Db {
  // If the DB file does not exist yet, run migrations to create it.
  if (!existsSync(path)) {
    const result = migrate(path);
    log.info({
      event: 'db.migrated_on_open',
      path: result.databasePath,
      appliedNow: result.appliedNow,
    });
  }
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  const stmts = {
    ensureUser: raw.prepare<{ id: string; ts: string }>(
      `INSERT OR IGNORE INTO users (id, created_at) VALUES (@id, @ts)`,
    ),
    selectSummary: raw.prepare<{ user_id: string }, { summary: string; updated_at: string; turn_count: number }>(
      `SELECT summary, updated_at, turn_count FROM memory_summaries WHERE user_id = @user_id`,
    ),
    selectRecentTurns: raw.prepare<{ user_id: string; limit: number }, TurnRow>(
      `SELECT id, user_id, role, content, ts FROM turns WHERE user_id = @user_id ORDER BY ts DESC, id DESC LIMIT @limit`,
    ),
    countTurnsSince: raw.prepare<{ user_id: string; ts: string }, { c: number }>(
      `SELECT COUNT(*) AS c FROM turns WHERE user_id = @user_id AND ts > @ts`,
    ),
    selectPreferences: raw.prepare<{ user_id: string }, PreferenceRow>(
      `SELECT user_id, key, value, updated_at FROM preferences WHERE user_id = @user_id`,
    ),
    insertTurn: raw.prepare<{ user_id: string; role: string; content: string; ts: string }>(
      `INSERT INTO turns (user_id, role, content, ts) VALUES (@user_id, @role, @content, @ts)`,
    ),
    upsertPref: raw.prepare<{ user_id: string; key: string; value: string; ts: string }>(
      `INSERT INTO preferences (user_id, key, value, updated_at)
       VALUES (@user_id, @key, @value, @ts)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),
    deletePref: raw.prepare<{ user_id: string; key: string }>(
      `DELETE FROM preferences WHERE user_id = @user_id AND key = @key`,
    ),
    upsertSummary: raw.prepare<{ user_id: string; summary: string; ts: string; turn_count: number }>(
      `INSERT INTO memory_summaries (user_id, summary, updated_at, turn_count)
       VALUES (@user_id, @summary, @ts, @turn_count)
       ON CONFLICT (user_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at, turn_count = excluded.turn_count`,
    ),
  };

  function nowIso(): string { return new Date().toISOString(); }

  return {
    raw,
    ensureUser(userId): void {
      stmts.ensureUser.run({ id: userId, ts: nowIso() });
    },
    loadUserContext(userId): PersistedUserContext {
      stmts.ensureUser.run({ id: userId, ts: nowIso() });
      const summaryRow = stmts.selectSummary.get({ user_id: userId });
      const turns = stmts.selectRecentTurns.all({ user_id: userId, limit: 20 });
      const prefRows = stmts.selectPreferences.all({ user_id: userId });
      const preferences = new Map<string, string>();
      for (const p of prefRows) preferences.set(p.key, p.value);
      // The DB query returns DESC; the system prompt reads top-down as
      // "most recent at the top" which matches what users naturally expect.
      const recentTurns = turns.map((t) => ({ role: t.role, content: t.content, ts: t.ts }));
      return {
        userId,
        memorySummary: summaryRow?.summary ?? null,
        recentTurns,
        preferences,
        memoryAvailable: true,
      };
    },
    appendTurn(userId, role, content): void {
      stmts.insertTurn.run({ user_id: userId, role, content, ts: nowIso() });
    },
    upsertPreference(userId, key, value): void {
      stmts.upsertPref.run({ user_id: userId, key, value, ts: nowIso() });
    },
    deletePreference(userId, key): void {
      stmts.deletePref.run({ user_id: userId, key });
    },
    upsertSummary(userId, summary, turnCount): void {
      stmts.upsertSummary.run({ user_id: userId, summary, ts: nowIso(), turn_count: turnCount });
    },
    recentTurns(userId, limit): readonly TurnRow[] {
      return stmts.selectRecentTurns.all({ user_id: userId, limit });
    },
    countTurnsSince(userId, sinceTs): number {
      const row = stmts.countTurnsSince.get({ user_id: userId, ts: sinceTs });
      return row?.c ?? 0;
    },
    close(): void { raw.close(); },
  };
}
