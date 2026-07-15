 import { Injectable, signal } from '@angular/core';

export type WorkspaceWindow = 'editor' | 'preview';

/**
 * The foreground window in the shared workspace.
 *
 * The preview and editor live in different parts of the DOM, so DOM order
 * cannot express which one the user most recently interacted with. Keeping the
 * choice here gives both frames one small, explicit source of stacking order.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceWindowStack {
  private readonly foreground = signal<WorkspaceWindow>('preview');

  readonly active = this.foreground.asReadonly();

  activate(window: WorkspaceWindow): void {
    this.foreground.set(window);
  }

  zIndex(window: WorkspaceWindow): number {
    return this.foreground() === window ? 4 : 3;
  }
}
