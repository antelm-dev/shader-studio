# Agent 01 prompt — contract and repository seams

You are the contract agent for Shader Studio's multipass graph view.

## Git setup

Do not edit the checkout you were launched in. Create a dedicated worktree and
branch from the exact integration commit supplied by the coordinator:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-contract"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-contract `
  $StartRef
Set-Location $Worktree
git status --short
```

The initial status must be empty. Commit throughout the task. Make at least one
commit for the written contract and a separate commit for executable contract
types or skeleton seams. Do not merge, rebase, push, or cherry-pick.

## Objective

Turn `docs/multipass-graph-agents/README.md` into a repository-grounded
implementation contract that allows agents 02–04 to work concurrently without
inventing incompatible graph, preview, or component APIs.

## Required investigation

Read the current versions of:

- `libs/shared/src/project/types.ts`
- `libs/shared/src/project/queries.ts`
- `libs/shared/src/project/pass-order.ts`
- `apps/web/src/app/workspace/shader-store.ts`
- `apps/web/src/app/rendering/shader-canvas.ts`
- `apps/web/src/app/rendering/shader-engine.ts`
- `apps/web/src/app/rendering/pass-targets.ts`
- `apps/web/src/app/rendering/renderer-handle.ts`
- `apps/web/src/app/ui/editor/editor-panel.ts`
- `apps/web/src/app/ui/preview/preview-shell.ts`
- `apps/web/src/app/prefs/preferences.ts`
- `libs/shared/src/prefs/panel.ts`
- `i18n/en.json` and `i18n/fr.json`

Locate applicable tests and repository instructions. Treat code as newer than
this prompt whenever they disagree.

## Deliverables

1. Add `docs/multipass-graph-agents/implementation-contract.md` defining:
   - exact MVP behavior and explicit non-goals;
   - node and edge kinds, stable IDs, direction, labels, and ports;
   - treatment of Image, Common, enabled/disabled buffers, assigned/missing
     textures, ordinary reads, feedback reads, and broken bindings;
   - how `resolvePassOrder().errors` and compile diagnostics map into graph
     status without duplicating render-order logic;
   - deterministic layout inputs and expected coordinate conventions;
   - selection, upstream-path highlighting, hover, pan, zoom, fit, keyboard
     navigation, and focus behavior;
   - graph open/closed and narrow-width behavior;
   - preview frame shape, ownership, throttling, invalidation, and cleanup;
   - behavior with no project, no buffers, unavailable WebGL, context loss, and
     an inactive or detached renderer;
   - persistence keys and safe defaults;
   - accessibility semantics and reduced-motion behavior;
   - SSR constraints;
   - exact file ownership for agents 02–04;
   - acceptance scenarios.
2. Add the smallest useful contract-only TypeScript types under a new
   `apps/web/src/app/ui/multipass-graph/` folder. Define graph IDs, nodes, ports,
   edges, statuses, geometry, selection state, and preview-frame metadata.
3. Define a narrow preview-provider interface that exposes browser-safe image
   data or URLs, never Three.js objects. Do not implement renderer readback.
4. Add pure compile-time or unit tests if they materially stabilize the seam.

Do not implement projection, layout, WebGL readback, the graph panel, or editor
integration. Do not modify the existing workspace layout.

## Fixed semantic constraints

- Edge direction is producer/resource → consuming pass.
- An ordinary buffer edge participates in same-frame dependency reasoning.
- A feedback edge means previous-frame data and must never be passed to a
  topological sorter as a same-frame dependency.
- A texture node represents an assigned project texture slot, even when loading
  or decoding fails.
- `Common` is not a rendered node. Decide and document whether it is omitted or
  represented as an informational source annotation; do not imply it produces a
  texture.
- Stable identity cannot depend only on a pass's current array index or display
  name.
- The UI does not own or retain GPU resources.
- Closing the graph must stop preview sampling work.
- Existing editor tabs remain present.

## Validation and handoff

Format only touched files and run the narrowest relevant tests plus typecheck if
the contract skeleton enters a production compilation path. Finish clean.

Report:

- absolute worktree path and branch;
- ordered commit hashes and subjects;
- exact checks and results;
- decisions agents 02–04 must treat as fixed;
- unresolved risks;
- clean `git status --short` confirmation.
