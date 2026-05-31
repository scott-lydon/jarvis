// Migration runner. Idempotent: scans src/db/migrations/*.sql in lexical
// order, applies any whose version is not yet in `schema_version`.
//
// Why hand-rolled instead of pulling in `umzug` or `kysely-migrator`:
// - The schema is small (4 tables) and rarely changes.
// - The constitution's "no infra cost at MVP scale" line means one fewer
//   dependency, one fewer thing to audit.
// - Pre-commit / vouch grep doesn't have to special-case a migration
//   framework's `down` syntax.
//
// Failure modes are surfaced with specific messages so a stuck migration
// is one log line away from being diagnosed (per CLAUDE.md error-message
// rule).

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly absPath: string;
}

/**
 * Parse a migration filename like `0001_init.sql` into {version, name}.
 * Returns null if the filename does not match the convention, so a stray
 * file (README, .DS_Store, .bak) is skipped instead of aborting.
 */
function parseMigrationFilename(filename: string): MigrationFile | null {
  // Match: ####_name.sql (4-digit zero-padded version, snake_case name).
  const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) return null;
  const versionStr = match[1];
  const name = match[2];
  if (versionStr === undefined || name === undefined) return null;
  return {
    version: Number.parseInt(versionStr, 10),
    name,
    absPath: join(MIGRATIONS_DIR, filename),
  };
}

function listMigrations(): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `Migration directory missing at ${MIGRATIONS_DIR}. Expected SQL ` +
      `files following the pattern \`####_name.sql\`. If you cloned the ` +
      `repo without the src/db/migrations folder, restore it from git.`,
    );
  }
  const files = readdirSync(MIGRATIONS_DIR);
  const parsed = files
    .map(parseMigrationFilename)
    .filter((m): m is MigrationFile => m !== null)
    .sort((a, b) => a.version - b.version);
  if (parsed.length === 0) {
    throw new Error(
      `No migrations found in ${MIGRATIONS_DIR}. Expected at least ` +
      `0001_init.sql.`,
    );
  }
  return parsed;
}

interface SchemaRow {
  readonly version: number;
}

function readAppliedVersions(db: Database.Database): Set<number> {
  // schema_version may not exist yet (first ever run).
  const exists = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
    )
    .get();
  if (exists === undefined) return new Set();
  const rows = db
    .prepare<[], SchemaRow>(`SELECT version FROM schema_version`)
    .all();
  return new Set(rows.map((r) => r.version));
}

function applyMigration(db: Database.Database, m: MigrationFile): void {
  const sql = readFileSync(m.absPath, 'utf8');
  // Wrap in a transaction so a half-applied migration cannot land.
  // SQLite supports multi-statement SQL via `exec`; the WAL pragma in
  // 0001_init.sql is a no-op once the database is already WAL.
  const run = db.transaction(() => {
    db.exec(sql);
  });
  try {
    run();
  } catch (cause) {
    throw new Error(
      `Migration ${String(m.version).padStart(4, '0')}_${m.name}.sql ` +
      `failed to apply. The transaction was rolled back; database is ` +
      `still at its prior schema version. Original SQLite error follows ` +
      `as .cause.`,
      { cause },
    );
  }
}

export interface MigrateResult {
  readonly databasePath: string;
  readonly appliedNow: readonly number[];
  readonly alreadyApplied: readonly number[];
}

/**
 * Apply all pending migrations against the database at `dbPath`. Creates
 * the database file (and the parent directory) if missing. Idempotent.
 *
 * Inputs: absolute or relative path to the SQLite file.
 * Outputs: a record of which versions were applied this run vs. already
 *          applied.
 * Failure modes: throws Error with a specific cause when a migration
 *                fails to parse or apply. Caller catches and surfaces.
 */
export function migrate(dbPath: string): MigrateResult {
  const absDbPath = resolve(dbPath);
  const dir = dirname(absDbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(absDbPath);
  try {
    // Per-connection PRAGMAs MUST run before any transaction.
    // `journal_mode = WAL` raises SQLITE_ERROR inside a transaction;
    // `foreign_keys = ON` is silently ignored if set mid-txn. Setting
    // them here once per connection is correct and is the reason the
    // migration SQL files themselves do not (and must not) carry them.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const all = listMigrations();
    const already = readAppliedVersions(db);
    const appliedNow: number[] = [];
    for (const m of all) {
      if (already.has(m.version)) continue;
      applyMigration(db, m);
      appliedNow.push(m.version);
    }
    return {
      databasePath: absDbPath,
      appliedNow,
      alreadyApplied: [...already].sort((a, b) => a - b),
    };
  } finally {
    db.close();
  }
}

// CLI entry: `tsx src/db/migrate.ts`.
// Resolves JARVIS_DB_PATH from env, defaulting to ./data/jarvis.db.
const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const dbPath = process.env.JARVIS_DB_PATH ?? './data/jarvis.db';
  try {
    const result = migrate(dbPath);
    // Top-level CLI success report. Success goes to stdout by convention so
    // a redirect can capture the applied-versions summary; no project
    // logger configured at this scope (the migrate runner is single-binary).
    // eslint-disable-next-line no-console -- documented CLI exception above
    console.log(
      `[migrate] db=${result.databasePath} applied_now=[${result.appliedNow.join(',')}] ` +
      `already=[${result.alreadyApplied.join(',')}]`,
    );
  } catch (err) {
    // Top-level CLI catcher prints the chained cause so the developer
    // sees the root SQLite error, not a generic wrapper.
    console.error('[migrate] FAILED');
    console.error(err);
    process.exit(1);
  }
}
