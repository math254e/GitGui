# Desktop releases

GitGui packages the Electron shell, static SvelteKit build, and a freshly compiled
release-profile Rust server as one version. Supported release artifacts are
unsigned Windows x64 NSIS installers and Linux x64 AppImages. Git must be installed
on the build machine and on the user's machine. macOS is not part of this workflow.
An unsigned Windows installer may show operating-system reputation prompts.

The baked `app-update.yml` uses electron-updater's public GitHub provider for
`math254e/GitGui`, channel `latest`. The app ID remains `dev.gitgui.desktop`.
No token or environment variable is required to find public updates. Windows
signature verification is disabled for these deliberately unsigned builds; HTTPS,
GitHub release permissions, and metadata SHA-512 checks provide the current trust
boundary. Signing can be added separately when certificates are available.

The desktop package uses stock Electron icons from the bundled runtime's source
version, documented in [the icon sources](../apps/desktop/build/README.md).
The Windows executable, NSIS installer/uninstaller, and installer header share
the ICO; Linux uses the matching PNG.

## Local packaging

For desktop development, close the existing GitGui desktop before rerunning
`npm run dev:desktop`, including an installed copy: installed and development
builds currently share the Electron profile. A secondary launch hands off to the
existing app and skips services/window initialization. The launcher invokes Node
and Electron directly without a command shell. On Windows it checks the exact Cargo debug
executable before building, so a running session produces an actionable message
instead of Cargo's access-denied error. It does not terminate any process.

The direct Electron launch sets `windowsHide: false`; hiding that process on
Windows also hides its first application window. Vite runs directly in the web
workspace, so closing Electron stops the owned Vite process without leaving an
npm/cmd descendant holding port 1420. Readiness failures also clean up that child.

Ctrl+C, SIGTERM and SIGHUP now request a normal Electron quit through an
inherited development-only parent channel. The launcher waits for Electron to
finish its backend/SSH cleanup before stopping Vite and returning. Unexpected
Vite exit uses that same path and returns a failure exit code. A slow desktop
cleanup produces a diagnostic after 30 seconds; the launcher stays attached
instead of force-terminating Electron. Parent-channel loss also requests normal
desktop quit. These controls are disabled in packaged or unmanaged launches.

Use Node 24, npm 11, Git, and a stable Rust toolchain. Windows additionally needs
the Visual Studio C++ build tools and Windows SDK for Rust's MSVC target. Build on
the matching x64 OS; cross-platform builds are rejected so the bundled server
cannot have the wrong executable format. The workflow uses Windows Server 2022
and Ubuntu 22.04; the Linux binary's glibc baseline comes from that build host.

```sh
npm ci
npm run release:test
npm run release:version -- 0.1.0
npm run release:version -- --check 0.1.0
npm run electron:package
```

Replace `0.1.0` with the intended stable `X.Y.Z` version (`vX.Y.Z` is also accepted).
Prereleases and extra channels are deliberately deferred. The version helper
updates all npm workspace versions and internal dependency references, npm's
workspace lock entries, all Rust crate versions, and their Cargo.lock entries.
It does not commit or tag anything. It plans changes before writing and rejects
missing lock entries. Review the local version diff when using it outside CI.

Packaging always builds the release Rust server, generates protocol contracts,
builds the production web app, and compiles SSH and Electron. It never reuses a
debug server or skips compilation. It stages production Node dependencies as real
directories outside the workspace so npm workspace symlinks cannot omit
`@gitgui/ssh` or `@gitgui/contracts`. Installed dependency versions must match the
npm lock. Resource inputs use absolute paths because electron-builder resolves
them against its project directory, independently of `directories.app`.

Outputs are under `release/<version>/<platform>-<target>-x64/`. Existing output
directories are rejected; choose a new directory for a repeat build:

```sh
npm run electron:package -- --output-dir release/trial-2
```

The `artifacts/` subdirectory contains only the release files. The unpacked app
is retained alongside it for inspection. Packaging runs that payload's backend
with `--version`, checks the bundled web entry and updater provider, and extracts
the app ASAR into a temporary directory to load SSH and electron-updater without
development dependencies. It checks the embedded app version and contracts files.
These checks do not launch the Electron UI or install an update.

Windows assets are `GitGui-<version>-win-x64.exe`, its `.exe.blockmap`, and
`latest.yml`. Linux assets are `GitGui-<version>-linux-x64.AppImage` and
`latest-linux.yml`; its differential blockmap is embedded in the AppImage, not a
separate file. The validator checks exact filenames and versions, regular files,
payload size and SHA-512, executable headers, blockmap coverage and every block
checksum, and rejects unexpected release files. It can also validate both platforms
after collecting their artifact directories:

```sh
npm run release:validate -- release-assets 0.1.0 all
```

Linux DEB is an optional local, manual distribution path:

```sh
npm run electron:package -- --target deb --output-dir release/manual-deb
```

DEB receives the same version and bundled-payload smoke checks. It is excluded
from the release matrix and updater metadata validation; distribute and upgrade
it manually. The supported Linux automatic-update distribution is AppImage.

## Version-tag GitHub Actions workflow

`.github/workflows/desktop-release.yml` builds only when a new stable version tag
such as `v0.1.1` is pushed. Branch pushes, pull requests, schedules, and manual
dispatches do not trigger this workflow. Tag deletion and updates to existing tags
are rejected before any build. The tag filter excludes prereleases; validation
also rejects leading zeroes and versions outside the Windows component limit.
Every job checks out the triggering commit, and the version comes from that tag.
Push this workflow and a new stable version tag to activate the build.

The workflow runs type checks and tests, aligns versions only in the runner's
working copy, builds on both target OSes, smoke-tests the packaged payloads,
validates update metadata and blockmaps, and retains the final files as Actions
artifacts for 14 days.
No source version commits or npm publications occur.

Desktop tests compile their SSH workspace dependency through the desktop
package's `pretest` hook, including when invoked by the root `npm test`. This
keeps clean runners independent of any previous desktop build output.

The workflow uses Node.js 24 action runtimes: checkout/setup-node/upload-artifact
v7 and download-artifact v8. The configured build Node version remains 24.
Artifact filenames use the literal supported `x64` suffix because electron-builder
otherwise expands the AppImage architecture macro to `x86_64` (and DEB to `amd64`).
A regression test exercises those mappings with electron-builder's own helpers.

Publication is disabled by default. Setting the repository Actions variable
`GITGUI_PUBLISH_RELEASES` to an exact stable tag such as `v0.1.5` authorizes only
that release. The value `true` enables publication for every subsequent stable
tag. The final job runs only in `math254e/GitGui` and after every build and check
succeeds. Leave the variable unset for builds that only retain Actions artifacts.

The publication job revalidates both platforms and verifies that the existing
release tag still resolves to the built commit, including annotated tags. It
creates a draft release with `--verify-tag`, uploads all installers and metadata,
then publishes it as latest. It never creates or moves a tag, and refuses to
overwrite an existing release. A failed upload leaves a draft requiring maintainer
inspection; no incomplete release is intentionally exposed. Tags point at source
before runner-only version injection; the tag version is authoritative for the
compiled payloads.

Only this opt-in publication job has `contents: write`. It uses the built-in
`GITHUB_TOKEN` and needs no external release secret. Repository/organization
Actions policies must allow that permission. Packaging always passes
`--publish never` and strips publishing/signing credentials from its child process.
Without the publication variable, new tags produce build artifacts only. There
are no hosted deployments or npm publications.

To use it, commit the configuration and intended source, create a new stable
`vX.Y.Z` tag on that commit, and push that tag. Enable publication before pushing a release tag only
when its installers should become discoverable by the desktop updater.

## T3 Code translation and limits

Inspected the local T3 Code `docs/operations/release.md`,
`scripts/build-desktop-artifact.ts`, `scripts/update-release-package-versions.ts`,
its version-helper tests, and `.github/workflows/release.yml`. Applicable concepts
are aligned versions before compilation, an isolated production app stage,
same-platform packaged dependency validation, GitHub updater configuration baked
at build time, `--publish never` during artifact construction, and publication
gated on validated artifacts and updater metadata.

GitGui deliberately uses npm's existing lock instead of T3's pnpm stage install,
and bundles the native Rust server rather than a Node server/npm CLI. It supports
two unsigned x64 targets and stable tag releases with publication disabled by
default, without T3's macOS, nightly scheduling, release-app credentials, version
commits, npm publishing, or hosted-web deployment. Local helper tests do not
replace an actual build on each OS. Installed version N-to-N+1 updates and Linux
AppImage/desktop runtime testing are deferred at the maintainer's request until
test environments are available. Artifact validation alone does not verify OS
installation or the running updater UI.

## Local implementation verification

On the Windows development host, frontend/desktop type checks, production web
build, Rust workspace check, release helper tests, desktop updater/lifecycle
tests, and the packaged Windows payload/metadata/blockmap checks passed. The
current local installer is under `release/electron-icon-verification/artifacts/`.
No workflow, tag creation, GitHub settings change, or publication was performed
during that local verification.

The full default-concurrency test run passed the JavaScript, protocol, and Git
core suites but hit five server-test deadlines on this Windows host. Rerunning
the complete server suite with `cargo test -p gitgui-server -- --test-threads=4`
passed, including all five affected tests and the inherited-control process
test. Test-case concurrency was bounded; the tests still exercise concurrent
clients and detached Git workers within each case. One existing Svelte
accessibility warning remains in `WorkingTreeFileList.svelte`.

The desktop control integration now also keeps stdin open while exercising
real Git startup, repository refresh, snapshot reads, and shutdown. That test
reproduced a Windows hang before Git's default stdin was isolated from the
control pipe, then passed after the fix. A separate Git input test confirms
commands that explicitly supply stdin still work. The installer above was
rebuilt with this correction and its payload/metadata checks passed.

The Windows installer was subsequently rebuilt with the stock Electron icon
assets. Native executable resource inspection confirmed all four icon sizes in
both `GitGui.exe` and the NSIS installer match the source Electron ICO after
resource-format normalization. Packaging, bundled payload, updater metadata,
and blockmap validation also passed for that build.

Linux AppImage packaging/desktop runtime and installed N-to-N+1 updates on both
platforms remain release-qualification work. No live release feed was published for those
tests. The version-tag-only workflow is now implemented locally. Event/version
guard tests and publication shell tests use fixtures, including moved/missing
tags, an existing release, and upload failure; they do not contact GitHub.
All 14 release helper tests and actionlint 1.7.12 passed for the tag-only change.

The workflow filter and event guards follow GitHub's
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [push payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)
documentation. The existing-tag check uses the
[commits API](https://docs.github.com/en/rest/commits/commits#get-a-commit), and
publication uses the documented [gh release create --verify-tag](https://cli.github.com/manual/gh_release_create)
behavior.

## Agentbox Linux server validation

On 2026-11-02, Agentbox validated the current uncommitted Rust source in an
isolated source fixture. The baseline was
`88d37cf24137f940a2e43ebe717831b986798c1c`, with the transferred tracked diff and
new Rust files applied; all 45 normalized source hashes matched before and
after testing. Compressed transfer SHA-256:
`e2c5247643631a0d0c47199fd98bd04689265667df7b6fbfaa96b812ab41154f`.

The host ran Ubuntu 26.04.1 LTS x86_64, glibc 2.43, Rust/Cargo 1.99.1, and Git
2.53.0. These commands passed with isolated Cargo output and temporary test data:

```sh
cargo check --workspace --locked
cargo test --workspace --locked -- --test-threads=4
cargo build --release -p gitgui-server --locked
```

There were 284 passing tests, zero failures, and two pre-existing ignored local
measurement tests. Both real server-process integration tests passed, covering
repository startup/refresh with the control pipe open, bootstrap/control framing,
prepare/resume/shutdown, and exact child exit. Unit coverage also passed for
malformed control input, host-wide admission, disconnected mutations, drain
timeout/refusal, EOF resume, cooperative shutdown, and explicit Git stdin.

The release binary reported `gitgui-server 0.1.0`; `file` confirmed an x86-64 ELF,
and `ldd` found no missing dependencies on Agentbox. This does not establish the
Ubuntu 22.04 release runner's glibc compatibility. Process integration tests used
the debug test binary; the release binary was built and version/dependency checked.

The checkout was unchanged and no owned test servers remained. The report,
source manifest, and logs are retained on Agentbox at
`/tmp/gitgui-linux-update-validation-up1fiyao/report.md`; temporary files may be
removed by the host later. This verifies Linux server behavior only. AppImage
packaging, graphical desktop runtime, and installed upgrades remain unverified.
