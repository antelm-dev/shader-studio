import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { MenuCommands } from '../menu-commands';
import { OpenDocuments } from '../editor/open-documents';
import { WorkspaceActions } from '../workspace-actions';
import { GlobalShortcuts } from './global-shortcuts';

@Component({
  selector: 'host-with-global-shortcuts',
  imports: [GlobalShortcuts],
  template: `<div appGlobalShortcuts></div>`,
})
class HostWithGlobalShortcuts {}

function chordEvent(
  key: string,
  init: Partial<KeyboardEventInit> & { target?: EventTarget } = {},
): KeyboardEvent {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...rest,
  });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('GlobalShortcuts', () => {
  const toggleDevTools = vi.fn();
  const save = vi.fn();
  const createFile = vi.fn();
  const toggle = vi.fn();
  const captureImage = vi.fn();
  const close = vi.fn();
  const cycle = vi.fn();
  const activate = vi.fn();
  const toggleFullscreen = vi.fn();
  const patch = vi.fn();
  let desktopAvailable = true;

  beforeEach(() => {
    toggleDevTools.mockReset();
    save.mockReset();
    createFile.mockReset();
    toggle.mockReset();
    captureImage.mockReset();
    close.mockReset();
    cycle.mockReset();
    activate.mockReset();
    toggleFullscreen.mockReset();
    patch.mockReset();
    desktopAvailable = true;

    TestBed.configureTestingModule({
      imports: [HostWithGlobalShortcuts],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DesktopPlatform,
          useValue: {
            get available() {
              return desktopAvailable;
            },
            toggleDevTools,
            toggleFullscreen,
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            save,
            dirty: () => false,
            flushRecovery: () => undefined,
            recompile: () => undefined,
            activeDoc: () => ({ id: 'doc-1' }),
          },
        },
        {
          provide: Preferences,
          useValue: {
            value: signal({ paused: false, guiVisible: true }).asReadonly(),
            patch,
          },
        },
        {
          provide: MenuCommands,
          useValue: { toggle, captureImage },
        },
        {
          provide: WorkspaceActions,
          useValue: { createFile },
        },
        {
          provide: OpenDocuments,
          useValue: {
            close,
            cycle,
            activate,
            openIds: () => ['doc-1'],
          },
        },
      ],
    });

    TestBed.createComponent(HostWithGlobalShortcuts).detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('toggles DevTools on Ctrl+Shift+I when desktop is available', () => {
    const event = chordEvent('i', { ctrlKey: true, shiftKey: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(toggleDevTools).toHaveBeenCalledOnce();
  });

  it('accepts Meta+Shift+I the same way as Ctrl+Shift+I', () => {
    window.dispatchEvent(chordEvent('I', { metaKey: true, shiftKey: true }));
    expect(toggleDevTools).toHaveBeenCalledOnce();
  });

  it('does not toggle on Ctrl+I or Shift+I alone', () => {
    window.dispatchEvent(chordEvent('i', { ctrlKey: true }));
    window.dispatchEvent(chordEvent('i', { shiftKey: true }));
    expect(toggleDevTools).not.toHaveBeenCalled();
  });

  it('ignores Ctrl+Shift+I when desktop is unavailable', () => {
    desktopAvailable = false;
    const event = chordEvent('i', { ctrlKey: true, shiftKey: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(toggleDevTools).not.toHaveBeenCalled();
  });

  it('handles Ctrl+Shift+I while Monaco has focus', () => {
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    document.body.appendChild(monaco);
    try {
      const event = chordEvent('i', { ctrlKey: true, shiftKey: true, target: monaco });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(toggleDevTools).toHaveBeenCalledOnce();
    } finally {
      monaco.remove();
    }
  });

  it('ignores key-repeat for Ctrl+Shift+I so DevTools does not flicker', () => {
    const event = chordEvent('i', { ctrlKey: true, shiftKey: true, repeat: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(toggleDevTools).not.toHaveBeenCalled();
  });

  it('still treats Ctrl+S as a chord ahead of the typing guard', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const event = chordEvent('s', { ctrlKey: true, target: input });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(save).toHaveBeenCalledOnce();
    } finally {
      input.remove();
    }
  });

  it('ignores bare letter shortcuts while typing', () => {
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    try {
      window.dispatchEvent(chordEvent('h', { target: input }));
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });
});
