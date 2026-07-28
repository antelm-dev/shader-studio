import { describe, expect, it } from 'vitest';

/**
 * Characterization of the Electron output BrowserWindow open/close rules
 * encoded in `apps/desktop/main/src/main.ts` at the native-surfaces start
 * commit. Kept as a pure state-machine fixture under web tests because the
 * desktop package has no vitest target yet.
 *
 * Agent 04 must preserve these semantics while replacing the special case with
 * a generic surface manager (adapter for Agent 07).
 */

type OutputState = {
  open: boolean;
  focused: boolean;
  emissions: boolean[];
};

function createOutputController() {
  const state: OutputState = { open: false, focused: false, emissions: [] };

  return {
    state,
    openOutput(): void {
      if (state.open) {
        state.focused = true;
        return;
      }
      state.open = true;
      state.focused = true;
      state.emissions.push(true);
    },
    closeOutput(): void {
      if (!state.open) return;
      state.open = false;
      state.focused = false;
      state.emissions.push(false);
    },
    outputOpen(): boolean {
      return state.open;
    },
    /** Main window `closed` handler closes the satellite if present. */
    onMainClosed(): void {
      this.closeOutput();
    },
  };
}

describe('output window open/close characterization', () => {
  it('starts closed', () => {
    const controller = createOutputController();
    expect(controller.outputOpen()).toBe(false);
    expect(controller.state.emissions).toEqual([]);
  });

  it('opens once and emits output-state-changed(true)', () => {
    const controller = createOutputController();
    controller.openOutput();

    expect(controller.outputOpen()).toBe(true);
    expect(controller.state.emissions).toEqual([true]);
  });

  it('re-open focuses the existing window without a second open emission', () => {
    const controller = createOutputController();
    controller.openOutput();
    controller.state.focused = false;

    controller.openOutput();

    expect(controller.outputOpen()).toBe(true);
    expect(controller.state.focused).toBe(true);
    expect(controller.state.emissions).toEqual([true]);
  });

  it('close clears open state and emits false', () => {
    const controller = createOutputController();
    controller.openOutput();
    controller.closeOutput();

    expect(controller.outputOpen()).toBe(false);
    expect(controller.state.emissions).toEqual([true, false]);
  });

  it('closing the main window closes the output satellite', () => {
    const controller = createOutputController();
    controller.openOutput();
    controller.onMainClosed();

    expect(controller.outputOpen()).toBe(false);
    expect(controller.state.emissions).toEqual([true, false]);
  });
});
