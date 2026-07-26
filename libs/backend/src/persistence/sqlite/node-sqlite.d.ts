/**
 * Minimal ambient declarations for the subset of Node's built-in `node:sqlite`
 * module this package uses. `@types/node@20` does not ship them yet; declaring
 * them here avoids a monorepo-wide type bump. When `@types/node` gains
 * `node:sqlite` these can be deleted.
 */
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;
  export type SQLRow = Record<string, SQLOutputValue>;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): SQLRow | undefined;
    all(...params: SQLInputValue[]): SQLRow[];
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
