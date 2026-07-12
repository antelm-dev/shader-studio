import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import type { ColorScheme } from '../core/preferences';
import {
  DEFAULT_EDITOR_APPEARANCE,
  fontFamilyStack,
  type EditorAppearance,
} from '../core/editor-prefs';
import type { CompileDiagnostic } from '../core/diagnostic';
import { ReducedMotion } from '../core/reduced-motion';
import { FontLoader, findFont, nearestWeight } from './google-fonts';
import { monacoThemeId, resolveThemeId } from './editor-themes';
import { GLSL_LANGUAGE_ID, JSON_LANGUAGE_ID, loadMonaco, type MonacoApi } from './monaco-loader';

export type EditorLanguage = 'glsl' | 'json';

/**
 * A Monaco instance bound to a signal.
 *
 * Deliberately dumb: it renders whatever `value` it is given, dresses itself in
 * whatever `appearance` it is given, and reports edits through `valueChange`. It
 * holds no opinion about shaders, which is what lets the same component back the
 * fragment, vertex and config tabs.
 *
 * It also never rebuilds itself. Every input is applied to the *live* editor
 * through `updateOptions`, because tearing down a Monaco instance takes the undo
 * stack, the cursor and the scroll position with it — and this component is
 * moved between a docked panel and a floating window at the user's whim.
 */
@Component({
  selector: 'app-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #host class="editor-host"></div>
    @if (!ready()) {
      <div class="editor-loading">Loading editor…</div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      min-height: 0;
    }

    .editor-host {
      width: 100%;
      height: 100%;
    }

    .editor-loading {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class CodeEditor {
  readonly value = input.required<string>();
  readonly language = input<EditorLanguage>('glsl');
  readonly diagnostics = input<readonly CompileDiagnostic[]>([]);
  readonly readOnly = input(false);
  readonly colorScheme = input<ColorScheme>('dark');
  readonly appearance = input<EditorAppearance>(DEFAULT_EDITOR_APPEARANCE);

  readonly valueChange = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private readonly fonts = inject(FontLoader);
  private readonly reducedMotion = inject(ReducedMotion);

  private readonly monaco = signal<MonacoApi | null>(null);
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;

  readonly ready = signal(false);

  /**
   * Set while we are writing into the model ourselves, so the resulting change
   * event is not echoed back out as if the user had typed it.
   */
  private applying = false;

  /**
   * The Monaco options implied by the current appearance.
   *
   * Motion is the one thing the user does not get the last word on: someone who
   * has asked their OS for less of it means it here too, and a cursor that
   * pulses or a viewport that glides is exactly what they asked to be spared.
   */
  private readonly options = computed<Monaco.editor.IEditorOptions>(() => {
    const appearance = this.appearance();
    const still = this.reducedMotion.enabled();
    const font = findFont(appearance.fontFamily);

    return {
      fontFamily: fontFamilyStack(appearance.fontFamily),
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      fontWeight: String(nearestWeight(appearance.fontFamily, appearance.fontWeight)),
      // Asking a face without ligatures for its ligatures is harmless, but it
      // also turns on kerning and contextual alternates that some of these fonts
      // do surprising things with. Only opt in where there is something to gain.
      fontLigatures: appearance.ligatures && (font?.ligatures ?? false),
      tabSize: appearance.tabSize,
      wordWrap: appearance.wordWrap,
      minimap: { enabled: appearance.minimap },
      lineNumbers: appearance.lineNumbers ? 'on' : 'off',
      bracketPairColorization: { enabled: appearance.bracketPairs },
      guides: { bracketPairs: appearance.bracketPairs },
      renderWhitespace: appearance.renderWhitespace ? 'all' : 'none',
      stickyScroll: { enabled: appearance.stickyScroll },
      cursorBlinking: still ? 'solid' : appearance.cursorBlinking,
      smoothScrolling: !still,
      cursorSmoothCaretAnimation: still ? 'off' : 'on',
    };
  });

  constructor() {
    afterNextRender(() => void this.boot());

    effect(() => {
      const monaco = this.monaco();
      const value = this.value();
      if (!monaco || !this.editor) return;

      // Only when it genuinely differs: assigning the value resets the cursor
      // and the undo stack, which would be maddening mid-keystroke.
      if (this.editor.getValue() !== value) {
        this.applying = true;
        this.editor.setValue(value);
        this.applying = false;
      }
    });

    effect(() => {
      const monaco = this.monaco();
      const diagnostics = this.diagnostics();
      const language = this.language();
      if (!monaco || !this.editor) return;

      const model = this.editor.getModel();
      if (!model) return;

      monaco.editor.setModelMarkers(
        model,
        'shader-studio',
        diagnostics.map((diagnostic) => this.toMarker(monaco, model, diagnostic, language)),
      );
    });

    effect(() => {
      const readOnly = this.readOnly();
      untracked(() => this.editor?.updateOptions({ readOnly }));
    });

    // Appearance, applied live. Nothing here recreates the editor.
    effect(() => {
      const options = this.options();
      untracked(() => this.editor?.updateOptions(options));
    });

    // `setTheme` is global to Monaco, not scoped to one editor; every instance
    // asking for the same theme is harmless and keeps them all in step.
    effect(() => {
      const monaco = this.monaco();
      const theme = monacoThemeId(resolveThemeId(this.appearance().theme, this.colorScheme()));
      untracked(() => monaco?.editor.setTheme(theme));
    });

    // Fetch the chosen family, then tell Monaco to measure again. Monaco caches
    // character widths on first paint; without the remeasure a font that lands a
    // moment later renders at the *fallback's* metrics — every glyph correct and
    // every cursor position wrong.
    effect(() => {
      const family = this.appearance().fontFamily;
      const monaco = this.monaco();
      if (!monaco) return;

      untracked(() => {
        void this.fonts.load(family).then((status) => {
          if (status === 'loaded') monaco.editor.remeasureFonts();
        });
      });
    });
  }

  /**
   * Re-measure and re-lay-out. Monaco's `automaticLayout` watches the host with a
   * ResizeObserver, which covers dragging and resizing; this exists for the cases
   * it cannot see — a tab that was hidden while its container changed size, and a
   * panel restored from a mode where it had no size at all.
   */
  layout(): void {
    this.editor?.layout();
  }

  focus(): void {
    this.editor?.focus();
  }

  private async boot(): Promise<void> {
    const monaco = await loadMonaco();

    const editor = monaco.editor.create(this.host().nativeElement, {
      value: untracked(this.value),
      language: this.monacoLanguage(untracked(this.language)),
      theme: monacoThemeId(
        resolveThemeId(untracked(this.appearance).theme, untracked(this.colorScheme)),
      ),
      readOnly: untracked(this.readOnly),
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      ...untracked(this.options),
    });

    editor.onDidChangeModelContent(() => {
      if (this.applying) return;
      this.valueChange.emit(editor.getValue());
    });

    this.editor = editor;
    this.monaco.set(monaco);
    this.ready.set(true);

    this.destroyRef.onDestroy(() => {
      editor.getModel()?.dispose();
      editor.dispose();
    });
  }

  private monacoLanguage(language: EditorLanguage): string {
    return language === 'json' ? JSON_LANGUAGE_ID : GLSL_LANGUAGE_ID;
  }

  /**
   * Diagnostics with no line (link errors, schema errors) are pinned to line 1
   * rather than dropped — an error you cannot see is worse than one in the
   * wrong place, and the message itself says what is wrong.
   */
  private toMarker(
    monaco: MonacoApi,
    model: Monaco.editor.ITextModel,
    diagnostic: CompileDiagnostic,
    language: EditorLanguage,
  ): Monaco.editor.IMarkerData {
    const line = Math.min(Math.max(diagnostic.line || 1, 1), model.getLineCount());
    const content = model.getLineContent(line);
    const start = content.search(/\S/);

    return {
      severity:
        diagnostic.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Error,
      message: diagnostic.message,
      startLineNumber: line,
      endLineNumber: line,
      startColumn: start < 0 ? 1 : start + 1,
      endColumn: content.length + 1,
      source: language,
    };
  }
}
