# Bounded large-file diffs

Issue [#9](https://github.com/math254e/GitGui/issues/9) adds a server-enforced
content budget. The original thresholds were measured locally before #3 landed; the integration
with current main preserves its instrumentation and #5 shared continuations.

## Behavior

Each original and modified side must fit all three limits:

- 64 KiB of raw UTF-8 content;
- 500 lines;
- 8 KiB per line.

At the limit, content remains eligible for the existing viewer. Above any limit,
**both full-content strings are omitted**. The response includes optional
`omittedContent` metadata with the reason, current limits, and at most 8 KiB of
plain-text prefix per side. Prefixes respect UTF-8 boundaries, can end mid-line,
and do not claim to be a patch or the complete file. No exact total size or line
count is claimed: obtaining it would require reading the omitted content.

The viewer explains the omission, offers an explicit “Inspect text prefixes”
disclosure, and describes full inspection using Git or a capable editor on the
repository host. Remote files must be inspected on their host. There is no
unbounded “load anyway” action. The normal Hunks/Inline/Split/File renderer is
never given prefixes. Whole-file staging/unstaging remains supported; hunk
selection is unavailable for omitted content.

Normal-sized text retains the current contents, parser, syntax highlighting,
layouts, wrapping, and hunk actions. Detected binary/non-UTF-8 content retains
the binary state and empty text representation. Binary detection examines only
the bounded bytes: binary markers or encoding errors exclusively beyond that
prefix cannot be detected. Such files conservatively use the omitted-content
state and are never passed to the text renderer.

The same limits apply to commit-versus-working-directory comparisons.

## Pipeline and ownership

1. `gitgui-core` resolves each side from the working file, index, or commit blob.
   Files are read through a capped reader; Git blobs use `git cat-file blob`
   with piped stdout, rather than collecting all of `git show`. Each side reads
   at most 65,537 bytes (64 KiB plus a sentinel byte), even if a file grows while
   reading. A child exceeding the budget is terminated and reaped by its owner.
   Read/lookup failures return errors rather than a successful empty diff.
2. Core classifies the bounded bytes before constructing the response. Byte,
   line-count, and line-length guards protect different shapes of large input.
   Only prefixes survive an omission, so commit cache entries and their clones
   are bounded too. Commit prefetch uses the same loader and cannot bypass it.
3. The server maps core metadata to the canonical Rust protocol. TypeScript is
   generated with `npm run protocol:generate`. The optional field is additive;
   normal responses omit it and older responses deserialize with no omission.
   Existing RPC methods, read scopes, and the direct client/server transport are
   unchanged. Older clients can ignore the additive field but cannot explain an
   omission; deploy matching client/server builds to obtain this UI.
4. The Svelte viewer stores the response, clears its old renderer items/parsed
   data, and displays omission independently of renderer initialization. It
   requests supplementary hunk previews only after receiving eligible content.
   Existing request-generation checks reject stale content and hunk responses.
   RPC errors still show Retry; renderer errors remain errors for normal text.
   Prefixes use escaped Svelte text inside scrollable, keyboard-focusable `pre`
   elements; no highlighting or diff algorithm runs when expanding them.
5. The shared file-view continuation caps the collected bytes during its first
   read/hash and rejects hunk preparation for omitted content. Normal files keep
   #5's shared status/index/read preconditions and stale-revision validation.
   Staged contents are checked before hashing; direct hunk-preview RPCs use the
   same preparation and return an explicit whole-file-action error for omission. Generated patch stdout is independently capped
   at 256 KiB plus a sentinel, including if a file grows after the guard. An
   oversized patch is an error with whole-file/Git guidance, never a partial
   selectable patch. Independent patch line-count (2,032, including headers) and
   line-length (8 KiB plus a diff marker) guards also cover growth between the
   content check and the first revision hash. Existing stale-revision validation
   still protects apply.

The content budget is Git domain behavior owned by Rust, not a connection-runtime
policy. No Electron bridge, connection/session lifecycle, or vendored T3 runtime
changes are needed. T3's workspace and connection-runtime references were read
to confirm the existing ownership boundary.

## Local measurements and threshold rationale

Run `node scripts/measure-diff-parsing.mjs` after `npm ci`. The script uses the
installed `@pierre/diffs@1.5.2`, the same `parseDiffFromFile` options as the viewer,
three synchronous parses per input, and files in which every line changes. This
is a deliberately expensive diff shape. On this Windows host, Node 24.13.0,
2026-10-22, observed milliseconds were:

| Lines per side | Bytes per side | Three parse times (ms) |
| --- | --- | --- |
| 100 | 2,390 | 6, 2, 3 |
| 250 | 6,140 | 10, 8, 7 |
| 500 | 12,390 | 30, 30, 35 |
| 1,000 | 24,890 | 123, 124, 110 |
| 2,000 | 50,890 | 482, 710, 610 |
| 5,000 | 128,890 | 5,495, 6,867, 5,289 |

The line budget is deliberately conservative: even a 25 KiB file can block
synchronous parsing for over 100 ms. A byte-only guard would miss that shape.
500 fully changed lines stayed below a 50 ms task in this sample. The byte and
line-length limits independently cap transfer, highlighting, and long-line
layout work; they are conservative engineering budgets, not empirically proven
universal latency thresholds. These Node parse timings exclude Git/status,
networking, browser highlighting/layout, and cold library initialization. They
are not #3's end-to-end instrumentation or a guarantee for every machine/input.

## Verification and remaining limits

Focused coverage exercises infinite-reader bounds, thresholds, UTF-8 boundaries,
binary/non-UTF-8 content, missing content errors, large working/index/root-commit/
rename/deletion sides, cache/wire conversion, legacy response compatibility,
direct hunk guards, generated patch limits, whole-file actions, and UI state
precedence. Local Chromium verification used an isolated repository and ephemeral
server state, with 100,001-line files, and checked normal hunk rendering,
working-tree/staged/commit omissions, binary display, correct `aria-busy`,
disclosures initially closed, escaped script-like text, and no supplementary hunk
request for an omitted file. The large-file response sizes were 19,264 bytes
(working tree), 19,186 bytes (staged), and 18,925 bytes (commit), including JSON
escaping and envelope overhead. After warming the normal viewer, no tasks above
50 ms were observed while selecting the omitted working file and expanding its
prefix disclosure. This is one local browser sample, not a latency guarantee.

Validation: `npm run check` (zero errors/warnings), `npm run build`, web Vitest
(76 passed, one opt-in live test skipped after integration), `cargo check --workspace`, and
`git diff --check`. The default Rust suite reproduces four existing Windows
failures on an untouched HEAD archive: one uses Windows-invalid filenames and
three assume LF checkouts despite this host's `core.autocrlf`. With
`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.autocrlf`, and
`GIT_CONFIG_VALUE_0=false` set for the test process, running
`cargo test --workspace -- --skip discard_and_stage_treat_unusual_paths_as_literal_file_names`
passes 57 core, 21 server, and one CORS test after integration, with one
historical measurement ignored and the Windows-invalid-filename case skipped.
Current-main integration retains continuation, cache, and concurrency tests.
The former unbounded large-file continuation success fixture now uses eligible
text; separate large-file cases verify omitted content, rejected continuation,
and working whole-file actions.

There is no full-file download, paging, streaming diff protocol, or worker-based
parser in this change. Old clients talking to old servers are not protected by
these limits. Current main includes bounded concurrent dispatch, cancellation,
limited prefetch, and shared hunk work. Status/file-list size, Git subprocess
deadlines, and remaining revision hashing costs are separate concerns. Content memory/transfer bounds do not imply a
wall-clock deadline for Git, filesystem access, or unrelated repository work.
The shared working-tree view preserves #5's single content read for eligible
unstaged files. Large unstaged files stop that read/hash after a sentinel byte;
large staged sides are rejected before the worktree revision hash. The existing
full revision hash is still streamed for other workflows and eligible staged
views whose unrelated working file may itself be large.
