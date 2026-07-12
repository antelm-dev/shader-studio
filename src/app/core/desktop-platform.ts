import { Injectable, computed, signal } from '@angular/core';

import type { Bundle, ImportMode } from '../../shared/model';

type WindowState = { maximized: boolean; fullscreen: boolean };

const IDLE_STATE: WindowState = { maximized: false, fullscreen: false };

@Injectable({ providedIn: 'root' })
export class DesktopPlatform {
  readonly available = typeof window !== 'undefined' && 'electron' in window;

  private readonly windowStateSignal = signal(IDLE_STATE);

  readonly maximized = computed(() => this.windowStateSignal().maximized);
  readonly fullscreen = computed(() => this.windowStateSignal().fullscreen);
  readonly outputOpen = signal(false);

  constructor() {
    if (!this.available) return;
    void window.electron.bridge.window.state().then((state) => this.windowStateSignal.set(state));
    window.electron.bridge.window.onStateChanged((state) => this.windowStateSignal.set(state));
    void window.electron.bridge.window.outputOpen().then((open) => this.outputOpen.set(open));
    window.electron.bridge.window.onOutputStateChanged((open) => this.outputOpen.set(open));
  }

  async openBundle(): Promise<{ name: string; bundle: unknown } | null> {
    if (!this.available) return null;
    const result = await window.electron.bridge.files.openBundle();
    if (result.status === 'cancelled') return null;
    if (result.status === 'error') throw new Error(result.message);
    return result.value;
  }

  async saveBundle(filename: string, bundle: Bundle): Promise<boolean> {
    if (!this.available) return false;
    const result = await window.electron.bridge.files.saveBundle(filename, bundle);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok';
  }

  async savePng(filename: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.available) return false;
    const result = await window.electron.bridge.files.savePng(filename, bytes);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok';
  }

  /** Raw bytes for a channel's image, or `null` if the shader has nothing assigned to it. */
  async readTexture(
    shaderId: string,
    channel: number,
  ): Promise<{ bytes: Uint8Array; ext: string } | null> {
    if (!this.available) return null;
    return window.electron.bridge.shader.readTexture(shaderId, channel);
  }

  migrationPending(): Promise<boolean> {
    return this.available ? window.electron.bridge.migration.pending() : Promise.resolve(false);
  }

  async migrate(): Promise<string | null> {
    const result = await window.electron.bridge.migration.select();
    if (result.status === 'cancelled') return null;
    if (result.status === 'error') throw new Error(result.message);
    return `Imported ${result.imported} shader${result.imported === 1 ? '' : 's'}${result.skipped ? `; skipped ${result.skipped}` : ''}`;
  }

  declineMigration(): Promise<void> {
    return window.electron.bridge.migration.decline();
  }

  onCloseRequested(listener: () => void): () => void {
    return this.available
      ? window.electron.bridge.window.onCloseRequested(listener)
      : () => undefined;
  }

  approveClose(approved: boolean): void {
    if (this.available) window.electron.bridge.window.approveClose(approved);
  }

  minimize(): void {
    if (this.available) window.electron.bridge.window.minimize();
  }

  toggleMaximize(): void {
    if (this.available) window.electron.bridge.window.toggleMaximize();
  }

  toggleFullscreen(): void {
    if (this.available) window.electron.bridge.window.toggleFullscreen();
  }

  openOutput(): void {
    if (this.available) window.electron.bridge.window.openOutput();
  }

  closeOutput(): void {
    if (this.available) window.electron.bridge.window.closeOutput();
  }

  close(): void {
    if (this.available) window.electron.bridge.window.close();
  }

  /** Keeps the import mode in the platform-neutral UI layer. */
  mode(value: ImportMode): ImportMode {
    return value;
  }
}
