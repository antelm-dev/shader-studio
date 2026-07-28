# Releasing Shader Studio

Shader Studio has three Windows delivery paths. CI previews are temporary test
builds, beta releases are opt-in Electron updates, and stable releases are
versioned from `master`.

## Repository setup

In **Settings → Actions → General**, enable **Allow GitHub Actions to create and
approve pull requests** so Release Please can maintain its release pull request.

The workflow uses `GITHUB_TOKEN` by default. Optionally add a
`RELEASE_PLEASE_TOKEN` repository secret backed by a fine-grained token with
Contents, Issues, and Pull requests read/write permissions. Resources created
with that token can trigger the normal pull-request CI; resources created with
`GITHUB_TOKEN` do not start new workflows.

## Preview builds

Push to or merge into the `preview` branch. CI runs the normal Windows packaging
check and uploads the unpacked application as
`shader-studio-preview-<commit>`. The artifact is available from the workflow
run for 14 days and is never published to the Electron update feed.

## Stable releases

Release Please runs after pushes to `master` and maintains a release pull
request from Conventional Commits:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer produces a major release.

The first release starts at `1.0.0`. Merge the generated release pull request
when the accumulated changes are ready. Release Please updates `CHANGELOG.md`
and `package.json`, creates the `v<version>` tag and GitHub Release, and the
Windows job attaches the NSIS installer, portable executable, blockmap, and
`latest.yml`.

Stable installers consume the `latest` update channel.

## Beta releases

Open **Actions → Beta release → Run workflow**, choose the commit or branch to
promote, and enter a unique version such as `1.1.0-beta.1`.

The workflow validates the version, creates a draft GitHub prerelease, builds
and uploads the Windows updater assets on the `beta` channel, then publishes the
prerelease only after the build succeeds. A failed build leaves a draft that a
rerun with the same version can reuse.

Users opt into beta updates by installing a beta build. Beta builds consume the
`beta` feed; ordinary versions consume `latest`.
