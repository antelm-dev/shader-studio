import { Injectable, signal } from '@angular/core';

/**
 * Structured application output: shader compiler and renderer messages today,
 * with room for the workspace and the MCP bridge to add their own.
 *
 * Deliberately not `console.*`. Monkey-patching the console would capture
 * everything the browser or Electron itself logs, most of which has nothing
 * to do with the shader — and would still leave the messages unstructured,
 * with no level, source or bounded history. Every producer that wants to
 * reach the Output tab calls this service directly instead.
 *
 * Session-scoped on purpose: entries are never written to `Preferences`, so
 * a reload starts from an empty log rather than replaying yesterday's errors.
 */
export type OutputLogLevel = 'info' | 'warning' | 'error';

export type OutputLogSource = 'compiler' | 'renderer' | 'workspace' | 'mcp';

export interface OutputLogEntry {
  id: number;
  timestamp: number;
  level: OutputLogLevel;
  source: OutputLogSource;
  message: string;
}

/** Roughly how many entries the log keeps before dropping the oldest. */
const MAX_ENTRIES = 500;

@Injectable({ providedIn: 'root' })
export class OutputLog {
  private nextId = 1;
  private readonly state = signal<readonly OutputLogEntry[]>([]);

  readonly entries = this.state.asReadonly();

  write(level: OutputLogLevel, source: OutputLogSource, message: string): void {
    const entry: OutputLogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      source,
      message,
    };

    this.state.update((entries) => {
      const next =
        entries.length >= MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES + 1) : entries;
      return [...next, entry];
    });
  }

  info(source: OutputLogSource, message: string): void {
    this.write('info', source, message);
  }

  warning(source: OutputLogSource, message: string): void {
    this.write('warning', source, message);
  }

  error(source: OutputLogSource, message: string): void {
    this.write('error', source, message);
  }

  clear(): void {
    this.state.set([]);
  }
}
