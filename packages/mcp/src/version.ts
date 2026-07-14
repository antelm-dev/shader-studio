import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads this package's own `version` field. Resolved relative to this file
 * rather than imported as JSON so the same code works both from `src/`
 * during development (`../package.json` = `packages/mcp/package.json`) and
 * from the bundled `dist/server.mjs` once published (npm always ships
 * `package.json` next to `dist/`, so the relative path still lands on it).
 *
 * Deliberately independent of `MCP_BRIDGE_PROTOCOL_VERSION` — the wire
 * protocol version and the npm package version are allowed to change on
 * different schedules.
 */
function readOwnVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readOwnVersion();
