/**
 * Temporary bridge for the existing single-environment tab owner.
 * T3 reference: threadRoutes.ts and routes/_chat.$environmentId.$threadId.tsx,
 * inspected at 70cd258d8aac43ea57494527b00bf36de3efa6c0. GitGui routes use the
 * same explicit scoped reference, with GitGui-owned tab/legacy-link policy.
 * The root-provided coordinator adapter replaces this bridge completely.
 */
import type { WebApplicationRuntimeState } from "$lib/connection/runtime";
import type { WorkspaceStore } from "$lib/workspace/workspace-store.svelte";
import type { RepositoryRouteAdapter, RepositoryRouteCandidate } from "$lib/workspace/repository-routing";
import { scopedRepositoryKey } from "@gitgui/client-runtime/workspace";

/** Narrow, non-secret migration read; never follow subsequent global selection changes. */
export function readLegacyRouteEnvironment(storage: Pick<Storage, "getItem">): string | undefined {
  try {
    // Matches connection/platform.ts. Parent migration should supply its captured value instead.
    return storage.getItem("gitgui.selectedEnvironment.v3")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createLegacyRepositoryRouteAdapter(
  store: WorkspaceStore,
  readRuntime: () => WebApplicationRuntimeState,
  readLegacyEnvironment: () => string | undefined,
): RepositoryRouteAdapter {
  return {
    get snapshot() {
      const runtime = readRuntime();
      const entries = runtime.registry.entries;
      const environmentIds = entries.map((entry) => entry.registration.environmentId);
      const candidates = new Map<string, RepositoryRouteCandidate>();
      const add = (environmentId: string, repositoryId: string, path: string) => {
        const entry = entries.find((entry) => entry.registration.environmentId === environmentId);
        if (!entry) return;
        const target = { environmentId, repositoryId };
        candidates.set(scopedRepositoryKey(target), {
          target, environmentLabel: entry.registration.displayName, path,
        });
      };
      for (const environmentId of environmentIds) {
        for (const repository of runtime.catalogs[environmentId]?.repositories ?? []) {
          add(environmentId, repository.id, repository.root || repository.path);
        }
        // Includes restored placeholders while offline and before catalog hydration.
        const data = runtime.environmentWorkspaces?.[environmentId]?.workspaceState;
        for (const repository of Object.values(data?.repositories ?? {})) {
          add(environmentId, repository.repository.id, repository.repository.root || repository.repository.path);
        }
      }
      const environmentId = store.workspaceState?.environmentId;
      if (environmentId) {
        for (const repository of store.repositoryCatalog) add(environmentId, repository.id, repository.root || repository.path);
        for (const repository of store.openRepos) add(environmentId, repository.id, repository.root);
      }
      const activeTarget = environmentId && store.activeRepositoryId
        ? { environmentId, repositoryId: store.activeRepositoryId } : null;
      return {
        ready: !runtime.loading,
        environmentIds,
        legacyCatalogsReady: environmentIds.every((id) => runtime.catalogs[id]?.hasSnapshot === true),
        candidates: [...candidates.values()],
        legacySelectedEnvironmentId: readLegacyEnvironment(),
        openTargets: environmentId ? store.openRepos.map((repo) => ({ environmentId, repositoryId: repo.id })) : [],
        activeTarget,
        view: activeTarget && store.workspace?.environmentId === environmentId ? store : null,
      };
    },
    async activate(target, { signal }) {
      signal.throwIfAborted();
      const workspace = store.workspace;
      if (!workspace || workspace.environmentId !== target.environmentId) {
        throw new Error("This environment is unavailable in the current workspace. Connect the application tab coordinator to open it.");
      }
      // Store open/select methods also navigate to legacy URLs. Route activation
      // must keep the URL (and browser history) supplied by the user.
      if (workspace.state.openRepositoryIds.includes(target.repositoryId)) {
        await workspace.selectRepository(target.repositoryId);
      } else {
        await workspace.openKnownRepository(target.repositoryId);
      }
      signal.throwIfAborted();
    },
  };
}
