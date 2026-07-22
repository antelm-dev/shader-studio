/**
 * A tiny, engine-neutral migration driver. Each engine supplies an ordered list
 * of `Migration`s and a pair of hooks that read and write the current schema
 * version (SQLite uses `PRAGMA user_version`, Postgres a `storage_metadata`
 * row). The runner applies every migration whose version is greater than the
 * stored one, in order, and records progress as it goes.
 *
 * Design constraints (see the storage brief):
 *   - migrations run before any API/IPC is exposed;
 *   - they are idempotent at the runner level (already-applied versions are
 *     skipped);
 *   - they never run implicitly beyond this explicit call;
 *   - they fail loudly if the database cannot be brought to the target version.
 *
 * Transaction handling is the engine's job: `runMigrations` is called *inside*
 * whatever transactional scope the engine wants (a single SQLite transaction,
 * or a Postgres advisory-locked transaction), so a half-applied migration rolls
 * back rather than leaving the schema wedged between versions.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Runs the DDL/DML for this step using the engine's statement executor. */
  up(exec: (sql: string) => void | Promise<void>): void | Promise<void>;
}

export interface MigrationContext {
  /** Returns the highest version already applied (0 on a fresh database). */
  getVersion(): number | Promise<number>;
  setVersion(version: number): void | Promise<void>;
  exec(sql: string): void | Promise<void>;
}

/** The version the given migration list brings a database up to. */
export function targetVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

export async function runMigrations(
  migrations: readonly Migration[],
  ctx: MigrationContext,
): Promise<number> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertContiguous(ordered);

  const current = await ctx.getVersion();
  const target = targetVersion(ordered);
  if (current > target) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${target}). ` +
        'Refusing to start against a future schema.',
    );
  }

  let applied = current;
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    await migration.up(ctx.exec);
    await ctx.setVersion(migration.version);
    applied = migration.version;
  }

  if (applied !== target) {
    throw new Error(`Migrations left the database at version ${applied}, expected ${target}.`);
  }
  return applied;
}

/** Guards against a mis-authored list — versions must be 1..N with no gaps or dupes. */
function assertContiguous(ordered: readonly Migration[]): void {
  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration list is not contiguous: expected version ${index + 1}, got ${migration.version} (${migration.name}).`,
      );
    }
  });
}
