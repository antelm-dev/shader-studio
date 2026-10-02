# 04 — Plugins-tab workflow and app cutover

Read the coordinator README and accepted implementation contracts/evidence
from 01–03. Mission: make both packages discoverable, independently usable from
Plugins, and replace built-in UI execution after real integration acceptance.

## Launch and isolation

Base policy: `integration-tip`. Prerequisites: accepted 02 and 03 locally merged
into `codex/integrate-external-plugins`, regenerated IPC and combined package
checks passing. Coordinator records `<exact-launch-base>` from that tip.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-external-plugins-04 -b codex/external-plugins-04-app <exact-launch-base>
cd E:/Adel/Documents/Orgs/shader-studio-external-plugins-04
git status --short --branch
```

Require clean initial status; read instructions and preserve unrelated changes.

## Owned scope and required work

Own the app workflow boundary: `apps/studio/src/app/plugins/plugins-page.ts`,
new project-action/form orchestration, shared app adapter registration and
DesktopPlatform wiring, workspace transition/menu/dialog integration and i18n.
Own final release catalogue membership, E2E scenarios and user/author docs.
Do not rewrite the conversion/schema/provider/runtime boundaries from 01–03;
coordinate defects with their owner and coordinator.

1. Register accepted typed provider/runtime adapters on web and desktop.
   Generate final catalogue entries from exact validated package versions.
   Verify production and installed desktop assets, SSR safety, offline desktop
   install, integrity/compatibility and deterministic regeneration.
2. Add Available/Installed sections or tabs showing each package, description,
   publisher/licence, contributions and version. Install/update uses existing
   review/store and leaves disabled until explicit enablement. Preserve file
   installation, invalid-package removal, restart state and independent toggles.
3. Installed Shadertoy offers bounded host-rendered paste/name and URL/ID/key
   forms; key preference stays host-side. Wallpaper exports the current shader
   draft, not a chosen custom effect. Dispatch by validated contribution/adapter
   metadata, not package-name checks. Plugins never render their own UI.
4. Apply existing guarded dirty-work/recovery policy before adopting imports;
   export snapshots unsaved values without a save. Validate final bundle and
   import atomically, avoiding partially created shaders. Capture profile,
   project and package/version/activation; abort/refuse stale results before
   adoption/writes. Wire progress, cancel, warnings and actionable errors.
5. Add translations, accessibility/focus and responsive behavior, lifecycle
   specs and `apps/studio-e2e/src/plugins.spec.ts` with disposable existing
   Playwright fixtures. Complete browser and installed-desktop workflows.
6. After README release gates pass, make a separate cutover commit. Audit all
   consumers, including `app.ts`, `ui/menu-commands.ts`,
   `ui/workspace-actions.ts`, `ui/dialogs/new-shader-dialog.ts` and old Shadertoy
   dialog wiring. Remove direct app conversion paths or make shortcuts resolve
   installed actions / lead to Plugins when absent/disabled. No built-in
   fallback or automatic activation. Preserve documented HTTP/IPC compatibility,
   existing shaders/key settings and local ISF packages.
7. Document installation change, supported external-product import workflow,
   remaining warnings, plugin-author contract and release rollback. If required
   installed Wallpaper Engine/desktop evidence is missing, retain migration
   paths as explicit pending work and report the gate; do not claim completion.

Out of scope: marketplace/signatures, automatic updates, new Shadertoy features,
full effects export, key-store redesign and unrelated app reorganization.

## Verification and delivery

Acceptance: AC-UI, AC-LIFECYCLE, AC-CUTOVER. Run
`pnpm --dir apps/studio test:web`, `pnpm check:i18n`,
`pnpm --dir apps/studio-e2e e2e -- plugins.spec.ts`. Verify all six README E2E
scenarios; coordinate the integrated `pnpm ci`, desktop build/package, smoke
and installed external-app gates. Report actual checks separately from proposed
manual steps. Do not substitute dev-browser isolation for installed desktop.

Deliver `integration-only` / `integration-tip` into
`codex/integrate-external-plugins`, eventual PR target `develop`. Make 1–3
logical commits (workflow, validation/docs, gated cutover), review complete diff,
report SHAs, acceptance evidence and gaps. No push/PR/merge/deploy authorized.
