import type {
  ProtocolError,
  RepositoryRefreshItem,
  RepositorySnapshot,
  RepositorySummary,
} from "@gitgui/contracts";
import { assertRepositoryId, GitGuiClient } from "@gitgui/client-runtime";
import {
  createEmptyWorkspaceMetadata,
  InMemoryWorkspaceMetadataAdapter,
  type WorkspaceMetadata,
  type WorkspaceMetadataAdapter,
  type WorkspaceMetadataIdentity,
  type WorkspaceRecentMetadata,
} from "./metadata";
import type { Unsubscribe } from "@gitgui/client-runtime";

const DEFAULT_RECENT_LIMIT = 50;

export interface WorkspaceRepositoryState {
  repository: RepositorySummary;
  snapshot?: RepositorySnapshot;
  error?: WorkspaceRepositoryError;
  loading: boolean;
  refreshing: boolean;
}

export interface WorkspaceRepositoryError {
  code?: string;
  message: string;
}

export interface ClientWorkspaceState {
  environmentId: string;
  openRepositoryIds: string[];
  recentRepositories: WorkspaceRecentMetadata[];
  activeRepositoryId: string | null;
  repositories: Record<string, WorkspaceRepositoryState>;
  restoring: boolean;
  opening: boolean;
  refreshing: boolean;
  error?: WorkspaceRepositoryError;
}

export interface ClientWorkspaceOptions {
  client: GitGuiClient;
  identity: WorkspaceMetadataIdentity;
  metadataAdapter?: WorkspaceMetadataAdapter;
  recentLimit?: number;
}

/** Per-environment client-owned tabs, recents, and hydrated repository state. */
export class ClientWorkspace {
  readonly environmentId: string;
  private readonly client: GitGuiClient;
  private readonly identity: WorkspaceMetadataIdentity;
  private readonly metadataAdapter: WorkspaceMetadataAdapter;
  private readonly recentLimit: number;
  private readonly listeners = new Set<(state: ClientWorkspaceState) => void>();
  private readonly requestGenerations = new Map<string, number>();
  private metadataWrite: Promise<void> = Promise.resolve();
  private metadataLoad?: Promise<WorkspaceMetadata>;
  private metadataLoaded = false;
  private metadata?: WorkspaceMetadata;
  private stateOperation: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private nextRequestGeneration = 0;
  private _state: ClientWorkspaceState;

  constructor(options: ClientWorkspaceOptions) {
    if (!options.identity.environmentId.trim()) throw new TypeError("Workspace environmentId cannot be empty");
    this.client = options.client;
    this.identity = { ...options.identity };
    this.environmentId = options.identity.environmentId;
    this.metadataAdapter = options.metadataAdapter ?? new InMemoryWorkspaceMetadataAdapter();
    this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    if (!Number.isInteger(this.recentLimit) || this.recentLimit <= 0) throw new RangeError("recentLimit must be positive");
    this._state = {
      environmentId: this.environmentId,
      openRepositoryIds: [],
      recentRepositories: [],
      activeRepositoryId: null,
      repositories: {},
      restoring: false,
      opening: false,
      refreshing: false,
    };
  }

  get state(): ClientWorkspaceState {
    return cloneState(this._state);
  }

  subscribe(listener: (state: ClientWorkspaceState) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  restore(): Promise<ClientWorkspaceState> {
    return this.serializeStateOperation(() => this.restoreWorkspace());
  }

  private async restoreWorkspace(): Promise<ClientWorkspaceState> {
    const lifecycle = ++this.lifecycleGeneration;
    this.update({ restoring: true, error: undefined });

    try {
      const metadata = await this.loadMetadata();
      const repositories = await this.client.listRepositories();
      if (lifecycle !== this.lifecycleGeneration) return this.state;

      const catalog = new Map(repositories.filter((repository) => isRepositorySummary(repository)).map((repository) => [repository.id, repository]));
      const openIds = uniqueValidIds(metadata.openRepositoryIds).filter((id) => catalog.has(id));
      const recentRepositories = metadata.recentRepositories
        .filter((recent) => catalog.has(recent.repositoryId))
        .sort(compareRecents)
        .slice(0, this.recentLimit);
      const activeRepositoryId = metadata.activeRepositoryId && openIds.includes(metadata.activeRepositoryId)
        ? metadata.activeRepositoryId
        : openIds[0] ?? null;

      const repositoryStates: Record<string, WorkspaceRepositoryState> = {};
      for (const id of openIds) {
        repositoryStates[id] = {
          repository: catalog.get(id)!,
          loading: true,
          refreshing: true,
        };
      }
      this.replace({
        openRepositoryIds: openIds,
        recentRepositories,
        activeRepositoryId,
        repositories: repositoryStates,
        restoring: true,
        opening: false,
        refreshing: false,
        error: undefined,
      });

      if (openIds.length) await this.refreshRepositories(openIds, { lifecycle, persist: false });
      if (lifecycle !== this.lifecycleGeneration) return this.state;
      this.update({ restoring: false });
      await this.persist();
      return this.state;
    } catch (error) {
      if (lifecycle === this.lifecycleGeneration) {
        this.update({ restoring: false, error: toWorkspaceError(error) });
      }
      throw error;
    }
  }

  async openRepositoryPath(path: string): Promise<ClientWorkspaceState> {
    if (!path.trim()) throw new TypeError("Repository path cannot be empty");
    return this.serializeStateOperation(() => this.openRepositoryPathOperation(path));
  }

  async createRepository(
    parentPath: string,
    name: string,
    options: { initialBranch?: string; initializeLfs?: boolean } = {},
  ): Promise<ClientWorkspaceState> {
    if (!parentPath.trim()) throw new TypeError("Repository parent path cannot be empty");
    if (!name.trim()) throw new TypeError("Repository name cannot be empty");
    return this.serializeStateOperation(() => this.createRepositoryOperation(parentPath, name, options));
  }

  private async createRepositoryOperation(
    parentPath: string,
    name: string,
    options: { initialBranch?: string; initializeLfs?: boolean },
  ): Promise<ClientWorkspaceState> {
    const lifecycle = this.lifecycleGeneration;
    this.update({ opening: true, error: undefined });
    try {
      const result = await this.client.createRepository(parentPath, name, options);
      if (lifecycle !== this.lifecycleGeneration) return this.state;
      this.addHydratedRepository(result.repository, result.snapshot);
      await this.persist();
      return this.state;
    } catch (error) {
      if (lifecycle === this.lifecycleGeneration) this.update({ error: toWorkspaceError(error) });
      throw error;
    } finally {
      if (lifecycle === this.lifecycleGeneration) this.update({ opening: false });
    }
  }

  private async openRepositoryPathOperation(path: string): Promise<ClientWorkspaceState> {
    const lifecycle = this.lifecycleGeneration;
    this.update({ opening: true, error: undefined });
    try {
      const result = await this.client.openRepository(path);
      if (lifecycle !== this.lifecycleGeneration) return this.state;
      this.addHydratedRepository(result.repository, result.snapshot);
      await this.persist();
      return this.state;
    } catch (error) {
      if (lifecycle === this.lifecycleGeneration) this.update({ error: toWorkspaceError(error) });
      throw error;
    } finally {
      if (lifecycle === this.lifecycleGeneration) this.update({ opening: false });
    }
  }

  async openKnownRepository(repositoryId: string): Promise<ClientWorkspaceState> {
    return this.serializeStateOperation(() => this.openKnownRepositoryOperation(repositoryId));
  }

  private async openKnownRepositoryOperation(repositoryId: string): Promise<ClientWorkspaceState> {
    const id = assertRepositoryId(repositoryId);
    const generation = this.beginRequest(id);
    const lifecycle = this.lifecycleGeneration;
    this.update({ opening: true, error: undefined });
    try {
      const result = await this.client.getRepositorySnapshot(id);
      if (!this.isCurrentGeneration(id, generation, lifecycle)) return this.state;
      this.addHydratedRepository(result.repository, result.snapshot);
      await this.persist();
      return this.state;
    } catch (error) {
      if (this.isCurrentGeneration(id, generation, lifecycle)) this.update({ error: toWorkspaceError(error) });
      throw error;
    } finally {
      if (this.isCurrentGeneration(id, generation, lifecycle)) this.update({ opening: false });
    }
  }

  selectRepository(repositoryId: string): Promise<void> {
    return this.serializeStateOperation(async () => {
      const id = assertRepositoryId(repositoryId);
      if (!this._state.openRepositoryIds.includes(id)) throw new Error(`Repository is not open: ${id}`);
      this.replace({ activeRepositoryId: id });
      await this.persist();
    });
  }

  closeRepository(repositoryId: string): Promise<void> {
    return this.serializeStateOperation(async () => {
      const id = assertRepositoryId(repositoryId);
      if (!this._state.openRepositoryIds.includes(id)) return;
      this.lifecycleGeneration += 1;
      this.requestGenerations.delete(id);
      const openRepositoryIds = this._state.openRepositoryIds.filter((candidate) => candidate !== id);
      const repositories = { ...this._state.repositories };
      delete repositories[id];
      const activeRepositoryId = this._state.activeRepositoryId === id ? openRepositoryIds[0] ?? null : this._state.activeRepositoryId;
      this.replace({ openRepositoryIds, repositories, activeRepositoryId, opening: false, refreshing: false, restoring: false });
      await this.persist();
    });
  }

  async removeRepository(repositoryId: string): Promise<ClientWorkspaceState> {
    return this.serializeStateOperation(() => this.removeRepositoryOperation(repositoryId));
  }

  private async removeRepositoryOperation(repositoryId: string): Promise<ClientWorkspaceState> {
    const id = assertRepositoryId(repositoryId);
    this.update({ opening: true, error: undefined });

    try {
      await this.client.removeRepository(id);
      this.lifecycleGeneration += 1;
      this.requestGenerations.delete(id);

      const openRepositoryIds = this._state.openRepositoryIds.filter((candidate) => candidate !== id);
      const repositories = { ...this._state.repositories };
      delete repositories[id];
      const recentRepositories = this._state.recentRepositories.filter((recent) => recent.repositoryId !== id);
      const activeRepositoryId = this._state.activeRepositoryId === id
        ? openRepositoryIds[0] ?? null
        : this._state.activeRepositoryId;

      this.replace({
        openRepositoryIds,
        recentRepositories,
        repositories,
        activeRepositoryId,
        opening: false,
        refreshing: false,
        restoring: false,
      });
      await this.persist();
      return this.state;
    } catch (error) {
      this.update({ error: toWorkspaceError(error) });
      throw error;
    } finally {
      this.update({ opening: false });
    }
  }

  removeRecentRepository(repositoryId: string): Promise<void> {
    return this.serializeStateOperation(async () => {
      const id = assertRepositoryId(repositoryId);
      this.replace({ recentRepositories: this._state.recentRepositories.filter((recent) => recent.repositoryId !== id) });
      await this.persist();
    });
  }

  async refreshRepository(repositoryId: string): Promise<ClientWorkspaceState> {
    return this.serializeStateOperation(() => this.refreshRepositories([assertRepositoryId(repositoryId)]));
  }

  async refreshAllRepositories(): Promise<ClientWorkspaceState> {
    return this.serializeStateOperation(() => this.refreshRepositories(this._state.openRepositoryIds));
  }

  async prefetchCommitFiles(repositoryId: string, commitHashes: string[]): Promise<void> {
    try {
      await this.client.prefetchCommitFiles(assertRepositoryId(repositoryId), commitHashes);
    } catch {
      // Prefetch is a performance hint and never affects workspace correctness.
    }
  }

  async prefetchCommitDiffs(params: Parameters<GitGuiClient["prefetchCommitDiffs"]>[0]): Promise<void> {
    try {
      await this.client.prefetchCommitDiffs({ ...params, repositoryId: assertRepositoryId(params.repositoryId) });
    } catch {
      // Prefetch is a performance hint and never affects workspace correctness.
    }
  }

  private async refreshRepositories(repositoryIds: string[], options: { lifecycle?: number; persist?: boolean } = {}): Promise<ClientWorkspaceState> {
    const ids = uniqueValidIds(repositoryIds).filter((id) => this._state.openRepositoryIds.includes(id));
    if (!ids.length) return this.state;
    const lifecycle = options.lifecycle ?? this.lifecycleGeneration;
    const generations = new Map(ids.map((id) => [id, this.beginRequest(id)]));
    this.updateRepositories(ids, (repository) => ({ ...repository, refreshing: true, loading: !repository.snapshot }));
    this.update({ refreshing: true, error: undefined });

    try {
      const result = await this.client.refreshRepositories(ids);
      const returned = new Map(result.repositories.map((item) => [item.repositoryId, item]));
      for (const id of ids) {
        const generation = generations.get(id)!;
        if (!this.isCurrentRequest(id, generation, lifecycle)) continue;
        const item = returned.get(id);
        this.applyRefreshItem(id, item);
      }
    } catch (error) {
      for (const id of ids) {
        const generation = generations.get(id)!;
        if (this.isCurrentRequest(id, generation, lifecycle)) this.setRepositoryError(id, toWorkspaceError(error));
      }
    } finally {
      for (const id of ids) {
        const generation = generations.get(id)!;
        if (this.isCurrentRequest(id, generation, lifecycle)) {
          this.updateRepository(id, (repository) => ({ ...repository, loading: false, refreshing: false }));
        }
      }
      if (lifecycle === this.lifecycleGeneration) this.update({ refreshing: false });
    }

    if (options.persist !== false) await this.persist();
    return this.state;
  }

  private applyRefreshItem(repositoryId: string, item: RepositoryRefreshItem | undefined): void {
    if (!item) {
      this.setRepositoryError(repositoryId, { code: "missing_refresh_result", message: "The server did not return a refresh result" });
      return;
    }
    if (item.error) {
      this.setRepositoryError(repositoryId, toWorkspaceError(item.error));
      return;
    }
    if (!item.repository || !item.snapshot) {
      this.setRepositoryError(repositoryId, { code: "invalid_refresh_result", message: "The server returned an incomplete repository refresh" });
      return;
    }
    this.updateRepository(repositoryId, () => ({ repository: item.repository!, snapshot: item.snapshot, loading: false, refreshing: false }));
  }

  private addHydratedRepository(repository: RepositorySummary, snapshot: RepositorySnapshot): void {
    const id = assertRepositoryId(repository.id);
    const openRepositoryIds = this._state.openRepositoryIds.includes(id)
      ? [...this._state.openRepositoryIds]
      : [...this._state.openRepositoryIds, id];
    const repositories = {
      ...this._state.repositories,
      [id]: { repository, snapshot, loading: false, refreshing: false },
    };
    this.replace({
      openRepositoryIds,
      repositories,
      activeRepositoryId: id,
      recentRepositories: touchRecent(this._state.recentRepositories, id, this.recentLimit),
    });
  }

  private updateRepositories(ids: string[], update: (repository: WorkspaceRepositoryState) => WorkspaceRepositoryState): void {
    const repositories = { ...this._state.repositories };
    for (const id of ids) {
      if (repositories[id]) repositories[id] = update(repositories[id]);
    }
    this.replace({ repositories });
  }

  private updateRepository(id: string, update: (repository: WorkspaceRepositoryState) => WorkspaceRepositoryState): void {
    const repository = this._state.repositories[id];
    if (!repository) return;
    this.replace({ repositories: { ...this._state.repositories, [id]: update(repository) } });
  }

  private setRepositoryError(id: string, error: WorkspaceRepositoryError): void {
    this.updateRepository(id, (repository) => ({ ...repository, error, loading: false, refreshing: false }));
  }

  private beginRequest(repositoryId: string): number {
    const generation = ++this.nextRequestGeneration;
    this.requestGenerations.set(repositoryId, generation);
    return generation;
  }

  private isCurrentRequest(repositoryId: string, generation: number, lifecycle = this.lifecycleGeneration): boolean {
    return this.isCurrentGeneration(repositoryId, generation, lifecycle) && this._state.openRepositoryIds.includes(repositoryId);
  }

  private isCurrentGeneration(repositoryId: string, generation: number, lifecycle: number): boolean {
    return lifecycle === this.lifecycleGeneration && this.requestGenerations.get(repositoryId) === generation;
  }

  private replace(partial: Partial<ClientWorkspaceState>): void {
    this._state = { ...this._state, ...partial };
    this.notify();
  }

  private update(partial: Partial<ClientWorkspaceState>): void {
    this.replace(partial);
  }

  private notify(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  private async persist(): Promise<void> {
    this.metadataWrite = this.metadataWrite.catch(() => undefined).then(async () => {
      await this.loadMetadata();
      const metadata = stateToMetadata(this._state);
      await this.metadataAdapter.save(this.identity, metadata);
      this.metadata = metadata;
      this.metadataLoaded = true;
    });
    return this.metadataWrite;
  }

  private serializeStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateOperation;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.stateOperation = current;

    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        // Every queued operation must release the promise that represents it.
        // A later operation may already have replaced `stateOperation`, but it
        // still waits on this operation's promise before it can start.
        release();
      });
  }

  private async loadMetadata(): Promise<WorkspaceMetadata> {
    if (this.metadataLoaded) {
      return this.metadata!;
    }
    if (!this.metadataLoad) {
      this.metadataLoad = this.metadataAdapter.load(this.identity).then(normalizeMetadata);
      this.metadataLoad.then(
        (metadata) => {
          this.metadata = metadata;
          this.metadataLoaded = true;
          this.metadataLoad = undefined;
        },
        () => {
          this.metadataLoad = undefined;
        },
      );
    }
    return this.metadataLoad;
  }
}

function normalizeMetadata(metadata: WorkspaceMetadata | null): WorkspaceMetadata {
  return metadata ?? createEmptyWorkspaceMetadata();
}

function stateToMetadata(state: ClientWorkspaceState): WorkspaceMetadata {
  return {
    schemaVersion: 1,
    openRepositoryIds: [...state.openRepositoryIds],
    recentRepositories: state.recentRepositories.map((recent) => ({ ...recent })),
    activeRepositoryId: state.activeRepositoryId,
  };
}

function touchRecent(recents: WorkspaceRecentMetadata[], repositoryId: string, limit: number): WorkspaceRecentMetadata[] {
  const now = Date.now();
  return [
    { repositoryId, lastOpenedAt: now, order: 0 },
    ...recents.filter((recent) => recent.repositoryId !== repositoryId).map((recent, index) => ({ ...recent, order: index + 1 })),
  ].slice(0, limit);
}

function compareRecents(left: WorkspaceRecentMetadata, right: WorkspaceRecentMetadata): number {
  return left.order - right.order || right.lastOpenedAt - left.lastOpenedAt;
}

function uniqueValidIds(ids: string[]): string[] {
  const valid: string[] = [];
  for (const id of ids) {
    try {
      const validId = assertRepositoryId(id);
      if (!valid.includes(validId)) valid.push(validId);
    } catch {
      // Ignore malformed persisted IDs; they are untrusted metadata.
    }
  }
  return valid;
}

function isRepositorySummary(value: unknown): value is RepositorySummary {
  if (!value || typeof value !== "object") return false;
  const repository = value as Partial<RepositorySummary>;
  return typeof repository.id === "string"
    && typeof repository.path === "string"
    && typeof repository.root === "string";
}

function toWorkspaceError(error: unknown): WorkspaceRepositoryError {
  if (isProtocolError(error)) return { code: error.code, message: error.message };
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { code, message: error.message };
  }
  return { message: String(error) };
}

function isProtocolError(value: unknown): value is ProtocolError {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && typeof value.code === "string"
    && "message" in value
    && typeof value.message === "string";
}

function cloneState(state: ClientWorkspaceState): ClientWorkspaceState {
  const repositories: Record<string, WorkspaceRepositoryState> = {};
  for (const [id, repository] of Object.entries(state.repositories)) {
    repositories[id] = {
      ...repository,
      repository: { ...repository.repository },
      snapshot: repository.snapshot,
      error: repository.error ? { ...repository.error } : undefined,
    };
  }
  return {
    ...state,
    openRepositoryIds: [...state.openRepositoryIds],
    recentRepositories: state.recentRepositories.map((recent) => ({ ...recent })),
    repositories,
    error: state.error ? { ...state.error } : undefined,
  };
}
