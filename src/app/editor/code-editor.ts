import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
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
import type { CompileDiagnostic } from '../core/diagnostic';
import {
  GLSL_LANGUAGE_ID,
  JSON_LANGUAGE_ID,
  THEME_IDS,
  loadMonaco,
  type MonacoApi,
} from './monaco-loader';

export type EditorLanguage = 'glsl' | 'json';

/**
 * A Monaco instance bound to a signal.
 *
 * Deliberately dumb: it renders whatever `value` it is given and reports edits
 * through `valueChange`. It holds no opinion about shaders, which is what lets
 * the same component back the fragment, vertex and config tabs.
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

  readonly valueChange = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);

  private readonly monaco = signal<MonacoApi | null>(null);
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;

  readonly ready = signal(false);

  /**
   * Set while we are writing into the model ourselves, so the resulting change
   * event is not echoed back out as if the user had typed it.
   */
  private applying = false;

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

    // `setTheme` is global to Monaco, not scoped to one editor; every instance
    // asking for the same theme is harmless and keeps them all in step.
    effect(() => {
      const monaco = this.monaco();
      const theme = THEME_IDS[this.colorScheme()];
      untracked(() => monaco?.editor.setTheme(theme));
    });
  }

  private async boot(): Promise<void> {
    const monaco = await loadMonaco();

    const editor = monaco.editor.create(this.host().nativeElement, {
      value: untracked(this.value),
      language: this.monacoLanguage(untracked(this.language)),
      theme: THEME_IDS[untracked(this.colorScheme)],
      readOnly: untracked(this.readOnly),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: `'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace`,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: 'line',
      tabSize: 2,
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
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
