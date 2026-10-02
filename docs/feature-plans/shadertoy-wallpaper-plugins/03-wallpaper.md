# 03 — Wallpaper Engine package and host project delivery

Read the coordinator README and task 01's committed implementation contract.
Mission: produce an independent Wallpaper conversion package whose validated
data becomes a usable browser ZIP / desktop project folder through host code.

## Launch and isolation

Base policy: `integration-tip`. Prerequisite: accepted 01 committed into the
integration branch. Coordinator records `<exact-launch-base>` at that gate,
the same SHA used for 02.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-external-plugins-03 -b codex/external-plugins-03-wallpaper <exact-launch-base>
cd E:/Adel/Documents/Orgs/shader-studio-external-plugins-03
git status --short --branch
```

Require clean initial status and applicable instructions; preserve user changes
and report branch/worktree collisions rather than resetting anything.

## Owned scope and required work

Own `plugins/official/wallpaper-engine/`,
`apps/studio/src/app/rendering/wallpaper-export.ts` and new bounded runtime/archive
assembly modules, plus `src/desktop/main/ipc/files.ipc.ts` for project delivery.
Associated specs are owned here. Export a typed host adapter/writer seam for 04;
do not edit PluginsPage, shared app configuration, DesktopPlatform, workspace
actions, Shadertoy modules or shared generation/build configuration.

1. Record parity cases: multipass order/feedback, resolution, wrap/filter,
   texture data, controls/defaults and current post-processing warning.
2. Build `dev.shadergrove.wallpaper-engine` using 01's generator. Conversion
   runs in the installed Worker and returns schema-validated mapping/property
   data for `wallpaper-web/v1`. Keep arbitrary HTML/JS out of plugin output;
   host owns executable runtime, serialization and file composition.
3. Preserve current supported rendering, with no hidden source save. Host
   snapshot captures the draft; textures remain correctly associated. Keep
   explicit omission warnings for post-processing. Do not add effects export.
4. Generate consistent keys/defaults/types in listener and `project.json`:
   number, bool, RGB color and choice. Check numeric precision, color encoding,
   key collisions and property changes. Output self-contained `index.html`,
   `project.json` and any required local assets, without remote runtime loads.
5. Browser host creates a bounded ZIP. Desktop host chooses a dedicated folder,
   validates paths/payloads again at IPC boundary, handles existing destinations
   without silent overwrite, and stages/completes writes without reporting
   partial success. Abort/cancel and stale-context checks precede delivery.
   Measure representative texture cases against 01's agreed quotas.
6. Export adapter/project writer interfaces for 04 to register; source IPC
   handlers/DTOs may change narrowly. Regenerate the bridge for checks; shared
   DTO/barrel/dependency changes go through coordinator. 04 owns shared
   DesktopPlatform integration, avoiding parallel edits with 02.
7. Verify real Wallpaper Engine HTML import/reopen behavior for generated
   `project.json`; if import overwrites it, provide a proven project-opening
   workflow/instructions. Do not assume successful metadata import from the
   documentation alone. Record installed version and evidence or an explicit gap.

Out of scope: final catalogue membership/Plugins UI, menu cutover, Shadertoy,
new renderer features, Workshop publishing/control and remote registry.

## Verification and delivery

Acceptance: AC-WALLPAPER, AC-OUTPUT. Run
`pnpm --dir apps/studio test:web`, `pnpm --dir apps/studio test:desktop`,
`pnpm gen:ipc`, `pnpm check:ipc`. Add actual PluginHost package tests, generated
asset parity, serialization/path/oversize rejection and cancel/failure writer
tests. Open extracted ZIP and folder in installed Wallpaper Engine and test
all supported controls, feedback/textures and offline render when available.
Missing installed-product access remains a release gap for 04/coordinator.

Delivery: `integration-only`, `integration-tip`, into
`codex/integrate-external-plugins`; no remote action. Make 1–3 logical commits,
review the entire diff, report SHAs, checks/results, adapter interface for 04,
actual external-product evidence and remaining limitations.
