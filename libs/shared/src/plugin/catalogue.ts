/**
 * The official plugin catalogue shipped with each app release.
 *
 * It is a trusted app asset (`plugins/catalogue.json`, beside the package
 * files it lists), not a remote registry: browsing it reads JSON and runs no
 * plugin code. Each entry pins one immutable package file by size and SHA-256
 * and repeats its identity, so the host can check the bytes it fetched are the
 * ones this release was built with before they reach the usual review and
 * installation. The hash is an integrity check, not a publisher signature.
 */
import { isCleanString, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import { PACKAGE_ID_PATTERN } from './ids';

export const CATALOGUE_FORMAT = 'shadergrove-plugin-catalogue/v1';
/** Where the catalogue lives, relative to the app's base URL. */
export const CATALOGUE_PATH = 'plugins/catalogue.json';
export const CATALOGUE_MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 32;

export interface CatalogueContribution {
  kind: string;
  id: string;
  name: string;
}

export interface CatalogueEntry {
  id: string;
  version: string;
  name: string;
  description: string;
  publisher: string;
  license: string;
  protocolVersion: number;
  appVersionRange: string;
  /** A leaf file name beside the catalogue. */
  file: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string;
  contributions: CatalogueContribution[];
}

export interface PluginCatalogue {
  format: typeof CATALOGUE_FORMAT;
  packages: CatalogueEntry[];
}

const ENTRY_KEYS = [
  'id',
  'version',
  'name',
  'description',
  'publisher',
  'license',
  'protocolVersion',
  'appVersionRange',
  'file',
  'bytes',
  'sha256',
  'contributions',
];
const FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}\.sgplugin\.json$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function validateCatalogue(input: unknown): Result<PluginCatalogue> {
  if (!isRecord(input)) return fail('catalogue must be an object');
  if (input['format'] !== CATALOGUE_FORMAT)
    return fail(`catalogue.format must be ${CATALOGUE_FORMAT}`);
  const extra = Object.keys(input).find((key) => key !== 'format' && key !== 'packages');
  if (extra) return fail(`catalogue.${extra} is not a known field`);
  const packages = input['packages'];
  if (!Array.isArray(packages) || packages.length > MAX_ENTRIES) {
    return fail(`catalogue.packages must have at most ${MAX_ENTRIES} entries`);
  }
  const entries: CatalogueEntry[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of packages.entries()) {
    const at = `catalogue.packages[${index}]`;
    if (!isRecord(raw)) return fail(`${at} must be an object`);
    const unknownKey = Object.keys(raw).find((key) => !ENTRY_KEYS.includes(key));
    if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
    const { id, version, protocolVersion, appVersionRange, file, bytes, sha256, contributions } =
      raw;
    if (typeof id !== 'string' || !PACKAGE_ID_PATTERN.test(id)) return fail(`${at}.id is invalid`);
    if (ids.has(id)) return fail(`${at}.id "${id}" is listed twice`);
    ids.add(id);
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      return fail(`${at}.version is invalid`);
    }
    for (const field of ['name', 'publisher', 'license'] as const) {
      const value = raw[field];
      if (!isCleanString(value) || value.trim() === '' || value.length > 64) {
        return fail(`${at}.${field} must be 1–64 characters of plain text`);
      }
    }
    const description = raw['description'];
    if (!isCleanString(description) || description.length > 300) {
      return fail(`${at}.description must be at most 300 characters of plain text`);
    }
    if (!Number.isInteger(protocolVersion)) return fail(`${at}.protocolVersion is invalid`);
    if (typeof appVersionRange !== 'string' || appVersionRange.length > 64) {
      return fail(`${at}.appVersionRange is invalid`);
    }
    if (typeof file !== 'string' || !FILE_PATTERN.test(file)) {
      return fail(`${at}.file must be a leaf *.sgplugin.json name`);
    }
    if (!Number.isInteger(bytes) || (bytes as number) < 1 || (bytes as number) > 1024 * 1024) {
      return fail(`${at}.bytes is invalid`);
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      return fail(`${at}.sha256 must be 64 lowercase hex digits`);
    }
    if (!Array.isArray(contributions) || contributions.length === 0 || contributions.length > 32) {
      return fail(`${at}.contributions must have 1 to 32 entries`);
    }
    const summary: CatalogueContribution[] = [];
    for (const contribution of contributions) {
      if (
        !isRecord(contribution) ||
        Object.keys(contribution).length !== 3 ||
        !isCleanString(contribution['kind']) ||
        !isCleanString(contribution['id']) ||
        !isCleanString(contribution['name']) ||
        (contribution['name'] as string).length > 64
      ) {
        return fail(`${at}.contributions entries must be { kind, id, name }`);
      }
      summary.push({
        kind: contribution['kind'] as string,
        id: contribution['id'] as string,
        name: contribution['name'] as string,
      });
    }
    entries.push({
      id,
      version,
      name: raw['name'] as string,
      description,
      publisher: raw['publisher'] as string,
      license: raw['license'] as string,
      protocolVersion: protocolVersion as number,
      appVersionRange,
      file,
      bytes: bytes as number,
      sha256,
      contributions: summary,
    });
  }
  return ok({ format: CATALOGUE_FORMAT, packages: entries });
}
