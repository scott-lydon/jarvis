-- Migration 0001 — initial schema for Jarvis persistence layer.
--
-- See plan.md §2.6 for column responsibilities.
-- All tables use TEXT for IDs (UUID v4 for users; auto-increment INTEGER
-- only on the `turns` table where chronological order matters).
--
-- Tables created here back US-03 (cross-session memory), US-11 (per-user
-- isolation), and the preferences side of US-05/US-08. Every read query in
-- src/db.ts MUST parameterise by user_id; see QA_ADVERSARY.md J-CAT-6.
--
-- Note on PRAGMAs: `journal_mode = WAL` cannot be set from inside a
-- transaction; SQLite raises SQLITE_ERROR if you try. The migration
-- runner (src/db/migrate.ts) sets WAL on the open connection BEFORE
-- any migration runs. `foreign_keys = ON` is also a per-connection
-- pragma; the runner sets it the same way. Do NOT add either pragma
-- to this file or any later migration.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,        -- UUID v4 from session manager
  created_at  TEXT NOT NULL            -- ISO 8601 UTC
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,           -- e.g. "never_mention", "flag_author"
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT NOT NULL,
  -- For tool-role rows, `content` is the JSON of {name, args, result}.
  -- For user/assistant rows, `content` is the spoken transcript text.
  ts          TEXT NOT NULL            -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS turns_user_ts ON turns(user_id, ts DESC);

CREATE TABLE IF NOT EXISTS memory_summaries (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- Number of turns folded into this summary, so the session manager
  -- can decide when to re-summarise (e.g., every 20 new turns).
  turn_count  INTEGER NOT NULL DEFAULT 0
);

-- Schema version is the row this migration installs into a one-row table
-- so future migrations know what's already applied.
CREATE TABLE IF NOT EXISTS schema_version (
  version  INTEGER NOT NULL PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
