// Unit test for Slice 8 — preferences post-call filter.
//
// We test the `readFlaggedAuthors` helper directly against a real
// SQLite database (no Octokit / no network). The flagged-author bubble
// behaviour is a deterministic side-channel that makes US-08 ("always
// flag PRs from X") robust to model failures: even if the LLM forgets
// the prompt-level instruction, the tool's result payload already has
// the flagged author at index 0 with `flagged: true`.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb } from '../../src/db.js';
import { readFlaggedAuthors } from '../../src/tools/github.js';
import type { ToolContext } from '../../src/tools/types.js';

const TEST_ENV = {
  openaiApiKey: 'sk-test',
  githubToken: 'ghp-fake',
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

function freshDb(): { path: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'jarvis-flag-'));
  dirs.push(tmp);
  return { path: join(tmp, 'flag.db') };
}

describe('readFlaggedAuthors (Slice 8)', () => {
  it('returns an empty set when no preference is stored', () => {
    const { path } = freshDb();
    const db = openDb(path);
    try {
      db.ensureUser('u1');
      const ctx: ToolContext = { userId: 'u1', env: TEST_ENV, db: db.raw };
      expect([...readFlaggedAuthors(ctx)]).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns the trimmed, lowercased authors when the preference is a comma list', () => {
    const { path } = freshDb();
    const db = openDb(path);
    try {
      db.ensureUser('u1');
      db.upsertPreference('u1', 'flag_author', ' Octocat ,SJPADGETT, , adunsulag');
      const ctx: ToolContext = { userId: 'u1', env: TEST_ENV, db: db.raw };
      const flagged = readFlaggedAuthors(ctx);
      expect([...flagged].sort()).toEqual(['adunsulag', 'octocat', 'sjpadgett']);
    } finally {
      db.close();
    }
  });

  it('returns an empty set when ctx.db is null (memory offline)', () => {
    const ctx: ToolContext = { userId: 'u1', env: TEST_ENV, db: null };
    expect([...readFlaggedAuthors(ctx)]).toEqual([]);
  });

  it('one user\'s flag_author does not bleed into another user', () => {
    const { path } = freshDb();
    const db = openDb(path);
    try {
      db.ensureUser('u1');
      db.ensureUser('u2');
      db.upsertPreference('u1', 'flag_author', 'octocat');
      const c1: ToolContext = { userId: 'u1', env: TEST_ENV, db: db.raw };
      const c2: ToolContext = { userId: 'u2', env: TEST_ENV, db: db.raw };
      expect([...readFlaggedAuthors(c1)]).toEqual(['octocat']);
      expect([...readFlaggedAuthors(c2)]).toEqual([]);
    } finally {
      db.close();
    }
  });
});
