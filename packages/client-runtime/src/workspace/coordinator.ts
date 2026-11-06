import { scopedRepositoryKey, sameRepository, type ScopedRepositoryRef } from "./repository.ts";
import { CheckoutAlreadyOpenError, closeRepositoryTab, openRepositoryTab, removeEnvironmentTabs, selectRepositoryTab, switchRepositoryTab, type RepositoryTabs } from "./tabs.ts";

/** Application-owned tab transitions. Remote preparation never holds the commit queue. */
export class WorkspaceTabCoordinator {
  private stateValue: RepositoryTabs;
  private queue: Promise<void> = Promise.resolve();
  private readonly reservations = new Map<string, { tabId: string; environmentId: string; sourceEnvironmentId?: string; sourceTabId?: string }>();
  private readonly revisions = new Map<string, number>();
  private readonly environmentRevisions = new Map<string, number>();
  private disposed = false;
  private readonly listeners = new Set<(state: RepositoryTabs) => void>();

  constructor(initial: RepositoryTabs, private readonly save: (state: RepositoryTabs) => Promise<void> | void) {
    this.stateValue = copy(initial);
  }
  get state(): RepositoryTabs { return copy(this.stateValue); }
  subscribe(listener: (state: RepositoryTabs) => void): () => void {
    this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener);
  }
  private commit(change: (state: RepositoryTabs) => RepositoryTabs, stillValid?: () => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.disposed) throw new Error("Workspace is disposed.");
      const next = change(this.stateValue);
      if (next === this.stateValue) return;
      await this.save(copy(next));
      // A close or environment removal can invalidate a transition while an
      // asynchronous persistence adapter is writing. Restore the last published
      // state before letting the queued close/removal proceed.
      if (stillValid && !stillValid()) {
        await this.save(copy(this.stateValue));
        throw new Error("Workspace operation is no longer current.");
      }
      this.stateValue = copy(next);
      for (const listener of this.listeners) listener(this.state);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  select(tabId: string, signal?: AbortSignal): Promise<void> {
    const valid = () => !signal?.aborted && !this.disposed;
    return this.commit((state) => {
      if (!valid()) throw new Error("Workspace operation is no longer current.");
      return selectRepositoryTab(state, tabId);
    }, valid);
  }
  close(tabId: string): Promise<void> {
    this.bump(tabId);
    this.releaseReservations((reservation) => reservation.tabId === tabId || reservation.sourceTabId === tabId);
    return this.commit((state) => closeRepositoryTab(state, tabId));
  }
  /** A delayed repository operation may close only the checkout it captured. */
  closeIfMatches(tabId: string, expectedTarget: ScopedRepositoryRef): Promise<void> {
    const expected = { ...expectedTarget };
    return this.commit((state) => {
      const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
      if (!tab || !sameRepository(tab.target, expected)) return state;
      this.bump(tabId);
      this.releaseReservations((reservation) => reservation.sourceTabId === tabId);
      return closeRepositoryTab(state, tabId);
    });
  }
  removeEnvironment(environmentId: string): Promise<void> {
    this.environmentRevisions.set(environmentId, (this.environmentRevisions.get(environmentId) ?? 0) + 1);
    this.releaseReservations((reservation) => reservation.environmentId === environmentId || reservation.sourceEnvironmentId === environmentId);
    return this.commit((state) => removeEnvironmentTabs(state, environmentId));
  }
  dispose(): void { this.disposed = true; this.reservations.clear(); this.listeners.clear(); }

  /** resolve canonicalizes a path; prepare loads data without publishing the tab. */
  async open(tabId: string, environmentId: string, resolve: () => Promise<ScopedRepositoryRef>, prepare: (target: ScopedRepositoryRef) => Promise<void>, origin?: { tabId: string; target: ScopedRepositoryRef }, signal?: AbortSignal): Promise<void> {
    await this.transition(tabId, environmentId, resolve, prepare, false, origin, signal);
  }
  async switch(tabId: string, environmentId: string, resolve: () => Promise<ScopedRepositoryRef>, prepare: (target: ScopedRepositoryRef) => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.transition(tabId, environmentId, resolve, prepare, true, undefined, signal);
  }
  private bump(tabId: string): number {
    this.releaseReservations((reservation) => reservation.tabId === tabId || reservation.sourceTabId === tabId);
    const revision = (this.revisions.get(tabId) ?? 0) + 1; this.revisions.set(tabId, revision); return revision;
  }
  private releaseReservations(predicate: (reservation: { tabId: string; environmentId: string; sourceEnvironmentId?: string; sourceTabId?: string }) => boolean): void {
    for (const [key, reservation] of this.reservations) if (predicate(reservation)) this.reservations.delete(key);
  }
  private async transition(tabId: string, environmentId: string, resolve: () => Promise<ScopedRepositoryRef>, prepare: (target: ScopedRepositoryRef) => Promise<void>, switching: boolean, origin?: { tabId: string; target: ScopedRepositoryRef }, signal?: AbortSignal): Promise<void> {
    const source = switching ? this.stateValue.tabs.find((tab) => tab.tabId === tabId) : undefined;
    if (switching && !source) throw new Error("Tab is no longer open.");
    if (origin && !this.stateValue.tabs.some((tab) => tab.tabId === origin.tabId && sameRepository(tab.target, origin.target))) throw new Error("The source tab has changed.");
    const revision = this.bump(tabId);
    const originRevision = origin ? this.revisions.get(origin.tabId) ?? 0 : 0;
    const originEnvironmentRevision = origin ? this.environmentRevisions.get(origin.target.environmentId) ?? 0 : 0;
    const environmentRevision = this.environmentRevisions.get(environmentId) ?? 0;
    const sourceEnvironmentRevision = source ? this.environmentRevisions.get(source.target.environmentId) ?? 0 : 0;
    const valid = () => !signal?.aborted && !this.disposed && this.revisions.get(tabId) === revision && (this.environmentRevisions.get(environmentId) ?? 0) === environmentRevision && (!source || ((this.environmentRevisions.get(source.target.environmentId) ?? 0) === sourceEnvironmentRevision && this.stateValue.tabs.some((tab) => tab.tabId === tabId && sameRepository(tab.target, source.target)))) && (!origin || ((this.environmentRevisions.get(origin.target.environmentId) ?? 0) === originEnvironmentRevision && (this.revisions.get(origin.tabId) ?? 0) === originRevision && this.stateValue.tabs.some((tab) => tab.tabId === origin.tabId && sameRepository(tab.target, origin.target))));
    const target = await resolve();
    if (target.environmentId !== environmentId) throw new Error("Resolved checkout belongs to another environment.");
    if (!valid()) throw new Error("Workspace operation is no longer current.");
    if (switching && source && sameRepository(source.target, target)) return;
    const key = scopedRepositoryKey(target);
    if (this.reservations.has(key) || this.stateValue.tabs.some((tab) => sameRepository(tab.target, target))) throw new CheckoutAlreadyOpenError();
    const reservation = { tabId, environmentId, sourceEnvironmentId: source?.target.environmentId ?? origin?.target.environmentId, sourceTabId: origin?.tabId };
    this.reservations.set(key, reservation);
    const releaseOnAbort = () => { if (this.reservations.get(key) === reservation) this.reservations.delete(key); };
    signal?.addEventListener("abort", releaseOnAbort, { once: true });
    if (signal?.aborted) releaseOnAbort();
    try {
      await prepare(target);
      await this.commit((state) => {
        if (!valid()) throw new Error("Workspace operation is no longer current.");
        return switching ? switchRepositoryTab(state, tabId, target) : openRepositoryTab(state, { tabId, target });
      }, valid);
    } finally { signal?.removeEventListener("abort", releaseOnAbort); releaseOnAbort(); }
  }
}

function copy(state: RepositoryTabs): RepositoryTabs {
  return { tabs: state.tabs.map((tab) => ({ tabId: tab.tabId, target: { ...tab.target } })), activeTabId: state.activeTabId };
}
