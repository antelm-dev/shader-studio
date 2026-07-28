import { Directive, inject } from '@angular/core';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import { MenuCommands } from '../menu-commands';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { WorkspaceActions } from '../workspace-actions';
import { OpenDocuments } from '../editor/open-documents';

/**
 * The window-level keyboard shortcuts and the unsaved-changes prompt on tab
 * close, lifted out of `App` as a host directive so the root component's own
 * class stays about layout.
 *
 * The split matters. The chorded shortcuts — Ctrl+S, Ctrl+N, the tab
 * shortcuts — work *while you are typing*, because that is exactly when you
 * want them: saving and switching files are things you do with your hands on
 * the keyboard, mid-edit. The bare-letter ones (Space, H, S) are ignored
 * inside a text field or the code editor, where they are simply characters.
 */
@Directive({
  selector: '[appGlobalShortcuts]',
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:beforeunload)': 'onBeforeUnload($event)',
  },
})
export class GlobalShortcuts {
  private readonly store = inject(ShaderStore);
  private readonly preferences = inject(Preferences);
  private readonly desktop = inject(DesktopPlatform);
  private readonly commands = inject(MenuCommands);
  private readonly workspace = inject(WorkspaceActions);
  private readonly openDocs = inject(OpenDocuments);

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    if (event.key === 'F11' && this.desktop.available) {
      event.preventDefault();
      this.desktop.toggleFullscreen();
      return;
    }

    if (this.onChordKeydown(event)) return;
    if (this.isTyping(event.target)) return;

    switch (event.key.toLowerCase()) {
      case ' ':
        event.preventDefault();
        this.preferences.patch({ paused: !this.preferences.value().paused });
        break;
      case 'h':
        this.commands.toggle('guiVisible');
        break;
      case 's':
        this.commands.captureImage();
        break;
      default:
        break;
    }
  }

  /** Returns true when the event was one of ours and has been handled. */
  private onChordKeydown(event: KeyboardEvent): boolean {
    const chord = event.ctrlKey || event.metaKey;
    if (!chord) return false;

    const key = event.key.toLowerCase();

    switch (key) {
      case 's':
        event.preventDefault();
        void this.store.save();
        return true;

      case 'n':
        event.preventDefault();
        void this.workspace.createFile();
        return true;

      // Run/compile. The preview already recompiles as you type, so this is the
      // "do it *now*" that a debounce always makes someone want.
      case 'enter':
        event.preventDefault();
        this.store.recompile();
        return true;

      case 'w': {
        event.preventDefault();
        const activeId = this.store.activeDoc()?.id;
        if (activeId) this.openDocs.close(activeId);
        return true;
      }

      // The classic editor convention for a bottom panel. Handled here, ahead
      // of `isTyping`, so it also works while Monaco has focus.
      case 'j':
        event.preventDefault();
        this.commands.toggle('bottomPanelOpen');
        return true;

      case 'pageup':
        event.preventDefault();
        this.openDocs.cycle(-1);
        return true;

      case 'pagedown':
        event.preventDefault();
        this.openDocs.cycle(1);
        return true;

      default:
        break;
    }

    // Ctrl+1…9 opens the nth *open* tab, the way every editor with tabs does.
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const docId = this.openDocs.openIds()[digit - 1];
      if (docId) {
        event.preventDefault();
        this.openDocs.activate(docId);
        return true;
      }
    }

    return false;
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.desktop.available || !this.store.dirty()) return;
    this.store.flushRecovery();
    event.preventDefault();
    event.returnValue = '';
  }

  private isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.closest('.monaco-editor') !== null
    );
  }
}
