import { sameRepository, scopedRepositoryKey } from "@gitgui/client-runtime/workspace";
import type { RepositoryRouteAdapter, RepositoryRouteCandidate } from "./repository-routing";
import type { WorkspaceStore } from "./workspace-store.svelte";

/** Route activation uses the application tab owner, without writing another URL. */
export function createApplicationRouteAdapter(store: WorkspaceStore, legacySelectedEnvironmentId?: string): RepositoryRouteAdapter {
  return {
    get snapshot() {
      const entries = store.environmentEntries;
      const environmentIds = entries.map((entry) => entry.registration.environmentId);
      const candidates = new Map<string, RepositoryRouteCandidate>();
      const add = (environmentId: string, repositoryId: string, path: string) => {
        const entry = entries.find((item) => item.registration.environmentId === environmentId);
        if (!entry) return;
        const target = { environmentId, repositoryId };
        candidates.set(scopedRepositoryKey(target), { target, environmentLabel: entry.registration.displayName, path });
      };
      for (const environmentId of environmentIds) {
        for (const repository of store.environmentCatalogs[environmentId]?.repositories ?? []) {
          add(environmentId, repository.id, repository.root || repository.path);
        }
        for (const item of Object.values(store.environmentViews[environmentId]?.workspaceState?.repositories ?? {})) {
          add(environmentId, item.repository.id, item.repository.root || item.repository.path);
        }
      }
      const activeTarget = store.activeApplicationTab?.target ?? null;
      const viewReady = activeTarget && store.workspaceState?.environmentId === activeTarget.environmentId &&
        store.activeRepositoryId === activeTarget.repositoryId;
      return {
        ready: store.applicationReady,
        environmentIds,
        legacyCatalogsReady: environmentIds.every((id) => store.environmentCatalogs[id]?.hasSnapshot === true),
        candidates: [...candidates.values()],
        legacySelectedEnvironmentId,
        openTargets: store.applicationTabs.tabs.map((tab) => tab.target),
        activeTarget,
        view: viewReady && sameRepository(activeTarget, store.activeApplicationTab!.target) ? store : null,
      };
    },
    activate: (target, { signal }) => store.activateRouteRepository(target, signal),
  };
}
