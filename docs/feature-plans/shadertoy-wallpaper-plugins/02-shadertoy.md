# 02 — Shadertoy package and host source provider

Read the coordinator README and task 01's committed implementation contract.
Mission: produce the independent Shadertoy package with actual Worker conversion
and the host-only retrieval service needed to preserve paste and API imports.

## Launch and isolation

Base policy: `integration-tip`. Launch only after 01 is accepted and merged
locally into `codex/integrate-external-plugins`. Coordinator pins
`<exact-launch-base>` at that gate and supplies the same SHA to 03.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-external-plugins-02 -b codex/external-plugins-02-shadertoy <exact-launch-base>
cd E:/Adel/Documents/Orgs/shader-studio-external-plugins-02
git status --short --branch
```

Require a clean initial checkout; report collisions/unrelated changes. Read
applicable instructions and preserve all user-owned files.

## Owned scope and required work

Own `plugins/official/shadertoy/`, the conversion boundary in
`libs/shared/src/glsl/shadertoy{,-api}.ts`, a new host Shadertoy provider module,
web retrieval in `apps/studio/src/server/api/shaders/` and shader transport IPC
in `src/desktop/main/ipc/shader.ipc.ts`. Narrow shader API adapter methods/specs
are allowed. Coordinate shared DTOs/barrels through 01/coordinator. Do not edit
PluginsPage, shared app configuration, DesktopPlatform, menus or workspace actions.

1. Establish parity fixtures for paste, Common/Image, buffers/feedback,
   textures, samplers and unsupported-input/download warnings before extraction.
2. Build manifest/versioned standalone package `dev.shadergrove.shadertoy`
   using 01's generator. Reuse pure conversion sources where legacy consumers
   require them; bundle code/dependencies into the Worker with no network/DOM
   or dynamic imports. Actual installed calls must use PluginHost.
3. Export the named provider implementation/typed orchestration seam for 04
   to register. Host fetches bounded source JSON; Worker returns validated
   project data and typed asset references; host validates/resolves assets,
   deduplicates and validates the final bundle. Preserve slot/buffer bindings
   through failed downloads. API key never enters Worker messages.
4. Web server and desktop main retain source-fetch authority: validate source
   ID, approved origins/paths, redirects, content/body bounds, decoding and
   timeout/abort. No arbitrary URL proxy, secret-bearing logs or plugin-selected
   domains. Make cancellation/context tokens composable with the host UI.
5. Preserve existing documented conversion HTTP/IPC response shapes. Trusted
   compatibility wrappers can share pure conversion source; do not execute
   installed plugin JS on the server/main process. Regenerate IPC for checks
   rather than hand-editing the generated bridge.
6. Return warnings and existing author/source information. Clearly separate
   plugin licence from imported-content rights. Retain current unsupported
   input types rather than silently claiming expanded support. Verify official
   API access requirements and record any unavailable live evidence.
7. Supply 04 the provider exports, data fields/forms needed for paste and API
   modes, cancellation and error behavior; user key preferences remain host-owned.

Out of scope: final catalogue membership/UI, dirty-work adoption, command
cutover, Wallpaper files, new input types, marketplace and key-storage redesign.
Request common dependency changes through coordinator rather than conflicting
with 03 on manifests/lockfiles.

## Verification and delivery

Acceptance: AC-SHADERTOY, AC-ISOLATION. Run
`pnpm --dir libs/shared test -- src/glsl/shadertoy`,
`pnpm --dir apps/studio test:server`,
`pnpm --dir apps/studio test:desktop`, `pnpm --dir apps/studio test:web`.
Add deterministic provider/redirect/bounds and actual PluginHost package tests,
assert absence of credentials in Worker requests and validate generated asset
drift. Live API smoke is separately reported; fixtures are mandatory.

Deliver `integration-only` to `codex/integrate-external-plugins` using
`integration-tip`; no remote action. Make 1–3 logical commits, review the full
diff, report SHAs, checks/results, parity fixtures, adapter interface for 04 and
unverified API/installed-app evidence. Coordinator owns final integrated gates.
