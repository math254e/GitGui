# Remote reliability implementation and qualification

Date: 2026-11-04. Implementation and qualification record. The researched proposal is
preserved in [the plan](remote-connection-reliability-plan.md); actual boundaries
are in [host runner](ssh-host-runner.md), [durable auth](ssh-auth.md),
[runtime ownership](connection-runtime.md#desktop-managed-ssh-acquisition) and
[source compatibility](ssh-source-compatibility.md).

## Failure coverage

| Boundary | Evidence | Qualification |
| --- | --- | --- |
| Unknown-result cancellation, delayed ensure, EOF/helper death, late claim | Rust ownership and executable `ssh_host_lifecycle` tests | Actual Linux child processes in WSL; real SSH tracked below |
| Launcher races, shared waiter cancellation, stale instance/PID, two environments | Rust ownership and scoped manager lifecycle tests | Deterministic races plus Linux child processes |
| Reused/external ownership and legacy selection | Rust attach-only and locator tests | No PID-only stop; ambiguous pre-helper evidence blocks |
| Busy Git drain and another live client | WorkGate and helper expiry/drain tests | Actual admission/worker permits; no forced Git termination |
| Cross-process grants, single use, restart, expiry, revocation, corrupt storage, scopes | Durable auth and executable HTTP pairing tests | SQLite transactions; owner grants read/operate/manage, ordinary pairing unchanged |
| Stalled HTTP headers/body, redirects, oversized/malformed JSON | Runtime HTTP and SSH transport tests | Loopback HTTP fixtures and controlled streams |
| Saved bearer, 401-only recovery, permission/identity failure | Web platform tests | Healthy reconnect does not pair; mismatch precedes credentials |
| Failed protected save/rename, two environments | Desktop store and catalog tests | Actual filesystem writes; encryption primitive mocked |
| Failed/interrupted RPC preflight, save/claim failure, activation interruption | Shared onboarding/registry tests | Save/claim/handoff order, disabled recovery, scoped cleanup |
| Lost IPC result, cancellation and explicit-disconnect responses | Web platform tests | UUID before IPC; 20-second outer cleanup budget; visible pending status, including normal removal |
| Session replacement, foreground, offline, blocked errors, removal | Driver/gateway, supervisor and Svelte suites | One retry owner, generation replacement, two-environment isolation; no mutation replay |
| Config Include/identity overrides and strict host trust | SSH primitive/trust tests | Fixture evidence is separate from native dialog qualification |

## Review corrections

The first independent client review identified cancellation/activation gaps,
disabled-record recovery, unbounded cancellation IPC and discarded cleanup
uncertainty. Corrections install cleanup before IPC, scope acquisition through
resolver/RPC readiness, mask durable commit and ownership handoff through
activation, retain disabled recovery records and report retained/pending cleanup.
A successful replacement takes ownership before releasing the previous handle
for that ConnectionId. The integrated review additionally found unbounded
explicit-disconnect IPC and discarded removal cleanup outcomes. Disconnect now
returns each operation's outcome through the desktop bridge and reports pending
or retained cleanup; a lost response cannot hold the environment lease forever.

Rust review corrections preserve authentication-required policy separately from
the database, validate environment identity and the digest key in every auth
transaction, and verify host ownership against the live guard and bound listener.
Follow-up corruption cases reject truncated databases, missing metadata or
grant/session tables, and a missing policy beside an established database.
Both files were introduced
by this unreleased durable format; there is no implicit database-only migration.

Real OpenSSH qualification reproduced a further race: a child could exit before
constructing its guard, leaving `cleanup-pending` metadata after a `stopped`
reply. Cancellation now commits observed exit for the matching generation while
rechecking the process lock. The Linux regression and real SSH requalification
passed without a second repair cancellation.

## Executed checks

- Windows client runtime: 86 passed, one existing opt-in test skipped.
- Web suite: 365 passed, seven existing opt-in live tests skipped.
  Focused platform/routes: 44 passed; onboarding: five passed.
- Web/Svelte TypeScript validation passed with the existing
  `WorkingTreeFileList.svelte` accessibility warning.
- Production web and desktop builds passed, including directory recovery.
- Desktop suite: 82 passed. SSH suite: 48 passed.
- Opt-in real Rust crash/restart/reopen regression passed with isolated state;
  cached bearer sessions are reused across process restarts.
- Release tooling: 15 passed. Source-pin validator fixtures passed.
- Latest WSL Linux: 13 ownership/helper tests passed, including the new
  observed-exit and forged-journal regressions. Final Linux executable lifecycle/auth:
  four passed after the auth-table correction. WorkGate: five passed. These
  include a locator longer than Unix socket pathname limits. Windows/Linux
  workspace checks passed at the R2 stage.
- Wider WSL server tests reproduce the pre-existing SHA-256 stash fixture failure
  on Git 2.43.0 (`Cannot save the current status`); stash code is unchanged.
- Final Windows Rust workspace: 291 passed, two existing measurement tests
  ignored, no failures. All seven durable auth tests passed after the final
  corruption cases. `npm run check` passes.
- Source validator: 15 pinned source/test files, 11 adaptation mappings.
  Effect, Effect Vitest and Node platform/shared resolve to 4.0.5. The original
  runtime pin is preserved; full verification against its unavailable upstream
  object could not be repeated (the exact-object fetch timed out). Reviewed
  runtime target hashes and this limitation are recorded in the manifest/docs.

## Qualification limits

Agentbox discovery changed no existing service/repository/auth/data. The first
attempt failed at the provider usage limit and establishes no real SSH result.
Subsequent isolated native Linux qualification established actual OpenSSH and
production TypeScript manager behavior:

- Initial Rust payload `7f68d418371d4b9205aed6f9efdd278d6a6097a7f036828f2da3bd54d369a5cb`:
  26 focused tests passed; real SSH found the cancellation metadata defect above.
- Corrected Rust/manager payload `c67082463641a56fadd66f280ba3d8eef98845ce05b95d9642a25b624c531ca6`:
  31 focused Rust tests passed, real SSH cancellation recorded terminal state,
  and the unmodified 300-second provisional expiry passed. Real Git work drained
  safely; scopes, independent pairing, bearer restart, stale PID/instance,
  shared ownership, two environments and a 207-byte locator passed.
- The production TypeScript manager used real OpenSSH/default dependencies:
  concurrent reuse, pairing/HTTP exchange, claim/cancel/disconnect/reconnect,
  two environments, encrypted-key POSIX askpass and unknown-host fingerprint
  confirmation passed. Callback prompts establish Linux askpass execution,
  not Electron presentation. The fixture needed the shared-platform override
  already present in GitGui's root package/lock; the production dependency graph
  was checked separately and contains only 4.0.5.
- Auth delta `aba035be8e9062ab5b3b82d1b62738fd5830a23d5f4f69b17edaf0f103ba72fb`:
  ten auth-filtered Linux tests passed. Real SSH pairing/saved bearer after
  restart passed; missing marker and truncated database caused startup failure
  while preserving identity and repository catalog.
- Production manager fault injection held a real helper ready response after
  launch. Cancelling the known operation stopped its server and the retired ID
  stayed rejected after opening the output gate. A gated real SSH forward also
  preserved the second acquisition when one of two remote leases was cancelled;
  the survivor paired and claimed successfully. The harness did not instrument
  the internal Deferred or establish that the held frame was actually delivered
  after cancellation. Deterministic scope tests cover those exact interleavings.
- Final auth-only correction also rejects missing grant/session tables without
  running repair DDL. Windows durable auth tests pass; final Linux auth-filtered verification passed
  all ten tests. This later delta is not claimed as part of the earlier SSH payload.
- Fixture audits found no active owned processes or held locks, and the baseline
  repository remained clean.

Reports are retained in owned Agentbox scratch directories:

- `/home/math254e/.t3/scratch/gitgui-linux-ssh-r2.drxm9ehn/REPORT.md`
- `/home/math254e/.t3/scratch/2026-11-04-act-as-the-test-sub-3f07bbd4/qualification/REPORT.md`
- `/home/math254e/.t3/scratch/2026-11-04-act-as-the-test-sub-8c8f8b87/final-fixture/REPORT.md`.

They qualify their recorded source payloads, not later untested deltas.

Windows/Linux native Electron dialogs, Windows askpass execution and
installed desktop upgrade behavior require host qualification; mocks do not
establish native behavior. No existing remote services are deployed or updated.

Remote provisioning/distribution, service installation, auto-updating, relays,
control-plane infrastructure and Git product changes remain deferred. Old servers
without the helper need a compatible binary or an explicit normal endpoint/manual
pairing; there is no unsafe old-launcher fallback. The bounded host journal blocks
when full/corrupt rather than silently pruning cancellation evidence.

Final auth source SHA-256 (LF-normalized):

- `crates/gitgui-server/src/auth.rs`: `e10538ed20dfbe0c3a9c6a227b65bb002ba601a75f383cbe8336789d49bd9a15`.
- `crates/gitgui-server/src/auth_repository.rs`: `18636c3be7e047a43d01d7bd0efaedf516a211f4b85d709d816ea33b71794877`.


## Completion by task

| Task | Implemented result | Remaining qualification |
| --- | --- | --- |
| R0 | Separate pinned source/adaptation/test inventory; stable Effect compatibility; original runtime pin retained | Original runtime snapshot is unavailable for a repeat full sync validation |
| R1 | Config/command/auth/errors and scoped prompts; real Linux key/passphrase/trust execution | Native Electron presentation, Windows askpass and ProxyJump host integration |
| R2 | Durable acquisition, serialized launch/claim/cancel, expiry, exact cooperative ownership and cleanup | None identified in executed Linux helper/SSH scenarios |
| R3 | Durable grants/sessions, independent pairing, scope enforcement, strict corrupt-store rejection | Installed Windows ACL qualification remains separate |
| R4 | Scoped manager, shared forwards, sender-bound IPC, cleanup journal, close/reopen/dispose | Native desktop quit/update presentation remains separate from fixtures |
| R5 | Scoped onboarding, live RPC preflight, atomic protected save, claim/handoff and cancellation status | Full native Electron onboarding remains separate |
| R6 | Full SHA-256 route keys, identity-pinned legacy/directory selection, optional recovery fields | Pre-helper ownership ambiguity requires explicit operator resolution |
| R7 | Multi-environment failure suites and isolated Linux real SSH/production-manager qualification | Exact late-frame delivery/internal Deferred interleavings use deterministic tests |
| R8 | Independent reviews, corrections, provenance and failure/qualification record | Platform limitations above remain explicit |

Reproduction commands (from the project root):

```sh
npm run check
npm run build
npm run desktop:build
npm run test -w @gitgui/client-runtime
npm run test -w @gitgui/ssh
npm run test -w @gitgui/desktop
npm run test -w @gitgui/web
npm run release:test
node scripts/vendor-t3code-ssh.mjs
node --test scripts/vendor-t3code-ssh.test.mjs
cargo test --workspace -- --test-threads=4
```

On Linux, focused native checks are `cargo test -p gitgui-server --lib ssh_host::`,
`cargo test -p gitgui-server --lib auth`, and
`cargo test -p gitgui-server --test ssh_host_lifecycle`.
The opt-in crash/reopen command is recorded in `connection-runtime.md`.

The main checkout remains on baseline `11149a2f8c743e2f4225b57af45327be6403e6fd`.
No commit, release, push, tag, PR or deployment was performed. The original
planning, roadmap and remote-update research files were preserved.


## Installed-profile startup follow-up (2026-11-04)

Native desktop retry exposed a missed released-state fixture: its saved
`server.json` had a historical `gitgui-<pid>-<time>` identity and 13 repository
registrations. UUID-only validation rejected it before auth initialization.
The correction keeps the original identity/catalog bytes, validates environment
IDs as bounded opaque values throughout primary/SSH paths, and still requires
UUID acquisition/process-instance IDs. New environments still receive UUIDs.
Server diagnostics now use stderr, so an early startup failure is visible to
the desktop instead of being swallowed by the stdout readiness parser.

Validation: Windows legacy identity/catalog/bearer restart passed; both native
inherited-control tests passed with a legacy profile; 49 SSH, 87 desktop and 45
focused web platform/routes tests passed; 14 Linux helper tests passed with
historical-ID ownership and locator fixtures; type checks and desktop build
passed. The failed development session had exited. One fresh native Windows
development session then reached readiness and performed ordinary repository
RPC traffic against the preserved identity and 13-entry catalog. That session was later found to have a hidden window, as corrected below.
This qualifies the native server startup path, not window visibility or the separate
Windows SSH prompt or installed-updater cases listed above.


The bounded follow-up review also aligned Rust's ownership UUID syntax with the
desktop: simple/braced/URN spellings and unsupported version/variant forms are
rejected for acquisition/instance keys. This does not constrain historical
EnvironmentIds. That helper-only correction is tested separately from the live
Windows primary binary; the working development session is not restarted to
apply an unrelated helper syntax check.


## Native window visibility and launcher cleanup follow-up (2026-11-04)

The direct Windows Electron spawn had inherited `windowsHide: true` from the
former command shim. Native Win32 enumeration confirmed that the owned GitGui
window existed but was invisible, despite its healthy server/RPC session. The
launcher now uses `windowsHide: false` for Electron, matching Electron's own CLI.
It also owns Vite directly instead of an npm/cmd chain, registers termination
handlers before waiting for readiness, bounds each readiness fetch and cleans
up a failed launch. Preflight reports the actual running server rather than
assuming a visible application window.

The original hidden session was identified by exact PID, executable path,
creation time and parent chain, then closed with WM_CLOSE on its verified owned
window. Its leftover Vite PID was verified by the same ownership evidence and
stopped exactly. A fresh native launch with the correction passed Win32
`IsWindowVisible`; normal window close then released Electron, Rust, Vite and
esbuild. The launcher exited zero; a final process/port audit found zero owned
qualification processes, zero checkout servers and zero listeners on port 1420.
No development session is left running by this verification. Launcher syntax
and the four preflight tests passed. Existing profile/catalog data was retained.


## Development signal and Vite failure corrections (2026-11-04)

Independent review found that launcher Ctrl+C/SIGTERM killed Electron before
normal cleanup, and that Vite exit after readiness left the desktop running.
Both now use normal desktop quit through an inherited parent-only development
channel; the launcher waits for the exact desktop exit before stopping Vite.
There is no force-kill fallback for Electron. A delayed cleanup is reported after
30 seconds while ownership remains attached. SIGHUP and parent-channel loss are
also handled. Shutdown while Electron readiness or local backend startup is
pending cannot initialize services or publish an unowned late backend.

Evidence: 93 desktop tests, 13 focused launcher/preflight tests, desktop build
and type checks passed. Native Windows fixtures used the production launcher
controller and development-channel helper with real Electron, the actual
BackendManager and a real Rust child, isolated profiles and no repositories.
They delayed normal cleanup beyond the former 250 ms timer. All signal-handler
requests, unexpected Vite exit and parent-channel disconnection waited for
cleanup and left no fixture backend or children. Windows signal-handler events
were injected; actual keyboard Ctrl+C delivery was not synthesized. Linux
fixtures separately delivered real SIGINT, SIGTERM and SIGHUP to a Node launcher
and observed delayed desktop/backend cleanup and complete child exit.

Native fixture sources/records are retained in
`target/dev-shutdown-native-b0bvpnfd/` (ignored build artifacts). Tests used only
owned children. The user's existing development session was neither stopped nor
restarted; the changed launcher and lifecycle apply on its next launch. No
second development frontend was started for qualification.
