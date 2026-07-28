# Native surfaces — implementation contract

Grounded in start commit `8219f0d8fa475ee164426964b1582b7162c02805`. Agents
02–05 treat this document as the coordination boundary unless the coordinator
explicitly revises it. Code that disagrees with older prompt text loses; this
contract and current code win.

Do **not** implement the new architecture in the contract branch. Characterize
current behavior, then lock the target seams.

---

## 1. Surface kinds and MVP boundaries

### Surface kinds (MVP)

| Kind               | Role today (start commit)                                      | MVP native? | Multiple instances?      |
| ------------------ | -------------------------------------------------------------- | ----------- | ------------------------ |
| `preview`          | Shader stage / floating preview (`PreviewWindow` + shell)      | yes         | **one** live preview     |
| `editor`           | Source editor (`EditorWindow` + shell + tabs)                  | yes         | **required** (≥1 group)  |
| `inspector`        | Right rail (`guiVisible`, `inspectorWidth`, `inspectorTab`)    | yes         | one                      |
| `shader-browser`   | Left library rail (`browserOpen`, `browserWidth`)              | yes         | one                      |
| `problems`         | Bottom-panel Problems tab                                      | yes         | one (with `output` tab)  |
| `output`           | Bottom-panel Output tab **and/or** Electron `/output` window   | yes         | see §1.1                 |

### §1.1 Output naming (fixed decision)

Two distinct surfaces share the English word “output” today:

1. **`problems-output`** (or keep twin tabs under one `bottom-panel` surface):
   the contained bottom panel with tabs `problems` | `output`
   (`BottomPanelTab` in `libs/shared/src/prefs/panel.ts`).
2. **`live-output`**: the Electron satellite that loads `/output` and mirrors
   preview via `OutputSync` (`apps/web/src/app/output-mode.ts`,
   `apps/desktop/main/src/main.ts`).

**MVP decision:** treat them as **two surface kinds**:

- `bottom-panel` — contained Problems/Output tool surface (may later split).
- `live-preview-output` — native-only satellite that hosts a **read-only live
  preview** (today’s `/output` window). Under the one-live-preview rule this
  satellite **is** the externalized preview host, not a second independent GPU
  authority (see §12).

Agent 07 converts `live-preview-output` into the generic native preview path.
Until then, preserve today’s open/close IPC (`open-output` / `close-output` /
`output-open` / `output-state-changed`).

### Non-MVP (explicit)

- Collaborative multi-writable editing / CRDT / OT.
- Transferring Monaco models, undo stacks, or WebGL contexts across processes.
- Multiple simultaneous live GPU previews.
- Forcing transient dialogs (export, confirm, settings) into the surface
  framework.
- Persisting shader/project content inside layout preferences.
- Replacing SQLite-in-main or moving persistence into renderers.
- Removing web/SSR builds.
- Treating Electron `webContents.id` / `BrowserWindow.id` as durable layout IDs.

---

## 2. Contained vs native terminology

| Term         | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| **Contained**| Rendered inside the main workspace DOM (Angular host).                  |
| **Native**   | Rendered in an Electron `BrowserWindow` (satellite renderer).           |
| **Docked**   | Contained, pinned to a workspace edge.                                  |
| **Floating** | Contained, draggable/resizable over the workspace.                      |
| **Stage**    | Contained full-workspace background (preview only).                     |
| **External** | Native placement (`BrowserWindow`).                                     |
| **Maximized / minimized** | Transient presentation over a restore point (contained or native). |

### Detach vs float (breaking rename vs current UI)

At the start commit:

- `EditorWindow.detach()` sets **floating** contained mode.
- `PreviewWindow.detach()` / `toggleDetached()` leave **stage** for **floating**.
- i18n keys `action.detach` / `action.detachPreview` mean those transitions.

**Target product vocabulary (Electron):**

| User action              | Placement result                         | Availability      |
| ------------------------ | ---------------------------------------- | ----------------- |
| **Float in workspace**   | Contained `floating`                     | Web + Electron    |
| **Detach** / externalize| Native `external`                        | Electron only     |
| **Return to workspace**  | Contained restore point (dock/float/stage)| Electron          |
| **Return to stage**      | Contained `stage` (preview)              | Web + Electron    |

Agents must not overload one command for both float and externalize. Migrate
labels so Electron “Detach” means externalize; keep “Float in workspace”
separate. Web never offers externalize.

---

## 3. Capability presets

Capabilities are **explicit per kind**. Do **not** invent a LCM base class that
admits impossible states (mirrors today’s comment in `PreviewWindow`: editor and
preview share geometry helpers only).

| Capability            | preview | editor | inspector | shader-browser | bottom-panel | live-preview-output |
| --------------------- | ------- | ------ | --------- | -------------- | ------------ | ------------------- |
| `stage`               | yes     | no     | no        | no             | no           | no                  |
| `dock`                | no      | yes    | yes\*     | yes\*          | yes\*        | no                  |
| `float`               | yes     | yes    | later\*\* | later\*\*      | later\*\*    | no                  |
| `maximize`            | yes     | yes    | yes       | yes            | yes          | native OS maximize  |
| `minimize`            | yes     | yes    | yes       | yes            | yes          | native OS minimize  |
| `externalize`         | yes     | yes    | yes       | yes            | yes          | n/a (already native)|
| `return`              | yes     | yes    | yes       | yes            | yes          | return → contained preview |
| `close`               | **no**  | yes    | yes       | yes            | yes          | yes (hides satellite)|
| `singleton`           | yes     | no     | yes       | yes            | yes          | yes (≤1 native preview) |
| `multiInstance`       | no      | yes    | no        | no             | no           | no                  |
| `ownsWritableDocs`    | no      | yes    | no        | no             | no           | no                  |
| `hostsGpuPreview`     | yes     | no     | no        | no             | no           | yes (same singleton)|

\*Today inspector / browser / bottom-panel are **edge rails / strips**, not the
editor’s dock-side state machine. Domain `dock` means “edge-attached contained
placement”; Agent 06 maps rails into the shared registry without requiring the
editor’s three dock sides for every surface.

\*\*MVP may keep rails edge-only; floating those tools is allowed by the domain
but not required until Agent 10.

Rejected transitions must be **typed failures**, not silent no-ops, once the
shared domain lands (Agent 02). Characterization of today’s editor/preview still
uses early-return guards (`maximize` when already maximized, etc.).

---

## 4. Legal placements and transitions

### Placement discriminant (target)

```text
ContainedPlacement =
  | { host: 'contained'; mode: 'stage' }
  | { host: 'contained'; mode: 'docked'; side: DockSide; size: number }
  | { host: 'contained'; mode: 'floating'; rect: Rect }
  | { host: 'contained'; mode: 'maximized'; restore: RestorePoint }
  | { host: 'contained'; mode: 'minimized'; restore: RestorePoint; point?: Point }

NativePlacement =
  | { host: 'native'; bounds: Rect; displayId?: string; maximized?: boolean; fullscreen?: boolean }
```

`RestorePoint` is only a **durable** mode (`stage` | `docked` | `floating`),
never `maximized` / `minimized` / a transient Electron id.

### Transition vocabulary

`showOnStage`, `dock`, `float`, `maximize`, `minimize`, `restore`,
`externalize`, `return`, `move`, `resize`, `resetGeometry`, `close`,
`activate` / `focus`.

### Current machines to preserve semantically

**Editor** (`EditorWindow` + `sanitizeWindowState`):

- Modes: `docked` | `floating` | `maximized` | `minimized`.
- Restore modes: `docked` | `floating`.
- Dock sides: `bottom` | `left` | `right`.
- Compact viewport (`width < 700`): **rendered** floating → docked bottom;
  **stored** mode/side unchanged.
- `close` / `toggleOpen` flip `Preferences.editorOpen` only — never drafts.

**Preview** (`PreviewWindow` + `sanitizePreviewWindow`):

- Modes: `stage` | `floating` | `maximized` | `minimized`.
- Restore modes: `stage` | `floating`.
- No dock, no close, separate minimized point.

---

## 5. Maximize / minimize restoration

Fixed rule (already true for editor and preview; domain must keep it):

1. Entering `maximized` or `minimized` from a durable mode records that mode as
   `restoreMode`.
2. Entering `maximized`/`minimized` from another transient mode **does not**
   overwrite `restoreMode`.
3. `restore()` / toggle-off returns to `restoreMode`.
4. Sanitizers reject illegal `restoreMode` values (e.g. `maximized`) by falling
   back to defaults.

Native OS maximize/fullscreen is **orthogonal** chrome on `NativePlacement`;
returning to the workspace restores the contained restore point, not the last
OS chrome flags, unless the surface remains native.

---

## 6. Surface identity vs native window identity

| Identity                         | Stable across relaunch? | Owner                         |
| -------------------------------- | ----------------------- | ----------------------------- |
| `SurfaceId`                      | yes (layout prefs)      | shared domain + preferences   |
| `EditorGroupId`                  | yes (session + layout)  | editor-group model (Agent 08) |
| `SessionClientId`                | per renderer connection | session protocol (Agent 05)   |
| Electron `BrowserWindow.id`      | **no**                  | main process only             |
| `webContents.id`                 | **no**                  | main process only             |

Persisted layout references **`SurfaceId` / `EditorGroupId` only**. Main maps
`SurfaceId → BrowserWindow` in a live registry (Agent 04). Child crash or
recreate allocates a new native id without changing `SurfaceId`.

---

## 7. Geometry ownership and persistence

| Concern                         | Owner / store                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Contained geometry + modes      | Layout preferences (today: `editorWindow`, `previewWindow`, panel widths)     |
| Viewport measurement            | Contained runtime (shells today; Agent 03 registry) — never in shared domain  |
| Native normal bounds / display  | Electron main surface manager (`window-state`-style persistence)              |
| Shader drafts / params / assets | `ShaderStore` + persistence IPC / SQLite in main                              |
| Open tab membership/order       | Session UI (`OpenDocuments`) — **not** project files; currently **unpersisted** |

Rules:

- Shared domain sanitizes numbers/enums; it does **not** read `window`,
  `localStorage`, or Electron APIs at module evaluation.
- Clamp/contain against a viewport supplied by the host (same pattern as
  `clampToViewport` / `clampPreviewRect`).
- Persist **committed** geometry on gesture end, not on every pointer move
  (Agent 03 requirement; today’s shells already use live preview + commit).
- Off-screen / missing-display recovery is mandatory for contained and native
  bounds.

### Legacy preference keys (migration input for Agent 02)

From `Preferences` / `STORAGE_KEY = 'shader-studio.preferences'`:

- `editorOpen`, `editorWindow`, `editorAppearance`
- `previewWindow`
- `browserOpen`, `browserWidth`, `guiVisible`, `inspectorWidth`, `inspectorTab`
- `bottomPanelOpen`, `bottomPanelHeight`, `bottomPanelTab`
- `fileExplorerOpen`, `fileExplorerView`, `fileExplorerWidth` (editor-local;
  **not** a workspace surface)

Migration must be deterministic, idempotent, and must not drop appearance or
capture prefs while reshaping layout.

---

## 8. Close, return, quit, child crash

| Event                         | Required behavior                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Close editor surface          | Hide/destroy **surface UI** only. Drafts stay in session authority. Tabs may move |
| Close last editor group       | Allowed only if another editor group remains **or** product keeps one empty group; never discard draft |
| Close preview                 | **Illegal** for preview kind. Native satellite close = return/hide live host under singleton rules |
| Return from native            | Destroy/hide `BrowserWindow`; restore contained placement; transfer focus         |
| Main window close request     | Keep approve-close handshake (`close-requested` / `approve-close`)                |
| App quit                      | Flush session save prompts as today; close satellites; persist layout             |
| Child crash / unresponsive    | Main clears registry entry; session releases that client’s document locks; drafts remain; UI may reopen surface |
| Output satellite closed today | `outputWindow = null`, emit `output-state-changed(false)`; main `closed` also closes output |

**Invariant:** closing any surface never deletes project content and never
discards an unsaved draft.

---

## 9. Editor groups, tabs, writable ownership

### Current facts

- `OpenDocuments` tracks **session-local** open ids + order **per shader id**.
- `ShaderStore.activeDoc()` is authoritative active document.
- Last-tab rule: cannot empty a shader’s open set (`closeDocument` no-op).
- Closing a tab never deletes buffers/passes.
- `CodeEditor` keeps Monaco models + undo + view state **in one renderer**.

### Target rules (MVP)

1. An **editor group** owns an ordered tab set and optionally a contained/native
   surface instance.
2. A document has **exactly one writable owner** (group/client) at a time.
3. Moving a document between renderers **recreates** Monaco; **undo history
   resets**. Cursor/selection/scroll **may** transfer via serializable view
   state only.
4. Multiple editor windows/groups are required; they share one draft authority.
5. Disconnect/close of an owner **releases the write lock** without deleting
   text; another group may claim ownership explicitly.

---

## 10. Monaco transfer policy

| Asset                | Cross-renderer?                         |
| -------------------- | --------------------------------------- |
| Model text           | Via session snapshot / document events  |
| Undo/redo stack      | **No** — explicitly lost on move        |
| View state           | Yes — `ICodeEditorViewState`-compatible JSON |
| Markers/diagnostics  | Recomputed or pushed as protocol events |
| Theme/appearance     | From shared preferences                 |

Document this in UX copy where Detach/move is offered (Agent 09).

---

## 11. Workspace session authority

`OutputSync` + `BroadcastChannel('shader-studio.output')` is a **prototype
mirror**, not the final multi-writer authority.

### Target (Agent 05)

- **One** authoritative draft/session in Electron (broker in main or a single
  controller client designated by main). Web in-process uses the same protocol
  types with an in-process transport.
- Monotonic **revisions** per document and/or session.
- Commands carry `baseRevision`; stale commands get structured rejection with
  current revision + enough state to resync.
- Snapshot = immutable serializable project/draft/params/diagnostics/selection —
  **never** Monaco or WebGL objects.
- Events: snapshot, doc patch, params, diagnostics, compile, save, presence,
  focus requests.
- Save/revert serialized.
- Protocol version negotiation required.
- SQLite remains in Electron main; renderers use typed IPC only.

Independent writable `ShaderStore` instances across renderers are **rejected**.

---

## 12. Preview, clock, GPU, context loss

From `PreviewWindow` comments and product constraints:

- Placement transitions must **not** destroy the canvas/WebGL context when
  staying in-process (today: CSS framing around a stable canvas).
- Crossing process boundaries **requires** a new WebGL context; clock/params
  restore from session snapshot, not from GPU objects.
- MVP: **one** live preview authority. Externalizing preview moves/hosts that
  authority in the satellite; the main workspace shows a placeholder or dormant
  stage, not a second live context.
- Context loss: report through session/diagnostics/output log; attempt restore
  from last good program + params; never pretend a lost context is still valid.
- `paused`, `resolutionScale`, `autoRipples` remain preference/session fields,
  not layout geometry.

---

## 13. Surface entry routes and bootstrap

| Surface host              | Entry today                                      | Target                                      |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Main workspace            | `/`, `/shaders/:id` (`app.routes.ts`)            | unchanged + surface registry                |
| Live output / native preview | pathname `/output` (`isOutputWindow()`)       | dedicated lightweight route/bootstrap       |

Constraints:

- Child renderers boot **only** the surface they display (no full chrome,
  MCP bridge, or routing orchestration unless required).
- `StartupCoordinator` already branches on `isOutputWindow()` — keep that
  pattern for native surface bootstraps.
- No DOM/Electron access at **module evaluation** in `libs/shared` or web
  services used by SSR.
- SSR defaults match first client paint (`Preferences` already does this).

Do not put editable source in URLs.

---

## 14. Typed IPC and Electron security

Current invariants in `main.ts` / `window.ipc.ts` that Agent 04 must preserve
and generalize:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- Preload-only bridge; regenerate via `pnpm gen:ipc` (never hand-edit
  `ipc-bridge.ts`)
- Navigation restricted to app origin / custom scheme
- `setWindowOpenHandler` → deny
- Close approval WeakSet for main window
- SQLite + file/texture bytes stay in main

Window IPC today: `minimize`, `toggle-maximize`, `toggle-fullscreen`, `state`,
`open-output`, `close-output`, `output-open`, `close`, `approve-close`, events
`close-requested`, `state-changed`, `output-state-changed`.

Agent 04 replaces the `outputWindow` special case with a surface manager while
keeping an adapter so Agent 07 can migrate behavior without breaking open/close
state signaling.

Satellite windows are non-modal; do not set `parent` merely for product “child”
language unless platform ownership requires it (document if used).

---

## 15. Focus, shortcuts, a11y, i18n, responsive, SSR, motion

- Contained z-order: most recently activated window foreground
  (`WorkspaceWindowStack` today understands only `editor` | `preview`; Agent 03
  generalizes).
- Keyboard resize: shared `arrowKeyDelta` / eight-edge handles / dock separators
  with ARIA (`role="separator"`, orientation, labels). EN/FR catalogs stay
  synchronized (`pnpm check:i18n`).
- Compact editor rules (`FLOATING_MIN_VIEWPORT = 700`) remain until domain
  encodes equivalent policy.
- Focus transfer on externalize/return must move keyboard focus into the
  receiving surface and announce status via existing i18n patterns.
- Respect reduced-motion for contained maximize/minimize/dock animations.
- Screen-reader labels for new Detach / Float commands must not collide.

---

## 16. File ownership — Agents 02–05

| Agent | Owns (create/modify) | Must not touch |
| ----- | -------------------- | -------------- |
| **02** shared domain | `libs/shared/src/surfaces/**` (types, capabilities, placement, transitions, sanitize, migration, exports, specs) | Angular shells, Electron main/preload, `ShaderStore`, session transport |
| **03** contained runtime | `apps/web/src/app/surfaces/**` (registry, controller, gestures, controls, SSR-safe projection, specs) | Electron main/preload, `ShaderStore` / `OutputSync`, preference migration removal, replacing production shells yet |
| **04** Electron manager | `apps/desktop/main/src/windows/**`, window IPC extensions, preload/typed contracts via `gen:ipc`, registry/lifecycle tests | Angular contained shells, session broker core, native preview/editor product routes |
| **05** session protocol | Shared protocol types + broker (+ transport interfaces/adapters under shared or agreed desktop seams), protocol tests | `BrowserWindow` factory, full `ShaderStore` rewrite, surface routes, CRDT |

Wave 3 agents branch from the **post–Agent 02** integration commit and stay in
their columns. Conflicts usually mean a contract violation.

Agent 06+ migrate production editor/preview onto 02+03; Agent 07 consumes 04+05
for native preview; Agent 08/09 for editor groups/native editors.

---

## 17. Legacy preference migration requirements

Agent 02 must provide pure functions that:

1. Accept unknown JSON from `shader-studio.preferences`.
2. Emit a versioned layout model + preserve unrelated fields.
3. Map:
   - `editorWindow` + `editorOpen` → editor surface instance(s)
   - `previewWindow` → preview surface
   - browser/inspector/bottom-panel fields → corresponding surfaces
4. Round-trip sanitization rejects corrupt executable states.
5. Idempotent on already-migrated input.
6. Do **not** delete legacy fields from disk in Agent 02; dual-read until Agent
   06 removes obsolete writers.

File-explorer prefs remain editor-local chrome, not workspace surfaces.

---

## 18. Acceptance scenarios

1. Maximize then minimize then restore returns to the original durable
   placement for editor and preview.
2. Floating geometry saved on a large display recovers fully on-screen on a
   smaller viewport without permanently rewriting stored rect until the user
   commits a new gesture.
3. Keyboard arrow/Shift-arrow resize nudges floating and docked edges using
   shared deltas (`16` / `64`).
4. Activating editor then preview flips z-order; only one contained foreground.
5. Closing the editor window sets `editorOpen=false` and does not clear drafts
   or open-tab state.
6. Closing an editor tab never deletes documents; last tab refuses to close.
7. Electron output satellite: open focuses existing; close clears open state;
   main window close closes satellite.
8. Web build: externalize unavailable; float/dock/stage still work; SSR safe.
9. Native child cannot `require` Node; navigation off-origin blocked.
10. Stale session edits rejected with current revision after Agent 05 lands.

---

## 19. Non-goals (recap)

- Implementing multi-preview GPU.
- Shipping collaboration.
- Persisting Monaco undo.
- LCM window base class with dock+stage+close union.
- Hand-editing generated IPC bridges.
- Agents 02–05 migrating production shells or removing `OutputSync` prematurely.

---

## 20. Repository facts locked at start commit

Re-checked against code:

1. `EditorWindow` and `PreviewWindow` are separate placement state machines.
2. `EditorShell` and `PreviewShell` duplicate drag/resize/containment/keyboard/
   max/min/activation mechanics.
3. `WorkspaceWindowStack` only knows `editor` | `preview`.
4. `OpenDocuments` is session-local tab membership/order by shader.
5. `CodeEditor` Monaco models are process-local and non-transferable.
6. `ShaderStore` owns record/draft/params/diagnostics/active doc/persistence/
   compilation orchestration.
7. Electron has a real output `BrowserWindow` + typed window IPC.
8. `OutputSync` is BroadcastChannel mirroring — prototype only.
9. SQLite lives in Electron main.
10. SSR supported; shared/web avoid DOM/Electron at module evaluation.

---

## 21. Characterization tests added by Agent 01

Executable documentation for gaps that were not already covered:

- `apps/web/src/app/editor/editor-window.spec.ts` — restore paths, compact
  fallback, geometry recovery, open/close vs content.
- `libs/shared/src/geometry.spec.ts` — keyboard nudge + `resizeRect` minima.
- `apps/web/src/app/output-mode.spec.ts` — `/output` detection.
- `apps/web/src/app/desktop/output-window.characterization.spec.ts` —
  singleton open/focus/close/main-closed semantics matching `main.ts`
  (pure fixture; desktop package has no vitest target yet).

Already sufficient (do not duplicate): `preview-window.spec.ts`,
`workspace-window-stack.spec.ts`, `open-documents*.spec.ts`, shared
`preview.spec.ts` / `panel.spec.ts` sanitizers.
