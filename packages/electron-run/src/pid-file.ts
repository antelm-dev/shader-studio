import fs from 'node:fs';
import path from 'node:path';
import { PID_FILE_PREFIX } from './constants.js';
import type { LoggerLike } from './logger.js';
import type { LaunchContext, PidInfo } from './types.js';

/** Absolute path of a fresh pid file for the current process. */
export function pidFilePath(cwd: string, timestamp: number, pid: number): string {
  return path.resolve(cwd, `${PID_FILE_PREFIX}${timestamp}-${pid}.json`);
}

/** List every pid file currently present in `cwd`. */
export function listPidFiles(cwd: string): string[] {
  return fs
    .readdirSync(cwd)
    .filter((fileName) => fileName.startsWith(PID_FILE_PREFIX) && fileName.endsWith('.json'))
    .map((fileName) => path.resolve(cwd, fileName));
}

/** Read and parse a pid file, returning `null` on any read/parse failure. */
export function readPidInfo(filePath: string, logger: LoggerLike): PidInfo | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PidInfo;
  } catch (error) {
    logger.warn(`Error reading pid file: ${filePath}`, error);
    return null;
  }
}

/** Delete a pid file if it exists. */
export function removePidFile(filePath: string | null, logger: LoggerLike): void {
  if (!filePath) {
    logger.warn('No pid file provided to removePidFile');
    return;
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/** Persist a launch snapshot to `filePath`. */
export function writePidFile(
  filePath: string,
  context: LaunchContext,
  pid: number,
  startedAt: string,
): void {
  const info: PidInfo = {
    pid,
    startedAt,
    entry: context.entryFile,
    args: context.additionalArgs,
    cwd: context.cwd,
  };

  fs.writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8');
}
