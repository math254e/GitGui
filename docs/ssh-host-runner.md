# SSH host runner (private contract v1)

R2 implementation contract for R4 integration. Linux hosts only; Windows and
Linux desktops run the same SSH command. Other hosts return `unsupported`.
The canonical definitions are `crates/gitgui-protocol/src/ssh_host.rs`, generated
into `packages/contracts/src/protocol.ts`. This contract is separate from RPC.

Run `gitgui-server ssh <ensure|claim|cancel|release|probe|pairing> --json`. Send one JSON
line on stdin (maximum 16 KiB including newline); stdout is exactly one JSON
response line with no logs. Every request contains `version: 1`, a fresh desktop
reserved UUID `acquisitionId`, `locator`, nullable `expectedEnvironmentId`, and
nullable `instanceId`. Reserve the acquisition ID **before invoking SSH** and
retain it for cleanup even when no launch result arrives. Never reuse an ID.
For `ensure`, keep stdin open after writing/flushing the line until the result
arrives. EOF or trailing input before the result cancels the acquisition. A lost
SSH process is additionally covered by server expiry. Other operations can close
stdin immediately after the request.
Operation failures still return a response frame and exit successfully; branch
on `outcome`, not the SSH exit code. Input/output transport failure can exit 1.

`locator` is `{ "kind": "default" }` for the ordinary per-user server directory,
or `{ "kind": "directory", "path": "/absolute/existing/path",
"environmentId": "expected-environment-id" }` for an explicitly selected existing
environment, including legacy target directories. Explicit directories require
an existing matching identity. The helper never moves or deletes catalogs or
identity, and never searches/guesses among legacy directories. Unverifiable or
conflicting identity blocks. The default uses the ordinary server data directory
(`$XDG_STATE_HOME/gitgui` or `$HOME/.local/state/gitgui` on Linux), independently
of SSH aliases/keys/target hashes.
Old profiles without an absolute directory use `{ "kind": "legacy",
"stateKey": "old-base64url-key", "environmentId": "expected-environment-id" }`.
Only `$HOME/.gitgui/environments/<stateKey>` is inspected (1–48 base64url
characters). Its existing identity must match. If that directory is absent,
the ordinary default is accepted only if its existing identity matches. A
conflicting legacy identity or duplicate matching directories blocks; no
catalog/identity is moved, renamed or removed, and legacy PID metadata is ignored.
An existing identity without a helper runtime record is `ambiguous`: the old
binary cannot prove exclusivity. Restart that selected environment explicitly
with the new binary to publish an attach-only record, or use its normal endpoint
with manual pairing. The helper does not guess a legacy PID or start a second
process against its catalog. Explicit directory selection always pins the ID.

`ensure` acquires a provisional usage handle and starts at most one managed
server. Its `ready` response contains `instanceId`, `environmentId`, `port`,
`ownership` (`managed` or `external`), `remoteDataDirectory` (the actual canonical
absolute host path), and `expiresAtUnixMs`. Forward **only**
`127.0.0.1:port`; results contain no URL, shell command or credential. Validate
discovery, auth, live RPC and durable client save before `claim`, with the exact
returned instance and expected environment ID. `claim` returns `claimed` and
removes the handle's provisional deadline. Independently issue pairing through
`pairing` operation using that same request shape with exact instance and expected
environment ID. A `ready` response to `pairing` additionally contains `pairing`
(`credential`, `expiresIn`, `scopes`). Only this protected SSH response contains
the one-time secret; never log/persist the response. Managed startup uses durable
`AuthStore::open` and always requires auth. Launching never returns or stores a
token. Pairing requires existing durable auth storage; old in-memory servers
return `unsupported` rather than accepting an unusable grant. Persistent primary
bootstrap startup also opens durable auth; explicitly anonymous standalone
development remains unchanged until an auth database exists.

`cancel` works with just the original acquisition ID and locator. It persists a
tombstone before requesting cleanup, including when ensure has not started yet.
It cannot cancel an already claimed handle (`retained`); use `release` with the
exact instance after closing that handle's RPC/tunnel. `release` also tombstones
the handle. Other handles and external servers survive. `probe` does not acquire
or launch. `cleanup-pending` means exit was not observed; retain the acquisition
journal and retry/reconcile. `retained` means another handle or client needs the
server. Never interpret either as stopped. All operations are idempotent.

New handles expire on the server, including after helper death/lost stdout.
Startup is bounded to 60s; ready but unclaimed handles get 300s to complete setup.
The 300s deadline accommodates the permitted three-minute SSH pairing prompt
plus bounded HTTP/RPC validation, durable save and claim; 120s could expire a
valid onboarding while that prompt was still open. Other budgets are unchanged.
The host serializes reserve/spawn/cancel/claim in short state transactions;
readiness/drain waits never hold that lock. The server checks the record before
startup and enforces expiry itself. Cleanup uses a private same-UID Unix socket
and exact random instance ID, never PID signalling. The ownership challenge is
answered by the live host guard and its bound listener. It proves the actual
environment ID, listener port and managed/external ownership; mutable journal
fields and PID metadata are not accepted as ownership proof. Busy Git work and
other live RPC clients are retained; a later idle reconciliation can finish
cleanup.
The socket path is `/tmp/gitgui-owner-<effective-uid>/<instance-uuid>.sock`,
independent of HOME/data-directory length. The directory must be an actual
same-UID directory with mode 0700 (symlinks, foreign ownership and permissive
existing modes are rejected); socket mode is 0600 and peer credentials are
checked. A public temp directory is never itself used as an owner endpoint.
The private journal is bounded to 2 MiB and 4096 acquisition IDs per environment.
Tombstones are never silently evicted: a full/corrupt/unreadable journal blocks
with `ambiguous` and needs explicit operator reconciliation. This favors exact
late-cancellation safety over an unsafe automatic pruning policy.

Upstream adaptation: T3 Code `70cd258d8aac43ea57494527b00bf36de3efa6c0`,
`packages/ssh/src/tunnel.ts` launch/reuse, pending acquisition and entry-scope
cleanup concepts, and `docs/internals/{remote,environment-auth}.md`. Rust owns
this helper because GitGui has a standalone Rust backend. Tombstones, server
expiry, process locks and cooperative instance-checked cleanup correct the
interrupted shell-launch gap; they are not claimed verbatim T3 behavior. No
generic service, update launcher or public shutdown endpoint is added.

Cancellation commits `stopped` for the matching instance only after observing
its process lock released, including when a startup child exits before creating
its host guard. The transaction checks the generation and process lock again;
it never overwrites a replacement instance. The host retains cancellation
tombstones. Desktop cleanup journals are removed only after a terminal cleanup
result; lost results remain pending for reconciliation. The modeled Linux race
and actual OpenSSH race both passed after this correction.

Real Agentbox/OpenSSH qualification, its passed scenarios, and the corrected
stopped-reply finding are recorded in
[SSH source compatibility and qualification](ssh-source-compatibility.md).
Native Electron, Windows askpass and installed-desktop upgrade flows remain
unqualified.


Existing environment identities are opaque, bounded nonempty strings. Releases
before UUID generation used `gitgui-<pid>-<time>` IDs; these are retained exactly
in `server.json`, credentials, catalog references and SSH locators. New IDs are
still UUIDs. Acquisition IDs and immutable process-instance IDs remain UUIDs;
accepting a historical environment ID does not relax process ownership checks.
