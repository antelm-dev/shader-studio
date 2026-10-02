import type { StoredPlugin } from '@shadergrove/desktop-api/contracts';

export type { StoredPlugin };

/**
 * Where installed plugins live between sessions. The text kept is the package
 * file as picked; `PluginInstallations` revalidates it on every load.
 */
export interface PluginStore {
  list(): Promise<StoredPlugin[]>;
  /** Keyed by `record.id`, the id from the package's own manifest. */
  put(record: StoredPlugin): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * The browser's: one IndexedDB database per profile — a signed-in account or
 * the anonymous session — so one account never sees, or runs, packages another
 * installed on the same machine.
 */
export class IndexedDbPluginStore implements PluginStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name: string) {}

  /**
   * Each record under its own key, whatever it holds: a value damaged outside
   * the app comes back with an empty text — listed as invalid, removable by that
   * key — instead of failing the whole list.
   */
  async list(): Promise<StoredPlugin[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const records: StoredPlugin[] = [];
      const request = db.transaction('plugins', 'readonly').objectStore('plugins').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(records);
        const value = cursor.value as Partial<StoredPlugin> | null;
        records.push({
          id: String(cursor.key),
          text: typeof value?.text === 'string' ? value.text : '',
          enabled: value?.enabled === true,
          installedAt: typeof value?.installedAt === 'string' ? value.installedAt : '',
        });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async put(record: StoredPlugin): Promise<void> {
    await this.request('readwrite', (store) => store.put(record, record.id));
  }

  async remove(id: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(id));
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('plugins');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async request(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // Settled by the transaction, not the request: a write is only saved once it commits,
      // and a commit can still abort (quota, disk) after the request succeeded.
      const transaction = db.transaction('plugins', mode);
      const request = run(transaction.objectStore('plugins'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  }
}

/** The desktop app's: files under `<userData>/plugins`, written by the main process. */
export class DesktopPluginStore implements PluginStore {
  list(): Promise<StoredPlugin[]> {
    return window.electron.bridge.plugins.list();
  }

  async put(record: StoredPlugin): Promise<void> {
    // The main process checks the id against the package itself.
    await window.electron.bridge.plugins.put(record);
  }

  async remove(id: string): Promise<void> {
    await window.electron.bridge.plugins.remove(id);
  }
}

/** Where there is nowhere to keep anything: the server, or a browser without IndexedDB. */
export class NoPluginStore implements PluginStore {
  async list(): Promise<StoredPlugin[]> {
    return [];
  }
  async put(): Promise<void> {
    throw new Error('Plugins cannot be installed here');
  }
  async remove(): Promise<void> {}
}
