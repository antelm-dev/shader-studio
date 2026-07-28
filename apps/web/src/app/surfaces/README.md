# Contained-surface runtime (Agent 03)

Reusable Angular mechanics for contained windows, built on
`@shader-studio/shared/surfaces`. Production `EditorShell` / `PreviewShell` are
**not** migrated here — that is Agent 06.

## Integration API for Agent 06

### 1. Hydrate and persist

```ts
import { SurfaceRegistry, SurfaceController } from '../surfaces';

// After preferences / migration load:
registry.hydrate(layoutPreferences);

// On successful command or gesture commit — write once:
preferences.patch({ layout: registry.snapshot() }); // exact key is Agent 06's choice
```

Do **not** write preferences inside pointermove. `SurfaceGeometryGesture` keeps
live preview in signals; call `SurfaceController.commitFloatingRect` /
`commitDockSize` / `commitMinimizedPoint` only from the gesture `onCommit`
callback.

### 2. Workspace measurement

```html
<div class="stage" surfaceWorkspace>
  <!-- surface hosts -->
</div>
```

`SurfaceWorkspaceDirective` ResizeObserves the host (browser only) and updates
`SurfaceRegistry.setViewport`. Clamping/projection then recover off-screen
bounds for **display** without rewriting stored rects until a gesture commits.

### 3. Per-surface host pattern

```ts
readonly gesture = new SurfaceGeometryGesture();

frame = computed(() =>
  projectSurfaceFrame(registry.get(id)!, registry.viewport(), {
    liveRect: gesture.liveRect(),
    liveDockSize: gesture.liveDockSize(),
    livePoint: gesture.livePoint(),
  }),
);

z = computed(() => registry.zIndex(id));
```

Host bindings:

- `[style.z-index]="z()"`
- `[surfaceFrameMotion]` + `[dragging]="gesture.dragging()"`
- Prefer CSS:

```css
.surface-frame--animating {
  transition:
    height 180ms ease,
    width 180ms ease,
    inset 180ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .surface-frame--animating {
    transition: none;
  }
}
```

### 4. Title bar and resize seams

Keep your own title content and body markup. Wire:

```html
<header
  surfaceTitleBar
  [dragEnabled]="frame().draggable"
  (dragStart)="onDrag($event)"
  (toggleMaximize)="onToggleMax()"
>
  <!-- title + projected controls -->
</header>

<surface-resize-handles
  [mode]="frame().resizableFloating ? 'floating' : frame().resizableDocked ? 'docked' : 'none'"
  [dockSide]="frame().dockSide"
  [dockValue]="frame().dockSize ?? 0"
  [dockMin]="…"
  [dockMax]="…"
  [dockLabel]="…"
  [label]="edgeLabel"
  (pointerDown)="onResizePointer($event)"
  (keyDown)="onResizeKey($event)"
/>
```

`onDrag` / `onResizePointer` call `gesture.begin(...)` with the surface kind,
viewport, and committed geometry; `onCommit` calls the controller.

### 5. Commands (capability-filtered)

```ts
const commands = describeSurfaceCommands(surface, {
  allowNative: desktop.isElectron, // false on web
  remainingEditorGroups: registry.openEditorGroupCount() - 1,
});

controller.maximize(id);
controller.float(id); // contained float — NOT detach
controller.externalize(id, bounds, { allowNative: true }); // Electron only
```

Detach ≠ float. Web never sets `allowNative`.

### 6. Activation / z-order

On `pointerdown` / `focusin` of a stacked host:

```ts
controller.activate(id);
```

`SurfaceRegistry.foreground` / `zIndex` replace `WorkspaceWindowStack` for
multi-surface stacking. Agent 06 may keep a thin adapter until shells move.

### 7. What not to do

- Do not put Electron / IPC here.
- Do not migrate preference keys or delete legacy writers in this module.
- Do not destroy Monaco/WebGL hosts across mode changes — style the frame.
- Do not access `window` / `document` at module evaluation time.

## Accessibility decisions

| Concern         | Decision                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Floating resize | Eight `role="separator"` grips, `tabindex="0"`, edge-specific `aria-label`, orientation horizontal for n/s |
| Docked resize   | Single free-edge separator with `aria-valuenow/min/max`                                                    |
| Keyboard        | Arrow = 16px, Shift+Arrow = 64px (`arrowKeyDelta`)                                                         |
| Title bar       | Buttons/links ignored for drag and double-click maximize                                                   |
| Motion          | `SurfaceFrameMotionDirective` + `prefers-reduced-motion` CSS; `ReducedMotion` for non-CSS consumers        |
| Focus order     | Most recently activated stacked surface gets highest z-index                                               |

## Module map

| Path                    | Role                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `surface-registry.ts`   | Instances, hydrate/snapshot, activation, z-order, viewport |
| `surface-controller.ts` | Transition facade + registry writes                        |
| `surface-commands.ts`   | Capability-filtered command descriptors                    |
| `surface-frame.ts`      | Display projection / recovery (no persistence)             |
| `surface-gesture.ts`    | Pointer capture + live preview → commit                    |
| `surface-keyboard.ts`   | Keyboard resize math + ARIA helpers                        |
| `controls/*`            | Workspace measure, title bar, resize grips, motion         |
