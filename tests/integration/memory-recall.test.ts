// Integration test for US-03 cross-session recall (Slice 4).
//
// Spec criterion (spec.md US-03): "When the user reopens a session
// (potentially after the server process was killed and restarted), the
// assistant must recall what was said earlier."
//
// We can't perform a real voice round-trip from this test runner — there
// is no microphone. The closest structural proof is:
//
//   1. Open a fresh SQLite database at a tmp path.
//   2. Append a few turns under user `u1` and close the database
//      (mirrors a server crash / restart — connection torn down).
//   3. Re-open the SAME path with `openDb(...)` again. This is the same
//      code path the production server uses on boot.
//   4. Call `loadUserContext('u1')`. The Session Manager would then feed
//      this into `buildSystemPrompt(...)` on the next session.
//
// The test asserts that prior turns and preferences survive the close /
// reopen, which is the only thing that has to be true for recall to
// work after a restart.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb } from '../../src/db.js';
import { buildSystemPrompt } from '../../src/session.js';
import { ToolDispatcher } from '../../src/tools/dispatcher.js';

const TEST_ENV = {
  openaiApiKey: 'sk-test',
  githubToken: null,
  wttrBaseUrl: 'https://example.invalid',
  dbPath: ':not-used:',
  port: 0,
  realtimeModel: 'gpt-realtime',
  realtimeVoice: 'marin',
  host: '127.0.0.1',
  realtimeUrlOverride: null,
} as const;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function freshTmpDb(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'jarvis-recall-'));
  dirs.push(tmp);
  return join(tmp, 'recall.db');
}

describe('US-03 cross-session memory recall', () => {
  it('turns persisted in one connection are visible in a fresh connection at the same path', () => {
    const dbPath = freshTmpDb();

    // Session 1 — write a few turns + a preference, then close.
    {
      const db = openDb(dbPath);
      db.ensureUser('u1');
      db.appendTurn('u1', 'user', 'I asked about the openemr repo');
      db.appendTurn('u1', 'assistant', 'You asked me to summarise the openemr PR queue.');
      db.upsertPreference('u1', 'flag_author', 'sjpadgett');
      db.close();
    }

    // Session 2 — fresh connection at the SAME path (simulates restart).
    const db2 = openDb(dbPath);
    try {
      const ctx = db2.loadUserContext('u1');
      const contents = ctx.recentTurns.map((t) => t.content);
      expect(contents).toContain('I asked about the openemr repo');
      expect(contents).toContain('You asked me to summarise the openemr PR queue.');
      expect(ctx.preferences.get('flag_author')).toBe('sjpadgett');
    } finally {
      db2.close();
    }
  });

  it('loadUserContext for an unknown user returns an empty context with memoryAvailable=true', () => {
    const dbPath = freshTmpDb();
    const db = openDb(dbPath);
    try {
      const ctx = db.loadUserContext('00000000-0000-0000-0000-000000000000');
      expect(ctx.recentTurns).toHaveLength(0);
      expect(ctx.memorySummary).toBeNull();
      expect(ctx.preferences.size).toBe(0);
      expect(ctx.memoryAvailable).toBe(true);
    } finally {
      db.close();
    }
  });

  it('recalled context is composed into the system prompt for the next session', () => {
    const dbPath = freshTmpDb();
    {
      const db = openDb(dbPath);
      db.ensureUser('u1');
      db.appendTurn('u1', 'user', 'Remember that my favorite repo is openemr/openemr.');
      db.appendTurn('u1', 'assistant', 'Got it — openemr/openemr is your favorite.');
      db.upsertSummary('u1', 'User cares about the openemr repo and PR/issue surfaces.', 2);
      db.close();
    }

    const db2 = openDb(dbPath);
    try {
      const userCtx = db2.loadUserContext('u1');
      const prompt = buildSystemPrompt({
        env: TEST_ENV,
        dispatcher: new ToolDispatcher(),
        user: userCtx,
      });
      // Both the rolling summary and the most-recent turns must end up in the
      // prompt the next session is initialised with, otherwise the model has
      // no path to recall anything across the restart.
      expect(prompt).toContain('Rolling summary:');
      expect(prompt).toContain('User cares about the openemr repo');
      expect(prompt).toContain('Most recent turns:');
      expect(prompt).toContain('favorite repo is openemr/openemr');
    } finally {
      db2.close();
    }
  });

  it('turns belonging to one user do not bleed into another user\'s recalled context (US-11)', () => {
    const dbPath = freshTmpDb();
    {
      const db = openDb(dbPath);
      db.ensureUser('u1');
      db.ensureUser('u2');
      db.appendTurn('u1', 'user', 'u1-only-marker');
      db.appendTurn('u2', 'user', 'u2-only-marker');
      db.close();
    }

    const db = openDb(dbPath);
    try {
      const c1 = db.loadUserContext('u1');
      const c2 = db.loadUserContext('u2');
      const c1Contents = c1.recentTurns.map((t) => t.content);
      const c2Contents = c2.recentTurns.map((t) => t.content);
      expect(c1Contents).toContain('u1-only-marker');
      expect(c1Contents).not.toContain('u2-only-marker');
      expect(c2Contents).toContain('u2-only-marker');
      expect(c2Contents).not.toContain('u1-only-marker');
    } finally {
      db.close();
    }
  });
});
