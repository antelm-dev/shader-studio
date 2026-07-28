# Agent 02 prompt — graph projection and deterministic layout

You own the pure data side of the multipass graph.

## Git setup

Create a private worktree from the coordinator-provided post-contract commit:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<POST_CONTRACT_INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-model"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-model `
  $StartRef
Set-Location $Worktree
git status --short
```

Do not edit unless the status is empty. Commit incrementally: keep projection
and its tests separate from layout and its tests where practical. Do not merge,
rebase, push, or cherry-pick.

## Objective

Create a pure, deterministic projection from the existing shader project and
status inputs into the graph contract, then lay it out without DOM, Canvas,
WebGL, or Angular dependencies.

Read `docs/multipass-graph-agents/implementation-contract.md` first and treat it
as binding. Inspect current project/query/order/store APIs rather than copying
logic from the prompt.

## Deliverables

- A graph projection module under
  `apps/web/src/app/ui/multipass-graph/`.
- Typed projection inputs for:
  - current `ShaderProject`;
  - assigned texture metadata;
  - compile state and diagnostics;
  - project-order errors from the existing resolver.
- Nodes for buffers, assigned texture slots, and final Image output as specified
  by the contract.
- Typed edges for ordinary buffer reads, feedback reads, texture reads, and
  invalid or unresolved bindings.
- Consumer-channel labels and stable source/target port IDs.
- A pure upstream-path query used by selection highlighting.
- A deterministic, left-to-right layout that:
  - places resources before consumers;
  - ignores feedback edges for rank calculation;
  - routes feedback distinctly;
  - handles fan-in, fan-out, disconnected/disabled nodes, cycles reported by
    the existing validator, texture-only shaders, and Image-only shaders;
  - returns stable coordinates and graph bounds;
  - does not use display names or array positions as identity.
- Focused unit tests covering every binding kind, directionality, feedback,
  cycles, broken IDs, disabled buffers, status aggregation, stable IDs,
  determinism, and path highlighting.

Prefer a small in-repo algorithm over introducing a graph-layout dependency
unless the contract explicitly approves one. Avoid random initial positions and
time-dependent output.

## Boundaries

- Do not edit renderer files, preferences, i18n catalogs, or existing workspace
  components.
- Do not reimplement `resolvePassOrder`; consume its errors and semantics.
- Do not turn feedback into an ordinary dependency to make layout convenient.
- Do not add graph mutation commands.
- Do not couple the model to SVG or HTML event objects.

If a contract correction is unavoidable, isolate it in its own commit and
highlight it in the handoff so all parallel agents can be notified.

## Validation and handoff

Run focused unit tests, formatting for touched files, and the relevant
typecheck. End with a clean worktree.

Report:

- worktree and branch;
- ordered commit hashes and subjects;
- tests/checks and results;
- graph/layout invariants the UI may rely on;
- performance assumptions and unresolved cases;
- clean-status confirmation.
