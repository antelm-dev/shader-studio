# Agent 04 prompt — graph panel UI, preferences, and accessibility

You own the new graph presentation shell and its user preferences.

## Git setup

Create a dedicated worktree from the coordinator-provided post-contract commit:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<POST_CONTRACT_INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-ui"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-ui `
  $StartRef
Set-Location $Worktree
git status --short
```

The initial status must be empty. Commit throughout: preferences/i18n,
presentational components, and tests should be reviewable checkpoints. Do not
merge, rebase, push, or cherry-pick.

## Objective

Build the contract-driven graph panel as presentational Angular components that
can be tested with fixture graph data before real store and renderer integration.

Read `docs/multipass-graph-agents/implementation-contract.md` first.

## Deliverables

- Components under `apps/web/src/app/ui/multipass-graph/` for:
  - panel chrome and empty/unavailable states;
  - graph viewport;
  - typed pass, texture, and final-image nodes;
  - ordinary, texture, feedback, and invalid edges;
  - zoom controls and fit-to-view.
- Inputs/outputs strictly based on contract graph values and preview provider
  values. Do not read `ShaderProject` or reproduce bindings inside components.
- Pan, wheel/pinch zoom, fit-to-view, pointer selection, and keyboard
  navigation with sensible clamping.
- Upstream-path visual treatment supplied through selection-state inputs.
- Node status badges for compiling, diagnostics, disabled, broken, preview
  loading, and preview unavailable.
- Distinct feedback treatment using geometry/pattern/label as well as color.
- Accessible names that announce producer, consumer, channel, feedback timing,
  diagnostics, disabled state, and preview availability.
- Focus visibility and a logical tab/arrow-key strategy.
- Reduced-motion and high-contrast-safe styling.
- Responsive panel behavior defined by the contract.
- Persisted preference fields for open state and viewport defaults using current
  preference infrastructure and safe migration/default behavior.
- English and French translations for every new user-facing string.
- Component-focused tests for interaction math, event outputs, ARIA text,
  status rendering, empty/error states, and preference defaults.

Use SVG for edges and ordinary HTML for accessible nodes unless repository
constraints strongly favor another approach. Avoid a canvas-only UI that hides
semantic content from assistive technology.

## Boundaries

- Do not edit `ShaderEngine`, `ShaderCanvas`, `RendererHandle`, or graph
  projection/layout modules owned by other agents.
- Do not integrate into `EditorPanel` or another existing workspace component.
- Do not implement graph editing, context-menu mutations, manual node dragging,
  or persistent coordinates.
- Do not add a third-party pan/zoom or graph library without clear contract and
  bundle justification.
- Keep Material usage consistent with nearby compact studio controls.

Build fixture data in tests or stories/helpers using the shared contract. If a
contract change is unavoidable, isolate and report it.

## Validation and handoff

Run component tests, preference tests, `pnpm check:i18n`, formatting, and the
relevant typecheck. Finish with a clean worktree.

Report:

- worktree and branch;
- ordered commits;
- checks/results;
- input/output API expected by integration;
- accessibility and responsive decisions;
- known visual limitations;
- clean-status confirmation.
