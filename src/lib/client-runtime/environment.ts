import type { ConnectionState, Unsubscribe } from "./types";
import { resolveEndpoint } from "./urls";

export const ENVIRONMENT_METADATA_SCHEMA_VERSION = 1;

export type EnvironmentKind = "desktop-local" | "direct-remote" | "hosted";

export interface EnvironmentRecord {
  id: string;
  displayName: string;
  endpoint: string;
  kind: EnvironmentKind;
  lastKnownState: ConnectionState;
  capabilities: string[];
  protocolVersion?: number;
  serverId?: string;
}

export interface EnvironmentInput {
  id?: string;
  displayName: string;
  endpoint: string;
  kind: EnvironmentKind;
  lastKnownState?: ConnectionState;
  capabilities?: string[];
  protocolVersion?: number;
  serverId?: string;
}

/** Mutable metadata supported by the registry; secrets are deliberately not part of this type. */
export type EnvironmentUpdate = Partial<
  Pick<EnvironmentRecord, "displayName" | "endpoint" | "kind" | "lastKnownState" | "capabilities" | "protocolVersion" | "serverId">
>;

export interface EnvironmentRegistryState {
  environments: EnvironmentRecord[];
  selectedEnvironmentId?: string;
}

export type EnvironmentRegistryListener = (state: EnvironmentRegistryState) => void;

/**
 * Environment metadata is intentionally separate from client connection state.
 * Adapters must persist only these non-secret records and the selected ID.
 */
export interface EnvironmentMetadataAdapter {
  load(): Promise<EnvironmentRecord[]>;
  save(environment: EnvironmentRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** `undefined` means no persisted choice; `null` means explicitly deselected. */
  loadSelected?(): Promise<string | null | undefined>;
  saveSelected?(id: string | undefined): Promise<void>;
}

export class InMemoryEnvironmentMetadataAdapter implements EnvironmentMetadataAdapter {
  private readonly environments = new Map<string, EnvironmentRecord>();
  private selectedEnvironmentId: string | null | undefined;

  constructor(initial: EnvironmentRecord[] = []) {
    for (const environment of initial) {
      const normalized = parseEnvironment(environment);
      this.environments.set(normalized.id, normalized);
    }
  }

  async load(): Promise<EnvironmentRecord[]> {
    return [...this.environments.values()].map(cloneEnvironment);
  }

  async save(environment: EnvironmentRecord): Promise<void> {
    const normalized = parseEnvironment(environment);
    this.environments.set(normalized.id, normalized);
  }

  async remove(id: string): Promise<void> {
    const normalizedId = assertEnvironmentId(id);
    this.environments.delete(normalizedId);
    if (this.selectedEnvironmentId === normalizedId) this.selectedEnvironmentId = null;
  }

  async loadSelected(): Promise<string | null | undefined> {
    return this.selectedEnvironmentId;
  }

  async saveSelected(id: string | undefined): Promise<void> {
    this.selectedEnvironmentId = id === undefined ? null : assertEnvironmentId(id);
  }
}

/**
 * Strict browser-safe storage for non-secret environment metadata.
 *
 * The storage object is injected so this module remains safe to import during
 * SSR. Session tokens, credentials, and unknown properties are never written.
 */
export class LocalStorageEnvironmentMetadataAdapter implements EnvironmentMetadataAdapter {
  constructor(private readonly storage: Storage, private readonly namespace = "gitgui.environments") {
    if (!namespace.trim() || /[\u0000-\u001f\u007f]/.test(namespace)) {
      throw new TypeError("Environment metadata namespace cannot be empty or contain control characters");
    }
  }

  async load(): Promise<EnvironmentRecord[]> {
    return this.read().environments.map(cloneEnvironment);
  }

  async save(environment: EnvironmentRecord): Promise<void> {
    const normalized = parseEnvironment(environment);
    const persisted = this.read();
    const index = persisted.environments.findIndex((candidate) => candidate.id === normalized.id);
    if (index === -1) persisted.environments.push(normalized);
    else persisted.environments[index] = normalized;
    this.write(persisted);
  }

  async remove(id: string): Promise<void> {
    const normalizedId = assertEnvironmentId(id);
    const persisted = this.read();
    persisted.environments = persisted.environments.filter((environment) => environment.id !== normalizedId);
    if (persisted.selectedEnvironmentId === normalizedId) persisted.selectedEnvironmentId = null;
    this.write(persisted);
  }

  async loadSelected(): Promise<string | null | undefined> {
    return this.read().selectedEnvironmentId;
  }

  async saveSelected(id: string | undefined): Promise<void> {
    const persisted = this.read();
    persisted.selectedEnvironmentId = id === undefined ? null : assertEnvironmentId(id);
    this.write(persisted);
  }

  private read(): PersistedEnvironmentMetadata {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.namespace);
    } catch {
      return emptyPersistedMetadata();
    }
    if (!raw) return emptyPersistedMetadata();

    try {
      return parsePersistedMetadata(JSON.parse(raw));
    } catch {
      // Local storage is user-controlled input. A malformed value behaves as empty metadata.
      return emptyPersistedMetadata();
    }
  }

  private write(metadata: PersistedEnvironmentMetadata): void {
    const safeMetadata = parsePersistedMetadata(metadata);
    this.storage.setItem(this.namespace, JSON.stringify(safeMetadata));
  }
}

export class EnvironmentRegistry {
  private readonly environments = new Map<string, EnvironmentRecord>();
  private selectedEnvironmentId?: string;
  private readonly listeners = new Set<EnvironmentRegistryListener>();
  private operationQueue: Promise<void> = Promise.resolve();
  private selectionRevision = 0;

  constructor(private readonly adapter: EnvironmentMetadataAdapter = new InMemoryEnvironmentMetadataAdapter()) {}

  load(): Promise<void> {
    return this.enqueue(async () => {
      const previousSelection = this.selectedEnvironmentId;
      const selectionRevision = this.selectionRevision;
      const loadedEnvironments = new Map<string, EnvironmentRecord>();

      for (const candidate of await this.adapter.load()) {
        try {
          const environment = parseEnvironment(candidate);
          if (!loadedEnvironments.has(environment.id)) loadedEnvironments.set(environment.id, environment);
        } catch {
          // Custom adapters may return untrusted data; ignore malformed records safely.
        }
      }

      const persistedSelection = this.adapter.loadSelected ? await this.adapter.loadSelected() : undefined;
      this.environments.clear();
      for (const [id, environment] of loadedEnvironments) this.environments.set(id, environment);

      if (selectionRevision === this.selectionRevision) {
        this.selectedEnvironmentId = chooseSelection(
          persistedSelection,
          previousSelection,
          this.environments,
        );
      } else {
        // A synchronous select() happened while the adapter was loading. Keep
        // that newer local choice instead of allowing stale persisted data to
        // overwrite it.
        this.selectedEnvironmentId = this.selectedEnvironmentId && this.environments.has(this.selectedEnvironmentId)
          ? this.selectedEnvironmentId
          : undefined;
      }
      this.notify();
    });
  }

  get state(): EnvironmentRegistryState {
    return this.snapshot();
  }

  list(): EnvironmentRecord[] {
    return [...this.environments.values()].map(cloneEnvironment);
  }

  get selectedId(): string | undefined {
    return this.selectedEnvironmentId;
  }

  get selected(): EnvironmentRecord | undefined {
    const environment = this.selectedEnvironmentId ? this.environments.get(this.selectedEnvironmentId) : undefined;
    return environment ? cloneEnvironment(environment) : undefined;
  }

  subscribe(listener: EnvironmentRegistryListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  add(input: EnvironmentInput): Promise<EnvironmentRecord> {
    return this.enqueue(async () => {
      const environment = normalizeEnvironmentInput(input);
      const wasUnselected = this.selectedEnvironmentId === undefined;
      const selectionRevision = this.selectionRevision;

      await this.adapter.save(environment);
      this.environments.set(environment.id, environment);
      if (wasUnselected && selectionRevision === this.selectionRevision) {
        this.selectedEnvironmentId = environment.id;
        this.selectionRevision += 1;
        await this.persistSelected();
      }
      this.notify();
      return cloneEnvironment(environment);
    });
  }

  update(id: string, patch: EnvironmentUpdate): Promise<EnvironmentRecord> {
    return this.enqueue(async () => {
      const current = this.require(id);
      const environment = parseEnvironment({ ...current, ...patch, id: current.id });
      await this.adapter.save(environment);
      this.environments.set(environment.id, environment);
      this.notify();
      return cloneEnvironment(environment);
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const normalizedId = assertEnvironmentId(id);
      const existed = this.environments.has(normalizedId);
      await this.adapter.remove(normalizedId);
      if (!existed) return;

      this.environments.delete(normalizedId);
      if (this.selectedEnvironmentId === normalizedId) {
        this.selectedEnvironmentId = this.environments.keys().next().value;
        this.selectionRevision += 1;
        await this.persistSelected();
      }
      this.notify();
    });
  }

  async rename(id: string, displayName: string): Promise<EnvironmentRecord> {
    return this.update(id, { displayName });
  }

  select(id: string | undefined): void {
    const normalizedId = id === undefined ? undefined : assertEnvironmentId(id);
    if (normalizedId !== undefined && !this.environments.has(normalizedId)) {
      throw new Error(`Unknown environment: ${normalizedId}`);
    }
    if (this.selectedEnvironmentId === normalizedId) return;

    this.selectedEnvironmentId = normalizedId;
    const selectionRevision = ++this.selectionRevision;
    void this.enqueue(async () => {
      if (selectionRevision !== this.selectionRevision) return;
      await this.persistSelected();
    }).catch(() => undefined);
    this.notify();
  }

  async updateConnectionMetadata(
    id: string,
    metadata: Pick<EnvironmentRecord, "lastKnownState" | "capabilities" | "protocolVersion" | "serverId">,
  ): Promise<EnvironmentRecord> {
    return this.update(id, metadata);
  }

  private snapshot(): EnvironmentRegistryState {
    return {
      environments: this.list(),
      selectedEnvironmentId: this.selectedEnvironmentId,
    };
  }

  private async persistSelected(): Promise<void> {
    if (!this.adapter.saveSelected) return;
    await this.adapter.saveSelected(this.selectedEnvironmentId);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationQueue = current;

    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.operationQueue === current) release();
      });
  }

  private require(id: string): EnvironmentRecord {
    const normalizedId = assertEnvironmentId(id);
    const environment = this.environments.get(normalizedId);
    if (!environment) throw new Error(`Unknown environment: ${normalizedId}`);
    return environment;
  }

  private notify(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

export function stableEnvironmentId(endpoint: string, kind: EnvironmentKind): string {
  const input = `${assertEnvironmentKind(kind)}:${normalizeEndpoint(endpoint)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `environment-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

interface PersistedEnvironmentMetadata {
  schemaVersion: number;
  environments: EnvironmentRecord[];
  selectedEnvironmentId?: string | null;
}

function normalizeEnvironmentInput(input: EnvironmentInput): EnvironmentRecord {
  if (!isRecord(input)) throw new TypeError("Invalid environment input");
  const endpoint = normalizeEndpoint(input.endpoint);
  const kind = assertEnvironmentKind(input.kind);
  const id = input.id === undefined ? stableEnvironmentId(endpoint, kind) : assertEnvironmentId(input.id);
  const displayName = normalizeDisplayName(input.displayName, endpoint, true);

  return parseEnvironment({
    id,
    displayName,
    endpoint,
    kind,
    lastKnownState: input.lastKnownState ?? "idle",
    capabilities: input.capabilities ?? [],
    protocolVersion: input.protocolVersion,
    serverId: input.serverId,
  });
}

function parseEnvironment(value: unknown): EnvironmentRecord {
  if (!isRecord(value)) throw new TypeError("Invalid environment record");
  const endpoint = normalizeEndpoint(value.endpoint);
  const kind = assertEnvironmentKind(value.kind);
  const id = assertEnvironmentId(value.id);
  const displayName = normalizeDisplayName(value.displayName, endpoint);
  const lastKnownState = assertConnectionState(value.lastKnownState);
  const capabilities = normalizeCapabilities(value.capabilities);
  const protocolVersion = normalizeProtocolVersion(value.protocolVersion);
  const serverId = normalizeOptionalId(value.serverId, "serverId");

  return {
    id,
    displayName,
    endpoint,
    kind,
    lastKnownState,
    capabilities,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(serverId === undefined ? {} : { serverId }),
  };
}

function parsePersistedMetadata(value: unknown): PersistedEnvironmentMetadata {
  if (!isRecord(value) || value.schemaVersion !== ENVIRONMENT_METADATA_SCHEMA_VERSION || !Array.isArray(value.environments)) {
    throw new TypeError("Invalid environment metadata");
  }

  const environments: EnvironmentRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value.environments) {
    try {
      const environment = parseEnvironment(candidate);
      if (!ids.has(environment.id)) {
        ids.add(environment.id);
        environments.push(environment);
      }
    } catch {
      // Ignore only the malformed record; valid sibling records remain usable.
    }
  }

  let selectedEnvironmentId: string | null | undefined;
  if (value.selectedEnvironmentId === null) selectedEnvironmentId = null;
  else if (value.selectedEnvironmentId === undefined) selectedEnvironmentId = undefined;
  else {
    try {
      selectedEnvironmentId = assertEnvironmentId(value.selectedEnvironmentId);
    } catch {
      selectedEnvironmentId = undefined;
    }
  }

  return { schemaVersion: ENVIRONMENT_METADATA_SCHEMA_VERSION, environments, selectedEnvironmentId };
}

function emptyPersistedMetadata(): PersistedEnvironmentMetadata {
  return { schemaVersion: ENVIRONMENT_METADATA_SCHEMA_VERSION, environments: [] };
}

function chooseSelection(
  persistedSelection: string | null | undefined,
  previousSelection: string | undefined,
  environments: Map<string, EnvironmentRecord>,
): string | undefined {
  if (persistedSelection === null) return undefined;
  if (persistedSelection !== undefined && environments.has(persistedSelection)) return persistedSelection;
  if (persistedSelection === undefined && previousSelection && environments.has(previousSelection)) return previousSelection;
  return environments.keys().next().value;
}

function assertEnvironmentId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Environment ID must be a non-empty safe string");
  }
  return value;
}

function assertEnvironmentKind(value: unknown): EnvironmentKind {
  if (value !== "desktop-local" && value !== "direct-remote" && value !== "hosted") {
    throw new TypeError(`Unsupported environment kind: ${String(value)}`);
  }
  return value;
}

function assertConnectionState(value: unknown): ConnectionState {
  if (
    value !== "idle"
    && value !== "connecting"
    && value !== "ready"
    && value !== "reconnecting"
    && value !== "incompatible"
    && value !== "unauthorized"
    && value !== "failed"
    && value !== "disconnected"
  ) {
    throw new TypeError(`Unsupported environment connection state: ${String(value)}`);
  }
  return value;
}

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Environment endpoint cannot be empty");
  const input = new URL(value);
  if (input.search || input.hash) throw new TypeError("Environment endpoints cannot contain query or hash data");
  return resolveEndpoint(input).httpBaseUrl;
}

function normalizeDisplayName(value: unknown, endpoint: string, allowDefault = false): string {
  if (typeof value !== "string") throw new TypeError("Environment display name must be a string");
  const displayName = value.trim();
  if (displayName) return displayName;
  if (allowDefault) return defaultDisplayName(endpoint);
  throw new TypeError("Environment display name cannot be empty");
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Environment capabilities must be an array");
  const capabilities: string[] = [];
  for (const capability of value) {
    if (typeof capability !== "string" || !capability || capability !== capability.trim() || /[\u0000-\u001f\u007f]/.test(capability)) {
      throw new TypeError("Environment capabilities must contain safe strings");
    }
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

function normalizeProtocolVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Environment protocol version must be a non-negative integer");
  }
  return value;
}

function normalizeOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return assertEnvironmentId(value);
  } catch {
    throw new TypeError(`Invalid ${field}`);
  }
}

function defaultDisplayName(endpoint: string): string {
  return new URL(endpoint).hostname || endpoint;
}

function cloneEnvironment(environment: EnvironmentRecord): EnvironmentRecord {
  return {
    ...environment,
    capabilities: [...environment.capabilities],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
