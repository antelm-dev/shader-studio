import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runShaderLibraryConformance, type ConformanceHarness } from '../../library/conformance';
import type { AssetKey } from '../shader-repository';
import { SqliteRepository } from './sqlite-repository';

function newHarness(): ConformanceHarness {
  const dir = mkdtempSync(join(tmpdir(), 'ss-sqlite-'));
  const file = join(dir, 'store.sqlite');

  const side = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };

  return {
    makeRepository: () => new SqliteRepository({ location: file }),
    cleanup: async () => {
      // Best-effort: a just-closed WAL handle can linger a beat on Windows.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir; the OS reclaims it */
      }
    },
    corruptProjectJson: async (id: string) =>
      side((db) => {
        db.prepare('UPDATE shaders SET project_json = ? WHERE id = ?').run('{ not json', id);
      }),
    removeAssetRow: async (id: string, key: AssetKey) =>
      side((db) => {
        db.prepare('DELETE FROM assets WHERE shader_id = ? AND asset_key = ?').run(id, key);
      }),
  };
}

runShaderLibraryConformance('sqlite', newHarness);
