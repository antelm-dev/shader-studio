import { Injectable, signal } from '@angular/core';

import type { UpdateState } from '@shader-studio/desktop-api/contracts';

const WEB_STATE: UpdateState = {
  status: 'unavailable',
  currentVersion: '',
  message: 'Les mises à jour sont gérées par votre navigateur.',
};

@Injectable({ providedIn: 'root' })
export class DesktopUpdater {
  readonly state = signal<UpdateState>(WEB_STATE);
  private readonly available = typeof window !== 'undefined' && 'electron' in window;

  constructor() {
    if (!this.available) return;
    void window.electron.bridge.update.state().then((state) => this.state.set(state));
    window.electron.bridge.update.onUpdateStateChanged((state) => this.state.set(state));
  }

  async check(): Promise<void> {
    if (!this.available) return;
    this.state.set(await window.electron.bridge.update.check());
  }

  update(): void {
    if (this.available) window.electron.bridge.update.install();
  }
}
