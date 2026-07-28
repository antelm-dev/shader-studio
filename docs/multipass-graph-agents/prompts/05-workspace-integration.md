# Agent 05 prompt — workspace integration and complete user flow

You are the integration agent. All Wave 2 work has already been reviewed and
cherry-picked into the integration branch.

## Git setup

Create your own worktree from the exact fully integrated Wave 2 commit:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<POST_WAVE_2_INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-integration-agent"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-workspace-integration `
  $StartRef
Set-Location $Worktree
git status --short
```

Do not begin unless status is empty. Commit throughout: wiring, workspace
layout/behavior, and integration tests should be distinct checkpoints. Do not
merge, rebase, push, or cherry-pick.

## Objective

Connect the graph model, layout, preview provider, and presentational panel into
one polished Shader Studio workflow without introducing a second source of truth.

Read the implementation contract and every Wave 2 handoff. Inspect the current
code after cherry-picks; do not assume APIs from the original prompts.

## Required integration

- Derive graph input from the current draft, texture metadata, store compilation
  state, diagnostics, and `resolvePassOrder` results.
- Feed that data through the shared projection/layout only.
- Subscribe to live previews only while the graph is visible and the panel can
  consume them; unsubscribe when hidden, destroyed, or switched away.
- Add a discoverable graph toggle to the editor/workspace chrome.
- Place the graph according to the contract:
  - useful alongside the editor at normal widths;
  - overlay/drawer or other contract-defined behavior at narrow widths;
  - no Monaco starvation or broken editor relayout;
  - existing pass tabs and pass configuration remain available.
- Pass-node selection must call the existing document-selection/navigation path.
- Texture nodes and final-output nodes must not masquerade as editable documents.
- Implement upstream-path highlighting and dim unrelated nodes without hiding
  diagnostic or invalid states.
- Fit the graph on first meaningful open and when the project identity changes,
  while preserving the user's current viewport during ordinary draft edits.
- Handle shader switches, buffer add/remove/rename/reorder/enable, channel
  rewiring, texture changes, compile debounce, context loss, and renderer
  replacement without stale nodes or previews.
- Ensure graph keyboard focus does not steal editor shortcuts after focus returns
  to Monaco.
- Add integration tests covering the complete flows and lifecycle boundaries.

## Required regression review

Check:

- editor selection and diagnostic navigation;
- resize/collapse/maximize behavior;
- SSR and hydration;
- detached preview/output window renderer selection;
- multipass rendering and feedback;
- save/revert/draft recovery;
- capture/export paths;
- English/French rendering;
- graph closed-state performance.

## Boundaries

- Do not expand the MVP into graph editing, manual node placement, profiling, or
  execution animation.
- Do not bypass the projection with component-local channel traversal.
- Do not poll the renderer when the graph is closed.
- Do not persist transient selection or preview blobs into shader records.
- Prefer adapters over invasive rewrites of stable renderer/editor code.

## Validation and handoff

Run focused integration and renderer tests, i18n check, typecheck, and production
build. Run broader tests if time permits. Commit fixes and finish clean.

Report:

- worktree and branch;
- ordered commits;
- exact checks and results;
- end-to-end behavior implemented;
- remaining risks suitable for QA;
- clean-status confirmation.
