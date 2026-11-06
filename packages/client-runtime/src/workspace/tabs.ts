import { sameRepository, type ScopedRepositoryRef } from "./repository.ts";

export interface RepositoryTab {
  readonly tabId: string;
  readonly target: ScopedRepositoryRef;
}

export interface RepositoryTabs {
  readonly tabs: readonly RepositoryTab[];
  readonly activeTabId: string | null;
}

export class CheckoutAlreadyOpenError extends Error {
  constructor() {
    super("This checkout is already open in another tab.");
    this.name = "CheckoutAlreadyOpenError";
  }
}

/** Pure tab transitions: the caller owns serialization, persistence and IO. */
export function openRepositoryTab(state: RepositoryTabs, tab: RepositoryTab): RepositoryTabs {
  if (state.tabs.some((existing) => sameRepository(existing.target, tab.target))) {
    throw new CheckoutAlreadyOpenError();
  }
  if (state.tabs.some((existing) => existing.tabId === tab.tabId)) {
    throw new Error("Tab ID is already in use.");
  }
  return { tabs: [...state.tabs, tab], activeTabId: tab.tabId };
}

export function switchRepositoryTab(state: RepositoryTabs, tabId: string, target: ScopedRepositoryRef): RepositoryTabs {
  const current = state.tabs.find((tab) => tab.tabId === tabId);
  if (!current) throw new Error("Tab is no longer open.");
  if (sameRepository(current.target, target)) return state;
  if (state.tabs.some((tab) => tab.tabId !== tabId && sameRepository(tab.target, target))) {
    throw new CheckoutAlreadyOpenError();
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) => tab.tabId === tabId ? { ...tab, target } : tab),
  };
}

export function selectRepositoryTab(state: RepositoryTabs, tabId: string): RepositoryTabs {
  if (!state.tabs.some((tab) => tab.tabId === tabId)) throw new Error("Tab is no longer open.");
  return state.activeTabId === tabId ? state : { ...state, activeTabId: tabId };
}

export function closeRepositoryTab(state: RepositoryTabs, tabId: string): RepositoryTabs {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
  const activeTabId = state.activeTabId === tabId
    ? tabs[Math.min(index, tabs.length - 1)]?.tabId ?? null
    : state.activeTabId;
  return { tabs, activeTabId };
}

/** Remove only tabs owned by an explicitly removed environment. */
export function removeEnvironmentTabs(state: RepositoryTabs, environmentId: string): RepositoryTabs {
  let next = state;
  for (const tab of state.tabs) {
    if (tab.target.environmentId === environmentId) next = closeRepositoryTab(next, tab.tabId);
  }
  return next;
}
