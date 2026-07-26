import { Pool } from 'pg';
import { afterAll, describe, it } from 'vitest';

import { runShaderLibraryConformance, type ConformanceHarness } from '../../library/conformance';
import type { AssetKey } from '../shader-repository';
import { PostgresRepository } from './postgres-repository';

/**
 * Runs the shared conformance suite against a real PostgreSQL, when one is
 * configured. Point `SHADER_TEST_DATABASE_URL` (or `DATABASE_URL`) at an
 * *empty, disposable* database — the harness drops and recreates its tables
 * between tests. Without a URL the suite is skipped rather than failing, so
 * `pnpm test` stays green on a machine with no PostgreSQL.
 *
 *   docker run --rm -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
 *   SHADER_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres pnpm --filter @shader-studio/backend test
 */
const url = process.env['SHADER_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

if (!url) {
  describe.skip('ShaderLibrary conformance (postgres)', () => {
    it('skipped — set SHADER_TEST_DATABASE_URL to run', () => undefined);
  });
} else {
  const sidePool = new Pool({ connectionString: url });
  afterAll(async () => {
    await sidePool.end();
  });

  const newHarness = (): ConformanceHarness => ({
    makeRepository: () => new PostgresRepository({ connectionString: url }),
    cleanup: async () => {
      await sidePool.query(
        'DROP TABLE IF EXISTS assets, presets, shaders, storage_metadata CASCADE',
      );
    },
    corruptProjectJson: async (id: string) => {
      // jsonb cannot hold invalid JSON, so store a degenerate-but-valid value;
      // the library must degrade to a default project rather than crash.
      await sidePool.query("UPDATE shaders SET project_json = 'null'::jsonb WHERE id = $1", [id]);
    },
    removeAssetRow: async (id: string, key: AssetKey) => {
      await sidePool.query('DELETE FROM assets WHERE shader_id = $1 AND asset_key = $2', [id, key]);
    },
  });

  runShaderLibraryConformance('postgres', newHarness);
}
