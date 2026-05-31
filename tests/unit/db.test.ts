// SQLite persistence smoke — uses a real temp .db file (no in-memory
// shortcut, per the constitution).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, type Db } from '../../src/db.js';

let tmp: string;
let dbPath: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jarvis-db-'));
  dbPath = join(tmp, 'test.db');
  db = openDb(dbPath);
});

afterAll(() => {
  db.close();
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('Db (SQLite persistence)', () => {
  it('opens with WAL mode enabled', () => {
    const mode = db.raw.pragma('journal_mode', { simple: true }) as string;
    expect(mode.toLowerCase()).toBe('wal');
  });

  it('ensureUser is idempotent', () => {
    db.ensureUser('user-a');
    db.ensureUser('user-a');
    const row = db.raw.prepare<{ id: string }, { c: number }>(`SELECT COUNT(*) AS c FROM users WHERE id = @id`).get({ id: 'user-a' });
    expect(row?.c).toBe(1);
  });

  it('appendTurn / loadUserContext returns the recent turns scoped to user_id', () => {
    db.ensureUser('user-b');
    db.appendTurn('user-b', 'user', 'hello world');
    db.appendTurn('user-b', 'assistant', 'hi back');
    const ctx = db.loadUserContext('user-b');
    expect(ctx.recentTurns.map((t) => t.content)).toContain('hello world');
    expect(ctx.recentTurns.map((t) => t.content)).toContain('hi back');
    // Other users do not bleed in.
    const ctxA = db.loadUserContext('user-a');
    expect(ctxA.recentTurns.find((t) => t.content === 'hello world')).toBeUndefined();
  });

  it('upsertPreference + loadUserContext exposes preferences', () => {
    db.ensureUser('user-c');
    db.upsertPreference('user-c', 'never_mention', 'cilantro');
    db.upsertPreference('user-c', 'never_mention', 'olives'); // overwrite
    const ctx = db.loadUserContext('user-c');
    expect(ctx.preferences.get('never_mention')).toBe('olives');
  });

  it('deletePreference removes the row', () => {
    db.ensureUser('user-d');
    db.upsertPreference('user-d', 'flag_author', 'octocat');
    db.deletePreference('user-d', 'flag_author');
    const ctx = db.loadUserContext('user-d');
    expect(ctx.preferences.get('flag_author')).toBeUndefined();
  });

  it('upsertSummary replaces existing summary', () => {
    db.ensureUser('user-e');
    db.upsertSummary('user-e', 'first', 1);
    db.upsertSummary('user-e', 'second', 2);
    const ctx = db.loadUserContext('user-e');
    expect(ctx.memorySummary).toBe('second');
  });
});
