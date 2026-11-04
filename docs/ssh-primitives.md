# SSH primitives

The active desktop manager uses the ports in
`packages/ssh/src/{config,command,auth,errors}.ts`, adapted from T3 Code commit
`70cd258d8aac43ea57494527b00bf36de3efa6c0`. The former Promise manager and unsafe
shell-launch fallback have been replaced. See [ssh-manager.md](ssh-manager.md)
for the API, lifecycle tests, budgets and source mapping.

`config.ts` retains Include/glob discovery, cycle prevention, multiple aliases
and known-host parsing, translating results to GitGui desktop types. This is a
discovery parser; system OpenSSH evaluates effective config. `platform.ts`
retains the defaulted platform reference instead of the entire shared T3 host
process module. Effect remains 4.0.5 with `Config.String` and stable
`effect/process` APIs instead of upstream beta imports.

`resolveSshTarget(profile)` runs `ssh -G`, retaining the original alias and
explicit user/port/identity overrides for subsequent commands. Failures never
silently fall back. The complete canonical route, identity override and optional
remote locator are SHA-256 hashed for deduplication. This hash is not an
EnvironmentId or a new remote directory. Rust resolves default/legacy/explicit
directories with identity checks.

`runSshCommand` and `runLocalCommand` use scoped children and interruptible
deadlines. System `ssh.exe` is spawned directly on Windows. Destinations and
identity arguments are validated; remote commands are fixed helper invocations
with bounded JSON stdin. Ensure keeps stdin open until the response. General
output limits are 1 MiB per stream, helper responses 16 KiB. OpenSSH diagnostics
are classified privately; typed IPC failures contain static messages without raw
output, credentials or command arguments. No npm/npx provisioning is ported.

`auth.ts` retains upstream POSIX and PowerShell askpass script bodies, with GitGui
guards refusing host-trust questions. Helpers live in scoped temporary directories.
Cached passwords/passphrases travel in the child environment and are cleared on
rejection/finalization; they never enter argv, journals or ordinary settings.
The two-password-attempt policy uses individual 180s prompts. Independent pairing
additionally has a 210s overall auth budget.

`trust.ts` implements host trust separately. For directly reachable unknown hosts,
`ssh-keyscan` obtains public keys and native confirmation shows their actual
SHA-256 fingerprints and resolved host/port. Real `ssh-keygen -F` checks configured
known-host files, including hashed entries, before and after confirmation.
Existing keys (including revoked/authority entries) block this acceptance path;
the code never overwrites them. Only approved bytes are appended, and retry
retains strict system verification. Unknown proxy/jump hosts require system
OpenSSH verification first. Password helpers never accept trust challenges.

`primitives.test.ts` adapts upstream config/auth/command cases;
`transport.test.ts` covers process interruption, deadlines, helper stdin and HTTP
bounds; `trust.test.ts` combines real local `ssh-keygen` with fixture scan output.
Desktop prompt tests cover expiry, late submissions, sender/frame binding,
partial presentation cleanup and close/reopen finalization. These are focused
adaptations, not a full upstream test port. Separate real Linux SSH qualification now establishes encrypted-key POSIX
askpass and unknown-host fingerprint confirmation through the production
manager. ProxyJump, Windows askpass execution and native OS dialogs remain
unqualified; script assertions and Electron fixtures do not prove those flows.
See the [validation record](remote-connection-reliability-validation.md).
