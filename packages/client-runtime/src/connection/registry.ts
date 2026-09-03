import { ConnectionDriver } from "./driver";
import type {
  ConnectionCatalogStore,
  ConnectionCredential,
  ConnectionPlatform,
  ConnectionRegistration,
  CredentialStore,
  EnvironmentConnectionState,
  RpcSession,
} from "./model";
import { assertEnvironmentId, ConnectionFailure } from "./model";
import { ConnectionResolver, discoverEnvironment } from "./resolver";
import { EnvironmentSupervisor } from "./supervisor";
import { resolveEndpoint } from "../rpc/urls";

export interface EnvironmentRegistryEntry {
  registration: ConnectionRegistration;
  connection: EnvironmentConnectionState;
  session: RpcSession | null;
}

export interface EnvironmentRegistryState {
  entries: EnvironmentRegistryEntry[];
  selectedEnvironmentId?: string;
}

export class EnvironmentRegistry {
  private readonly entries = new Map<string, EnvironmentRegistryEntry>();
  private readonly supervisors = new Map<string, EnvironmentSupervisor>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<(state: EnvironmentRegistryState) => void>();
  private selectedEnvironmentId?: string;
  private started = false;

  constructor(
    private readonly catalog: ConnectionCatalogStore,
    private readonly credentials: CredentialStore,
    private readonly platform: ConnectionPlatform,
    private readonly createDriver: () => ConnectionDriver = () =>
      new ConnectionDriver(new ConnectionResolver(platform, credentials)),
  ) {}

  get state(): EnvironmentRegistryState {
    return this.snapshot();
  }

  subscribe(listener: (state: EnvironmentRegistryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const persisted = await this.catalog.load();
    this.selectedEnvironmentId = persisted.selectedEnvironmentId;
    for (const registration of persisted.registrations) await this.reconcile(registration, false);

    const controller = new AbortController();
    const primary = await this.platform.getPrimaryConnection(controller.signal);
    if (primary) {
      if (primary.credential) await this.credentials.set(primary.descriptor.environmentId, primary.credential);
      await this.reconcile({
        environmentId: primary.descriptor.environmentId,
        displayName: primary.descriptor.label,
        target: { kind: "primary" },
        capabilities: [...primary.descriptor.capabilities],
        protocolVersion: primary.descriptor.protocolVersion,
      }, true);
      this.selectedEnvironmentId ??= primary.descriptor.environmentId;
    }

    this.selectedEnvironmentId ??= this.entries.keys().next().value;
    await this.catalog.saveSelected(this.selectedEnvironmentId);
    for (const supervisor of this.supervisors.values()) supervisor.connect();
    this.notify();
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.disconnect()));
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.supervisors.clear();
    this.entries.clear();
    this.notify();
  }

  async addBearer(httpUrl: string, credential?: ConnectionCredential): Promise<ConnectionRegistration> {
    const normalizedHttpUrl = normalizeDirectHttpUrl(httpUrl);
    const descriptor = await discoverEnvironment(normalizedHttpUrl);
    const registration: ConnectionRegistration = {
      environmentId: descriptor.environmentId,
      displayName: descriptor.label,
      target: { kind: "bearer", httpUrl: normalizedHttpUrl },
      capabilities: [...descriptor.capabilities],
      protocolVersion: descriptor.protocolVersion,
    };
    return await this.registerValidated(registration, credential);
  }

  async addSsh(
    target: Extract<ConnectionRegistration["target"], { kind: "ssh" }>,
    credential?: ConnectionCredential,
  ): Promise<ConnectionRegistration> {
    const controller = new AbortController();
    const prepared = await this.platform.ensureSshConnection(target, controller.signal);
    const registration: ConnectionRegistration = {
      environmentId: prepared.descriptor.environmentId,
      displayName: prepared.descriptor.label,
      target,
      capabilities: [...prepared.descriptor.capabilities],
      protocolVersion: prepared.descriptor.protocolVersion,
    };
    try {
      return await this.registerValidated(registration, credential ?? prepared.credential);
    } catch (error) {
      await this.platform.disconnectSshConnection?.(target);
      throw error;
    }
  }

  select(environmentId: string | undefined): void {
    if (environmentId !== undefined && !this.entries.has(assertEnvironmentId(environmentId))) {
      throw new Error(`Unknown environment: ${environmentId}`);
    }
    this.selectedEnvironmentId = environmentId;
    void this.catalog.saveSelected(environmentId);
    this.notify();
  }

  retry(environmentId: string): void {
    this.supervisors.get(assertEnvironmentId(environmentId))?.retry();
  }

  async credentialChanged(environmentId: string, credential: ConnectionCredential): Promise<void> {
    const id = assertEnvironmentId(environmentId);
    await this.credentials.set(id, credential);
    this.supervisors.get(id)?.credentialChanged();
  }

  async remove(environmentId: string): Promise<void> {
    const id = assertEnvironmentId(environmentId);
    const entry = this.entries.get(id);
    const supervisor = this.supervisors.get(id);
    await supervisor?.disconnect();
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.supervisors.delete(id);
    this.entries.delete(id);
    await this.catalog.remove(id);
    await this.credentials.remove(id);
    if (entry?.registration.target.kind === "ssh") {
      await this.platform.disconnectSshConnection?.(entry.registration.target);
    }
    await this.platform.cleanupEnvironment?.(id);
    if (this.selectedEnvironmentId === id) {
      this.selectedEnvironmentId = this.entries.keys().next().value;
      await this.catalog.saveSelected(this.selectedEnvironmentId);
    }
    this.notify();
  }

  supervisor(environmentId: string): EnvironmentSupervisor | undefined {
    return this.supervisors.get(assertEnvironmentId(environmentId));
  }

  currentSession(environmentId = this.selectedEnvironmentId): RpcSession | null {
    return environmentId ? this.entries.get(environmentId)?.session ?? null : null;
  }

  private async reconcile(registration: ConnectionRegistration, persist: boolean): Promise<void> {
    const existing = this.entries.get(registration.environmentId);
    if (existing && JSON.stringify(existing.registration) === JSON.stringify(registration)) return;
    if (persist) await this.catalog.save(registration);
    if (existing) {
      await this.supervisors.get(registration.environmentId)?.disconnect();
      this.unsubscribers.get(registration.environmentId)?.();
    }
    const driver = this.createDriver();
    const supervisor = new EnvironmentSupervisor(registration, driver, this.platform);
    const entry: EnvironmentRegistryEntry = {
      registration,
      connection: supervisor.state,
      session: null,
    };
    this.entries.set(registration.environmentId, entry);
    this.supervisors.set(registration.environmentId, supervisor);
    this.unsubscribers.set(registration.environmentId, supervisor.subscribe((connection, session) => {
      entry.connection = connection;
      entry.session = session;
      this.notify();
    }));
    if (this.started) supervisor.connect();
    this.notify();
  }

  private async registerValidated(
    registration: ConnectionRegistration,
    credential?: ConnectionCredential,
  ): Promise<ConnectionRegistration> {
    const previousCredential = await this.credentials.get(registration.environmentId);
    try {
      if (credential) await this.credentials.set(registration.environmentId, credential);
      const driver = this.createDriver();
      const session = await driver.connect(registration, new AbortController().signal, () => undefined);
      session.close("Connection onboarding completed");
      await this.reconcile(registration, true);
      this.selectedEnvironmentId = registration.environmentId;
      await this.catalog.saveSelected(registration.environmentId);
      this.supervisors.get(registration.environmentId)?.connect();
      this.notify();
      return registration;
    } catch (error) {
      if (previousCredential) await this.credentials.set(registration.environmentId, previousCredential);
      else await this.credentials.remove(registration.environmentId);
      throw error;
    }
  }

  private snapshot(): EnvironmentRegistryState {
    return {
      entries: [...this.entries.values()].map((entry) => ({
        registration: structuredClone(entry.registration),
        connection: { ...entry.connection },
        session: entry.session,
      })),
      selectedEnvironmentId: this.selectedEnvironmentId,
    };
  }

  private notify(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

function normalizeDirectHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new ConnectionFailure(
      "Connection URLs cannot contain credentials, query parameters, or fragments",
      "configuration",
      false,
    );
  }
  return resolveEndpoint(url).httpBaseUrl;
}
