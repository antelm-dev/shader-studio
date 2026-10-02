# Shadertoy and Wallpaper Engine plugin migration

Status: executable docs-only plan, 2026-10-02. No workers have been launched.

## Goal and milestone

Ship two independently installable official packages in the Plugins tab:
**Shadertoy Import** (paste and URL/ID + API key) and **Wallpaper Engine Export**
(current draft to a web-wallpaper project). Conversion executes in installed
plugin Workers; the host owns UI, credentials, network, adoption, executable
templates and file writes. Preserve existing supported behavior and protocol-v1
ISF/effect packages. Web and installed desktop are both release targets.

This plan covers the complete requested migration. Exception to the skill's
usual 1–3 tasks / two waves: four tasks / three waves are needed to freeze shared
contracts, develop two separate integrations without shared-file conflicts,
then implement the user-facing cutover. No task is an isolated testing or docs
assignment. The preceding eight-task sketch is consolidated as follows:
T1–T3 → 01; T4 → 02; T5 → 03; T6–T8 → 04 and coordinator gates.

## Repository and launch policy

- Source checkout: `E:/Adel/Documents/Orgs/shader-studio`, branch `develop`.
- Source base: `2fff989e13da062fd5f2a895be9d07e97acfe067`; fetched
  `origin/develop` matched this SHA during planning.
- Remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`.
- Remote default: `master`, observed at
  `615702fddc89189ae4e4c85f1ef3a82c5287e171`. It is the release destination,
  not the launch base for this feature's merged plugin/app layout.
- Planning ref: `plans/shadertoy-wallpaper-plugins`. Pin its actual plan
  commit before execution. Integration branch: `codex/integrate-external-plugins`,
  initialized from the recorded source base after checking for collisions.
- All tasks are `integration-only`, `integration-tip`: neither new contracts
  nor incomplete catalogue entries should ship alone. Intended eventual PR
  destination is `develop`; promotion to `master` is a separate release action.
- Resolve and record an immutable launch SHA for every worker. For 01 it is the
  integration branch's initial SHA; 02 and 03 share the accepted 01 tip; 04
  launches only after both accepted package branches are merged locally and
  their combined checks pass. A PR being open does not satisfy a prerequisite.
- Supply this README and the worker prompt directly, or supply pinned planning
  ref + paths with verified read access. Source-based worktrees will not contain
  these documents automatically. Do not depend on the untracked sketch.

No applicable `AGENTS.md` was found in the inspected checkout/ancestors.
Recheck instructions and status at execution. Preserve all unrelated changes,
especially untracked `docs/plugin-adapters-plan.md`,
`docs/shadertoy-wallpaper-plugins-sketch.md` and `libs/desktop-api/`.

## Current boundaries

- `libs/shared/src/plugin/package.ts`: protocol 1, effect-only importer result
  and exporter input; strict manifests and bounded bytes/time.
- `apps/studio/src/app/plugins/`: isolated runner, installed-package store,
  explicit review/enablement, file installation UI; no available catalogue.
- `libs/shared/src/glsl/shadertoy{,-api}.ts`: paste adaptation and full
  Common/Image/buffer/feedback/texture conversion; fetching and conversion mix.
- `apps/studio/src/server/api/shaders/shaders.controller.ts` and
  `src/desktop/main/ipc/shader.ipc.ts`: existing conversion endpoint/IPC returning
  a bundle. Retain compatibility; never run installed third-party JS in either.
- `apps/studio/src/app/rendering/wallpaper-export.ts`: multipass HTML with
  embedded textures and property listener, no property definitions file.
  Post-processing is omitted with a warning.
- `src/desktop/main/ipc/files.ipc.ts`: writes `index.html` to a chosen dedicated
  folder; browser downloads HTML. New delivery is folder / ZIP.
- `tools/workspace/src/generate/isf-plugin.ts`: fixture packaging precedent,
  not the production distribution path for the two new packages.

## Frozen shared direction; task 01 must freeze exact schemas

1. Keep protocol 1 accepted. Introduce protocol 2 with explicit
   `projectImporter` / `projectExporter`; never reinterpret effect contracts.
   Freeze method names, version/range validation and candidate/output schemas.
2. `projectImporter` supports declared paste/provider modes. Host-rendered
   text inputs are bounded; credential inputs are never serialized into Worker
   calls. Candidate data carries project, controls/values, credits, bounded
   warnings and typed texture references; final adoption uses bundle validation.
3. Register named host adapters with typed interfaces: source provider
   `shadertoy-api/v1` and export runtime `wallpaper-web/v1`. Only these supported
   adapter IDs resolve; metadata cannot grant arbitrary fetch/filesystem access.
   01 defines the registration seam; 02/03 export implementations; 04 registers
   them in shared app configuration. No imports of missing modules in 01.
4. Shadertoy flow: host retrieves bounded JSON → Worker converts → host checks
   texture descriptors and downloads approved assets → host validates/adopts
   final bundle. The key stays host-side. Redirects and origins/paths are checked
   by the provider, including assets; arbitrary plugin-provided URLs are refused.
5. Wallpaper flow: immutable draft snapshot → Worker maps to validated data →
   host runtime safely assembles `index.html`, `project.json` and local assets
   → host delivers ZIP/folder. No plugin-supplied executable HTML/JS template.
   Plugins still supply GLSL, which remains subject to project validation.
6. Reuse existing installation persistence and review. Catalogue/packages ship
   with trusted app assets; verify sizes, hash, ID/version and compatibility.
   A hash is an integrity check, not a publisher signature. Browsing runs no code.
   Install/replacement leaves a package disabled until explicit enablement;
   failed replacement preserves the old package. Versions are immutable.
7. Proposed IDs: `dev.shadergrove.shadertoy`,
   `dev.shadergrove.wallpaper-engine`; check uniqueness before freezing.
   Production sources: `plugins/official/shadertoy/` and
   `plugins/official/wallpaper-engine/`. 01 owns shared generation/build wiring;
   02/03 own their respective source and generated package files. 04 finalizes
   the release catalogue only after both packages validate.
8. Do not blindly expand global quotas: current file/input/output limits are
   8/24/16 MiB; existing desktop HTML delivery allows 256 MiB. Agree project
   operation limits using representative texture fixtures, count before large
   allocations/transfer, and avoid silently shrinking supported export cases.
   Host-owned texture resolution/runtime assembly can keep asset bytes outside
   the Worker when its conversion needs only validated metadata.
9. One Worker at a time, abort/timeout and actual termination remain enforced.
   Capture profile, selected project and installed package/version/activation
   for each operation; dispose/cancel or reject stale results before adoption
   and writes. Dirty imports use the host's recovery/transition policy; exports
   snapshot draft state and do not save implicitly.

## Tasks, waves and ownership

| ID  | Outcome                                                             | Wave / prerequisites               | Branch                                 | Sibling worktree                                           | Acceptance                      |
| --- | ------------------------------------------------------------------- | ---------------------------------- | -------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| 01  | Project operation contracts, runner and catalogue distribution seam | 1 / none                           | `codex/external-plugins-01-foundation` | `E:/Adel/Documents/Orgs/shader-studio-external-plugins-01` | AC-CONTRACT, AC-DISTRIBUTION    |
| 02  | Installed Shadertoy Worker package and host source provider         | 2 / accepted 01 integration gate   | `codex/external-plugins-02-shadertoy`  | `E:/Adel/Documents/Orgs/shader-studio-external-plugins-02` | AC-SHADERTOY, AC-ISOLATION      |
| 03  | Installed Wallpaper Worker package and host project delivery        | 2 / accepted 01 integration gate   | `codex/external-plugins-03-wallpaper`  | `E:/Adel/Documents/Orgs/shader-studio-external-plugins-03` | AC-WALLPAPER, AC-OUTPUT         |
| 04  | Plugins-tab install/use workflow and built-in UI cutover            | 3 / accepted combined 02 + 03 gate | `codex/external-plugins-04-app`        | `E:/Adel/Documents/Orgs/shader-studio-external-plugins-04` | AC-UI, AC-LIFECYCLE, AC-CUTOVER |

Every task has delivery `integration-only`, base policy `integration-tip`,
destination `codex/integrate-external-plugins`. No independent default-branch PR.

01 owns shared plugin schemas/host, catalogue service/install state and common
generation/build wiring. 02 owns Shadertoy pure conversion/provider routes,
shader transport IPC and narrowly required API adapters. 03 owns Wallpaper
mapping/runtime, folder/archive writes and file IPC. 04 owns PluginsPage,
shared app adapter registration, action orchestration, workspace transitions,
menu/dialog wiring and i18n. IPC source registration modules for shader/files
are distinct; 02/03 regenerate their own bridge for checks, and the coordinator
regenerates once after merge. Any shared DTO/export barrel edits are coordinated
through an explicit owner, not concurrent changes. 04 handles shared desktop
platform APIs; 03 exposes a typed writer seam without editing that shared file.

Wave 1 gate: version-1 regression specs plus valid/malformed project calls,
catalogue integrity checks and production asset build pass; README/fixtures in
the implementation commit document exact interfaces for 02/03/04. Unsupported
adapters/packages are absent from the visible catalogue.

Wave 2 gate: both deterministic packages run through the actual PluginHost,
their legacy parity tests pass, host providers/runtime validate untrusted data,
and combined IPC generation/typechecks pass. The two workers need not edit
PluginsPage or shared app configuration. Commit fixture evidence with them.

Wave 3 gate: complete browser/installed-desktop workflow and external Wallpaper
Engine acceptance pass. Then 04 removes built-in UI execution in a separate
logical commit. Until that gate, retaining migration paths is explicit pending
work; never declare the milestone complete because source code alone builds.

## Acceptance and verification

- **AC-CONTRACT:** protocol-v1 ISF/effects still work; protocol-2 project
  contributions reject malformed/unknown contracts, unsupported adapters,
  oversize inputs/results, stale replies and cancellation without mutations.
- **AC-DISTRIBUTION:** deterministic production packages and catalogue assets
  work in web/SSR and installed desktop; review/hash/identity/version validation,
  restart persistence, explicit update and offline desktop install are verified.
- **AC-SHADERTOY:** paste and API import preserve supported Common/Image/buffers,
  feedback, textures/samplers and warnings; no partial shader on rejection.
- **AC-ISOLATION:** keys never enter Worker messages or unsafe logs; source
  fetching is bounded/provider-specific; network/IPC escapes fail and actual
  Worker termination is observed in browser and installed desktop.
- **AC-WALLPAPER:** current draft exports without saving; multipass/textures and
  existing post-processing warnings remain; number/bool/color/choice controls
  work with matching metadata/listener/defaults in installed Wallpaper Engine.
- **AC-OUTPUT:** browser ZIP/desktop folder are self-contained; serialization,
  filenames/paths, destination collisions, cancellation and partial-write
  handling are verified. Plugin-generated HTML/JS cannot bypass host templates.
- **AC-UI:** both available entries independently install → explicitly enable
  → run from Installed; status, errors, warnings, cancel and accessibility work.
- **AC-LIFECYCLE:** profile/project/package changes cannot finish against stale
  context; disable/remove abort or refuse pending work; shaders remain portable
  after removal; ISF/local file installation remains supported.
- **AC-CUTOVER:** every app entry point uses its enabled installed contribution
  or leads to Plugins. No built-in app fallback. Documented HTTP/IPC compatibility
  remains; rollback and the installation change are documented.

Workers run the focused suites listed in their prompts. Coordinator runs once
on the integrated result: `pnpm ci`, `pnpm build:desktop`, `pnpm pack:desktop`,
`pnpm e2e`, `pnpm smoke`; include `pnpm gen:ipc` / `pnpm check:ipc` after merging
IPC changes. Repeat only for new fixes or unresolved failures. Use
`pnpm exec oxfmt --check` for modified files; direct local formatter is an
acceptable fallback if pnpm's store lock is inaccessible.

Critical E2E scenarios:

1. Anonymous browser and signed-in profile each discover/install/enable the
   packages, run paste/API import and ZIP export, restart/reload, then independently
   disable/remove. Switching accounts during an operation refuses stale results.
2. Dirty shader import preserves recovery/cancel behavior; Wallpaper uses unsaved
   controls/source from the draft; project selection and package replacement
   during a call cannot target the wrong shader or package version.
3. Installed desktop loads the catalogue/assets offline, runs the Worker under
   `shader-studio://bundle/`, saves a project folder and survives app restart.
4. Invalid source, API error, unsupported inputs, failed/redirected texture fetch,
   oversize data and forced Worker timeout leave projects intact; save cancellation,
   hostile paths/templates and interrupted folder writes never report success.
5. Extract browser ZIP / use desktop folder in real Wallpaper Engine: import/reopen,
   controls, color/choice defaults, feedback/texture render, resolution/aspect ratio,
   offline operation and post-processing warning. Record installed version and
   confirm supplied `project.json` survives the actual supported workflow.
6. Removal keeps imported shaders usable; old menu/new-shader dialog shortcuts
   lead to Plugins when packages are absent/disabled. Legacy HTTP/IPC clients
   still receive documented bundles and errors.

Deterministic fixtures are mandatory; add a bounded live Shadertoy API smoke when
credentials/access are available. Missing real-app/API evidence is a named gap,
never a passed test. Use existing `apps/studio-e2e/src/fixtures.ts` / disposable
Playwright server (port 4322), and `tools/workspace/src/plugin-sandbox-smoke.ts`
for outside-the-page Worker/network observations. Browser dev evidence cannot
substitute for installed desktop or installed Wallpaper Engine evidence.

## Coordination and review handoff

Create isolated worktrees only at execution; record exact absolute paths and
launch SHAs. Never reset or clean the user's checkout. Each worker reads README
and prompt, checks initial status, makes 1–3 logical commits, reviews its complete
diff, and reports commits, actual commands/results, acceptance IDs, omissions
and risks. Return code and fixture evidence to the integration owner; do not
push/open/merge remote PRs on the strength of these prompts.

Coordinator reviews worker diffs before integrating, owns conflicts/schema
changes, refreshes the exact dependency tip, and supplies contract changes to
dependents. Before review, write `execution-record.md` under this plan directory
with resolved SHAs, merged commits and gate evidence. Keep incomplete and failed
checks explicit. Workers' worktrees are retained through review; cleanup after
accepted integration follows the execution skill, never broad recursive deletion.

Remote actions require a later explicit instruction, e.g. “Review completed
tasks and open or merge eligible PRs.” That phrase is a suggested future request,
not authorization from this plan. Final PR destination is `develop`; task commits
are combined only after acceptance, with no standalone incomplete-contract PR.

## Deferred backlog

Hosted marketplace/remote registry, community submissions, publisher signatures,
ratings/payments, automatic background updates, additional Shadertoy input
types, complete post-processing export, Workshop publishing/control, new ISF
catalogue packaging and a wider key-storage migration. No worker prompts for
these items. Recheck Shadertoy API access/documentation and Wallpaper Engine
project import behavior during implementation; external behavior is not inferred
from the current repository's tests.

References: [Wallpaper project import](https://docs.wallpaperengine.io/en/web/first/gettingstarted.html),
[user properties](https://docs.wallpaperengine.io/en/web/customization/properties.html),
[Shadertoy documentation](https://www.shadertoy.com/howto).

## Machine-readable review contract

```yaml
review_contract:
  milestone: shadertoy-wallpaper-installed-plugins
  planning_ref: plans/shadertoy-wallpaper-plugins
  source_base: '2fff989e13da062fd5f2a895be9d07e97acfe067'
  default_branch: master
  integration_branch: codex/integrate-external-plugins
  remote: origin
  intended_pr_target: develop
  tasks:
    - id: '01'
      branch: codex/external-plugins-01-foundation
      depends_on: []
      acceptance: [AC-CONTRACT, AC-DISTRIBUTION]
      checks:
        - 'pnpm --dir libs/shared test -- src/plugin'
        - 'pnpm --dir apps/studio test:web'
        - 'pnpm build'
      delivery: integration-only
      base_policy: integration-tip
    - id: '02'
      branch: codex/external-plugins-02-shadertoy
      depends_on: ['01']
      acceptance: [AC-SHADERTOY, AC-ISOLATION]
      checks:
        - 'pnpm --dir libs/shared test -- src/glsl/shadertoy'
        - 'pnpm --dir apps/studio test:server'
        - 'pnpm --dir apps/studio test:desktop'
        - 'pnpm --dir apps/studio test:web'
      delivery: integration-only
      base_policy: integration-tip
    - id: '03'
      branch: codex/external-plugins-03-wallpaper
      depends_on: ['01']
      acceptance: [AC-WALLPAPER, AC-OUTPUT]
      checks:
        - 'pnpm --dir apps/studio test:web'
        - 'pnpm --dir apps/studio test:desktop'
        - 'pnpm gen:ipc'
        - 'pnpm check:ipc'
      delivery: integration-only
      base_policy: integration-tip
    - id: '04'
      branch: codex/external-plugins-04-app
      depends_on: ['02', '03']
      acceptance: [AC-UI, AC-LIFECYCLE, AC-CUTOVER]
      checks:
        - 'pnpm --dir apps/studio test:web'
        - 'pnpm check:i18n'
        - 'pnpm --dir apps/studio-e2e e2e -- plugins.spec.ts'
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - 'pnpm ci'
    - 'pnpm build:desktop'
    - 'pnpm pack:desktop'
    - 'pnpm e2e'
    - 'pnpm smoke'
  e2e_scenarios:
    - 'Browser discovery/install/enable/import/export and profile isolation'
    - 'Dirty draft, cancellation and stale project/package result rejection'
    - 'Installed desktop offline assets, Worker isolation and project folder'
    - 'Hostile provider/results/paths and failed or interrupted writes'
    - 'Real Wallpaper Engine import/reopen with all supported control types'
    - 'Removal portability, plugin-gated shortcuts and legacy API compatibility'
  deferred:
    - 'Hosted marketplace and publisher signing'
    - 'Automatic background updates and community submissions'
    - 'Additional Shadertoy inputs and full post-processing export'
    - 'Workshop publishing/control and wider key-storage migration'
```
