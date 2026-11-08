# Desktop SSH manager (R4)

The active path is `DesktopSshEnvironment` → scoped `packages/ssh/src/tunnel.ts`
manager → system OpenSSH → private Rust host helper. The superseded Promise
manager and shell launch/stop fallback are removed. The renderer receives a
normal loopback HTTP endpoint and connects directly. The environment supervisor
remains the only reconnect owner.

## API and lifetimes

`makeSshEnvironmentManager(options)` is an Effect requiring a manager `Scope`
and Node filesystem/path/process services. Returned operations are Effects;
only the Electron service converts them to Promises.

| Operation | Contract |
| --- | --- |
| `ensureEnvironment(target, { operationId, expectedEnvironmentId? })` | Reserve a fresh UUID, persist ownership before SSH, ensure/attach, forward and validate discovery. Returns `DesktopPreparedConnection` with `ssh.operationId` and canonical `ssh.remoteDataDirectory`, without a credential. |
| `issuePairingCredential(operationId, expectedEnvironmentId)` | Independently request one grant for the same acquisition and exact instance. No launch/restart or automatic issuance on healthy reconnect. |
| `claimConnection(operationId, expectedEnvironmentId)` | Claim after authenticated RPC and durable staging. Journal the attempt first so a lost claim result can be released safely. |
| `cancelConnection(operationId)` | Interrupt only that operation, finalize prompts/forward, cancel provisional ownership or release its exact possibly claimed handle. Return `stopped`, `released`, `retained` or `cleanup-pending`. |
| `disconnectEnvironment(target)` | Cancel matching route/locator acquisitions, including an originally default/legacy profile whose saved profile now carries the canonical directory. Other directories/routes survive. |
| `close` / `reopen` | Close admission, interrupt and drain acquisitions, clear scoped secrets; reopen after shutdown/recovery finishes. Tombstones survive reopening. |
| `discoverHosts()` | Discover aliases through Include-aware config and non-hashed known-host entries. |

The typed bridge uses `desktop:ssh:*` channels. Main's existing trusted-renderer
wrapper checks origin/main frame. The service also binds each operation ID to
`webContents.id`, including cancel-before-ensure. Other senders cannot claim,
pair, cancel or reuse it. Renderer destruction/crash releases that sender's
outstanding acquisitions. Permanent `dispose()` closes the manager scope,
prompt registry and managed Node runtime; update recovery uses close/reopen.
The existing atomic registration/credential save remains in main/preload; claim
does not itself publish a registration or decide authenticated RPC readiness.

Each waiter has its own Rust acquisition and operation scope. A shared tunnel
has a separate scope, pending Deferred and user set. Cancelling the waiter that
started it cannot interrupt another attached waiter. Every acquisition probes a
reused tunnel. Failed entries leave admission and are replaced; old owners keep
their exact resource until release. Old finalizers cannot remove or close the
replacement.

Ownership is journaled before ensure starts. Lost output still leaves the original
UUID/locator for cancel; Rust tombstones/expiry cover late helper activity.
After ensure, operations pin its canonical directory, EnvironmentId and instance.
Pairing and claim must match the instance even after a same-ID server restart.
Possibly committed claims use release during cleanup. Only Rust decides whether
shared/external/busy instances can stop. There is no PID-only signalling or
persistent-data deletion in the desktop manager.

## Cleanup records and bounds

Atomic JSON records live under `<desktop userData>/ssh/cleanup/`, containing only
the resolved non-secret route, helper request and `claimAttempted` flag. No
pairing/bearer/bootstrap/SSH secret is stored. Finalizers never prompt; they use
an available scoped secret or batch auth. Failure/`cleanup-pending` retains the
record. Repeated cancellation reports the retained outcome rather than claiming
observed exit.

A subsequent successful SSH connection reconciles matching transport routes
using each record's original locator/acquisition/instance. Other routes and live
acquisitions are skipped. Size/schema/UUID checks precede use. Oversized/malformed
records remain for explicit reconciliation. Each pass examines at most 1024
directory entries with a 15-second total budget. A per-route round-robin cursor
advances before each record so timeout, malformed records, or unrelated entries
cannot permanently starve later cleanup; repeated connections on a stable
directory eventually inspect every entry. Concurrent passes for the same route
do not race the cursor. The cursor is in memory and its map is bounded by the
manager's 8,192 acquisition-ID limit. Unfinished records remain for a later
connection. Pending IDs cannot overwrite their journal after restart.
Cancellation by a known ID after restart reports `cleanup-pending` while that
journal survives; an absent live scope is not evidence of remote exit.

Completed acquisition objects, scopes, descriptors and profiles leave the live
map. Only compact idempotency tombstones remain, capped at 8192 operation IDs per
desktop lifetime. IDs are never evicted: admission fails with a typed configuration
error asking for restart at capacity. Close/reopen does not reset this limit.
The sender map has the same cap. This explicit bound preserves delayed IPC and
cancel-before-ensure safety. Rust's separate persistent journal limits are in
`ssh-host-runner.md`.

## Budgets

SSH connect: 10s; ensure command: 90s; host startup: 60s; forward readiness: 20s;
descriptor probe: 1s; individual password/trust prompt: 180s; pairing helper: 10s;
remote cleanup: 15s; local owned SSH child termination: 2s before force kill.
HTTP deadlines include body consumption and interruption aborts the request.
Discovery rejects redirects and oversized/malformed responses.

Independent pairing's **entire auth flow has a 210s budget**, including both
permitted prompts and helper attempts. The second prompt receives only the
remaining overall time; individual prompt limits stay 180s. This reserves 90s
of the host's 300s ready/unclaimed window for other setup work, including forward
readiness/reconciliation and HTTP/RPC/save/claim. Ensure's prompt/start budgets
are unchanged. Expiry fails authentication and finalizes the prompt; no Rust TTL
is silently extended.

## Source adaptations

Pinned source: T3 Code `70cd258d8aac43ea57494527b00bf36de3efa6c0`, inspected in
the local reference checkout. Source/test hashes are tracked separately in
`scripts/t3code-ssh-sources.json`. These are adaptations, not verbatim bodies or
a complete upstream test port. Effect/platform remain 4.0.5; upstream used
patched 4.0.0-beta.103 and unstable process/HTTP imports.

| Upstream | GitGui translation and tests |
| --- | --- |
| `packages/ssh/src/{config,command,auth,errors}.ts` and tests | Same modules plus `platform.ts`; `primitives.test.ts`, `index.test.ts`, `transport.test.ts`. Stable APIs, identity override/full SHA-256 route key, bounded stdin/output, static typed diagnostics. See `ssh-primitives.md`. |
| `packages/shared/src/hostProcess.ts` | `platform.ts` retains only the defaulted platform reference, exercised by Windows helper assertions in `primitives.test.ts`. |
| `packages/ssh/src/tunnel.ts` / `tunnel.test.ts` | `tunnel.ts`, `transport.ts`, `runner.ts`; `manager-lifecycle.test.ts`, `transport.test.ts`, `index.test.ts`. Deferred pending entries, scoped forwards/auth are retained concepts. Per-waiter Rust ownership, journal/claim, instance-pinned pairing, 210s pairing budget and bounded tombstones are GitGui corrections/additions. npm/npx runners, shell PID cleanup and Electron HTTP proxy are not copied. |
| Upstream auth/command boundary | `trust.ts` / `trust.test.ts`: separate strict fingerprint confirmation is a GitGui addition, not T3 askpass parity. |
| Desktop `DesktopSshEnvironment.ts` and test | Same module / `.test.ts`: scoped manager behind typed IPC results, sender-bound IDs and explicit close/reopen/dispose. |
| Desktop `DesktopSshPasswordPrompts.ts` and test | Same module, `prompt-preload.cts`, `.test.ts`, `.native.test.ts`: Deferred requests, expiry, late-response gating and scope finalization. Dedicated sandboxed password modal/native trust dialog replace T3's main-renderer prompt UI. Partial presentation failures destroy the owned modal/listeners. |

## Verification and qualification limits

Focused tests cover cancellation-before-ensure, interrupted/lost results, shared
waiters, shutdown/prompt disposal, stale tunnel replacement, two environments,
resolved-locator removal, uncertain claim, pairing instance mismatch, 210s
two-prompt expiry, bounded tombstones and pending-journal restart reconciliation.
Transport tests use real local HTTP header/body stalls/aborts/redirects and a
real owned Node child timeout. Trust tests use real `ssh-keygen` lookup/fingerprints
with fixture `ssh-keyscan` network output. Electron event fixtures verify exact
sender/frame/request binding and modal cleanup.
`apps/desktop/src/main-lifecycle.test.ts` exercises the actual service/manager
through trusted IPC with fixture host/forward boundaries: ordinary quit,
updater preparation/refusal, recovery ordering, pending setup drain and password/
trust prompt cancellation. The superseded Promise-manager process fixture is
removed. These tests also verify that permanent disposal is idempotent.

These tests do not qualify actual native presentation, OpenSSH execution of
Windows/POSIX askpass, real password/passphrase/agent/ProxyJump flows, installed
update recovery or end-to-end onboarding. Managed hosts require Linux and a
compatible `gitgui-server` on PATH; there is no provisioning or old-helper fallback.
Unknown proxy/jump hosts require system OpenSSH verification first; changed or
revoked keys always block. R2 WSL tests and separate real-host qualification are
distinct evidence, not results established by this R4 unit suite.

Validation on the Windows development host, 2026-11-03: `npm run test -w
@gitgui/ssh` passes 48 tests; `npm run test -w @gitgui/desktop` passes 82 tests,
including 14 SSH adapter tests and 11 main lifecycle/IPC tests. `npm run check`,
`npm run desktop:build`, `npm run build` and `git diff --check` pass. Existing
Svelte accessibility, Rollup annotation/chunk-size and ts-rs attribute warnings
remain. `npm ls effect @effect/platform-node @effect/platform-node-shared`
reports 4.0.5 throughout. The read-only pinned-source validator passes; its
source hashes alone do not establish behavior or complete adaptation mappings.


Final integration adds a 20-second renderer budget for explicit disconnect as
well as cancellation. Disconnect returns each acquisition's cleanup outcome;
normal removal therefore reports retained/pending cleanup instead of dropping
it. The desktop journal preserves uncertain ownership across restart. Settings
can also recover an existing directory using its saved environment ID.

Separate native Linux OpenSSH qualification exercised the production manager,
including encrypted-key POSIX askpass, fingerprint confirmation and cancellation
with a held launch response. See the [validation record](remote-connection-reliability-validation.md)
for source hashes, exact fault-injection limits and remaining native checks.
