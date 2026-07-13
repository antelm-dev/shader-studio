import type { COMMANDS } from './constants.js';
import type { LoggerLike } from './logger.js';

/** One of the interactive stdin commands. */
export type Command = typeof COMMANDS extends Set<infer T> ? T : never;

/** Snapshot persisted to a pid file while an Electron process is running. */
export interface PidInfo {
  pid: number;
  startedAt: string;
  entry: string;
  args: string[];
  cwd: string;
}

/** Fully resolved parameters used to spawn an Electron process. */
export interface LaunchContext {
  cwd: string;
  env: Record<string, string>;
  entryFile: string;
  additionalArgs: string[];
  clearScreen: boolean;
}

/** Rollup output descriptor used to locate the bundled entry file. */
export interface BundleOutputLocation {
  dir?: string;
  file?: string;
}

/** Options accepted by {@link createElectronRunner}. */
export interface ElectronRunOptions {
  /** Entry file resolved against the bundle output directory. Defaults to `main.js`. */
  entry?: string;
  /**
   * Path to the Electron binary to launch. Defaults to resolving the `electron`
   * package. Set this when the `electron` package isn't resolvable from this
   * library (e.g. when it's linked into another project).
   */
  electronPath?: string;
  /** Debounce in ms before a rebuild triggers a restart. Defaults to `150`. */
  debounceMs?: number;
  /** Extra CLI args passed to the Electron binary before the entry file. */
  additionalArgs?: string[];
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra environment variables merged onto `process.env`. */
  env?: Record<string, string>;
  /** Enable interactive stdin commands (rs, start, stop, …). Defaults to `true`. */
  stdinControls?: boolean;
  /** Clear the terminal before each launch. Defaults to `false`. */
  clearScreen?: boolean;
  /** Custom logger. Defaults to a labelled console logger. */
  logger?: LoggerLike;
}
