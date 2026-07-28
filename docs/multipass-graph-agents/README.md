# Multipass graph view: coordinator runbook

This folder is a staged prompt pack for implementing a visual, live-aware graph
of Shader Studio's multipass render pipeline.

The graph is initially an **inspection and navigation surface**, not a second
project editor. It should make buffers, texture inputs, current-frame
dependencies, previous-frame feedback, and the final image understandable
without opening every pass configuration.

## MVP contract

- Open the graph from the editor workspace without replacing the existing pass
  tabs or pass settings.
- Represent enabled and disabled buffer passes, assigned texture slots, and the
  final Image pass as typed nodes.
- Represent ordinary buffer reads, texture reads, and feedback reads as
  visually and semantically distinct edges.
- Label each binding with its consuming `iChannel0`…`iChannel3`.
- Show pass name, kind, resolution, compile state, diagnostic count, and a
  throttled live preview when the renderer can provide one.
- Select a pass node to activate its existing editor document.
- Highlight the upstream path for a selected node and dim unrelated nodes.
- Provide deterministic automatic layout, pan, zoom, fit-to-view, keyboard
  navigation, and a reduced-motion-safe experience.
- Persist graph visibility and viewport preferences, but keep automatic node
  positions derived in the MVP.
- Surface broken bindings, disabled dependencies, invalid same-frame cycles,
  unavailable WebGL, and preview-capture failure without breaking editing.
- Keep English and French catalogs in sync.

Do not add arbitrary graph rewiring, drag-to-connect, pass creation, node
deletion, grouping, a minimap, execution animation, GPU profiling, or persistent
manual node positions in this iteration. Those are deliberate follow-ups.

## Repository facts agents must preserve

- `ShaderProject` and `ChannelBinding` in
  `libs/shared/src/project/types.ts` are the source of truth.
- `feedback: true` means “read the previous frame” and is **not** a same-frame
  dependency.
- `resolvePassOrder` in `libs/shared/src/project/pass-order.ts` already owns
  dependency validation and execution order.
- `ShaderCanvas` composes the current project into `EnginePass` values and owns
  the primary `ShaderEngine`.
- `ShaderEngine` and `BufferTargets` own WebGL resources, including ping-pong
  render targets. UI code must not retain Three.js textures or targets.
- `RendererHandle` is the existing application-level seam for the active
  renderer.
- `ShaderStore` owns selection, documents, compile state, diagnostics, render
  order, and the current draft.
- The app is SSR-capable. Graph code must not access browser APIs at module
  evaluation time.

Prompt 01 may refine these facts in an implementation contract after inspecting
the exact integration commit. Later prompts must follow that contract.

## Branch and worktree policy

Every implementation agent, including integration and QA agents, must work in
its own Git worktree on its own `codex/` branch. No agent edits the checkout in
which it was launched.

The coordinator first creates an integration worktree:

```powershell
$RepoRoot = "<REPO_ROOT>"
$BaseRef = "<BASE_REF>"
$IntegrationTree = "<REPO_PARENT>\shader-studio-multipass-graph-integration"

git -C $RepoRoot worktree add $IntegrationTree `
  -b codex/multipass-graph-integration `
  $BaseRef
```

Record the exact starting point:

```powershell
git -C $IntegrationTree rev-parse HEAD
git -C $IntegrationTree status --short
```

Each agent receives the current integration commit, creates its worktree from
that commit, and commits throughout the task at coherent checkpoints. A large
finished implementation left only in a working tree is not an acceptable
handoff.

Agents must not merge, rebase, push, or cherry-pick into the integration branch.
Every handoff must include:

- branch name and absolute worktree path;
- ordered commit hashes and subjects;
- checks run and exact results;
- assumptions, compromises, and known risks;
- confirmation that `git status --short` is empty.

## Execution graph

```text
01 contract and seams
          |
          +--------------------+--------------------+
          |                    |                    |
02 projection + layout   03 live previews     04 graph UI shell
          |                    |                    |
          +--------------------+--------------------+
                               |
                     05 workspace integration
                               |
                           06 final QA
```

## Wave 1 — contract

Run [01-contract-and-seams.md](prompts/01-contract-and-seams.md) alone.

Review its implementation contract and commits. Cherry-pick approved commits,
in order, into the integration worktree:

```powershell
git -C $IntegrationTree cherry-pick <commit-1> <commit-2>
```

Run the checks named in the handoff. Prompts 02–04 must all branch from this
exact integration tip.

## Wave 2 — three agents in parallel

Start these prompts concurrently:

- [02-graph-projection-and-layout.md](prompts/02-graph-projection-and-layout.md)
- [03-live-node-previews.md](prompts/03-live-node-previews.md)
- [04-graph-panel-ui.md](prompts/04-graph-panel-ui.md)

Their primary ownership is intentionally separate:

| Agent | Primary ownership                                                           |
| ----- | --------------------------------------------------------------------------- |
| 02    | Pure graph projection, validation mapping, layout, and unit tests           |
| 03    | Renderer readback/preview seam, throttling, cleanup, and unit tests         |
| 04    | New graph panel components, preferences, i18n, styling, and component tests |

Agents may read any file but must not casually edit another stream's ownership.
If the contract proves insufficient, make the smallest isolated contract change
in its own commit and call it out immediately.

Suggested cherry-pick order after all three finish:

1. Agent 02 — graph data and layout.
2. Agent 03 — renderer preview seam.
3. Agent 04 — UI shell and preferences.

Resolve integration conflicts only in the integration worktree. Then run focused
tests, `pnpm check:i18n`, and `pnpm typecheck`.

## Wave 3 — workspace integration

Run [05-workspace-integration.md](prompts/05-workspace-integration.md) from the
post-Wave-2 integration commit.

This agent connects the panel to the actual store and renderer, places it in the
workspace, implements selection/path highlighting and responsive behavior, and
adds integration tests. Cherry-pick its commits in reported order.

## Wave 4 — final QA

Run [06-final-qa.md](prompts/06-final-qa.md) from the fully integrated commit.
The QA agent must inspect the real feature, run broad validation, and commit
approved fixes rather than merely writing a defect report.

After cherry-picking QA commits, run:

```powershell
git -C $IntegrationTree status --short
pnpm --dir $IntegrationTree check
pnpm --dir $IntegrationTree typecheck
pnpm --dir $IntegrationTree test
pnpm --dir $IntegrationTree build
```

If the local pnpm version does not support `--dir`, run the commands with
`$IntegrationTree` as the working directory.

## Coordinator rules

- Record and share exact commit hashes; never tell an agent to branch from a
  moving branch name.
- Do not start a dependent wave from a stale integration commit.
- Review every commit before cherry-picking it.
- Keep conflict resolutions in small, explained commits.
- Preserve unrelated changes and never use destructive cleanup.
- Notify all live Wave 2 agents if a shared contract changes.
- Prefer focused tests after each cherry-pick and broad tests at wave boundaries.
- Keep renderer readback opt-in and bounded. The graph must not reduce normal
  preview frame rate when closed.
- Reject UI implementations that reconstruct render semantics independently of
  the shared graph projection.
- The coordinator owns the integration branch. Agents do not push or open pull
  requests unless explicitly asked later.

## Definition of done

- A multipass project has an accurate graph containing buffer, texture, and
  final-image nodes.
- Current-frame and previous-frame feedback edges cannot be confused by color,
  shape, label, or accessible text.
- Edge direction consistently means resource producer to pass consumer.
- Each edge identifies the consuming channel.
- Graph layout is deterministic across reloads and independent of array-index
  identity.
- Selecting a pass node opens the existing editor document and highlights its
  dependency path.
- Compile, diagnostic, disabled, and invalid-binding states are visible without
  relying on color alone.
- Live previews update at a bounded rate, stop when hidden, release object URLs
  or other resources, and degrade gracefully when readback is unavailable.
- The feature is keyboard-usable, SSR-safe, translated, responsive, and honors
  reduced motion.
- Existing rendering, feedback semantics, shader switching, editor navigation,
  detached previews, output windows, capture/export, and context recovery still
  work.
- Check, typecheck, tests, and production build pass.
- The final integration worktree is clean with reviewable incremental history.
