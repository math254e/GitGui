# SSH source compatibility and qualification

## Pinned source set

The SSH reference set is T3 Code commit
`70cd258d8aac43ea57494527b00bf36de3efa6c0`. The source inventory and adapted
target hashes are recorded in [`scripts/t3code-ssh-sources.json`](../scripts/t3code-ssh-sources.json).
It pins 15 upstream source and test files. The inventory records 11 completed
adapted source-to-target mappings with their corresponding GitGui tests. These
are adaptations, not verbatim copies; unlisted pinned tests remain upstream
reference material and are not reported as ported tests.

The mappings cover SSH config, command, auth and error primitives; the tunnel
manager, runner and transport; Electron SSH environment and password-prompt
services; host process handling; and client onboarding. GitGui adds Rust host
ownership, durable cancellation records, scoped desktop contracts and direct
HTTP client connections at its system boundaries. The pinned source inventory
is separate from `scripts/t3code-vendored.json` and does not imply that an
adaptation is behaviorally equivalent to T3.

The vendoring script and its tests validate the pinned checkout, source hashes,
adapted target hashes and paths. To inspect or update this inventory, run
`node scripts/vendor-t3code-ssh.mjs` with `T3CODE_PATH` set when the reference
checkout is elsewhere. This provenance check does not re-synchronize the client
runtime.

## Effect compatibility

T3's SSH source at the pinned revision uses Effect
`4.0.0-beta.103`, including patched upstream packages. GitGui's SSH adaptations
use stable Effect `4.0.5` APIs. In particular, imports from
`effect/unstable/process` and `effect/unstable/http` are adapted to the stable
`effect/process` and `effect/http` exports, and affected APIs are reviewed at
the adaptation boundary. The workspace pins Effect and `@effect/vitest` to
`4.0.5`; test support also pins the required platform packages to `4.0.5` and
uses overrides to prevent a second Effect version. This is an explicit stable
API adaptation, not a silent downgrade.

The existing client-runtime snapshot remains pinned to
`1688f965682d331da16a8c39f049592361f69c8d`. That pin is unchanged by the SSH
port; do not infer that its upstream source hash was reverified for this work.
Do not bulk-resynchronize or downgrade the runtime as part of SSH adaptation.

## Qualification status

The isolated Agentbox real-OpenSSH qualification used source payload
`7f68d418371d4b9205aed6f9efdd278d6a6097a7f036828f2da3bd54d369a5cb` and passed
26 focused checks plus real `ensure`, lost-result recovery, shared ownership,
stale-PID handling, two-environment isolation, pairing, saved-bearer reconnect,
scope enforcement, Git-work drain, a 207-byte locator, and actual 300-second
expiry. It also found that a stopped reply can leave cleanup pending in the
host journal. The fix subsequently passed the Linux regression and real SSH requalification with payload
`c67082463641a56fadd66f280ba3d8eef98845ce05b95d9642a25b624c531ca6`.
The production TypeScript manager also passed real SSH reuse, independent
pairing/HTTP exchange, claim/cancel/disconnect, reconnect, two environments,
encrypted-key askpass and unknown-host trust. See
[the validation record](remote-connection-reliability-validation.md) for final
source deltas, failure injection and remaining limits.

Native Electron, Windows askpass, and installed-desktop upgrade flows remain
unqualified. The Agentbox result does not establish those platform or packaging
behaviors.
