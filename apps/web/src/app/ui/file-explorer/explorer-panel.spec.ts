import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Preferences, type WorkspacePreferences } from '../../prefs/preferences';
import { I18nCatalog, type I18nCatalogMap } from '../../i18n/catalog';
import { I18n } from '../../i18n/i18n';
import {
  INFORMATIONAL_CAPABILITIES,
  INACTIVE_STATUS,
  type ExplorerNode,
  type ExplorerTree,
} from './contract';
import { ExplorerPanel } from './explorer-panel';

class FileCatalog extends I18nCatalog {
  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    const raw = readFileSync(
      resolve(import.meta.dirname, `../../../../../../i18n/${locale}.json`),
      'utf8',
    );
    return Promise.resolve(JSON.parse(raw) as I18nCatalogMap);
  }
}

const doc = (id: string, patch: Partial<ExplorerNode> = {}, depth = 1): ExplorerNode => ({
  id,
  kind: 'buffer-pass',
  docId: id,
  name: id,
  depth,
  children: [],
  capabilities: {
    selectable: true,
    rename: true,
    duplicate: false,
    delete: true,
    reorder: true,
    toggleEnabled: true,
    ...patch.capabilities,
  },
  status: { ...INACTIVE_STATUS, ...patch.status },
  icon: 'layers',
  ...patch,
});

const group = (id: string, labelKey: string, children: ExplorerNode[]): ExplorerNode => ({
  id,
  kind: 'group',
  labelKey,
  depth: 0,
  children,
  capabilities: INFORMATIONAL_CAPABILITIES,
  status: INACTIVE_STATUS,
  icon: 'folder',
  defaultExpanded: true,
});

const sampleTree = (): ExplorerTree => ({
  view: 'files',
  nodes: [
    group('explorer:files:group:passes', 'explorer.group.passes', [
      doc('image', { kind: 'image-pass', name: 'Image' }),
      doc('buf-a', { name: 'Buffer A' }),
      doc('buf-b', { name: 'Buffer B' }),
    ]),
    group('explorer:files:group:project', 'explorer.group.project', [
      doc('@vertex', {
        kind: 'vertex',
        name: 'Vertex',
        capabilities: {
          selectable: true,
          rename: false,
          duplicate: false,
          delete: false,
          reorder: false,
          toggleEnabled: false,
        },
      }),
    ]),
  ],
});

function dispatchDragEvent(
  target: HTMLElement,
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: Pick<DataTransfer, 'setData' | 'getData' | 'dropEffect' | 'effectAllowed'> = {
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
    setData: () => undefined,
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  });
  target.dispatchEvent(event);
}

describe('ExplorerPanel', () => {
  const language = signal({ language: 'en' as 'en' | 'fr' });
  const tree = signal<ExplorerTree>(sampleTree());

  beforeEach(async () => {
    tree.set(sampleTree());
    TestBed.configureTestingModule({
      imports: [ExplorerPanel],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        { provide: I18nCatalog, useClass: FileCatalog },
        {
          provide: Preferences,
          useValue: {
            value: language.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) => {
              if (patch.language) language.set({ language: patch.language });
            },
          },
        },
      ],
    });
    await TestBed.inject(I18n).ensureLoaded('en');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const mount = () => {
    const fixture = TestBed.createComponent(ExplorerPanel);
    fixture.componentRef.setInput('tree', tree());
    fixture.detectChanges();
    return fixture;
  };

  it('renders nested hierarchy with group and document rows', () => {
    const fixture = mount();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
    expect(element.textContent).toContain('Image');
    expect(element.textContent).toContain('Buffer A');
  });

  it('emits select when a selectable row is clicked', () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const row = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(select).toHaveBeenCalledWith({ docId: 'buf-a' });
  });

  it('does not emit select for informational group rows', () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const row = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"]',
    ) as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(select).not.toHaveBeenCalled();
  });

  it('emits viewChange from the header switch', () => {
    const fixture = mount();
    const viewChange = vi.fn();
    fixture.componentInstance.viewChange.subscribe(viewChange);

    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(viewChange).toHaveBeenCalledWith('pipeline');
  });

  it('collapses groups when the expand control is clicked', () => {
    const fixture = mount();
    const expand = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"] .expand',
    ) as HTMLButtonElement;
    expand.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-node-id="image"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-node-id="buf-a"]')).toBeNull();
  });

  it('emits command events for header create actions', () => {
    const fixture = mount();
    const command = vi.fn();
    fixture.componentInstance.command.subscribe(command);

    fixture.componentInstance.collapse.emit();
    fixture.componentInstance.command.emit({ command: 'create-file' });
    expect(command).toHaveBeenCalledWith({ command: 'create-file' });
  });

  it('disables buffer creation when canCreateBuffer is false', () => {
    const fixture = mount();
    fixture.componentRef.setInput('canCreateBuffer', false);
    fixture.detectChanges();
    expect(fixture.componentInstance.canCreateBuffer()).toBe(false);
  });

  it('shows loading state instead of the tree', () => {
    tree.set({ view: 'files', nodes: [], emptyReason: 'loading' });
    const fixture = mount();
    expect(fixture.nativeElement.querySelector('[role="tree"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('mat-spinner')).not.toBeNull();
  });

  it('shows no-project empty state', () => {
    tree.set({ view: 'files', nodes: [], emptyReason: 'no-project' });
    const fixture = mount();
    expect(fixture.nativeElement.querySelector('.state.empty')).not.toBeNull();
  });

  it('marks active rows with aria-selected', () => {
    tree.set({
      ...sampleTree(),
      nodes: [
        group('explorer:files:group:passes', 'explorer.group.passes', [
          doc('image', {
            kind: 'image-pass',
            name: 'Image',
            status: { ...INACTIVE_STATUS, active: true },
          }),
        ]),
      ],
    });
    const fixture = mount();
    const active = fixture.nativeElement.querySelector('[data-node-id="image"]') as HTMLElement;
    expect(active.getAttribute('aria-selected')).toBe('true');
  });

  it('emits rename command on double-click when allowed', () => {
    const fixture = mount();
    const command = vi.fn();
    fixture.componentInstance.command.subscribe(command);

    const row = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    expect(command).toHaveBeenCalledWith({ command: 'rename', docId: 'buf-a' });
  });

  it('emits reorder intent for compatible drag-and-drop', () => {
    const fixture = mount();
    const reorder = vi.fn();
    fixture.componentInstance.reorder.subscribe(reorder);

    const source = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    const target = fixture.nativeElement.querySelector('[data-node-id="buf-b"]') as HTMLElement;

    const dataTransfer: Pick<DataTransfer, 'setData' | 'getData' | 'dropEffect' | 'effectAllowed'> = {
      dropEffect: 'none',
      effectAllowed: 'all',
      getData: () => '',
      setData: () => undefined,
    };
    dispatchDragEvent(source, 'dragstart', dataTransfer);
    dispatchDragEvent(target, 'drop', dataTransfer);
    fixture.detectChanges();

    expect(reorder).toHaveBeenCalledWith({
      sourceDocId: 'buf-a',
      targetDocId: 'buf-b',
      list: 'buffer',
    });
  });

  it('activates rows on Enter via keyboard handler', async () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const treeRoot = fixture.nativeElement.querySelector('#explorer-tree') as HTMLElement;
    treeRoot.focus();
    treeRoot.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    fixture.detectChanges();

    const groupRow = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"]',
    ) as HTMLElement;
    groupRow.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    fixture.detectChanges();

    const focusedRow = fixture.nativeElement.querySelector('[data-node-id="image"]') as HTMLElement;
    focusedRow.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    expect(select).toHaveBeenCalledWith({ docId: 'image' });
  });
});
