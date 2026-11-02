# Desktop auto-update implementation plan

Status: desktop updating and the stable-tag workflow are implemented; v0.1.5 is published.
Research date: 2026-10-29.

Validation update, 2026-11-02: the stable-tag workflow is implemented and locally
linted/tested and Windows/Linux packaging passed in GitHub Actions. Linux Rust
workspace checks, 284 tests, and a release server build
passed on Agentbox against the transferred current source. See
[desktop-releases.md](desktop-releases.md#agentbox-linux-server-validation).
The installed Windows app was observed upgrading from 0.1.3 to 0.1.5 and
relaunching its backend. Linux desktop runtime/installed upgrades and broader
installed failure-path qualification remain deferred at the maintainer's request.

## Scope decision

Implement desktop auto-updates first. Copy T3 Code's desktop update state
machine, explicit download/install UX, progress, release notes, and install
failure recovery. Publish desktop packages through GitHub Releases, built by
the GitHub Actions workflow configured in this change. Do not distribute GitGui through npm.

The selected targets are Windows x64 NSIS and Linux x64 AppImage. Builds are
unsigned for this initial personal/small-group distribution. macOS is excluded.
GitHub builds must run only when a new stable version tag such as `v0.1.1` is
pushed. Branch pushes, pull requests, schedules, and manual dispatches must not
start release builds. Derive and validate the release version from that tag.
Publication remains disabled until separately enabled; a build trigger does not
authorize publication. Publication was enabled for v0.1.5 and disabled afterward.

The version-tag-only trigger is implemented in the local workflow. It admits new
tag pushes only and validates the stable version before compilation. Publication
uses the existing tag and stays disabled unless the repository Actions variable
`GITGUI_PUBLISH_RELEASES` is explicitly set to `true` or the exact authorized tag.

Remote updates are deferred until GitGui's remote architecture is closer to
T3 Code. This includes remote service launchers, trial/rollback, standalone
server update bundles, remote update RPC and permissions, restart-safe remote
authentication, SSH provisioning/adoption, and remotely triggered desktop
updates. None is a prerequisite for this desktop feature.

The initial remote investigation is retained in
[remote-update-research.md](remote-update-research.md). It is reference material,
not a committed future design. Revisit it against the actual remote implementation
and current T3 sources when remote update work starts.

## Research baseline

Inspected the clean local T3 checkout at
`D:/GitHub/PictureTagingApp.references/t3code`, HEAD
`70cd258d8aac43ea57494527b00bf36de3efa6c0`.

Desktop sources:

- `apps/desktop/src/updates/{DesktopUpdates,updateMachine,updateChannels,releaseNotes}.ts`
  and their tests.
- `apps/desktop/src/electron/ElectronUpdater.ts` and
  `apps/desktop/src/ipc/methods/updates.ts`.
- `apps/web/src/components/desktopUpdate.logic.ts` and its tests.
- `docs/operations/release.md`, `.github/workflows/release.yml`, and
  `scripts/{build-desktop-artifact,merge-update-manifests,update-release-package-versions}.ts`.
- The required workspace, connection-runtime, remote, and environment-auth docs,
  plus desktop lifecycle and SSH ownership sources.

The reference checkout uses Effect `4.0.0-beta.103`, while GitGui requires
`4.0.5`. GitGui's vendored runtime records a different upstream snapshot,
`1688f965682d331da16a8c39f049592361f69c8d`, unavailable in this checkout.
Record the actual source of each copied update module and its adaptations.
Port selected desktop behavior without bulk syncing the connection runtime
or downgrading its dependencies. Resolve provenance for any existing vendored
file that actually needs changing; a full runtime resync is outside this feature.

## T3 behavior to copy

T3 uses `electron-updater` with a GitHub Releases provider baked into the package.
Checks begin after 15 seconds and repeat every four minutes. It explicitly sets
`autoDownload = false` and `autoInstallOnAppQuit = false`.

The first action downloads an update. After download, a second action offers
restart/install with confirmation. State includes versions, progress, release
notes, last check, and retryable errors. Checks, downloads, installs, and channel
changes are serialized. A downloaded installer survives unrelated check failures.

Before installing, Electron stops its owned local backends. If the updater
reports installation failure while Electron remains alive, it clears quitting
state, keeps its windows, restarts the stopped backends, and permits retry.
This recovery does not provide service-style rollback of a completed OS installer.

### Audit corrections and copy boundaries (2026-11-02)

The updater is an adapted implementation, not part of the file-by-file
client-runtime vendoring manifest. Its original introduction (`7e49ce0`) already
contained the unconditional downloaded-installer retention, omitted bounded
diagnostics, and tag-only release-note stripping. These were incomplete copies
of the inspected T3 snapshot, not required Rust or Svelte differences.

- `update-machine.ts:updateAvailable` follows T3's
  `updateMachine.ts:reduceDesktopUpdateStateOnUpdateAvailable`: preserve the
  installer only for a matching offer; replace it for a different offer. A
  matching offer can refresh its notes, retaining existing notes only when the
  feed omits them. Expected-version installation waits up to 90 seconds for an
  admitted background check, then revalidates the version and reserves the
  install action. Changed versions and timed-out checks refuse installation;
  disposal releases waiting callers. Unversioned calls do not wait.
- `release-notes.ts` copies T3's entity decoder and strip-before-decode order
  from `releaseNotes.ts`. GitGui keeps bounded plain text instead of grouped
  summaries: six notes, 32,000 input characters, 8,000 output characters.
  Additional input handling preserves unknown named entities and invalid Unicode
  scalars literally and strips control characters after decoding. The UI renders
  the result as text, including decoded angle brackets.
- `update-diagnostics.ts`, `desktop-updates.ts`, and `electron-updater.ts`
  translate T3's bounded `DesktopUpdates.ts` failure annotations into the
  existing Promise lifecycle. The default stderr sink records fixed operation,
  error-tag, channel, and optional event fields. It never inspects raw errors or
  nested causes. Free-form library logging stays disabled; a failing diagnostic
  sink cannot interrupt installation recovery. Event and promise failure paths
  can each produce an annotation, as separate boundary observations.
- `main.ts` and `packages/ssh/src/index.ts` translate T3's early install
  reservation and `tunnel.ts` manager/entry scopes into GitGui's existing Promise
  manager: close SSH admission synchronously before backend preparation, cancel
  pending setup, and drain resource disposal before installation can quit.
  Results arriving after closure are disposed instead of registered. Recovery
  reopens admission only after the backend is restored, before emitting wakeup;
  failed recovery leaves admission closed. Normal shutdown uses the same drain.
  Existing managed/external remote-process ownership remains unchanged. T3's
  Effect scope cancellation is translated to an AbortController per acquisition.
  Close aborts launch-result waits, readiness probes, and outstanding prompts;
  the password window closes and native host-trust dialogs receive the signal.
  Late answers cannot start a retry after recovery. T3's one-second probe budget
  covers both HTTP headers and body consumption, inside GitGui's existing
  60-second overall readiness budget. Prompts expire after T3's three-minute
  budget. Cleanup cancels deadline timers and listeners; owned remote cleanup
  retains its existing 15-second budget. No new connection retry owner is added.

The SSH race combined snapshot-only cleanup introduced in `369e98c` with updater
cleanup added in `7e49ce0`. The regression tests exercise the real manager through
desktop IPC with controlled SSH/HTTP boundaries, including late setup, auth
prompts, pending disposal, failed installation/recovery, and ordinary quit.

Source for these corrections remains T3 commit
`70cd258d8aac43ea57494527b00bf36de3efa6c0`; regressions are adapted from its
`DesktopUpdates.test.ts` and `releaseNotes.test.ts`. Future syncs must compare
the applicable upstream implementation and failure tests together, then record
each concrete adaptation rather than claiming file-for-file updater vendoring.

Combined correction validation: 66 desktop tests and 19 SSH tests passed;
both package TypeScript checks and the SSH/desktop production TypeScript build
passed. Regression coverage includes unanswered prompts, stalled descriptor
headers/bodies, a real streaming HTTP body that never finishes, prompt/probe
deadlines, and confirmed installs overlapping matching/replacement/failed checks.
Installed upgrades were not repeated as part of these corrections.

### Deferred remote launch cleanup (release decision)

The follow-up review found a remaining P2 in launch cancellation: if the remote
script has already started its detached managed server but its launch result has
not arrived, cancellation kills the local SSH process without stopping that
remote server. Late launch output is ignored. If the server's ownership metadata
was written, a later attempt can reuse it without the lost bootstrap credential,
potentially preventing first-time onboarding. The cancellation tests establish
local cleanup, not complete remote launch cleanup.

The maintainer explicitly deferred this issue to the remote architecture review
while authorizing the next desktop release. That work must retain ownership
during launch, record it before readiness, and drain bounded, ownership-checked
remote cleanup on cancellation, including a launcher still running. The cleanup
claims above apply to acquired resources with known ownership; they do not
establish cleanup for an interrupted remote launch before its result arrives.

## GitGui starting point before implementation

- `apps/desktop/src/main.ts` already has `electron-updater`, status events,
  checks, and a direct `quitAndInstall()` action. The feed currently comes from
  `GITGUI_UPDATE_FEED_URL`. Automatic download/install defaults are not explicitly
  disabled, and actions, progress, and install recovery are incomplete.
- `apps/desktop/electron-builder.yml` packages the web app and Rust server with
  NSIS, DMG, AppImage, and DEB. It lacks publish configuration and explicitly
  selects DMG without the macOS update ZIP.
- `packages/contracts/src/desktop.ts` and `preload.cts` expose basic
  status/check/install capabilities; the web app does not consume them yet.
- `TopMenu.svelte` ends with Settings, and `routes/+layout.svelte` mounts the
  shared application chrome. These are the presentation integration points.
- `BackendManager` owns the primary local server. Its existing shutdown uses
  termination with a five-second forced-stop fallback, so update installation
  needs a safe local shutdown path before it can be enabled.
- Desktop, web, and Rust package versions are separate `0.1.0` values today.

## Architecture

Electron main owns release checks, installer downloads, update state, action
serialization, installation, and local backend shutdown/recovery. Extract this
from `main.ts` into focused modules following T3's updater service, pure state
reducers, and narrow `electron-updater` adapter.

The preload bridge exposes typed status, check, download, install, and state
subscription capabilities. Keep these contracts separate from Rust Git RPC.
Errors sent to the renderer are bounded and safe for display.

Mount one desktop-update adapter at the Svelte application root. The adapter
receives the optional desktop capability through application composition and
supplies state/actions to presentation components. Components do not detect
Electron, manage updater timers, or import Electron packages. Hosted web remains
buildable and simply has no desktop install action.

The Rust change, if required, is limited to safely quiescing and stopping the
primary local server under Electron's ownership. Do not introduce a service
launcher, remote updater protocol, or environment update controller for this work.
The existing connection supervisor still owns reconnection after install failure
recovery; no updater-specific transport retry loop is added.

### Keep the desktop service ready for remote callers

Preserve T3's reusable updater service boundary now, so a later remote request
can invoke the same implementation as a local button:

- Keep check, download, version-checked install, state subscription, disabled
  reasons, and accepted/rejected action results in the Electron service.
- Keep confirmation and presentation in the UI; the updater service owns action
  reservations, lifecycle coordination, and failure recovery independently of
  which authorized caller initiated an action.
- Revalidate the expected downloaded version when reserving installation. A
  future preparation/commit adapter can build on this without replacing the
  installer or permitting stale prepared versions to install.
- Keep release identity, channel, and component versions explicit, while
  desktop bridge types remain separate from future server update contracts.

This preserves useful integration points, not a remote implementation. Do not
add unused RPC methods, preparation tokens, launcher binaries, permission scopes,
or speculative SSH behavior. Design the actual remote adapter after remote
ownership, authentication, and reconnect behavior are established.

## Desktop release contract

Use GitHub Releases initially, matching T3's desktop provider. The configured
workflow builds and validates; publication is a separate opt-in job.
Bake the public release repository into the packaged app so users
need neither a feed environment variable nor a GitHub token. A generic HTTPS
feed can remain an explicit deployment alternative without changing updater UX.

The release matrix contains Windows x64 NSIS and Linux x64 AppImage. DEB remains
an optional manual packaging target, outside the updater release matrix.
Validate additional targets before claiming updater support.

Required release outputs:

- Windows NSIS and Linux AppImage payloads.
- Generated `latest.yml` and `latest-linux.yml`, the Windows external blockmap,
  and Linux's embedded blockmap, with all referenced payloads.
- A single release version applied to the desktop package, compiled web build,
  and bundled Rust server. Install the whole desktop package together; the
  bundled Rust executable is not updated independently.

Preserve `electron-updater` payload checksum verification and blockmap support.
Windows code-signature verification is explicitly disabled for the selected
unsigned build policy. Signing remains a future packaging change; no certificate
or external signing secret is needed now. Use the locked updater version's APIs.

Upload and validate all assets in a draft release before publication. Check that
every updater manifest references an available payload of the declared version.
For a static mirror, upload versioned assets before advancing channel metadata.
Support HTTP range requests for differential downloads.

Start with stable releases. Keep T3's channel separation in the design, but a
nightly selector and channel-switching UX can be added when the pipeline serves
nightly releases. No standalone server archives, custom signed Rust release
manifest, or remote package matrix is required for this scope.

## Update button and interaction

Place the update button immediately to the left of Settings at the right end
of the top repository tab bar. It always refers to the local GitGui desktop app,
regardless of the currently selected environment. Do not add an environment
update menu or remote update actions in this feature.

Copy T3's state-driven interaction:

1. Hide the button while no actionable update exists. General settings exposes
   the installed version, last check, and a manual **Check for updates** action.
2. When an update is available, show the update button and target version.
   Selecting it downloads the package. Include a release-notes preview/link.
3. During download, show progress and prevent duplicate actions.
4. After download, offer **Restart and install**, with confirmation identifying
   the desktop restart and any affected connections.
5. Show download/install failure with Retry. Retain the downloaded installer
   when a later check fails. Installation failures that keep Electron alive
   restore the local backend and usable UI.

Keep unsupported development/install forms disabled with an accurate reason.
The browser UI has no desktop updater button. Automatic hosted-web reload and
remote client/server version-skew UX are separate future work.

## Local installation lifecycle

1. Reserve the install action so checks/downloads cannot race it. Persist pending
   client workspace state and check that the expected downloaded version remains
   installable.
2. Ask the primary local server to stop admitting new Git mutations and drain
   already-started Git work/catalog writes across its clients and repositories.
   Use a narrow desktop-owned control channel if the current lifecycle cannot
   provide this safely; account for Windows shutdown behavior explicitly.
3. If work cannot drain within the update budget, abort installation, restore
   admission, and report that GitGui is busy. Do not force-kill a running Git
   mutation to meet the updater timeout or replay mutations after reconnect.
4. Stop the quiescent local backend and call `quitAndInstall` with T3's
   silent/relaunch behavior. Coordinate this with `before-quit` through one
   lifecycle owner to avoid the current handler racing updater shutdown.
5. If invocation or an updater event reports failure while the app is alive,
   clear quitting state, restart the local backend, release the reservation,
   and preserve retryable update state and the application windows.
6. On successful relaunch, use the normal primary registration/bootstrap flow
   and restore the saved workspace. Check that desktop, web, and bundled server
   report the same version.

Existing remote connections follow the app's current shutdown/reconnect behavior.
Test a local desktop restart with saved direct and SSH connections and describe
its actual effects in the restart confirmation. Preserve registrations and
credentials. Do not make uninterrupted remote work, new SSH ownership semantics,
or remote architecture parity a prerequisite for desktop updates. Any small
shutdown fix needed must stay within the existing process-ownership boundary.

## Implementation sequence

1. **Release foundations.** Record copied-source provenance; align desktop/web/
   bundled-server versions; configure the release provider and Windows/Linux
   artifact validation. Configure builds only on new stable `vX.Y.Z` tags, with
   publishing disabled by default, and produce a local production package.
2. **Updater service and bridge.** Port T3's reducer, adapter, action serialization,
   automatic-check/manual-download policy, progress, release notes, and safe
   retry states. Extend the typed preload contract and mount one Svelte adapter.
3. **Local install lifecycle.** Add safe local quiesce/stop as needed, coordinate
   Electron quit behavior, and implement both synchronous and event-driven
   failure recovery. Keep install disabled until these paths are validated.
4. **Top-bar UX and qualification.** Add the button beside Settings, download and
   install confirmation, General settings check/status, and release notes.
   Verify real installed-package upgrades and document supported install forms.

The version-tag-only workflow has built and published v0.1.5. Further pushes,
tags and publication require maintainer authorization; the audit corrections do
not create a release. Remote architecture work and remote updating remain
separate follow-ups with their own plans.

## Verification and completion

- Port T3's relevant updater tests: initial/interval checks, progress,
  serialization, downloaded-installer preservation, download retry, safe errors,
  and state subscription cleanup. Include guards for Windows and Linux AppImage
  installation forms; unsupported platforms remain disabled.
- Test local active Git operations, drain refusal, delayed shutdown, installer
  invocation failure, asynchronous updater failure, backend recovery, and races
  with normal quit. Verify no automatic download or install-on-quit.
- Test unavailable feed, malformed/missing metadata, interrupted/corrupt download,
  low disk, payload checksum mismatch, and retry without losing usable state.
- Test button placement/states, keyboard access, progress, confirmation, release
  notes, manual checks, and the browser build without Electron capabilities.
- Smoke-test installed version A to B on Windows NSIS and Linux AppImage.
  Verify aligned component versions, saved tabs/preferences,
  repository state, registrations, and credentials after relaunch. Exercise
  existing direct/SSH connection behavior without promising remote upgrades.
- Run appropriate package tests, `npm run check`, `npm run build`, Rust checks
  and lifecycle tests if Rust changes, and `git diff --check`. If a vendored file
  changes, update its header and vendoring documentation/manifest and validate
  it against the chosen reference. Add before/after screenshots and an interaction
  recording during implementation; reuse an existing development session.

Completion means the desktop can discover a release, download it from the top-bar
button, restart/install the complete package, restore its workspace, and recover
from reported pre-exit installation failures. Remote self-updating is excluded
from this milestone.

## External documentation checked

- [electron-builder v26 auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/):
  providers, metadata, macOS signing/ZIP requirements, progress, and packaging.
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases):
  asset/tag immutability and publishing complete draft releases.
