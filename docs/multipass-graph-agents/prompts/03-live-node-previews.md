# Agent 03 prompt — bounded live node previews

You own the renderer-to-graph preview seam.

## Git setup

Create a dedicated worktree from the exact post-contract integration commit:

```powershell
$RepoRoot = "<REPO_ROOT>"
$StartRef = "<POST_CONTRACT_INTEGRATION_COMMIT>"
$Worktree = "<REPO_PARENT>\shader-studio-multipass-graph-previews"

git -C $RepoRoot worktree add $Worktree `
  -b codex/multipass-graph-previews `
  $StartRef
Set-Location $Worktree
git status --short
```

Start only from an empty status. Commit along the way, separating low-level
readback, application service/throttling, and tests into coherent commits. Do
not merge, rebase, push, or cherry-pick.

## Objective

Implement the contract's optional, bounded stream of node preview frames without
leaking WebGL or Three.js ownership into UI code and without penalizing normal
rendering while the graph is closed.

Read `docs/multipass-graph-agents/implementation-contract.md` first. Then inspect
`ShaderEngine`, `BufferTargets`, `ShaderCanvas`, `RendererHandle`, context
lifecycle, offline capture, thumbnail encoding, and multipass tests.

## Required behavior

- Expose final-image and buffer previews through the contract provider.
- Return browser-safe frame data defined by the contract; never return
  `THREE.Texture`, `WebGLRenderTarget`, renderer, or GL context references.
- Make preview observation explicitly subscribable/enableable. With no consumer:
  - perform no readbacks;
  - allocate no recurring preview buffers;
  - schedule no preview timers.
- Bound update rate and preview dimensions. Prefer one coordinated sampling pass
  over independent timers per node.
- Coalesce slow readbacks; never build an unbounded queue.
- Preserve the main render loop, capture/export, detached preview, output window,
  pause semantics, shader switching, feedback ping-pong, and context ownership.
- Define deterministic behavior while paused: graph previews may update after
  source/parameter changes but must not secretly advance shader time.
- Invalidate frames when a pass disappears, the selected shader changes, the
  active renderer changes, or a context is lost.
- Revoke object URLs and release buffers/listeners on replacement, unsubscribe,
  and engine disposal.
- Degrade to an unavailable/loading/error state when readback cannot occur.
- Keep SSR safe; browser-only work begins after a live renderer exists.

Use the smallest safe engine seam. If final-image capture can reuse an existing
path, do so without repeatedly PNG-encoding at render-frame rate. For buffer
targets, sample only after a complete multipass frame so previews never expose a
half-written ping-pong state.

## Tests

Add focused tests for:

- no work with zero subscribers;
- rate limiting and coalescing;
- correct pass/frame identity;
- removal and shader-switch invalidation;
- active-engine changes;
- unsubscribe/dispose cleanup;
- paused behavior;
- context loss/recovery;
- readback or encoding failure;
- no regression to feedback target selection.

Use fakes where browser GPU behavior is not reliably available in unit tests.

## Boundaries

- Do not build graph components, edit preferences/i18n, or integrate the panel.
- Do not add profiling/timing collection.
- Do not create a WebGL context per graph node.
- Do not make the preview service a second render engine.
- Do not expose mutable engine internals.

If the contract must change, isolate the change in its own commit and flag it
immediately.

## Validation and handoff

Run renderer-focused tests, formatting, relevant typecheck, and any multipass or
multi-context regression tests affected by the seam. Finish clean.

Report:

- worktree and branch;
- ordered commits;
- checks and results;
- measured or reasoned readback cost and chosen bounds;
- lifecycle guarantees and known platform limitations;
- clean-status confirmation.
