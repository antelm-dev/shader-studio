# Editor-local file explorer — implementation contract

This document turns the MVP in [README.md](README.md) into a concrete contract
grounded in the current Shader Studio repository. Agents 02–04 must treat the
decisions here as fixed unless the coordinator explicitly revises the contract.

## Scope

### MVP behavior

- A **collapsible, resizable vertical explorer** attached to the **left side of
  the code editor** inside `app-editor-panel` (integration is agent 05).
- The explorer lives inside the editor window in every editor-window mode
  (docked, floating, maximized, minimized toolbar-only). It is not a separate
  OS window and does not replace the shader-library browser.
- Two views:
  - **Files** — passes, include files, vertex shader, and config schema.
  - **Pipeline** — Common pass, execution order, per-pass channel bindings.
- **Single click** on a selectable row calls `ShaderStore.selectDoc(docId)` and
  activates the existing editor tab for that document. Editor tabs remain in the
  MVP toolbar.
- Row presentation surfaces, without relying on colour alone:
  - active document
  - disabled buffer passes
  - project-level dirty state on compilable documents
  - per-document compiling state
  - per-document error counts
- **Context commands** reuse existing store / `WorkspaceActions` flows (create,
  rename, duplicate, enable/disable, reorder, delete). The explorer does not
  reimplement mutations or confirmation dialogs.
- **Persisted UI state** (agent 04): open/collapsed, selected view, width.
- At **narrow editor widths** the explorer becomes an **in-panel overlay/drawer**
  so Monaco keeps usable width.
- All user-facing strings use i18n keys under the `explorer.*` prefix (agent 04).

### Explicit non-goals

- Disk-level filesystem browsing, arbitrary folders, `#include` resolution UI.
- Drag-and-drop file upload.
- Detached explorer window.
- Replacing or removing editor tabs.
- Replacing the shader-library browser (`browserOpen` / `browserWidth`).
- Persisting tree expansion state across reloads.
- Angular Material `MatTree` / `MatTreeNestedDataSource` as part of the contract.
- A new global state store — projections are `computed` signals over `ShaderStore`.

## Source-of-truth mapping

| Concept | Repository source |
| --- | --- |
| Openable documents | `ShaderStore.documents()` → `EditorDocument[]` |
| Active document | `ShaderStore.activeDoc()` / `activeDocId` |
| Select document | `ShaderStore.selectDoc(id)` |
| Project structure | `ShaderStore.project()` → `ShaderProject` |
| Pass display order (Files) | `displayPasses(project)` from `@shader-studio/shared/project` |
| Render execution order | `ShaderStore.renderOrder()` (topological, image last) |
| Graph errors | `ShaderStore.projectErrors()` |
| Per-doc diagnostics | `ShaderStore.diagnosticsFor(docId)` / `errorCountFor(docId)` |
| Compiling passes | `ShaderStore.compiling(): ReadonlySet<string>` |
| Dirty | `ShaderStore.dirty()` (project-level) |
| Buffer enable/disable | `ShaderStore.setPassEnabledById` |
| File/buffer CRUD + reorder | `ShaderStore` mutations + `WorkspaceActions` dialogs |
| Vertex / config ids | `VERTEX_DOC` (`@vertex`), `CONFIG_DOC` (`@config`) |

`EditorDocument` shape (from `shader-store.ts`):

```typescript
interface EditorDocument {
  id: string;
  kind: 'pass' | 'file' | 'vertex' | 'config';
  name: string;
  language: 'glsl' | 'json';
  source: string;
  passKind?: 'image' | 'common' | 'buffer';
  slot?: 'A' | 'B' | 'C' | 'D' | null;
  enabled?: boolean;
}
```

## Views

### Files view hierarchy

Top-level **groups** (always present when a project is loaded; omit empty
groups):

| Group id | i18n label key | Children (in order) |
| --- | --- | --- |
| `explorer:files:group:passes` | `explorer.group.passes` | Image pass, Common pass (if present), buffer passes in `displayPasses` buffer order |
| `explorer:files:group:includes` | `explorer.group.includes` | Include files in `project.files` array order |
| `explorer:files:group:project` | `explorer.group.project` | Vertex (`@vertex`), Config (`@config`) |

**Ordering rules**

- Passes follow `displayPasses(project)`: Image, Common (when it exists), then
  buffers in project insertion order (not render order).
- Include files follow `project.files` order.
- Vertex always precedes Config in the project group.

### Pipeline view hierarchy

| Group id | i18n label key | Children (in order) |
| --- | --- | --- |
| `explorer:pipeline:group:common` | `explorer.group.common` | Common pass node (selectable) when present |
| `explorer:pipeline:group:execution` | `explorer.group.execution` | Enabled buffers in `renderOrder()` (excluding Image), then Image pass |
| `explorer:pipeline:group:disabled` | `explorer.group.disabledBuffers` | Disabled buffer passes in slot order A → D (omit group when empty) |

Under **each pass node** (Image, Common, enabled buffers, disabled buffers):

| Child id pattern | Kind | Selectable |
| --- | --- | --- |
| `explorer:pipeline:pass:{passId}:channels` | `group` | no |
| `explorer:pipeline:pass:{passId}:channel:{0\|1\|2\|3}` | `channel` | no |
| binding child (see below) | informational | no |

**Channel binding children** (one per channel, deterministic id):

| Binding | Node kind | Child id suffix | Dependency edge? |
| --- | --- | --- | --- |
| `{ kind: 'none' }` | `channel-none` | `:binding:none` | no |
| `{ kind: 'texture', slot: n }` | `channel-texture` | `:binding:texture:{n}` | no |
| `{ kind: 'buffer', passId, feedback: false }` | `channel-buffer` | `:binding:buffer:{passId}` | **yes** (display only) |
| `{ kind: 'buffer', passId, feedback: true }` | `channel-feedback` | `:binding:feedback:{passId}` | **no** — feedback is shown but must not be drawn as a dependency edge |

Channel rows use fixed order **iChannel0 → iChannel3** regardless of binding
state.

**Execution ordering**

- Use `ShaderStore.renderOrder()` for enabled passes. That list excludes Common
  (Common is compiled into every pass, not executed as its own stage).
- Image is always last in the execution group, matching `resolvePassOrder`.
- Disabled buffers are listed separately, sorted by `BUFFER_SLOTS` order.

## Selectable vs informational nodes

### Selectable nodes

A row is **selectable** when it maps to an existing `EditorDocument.id`:

| `ExplorerSelectableKind` | `EditorDocument.id` | `EditorDocument.kind` |
| --- | --- | --- |
| `image-pass` | pass id | `pass` / `passKind: 'image'` |
| `common-pass` | pass id | `pass` / `passKind: 'common'` |
| `buffer-pass` | pass id | `pass` / `passKind: 'buffer'` |
| `source-file` | file id | `file` |
| `vertex` | `@vertex` | `vertex` |
| `config` | `@config` | `config` |

For selectable nodes **`node.id === node.docId`**. The projection must never
emit a selectable `docId` that is absent from `documents()`.

### Informational nodes

Groups, channel headers, and binding detail rows are **not selectable**. They
use deterministic ids from `node-id.ts` (never array index alone). Activating
them (click, Enter) does nothing; focus may land on them for keyboard traversal.

## Node status semantics

Status is computed in the projection (agent 02) from store signals:

| Field | Rule |
| --- | --- |
| `active` | `docId === activeDoc()?.id` |
| `disabled` | `passKind === 'buffer' && enabled === false` |
| `dirty` | `store.dirty()` for `image-pass`, `common-pass`, `buffer-pass`, `vertex`, `config`; always `false` for `source-file` and informational nodes |
| `compiling` | `store.compiling().has(docId)` for compilable selectable kinds |
| `errorCount` | `store.errorCountFor(docId)` for `image-pass`, `common-pass`, `buffer-pass`, `vertex`, `config`; `0` for files and informational nodes |

Match `EditorTabs` presentation rules:

- Compiling beats error beats dirty/idle for icon/dot priority.
- Error count badge replaces the state dot when `errorCount > 0`.
- Disabled buffers use struck-through label styling (not removal from the tree).

## Context-command capabilities

Capabilities mirror `editor-tabs.ts` permission logic — the projection exposes
them so templates do not duplicate rules:

| Capability | Rule (same as tabs) |
| --- | --- |
| `rename` | `passKind === 'buffer'` or `kind === 'file'` |
| `duplicate` | (`passKind === 'buffer' && canAddBuffer()`) or `kind === 'file'` |
| `delete` | `passKind === 'buffer'` or `kind === 'file'` |
| `reorder` | same as `rename` |
| `toggleEnabled` | `passKind === 'buffer'` |
| `selectable` | selectable kinds only |

Header-level commands (not per-node):

- **Create buffer** — `store.addBufferPass()` when `canAddBuffer()`; disabled
  with tooltip when all slots are full (reuse `editor.buffersFull` or
  `explorer.buffersFull`).
- **Create file** — `workspace.createFile()`.

Per-node commands call existing APIs:

| Command | Action |
| --- | --- |
| Rename | `workspace.renameDocument(doc)` |
| Duplicate | `store.duplicateSourceFile` / `store.duplicateBufferPass` |
| Delete | `workspace.deleteDocument(doc)` |
| Enable / Disable | `store.setPassEnabledById(id, enabled)` |
| Reorder | `store.moveSourceFile` / `store.movePassTo` (see reorder intent) |

## Reorder (drag-and-drop)

Reorder is **in scope** for buffer↔buffer and file↔file siblings only, matching
tabs. Cross-group drops are rejected.

```typescript
interface ExplorerReorderIntent {
  sourceDocId: string;
  targetDocId: string;
  list: 'buffer' | 'file';
}
```

The panel emits the intent; integration calls the same store methods as
`EditorTabs.onDrop`.

## Interaction

### Pointer

- **Single click** on selectable row → `selectDoc(docId)`.
- **Double click** on renameable row → `rename` intent (same as tab double-click).
- **Context menu** → emit allowed commands from `capabilities`.
- **Drag start** only when `capabilities.reorder`; drop only on same-list siblings.

### Keyboard

- Explorer panel is a **`role="tree"`** (or nested `treeitem`/`group` pattern).
- **ArrowUp/ArrowDown** — move focus between visible rows.
- **ArrowRight** — expand collapsed group; on selectable leaf, no-op.
- **ArrowLeft** — collapse expanded group; on child, move to parent.
- **Home/End** — first/last visible row.
- **Enter/Space** on selectable row — same as click (`selectDoc`).
- **Context menu key** — open row action menu when commands exist.

Focus returns to the editor on Escape when the overlay is open (agent 05).

### Collapse / resize

- **Collapse toggle** hides the explorer strip; persisted as `fileExplorerOpen`.
- **Width resize** drags the explorer/editor split; persisted as
  `fileExplorerWidth`.
- Collapsing the editor window (`EditorShell` minimized) hides the explorer with
  the editor body; explorer open preference is preserved.

## Narrow width / overlay

- Use the editor panel's **container query width** (the panel already sets
  `container-type: inline-size`).
- Breakpoint: **`FILE_EXPLORER_OVERLAY_BREAKPOINT = 480` px**.
- At or below the breakpoint, the explorer renders as an **overlay drawer** over
  the editor body (not beside it). A scrim click or Escape closes the overlay
  for the current session; `fileExplorerOpen` stays `true`.
- Above the breakpoint, the explorer is a **left docked column** inside the
  editor panel; Monaco and explorer share width.

## Persistence (agent 04)

Add to `WorkspacePreferences` and sanitize via `libs/shared/src/prefs/panel.ts`:

| Field | Type | Default | Sanitization |
| --- | --- | --- | --- |
| `fileExplorerOpen` | `boolean` | `true` | boolean coercion |
| `fileExplorerView` | `'files' \| 'pipeline'` | `'files'` | enum fallback |
| `fileExplorerWidth` | `number` | `240` | clamp `FILE_EXPLORER_LIMITS.width` |

```typescript
export const FILE_EXPLORER_LIMITS = {
  width: { min: 180, max: 400 },
} as const;
export const DEFAULT_FILE_EXPLORER_WIDTH = 240;
export const DEFAULT_FILE_EXPLORER_OPEN = true;
export const DEFAULT_FILE_EXPLORER_VIEW = 'files' as const;
export const FILE_EXPLORER_OVERLAY_BREAKPOINT = 480;
```

Tree **expansion** state is **session-local** in the panel component (not
persisted in MVP).

## Accessibility

- Panel: `role="complementary"` with `aria-label` from `explorer.aria.panel`.
- View switch: `role="tablist"` / `role="tab"` with `aria-selected`.
- Tree groups: `role="group"` with `aria-label` from i18n.
- Selectable rows: `role="treeitem"`, `aria-selected` when active.
- Disabled buffers: `aria-disabled="true"` on the row; they remain focusable and
  editable.
- Error count: `aria-label` with parameterized `explorer.status.errors` (not
  colour alone).
- Compiling: `aria-busy="true"` on the row.
- Dirty: visible indicator plus `explorer.status.unsaved` available to screen
  readers.
- Resize handle: `role="separator"`, `aria-orientation="vertical"`, keyboard
  arrows adjust width (same pattern as `EditorShell` dock handle).

## Loading, empty, and missing states

| Condition | `ExplorerTree.emptyReason` | UI |
| --- | --- | --- |
| `store.loading()` | `loading` | Spinner/disabled tree, `explorer.state.loading` |
| `!store.project()` | `no-project` | `explorer.state.noProject` (same spirit as `editor.empty`) |
| Project loaded, zero documents (should not happen) | `no-documents` | `explorer.state.noDocuments` |
| Files view, no include files | — | Omit includes **group** (not an empty-state) |
| Pipeline view, no disabled buffers | — | Omit disabled **group** |

## TypeScript contract surface

Agent 01 delivers **contract-only** types under
`apps/web/src/app/ui/file-explorer/`:

- `contract.ts` — view mode, node shape, status, capabilities, commands, tree.
- `node-id.ts` — deterministic id builders for groups and channel rows.
- `node-id.spec.ts` — pure tests for id stability.

The projection function (agent 02) returns `ExplorerTree`. The panel (agent 03)
accepts `ExplorerTree` plus emits `ExplorerSelectEvent`, `ExplorerCommandEvent`,
and `ExplorerReorderIntent`.

**Do not import** these types from production editor code until agent 05
integrates.

## File ownership

| Agent | Primary files |
| --- | --- |
| **01** (this) | `docs/file-explorer-agents/implementation-contract.md`, `file-explorer/contract.ts`, `file-explorer/node-id.ts`, `file-explorer/node-id.spec.ts` |
| **02** | `file-explorer/project-explorer.ts` (or similar), projection unit tests |
| **03** | `file-explorer/explorer-panel.ts`, component tests |
| **04** | `libs/shared/src/prefs/panel.ts`, `preferences.ts`, `workspace-actions.ts`, `i18n/en.json`, `i18n/fr.json` |
| **05** | `editor-panel.ts`, layout/overlay wiring, integration tests |

## Acceptance-test scenarios

1. **Open shader** — Files view shows Image, Common, buffers, Vertex, Config;
   Pipeline view shows Common, execution order, channel bindings.
2. **Select row** — Active tab and Monaco document match; explorer row shows
   active state.
3. **Disabled buffer** — Visible in both views with disabled styling; still
   editable; excluded from execution group in Pipeline.
4. **Feedback channel** — Pipeline shows feedback binding with distinct styling;
   no dependency edge to self in the graph display.
5. **Buffer dependency** — Pipeline shows buffer binding as dependency reference
   under the channel row.
6. **Dirty / compiling / errors** — States match tab dots/badges for the same
   document.
7. **Rename buffer/file** — Context menu → dialog → tree and tabs update.
8. **Reorder buffers** — Drag in explorer (or tabs) updates order in both places.
9. **Narrow editor** — Below 480px explorer overlays editor; Monaco keeps min width.
10. **Persist** — Reload restores open state, view, and width.
11. **i18n** — Toggle locale; all `explorer.*` strings render in EN/FR.
12. **No regression** — Shader library, tabs, compile, draft recovery, SSR, desktop.

## Unresolved risks

- **Per-document dirty** — Only project-level `dirty()` exists today; explorer
  shows dirty on all compilable docs when any edit is unsaved (matches tabs).
- **Texture channel rows** — Informational only; jumping to the texture inspector
  is out of MVP scope.
- **Overlay focus trap** — Agent 05 must ensure focus management does not break
  Monaco shortcuts when the drawer is closed.
- **Common pass optional** — `commonPass(project)` may be null on edge projects;
  projection must tolerate missing Common.
