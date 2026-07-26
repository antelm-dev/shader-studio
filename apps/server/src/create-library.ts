/**
 * Builds the shader storage the server runs on. PostgreSQL is selected whenever
 * `DATABASE_URL` is set (always the case under Docker Compose); without it, a
 * local SQLite file is used so `pnpm dev:server` and `ng serve` work with no
 * database to stand up. Either way the web app only ever sees the REST API —
 * the connection string never leaves this process.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ShaderLibrary } from '@shader-studio/backend/library';
import { createLegacyReader } from '@shader-studio/backend/persistence/legacy';
import type { ShaderRepository } from '@shader-studio/backend/persistence';

export async function createLibrary(): Promise<ShaderLibrary> {
  const repo = await createRepository();
  const library = new ShaderLibrary(repo);
  await library.init();

  const seed = process.env['SHADER_SEED'] !== '0';
  await library.installExamples(createLegacyReader(examplesDir()), seed);
  return library;
}

async function createRepository(): Promise<ShaderRepository> {
  const url = process.env['DATABASE_URL'];
  if (url) {
    // Imported lazily so `pg` stays out of the module graph unless it is used —
    // in particular, Angular's build-time route extraction (no DATABASE_URL)
    // must never try to resolve the external `pg` package.
    const { PostgresRepository } = await import('@shader-studio/backend/persistence/postgres');
    return new PostgresRepository({
      connectionString: url,
      maxPoolSize: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    });
  }

  // Development fallback: no DATABASE_URL, so persist to a local SQLite file.
  // `node:sqlite` is imported lazily so it never loads on the Postgres path.
  const { SqliteRepository } = await import('@shader-studio/backend/persistence/sqlite');
  const dir = process.env['SHADER_DATA_DIR'] ?? join(process.cwd(), 'data');
  await mkdir(dir, { recursive: true });
  console.warn(`[server] DATABASE_URL is not set — using a local SQLite database in ${dir}`);
  return new SqliteRepository({ location: join(dir, 'shader-studio.sqlite') });
}

/** The examples folder used for seeding: the env override, else the nearest `examples/` up the tree. */
function examplesDir(): string {
  const override = process.env['SHADER_EXAMPLES_DIR'];
  if (override) return override;

  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, 'examples', 'shaders'))) return join(current, 'examples');
    const parent = dirname(current);
    if (parent === current) return join(process.cwd(), 'examples');
    current = parent;
  }
}
