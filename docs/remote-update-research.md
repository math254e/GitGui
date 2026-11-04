# Remote update research (deferred)

Status: reference research only; excluded from the current desktop update scope.
Updated: 2026-10-29.

Remote updates are deferred until GitGui's remote architecture has been brought
closer to T3 Code. Reassess the design against that implementation before
planning remote update work. The GitGui translations below are preliminary,
not an approved future architecture or a requirement for desktop updates.

The prerequisite connection work is now distilled into
[remote connection reliability](remote-connection-reliability-plan.md), including
SSH acquisition ownership, separate pairing, migration, and reconnect validation.
That plan does not enable remote updating.

The current implementation plan is [auto-update-plan.md](auto-update-plan.md).
It covers desktop releases, download/install, and the top-bar update control.
Standalone bundles, service launchers, remote authentication changes, SSH
provisioning, and remote desktop update requests are outside that scope.

The following findings were retained from the initial research to avoid losing
the source investigation. The baseline records the original inspection.

## Research baseline and source map

Inspected the clean local checkout at
`D:/GitHub/PictureTagingApp.references/t3code`, HEAD
`70cd258d8aac43ea57494527b00bf36de3efa6c0`.

GitGui's existing runtime manifest instead records
`1688f965682d331da16a8c39f049592361f69c8d`
(`v0.1.2-nightly.20261021.3473`). That object is unavailable in this reference
checkout. The inspected checkout also uses Effect `4.0.0-beta.103`, whereas
GitGui requires `4.0.5`. Treat this as a source baseline difference: port the
selected update behavior and tests with explicit provenance; do not bulk sync
the connection runtime or downgrade Effect. Before implementation, reconcile
the reference snapshot with the existing vendoring policy and record the
chosen per-file sources and adaptations.

T3 sources inspected:

- `docs/internals/{workspace-layout,connection-runtime,remote,environment-auth,server-updates}.md`
  and `docs/{user/updating,operations/release}.md`.
- `apps/desktop/src/updates/{DesktopUpdates,updateMachine,updateChannels,releaseNotes}.ts`:
  state, scheduling, channel selection, progress, release notes, install recovery.
- `apps/desktop/src/electron/ElectronUpdater.ts` and
  `apps/desktop/src/ipc/methods/updates.ts`: narrow updater adapter and bridge.
- `apps/desktop/src/updates/{DesktopRemoteUpdates,remoteUpdateFlow}.ts` and
  `apps/server/src/desktopUpdate/DesktopAppUpdate.ts`: remote preparation,
  reservation, commit, failure replay, cancellation, and expiry.
- `apps/server/src/cloud/{selfUpdate,pinnedRuntime,serviceProtocol,serviceLauncherClient,servicePreflight,bootService}.ts`,
  `apps/server/src/serviceLauncher.ts`, and `serverActivation.ts`: immutable
  installs, durable launcher state, preflight, trial, commit, rollback, service setup.
- `packages/client-runtime/src/state/server.ts`: progress shared across views,
  handoff handling, reconnect observation, and exact outcome validation.
- `packages/contracts/src/{server,environment,rpc}.ts`,
  `apps/server/src/auth/RpcAuthorization.ts`: advertised capabilities and authorization.
- `packages/ssh/src/{command,tunnel}.ts`: remote bootstrap and process ownership.
- `apps/web/src/components/{desktopUpdate.logic,ServerUpdateAction}.tsx/ts`,
  the update tests beside these modules, `.github/workflows/release.yml`,
  `scripts/{build-desktop-artifact,merge-update-manifests,update-release-package-versions}.ts`.

### What T3 actually does

Desktop uses `electron-updater`, a GitHub Releases provider baked into the
package, a 15-second initial check, and four-minute polling. It explicitly sets
`autoDownload = false` and `autoInstallOnAppQuit = false`. The first update
action downloads; the next offers restart/install. Actions are serialized and
a downloaded installer survives unrelated check errors. Installation stops
owned local backends first. A reported install failure clears quitting state,
keeps the windows, restarts stopped backends, and permits retry.

Standalone remote self-update requires a stable service launcher. The active
server installs an exact npm version into staging and preflights it; the
launcher selects a trial, stops the old child, snapshots SQLite, and starts the
candidate. The candidate prepares all startup work behind an activation gate.
Only then does the launcher durably commit and permit commands. A failed trial
restores the snapshot and boots the previous version. The prepared deadline is
120 seconds. Foreground processes do not self-replace.

Remote desktop updates use a different owner: the server asks its Electron
parent to check/download over an inherited control channel. Preparation returns
a token while the RPC connection is alive. A separate commit triggers install.
The result reports the version actually selected by that desktop's feed;
the request's target version does not pin a remote desktop installer.

T3's SSH runner can provision using npm/npx, but SSH transport alone does not
make a foreground server service-managed or self-updatable. GitGui needs an
explicit translation for updating its SSH-owned Rust processes.

## Remote update protocol and authentication

Extend `crates/gitgui-protocol`, regenerate TypeScript, and adapt the existing
method table and descriptor schemas. Proposed public methods, not existing CLI:

- `server.get_update`: supported owner/mode, availability, active operation,
  preparation/terminal outcome, selected version, and safe failure reason.
- `server.prepare_update`: exact target version and client operation identifier;
  returns an operation ID promptly while preparation continues server-side.
- `server.commit_update`: the prepared operation/token; initiates owner handoff.
- `server.cancel_update`: cancels uncommitted preparation only.
- An authorized environment update event carries sequenced progress; the query
  remains authoritative after event gaps, navigation, or reconnect.

This is a deliberate wire adaptation of T3's streaming progress RPC. GitGui's
JSON envelope has no equivalent streaming request and its requests time out
after 30 seconds. Do not hold a multi-minute download inside one request or
increase every RPC timeout. Use the existing event transport plus short queries
and two-phase preparation/commit; do not add another socket implementation.
For service updates the explicit preparation phase is an addition to T3's
service handoff, preserving its acknowledgement-before-restart invariant.

Use a dedicated `server:update` scope and `server:read` for update administration
state. Extend bootstrap administrative grants and permit explicit scoped pairing
for trusted remote maintainers; ordinary `repository:operate` grants must not
silently become server-software installation permission. This differs from T3's
`orchestration:operate` mapping because GitGui's ordinary scope means Git changes.
Display permission limitations, and check authorization before enqueue/admission.
Public descriptors advertise capability only, without preparation tokens.

Persist bearer session verifiers and grants atomically, using hashed opaque
tokens, environment binding, expiry, revocation, and restrictive file permissions.
Persist authentication-required policy independently of a per-launch bootstrap.
Keep bootstrap values in inherited protected transport, tickets ephemeral and
single-use, and existing grants scoped exactly as issued. New administrative
permissions require an explicit new grant; do not elevate old sessions on upgrade.
An existing in-memory grant can be carried into the first persistence-capable
release only where the old process supports migration; older releases may need
one manual update and re-pair. Do not claim seamless upgrade from them.

Operation state is keyed by EnvironmentId, with client operation ID, exact target,
and eventual launcher-generated update ID. Bind preparations to the requesting
authorized session, validate duplicate requests, serialize concurrent installers,
expire uncommitted preparations (T3 uses five minutes), and reject changed targets.
Once commit is durably accepted, loss of the initiating client must not cancel
the update. After reconnect, an authorized query reports the same operation.
Prepared control tokens never enter ordinary logs/settings or public metadata.

## Standalone service updates

Follow T3's durable state model under the environment's runtime directory:
stable launcher, immutable `versions/<version>`, selection state with active
version and at most one pending/committed/rolled-back/failed record, and a
per-update rollback snapshot. Keep runtime downloads outside the server-owned
data snapshot and acquire a single launcher lock per environment data directory.

1. The current Rust server downloads/verifies the exact signed artifact and
   extracts to unique staging. Run a proposed preflight mode that reports exact
   version, target, required launcher protocol, data compatibility, and dependency
   availability without mutating the live data directory.
2. Atomically publish a complete immutable version directory. A partial install
   never becomes selectable. Reuse a verified complete install under the same
   install lock; retain active and rollback versions during garbage collection.
3. On commit, the launcher validates its active child, ownership, target,
   complete install, and allowed newer version. It durably records pending state,
   generates the update ID, and acknowledges before the old child is stopped.
   Preserve T3's response-flush grace after handoff acceptance. A lost response
   is reconciled through the original operation ID and durable launcher outcome,
   not by blindly submitting a second update.
4. Drain the old server, close serving sockets, and stop it. Snapshot only
   enumerated server-owned mutable files with all writers stopped: identity,
   catalog, auth grants/policy, and future schema state. Do not snapshot Git
   repositories or promise to roll back repository changes.
5. Start the trial against the same data directory, configuration, identity,
   bind address/port, origins, and protected authentication model. Prepare
   migrations, repository state, HTTP, and long-lived workers behind an activation
   gate. Discovery/readiness must not report ready or admit normal mutations yet.
6. The trial reports prepared with the expected update ID. The launcher durably
   commits the version before opening the activation gate. No fallible startup
   acquisition is postponed until after commit. Publish ready and the terminal
   correlated outcome only after activation.
7. Trial failure or the 120-second prepared deadline stops the candidate, restores
   the complete server metadata snapshot, durably records rollback, and boots
   the previous version. Interrupted restores resume from a durable marker before
   either version starts. Strict invalid-state handling fails closed.

Copy T3's same-directory replacement, file/directory fsync, serialized event
handling, restart recovery, and versioned launcher protocol. The running server
never edits its systemd/launchd unit or durable launcher selection. Initial service
installation and explicit launcher upgrades happen locally through proposed
`service install/update/status/uninstall` subcommands. A release needing a newer
launcher gives a precise local upgrade instruction before any disruption.

Linux systemd and macOS launchd are the initial standalone service owners.
Native Windows service installation is deferred; Windows desktop-hosted servers
remain covered through Electron and foreground Windows servers have manual guidance.
The stable launcher itself is not overwritten while running by a remote update.

### Git-specific shutdown rule

Before replacing a server, close mutation admission across every client and
repository and drain all started Git operations and catalog writes. Merely
waiting for one socket or one repository queue is insufficient. Pause background
writers and cancel only safe pending/unused reads. If drain cannot finish within
the declared update budget, abort the update before stopping the old process,
restore admission, and report the busy operation. Never force-kill an active Git
mutation to meet an updater timer, and never automatically retry an uncertain
mutation after reconnect. This applies to local desktop updates too.

## SSH-managed environments

Keep provisioning and restoration inside the existing Electron/SSH runner.
Replace npm bootstrap concepts with a target-specific, verified Rust bundle in
a user-owned remote install directory; no sudo and no shell command interpolated
from untrusted release metadata. A remote downloader verifies with an installed
trusted tool/helper, or Electron downloads/verifies and transfers the bytes over
SSH. The first-launch provisioning path can use the latter without requiring
Node or a Rust toolchain on the host.

For GitGui-owned SSH launches, start the same stable launcher in an owned SSH
mode, without installing a system service. It supervises version replacement
using the same state/rollback protocol. This is an explicit extension of T3's
service-only self-update ownership: GitGui needs it to update its currently
foreground SSH-owned Rust servers without npm or detached self-respawn.

Split tunnel release/restoration from explicit owned-environment stop. A health
probe failure must not call the current full `disconnectEnvironment` and kill
the replacement. Restore by reading the owned launch record, checking launcher
identity, querying ready/descriptor, and forwarding to its current bound port.
Use a stable loopback port across child replacements when possible. If it changes,
resolve the new endpoint before the supervisor opens a replacement session.
Preserve credentials and verify the expected EnvironmentId throughout.

Existing PATH-launched environments without the launcher need a one-time explicit
adoption/relaunch. Preserve their exact data directory and ID. Never overwrite or
stop an external server just because it was discovered through SSH. An externally
service-managed server can expose the normal service-update capability, while an
external foreground server offers manual exact-version instructions.

For the local desktop's update restart, distinguish releasing SSH forwards from
explicitly removing an environment. Preserve an owned launcher through that
temporary client restart and restore its forward afterwards; do not route this
through today's full SSH shutdown that kills owned remote servers. This is a
GitGui lifecycle adaptation to avoid interrupting unrelated remote Git work.

## Remote desktop hosts and reconnect completion

Port T3's parent control-channel preparation and commit flow to Rust/Electron.
The remote client receives a prepared token and actual target version while
the backend is alive. It then commits; only the Electron parent downloads and
installs the full desktop package, keeping the bundled Rust server and UI aligned.
The parent reserves that version, handles duplicate/local-vs-remote races, and
replays an install failure for the same token after restarting a stopped backend.

The remote desktop's configured channel selects the actual offered release,
matching T3; it may differ from the requesting client's exact version. Report
that target before commit and reject a protocol-incompatible result. An older
desktop parent without control support offers local update guidance. The Rust
server must never overwrite an executable bundled inside a desktop installation.

In the shared client runtime, adapt T3's update operation state without its agent
or thread continuation behavior. Resolve each command against the current
supervisor/session; retain per-environment update status across navigation and
selection changes. Observe reconnect before triggering commit so a fast restart
cannot race the listener. Arm outcome observation before handoff and query the
last outcome immediately on a replacement session so missed events are harmless.

Success requires the same EnvironmentId, a replacement ready session at the
accepted target version, and the matching committed update ID for launcher
updates. Rollback/failed outcomes terminate immediately with their reason.
For desktop updates, follow T3's token/failure replay and verify replacement
generation plus actual version; a successful disconnect alone proves nothing.
Progress deadlines may end the update UI operation, but the supervisor keeps
its normal indefinite transient reconnect behavior. Clear update-specific
resources on explicit environment removal; never turn a post-commit removal
into a rollback or automatic command replay.

Keep version difference and RPC incompatibility distinct. A compatible older
server can be updated to the client's exact version. A newer compatible server
must not be downgraded to match an older client; prompt to update the client.
Unsupported old servers and blocked incompatible protocol connections need
manual/local recovery guidance. Do not bypass authentication or protocol checks
to make an update button work. For future breaking protocols, retain a compatible
upgrade path or ship an intermediate release before dropping the old protocol.
