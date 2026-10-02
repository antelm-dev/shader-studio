# Official plugins

Sources of the plugin packages that ship with each Shadergrove release and
appear under **Plugins → Available**. They install and run like any other
package: reviewed, installed switched off, enabled explicitly, and executed in
the isolated plugin Worker. The app has no built-in fallback for what they do.

| Folder              | Package id                         | Contributions                                          |
| ------------------- | ---------------------------------- | ------------------------------------------------------ |
| `shadertoy/`        | `dev.shadergrove.shadertoy`        | `projectImporter` (paste, provider `shadertoy-api/v1`) |
| `wallpaper-engine/` | `dev.shadergrove.wallpaper-engine` | `projectExporter` (runtime `wallpaper-web/v1`)         |

## Layout and build

Each folder holds `manifest.json`, `listing.json` (catalogue-only text: the
description) and `src/index.ts`, the Worker entry. `release.json` lists the
folders this release's catalogue offers, in order.

```sh
pnpm gen:plugins     # bundle every package and write the catalogue
pnpm check:plugins   # fail if the committed output is not what the sources build
```

The generator (`tools/workspace/src/generate/official-plugins.ts`) bundles
`src/index.ts` with esbuild into one IIFE — no imports, no network, DOM or
dynamic code (it refuses bundles that mention them) — and writes
`<id>-<version>.sgplugin.json` plus `catalogue.json` to
`apps/studio/src/plugins/`, which the app serves as `plugins/…` on the web and
under `shader-studio://bundle/plugins/…` on the desktop (offline). Each
catalogue entry pins its file's size and SHA-256; the app checks both, and the
manifest's id, version, protocol and app range, before the usual review. The
hash is an integrity check, not a publisher signature.

A version is immutable: change the code, bump `manifest.version`. Installing a
newer version from the catalogue is an explicit **Update** that leaves the
package switched off until the user enables it again; if the update fails, the
installed version stays.

## Protocol 2 contract

`libs/shared/src/plugin/project.ts` is the source of truth; in short:

- `manifest.protocolVersion: 2`. Protocol 1 packages (effects, file
  importers/exporters, themes) are unchanged and still accepted.
- **`projectImporter`** — `{ kind, id, name, modes: ("paste" | "provider")[],
provider?: "shadertoy-api/v1", maxInputBytes, maxOutputBytes }` (limits up
  to 4 MiB). Method `projectImporter:<id>`, called with
  - `{ mode: "paste", name, text }` — host-rendered form, text ≤ 256 KiB; or
  - `{ mode: "provider", provider, sourceId, source }` — the JSON the host's
    provider fetched (≤ 2 MiB). **No credential is ever sent.**

  It returns a `ProjectCandidate`: `{ name, description, credits: { author?,
sourceUrl? }, project, controls, values, textures, warnings }`. Texture
  bindings in `project` are cleared; textures arrive only as `textures`
  requests `{ asset, uses: [{ passId, channel }], wrap, filter, flipY }`,
  which the host's provider resolves against its own allow-list, slots in
  first-requested order (failed downloads take no slot), and the host
  validates the final bundle before importing it atomically.

- **`projectExporter`** — `{ kind, id, name, runtime: "wallpaper-web/v1",
maxInputBytes, maxOutputBytes }`. Method `projectExporter:<id>`, called with
  a `ProjectExportInput` snapshot of the open draft (unsaved edits included,
  nothing saved): `{ name, author?, project, controls, params, channels,
postProcessingActive }`, where `channels` is texture _metadata_ only. It
  returns `{ data, warnings }`; `data` must satisfy the runtime's schema
  (`libs/shared/src/plugin/wallpaper-web.ts`). The host runtime alone writes
  executable files and assets.
- Only the adapter ids above resolve (`SOURCE_PROVIDER_IDS`,
  `EXPORT_RUNTIME_IDS`); naming one selects host code and grants the plugin
  nothing. Implementations are registered by the app with
  `provideHostAdapters()` (`apps/studio/src/app/plugins/host-adapters.ts`).
- Every call runs in a fresh Worker, one at a time, with the 10 s timeout and
  real termination of protocol 1. The host captures profile, open shader and
  package id/version/install time when a call starts
  (`PluginInstallations.context`) and refuses the result if any changed;
  disabling, updating or removing a package aborts its pending work.

## Rights

A plugin's licence covers the plugin's code. Content it imports — a Shadertoy
shader, for example — keeps its author's rights and licence; the importer
records the author and source URL with the shader.
