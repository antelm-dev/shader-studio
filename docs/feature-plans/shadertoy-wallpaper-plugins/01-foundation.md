# 01 — Project operation and catalogue foundations

Read the coordinator README supplied with this prompt. Mission: establish the
typed, bounded host/package boundary and release-distribution seam consumed by
both integrations. This is integration infrastructure, not a shipped standalone
feature or permission to implement the two adapters.

## Launch and isolation

Base policy: `integration-tip`. Prerequisites: none. Coordinator resolves
`<exact-launch-base>` from `codex/integrate-external-plugins`, initially the
README source base, and records it before launch. Use:

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-external-plugins-01 -b codex/external-plugins-01-foundation <exact-launch-base>
cd E:/Adel/Documents/Orgs/shader-studio-external-plugins-01
git status --short --branch
```

Stop on unrelated initial changes or name collisions; preserve them and report.
Read applicable repository instructions. Never use the user's untracked files
as implementation inputs.

## Owned scope and required work

Own the narrow shared host/package boundary: `libs/shared/src/plugin/`,
`apps/studio/src/app/plugins/plugin-host.ts`, new catalogue/adapter interfaces,
necessary `plugin-installations.ts` integration, and common production package
generation/build asset wiring (`tools/workspace`, `apps/studio/angular.json`).
Associated specs and shared export/IPC DTO seams belong here when necessary;
do not create broad architecture refactors.

1. Capture current protocol-v1 ISF behavior. Add protocol-2 project contribution
   validation/dispatch without changing effect import/export semantics. Define
   paste/provider input modes, import candidate/texture references, bounded
   warnings and typed project-export/runtime data. Reject unknown fields/kinds.
2. Freeze interfaces for named provider `shadertoy-api/v1` and host runtime
   `wallpaper-web/v1`, including adapter registration and cancellation. Define
   source fetch → conversion → asset resolution → final validation flow. Keys
   and write authority never cross the Worker boundary. Do not import adapter
   implementations that later workers have not supplied.
3. Specify immutable draft snapshots, context tokens and project quotas using
   texture fixtures; count serialized/transferred bytes before allocation.
   Preserve global Worker queue/timeout/termination and existing effect limits.
4. Provide deterministic standalone package generation from
   `plugins/official/<name>/`, catalogue schema and same-release asset loader.
   Check size/hash/ID/version/range before existing review/install persistence.
   Explicit replacement leaves disabled state; failed writes retain the old
   package. Catalogue lookup/browsing must never execute code.
5. Wire web/desktop asset copying and SSR-safe lookup, including packaged
   desktop URL resolution. Do not advertise placeholder integrations; use
   synthetic fixtures to validate the foundation. Workers 02/03 add their
   sources/output, worker 04 finalizes catalogue entries and UI.
6. Commit a concise implementation contract/fixture description for dependents:
   exact schemas/methods, generator commands, adapter exports, quotas, input
   forms and supported paths. Coordinate required common dependency/lockfile
   changes here so parallel workers do not edit them.

Out of scope: Shadertoy retrieval/conversion implementation, Wallpaper runtime
and writes, PluginsPage/forms/menu cutover, hosted registry, signing, public
submissions and unrelated untracked `libs/desktop-api/`.

## Verification and delivery

Acceptance: AC-CONTRACT, AC-DISTRIBUTION. Add rejection/abort/context and
catalogue corruption/replacement tests plus protocol-v1 regression evidence.
Run `pnpm --dir libs/shared test -- src/plugin`,
`pnpm --dir apps/studio test:web`, `pnpm build`; prove copied assets and no SSR
browser-global access. Synthetic fixtures are not final integration acceptance.

Delivery: `integration-only` to `codex/integrate-external-plugins`, base policy
`integration-tip`; no independently deployable PR or remote action. Make 1–3
logical commits, review the full diff, and report SHAs, exact commands/results,
interfaces for dependent workers, acceptance evidence and remaining gaps.
