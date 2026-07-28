# Agent 06 prompt — final QA, performance, and accessibility

You are the final QA and hardening agent for the multipass graph view.

## Git setup

Create a dedicated worktree from the exact post-integration commit:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<POST_INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-qa"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-qa `
  $StartRef
Set-Location $Worktree
git status --short
```

Begin only from empty status. Commit fixes incrementally by concern. Do not
merge, rebase, push, or cherry-pick.

## Objective

Validate the implemented feature as user-facing software, fix issues found, and
leave a release-ready branch. Do not merely produce a report when an in-scope
fix is safe.

Read:

- `docs/multipass-graph-agents/README.md`
- `docs/multipass-graph-agents/implementation-contract.md`
- all preceding agent handoffs or commit messages

Then inspect the actual implementation.

## Functional matrix

Exercise at least:

- Image-only project;
- one buffer feeding Image;
- a deep buffer chain;
- fan-in and fan-out;
- texture inputs;
- self-feedback;
- cross-buffer feedback;
- an invalid same-frame cycle;
- missing buffer IDs and unavailable textures;
- disabled producer and consumer passes;
- compile errors in a pass, Common, include file, and vertex source;
- buffer add, remove, rename, reorder, enable/disable, and rewire while open;
- switching shaders with the graph open;
- selecting nodes and returning focus to the editor;
- zoom, pan, fit, resize, collapse, maximize, narrow widths, and reload;
- paused rendering;
- lost/restored WebGL context if test infrastructure supports it;
- primary preview plus detached/output renderer;
- English and French.

Verify that every edge is producer → consumer, labels the consumer channel, and
that feedback is unmistakably previous-frame data.

## Performance and lifecycle

- Confirm no preview sampling occurs while the graph is closed.
- Confirm sampling is bounded and does not queue indefinitely.
- Check that repeated opening, closing, shader switching, and pass deletion do
  not leak timers, subscriptions, object URLs, arrays, or GPU resources.
- Compare normal preview responsiveness with the graph closed and open.
- Test a maximally complex current project: four buffers, four bindings per
  pass, feedback, and textures.
- Ensure layout is stable rather than visibly reshuffling on every preview or
  compile-state update.

## Accessibility and visual QA

- Use keyboard only for opening, traversing, selecting, fitting, and leaving the
  graph.
- Inspect roles, labels, focus order, focus visibility, and announcements.
- Verify states do not rely on color alone.
- Verify reduced motion and high-contrast/forced-colors behavior where possible.
- Inspect overflow, clipping, edge labels, node thumbnails, and tooltips at
  representative desktop and narrow sizes.
- Ensure unavailable previews retain useful text and status.

## Automated validation

Run focused tests first, then:

```powershell
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Run formatting/lint checks appropriate to touched files. If a broad command
fails for an unrelated pre-existing reason, prove that with focused evidence;
do not hide it.

## Fix policy

Commit safe in-scope fixes. Keep separate commits for:

- semantic/data correctness;
- renderer lifecycle/performance;
- UI/accessibility;
- tests or documentation.

Do not expand scope into graph editing, manual positions, profiling, animation,
or unrelated cleanup. Escalate architectural changes to the coordinator instead
of disguising them as QA.

## Handoff

Report:

- worktree and branch;
- ordered commit hashes and subjects;
- full test/check matrix with results;
- defects fixed;
- remaining limitations, severity, and reproduction steps;
- any manual checks the coordinator must repeat;
- clean `git status --short` confirmation.
