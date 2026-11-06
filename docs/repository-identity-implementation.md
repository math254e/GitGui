# Repository identity and worktree-family implementation

The Rust server populates the additive `RepositorySummary.repositoryIdentity`
and `worktreeFamily` hints in catalog, open/create, snapshot, graph, refresh, and
status responses. Other repository responses carry the latest hydrated hints.
Checkout IDs and catalog persistence schema are
unchanged. These hints never select a server, authorize an operation, or replace
an environment-scoped checkout target.

`repositoryIdentity.canonicalKey` selects the fetch remote named `upstream`, then
`origin`, then the first remaining remote in deterministic Rust lexical order.
Supported HTTP, HTTPS, Git, SSH and SCP forms normalize to lowercase host/path,
ignoring transport ports, trailing slashes and `.git`. A selected unsupported
remote yields no identity; another remote is not substituted. User information
is stripped, query/fragment/control-character forms are rejected, and raw remote
URLs and Git diagnostics are neither returned nor logged by this reader.

`worktreeFamily.id` is a SHA-256 digest of the backend's stable environment ID
and canonical Git common directory. Thus linked worktrees share a family even
without remotes; independent clones and different environments do not.
`mainRoot`, when known, is the canonical main checkout path. Git's NUL-delimited
worktree records determine linked-worktree status. Submodules and separate Git
directories are not classified as linked merely because `.git` is a file. For
linked worktrees of a bare or separate-Git-directory repository, Git may not
identify a canonical main checkout, so `mainRoot` is omitted.

Each catalog registration owns one in-memory cache entry. Positive, no-remote,
and failed reads have a one-minute TTL. Lightweight file stamps invalidate
observed changes to Git configuration, Gitfiles, common-directory links, and
worktree registrations. Ordinary index/HEAD writes do not invalidate identity.
There is no filesystem search or full-history read. A cold read normally starts
three local Git processes; main checkouts with separate Git directories require
one additional root-validation process. Every command has a two-second timeout
and a 256 KiB stdout limit, with stdin closed and stderr discarded.

The server admits at most four metadata workers across all concurrent requests.
Concurrent reads of a registration share its cache and serialize discovery.
Catalog locks are released before filesystem/Git work. Worker ownership retains
the cache lock, semaphore permit, and lifecycle work guard after RPC cancellation
or disconnect; shutdown/quiescence can drain actual work. Removing or replacing
a registration creates a distinct cache owner, and late list/lookup results
cannot publish an old owner. Add/remove/re-registration publish catalog membership
only after persistence succeeds; failed writes preserve live membership/caches.
Hydration publishes availability back to the current catalog registration so
explicit rechecks restore parked filesystem watches. Mutation repository lookup
remains lightweight and preserves existing registration/common-directory lock
ordering; metadata discovery never runs ahead of mutation lock acquisition.

Missing directories retain their catalog entries and last-known in-memory hints
with `missing: true` and the new optional `metadataStale: true`. Inaccessible or
failed reads also mark hints stale without labelling permission/I/O failures as
missing. A later successful read clears staleness; a successful no-remote result
clears the previous logical identity. Other catalog entries remain usable.
Older summaries without these fields deserialize unchanged.

## Provenance and deliberate adaptations

Inspected the local T3 checkout at
`70cd258d8aac43ea57494527b00bf36de3efa6c0`, particularly:

- `apps/server/src/project/RepositoryIdentityResolver.ts` and its tests;
- `packages/shared/src/git.ts` and `git.test.ts`;
- `packages/client-runtime/src/state/projectGrouping.ts` and
  `environment/scoped.ts`, plus the connection/runtime/auth internals documents.

Remote preference, supported matching fixtures and one-minute positive/negative
TTL follow those sources. GitGui omits T3's raw URL locator, rejects unsafe or
ambiguous URL forms, and uses locale-independent lexical remote fallback rather
than adding an ICU collation dependency to Rust. Catalog-root validation rejects
accidentally inherited parent repositories. Family metadata, file-stamp
invalidation, failed-read caching, and last-known stale hints are GitGui domain
adaptations for individually registered checkouts. No vendored runtime file,
snapshot pin, or Effect dependency is changed.

## Verification and limits

Focused tests cover remote preference, URL equivalence/redaction, missing and
malformed output, process timeout/output bounds, real linked worktrees, independent
clones, separate Git directories, environment-local family matching, positive/
negative/failure caching, config invalidation, ordinary index changes, recovery,
late registration results, failed catalog writes, bounded workers, cancellation,
quiescence, configuration changes during discovery, authorization, and metadata
consistency across existing RPCs.
Unix-only fixtures additionally cover symlinks and newline paths.

Validation performed on Windows:

- `cargo check --workspace` passed.
- `cargo test -p gitgui-core --lib repository_identity -- --test-threads=2`
  passed all 9 final identity tests.
- `cargo test -p gitgui-server --lib -- --test-threads=2` passed all 82 tests,
  including the existing mutation-lock and watcher-restoration regressions.
- The broader workspace library run passed 147 core tests (2 measurement tests
  ignored) and the protocol compatibility test. Its initial server failures
  were corrected and verified by the complete server rerun above.
- `npm run protocol:generate` and `git diff --check` passed.
- The all-target workspace test command could not replace the in-use
  `target/debug/gitgui-server.exe`; no user process was stopped.
- `npm run check` reached Svelte validation but failed on the independently
  edited `apps/web/src/lib/workspace/stash-store.test.ts:585` runtime fixture,
  which lacks `environmentWorkspaces`. The desktop, client-runtime and SSH
  TypeScript checks passed. That out-of-scope fixture was not modified here.

Matching retains T3's best-effort limits: case-sensitive paths or distinct services
on different ports can group together, and SSH aliases are not resolved. Unknown
external include/global configuration changes and ambiguous file timestamps are
revalidated by TTL. Cached hints are not persisted in the server catalog; a
server restart cannot recover metadata for an already-missing checkout. Client
catalog caching remains its existing separate responsibility. Filesystem calls
themselves are subject to the host OS (for example, a stalled network mount).
