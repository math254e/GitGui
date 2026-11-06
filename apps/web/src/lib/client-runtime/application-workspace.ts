import { sameRepository, type RepositoryTabs, type ScopedRepositoryRef, WorkspaceTabCoordinator } from "@gitgui/client-runtime/workspace";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { EnvironmentWorkspaceData } from "$lib/connection/environment-workspace";
import type { PreparedWorkspaceRepository } from "./workspace";
import { createApplicationWorkspaceCoordinator } from "./application-workspace-metadata";

type PreparedRepository = PreparedWorkspaceRepository & { environmentId: string; generation: number; service: EnvironmentWorkspaceData };

type LoadRepository = (environmentId: string, load: (client: GitGuiClient) => Promise<PreparedWorkspaceRepository>, expectedId?: string) => Promise<ScopedRepositoryRef>;
const readSnapshot = (client: GitGuiClient, id: string, signal?: AbortSignal) =>
  signal ? client.getRepositorySnapshot(id, signal) : client.getRepositorySnapshot(id);

/** Coordinates the one application tab list with environment-owned data. */
export class ApplicationWorkspace {
  private coordinator?: WorkspaceTabCoordinator;
  private unsubscribeTabs?: () => void;
  private unsubscribeRuntime?: () => void;
  private readonly listeners = new Set<(state: RepositoryTabs) => void>();
  private disposed = false;
  private projection = 0;
  private readonly prepared = new Map<string, PreparedRepository>();
  private readonly pendingRemovals = new Set<string>();
  private readonly removing = new Set<string>();
  private removalTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly runtime: WebApplicationRuntime, private readonly storage: Storage) {}

  get state(): RepositoryTabs { return this.coordinator?.state ?? { tabs: [], activeTabId: null }; }

  async start(): Promise<void> {
    if (this.coordinator || this.disposed) return;
    const state = this.runtime.state;
    const coordinator = await createApplicationWorkspaceCoordinator(this.storage,
      state.registry.entries.map((entry) => entry.registration.environmentId), state.registry.selectedEnvironmentId);
    if (this.disposed) { coordinator.dispose(); return; }
    this.coordinator = coordinator;
    this.unsubscribeTabs = coordinator.subscribe((tabs) => {
      this.project(tabs);
      for (const listener of this.listeners) listener(tabs);
    });
    this.unsubscribeRuntime = this.runtime.subscribe((next) => this.reconcile(next));
  }

  subscribe(listener: (state: RepositoryTabs) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async open(target: ScopedRepositoryRef, source?: { tabId: string; target: ScopedRepositoryRef }, signal?: AbortSignal): Promise<void> {
    const tabId = crypto.randomUUID();
    await this.withPreparation(tabId, (load) => this.requireCoordinator().open(tabId, target.environmentId,
      async () => ({ ...target }), async (resolved) => { await load(resolved.environmentId,
        (client) => readSnapshot(client, resolved.repositoryId, signal), resolved.repositoryId); }, source, signal));
  }

  /** Route navigation selects an existing checkout; explicit new-tab actions still reject duplicates. */
  async activate(target: ScopedRepositoryRef, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const coordinator = this.requireCoordinator();
    const existing = coordinator.state.tabs.find((tab) => sameRepository(tab.target, target));
    if (existing) { await coordinator.select(existing.tabId, signal); return; }
    const tabId = crypto.randomUUID();
    await this.withPreparation(tabId, (load) => coordinator.open(tabId, target.environmentId,
      async () => ({ ...target }), async (resolved) => { await load(resolved.environmentId,
        (client) => readSnapshot(client, resolved.repositoryId, signal), resolved.repositoryId); }, undefined, signal));
  }

  async openPath(environmentId: string, path: string, source?: { tabId: string; target: ScopedRepositoryRef }, signal?: AbortSignal): Promise<void> {
    if (!path.trim()) throw new TypeError("Repository path cannot be empty");
    const tabId = crypto.randomUUID();
    try {
      await this.withPreparation(tabId, (load) => this.requireCoordinator().open(tabId, environmentId,
        () => this.preparePath(load, environmentId, path, signal), async () => {}, source, signal));
    } finally {
      // Registering a path may succeed even when tab publication is cancelled
      // or fails; reconcile the server-owned catalog in either case.
      void this.runtime.refreshEnvironmentCatalog(environmentId);
    }
  }

  async create(environmentId: string, parentPath: string, name: string, options: { initialBranch?: string; initializeLfs?: boolean }, signal?: AbortSignal): Promise<boolean> {
    const tabId = crypto.randomUUID();
    let created = false;
    try {
      await this.withPreparation(tabId, (load) => this.requireCoordinator().open(tabId, environmentId,
        () => load(environmentId, async (client) => { const result = await client.createRepository(parentPath, name, options); created = true; return result; }), async () => {}, undefined, signal));
      return true;
    } catch (error) {
      if (created && signal?.aborted) return false;
      throw error;
    } finally { void this.runtime.refreshEnvironmentCatalog(environmentId); }
  }

  async switch(tabId: string, target: ScopedRepositoryRef, expected: ScopedRepositoryRef, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const coordinator = this.requireSource(tabId, expected);
    await this.withPreparation(tabId, (load) => coordinator.switch(tabId, target.environmentId,
      async () => ({ ...target }), async (resolved) => { await load(resolved.environmentId,
        (client) => readSnapshot(client, resolved.repositoryId, signal), resolved.repositoryId); }, signal));
  }

  async switchPath(tabId: string, path: string, expected: ScopedRepositoryRef, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!path.trim()) throw new TypeError("Repository path cannot be empty");
    const coordinator = this.requireSource(tabId, expected);
    try {
      await this.withPreparation(tabId, (load) => coordinator.switch(tabId, expected.environmentId,
        () => this.preparePath(load, expected.environmentId, path, signal), async () => {}, signal));
    } finally {
      void this.runtime.refreshEnvironmentCatalog(expected.environmentId);
    }
  }

  private requireSource(tabId: string, expected: ScopedRepositoryRef): WorkspaceTabCoordinator {
    const coordinator = this.requireCoordinator();
    const source = coordinator.state.tabs.find((tab) => tab.tabId === tabId);
    if (!source || !sameRepository(source.target, expected)) throw new Error("The source tab has changed.");
    return coordinator;
  }

  /** Exact registered host paths need only read scope; aliases still canonicalize on the server. */
  private preparePath(load: LoadRepository, environmentId: string, path: string, signal?: AbortSignal): Promise<ScopedRepositoryRef> {
    const matches = this.runtime.state.catalogs?.[environmentId]?.repositories.filter((repository) =>
      sameHostPath(repository.path, path) || sameHostPath(repository.root, path)) ?? [];
    const known = matches.length === 1 ? matches[0] : undefined;
    return known
      ? load(environmentId, (client) => readSnapshot(client, known.id, signal), known.id)
      : load(environmentId, (client) => client.openRepository(path));
  }

  /** Hold data privately until a persisted tab publication projects this exact target. */
  private async withPreparation(tabId: string, operation: (load: LoadRepository) => Promise<void>): Promise<void> {
    let receipt: PreparedRepository | undefined;
    try {
      await operation(async (environmentId, load, expectedId) => {
        if (this.pendingRemovals.has(environmentId)) throw new Error("Environment removal is pending.");
        const service = this.runtime.getEnvironmentWorkspace(environmentId);
        if (!service) throw new Error("Environment is not available.");
        const generation = service.state.generation;
        const result = await load(service.client);
        if (expectedId && result.repository.id !== expectedId) throw new Error("Server returned a different repository.");
        if (this.runtime.getEnvironmentWorkspace(environmentId) !== service || service.state.generation !== generation)
          throw new Error("Environment session changed during repository preparation.");
        receipt = { ...result, environmentId, generation, service };
        this.prepared.set(tabId, receipt);
        return { environmentId, repositoryId: result.repository.id };
      });
    } finally {
      if (this.prepared.get(tabId) === receipt) this.prepared.delete(tabId);
    }
  }

  select(tabId: string): Promise<void> { return this.requireCoordinator().select(tabId); }
  close(tabId: string): Promise<void> { return this.requireCoordinator().close(tabId); }
  closeIfMatches(tabId: string, expectedTarget: ScopedRepositoryRef): Promise<void> {
    return this.requireCoordinator().closeIfMatches(tabId, expectedTarget);
  }

  dispose(): void {
    this.disposed = true;
    this.projection += 1;
    clearTimeout(this.removalTimer);
    this.prepared.clear();
    this.unsubscribeTabs?.();
    this.unsubscribeRuntime?.();
    this.coordinator?.dispose();
    this.listeners.clear();
  }

  private requireCoordinator(): WorkspaceTabCoordinator {
    if (!this.coordinator || this.disposed) throw new Error("Application workspace is not ready.");
    return this.coordinator;
  }

  private reconcile(state: WebApplicationRuntimeState): void {
    if (!this.coordinator || this.disposed) return;
    for (const environmentId of state.removedEnvironmentIds ?? []) this.pendingRemovals.add(environmentId);
    this.retryRemovals();
    this.project(this.coordinator.state);
  }

  private retryRemovals(): void {
    if (this.disposed || !this.coordinator) return;
    for (const environmentId of this.pendingRemovals) {
      if (this.removing.has(environmentId)) continue;
      this.removing.add(environmentId);
      void this.runtime.acknowledgeEnvironmentWorkspaceRemoval(environmentId,
        () => this.coordinator!.removeEnvironment(environmentId)).then(() => {
        this.pendingRemovals.delete(environmentId);
      }).catch(() => {
        // Registration removal is already durable. Keep the cleanup pending even
        // if no further connection notification arrives; the journal covers restart.
        if (!this.disposed && !this.removalTimer) this.removalTimer = setTimeout(() => {
          this.removalTimer = undefined;
          this.retryRemovals();
        }, 1000);
      }).finally(() => this.removing.delete(environmentId));
    }
  }

  private project(state: RepositoryTabs): void {
    const revision = ++this.projection;
    const active = state.tabs.find((tab) => tab.tabId === state.activeTabId);
    for (const environmentId of Object.keys(this.runtime.environmentWorkspaces)) {
      const ids = state.tabs.filter((tab) => tab.target.environmentId === environmentId).map((tab) => tab.target.repositoryId);
      const activeId = active?.target.environmentId === environmentId ? active.target.repositoryId : null;
      const service = this.runtime.getEnvironmentWorkspace(environmentId);
      const prepared = state.tabs.flatMap((tab) => {
        const item = this.prepared.get(tab.tabId);
        return item && item.service === service && item.environmentId === environmentId && item.repository.id === tab.target.repositoryId ? [item] : [];
      });
      void service?.setRepositoryTargets(ids, activeId, prepared).catch(() => {
        // Session loss is represented by the environment service; stale
        // projections cannot publish a second tab state.
        if (revision !== this.projection) return;
      });
    }
  }
}

/** Only normalize Windows path syntax; never assume host filesystem case rules. */
export function sameHostPath(first: string, second: string): boolean {
  if (first === second) return true;
  const windows = (path: string): string | null => {
    let value = path.replace(/\\/g, "/");
    if (value.startsWith("//?/UNC/")) value = "//" + value.slice(8);
    else if (value.startsWith("//?/")) value = value.slice(4);
    if (!/^(?:[a-zA-Z]:\/|\/\/)/.test(value)) return null;
    return value.replace(/^[a-z]:/, (drive) => drive.toUpperCase()).replace(/\/+$/, "");
  };
  const a = windows(first), b = windows(second);
  return a !== null && b !== null && a === b;
}
