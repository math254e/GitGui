# Repository route integration

Integration status: the root now supplies `createApplicationRouteAdapter` and
mounts the application tab coordinator. Scoped route activation uses that
coordinator; the repository route owns URL replacement when its tab closes.
The checklist and transitional adapter notes below describe the original
handoff and remain useful context for the legacy fallback.

The mounted canonical route is `/repo/<environmentId>/<repositoryId>`.
Its SvelteKit ID is `/repo/(scoped)/[environmentId]/[repositoryId]`.
The group lets the legacy `/repo/[repositoryId]` keep its ID and parameter
without ambiguous dynamic directory names. Both empty pages inherit the single
`repo/+layout.svelte` owner. That layout mounts `RepositoryRoute` once;
`RepositoryPage` contains the existing presentation, including the worktree
actions present before extraction. Presentation cleanup releases its diff renderer.

The architectural reference is T3's `apps/web/src/threadRoutes.ts` and
`routes/_chat.$environmentId.$threadId.tsx`, inspected at
`70cd258d8aac43ea57494527b00bf36de3efa6c0`. The common concept is an explicit
environment-qualified route reference. GitGui's repository uniqueness, tab
activation, and legacy ambiguity rules are its own.

## Parent integration

1. Call `provideRepositoryRouteAdapter(adapter)` from
   `$lib/workspace/repository-routing` in the root's component initialization,
   beside the single application tab owner. Do not also mount another repository
   presentation or route activation effect in the root or child pages.
2. Supply a reactive `adapter.snapshot` getter with:
   - `ready` once registrations/application tabs restore, including placeholders;
   - all registered `environmentIds`, scoped `openTargets`, `activeTarget`;
   - catalog/tab `candidates` with environment labels and canonical display paths;
   - `legacyCatalogsReady` only when every known catalog has a cached/live
     snapshot (an uncached offline host cannot establish uniqueness);
   - the migration's saved `legacySelectedEnvironmentId`, captured once,
     if present, rather than the displayed tab's environment;
   - a `view` implementing the exported `RepositoryPageModel`, a structural
     Pick of the existing presentation properties/actions. Its clients, state,
     callbacks and cache keys must belong to `activeTarget`.
3. Implement `activate(target, { signal })` using the coordinator: select an
   existing exact scoped tab; otherwise prepare/open exactly one. Never navigate
   in this method. Honor abort before persistence/publication and check the
   coordinator's navigation/source revision after asynchronous preparation.
   Release reservations on cancellation, close, failure and environment removal.
   Route activation is navigation, not the duplicate-error "Open in new tab" action.
4. Use `scopedRepositoryPath` for tab/home/action navigation. Use
   `isRepositoryRouteId` in root chrome and scoped references for tab callbacks.
   Remove the old store's route/deep-link/close/startup effects as that owner
   migrates: it must not also write authoritative open/active tabs or navigate
   a scoped activation back to a legacy URL.
5. Close/remove through the coordinator, publish the surviving scoped
   open/active state, and use `resolveClosedScopedRepositoryTarget` if navigating
   outside the route. The route itself replaces the URL when its observed tab
   disappears; it never reopens that target during the same route entry.
   Leaving and returning through browser history is a new entry and may open it.
   Navigate away on explicit environment removal after durable removal succeeds.

The route controller aborts old activations on target changes and unmount, ignores
late errors, and never displays another environment's active view. The presentation
is keyed by both environment and repository ID, so equal IDs cannot reuse child
view state. A link to an open tab selects it without creating another tab.
Legacy ambiguity renders an accessible environment/path choice; choosing replaces
the old URL with a scoped URL and preserves the browser query and fragment.
`gitgui://repo/<environmentId>/<repositoryId>` takes the same path. Old
`gitgui://repo/<repositoryId>` links retain legacy resolution rather than acquiring
an implicit environment during parsing.

## Transitional behavior and remaining risks

When the parent has not provided an adapter, `legacy-adapter.ts` projects all
runtime catalogs but operates only on the existing store's exact environment.
It reads the non-secret `gitgui.selectedEnvironment.v3` migration hint once on
mount; denial of browser storage simply disables this hint. It does not change
environment selection or create a runtime/session. Scoped URLs work for the
current environment, and cross-environment activation reports an explicit error.
The runtime projection subscription is disposed with the shared route layout.

The old data service has no AbortSignal on open/select. The transition bridge
checks abort before and after that call, and the controller prevents stale
navigation/rendering, but a read already in progress can still publish a legacy
tab. Full cancellation and concurrent multi-environment mutation safety require
the parent coordinator adapter. This bridge deliberately does not create a second
tab owner to work around that limitation.

During transition the route detects close without reopening, but leaves close
navigation to the old store to avoid two simultaneous URL writers. With an
integrated adapter, the route owns close replacement as described above.

The shared workspace now includes a parent-owned application-route adapter and
root provider using this API and the grouped route helper. Those files remain
outside this route implementation's ownership. The parent must still ensure that
its close/remove methods do not also navigate after publishing a tab removal:
the integrated route already replaces its URL. In the current parent integration,
`closeApplicationTab` and `removeScopedRepository` retain their own navigation,
so that ownership needs to be reconciled to avoid competing history updates.
No root/store/runtime/component, protocol, desktop lifecycle, credentials or
session behavior is modified by this route implementation.
